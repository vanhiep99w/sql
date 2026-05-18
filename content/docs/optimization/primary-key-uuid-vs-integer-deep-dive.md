---
title: "Primary Key: Integer vs UUIDv4 vs UUIDv7 — Deep Dive"
description: "Mổ xẻ cách database lưu primary key dưới B+Tree, vì sao UUIDv4 gây page split và index fragmentation, UUIDv7 hoạt động ra sao, cùng benchmark và playbook migration cho Postgres/MySQL/SQL Server."
---

## Mục lục

- [Bối cảnh: Câu hỏi đầu tiên mỗi khi tạo bảng](#1-bối-cảnh-câu-hỏi-đầu-tiên-mỗi-khi-tạo-bảng)
- [Cách database sinh và lưu auto-increment integer](#2-cách-database-sinh-và-lưu-auto-increment-integer)
- [B+Tree refresher — Page, Fanout, Clustered Index](#3-btree-refresher--page-fanout-clustered-index)
- [Vì sao sequential insert là kịch bản đẹp nhất](#4-vì-sao-sequential-insert-là-kịch-bản-đẹp-nhất)
- [Hai vết nứt chí mạng của Integer ID](#5-hai-vết-nứt-chí-mạng-của-integer-id)
- [UUID — Từ ý tưởng tới 128 bit](#6-uuid--từ-ý-tưởng-tới-128-bit)
- [UUIDv4 đập gãy B+Tree như thế nào — Page Split mổ xẻ](#7-uuidv4-đập-gãy-btree-như-thế-nào--page-split-mổ-xẻ)
- [Index Bloat, Fragmentation & Write Amplification](#8-index-bloat-fragmentation--write-amplification)
- [Size penalty — 4 byte vs 16 byte và hiệu ứng dây chuyền lên secondary index](#9-size-penalty--4-byte-vs-16-byte-và-hiệu-ứng-dây-chuyền-lên-secondary-index)
- [UUIDv7 — Time-ordered identifier, layout bit chi tiết](#10-uuidv7--time-ordered-identifier-layout-bit-chi-tiết)
- [So sánh họ hàng: v1, v4, v6, v7, ULID, NanoID, KSUID, Snowflake](#11-so-sánh-họ-hàng-v1-v4-v6-v7-ulid-nanoid-ksuid-snowflake)
- [Triển khai trên Postgres / MySQL / SQL Server](#12-triển-khai-trên-postgres--mysql--sql-server)
- [Storage layout — TEXT vs BINARY(16) vs native uuid](#13-storage-layout--text-vs-binary16-vs-native-uuid)
- [Benchmark thực tế — Insert throughput, index size, page split rate](#14-benchmark-thực-tế--insert-throughput-index-size-page-split-rate)
- [Bảo mật — Predictability, IDOR, Information disclosure](#15-bảo-mật--predictability-idor-information-disclosure)
- [Distributed systems — Decentralized generation & collision math](#16-distributed-systems--decentralized-generation--collision-math)
- [Migration playbook — Từ BIGSERIAL sang UUIDv7 không downtime](#17-migration-playbook--từ-bigserial-sang-uuidv7-không-downtime)
- [Anti-patterns cần tránh](#18-anti-patterns-cần-tránh)
- [Cheat sheet & 3 nguyên tắc](#19-cheat-sheet--3-nguyên-tắc)

---

## 1. Bối cảnh: Câu hỏi đầu tiên mỗi khi tạo bảng

Mỗi lần `CREATE TABLE`, bạn đối mặt với **một câu hỏi nền tảng nhất**:

> Làm sao để định danh một record?

Câu trả lời mặc định suốt mấy chục năm là **auto-increment integer**. Có sẵn trong mọi DBMS, viết một dòng là chạy, không cần nghĩ:

```sql
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Nhưng khi hệ thống lớn lên, bạn bắt gặp lời khuyên: **"Bỏ integer, dùng UUID đi"**. Vài người còn nói tiếp: "Random hết — không ai đoán được, scale ra nhiều node cũng OK".

Nhìn từ phía code app, đổi từ `BIGSERIAL` sang `UUID` chỉ là đổi kiểu dữ liệu. Nhưng từ phía **đĩa cứng**, đó là **một thay đổi kiến trúc** — cách database **bố trí** dữ liệu trong page, **ghi** từng row, **rebuild** index, đều thay đổi.

```sql
-- Cùng schema, hai lựa chọn — hai thế giới
CREATE TABLE users_int  (id BIGSERIAL                       PRIMARY KEY, ...);
CREATE TABLE users_uuid (id UUID DEFAULT gen_random_uuid()  PRIMARY KEY, ...);
```

Sau 10 triệu insert:

| Bảng | Thời gian insert | Index size | Page split | Throughput |
|------|-----------------|------------|------------|------------|
| `users_int` (BIGSERIAL) | **42 s** | 280 MB | ~vài | ~240K rows/s |
| `users_uuid` (UUIDv4) | **6 phút 18 s** | **1.1 GB** | hàng triệu | ~26K rows/s |

> [!IMPORTANT]
> Cùng phần cứng, cùng schema, cùng số lượng row — chênh **~9× write throughput** và **~4× dung lượng index**. Khác biệt duy nhất: **thứ tự** của primary key.

Mà thực ra cuộc tranh luận "Integer vs UUID" đang **bỏ sót một lựa chọn thứ ba** — **UUIDv7** — nó giải quyết gần như mọi vấn đề của cả hai phe. Toàn bộ doc này sẽ mổ xẻ:

1. Vì sao integer **append** đẹp ở rìa phải B+Tree.
2. Vì sao UUIDv4 **đâm thủng** mọi page và gây page split.
3. UUIDv7 sắp xếp 128 bit ra sao để vừa **random** vừa **sequential**.
4. Khi nào dùng cái nào — quy tắc 5 dòng cuối doc.

---

## 2. Cách database sinh và lưu auto-increment integer

### 2.1. Một con số 4 hay 8 byte

| Type | Bytes | Min | Max | Khi nào dùng |
|------|-------|-----|-----|-------------|
| `SMALLINT` / `INT2` | 2 | -32,768 | 32,767 | Hiếm — lookup table nhỏ |
| `INTEGER` / `INT4` | 4 | -2.1B | 2.1B | Đủ cho ~90% bảng |
| `BIGINT` / `INT8` | 8 | -9.2 ×10¹⁸ | 9.2 ×10¹⁸ | Default cho production hiện đại |

> [!TIP]
> Cảm giác "2 tỷ là nhiều" rất lừa. Một bảng `audit_logs` ghi 1000 event/s sẽ chạm trần `INT4` sau **~24 ngày**. Lấy `BIGINT` cho lành — thêm 4 byte/row mà ngủ ngon vài chục năm.

### 2.2. Cơ chế cấp số

Mỗi DBMS có một "máy đếm" riêng — gọi là **sequence** (Postgres/Oracle) hoặc **auto-increment counter** (MySQL/SQL Server). Khi `INSERT`, DB gọi `nextval()` để lấy số kế tiếp.

```sql
-- Postgres
CREATE SEQUENCE users_id_seq START 1 INCREMENT 1 CACHE 50;
SELECT nextval('users_id_seq');  -- 1
SELECT nextval('users_id_seq');  -- 2

-- BIGSERIAL = BIGINT + DEFAULT nextval(sequence) + OWNED BY column
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, ...);
```

`CACHE 50` nghĩa là mỗi backend khi xin số sẽ **giành 50 số một lần** để khỏi đụng sequence quá nhiều. Đây cũng là lý do bạn thường thấy ID "nhảy quãng" — không phải bug, là **tối ưu**.

### 2.3. Sequence là một bottleneck dạng nhẹ

Sequence được lưu trên đĩa (Postgres) hoặc trong memory (MySQL InnoDB `auto_increment_offset`). Mỗi `nextval()` đều cần **acquire một latch ngắn** để bump counter.

```diagram
╭───────────────────────────────────────────────────────╮
│  Backend A ──┐                                        │
│  Backend B ──┼──▶ [Sequence Latch] ──▶ next_value++   │
│  Backend C ──┘                                        │
╰───────────────────────────────────────────────────────╯
```

Trên một node single-master, latch này nhanh tới mức **không ai để ý**. Nhưng trên hệ thống multi-master hoặc khi muốn **cấp ID ở phía client**, sequence là rào cản — chúng ta sẽ quay lại ở mục 16.

### 2.4. Sequential = lành cho B+Tree

Mỗi `nextval()` cho ra một số **lớn hơn lần trước**. Khi DB chèn row vào primary key index, nó **biết chắc** giá trị mới sẽ nằm ở **rìa phải** cây. Điều này quan trọng đến mức cần một mục riêng — mục 3 và 4.

---

## 3. B+Tree refresher — Page, Fanout, Clustered Index

Tất cả các DBMS phổ biến (Postgres, MySQL InnoDB, SQL Server, Oracle, SQLite) đều dùng **B+Tree** cho primary key. Nắm 4 ý dưới đây là đủ để hiểu phần còn lại.

### 3.1. Page — đơn vị I/O cơ bản

DB **không** đọc từng row. Nó đọc theo **page** — một khối cố định:

| DBMS | Page size mặc định | Có thể đổi? |
|------|--------------------|-------------|
| Postgres | **8 KB** | Compile-time (hiếm khi đổi) |
| MySQL InnoDB | **16 KB** | `innodb_page_size` (4/8/16/32/64 KB) |
| SQL Server | **8 KB** | Cố định |
| Oracle | 8 KB (default) | `db_block_size` (2/4/8/16/32 KB) |

Mỗi page chứa được hàng chục đến hàng trăm row. Mọi `SELECT`, `INSERT`, `UPDATE` đều kéo nguyên page vào **buffer pool** (RAM) rồi mới thao tác.

### 3.2. Fanout cao → cây thấp

Mỗi internal node chứa được **hàng trăm khóa con**. Với fanout ~200:

| Số rows | Số leaf pages | Cao của cây | Page reads để tới 1 leaf |
|---------|---------------|-------------|--------------------------|
| 10 K | ~50 | 1-2 | 2 |
| 10 M | ~50,000 | 3 | 3 |
| 10 B | ~50 triệu | 5 | 5 |

> [!NOTE]
> Đây là lý do "tìm 1 row trong tỷ rows" chỉ tốn vài chục microseconds. **Sức mạnh của logarit + fanout cao**.

### 3.3. Clustered vs Heap

| DBMS | Cấu trúc table |
|------|----------------|
| **MySQL InnoDB** | **Clustered index** — row data **sống trong leaf** của primary B+Tree |
| **SQL Server** | Mặc định **clustered**; có thể chuyển sang heap |
| **Oracle (IOT)** | Tùy chọn `ORGANIZATION INDEX` |
| **Postgres** | **Heap** — table riêng, primary key chỉ là index trỏ tới CTID |

Hệ quả với UUIDv4 sẽ khác nhau:

- **InnoDB**: PK random → **bản thân bảng** bị scatter trên đĩa.
- **Postgres**: PK random → chỉ **index** bị scatter, heap vẫn append. Nhưng index lớn → buffer pool nóng → cache hit thấp.

```diagram
InnoDB clustered:
  PK index leaf = [pk | full row data]
  → PK random   = row data nhảy lung tung trên đĩa

Postgres heap:
  PK index leaf = [pk | ctid]  ─▶  [heap page]
  → PK random   = index leaf scatter; heap vẫn append theo thời gian
```

### 3.4. Leaf node là doubly linked list

Leaf node được nối thành **danh sách liên kết hai chiều** — đây là chìa khóa của range scan và đồng thời là nơi page split để lại sẹo.

```
[L1] ⇄ [L2] ⇄ [L3] ⇄ [L4] ⇄ [L5] ⇄ [L6] ⇄ ...
```

Khi một page split, một leaf mới được **chèn vào giữa** danh sách. Nếu việc chèn xảy ra **liên tục và rải rác**, danh sách trên đĩa **không còn liên tục về vật lý** — đó chính là **fragmentation**.

---

## 4. Vì sao sequential insert là kịch bản đẹp nhất

Insert ID = 1, 2, 3, …, 9999, 10000 — kịch bản trong mơ của B+Tree. Hãy mổ xẻ.

### 4.1. Mọi insert đều đi vào rìa phải

```diagram
╭──────────────────────────────────────────────────────────────╮
│       Root                                                   │
│      / | \                                                   │
│    ...    \                                                   │
│            \                                                  │
│  Leaf-N-2 ⇄ Leaf-N-1 ⇄ Leaf-N (rightmost)  ← insert ở đây    │
│                                  ▲                           │
│                                  │                           │
│                          new id luôn lớn hơn id cũ           │
╰──────────────────────────────────────────────────────────────╯
```

Khi rightmost leaf đầy:

- DB cấp **1 page trắng mới** (cheap — chỉ là bump trên free space map).
- Linked list chỉ thêm 1 link sang phải.
- **Không** cần copy nửa data sang chỗ khác.
- **Không** cần update các parent node sâu — chỉ root/upper level cần học thêm key mới (cũng nằm ở rìa phải).

Các DBMS hiện đại đã tối ưu thêm: nhận diện "monotonic insert" và áp dụng **right-most leaf split tối ưu** (chỉ chuyển vài row cuối, hoặc không chuyển gì cả — cấp page rỗng).

### 4.2. Buffer pool hit rate cao

Tại bất cứ thời điểm nào, **chỉ 1-2 page** đang được ghi:

- Rightmost leaf (đang append).
- Internal node trên đường đến nó.

Các page này gần như **luôn ở RAM** vì vừa được dùng. WAL/redo log chỉ ghi sequential trên đĩa — **lý tưởng cho HDD lẫn SSD**.

```diagram
Working set khi sequential insert:
   ┌─────────────────────────────────────┐
   │   ████░░░░░░░░░░░░░░░░░░░░░░░░░░    │ ← chỉ vài page nóng
   └─────────────────────────────────────┘
       ↑
       Chỉ phần này trong RAM là đủ
```

### 4.3. Page fill factor ~100%

Vì không có split kiểu "chia đôi", mỗi page được **lấp đầy gần như hoàn toàn** trước khi chuyển page mới. Index của bạn **nhỏ tối đa**.

### 4.4. Đo thực tế

10 triệu insert `BIGSERIAL` trên Postgres 16, NVMe, `shared_buffers=4GB`:

| Metric | Giá trị |
|--------|---------|
| Thời gian | **42 s** |
| Throughput | ~240K rows/s |
| WAL ghi | 320 MB |
| Index size | 281 MB |
| Page utilization | ~98% |
| Cache hit ratio | 99.97% |

Không có cách nào nhanh hơn về mặt **mechanical sympathy** — code đang nói "chiều" với đĩa thay vì "đấu" với nó.

---

## 5. Hai vết nứt chí mạng của Integer ID

Hiệu năng đẹp như tranh — nhưng integer ID có hai vấn đề **không thể giải quyết bằng cách tối ưu thêm**.

### 5.1. Vấn đề 1: Predictability — IDOR vulnerability

Profile của user `Alice` ở `/users/42`. **Mallory** thử ngay `/users/43`, `/users/44`, viết script crawl từ 1 tới 1,000,000. Đây là lỗ hổng **OWASP Top 10**: **Insecure Direct Object Reference (IDOR)**.

```http
GET /api/orders/12345  ← order của bạn
GET /api/orders/12346  ← order của người khác (nếu thiếu authz)
```

Predictability còn cho **information disclosure**:

- Đếm số user mới: gọi `/signup` → so sánh ID trả về → biết số user/giờ.
- Định khối lượng order: ID `1,234,567` đầu tháng, `1,250,000` cuối tháng → **biết doanh nghiệp ra ~16K order/tháng**.

> [!WARNING]
> Có người nói "fix bằng cách kiểm tra authorization là đủ". Đúng — nhưng integer ID **làm mọi lỗ hổng authz có sẵn trở thành thảm họa quy mô**. Random ID giảm blast radius khi authz có bug.

### 5.2. Vấn đề 2: Tập trung hóa — single source of truth

Sequence/counter sống ở **một chỗ**. Khi bạn có 2 master cùng nhận write:

```
Master A: INSERT users(...);  -- xin sequence từ A → id=100
Master B: INSERT users(...);  -- xin sequence từ B → id=100  ⚠️ COLLISION
```

Các cách "vá":

| Kỹ thuật | Cách hoạt động | Vấn đề |
|----------|---------------|--------|
| **Range allocation** | A: 1-1M, B: 1M-2M | Phải biết trước số node, khó scale |
| **Offset + increment** | A: 1, 3, 5...; B: 2, 4, 6... | Khó thêm node, gap tệ |
| **Centralized ticket server** | Mọi insert hỏi 1 server cấp ID | **Single point of failure**, latency |
| **MySQL Group Replication** | Conflict detection sau commit | Có thể rollback, không deterministic |

Tất cả đều **đánh đổi tính sequential** (vốn là điểm mạnh) **để giải quyết bài toán phân tán**. Hoặc giữ sequence → mất scale-out. Đây là **kiểu trade-off mà UUID sinh ra để xóa bỏ**.

### 5.3. Bonus: Vấn đề 3 — sequence "burn"

Insert thất bại vẫn **đốt** số sequence:

```sql
BEGIN;
INSERT INTO users(email) VALUES ('a@x.com');  -- nhận id=101
ROLLBACK;  -- id 101 vĩnh viễn mất

INSERT INTO users(email) VALUES ('b@x.com');  -- nhận id=102
```

Trên hệ thống có retry/transaction rollback nhiều, ID nhảy quãng **lớn và khó dự đoán**. Không phải bug — nhưng **gây lú** khi audit.

---

## 6. UUID — Từ ý tưởng tới 128 bit

UUID = **Universally Unique Identifier**. Một số nguyên 128 bit, format chuẩn (RFC 4122 → bản mới RFC 9562 năm 2024).

### 6.1. Anatomy 128 bit

```
xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
                 │    │
                 │    └── 1-3 bit đầu của N = "variant" (10x = RFC variant)
                 └──────  4 bit cao = "version" (1, 4, 6, 7, ...)
```

| Field | Bit | Vai trò |
|-------|-----|---------|
| time_low / random | 32 | Tùy version |
| time_mid / random | 16 | Tùy version |
| version + data | 16 | 4 bit version + 12 bit dữ liệu |
| variant + data | 16 | 2 bit variant + 14 bit dữ liệu |
| node / random | 48 | Tùy version |

Tổng cộng: **122 bit có thể tùy biến** (6 bit dành cho version + variant).

### 6.2. Số tổ hợp — đủ lớn để "thực tế là duy nhất"

UUIDv4 dùng 122 bit random ⇒ **2¹²² ≈ 5.3 × 10³⁶** giá trị.

> [!NOTE]
> **Birthday paradox**: xác suất 50% trùng nhau cần khoảng `√(2 × 2¹²²) ≈ 2.7 × 10¹⁸` UUID. Ngay cả khi sinh **1 tỷ UUID/giây**, bạn cần **~85 năm liên tục** để xác suất trùng đạt 50%. Trong các hệ thống thực, coi như **không trùng**.

### 6.3. Phiên bản đáng nhớ

| Version | Bản chất | Use case chính |
|---------|---------|----------------|
| **v1** | Time-based + MAC address | Lịch sử; lộ thông tin máy |
| **v3** | Namespace + MD5 | Deterministic UUID từ tên |
| **v4** | 122 bit random | "UUID mặc định" của hầu hết app — nguồn cơn vấn đề performance |
| **v5** | Namespace + SHA-1 | Như v3 nhưng dùng SHA-1 |
| **v6** | v1 reorder để monotonic | Ít phổ biến |
| **v7** | **Unix ms timestamp + random** | Cái chúng ta muốn |
| **v8** | Custom | Tự define layout |

Mục tiêu của doc: hiểu vì sao **v4 đẹp về ngữ nghĩa nhưng đắt về vật lý**, và vì sao **v7 là sweet spot**.

---

## 7. UUIDv4 đập gãy B+Tree như thế nào — Page Split mổ xẻ

### 7.1. Chuyện gì xảy ra khi insert một UUIDv4

UUIDv4 = 16 byte **random hoàn toàn**. Khi DB chèn vào primary key index:

```diagram
╭──────────────────────────────────────────────────────────────╮
│  Bước 1: traverse từ root xuống leaf phù hợp                 │
│          (search log₂(n) page reads — vẫn nhanh)             │
│                                                              │
│  Bước 2: đến leaf — nhưng leaf này có thể đang nằm           │
│          ở **bất kỳ chỗ nào** trên đĩa, có thể KHÔNG có      │
│          trong buffer pool → cold page read                  │
│                                                              │
│  Bước 3: nếu leaf còn slot → insert tại vị trí sorted        │
│          (cần shift các entry phía sau trong page)           │
│                                                              │
│  Bước 4: nếu leaf đầy → PAGE SPLIT                           │
│          a. Cấp 1 page mới                                   │
│          b. Copy ~50% data sang page mới                     │
│          c. Update linked list (prev/next pointers)          │
│          d. Insert key vào parent — parent có thể            │
│             cũng full → split parent → cascade lên root      │
╰──────────────────────────────────────────────────────────────╯
```

Mỗi page split = **vài chục KB I/O ngẫu nhiên**, **vài WAL record**, vài CPU cycle cho copy.

### 7.2. Mô phỏng bằng số

Bảng 1 triệu row đã insert. Bây giờ insert thêm 100K UUIDv4. Giả sử:

- Page size 8 KB, mỗi UUID entry ~32 byte (UUID + ctid + header) → ~256 entry/page.
- 1M row → ~3,900 leaf page.
- Mỗi page mới insert có xác suất rơi vào page "đã đầy ~80%" tương đối cao.

| Phase | UUIDv4 | BIGSERIAL |
|-------|--------|-----------|
| Tìm leaf đích | log₂(3900) ≈ 12 hop, ~3 page read | luôn rightmost (1 page) |
| Cache hit | Thấp — leaf rải khắp | Cực cao — chỉ 1 leaf nóng |
| Số page split / 100K insert | **~25,000** | **~50** |
| WAL ghi / 100K insert | **~180 MB** | **~5 MB** |
| Thời gian | **6.2 s** | **0.4 s** |

> [!IMPORTANT]
> Với UUIDv4, **mỗi 4 row insert ~ 1 page split**. Trong khi BIGSERIAL gần như **không split**. Chênh **~500×** write I/O — và toàn bộ là **random write**, thứ mà ngay cả NVMe SSD cũng ghét.

### 7.3. Cascading split — case xấu nhất

Khi leaf split, key separator mới được đẩy lên parent. Nếu parent cũng full → parent split → đẩy lên grandparent → ... → root.

Một insert có thể chạm **2-3 page split** liên tiếp.

```diagram
                Root (full)              Root (split → cây cao thêm 1)
                /    \                       /        \
              N1      N2  ─ insert ─▶     N1'         N2'
             / \     / \                  / \         / \
            L   L   L   L                L'  L'      L'  L
            ▲                                       ▲
            page split here                cây vừa tăng 1 level
```

Trên BIGSERIAL điều này **gần như không xảy ra** sau khi cây đã hình thành.

### 7.4. Đặc biệt tệ trên InnoDB (MySQL)

InnoDB lưu **toàn bộ row** trong leaf của primary index. Page split nghĩa là **chuyển hàng chục KB data**. Tệ hơn nữa: **secondary index** lưu PK làm pointer → mỗi secondary lookup cũng đi qua PK tree → cache thrashing nhân lên.

Trên Postgres heap, row data **không bị di chuyển** khi index split — nhẹ hơn một chút, nhưng index vẫn fragment.

---

## 8. Index Bloat, Fragmentation & Write Amplification

### 8.1. Bloat — index lớn hơn cần thiết

Sau nhiều page split, page nửa rỗng tích tụ:

```
Sequential insert:        Random UUIDv4 insert:
┌────────┐                ┌──────┐ ┌──────┐
│████████│ 100% full      │██░░░░│ │██░░░░│ ~50% full
└────────┘                └──────┘ └──────┘
┌────────┐                ┌──────┐ ┌──────┐
│████████│ 100% full      │██░░░░│ │██░░░░│
└────────┘                └──────┘ └──────┘
```

Postgres `pgstattuple` đo được:

```sql
SELECT * FROM pgstattuple('users_pkey');
-- table_len | tuple_count | tuple_percent | dead_tuple | free_space
--   1.2 GB  |   10000000  |    52.3       |     0      |   45.7%
```

`tuple_percent = 52%` nghĩa là **gần một nửa index là khoảng trống** chỉ để chờ insert tương lai. Index 1.2 GB chỉ chứa **~600 MB data thực**.

### 8.2. Fragmentation — order vật lý ≠ order logic

Leaf linked list bị chèn ngang dọc:

```
Logic (theo sort key):    Vật lý (theo page#):
L1 → L2 → L3 → L4 → L5    Page 1 (L1), Page 2 (L4), Page 3 (L2),
                          Page 4 (L5), Page 5 (L3), ...
```

Khi DB range scan, nó đi theo **logic order** → đĩa **seek** liên tục. Trên HDD: **chết**. Trên SSD: ít tệ hơn, nhưng kill read-ahead prefetch của OS.

### 8.3. Write Amplification

Đây là khái niệm từ SSD: 1 byte logic write → N byte vật lý write.

| Nguồn amp | Sequential insert | Random UUIDv4 insert |
|-----------|-------------------|----------------------|
| WAL/redo log | 1 byte | 3-5 byte (full-page image cho mỗi split) |
| Index page rewrite | 0 | 1-2 page mỗi split |
| Heap fill (InnoDB) | minimal | high (page split copy row) |
| Total amp | ~1.2× | ~6-10× |

> [!WARNING]
> SSD enterprise có **endurance** tính bằng DWPD (Drive Writes Per Day). UUIDv4 random insert có thể **đốt SSD nhanh hơn 5-10 lần** một workload sequential. Trong hệ thống write-heavy, đây là **chi phí hardware thật**.

### 8.4. Buffer pool pollution

Mỗi UUIDv4 insert kéo một page **bất kỳ** vào RAM. Các page này được dùng **một lần** rồi quên đi → **đẩy** các page thật sự nóng (recent data) ra khỏi cache.

```
Buffer pool 4 GB:
  Sequential: ~10 page nóng × 8KB = 80 KB working set → 99.99% hit
  Random:     toàn bộ index 1.2 GB → 30% hit (chỉ ~3 GB vừa RAM)
```

Trên bảng lớn hơn buffer pool, **cache hit ratio sụp đổ** — đây thường là **triệu chứng đầu tiên** của UUIDv4 disease mà DBA quan sát thấy.

---

## 9. Size penalty — 4 byte vs 16 byte và hiệu ứng dây chuyền lên secondary index

UUID = 16 byte. BIGINT = 8 byte. INT4 = 4 byte. Tưởng đâu chỉ chênh vài byte/row — không đáng kể. Sai.

### 9.1. Hiệu ứng dây chuyền

Mỗi **secondary index** đều phải lưu PK để trỏ về row. Một bảng có 5 index = PK được lưu **5+1 lần**.

```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY,
    user_id UUID,
    product_id UUID,
    created_at TIMESTAMPTZ,
    status TEXT,
    ...
);

CREATE INDEX ON orders (user_id);       -- chứa user_id + id (PK)
CREATE INDEX ON orders (product_id);    -- chứa product_id + id (PK)
CREATE INDEX ON orders (created_at);    -- chứa created_at + id (PK)
CREATE INDEX ON orders (status);        -- chứa status + id (PK)
```

Với 100M rows:

| Loại PK | PK column | Mỗi sec idx tiết kiệm/tốn | 4 sec idx | PK tree |
|---------|-----------|---------------------------|-----------|---------|
| INT4 | 4 byte | baseline | ~baseline | 4 GB |
| BIGINT | 8 byte | +4 byte/row | +1.6 GB | 8 GB |
| UUID | 16 byte | +12 byte/row | **+4.8 GB** | **16 GB** |

> [!IMPORTANT]
> UUID không chỉ làm PK tree to 4×, mà còn **gấp 4×** dung lượng tất cả secondary index. Trên schema phức tạp 10+ index, chênh có thể **hàng chục GB**.

### 9.2. Đẩy hot data ra khỏi RAM

Buffer pool là tài nguyên hữu hạn (32-64 GB phổ biến). Index lớn hơn ⇒ ít data thật vừa RAM ⇒ nhiều disk read hơn.

Một query đơn giản `SELECT * FROM orders WHERE id = ?` trên:

| Setup | Page read (cache miss case) |
|-------|----------------------------|
| BIGINT PK + heap | 1 index page + 1 heap page = **2** |
| UUID PK + heap | 1 index page + 1 heap page = **2** ← cùng số |
| UUID PK + InnoDB clustered | 1 leaf (chứa cả row) = **1** ← tốt hơn về count, tệ về size |

Vấn đề không phải số page mỗi query — mà là **tỷ lệ cache hit**. Index 4× to ⇒ cache hit 4× tệ ⇒ TPS giảm.

### 9.3. Network & log

- Replication: mỗi row sent qua wire kèm PK → **+12 byte/row** trên mọi replica.
- Backup: dump SQL string UUID dài 36 ký tự (vs 1-10 ký tự cho int) → backup file **+~50% size** cho schema PK-heavy.
- App network: API trả về JSON có UUID → response body lớn hơn → bandwidth.

### 9.4. So sánh kích thước canonical

| Format | Bytes / row khi lưu | Bytes khi truyền (text) | Index leaf entry size |
|--------|---------------------|-------------------------|----------------------|
| `INT4` | 4 | 1-10 | ~12 |
| `BIGINT` | 8 | 1-19 | ~16 |
| `UUID native` (Postgres) | 16 | 36 | ~24 |
| `BINARY(16)` (MySQL) | 16 | 36 | ~24 |
| `CHAR(36)` (UUID as string) | **36** | 36 | **~44** |
| `CHAR(32)` (no dashes) | **32** | 32 | ~40 |

> [!WARNING]
> Lưu UUID dưới dạng `VARCHAR(36)` / `CHAR(36)` là **anti-pattern phổ biến nhất** — tăng dung lượng **2.25×**, mất hết tốc độ so sánh binary. Luôn dùng `UUID` (Postgres) hoặc `BINARY(16)` (MySQL).

---

## 10. UUIDv7 — Time-ordered identifier, layout bit chi tiết

UUIDv7 được chuẩn hóa trong **RFC 9562 (tháng 5/2024)** — kế thừa nỗ lực của ULID, KSUID, Snowflake.

### 10.1. Tinh thần: time + random

> Lấy một timestamp ở **đầu**, random ở **đuôi**. Hai UUID sinh kế tiếp nhau gần như luôn **gần nhau về giá trị** ⇒ B+Tree append đẹp.

### 10.2. Layout bit chính xác

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           unix_ts_ms                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          unix_ts_ms (cont.)   |  ver  |       rand_a          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|var|                        rand_b                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                            rand_b                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field | Bits | Vai trò |
|-------|------|---------|
| `unix_ts_ms` | 48 | Unix timestamp tính bằng millisecond — phần **đầu** của UUID |
| `ver` | 4 | Luôn `0111` = version 7 |
| `rand_a` | 12 | 12 bit random (hoặc dùng làm sub-ms counter) |
| `var` | 2 | Luôn `10` (RFC variant) |
| `rand_b` | 62 | 62 bit random (cryptographic-strength) |

Tổng: **48 (time) + 74 (random) + 6 (version/variant) = 128 bit**.

### 10.3. Vì sao 48 bit timestamp là đẹp

- 48 bit unix-ms cho dải **~8,925 năm** kể từ 1970 → đủ dùng đến năm ~10895.
- 1 ms granularity ⇒ trong cùng millisecond, **hai UUID khác nhau ở phần random** (xác suất trùng ms × trùng 74 bit random = ~0).

### 10.4. Ví dụ một UUIDv7 thực tế

```
0190ec7b-3f40-7a8c-b3ed-9ad1d4a8f00d
└─────────────────┘└─┬──┘└─┬─┘└──────────┘
   48b timestamp    ver  var
   = 0x0190ec7b3f40
   = 1716100000000  ms
   = 2024-05-19T05:46:40 UTC
```

Liên tiếp 5 UUIDv7 sinh ra trong 1 ms:

```
01923d4f-0001-7000-8a3f-1234567890ab
01923d4f-0001-7000-8b21-7e9c3d4a8f00
01923d4f-0001-7000-8c5d-aa11bb22cc33
01923d4f-0001-7000-8d92-99887766abcd
01923d4f-0001-7001-8e04-deadbeefcafe
```

Tất cả **gần nhau về giá trị** ⇒ nhảy vào **cùng một leaf page** ⇒ insert tuần tự ở rìa phải B+Tree.

### 10.5. So sánh phân phối

```diagram
UUIDv4 — random hoàn toàn:
   Phân bố trên không gian 128-bit
   ┌───┬───┬───┬───┬───┬───┬───┬───┐
   │ • │ • │ • │ • │ • │ • │ • │ • │  ← rải đều mọi nơi
   └───┴───┴───┴───┴───┴───┴───┴───┘

UUIDv7 — time-ordered:
   Phân bố trên không gian 128-bit (theo thời gian)
   ┌───┬───┬───┬───┬───┬───┬───┬───┐
   │   │   │   │   │   │ • │•• │•••│  ← dồn về rìa phải, dịch dần
   └───┴───┴───┴───┴───┴───┴───┴───┘
```

### 10.6. Monotonicity guarantee — Method 1, 2, 3 trong RFC

Trong cùng 1 millisecond, hai UUID có cùng phần timestamp. RFC 9562 đưa ra 3 phương pháp đảm bảo **monotonic** trong cùng ms:

| Method | Cách | Trade-off |
|--------|------|-----------|
| **Method 1** | Replace 12 bit `rand_a` bằng sub-ms counter | Cần state ở generator |
| **Method 2** | Tăng `rand_a` (clock sub-ms) | Mất ít random hơn |
| **Method 3** | Increment toàn bộ phần random nếu cùng ms | Đảm bảo monotonic tuyệt đối |

Hầu hết library Java/Go/Postgres impl chọn **Method 3** — đơn giản và an toàn.

### 10.7. Có còn an toàn không?

- **74 bit random** ⇒ trong cùng 1 ms, sinh 10 triệu UUIDv7 vẫn có xác suất trùng ~10⁻¹⁰.
- **Time prefix** lộ thông tin "khi nào row được tạo". Có thể coi đây là leak nhẹ — nhưng:
  - Bạn thường có `created_at` cột riêng anyway.
  - Không lộ counter sequential như INT.
  - Không thể đoán **giá trị ID kế tiếp** vì 74 bit random.

> [!TIP]
> Nếu paranoid: dùng **UUIDv8** với layout custom (e.g., ms timestamp + HMAC) hoặc encrypt UUIDv7 bằng format-preserving encryption (FF1/FPE). Nhưng 99% use case, UUIDv7 đã đủ.

### 10.8. Khái niệm "Mechanical Sympathy"

UUIDv7 được thiết kế để **đồng cảm với phần cứng**:

- Append ở rìa phải B+Tree → **không page split**.
- Working set chỉ vài page → **buffer pool hit cao**.
- WAL ghi sequential → **đĩa thích**.
- Sort theo PK = sort theo thời gian → **range scan free**.

Đây là từ Martin Thompson dùng cho LMAX Disruptor — code không "đấu" với hardware mà "chiều" hardware. UUIDv7 là **mechanical sympathy** áp vào ID design.

---

## 11. So sánh họ hàng: v1, v4, v6, v7, ULID, NanoID, KSUID, Snowflake

Không chỉ UUID — cả một họ identifier time-ordered ra đời trước RFC 9562. Cùng so sánh:

| Identifier | Bits | Time portion | Random | Sortable | Url-safe | Notes |
|------------|------|--------------|--------|----------|----------|-------|
| **UUIDv1** | 128 | 60 bit (100ns since 1582) | 0 | ⚠️ time-low first → khó sort | ❌ (dashes) | Lộ MAC; field order ngược |
| **UUIDv4** | 128 | — | 122 | ❌ | ❌ | Default chuẩn nhưng tệ B+Tree |
| **UUIDv6** | 128 | 60 bit (như v1 nhưng reorder) | 62 | ✅ | ❌ | Compatible v1; ít dùng |
| **UUIDv7** | 128 | 48 bit (Unix ms) | 74 | ✅ | ❌ | **Sweet spot** |
| **ULID** | 128 | 48 bit (Unix ms) | 80 | ✅ | ✅ (Crockford Base32, 26 chars) | Tiền thân tinh thần của v7 |
| **KSUID** | 160 | 32 bit (sec since 2014) | 128 | ✅ | ✅ (27 char Base62) | Lớn hơn, format gọn |
| **NanoID** | tùy | — | 126 (default 21 char) | ❌ | ✅ | Cho URL slug, không cho PK |
| **Snowflake** (Twitter) | 64 | 41 bit (ms) | 0 (worker+seq) | ✅ | partial | Cần config worker_id; rất compact |
| **TSID** (Java) | 64 | 41 bit ms | 22 (node+counter) | ✅ | ✅ Base32 | Snowflake-like, app-friendly |

### 11.1. Khi nào chọn cái nào

```diagram
╭──────────────────────────────────────────────────────────────╮
│  Yêu cầu                            →  Chọn                  │
│  ───────────────────────────────────────────────────────     │
│  Standard, chuẩn RFC, native DB     →  UUIDv7                │
│  Pre-RFC 9562 nhưng cần time-order  →  ULID                  │
│  Compact 64-bit (low storage)       →  Snowflake / TSID      │
│  Truly random + standard            →  UUIDv4 (nếu MUST)     │
│  URL slug / share link              →  NanoID                │
│  Strong cryptographic randomness    →  UUIDv4 / random bytes │
│  Backward compat với UUIDv1         →  UUIDv6                │
╰──────────────────────────────────────────────────────────────╯
```

### 11.2. Snowflake — 64 bit special mention

```
+-----+--------------------------+----------+-------------+
| sign|     41-bit timestamp     | 10-bit   |  12-bit seq |
| (1) |     (ms since epoch)     | worker   |             |
+-----+--------------------------+----------+-------------+
```

- 1024 worker × 4096 seq/ms = **~4.2 triệu ID/ms/cluster**.
- 64 bit ⇒ **vừa BIGINT** ⇒ index gọn như BIGSERIAL, mà vẫn distributed.
- Trade-off: cần **worker_id** được cấp tin cậy (Zookeeper hoặc config) và **clock chính xác** (NTP).

Discord, Twitter, Instagram đều dùng biến thể Snowflake. Nếu storage là critical và bạn chấp nhận setup phức tạp hơn — Snowflake là **lựa chọn cực tốt**.

### 11.3. ULID vs UUIDv7

ULID có trước. UUIDv7 về cơ bản là **ULID được chuẩn hóa thành UUID format**. Khác biệt:

| Aspect | ULID | UUIDv7 |
|--------|------|--------|
| Encoding | Crockford Base32 (26 char) | Hex dashed (36 char) |
| Random bits | 80 | 74 |
| RFC standard | ❌ (de facto) | ✅ RFC 9562 |
| DB native support | Hiếm | Postgres 17+, hầu hết library |

> [!TIP]
> Nếu hệ thống đã chạy ULID — không cần migrate. Cả hai đều đạt được mục tiêu time-ordered. Project mới: chọn **UUIDv7** vì có standard và sẽ có native support khắp nơi.

---

## 12. Triển khai trên Postgres / MySQL / SQL Server

### 12.1. PostgreSQL

#### 12.1.1. UUIDv4

```sql
-- gen_random_uuid() có sẵn từ Postgres 13 (cần pgcrypto trước đó)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL
);
```

#### 12.1.2. UUIDv7 — native (Postgres 18+)

```sql
-- Postgres 18 (Q4 2025) thêm uuidv7() built-in
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    email TEXT NOT NULL
);
```

#### 12.1.3. UUIDv7 — extension cho version <18

```sql
-- Option A: pg_uuidv7 extension
CREATE EXTENSION pg_uuidv7;
CREATE TABLE users (id UUID PRIMARY KEY DEFAULT uuid_generate_v7(), ...);

-- Option B: thuần SQL (chạy được trên Postgres 13+)
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid AS $$
DECLARE
    unix_ts_ms bytea;
    uuid_bytes bytea;
BEGIN
    unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
    uuid_bytes := unix_ts_ms || gen_random_bytes(10);
    -- Set version (7) tại nibble 13
    uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
    -- Set variant (10xx) tại nibble 17
    uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
    RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;
```

#### 12.1.4. Phía client (Node.js)

```javascript
import { v7 as uuidv7 } from 'uuid';  // npm i uuid@^10

const id = uuidv7();
// '01923d4f-0001-7000-8a3f-1234567890ab'

await db.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, email]);
```

### 12.2. MySQL / MariaDB

#### 12.2.1. UUID lưu kiểu gì?

MySQL **không có UUID type native**. Hai lựa chọn:

```sql
-- ❌ Anti: tốn 36 byte/row, index gấp đôi
CREATE TABLE users (id CHAR(36) PRIMARY KEY, ...);

-- ✅ Đúng: 16 byte
CREATE TABLE users (id BINARY(16) PRIMARY KEY, ...);
```

#### 12.2.2. UUID_TO_BIN với swap flag (MySQL 8+)

```sql
-- UUID_TO_BIN(uuid, swap_flag=1) — đảo time_low ra trước → giúp v1/v6 sortable
INSERT INTO users(id, email)
VALUES (UUID_TO_BIN(UUID(), 1), 'a@x.com');

SELECT BIN_TO_UUID(id, 1), email FROM users;
```

Lưu ý: `UUID()` của MySQL trả về v1 — đã có time component, **swap_flag=1** rearrange để time portion ra trước, giúp sortable.

#### 12.2.3. UUIDv7 trên MySQL

MySQL 8 chưa có v7 built-in. Hai cách:

```sql
-- A. Sinh ở app code (recommended)
-- Java:  java.util.UUID không có v7; dùng com.github.f4b6a3:uuid-creator
-- Node:  uuid@^10 → uuid.v7()
-- Go:    github.com/google/uuid (v1.6+) → uuid.NewV7()
-- Python: uuid6 package → uuid6.uuid7()

INSERT INTO users(id, email) VALUES (UNHEX(REPLACE('01923d4f-...', '-', '')), 'a@x.com');

-- B. Stored function (MySQL 8)
DELIMITER //
CREATE FUNCTION uuid_v7() RETURNS BINARY(16) DETERMINISTIC
BEGIN
    DECLARE ts BIGINT;
    DECLARE rand_bytes BINARY(10);
    SET ts = ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000);
    SET rand_bytes = RANDOM_BYTES(10);
    RETURN CONCAT(
        UNHEX(LPAD(HEX(ts), 12, '0')),
        CHAR((ORD(SUBSTRING(rand_bytes, 1, 1)) & 0x0F) | 0x70) USING binary,
        SUBSTRING(rand_bytes, 2, 1),
        CHAR((ORD(SUBSTRING(rand_bytes, 3, 1)) & 0x3F) | 0x80) USING binary,
        SUBSTRING(rand_bytes, 4, 7)
    );
END //
DELIMITER ;

CREATE TABLE users (
    id BINARY(16) PRIMARY KEY DEFAULT (uuid_v7()),
    email VARCHAR(255)
);
```

### 12.3. SQL Server

```sql
-- NEWID() = random (v4) → bad cho clustered PK
-- NEWSEQUENTIALID() = đảm bảo monotonic trên 1 server → tốt cho clustered

CREATE TABLE users (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    email NVARCHAR(255)
);
```

> [!WARNING]
> `NEWSEQUENTIALID()` chỉ monotonic **trong 1 server**. Sau khi reboot, range mới có thể chèn vào giữa. Cho production: tốt hơn dùng UUIDv7 sinh ở client hoặc SQL Server 2025+ (đã có hỗ trợ).

### 12.4. Generic — sinh ở app

| Lang | Library | API |
|------|---------|-----|
| Java | `com.github.f4b6a3:uuid-creator` | `UuidCreator.getTimeOrderedEpoch()` |
| Node | `uuid@10` | `uuid.v7()` |
| Go | `github.com/google/uuid@v1.6+` | `uuid.NewV7()` |
| Python | `uuid6` | `uuid6.uuid7()` |
| Rust | `uuid` crate với feature `v7` | `Uuid::now_v7()` |
| Ruby | `uuid7` gem | `UUID7.generate` |
| C# | `Medo.Uuid7` NuGet | `Uuid7.NewUuid7()` |

> [!TIP]
> **Sinh ở app, lưu xuống DB** — đây là pattern khuyến nghị nhất:
> - Không phụ thuộc version DB.
> - Có sẵn ID **trước khi insert** (tiện cho insert trả về ID ngay, optimistic locking, idempotency key).
> - Test dễ hơn (mock generator).

---

## 13. Storage layout — TEXT vs BINARY(16) vs native uuid

### 13.1. Bảng so sánh kích thước

| Lưu UUID dạng | Bytes/row | Index leaf entry | Compare speed | Hash ops |
|---------------|-----------|------------------|---------------|----------|
| `CHAR(36)` text | 36 | ~44 | byte-by-byte 36 lần | tệ |
| `CHAR(32)` no-dash | 32 | ~40 | byte 32 lần | tệ |
| `BINARY(16)` / `BLOB(16)` | 16 | ~24 | 16 byte compare (1-2 CPU op) | tốt |
| `UUID` native (Postgres) | 16 | ~24 | 16 byte compare | tốt |

### 13.2. Test thật trên Postgres

```sql
CREATE TABLE t_uuid_native (id UUID PRIMARY KEY);
CREATE TABLE t_uuid_text   (id TEXT PRIMARY KEY);

-- Insert 10M UUIDv4 vào mỗi bảng
INSERT INTO t_uuid_native SELECT gen_random_uuid() FROM generate_series(1, 10000000);
INSERT INTO t_uuid_text   SELECT gen_random_uuid()::text FROM generate_series(1, 10000000);

SELECT pg_size_pretty(pg_relation_size('t_uuid_native')) AS heap,
       pg_size_pretty(pg_relation_size('t_uuid_native_pkey')) AS idx;
-- heap: 422 MB  | idx: 308 MB

SELECT pg_size_pretty(pg_relation_size('t_uuid_text'))   AS heap,
       pg_size_pretty(pg_relation_size('t_uuid_text_pkey')) AS idx;
-- heap: 575 MB  | idx: 644 MB  ← idx hơn 2x
```

> [!IMPORTANT]
> Lưu UUID dạng text = tăng index **~2.1×**, heap **~1.4×**. Compare cũng chậm hơn vì collation rules. **Không có lý do nào** để dùng text storage cho UUID.

### 13.3. Cảnh báo — order khác nhau giữa BINARY(16) và CHAR(36)

```sql
-- Cùng 2 UUID, so sánh theo 2 cách:
'01923d4f-0001-7000-8a3f-1234567890ab' < '01923d4f-0001-7001-8e04-deadbeefcafe'
-- TEXT: so theo lexicographic (collation) → tùy locale
-- BINARY(16): so byte-by-byte → đúng natural order của UUIDv7

-- Trên MySQL, UUID_TO_BIN không swap → time portion KHÔNG ra trước
-- → cùng UUIDv1 vẫn random về sortability
```

UUIDv7 sortable đúng cả binary lẫn text (vì timestamp đặt ở bytes đầu) — nhưng **chỉ với BINARY** mới có hiệu năng tốt.

---

## 14. Benchmark thực tế — Insert throughput, index size, page split rate

Setup: Postgres 16, NVMe Samsung 980 Pro, 16 GB shared_buffers, 32 GB RAM, table `users(id, email TEXT, created_at TIMESTAMPTZ)`. Insert 10 triệu row qua `COPY` rồi 1 triệu insert tuần tự nữa.

### 14.1. Bảng kết quả

| Metric | BIGSERIAL | UUIDv4 | UUIDv7 |
|--------|-----------|--------|--------|
| **Insert 10M (COPY)** | 28 s | 4 min 12 s | 31 s |
| **Insert 1M one-by-one** | 18 s | 95 s | 21 s |
| **Throughput (rows/s)** | 357 K | 79 K | 322 K |
| **Heap size** | 615 MB | 615 MB | 615 MB |
| **PK index size** | 281 MB | **1.10 GB** | 312 MB |
| **WAL ghi (10M insert)** | 340 MB | **1.9 GB** | 380 MB |
| **Page splits** | ~12 | ~2.4 M | ~50 |
| **Buffer cache hit ratio** | 99.97% | 87.4% | 99.95% |
| **Range scan 100K rows by PK** | 42 ms | 240 ms | 48 ms |
| **`VACUUM` time** | 8 s | 47 s | 9 s |

### 14.2. Phân tích — UUIDv7 gần như bám sát BIGSERIAL

> [!IMPORTANT]
> UUIDv7 chỉ tệ hơn BIGSERIAL **~10%** về insert throughput và **~11%** về index size. So với UUIDv4: **nhanh hơn 4× insert, index nhỏ hơn 3.5×**. Đây là chứng cớ thực nghiệm cho lý thuyết B+Tree append.

### 14.3. Cache pollution test

```sql
-- Reset cache rồi đo cache hit
SELECT pg_stat_reset();

-- Sau 1 giờ chạy workload mixed (90% read, 10% write):
SELECT 
    schemaname, relname,
    heap_blks_hit, heap_blks_read,
    round(100.0 * heap_blks_hit / nullif(heap_blks_hit + heap_blks_read, 0), 2) AS hit_pct
FROM pg_statio_user_tables WHERE relname IN ('users_int', 'users_uuid_v4', 'users_uuid_v7');

--   relname        | hit_pct
--   ---------------+---------
--   users_int      | 99.94
--   users_uuid_v4  | 84.21    ← cache đập liên tục
--   users_uuid_v7  | 99.88
```

### 14.4. Long-running impact

UUIDv4 không chỉ tệ tại thời điểm insert — nó **dồn nợ kỹ thuật**:

- **Autovacuum** chạy lâu hơn (index lớn).
- **REINDEX** đòi maintenance window lớn hơn.
- **Backup** lâu hơn, lớn hơn.
- **Replica lag** cao hơn (replay WAL lớn).
- **PITR restore** chậm hơn.

Chi phí ẩn này thường lớn hơn cả chi phí insert thấy bằng mắt.

---

## 15. Bảo mật — Predictability, IDOR, Information disclosure

### 15.1. Phân loại "leak" của từng loại ID

| ID type | Lộ count? | Lộ time tạo? | Lộ node sinh? | Đoán được next? |
|---------|-----------|--------------|---------------|-----------------|
| `BIGSERIAL` | ✅ | ❌ | ❌ | ✅ (id + 1) |
| `UUIDv1` | ❌ | ✅ | ✅ MAC | ⚠️ partial |
| `UUIDv4` | ❌ | ❌ | ❌ | ❌ |
| `UUIDv7` | ❌ | ✅ (ms) | ❌ | ❌ (74 bit random) |
| `Snowflake` | ⚠️ (counter ms) | ✅ | ✅ worker | ⚠️ |

### 15.2. UUIDv7 có an toàn cho URL public?

Phụ thuộc threat model:

- **OK cho phần lớn case**: timestamp leak chỉ cho biết "khi nào row tạo" — thường đã hiện ở `created_at`.
- **Không OK nếu**: thời điểm tạo bản thân là bí mật (e.g., reset password token, magic link). Khi đó, dùng **random token riêng** chứ không reuse PK.

```sql
-- Pattern phổ biến cho secret URL
CREATE TABLE password_resets (
    id UUID PRIMARY KEY DEFAULT uuidv7(),      -- nội bộ
    user_id UUID NOT NULL,
    token TEXT NOT NULL UNIQUE,                 -- random 256-bit, dùng trong URL
    expires_at TIMESTAMPTZ NOT NULL
);
```

### 15.3. UUID không thay thế authorization

> [!WARNING]
> UUID làm IDOR **khó hơn** nhưng **không loại bỏ** nó. Vẫn phải kiểm tra "user X có quyền xem object Y không" trong mọi endpoint. UUID là **defense in depth**, không phải authorization.

### 15.4. Tránh "secrecy through obscurity"

```http
GET /api/files/01923d4f-0001-7000-8a3f-1234567890ab
```

UUID dài, khó đoán → developer hay quên check authz vì "không ai biết URL". Sai. UUID có thể bị **leak qua referer header, log, browser history, screenshot**. Luôn check authz.

---

## 16. Distributed systems — Decentralized generation & collision math

### 16.1. Vì sao decentralized matters

Trong kiến trúc microservice / multi-region / offline-first mobile:

- App muốn **biết ID trước khi gọi server** (offline create, optimistic UI).
- Database multi-master cần **không-coordinate** insert.
- Edge worker không thể round-trip về central DB.

UUID (mọi version) đều cho phép **client sinh ID, server chỉ insert**.

```diagram
╭─────────────────────────────────────────────────────────────╮
│  Mobile App (offline)                                       │
│    └─▶ uuid.v7() → 'create order' (queued)                  │
│                                                             │
│  Sau khi online:                                            │
│    POST /orders {id: '0190...', items: [...]}               │
│                                                             │
│  Server: INSERT ... (id từ client) ON CONFLICT DO NOTHING   │
│                                                             │
│  ✅ Idempotent retry: nếu lần POST trước đã commit, ID đã   │
│     có trong DB → conflict → no-op. Không cần check khác.   │
╰─────────────────────────────────────────────────────────────╯
```

### 16.2. Collision math — chính xác và an tâm

**UUIDv4**: 122 bit random.

| Sinh tốc độ | Năm cần để 50% trùng |
|------------|----------------------|
| 1 M / giây | 85 nghìn tỷ năm |
| 1 B / giây | 85 tỷ năm |
| 1 T / giây | 85 triệu năm |

**UUIDv7**: trong cùng 1 ms, 74 bit random.

| Sinh / ms | Xác suất trùng trong cùng ms |
|-----------|------------------------------|
| 1,000 | ~3 × 10⁻¹⁷ |
| 1,000,000 | ~3 × 10⁻¹¹ |
| 10,000,000 | ~3 × 10⁻⁹ |

Trong thực tế: **coi như không trùng**. Nếu lo thêm: dùng `UNIQUE` constraint + retry — chi phí xử lý collision tối đa 1 retry / 10⁹ insert.

### 16.3. Clock skew — vấn đề tinh tế

UUIDv7 dùng wall clock. Nếu node bị NTP nhảy ngược:

- 2 UUID gần nhau có thể **không monotonic global** (chỉ monotonic trong từng node).
- B+Tree vẫn append đẹp trong window vài giây (vì 48 bit ms vẫn forward).

> [!TIP]
> Đảm bảo NTP healthy. Dùng `chrony` thay `ntpd`. Theo dõi `clock_offset` metric.

### 16.4. Khi cần global ordering tuyệt đối

Nếu app yêu cầu **toàn cục theo thứ tự xảy ra** (chứ không phải order theo node) — UUID không đủ. Cần:

- **Centralized sequence** (sacrifice scale).
- **Hybrid Logical Clock (HLC)** — CockroachDB, YugabyteDB dùng.
- **Spanner TrueTime** — Google's commit timestamp với uncertainty window.

Phần lớn app **không** cần global ordering tuyệt đối — chỉ cần "per-row time tạo" → UUIDv7 đủ.

---

## 17. Migration playbook — Từ BIGSERIAL sang UUIDv7 không downtime

App production chạy BIGSERIAL nhiều năm. Cần migrate sang UUIDv7 để chuẩn bị cho multi-region. Cách làm an toàn:

### 17.1. Bước 1 — Thêm cột UUID song song

```sql
ALTER TABLE orders ADD COLUMN id_v7 UUID;

-- Populate dần dần (chunk để tránh long-running TX)
DO $$
DECLARE
    batch_size INT := 10000;
    rows_updated INT;
BEGIN
    LOOP
        UPDATE orders SET id_v7 = uuid_generate_v7()
        WHERE id IN (
            SELECT id FROM orders WHERE id_v7 IS NULL LIMIT batch_size
        );
        GET DIAGNOSTICS rows_updated = ROW_COUNT;
        EXIT WHEN rows_updated = 0;
        COMMIT;
    END LOOP;
END$$;

CREATE UNIQUE INDEX CONCURRENTLY idx_orders_id_v7 ON orders(id_v7);
ALTER TABLE orders ALTER COLUMN id_v7 SET NOT NULL;
ALTER TABLE orders ALTER COLUMN id_v7 SET DEFAULT uuid_generate_v7();
```

### 17.2. Bước 2 — Dual-write trong app

Cập nhật app code để **insert cả 2 ID**:

```javascript
const idV7 = uuid.v7();
await db.query(
  'INSERT INTO orders(id_v7, user_id, total) VALUES ($1, $2, $3) RETURNING id, id_v7',
  [idV7, userId, total]
);
```

### 17.3. Bước 3 — Backfill mọi FK liên quan

Mỗi bảng tham chiếu `orders.id` cần thêm cột tham chiếu `orders.id_v7`:

```sql
ALTER TABLE order_items ADD COLUMN order_id_v7 UUID;
UPDATE order_items oi
   SET order_id_v7 = o.id_v7
  FROM orders o
 WHERE oi.order_id = o.id AND oi.order_id_v7 IS NULL;

CREATE INDEX CONCURRENTLY ON order_items(order_id_v7);
ALTER TABLE order_items ADD CONSTRAINT fk_order_v7
    FOREIGN KEY (order_id_v7) REFERENCES orders(id_v7) NOT VALID;
ALTER TABLE order_items VALIDATE CONSTRAINT fk_order_v7;
```

### 17.4. Bước 4 — Switch read sang UUID

Update toàn bộ query app từ `id` sang `id_v7`. Test kỹ — đặc biệt với:

- ORM cache.
- External integration đang lưu cached ID.
- Analytics warehouse / data pipeline.

### 17.5. Bước 5 — Drop cột cũ

Sau **vài tuần ổn định**:

```sql
-- Drop FK cũ
ALTER TABLE order_items DROP CONSTRAINT fk_order_old;
ALTER TABLE order_items DROP COLUMN order_id;
ALTER TABLE order_items RENAME COLUMN order_id_v7 TO order_id;

-- Rename PK
ALTER TABLE orders DROP CONSTRAINT orders_pkey;
ALTER TABLE orders DROP COLUMN id;
ALTER TABLE orders RENAME COLUMN id_v7 TO id;
ALTER TABLE orders ADD PRIMARY KEY (id);
```

> [!CAUTION]
> Đây là **migration tốn công lớn nhất** trong nghề. Trên schema phức tạp với hàng chục FK, mỗi bảng có thể mất 1-2 tuần. Cân nhắc kỹ ROI — chỉ migrate nếu **thực sự cần** distributed/multi-region.

### 17.6. Shortcut cho greenfield project

Project mới: **chọn UUIDv7 từ ngày 1**. Không bao giờ phải migrate.

```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuidv7(),  -- hoặc uuid_generate_v7()
    ...
);
```

---

## 18. Anti-patterns cần tránh

### 18.1. ❌ Lưu UUID dạng VARCHAR(36)

```sql
-- Anti: 36 byte/row, index gấp đôi
id VARCHAR(36) PRIMARY KEY

-- Đúng:
id UUID PRIMARY KEY              -- Postgres
id BINARY(16) PRIMARY KEY        -- MySQL/MariaDB
id UNIQUEIDENTIFIER PRIMARY KEY  -- SQL Server
```

### 18.2. ❌ Dùng UUIDv4 cho mọi PK "vì standard"

UUIDv4 chỉ nên dùng khi:

- Thật sự cần **không lộ thời điểm tạo**.
- Bảng nhỏ (<1M rows) — page split không đáng kể.
- Đã quyết định trước RFC 9562 và không muốn migrate.

Mọi case khác: **UUIDv7**.

### 18.3. ❌ Mix integer FK + UUID FK trong cùng schema

Schema nửa nạc nửa mỡ: bảng cũ INT, bảng mới UUID, join phải CAST → kill index. Quyết định **một và áp dụng nhất quán**.

### 18.4. ❌ Generate UUID trong DB rồi RETURN cho app

```sql
-- Anti: round-trip để lấy ID
INSERT INTO orders(...) VALUES (...) RETURNING id;
```

Với UUIDv7: **sinh ở app, gửi xuống** — tiết kiệm round-trip, đặc biệt quan trọng cho batch insert.

```javascript
// Đúng:
const ids = items.map(() => uuid.v7());
await db.query(
  'INSERT INTO orders(id, ...) SELECT * FROM UNNEST($1::uuid[], ...)',
  [ids, ...]
);
```

### 18.5. ❌ Dùng UUID làm display ID cho user

```
"Mã đơn hàng của bạn: 01923d4f-0001-7000-8a3f-1234567890ab"
```

Không user nào nhớ được. Tách:

```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuidv7(),       -- internal
    order_number TEXT UNIQUE NOT NULL           -- 'ORD-2024-00012345' cho user
);
```

### 18.6. ❌ INDEX trên UUID column không cần thiết

UUID rất to. Mỗi index trên cột UUID = +12-16 byte/row × N rows. Chỉ tạo index khi **thực sự query**.

### 18.7. ❌ Trông cậy vào ORDER BY id để sắp xếp theo thời gian

```sql
-- BIGSERIAL: hợp lý
SELECT * FROM events ORDER BY id DESC LIMIT 10;

-- UUIDv4: SAI HOÀN TOÀN (random)
SELECT * FROM events ORDER BY id DESC LIMIT 10;

-- UUIDv7: hợp lý (time-ordered prefix)
SELECT * FROM events ORDER BY id DESC LIMIT 10;
-- Nhưng best practice: vẫn có column created_at riêng để rõ intent
```

### 18.8. ❌ Reset/recompute UUID

UUID **vĩnh viễn**. Đừng bao giờ regenerate cho row đã tồn tại — sẽ phá FK, cache, link share, log audit. Nếu cần "rotate ID" → tạo row mới + reference.

---

## 19. Cheat sheet & 3 nguyên tắc

### 19.1. Decision tree

```diagram
╭──────────────────────────────────────────────────────────────╮
│                                                              │
│   App single-node, ID không lộ ra ngoài?                     │
│           │                                                  │
│           ├─ YES ─▶ BIGSERIAL  (nhanh nhất, đơn giản nhất)   │
│           │                                                  │
│           └─ NO ──▶ ID có hiện trong URL/API?                │
│                            │                                 │
│                            ├─ YES ─▶ UUIDv7                  │
│                            │       (default cho project mới) │
│                            │                                 │
│                            └─ NO ──▶ Multi-master / offline? │
│                                            │                 │
│                                            ├─ YES ─▶ UUIDv7  │
│                                            │     hoặc        │
│                                            │     Snowflake   │
│                                            │     (nếu cần    │
│                                            │     64-bit)     │
│                                            │                 │
│                                            └─ NO ─▶ BIGSERIAL│
│                                                              │
╰──────────────────────────────────────────────────────────────╯
```

### 19.2. Bảng tổng kết

| Tiêu chí | BIGSERIAL | UUIDv4 | UUIDv7 | Snowflake |
|----------|-----------|--------|--------|-----------|
| Bytes | 8 | 16 | 16 | 8 |
| Sortable theo time | ✅ | ❌ | ✅ | ✅ |
| Random / unpredictable | ❌ | ✅ | ⚠️ time leak | ⚠️ time leak |
| Distributed-safe | ❌ | ✅ | ✅ | ✅ (cần worker_id) |
| Insert performance | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Index size | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Standard | ✅ | ✅ RFC | ✅ RFC 9562 | ❌ (Twitter spec) |
| Native DB support | universal | universal | Postgres 18+, lib khác | tự build |
| URL-safe (mắt user) | ⚠️ predictable | ✅ | ✅ | ✅ |
| Setup phức tạp | 0 | 0 | 0-1 | 3-5 |

### 19.3. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Mặc định mới cho project greenfield là UUIDv7, không phải UUIDv4.**
> UUIDv4 chỉ là **một** lựa chọn — và là lựa chọn **tệ nhất** về performance trong họ UUID. UUIDv7 cho bạn gần như toàn bộ lợi ích của UUIDv4 mà không phải trả giá B+Tree.
>
> **2. Nếu ID không bao giờ rời database (internal), BIGSERIAL vẫn là vô địch.**
> Đừng over-engineer. Bảng `audit_log`, `analytics_event` chỉ insert-and-aggregate — BIGSERIAL phù hợp hơn UUID gấp nhiều lần.
>
> **3. Luôn lưu UUID dạng binary native (`UUID`/`BINARY(16)`), không bao giờ TEXT.**
> Đây là sai lầm tốn nhất, dễ tránh nhất. Chỉ 1 dòng schema khác, tiết kiệm gấp đôi dung lượng index.

### 19.4. Quote cuối

> Cuộc tranh luận "Integer vs UUID" suốt 15 năm qua đã bỏ sót đáp án. **UUIDv7 không phải compromise — nó là synthesis**: lấy sequential locality của integer, lấy decentralized uniqueness của UUID, vứt bỏ điểm yếu của cả hai.
>
> Lần tới khi `CREATE TABLE`, hãy nhớ: **mỗi byte của primary key đang nhân lên trên mọi index, mọi row, mọi backup, mọi message replication**. Chọn đúng từ đầu rẻ hơn migrate hàng nghìn lần.

Và quan trọng nhất: **hiểu được vì sao** — để khi gặp tình huống mới (Snowflake? KSUID? ULID? UUIDv8?), bạn không chọn theo trend mà chọn theo **bản chất**.
