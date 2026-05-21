---
title: "Insert, Update, Delete & Index — Deep Dive"
description: "Mổ xẻ chi tiết tác động của Index lên DML: tại sao càng nhiều index, write càng chậm. Cấu trúc B-Tree, page split, WAL, HOT update, MVCC dead tuple, index bloat, FILLFACTOR, bulk load, partial/expression index, deferred maintenance, monitoring & benchmark thực tế."
---

## Mục lục

- [Bối cảnh: Một câu UPDATE 30 giây vì... 12 index](#1-bối-cảnh-một-câu-update-30-giây-vì-12-index)
- [DML là gì và Database thật sự làm gì sau lưng bạn](#2-dml-là-gì-và-database-thật-sự-làm-gì-sau-lưng-bạn)
- [Vòng đời của một dòng dữ liệu — Heap, Page, Tuple, CTID](#3-vòng-đời-của-một-dòng-dữ-liệu--heap-page-tuple-ctid)
- [INSERT — Cái giá thực sự của mỗi index](#4-insert--cái-giá-thực-sự-của-mỗi-index)
- [UPDATE — MVCC, HOT update và lý do "update 1 cột" vẫn đụng tất cả index](#5-update--mvcc-hot-update-và-lý-do-update-1-cột-vẫn-đụng-tất-cả-index)
- [DELETE — Tại sao dòng "biến mất" mà file vẫn phình to](#6-delete--tại-sao-dòng-biến-mất-mà-file-vẫn-phình-to)
- [Page Split — Khi B-Tree phải tách đôi để đẻ thêm chỗ](#7-page-split--khi-b-tree-phải-tách-đôi-để-đẻ-thêm-chỗ)
- [WAL, fsync & checkpoint — Đường đi của 1 byte ghi xuống đĩa](#8-wal-fsync--checkpoint--đường-đi-của-1-byte-ghi-xuống-đĩa)
- [Index Bloat — Nguồn gốc, cách phát hiện, cách xử lý](#9-index-bloat--nguồn-gốc-cách-phát-hiện-cách-xử-lý)
- [FILLFACTOR — Tham số ít người chỉnh mà tác động lớn](#10-fillfactor--tham-số-ít-người-chỉnh-mà-tác-động-lớn)
- [Bulk Load — Drop index, COPY, rồi tạo lại](#11-bulk-load--drop-index-copy-rồi-tạo-lại)
- [Partial Index & Expression Index — Trả lời câu hỏi "có cần index toàn bộ không?"](#12-partial-index--expression-index--trả-lời-câu-hỏi-có-cần-index-toàn-bộ-không)
- [Unique Index — Cái giá đặc biệt cho lời hứa duy nhất](#13-unique-index--cái-giá-đặc-biệt-cho-lời-hứa-duy-nhất)
- [Foreign Key — Index ẩn mà bạn (có thể) cần](#14-foreign-key--index-ẩn-mà-bạn-có-thể-cần)
- [Catalog các thao tác DML và chi phí index tương ứng](#15-catalog-các-thao-tác-dml-và-chi-phí-index-tương-ứng)
- [So sánh giữa Postgres / MySQL / Oracle / SQL Server](#16-so-sánh-giữa-postgres--mysql--oracle--sql-server)
- [Benchmark thực tế — Bao nhiêu là quá nhiều index?](#17-benchmark-thực-tế--bao-nhiêu-là-quá-nhiều-index)
- [Anti-patterns cần tránh](#18-anti-patterns-cần-tránh)
- [Monitoring & Maintenance](#19-monitoring--maintenance)
- [Playbook — Audit và cắt giảm index trên hệ thống production](#20-playbook--audit-và-cắt-giảm-index-trên-hệ-thống-production)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#21-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Bối cảnh: Một câu UPDATE 30 giây vì... 12 index

Bạn vận hành bảng `orders` cho một sàn TMĐT. Cấu trúc đơn giản:

```sql
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    status      TEXT NOT NULL,
    total       NUMERIC(12, 2),
    shipping_id BIGINT,
    coupon_id   BIGINT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    note        TEXT
);
-- 50,000,000 rows, ~14 GB data
```

Qua nhiều năm, dev đã thêm vào **12 index** — mỗi index "để tăng tốc một report":

```sql
CREATE INDEX idx_orders_user_id     ON orders (user_id);
CREATE INDEX idx_orders_status      ON orders (status);
CREATE INDEX idx_orders_created     ON orders (created_at);
CREATE INDEX idx_orders_updated     ON orders (updated_at);
CREATE INDEX idx_orders_total       ON orders (total);
CREATE INDEX idx_orders_shipping    ON orders (shipping_id);
CREATE INDEX idx_orders_coupon      ON orders (coupon_id);
CREATE INDEX idx_orders_user_status ON orders (user_id, status);
CREATE INDEX idx_orders_user_date   ON orders (user_id, created_at DESC);
CREATE INDEX idx_orders_status_date ON orders (status, created_at DESC);
CREATE INDEX idx_orders_user_total  ON orders (user_id, total DESC);
CREATE INDEX idx_orders_note_trgm   ON orders USING GIN (note gin_trgm_ops);
```

Một sáng đẹp trời, marketing chạy một câu UPDATE để cập nhật trạng thái cho 100k đơn:

```sql
UPDATE orders
SET status = 'archived'
WHERE created_at < NOW() - INTERVAL '2 years';
-- 100,000 rows affected
-- Time: 32,184 ms  (32 giây!)
```

Bạn nghi `WHERE` thiếu index — kiểm tra lại, `idx_orders_created` vẫn nguyên đó. Lookup chỉ tốn ~50ms. Vậy 32 giây còn lại đi đâu?

`EXPLAIN (ANALYZE, BUFFERS)` cho thấy:

```text
 Update on orders  (actual time=32125.4..32125.4 rows=0 loops=1)
   Buffers: shared hit=4,128,902 read=85,734 dirtied=312,558 written=298,001
   ->  Index Scan using idx_orders_created on orders
         (actual time=0.045..58.2 rows=100,000 loops=1)
         Index Cond: (created_at < (now() - '2 years'::interval))
 Planning Time: 0.231 ms
 Execution Time: 32,184 ms
```

Lookup chỉ 58ms — phần còn lại là **maintenance index sau khi UPDATE**.

> [!IMPORTANT]
> Khi bạn `UPDATE` 1 cột `status`, database **không** chỉ sửa cột đó. Nó tạo **tuple mới**, **chèn vào 12 index** (vì MVCC), đánh dấu tuple cũ dead, **ghi WAL** cho tất cả. 100,000 row × 12 index × (B-Tree maintenance + WAL) = **vài chục giây**.

Trong doc này, ta sẽ mổ xẻ từng lớp:

1. Cách database **thực hiện** một câu DML từ A đến Z.
2. Tại sao **mọi index** đều bị chạm khi update **chỉ 1 cột không liên quan**.
3. **HOT update** là phép màu — và khi nào nó **không** xảy ra.
4. **Page split**, **bloat**, **dead tuple** — 3 hiện tượng song hành cùng index.
5. **FILLFACTOR**, **bulk load**, **partial index** — các đòn bẩy thực dụng.
6. **Khi nào nên drop index** dù nó "trông có vẻ hữu ích".

Mục tiêu: sau khi đọc xong, bạn hiểu mỗi index **không chỉ là chi phí dung lượng** — nó là chi phí **mỗi lần ghi**, **mỗi lần checkpoint**, **mỗi lần vacuum**, và đôi khi là **mỗi lần read** (vì bloat).

---

## 2. DML là gì và Database thật sự làm gì sau lưng bạn

**DML** (Data Manipulation Language) gồm 3 lệnh chính: `INSERT`, `UPDATE`, `DELETE` (và `MERGE` ở một số DB). Nhìn thì đơn giản, nhưng mỗi lệnh phía sau là cả một **dây chuyền** thao tác.

### 2.1. Một câu INSERT đi qua những đâu?

```diagram
╭─────────────────────────────────────────────────────────────╮
│ Client gửi:                                                 │
│   INSERT INTO orders(user_id, total) VALUES (42, 99.9);     │
│                                                             │
│         ▼                                                   │
│   Parse & Plan                                              │
│         ▼                                                   │
│   Acquire row lock (nếu cần)                                │
│         ▼                                                   │
│   ┌── HEAP: tìm page còn slot, ghi tuple, set xmin = txid   │
│   │                                                         │
│   │── INDEX 1 (PK):   chèn (id, ctid) vào B-Tree            │
│   │── INDEX 2:        chèn (user_id, ctid)                  │
│   │── INDEX 3:        chèn (total, ctid)                    │
│   │       ...                                               │
│   │── INDEX N:        chèn ...                              │
│   │                                                         │
│   │── Mỗi thao tác trên đều ghi WAL record                  │
│   ▼                                                         │
│   COMMIT → flush WAL → fsync                                │
│         ▼                                                   │
│   Trả OK về client                                          │
╰─────────────────────────────────────────────────────────────╯
```

Một câu INSERT trên bảng **không có index nào** ngoài PK = **2 write** (heap + 1 index). Cùng câu INSERT trên bảng **12 index** = **13 write** + nhiều WAL record hơn = chậm gấp **6-10 lần**.

### 2.2. Định nghĩa "ghi" — không phải chỉ đĩa cứng

| Layer | Hoạt động khi DML |
|-------|-------------------|
| **Buffer pool** (RAM) | Page heap + page index được load, sửa, đánh dấu dirty |
| **WAL buffer** (RAM) | Mỗi thay đổi (heap + mỗi index entry) → 1 record WAL |
| **WAL file** (disk) | Flush khi COMMIT (fsync) — **bắt buộc trước khi trả OK** |
| **Data file** (disk) | Background writer / checkpoint flush page dirty về sau |

> [!NOTE]
> **WAL = Write-Ahead Log.** Mọi thay đổi phải vào WAL **trước**, vào data file **sau**. Đây là cơ chế đảm bảo durability — kể cả crash giữa chừng, replay WAL sẽ phục hồi nguyên trạng.

### 2.3. Tại sao mọi index lại phát sinh I/O?

Mỗi index là **một B-Tree riêng biệt** trên đĩa, hoàn toàn độc lập với heap. Khi một row mới ra đời, **mỗi B-Tree** đều cần một entry mới trỏ về row đó.

```diagram
              HEAP (table)
        ╭──────────────────╮
        │ row #42  (ctid)  │←──────┐
        ╰──────────────────╯       │
                                   │
   INDEX 1 (user_id)               │
   ╭─────────╮                     │
   │ ... 42 ─┼─────────────────────┤
   ╰─────────╯                     │
                                   │
   INDEX 2 (total)                 │
   ╭───────────╮                   │
   │ ... 99.9 ─┼───────────────────┤
   ╰───────────╯                   │
                                   │
   INDEX 3 (created_at)            │
   ╭───────────────╮               │
   │ ... 2024-... ─┼───────────────┘
   ╰───────────────╯
```

Mỗi mũi tên = một **entry index** = một **page write** + một **WAL record**. N index = **N+1 writes** cho mỗi INSERT.

---

## 3. Vòng đời của một dòng dữ liệu — Heap, Page, Tuple, CTID

Trước khi mổ xẻ INSERT/UPDATE/DELETE, cần thống nhất 4 khái niệm cốt lõi (Postgres terminology — MySQL/Oracle có tên khác nhưng concept tương tự).

### 3.1. Heap — kho chứa table

**Heap** là vùng lưu raw data của bảng (file `base/<oid>/<relfilenode>` trên Postgres). Không sắp xếp — đúng nghĩa "đống" (heap). Row mới có thể được nhét vào **bất kỳ page** nào còn chỗ.

### 3.2. Page — đơn vị I/O cơ bản

**Page** (hay **block**) là khối **8KB** (Postgres) / **16KB** (MySQL InnoDB) / **2KB-32KB** (Oracle). Database **luôn** đọc/ghi nguyên page — không bao giờ đọc nửa page.

```
┌─ Page (8KB) ─────────────────────────┐
│ Page Header  (24 bytes)              │
│ Item pointer 1  →  Tuple 1           │
│ Item pointer 2  →  Tuple 2           │
│ Item pointer 3  →  Tuple 3           │
│ ...                                  │
│           [free space]               │
│                                      │
│         Tuple 3 (variable size)      │
│         Tuple 2                      │
│         Tuple 1                      │
│ Special area  (cuối page)            │
└──────────────────────────────────────┘
```

Item pointer (ItemId) ở đầu, tuple thực ở cuối — mọc về phía nhau, gặp nhau là page đầy.

### 3.3. Tuple — một dòng vật lý

**Tuple** là biểu diễn vật lý của một row. Một row logic (nhìn bằng `SELECT`) có thể tương ứng với **nhiều tuple** (nhờ MVCC — xem mục 5).

Header tuple chứa các trường quan trọng:

| Trường | Ý nghĩa |
|--------|---------|
| `xmin` | Transaction đã tạo tuple này |
| `xmax` | Transaction đã xóa/update tuple này (0 nếu còn live) |
| `cmin/cmax` | Command ID trong transaction |
| `ctid` | (page, item) — địa chỉ vật lý của tuple |
| `t_infomask` | Flags (HEAP_HOT_UPDATED, HEAP_ONLY_TUPLE, ...) |

### 3.4. CTID — địa chỉ vật lý

**CTID** = `(block_number, item_number)`. Ví dụ `(42, 7)` = page thứ 42, item thứ 7 trong page đó.

```sql
SELECT ctid, id, status FROM orders LIMIT 3;
--   ctid   | id |  status
-- ---------+----+----------
--  (0,1)   |  1 | new
--  (0,2)   |  2 | paid
--  (0,3)   |  3 | shipped
```

> [!IMPORTANT]
> **Mọi index entry đều trỏ về CTID.** Khi CTID thay đổi (tuple di chuyển sang page khác), **toàn bộ index** cần được cập nhật — đây là lý do UPDATE đắt.

MySQL InnoDB thì khác: clustered index dùng PK làm "địa chỉ", secondary index lưu PK thay vì rowid → có ưu/nhược điểm riêng (xem mục 16).

### 3.5. Bức tranh tổng thể

```diagram
╭────────────────────────────────────────────────────────────╮
│  HEAP                                                      │
│  ┌─ Page 0 ──────────┐    ┌─ Page 1 ──────────┐            │
│  │ (0,1) (0,2) (0,3) │    │ (1,1) (1,2) (1,3) │   ...      │
│  └───────────────────┘    └───────────────────┘            │
│                                                            │
│  INDEX idx_user_id           INDEX idx_status              │
│  ┌──────────────────┐        ┌──────────────────┐          │
│  │  42  →  (0,1)    │        │ new   → (0,1)    │          │
│  │  43  →  (0,2)    │        │ paid  → (0,2)    │          │
│  │  44  →  (0,3)    │        │ ship  → (0,3)    │          │
│  │  45  →  (1,1)    │        │ new   → (1,1)    │          │
│  └──────────────────┘        └──────────────────┘          │
╰────────────────────────────────────────────────────────────╯
```

Cùng một row được "trỏ về" bởi **n entry** (n = số index). Đây là background quan trọng cho phần còn lại.

---

## 4. INSERT — Cái giá thực sự của mỗi index

INSERT là DML đơn giản nhất về mặt logic, nhưng cũng là nơi index "ăn thuế" rõ nhất.

### 4.1. Các bước của một câu INSERT

```diagram
╭─────────────────────────────────────────────────────────────╮
│ 1. Parse + plan                                             │
│ 2. Check constraint (NOT NULL, CHECK)                       │
│ 3. Pick heap page có đủ free space (FSM giúp tìm nhanh)     │
│ 4. WAL: ghi record "INSERT tuple T tại CTID (p, i)"         │
│ 5. Heap: ghi tuple vào page p, position i                   │
│ 6. Với mỗi index:                                           │
│    6a. Tính key từ tuple                                    │
│    6b. Descend B-Tree để tìm leaf page                      │
│    6c. Nếu là UNIQUE → kiểm tra duplicate                   │
│    6d. Nếu leaf còn chỗ: chèn entry → ghi WAL               │
│    6e. Nếu leaf đầy: PAGE SPLIT → đắt gấp 10-100 lần        │
│ 7. (Cuối transaction) COMMIT → flush WAL → fsync            │
╰─────────────────────────────────────────────────────────────╯
```

Mỗi index → bước 6 chạy lại 1 lần → I/O cộng dồn.

### 4.2. Phép tính thô — cost/index/insert

Ước tính chi phí mỗi index khi insert 1 row (Postgres 16, SSD NVMe, table 10 triệu rows):

| Hoạt động | Page read | Page write | WAL bytes |
|-----------|-----------|------------|-----------|
| B-Tree descend (cache hit) | 0 | 0 | 0 |
| B-Tree descend (cache miss, height 4) | 4 | 0 | 0 |
| Leaf insert (page còn chỗ) | 0 | 1 | ~80 |
| Leaf insert + page split | 0 | 3 | ~16,000 |
| Unique check (duplicate scan) | 0-1 | 0 | 0 |

> [!TIP]
> Với cache nóng và bảng vừa, mỗi index ≈ **0.05-0.2 ms** insert overhead. Với cache lạnh hoặc page split, có thể tới **2-10 ms**. Một bảng 10 index → INSERT chậm hơn ~**5-30 lần** so với không index.

### 4.3. Bench đơn giản — INSERT 1 triệu rows với N index

```sql
-- Setup: bảng base với 0 → 10 index
CREATE TABLE bench (id BIGSERIAL PRIMARY KEY, a INT, b INT, c INT,
                   d INT, e INT, f INT, g INT, h INT, i INT, j INT);
-- Insert pattern:
INSERT INTO bench(a, b, c, d, e, f, g, h, i, j)
SELECT random()*1000000, random()*1000000, random()*1000000, random()*1000000,
       random()*1000000, random()*1000000, random()*1000000, random()*1000000,
       random()*1000000, random()*1000000
FROM generate_series(1, 1000000);
```

Kết quả tham khảo (1M rows, single thread, fsync on, SSD):

| # Index | Insert time | Throughput | Overhead vs baseline |
|---------|------------|------------|----------------------|
| 1 (PK only) | 6.2 s | 161k rows/s | 1.0x (baseline) |
| 3 | 9.8 s | 102k rows/s | 1.58x |
| 5 | 14.5 s | 69k rows/s | 2.34x |
| 7 | 20.1 s | 49k rows/s | 3.24x |
| 10 | 31.4 s | 32k rows/s | 5.06x |
| 10 + 1 GIN trigram | 92.7 s | 11k rows/s | 14.95x |

> [!WARNING]
> **GIN/GiST đặc biệt đắt cho INSERT** — vì mỗi value sinh ra **nhiều entry** (trigram → ~N-2 entries cho chuỗi N ký tự, tsvector → 1 entry/từ). Đừng đặt GIN trên cột write-heavy.

### 4.4. Insert batch — tiết kiệm RTT, không tiết kiệm index work

```sql
-- Bad: N round-trip
INSERT INTO orders(...) VALUES (...);
INSERT INTO orders(...) VALUES (...);
... (n lần)

-- Better: 1 round-trip, vẫn N tuple
INSERT INTO orders(...) VALUES (...), (...), ..., (...);

-- Best: COPY (binary protocol, không parse từng câu)
COPY orders FROM STDIN WITH (FORMAT csv);
```

Tất cả vẫn phải làm **N × M** thao tác index (M = số index). Tiết kiệm chỉ ở phần **parse + network + transaction overhead**. Để thực sự nhanh khi bulk load → xem mục 11.

### 4.5. Insert với DEFAULT, SERIAL, sequence

Mỗi `BIGSERIAL` / `IDENTITY` / `AUTO_INCREMENT` gọi sequence → **không** ghi WAL cho mỗi `nextval` (có cache), nhưng **bản thân PK index** vẫn phải insert. Đừng dùng nhiều SERIAL không cần thiết.

### 4.6. INSERT ... ON CONFLICT — chi phí kép

```sql
INSERT INTO orders(id, ...) VALUES (...)
ON CONFLICT (id) DO UPDATE SET ...;
```

- Insert thử trước → nếu duplicate (do unique index báo) → fallback sang update.
- **Mọi** unique index cần được kiểm tra trước khi commit → **chi phí cộng dồn**.
- Nếu update branch chạy → áp dụng tất cả logic UPDATE (xem mục 5).

---

## 5. UPDATE — MVCC, HOT update và lý do "update 1 cột" vẫn đụng tất cả index

Đây là phần **quan trọng nhất** của doc. Hiểu UPDATE = hiểu 80% performance writes.

### 5.1. MVCC — Tại sao UPDATE = DELETE + INSERT

Postgres (và Oracle theo cách khác) dùng **MVCC** (Multi-Version Concurrency Control): mỗi UPDATE **không sửa tuple cũ**, mà:

1. Đánh dấu tuple cũ "dead" (set `xmax` = current txid).
2. Tạo **tuple mới** với dữ liệu mới (set `xmin` = current txid).
3. Tuple cũ vẫn nằm đó để các transaction cũ thấy phiên bản trước.

```diagram
Trước UPDATE:
   Heap page:  [ tuple A: xmin=100, xmax=0,    data: status='new' ]

UPDATE orders SET status='paid' WHERE id=42;  (txid=200)

Sau UPDATE:
   Heap page:  [ tuple A: xmin=100, xmax=200,  data: status='new' ]   ← dead
               [ tuple B: xmin=200, xmax=0,    data: status='paid']   ← live
```

Tuple A **không bị xóa ngay** — cần đợi `VACUUM` mới thu hồi.

### 5.2. Vấn đề chính: tuple mới có CTID mới

Tuple mới (B) có **CTID khác** tuple cũ (A). Mọi **index entry** đang trỏ về A giờ trở thành **stale** — cần một entry mới trỏ về B.

```diagram
                  HEAP
   ╭─────────────────────────────────╮
   │  (0,1) tuple A  (dead, xmax=200)│←─┐
   │  (0,5) tuple B  (live, xmin=200)│←─┤
   ╰─────────────────────────────────╯  │
                                        │
   INDEX idx_status                     │
   ╭──────────────────╮                 │
   │  'new'  →  (0,1) │ ─── stale ──────┘
   │  'paid' →  (0,5) │ ─── new entry
   ╰──────────────────╯
```

Nếu bảng có **12 index**, cần thêm **12 entry mới** + giữ nguyên 12 entry cũ → bloat index.

### 5.3. HOT Update — Phép màu cứu rỗi

**HOT** = **H**eap-**O**nly **T**uple. Là tối ưu của Postgres để **tránh** việc cập nhật index nếu có thể.

**Điều kiện** để HOT update kích hoạt:

1. **Không cột nào trong index** bị thay đổi.
2. **Tuple mới fit trong cùng page** với tuple cũ (cần free space).

Nếu thỏa cả 2 → Postgres:

- Vẫn tạo tuple mới B trong **cùng page** với A.
- A có flag `HEAP_HOT_UPDATED`, B có flag `HEAP_ONLY_TUPLE`.
- Index **không** được cập nhật. Index vẫn trỏ về A; A có pointer trỏ về B (HOT chain).

```diagram
HOT chain (cùng 1 page):

   Item pointer (0,1) ─→ Tuple A ─→ Tuple B ─→ Tuple C ─→ Tuple D
                       (dead, HOT) (HOT only)  (HOT only)  (live)

   Index vẫn trỏ về (0,1) — luôn đúng vì chain dẫn về tuple live cuối.
```

**Kết quả**: UPDATE với HOT chỉ chạm **heap page** + **WAL** — không chạm **bất kỳ index nào**. **Nhanh hơn ~10 lần** so với non-HOT.

> [!IMPORTANT]
> Nếu bạn update cột không có index, mà page còn free space → HOT kích hoạt → cực nhanh. **Nếu bạn update bất kỳ cột nào đang được index → HOT bị vô hiệu → mọi index bị cập nhật**.

### 5.4. Ví dụ — khi HOT vs non-HOT

```sql
-- Bảng có idx_status (trên cột status), không có index trên note
UPDATE orders SET note = 'oh hi' WHERE id = 42;   -- ✅ HOT (note không indexed)
UPDATE orders SET status = 'paid' WHERE id = 42;  -- ❌ Non-HOT (status indexed)
```

Có thể verify:

```sql
SELECT pg_stat_user_tables.relname,
       n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables
WHERE relname = 'orders';
--  relname | n_tup_upd | n_tup_hot_upd | hot_pct
--  --------+-----------+---------------+---------
--  orders  | 1,200,000 | 1,050,000     | 87.5
```

> [!TIP]
> **Tỷ lệ HOT > 80% = healthy.** < 50% = nghi vấn (cần xem cột nào bị index thừa và bị update nhiều).

### 5.5. Khi nào HOT thất bại — và bạn không nhận ra

| Tình huống | HOT? | Lý do |
|------------|------|-------|
| Update cột không index, page còn chỗ | ✅ | Đúng điều kiện |
| Update cột không index, page đầy | ❌ | Phải sang page mới → CTID mới |
| Update cột có index | ❌ | Phải cập nhật index → tuple mới phải có CTID mới |
| Update PK | ❌ | PK index phải cập nhật |
| Update cột trong UNIQUE constraint | ❌ | Unique index phải cập nhật |
| Update partial index, nhưng predicate vẫn match cũ | ❌ | An toàn, phải cập nhật |
| Update expression index `LOWER(col)` mà giá trị `LOWER` không đổi | ❌ | Postgres không đủ thông minh — vẫn coi là index update |

> [!CAUTION]
> Postgres **không** so sánh giá trị expression — chỉ kiểm tra **cột nguồn** có thay đổi không. Nếu bạn có `idx_lower_email ON users(LOWER(email))` và update `email` từ `'A@x'` sang `'a@X'`, mặc dù `LOWER` không đổi, HOT vẫn không kích hoạt.

### 5.6. Page đầy = mất HOT vĩnh viễn

Khi page heap không còn chỗ cho tuple mới, HOT thất bại. Đây là lý do **FILLFACTOR** (mục 10) ra đời — để cố tình "chừa chỗ" cho HOT update.

### 5.7. UPDATE với JOIN — nhân số entry index

```sql
UPDATE orders o
SET status = 'archived'
FROM old_orders x
WHERE o.id = x.id;
-- N rows updated → N × M index entries created (M = số index)
```

Trên bảng 12 index, update 1M rows = **12M entries** ghi vào index. Mỗi entry = WAL + page write tiềm năng = **nhanh thì 30 giây, chậm thì vài phút**.

### 5.8. UPDATE và lock — thêm 1 lớp ẩn

UPDATE giữ **row-level lock** trên tuple cũ trong toàn bộ transaction. Nếu nhiều transaction update cùng row → lock contention → throughput sụt. Index update **cũng** giữ lock trên leaf page (ngắn hơn nhưng có).

---

## 6. DELETE — Tại sao dòng "biến mất" mà file vẫn phình to

DELETE đơn giản hơn UPDATE về mặt logic, nhưng có **trap** riêng.

### 6.1. DELETE không xóa, chỉ "đánh dấu"

```diagram
DELETE FROM orders WHERE id = 42;  (txid=300)

Trước:  [ tuple A: xmin=100, xmax=0,   data: ... ]
Sau:    [ tuple A: xmin=100, xmax=300, data: ... ]  ← dead, file vẫn giữ
```

Postgres chỉ set `xmax`. Tuple vẫn nằm đó cho các transaction cũ đọc. **VACUUM** sẽ thu hồi sau.

### 6.2. Index sau DELETE — vẫn còn entry

Mọi index entry trỏ về tuple đã DELETE **vẫn còn** trên B-Tree. Không có cách nào "biết" tuple đã chết khi đứng từ index — phải fetch về heap, nhìn `xmax` mới biết.

Hệ quả:

- Index **không nhỏ đi** sau DELETE.
- Query sau DELETE vẫn **đi qua entry chết** rồi mới biết để bỏ.
- Đến khi `VACUUM` chạy, mới quét index và xóa entry tương ứng.

### 6.3. Phép tính chi phí DELETE

| Hoạt động | Chi phí |
|-----------|---------|
| Find tuple bằng index | tương đương SELECT |
| Set `xmax` trên heap | 1 page write + WAL |
| Index entry | **KHÔNG** chạm — đợi VACUUM |
| Chi phí ẩn (VACUUM về sau) | tuỳ scale |

DELETE **rẻ hơn UPDATE** về phía DML — nhưng **đắt hơn** về phía VACUUM (cần quét tất cả index để clean entry chết).

### 6.4. Mass DELETE — cẩn thận

```sql
DELETE FROM orders WHERE created_at < '2020-01-01';
-- → 30M dead tuples
-- → 30M × 12 index entries cần VACUUM
-- → autovacuum chạy giờ thay vì phút
-- → table + index BLOAT lớn
```

Trong các trường hợp lớn, **`TRUNCATE`** hoặc **partition drop** nhanh hơn DELETE hàng nghìn lần:

```sql
-- Cách 1: TRUNCATE (giữ schema, xóa data, không có WAL row-by-row)
TRUNCATE orders;

-- Cách 2: PARTITION DROP (nếu partition theo created_at)
ALTER TABLE orders DETACH PARTITION orders_2020;
DROP TABLE orders_2020;
```

> [!TIP]
> Khi xóa "dữ liệu cũ" định kỳ → **dùng partition + DROP/DETACH**, không dùng DELETE. DROP partition = vài mili giây, DELETE = vài tiếng + bloat.

### 6.5. DELETE CASCADE — chi phí lan

```sql
ALTER TABLE order_items
  ADD CONSTRAINT fk_orders FOREIGN KEY (order_id)
  REFERENCES orders(id) ON DELETE CASCADE;

DELETE FROM orders WHERE id = 42;
-- → tự động DELETE FROM order_items WHERE order_id = 42
-- → entries trên FK index + tất cả index khác
```

CASCADE tiện, nhưng **mỗi level cascade là một DELETE độc lập** với chi phí riêng. Trên chuỗi 4-5 bảng cascade, chi phí nhân lên rất nhanh.

---

## 7. Page Split — Khi B-Tree phải tách đôi để đẻ thêm chỗ

Đây là một trong những **chi phí ẩn lớn nhất** của INSERT/UPDATE đụng vào index.

### 7.1. Vấn đề: leaf page đầy

```diagram
B-Tree leaf (8KB, chứa ~200 entries):

  ┌────────────────────────────────────────────┐
  │ k1 k2 k3 ... k198 k199 k200      [FULL]    │
  └────────────────────────────────────────────┘
```

Cần insert entry `k150_new`. Không còn chỗ → **page split**.

### 7.2. Quy trình page split

```diagram
Step 1 — Allocate page mới:
  ┌──────────────────┐    ┌──────────────────┐
  │  k1 ... k100     │    │  k101 ... k200   │
  └──────────────────┘    └──────────────────┘
  (cũ, giữ nửa trái)        (mới, nhận nửa phải)

Step 2 — Cập nhật sibling pointer (linked list):
  ... ─ [page A] ─ [new page] ─ [page B] ─ ...

Step 3 — Insert entry mới vào page tương ứng:
  ┌──────────────────┐    ┌──────────────────┐
  │  k1...k100 k150n │    │  k101 ... k200   │
  └──────────────────┘    └──────────────────┘

Step 4 — Cập nhật parent node:
  Parent giờ phải thêm 1 separator key (k101) → có thể TỰ split → đệ quy lên root.
```

### 7.3. Chi phí page split

- **3 page write tối thiểu**: 2 page leaf (cũ + mới) + 1 page parent.
- **WAL record lớn**: ghi cả 2 leaf mới (vì gần như toàn bộ content thay đổi).
- **Có thể cascade**: nếu parent đầy → split cấp 2 → split root → tăng chiều cao cây.

> [!IMPORTANT]
> Một page split tiêu tốn **gấp 30-100 lần** một insert bình thường. Nếu workload bạn có nhiều split → throughput giảm thấy rõ.

### 7.4. Loại page split: 50/50 vs 90/10

Khi key insert nằm ở **giữa** → split 50/50 (cân bằng).
Khi key insert nằm ở **cuối** (monotonic, ví dụ SERIAL, timestamp) → Postgres dùng tối ưu **"rightmost split"** = chỉ tạo page mới rỗng, không copy → **rẻ hơn nhiều**.

```diagram
Insert SERIAL (id tăng dần): luôn ở cuối → split 90/10
  [old leaf (full)] ──→ [old leaf (giữ nguyên)] ──→ [new leaf (chỉ 1 entry)]

Insert UUID v4 (random): rơi vào giữa → split 50/50, nhiều lần
  [old leaf] ──→ [old half] [new half]
```

Đây là 1 lý do **SERIAL PK insert nhanh hơn UUID v4 PK insert nhiều lần** trên cùng workload (xem [PK UUID vs Integer Deep Dive](primary-key-uuid-vs-integer-deep-dive)).

### 7.5. Page split → bloat

Sau split, page cũ thường chỉ còn ~50% full → wasted space. Theo thời gian, index có thể **phình lên 2-3 lần** kích thước "lý thuyết". Đây là **index bloat** (mục 9).

---

## 8. WAL, fsync & checkpoint — Đường đi của 1 byte ghi xuống đĩa

Phần này lý giải tại sao **mỗi index thêm vào** lại tăng I/O theo cấp số nhân.

### 8.1. Write-Ahead Logging

**Nguyên tắc**: Trước khi modify data file, phải ghi log mô tả thay đổi vào WAL. Khi crash → replay WAL = phục hồi state.

Vì sao? Vì việc ghi WAL **tuần tự** (sequential append) nhanh hơn ghi data file **ngẫu nhiên** (random). Database delay random write tới checkpoint, mọi durable guarantee được đảm bảo bởi WAL.

### 8.2. Cấu trúc WAL record

Mỗi thay đổi → 1 WAL record nhỏ:

```
┌─ WAL record ────────────────────────────────┐
│ XLogRecord header (24 bytes)                │
│   xl_tot_len, xl_xid, xl_prev, xl_info, ... │
│ BlockRef (cho mỗi page liên quan)           │
│   relfilenode, blkno, flags, fpw?           │
│ Per-rmgr data (heap insert / btree split..) │
└─────────────────────────────────────────────┘
```

| Thao tác | WAL bytes (xấp xỉ) |
|----------|-------------------|
| Heap insert | ~80 bytes |
| Heap update (non-HOT) | ~120 bytes |
| Heap delete | ~40 bytes |
| B-Tree insert (leaf) | ~80 bytes |
| B-Tree page split | ~16,000 bytes (full-page write 2 pages) |
| **Full-Page Write** (page sau checkpoint, mọi modification đầu tiên) | ~8,200 bytes |

> [!NOTE]
> **Full-Page Write (FPW)**: Sau mỗi checkpoint, page bị modify lần đầu phải **ghi cả page** vào WAL (không chỉ delta) — để chống "torn write" khi crash giữa write page. → ngay sau checkpoint, WAL traffic tăng vọt.

### 8.3. Đường đi 1 byte modification

```diagram
╭────────────────────────────────────────────────────────────╮
│ App: UPDATE orders SET status='paid' WHERE id=42;          │
│            │                                               │
│            ▼                                               │
│   Backend process trong PG                                 │
│            │                                               │
│            ▼                                               │
│   Shared Buffer (RAM) ── mark dirty                        │
│            │                                               │
│            ▼                                               │
│   WAL Buffer (RAM) ── append record                        │
│            │                                               │
│   ───── COMMIT ─────                                       │
│            │                                               │
│            ▼                                               │
│   WAL file (disk) ── fsync()  ← BẮT BUỘC trước khi OK      │
│            │                                               │
│            ▼ (async, sau)                                  │
│   Bgwriter / Checkpointer flush page dirty về data file    │
╰────────────────────────────────────────────────────────────╯
```

**fsync** là điểm nghẽn lớn nhất với mọi DML. NVMe SSD ~30k fsync/s, HDD ~100 fsync/s. Mỗi COMMIT = ít nhất 1 fsync (trừ khi dùng `synchronous_commit = off`).

### 8.4. Group commit & batched fsync

Để giảm áp lực fsync, Postgres group nhiều commit lại:

```
Tx A → write WAL → wait
Tx B → write WAL → wait      ┐
Tx C → write WAL → wait      ├─→ 1 fsync()  ──→ all 3 commit return
Tx D → write WAL → wait      ┘
```

`commit_delay` + `commit_siblings` điều chỉnh. Tăng throughput nhưng tăng latency.

### 8.5. Tại sao nhiều index → nhiều WAL

Mỗi index insert/update = 1 WAL record riêng. Bảng 10 index → **10 WAL records** thay vì 1. Trên workload write-heavy, WAL trở thành bottleneck → disk I/O bão hòa → checkpointer không kịp flush → bgwriter quá tải → **cascade slowdown**.

### 8.6. Checkpoint storm

Mỗi `checkpoint_timeout` (default 5 phút), checkpointer phải flush **mọi page dirty** về data file. Sau đó, mọi modification lại bắt đầu FPW chu kỳ mới.

```diagram
Time:    ▼ checkpoint                       ▼ checkpoint
WAL bps: ▁▁▇▆▅▅▄▄▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▁▁▇▆▅▅▄▄▃▃▃...
```

Right after checkpoint, FPW gây surge WAL. Nhiều index = surge to hơn. Tune `max_wal_size`, `checkpoint_completion_target` để smooth.

---

## 9. Index Bloat — Nguồn gốc, cách phát hiện, cách xử lý

### 9.1. Bloat là gì?

**Bloat** = "khoảng trống lãng phí" trong index/table do dead tuple chưa được tái sử dụng. Index 1GB lý thuyết → thực tế chiếm 3GB → 2GB là bloat.

### 9.2. Bloat trong index sinh ra từ đâu?

1. **DELETE** → entry còn nguyên, đợi VACUUM.
2. **UPDATE non-HOT** → entry mới được chèn, entry cũ phải đợi VACUUM.
3. **Page split** → page cũ chỉ ~50% full, không co lại được.
4. **Insert pattern không tuần tự** (UUID v4) → split nhiều hơn → bloat nhanh hơn.

```diagram
Index leaf trước workload:
  ┌────────────────────────────┐
  │ k1 k2 k3 ... k200  [100%]  │
  └────────────────────────────┘

Sau 1M UPDATE non-HOT trên các giá trị:
  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ k1...k90 │  │ k91..k95 │  │ k96..k200│
  └──────────┘  └──────────┘  └──────────┘
   (60% used)   (40% used)    (50% used)
   
   Total: 3 page, dùng ~50% mỗi page = bloat 2x.
```

### 9.3. Hệ quả của bloat

- **Tăng disk space**: hiển nhiên.
- **Tăng I/O đọc**: B-Tree càng bloat → càng nhiều page leaf → cache hit thấp → read chậm.
- **Tăng I/O ghi**: page nửa rỗng vẫn phải đọc/ghi đủ 8KB.
- **VACUUM chậm**: phải quét toàn bộ index để dọn.

### 9.4. Đo bloat

```sql
-- pgstattuple extension
CREATE EXTENSION pgstattuple;

SELECT
  schemaname || '.' || tablename AS table,
  pg_size_pretty(pg_relation_size(relid)) AS table_size,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  (SELECT round(avg_leaf_density, 1)
   FROM pgstatindex(indexrelid::regclass::text)) AS leaf_density
FROM pg_stat_user_tables t
JOIN pg_index i ON i.indrelid = t.relid
WHERE relname = 'orders';

-- Hoặc dùng index bloat query nổi tiếng của ioguix:
-- https://github.com/ioguix/pgsql-bloat-estimation
```

### 9.5. Xử lý bloat

| Cách | Đặc điểm |
|------|----------|
| `VACUUM` | Reclaim slot dùng được, **không** trả space về OS |
| `VACUUM FULL` | Rewrite toàn bộ table + index → trả space → **lock độc quyền**, downtime |
| `REINDEX` | Rebuild 1 index → trả space → lock index (vài giây) |
| `REINDEX CONCURRENTLY` (PG 12+) | Rebuild không block read/write — recommended |
| `pg_repack` (extension) | Online repack table + index, không downtime |

```sql
-- Production-safe
REINDEX INDEX CONCURRENTLY idx_orders_user_id;
REINDEX TABLE CONCURRENTLY orders;

-- Khi downtime cho phép
VACUUM FULL orders;  -- ⚠️ block toàn bảng
```

> [!CAUTION]
> Bloat **không phải lúc nào cũng cần fix gấp**. Một index 30% bloat thường không đáng lo. Quan tâm khi bloat > 50% hoặc index quá lớn so với dữ liệu thật.

---

## 10. FILLFACTOR — Tham số ít người chỉnh mà tác động lớn

### 10.1. Định nghĩa

**FILLFACTOR** = % page được điền khi build/reload. Phần còn lại dành cho HOT update / page split tránh.

- Heap default: **100%** (full).
- B-Tree default: **90%** (chừa 10%).

### 10.2. Tại sao chừa chỗ?

- **Heap**: chừa chỗ để HOT update có thể fit tuple mới cùng page → tránh cập nhật index.
- **B-Tree**: chừa chỗ cho insert mới fit không cần split.

### 10.3. Khi nào nên giảm FILLFACTOR?

| Workload | FILLFACTOR khuyên |
|----------|-------------------|
| Read-only / append-only | 100% (default heap) |
| UPDATE thường xuyên trên cột không index | **70-80%** (tăng tỷ lệ HOT) |
| INSERT thường xuyên với key random (UUID) | **80-90%** index |
| Time-series, monotonic key | 100% (insert luôn ở cuối, không split giữa) |

### 10.4. Set FILLFACTOR

```sql
-- Trên bảng
ALTER TABLE orders SET (fillfactor = 80);
-- Effect: VACUUM FULL / REINDEX mới apply

-- Trên index
ALTER INDEX idx_orders_user_id SET (fillfactor = 80);
REINDEX INDEX CONCURRENTLY idx_orders_user_id;
```

### 10.5. Trade-off

- **Giảm fillfactor** → table/index lớn hơn (~25% với 80%) → cache hit thấp hơn cho read.
- **Tăng HOT %** → write nhanh hơn nhiều.

> [!TIP]
> Bảng write-heavy có nhiều index → giảm `fillfactor` xuống **70-80%** và theo dõi `n_tup_hot_upd` tỷ lệ trên `n_tup_upd`. Nếu HOT% từ 30% → 80% → write throughput thường tăng **2-4x**.

---

## 11. Bulk Load — Drop index, COPY, rồi tạo lại

Đây là **kỹ thuật cổ điển** nhưng quá nhiều dev bỏ qua.

### 11.1. Vấn đề

Load 10M rows vào bảng có 8 index. Mỗi row → 8 lookup + 8 insert vào B-Tree → 80M B-Tree operation. Cộng với page split, WAL, fsync → **giờ chứ không phải phút**.

### 11.2. Cách đúng — pattern 3 bước

```sql
-- BƯỚC 1: Drop tất cả non-PK index
DROP INDEX idx_orders_user_id;
DROP INDEX idx_orders_status;
DROP INDEX idx_orders_created;
-- ... (giữ PK vì cần đảm bảo unique)

-- BƯỚC 2: Bulk load (COPY là nhanh nhất)
COPY orders FROM '/tmp/orders.csv' WITH (FORMAT csv, HEADER true);
-- Có thể nhanh thêm:
SET maintenance_work_mem = '2GB';
SET synchronous_commit = off;  -- ⚠️ chỉ khi chấp nhận mất 1 vài giây nếu crash

-- BƯỚC 3: Tạo lại index (parallel nếu có thể)
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders(user_id);
CREATE INDEX CONCURRENTLY idx_orders_status ON orders(status);
CREATE INDEX CONCURRENTLY idx_orders_created ON orders(created_at);
-- ...

-- BƯỚC 4: VACUUM ANALYZE
VACUUM ANALYZE orders;
```

### 11.3. Vì sao build index sau lại nhanh hơn?

Khi build index từ đầu, Postgres:
- Đọc heap **tuần tự** (sequential I/O).
- **Sort** key trong bộ nhớ (`maintenance_work_mem`) hoặc external sort.
- Build B-Tree **từ dưới lên** (bottom-up) — không có page split nào.

So với: insert từng row vào B-Tree đã tồn tại = **N lookup + N split tiềm năng**.

### 11.4. Bench thực tế

| Pattern | Time (10M rows, 8 index) |
|---------|-------------------------|
| `INSERT` từng dòng (no batch) | 38 phút |
| `INSERT` batched (1000/batch) | 14 phút |
| `COPY` với index sẵn | 6 phút |
| `COPY` không index + build sau | **1.8 phút** |

> [!TIP]
> Bulk migration / ETL nightly job → **luôn** dùng pattern drop-load-rebuild. Tiết kiệm 70-95% thời gian.

### 11.5. Khi không thể drop index (bảng vẫn online)

```sql
-- Tăng work_mem để batch insert có buffer
SET work_mem = '256MB';
SET maintenance_work_mem = '2GB';

-- Tạm bỏ trigger
ALTER TABLE orders DISABLE TRIGGER ALL;

-- Load
COPY orders FROM ...;

-- Bật lại
ALTER TABLE orders ENABLE TRIGGER ALL;
```

---

## 12. Partial Index & Expression Index — Trả lời câu hỏi "có cần index toàn bộ không?"

Đây là hai loại index ít người dùng nhất, mà thường **giải pháp đẹp** cho write-heavy.

### 12.1. Partial Index

Chỉ index một **phần** của bảng:

```sql
-- Workload: 99% orders là 'completed'. Chỉ query 1% còn lại là 'pending'.
CREATE INDEX idx_orders_pending
  ON orders(created_at)
  WHERE status = 'pending';
```

Lợi ích:
- Index **nhỏ hơn 100 lần** → cache hit cao.
- Insert/update **không ảnh hưởng** đến index nếu row không thỏa predicate.
- Update **đưa row vào hoặc ra khỏi predicate** = chèn/xóa entry → chi phí có nhưng vẫn ít.

```sql
-- Use case kinh điển
CREATE INDEX idx_users_active_email
  ON users(email)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_orders_unpaid
  ON orders(created_at)
  WHERE paid_at IS NULL;

CREATE INDEX idx_logs_error
  ON logs(created_at)
  WHERE level >= 'error';
```

### 12.2. Expression Index

Index trên giá trị tính toán:

```sql
CREATE INDEX idx_users_lower_email
  ON users(LOWER(email));

-- Query phải dùng cùng expression
SELECT * FROM users WHERE LOWER(email) = 'a@x.com';  -- ✅ dùng index
```

Chi phí: mỗi insert/update tính lại expression. Với expression nặng (regex, JSON path), chi phí có thể đáng kể.

### 12.3. So sánh chi phí DML

| Index type | Insert cost | HOT update? |
|------------|-------------|-------------|
| Full B-Tree | ~80 bytes WAL + insert | Có nếu cột không bị động |
| Partial (predicate match) | tương đương full | tương đương |
| Partial (predicate không match) | **0** | **Có** (index không liên quan) |
| Expression | full + cost tính expression | Có nếu cột nguồn không đổi |

> [!IMPORTANT]
> **Partial index** là cách rẻ nhất để có "selective index" cho workload write-heavy. Nếu chỉ ~1% rows được query — index 99% còn lại là lãng phí thuần.

---

## 13. Unique Index — Cái giá đặc biệt cho lời hứa duy nhất

UNIQUE constraint = unique index + check duplicate trước mỗi insert.

### 13.1. Chi phí thêm so với index thường

Mỗi insert/update cập nhật unique index:

1. **Tính key**.
2. **Descend B-Tree** tìm leaf.
3. **Scan leaf** xem có entry cùng key chưa (≠ NULL).
4. Nếu có → xét visibility (entry có thể là dead tuple).
5. Nếu thực sự duplicate → **error + rollback**.
6. Nếu không → insert entry.

Bước 3-4 là **overhead riêng của UNIQUE** so với index thường.

### 13.2. Implication cho UPSERT

```sql
INSERT INTO users(email, name) VALUES(...)
ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name;
```

- Khoá lock trên **leaf page chứa key** trong unique index.
- Concurrent insert cùng email → 1 con thắng, các con khác đợi.
- Throughput tối đa giới hạn bởi contention trên leaf page hot.

### 13.3. Deferred Unique Constraint

```sql
ALTER TABLE x ADD CONSTRAINT u UNIQUE(col) DEFERRABLE INITIALLY DEFERRED;
```

Cho phép check vào cuối transaction → swap value tạm thời không vi phạm:

```sql
BEGIN;
UPDATE positions SET order = order * -1;  -- tạm để swap
UPDATE positions SET order = -order + N;  -- restore mới
COMMIT;  -- check unique tại đây
```

Nhưng đánh đổi: **không thể nhận lỗi sớm** — sai lệch chỉ phát hiện ở COMMIT.

### 13.4. NULL trong UNIQUE

Postgres / SQL Server: **`NULL ≠ NULL`** → nhiều NULL hợp lệ.
MySQL: tương tự với InnoDB.
Oracle: cho phép nhiều NULL nếu unique không chứa cột NOT NULL khác.

Cần partial unique nếu muốn "1 NULL active":

```sql
CREATE UNIQUE INDEX uq_active_email
  ON users(email)
  WHERE deleted_at IS NULL;
```

---

## 14. Foreign Key — Index ẩn mà bạn (có thể) cần

### 14.1. FK không tự sinh index trên child

```sql
CREATE TABLE order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT REFERENCES orders(id),  -- ← FK
    qty INT
);
-- Không có index trên order_id mặc định!
```

Hệ quả:

- `SELECT * FROM order_items WHERE order_id = 42` → **Seq Scan** trên `order_items`.
- `DELETE FROM orders WHERE id = 42` → cần check FK ở `order_items` → **Seq Scan**.
- `UPDATE orders SET id = ...` (nếu cho phép) → Seq Scan child.

### 14.2. Cần thêm index thủ công

```sql
CREATE INDEX idx_order_items_order ON order_items(order_id);
```

> [!WARNING]
> **Mọi FK** trên bảng lớn cần index trên cột FK của bảng con. Quên index → DELETE/UPDATE parent có thể chậm **hàng nghìn lần**.

### 14.3. Chi phí của FK check khi INSERT child

```sql
INSERT INTO order_items(order_id, qty) VALUES (42, 3);
-- Database: kiểm tra orders.id = 42 tồn tại → lookup PK orders → index seek
```

Mỗi insert child = 1 extra lookup parent. Trên PK index nhỏ + cache nóng → ~0.05ms. Không quá nặng, nhưng x N rows trong batch là đáng kể.

### 14.4. FK với CASCADE → chi phí lan

Đã đề cập mục 6.5 — DELETE parent → DELETE cascade child → tất cả index child phải maintain.

---

## 15. Catalog các thao tác DML và chi phí index tương ứng

Đây là **cheat sheet thực hành** quan trọng nhất doc.

```diagram
╭──────────────────────────────────────────────────────────────────╮
│  Operation                       Index impact     Cost factor    │
│  ────────────────────────────────────────────────────────────    │
│  INSERT 1 row                    All indexes      1× per index   │
│  INSERT ... ON CONFLICT          All unique check 2× check       │
│  COPY (bulk)                     All indexes      Per row × N    │
│  UPDATE (HOT)                    None (heap only) ~Free          │
│  UPDATE (non-HOT)                All indexes      Like INSERT    │
│  UPDATE indexed column           That index +     +1× target idx │
│  DELETE                          Heap only        Cleanup later  │
│  TRUNCATE                        Heap + indexes   Reset (fast)   │
│  MERGE / UPSERT                  Mix              Up to 2× ops   │
│  Foreign key cascade             Triggers DML     Lan child      │
│  ────────────────────────────────────────────────────────────    │
│  Page split                      Cost 30-100×     Avoid via FF   │
│  Full-Page Write (after CKPT)    8KB WAL per page Avoid via wide │
│                                                   checkpoint     │
│  Unique check                    +1 leaf scan     Per insert     │
│  GIN insert                      N-2 entries/val  Heavy          │
╰──────────────────────────────────────────────────────────────────╯
```

### 15.1. Operations xếp theo chi phí (tương đối)

| # | Operation | Relative cost |
|---|-----------|---------------|
| 1 | DELETE 1 row (no FK) | 1x |
| 2 | UPDATE HOT 1 row | ~1x |
| 3 | INSERT 1 row (1 index) | 2x |
| 4 | INSERT 1 row (10 index B-Tree) | ~6-10x |
| 5 | UPDATE 1 row (non-HOT, 10 index) | ~8-15x |
| 6 | INSERT 1 row (10 index + 1 GIN trgm) | ~30-50x |
| 7 | UPDATE 1 row gây page split index | ~50-200x |
| 8 | DELETE 1M rows + autovacuum sau | ~10-100x DELETE bình thường (delayed) |

---

## 16. So sánh giữa Postgres / MySQL / Oracle / SQL Server

| Aspect | Postgres | MySQL (InnoDB) | Oracle | SQL Server |
|--------|----------|----------------|--------|-----------|
| **Concurrency model** | MVCC (heap tuple versions) | MVCC (undo log) | MVCC (undo segments) | MVCC (version store) hoặc lock |
| **In-place update?** | ❌ (tuple mới) | ✅ (qua undo) | ✅ (qua undo) | ✅ (qua version store) |
| **HOT update / equivalent** | HOT (Postgres) | Implicit via undo | Implicit via undo | Per-row versioning |
| **Clustered PK** | Không (heap riêng) | ✅ (PK = clustered) | IOT nếu khai báo | Clustered index default |
| **Secondary index trỏ về** | CTID (physical) | PK value (logical) | ROWID (physical) | Clustered key |
| **Hệ quả khi page split** | Index ổn (CTID không đổi nếu HOT) | Secondary index ổn (PK không đổi) | ROWID có thể đổi → cần update | Tương tự MySQL |
| **Vacuum equivalent** | `VACUUM` | Purge thread tự dọn undo | SMON cleanup | Tự động ghost record cleanup |
| **WAL / Redo / Log** | WAL | Redo log + binlog | Redo log | Transaction log |
| **Bulk load best practice** | COPY + drop/rebuild idx | LOAD DATA INFILE + ALTER TABLE DISABLE KEYS | SQL*Loader / DIRECT path | BULK INSERT + TABLOCK |
| **FILLFACTOR analog** | `fillfactor` storage param | `MERGE_THRESHOLD` | `PCTFREE` | `FILLFACTOR` |

### 16.1. MySQL InnoDB — đặc thù

- **Secondary index lưu PK** thay vì rowid → mỗi secondary lookup tốn 1 lần PK lookup nữa.
- **UPDATE in-place** cho cột không index → tốt.
- **UPDATE PK** = đắt khủng khiếp (đụng tất cả secondary).
- **PURGE thread** tự dọn undo → ít cần "VACUUM thủ công" như Postgres.

### 16.2. Oracle — ROWID & PCTFREE

- ROWID là **địa chỉ vật lý** — nhưng vì in-place update, thường không đổi.
- **PCTFREE** giống FILLFACTOR — chừa chỗ cho row tăng kích thước (vd update VARCHAR2).
- **Index Organized Table (IOT)** — bảng = clustered B-Tree theo PK, giống MySQL.

### 16.3. SQL Server — Clustered ngôi vương

- PK mặc định = clustered → bảng = leaf của clustered index.
- Secondary trỏ về **clustered key**.
- Update key clustered = cực đắt.

---

## 17. Benchmark thực tế — Bao nhiêu là quá nhiều index?

### 17.1. Setup

```sql
-- Bảng base
CREATE TABLE t(id BIGSERIAL PRIMARY KEY, c1 INT, c2 INT, c3 INT,
              c4 INT, c5 INT, c6 INT, c7 INT, c8 INT, c9 INT, c10 INT);

-- Workload: 60% INSERT, 30% UPDATE, 10% SELECT
```

### 17.2. Throughput (transactions/sec)

| # Index | INSERT tps | UPDATE tps | Mixed tps |
|---------|-----------|------------|-----------|
| 1 | 28,500 | 31,200 | 26,800 |
| 3 | 19,800 (-30%) | 23,500 (-25%) | 19,100 (-29%) |
| 5 | 14,200 (-50%) | 18,400 (-41%) | 14,500 (-46%) |
| 7 | 10,800 (-62%) | 15,100 (-52%) | 11,300 (-58%) |
| 10 | 7,400 (-74%) | 11,800 (-62%) | 8,200 (-69%) |

### 17.3. Latency p99

| # Index | INSERT p99 | UPDATE p99 |
|---------|-----------|------------|
| 1 | 1.2 ms | 1.0 ms |
| 5 | 8.5 ms | 5.2 ms |
| 10 | 25 ms | 15 ms |

> [!NOTE]
> Latency tăng **phi tuyến** với số index do contention WAL, page split cumulative, và bloat. Latency p99 thường tệ hơn p50 nhiều lần với workload nhiều index.

### 17.4. Khi nào nên dừng thêm index?

Hỏi 3 câu trước khi tạo index mới:

1. **Query này chạy bao nhiêu lần/ngày?**
   - < 10 lần/ngày & vài giây → đừng tạo, để Seq Scan.
   - > 1000 lần/ngày & cần < 100ms → có khi cần.

2. **Cột này có bị update không?**
   - Có → index sẽ tốn cho mọi UPDATE.
   - Không → tốn ít (chỉ INSERT).

3. **Có index hiện tại có cover được không?**
   - Composite (a, b) cover được (a) → không cần (a) riêng.

### 17.5. Quy tắc kinh nghiệm

> [!TIP]
> - Bảng OLTP (write-heavy): **≤ 5 index** thường vừa đủ.
> - Bảng read-heavy / DW: 10-15 index không phải bất thường.
> - Bảng append-only (log) + partition: phụ thuộc, nhưng < 5 chính + 1-2 partial.
> - Bảng "linked" (junction, many-to-many): cần FK index + có khi unique composite — thường 2-3 index.

---

## 18. Anti-patterns cần tránh

### 18.1. ❌ Tạo index "phòng hờ" không có query thực

```sql
-- Anti: tạo trên mọi cột "phòng khi cần"
CREATE INDEX idx_orders_note ON orders(note);
-- Reality: không query nào WHERE note = ... → 0 idx_scan, 100% chi phí
```

Audit `pg_stat_user_indexes.idx_scan = 0` → drop.

### 18.2. ❌ Duplicate index

```sql
CREATE INDEX idx_a ON orders(user_id);
CREATE INDEX idx_b ON orders(user_id, created_at);
-- idx_a hoàn toàn redundant — idx_b đã cover prefix user_id
```

### 18.3. ❌ Index quá rộng

```sql
CREATE INDEX idx_wide ON orders(user_id, status, total, created_at, shipping_id);
-- Size lớn, ít dùng, mỗi UPDATE 1 trong 5 cột phá HOT
```

### 18.4. ❌ Index trên cột thay đổi liên tục

```sql
CREATE INDEX idx_orders_updated ON orders(updated_at);
-- updated_at update mỗi lần row đổi → mỗi UPDATE chèn 1 entry mới + bloat
```

Nếu bắt buộc → cân nhắc partial: `WHERE updated_at > NOW() - INTERVAL '7 days'`.

### 18.5. ❌ Index trên cột low-cardinality

```sql
CREATE INDEX idx_orders_active ON orders(is_active);
-- Chỉ 2 giá trị → selectivity 50% → Postgres không dùng index, vẫn Seq Scan
```

Dùng **partial** thay thế:

```sql
CREATE INDEX idx_orders_active_partial ON orders(created_at) WHERE is_active = true;
```

### 18.6. ❌ Không drop index sau khi đổi schema

```sql
-- Đổi business logic: không còn query theo coupon_id
-- Quên: DROP INDEX idx_orders_coupon → vẫn tốn write cost
```

Định kỳ chạy unused index audit.

### 18.7. ❌ Dùng GIN trên cột write-heavy

```sql
CREATE INDEX idx_logs_msg_trgm ON logs USING GIN(msg gin_trgm_ops);
-- logs: 100k inserts/s → GIN bị bottleneck, write throughput giảm 90%
```

Solution: tách bảng `hot` (write) + `cold` (search), sync periodically.

### 18.8. ❌ DELETE thay vì TRUNCATE/DROP PARTITION

```sql
DELETE FROM events WHERE created_at < NOW() - INTERVAL '30 days';
-- 50M dead tuples, 12 index cần vacuum, bloat tăng vọt
```

Dùng partition + DROP.

### 18.9. ❌ Không monitor HOT %

```sql
-- Không biết HOT% giảm từ 90% → 20% sau khi thêm index gần đây
-- → write degraded, không có ai để ý đến lúc complaint
```

### 18.10. ❌ Bulk load với index còn nguyên

```sql
COPY orders FROM '/tmp/big.csv';  -- 10M rows, 8 index → 30 phút
-- Đúng: drop index → COPY → rebuild → 3 phút
```

---

## 19. Monitoring & Maintenance

### 19.1. Index không bao giờ dùng đến

```sql
SELECT
    schemaname || '.' || relname AS table,
    indexrelname AS index,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%pkey'
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;
```

### 19.2. Tỷ lệ HOT update

```sql
SELECT
    relname,
    n_tup_upd, n_tup_hot_upd,
    round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct,
    n_live_tup, n_dead_tup
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC
LIMIT 20;
-- hot_pct < 50% trên bảng write-heavy = đáng điều tra
```

### 19.3. Index bloat

```sql
-- Cần extension pgstattuple (chậm, chạy off-peak)
CREATE EXTENSION pgstattuple;

SELECT
    indexrelname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    round((pgstatindex(indexrelid::regclass::text)).avg_leaf_density, 1) AS density
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;
-- density < 50 = bloat đáng kể → REINDEX CONCURRENTLY
```

### 19.4. Top write tables

```sql
SELECT
    relname,
    n_tup_ins, n_tup_upd, n_tup_del,
    n_tup_ins + n_tup_upd + n_tup_del AS total_writes,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY total_writes DESC
LIMIT 10;
-- Bảng top write → ứng viên audit index
```

### 19.5. WAL traffic

```sql
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')) AS total_wal;

-- Per-statement (pg_stat_statements)
SELECT substring(query, 1, 60) AS q,
       calls, total_exec_time, wal_records, wal_bytes
FROM pg_stat_statements
ORDER BY wal_bytes DESC
LIMIT 20;
```

### 19.6. Autovacuum tracking

```sql
SELECT relname, n_dead_tup, last_autovacuum, autovacuum_count
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

### 19.7. Lock waits

```sql
SELECT pid, query, wait_event_type, wait_event, state, query_start
FROM pg_stat_activity
WHERE wait_event_type = 'Lock'
ORDER BY query_start;
```

---

## 20. Playbook — Audit và cắt giảm index trên hệ thống production

Bạn thừa hưởng hệ thống 30+ index/bảng. Làm sao audit và giảm an toàn?

### 20.1. Bước 1 — Inventory

```sql
SELECT schemaname, relname, count(*) AS n_indexes
FROM pg_stat_user_indexes
GROUP BY 1, 2
ORDER BY n_indexes DESC
LIMIT 20;
```

### 20.2. Bước 2 — Đánh giá từng index

Cho mỗi bảng top, xuất danh sách index kèm:

```sql
SELECT
    i.indexrelname,
    pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
    i.idx_scan, i.idx_tup_read, i.idx_tup_fetch,
    pg_get_indexdef(i.indexrelid) AS definition
FROM pg_stat_user_indexes i
WHERE i.relname = 'orders'
ORDER BY i.idx_scan;
```

Phân loại:

| Tiêu chí | Hành động |
|----------|----------|
| `idx_scan = 0` trong 30 ngày | Candidate drop |
| `idx_scan < 10` & size > 1GB | Cân nhắc drop nếu chấp nhận query chậm |
| Cover bởi composite khác | Drop |
| GIN trên cột write-heavy | Cân nhắc tách bảng |
| Trùng cột với index khác (case khác nhau) | Đánh giá merge |

### 20.3. Bước 3 — Drop CONCURRENTLY

```sql
-- Không block reads/writes
DROP INDEX CONCURRENTLY idx_orders_old_unused;
```

> [!CAUTION]
> Trước khi drop production index, **luôn**: snapshot stats, theo dõi 1 tuần, có rollback plan (CREATE INDEX CONCURRENTLY lại nếu cần — đảm bảo có DDL script sẵn).

### 20.4. Bước 4 — Đo lại

```sql
-- Trước/sau:
SELECT calls, mean_exec_time, total_exec_time
FROM pg_stat_statements WHERE query LIKE '%orders%';

-- HOT% trước/sau:
SELECT relname, round(100.0 * n_tup_hot_upd / n_tup_upd, 1) AS hot_pct
FROM pg_stat_user_tables WHERE relname = 'orders';
```

### 20.5. Bước 5 — Tuning tiếp

- Thêm `fillfactor` 80% trên bảng update-heavy.
- Chuyển index full → partial nếu predicate hợp lý.
- Chuyển GIN sang FTS riêng table sync nếu write quá nhiều.

### 20.6. Bước 6 — Lập rule team

- Mọi PR thêm index phải có justification: query nào, tần suất, latency target.
- Quarterly audit unused index.
- Khi schema change, drop index liên quan trước.

---

## 21. Tóm tắt — Cheat sheet & 3 nguyên tắc

Quay lại câu hỏi đầu doc: **Tại sao 1 UPDATE 100k rows tốn 32 giây dù lookup chỉ 58ms?**

> Mỗi index = thêm 1 B-Tree phải maintain mỗi lần write. Index update không thể HOT → mọi index bị chèn entry mới + WAL + page split → 12 index × 100k rows = vài chục giây.

### 21.1. Cheat sheet operation → impact

```diagram
╭───────────────────────────────────────────────────────────────╮
│  Operation                Index touched     Tips              │
│  ───────────────────────────────────────────────────────────  │
│  INSERT                   All               ↓ count, COPY     │
│  UPDATE (cols indexed)    Affected idx      Avoid if possible │
│  UPDATE (cols not idx)    None (HOT!)       ✓ Tối ưu lý tưởng │
│  UPDATE (page full)       All (no HOT)      ↓ fillfactor      │
│  DELETE                   None (defer)      VACUUM/TRUNCATE   │
│  TRUNCATE                 Reset             Use for cleanup   │
│  COPY bulk                All per row       Drop & rebuild    │
│  UPSERT                   All + unique chk  Costly            │
│  GIN/GIST insert          Many entries      Avoid hot tables  │
╰───────────────────────────────────────────────────────────────╯
```

### 21.2. Bảng so sánh chi phí

| Pattern | Insert | Update HOT | Update non-HOT | Delete |
|---------|--------|------------|----------------|--------|
| 0 index | 1x | 1x | 1x | 1x |
| 5 B-Tree | 4x | 1x | 5x | 1x |
| 10 B-Tree | 8x | 1x | 9x | 1x |
| 10 B-Tree + 1 GIN | 25x | 1x | 26x | 1x |

### 21.3. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Mỗi index là một loại thuế ghi.**
> Trước khi thêm: hỏi query thực sự cần nó chạy bao nhiêu lần và tiết kiệm bao nhiêu ms. So với chi phí cho **mọi** INSERT/UPDATE từ nay đến hết đời bảng.
>
> **2. Bảo vệ HOT update bằng mọi giá.**
> - Đừng index những cột bị update thường xuyên.
> - Set `fillfactor = 80` cho bảng update-heavy.
> - Monitor `n_tup_hot_upd / n_tup_upd` — phấn đấu > 80%.
>
> **3. Dùng đúng công cụ cho đúng việc.**
> - **Bulk load** → drop index → COPY → rebuild.
> - **Mass delete định kỳ** → partition + DROP, không DELETE.
> - **Selective query** → partial index, không full index.
> - **Search substring** → tách bảng, GIN riêng, không nhồi vào bảng OLTP.

### 21.4. Quote cuối

> Index không phải miễn phí. Mỗi B-Tree là một lời hứa với optimizer rằng cấu trúc này sẽ luôn được giữ nhất quán — và lời hứa đó phải trả bằng I/O, WAL, lock, và bloat của **mọi** write từ giây phút nó được tạo ra.

Lần sau khi đứng trước câu hỏi *"có nên thêm index này không?"* — hãy nhớ: **bạn không chỉ trả một lần để tạo nó. Bạn trả mỗi lần ai đó INSERT, UPDATE, hoặc DELETE từ giờ trở đi.**
