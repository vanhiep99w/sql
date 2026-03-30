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

PostgreSQL dùng **MVCC** (Multi-Version Concurrency Control). Thay vì lock row khi có người đọc (như MySQL InnoDB ở một số trường hợp), MVCC tạo **nhiều phiên bản (version)** của cùng một row.

Cách hoạt động:
- Khi một row được INSERT, PostgreSQL gán **`xmin`** = transaction ID của transaction tạo ra nó.
- Khi row bị UPDATE hoặc DELETE, PostgreSQL gán **`xmax`** = transaction ID của transaction thay đổi nó. Row cũ vẫn tồn tại (dead tuple), row mới được tạo.
- Mỗi transaction chỉ "nhìn thấy" các row mà `xmin` đã committed **trước** thời điểm snapshot của nó, và `xmax` chưa committed hoặc committed **sau** snapshot.

```sql
-- Xem xmin/xmax của row
SELECT xmin, xmax, * FROM users WHERE id = 1;
```

Hệ quả quan trọng: **Reader không bao giờ block Writer và ngược lại** — đây là lý do PostgreSQL xử lý concurrent read/write rất tốt. Tuy nhiên, dead tuples tích tụ theo thời gian → cần VACUUM để dọn dẹp.

---

**2. VACUUM dùng để làm gì?**

Vì MVCC giữ lại các phiên bản row cũ (dead tuples), VACUUM là quá trình **dọn dẹp rác** mà MVCC tạo ra:

- **Dọn dẹp dead tuples** — đánh dấu không gian của row cũ là "có thể tái sử dụng" cho INSERT/UPDATE mới.
- **Giải phóng không gian nội bộ** — `VACUUM` thường chỉ đánh dấu reusable bên trong file, **không trả lại disk cho OS**. Chỉ `VACUUM FULL` mới rewrite toàn bộ table để thu nhỏ file (nhưng sẽ **lock exclusive** toàn bảng).
- **Ngăn transaction ID wraparound** — PostgreSQL dùng 32-bit transaction ID (~4.2 tỷ). Nếu không VACUUM, hệ thống sẽ phải shutdown để tránh mất dữ liệu khi ID quay vòng. VACUUM đánh dấu các row cũ là "frozen" (visible cho mọi transaction) để giải phóng transaction ID.
- **Cập nhật Visibility Map** — đánh dấu các page chỉ chứa row "visible cho tất cả" → giúp **Index-Only Scan** bỏ qua heap fetch, tăng tốc query đáng kể.

```sql
-- VACUUM thường — không lock table, chạy được song song với query
VACUUM orders;

-- VACUUM FULL — lock exclusive, rewrite file, trả disk cho OS
VACUUM FULL orders;

-- VACUUM + ANALYZE cùng lúc
VACUUM ANALYZE orders;
```

---

**3. Khác biệt giữa VACUUM và ANALYZE?**

Hai lệnh này giải quyết **hai vấn đề khác nhau** nhưng thường bị nhầm lẫn:

| Tiêu chí | VACUUM | ANALYZE |
| -------- | ------ | ------- |
| Mục đích chính | Dọn dead tuples, chống bloat | Thu thập statistics cho query planner |
| Dọn dead tuples | ✅ | ❌ |
| Chống table bloat | ✅ | ❌ |
| Giảm file size trên disk | Chỉ `VACUUM FULL` | ❌ |
| Cập nhật `pg_statistic` | ❌ | ✅ (histogram, distinct values, correlation...) |
| Giúp planner chọn plan tốt | Gián tiếp (qua visibility map) | **Trực tiếp** — planner dùng statistics để ước tính cost |
| Giải quyết TX ID wraparound | ✅ | ❌ |
| Có thể chạy cùng lúc? | ✅ `VACUUM ANALYZE table_name;` | ✅ |

> [!TIP]
> Sau khi bulk INSERT/UPDATE/DELETE lượng lớn data, nên chạy `VACUUM ANALYZE` để vừa dọn rác vừa cập nhật statistics cho planner.

---

**4. Autovacuum chạy khi nào?**

PostgreSQL có **autovacuum daemon** chạy nền, tự động trigger VACUUM và ANALYZE khi phát hiện table "bẩn" đủ nhiều. Công thức tính ngưỡng:

```
-- Trigger VACUUM khi:
dead_tuples ≥ autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples

-- Trigger ANALYZE khi:
changed_tuples ≥ autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × reltuples
```

Giá trị mặc định:
- `autovacuum_vacuum_threshold` = 50, `autovacuum_vacuum_scale_factor` = 0.2
- → Bảng 1 triệu row: cần 200.050 dead tuples mới trigger VACUUM

Đối với bảng lớn (hàng chục triệu row), scale factor 20% nghĩa là phải tích tụ **hàng triệu dead tuples** mới chạy → nên giảm `autovacuum_vacuum_scale_factor` cho bảng lớn:

```sql
ALTER TABLE big_orders SET (
  autovacuum_vacuum_scale_factor = 0.01,  -- 1% thay vì 20%
  autovacuum_analyze_scale_factor = 0.005
);
```

---

**5. Khi nào dùng EXPLAIN, khi nào dùng EXPLAIN ANALYZE?**

- **`EXPLAIN`** — chỉ hiển thị **query plan dự đoán** mà planner chọn, không thực sự chạy query. Dùng khi muốn xem plan nhanh mà không ảnh hưởng data (ví dụ query có `DELETE`, `UPDATE`).

- **`EXPLAIN ANALYZE`** — **chạy query thật** + hiển thị thời gian thực tế từng node, số row thực tế vs ước tính. Dùng để tuning vì cho thấy planner ước sai ở đâu.

```sql
-- Chỉ xem plan, không chạy (an toàn cho DELETE/UPDATE)
EXPLAIN SELECT * FROM orders WHERE status = 'ACTIVE';

-- Chạy thật + đo thời gian (KHÔNG dùng với DELETE/UPDATE trừ khi bọc trong transaction rollback)
EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'ACTIVE';

-- Phiên bản đầy đủ nhất — bao gồm buffer hits, I/O, timing
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT * FROM orders WHERE status = 'ACTIVE';
```

> [!IMPORTANT]
> `EXPLAIN ANALYZE` với `DELETE`/`UPDATE` sẽ **thực sự xóa/sửa data**. Nếu cần test, bọc trong `BEGIN; ... ROLLBACK;`.

---

**6. Sequential Scan vs Index Scan?**

PostgreSQL có nhiều chiến lược đọc dữ liệu, planner tự chọn dựa trên cost estimate:

| Loại | Cách hoạt động | Khi nào planner chọn |
| ---- | -------------- | -------------------- |
| **Seq Scan** | Đọc **toàn bộ** table từ đầu đến cuối, lọc row theo điều kiện | Bảng nhỏ, hoặc query trả về **phần lớn** bảng (>5-10%), hoặc không có index phù hợp |
| **Index Scan** | Tra cứu index → lấy pointer tới heap page → fetch row từ heap | Filter có **selectivity cao** (trả về ít row), index phù hợp với điều kiện WHERE |
| **Index-Only Scan** | Chỉ đọc từ index, **không cần truy cập heap** | Tất cả cột cần thiết đều nằm trong index, visibility map đã cập nhật (cần VACUUM) |
| **Bitmap Index Scan** | Scan index → tạo bitmap các page cần đọc → fetch theo batch | Trả về **nhiều row nhưng không quá nhiều** (khoảng 5-20% bảng), hoặc cần **gộp nhiều index** (`BitmapAnd`, `BitmapOr`) |

```
Ví dụ so sánh cost:
- Bảng 1M rows, query trả 10 rows     → Index Scan (nhanh)
- Bảng 1M rows, query trả 900K rows   → Seq Scan (nhanh hơn Index Scan vì tránh random I/O)
- Bảng 1M rows, query trả 50K rows    → Bitmap Index Scan (batch I/O)
```

---

**7. Khi nào PostgreSQL không dùng index?**

Có index không có nghĩa planner sẽ dùng. Các trường hợp phổ biến index bị bỏ qua:

- **Filter không selective** — ví dụ `WHERE status = 'active'` khi 90% row là active. Planner tính rằng Seq Scan đọc tuần tự nhanh hơn Index Scan + random I/O trên gần hết bảng.

- **Hàm bọc quanh cột index** — `WHERE UPPER(name) = 'JOHN'` sẽ không dùng index trên `name`. Cần tạo **expression index**: `CREATE INDEX idx ON users (UPPER(name));`

- **Implicit type cast** — `WHERE phone = 123` khi `phone` là `varchar`. PostgreSQL phải cast `phone` sang numeric để so sánh → không dùng được index. Fix: dùng đúng type `WHERE phone = '123'`.

- **Leading wildcard trong LIKE** — `LIKE '%keyword'` hoặc `LIKE '%keyword%'` không dùng B-tree vì B-tree sắp xếp từ trái sang phải. Giải pháp:

```sql
-- Cài pg_trgm extension cho trigram matching
CREATE EXTENSION pg_trgm;
CREATE INDEX idx_trgm ON articles USING GIN (title gin_trgm_ops);

-- Giờ query LIKE '%keyword%' sẽ dùng GIN index
SELECT * FROM articles WHERE title LIKE '%postgresql%';
```

- **Statistics lỗi thời** — planner ước sai số row → chọn sai plan. Chạy `ANALYZE table_name;` để cập nhật.

---

## Phần 2 — Function & Stored Procedure

**8. Khác biệt giữa FUNCTION và PROCEDURE?**

PostgreSQL 11+ mới hỗ trợ `PROCEDURE`. Trước đó chỉ có `FUNCTION`:

