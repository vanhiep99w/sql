---
title: "MySQL vs PostgreSQL"
description: "So sánh chi tiết MySQL và PostgreSQL — MVCC, JSON, Performance, Replication, Use Cases"
---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Kiến trúc Storage](#kiến-trúc-storage)
- [MVCC](#mvcc)
- [Hỗ trợ JSON](#hỗ-trợ-json)
- [Data Types](#data-types)
- [Replication](#replication)
- [Concurrency & Locking](#concurrency--locking)
- [Performance](#performance)
- [Maintenance](#maintenance)
- [Extension Ecosystem](#extension-ecosystem)
- [Khi nào chọn MySQL, khi nào PostgreSQL](#khi-nào-chọn-mysql-khi-nào-postgresql)
- [Bảng tổng kết](#bảng-tổng-kết)

---

## Tổng quan

| Tiêu chí | MySQL | PostgreSQL |
|----------|-------|------------|
| **Ra đời** | 1995 | 1996 (từ dự án Ingres, Berkeley) |
| **Triết lý** | Đơn giản, nhanh, dễ dùng | Đúng chuẩn SQL, mở rộng mạnh |
| **License** | GPL (Oracle sở hữu) | PostgreSQL License (hoàn toàn tự do) |
| **Storage Engine** | Pluggable (InnoDB, MyISAM, Memory...) | Một engine duy nhất (heap-based) |
| **Cộng đồng** | Rất lớn, phổ biến trong web | Đang tăng mạnh, ưa chuộng trong enterprise |

### Triết lý thiết kế

- **MySQL**: ưu tiên tốc độ và đơn giản. Phù hợp ứng dụng web, CRUD cơ bản, startup cần triển khai nhanh.
- **PostgreSQL**: ưu tiên tính đúng đắn (correctness) và tuân thủ chuẩn SQL. Phù hợp hệ thống phức tạp, data integrity quan trọng.

## Kiến trúc Storage

### MySQL InnoDB

```
┌─────────────────────────────────────────────────┐
│                  MySQL InnoDB                   │
├─────────────────────────────────────────────────┤
│                                                 │
│   ┌──────────────────────────────────────────┐  │
│   │           Buffer Pool (RAM)              │  │
│   │  ┌──────────┐ ┌───────────┐ ┌──────────┐ │  │
│   │  │Data Pages│ │Index Pages│ │Undo Logs │ │  │
│   │  └──────────┘ └───────────┘ └──────────┘ │  │
│   └──────────────────────────────────────────┘  │
│                      │                          │
│   ┌─────────────┐    │   ┌─────────────────┐    │
│   │  Redo Log   │    │   │   Undo Log      │    │
│   │ (WAL)       │    │   │ (MVCC versions) │    │
│   └─────────────┘    │   └─────────────────┘    │
│                      ▼                          │
│   ┌──────────────────────────────────────────┐  │
│   │         Tablespace (.ibd files)          │  │
│   │   Data + Clustered Index (B+Tree)        │  │
│   └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

- **Clustered Index**: dữ liệu được lưu theo thứ tự Primary Key trong B+Tree.
- **Undo Log**: lưu phiên bản cũ của row khi UPDATE/DELETE — phục vụ MVCC.
- **Buffer Pool**: cache data pages và index pages trong RAM.

### PostgreSQL

```
┌─────────────────────────────────────────────────┐
│                 PostgreSQL                      │
├─────────────────────────────────────────────────┤
│                                                 │
│   ┌──────────────────────────────────────────┐  │
│   │          Shared Buffers (RAM)            │  │
│   │  ┌──────────┐ ┌───────────┐ ┌──────────┐ │  │
│   │  │Data Pages│ │Index Pages│ │  CLOG    │ │  │
│   │  └──────────┘ └───────────┘ └──────────┘ │  │
│   └──────────────────────────────────────────┘  │
│                      │                          │
│   ┌─────────────┐    │   ┌─────────────────┐    │
│   │    WAL      │    │   │ Visibility Map  │    │
│   │ (Write-     │    │   │ Free Space Map  │    │
│   │  Ahead Log) │    │   └─────────────────┘    │
│   └─────────────┘    │                          │
│                      ▼                          │
│   ┌──────────────────────────────────────────┐  │
│   │              Heap Files                  │  │
│   │   Row versions (live + dead) trong heap  │  │
│   │   Index là cấu trúc riêng biệt           │  │
│   └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

- **Heap-based**: dữ liệu lưu không theo thứ tự, index trỏ đến vị trí trong heap.
- **MVCC in-place**: row cũ nằm ngay trong heap → tạo dead tuples → cần VACUUM.
- **WAL**: đảm bảo durability, hỗ trợ replication.

| Tiêu chí | MySQL InnoDB | PostgreSQL |
|----------|-------------|------------|
| Tổ chức dữ liệu | Clustered Index (B+Tree) | Heap (không sắp xếp) |
| Nơi lưu row cũ | Undo Log (riêng biệt) | Trong heap (cùng table) |
| Primary Key | Bắt buộc (tạo ẩn nếu không khai báo) | Không bắt buộc |
| Table bloat | Không (undo log tự cleanup) | Có, cần VACUUM |

## MVCC

Cả hai đều dùng MVCC nhưng cách triển khai khác nhau cơ bản:

| Tiêu chí | MySQL InnoDB | PostgreSQL |
|----------|-------------|------------|
| Nơi lưu row cũ | Undo Log | Heap (ngay trong table) |
| Table chứa nhiều phiên bản? | ❌ Không | ✔ Có |
| Cần VACUUM? | ❌ Không | ✔ Có |
| Cleanup cơ chế | Purge Thread tự động | VACUUM / AUTOVACUUM |
| Rollback | Đọc từ undo log để khôi phục | Row cũ vẫn nằm trong heap |
| Read consistency | Đọc undo log nếu cần snapshot cũ | Kiểm tra xmin/xmax visibility |

> [!NOTE]
> Xem chi tiết tại [MVCC — Multi-Version Concurrency Control](/fundamentals/mvcc/).

## Hỗ trợ JSON

PostgreSQL hỗ trợ JSON/JSONB mạnh hơn MySQL đáng kể:

| Tính năng | MySQL | PostgreSQL |
|-----------|-------|------------|
| **Kiểu dữ liệu** | `JSON` (lưu text, validate khi insert) | `JSON` + `JSONB` (binary, nhanh hơn) |
| **Index trên JSON** | Generated columns + B-Tree | GIN index trực tiếp trên JSONB |
| **Truy vấn** | `->`, `->>`, `JSON_EXTRACT()` | `->`, `->>`, `@>`, `?`, `?&`, `?\|`, `#>` |
| **Partial match** | Hạn chế | `@>` containment operator rất mạnh |
| **Full-text search trên JSON** | Không | Có (GIN + tsvector) |
| **Modify JSON** | `JSON_SET()`, `JSON_REPLACE()` | `jsonb_set()`, `\|\|` merge, `-` delete key |
| **Performance** | Chậm hơn (parse mỗi lần query) | JSONB nhanh hơn (binary storage) |

### Ví dụ so sánh

```sql
-- MySQL: Query JSON
SELECT * FROM users WHERE JSON_EXTRACT(profile, '$.city') = 'Hanoi';
-- Hoặc
SELECT * FROM users WHERE profile->>'$.city' = 'Hanoi';

-- PostgreSQL: Query JSONB (nhanh hơn với GIN index)
CREATE INDEX idx_profile ON users USING GIN (profile);
SELECT * FROM users WHERE profile @> '{"city": "Hanoi"}';
SELECT * FROM users WHERE profile->>'city' = 'Hanoi';
```

## Data Types

PostgreSQL hỗ trợ nhiều kiểu dữ liệu phong phú hơn:

| Kiểu dữ liệu | MySQL | PostgreSQL |
|--------------|-------|------------|
| **ARRAY** | ❌ Không | ✅ `INTEGER[]`, `TEXT[]` |
| **HSTORE** | ❌ Không | ✅ Key-value pairs |
| **Range Types** | ❌ Không | ✅ `int4range`, `tsrange`, `daterange` |
| **Composite Types** | ❌ Không | ✅ Custom row types |
| **ENUM** | ✅ Có (cột level) | ✅ Có (type level, linh hoạt hơn) |
| **UUID** | ✅ `CHAR(36)` hoặc `BINARY(16)` | ✅ Native `UUID` type |
| **Network** | ❌ Không | ✅ `INET`, `CIDR`, `MACADDR` |
| **Geometric** | ❌ Cơ bản | ✅ `POINT`, `LINE`, `POLYGON`, `CIRCLE` |
| **Vector** | ❌ Không (cần plugin) | ✅ `pgvector` extension |

## Replication

| Tiêu chí | MySQL | PostgreSQL |
|----------|-------|------------|
| **Physical Replication** | Binary Log Replication | Streaming Replication (WAL) |
| **Logical Replication** | ✅ Binlog-based | ✅ Logical Replication (PG 10+) |
| **Multi-master** | Group Replication, InnoDB Cluster | BDR (thương mại), Citus |
| **Failover** | MySQL Router, ProxySQL | Patroni, pg_auto_failover |
| **Setup dễ dàng** | ⭐ Dễ hơn | ⚠️ Phức tạp hơn |

### MySQL Replication

```sql
-- Master-Slave cơ bản
-- Master:
CHANGE MASTER TO
  MASTER_HOST='master_ip',
  MASTER_USER='repl_user',
  MASTER_PASSWORD='password',
  MASTER_LOG_FILE='mysql-bin.000001',
  MASTER_LOG_POS=0;
START SLAVE;
```

### PostgreSQL Streaming Replication

```bash
# postgresql.conf (Primary)
wal_level = replica
max_wal_senders = 10

# pg_hba.conf (Primary)
host replication repl_user standby_ip/32 md5

# Standby: clone từ primary
pg_basebackup -h primary_ip -D /var/lib/postgresql/data -U repl_user -P -R
```

## Concurrency & Locking

| Tiêu chí | MySQL InnoDB | PostgreSQL |
|----------|-------------|------------|
| **Row-level locking** | ✅ Có | ✅ Có |
| **Gap locking** | ✅ Có (ngăn phantom reads) | ❌ Không (dùng SSI thay thế) |
| **Advisory locks** | ✅ `GET_LOCK()` | ✅ `pg_advisory_lock()` |
| **Deadlock detection** | Tự động, rollback transaction nhỏ nhất | Tự động, rollback transaction gây deadlock |
| **SELECT FOR UPDATE** | ✅ Có | ✅ Có + `SKIP LOCKED`, `NOWAIT` |
| **Serializable** | Dùng gap locks | Dùng SSI (Serializable Snapshot Isolation) |

> [!IMPORTANT]
> PostgreSQL dùng **SSI** cho Serializable — không cần gap lock, hiệu năng tốt hơn MySQL ở mức isolation cao nhất.

## Performance

| Workload | MySQL | PostgreSQL | Ghi chú |
|----------|-------|------------|---------|
| **Simple CRUD** | ⭐⭐ Nhanh hơn | ⭐ | MySQL tối ưu hơn cho read đơn giản |
| **Write-heavy OLTP** | ⭐⭐ Tốt | ⭐ Trung bình | MySQL không bị bloat, undo log hiệu quả |
| **Complex queries** | ⭐ | ⭐⭐ Mạnh hơn | PostgreSQL có query planner tốt hơn |
| **OLAP / Analytics** | ⭐ | ⭐⭐ | CTE, Window Functions, Parallel Query |
| **JSON workload** | ⭐ | ⭐⭐ Mạnh hơn nhiều | JSONB + GIN index |
| **Full-text search** | ⭐ Cơ bản | ⭐⭐ Mạnh | tsvector, GIN, pg_trgm |
| **Geospatial** | ⭐ Hạn chế | ⭐⭐ PostGIS | PostGIS là tiêu chuẩn industry |

## Maintenance

| Tiêu chí | MySQL | PostgreSQL |
|----------|-------|------------|
| **Table bloat** | Không xảy ra | Xảy ra, cần VACUUM |
| **Cleanup tự động** | Purge thread (tự động) | AUTOVACUUM (cần tune) |
| **Rebuild table** | `OPTIMIZE TABLE` | `VACUUM FULL` (khóa bảng) |
| **Statistics update** | `ANALYZE TABLE` | `ANALYZE` (hoặc AUTOVACUUM) |
| **Phức tạp vận hành** | ⭐ Đơn giản hơn | ⚠️ Cần hiểu VACUUM, bloat |
| **Transaction ID Wraparound** | Không có vấn đề | Cần monitor (VACUUM ngăn) |

> [!TIP]
> Xem chi tiết tại [PostgreSQL VACUUM](/postgresql/vacuum/).

## Extension Ecosystem

PostgreSQL có hệ sinh thái extension phong phú hơn nhiều:

| Extension | Chức năng | MySQL tương đương |
|-----------|----------|-------------------|
| **PostGIS** | Geospatial queries, GIS | Spatial functions (rất hạn chế) |
| **pgvector** | Vector similarity search (AI/ML) | Không có native |
| **pg_trgm** | Fuzzy text search, trigram matching | Không có |
| **TimescaleDB** | Time-series database | Không có |
| **Citus** | Distributed PostgreSQL, sharding | MySQL Cluster, Vitess |
| **pg_stat_statements** | Query performance monitoring | Performance Schema |
| **pgcrypto** | Encryption functions | Built-in encryption |
| **hstore** | Key-value storage | Không có |
| **ltree** | Hierarchical data | Không có native |

## Khi nào chọn MySQL, khi nào PostgreSQL

### Chọn MySQL khi:

- Ứng dụng web đơn giản, CRUD-heavy
- Team quen thuộc MySQL, cần triển khai nhanh
- Write-heavy workload (không lo bloat)
- Cần replication đơn giản (Master-Slave)
- Hosting/cloud support rộng rãi (AWS RDS, PlanetScale, etc.)
- Không cần kiểu dữ liệu phức tạp

### Chọn PostgreSQL khi:

- Cần JSON/JSONB phức tạp
- Query phức tạp (CTE, Window Functions, Lateral Join)
- Geospatial data (PostGIS)
- Vector search cho AI/ML (pgvector)
- Cần data integrity nghiêm ngặt
- Extension ecosystem phong phú
- Chuẩn SQL compliance quan trọng

## Bảng tổng kết

| Tiêu chí | MySQL | PostgreSQL | Thắng |
|----------|-------|------------|-------|
| Dễ sử dụng | ⭐⭐⭐ | ⭐⭐ | MySQL |
| SQL compliance | ⭐⭐ | ⭐⭐⭐ | PostgreSQL |
| JSON support | ⭐ | ⭐⭐⭐ | PostgreSQL |
| Data types | ⭐⭐ | ⭐⭐⭐ | PostgreSQL |
| Write performance | ⭐⭐⭐ | ⭐⭐ | MySQL |
| Complex queries | ⭐⭐ | ⭐⭐⭐ | PostgreSQL |
| Replication setup | ⭐⭐⭐ | ⭐⭐ | MySQL |
| Extensions | ⭐ | ⭐⭐⭐ | PostgreSQL |
| Maintenance | ⭐⭐⭐ | ⭐⭐ | MySQL |
| Geospatial | ⭐ | ⭐⭐⭐ | PostgreSQL |
| Community | ⭐⭐⭐ | ⭐⭐⭐ | Hòa |
| **Tổng** | **22** | **28** | **PostgreSQL** |

> [!NOTE]
> Không có database nào "tốt hơn" tuyệt đối — lựa chọn phụ thuộc vào use case, team experience, và yêu cầu cụ thể của dự án.
