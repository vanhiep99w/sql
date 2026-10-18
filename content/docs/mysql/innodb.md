---
title: "InnoDB Storage Engine"
description: "Kiến trúc InnoDB — Buffer Pool, Redo Log, Undo Log, Tablespace và cách MySQL xử lý dữ liệu bên dưới"
---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Kiến trúc tổng thể](#kiến-trúc-tổng-thể)
- [Buffer Pool](#buffer-pool)
- [Redo Log](#redo-log)
- [Undo Log](#undo-log)
- [Tablespace & Storage](#tablespace--storage)
- [Row Format](#row-format)
- [MVCC trong InnoDB](#mvcc-trong-innodb)
- [Tóm tắt](#tóm-tắt)

---

## Tổng quan

InnoDB là storage engine mặc định của MySQL từ phiên bản 5.5+. Đây là engine hỗ trợ đầy đủ ACID, foreign key, row-level locking và MVCC — làm nền tảng cho hầu hết các ứng dụng production.

| Đặc điểm | Giá trị |
| --------- | ------- |
| ACID compliant | Có |
| Transaction | Có |
| Foreign Key | Có |
| Locking | Row-level |
| MVCC | Có |
| Full-text Search | Từ MySQL 5.6+ |
| Crash recovery | Tự động qua Redo Log |

> [!NOTE]
> Storage engine khác như MyISAM không hỗ trợ transaction và row-level locking — chỉ phù hợp read-heavy, không khuyến khích dùng cho ứng dụng mới.

---

## Kiến trúc tổng thể

```d2 title="MySQL Server và InnoDB"
direction: down
server: MySQL Server Layer {
  icon: ../../diagram-assets/mysql.svg
  parser: Query Parser
  optimizer: Optimizer
  executor: Execution Engine
  parser -> optimizer -> executor
}
innodb: InnoDB Storage Engine {
  memory: In-Memory Structures {
    buffer: Buffer Pool — data + index
    redo: Redo Log Buffer
    change: Change Buffer
    dictionary: Data Dictionary Cache
  }
  disk: On-Disk Structures {
    tables: Tablespace .ibd { shape: cylinder }
    redo: Redo Logs { shape: cylinder }
    undo: Undo Logs { shape: cylinder }
  }
  memory.buffer -> disk.tables: flush dirty pages
  memory.redo -> disk.redo: flush redo
}
server.executor -> innodb
```

---

## Buffer Pool

Buffer Pool là vùng nhớ RAM quan trọng nhất của InnoDB — nơi cache **data pages** và **index pages** từ disk để tránh đọc disk liên tục.

### Cơ chế hoạt động

```d2 title="Buffer Pool: đường đọc và ghi"
direction: right
read: READ request {
  lookup: Tìm page trong Buffer Pool
  hit: HIT — trả từ RAM
  disk: MISS — đọc disk
  load: Load vào Buffer Pool rồi trả về
  lookup -> hit: có
  lookup -> disk: không
  disk -> load
}
write: WRITE request {
  dirty: Ghi Buffer Pool — dirty page
  redo: Ghi Redo Log để bảo đảm durability
  flush: Background flush dirty page — checkpoint
  dirty -> redo -> flush
}
```

### LRU Algorithm — Quản lý bộ nhớ

InnoDB dùng biến thể LRU (Least Recently Used) gọi là **Midpoint Insertion Strategy**:

```d2 title="Buffer Pool midpoint insertion"
direction: right
new_pages: Page mới đọc vào
lru: Buffer Pool List {
  recent: "NEW sublist — 5/8\nHEAD: most recent"
  old: "OLD sublist — 3/8\nTAIL: evict first"
  recent -> old: thứ tự LRU
}
new_pages -> lru.old: midpoint insertion
```

- Page mới load vào được đặt ở **midpoint** (đầu OLD sublist).
- Nếu page được truy cập lại → di chuyển lên **NEW sublist**.
- Tránh full scan (table scan lớn) đẩy hot pages ra ngoài.

### Sizing Buffer Pool

```sql
-- Kiểm tra kích thước hiện tại
SHOW VARIABLES LIKE 'innodb_buffer_pool_size';

-- Khuyến nghị: 70-80% RAM available cho dedicated MySQL server
-- Ví dụ server 16GB RAM:
SET GLOBAL innodb_buffer_pool_size = 12884901888; -- 12GB

-- Multiple instances (MySQL 5.7+) để tránh mutex contention
SET GLOBAL innodb_buffer_pool_instances = 8;
```

| Chỉ số | Ý nghĩa | Mục tiêu |
| ------ | ------- | -------- |
| `Innodb_buffer_pool_read_requests` | Tổng số read request | — |
| `Innodb_buffer_pool_reads` | Số lần phải đọc từ disk | Càng nhỏ càng tốt |
| **Hit Rate** | `1 - (reads / read_requests)` | > 99% |

```sql
-- Tính Buffer Pool hit rate
SELECT
  (1 - (Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests)) * 100
  AS hit_rate_pct
FROM information_schema.GLOBAL_STATUS
WHERE Variable_name IN ('Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests');
```

---

## Redo Log

Redo Log đảm bảo **Durability** trong ACID — khi server crash, InnoDB có thể replay Redo Log để khôi phục các transaction đã commit nhưng chưa flush xuống disk.

### Write-Ahead Logging (WAL)

```d2 title="InnoDB commit và flush"
direction: right
n0: "Thay đổi Buffer Pool: dirty page"
n1: "Ghi record vào Redo Log Buffer"
n2: "Flush Redo Log xuống disk theo cấu hình durability"
n3: "Trả success cho client"
n4: "Background flush dirty page xuống tablespace"
n0 -> n1 -> n2 -> n3 -> n4
```

> [!IMPORTANT]
> Bước 3 là **commit point** — sau khi Redo Log flush xuống disk, transaction được coi là committed dù data page chưa xuống disk. Đây là WAL — log trước, data sau.

### innodb_flush_log_at_trx_commit

Đây là setting quan trọng nhất ảnh hưởng đến performance vs durability:

| Giá trị | Flush khi nào | Durability | Performance |
| ------- | ------------- | ---------- | ----------- |
| `1` (default) | Mỗi commit → flush to disk | Tối đa (ACID compliant) | Chậm nhất |
| `2` | Mỗi commit → flush to OS cache; flush to disk mỗi giây | Mất data nếu OS crash | Nhanh hơn |
| `0` | Mỗi giây → flush to disk | Mất data nếu MySQL crash | Nhanh nhất |

```sql
SHOW VARIABLES LIKE 'innodb_flush_log_at_trx_commit';
```

> [!TIP]
> Production: dùng `1`. Nếu chấp nhận mất tối đa 1 giây data (ví dụ analytics DB), dùng `2`.

### Redo Log Rotation

- InnoDB dùng **circular buffer** — có 2 file mặc định: `ib_logfile0`, `ib_logfile1`.
- Khi file đầy → ghi vào file tiếp theo (vòng tròn).
- Nếu Redo Log đầy trước khi checkpoint xong → DB phải dừng ghi, chờ flush → gây stall.

```sql
-- Kiểm tra kích thước Redo Log
SHOW VARIABLES LIKE 'innodb_log_file_size';
SHOW VARIABLES LIKE 'innodb_log_files_in_group';

-- Xem tốc độ ghi log
SHOW STATUS LIKE 'Innodb_os_log_written';
```

---

## Undo Log

Undo Log phục vụ 2 mục đích:

1. **Rollback transaction** — lưu "ảnh cũ" để hoàn tác khi ROLLBACK.
2. **MVCC** — cung cấp snapshot cũ cho các transaction đang đọc (đọc consistent view mà không block write).

### Cơ chế

```d2 title="Undo phục vụ rollback và snapshot read"
direction: down
update: "UPDATE users SET name='Bob' WHERE id=1"
old: "Trước ghi: lưu undo id=1, Alice,\ntxn_id=100"
current: "Buffer Pool: id=1, Bob, txn_id=101"
rollback: "ROLLBACK: đọc undo và khôi phục Alice"
commit: "COMMIT: phiên bản cũ còn phục vụ snapshot\nkhi cần"
purge: "Purge thread dọn undo khi không còn cần"
update -> old
old -> current
current -> rollback: "Rollback"
current -> commit: "Commit"
commit -> purge
```

### Undo Log & Long-running Transactions

Transaction chạy lâu = Undo Log không được purge = **Undo Tablespace phình to**.

```sql
-- Kiểm tra các transaction đang chạy lâu
SELECT
  trx_id,
  trx_started,
  TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_sec,
  trx_query
FROM information_schema.INNODB_TRX
ORDER BY duration_sec DESC;
```

> [!IMPORTANT]
> Transaction chạy > vài phút trên bảng có write cao → Undo Log tích lũy lớn → disk usage tăng + purge lag → ảnh hưởng toàn bộ hiệu năng DB. Luôn giữ transaction ngắn.

---

## Tablespace & Storage

InnoDB tổ chức storage theo hierarchy:

```d2 title="Các đơn vị lưu trữ InnoDB"
direction: down
n0: "Tablespace .ibd"
n1: "Segment: leaf và non-leaf segment của table"
n2: "Extent: 1 MB = 64 pages"
n3: "Page: mặc định 16 KB, đơn vị I/O"
n4: "Row data"
n0 -> n1 -> n2 -> n3 -> n4
```

### System Tablespace vs File-per-Table

| | System Tablespace (`ibdata1`) | File-per-Table (`.ibd`) |
| - | ----------------------------- | ----------------------- |
| Mặc định | MySQL < 5.6 | MySQL ≥ 5.6 (innodb_file_per_table=ON) |
| Vị trí | 1 file dùng chung | 1 file `.ibd` per table |
| Quản lý | Khó thu hồi không gian | Dễ: DROP TABLE xóa file |
| Performance | Tương đương | Tương đương |

```sql
-- Kiểm tra setting
SHOW VARIABLES LIKE 'innodb_file_per_table';

-- Xem kích thước các tablespace
SELECT
  table_schema,
  table_name,
  ROUND(data_length / 1024 / 1024, 2) AS data_mb,
  ROUND(index_length / 1024 / 1024, 2) AS index_mb
FROM information_schema.TABLES
WHERE engine = 'InnoDB'
ORDER BY data_mb + index_mb DESC
LIMIT 20;
```

---

## Row Format

InnoDB có 4 row format, ảnh hưởng đến cách lưu trữ và khả năng nén:

| Format | Mặc định từ | Đặc điểm |
| ------ | ----------- | --------- |
| `REDUNDANT` | MySQL < 5.0 | Format cũ, lưu full column info — tốn space |
| `COMPACT` | MySQL 5.0 | Tiết kiệm ~20% so với REDUNDANT |
| `DYNAMIC` | MySQL 5.7 (default hiện tại) | Tối ưu cho BLOB/TEXT — lưu off-page |
| `COMPRESSED` | MySQL 5.1 | Nén dữ liệu — tiết kiệm disk, tốn CPU |

```sql
-- Kiểm tra row format của bảng
SELECT table_name, row_format
FROM information_schema.TABLES
WHERE table_schema = 'your_db';

-- Tạo bảng với row format cụ thể
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  data JSON
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC;
```

### Off-page Storage (DYNAMIC/COMPRESSED)

Với DYNAMIC format, cột BLOB/TEXT lớn được lưu **off-page**:
- Trong row chính: chỉ lưu **20-byte pointer** đến off-page data.
- Trang off-page riêng chứa dữ liệu thực.
- Giúp mỗi page chứa nhiều row hơn → giảm I/O cho query không cần cột BLOB.

---

## MVCC trong InnoDB

InnoDB implement MVCC qua **hidden columns** và **Undo Log**:

### Hidden Columns

Mỗi row trong InnoDB có 3 hidden column ẩn:

| Column | Kích thước | Vai trò |
| ------ | ---------- | ------- |
| `DB_TRX_ID` | 6 bytes | Transaction ID ghi lần cuối vào row này |
| `DB_ROLL_PTR` | 7 bytes | Pointer đến Undo Log record (ảnh cũ của row) |
| `DB_ROW_ID` | 6 bytes | Auto-increment row ID nếu không có PK |

### Read View

Khi transaction bắt đầu đọc (với `REPEATABLE READ`), InnoDB tạo **Read View**:

```d2 title="Read View quyết định visibility theo transaction ID"
direction: down
row: Row có DB_TRX_ID = X
old: X < up_limit_id? { shape: diamond }
visible: Visible theo Read View trong mô hình đang xét
future: X ≥ low_limit_id? { shape: diamond }
in_list: X nằm trong trx_id_list? { shape: diamond }
undo: Không visible — tìm version cũ trong undo
row -> old
old -> visible: Có
old -> future: Không
future -> undo: Có
future -> in_list: Không
in_list -> undo: Có — active lúc tạo view
in_list -> visible: Không — đã commit
```

`trx_id_list` là tập transaction đang active khi tạo view; `up_limit_id` là min active transaction ID, còn `low_limit_id` là mốc transaction ID tiếp theo. Transaction tạo Read View còn có quy tắc nhìn thấy thay đổi của chính nó; ID lớn hơn mốc không đồng nghĩa transaction ấy đã commit.

Chi tiết hơn: xem [`mvcc.md`](/docs/fundamentals/mvcc).

---

## Tóm tắt

| Component | Vai trò chính | Liên quan đến |
| --------- | ------------- | ------------- |
| **Buffer Pool** | Cache data/index pages trong RAM | Read performance |
| **Redo Log** | Đảm bảo Durability sau crash | D trong ACID |
| **Undo Log** | Rollback + MVCC snapshot | A trong ACID, MVCC |
| **Tablespace** | Tổ chức file lưu trữ trên disk | Storage management |
| **Row Format** | Cách encode dữ liệu trong page | Space efficiency |
| **MVCC** | Concurrent read-write không block | Isolation, performance |

> [!TIP]
> Ba thứ quan trọng nhất cần hiểu khi optimize MySQL InnoDB: **Buffer Pool size**, **innodb_flush_log_at_trx_commit**, và **tránh long-running transactions**.