| Tiêu chí | FUNCTION | PROCEDURE |
| -------- | -------- | --------- |
| Return value | ✅ Bắt buộc khai báo `RETURNS` | ❌ Không return (dùng `OUT` parameter nếu cần) |
| COMMIT / ROLLBACK bên trong | ❌ Không được phép | ✅ Có thể commit/rollback giữa chừng |
| Gọi trong SELECT | ✅ `SELECT my_func(...)` | ❌ Phải dùng `CALL my_proc(...)` |
| Transaction control | Chạy trong transaction của caller | Có thể tự quản lý transaction |
| Use case chính | Tính toán, transform data, trả kết quả | Batch processing, ETL, workflow cần commit từng bước |

```sql
-- Function — dùng trong SELECT, bắt buộc RETURN
SELECT add_user('Alice');

-- Procedure — dùng CALL, có thể COMMIT giữa chừng
CALL update_status(123);
```

> [!TIP]
> Nếu logic chỉ cần tính toán và trả kết quả → dùng **FUNCTION**. Nếu cần commit/rollback giữa chừng (ví dụ xử lý batch 10K row, commit mỗi 1000 row) → dùng **PROCEDURE**.

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

Giải thích từng phần:
- `CREATE OR REPLACE` — tạo mới hoặc ghi đè nếu function đã tồn tại (cùng tên + cùng parameter types).
- `RETURNS int` — kiểu dữ liệu trả về.
- `$$...$$` — dollar quoting, thay thế cho dấu nháy đơn để tránh escape hell khi function có chứa string literals.
- `RETURNING id INTO new_id` — lấy giá trị `id` vừa INSERT trực tiếp vào biến, không cần query thêm.
- `LANGUAGE plpgsql` — sử dụng PL/pgSQL (procedural language), hỗ trợ IF/LOOP/EXCEPTION.

---

**10. Khác biệt LANGUAGE sql và plpgsql?**

| Tiêu chí | `LANGUAGE sql` | `LANGUAGE plpgsql` |
| -------- | -------------- | ------------------ |
| Bản chất | Chạy SQL thuần, giống chạy query bình thường | Procedural — biên dịch thành execution plan riêng |
| Tốc độ | Nhanh hơn cho logic đơn giản (ít overhead) | Có overhead khởi tạo PL engine |
| IF / LOOP / EXCEPTION | ❌ Không hỗ trợ | ✅ Đầy đủ control flow |
| Biến (DECLARE) | ❌ | ✅ |
| Inline bởi planner | ✅ Có thể được inline vào query gọi nó | ❌ Luôn chạy như black box |
| Multi-statement logic | Hạn chế — chỉ là danh sách SQL statements | ✅ Đầy đủ |

```sql
-- LANGUAGE sql — đơn giản, nhanh, có thể được inline
CREATE FUNCTION get_active_count() RETURNS bigint AS $$
  SELECT COUNT(*) FROM orders WHERE status = 'ACTIVE';
$$ LANGUAGE sql STABLE;

-- LANGUAGE plpgsql — khi cần logic phức tạp
CREATE FUNCTION process_order(p_id int) RETURNS text AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM orders WHERE id = p_id;
  IF v_status = 'PENDING' THEN
    UPDATE orders SET status = 'PROCESSING' WHERE id = p_id;
    RETURN 'started';
  ELSE
    RETURN 'skipped';
  END IF;
END;
$$ LANGUAGE plpgsql;
```

---

**11. Exception block**

Exception block trong PL/pgSQL hoạt động như `try/catch` — khi có lỗi xảy ra bên trong `BEGIN...END`, PostgreSQL sẽ **tạo savepoint ẩn** trước block đó. Nếu exception xảy ra, nó rollback về savepoint và chạy handler:

```sql
CREATE FUNCTION safe_insert(p_name text) RETURNS text AS $$
BEGIN
  INSERT INTO users(name) VALUES (p_name);
  RETURN 'OK';
EXCEPTION
  WHEN unique_violation THEN
    RETURN 'Duplicate name: ' || p_name;
  WHEN others THEN
    RAISE NOTICE 'Unexpected error: %', SQLERRM;
    RAISE;  -- re-throw error
END;
$$ LANGUAGE plpgsql;
```

> [!IMPORTANT]
> Exception block có **overhead hiệu năng** vì PostgreSQL phải tạo savepoint. Không nên dùng trong vòng lặp chạy hàng triệu lần — thay vào đó dùng `INSERT ... ON CONFLICT` hoặc kiểm tra trước khi thao tác.

---

**12. RAISE NOTICE vs RAISE EXCEPTION?**

Cả hai đều dùng để phát thông báo, nhưng hành vi rất khác nhau:

- **`RAISE NOTICE`** — gửi message tới client (giống `console.log`), **không ảnh hưởng transaction**. Dùng để debug, log tiến trình.

- **`RAISE EXCEPTION`** — **throw error** và **rollback toàn bộ transaction** (hoặc rollback về savepoint nếu có exception block bao ngoài). Dùng khi muốn dừng thực thi và báo lỗi.

```sql
-- Các level severity từ thấp đến cao:
RAISE DEBUG 'Chi tiết debug';           -- chỉ hiện khi client_min_messages = debug
RAISE LOG 'Ghi vào server log';         -- ghi log server, không gửi client
RAISE NOTICE 'Thông báo: %', v_name;   -- gửi client, không rollback
RAISE WARNING 'Cảnh báo quan trọng';   -- gửi client, không rollback
RAISE EXCEPTION 'Lỗi: % không tồn tại', v_id;  -- rollback + throw error
```

---

**13. Immutable / Stable / Volatile?**

Đây là **volatility classification** — cho planner biết function có "thuần khiết" không để tối ưu:

| Volatility | Ý nghĩa | Ví dụ | Planner tối ưu thế nào |
| ---------- | ------- | ----- | ---------------------- |
| `IMMUTABLE` | Cùng input → **luôn luôn** cùng output, không phụ thuộc database state | `lower('ABC')`, `2 + 3` | Planner có thể **pre-evaluate** lúc planning, dùng trong expression index |
| `STABLE` | Cùng output **trong phạm vi 1 câu SQL**, nhưng có thể khác giữa các câu | `now()`, `current_user`, lookup function đọc config table | Planner có thể gọi 1 lần và cache kết quả trong 1 statement |
| `VOLATILE` | Có thể trả kết quả khác nhau **mỗi lần gọi**, kể cả trong cùng 1 row | `random()`, `nextval()`, function có INSERT/UPDATE | Planner **không cache**, gọi lại mỗi lần. Mặc định nếu không khai báo |

> [!IMPORTANT]
> Khai báo sai volatility có thể gây bug nghiêm trọng. Ví dụ: đánh dấu function có `SELECT` bên trong là `IMMUTABLE` → planner cache kết quả cũ, query trả data sai. Chỉ đánh `IMMUTABLE` khi function **thực sự** không đọc database.

---

## Phần 3 — EnterpriseDB (EPAS) Oracle Compatibility

**14. EPAS hỗ trợ package giống Oracle như thế nào?**

EPAS (EDB Postgres Advanced Server) cung cấp **Oracle Compatibility Mode** — một layer bổ sung trên PostgreSQL cho phép chạy code Oracle gần như nguyên bản. Các tính năng chính:

- **`PACKAGE` / `PACKAGE BODY`** — nhóm các function, procedure, type, variable vào một đơn vị logic (giống namespace). PostgreSQL thuần không có khái niệm này.
- **`SYNONYM`** — tạo alias cho object (table, view, function) giữa các schema. Giúp code Oracle dùng synonym không cần sửa.
- **Oracle-style exception** — hỗ trợ `NO_DATA_FOUND`, `TOO_MANY_ROWS`, `DUP_VAL_ON_INDEX`... đúng tên và hành vi như Oracle.
- **`DBMS_*` packages** — reimplementation các built-in package của Oracle:
  - `DBMS_OUTPUT` — debug output (giống `RAISE NOTICE` nhưng API Oracle)
  - `DBMS_JOB` / `DBMS_SCHEDULER` — job scheduling
  - `DBMS_LOCK` — application-level locking
  - `DBMS_SQL` — dynamic SQL
  - `UTL_FILE` — đọc/ghi file trên server

---

**15. Tạo package trong EPAS**

Package gồm 2 phần: **Specification** (khai báo public interface) và **Body** (implementation):

```sql
-- Package Specification — khai báo những gì "bên ngoài" có thể gọi
CREATE OR REPLACE PACKAGE math_pkg AS
  FUNCTION add(a int, b int) RETURN int;
  FUNCTION multiply(a int, b int) RETURN int;
END math_pkg;
/

-- Package Body — chứa implementation
CREATE OR REPLACE PACKAGE BODY math_pkg AS
  FUNCTION add(a int, b int) RETURN int IS
  BEGIN
    RETURN a + b;
  END;

  FUNCTION multiply(a int, b int) RETURN int IS
  BEGIN
    RETURN a * b;
  END;
END math_pkg;
/
```

```sql
-- Gọi function trong package
SELECT math_pkg.add(10, 20);       -- 30
SELECT math_pkg.multiply(5, 6);    -- 30
```

Lợi ích package:
- **Encapsulation** — có thể có private function/variable trong body mà spec không khai báo → bên ngoài không gọi được.
- **Session state** — package variable giữ giá trị trong suốt session (giống global variable scoped theo session).
- **Dễ quản lý** — nhóm logic liên quan vào 1 chỗ thay vì hàng chục standalone function.

---

**16. EPAS có hỗ trợ PL/SQL không?**

Có — EPAS hỗ trợ **~95% PL/SQL Oracle** bao gồm:
- Cú pháp `IS/AS` thay vì `AS $$...$$ LANGUAGE plpgsql`
- `%TYPE`, `%ROWTYPE` references
- `CURSOR` với `FOR...LOOP` kiểu Oracle
- `BULK COLLECT`, `FORALL` cho batch processing
- `EXECUTE IMMEDIATE` cho dynamic SQL
- Implicit cursor attributes (`SQL%ROWCOUNT`, `SQL%FOUND`)

