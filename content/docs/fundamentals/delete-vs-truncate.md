---
title: "DELETE vs TRUNCATE"
description: "Mổ xẻ chi tiết sự khác nhau giữa DELETE và TRUNCATE trong SQL — không chỉ syntax, mà là cách database thực thi từng lệnh ở tầng heap, page, WAL, MVCC, dead tuple, sequence, lock, trigger, FK. Kèm execution plan, benchmark, rollback, ON DELETE, và decision framework."
---

## Mục lục

- [Bối cảnh: Câu DELETE chạy 40 phút mà bảng vẫn đầy 80 GB](#1-bối-cảnh-câu-delete-chạy-40-phút-mà-bảng-vẫn-đầy-80-gb)
- [Hai lệnh, một mục đích, hai bản chất hoàn toàn khác nhau](#2-hai-lệnh-một-mục-đích-hai-bản-chất-hoàn-toàn-khác-nhau)
- [DELETE — DML, đi từng dòng, tôn trọng MVCC](#3-delete--dml-đi-từng-dòng-tôn-trọng-mvcc)
- [TRUNCATE — DDL, ném cả cái file đi, không thèm nhìn từng dòng](#4-truncate--ddl-ném-cả-cái-file-đi-không-thèm-nhìn-từng-dòng)
- [So sánh Execution Plan & đường đi của một lệnh](#5-so-sánh-execution-plan--đường-đi-của-một-lệnh)
- [Vì sao DELETE không trả lại disk còn TRUNCATE thì có](#6-vì-sao-delete-không-trả-lại-disk-còn-truncate-thì-có)
- [Transaction & Rollback — Cả hai đều rollback được, nhưng khác nhau](#7-transaction--rollback--cả-hai-đều-rollback-được-nhưng-khác-nhau)
- [Lock — Row lock vs Access Exclusive lock](#8-lock--row-lock-vs-access-exclusive-lock)
- [Sequence / Identity / AUTO_INCREMENT — Ai reset, ai không](#9-sequence--identity--autoincrement--ai-reset-ai-không)
- [Trigger, Foreign Key, ON DELETE CASCADE — Những điều TRUNCATE bỏ qua](#10-trigger-foreign-key-on-delete-cascade--những-điều-truncate-bỏ-qua)
- [WAL, replication & PITR — Khối lượng log sinh ra khác nhau ra sao](#11-wal-replication--pitr--khối-lượng-log-sinh-ra-khác-nhau-ra-sao)
- [So sánh giữa Postgres / MySQL / Oracle / SQL Server](#12-so-sánh-giữa-postgres--mysql--oracle--sql-server)
- [Benchmark thực tế — DELETE vs TRUNCATE vs DROP+CREATE](#13-benchmark-thực-tế--delete-vs-truncate-vs-dropcreate)
- [Còn DROP TABLE thì sao? — Bộ ba xóa dữ liệu](#14-còn-drop-table-thì-sao--bộ-ba-xóa-dữ-liệu)
- [Anti-patterns cần tránh](#15-anti-patterns-cần-tránh)
- [Decision Framework — Flowchart chọn đúng lệnh](#16-decision-framework--flowchart-chọn-đúng-lệnh)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#17-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Bối cảnh: Câu DELETE chạy 40 phút mà bảng vẫn đầy 80 GB

Bạn vận hành bảng `events` của một hệ thống logging. Mỗi đêm có một job dọn log cũ:

```sql
CREATE TABLE events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT,
    type        TEXT,
    payload     JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- 200,000,000 rows, ~80 GB data + 25 GB index
```

Job dọn log viết thế này:

```sql
DELETE FROM events WHERE created_at < NOW() - INTERVAL '90 days';
-- 180,000,000 rows affected
-- Time: 2,418,330 ms  (~40 phút!)
```

Sau khi job chạy xong, bạn mở `\dt+ events` để xem dung lượng đã giảm chưa:

```text
 Schema |  Name  | Type  |    Size    | Description
--------+--------+-------+------------+-------------
 public | events | table |   80 GB    |
```

**80 GB. Không giảm một byte nào.** Bạn xóa 90% số dòng, đợi 40 phút, mà file vẫn nguyên kích thước — thậm chí WAL còn phình thêm 60 GB và replica thì lag 20 phút.

Đồng nghiệp đi qua nhìn màn hình, gõ một dòng:

```sql
TRUNCATE TABLE events;
-- Time: 47 ms
```

47 mili-giây. Disk trả về ngay lập tức. Bạn đứng hình.

> [!IMPORTANT]
> `DELETE` và `TRUNCATE` **trông** giống nhau (đều "xóa dữ liệu trong bảng"), nhưng dưới lớp vỏ chúng là **hai cơ chế hoàn toàn khác nhau**: một cái là **DML** đi qua từng dòng và tôn trọng MVCC, một cái là **DDL** ném thẳng file dữ liệu đi. Hiểu sai sự khác biệt này dẫn đến job chạy 40 phút thay vì 47ms — hoặc tệ hơn: xóa nhầm dữ liệu không rollback được, hoặc bỏ qua trigger audit quan trọng.

Trong doc này, ta sẽ mổ xẻ từng lớp:

1. `DELETE` thật sự làm gì với **từng tuple, từng index, từng WAL record**.
2. Vì sao `TRUNCATE` nhanh đến mức "phi lý" — và cái giá nó đánh đổi.
3. Vì sao `DELETE` **không** trả lại disk, còn `TRUNCATE` thì có.
4. Cả hai **rollback** được hay không, lock kiểu gì, ảnh hưởng sequence ra sao.
5. Khi nào dùng cái nào — và khi nào **cả hai đều sai**, phải dùng partition hoặc `DROP`.

---

## 2. Hai lệnh, một mục đích, hai bản chất hoàn toàn khác nhau

Trước khi đi sâu, hãy nhìn tổng quan:

```diagram
╭───────────────────────────────────────────────────────────────╮
│  DELETE                                                       │
│  ──────                                                       │
│  • Là DML (Data Manipulation Language)                        │
│  • Đi qua TỪNG dòng thỏa WHERE, đánh dấu "dead"               │
│  • Sinh MVCC dead tuple → cần VACUUM thu hồi sau              │
│  • Kích hoạt trigger (BEFORE/AFTER DELETE)                    │
│  • Tôn trọng FK, ON DELETE CASCADE/RESTRICT                   │
│  • Ghi WAL cho TỪNG dòng → log khổng lồ                       │
│  • Row-level lock → đọc/ghi dòng khác vẫn chạy được           │
│  • KHÔNG trả disk về OS (file giữ nguyên size)                │
│  • Có WHERE → xóa một phần được                               │
│                                                               │
│  TRUNCATE                                                     │
│  ────────                                                     │
│  • Là DDL (Data Definition Language)                          │
│  • KHÔNG nhìn từng dòng — bỏ/đổi cả file dữ liệu              │
│  • Không sinh dead tuple, không cần VACUUM                    │
│  • KHÔNG kích hoạt row trigger (chỉ TRUNCATE trigger - PG)    │
│  • Bị chặn nếu có FK trỏ tới (trừ khi CASCADE)               │
│  • Ghi WAL rất ít (chỉ metadata thao tác)                     │
│  • Table-level lock (ACCESS EXCLUSIVE) → khóa cả bảng         │
│  • TRẢ disk về OS ngay (file co lại 0)                        │
│  • KHÔNG có WHERE → xóa toàn bộ hoặc không gì cả              │
╰───────────────────────────────────────────────────────────────╯
```

Bảng so sánh nhanh — phần còn lại của doc sẽ giải thích **tại sao** từng dòng đúng:

| Tiêu chí | DELETE | TRUNCATE |
|----------|--------|----------|
| Loại lệnh | DML | DDL |
| Có `WHERE` (xóa một phần) | ✅ | ❌ (toàn bộ bảng) |
| Tốc độ trên bảng lớn | Chậm (O(n) theo số dòng) | Cực nhanh (gần như O(1)) |
| Đếm số dòng xóa (rows affected) | ✅ Trả về chính xác | ❌ Thường trả 0 |
| Kích hoạt trigger DELETE | ✅ | ❌ (PG có trigger riêng cho TRUNCATE) |
| Tôn trọng `ON DELETE CASCADE` | ✅ | ⚠️ Phải dùng `TRUNCATE ... CASCADE` |
| Sinh MVCC dead tuple | ✅ (phải VACUUM) | ❌ |
| Trả lại disk cho OS | ❌ (cần VACUUM FULL) | ✅ Ngay lập tức |
| Reset sequence/AUTO_INCREMENT | ❌ | ⚠️ Tùy DB / tùy option |
| Rollback trong transaction | ✅ | ✅ (PG/SQL Server) / ❌ (MySQL/Oracle) |
| Khối lượng WAL/redo | Lớn (mỗi dòng) | Nhỏ (metadata) |
| Mức lock | Row-level | Table-level (ACCESS EXCLUSIVE) |
| Quyền cần | `DELETE` | `TRUNCATE` / owner (mạnh hơn) |

---

## 3. DELETE — DML, đi từng dòng, tôn trọng MVCC

`DELETE` là một lệnh **DML** đầy đủ. Nó không "xóa" dữ liệu theo nghĩa đập ngay khỏi đĩa — nó **đánh dấu** từng dòng là "không còn nhìn thấy nữa" và để lại phần dọn dẹp cho `VACUUM`.

### 3.1. DELETE không xóa — nó đánh dấu "dead"

Trong các DB dùng **MVCC** (Postgres, Oracle theo cách khác, MySQL InnoDB theo cách khác), mỗi tuple có 2 trường quan trọng trong header:

| Trường | Ý nghĩa |
|--------|---------|
| `xmin` | Transaction đã **tạo** tuple này |
| `xmax` | Transaction đã **xóa/update** tuple này (0 = còn live) |

Khi bạn chạy `DELETE`, Postgres **không** xóa tuple. Nó chỉ set `xmax` = transaction id hiện tại:

```diagram
Trước DELETE:
   Heap page:  [ tuple A: xmin=100, xmax=0,   data: 'log #42' ]   ← live

DELETE FROM events WHERE id=42;   (txid=205)

Sau DELETE (chưa COMMIT, chưa VACUUM):
   Heap page:  [ tuple A: xmin=100, xmax=205, data: 'log #42' ]   ← "dead" với txn mới
```

Tuple A **vẫn nằm nguyên đó**, chiếm nguyên chỗ cũ. Nó chỉ "vô hình" với các transaction bắt đầu **sau** txid 205. Các transaction cũ (snapshot trước đó) vẫn thấy nó — đây chính là tinh thần của MVCC: *xóa nhưng không xóa, để reader cũ không bị ảnh hưởng*.

> [!NOTE]
> Đây là lý do `DELETE` rồi mà disk không giảm: dữ liệu vẫn ở đó dưới dạng **dead tuple**. Chỉ khi `VACUUM` chạy, không gian đó mới được đánh dấu **reusable** (và kể cả lúc đó, file cũng không co lại — xem mục 6).

### 3.2. Các bước thực thi một câu DELETE

```diagram
╭─────────────────────────────────────────────────────────────╮
│ 1. Parse + plan câu DELETE ... WHERE ...                    │
│ 2. Chọn access path để tìm dòng thỏa WHERE                  │
│    (Seq Scan / Index Scan trên điều kiện)                   │
│ 3. Với MỖI dòng tìm được:                                   │
│    3a. Acquire row lock (FOR UPDATE ngầm)                   │
│    3b. Chạy BEFORE DELETE trigger (nếu có)                  │
│    3c. Kiểm tra FK: dòng này có ai tham chiếu không?        │
│        → RESTRICT/NO ACTION: báo lỗi nếu có child           │
│        → CASCADE: đệ quy DELETE child                       │
│    3d. Set xmax = current txid trên tuple (đánh dấu dead)   │
│    3e. Ghi WAL record cho thao tác delete tuple này         │
│    3f. Chạy AFTER DELETE trigger (nếu có)                   │
│ 4. (Index KHÔNG được sửa ngay — entry trỏ về tuple dead     │
│     sẽ được dọn bởi VACUUM sau)                             │
│ 5. COMMIT → flush WAL → fsync                               │
╰─────────────────────────────────────────────────────────────╯
```

Điểm mấu chốt: **bước 3 lặp lại cho từng dòng**. Xóa 180 triệu dòng = 180 triệu lần đánh dấu + 180 triệu WAL record + kiểm tra FK/trigger cho mỗi dòng. Đây là lý do `DELETE` là **O(n)** theo số dòng xóa.

### 3.3. DELETE và index — không sửa ngay, để lại rác

Khi `DELETE` một dòng, các **index entry** trỏ về dòng đó **không bị xóa ngay**. Index vẫn còn entry trỏ về tuple đã dead:

```diagram
                  HEAP
   ╭─────────────────────────────────╮
   │  (0,1) tuple A  (dead, xmax=205)│←─┐
   ╰─────────────────────────────────╯  │
                                        │
   INDEX idx_events_created             │
   ╭──────────────────────────╮         │
   │  '2023-01-01' →  (0,1)   │ ── vẫn trỏ về tuple dead ──┘
   ╰──────────────────────────╯
```

Entry index này trở thành rác. `VACUUM` về sau phải:
1. Quét heap tìm dead tuple.
2. Với mỗi dead tuple, xóa **tất cả** index entry trỏ về nó.
3. Đánh dấu chỗ trống trong heap là reusable.

Vì vậy `DELETE` ồ ạt còn sinh thêm **chi phí VACUUM** về sau — chi phí "trả góp" mà bạn sẽ phải trả vào lúc autovacuum chạy (thường đúng vào lúc traffic cao).

### 3.4. Ví dụ: DELETE có WHERE — thứ TRUNCATE không làm được

Sức mạnh lớn nhất của `DELETE` là **xóa có điều kiện**:

```sql
-- Chỉ xóa đơn hàng đã hủy của năm ngoái
DELETE FROM orders
WHERE status = 'cancelled'
  AND created_at < '2025-01-01';

-- Xóa theo subquery
DELETE FROM sessions
WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);

-- Xóa kèm JOIN (Postgres: USING)
DELETE FROM order_items oi
USING orders o
WHERE oi.order_id = o.id AND o.status = 'cancelled';
```

`TRUNCATE` **không có** `WHERE`. Nó chỉ biết "xóa sạch bảng". Nếu bạn cần giữ lại dù chỉ 1 dòng → bắt buộc dùng `DELETE`.

### 3.5. Ưu điểm của DELETE

| Ưu điểm | Giải thích |
|---------|-----------|
| **Xóa có điều kiện** | `WHERE`, subquery, JOIN — xóa chính xác cái cần xóa |
| **Kích hoạt trigger** | Audit log, soft-delete cascade, cleanup phụ thuộc |
| **Tôn trọng FK** | `ON DELETE CASCADE/RESTRICT` chạy đúng |
| **MVCC-safe** | Reader đang chạy không bị ảnh hưởng, lock nhẹ (row-level) |
| **Rollback chuẩn DML** | Nằm gọn trong transaction ở mọi DB |
| **Trả về số dòng xóa** | Biết chính xác đã xóa bao nhiêu |

### 3.6. Nhược điểm của DELETE

| Nhược điểm | Giải thích |
|------------|-----------|
| **Chậm O(n)** | Đi từng dòng — bảng lớn = rất lâu |
| **Sinh dead tuple** | Bloat heap + index, cần VACUUM dọn |
| **Không trả disk** | File giữ nguyên size kể cả sau VACUUM |
| **WAL khổng lồ** | Mỗi dòng = 1 WAL record → replica lag, PITR phình |
| **Long transaction nguy hiểm** | DELETE 100M dòng trong 1 txn giữ lock + WAL lâu |

---

## 4. TRUNCATE — DDL, ném cả cái file đi, không thèm nhìn từng dòng

`TRUNCATE` không phải là một "DELETE nhanh". Nó là một lệnh **DDL** — cùng họ với `CREATE`/`DROP`/`ALTER` — và cơ chế của nó hoàn toàn khác.

### 4.1. TRUNCATE làm gì ở tầng vật lý

Thay vì đi qua từng tuple, `TRUNCATE` thao tác ở mức **file**. Trong Postgres, dữ liệu một bảng nằm trong file gọi là `relfilenode`. Khi truncate:

```diagram
╭─────────────────────────────────────────────────────────────╮
│  TRUNCATE TABLE events;                                     │
│                                                             │
│  1. Lấy ACCESS EXCLUSIVE lock trên bảng                     │
│  2. Tạo một relfilenode MỚI (file rỗng) cho bảng + index    │
│  3. Cập nhật catalog: bảng giờ trỏ tới file rỗng mới        │
│  4. File CŨ (chứa 80GB data) được lên lịch xóa khi COMMIT   │
│  5. Ghi WAL: chỉ một ít record metadata (không từng dòng)   │
│  6. COMMIT → file cũ bị unlink → OS trả disk ngay           │
╰─────────────────────────────────────────────────────────────╯
```

Mấu chốt: nó **không đọc**, **không sửa**, **không đánh dấu** một tuple nào. Nó chỉ nói với hệ thống file: *"cái file 80GB kia? Bỏ đi. Đây là file rỗng mới."* Vì thao tác không phụ thuộc số dòng, `TRUNCATE` gần như **O(1)** — xóa 200 triệu dòng cũng nhanh như xóa 200 dòng.

> [!IMPORTANT]
> `TRUNCATE` nhanh vì nó **không quan tâm bên trong file có gì**. Cái giá phải trả: nó không thể xóa *một phần*, không chạy trigger DELETE từng dòng, không kiểm tra FK từng dòng, và phải lấy lock **độc quyền toàn bảng** (không ai đọc/ghi được trong lúc đó).

### 4.2. Vì sao TRUNCATE không sinh dead tuple

Vì không có tuple nào bị đánh dấu `xmax` — cả cái file cũ bị vứt đi nguyên khối. Không có rác MVCC nào để lại → **không cần VACUUM** sau truncate. So sánh:

```diagram
DELETE 1 triệu dòng:
   → 1 triệu dead tuple nằm trong heap + index
   → autovacuum phải quét, dọn, ghi WAL thêm
   → disk vẫn đầy cho tới khi (có thể) VACUUM FULL

TRUNCATE bảng 1 triệu dòng:
   → 0 dead tuple
   → 0 việc cho VACUUM
   → disk trả về OS ngay tại COMMIT
```

### 4.3. TRUNCATE nhiều bảng cùng lúc

`TRUNCATE` có thể nhận nhiều bảng và làm tất cả trong **một transaction nguyên tử**:

```sql
-- Xóa sạch nhiều bảng cùng lúc, atomic
TRUNCATE TABLE order_items, orders, cart_items, carts;

-- Reset cả sequence (Postgres)
TRUNCATE TABLE events RESTART IDENTITY;

-- Xóa luôn các bảng có FK trỏ tới
TRUNCATE TABLE users CASCADE;
```

> [!TIP]
> Khi reset toàn bộ dữ liệu cho môi trường test/staging, `TRUNCATE a, b, c, d RESTART IDENTITY CASCADE;` là cách gọn và nhanh nhất — vừa xóa sạch, vừa reset id về 1, vừa lo các bảng phụ thuộc, tất cả trong một lệnh atomic.

### 4.4. Ưu điểm của TRUNCATE

| Ưu điểm | Giải thích |
|---------|-----------|
| **Cực nhanh** | Gần O(1) — không phụ thuộc số dòng |
| **Trả disk ngay** | File cũ bị unlink, OS thu hồi không gian |
| **Không sinh dead tuple** | Không cần VACUUM dọn dẹp |
| **WAL tối thiểu** | Chỉ metadata → replica không lag |
| **Reset sequence** (tùy chọn) | `RESTART IDENTITY` đưa id về đầu |
| **Atomic nhiều bảng** | Truncate nhiều bảng trong 1 lệnh |

### 4.5. Nhược điểm của TRUNCATE

| Nhược điểm | Giải thích |
|------------|-----------|
| **Không có WHERE** | Tất-cả-hoặc-không-gì — không xóa một phần được |
| **Lock độc quyền toàn bảng** | Chặn mọi đọc/ghi trong lúc chạy |
| **Bỏ qua row trigger** | Audit/cascade logic theo trigger không chạy |
| **Vướng FK** | Bị chặn nếu bảng khác trỏ tới (cần CASCADE) |
| **Quyền mạnh hơn** | Cần quyền `TRUNCATE`/owner, không chỉ `DELETE` |
| **Không rollback ở MySQL/Oracle** | Là DDL ngầm commit ở các DB này |

---

## 5. So sánh Execution Plan & đường đi của một lệnh

### 5.1. EXPLAIN cho DELETE — có cả một query plan

`DELETE` là DML, nên nó có **execution plan** đầy đủ như `SELECT`:

```sql
EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM events WHERE created_at < NOW() - INTERVAL '90 days';
```

```text
 Delete on events  (actual time=2418200.1..2418200.1 rows=0 loops=1)
   Buffers: shared hit=18,442,901 read=2,105,338 dirtied=4,920,114 written=4,388,002
   ->  Index Scan using idx_events_created on events
         (actual time=0.061..89441.2 rows=180,000,000 loops=1)
         Index Cond: (created_at < (now() - '90 days'::interval))
 Planning Time: 0.214 ms
 Execution Time: 2,418,330 ms
```

Đọc kỹ: phần `Index Scan` tìm dòng chỉ tốn ~89 giây. **2400+ giây còn lại** là việc đánh dấu 180M tuple, ghi WAL, dirty 4.9 triệu page (`dirtied=4,920,114`) — phần "xóa" thật sự. `dirtied` = số page bị làm bẩn → tất cả phải được ghi xuống đĩa bởi checkpoint/background writer.

### 5.2. EXPLAIN cho TRUNCATE — không có gì để plan

```sql
EXPLAIN TRUNCATE TABLE events;
-- ERROR:  syntax error at or near "TRUNCATE"
```

`TRUNCATE` là DDL — **không có** query plan để EXPLAIN. Không có "scan", không có "rows", không có cost. Nó chỉ là vài thao tác metadata + unlink file. Đây là bằng chứng trực quan nhất rằng hai lệnh này thuộc **hai thế giới khác nhau**.

### 5.3. Đường đi của 1 byte — minh họa song song

```diagram
DELETE FROM events WHERE created_at < X;
─────────────────────────────────────────
  Plan → Scan tìm dòng → [với mỗi dòng]:
     lock row → trigger? → FK? → set xmax
     → WAL record → dirty page
  ... lặp 180,000,000 lần ...
  → COMMIT → flush WAL (60 GB) → fsync
  → (sau đó) autovacuum dọn dead tuple → thêm WAL
  → disk: VẪN 80 GB

TRUNCATE TABLE events;
─────────────────────────────────────────
  ACCESS EXCLUSIVE lock
  → tạo relfilenode rỗng mới
  → catalog trỏ sang file mới
  → WAL: ~vài KB metadata
  → COMMIT → unlink file cũ
  → disk: 0 (trả về OS ngay)
```

---

## 6. Vì sao DELETE không trả lại disk còn TRUNCATE thì có

Đây là hiểu lầm phổ biến nhất: *"Tôi xóa hết dòng rồi mà sao file không nhỏ lại?"*

### 6.1. Mô hình "high water mark"

Heap của một bảng giống một cái cốc nước. `DELETE` làm **bốc hơi** nước (đánh dấu dead tuple), nhưng **mực cao nhất** (high water mark) — tức kích thước file — không tự hạ xuống. Database giữ nguyên các page đã cấp phát, chỉ đánh dấu chúng "có chỗ trống để tái sử dụng".

```diagram
Ban đầu:        ████████████████  80 GB (đầy)

Sau DELETE 90%: ░░░░░░░░░░░░░░██  80 GB file size, ~90% là chỗ trống reusable
                (file KHÔNG co — chỉ có chỗ trống bên trong)

Sau VACUUM:     ░░░░░░░░░░░░░░██  80 GB — chỗ trống nay "chính thức" reusable
                (vẫn KHÔNG co, chỉ là Postgres giờ biết chỗ nào dùng lại được)

Sau VACUUM FULL:██                ~8 GB (viết lại bảng, co file — nhưng KHÓA bảng!)

Sau TRUNCATE:   (rỗng)            0 GB — file cũ bị vứt đi, trả disk ngay
```

### 6.2. Tại sao thiết kế như vậy

Việc co file (trả page về OS) đòi hỏi **viết lại/di chuyển dữ liệu** và **lock**, rất đắt. Trong vận hành bình thường, bảng sẽ sớm được `INSERT` lấp lại chỗ trống đó, nên co rồi lại nới là lãng phí. Vì thế các DB chọn **giữ chỗ trống để tái sử dụng** thay vì trả ngay cho OS.

| Lệnh | Chỗ trống tái sử dụng | File co lại | Lock |
|------|----------------------|-------------|------|
| `DELETE` | Sau khi VACUUM | ❌ Không | Row-level |
| `VACUUM` (thường) | ✅ | ❌ (chỉ cắt page rỗng ở cuối) | Nhẹ, không chặn |
| `VACUUM FULL` | ✅ | ✅ Có (viết lại bảng) | ACCESS EXCLUSIVE |
| `TRUNCATE` | — | ✅ Ngay lập tức | ACCESS EXCLUSIVE |

> [!WARNING]
> `VACUUM FULL` co được file nhưng phải lấy **ACCESS EXCLUSIVE lock** và viết lại toàn bộ bảng — nguy hiểm không kém TRUNCATE về mặt khóa. Trên production, người ta thường dùng `pg_repack` để co bảng mà không khóa lâu, thay vì `VACUUM FULL`.

---

## 7. Transaction & Rollback — Cả hai đều rollback được, nhưng khác nhau

### 7.1. Postgres & SQL Server — Cả hai rollback được

Trong Postgres và SQL Server, `TRUNCATE` là **transactional DDL** — nằm trong transaction và rollback được:

```sql
-- Postgres
BEGIN;
TRUNCATE TABLE events;     -- bảng "trống" trong transaction này
SELECT count(*) FROM events;  -- => 0
ROLLBACK;
SELECT count(*) FROM events;  -- => 200,000,000  (dữ liệu quay lại!)
```

Cơ chế: vì truncate chỉ **tạo relfilenode mới** và lên lịch xóa file cũ **khi COMMIT**, nếu `ROLLBACK` thì file cũ chưa bị xóa → catalog trỏ lại file cũ → dữ liệu nguyên vẹn.

```sql
-- DELETE tất nhiên cũng rollback được (DML chuẩn)
BEGIN;
DELETE FROM events WHERE created_at < '2024-01-01';
ROLLBACK;   -- dead tuple được "hồi sinh" (xmax bị bỏ)
```

### 7.2. MySQL & Oracle — TRUNCATE KHÔNG rollback được

Ở MySQL và Oracle, `TRUNCATE` gây **implicit commit** (commit ngầm). Nó tự động commit transaction đang chạy, và bản thân nó không thể rollback:

```sql
-- MySQL / Oracle
START TRANSACTION;
INSERT INTO log VALUES (...);   -- thao tác này...
TRUNCATE TABLE events;          -- ...bị commit NGẦM tại đây! Không quay lại được
ROLLBACK;                       -- vô tác dụng với TRUNCATE (và cả INSERT ở trên)
```

> [!IMPORTANT]
> Ở MySQL/Oracle, `TRUNCATE` là **điểm không thể quay đầu**. Đã chạy là mất dữ liệu, kể cả bạn đang trong transaction. `DELETE` thì luôn rollback được ở mọi DB. Nếu bạn cần "an toàn rollback" trên MySQL/Oracle → dùng `DELETE`, đừng dùng `TRUNCATE`.

### 7.3. Bảng so sánh rollback

| DB | `DELETE` rollback | `TRUNCATE` rollback | Ghi chú |
|----|:-:|:-:|---------|
| PostgreSQL | ✅ | ✅ | DDL transactional thật sự |
| SQL Server | ✅ | ✅ | TRUNCATE minimally-logged nhưng vẫn rollback được |
| MySQL (InnoDB) | ✅ | ❌ | TRUNCATE = implicit commit + drop/recreate |
| Oracle | ✅ | ❌ | TRUNCATE là DDL, auto-commit |

---

## 8. Lock — Row lock vs Access Exclusive lock

### 8.1. DELETE — Row-level lock

`DELETE` chỉ khóa các **dòng** nó đụng tới. Các dòng khác — và phần lớn người đọc — vẫn hoạt động bình thường (nhờ MVCC, reader đọc snapshot cũ không cần đợi):

```diagram
DELETE FROM events WHERE user_id = 42;   -- chỉ khóa các dòng user_id=42

Trong lúc đó, các session khác VẪN có thể:
   ✅ SELECT * FROM events WHERE user_id = 99;   (đọc bình thường)
   ✅ INSERT INTO events ...                       (ghi dòng mới)
   ✅ UPDATE events SET ... WHERE user_id = 7;     (sửa dòng khác)
   ⏳ UPDATE events SET ... WHERE user_id = 42;    (chỉ cái này phải đợi)
```

### 8.2. TRUNCATE — Access Exclusive lock

`TRUNCATE` lấy **ACCESS EXCLUSIVE** — mức lock cao nhất. Trong lúc nó chạy (dù chỉ 47ms), **không session nào** được đọc hay ghi bảng đó, kể cả `SELECT`:

```diagram
TRUNCATE TABLE events;   -- khóa TOÀN BẢNG ở mức cao nhất

Trong lúc đó, MỌI session khác bị chặn:
   ⏳ SELECT * FROM events ...      (phải đợi!)
   ⏳ INSERT INTO events ...        (phải đợi!)
   ⏳ Mọi thứ đụng tới events       (phải đợi!)
```

> [!NOTE]
> `TRUNCATE` chạy rất nhanh nên cửa sổ khóa thường rất ngắn (vài ms–vài chục ms). Nhưng nếu **có transaction khác đang giữ lock** trên bảng (kể cả một `SELECT` dài), `TRUNCATE` sẽ phải **xếp hàng đợi** lấy ACCESS EXCLUSIVE — và trong lúc đợi, nó chặn luôn mọi query mới phía sau. Trên hệ thống bận, một `TRUNCATE` "47ms" có thể biến thành sự cố nghẽn cổ chai nếu nó kẹt sau một query chạy lâu.

---

## 9. Sequence / Identity / AUTO_INCREMENT — Ai reset, ai không

Một khác biệt hay bị quên: số tự tăng (`id`) sau khi xóa.

### 9.1. DELETE — KHÔNG bao giờ reset sequence

```sql
-- Bảng có id BIGSERIAL, đang ở id = 1,000,000
DELETE FROM events;        -- xóa hết
INSERT INTO events(type) VALUES ('new');
SELECT id FROM events;     -- => 1,000,001  (tiếp tục từ chỗ cũ!)
```

`DELETE` không đụng tới sequence. Id tiếp theo vẫn nối tiếp giá trị cuối cùng.

### 9.2. TRUNCATE — Tùy DB, tùy option

| DB | Hành vi mặc định | Cách điều khiển |
|----|------------------|-----------------|
| **PostgreSQL** | **Giữ nguyên** sequence (`CONTINUE IDENTITY`) | `TRUNCATE ... RESTART IDENTITY` để reset về 1 |
| **MySQL (InnoDB)** | **Reset** AUTO_INCREMENT về 1 (luôn) | Không tránh được — TRUNCATE luôn reset |
| **SQL Server** | **Reset** IDENTITY về seed | Mặc định reset |
| **Oracle** | Tùy: `TRUNCATE ... [CONTINUE\|RESTART] IDENTITY` (12c+) | Mặc định CONTINUE, dùng RESTART để reset |

```sql
-- Postgres: muốn reset id về 1
TRUNCATE TABLE events RESTART IDENTITY;
INSERT INTO events(type) VALUES ('new');
SELECT id FROM events;     -- => 1  (đã reset)

-- Postgres: giữ nguyên (mặc định)
TRUNCATE TABLE events;            -- = TRUNCATE ... CONTINUE IDENTITY
-- id tiếp theo vẫn nối tiếp giá trị cũ
```

> [!WARNING]
> Đừng giả định hành vi sequence khi chuyển DB. Cùng câu `TRUNCATE TABLE t;`: MySQL **reset** id về 1, Postgres **giữ nguyên**. Một migration script viết cho MySQL đem chạy trên Postgres có thể tạo ra id trùng/lệch ngoài mong đợi.

---

## 10. Trigger, Foreign Key, ON DELETE CASCADE — Những điều TRUNCATE bỏ qua

### 10.1. Trigger

`DELETE` kích hoạt **row-level trigger** (`BEFORE DELETE`, `AFTER DELETE`) cho **từng dòng**. Đây là cách audit log, soft-delete, cleanup phụ thuộc thường được cài đặt:

```sql
CREATE TRIGGER audit_event_delete
AFTER DELETE ON events
FOR EACH ROW
EXECUTE FUNCTION log_deleted_event();   -- ghi vào bảng audit cho mỗi dòng
```

- `DELETE FROM events ...` → trigger chạy cho **mỗi dòng** bị xóa → audit đầy đủ.
- `TRUNCATE TABLE events` → trigger `FOR EACH ROW` **KHÔNG chạy**. Audit bị bỏ qua hoàn toàn.

> [!IMPORTANT]
> Nếu bảng có trigger audit/cascade quan trọng theo từng dòng, `TRUNCATE` sẽ **âm thầm bỏ qua** chúng. Đây là một cái bẫy nguy hiểm: dữ liệu mất nhưng không có vết audit. Postgres có hỗ trợ **statement-level TRUNCATE trigger** (`AFTER TRUNCATE ... FOR EACH STATEMENT`) để bù lại — nhưng bạn phải **chủ động** tạo nó.

```sql
-- Postgres: trigger riêng cho TRUNCATE (statement-level, không phải per-row)
CREATE TRIGGER on_events_truncate
AFTER TRUNCATE ON events
FOR EACH STATEMENT
EXECUTE FUNCTION log_truncate_event();
```

### 10.2. Foreign Key

`DELETE` tôn trọng FK theo từng dòng:

```sql
-- orders.user_id REFERENCES users(id) ON DELETE RESTRICT
DELETE FROM users WHERE id = 42;
-- ERROR nếu user 42 còn order → RESTRICT chặn lại
-- Hoặc nếu ON DELETE CASCADE → các order của user 42 cũng bị xóa
```

`TRUNCATE` xử lý FK ở mức **bảng**, không phải mức dòng:

```sql
TRUNCATE TABLE users;
-- ERROR:  cannot truncate a table referenced in a foreign key constraint
-- DETAIL: Table "orders" references "users".
-- HINT:   Truncate table "orders" at the same time, or use TRUNCATE ... CASCADE.
```

Để truncate bảng được tham chiếu, bạn phải:

```sql
-- Cách 1: truncate cả cụm cùng lúc
TRUNCATE TABLE users, orders, order_items;

-- Cách 2: CASCADE (TỰ ĐỘNG truncate mọi bảng trỏ tới — NGUY HIỂM)
TRUNCATE TABLE users CASCADE;
```

> [!WARNING]
> `TRUNCATE ... CASCADE` **khác** `ON DELETE CASCADE`. `TRUNCATE CASCADE` sẽ xóa sạch **toàn bộ** mọi bảng có FK trỏ tới (và đệ quy tiếp) — bất kể bao nhiêu dòng. Một lệnh `TRUNCATE users CASCADE` có thể quét sạch nửa database nếu sơ đồ FK phức tạp. Luôn cân nhắc kỹ trước khi gõ `CASCADE`.

### 10.3. Bảng tổng kết

| Khía cạnh | DELETE | TRUNCATE |
|-----------|--------|----------|
| Row trigger (`FOR EACH ROW`) | ✅ Chạy mỗi dòng | ❌ Không chạy |
| Statement TRUNCATE trigger (PG) | — | ✅ Nếu bạn tạo |
| FK `ON DELETE CASCADE` | ✅ Đệ quy xóa child | ❌ (dùng `TRUNCATE CASCADE` thay thế) |
| FK `RESTRICT/NO ACTION` | ✅ Chặn từng dòng | ⚠️ Chặn cả lệnh nếu có bảng trỏ tới |
| Kiểm tra ràng buộc | Per-row | Per-table |

---

## 11. WAL, replication & PITR — Khối lượng log sinh ra khác nhau ra sao

Mọi thay đổi trong Postgres đều phải ghi vào **WAL** (Write-Ahead Log) trước khi xuống data file. WAL là nền tảng của durability, replication, và Point-In-Time Recovery (PITR). Khối lượng WAL mà hai lệnh sinh ra **khác nhau một trời một vực**.

### 11.1. DELETE — WAL theo từng dòng

Mỗi dòng `DELETE` sinh một WAL record (đánh dấu tuple dead). Xóa 180 triệu dòng → ~180 triệu WAL record → có thể **hàng chục GB WAL**.

Hệ quả dây chuyền:
- **Replica lag**: replica phải replay từng record → tụt lại hàng chục phút.
- **PITR phình**: kho lưu WAL (archive) tăng vọt.
- **Checkpoint dồn dập**: nhiều dirty page → I/O spike.

```diagram
DELETE 180M dòng:
   primary ──[~60 GB WAL]──► archive (PITR phình)
                  │
                  └─────────► replica (replay 60 GB → lag 20 phút)
```

### 11.2. TRUNCATE — WAL tối thiểu

`TRUNCATE` chỉ ghi vài record metadata ("bảng X giờ trỏ relfilenode mới, file cũ unlink khi commit"). Dù bảng có 200 triệu dòng, WAL chỉ vài KB.

```diagram
TRUNCATE bảng 200M dòng:
   primary ──[~vài KB WAL]──► archive (gần như không tăng)
                  │
                  └──────────► replica (replay tức thì → lag ~0)
```

> [!NOTE]
> Đây là lý do trên hệ thống có replication, dọn dữ liệu lớn bằng `TRUNCATE` (hoặc drop partition) **lành tính** hơn nhiều so với một câu `DELETE` khổng lồ. `DELETE` 100 triệu dòng có thể làm replica lag nghiêm trọng và đẩy storage WAL lên đỉnh.

---

## 12. So sánh giữa Postgres / MySQL / Oracle / SQL Server

| Khía cạnh | PostgreSQL | MySQL (InnoDB) | Oracle | SQL Server |
|-----------|-----------|----------------|--------|------------|
| `DELETE` là | DML | DML | DML | DML |
| `TRUNCATE` là | DDL (transactional) | DDL (implicit commit) | DDL (auto-commit) | DDL (minimally logged) |
| `TRUNCATE` rollback được | ✅ | ❌ | ❌ | ✅ |
| `TRUNCATE` reset id | Mặc định **giữ** (`RESTART IDENTITY` để reset) | **Luôn reset** về 1 | Mặc định giữ (`RESTART IDENTITY` 12c+) | **Reset** về seed |
| `TRUNCATE` + FK | Chặn, cần `CASCADE`/truncate cùng lúc | Chặn nếu FK trỏ tới | Chặn (disable FK trước) | Chặn nếu có FK |
| `TRUNCATE ... CASCADE` | ✅ | ❌ | ❌ | ❌ |
| Cơ chế xóa của TRUNCATE | Tạo relfilenode mới, unlink file cũ | Drop + re-create tablespace | Deallocate extent (giữ tới minextents) | Deallocate data page |
| `DELETE` sinh dead row cần dọn | Dead tuple → VACUUM | Undo log → purge thread | Undo segment | Ghost record → ghost cleanup |
| Trigger TRUNCATE riêng | ✅ (`FOR EACH STATEMENT`) | ❌ | ❌ | ❌ |
| `DELETE` không WHERE = xóa hết | ✅ | ✅ | ✅ | ✅ |

> [!TIP]
> Quy tắc bỏ túi khi chuyển DB: **`DELETE` hành xử gần như giống nhau ở mọi DB; `TRUNCATE` thì khác nhau ở 3 điểm chí mạng** — rollback được không, có reset id không, có cho CASCADE không. Luôn tra lại 3 điểm này trước khi đem script truncate sang DB khác.

---

## 13. Benchmark thực tế — DELETE vs TRUNCATE vs DROP+CREATE

Kịch bản: bảng `events` với 10,000,000 dòng, 3 index, Postgres 16, SSD NVMe, fsync on. Mục tiêu: xóa **toàn bộ** bảng.

| Phương án | Thời gian | Disk sau xóa | WAL sinh ra | Cần VACUUM | Khóa |
|-----------|----------:|-------------:|------------:|:----------:|------|
| `DELETE FROM events;` | ~95 s | ~4.2 GB (không đổi) | ~3.1 GB | ✅ Có | Row-level |
| `DELETE` + `VACUUM` | ~95 s + ~40 s | ~4.2 GB (vẫn không co) | +WAL VACUUM | — | Nhẹ |
| `DELETE` + `VACUUM FULL` | ~95 s + ~70 s | ~0 (co hẳn) | Lớn | — | ACCESS EXCL |
| `TRUNCATE TABLE events;` | **~38 ms** | **0 (trả ngay)** | **~vài KB** | ❌ Không | ACCESS EXCL (ngắn) |
| `DROP` + `CREATE TABLE` | ~25 ms | 0 | ~vài KB | ❌ | ACCESS EXCL |

Chênh lệch: `DELETE` mất **95 giây + 40 phút disk vẫn đầy + replica lag**, trong khi `TRUNCATE` mất **38 mili-giây** và trả disk ngay. Tỉ lệ ~**2500 lần** về tốc độ cho cùng kết quả (xóa toàn bộ bảng).

> [!IMPORTANT]
> Con số trên chỉ đúng cho trường hợp **xóa TOÀN BỘ bảng**. Nếu bạn cần giữ lại dù chỉ vài dòng → `TRUNCATE` không dùng được, và `DELETE` (dù chậm) là lựa chọn duy nhất. Đừng đọc bảng này thành "TRUNCATE luôn tốt hơn DELETE" — chúng giải quyết hai bài toán khác nhau.

### 13.1. Mẹo khi buộc phải DELETE khối lượng lớn

Khi bạn **bắt buộc** xóa một phần lớn (không xóa hết, nên không truncate được), đừng chạy một câu DELETE khổng lồ. Chia nhỏ thành batch:

```sql
-- Xóa theo lô 10,000 dòng/lần để tránh long transaction + WAL spike
DO $$
BEGIN
  LOOP
    DELETE FROM events
    WHERE id IN (
      SELECT id FROM events
      WHERE created_at < NOW() - INTERVAL '90 days'
      LIMIT 10000
    );
    EXIT WHEN NOT FOUND;
    COMMIT;   -- commit từng lô → giải phóng WAL, cho VACUUM kịp dọn
  END LOOP;
END $$;
```

Hoặc cân nhắc kiến trúc **partition** ngay từ đầu (xem mục 14): xóa dữ liệu cũ = `DROP`/`DETACH` nguyên partition, nhanh như truncate mà vẫn xóa được "một phần" theo khoảng thời gian.

---

## 14. Còn DROP TABLE thì sao? — Bộ ba xóa dữ liệu

Để hoàn chỉnh bức tranh, đặt cạnh nhau ba lệnh hay bị nhầm:

```diagram
╭───────────────────────────────────────────────────────────────╮
│  DELETE     → Xóa DÒNG (data), giữ bảng + cấu trúc + index    │
│               → có WHERE, có thể xóa một phần                  │
│                                                               │
│  TRUNCATE   → Xóa TẤT CẢ DÒNG, giữ bảng + cấu trúc + index    │
│               → không WHERE, nhanh, trả disk                  │
│                                                               │
│  DROP TABLE → Xóa CẢ BẢNG: data + cấu trúc + index + trigger  │
│               → bảng biến mất hoàn toàn khỏi schema           │
╰───────────────────────────────────────────────────────────────╯
```

| Tiêu chí | DELETE | TRUNCATE | DROP TABLE |
|----------|--------|----------|------------|
| Xóa dữ liệu | ✅ (một phần/toàn bộ) | ✅ (toàn bộ) | ✅ (toàn bộ) |
| Giữ cấu trúc bảng | ✅ | ✅ | ❌ (bảng biến mất) |
| Giữ index/constraint/trigger | ✅ | ✅ | ❌ |
| Còn dùng được bảng sau đó | ✅ | ✅ | ❌ (phải CREATE lại) |
| Loại lệnh | DML | DDL | DDL |
| Tốc độ | Chậm | Nhanh | Nhanh |

### 14.1. Partition — vũ khí thật sự để dọn dữ liệu lớn

Với bảng log/time-series khổng lồ, lựa chọn tối ưu **không phải** DELETE hay TRUNCATE mà là **partition theo thời gian**. Xóa dữ liệu cũ trở thành thao tác metadata tức thì:

```sql
-- Bảng partition theo tháng
CREATE TABLE events (id BIGSERIAL, created_at TIMESTAMPTZ, ...)
PARTITION BY RANGE (created_at);

CREATE TABLE events_2025_01 PARTITION OF events
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
-- ... các partition khác

-- Dọn log tháng cũ — TỨC THÌ, không scan, không WAL khổng lồ:
ALTER TABLE events DETACH PARTITION events_2025_01;   -- tách ra
DROP TABLE events_2025_01;                            -- hoặc drop hẳn
-- HOẶC chỉ truncate riêng 1 partition:
TRUNCATE TABLE events_2025_01;
```

> [!TIP]
> Nếu bài toán của bạn là "xóa dữ liệu cũ định kỳ trên bảng lớn", câu trả lời đúng nhất thường **không** nằm trong cuộc tranh luận DELETE vs TRUNCATE — mà là **thiết kế partition** để biến việc xóa thành `DROP PARTITION` (tức thì). DELETE/TRUNCATE chỉ là cách xử lý khi bảng *chưa* được partition.

---

## 15. Anti-patterns cần tránh

### Anti-pattern 1: Dùng DELETE để xóa sạch bảng lớn

```sql
-- ❌ Chậm, sinh dead tuple, WAL khổng lồ, disk không giảm
DELETE FROM huge_log_table;

-- ✅ Xóa toàn bộ → dùng TRUNCATE
TRUNCATE TABLE huge_log_table;
```

### Anti-pattern 2: Dùng TRUNCATE khi cần audit/trigger

```sql
-- ❌ Bỏ qua AFTER DELETE trigger → mất audit log
TRUNCATE TABLE orders;

-- ✅ Cần trigger chạy → DELETE (hoặc tạo TRUNCATE trigger riêng nếu PG)
DELETE FROM orders WHERE created_at < '2024-01-01';
```

### Anti-pattern 3: TRUNCATE trong transaction trên MySQL/Oracle và tưởng rollback được

```sql
-- ❌ MySQL/Oracle: TRUNCATE commit ngầm → ROLLBACK vô tác dụng
START TRANSACTION;
TRUNCATE TABLE events;
ROLLBACK;   -- dữ liệu KHÔNG quay lại!

-- ✅ Cần an toàn rollback trên MySQL/Oracle → dùng DELETE
START TRANSACTION;
DELETE FROM events;
ROLLBACK;   -- OK, dữ liệu quay lại
```

### Anti-pattern 4: Một câu DELETE 100 triệu dòng trong 1 transaction

```sql
-- ❌ Long transaction: giữ lock lâu, WAL phình, replica lag, autovacuum bị chặn
DELETE FROM events WHERE created_at < NOW() - INTERVAL '1 year';

-- ✅ Chia batch + commit từng lô (xem mục 13.1)
-- ✅ Hoặc tốt hơn: partition rồi DROP PARTITION
```

### Anti-pattern 5: TRUNCATE ... CASCADE mà không hiểu nó kéo theo gì

```sql
-- ❌ Tưởng chỉ xóa users, hóa ra quét sạch mọi bảng trỏ tới (đệ quy)
TRUNCATE TABLE users CASCADE;

-- ✅ Liệt kê tường minh các bảng muốn xóa
TRUNCATE TABLE users, sessions, user_settings;
```

### Anti-pattern 6: Trông đợi DELETE trả lại disk

```sql
-- ❌ Xóa xong tưởng file co lại — nó KHÔNG
DELETE FROM events WHERE ...;
-- (disk vẫn nguyên)

-- ✅ Nếu thực sự cần co file: VACUUM FULL (khóa bảng) hoặc pg_repack (online)
VACUUM FULL events;     -- hoặc: pg_repack -t events
```

---

## 16. Decision Framework — Flowchart chọn đúng lệnh

```diagram
╭──────────────────────────────────────────────────────────────╮
│  Bạn cần xóa dữ liệu?                                        │
│                                                              │
│  ┌─ Xóa MỘT PHẦN (có điều kiện WHERE)?                        │
│  │  └─ Có → DELETE  (không có lựa chọn khác)                  │
│  │         └─ Khối lượng lớn? → chia batch / partition        │
│  │                                                            │
│  ├─ Xóa TOÀN BỘ bảng?                                         │
│  │  │                                                         │
│  │  ├─ Cần trigger DELETE chạy (audit)? → DELETE              │
│  │  │                                                         │
│  │  ├─ MySQL/Oracle & cần rollback an toàn? → DELETE          │
│  │  │                                                         │
│  │  └─ Còn lại → TRUNCATE  (nhanh, trả disk)                  │
│  │         └─ Cần reset id? → TRUNCATE ... RESTART IDENTITY   │
│  │         └─ Có FK trỏ tới? → liệt kê bảng / CASCADE (cẩn thận)│
│  │                                                            │
│  └─ Không cần bảng nữa (xóa cả cấu trúc)? → DROP TABLE        │
│                                                              │
│  ┌─ Dọn dữ liệu cũ ĐỊNH KỲ trên bảng lớn?                     │
│  │  └─ Thiết kế PARTITION → DROP/DETACH PARTITION (tốt nhất)  │
╰──────────────────────────────────────────────────────────────╯
```

### Bảng quyết định nhanh

| Tình huống | Chọn | Lý do |
|------------|------|-------|
| Xóa vài dòng theo điều kiện | **DELETE** | Chỉ DELETE có WHERE |
| Xóa toàn bộ bảng, không cần trigger | **TRUNCATE** | Nhanh, trả disk, ít WAL |
| Xóa toàn bộ nhưng cần audit trigger | **DELETE** | TRUNCATE bỏ qua row trigger |
| Reset bảng test/staging về rỗng | **TRUNCATE ... RESTART IDENTITY** | Sạch + reset id, atomic |
| MySQL/Oracle, cần rollback được | **DELETE** | TRUNCATE commit ngầm |
| Xóa khối lượng cực lớn (một phần) | **DELETE theo batch** / partition | Tránh long txn, WAL spike |
| Dọn log cũ định kỳ | **DROP/DETACH PARTITION** | Tức thì, không scan |
| Không cần bảng nữa | **DROP TABLE** | Xóa cả cấu trúc |
| Cần co file sau khi DELETE | **VACUUM FULL** / pg_repack | DELETE không trả disk |

---

## 17. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 17.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  Lệnh        Bản chất   WHERE  Tốc độ   Disk   Trigger  Rollback│
│  ───────────────────────────────────────────────────────────   │
│  DELETE      DML        ✅     Chậm     Giữ    ✅       ✅ mọi DB │
│  TRUNCATE    DDL        ❌     Nhanh    Trả    ❌*      Tùy DB    │
│  DROP TABLE  DDL        ❌     Nhanh    Trả    —        Tùy DB    │
│                                                               │
│  * PG có thể tạo statement-level TRUNCATE trigger riêng        │
╰───────────────────────────────────────────────────────────────╯
```

### 17.2. So sánh tổng quan

| Tiêu chí | DELETE | TRUNCATE |
|----------|:------:|:--------:|
| Tốc độ (xóa hết) | ⭐ | ⭐⭐⭐ |
| Xóa một phần | ⭐⭐⭐ | ❌ |
| Trả lại disk | ❌ | ⭐⭐⭐ |
| Ít WAL / replica-friendly | ⭐ | ⭐⭐⭐ |
| Trigger/FK chuẩn DML | ⭐⭐⭐ | ⭐ |
| An toàn rollback (mọi DB) | ⭐⭐⭐ | ⭐⭐ |
| Lock nhẹ | ⭐⭐⭐ | ⭐ |

### 17.3. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. DELETE để xóa MỘT PHẦN, TRUNCATE để xóa TẤT CẢ.**
> Cần `WHERE` → bắt buộc DELETE. Xóa sạch bảng không cần giữ gì → TRUNCATE (nhanh hơn hàng nghìn lần và trả disk ngay). Đừng dùng DELETE để xóa cả bảng lớn.
>
> **2. TRUNCATE bỏ qua trigger, FK per-row, và (ở MySQL/Oracle) không rollback được.**
> Trước khi gõ TRUNCATE, hỏi: *Có trigger audit không? Có bảng nào trỏ FK tới không? DB này có cho rollback TRUNCATE không?* Nếu nghi ngờ → DELETE an toàn hơn.
>
> **3. DELETE không trả disk; bảng lớn thì hãy nghĩ tới partition.**
> DELETE chỉ tạo dead tuple — file không co, còn sinh việc cho VACUUM và WAL khổng lồ. Với dữ liệu time-series cần dọn định kỳ, thiết kế **partition** rồi `DROP PARTITION` là lời giải vượt trội cả DELETE lẫn TRUNCATE.

### 17.4. Quote cuối

> `DELETE` và `TRUNCATE` không phải hai phiên bản nhanh/chậm của cùng một thứ — chúng là **hai cơ chế khác nhau ở tận tầng file**. Một cái nói chuyện với MVCC từng dòng, một cái nói chuyện với hệ thống file từng khối. Kỹ sư giỏi không chọn theo "cái nào nhanh hơn", mà theo **cái nào đúng bản chất bài toán**: cần lọc → DELETE, cần reset → TRUNCATE, cần dọn định kỳ → partition.

Lần sau trước khi gõ lệnh xóa dữ liệu, hãy tự hỏi: *"Mình đang xóa một phần hay tất cả? Mình có cần dữ liệu này quay lại không? Và sau khi xóa, disk có thật sự được trả về không?"* — Ba câu hỏi đó quyết định bạn nên gõ `DELETE`, `TRUNCATE`, hay nghĩ lại về kiến trúc bảng.
