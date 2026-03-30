---
title: "PostgreSQL Interview Q&A"
description: "Bộ câu hỏi phỏng vấn PostgreSQL & EnterpriseDB (EPAS) — từ lý thuyết cốt lõi đến tuning, locking, PL/pgSQL và migrate Oracle"
---

## Mục lục

- [Phần 1 — Lý thuyết cốt lõi](#phần-1--lý-thuyết-cốt-lõi)
- [Phần 2 — Function & Stored Procedure](#phần-2--function--stored-procedure)
- [Phần 3 — EnterpriseDB (EPAS) Oracle Compatibility](#phần-3--enterprisedb-epas-oracle-compatibility)
- [Phần 4 — Query Performance Tuning](#phần-4--query-performance-tuning)
- [Phần 5 — Locking & Concurrency](#phần-5--locking--concurrency)
- [Phần 6 — Advanced](#phần-6--advanced)
- [Phần 7 — EPAS Oracle Compat Mode chuyên sâu](#phần-7--epas-oracle-compat-mode-chuyên-sâu)
- [Phần 8 — Coding Test](#phần-8--coding-test)
- [Phần 9 — Tư duy chuyên gia](#phần-9--tư-duy-chuyên-gia)
- [Bonus — Migrate Oracle → PostgreSQL](#bonus--migrate-oracle--postgresql)

---

## Phần 1 — Lý thuyết cốt lõi

**1. PostgreSQL dùng cơ chế transaction gì?**

PostgreSQL dùng **MVCC** (Multi-Version Concurrency Control) để tránh locking khi đọc. MVCC lưu nhiều phiên bản row và sử dụng `xmin`/`xmax` để xác định visibility.

---

**2. VACUUM dùng để làm gì?**

- Dọn dẹp dead tuples.
- Giải phóng không gian nội bộ (`VACUUM FULL` mới trả về OS).
- Ngăn hiện tượng **transaction ID wraparound**.
- Cập nhật visibility map → hỗ trợ index-only scan.

---

**3. Khác biệt giữa VACUUM và ANALYZE?**

| | VACUUM | ANALYZE |
| - | ------ | ------- |
| Dọn dead tuples | ✅ | ❌ |
| Chống bloat | ✅ | ❌ |
| Giảm size file (disk) | VACUUM FULL | ❌ |
| Cập nhật statistics | ❌ | ✅ |
| Giúp planner chọn plan | Gián tiếp | Trực tiếp |
| Giải quyết wraparound | ✅ | ❌ |

---

**4. Autovacuum chạy khi nào?**

Khi số dead tuples vượt ngưỡng:

```
autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples
```

---

**5. Khi nào dùng EXPLAIN, khi nào dùng EXPLAIN ANALYZE?**

- `EXPLAIN` — xem query plan dự đoán (không chạy thật).
- `EXPLAIN ANALYZE` — chạy query thật + hiển thị thời gian thực → dùng để tuning.

---

**6. Sequential Scan vs Index Scan?**

| Loại | Đặc điểm |
| ---- | --------- |
| **Seq Scan** | Đọc toàn bộ bảng — phù hợp bảng nhỏ hoặc filter không selective |
| **Index Scan** | Dùng index để lọc — hiệu quả khi cardinality cao |
| **Bitmap Index Scan** | Dùng khi select nhiều row — batch fetch, gộp nhiều index |

---

**7. Khi nào PostgreSQL không dùng index?**

- Điều kiện không selective (ví dụ `WHERE status = 'active'` khi 90% là active).
- Hàm không `IMMUTABLE` bọc quanh cột.
- So sánh kiểu khác nhau (implicit cast).
- `LIKE '%keyword'` — prefix wildcard không dùng được B-tree (cần GIN/trigram).

---

## Phần 2 — Function & Stored Procedure

**8. Khác biệt giữa FUNCTION và PROCEDURE?**

| | FUNCTION | PROCEDURE |
| - | -------- | --------- |
| Return value | Có | Không |
| COMMIT/ROLLBACK bên trong | Không | Có |
| Dùng trong SELECT | Có | Không |

---

**9. Cách tạo function PL/pgSQL**

```sql
CREATE OR REPLACE FUNCTION add_user(p_name text)
RETURNS int AS $$
DECLARE
  new_id int;
BEGIN
  INSERT INTO users(name) VALUES (p_name) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$ LANGUAGE plpgsql;
```

---

**10. Khác biệt LANGUAGE sql và plpgsql?**

| | `sql` | `plpgsql` |
| - | ----- | --------- |
| Đơn giản, nhanh | ✅ | — |
| IF/LOOP/EXCEPTION | ❌ | ✅ |
| Multi-statement logic | ❌ | ✅ |

---

**11. Exception block**

```sql
BEGIN
  -- code
EXCEPTION WHEN others THEN
  RAISE;
END;
```

---

**12. RAISE NOTICE vs RAISE EXCEPTION?**

- `RAISE NOTICE` — debug/log, không rollback.
- `RAISE EXCEPTION` — throw error + rollback transaction.

---

**13. Immutable / Stable / Volatile?**

| Volatility | Ý nghĩa | Ghi chú |
| ---------- | ------- | ------- |
| `IMMUTABLE` | Cùng input → cùng output mọi lúc | Hash index có thể dùng |
| `STABLE` | Không đổi trong 1 query | Ví dụ `now()` |
| `VOLATILE` | Có thể thay đổi mỗi lần gọi | Mặc định |

---

## Phần 3 — EnterpriseDB (EPAS) Oracle Compatibility

**14. EPAS hỗ trợ package giống Oracle như thế nào?**

EPAS có **Oracle Compatibility Mode**, hỗ trợ:
- `PACKAGE` / `PACKAGE BODY`
- `SYNONYM`
- Oracle-style exception
- `DBMS_*` packages: `DBMS_OUTPUT`, `DBMS_JOB`, `DBMS_LOCK`, ...

---

**15. Tạo package trong EPAS**

```sql
-- Package Specification
CREATE OR REPLACE PACKAGE math_pkg AS
  FUNCTION add(a int, b int) RETURN int;
END math_pkg;
/

-- Package Body
CREATE OR REPLACE PACKAGE BODY math_pkg AS
  FUNCTION add(a int, b int) RETURN int IS
  BEGIN
    RETURN a + b;
  END;
END math_pkg;
/
```

---

**16. EPAS có hỗ trợ PL/SQL không?**

Có — hỗ trợ gần như đầy đủ PL/SQL như Oracle (**~95% compatibility**).

---

**17. Khi nào nên chọn EPAS thay vì PostgreSQL open-source?**

- Hệ thống dùng nhiều PL/SQL Oracle.
- Cần `PACKAGE` / `PACKAGE BODY`.
- Muốn migrate từ Oracle với ít sửa code.
- Cần `DBMS_*` packages.

---

## Phần 4 — Query Performance Tuning

**18. Làm sao biết query bị slow?**

```sql
-- Queries đang chạy
SELECT * FROM pg_stat_activity WHERE state = 'active';

-- Top slow queries
SELECT query, calls, mean_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

Checklist: `EXPLAIN ANALYZE` → check dead tuples → check lock/wait event.

---

**19. Khi nào dùng Partial Index?**

Khi dữ liệu có tính chất phân vùng logic — index chỉ cần cover subset:

```sql
CREATE INDEX idx_active ON orders (status) WHERE status = 'ACTIVE';
```

Nhỏ hơn, nhanh hơn full index khi query luôn có `WHERE status = 'ACTIVE'`.

---

**20. Khi nào dùng GIN index?**

- Full-text search (`tsvector`)
- `JSONB` operators (`@>`, `?`, `?|`)
- Array search (`@>`, `&&`)

---

**21. B-tree index phù hợp cho kiểu dữ liệu nào?**

Equality (`=`), Range (`>`, `<`, `BETWEEN`), và `ORDER BY`. Mặc định cho hầu hết use cases.

---

**22. Vì sao `LIKE '%text%'` không dùng index?**

Prefix wildcard (`%text%`) không dùng được B-tree — cần:

```sql
-- Cài extension
CREATE EXTENSION pg_trgm;

-- Tạo GIN trigram index
CREATE INDEX idx_trgm ON articles USING GIN (title gin_trgm_ops);
```

---

**23. Làm sao biết table đang bị bloat?**

```sql
-- Cài extension
CREATE EXTENSION pgstattuple;

SELECT * FROM pgstattuple('my_table');
-- dead_tuple_percent cao → cần VACUUM
```

Hoặc so sánh `pg_relation_size` vs số live rows × avg row length.

---

**24. Slow query sau migrate Oracle → Postgres, xử lý?**

1. Kiểm tra index đủ chưa.
2. Rewrite query theo cú pháp PostgreSQL.
3. `EXPLAIN ANALYZE` → kiểm tra Hash Join / Nested Loop.
4. Chạy `ANALYZE` — statistics cũ sau import.
5. Kiểm tra `grouping sets`, window functions → cần index phù hợp.

---

**25. Cách tối ưu JOIN lớn?**

- Index trên join keys.
- Dùng Hash Join cho large dataset (tăng `work_mem`).
- Tránh function trong WHERE join: `WHERE f(a.col) = b.col`.
- Tránh implicit cast giữa 2 cột.

---

## Phần 5 — Locking & Concurrency

**26. Các kiểu lock trong PostgreSQL?**

| Loại | Ví dụ |
| ---- | ----- |
| Row-level | `SELECT ... FOR UPDATE`, `FOR SHARE` |
| Table-level | `ACCESS SHARE`, `ROW EXCLUSIVE`, `EXCLUSIVE` |
| Advisory lock | `pg_advisory_lock(key)` |
| WAL locks | Internal |

---

**27. Deadlock xảy ra khi nào?**

Khi 2 transaction chờ lock của nhau theo vòng tròn — PostgreSQL tự detect và kill 1 bên.

---

**28. Làm sao debug deadlock?**

```sql
-- Xem locks đang giữ
SELECT * FROM pg_locks;

-- Xem session đang làm gì
SELECT pid, state, wait_event_type, wait_event, query
FROM pg_stat_activity;
```

Bật logging:

```
deadlock_timeout = 1s
log_lock_waits = on
```

---

**29. Khi nào dùng `SELECT FOR UPDATE`?**

Khi cần lock row để đảm bảo không có transaction khác thay đổi trước khi mình UPDATE:

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
-- kiểm tra balance
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

---

**30. Read Committed vs Repeatable Read?**

| | Read Committed (default) | Repeatable Read |
| - | ------------------------ | --------------- |
| Snapshot | Mới cho mỗi câu SELECT | Cố định suốt transaction |
| Non-repeatable read | Có | Không |
| Phantom read | Có | Không (trong PG) |

---

## Phần 6 — Advanced

**31. WAL trong PostgreSQL là gì?**

**WAL** (Write-Ahead Log):
- Ghi log **trước** khi write data page xuống disk.
- Đảm bảo **Durability** — crash recovery replay WAL.
- Nền tảng của **streaming replication**.

---

**32. Physical vs Logical Replication?**

| | Physical | Logical |
| - | -------- | ------- |
| Đơn vị | Block-level | Row-level |
| Phạm vi | Toàn bộ cluster | Từng bảng/publication |
| Cross-version | Không | Có |
| Filtering | Không | Có |

---

**33. Partitioning trong PostgreSQL hoạt động thế nào?**

Declarative partitioning (PG 10+) — planner tự routing đến partition phù hợp:

```sql
CREATE TABLE orders (id bigint, created_at date, amount numeric)
PARTITION BY RANGE (created_at);

CREATE TABLE orders_2024 PARTITION OF orders
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
```

---

**34. CTE (`WITH`) — lợi ích và rủi ro?**

- Dùng cho logic phức tạp, code dễ đọc.
- **PostgreSQL < 12**: CTE là **optimization fence** → không inline → có thể chậm.
- **PostgreSQL 12+**: CTE được inline mặc định nếu không có `MATERIALIZED`.

```sql
-- Force materialization (optimization fence)
WITH cte AS MATERIALIZED (SELECT ...)
SELECT * FROM cte;

-- Allow inline (default PG12+)
WITH cte AS NOT MATERIALIZED (SELECT ...)
SELECT * FROM cte;
```

---

**35. Materialized View refresh thế nào?**

```sql
-- Block concurrent reads trong lúc refresh
REFRESH MATERIALIZED VIEW mv_name;

-- Non-blocking (cần UNIQUE index trên MV)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_name;
```

---

**36. Full-text search?**

```sql
-- Tạo index
CREATE INDEX idx_fts ON articles USING GIN (to_tsvector('english', body));

-- Query
SELECT * FROM articles
WHERE to_tsvector('english', body) @@ to_tsquery('english', 'postgresql & tuning');
```

---

**37. JSONB index?**

```sql
-- GIN index cho JSONB (hỗ trợ @>, ?, ?|, ?&)
CREATE INDEX idx_json ON logs USING GIN (data jsonb_path_ops);

-- Index path cụ thể
CREATE INDEX idx_json_status ON logs ((data->>'status'));
```

---

## Phần 7 — EPAS Oracle Compat Mode chuyên sâu

**38. EnterpriseDB tương thích Oracle ở điểm nào?**

- `PACKAGE` / `PACKAGE BODY`
- Oracle-style cursor loop
- Oracle exception model
- `SYNONYM`
- `DBMS_OUTPUT`, `DBMS_PIPE`, `DBMS_JOB`
- Oracle `DATE` type, `NUMBER` type
- `DUAL` table

---

**39. Khác biệt EPAS và PostgreSQL thuần?**

EPAS bổ sung:
- PL/SQL compatibility layer (bypass PL/pgSQL cho Oracle code)
- Index Advisor
- SQL Profiler
- Bulk loader nhanh hơn
- Oracle-style objects (package, synonym, ...)
- Security: password policy, SQL firewall

---

**40. Migrate Oracle → EPAS, lỗi thường gặp?**

| Lỗi | Giải thích |
| --- | ---------- |
| Dynamic SQL cần sửa | `EXECUTE IMMEDIATE` có syntax khác đôi chỗ |
| Built-in functions không 1-1 | Một số Oracle functions không có mapping trực tiếp |
| `DATE` Oracle → `TIMESTAMP` | Oracle DATE chứa time, Postgres DATE không |
| Package global variable | Semantics khác — cần test kỹ |

---

## Phần 8 — Coding Test

**47. Function tính tổng số đơn hàng theo user**

```sql
CREATE OR REPLACE FUNCTION total_order(p_user int)
RETURNS int AS $$
DECLARE
  result int;
BEGIN
  SELECT COUNT(*) INTO result FROM orders WHERE user_id = p_user;
  RETURN result;
END;
$$ LANGUAGE plpgsql;
```

---

**48. Procedure update status và commit**

```sql
CREATE PROCEDURE update_status(p_id int)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orders SET status = 'DONE' WHERE id = p_id;
  COMMIT;
END;
$$;
```

---

**50. Tuning query aggregate lớn — 4 bước**

1. Tạo index phù hợp trên các cột GROUP BY / WHERE.
2. Bật parallel query (`max_parallel_workers_per_gather`).
3. Tăng `work_mem` để hash aggregate không spill to disk.
4. Pre-aggregate bằng Materialized View + `REFRESH CONCURRENTLY`.

---

## Phần 9 — Tư duy chuyên gia

**51. Vì sao PostgreSQL chọn Seq Scan dù có index?**

- Planner ước tính `cost(index scan) > cost(seq scan)`.
- Statistics lỗi thời → `ANALYZE` để cập nhật.
- Filter không selective — đọc gần hết bảng dù có index còn tốn I/O hơn seq scan.

---

**52. Ép PostgreSQL dùng index (debug)?**

```sql
-- Chỉ dùng để debug, KHÔNG dùng production
SET enable_seqscan = off;
EXPLAIN ANALYZE SELECT ...;
SET enable_seqscan = on;
```

Production: rewrite query, tạo index phù hợp, chạy `ANALYZE`.

---

**53. Debug slow query trên production?**

```sql
-- 1. Top slow queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;

-- 2. Chi tiết plan với buffer info
EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT TEXT)
SELECT ...;
```

Bật `auto_explain` để tự log slow query plan:

```
shared_preload_libraries = 'auto_explain'
auto_explain.log_min_duration = '1s'
auto_explain.log_analyze = true
auto_explain.log_buffers = true
```

---

**54. Khi nào dùng UNLOGGED TABLE?**

Khi không cần durability (cache table, staging, temp processing) — không ghi WAL → INSERT nhanh hơn đáng kể. Mất data nếu crash.

```sql
CREATE UNLOGGED TABLE staging_data (...);
```

---

**55. Khi nào dùng TEMP table?**

- Dữ liệu tạm thời trong session.
- Kết quả trung gian cho join nhiều bước phức tạp.
- Tự xóa khi session kết thúc.

---

**56. Khi nào dùng Citus / Sharding?**

- Dữ liệu vượt khả năng 1 server (>TB, hàng tỷ row).
- Cần scale write — single Postgres không đủ.

---

**57. Khác biệt ANALYZE và auto_analyze?**

`ANALYZE` chạy thủ công. `autovacuum` daemon chạy `ANALYZE` tự động khi số row thay đổi vượt ngưỡng `autovacuum_analyze_scale_factor`.

---

**58. Vì sao join không dùng index?**

- Dùng function trên cột join: `WHERE f(a.col) = b.col`.
- Implicit cast: `int` join với `bigint`.
- Kiểu dữ liệu mismatch giữa 2 bảng.

---

**59. Khi nào dùng composite index?**

Khi query filter theo nhiều cột theo thứ tự cụ thể:

```sql
-- Query: WHERE status = 'active' AND created_at > '2024-01-01'
CREATE INDEX idx_status_created ON orders (status, created_at);
-- Cột có selectivity cao hơn nên đứng đầu
```

---

**60. Interview case — slow query**

Quy trình chuẩn:

```sql
-- Bước 1: Xem plan
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;

-- Bước 2: Phân tích
-- - Seq Scan trên bảng lớn? → thiếu index
-- - Rows estimated ≠ rows actual? → cần ANALYZE
-- - Hash Batches > 1? → tăng work_mem
-- - Nested Loop với large outer table? → cân nhắc Hash Join

-- Bước 3: Tạo index phù hợp
CREATE INDEX CONCURRENTLY idx_... ON ... (...);

-- Bước 4: Rewrite SQL nếu cần
-- Bước 5: Tuning parameter
SET work_mem = '256MB';
```

---

## Bonus — Migrate Oracle → PostgreSQL

**41. Thay thế Oracle `CONNECT BY` (hierarchical query)**

```sql
-- Oracle:
SELECT id, parent_id, name FROM categories
START WITH parent_id IS NULL
CONNECT BY PRIOR id = parent_id;

-- PostgreSQL:
WITH RECURSIVE tree AS (
  SELECT id, parent_id, name FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.name
  FROM categories c
  JOIN tree t ON c.parent_id = t.id
)
SELECT * FROM tree;
```

---

**42. Oracle `SEQUENCE.NEXTVAL` / `CURRVAL` → Postgres**

```sql
-- Oracle: seq_name.nextval / seq_name.currval
-- PostgreSQL:
SELECT nextval('seq_name');
SELECT currval('seq_name');
```

---

**43. Oracle `MERGE INTO` → PostgreSQL**

PostgreSQL 15+ hỗ trợ `MERGE` natively. Trước đó dùng `INSERT ... ON CONFLICT`:

```sql
INSERT INTO target (id, value)
VALUES (1, 'new')
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;
```

---

**44–46. Mapping nhanh các hàm Oracle → Postgres**

| Oracle | PostgreSQL |
| ------ | ---------- |
| `NVL(a, b)` | `COALESCE(a, b)` |
| `DECODE(col, v1, r1, v2, r2, default)` | `CASE WHEN col = v1 THEN r1 WHEN col = v2 THEN r2 ELSE default END` |
| `SYSDATE` | `NOW()` hoặc `CURRENT_TIMESTAMP` |
| `ROWNUM` | `ROW_NUMBER() OVER ()` hoặc `LIMIT` |
| Global Temporary Table | `CREATE TEMP TABLE ... ON COMMIT DELETE ROWS` |
| `TO_DATE('...', 'fmt')` | `TO_DATE('...', 'fmt')` (tương tự) |
| `CONNECT BY` | Recursive CTE (`WITH RECURSIVE`) |