Phần 5% còn lại thường là: một số Oracle built-in function edge case, `AUTONOMOUS_TRANSACTION` (EPAS hỗ trợ hạn chế), và một số advanced Oracle features hiếm gặp.

---

**17. Khi nào nên chọn EPAS thay vì PostgreSQL open-source?**

| Tiêu chí | PostgreSQL Open-Source | EPAS |
| -------- | --------------------- | ---- |
| Hệ thống mới, không ràng buộc Oracle | ✅ Đủ dùng | Overkill |
| Migrate từ Oracle, code PL/SQL lớn | Phải rewrite nhiều | ✅ Chạy gần nguyên bản |
| Cần PACKAGE / PACKAGE BODY | ❌ Không có | ✅ |
| Cần DBMS_* packages | ❌ Phải tự viết | ✅ Có sẵn |
| Cần enterprise support (SLA, hotfix) | Community support | ✅ EDB support 24/7 |
| Cần SQL Profiler, Index Advisor | ❌ | ✅ Built-in tools |
| Chi phí license | Miễn phí | Có phí (subscription) |

> [!TIP]
> Quy tắc đơn giản: Nếu đang migrate từ Oracle và có >50 package/stored procedure PL/SQL → chọn EPAS để tiết kiệm effort rewrite. Nếu viết mới hoàn toàn → PostgreSQL open-source là đủ.

---

## Phần 4 — Query Performance Tuning

**18. Làm sao biết query bị slow?**

Có 3 layer để phát hiện slow query, từ real-time đến historical:

**Layer 1 — Real-time monitoring:**
```sql
-- Xem queries đang chạy ngay lúc này
SELECT pid, now() - query_start AS duration, state, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE state = 'active'
ORDER BY duration DESC;
```

**Layer 2 — Historical analysis (cần extension `pg_stat_statements`):**
```sql
-- Bật extension (cần add vào shared_preload_libraries rồi restart)
CREATE EXTENSION pg_stat_statements;

-- Top 20 slow queries trung bình
SELECT query, calls, mean_exec_time, total_exec_time,
       rows, shared_blks_hit, shared_blks_read
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

**Layer 3 — Auto-log slow queries:**
```
-- Trong postgresql.conf
log_min_duration_statement = 1000   -- log mọi query > 1 giây
```

Checklist debug khi phát hiện slow query:
1. `EXPLAIN (ANALYZE, BUFFERS)` → xem plan thực tế
2. Check `pg_stat_user_tables` → `n_dead_tup` cao? → cần VACUUM
3. Check `pg_stat_activity` → `wait_event` có phải lock không?
4. Check statistics → `last_analyze` quá cũ? → chạy ANALYZE

---

**19. Khi nào dùng Partial Index?**

Partial Index chỉ index **một subset** của bảng thỏa điều kiện `WHERE`. Dùng khi query luôn filter theo một giá trị cụ thể và phần còn lại không cần index:

```sql
-- Bảng orders có 10M rows, nhưng chỉ 50K rows có status = 'ACTIVE'
-- Full index: index 10M rows (lãng phí)
CREATE INDEX idx_status ON orders (status);

-- Partial index: chỉ index 50K rows ACTIVE (nhỏ gọn, nhanh hơn)
CREATE INDEX idx_active ON orders (created_at) WHERE status = 'ACTIVE';
```

Lợi ích:
- **Kích thước nhỏ hơn** nhiều so với full index → ít tốn disk, nằm gọn trong RAM
- **Write nhanh hơn** — INSERT/UPDATE row có status khác 'ACTIVE' không cần cập nhật index
- **Query nhanh hơn** — index nhỏ → ít page cần scan

> [!IMPORTANT]
> Query phải có điều kiện **khớp với WHERE clause của partial index** thì planner mới dùng. Ví dụ: index `WHERE status = 'ACTIVE'` chỉ dùng cho query có `WHERE status = 'ACTIVE'`.

---

**20. Khi nào dùng GIN index?**

**GIN** (Generalized Inverted Index) được thiết kế cho dữ liệu có **nhiều giá trị trong một cột** (composite values). Hoạt động bằng cách tạo inverted index — map từng giá trị ngược lại row chứa nó:

| Use case | Operator | Ví dụ |
| -------- | -------- | ----- |
| Full-text search | `@@` | `WHERE to_tsvector('english', body) @@ to_tsquery('postgresql')` |
| JSONB containment | `@>`, `?`, `?&`, `?\|` | `WHERE data @> '{"status": "active"}'` |
| Array overlap/contain | `@>`, `&&`, `<@` | `WHERE tags @> ARRAY['urgent']` |
| Trigram (LIKE %text%) | `LIKE`, `ILIKE`, `~` | `WHERE title LIKE '%postgresql%'` (cần `pg_trgm`) |

```sql
-- GIN cho JSONB
CREATE INDEX idx_data ON logs USING GIN (data);

-- GIN cho full-text search
CREATE INDEX idx_fts ON articles USING GIN (to_tsvector('english', body));

-- GIN cho trigram matching
CREATE EXTENSION pg_trgm;
CREATE INDEX idx_trgm ON articles USING GIN (title gin_trgm_ops);
```

Trade-off: GIN **insert chậm hơn** B-tree (vì phải cập nhật inverted list), nhưng **read nhanh hơn** cho các operator trên.

---

**21. B-tree index phù hợp cho kiểu dữ liệu nào?**

B-tree là index **mặc định** khi `CREATE INDEX` không chỉ định type. Phù hợp cho dữ liệu có thể **sắp xếp tuyến tính**:

| Operator | Ví dụ | Dùng B-tree? |
| -------- | ----- | ------------ |
| `=` (equality) | `WHERE id = 100` | ✅ |
| `>`, `<`, `>=`, `<=` (range) | `WHERE created_at > '2024-01-01'` | ✅ |
| `BETWEEN` | `WHERE price BETWEEN 10 AND 100` | ✅ |
| `ORDER BY` | `ORDER BY created_at DESC` | ✅ (tránh sort thêm) |
| `IS NULL` / `IS NOT NULL` | `WHERE deleted_at IS NULL` | ✅ |
| `LIKE 'prefix%'` | `WHERE name LIKE 'John%'` | ✅ (chỉ prefix, không wildcard đầu) |
| `LIKE '%suffix'` | `WHERE name LIKE '%son'` | ❌ Cần GIN trigram |
| `@>` (JSONB contain) | `WHERE data @> '...'` | ❌ Cần GIN |

> [!TIP]
> Nếu không chắc dùng loại index nào, B-tree là lựa chọn an toàn nhất. Chỉ chuyển sang GIN/GiST/BRIN khi B-tree không hỗ trợ operator cần thiết hoặc data pattern đặc biệt.

---

**22. Vì sao `LIKE '%text%'` không dùng index?**

B-tree index sắp xếp data theo thứ tự từ trái sang phải (giống mục lục sách sắp theo chữ cái). Khi tìm `LIKE 'John%'`, B-tree có thể nhảy thẳng đến vùng bắt đầu bằng "John". Nhưng `LIKE '%text%'` có wildcard ở đầu → phải scan toàn bộ index vì không biết data bắt đầu từ đâu.

Giải pháp dùng **GIN trigram index** — chia text thành các chuỗi 3 ký tự (trigrams) rồi đánh index ngược:

```sql
-- Cài extension
CREATE EXTENSION pg_trgm;

-- Tạo GIN trigram index
CREATE INDEX idx_trgm ON articles USING GIN (title gin_trgm_ops);

-- Giờ các query sau đều dùng được index:
SELECT * FROM articles WHERE title LIKE '%postgresql%';
SELECT * FROM articles WHERE title ILIKE '%PostgreSQL%';  -- case-insensitive
SELECT * FROM articles WHERE title ~ 'post.*sql';         -- regex
```

Cách trigram hoạt động: `'postgresql'` được chia thành `['pos', 'ost', 'stg', 'tgr', 'gre', 'res', 'esq', 'sql']`. GIN index lưu mapping `trigram → list rows`. Khi query `LIKE '%sql%'`, nó tìm tất cả row có chứa trigram `'sql'`.

---

**23. Làm sao biết table đang bị bloat?**

Table bloat xảy ra khi dead tuples chiếm nhiều không gian nhưng chưa được VACUUM dọn. Có 3 cách kiểm tra:

**Cách 1 — `pgstattuple` extension (chính xác nhất, nhưng scan toàn bộ table):**
```sql
CREATE EXTENSION pgstattuple;

