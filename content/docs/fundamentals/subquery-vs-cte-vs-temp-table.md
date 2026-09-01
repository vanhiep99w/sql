---
title: "Subquery vs CTE vs Temp Table"
description: "Mổ xẻ chi tiết 3 cách tổ chức query phức tạp trong SQL — khi nào dùng subquery, khi nào CTE, khi nào temp table. Kèm execution plan, benchmark, recursive CTE, materialization trap, và real-world patterns."
---

## Mục lục

- [Bối cảnh: Khi một câu query 200 dòng không ai dám đụng vào](#1-bối-cảnh-khi-một-câu-query-200-dòng-không-ai-dám-đụng-vào)
- [3 công cụ — Cùng mục đích, khác bản chất](#2-3-công-cụ--cùng-mục-đích-khác-bản-chất)
- [Subquery — Nền tảng, linh hoạt, nhưng dễ thành mớ bòng bong](#3-subquery--nền-tảng-linh-hoạt-nhưng-dễ-thành-mớ-bòng-bong)
- [CTE — Đặt tên cho logic, đọc như văn xuôi](#4-cte--đặt-tên-cho-logic-đọc-như-văn-xuôi)
- [Temp Table — Materialized thật sự, bạn kiểm soát hoàn toàn](#5-temp-table--materialized-thật-sự-bạn-kiểm-soát-hoàn-toàn)
- [So sánh Execution Plan: cùng logic, 3 cách viết, 3 plan khác nhau?](#6-so-sánh-execution-plan-cùng-logic-3-cách-viết-3-plan-khác-nhau)
- [CTE Materialization — Cái bẫy hiệu năng ít người biết](#7-cte-materialization--cái-bẫy-hiệu-năng-ít-người-biết)
- [Recursive CTE — Sức mạnh mà subquery và temp table không có](#8-recursive-cte--sức-mạnh-mà-subquery-và-temp-table-không-có)
- [Subquery trong SELECT / WHERE / FROM — 3 vị trí, 3 hành vi](#9-subquery-trong-select--where--from--3-vị-trí-3-hành-vi)
- [Real-world patterns — 10 tình huống thực tế](#10-real-world-patterns--10-tình-huống-thực-tế)
- [So sánh giữa Postgres / MySQL / Oracle / SQL Server](#11-so-sánh-giữa-postgres--mysql--oracle--sql-server)
- [Anti-patterns cần tránh](#12-anti-patterns-cần-tránh)
- [Decision Framework — Flowchart chọn công cụ đúng](#13-decision-framework--flowchart-chọn-công-cụ-đúng)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#14-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Bối cảnh: Khi một câu query 200 dòng không ai dám đụng vào

Bạn join team mới, được giao maintain một report query. Mở file ra thấy:

```sql
SELECT
    u.id,
    u.name,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_orders,
    (SELECT SUM(total) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS total_revenue,
    (SELECT AVG(total) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS avg_order,
    (SELECT MAX(created_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at,
    (SELECT name FROM products p
     WHERE p.id = (
         SELECT oi.product_id FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.user_id = u.id
         GROUP BY oi.product_id ORDER BY COUNT(*) DESC LIMIT 1
     )
    ) AS favorite_product
FROM users u
WHERE u.created_at >= '2024-01-01'
  AND EXISTS (
      SELECT 1 FROM orders o
      WHERE o.user_id = u.id
        AND o.status IN ('paid','shipped','delivered')
        AND o.total > (
            SELECT AVG(total) FROM orders WHERE status = 'paid'
        )
  )
ORDER BY total_revenue DESC
LIMIT 50;
```

**5 correlated subqueries** trong SELECT, **2 nested subqueries** trong WHERE, **không có comment**. Mỗi subquery chạy cho **mỗi row** của outer query. Trên bảng 2 triệu users → hàng triệu lần thực thi.

PM hỏi: "Thêm cột `most_bought_category` được không?" — Bạn nhìn query, thở dài, và tự hỏi: **"Có cách nào viết lại cho dễ đọc, dễ sửa, mà vẫn nhanh không?"**

Câu trả lời: **Có — và bạn có 3 công cụ để chọn.**

> [!IMPORTANT]
> **Subquery**, **CTE**, và **Temp Table** giải quyết cùng một vấn đề: **tổ chức logic phức tạp thành các phần nhỏ hơn**. Nhưng chúng khác nhau về cách optimizer xử lý, performance, scope, và khả năng đọc. Chọn sai công cụ → query chậm hoặc code khó maintain.

Trong doc này, ta sẽ:

1. Phân tích **bản chất** từng công cụ — không chỉ syntax.
2. So sánh **execution plan** thực tế cho cùng một logic.
3. Vạch trần **CTE materialization trap** — khi CTE chậm hơn subquery.
4. Khám phá **Recursive CTE** — thứ mà subquery và temp table không làm được.
5. Đưa ra **decision framework** rõ ràng để chọn đúng công cụ trong từng tình huống.

---

## 2. 3 công cụ — Cùng mục đích, khác bản chất

Trước khi đi sâu, hãy nhìn tổng quan:

```diagram
╭───────────────────────────────────────────────────────────────╮
│  Subquery                                                     │
│  ─────────                                                    │
│  • Là một SELECT lồng trong SELECT/WHERE/FROM khác            │
│  • Không có tên riêng (trừ khi dùng alias trong FROM)         │
│  • Optimizer có thể inline, flatten, hoặc materialize         │
│  • Scope: chỉ tồn tại trong câu query chứa nó                 │
│                                                               │
│  CTE (Common Table Expression)                                │
│  ─────────────────────────────                                │
│  • WITH ... AS (...) — đặt tên cho một block logic            │
│  • Có thể tham chiếu nhiều lần trong query chính              │
│  • Có thể recursive (đệ quy)                                  │
│  • Scope: chỉ tồn tại trong câu query ngay sau WITH           │
│                                                               │
│  Temp Table                                                   │
│  ──────────                                                   │
│  • CREATE TEMP TABLE hoặc SELECT INTO                         │
│  • Data được ghi vào disk (hoặc memory) thật sự               │
│  • Có thể đánh index, ANALYZE, dùng ở nhiều query             │
│  • Scope: tồn tại đến hết session (hoặc transaction)          │
╰───────────────────────────────────────────────────────────────╯
```

| Tiêu chí | Subquery | CTE | Temp Table |
|----------|----------|-----|------------|
| Đặt tên cho logic | ❌ (chỉ alias) | ✅ Tên rõ ràng | ✅ Tên bảng |
| Tái sử dụng trong cùng query | ❌ Phải viết lại | ✅ Tham chiếu nhiều lần | ✅ Dùng nhiều query |
| Tái sử dụng **cross-query** | ❌ | ❌ | ✅ |
| Đánh index | ❌ | ❌ | ✅ |
| Recursive | ❌ | ✅ | ❌ (phải loop thủ công) |
| Optimizer có thể inline | ✅ | ⚠️ Tùy DB và version | ❌ (đã materialized) |
| Overhead tạo | Không | Không | Có (CREATE + INSERT) |
| Khi nào dùng | Logic đơn giản, 1 lần | Logic phức tạp, đọc dễ, recursive | Data lớn, cần index, dùng nhiều lần |

---

## 3. Subquery — Nền tảng, linh hoạt, nhưng dễ thành mớ bòng bong

### 3.1. Subquery là gì?

Subquery là một **SELECT hoàn chỉnh** được đặt bên trong một query khác. Nó có thể xuất hiện ở 3 vị trí:

```sql
-- 1. Trong FROM (Derived Table / Inline View)
SELECT * FROM (SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id) AS order_counts;

-- 2. Trong WHERE
SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE status = 'paid');

-- 3. Trong SELECT (Scalar Subquery)
SELECT u.name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
FROM users u;
```

### 3.2. Optimizer xử lý subquery như thế nào

Đây là phần **quan trọng nhất** — không phải cú pháp, mà là **cách database thực thi**.

#### Derived Table (FROM subquery) — Thường được flatten

```sql
SELECT u.name, oc.cnt
FROM users u
JOIN (SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id) oc
  ON oc.user_id = u.id;
```

Hầu hết optimizer **flatten** (phẳng hóa) derived table — merge nó vào query chính:

```text
 Hash Join  (actual time=234.567..456.789 rows=1500000 loops=1)
   Hash Cond: (u.id = orders.user_id)
   ->  Seq Scan on users u  (actual time=0.008..45.678 rows=2000000 loops=1)
   ->  Hash  (actual time=189.012..189.012 rows=1500000 loops=1)
         ->  HashAggregate  (actual time=98.765..156.789 rows=1500000 loops=1)
               Group Key: orders.user_id
               ->  Seq Scan on orders  (actual time=0.006..56.789 rows=20000000 loops=1)
 Execution Time: 478.901 ms
```

Optimizer nhìn thấy **một query phẳng** — không có "subquery" nào cả trong plan.

#### WHERE subquery — Có thể trở thành Semi Join

```sql
SELECT * FROM users u
WHERE u.id IN (SELECT user_id FROM orders WHERE status = 'paid');
```

Postgres convert thành **Semi Join**:

```text
 Hash Semi Join  (actual time=45.678..234.567 rows=1200000 loops=1)
   Hash Cond: (u.id = orders.user_id)
   ->  Seq Scan on users u  (actual time=0.008..34.567 rows=2000000 loops=1)
   ->  Hash  (actual time=23.456..23.456 rows=850000 loops=1)
         ->  Seq Scan on orders  (actual time=0.006..15.678 rows=850000 loops=1)
               Filter: (status = 'paid')
 Execution Time: 245.678 ms
```

> [!NOTE]
> **Semi Join** nghĩa là: với mỗi row bên trái, chỉ cần tìm thấy **1 row match** bên phải là đủ — không cần duyệt hết. Đây là optimization tự động, bạn **không cần viết JOIN** — `IN (SELECT ...)` đã đủ.

#### Scalar Subquery (SELECT) — Chạy mỗi row = nguy hiểm

```sql
SELECT u.name,
       (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
FROM users u;
```

```text
 Seq Scan on users u  (actual time=0.012..8945.678 rows=2000000 loops=1)
   SubPlan 1
     ->  Aggregate  (actual time=0.003..0.004 rows=1 loops=2000000)
           ->  Index Scan using idx_orders_user_id on orders o
                 (actual time=0.002..0.003 rows=10 loops=2000000)
                 Index Cond: (user_id = u.id)
 Execution Time: 8967.890 ms
```

`loops=2000000` — subquery chạy **2 triệu lần**. Mỗi lần nhanh (0.004ms) nhưng nhân lên = **~9 giây**.

### 3.3. Ưu điểm của Subquery

| Ưu điểm | Giải thích |
|----------|-----------|
| **Optimizer có toàn quyền** | Có thể flatten, convert thành JOIN, reorder — linh hoạt nhất |
| **Không overhead syntax** | Viết nhanh cho logic đơn giản |
| **Mọi DB đều hỗ trợ** | SQL-92 standard, hoạt động ở mọi nơi |
| **Inline = ít side effect** | Không tạo object tạm, không cần cleanup |

### 3.4. Nhược điểm của Subquery

| Nhược điểm | Giải thích |
|------------|-----------|
| **Khó đọc khi lồng sâu** | 3+ level nesting → code review nightmare |
| **Không tái sử dụng** | Cùng logic dùng 2 lần → phải copy-paste |
| **Scalar subquery = correlated trap** | Chạy mỗi row nếu optimizer không optimize |
| **Debug khó** | Không thể chạy riêng phần subquery dễ dàng (phải copy ra) |

---

## 4. CTE — Đặt tên cho logic, đọc như văn xuôi

### 4.1. CTE là gì?

CTE (Common Table Expression) dùng keyword `WITH` để **đặt tên** cho một block logic, rồi tham chiếu nó trong query chính:

```sql
WITH paid_orders AS (
    SELECT user_id, COUNT(*) AS cnt, SUM(total) AS revenue
    FROM orders
    WHERE status = 'paid'
    GROUP BY user_id
)
SELECT u.name, po.cnt, po.revenue
FROM users u
JOIN paid_orders po ON po.user_id = u.id
ORDER BY po.revenue DESC
LIMIT 50;
```

Đọc **từ trên xuống**: "Đầu tiên, tính paid_orders. Sau đó, JOIN với users." — logic rõ ràng như đọc văn xuôi.

### 4.2. Nhiều CTE — Pipeline processing

CTE mạnh nhất khi bạn **chain** nhiều bước:

```sql
WITH
-- Bước 1: Lọc đơn hàng đã thanh toán
paid_orders AS (
    SELECT id, user_id, total, created_at
    FROM orders
    WHERE status = 'paid'
      AND created_at >= '2024-01-01'
),

-- Bước 2: Tính metrics per user
user_metrics AS (
    SELECT
        user_id,
        COUNT(*) AS order_count,
        SUM(total) AS total_revenue,
        AVG(total) AS avg_order_value,
        MAX(created_at) AS last_order_at
    FROM paid_orders
    GROUP BY user_id
),

-- Bước 3: Phân loại user
user_segments AS (
    SELECT
        user_id,
        order_count,
        total_revenue,
        avg_order_value,
        last_order_at,
        CASE
            WHEN total_revenue >= 10000 AND order_count >= 20 THEN 'VIP'
            WHEN total_revenue >= 5000 OR order_count >= 10 THEN 'Regular'
            ELSE 'New'
        END AS segment
    FROM user_metrics
)

-- Query chính
SELECT u.name, u.email, s.*
FROM user_segments s
JOIN users u ON u.id = s.user_id
WHERE s.segment = 'VIP'
ORDER BY s.total_revenue DESC;
```

So sánh nếu viết bằng **subquery lồng**:

```sql
SELECT u.name, u.email, s.*
FROM (
    SELECT
        user_id, order_count, total_revenue, avg_order_value, last_order_at,
        CASE
            WHEN total_revenue >= 10000 AND order_count >= 20 THEN 'VIP'
            WHEN total_revenue >= 5000 OR order_count >= 10 THEN 'Regular'
            ELSE 'New'
        END AS segment
    FROM (
        SELECT
            user_id,
            COUNT(*) AS order_count,
            SUM(total) AS total_revenue,
            AVG(total) AS avg_order_value,
            MAX(created_at) AS last_order_at
        FROM (
            SELECT id, user_id, total, created_at
            FROM orders
            WHERE status = 'paid'
              AND created_at >= '2024-01-01'
        ) paid_orders
        GROUP BY user_id
    ) user_metrics
) s
JOIN users u ON u.id = s.user_id
WHERE s.segment = 'VIP'
ORDER BY s.total_revenue DESC;
```

> [!WARNING]
> Cùng logic, cùng kết quả — nhưng bản subquery **đọc từ trong ra ngoài** (inside-out), còn CTE **đọc từ trên xuống** (top-down). Với 3+ bước logic, CTE **dễ đọc hơn nhiều lần**.

### 4.3. CTE tham chiếu nhiều lần — DRY principle

Khi cùng một kết quả cần dùng ở **nhiều chỗ**:

```sql
WITH monthly_revenue AS (
    SELECT
        DATE_TRUNC('month', created_at) AS month,
        SUM(total) AS revenue
    FROM orders
    WHERE status = 'paid'
    GROUP BY DATE_TRUNC('month', created_at)
)
SELECT
    curr.month,
    curr.revenue AS current_revenue,
    prev.revenue AS previous_revenue,
    ROUND((curr.revenue - prev.revenue) / prev.revenue * 100, 2) AS growth_pct
FROM monthly_revenue curr
LEFT JOIN monthly_revenue prev
  ON prev.month = curr.month - INTERVAL '1 month'
ORDER BY curr.month;
```

`monthly_revenue` được dùng **2 lần** — một lần cho tháng hiện tại, một lần cho tháng trước. Với subquery, bạn phải **viết lại toàn bộ logic** 2 lần:

```sql
-- Subquery: phải copy-paste logic
SELECT
    curr.month,
    curr.revenue,
    prev.revenue AS previous_revenue,
    ROUND((curr.revenue - prev.revenue) / prev.revenue * 100, 2) AS growth_pct
FROM (
    SELECT DATE_TRUNC('month', created_at) AS month, SUM(total) AS revenue
    FROM orders WHERE status = 'paid'
    GROUP BY DATE_TRUNC('month', created_at)
) curr
LEFT JOIN (
    SELECT DATE_TRUNC('month', created_at) AS month, SUM(total) AS revenue
    FROM orders WHERE status = 'paid'
    GROUP BY DATE_TRUNC('month', created_at)
) prev ON prev.month = curr.month - INTERVAL '1 month'
ORDER BY curr.month;
```

> [!TIP]
> Khi cùng logic cần dùng **≥ 2 lần** trong query → CTE là lựa chọn tự nhiên. Nó đảm bảo logic **nhất quán** và dễ maintain — sửa 1 chỗ thay vì 2.

### 4.4. Ưu điểm của CTE

| Ưu điểm | Giải thích |
|----------|-----------|
| **Đọc top-down** | Logic chảy từ trên xuống, dễ theo dõi |
| **Tái sử dụng** | Tham chiếu nhiều lần trong cùng query — không copy-paste |
| **Debug dễ** | Chạy riêng từng CTE block để kiểm tra kết quả |
| **Recursive** | Hỗ trợ đệ quy — duyệt cây, graph, hierarchy |
| **Self-documenting** | Tên CTE mô tả logic: `paid_orders`, `user_metrics`, `user_segments` |

### 4.5. Nhược điểm của CTE

| Nhược điểm | Giải thích |
|------------|-----------|
| **Materialization trap** (xem mục 7) | Một số DB materialize CTE → chặn optimization |
| **Không đánh index được** | Kết quả CTE không có index → JOIN lớn có thể chậm |
| **Scope giới hạn** | Chỉ dùng trong query ngay sau WITH — không dùng ở query khác |
| **Không phải lúc nào cũng nhanh hơn** | Optimizer có thể xử lý subquery tốt hơn CTE (tùy DB) |

---

## 5. Temp Table — Materialized thật sự, bạn kiểm soát hoàn toàn

### 5.1. Temp Table là gì?

Temp Table là **bảng tạm** tồn tại trong session (hoặc transaction). Data được ghi vào disk/memory thật sự — bạn có thể đánh index, ANALYZE, và dùng trong nhiều query.

```sql
-- Cách 1: CREATE + INSERT
CREATE TEMP TABLE tmp_paid_orders AS
SELECT user_id, COUNT(*) AS cnt, SUM(total) AS revenue
FROM orders
WHERE status = 'paid'
GROUP BY user_id;

-- Đánh index cho JOIN hiệu quả
CREATE INDEX idx_tmp_paid_user ON tmp_paid_orders(user_id);

-- Cập nhật statistics để optimizer có thông tin chính xác
ANALYZE tmp_paid_orders;

-- Dùng trong nhiều query
SELECT u.name, t.cnt, t.revenue
FROM users u
JOIN tmp_paid_orders t ON t.user_id = u.id
ORDER BY t.revenue DESC LIMIT 50;

-- Dùng lại ở query khác
SELECT segment, COUNT(*), AVG(revenue)
FROM (
    SELECT CASE
        WHEN revenue >= 10000 THEN 'VIP'
        WHEN revenue >= 5000 THEN 'Regular'
        ELSE 'New'
    END AS segment, revenue
    FROM tmp_paid_orders
) x
GROUP BY segment;
```

### 5.2. Temp Table trên các DB

| Feature | PostgreSQL | MySQL | Oracle | SQL Server |
|---------|-----------|-------|--------|------------|
| Syntax tạo | `CREATE TEMP TABLE` | `CREATE TEMPORARY TABLE` | `CREATE GLOBAL TEMPORARY TABLE` | `CREATE TABLE #tmp` / `SELECT INTO #tmp` |
| Scope mặc định | Session | Session | Định nghĩa persistent, data per-transaction hoặc per-session | Session (`#`) hoặc Global (`##`) |
| Có thể đánh index | ✅ | ✅ | ✅ | ✅ |
| ANALYZE/UPDATE STATISTICS | ✅ | ✅ (tự động) | ✅ | ✅ |
| Lưu ở đâu | `pg_temp` schema, disk | `tmpdir`, disk | Tablespace riêng | `tempdb`, disk |
| Auto-cleanup | Cuối session | Cuối session | Tùy config (`ON COMMIT`) | Cuối session |

### 5.3. Khi nào Temp Table vượt trội

#### Case 1: Kết quả trung gian dùng nhiều lần

```sql
-- Tính 1 lần, dùng 5 lần
CREATE TEMP TABLE tmp_user_stats AS
SELECT user_id,
       COUNT(*) AS order_count,
       SUM(total) AS revenue,
       AVG(total) AS avg_order,
       MAX(created_at) AS last_order
FROM orders
WHERE created_at >= '2024-01-01'
GROUP BY user_id;

CREATE INDEX ON tmp_user_stats(user_id);
ANALYZE tmp_user_stats;

-- Query 1: Top users by revenue
SELECT u.name, s.revenue FROM users u JOIN tmp_user_stats s ON s.user_id = u.id ORDER BY s.revenue DESC LIMIT 10;

-- Query 2: Phân phối order count
SELECT order_count, COUNT(*) AS user_count FROM tmp_user_stats GROUP BY order_count ORDER BY order_count;

-- Query 3: Users chưa mua hàng gần đây
SELECT u.name, s.last_order FROM users u JOIN tmp_user_stats s ON s.user_id = u.id WHERE s.last_order < NOW() - INTERVAL '90 days';

-- Query 4: Correlation revenue vs order count
SELECT CORR(order_count, revenue) AS correlation FROM tmp_user_stats;

-- Cleanup
DROP TABLE tmp_user_stats;
```

Với CTE hoặc subquery, logic `SELECT ... FROM orders GROUP BY user_id` phải **chạy lại từ đầu** cho mỗi query — aggregate 20 triệu rows **4 lần**. Temp table chạy **1 lần** duy nhất.

#### Case 2: Dataset trung gian lớn cần index

```sql
-- 500,000 rows kết quả — cần JOIN hiệu quả
CREATE TEMP TABLE tmp_active_products AS
SELECT p.id, p.name, p.category_id, p.price,
       SUM(oi.quantity) AS total_sold
FROM products p
JOIN order_items oi ON oi.product_id = p.id
JOIN orders o ON o.id = oi.order_id
WHERE o.created_at >= '2024-01-01'
GROUP BY p.id, p.name, p.category_id, p.price;

-- Index để JOIN nhanh
CREATE INDEX ON tmp_active_products(category_id);
CREATE INDEX ON tmp_active_products(total_sold DESC);
ANALYZE tmp_active_products;

-- Giờ các query phân tích chạy trên 500K rows (có index) thay vì JOIN 80M order_items
```

### 5.4. Ưu điểm của Temp Table

| Ưu điểm | Giải thích |
|----------|-----------|
| **Đánh index** | Tối ưu JOIN/WHERE trên kết quả trung gian |
| **ANALYZE** | Optimizer có statistics chính xác → plan tốt hơn |
| **Cross-query** | Dùng trong nhiều query khác nhau |
| **Materialized thật sự** | Data đã tính xong, không tính lại |
| **Kiểm soát hoàn toàn** | Bạn quyết định lưu gì, index gì, khi nào xóa |

### 5.5. Nhược điểm của Temp Table

| Nhược điểm | Giải thích |
|------------|-----------|
| **Overhead tạo** | CREATE + INSERT + INDEX + ANALYZE tốn thời gian |
| **Disk I/O** | Ghi ra disk (trừ khi fit trong memory) |
| **Quản lý lifecycle** | Phải nhớ DROP hoặc dùng `ON COMMIT DROP` |
| **Transaction log** | INSERT vào temp table vẫn ghi WAL (Postgres) → overhead |
| **Không dùng trong View** | View không chấp nhận DDL statements |
| **Nhiều bước** | Phải viết CREATE, INSERT, INDEX riêng — code dài hơn |

---

## 6. So sánh Execution Plan: cùng logic, 3 cách viết, 3 plan khác nhau?

Hãy lấy một bài toán cụ thể: **"Lấy top 20 users có revenue cao nhất từ đầu năm 2024, kèm tên và email."**

### 6.1. Subquery

```sql
SELECT u.name, u.email, sub.revenue
FROM users u
JOIN (
    SELECT user_id, SUM(total) AS revenue
    FROM orders
    WHERE status = 'paid' AND created_at >= '2024-01-01'
    GROUP BY user_id
) sub ON sub.user_id = u.id
ORDER BY sub.revenue DESC
LIMIT 20;
```

Postgres plan:

```text
 Limit  (actual time=456.789..456.823 rows=20 loops=1)
   ->  Sort  (actual time=456.787..456.812 rows=20 loops=1)
         Sort Key: (sum(orders.total)) DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Hash Join  (actual time=234.567..423.456 rows=980000 loops=1)
               Hash Cond: (orders.user_id = u.id)
               ->  HashAggregate  (actual time=189.012..345.678 rows=980000 loops=1)
                     Group Key: orders.user_id
                     ->  Seq Scan on orders  (actual time=0.008..98.765 rows=8500000 loops=1)
                           Filter: ((status = 'paid') AND (created_at >= '2024-01-01'))
               ->  Hash  (actual time=34.567..34.567 rows=2000000 loops=1)
                     ->  Seq Scan on users u  (actual time=0.006..22.345 rows=2000000 loops=1)
 Execution Time: 457.234 ms
```

### 6.2. CTE

```sql
WITH user_revenue AS (
    SELECT user_id, SUM(total) AS revenue
    FROM orders
    WHERE status = 'paid' AND created_at >= '2024-01-01'
    GROUP BY user_id
)
SELECT u.name, u.email, ur.revenue
FROM users u
JOIN user_revenue ur ON ur.user_id = u.id
ORDER BY ur.revenue DESC
LIMIT 20;
```

Postgres 12+ plan (CTE inlined):

```text
 Limit  (actual time=458.123..458.156 rows=20 loops=1)
   ->  Sort  (actual time=458.121..458.145 rows=20 loops=1)
         Sort Key: (sum(orders.total)) DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Hash Join  (actual time=235.678..424.567 rows=980000 loops=1)
               Hash Cond: (orders.user_id = u.id)
               ->  HashAggregate  (actual time=190.123..346.789 rows=980000 loops=1)
                     Group Key: orders.user_id
                     ->  Seq Scan on orders  (actual time=0.009..99.876 rows=8500000 loops=1)
                           Filter: ((status = 'paid') AND (created_at >= '2024-01-01'))
               ->  Hash  (actual time=34.789..34.789 rows=2000000 loops=1)
                     ->  Seq Scan on users u  (actual time=0.007..22.567 rows=2000000 loops=1)
 Execution Time: 458.567 ms
```

> [!NOTE]
> Trên Postgres 12+, plan **gần như giống hệt** subquery — vì optimizer **inline** CTE (flatten nó vào query chính). CTE chỉ là syntax sugar, không tạo barrier cho optimization.

### 6.3. Temp Table

```sql
CREATE TEMP TABLE tmp_revenue AS
SELECT user_id, SUM(total) AS revenue
FROM orders
WHERE status = 'paid' AND created_at >= '2024-01-01'
GROUP BY user_id;

CREATE INDEX ON tmp_revenue(user_id);
ANALYZE tmp_revenue;

SELECT u.name, u.email, t.revenue
FROM users u
JOIN tmp_revenue t ON t.user_id = u.id
ORDER BY t.revenue DESC
LIMIT 20;
```

Plan cho query cuối:

```text
 Limit  (actual time=0.089..0.234 rows=20 loops=1)
   ->  Sort  (actual time=0.087..0.223 rows=20 loops=1)
         Sort Key: t.revenue DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Nested Loop  (actual time=0.023..178.456 rows=980000 loops=1)
               ->  Seq Scan on tmp_revenue t  (actual time=0.006..45.678 rows=980000 loops=1)
               ->  Index Scan using users_pkey on users u  (actual time=0.002..0.002 rows=1 loops=980000)
                     Index Cond: (id = t.user_id)
 Execution Time: 189.345 ms
```

Nhưng **tổng thời gian** bao gồm cả CREATE + INDEX + ANALYZE:

| Bước | Thời gian |
|------|-----------|
| CREATE TEMP TABLE (aggregate 8.5M rows) | ~280 ms |
| CREATE INDEX | ~120 ms |
| ANALYZE | ~15 ms |
| SELECT query | ~189 ms |
| **Tổng** | **~604 ms** |

### 6.4. So sánh tổng kết

| Cách | Query time | Tổng time | Plan quality | Đọc dễ? |
|------|-----------|-----------|-------------|---------|
| Subquery | 457 ms | 457 ms | ✅ Optimizer tự quyết | Trung bình |
| CTE (inlined) | 458 ms | 458 ms | ✅ Giống subquery | ✅ Tốt |
| Temp Table | 189 ms (query) | 604 ms (tổng) | ✅ Có index | ✅ Tốt |

> [!IMPORTANT]
> Với **1 query duy nhất**, subquery và CTE thường nhanh hơn temp table vì không có overhead CREATE/INDEX. Temp table chỉ lợi khi **dùng kết quả nhiều lần** — lúc đó chi phí tạo được "trả hết" từ lần dùng thứ 2 trở đi.

---

## 7. CTE Materialization — Cái bẫy hiệu năng ít người biết

### 7.1. CTE trước Postgres 12 — Luôn materialized

Trước Postgres 12 (và hiện tại trên một số DB khác), CTE luôn bị **materialized** — nghĩa là database:

1. **Chạy CTE trước**, lưu toàn bộ kết quả vào bộ nhớ tạm
2. **Rồi mới chạy** query chính, đọc từ kết quả đã lưu

Hậu quả: optimizer **không thể push down** filter từ query chính vào CTE.

```sql
WITH all_orders AS (
    SELECT * FROM orders        -- 20 triệu rows
)
SELECT * FROM all_orders
WHERE user_id = 12345           -- chỉ cần ~10 rows
  AND status = 'paid';
```

**Nếu materialized:**

```text
 CTE Scan on all_orders  (actual time=2345.678..4567.890 rows=8 loops=1)
   Filter: ((user_id = 12345) AND (status = 'paid'))
   Rows Removed by Filter: 19999992
   CTE all_orders
     ->  Seq Scan on orders  (actual time=0.008..1234.567 rows=20000000 loops=1)
 Execution Time: 4568.234 ms
```

Database đọc **20 triệu rows** vào memory, rồi filter còn 8. Nếu viết trực tiếp:

```sql
SELECT * FROM orders WHERE user_id = 12345 AND status = 'paid';
```

```text
 Index Scan using idx_orders_user_id on orders
   (actual time=0.023..0.045 rows=8 loops=1)
   Index Cond: (user_id = 12345)
   Filter: (status = 'paid')
 Execution Time: 0.068 ms
```

**4,568ms vs 0.068ms** — chênh lệch **67,000 lần** — chỉ vì CTE bị materialized.

### 7.2. Postgres 12+ — Inline by default (nhưng có ngoại lệ)

Từ Postgres 12, optimizer **tự quyết** inline hay materialize CTE:

| Điều kiện | Optimizer chọn | Lý do |
|-----------|---------------|-------|
| CTE dùng **1 lần**, không recursive, không side effect | **Inline** | Cho phép push down filter, join reorder |
| CTE dùng **≥ 2 lần** | **Materialize** | Tránh tính lại nhiều lần |
| CTE có **side effect** (INSERT/UPDATE/DELETE) | **Materialize** | Đảm bảo thực thi đúng 1 lần |
| CTE **recursive** | **Materialize** | Bắt buộc — cần lưu trạng thái giữa các iteration |

### 7.3. Kiểm soát thủ công: MATERIALIZED / NOT MATERIALIZED

```sql
-- Ép materialized (Postgres 12+)
WITH heavy_calc AS MATERIALIZED (
    SELECT user_id, SUM(total) AS revenue
    FROM orders
    WHERE status = 'paid'
    GROUP BY user_id
)
SELECT * FROM heavy_calc WHERE revenue > 10000;

-- Ép inline (Postgres 12+)
WITH quick_filter AS NOT MATERIALIZED (
    SELECT * FROM orders WHERE status = 'pending'
)
SELECT * FROM quick_filter WHERE user_id = 12345;
```

> [!TIP]
> Dùng `MATERIALIZED` khi:
> - CTE tính toán **nặng** và bạn dùng kết quả **nhiều lần**
> - Bạn muốn **cố định** kết quả trung gian (snapshot)
>
> Dùng `NOT MATERIALIZED` khi:
> - Query chính có **filter mạnh** mà cần push down vào CTE
> - CTE chỉ dùng 1 lần nhưng optimizer vẫn materialize (hiếm trên Postgres 12+)

### 7.4. MySQL — CTE luôn materialized (đến MySQL 8.0.14)

MySQL materialized **mọi CTE** cho đến gần đây. Từ MySQL 8.0.14+, MySQL bắt đầu **merge** (inline) CTE trong một số trường hợp — nhưng vẫn kém aggressive hơn Postgres.

Kiểm tra bằng EXPLAIN:

```text
-- MySQL: nếu thấy `<derived2>` hoặc `<subquery2>` → materialized
-- Nếu thấy CTE được merge vào query chính → inlined

EXPLAIN FORMAT=TREE
WITH cte AS (SELECT * FROM orders WHERE status='paid')
SELECT * FROM cte WHERE user_id = 12345;
```

### 7.5. Oracle — Luôn có quyền inline

Oracle **rất aggressive** khi inline CTE. Nó coi CTE gần như subquery — trừ khi bạn dùng hint `/*+ MATERIALIZE */`:

```sql
-- Oracle: ép materialize
WITH heavy AS (
    SELECT /*+ MATERIALIZE */ user_id, SUM(total) AS revenue
    FROM orders GROUP BY user_id
)
SELECT * FROM heavy WHERE revenue > 10000;

-- Oracle: ép inline
WITH light AS (
    SELECT /*+ INLINE */ * FROM orders WHERE status = 'paid'
)
SELECT * FROM light WHERE user_id = 12345;
```

### 7.6. Bảng so sánh CTE materialization

| DB | Mặc định | Inline khi nào? | Kiểm soát thủ công |
|----|---------|----------------|-------------------|
| **Postgres <12** | Luôn materialize | Không bao giờ | Không có |
| **Postgres 12+** | Inline nếu dùng 1 lần | Tự động, smart | `MATERIALIZED` / `NOT MATERIALIZED` |
| **MySQL <8.0.14** | Luôn materialize | Không bao giờ | Không có |
| **MySQL 8.0.14+** | Merge nếu đơn giản | Hạn chế | Không có keyword, dùng optimizer hint |
| **Oracle** | Inline mặc định | Aggressive | `/*+ MATERIALIZE */` / `/*+ INLINE */` |
| **SQL Server** | Inline mặc định | Aggressive | Không có keyword trực tiếp |

---

## 8. Recursive CTE — Sức mạnh mà subquery và temp table không có

### 8.1. Vấn đề: Duyệt dữ liệu phân cấp

Bảng `categories` có cấu trúc cây:

```sql
CREATE TABLE categories (
    id        INT PRIMARY KEY,
    name      VARCHAR(100) NOT NULL,
    parent_id INT REFERENCES categories(id)
);

INSERT INTO categories VALUES
(1, 'Electronics', NULL),
(2, 'Computers', 1),
(3, 'Laptops', 2),
(4, 'Gaming Laptops', 3),
(5, 'Business Laptops', 3),
(6, 'Desktops', 2),
(7, 'Phones', 1),
(8, 'Smartphones', 7),
(9, 'Feature Phones', 7),
(10, 'Clothing', NULL),
(11, 'Men', 10),
(12, 'Shirts', 11);
```

```diagram
╭───────────────────────────────────────────────────╮
│  Electronics (1)                                  │
│  ├── Computers (2)                                │
│  │   ├── Laptops (3)                              │
│  │   │   ├── Gaming Laptops (4)                   │
│  │   │   └── Business Laptops (5)                 │
│  │   └── Desktops (6)                             │
│  └── Phones (7)                                   │
│      ├── Smartphones (8)                          │
│      └── Feature Phones (9)                       │
│                                                   │
│  Clothing (10)                                    │
│  └── Men (11)                                     │
│      └── Shirts (12)                              │
╰───────────────────────────────────────────────────╯
```

**Bài toán**: Lấy tất cả subcategories của "Electronics" (bao gồm chính nó) — bất kể sâu bao nhiêu level.

Subquery **không thể làm được** (vì không biết trước bao nhiêu level). Temp table phải dùng **loop thủ công**. Recursive CTE giải quyết **elegant**.

### 8.2. Cách viết Recursive CTE

```sql
WITH RECURSIVE category_tree AS (
    -- Base case: bắt đầu từ "Electronics"
    SELECT id, name, parent_id, 0 AS depth, name::TEXT AS path
    FROM categories
    WHERE id = 1

    UNION ALL

    -- Recursive case: tìm con của mỗi node đã tìm được
    SELECT c.id, c.name, c.parent_id, ct.depth + 1, ct.path || ' > ' || c.name
    FROM categories c
    JOIN category_tree ct ON c.parent_id = ct.id
)
SELECT * FROM category_tree ORDER BY path;
```

Kết quả:

```text
 id | name              | parent_id | depth | path
----+-------------------+-----------+-------+-------------------------------------------
  1 | Electronics       |    (null) |     0 | Electronics
  2 | Computers         |         1 |     1 | Electronics > Computers
  6 | Desktops          |         2 |     2 | Electronics > Computers > Desktops
  3 | Laptops           |         2 |     2 | Electronics > Computers > Laptops
  5 | Business Laptops  |         3 |     3 | Electronics > Computers > Laptops > Business Laptops
  4 | Gaming Laptops    |         3 |     3 | Electronics > Computers > Laptops > Gaming Laptops
  7 | Phones            |         1 |     1 | Electronics > Phones
  9 | Feature Phones    |         7 |     2 | Electronics > Phones > Feature Phones
  8 | Smartphones       |         7 |     2 | Electronics > Phones > Smartphones
```

### 8.3. Cách Recursive CTE hoạt động — Step by step

```diagram
╭───────────────────────────────────────────────────────────────╮
│  Iteration 0 (Base case):                                     │
│    Working table: {Electronics}                               │
│    Result: {Electronics}                                      │
│                                                               │
│  Iteration 1:                                                 │
│    Tìm con của {Electronics} → {Computers, Phones}            │
│    Working table: {Computers, Phones}                         │
│    Result: {Electronics, Computers, Phones}                   │
│                                                               │
│  Iteration 2:                                                 │
│    Tìm con của {Computers, Phones}                            │
│    → {Laptops, Desktops, Smartphones, Feature Phones}         │
│    Working table: {Laptops, Desktops, Smartphones, ...}       │
│    Result: + {Laptops, Desktops, Smartphones, Feature Phones} │
│                                                               │
│  Iteration 3:                                                 │
│    Tìm con của {Laptops, Desktops, ...}                       │
│    → {Gaming Laptops, Business Laptops}                       │
│    Working table: {Gaming Laptops, Business Laptops}          │
│    Result: + {Gaming Laptops, Business Laptops}               │
│                                                               │
│  Iteration 4:                                                 │
│    Tìm con của {Gaming Laptops, Business Laptops}             │
│    → {} (không có con)                                        │
│    Working table: {} → DỪNG                                   │
╰───────────────────────────────────────────────────────────────╯
```

> [!IMPORTANT]
> Recursive CTE dừng khi **working table rỗng** — không còn row mới nào được tạo ra. Nếu data có **cycle** (A → B → A), CTE sẽ **chạy vô hạn**. Phải thêm guard:

```sql
WITH RECURSIVE category_tree AS (
    SELECT id, name, parent_id, 0 AS depth, ARRAY[id] AS visited
    FROM categories WHERE id = 1

    UNION ALL

    SELECT c.id, c.name, c.parent_id, ct.depth + 1, ct.visited || c.id
    FROM categories c
    JOIN category_tree ct ON c.parent_id = ct.id
    WHERE c.id != ALL(ct.visited)    -- guard chống cycle
      AND ct.depth < 20             -- giới hạn độ sâu
)
SELECT * FROM category_tree;
```

### 8.4. Ứng dụng thực tế của Recursive CTE

| Bài toán | Mô tả |
|----------|-------|
| **Duyệt cây category** | Lấy tất cả con/cháu của một node |
| **Org chart** | Tìm tất cả nhân viên dưới quyền một manager |
| **BOM (Bill of Materials)** | Liệt kê tất cả linh kiện cấu thành sản phẩm |
| **Đường đi ngắn nhất** | BFS trên graph trong database |
| **Số Fibonacci / Series** | Sinh dãy số — ít thực tế nhưng hay để học |
| **Date series** | Tạo dãy ngày liên tục để LEFT JOIN (fill gaps) |

#### Ví dụ: Tạo date series để fill gaps

```sql
WITH RECURSIVE date_series AS (
    SELECT DATE '2024-01-01' AS dt

    UNION ALL

    SELECT dt + INTERVAL '1 day'
    FROM date_series
    WHERE dt < DATE '2024-12-31'
)
SELECT ds.dt, COALESCE(o.revenue, 0) AS revenue
FROM date_series ds
LEFT JOIN (
    SELECT DATE(created_at) AS dt, SUM(total) AS revenue
    FROM orders
    WHERE status = 'paid' AND created_at >= '2024-01-01'
    GROUP BY DATE(created_at)
) o ON o.dt = ds.dt
ORDER BY ds.dt;
```

> [!TIP]
> Trên Postgres, `generate_series()` thay thế recursive CTE cho date series — nhanh hơn và gọn hơn:
> ```sql
> SELECT dt::DATE FROM generate_series('2024-01-01', '2024-12-31', '1 day'::INTERVAL) AS dt;
> ```
> Nhưng trên MySQL/Oracle không có `generate_series`, recursive CTE là cách duy nhất.

### 8.5. So sánh: Recursive CTE vs Loop với Temp Table

```sql
-- Cách temp table + loop (không dùng recursive CTE)
CREATE TEMP TABLE tmp_tree (id INT, name VARCHAR(100), depth INT);
INSERT INTO tmp_tree SELECT id, name, 0 FROM categories WHERE id = 1;

-- Loop thủ công
DO $$
DECLARE
    current_depth INT := 0;
    rows_found INT := 1;
BEGIN
    WHILE rows_found > 0 AND current_depth < 20 LOOP
        INSERT INTO tmp_tree
        SELECT c.id, c.name, current_depth + 1
        FROM categories c
        JOIN tmp_tree t ON c.parent_id = t.id AND t.depth = current_depth;

        GET DIAGNOSTICS rows_found = ROW_COUNT;
        current_depth := current_depth + 1;
    END LOOP;
END $$;

SELECT * FROM tmp_tree ORDER BY depth, name;
DROP TABLE tmp_tree;
```

| Tiêu chí | Recursive CTE | Temp Table + Loop |
|----------|---------------|-------------------|
| Số dòng code | ~10 | ~20 |
| Trong 1 statement | ✅ | ❌ (cần procedural block) |
| Dùng trong VIEW | ✅ | ❌ |
| Performance | Tương đương | Tương đương (đôi khi nhanh hơn nếu đánh index) |
| Đọc dễ | ✅ | ❌ |
| Portable | ✅ (SQL:1999 standard) | ❌ (syntax procedural khác nhau mỗi DB) |

---

## 9. Subquery trong SELECT / WHERE / FROM — 3 vị trí, 3 hành vi

### 9.1. Subquery trong FROM (Derived Table)

```sql
SELECT u.name, oc.order_count
FROM users u
JOIN (
    SELECT user_id, COUNT(*) AS order_count
    FROM orders GROUP BY user_id
) oc ON oc.user_id = u.id;
```

**Hành vi**: Optimizer thường **flatten** — merge subquery vào query chính. Performance **tương đương JOIN trực tiếp**.

**Khi nào dùng**: Cần aggregate trước rồi JOIN — tránh nhân bản rows.

### 9.2. Subquery trong WHERE

#### IN / NOT IN

```sql
-- Semi Join — optimizer tự convert
SELECT * FROM users
WHERE id IN (SELECT user_id FROM orders WHERE total > 1000);

-- Anti Join — dùng NOT EXISTS thay NOT IN (xem bài Query Optimization Patterns)
SELECT * FROM users
WHERE NOT EXISTS (
    SELECT 1 FROM orders WHERE user_id = users.id
);
```

#### EXISTS / NOT EXISTS

```sql
-- EXISTS: chỉ cần 1 row match → dừng
SELECT * FROM products p
WHERE EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.product_id = p.id AND oi.quantity > 100
);
```

**Hành vi**: `EXISTS` là **short-circuit** — tìm thấy 1 row là dừng, không scan hết subquery. Rất hiệu quả cho check tồn tại.

#### Scalar comparison

```sql
-- So sánh với 1 giá trị
SELECT * FROM orders
WHERE total > (SELECT AVG(total) FROM orders WHERE status = 'paid');
```

**Hành vi**: Subquery chạy **1 lần** (non-correlated), kết quả cache lại cho mọi row. Nhanh.

### 9.3. Subquery trong SELECT (Scalar)

```sql
SELECT
    u.name,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
FROM users u;
```

**Hành vi**: Chạy **mỗi row** của outer query (correlated). **Nguy hiểm** khi outer query trả nhiều rows.

### 9.4. Bảng tổng hợp

| Vị trí | Loại | Correlated? | Optimizer xử lý | Performance risk |
|--------|------|------------|-----------------|-----------------|
| FROM | Derived Table | Không | Flatten / Merge | Thấp |
| WHERE + IN | Semi Join | Không | Hash Semi Join | Thấp |
| WHERE + EXISTS | Semi Join | Có | Nested Loop Semi Join | Thấp (short-circuit) |
| WHERE + scalar | Comparison | Không | Run once, cache | Thấp |
| WHERE + correlated scalar | Comparison | Có | Nested Loop | **Cao** |
| SELECT + scalar | Scalar | Có | Nested Loop | **Cao** |

> [!WARNING]
> Correlated scalar subquery trong **SELECT** là nơi **nguy hiểm nhất**. Nếu outer query trả 1M rows, subquery chạy **1M lần**. Luôn cân nhắc **JOIN + GROUP BY** thay thế.

---

## 10. Real-world patterns — 10 tình huống thực tế

### Pattern 1: Running total — CTE wins

```sql
-- Doanh thu tích lũy theo ngày
WITH daily_revenue AS (
    SELECT DATE(created_at) AS day, SUM(total) AS revenue
    FROM orders
    WHERE status = 'paid' AND created_at >= '2024-01-01'
    GROUP BY DATE(created_at)
)
SELECT
    day,
    revenue,
    SUM(revenue) OVER (ORDER BY day) AS running_total
FROM daily_revenue
ORDER BY day;
```

**Tại sao CTE**: Logic rõ ràng — tính daily trước, running total sau. Window function `SUM() OVER` chạy trên kết quả đã aggregate.

### Pattern 2: De-duplication — Subquery wins

```sql
-- Lấy đơn hàng gần nhất của mỗi user
SELECT * FROM orders o
WHERE o.id = (
    SELECT o2.id FROM orders o2
    WHERE o2.user_id = o.user_id
    ORDER BY o2.created_at DESC LIMIT 1
);

-- Hoặc dùng ROW_NUMBER (CTE cũng OK):
WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
    FROM orders
)
SELECT * FROM ranked WHERE rn = 1;
```

**CTE với ROW_NUMBER** thường **dễ đọc hơn** và optimizer handle tốt.

### Pattern 3: Multi-step ETL report — Temp Table wins

```sql
-- Step 1: Aggregate orders
CREATE TEMP TABLE tmp_order_agg AS
SELECT user_id,
       COUNT(*) AS order_count,
       SUM(total) AS revenue,
       AVG(total) AS avg_order
FROM orders WHERE created_at >= '2024-01-01'
GROUP BY user_id;
CREATE INDEX ON tmp_order_agg(user_id);

-- Step 2: Aggregate order items
CREATE TEMP TABLE tmp_product_agg AS
SELECT oi.product_id,
       SUM(oi.quantity) AS total_sold,
       SUM(oi.quantity * oi.unit_price) AS product_revenue
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.created_at >= '2024-01-01'
GROUP BY oi.product_id;
CREATE INDEX ON tmp_product_agg(product_id);

-- Step 3: Multiple reports from pre-aggregated data
-- Report A: Top users
SELECT u.name, t.revenue FROM users u JOIN tmp_order_agg t ON t.user_id = u.id ORDER BY t.revenue DESC LIMIT 20;

-- Report B: Top products
SELECT p.name, t.total_sold, t.product_revenue FROM products p JOIN tmp_product_agg t ON t.product_id = p.id ORDER BY t.product_revenue DESC LIMIT 20;

-- Report C: Cross analysis
SELECT u.name, p.name AS top_product, t.revenue
FROM tmp_order_agg t
JOIN users u ON u.id = t.user_id
JOIN LATERAL (
    SELECT p.name FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN orders o ON o.id = oi.order_id
    WHERE o.user_id = t.user_id
    GROUP BY p.name ORDER BY SUM(oi.quantity) DESC LIMIT 1
) p ON true
ORDER BY t.revenue DESC LIMIT 20;

-- Cleanup
DROP TABLE tmp_order_agg, tmp_product_agg;
```

**Tại sao Temp Table**: 2 aggregate tables, mỗi cái dùng trong **nhiều reports**. Tính 1 lần, dùng nhiều lần.

### Pattern 4: Conditional aggregation — CTE pipeline

```sql
WITH
order_data AS (
    SELECT user_id, total, status, created_at,
           DATE_TRUNC('month', created_at) AS month
    FROM orders
    WHERE created_at >= '2024-01-01'
),
monthly AS (
    SELECT month, user_id,
           COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancel_count,
           SUM(total) FILTER (WHERE status = 'paid') AS paid_revenue
    FROM order_data
    GROUP BY month, user_id
)
SELECT month,
       COUNT(DISTINCT user_id) AS active_users,
       SUM(paid_count) AS total_paid,
       SUM(cancel_count) AS total_cancelled,
       SUM(paid_revenue) AS total_revenue,
       ROUND(SUM(cancel_count)::NUMERIC / NULLIF(SUM(paid_count + cancel_count), 0) * 100, 2) AS cancel_rate
FROM monthly
GROUP BY month
ORDER BY month;
```

### Pattern 5: Pagination with total count — CTE tái sử dụng

```sql
WITH filtered_orders AS (
    SELECT id, user_id, total, status, created_at
    FROM orders
    WHERE status = 'paid'
      AND created_at >= '2024-01-01'
      AND total > 100
)
SELECT
    (SELECT COUNT(*) FROM filtered_orders) AS total_count,
    fo.*
FROM filtered_orders fo
ORDER BY fo.created_at DESC
LIMIT 20 OFFSET 0;
```

**Tại sao CTE**: filter logic viết **1 lần**, dùng cho cả `COUNT(*)` và kết quả phân trang. Đảm bảo filter **nhất quán**.

> [!NOTE]
> Lưu ý: trên Postgres 12+, CTE này sẽ được **inlined** — nghĩa là filter chạy 2 lần (1 cho count, 1 cho data). Nếu filter nặng, dùng `MATERIALIZED` để tránh tính lại:
> ```sql
> WITH filtered_orders AS MATERIALIZED (...)
> ```

### Pattern 6: Gap detection — Recursive CTE

```sql
-- Tìm ngày không có đơn hàng
WITH RECURSIVE all_dates AS (
    SELECT DATE '2024-01-01' AS dt
    UNION ALL
    SELECT dt + 1 FROM all_dates WHERE dt < DATE '2024-12-31'
),
order_dates AS (
    SELECT DISTINCT DATE(created_at) AS dt
    FROM orders
    WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'
)
SELECT ad.dt AS missing_date
FROM all_dates ad
LEFT JOIN order_dates od ON od.dt = ad.dt
WHERE od.dt IS NULL
ORDER BY ad.dt;
```

### Pattern 7: Before/After comparison — CTE readable

```sql
WITH
before AS (
    SELECT product_id, AVG(unit_price) AS avg_price, SUM(quantity) AS total_qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= '2024-01-01' AND o.created_at < '2024-07-01'
    GROUP BY product_id
),
after AS (
    SELECT product_id, AVG(unit_price) AS avg_price, SUM(quantity) AS total_qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= '2024-07-01' AND o.created_at < '2025-01-01'
    GROUP BY product_id
)
SELECT p.name,
       b.avg_price AS price_h1, a.avg_price AS price_h2,
       ROUND((a.avg_price - b.avg_price) / b.avg_price * 100, 2) AS price_change_pct,
       b.total_qty AS qty_h1, a.total_qty AS qty_h2
FROM before b
JOIN after a ON a.product_id = b.product_id
JOIN products p ON p.id = b.product_id
ORDER BY price_change_pct DESC
LIMIT 20;
```

### Pattern 8: Cumulative distinct — CTE + Window

```sql
-- Số user mới mỗi ngày (chưa từng mua hàng trước đó)
WITH first_order AS (
    SELECT user_id, MIN(DATE(created_at)) AS first_day
    FROM orders
    WHERE status = 'paid'
    GROUP BY user_id
)
SELECT first_day, COUNT(*) AS new_users,
       SUM(COUNT(*)) OVER (ORDER BY first_day) AS cumulative_users
FROM first_order
GROUP BY first_day
ORDER BY first_day;
```

### Pattern 9: Recursive bill of materials — Recursive CTE

```sql
-- Tính tổng chi phí sản xuất 1 sản phẩm (tất cả linh kiện)
WITH RECURSIVE bom AS (
    SELECT part_id, component_id, quantity, 1 AS level
    FROM bill_of_materials
    WHERE part_id = 1001  -- sản phẩm gốc

    UNION ALL

    SELECT b.part_id, b.component_id, b.quantity * bom.quantity, bom.level + 1
    FROM bill_of_materials b
    JOIN bom ON b.part_id = bom.component_id
    WHERE bom.level < 10  -- giới hạn
)
SELECT c.name, SUM(bom.quantity) AS total_needed, c.unit_cost,
       SUM(bom.quantity * c.unit_cost) AS total_cost
FROM bom
JOIN components c ON c.id = bom.component_id
GROUP BY c.id, c.name, c.unit_cost
ORDER BY total_cost DESC;
```

### Pattern 10: Stored procedure — Temp Table wins

```sql
-- Trong stored procedure, temp table tồn tại xuyên suốt
CREATE OR REPLACE FUNCTION generate_monthly_report(report_month DATE)
RETURNS TABLE(metric TEXT, value NUMERIC) AS $$
BEGIN
    CREATE TEMP TABLE tmp_month_orders ON COMMIT DROP AS
    SELECT * FROM orders
    WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', report_month)
      AND status = 'paid';

    CREATE INDEX ON tmp_month_orders(user_id);

    RETURN QUERY
    SELECT 'total_orders'::TEXT, COUNT(*)::NUMERIC FROM tmp_month_orders
    UNION ALL
    SELECT 'total_revenue', SUM(total) FROM tmp_month_orders
    UNION ALL
    SELECT 'unique_users', COUNT(DISTINCT user_id)::NUMERIC FROM tmp_month_orders
    UNION ALL
    SELECT 'avg_order_value', ROUND(AVG(total), 2) FROM tmp_month_orders;
END;
$$ LANGUAGE plpgsql;
```

---

## 11. So sánh giữa Postgres / MySQL / Oracle / SQL Server

| Feature | PostgreSQL | MySQL | Oracle | SQL Server |
|---------|-----------|-------|--------|------------|
| **CTE syntax** | ✅ WITH ... AS | ✅ WITH ... AS (8.0+) | ✅ WITH ... AS | ✅ WITH ... AS |
| **Recursive CTE** | ✅ `WITH RECURSIVE` | ✅ `WITH RECURSIVE` (8.0+) | ✅ (không cần keyword `RECURSIVE`) | ✅ (không cần keyword `RECURSIVE`) |
| **CTE inline/materialize** | Inline by default (12+) | Merge nếu đơn giản (8.0.14+) | Inline by default | Inline by default |
| **Kiểm soát materialize** | `MATERIALIZED` / `NOT MATERIALIZED` | Không có keyword | `/*+ MATERIALIZE */` / `/*+ INLINE */` | Không có keyword |
| **CTE max recursion** | Không giới hạn (guard thủ công) | `cte_max_recursion_depth` (default 1000) | Không giới hạn | `OPTION (MAXRECURSION N)` (default 100) |
| **Temp Table syntax** | `CREATE TEMP TABLE` | `CREATE TEMPORARY TABLE` | `CREATE GLOBAL TEMPORARY TABLE` | `#table_name` / `##global_table` |
| **Temp Table in CTE** | ❌ | ❌ | ❌ | ❌ |
| **CTE in VIEW** | ✅ | ✅ (8.0+) | ✅ | ✅ |
| **CTE in INSERT/UPDATE/DELETE** | ✅ (writeable CTE) | ❌ (read-only CTE) | ✅ (DML in CTE) | ✅ |
| **Subquery in FROM flatten** | ✅ Aggressive | ✅ (derived merge) | ✅ | ✅ |
| **IN subquery → Semi Join** | ✅ Tự động | ✅ (5.6+, với `semijoin=on`) | ✅ | ✅ |

> [!TIP]
> **Postgres** có ưu thế lớn nhất với CTE: kiểm soát materialize rõ ràng, writeable CTE (INSERT/UPDATE/DELETE trong CTE), và inline aggressive từ version 12. **MySQL** bắt kịp từ 8.0 nhưng vẫn hạn chế hơn.

### Writeable CTE — Postgres exclusive power

```sql
-- Xóa orders cũ và trả về chi tiết
WITH deleted_orders AS (
    DELETE FROM orders
    WHERE status = 'cancelled' AND created_at < '2023-01-01'
    RETURNING *
)
SELECT COUNT(*) AS deleted_count, SUM(total) AS total_value
FROM deleted_orders;

-- Upsert pattern
WITH new_data AS (
    SELECT * FROM (VALUES
        ('user1@test.com', 'User 1', '0901234567'),
        ('user2@test.com', 'User 2', '0907654321')
    ) AS t(email, name, phone)
),
upserted AS (
    INSERT INTO users (email, name, phone)
    SELECT * FROM new_data
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone
    RETURNING *
)
SELECT * FROM upserted;
```

---

## 12. Anti-patterns cần tránh

### Anti-pattern 1: CTE cho mọi thứ — "CTE addiction"

```sql
-- ❌ CTE thừa — chỉ wrap lại SELECT đơn giản
WITH all_users AS (
    SELECT * FROM users
)
SELECT * FROM all_users WHERE created_at >= '2024-01-01';

-- ✅ Viết thẳng
SELECT * FROM users WHERE created_at >= '2024-01-01';
```

CTE chỉ hữu ích khi nó **đặt tên cho logic phức tạp** hoặc **tái sử dụng**. Wrap một `SELECT *` đơn giản là **overhead đọc code** không cần thiết — và trên Postgres <12 hoặc MySQL cũ, nó còn chặn optimizer push filter.

### Anti-pattern 2: Scalar subquery thay vì JOIN

```sql
-- ❌ Scalar subquery — chạy mỗi row
SELECT
    o.id,
    o.total,
    (SELECT u.name FROM users u WHERE u.id = o.user_id) AS user_name,
    (SELECT u.email FROM users u WHERE u.id = o.user_id) AS user_email
FROM orders o;

-- ✅ JOIN — 1 lần lookup
SELECT o.id, o.total, u.name AS user_name, u.email AS user_email
FROM orders o
JOIN users u ON u.id = o.user_id;
```

> [!NOTE]
> Một số optimizer (Postgres, Oracle) **có thể** optimize scalar subquery thành JOIN tự động. Nhưng đừng dựa vào optimizer — viết JOIN từ đầu rõ ràng và đảm bảo hơn.

### Anti-pattern 3: Temp Table cho logic đơn giản

```sql
-- ❌ Tạo temp table khi chỉ dùng 1 lần
CREATE TEMP TABLE tmp AS
SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id;
SELECT * FROM tmp WHERE cnt > 10;
DROP TABLE tmp;

-- ✅ Subquery hoặc CTE — gọn hơn, ít overhead
SELECT * FROM (
    SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id
) t WHERE cnt > 10;

-- Hoặc HAVING
SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id HAVING COUNT(*) > 10;
```

### Anti-pattern 4: Recursive CTE không có guard

```sql
-- ❌ NGUY HIỂM — nếu data có cycle → infinite loop
WITH RECURSIVE tree AS (
    SELECT id, parent_id FROM categories WHERE id = 1
    UNION ALL
    SELECT c.id, c.parent_id FROM categories c JOIN tree t ON c.parent_id = t.id
)
SELECT * FROM tree;

-- ✅ An toàn — có depth limit và cycle detection
WITH RECURSIVE tree AS (
    SELECT id, parent_id, 0 AS depth, ARRAY[id] AS path
    FROM categories WHERE id = 1
    UNION ALL
    SELECT c.id, c.parent_id, t.depth + 1, t.path || c.id
    FROM categories c
    JOIN tree t ON c.parent_id = t.id
    WHERE t.depth < 100              -- depth guard
      AND c.id != ALL(t.path)        -- cycle guard
)
SELECT * FROM tree;
```

### Anti-pattern 5: Không cleanup Temp Table

```sql
-- ❌ Temp tables tích tụ trong long-running sessions
CREATE TEMP TABLE tmp1 AS SELECT ...;
CREATE TEMP TABLE tmp2 AS SELECT ...;
-- ... quên DROP

-- ✅ Dùng ON COMMIT DROP trong transaction
BEGIN;
CREATE TEMP TABLE tmp_work ON COMMIT DROP AS SELECT ...;
-- ... dùng tmp_work
COMMIT; -- tự động DROP

-- Hoặc luôn DROP khi xong
CREATE TEMP TABLE tmp_work AS SELECT ...;
-- ... dùng
DROP TABLE IF EXISTS tmp_work;
```

---

## 13. Decision Framework — Flowchart chọn công cụ đúng

```diagram
╭──────────────────────────────────────────────────────────────╮
│  Bạn cần chia query phức tạp thành các phần nhỏ?             │
│                                                              │
│  ┌─ Logic dùng bao nhiêu lần trong query?                    │
│  │                                                           │
│  ├─ 1 lần → Logic phức tạp không?                            │
│  │  ├─ Đơn giản (1-2 bước) → SUBQUERY                        │
│  │  └─ Phức tạp (3+ bước) → CTE                              │
│  │                                                           │
│  ├─ ≥ 2 lần trong CÙNG query → CTE                           │
│  │                                                           │
│  └─ ≥ 2 lần trong KHÁC query → TEMP TABLE                    │
│                                                              │
│  ┌─ Cần recursive / duyệt cây?                               │
│  │  └─ Có → RECURSIVE CTE                                    │
│  │                                                           │
│  ┌─ Dataset trung gian lớn, cần index?                       │
│  │  └─ Có → TEMP TABLE                                       │
│  │                                                           │
│  ┌─ Trong VIEW hoặc single statement?                        │
│  │  └─ Có → CTE (temp table không dùng được)                 │
│  │                                                           │
│  ┌─ Stored procedure, cần dùng ở nhiều bước?                 │
│  │  └─ Có → TEMP TABLE                                       │
╰──────────────────────────────────────────────────────────────╯
```

### Bảng quyết định nhanh

| Tình huống | Chọn | Lý do |
|------------|------|-------|
| Logic đơn giản, dùng 1 lần | **Subquery** | Gọn, optimizer inline |
| Logic phức tạp 3+ bước | **CTE** | Đọc top-down, debug dễ |
| Cùng logic dùng ≥2 lần trong 1 query | **CTE** | DRY, nhất quán |
| Cùng data dùng ở nhiều query | **Temp Table** | Tính 1 lần, dùng nhiều |
| Cần đánh index kết quả trung gian | **Temp Table** | CTE/subquery không index được |
| Duyệt cây / graph | **Recursive CTE** | Subquery và temp table không recursive |
| Trong VIEW / single statement | **CTE** hoặc **Subquery** | Temp table cần DDL |
| ETL pipeline phức tạp | **Temp Table** | Kiểm soát hoàn toàn |
| Check tồn tại (EXISTS) | **Subquery** | Gọn, optimizer semi-join |
| Scalar lookup 1 giá trị | **Subquery** | Nếu non-correlated; JOIN nếu nhiều cột |

---

## 14. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 14.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  Công cụ           Khi nào dùng                    Khi nào tránh│
│  ─────────────────────────────────────────────────────────    │
│  Subquery          Logic đơn giản, 1 lần            Lồng ≥3 level│
│  CTE               Pipeline phức tạp, reuse        Logic trivial│
│  CTE MATERIALIZED  CTE dùng ≥2 lần, nặng          CTE dùng 1 lần│
│  CTE NOT MATERIAL. Filter cần push down            CTE dùng ≥2 lần│
│  Recursive CTE     Duyệt cây, graph, series        Data phẳng   │
│  Temp Table        Cross-query, cần index           Dùng 1 lần   │
╰───────────────────────────────────────────────────────────────╯
```

### 14.2. So sánh tổng quan

| Tiêu chí | Subquery | CTE | Temp Table |
|----------|----------|-----|------------|
| Readability | ⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| Performance (1 lần) | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| Performance (nhiều lần) | ⭐ | ⭐⭐ | ⭐⭐⭐ |
| Flexibility | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| Indexability | ❌ | ❌ | ✅ |
| Recursive | ❌ | ✅ | ❌ |
| Cross-query | ❌ | ❌ | ✅ |
| Portability | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |

### 14.3. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Ưu tiên readability — CTE là mặc định cho logic phức tạp.**
> Nếu query có ≥3 bước logic, viết CTE pipeline từ trên xuống. Code review sẽ cảm ơn bạn. Chỉ chuyển sang subquery khi CTE gây materialization overhead.
>
> **2. Subquery cho việc nhỏ, Temp Table cho việc lớn.**
> - EXISTS, IN, scalar lookup → subquery.
> - Kết quả trung gian dùng ở nhiều query, cần index → temp table.
> - Đừng dùng temp table cho logic dùng 1 lần — overhead tạo không đáng.
>
> **3. Luôn kiểm tra EXPLAIN — đừng giả định performance.**
> CTE materialized hay inline? Subquery flatten hay nested loop? **Chỉ EXPLAIN mới cho câu trả lời chính xác.** Mỗi DB, mỗi version, mỗi dataset cho kết quả khác nhau.

### 14.4. Quote cuối

> Subquery, CTE, và Temp Table không phải đối thủ — chúng là **đồng đội**. Mỗi cái mạnh ở một khía cạnh. Kỹ sư giỏi không phải người biết syntax — mà là người biết **khi nào dùng công cụ nào**. Và cách duy nhất để biết chắc: đọc EXPLAIN, đo benchmark, rồi quyết định.

Lần sau khi viết query phức tạp, hãy tự hỏi: *"Mình đang viết cho optimizer hiểu, hay đang viết cho đồng nghiệp hiểu?"* — Câu trả lời tốt nhất: **cả hai**.
