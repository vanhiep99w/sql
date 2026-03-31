---
title: "Oracle Database Architecture"
description: "Kiến trúc Oracle Database — SGA, PGA, Background Processes, Tablespace và cách Oracle quản lý bộ nhớ, storage"
---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Kiến trúc tổng thể](#kiến-trúc-tổng-thể)
- [Memory Structures](#memory-structures)
- [Background Processes](#background-processes)
- [Storage Structures](#storage-structures)
- [Redo Log & Archiving](#redo-log--archiving)
- [Undo Management](#undo-management)
- [So sánh với PostgreSQL & MySQL](#so-sánh-với-postgresql--mysql)
- [Tóm tắt](#tóm-tắt)

---

## Tổng quan

Oracle Database Instance = **Memory (SGA + PGA) + Background Processes**. Database = **tập hợp files trên disk** (datafiles, control files, redo logs).

```
Instance ≠ Database
- 1 Instance có thể mount 1 Database (cấu hình thông thường)
- Nhiều Instance mount 1 Database (Oracle RAC — Real Application Clusters)
```

Oracle phân biệt rõ ràng giữa Instance (đang chạy trong memory) và Database (files trên disk) — khác MySQL/PostgreSQL gộp chung.

---

## Kiến trúc tổng thể

```
┌──────────────────────────────────────────────────────────────────┐
│                        Oracle Instance                           │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              System Global Area (SGA)                       │ │
│  │                                                             │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │ │
│  │  │  DB Buffer   │  │   Shared     │  │  Redo Log Buffer │   │ │
│  │  │   Cache      │  │    Pool      │  │                  │   │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │ │
│  │  ┌──────────────┐  ┌──────────────┐                         │ │
│  │  │  Large Pool  │  │  Java Pool   │                         │ │
│  │  └──────────────┘  └──────────────┘                         │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Program Global Area (PGA)                      │ │
│  │  (Per-session: sort area, hash area, session info)          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Background Processes: DBWn, LGWR, CKPT, SMON, PMON, ARCn...     │
└──────────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────────────┐
│                        Oracle Database                           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │  Datafiles   │  │ Control File │  │  Redo Log    │            │
│  │  (.dbf)      │  │              │  │  Files       │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
│  ┌──────────────┐                                                │
│  │  Archive Log │                                                │
│  │  Files       │                                                │
│  └──────────────┘                                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Memory Structures

### System Global Area (SGA)

SGA là vùng nhớ dùng chung cho tất cả user session kết nối vào cùng 1 Oracle Instance.

#### Database Buffer Cache

Tương đương **Buffer Pool** của InnoDB — cache data blocks từ datafiles.

```sql
-- Xem kích thước
SHOW PARAMETER db_cache_size;

-- Kiểm tra hit ratio (mục tiêu > 95%)
SELECT
  ROUND(1 - (physical_reads / (db_block_gets + consistent_gets)), 4) * 100
    AS buffer_hit_ratio_pct
FROM v$buffer_pool_statistics;
```

Oracle dùng **LRU + Touch Count** để quản lý cache. Buffers được phân loại:
- **Hot** (default pool): dữ liệu thường xuyên truy cập.
- **KEEP pool**: dữ liệu cần giữ lâu trong cache (bảng nhỏ, lookup tables).
- **RECYCLE pool**: dữ liệu ít dùng, được recycle nhanh.

```sql
-- Chỉ định pool cho bảng
ALTER TABLE lookup_data STORAGE (BUFFER_POOL KEEP);
```

#### Shared Pool

Gồm 2 thành phần chính:

| Thành phần | Vai trò |
| ---------- | ------- |
| **Library Cache** | Cache parsed SQL và PL/SQL (execution plans, compiled code) |
| **Data Dictionary Cache** | Cache metadata: table definitions, column info, privileges |

**Library Cache** giúp Oracle tái sử dụng execution plan mà không cần parse lại — quan trọng cho performance:

```sql
-- Xem hit ratio của Library Cache
SELECT namespace, gets, gethits,
  ROUND(gethits/gets * 100, 2) AS hit_ratio
FROM v$librarycache
WHERE gets > 0;

-- Nếu hit ratio thấp → ứng dụng không dùng bind variables
-- Mỗi câu SQL với literal khác nhau sẽ parse lại (hard parse)
-- Bad: SELECT * FROM users WHERE id = 1
--      SELECT * FROM users WHERE id = 2  (parse riêng)
-- Good: SELECT * FROM users WHERE id = :id  (dùng 1 execution plan)
```

#### Redo Log Buffer

Buffer tạm thời trong RAM cho redo entries trước khi LGWR flush xuống Redo Log files.

```sql
SHOW PARAMETER log_buffer;
-- Thường 8-16MB là đủ; tăng nếu có nhiều "redo log space requests" waits
```

### Program Global Area (PGA)

PGA là vùng nhớ **riêng tư cho từng server process** (mỗi session có PGA riêng):

| Vùng | Chứa gì |
| ---- | ------- |
| **Sort Area** | Dữ liệu sort (ORDER BY, GROUP BY) |
| **Hash Area** | Hash join operations |
| **Bitmap merge area** | Bitmap index operations |
| **Session info** | Bind variables, cursor state |

```sql
-- Oracle tự quản lý PGA (khuyến nghị)
SHOW PARAMETER pga_aggregate_target;

-- Xem PGA sử dụng hiện tại
SELECT * FROM v$pgastat;
```

### Automatic Memory Management (AMM)

Oracle có thể tự điều chỉnh SGA và PGA:

```sql
-- Automatic Shared Memory Management (ASMM)
ALTER SYSTEM SET sga_target = 4G;        -- Oracle tự phân bổ giữa các SGA components
ALTER SYSTEM SET pga_aggregate_target = 1G;

-- Automatic Memory Management (AMM) — quản lý cả SGA + PGA
ALTER SYSTEM SET memory_target = 5G;     -- Oracle tự phân bổ toàn bộ
```

---

## Background Processes

Oracle chạy nhiều background process để xử lý các tác vụ nền. Các process cốt lõi:

### DBWn — Database Writer

Flush **dirty blocks** từ Buffer Cache xuống datafiles.

- `n` = số instances (DBW0, DBW1, ...) — có thể cấu hình nhiều DBWn để tăng throughput.
- Trigger khi: buffer cache đầy, checkpoint, timeout.
- **Không** flush theo từng commit — Oracle dùng WAL (redo log) để đảm bảo durability.

```sql
SHOW PARAMETER db_writer_processes;
```

### LGWR — Log Writer

Flush **Redo Log Buffer** xuống Redo Log files.

Trigger khi:
- Transaction COMMIT
- Redo Log Buffer đầy 1/3
- DBWn cần flush dirty block (phải đảm bảo redo đã xuống disk trước)
- Mỗi 3 giây

> [!IMPORTANT]
> **Commit chỉ hoàn thành sau khi LGWR xác nhận flush thành công**. Đây là đảm bảo Durability của Oracle.

### CKPT — Checkpoint

- Ghi **checkpoint position** vào Control File và Datafile headers.
- Báo cho DBWn biết cần flush dirty buffers.
- Checkpoint position = điểm trong Redo Log mà tất cả dữ liệu trước đó đã được flush → Oracle biết bắt đầu recovery từ đâu sau crash.

### SMON — System Monitor

- **Instance recovery**: khi instance restart sau crash, SMON replay Redo Log để khôi phục committed transactions chưa flush.
- **Space management**: coalesce free extents trong tablespace.
- **Temp segment cleanup**: dọn dẹp temporary segments không dùng.

### PMON — Process Monitor

- Monitor user processes — khi session die (bị kill hoặc disconnect bất thường), PMON cleanup:
  - Rollback uncommitted transactions.
  - Release locks.
  - Free PGA.

### ARCn — Archiver

- Sao chép **Redo Log files đã đầy** sang Archive Log destination (disk hoặc tape).
- Chỉ chạy khi database ở **ARCHIVELOG mode**.
- Cần thiết cho **point-in-time recovery** và **standby database** (Oracle Data Guard).

```sql
-- Kiểm tra mode
SELECT log_mode FROM v$database;

-- Chuyển sang ARCHIVELOG mode
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;
```

---

## Storage Structures

### Hierarchy

```
Tablespace (logical)
└── Segment (logical — 1 object = 1+ segments)
    └── Extent (logical — tập hợp các data blocks liên tiếp)
        └── Data Block (logical — đơn vị I/O của Oracle)
            └── OS Block (physical — 512 bytes hoặc 4KB)
```

| Đơn vị | Kích thước | Mô tả |
| ------ | ---------- | ----- |
| **Data Block** | 2KB, 4KB, **8KB** (default), 16KB, 32KB | Đơn vị I/O nhỏ nhất của Oracle |
| **Extent** | N × Block size | Tập hợp blocks liên tiếp được cấp phát cùng lúc |
| **Segment** | 1+ Extents | Tương ứng với 1 đối tượng: bảng, index, undo segment, temp segment |
| **Tablespace** | 1+ Datafiles | Container logical cho các segments |

### Tablespace Types

| Loại | Vai trò |
| ---- | ------- |
| `SYSTEM` | Data dictionary, system objects — không bao giờ lưu user data ở đây |
| `SYSAUX` | Auxiliary objects (AWR, Enterprise Manager repository) |
| `TEMP` | Temporary segments (sort, hash join) — không persistent |
| `UNDO` | Undo segments (trước v9i gọi là Rollback Segments) |
| `USERS` | Default tablespace cho user data (thường tạo thêm per-app) |

```sql
-- Xem danh sách tablespace
SELECT tablespace_name, status, contents FROM dba_tablespaces;

-- Xem space usage
SELECT
  tablespace_name,
  ROUND(used_space * 8192 / 1024 / 1024, 2) AS used_mb,
  ROUND(tablespace_size * 8192 / 1024 / 1024, 2) AS total_mb,
  ROUND(used_percent, 2) AS used_pct
FROM dba_tablespace_usage_metrics;

-- Tạo tablespace mới
CREATE TABLESPACE app_data
  DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 1G
  AUTOEXTEND ON NEXT 256M MAXSIZE 10G;
```

### Control File

File nhỏ nhưng **cực kỳ quan trọng** — chứa:
- Tên database, DBID.
- Vị trí và trạng thái của tất cả datafiles và redo log files.
- Checkpoint information.
- RMAN backup metadata.

```sql
-- Xem vị trí control files
SHOW PARAMETER control_files;

-- Luôn multiplexing control files (ít nhất 2 copies ở disk khác nhau)
-- my Oracle recomendation: 3 copies
```

---

## Redo Log & Archiving

### Redo Log Groups

Oracle dùng **Redo Log Groups** thay vì file đơn — mỗi group có thể có nhiều **members** (copies):

```
Group 1: /u01/redo/redo01a.log (50MB) — CURRENT (đang ghi)
         /u02/redo/redo01b.log (50MB) — mirror

Group 2: /u01/redo/redo02a.log (50MB) — INACTIVE
         /u02/redo/redo02b.log (50MB) — mirror

Group 3: /u01/redo/redo03a.log (50MB) — ACTIVE (cần trước checkpoint xong)
         /u02/redo/redo03b.log (50MB) — mirror
```

```sql
-- Xem trạng thái redo log groups
SELECT group#, status, archived, bytes/1024/1024 AS mb FROM v$log;

-- Thêm group nếu cần
ALTER DATABASE ADD LOGFILE GROUP 4
  ('/u01/redo/redo04a.log', '/u02/redo/redo04b.log') SIZE 200M;
```

**Log Switch**: khi group hiện tại đầy → switch sang group tiếp theo → trigger checkpoint.

> [!IMPORTANT]
> Nếu tất cả groups đều `ACTIVE` hoặc `CURRENT` và ARCn chưa archive xong → Oracle treo (log switch wait). Giải pháp: thêm groups hoặc tăng size.

### ARCHIVELOG Mode & Point-in-Time Recovery

```sql
-- Backup full database với RMAN
RMAN> BACKUP DATABASE;

-- Point-in-time recovery về thời điểm cụ thể
RMAN> RECOVER DATABASE UNTIL TIME "TO_DATE('2024-06-15 14:30:00', 'YYYY-MM-DD HH24:MI:SS')";
RMAN> RECOVER DATABASE UNTIL SCN 12345678;  -- hoặc theo SCN
```

SCN (System Change Number) = số thứ tự tăng dần cho mỗi commit trong Oracle — tương đương LSN trong PostgreSQL.

---

## Undo Management

Oracle dùng **Undo Tablespace** (Automatic Undo Management — AUM) để quản lý undo:

```sql
-- Xem undo tablespace
SHOW PARAMETER undo_tablespace;
SHOW PARAMETER undo_retention;  -- giây — bao lâu giữ undo sau commit

-- Kiểm tra undo space
SELECT
  tablespace_name,
  status,
  SUM(bytes)/1024/1024 AS mb
FROM dba_undo_extents
GROUP BY tablespace_name, status;
```

### ORA-01555: Snapshot Too Old

Lỗi phổ biến trong Oracle khi:
1. Transaction A bắt đầu query dài.
2. Transaction B thay đổi dữ liệu và commit.
3. Oracle cần undo để tái tạo snapshot cũ cho A.
4. Nhưng undo của B đã bị ghi đè (vì `undo_retention` quá ngắn hoặc undo tablespace nhỏ).

```sql
-- Giải pháp: tăng undo_retention
ALTER SYSTEM SET undo_retention = 3600;  -- 1 giờ

-- Hoặc đảm bảo undo tablespace đủ lớn
ALTER DATABASE DATAFILE '/u01/oradata/undo01.dbf' AUTOEXTEND ON MAXSIZE 10G;
```

---

## So sánh với PostgreSQL & MySQL

| | Oracle | PostgreSQL | MySQL (InnoDB) |
| - | ------ | ---------- | -------------- |
| Memory architecture | SGA (shared) + PGA (per-session) | Shared Buffers + Work Mem (per-query) | Buffer Pool + per-thread buffers |
| Undo storage | Dedicated Undo Tablespace | Inline trong heap (tuples cũ) | Undo Log trong System Tablespace |
| Redo Log | Online Redo Logs (groups) | WAL files (pg_wal/) | InnoDB Redo Log files |
| Crash recovery | SMON replay redo | Startup replay WAL | InnoDB auto-recovery |
| Background processes | Explicit, named (PMON, SMON, ...) | Background workers | InnoDB threads (DBW, purge, ...) |
| Storage unit | Block (8KB default) | Page (8KB fixed) | Page (16KB fixed) |
| Tablespace | Logical container, maps to datafiles | Directory-based | Datafile per table (.ibd) |
| Multi-instance | Oracle RAC | — (dùng Patroni/Citus) | — (dùng Galera/Group Replication) |

---

## Tóm tắt

| Component | Vai trò |
| --------- | ------- |
| **SGA — Buffer Cache** | Cache data blocks, giảm disk I/O |
| **SGA — Shared Pool** | Cache execution plans và metadata |
| **PGA** | Per-session: sort, hash join, session state |
| **DBWn** | Flush dirty blocks xuống disk (background) |
| **LGWR** | Flush redo xuống disk khi commit |
| **SMON** | Instance recovery + space management |
| **PMON** | Cleanup dead sessions |
| **ARCn** | Archive redo logs (chỉ trong ARCHIVELOG mode) |
| **Tablespace** | Logical storage container |
| **Control File** | Catalog của database — backup luôn |
| **Redo Log Groups** | Write-ahead log với mirroring |
| **Undo Tablespace** | MVCC snapshot + rollback |

> [!TIP]
> Các view quan trọng để monitor Oracle: `v$session`, `v$sql`, `v$buffer_pool_statistics`, `v$log`, `v$pgastat`, `dba_tablespace_usage_metrics`. Tất cả đều truy vấn bằng SQL thông thường.