SELECT * FROM pgstattuple('my_table');
-- Chú ý: dead_tuple_percent > 20% → cần VACUUM ngay
-- free_percent cao → table đã VACUUM nhưng space chưa được tái sử dụng
```

**Cách 2 — So sánh kích thước thực vs kích thước lý thuyết:**
```sql
SELECT
  relname,
  pg_size_pretty(pg_relation_size(relid)) AS actual_size,
  n_live_tup,
  n_dead_tup,
  round(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct,
  last_vacuum,
  last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

**Cách 3 — Dùng `pg_bloat_check` hoặc query ước tính từ `pgstattuple_approx` (nhanh hơn, ít chính xác hơn):**
```sql
SELECT * FROM pgstattuple_approx('my_table');
```

> [!TIP]
> Nếu `dead_tuple_percent` > 20% thường xuyên, hãy xem lại cấu hình autovacuum cho table đó (giảm `autovacuum_vacuum_scale_factor`).

---

**24. Slow query sau migrate Oracle → Postgres, xử lý?**

Sau migrate, query thường chậm vì nhiều nguyên nhân khác nhau. Quy trình xử lý theo thứ tự ưu tiên:

1. **Chạy `ANALYZE` trên toàn bộ database** — sau import data, statistics hoàn toàn trống. Planner không biết gì về data distribution → chọn plan sai.
   ```sql
   ANALYZE;  -- toàn bộ database
   -- hoặc từng bảng lớn
   ANALYZE orders;
   ```

2. **Kiểm tra index** — Oracle implicit index trên primary key/unique constraint sẽ được migrate, nhưng các index khác có thể bị thiếu. Đặc biệt chú ý foreign key — Oracle tự tạo index cho FK, **PostgreSQL không tự tạo**.

3. **Rewrite query theo cú pháp PostgreSQL** — Oracle optimizer xử lý subquery, implicit join khác. Một số pattern cần sửa:
   - `(+)` outer join → `LEFT JOIN`
   - `CONNECT BY` → `WITH RECURSIVE`
   - `ROWNUM` → `ROW_NUMBER() OVER ()` hoặc `LIMIT`

4. **`EXPLAIN ANALYZE` từng query chậm** — so sánh estimated rows vs actual rows. Nếu lệch lớn → statistics chưa đủ, tăng `default_statistics_target` cho cột có cardinality cao.

5. **Kiểm tra data types** — Oracle `NUMBER` → Postgres `numeric` (chậm hơn `int`/`bigint`). Đổi sang integer types nếu không cần decimal.

---

**25. Cách tối ưu JOIN lớn?**

PostgreSQL có 3 chiến lược JOIN, planner tự chọn dựa trên cost:

| Chiến lược | Khi nào dùng | Yêu cầu |
| ---------- | ------------ | -------- |
| **Nested Loop** | Outer table nhỏ, inner table có index | Index trên join key của inner table |
| **Hash Join** | Cả 2 bảng lớn, không có index phù hợp | Đủ `work_mem` để chứa hash table |
| **Merge Join** | Cả 2 bảng đã sort sẵn (hoặc có index) | Data đã sorted theo join key |

Checklist tối ưu:

- **Tạo index trên join keys** — đây là điều quan trọng nhất. Không có index = Seq Scan + Hash Join (chậm với bảng lớn).

- **Tăng `work_mem` cho session nếu Hash Join spill to disk:**
  ```sql
  -- Kiểm tra trong EXPLAIN ANALYZE: "Batches: 8" nghĩa là hash table không vừa memory
  SET work_mem = '256MB';  -- chỉ cho session hiện tại
  ```

- **Tránh function trên cột join** — `WHERE f(a.col) = b.col` buộc Seq Scan vì không dùng được index. Nếu cần, tạo expression index.

- **Tránh implicit cast** — `int` join với `bigint` hoặc `varchar` join với `text` có thể ngăn index usage. Đảm bảo data type 2 bên match.

- **Xem xét join order** — với nhiều bảng (>4-5), planner có thể chọn sai order. Dùng `join_collapse_limit` hoặc explicit join order nếu cần.

---

## Phần 5 — Locking & Concurrency

**26. Các kiểu lock trong PostgreSQL?**

PostgreSQL sử dụng nhiều cấp độ lock khác nhau. Hiểu lock giúp tránh deadlock và thiết kế concurrent system tốt hơn:

| Loại | Mô tả | Ví dụ sử dụng |
| ---- | ----- | ------------- |
| **Row-level lock** | Lock từng row cụ thể, transaction khác vẫn đọc/ghi row khác | `SELECT ... FOR UPDATE` (exclusive), `FOR SHARE` (shared), `FOR NO KEY UPDATE`, `FOR KEY SHARE` |
| **Table-level lock** | Lock toàn bảng với các mức nghiêm ngặt khác nhau | `ACCESS SHARE` (SELECT bình thường), `ROW EXCLUSIVE` (INSERT/UPDATE/DELETE), `ACCESS EXCLUSIVE` (ALTER TABLE, DROP, VACUUM FULL) |
| **Advisory lock** | Application-level lock, PostgreSQL chỉ quản lý — app tự quyết logic | `pg_advisory_lock(123)` — dùng cho distributed locking, rate limiting, singleton job |
| **Page-level lock** | Lock ở cấp data page (8KB block), internal | PostgreSQL tự quản lý, developer không can thiệp |

```sql
-- Xem tất cả locks hiện tại
SELECT l.locktype, l.relation::regclass, l.mode, l.granted, a.pid, a.query
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation IS NOT NULL;
```

> [!IMPORTANT]
> `ACCESS EXCLUSIVE` lock (từ `ALTER TABLE`, `DROP`, `VACUUM FULL`) sẽ **block mọi thao tác khác** kể cả SELECT. Trên production, luôn dùng `CREATE INDEX CONCURRENTLY` thay vì `CREATE INDEX` để tránh block write.

---

**27. Deadlock xảy ra khi nào?**

Deadlock xảy ra khi **2 hoặc nhiều transaction chờ lock lẫn nhau** tạo thành vòng tròn, không ai có thể tiến tiếp:

```
Transaction A: lock row 1, đang chờ lock row 2
Transaction B: lock row 2, đang chờ lock row 1
→ Cả hai chờ nhau mãi mãi = DEADLOCK
```

PostgreSQL có **deadlock detector** chạy định kỳ (mặc định mỗi `deadlock_timeout = 1s`). Khi phát hiện deadlock, PostgreSQL sẽ **rollback 1 trong 2 transaction** (chọn transaction ít tốn kém hơn để rollback) và gửi error `ERROR: deadlock detected`.

Cách phòng tránh:
- **Lock theo thứ tự nhất quán** — nếu cần lock row 1 và row 2, luôn lock theo thứ tự ID tăng dần.
- **Giữ transaction ngắn** — transaction dài = giữ lock lâu = tăng xác suất deadlock.
- **Tránh interactive transaction** — không nên `BEGIN` rồi đợi user input rồi mới `COMMIT`.

---

**28. Làm sao debug deadlock?**

**Bước 1 — Bật logging để PostgreSQL tự ghi chi tiết deadlock:**
```
-- postgresql.conf
deadlock_timeout = 1s        -- thời gian chờ trước khi check deadlock
log_lock_waits = on          -- log khi query phải chờ lock > deadlock_timeout
log_min_duration_statement = 0  -- log tất cả query (hoặc set giá trị phù hợp)
```

**Bước 2 — Xem locks đang giữ và session đang chờ:**
```sql
-- Xem ai đang block ai
SELECT
  blocked.pid AS blocked_pid,
  blocked.query AS blocked_query,
  blocking.pid AS blocking_pid,
  blocking.query AS blocking_query,
  blocked.wait_event_type,
  blocked.wait_event
FROM pg_stat_activity blocked
JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted
JOIN pg_locks gl ON gl.relation = bl.relation AND gl.granted
JOIN pg_stat_activity blocking ON blocking.pid = gl.pid
WHERE blocked.pid != blocking.pid;
```

**Bước 3 — Kill session gây block nếu cần (cẩn thận trên production):**
```sql
SELECT pg_cancel_backend(pid);     -- cancel query (graceful)
SELECT pg_terminate_backend(pid);  -- kill session (force)
```

---

**29. Khi nào dùng `SELECT FOR UPDATE`?**

Dùng khi cần **pessimistic locking** — đọc data rồi cập nhật dựa trên giá trị vừa đọc, không muốn transaction khác thay đổi giữa chừng:

```sql
-- Ví dụ: rút tiền — cần đảm bảo balance không bị thay đổi giữa SELECT và UPDATE
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
-- Giả sử balance = 500. Row đang bị lock, transaction khác phải chờ.
-- Kiểm tra: balance >= 100?
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
-- Sau COMMIT, lock được giải phóng → transaction khác tiếp tục.
```

Các biến thể:
| Lệnh | Hành vi |
| ----- | ------- |
| `FOR UPDATE` | Lock exclusive — block cả read `FOR UPDATE` và write |
| `FOR NO KEY UPDATE` | Nhẹ hơn `FOR UPDATE` — cho phép `FOR KEY SHARE` (dùng khi không sửa primary key) |
| `FOR SHARE` | Shared lock — cho phép nhiều transaction cùng `FOR SHARE`, block write |
| `FOR UPDATE NOWAIT` | Nếu row đang bị lock → báo lỗi ngay thay vì chờ |
| `FOR UPDATE SKIP LOCKED` | Bỏ qua row đang bị lock → rất hữu ích cho **job queue pattern** |

```sql
-- Job queue pattern: lấy 1 task chưa bị lock
SELECT id, payload FROM tasks
WHERE status = 'PENDING'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

---

**30. Read Committed vs Repeatable Read?**

PostgreSQL hỗ trợ 4 isolation level, nhưng 2 level hay dùng nhất:

| Tiêu chí | Read Committed (default) | Repeatable Read |
| -------- | ------------------------ | --------------- |
| Snapshot | **Mới cho mỗi câu SQL** — mỗi SELECT thấy data mới nhất đã committed | **Cố định từ đầu transaction** — snapshot tại thời điểm câu SQL đầu tiên |
| Non-repeatable read | ✅ Có thể xảy ra — `SELECT` lần 1 và lần 2 thấy data khác nhau nếu có transaction khác committed giữa chừng | ❌ Không — luôn thấy cùng data |
| Phantom read | ✅ Có thể — row mới INSERT bởi transaction khác có thể xuất hiện | ❌ Không (PostgreSQL dùng SSI ngăn phantom) |
| Serialization error | ❌ Không bao giờ | ✅ Có thể — nếu 2 transaction conflict, 1 bên bị rollback với `ERROR: could not serialize access` |
| Dùng khi nào | Hầu hết OLTP application | Report/analytics cần consistent snapshot, hoặc business logic cần đảm bảo data không đổi trong transaction |

```sql
-- Set isolation level cho transaction
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT * FROM accounts WHERE id = 1;  -- snapshot tại đây
-- ... dù transaction khác đã UPDATE account 1, SELECT ở đây vẫn thấy giá trị cũ
COMMIT;
```

> [!TIP]
> Khi dùng `REPEATABLE READ`, cần **retry logic** trong application vì có thể gặp serialization error. Đây là trade-off: consistency cao hơn nhưng cần handle error nhiều hơn.

---

## Phần 6 — Advanced

**31. WAL trong PostgreSQL là gì?**

**WAL** (Write-Ahead Logging) là cơ chế cốt lõi đảm bảo **data không bị mất khi crash**. Nguyên tắc: **ghi log trước, ghi data sau**.

Cách hoạt động:
1. Khi INSERT/UPDATE/DELETE, PostgreSQL ghi **thay đổi vào WAL file trước** (sequential write, rất nhanh).
2. Data page thực tế trong shared buffer **chưa cần ghi xuống disk ngay** (dirty page).
3. Checkpoint process định kỳ flush dirty pages xuống disk.
4. Nếu crash xảy ra → PostgreSQL đọc lại WAL và **replay** các thay đổi chưa flush → data được khôi phục.

Tại sao WAL nhanh hơn ghi trực tiếp?
- WAL ghi **sequential** (append-only) → nhanh hơn nhiều so với random I/O khi ghi data pages.
- Cho phép batch nhiều thay đổi rồi flush 1 lần thay vì flush từng operation.

WAL còn là nền tảng cho:
- **Streaming Replication** — gửi WAL records sang standby server để đồng bộ
- **Point-in-Time Recovery (PITR)** — restore database về bất kỳ thời điểm nào bằng cách replay WAL
- **Logical Decoding** — decode WAL thành row-level changes cho CDC (Change Data Capture)

---

**32. Physical vs Logical Replication?**

| Tiêu chí | Physical Replication | Logical Replication |
| -------- | -------------------- | ------------------- |
| Đơn vị sao chép | **Block-level** — copy nguyên data page | **Row-level** — sao chép từng INSERT/UPDATE/DELETE |
| Phạm vi | **Toàn bộ cluster** (tất cả databases) | **Từng bảng** — chọn table cụ thể qua publication |
| Cross-version | ❌ Không — primary và standby phải cùng major version | ✅ Có — có thể replicate giữa PG 14 → PG 16 |
| Filtering row/column | ❌ Không | ✅ Có — PG 15+ hỗ trợ row filter và column list |
| Standby có thể write? | ❌ Read-only | ✅ Có — subscriber database có thể có data riêng |
| DDL replication | ✅ Tự động (vì copy block) | ❌ Không — phải apply DDL thủ công trên subscriber |
| Setup phức tạp | Đơn giản hơn | Phức tạp hơn (publication/subscription) |
| Use case | HA/failover, read replica | Zero-downtime upgrade, selective replication, CDC |

```sql
-- Logical Replication setup
-- Trên publisher:
CREATE PUBLICATION my_pub FOR TABLE orders, users;

-- Trên subscriber:
CREATE SUBSCRIPTION my_sub
  CONNECTION 'host=primary dbname=mydb'
  PUBLICATION my_pub;
```

---

**33. Partitioning trong PostgreSQL hoạt động thế nào?**

Partitioning chia **1 bảng lớn** thành nhiều bảng nhỏ (partitions) vật lý, nhưng application vẫn query **1 tên bảng** duy nhất. PostgreSQL tự routing đến đúng partition.

**Declarative Partitioning** (PG 10+):

```sql
-- Bảng cha — không chứa data trực tiếp
CREATE TABLE orders (
  id bigint,
  created_at date,
  amount numeric
) PARTITION BY RANGE (created_at);

-- Các partition — mỗi partition chứa 1 khoảng thời gian
CREATE TABLE orders_2024 PARTITION OF orders
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

CREATE TABLE orders_2025 PARTITION OF orders
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

-- Query tự động chỉ scan partition cần thiết (partition pruning)
SELECT * FROM orders WHERE created_at = '2025-06-15';
-- → PostgreSQL chỉ scan orders_2025, bỏ qua orders_2024
```

Các kiểu partition:
| Kiểu | Dùng khi | Ví dụ |
| ---- | -------- | ----- |
| `RANGE` | Data có thứ tự tự nhiên | Theo thời gian (ngày/tháng/năm) |
| `LIST` | Phân nhóm theo giá trị cụ thể | Theo region, country, status |
| `HASH` | Phân bố đều, không có range tự nhiên | Theo user_id hash |

Lợi ích: query nhanh hơn (partition pruning), maintenance dễ hơn (DROP partition thay vì DELETE hàng triệu row), VACUUM nhanh hơn (chỉ vacuum partition thay đổi).

---

**34. CTE (`WITH`) — lợi ích và rủi ro?**

CTE (Common Table Expression) giúp viết query phức tạp dễ đọc hơn bằng cách chia thành các bước logic:

```sql
WITH monthly_revenue AS (
  SELECT date_trunc('month', created_at) AS month, SUM(amount) AS revenue
  FROM orders
  GROUP BY 1
),
monthly_growth AS (
  SELECT month, revenue,
    LAG(revenue) OVER (ORDER BY month) AS prev_revenue
  FROM monthly_revenue
)
SELECT month, revenue,
  round((revenue - prev_revenue) / prev_revenue * 100, 2) AS growth_pct
FROM monthly_growth;
```

**Rủi ro hiệu năng — optimization fence:**

- **PostgreSQL < 12**: CTE luôn được **materialized** (chạy riêng, lưu kết quả vào temp) → planner không thể push filter xuống bên trong CTE → có thể chậm đáng kể.
- **PostgreSQL 12+**: CTE được **inline mặc định** nếu không có side effects và chỉ được reference 1 lần.

```sql
-- Force materialization (dùng khi CTE được reference nhiều lần, tránh chạy lại)
WITH cte AS MATERIALIZED (
  SELECT * FROM expensive_query
)
SELECT * FROM cte WHERE id = 1
UNION ALL
SELECT * FROM cte WHERE id = 2;

-- Force inline (PG12+ default, nhưng có thể explicit)
WITH cte AS NOT MATERIALIZED (
  SELECT * FROM orders WHERE status = 'ACTIVE'
)
SELECT * FROM cte WHERE amount > 1000;
-- → Planner sẽ merge filter: status = 'ACTIVE' AND amount > 1000
```

---

**35. Materialized View refresh thế nào?**

Materialized View (MV) lưu **kết quả query vật lý** — query nhanh như table nhưng data có thể stale. Cần refresh để cập nhật:

```sql
-- Tạo Materialized View
CREATE MATERIALIZED VIEW mv_monthly_revenue AS
SELECT date_trunc('month', created_at) AS month, SUM(amount) AS revenue
FROM orders
GROUP BY 1;

-- Tạo unique index (bắt buộc nếu muốn dùng CONCURRENTLY)
CREATE UNIQUE INDEX ON mv_monthly_revenue (month);

-- Refresh BLOCKING — lock MV, SELECT bị block trong lúc refresh
REFRESH MATERIALIZED VIEW mv_monthly_revenue;

-- Refresh NON-BLOCKING — tạo version mới song song, swap khi xong
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_revenue;
-- Yêu cầu: MV phải có UNIQUE index
```

| So sánh | `REFRESH` | `REFRESH CONCURRENTLY` |
| ------- | --------- | ---------------------- |
| Block SELECT | ✅ Có | ❌ Không |
| Tốc độ | Nhanh hơn | Chậm hơn (phải diff old vs new) |
| Yêu cầu | Không | Cần UNIQUE index trên MV |
| Dùng khi | MV nhỏ, downtime chấp nhận được | Production, MV lớn, zero-downtime |

---

**36. Full-text search?**

PostgreSQL có built-in full-text search mà không cần Elasticsearch cho nhiều use case:

```sql
-- Bước 1: Tạo GIN index trên tsvector (vector chứa các từ đã tokenize + normalize)
CREATE INDEX idx_fts ON articles USING GIN (to_tsvector('english', body));

-- Bước 2: Query dùng @@ operator
SELECT title, ts_rank(to_tsvector('english', body), query) AS rank
FROM articles, to_tsquery('english', 'postgresql & tuning') query
WHERE to_tsvector('english', body) @@ query
ORDER BY rank DESC;
```

Các operator trong `to_tsquery`:
| Operator | Ý nghĩa | Ví dụ |
| -------- | ------- | ----- |
| `&` | AND | `'postgresql & tuning'` — cả 2 từ |
| `\|` | OR | `'postgresql \| mysql'` — 1 trong 2 |
| `!` | NOT | `'postgresql & !mysql'` — có PG, không có MySQL |
| `<->` | Followed by | `'database <-> tuning'` — "database" theo sau bởi "tuning" |

> [!TIP]
> Để tránh gọi `to_tsvector()` mỗi lần query, tạo generated column:
> ```sql
> ALTER TABLE articles ADD COLUMN search_vector tsvector
>   GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
> CREATE INDEX idx_fts ON articles USING GIN (search_vector);
> ```

---

**37. JSONB index?**

PostgreSQL hỗ trợ lưu và query JSON rất mạnh. Có 2 cách đánh index cho JSONB:

**Cách 1 — GIN index toàn bộ document (linh hoạt, dùng cho nhiều query pattern):**
```sql
-- Default GIN — hỗ trợ @>, ?, ?|, ?&
CREATE INDEX idx_json ON logs USING GIN (data);

-- jsonb_path_ops — nhỏ hơn, nhanh hơn cho @> (containment) nhưng không hỗ trợ ?, ?|
CREATE INDEX idx_json ON logs USING GIN (data jsonb_path_ops);
```

**Cách 2 — B-tree index trên path cụ thể (khi chỉ query theo 1-2 key):**
```sql
-- Index cho query: WHERE data->>'status' = 'error'
CREATE INDEX idx_json_status ON logs ((data->>'status'));

-- Index cho query: WHERE (data->'metadata'->>'user_id')::int = 123
CREATE INDEX idx_json_user ON logs (((data->'metadata'->>'user_id')::int));
```

| So sánh | GIN (toàn bộ) | B-tree (path cụ thể) |
| ------- | ------------- | -------------------- |
| Linh hoạt | ✅ Query bất kỳ key | ❌ Chỉ key đã index |
| Kích thước | Lớn hơn | Nhỏ hơn nhiều |
| Tốc độ write | Chậm hơn | Nhanh hơn |
| Equality / Range | Chỉ containment `@>` | ✅ `=`, `>`, `<`, `BETWEEN` |

---

## Phần 7 — EPAS Oracle Compat Mode chuyên sâu

**38. EnterpriseDB tương thích Oracle ở điểm nào?**

EPAS Oracle Compatibility Mode hỗ trợ gần như toàn bộ stack phát triển Oracle:

| Tính năng | Mô tả | Mức tương thích |
| --------- | ----- | --------------- |
| `PACKAGE` / `PACKAGE BODY` | Nhóm functions, procedures, variables vào module | ~98% |
| Oracle-style cursor loop | `FOR rec IN (SELECT ...) LOOP`, implicit cursor | ~95% |
| Oracle exception model | `NO_DATA_FOUND`, `TOO_MANY_ROWS`, `DUP_VAL_ON_INDEX` | ~95% |
| `SYNONYM` | Alias cho objects giữa schemas | ✅ Đầy đủ |
| `DBMS_OUTPUT` | Debug output giống Oracle | ✅ Đầy đủ |
| `DBMS_PIPE` | Communication giữa sessions qua pipe | ✅ |
| `DBMS_JOB` | Job scheduling | ✅ |
| `DBMS_SQL` | Dynamic SQL API | ~90% |
| Oracle `DATE` type | `DATE` chứa cả time (giống Oracle, khác PG thuần) | ✅ Trong compat mode |
| `NUMBER` type | Ánh xạ sang `numeric` nhưng chấp nhận cú pháp Oracle | ✅ |
| `DUAL` table | `SELECT SYSDATE FROM DUAL` — hoạt động đúng | ✅ |
| `CONNECT BY` | Hierarchical query (cú pháp Oracle) | ✅ Trong EPAS |
| `DECODE()` | `DECODE(col, v1, r1, v2, r2, default)` | ✅ |
| `NVL()` / `NVL2()` | Null-handling functions | ✅ |

---

**39. Khác biệt EPAS và PostgreSQL thuần?**

EPAS = PostgreSQL + Oracle compatibility layer + enterprise tools:

| Tính năng | PostgreSQL thuần | EPAS |
| --------- | --------------- | ---- |
| PL/SQL compatibility | ❌ Chỉ có PL/pgSQL | ✅ Chạy code PL/SQL Oracle gần nguyên bản |
| PACKAGE / PACKAGE BODY | ❌ | ✅ |
| SYNONYM | ❌ | ✅ |
| **Index Advisor** | ❌ Phải dùng extension bên ngoài | ✅ Suggest missing indexes dựa trên workload |
| **SQL Profiler** | ❌ Chỉ có `pg_stat_statements` | ✅ GUI-based profiling chi tiết từng statement |
| **EDB*Loader** | `COPY` command | ✅ Tương thích Oracle `SQL*Loader`, nhanh hơn cho bulk load |
| Security | Basic (pg_hba, roles) | ✅ Password policy (complexity, expiry), SQL/Protect (SQL injection firewall), data redaction |
| Oracle data types | Cần mapping thủ công | ✅ `DATE` (với time), `NUMBER`, `VARCHAR2` hoạt động đúng |
| Audit | Cần extension `pgaudit` | ✅ Built-in, chi tiết hơn |

> [!NOTE]
> EPAS vẫn là PostgreSQL bên dưới — tất cả extensions, tools, client libraries của PostgreSQL đều hoạt động. EPAS chỉ thêm layer trên cùng.

---

**40. Migrate Oracle → EPAS, lỗi thường gặp?**

Dù EPAS tương thích ~95%, vẫn có các edge case cần xử lý:

| Lỗi | Giải thích chi tiết | Cách fix |
| --- | ------------------- | -------- |
| Dynamic SQL syntax khác | `EXECUTE IMMEDIATE 'SELECT ...' INTO v_result` — cú pháp bind variable có thể khác | Test từng `EXECUTE IMMEDIATE`, sửa bind syntax nếu cần |
| Built-in functions không 1-1 | `REGEXP_SUBSTR`, `LISTAGG`, `XMLAGG` có thể thiếu hoặc khác behavior | Viết wrapper function hoặc dùng PostgreSQL equivalent |
| `DATE` Oracle ≠ `DATE` PostgreSQL | Oracle `DATE` chứa time (year-month-day hour-minute-second), PostgreSQL `DATE` chỉ chứa date | Dùng EPAS compat mode (tự handle) hoặc đổi sang `TIMESTAMP` |
| Package global variable | Trong Oracle, package variable giữ giá trị suốt session. EPAS cũng hỗ trợ nhưng behavior khi connection pooling có thể khác | Test kỹ với connection pooler (PgBouncer), reset package state khi cần |
| `AUTONOMOUS_TRANSACTION` | Oracle pragma cho phép commit independent. EPAS hỗ trợ hạn chế | Rewrite dùng `dblink` hoặc redesign logic |
| Sequence cache | Oracle cache sequence value per session, PG cache per backend | Set `CACHE` value phù hợp, chấp nhận gap trong sequence |
| Empty string ≠ NULL | Oracle coi `''` = `NULL`. PostgreSQL phân biệt `''` và `NULL` | Audit tất cả so sánh `IS NULL` vs `= ''`, thêm `COALESCE` nếu cần |

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

Cách gọi và kiểm tra:
```sql
-- Gọi function
SELECT total_order(42);   -- trả về số đơn hàng của user 42

-- Dùng trong query khác
SELECT u.id, u.name, total_order(u.id) AS order_count
FROM users u
WHERE total_order(u.id) > 10;
```

> [!TIP]
> Trong trường hợp này, có thể viết bằng `LANGUAGE sql` sẽ hiệu quả hơn vì planner có thể inline:
> ```sql
> CREATE OR REPLACE FUNCTION total_order(p_user int)
> RETURNS bigint AS $$
>   SELECT COUNT(*) FROM orders WHERE user_id = p_user;
> $$ LANGUAGE sql STABLE;
> ```

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

Tại sao dùng PROCEDURE thay vì FUNCTION?
- `COMMIT` bên trong **chỉ được phép trong PROCEDURE**, không được phép trong FUNCTION.
- Use case: batch processing cần commit từng phần để tránh long transaction và giữ lock quá lâu.

```sql
-- Gọi procedure
CALL update_status(123);

-- Ví dụ batch processing với commit từng bước
CREATE PROCEDURE batch_update_status()
LANGUAGE plpgsql AS $$
DECLARE
  v_id int;
  v_count int := 0;
BEGIN
  FOR v_id IN SELECT id FROM orders WHERE status = 'PENDING' LIMIT 10000
  LOOP
    UPDATE orders SET status = 'DONE' WHERE id = v_id;
    v_count := v_count + 1;
    IF v_count % 1000 = 0 THEN
      COMMIT;  -- commit mỗi 1000 rows, giải phóng lock
      RAISE NOTICE 'Committed % rows', v_count;
    END IF;
  END LOOP;
  COMMIT;
END;
$$;
```

---

**50. Tuning query aggregate lớn — 4 bước**

Khi query có `GROUP BY` / `SUM` / `COUNT` trên bảng hàng triệu row và chạy chậm:

**Bước 1 — Tạo index phù hợp:**
```sql
-- Index trên cột GROUP BY + WHERE giúp planner dùng Index Scan hoặc Index-Only Scan
CREATE INDEX idx_orders_status_date ON orders (status, created_at);

-- Với aggregate cần cột cụ thể, dùng covering index (INCLUDE)
CREATE INDEX idx_orders_covering ON orders (status) INCLUDE (amount);
-- → Index-Only Scan cho: SELECT status, SUM(amount) FROM orders GROUP BY status
```

**Bước 2 — Bật parallel query:**
```sql
-- Kiểm tra cấu hình hiện tại
SHOW max_parallel_workers_per_gather;  -- default = 2

-- Tăng nếu server có nhiều CPU cores
SET max_parallel_workers_per_gather = 4;
-- PostgreSQL sẽ dùng Parallel Seq Scan + Partial HashAggregate → gộp kết quả
```

**Bước 3 — Tăng `work_mem` để hash aggregate nằm gọn trong memory:**
```sql
-- Nếu EXPLAIN ANALYZE hiển thị "Batches: 4" hoặc "Sort Method: external merge"
-- → hash table / sort spill to disk → chậm
SET work_mem = '256MB';  -- chỉ cho session hiện tại, không set global quá cao
```

**Bước 4 — Pre-aggregate bằng Materialized View:**
```sql
-- Khi query chạy thường xuyên nhưng data không cần real-time
CREATE MATERIALIZED VIEW mv_daily_stats AS
SELECT date_trunc('day', created_at) AS day, status, COUNT(*), SUM(amount)
FROM orders
GROUP BY 1, 2;

CREATE UNIQUE INDEX ON mv_daily_stats (day, status);

-- Refresh định kỳ (ví dụ mỗi 5 phút via pg_cron)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_stats;
```

---

## Phần 9 — Tư duy chuyên gia

**51. Vì sao PostgreSQL chọn Seq Scan dù có index?**

Đây là câu hỏi **rất hay gặp** trong interview. Câu trả lời cần phân tích cost model:

PostgreSQL planner chọn plan có **lowest estimated cost**. Có 3 lý do chính index bị bỏ qua:

1. **Cost(Index Scan) > Cost(Seq Scan)** — Index Scan phải đọc index page → theo pointer đến heap page (random I/O). Nếu query trả về >5-10% bảng, random I/O của index scan tốn hơn sequential I/O của seq scan.

2. **Statistics lỗi thời** — planner dùng `pg_statistic` (histogram, distinct values) để ước tính selectivity. Nếu data thay đổi nhiều mà chưa `ANALYZE`, planner ước sai → chọn sai plan.

3. **Filter không selective** — ví dụ `WHERE status = 'active'` khi 90% rows là active. Planner biết phải đọc gần hết bảng → seq scan đọc tuần tự nhanh hơn.

```sql
-- Kiểm tra selectivity của 1 giá trị
SELECT n_distinct, most_common_vals, most_common_freqs
FROM pg_stats
WHERE tablename = 'orders' AND attname = 'status';
-- Nếu 'active' có frequency 0.9 → 90% bảng → seq scan hợp lý
```

---

**52. Ép PostgreSQL dùng index (debug)?**

```sql
-- Chỉ dùng để debug, KHÔNG dùng production vì disable toàn bộ seq scan
SET enable_seqscan = off;
EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'active';
SET enable_seqscan = on;  -- nhớ bật lại!
```

Khi nào dùng trick này?
- Để **so sánh cost** giữa seq scan và index scan — nếu index scan cũng chậm, vấn đề không phải ở thiếu index.
- Để xác nhận index có hoạt động đúng không.

**Cách đúng trên production** (thay vì disable seq scan):
1. Rewrite query cho selective hơn
2. Tạo index phù hợp (partial index, covering index)
3. Chạy `ANALYZE` để cập nhật statistics
4. Tăng `random_page_cost` nếu dùng SSD (mặc định 4.0, SSD nên set 1.1-1.5):
   ```sql
   -- SSD: random I/O gần bằng sequential → planner ưu tiên index hơn
   SET random_page_cost = 1.1;
   ```

---

**53. Debug slow query trên production?**

Quy trình 4 bước cho production:

**Bước 1 — Tìm slow query:**
```sql
-- Từ pg_stat_statements (top query theo mean time)
SELECT query, calls, mean_exec_time, total_exec_time,
  stddev_exec_time, rows,
  shared_blks_hit, shared_blks_read,
  round(shared_blks_hit::numeric / NULLIF(shared_blks_hit + shared_blks_read, 0) * 100, 2) AS cache_hit_pct
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;
```

**Bước 2 — Phân tích plan chi tiết:**
```sql
EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT TEXT)
SELECT ...;
-- Chú ý:
-- - "actual rows" vs "rows estimated" lệch lớn → cần ANALYZE
-- - "Buffers: shared read=xxxxx" → cache miss nhiều → cần tăng shared_buffers
-- - "Sort Method: external merge" → work_mem không đủ
```

**Bước 3 — Bật `auto_explain` để tự log plan cho slow query:**
```
-- postgresql.conf (cần reload, không cần restart)
shared_preload_libraries = 'auto_explain'  -- cần restart lần đầu
auto_explain.log_min_duration = '1s'       -- log query > 1 giây
auto_explain.log_analyze = true            -- bao gồm actual time
auto_explain.log_buffers = true            -- bao gồm buffer usage
auto_explain.log_nested_statements = true  -- log cả query trong function
```

**Bước 4 — Fix theo diagnosis:**

| Diagnosis | Fix |
| --------- | --- |
| Seq Scan trên bảng lớn | Tạo index phù hợp |
| Estimated ≠ Actual rows | `ANALYZE table_name;` |
| Hash Batches > 1 | Tăng `work_mem` |
| Nested Loop với large outer | Tạo index hoặc restructure query |
| Cache hit < 90% | Tăng `shared_buffers` |

---

**54. Khi nào dùng UNLOGGED TABLE?**

UNLOGGED TABLE **không ghi WAL** → INSERT/UPDATE nhanh hơn 2-10x so với table thường. Trade-off: **mất toàn bộ data nếu server crash** (vì không có WAL để replay), và **không được replicate** sang standby.

```sql
CREATE UNLOGGED TABLE staging_data (
  id serial PRIMARY KEY,
  raw_json jsonb,
  processed_at timestamp
);
```

Use case phù hợp:
- **Staging table** — import data từ CSV/API, transform rồi INSERT vào table chính
- **Cache table** — lưu kết quả tính toán tạm, có thể rebuild bất cứ lúc nào
- **Session data** — lưu temp data cho batch processing
- **Queue table** — message queue nội bộ không cần durability

> [!IMPORTANT]
> Sau crash, UNLOGGED TABLE sẽ bị **truncate tự động** (không phải corrupt — PostgreSQL xóa sạch data vì không thể verify consistency). Chỉ dùng cho data có thể rebuild.

---

**55. Khi nào dùng TEMP table?**

TEMP table tồn tại **chỉ trong session hiện tại** và tự xóa khi session kết thúc:

```sql
-- Tạo temp table — chỉ session này thấy
CREATE TEMP TABLE tmp_results (
  id int,
  score numeric
);

