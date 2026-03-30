---
title: "MySQL Replication"
description: "MySQL Replication — Binary Log, Source-Replica setup, GTID, semi-sync và các topology phổ biến"
---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Binary Log](#binary-log)
- [Cơ chế Replication](#cơ-chế-replication)
- [Replication Formats](#replication-formats)
- [GTID Replication](#gtid-replication)
- [Replication Topologies](#replication-topologies)
- [Synchronous vs Asynchronous](#synchronous-vs-asynchronous)
- [Replication Lag](#replication-lag)
- [Monitoring](#monitoring)
- [Tóm tắt](#tóm-tắt)

---

## Tổng quan

MySQL Replication cho phép sao chép dữ liệu từ một server (**Source**, hay còn gọi là Master) sang một hoặc nhiều server khác (**Replica**, hay Slave). Đây là nền tảng cho:

- **High Availability** — Replica sẵn sàng thay thế Source khi Source fail.
- **Read Scaling** — phân tải read query sang Replica.
- **Backup** — backup từ Replica không ảnh hưởng Source.
- **Analytics** — chạy heavy query trên Replica riêng, tránh ảnh hưởng production.

---

## Binary Log

Binary Log (binlog) là file ghi lại tất cả thay đổi dữ liệu trên MySQL — **nền tảng của replication và point-in-time recovery**.

### Bật Binary Log

```sql
-- my.cnf / my.ini
[mysqld]
log_bin = /var/log/mysql/mysql-bin.log
server_id = 1              -- mỗi server phải có ID duy nhất
binlog_expire_logs_seconds = 604800  -- tự xóa sau 7 ngày
max_binlog_size = 100M
```

### Xem nội dung Binary Log

```bash
# List các binlog files
mysqlbinlog --list-events /var/log/mysql/mysql-bin.000001

# Đọc nội dung
mysqlbinlog /var/log/mysql/mysql-bin.000001

# Đọc từ position cụ thể (dùng cho recovery)
mysqlbinlog --start-position=4 --stop-position=1024 mysql-bin.000001
```

```sql
-- Xem danh sách binlog files trên server
SHOW BINARY LOGS;

-- Xem position hiện tại
SHOW MASTER STATUS;
```

### Binlog Events

Mỗi thay đổi được ghi thành một **event** trong binlog:

| Event Type | Nội dung |
| ---------- | -------- |
| `QUERY_EVENT` | SQL statement (dùng trong Statement-based) |
| `TABLE_MAP_EVENT` | Mapping table ID → tên bảng |
| `WRITE_ROWS_EVENT` | INSERT rows (dùng trong Row-based) |
| `UPDATE_ROWS_EVENT` | UPDATE rows (trước + sau) |
| `DELETE_ROWS_EVENT` | DELETE rows |
| `GTID_EVENT` | GTID cho transaction |
| `ROTATE_EVENT` | Khi chuyển sang file binlog mới |

---

## Cơ chế Replication

```
SOURCE (Master)                    REPLICA (Slave)
─────────────────                  ────────────────────────────
  Transaction                        IO Thread
  ↓                                  ↓
  Commit                             Connects to Source
  ↓                                  ↓
  Write to Binary Log  ──────────►  Read Binary Log events
                                     ↓
                                     Write to Relay Log
                                     ↓
                                     SQL Thread
                                     ↓
                                     Execute events from Relay Log
                                     ↓
                                     Apply to Replica DB
```

### 3 Thread tham gia replication

| Thread | Chạy trên | Vai trò |
| ------ | --------- | ------- |
| **Binlog Dump Thread** | Source | Gửi binlog events cho Replica khi được yêu cầu |
| **IO Thread** | Replica | Kết nối Source, nhận events, ghi vào Relay Log |
| **SQL Thread** | Replica | Đọc Relay Log, thực thi events lên local DB |

### Setup cơ bản

**Trên Source:**
```sql
-- Tạo user cho replication
CREATE USER 'replicator'@'replica_ip' IDENTIFIED BY 'password';
GRANT REPLICATION SLAVE ON *.* TO 'replicator'@'replica_ip';

-- Lấy binlog position hiện tại
FLUSH TABLES WITH READ LOCK;
SHOW MASTER STATUS;
-- Ghi lại File và Position
UNLOCK TABLES;
```

**Trên Replica:**
```sql
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = 'source_ip',
  SOURCE_USER = 'replicator',
  SOURCE_PASSWORD = 'password',
  SOURCE_LOG_FILE = 'mysql-bin.000001',  -- từ SHOW MASTER STATUS
  SOURCE_LOG_POS = 4;                    -- từ SHOW MASTER STATUS

START REPLICA;
SHOW REPLICA STATUS\G
```

---

## Replication Formats

Binary Log có 3 format ảnh hưởng đến cách events được ghi:

### Statement-Based Replication (SBR)

- Ghi **SQL statement** vào binlog.
- Replica replay đúng câu SQL đó.

```sql
-- Binlog ghi:
UPDATE users SET updated_at = NOW() WHERE id = 1;

-- Vấn đề: NOW() trả về giá trị khác nhau trên Source và Replica
-- → Dữ liệu không nhất quán!
```

| | SBR |
| - | --- |
| Ưu điểm | Binlog nhỏ, dễ đọc |
| Nhược điểm | Non-deterministic functions (NOW, UUID, RAND) gây inconsistency |

### Row-Based Replication (RBR)

- Ghi **giá trị thực tế** của từng row trước và sau thay đổi.
- An toàn hơn với non-deterministic functions.

```sql
-- Binlog ghi (dạng binary):
-- UPDATE users: row id=1: updated_at: '2024-01-01 10:00:00' → '2024-06-15 14:30:00'
```

| | RBR |
| - | --- |
| Ưu điểm | Chính xác, an toàn, không phụ thuộc SQL semantics |
| Nhược điểm | Binlog lớn hơn (đặc biệt khi UPDATE nhiều row) |

### Mixed Replication

- Mặc định dùng SBR, tự động chuyển sang RBR khi phát hiện non-deterministic.
- Cân bằng giữa binlog size và safety.

```sql
-- Kiểm tra và đặt format
SHOW VARIABLES LIKE 'binlog_format';
SET GLOBAL binlog_format = 'ROW';  -- khuyến nghị cho production
```

> [!TIP]
> **Khuyến nghị:** dùng `ROW` format cho production. Binlog lớn hơn nhưng đảm bảo consistency tuyệt đối.

---

## GTID Replication

GTID (Global Transaction Identifier) là cách định danh transaction duy nhất trên toàn cluster — giúp replication và failover đơn giản hơn nhiều so với binlog file+position.

### Cấu trúc GTID

```
GTID = server_uuid:transaction_id
Ví dụ: 3E11FA47-71CA-11E1-9E33-C80AA9429562:23
```

### Bật GTID

```ini
# my.cnf
[mysqld]
gtid_mode = ON
enforce_gtid_consistency = ON
log_slave_updates = ON   -- Replica cũng ghi binlog (cần cho chaining)
```

### Setup Replica với GTID

```sql
-- Thay vì chỉ định file + position:
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = 'source_ip',
  SOURCE_USER = 'replicator',
  SOURCE_PASSWORD = 'password',
  SOURCE_AUTO_POSITION = 1;   -- GTID tự động xác định vị trí

START REPLICA;
```

### Lợi ích của GTID

| | File+Position | GTID |
| - | ------------- | ---- |
| Failover | Phải tìm đúng binlog file + position mới | Tự động — Replica biết cần transaction nào |
| Consistency check | Khó | Dễ — so sánh GTID sets |
| Replication chains | Phức tạp | Đơn giản |
| Point-in-time recovery | Theo file/pos | Theo GTID |

```sql
-- Xem GTID executed trên server
SHOW VARIABLES LIKE 'gtid_executed';
SHOW REPLICA STATUS\G  -- xem Executed_Gtid_Set và Retrieved_Gtid_Set
```

---

## Replication Topologies

### 1. Single Source — Single Replica

```
[Source] ──► [Replica]
```

Đơn giản nhất. Replica dùng cho read scaling hoặc backup.

### 2. Single Source — Multiple Replicas

```
              ┌──► [Replica 1]  (read queries)
[Source] ─────┼──► [Replica 2]  (analytics)
              └──► [Replica 3]  (backup)
```

Read scale-out. Source là single point of failure.

### 3. Source — Source (Active-Active)

```
[Source 1] ◄──► [Source 2]
```

Cả 2 đều nhận write. Cần xử lý **conflict resolution** — phức tạp, dễ gây data inconsistency. Không khuyến khích trừ khi có sharding theo region.

### 4. Source — Replica với Relay (Chained / Hierarchical)

```
[Source] ──► [Relay Replica] ──► [Replica 1]
                              └──► [Replica 2]
```

Giảm tải cho Source khi có nhiều Replica. Relay Replica phân phối binlog cho các Replica downstream.

### 5. Semi-Sync + Multi-Source (Production Grade)

```
                    ┌──► [Replica 1]
[Source] ──Semi──►──┤
                    └──► [Replica 2]
```

Multi-Source Replication (MySQL 5.7+): 1 Replica nhận dữ liệu từ nhiều Source — dùng cho consolidation.

---

## Synchronous vs Asynchronous

### Asynchronous (mặc định)

```
Client → Source: COMMIT
Source: ghi binlog → trả về OK cho client
Replica: nhận và apply (sau đó, không biết khi nào)
```

- **Ưu:** Latency thấp cho write.
- **Nhược:** Khi Source fail → có thể mất data chưa replicate.

### Semi-Synchronous

```
Client → Source: COMMIT
Source: ghi binlog
Source: chờ ít nhất 1 Replica xác nhận đã nhận (không cần apply)
Source: trả về OK cho client
```

```sql
-- Cài plugin và bật semi-sync
INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
SET GLOBAL rpl_semi_sync_source_enabled = 1;
SET GLOBAL rpl_semi_sync_source_timeout = 1000;  -- ms, sau đó fallback async

-- Trên Replica
INSTALL PLUGIN rpl_semi_sync_replica SONAME 'semisync_replica.so';
SET GLOBAL rpl_semi_sync_replica_enabled = 1;
```

- **Ưu:** Không mất data khi Source crash (ít nhất 1 Replica đã có data).
- **Nhược:** Latency write tăng theo RTT giữa Source và Replica.

### So sánh

| | Async | Semi-Sync | Sync (Group Replication) |
| - | ----- | --------- | ------------------------ |
| Write latency | Thấp nhất | Tăng ~1 RTT | Tăng nhiều |
| Durability | Thấp | Cao | Cao nhất |
| Data loss khi failover | Có thể | Không (ít nhất 1 replica) | Không |
| Phức tạp | Thấp | Trung bình | Cao |

---

## Replication Lag

**Replication lag** = thời gian trễ giữa Source và Replica. Đây là vấn đề phổ biến nhất trong MySQL replication.

### Nguyên nhân

| Nguyên nhân | Giải thích |
| ----------- | ---------- |
| **Single-threaded SQL Thread** | MySQL < 5.6: chỉ 1 SQL thread → bottleneck khi Source ghi nhiều |
| **Large transactions** | 1 transaction lớn (xóa 1M rows) → SQL Thread phải apply xong rồi mới apply tiếp |
| **Network latency** | IO Thread bị chậm khi Source-Replica ở xa nhau |
| **Replica hardware yếu** | CPU/IO kém hơn Source |
| **Lock contention** | Replica đang xử lý read query nặng → SQL Thread chờ lock |

### Parallel Replication (MySQL 5.7+)

```sql
-- Bật multi-threaded replica
SET GLOBAL slave_parallel_type = 'LOGICAL_CLOCK';  -- hoặc DATABASE
SET GLOBAL slave_parallel_workers = 4;             -- số SQL threads

-- my.cnf
slave_parallel_type = LOGICAL_CLOCK
slave_parallel_workers = 4
slave_preserve_commit_order = 1  -- giữ thứ tự commit
```

| Mode | Cơ chế | Khi nào dùng |
| ---- | ------ | ------------ |
| `DATABASE` | Parallel theo database | Multi-database, ít dùng chung |
| `LOGICAL_CLOCK` | Parallel theo binlog commit timestamp | Phổ biến hơn, hiệu quả hơn |

---

## Monitoring

```sql
-- Kiểm tra trạng thái replication trên Replica
SHOW REPLICA STATUS\G

-- Các field quan trọng:
-- Replica_IO_Running: Yes / No
-- Replica_SQL_Running: Yes / No
-- Seconds_Behind_Source: replication lag (giây)
-- Last_Error: lỗi cuối nếu có
-- Executed_Gtid_Set: GTID đã apply
-- Retrieved_Gtid_Set: GTID đã nhận từ Source
```

```sql
-- Performance Schema — lag chi tiết hơn
SELECT * FROM performance_schema.replication_applier_status_by_worker;

-- Xem throughput
SELECT * FROM performance_schema.replication_connection_status;
```

### Alert thresholds

| Chỉ số | Cảnh báo | Critical |
| ------ | -------- | -------- |
| `Seconds_Behind_Source` | > 30s | > 300s |
| `Replica_IO_Running` | — | `No` |
| `Replica_SQL_Running` | — | `No` |
| `Last_Error` | — | Bất kỳ |

---

## Tóm tắt

| Chủ đề | Điểm chính |
| ------ | ---------- |
| **Binary Log** | Ghi lại mọi thay đổi — nền tảng replication và recovery |
| **IO Thread / SQL Thread** | 2 thread độc lập — IO nhận binlog, SQL apply |
| **Row-based format** | An toàn nhất cho production, dùng mặc định |
| **GTID** | Đơn giản hóa failover, khuyến nghị cho cluster mới |
| **Semi-sync** | Tránh mất data khi failover, đánh đổi latency |
| **Parallel Replication** | Giảm lag với `LOGICAL_CLOCK` + nhiều workers |
| **Replication lag** | Monitor `Seconds_Behind_Source`, tuning với parallel replication |

> [!NOTE]
> MySQL Group Replication và InnoDB Cluster (MySQL 8.0+) cung cấp **fully synchronous, multi-primary replication** với automatic failover — phù hợp cho HA requirements cao hơn setup Source-Replica truyền thống.
