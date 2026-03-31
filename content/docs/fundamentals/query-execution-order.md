---
title: "Thứ tự thực thi SQL Query"
description: "Full pipeline database xử lý một câu SQL — từ lúc nhận text đến trả kết quả về client: parsing, optimization, execution, cleanup"
---

## Mục lục

- [Bạn viết vs Database chạy](#bạn-viết-vs-database-chạy)
- [Full Pipeline — Diagram tổng quan](#full-pipeline--diagram-tổng-quan)
- [Giai đoạn 1 — Trước khi thực thi](#giai-đoạn-1--trước-khi-thực-thi)
  - [Bước 1 — Parsing](#bước-1--parsing)
  - [Bước 2 — Semantic Analysis](#bước-2--semantic-analysis)
  - [Bước 3 — Query Rewriting](#bước-3--query-rewriting)
  - [Bước 4 — Optimization](#bước-4--optimization)
  - [Bước 5 — Plan Compilation](#bước-5--plan-compilation)
- [Giai đoạn 2 — Thực thi Query](#giai-đoạn-2--thực-thi-query)
  - [Bước 6 — FROM & JOIN](#bước-6--from--join)
  - [Bước 7 — WHERE](#bước-7--where)
  - [Bước 8 — GROUP BY](#bước-8--group-by)
  - [Bước 9 — HAVING](#bước-9--having)
  - [Bước 10 — SELECT](#bước-10--select)
  - [Bước 11 — Window Functions](#bước-11--window-functions)
  - [Bước 12 — DISTINCT](#bước-12--distinct)
  - [Bước 13 — ORDER BY](#bước-13--order-by)
  - [Bước 14 — LIMIT / OFFSET](#bước-14--limit--offset)
- [Giai đoạn 3 — Sau khi thực thi](#giai-đoạn-3--sau-khi-thực-thi)
  - [Bước 15 — Result Formatting](#bước-15--result-formatting)
  - [Bước 16 — Stats Update](#bước-16--stats-update)
  - [Bước 17 — Lock Release & Cleanup](#bước-17--lock-release--cleanup)
  - [Bước 18 — WAL Flush (Write queries)](#bước-18--wal-flush-write-queries)
- [Ví dụ thực tế end-to-end](#ví-dụ-thực-tế-end-to-end)
- [Những lỗi hay gặp do nhầm thứ tự](#những-lỗi-hay-gặp-do-nhầm-thứ-tự)
- [Tổng kết nhanh](#tổng-kết-nhanh)

---

## Bạn viết vs Database chạy

Khi bạn viết một câu SQL, bạn viết theo thứ tự này:

```sql
SELECT   ...
FROM     ...
JOIN     ...
WHERE    ...
GROUP BY ...
HAVING   ...
ORDER BY ...
LIMIT    ...
```

Nhưng database **không chỉ chạy 8 dòng đó**. Phía sau còn cả một pipeline dài hơn nhiều — từ lúc nhận chuỗi text đến lúc trả kết quả về client.

---

## Full Pipeline — Diagram tổng quan

```
Client gửi SQL text
        │
        ▼
┌───────────────────────────────────────────────────────────────────┐
│                   GIAI ĐOẠN 1: TRƯỚC THỰC THI                    │
│                                                                   │
│  ┌─────────────────┐                                             │
│  │  1. PARSING     │  Tokenize SQL → build Parse Tree            │
│  │                 │  kiểm tra syntax (dấu phẩy, ngoặc...)       │
│  └────────┬────────┘                                             │
│           │  Parse Tree                                          │
│           ▼                                                       │
│  ┌─────────────────┐                                             │
│  │  2. SEMANTIC    │  Validate tên bảng/cột có tồn tại?          │
│  │     ANALYSIS    │  User có quyền truy cập không?              │
│  │                 │  Data types có khớp không?                  │
│  └────────┬────────┘                                             │
│           │  Validated AST                                       │
│           ▼                                                       │
│  ┌─────────────────┐                                             │
│  │  3. QUERY       │  Expand SELECT * → tên cột cụ thể           │
│  │     REWRITING   │  Unfold VIEW → SQL gốc của view             │
│  │                 │  Transform subquery → JOIN nếu được         │
│  └────────┬────────┘                                             │
│           │  Logical Plan                                        │
│           ▼                                                       │
│  ┌─────────────────┐                                             │
│  │  4. OPTIMIZATION│  Cost-Based Optimizer (CBO) chạy:           │
│  │                 │  - Đọc table statistics (row count, NDV...)  │
│  │                 │  - Thử nhiều execution plan khác nhau        │
│  │                 │  - Chọn plan có estimated cost thấp nhất     │
│  │                 │  (chọn index nào, join order, join algo...)  │
│  └────────┬────────┘                                             │
│           │  Optimized Physical Plan                             │
│           ▼                                                       │
│  ┌─────────────────┐                                             │
│  │  5. PLAN        │  Compile plan thành bytecode/instructions   │
│  │     COMPILATION │  Cache plan (prepared statements)           │
│  └────────┬────────┘                                             │
└───────────┼───────────────────────────────────────────────────────┘
            │  Executable Plan
            ▼
┌───────────────────────────────────────────────────────────────────┐
│                   GIAI ĐOẠN 2: THỰC THI QUERY                    │
│                                                                   │
│  Thứ tự logic thực thi (không phải thứ tự bạn viết):             │
│                                                                   │
│   6. FROM / JOIN  ──→  Tạo bảng trung gian từ các bảng nguồn     │
│         │                                                         │
│         ▼                                                         │
│   7. WHERE        ──→  Lọc từng ROW (chưa có aggregate)          │
│         │                                                         │
│         ▼                                                         │
│   8. GROUP BY     ──→  Gom rows thành NHÓM                       │
│         │                                                         │
│         ▼                                                         │
│   9. HAVING       ──→  Lọc từng NHÓM (có aggregate)             │
│         │                                                         │
│         ▼                                                         │
│  10. SELECT       ──→  Tính toán cột, tạo alias                  │
│         │                                                         │
│         ▼                                                         │
│  11. WINDOW FUNC  ──→  ROW_NUMBER, RANK, LAG, SUM OVER...        │
│         │                                                         │
│         ▼                                                         │
│  12. DISTINCT     ──→  Loại bỏ row trùng lặp                     │
│         │                                                         │
│         ▼                                                         │
│  13. ORDER BY     ──→  Sắp xếp kết quả (có thể dùng alias)      │
│         │                                                         │
│         ▼                                                         │
│  14. LIMIT/OFFSET ──→  Cắt lấy số row cần thiết                 │
│                                                                   │
└───────────┬───────────────────────────────────────────────────────┘
            │  Result Set
            ▼
┌───────────────────────────────────────────────────────────────────┐
│                   GIAI ĐOẠN 3: SAU THỰC THI                      │
│                                                                   │
│  15. RESULT FORMATTING  ──→  Đóng gói rows/columns → wire format │
│         │                                                         │
│         ▼                                                         │
│  16. STATS UPDATE       ──→  Ghi lại execution time, rows read   │
│         │                    (dùng để optimizer học về sau)       │
│         ▼                                                         │
│  17. LOCK RELEASE       ──→  Giải phóng shared/row locks         │
│      & CLEANUP               Free memory, đóng cursor, trả buffer│
│         │                                                         │
│         ▼                                                         │
│  18. WAL FLUSH          ──→  (Chỉ write queries)                 │
│      (write only)            Flush WAL buffer → disk             │
│                              Báo commit success về client        │
└───────────┬───────────────────────────────────────────────────────┘
            │
            ▼
    Client nhận kết quả
```

---

## Giai đoạn 1 — Trước khi thực thi

### Bước 1 — Parsing

**Database làm gì:** Nhận chuỗi text SQL, chia thành các token (từ khóa, tên bảng, toán tử...), rồi build thành **Parse Tree** (cây cú pháp).

```
Input:  "SELECT name FROM users WHERE id = 1"
                │
                ▼
Tokenize: [SELECT] [name] [FROM] [users] [WHERE] [id] [=] [1]
                │
                ▼
Parse Tree:
    SELECT
    ├── columns: [name]
    ├── from: [users]
    └── where: id = 1
```

Nếu SQL sai cú pháp (thiếu dấu phẩy, thừa ngoặc...) → lỗi xảy ra **tại đây**, chưa chạm đến database.

```sql
-- Lỗi xảy ra ở bước Parsing — sai syntax
SELECT name age FROM users;   -- thiếu dấu phẩy
-- ERROR: syntax error at or near "age"
```

---

### Bước 2 — Semantic Analysis

**Database làm gì:** Kiểm tra xem những gì trong Parse Tree có **tồn tại và hợp lệ** không:

- Bảng `users` có tồn tại trong schema không?
- Cột `name` có thuộc bảng `users` không?
- User hiện tại có quyền `SELECT` trên bảng đó không?
- Kiểu dữ liệu có khớp không (`WHERE id = 'abc'` khi id là INT)?

```sql
-- Lỗi xảy ra ở bước Semantic Analysis — tên cột sai
SELECT username FROM users;
-- ERROR: column "username" does not exist
-- (cột đúng là "name")
```

---

### Bước 3 — Query Rewriting

**Database làm gì:** Biến đổi Logical Plan thành dạng tương đương nhưng dễ optimize hơn:

**Expand `SELECT *`:**
```sql
-- Bạn viết:
SELECT * FROM users

-- Sau rewriting:
SELECT id, name, email, created_at FROM users
```

**Unfold VIEW:**
```sql
-- Bạn viết:
SELECT * FROM active_users   -- active_users là VIEW

-- Sau rewriting (thay VIEW bằng SQL gốc):
SELECT * FROM (
  SELECT * FROM users WHERE is_active = true
) active_users
```

**Transform correlated subquery → JOIN:**
```sql
-- Bạn viết:
SELECT * FROM orders o
WHERE EXISTS (
  SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.vip = true
)

-- Sau rewriting (optimizer có thể chuyển thành):
SELECT o.* FROM orders o
JOIN customers c ON c.id = o.customer_id AND c.vip = true
```

---

### Bước 4 — Optimization

Đây là bước **tốn CPU nhất** trước khi thực thi. **Cost-Based Optimizer (CBO)** hoạt động:

1. **Đọc statistics** — số rows, data distribution, NDV (Number of Distinct Values), histogram của từng cột
2. **Sinh ra nhiều execution plan** — thử các cách khác nhau: index nào dùng, join theo thứ tự nào, dùng Hash Join hay Nested Loop hay Merge Join...
3. **Ước tính cost** cho mỗi plan (dựa trên I/O, CPU, memory)
4. **Chọn plan có cost thấp nhất**

```sql
-- Xem execution plan mà optimizer đã chọn:
EXPLAIN SELECT * FROM orders WHERE customer_id = 123;

-- Output (PostgreSQL):
-- Index Scan using idx_orders_customer_id on orders
--   Index Cond: (customer_id = 123)
--   cost=0.43..8.45 rows=1 width=100
```

> **Tại sao statistics quan trọng?** Nếu statistics lỗi thời (sau khi import lượng lớn data), optimizer không biết bảng đã có bao nhiêu rows → có thể chọn sai plan → query chậm. Fix bằng `ANALYZE` (PostgreSQL) hoặc `ANALYZE TABLE` (MySQL).

---

### Bước 5 — Plan Compilation

**Database làm gì:** Compile execution plan thành **bytecode** hoặc **instruction set** để executor chạy. Với **prepared statements**, plan được cache lại — lần sau gửi cùng query chỉ cần bind parameters mà không cần parse/optimize lại.

```sql
-- Prepared statement: parse + optimize chỉ 1 lần
PREPARE get_order AS
  SELECT * FROM orders WHERE id = $1;

-- Các lần execute sau chỉ cần bind param, không parse lại
EXECUTE get_order(42);
EXECUTE get_order(99);
```

---

## Giai đoạn 2 — Thực thi Query

### Bước 6 — FROM & JOIN

**Database làm gì:** Đọc dữ liệu từ tất cả bảng, thực hiện JOIN để tạo bảng trung gian.

```sql
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p  ON o.product_id  = p.id
```

Kết quả là một bảng khổng lồ chứa toàn bộ dữ liệu đã ghép. Mọi bước tiếp theo đều làm việc trên bảng trung gian này.

> **Optimizer thường thay đổi thứ tự JOIN** — không nhất thiết join theo thứ tự bạn viết. Nó sẽ join bảng nhỏ trước để kết quả trung gian nhỏ hơn.

---

### Bước 7 — WHERE

**Database làm gì:** Duyệt từng row, giữ lại row thỏa điều kiện.

```sql
WHERE o.status = 'completed'
  AND o.created_at >= '2024-01-01'
```

**Quan trọng:** GROUP BY chưa chạy → aggregate (`COUNT`, `SUM`...) chưa có giá trị → không thể dùng trong WHERE.

```sql
-- ❌ SAI: COUNT chưa được tính
WHERE COUNT(o.id) > 5

-- ✅ ĐÚNG
HAVING COUNT(o.id) > 5
```

---

### Bước 8 — GROUP BY

**Database làm gì:** Gom các row có cùng giá trị cột chỉ định thành nhóm.

```sql
GROUP BY c.id, c.name
```

Sau bước này aggregate functions (`COUNT`, `SUM`, `AVG`, `MAX`, `MIN`) mới có thể tính vì đã biết nhóm.

---

### Bước 9 — HAVING

**Database làm gì:** Lọc các **nhóm** (không phải row) dựa trên kết quả aggregate.

```sql
HAVING COUNT(o.id) > 5
   AND SUM(o.total_amount) > 1000000
```

| | WHERE | HAVING |
|---|---|---|
| Chạy ở bước | 7 (trước GROUP BY) | 9 (sau GROUP BY) |
| Lọc đơn vị | Từng **row** | Từng **nhóm** |
| Dùng aggregate? | ❌ Không | ✅ Có |
| Performance | Tốt hơn (bỏ row sớm) | Tốn hơn (đã gom rồi mới bỏ) |

> **Rule of thumb:** Điều kiện không cần aggregate → WHERE. Cần aggregate → HAVING.

---

### Bước 10 — SELECT

**Database làm gì:** Tính toán các cột cần trả về — expressions, alias, aggregate functions.

```sql
SELECT
  c.name,
  COUNT(o.id)          AS total_orders,
  SUM(o.total_amount)  AS revenue
```

Đây là lý do alias **chưa tồn tại** ở WHERE (bước 7) và HAVING (bước 9):

```sql
-- ❌ SAI: alias 'revenue' chưa được tạo ở bước WHERE
SELECT SUM(total_amount) AS revenue
FROM orders
WHERE revenue > 1000000

-- ✅ ĐÚNG
HAVING SUM(total_amount) > 1000000
```

---

### Bước 11 — Window Functions

**Database làm gì:** Tính các window functions (`ROW_NUMBER()`, `RANK()`, `LAG()`, `SUM() OVER()`...) trên tập kết quả sau SELECT.

```sql
SELECT
  name,
  salary,
  RANK() OVER (ORDER BY salary DESC) AS salary_rank
FROM employees
```

Window functions **không thể dùng trong WHERE hay HAVING** vì chúng chưa được tính ở đó:

```sql
-- ❌ Lỗi: window functions not allowed in WHERE
WHERE ROW_NUMBER() OVER (ORDER BY salary) <= 3

-- ✅ Fix: wrap trong subquery/CTE
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (ORDER BY salary DESC) AS rn
  FROM employees
) t
WHERE rn <= 3;
```

---

### Bước 12 — DISTINCT

**Database làm gì:** Loại bỏ các row hoàn toàn giống nhau.

```sql
SELECT DISTINCT c.city FROM customers c
```

DISTINCT chạy sau SELECT vì phải biết tập cột kết quả trước rồi mới so sánh được.

---

### Bước 13 — ORDER BY

**Database làm gì:** Sắp xếp tập kết quả.

```sql
ORDER BY revenue DESC, c.name ASC
```

ORDER BY chạy sau SELECT nên **có thể dùng alias**:

```sql
-- ✅ Hợp lệ
SELECT SUM(total_amount) AS revenue
FROM orders
GROUP BY customer_id
ORDER BY revenue DESC   -- alias đã tồn tại từ bước 10
```

---

### Bước 14 — LIMIT / OFFSET

**Database làm gì:** Cắt lấy số lượng row theo yêu cầu.

```sql
LIMIT 10 OFFSET 20   -- Lấy 10 row, bỏ 20 row đầu (trang 3)
```

> **Vấn đề với OFFSET lớn:** `OFFSET 10000 LIMIT 10` vẫn phải scan 10,010 rows rồi mới bỏ 10,000 đi. Dùng **keyset pagination** (`WHERE id > last_seen_id`) sẽ hiệu quả hơn.

---

## Giai đoạn 3 — Sau khi thực thi

### Bước 15 — Result Formatting

**Database làm gì:** Đóng gói result set thành wire format để truyền qua network về client — serialize rows, columns, data types theo protocol (PostgreSQL wire protocol, MySQL protocol...).

---

### Bước 16 — Stats Update

**Database làm gì:** Ghi lại thông tin về query vừa chạy vào system catalog:

- Execution time
- Rows examined / rows returned
- Buffer hits / misses

Đây là dữ liệu optimizer dùng để cải thiện plan cho các lần sau, và DBA dùng để tìm slow queries.

```sql
-- PostgreSQL: xem stats của các câu query đã chạy
SELECT query, calls, total_exec_time, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

---

### Bước 17 — Lock Release & Cleanup

**Database làm gì:**

- **Giải phóng lock** — shared lock, row-level lock đã giữ trong quá trình execute
- **Free memory** — giải phóng các buffer tạm, sort memory, hash table
- **Đóng cursor** — nếu query dùng cursor
- **Trả buffer về pool** — trả buffer pages về buffer pool để tái sử dụng

> **Lưu ý:** Với `READ COMMITTED`, lock row được giải phóng ngay sau khi đọc xong. Với `SERIALIZABLE`, lock giữ đến hết transaction.

---

### Bước 18 — WAL Flush (Write queries)

**Database làm gì:** Chỉ áp dụng cho INSERT/UPDATE/DELETE/DDL.

Trước khi báo `COMMIT` thành công về client, database phải đảm bảo **WAL (Write-Ahead Log)** đã được flush xuống disk — đây là cơ chế đảm bảo **Durability** trong ACID.

```
1. Execute: thay đổi data trong buffer pool (in-memory)
2. WAL record: ghi log vào WAL buffer
3. WAL flush: fsync WAL buffer → disk   ← bắt buộc trước COMMIT
4. Báo SUCCESS về client
5. (Sau đó) Background writer flush data page → disk
```

Nếu server crash sau bước 3 nhưng trước bước 5 → khi restart, database dùng WAL để **replay** lại thay đổi → không mất data.

---

## Ví dụ thực tế end-to-end

**Bài toán:** Tìm top 5 khách hàng VIP năm 2024 — ít nhất 3 đơn hoàn thành, tổng chi tiêu trên 10 triệu.

```sql
SELECT                                    -- Bước 10
    c.name,
    COUNT(o.id)         AS total_orders,
    SUM(o.total_amount) AS revenue
FROM orders o                             -- Bước 6
JOIN customers c ON o.customer_id = c.id  -- Bước 6
WHERE
    o.status     = 'completed'            -- Bước 7
    AND o.created_at >= '2024-01-01'      -- Bước 7
    AND o.created_at <  '2025-01-01'      -- Bước 7
GROUP BY c.id, c.name                     -- Bước 8
HAVING
    COUNT(o.id)         >= 3              -- Bước 9
    AND SUM(o.total_amount) > 10000000    -- Bước 9
ORDER BY revenue DESC                     -- Bước 13
LIMIT 5;                                  -- Bước 14
```

**Trace toàn bộ pipeline:**

```
[TRƯỚC THỰC THI]
  Parsing      → Build parse tree, check syntax ✓
  Semantic     → Xác nhận orders, customers tồn tại, user có quyền ✓
  Rewriting    → Không có VIEW/subquery cần unfold
  Optimization → CBO chọn: Index Scan trên idx_orders_status_date,
                 Hash Join với customers
  Compilation  → Compile plan thành instructions

[THỰC THI]
  Bước 6  FROM+JOIN  → Ghép orders + customers ~ 1,000,000 rows
  Bước 7  WHERE      → Lọc status+date → còn ~200,000 rows
  Bước 8  GROUP BY   → Gom thành ~15,000 nhóm khách hàng
  Bước 9  HAVING     → Giữ nhóm đủ điều kiện → còn ~800 nhóm
  Bước 10 SELECT     → Tính COUNT, SUM → 800 rows, 3 cột
  Bước 13 ORDER BY   → Sort 800 rows theo revenue DESC
  Bước 14 LIMIT      → Cắt lấy 5 rows đầu

[SAU THỰC THI]
  Formatting → Serialize 5 rows → wire format
  Stats      → Ghi execution time, rows_examined=200000
  Cleanup    → Release shared locks, free sort buffer
  (Không có WAL flush vì đây là SELECT)
```

---

## Những lỗi hay gặp do nhầm thứ tự

### Lỗi 1: Dùng alias trong WHERE

```sql
-- ❌ Lỗi: alias 'discounted' chưa tồn tại ở bước WHERE
SELECT price * 0.9 AS discounted
FROM products
WHERE discounted < 100;

-- ✅ Fix: lặp lại expression
SELECT price * 0.9 AS discounted
FROM products
WHERE price * 0.9 < 100;

-- ✅ Fix: dùng subquery/CTE
SELECT * FROM (
  SELECT price * 0.9 AS discounted FROM products
) t
WHERE t.discounted < 100;
```

### Lỗi 2: Dùng aggregate trong WHERE

```sql
-- ❌ Lỗi: aggregate functions not allowed in WHERE
SELECT customer_id, COUNT(*) AS cnt
FROM orders
WHERE COUNT(*) > 5
GROUP BY customer_id;

-- ✅ Fix
SELECT customer_id, COUNT(*) AS cnt
FROM orders
GROUP BY customer_id
HAVING COUNT(*) > 5;
```

### Lỗi 3: Dùng WHERE thay vì HAVING làm chậm query

```sql
-- ❌ Chậm: lọc attribute của row trong HAVING → phải gom hết rồi mới bỏ
SELECT customer_id, COUNT(*) AS cnt
FROM orders
GROUP BY customer_id
HAVING status = 'completed';

-- ✅ Nhanh: lọc trước GROUP BY → ít data hơn khi gom
SELECT customer_id, COUNT(*) AS cnt
FROM orders
WHERE status = 'completed'
GROUP BY customer_id;
```

### Lỗi 4: Statistics lỗi thời → optimizer chọn sai plan

```sql
-- Sau khi import lượng lớn data, chạy lại ANALYZE để cập nhật statistics
ANALYZE orders;              -- PostgreSQL
ANALYZE TABLE orders;        -- MySQL
EXEC sp_updatestats;         -- SQL Server
```

---

## Tổng kết nhanh

| Giai đoạn | Bước | Làm gì | Biết gì |
|-----------|------|--------|---------|
| **Trước** | 1. Parsing | Tokenize, build parse tree | Syntax hợp lệ chưa |
| | 2. Semantic | Validate bảng/cột/quyền | Schema, permissions |
| | 3. Rewriting | Expand *, unfold view | Logical plan |
| | 4. Optimization | Chọn execution plan tốt nhất | Statistics, indexes |
| | 5. Compilation | Compile → bytecode | Physical plan |
| **Thực thi** | 6. FROM/JOIN | Tạo bảng trung gian | Tất cả cột các bảng |
| | 7. WHERE | Lọc từng row | Cột gốc, **không** có aggregate/alias |
| | 8. GROUP BY | Gom row thành nhóm | Cột gốc |
| | 9. HAVING | Lọc từng nhóm | Cột gốc + aggregate, **không** có alias |
| | 10. SELECT | Tính cột, tạo alias | Mọi thứ — sinh ra alias |
| | 11. Window Func | ROW_NUMBER, RANK... | Kết quả SELECT |
| | 12. DISTINCT | Bỏ row trùng | Kết quả sau SELECT |
| | 13. ORDER BY | Sắp xếp | Kết quả SELECT + **alias ✅** |
| | 14. LIMIT/OFFSET | Cắt số row | Kết quả cuối |
| **Sau** | 15. Formatting | Serialize → wire format | Result set |
| | 16. Stats Update | Ghi execution stats | Cho optimizer học |
| | 17. Cleanup | Release lock, free memory | — |
| | 18. WAL Flush | Đảm bảo durability | Chỉ write queries |

> **Quy tắc vàng:** Muốn dùng một thứ ở mệnh đề X → hỏi *"Thứ đó đã tồn tại chưa ở bước X?"*. Nếu chưa → lỗi. Fix bằng subquery hoặc CTE để đẩy thứ đó về bước trước.