-- Hoặc tạo từ query
CREATE TEMP TABLE tmp_active AS
SELECT * FROM orders WHERE status = 'ACTIVE';

-- Tạo index trên temp table (planner cũng dùng)
CREATE INDEX ON tmp_active (id);
```

Use case:
- **Kết quả trung gian** cho multi-step ETL trong 1 session
- **Tránh subquery phức tạp** — INSERT kết quả vào temp table, join ở bước sau
- **Isolate data** — mỗi session có bản temp riêng, không conflict

| So sánh | TEMP TABLE | UNLOGGED TABLE | TABLE thường |
| ------- | ---------- | -------------- | ------------ |
| Visibility | Chỉ session tạo ra | Tất cả sessions | Tất cả sessions |
| Tồn tại sau disconnect | ❌ | ✅ | ✅ |
| Ghi WAL | ❌ | ❌ | ✅ |
| Replicate | ❌ | ❌ | ✅ |
| Survive crash | ❌ | ❌ (truncated) | ✅ |

---

**56. Khi nào dùng Citus / Sharding?**

Khi **single PostgreSQL server không đủ** cho workload, cần **horizontal scaling**:

- **Data volume > vài TB** — một server không đủ disk I/O hoặc RAM cho working set
- **Write throughput cao** — single PostgreSQL bị bottleneck ở WAL write, cần phân tán write ra nhiều node
- **Query cần parallel trên nhiều node** — aggregation trên hàng tỷ row, cần distributed query execution

Citus (giờ là extension chính thức của PostgreSQL) phân phối data theo **distribution column**:

```sql
-- Tạo distributed table
SELECT create_distributed_table('orders', 'user_id');
-- orders được chia thành 32 shards (default) theo hash(user_id)

-- Query tự động route đến đúng shard
SELECT * FROM orders WHERE user_id = 42;  -- chỉ query 1 shard

-- Aggregate trên tất cả shards
SELECT status, COUNT(*) FROM orders GROUP BY status;
-- → chạy song song trên tất cả nodes → gộp kết quả
```

> [!TIP]
> Trước khi sharding, hãy tận dụng hết vertical scaling: tăng RAM (shared_buffers), SSD (giảm random I/O), read replicas, partitioning, materialized views. Sharding tăng complexity đáng kể.

---

**57. Khác biệt ANALYZE và auto_analyze?**

| Tiêu chí | `ANALYZE` (thủ công) | `auto_analyze` (tự động) |
| -------- | -------------------- | ------------------------ |
| Ai trigger | DBA chạy lệnh | Autovacuum daemon |
| Khi nào chạy | Bất cứ lúc nào | Khi `changed_tuples ≥ threshold + scale_factor × reltuples` |
| Scope | Có thể chọn table + column cụ thể | Toàn bộ table (autovacuum chọn) |
| Default scale factor | N/A | `autovacuum_analyze_scale_factor = 0.1` (10%) |
| Nên dùng khi | Sau bulk import, sau migration, khi biết data đã thay đổi nhiều | Để PostgreSQL tự quản lý thường ngày |

```sql
-- ANALYZE thủ công — chạy ngay, chọn table cụ thể
ANALYZE orders;
ANALYZE orders (status, created_at);  -- chỉ analyze 2 cột

-- Kiểm tra lần cuối auto_analyze chạy
SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze
FROM pg_stat_user_tables
ORDER BY n_mod_since_analyze DESC;
```

---

**58. Vì sao join không dùng index?**

3 nguyên nhân phổ biến khiến planner không dùng index cho JOIN:

**1. Function trên cột join:**
```sql
-- ❌ Index trên a.col không dùng được
SELECT * FROM a JOIN b ON UPPER(a.name) = b.name;

-- ✅ Fix: tạo expression index
CREATE INDEX idx ON a (UPPER(name));
```

**2. Implicit type cast:**
```sql
-- ❌ a.id là int, b.ref_id là bigint → PostgreSQL phải cast a.id sang bigint
SELECT * FROM a JOIN b ON a.id = b.ref_id;
-- Index trên a.id (int) không dùng được vì cast thành bigint

-- ✅ Fix: đảm bảo cùng type
ALTER TABLE b ALTER COLUMN ref_id TYPE int;
-- hoặc cast explicit trong query + tạo expression index
```

**3. Collation mismatch (cho text columns):**
```sql
-- ❌ Nếu 2 bảng dùng collation khác nhau
SELECT * FROM a JOIN b ON a.name = b.name;
-- Index dùng collation "en_US" nhưng query compare với collation "C" → không dùng được

-- ✅ Fix: đảm bảo cùng collation hoặc explicit COLLATE
```

---

**59. Khi nào dùng composite index?**

Composite index (multi-column index) hiệu quả khi query **filter theo nhiều cột cùng lúc**:

```sql
-- Query pattern thường xuyên:
SELECT * FROM orders
WHERE status = 'active' AND created_at > '2024-01-01'
ORDER BY created_at DESC;

-- Composite index phù hợp:
CREATE INDEX idx_status_created ON orders (status, created_at DESC);
```

**Quy tắc sắp xếp cột trong composite index:**

1. **Equality columns đứng trước** — cột dùng `=` đặt trước cột dùng range (`>`, `<`, `BETWEEN`)
2. **Selectivity cao đứng trước** — cột có nhiều distinct values hơn đặt trước (nhưng quy tắc 1 ưu tiên hơn)
3. **ORDER BY column đặt cuối** — nếu query có `ORDER BY`, đặt cột sort ở cuối index

```sql
-- Ví dụ: WHERE status = 'active' AND region = 'US' AND created_at > '2024-01-01'
-- ORDER BY created_at DESC

-- Index tốt nhất:
CREATE INDEX idx_composite ON orders (status, region, created_at DESC);
-- equality(status) → equality(region) → range+sort(created_at)
```

> [!IMPORTANT]
> Composite index `(a, b)` **có thể** dùng cho query filter chỉ `a`, nhưng **không thể** dùng cho query filter chỉ `b`. Thứ tự cột trong index quan trọng — nghĩ như mục lục sách: tìm theo "chương" trước rồi mới tìm "trang" trong chương đó.

---

**60. Interview case — slow query**

Đây là dạng câu hỏi tình huống — interviewer muốn thấy **quy trình tư duy có hệ thống**, không phải đoán mò:

**Bước 1 — Thu thập thông tin:**
```sql
-- Xem execution plan thực tế
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT ...;
```

**Bước 2 — Đọc plan và chẩn đoán:**

| Dấu hiệu trong plan | Chẩn đoán | Hành động |
| -------------------- | --------- | --------- |
| `Seq Scan` trên bảng lớn | Thiếu index phù hợp | Tạo index |
| `rows=1000` (estimated) vs `actual rows=500000` | Statistics lỗi thời | `ANALYZE table;` |
| `Hash Batches: 8` | `work_mem` không đủ cho hash join | Tăng `work_mem` cho session |
| `Nested Loop` với outer table lớn | Planner chọn sai join strategy | Kiểm tra statistics, tạo index cho inner table |
| `Sort Method: external merge Disk` | Sort spill to disk | Tăng `work_mem` |
| `Buffers: shared read=50000` (nhiều read, ít hit) | Cache miss — data không nằm trong RAM | Tăng `shared_buffers` hoặc cần index để giảm data scan |

**Bước 3 — Fix:**
```sql
-- 3a. Tạo index phù hợp (CONCURRENTLY để không block production)
CREATE INDEX CONCURRENTLY idx_orders_status_date
  ON orders (status, created_at)
  WHERE status IN ('ACTIVE', 'PENDING');  -- partial index nếu phù hợp

-- 3b. Cập nhật statistics
ANALYZE orders;

-- 3c. Tuning session parameters
SET work_mem = '256MB';
```

**Bước 4 — Verify:**
```sql
-- Chạy lại EXPLAIN ANALYZE, so sánh execution time trước/sau
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
-- Kiểm tra: index được sử dụng? rows estimated ≈ actual? time giảm?
```

**Bước 5 — Nếu vẫn chậm, xem xét rewrite SQL:**
- Subquery → JOIN hoặc CTE
- `NOT IN (subquery)` → `NOT EXISTS` (thường nhanh hơn)
- `DISTINCT` trên bảng lớn → `GROUP BY` hoặc window function
- Multi-join phức tạp → chia thành bước với temp table

---

## Bonus — Migrate Oracle → PostgreSQL

**41. Thay thế Oracle `CONNECT BY` (hierarchical query)**

Oracle dùng `CONNECT BY` cho hierarchical (tree) query. PostgreSQL dùng **Recursive CTE** — mạnh hơn và linh hoạt hơn:

```sql
-- Oracle:
SELECT id, parent_id, name, LEVEL
FROM categories
START WITH parent_id IS NULL
CONNECT BY PRIOR id = parent_id
ORDER SIBLINGS BY name;

-- PostgreSQL equivalent:
WITH RECURSIVE tree AS (
  -- Anchor: root nodes (tương đương START WITH)
  SELECT id, parent_id, name, 1 AS level
  FROM categories
  WHERE parent_id IS NULL

  UNION ALL

  -- Recursive: join child → parent (tương đương CONNECT BY)
  SELECT c.id, c.parent_id, c.name, t.level + 1
  FROM categories c
  JOIN tree t ON c.parent_id = t.id
)
SELECT * FROM tree
ORDER BY level, name;  -- ORDER SIBLINGS BY name
```

Các tính năng Oracle hierarchical query và cách thay thế:

| Oracle | PostgreSQL |
| ------ | ---------- |
| `LEVEL` | Thêm cột counter trong recursive CTE (`t.level + 1`) |
| `SYS_CONNECT_BY_PATH(name, '/')` | `string_agg` hoặc concat path thủ công trong CTE |
| `CONNECT_BY_ISLEAF` | `LEFT JOIN` check xem node có child không |
| `NOCYCLE` (tránh infinite loop) | Dùng mảng lưu path đã visit: `NOT (c.id = ANY(t.visited))` |

---

**42. Oracle `SEQUENCE.NEXTVAL` / `CURRVAL` → Postgres**

Cú pháp khác nhưng behavior tương tự:

```sql
-- Oracle:
INSERT INTO orders (id, name) VALUES (order_seq.NEXTVAL, 'Order 1');
SELECT order_seq.CURRVAL FROM DUAL;

-- PostgreSQL:
INSERT INTO orders (id, name) VALUES (nextval('order_seq'), 'Order 1');
SELECT currval('order_seq');  -- không cần FROM DUAL
```

Các lưu ý khi migrate:
- `CURRVAL` chỉ hoạt động **sau khi đã gọi `NEXTVAL`** trong cùng session (giống Oracle).
- PostgreSQL có `SERIAL` / `BIGSERIAL` / `GENERATED ALWAYS AS IDENTITY` — tự tạo sequence ngầm, nên ưu tiên dùng thay vì quản lý sequence thủ công:
  ```sql
  -- Modern PostgreSQL — thay vì sequence thủ công
  CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text
  );
  ```

---

**43. Oracle `MERGE INTO` → PostgreSQL**

**PostgreSQL 15+** hỗ trợ `MERGE` syntax chuẩn SQL:2008:

```sql
-- PostgreSQL 15+ — MERGE natively
MERGE INTO target t
USING source s ON t.id = s.id
WHEN MATCHED THEN
  UPDATE SET value = s.value, updated_at = NOW()
WHEN NOT MATCHED THEN
  INSERT (id, value) VALUES (s.id, s.value);
```

**PostgreSQL < 15** — dùng `INSERT ... ON CONFLICT` (UPSERT):

```sql
-- Chỉ hỗ trợ INSERT or UPDATE, không có DELETE branch
INSERT INTO target (id, value)
VALUES (1, 'new')
ON CONFLICT (id)
DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
-- EXCLUDED là pseudo-table chứa row muốn INSERT
```

| So sánh | `MERGE` (PG 15+) | `INSERT ON CONFLICT` |
| ------- | ----------------- | -------------------- |
| DELETE branch | ✅ `WHEN MATCHED AND ... THEN DELETE` | ❌ |
| Multiple source rows | ✅ `USING source_table` | ✅ `VALUES (...), (...)` |
| Bulk upsert từ table | ✅ Tự nhiên | Cần `INSERT INTO ... SELECT ... ON CONFLICT` |
| Trước PG 15 | ❌ | ✅ |

---

**44–46. Mapping nhanh các hàm Oracle → Postgres**

| Oracle | PostgreSQL | Ghi chú |
| ------ | ---------- | ------- |
| `NVL(a, b)` | `COALESCE(a, b)` | `COALESCE` hỗ trợ nhiều argument: `COALESCE(a, b, c, d)` |
| `NVL2(a, b, c)` | `CASE WHEN a IS NOT NULL THEN b ELSE c END` | Không có function tương đương trực tiếp |
| `DECODE(col, v1, r1, v2, r2, def)` | `CASE WHEN col = v1 THEN r1 WHEN col = v2 THEN r2 ELSE def END` | `DECODE` Oracle treat NULL = NULL (khác `CASE`) |
| `SYSDATE` | `NOW()` hoặc `CURRENT_TIMESTAMP` | `NOW()` trả `timestamptz`, `CURRENT_DATE` nếu chỉ cần date |
| `ROWNUM` | `ROW_NUMBER() OVER ()` hoặc `LIMIT` | `ROWNUM` Oracle gán trước ORDER BY, PG không có concept này |
| `ROWID` | `ctid` | `ctid` có thể thay đổi sau VACUUM, không nên dùng làm identifier |
| `Global Temp Table` | `CREATE TEMP TABLE ... ON COMMIT DELETE ROWS` | PG temp table tạo mới mỗi session, Oracle define 1 lần dùng nhiều session |
| `TO_DATE('...', 'fmt')` | `TO_DATE('...', 'fmt')` | Cú pháp tương tự, nhưng format tokens có thể khác (`MM` vs `mm`) |
| `TO_CHAR(number)` | `TO_CHAR(number, 'format')` | PG bắt buộc format string |
| `CONNECT BY` | `WITH RECURSIVE` | Xem câu 41 ở trên |
| `(+)` outer join | `LEFT JOIN` / `RIGHT JOIN` | Oracle `(+)` syntax không hỗ trợ trong PG |
| `LISTAGG(col, ',')` | `STRING_AGG(col, ',')` | Behavior tương tự |
| `SUBSTR(str, pos, len)` | `SUBSTRING(str FROM pos FOR len)` hoặc `SUBSTR(str, pos, len)` | PG cũng hỗ trợ `SUBSTR` |
