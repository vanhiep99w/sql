---
title: "Query Optimization Patterns"
description: "Mổ xẻ 15+ anti-pattern SQL phổ biến nhất — SELECT *, N+1, implicit conversion, correlated subquery, OFFSET pagination, OR trap, function-on-column. Kèm benchmark, EXPLAIN ANALYZE và cách fix từng cái."
---

<SourceRef project="optimization-query-optimization-patterns" variant="button">
Mở các đoạn code trong bài
</SourceRef>

Các file trong Source Explorer là **snippet độc lập**, giữ nguyên ngữ cảnh và database của từng mục; không chạy nối tiếp tất cả như một script.

## Mục lục

- [Bối cảnh: Khi dashboard 200ms biến thành 12 giây](#1-bối-cảnh-khi-dashboard-200ms-biến-thành-12-giây)
- [Anti-pattern #1: SELECT * — Kẻ giết Index-Only Scan](#2-anti-pattern-1-select----kẻ-giết-index-only-scan)
- [Anti-pattern #2: N+1 Query — Cái bẫy của ORM](#3-anti-pattern-2-n1-query--cái-bẫy-của-orm)
- [Anti-pattern #3: Implicit Type Conversion — Silent Index Killer](#4-anti-pattern-3-implicit-type-conversion--silent-index-killer)
- [Anti-pattern #4: Function trên cột — Giết index không cần dao](#5-anti-pattern-4-function-trên-cột--giết-index-không-cần-dao)
- [Anti-pattern #5: OR Conditions — Optimizer bó tay](#6-anti-pattern-5-or-conditions--optimizer-bó-tay)
- [Anti-pattern #6: Correlated Subquery — Nested Loop ẩn](#7-anti-pattern-6-correlated-subquery--nested-loop-ẩn)
- [Anti-pattern #7: OFFSET Pagination — Càng lật càng chậm](#8-anti-pattern-7-offset-pagination--càng-lật-càng-chậm)
- [Anti-pattern #8: NOT IN với NULL — Kết quả sai âm thầm](#9-anti-pattern-8-not-in-với-null--kết-quả-sai-âm-thầm)
- [Anti-pattern #9: DISTINCT / GROUP BY thừa — Che lỗi JOIN](#10-anti-pattern-9-distinct--group-by-thừa--che-lỗi-join)
- [Anti-pattern #10: WHERE vs HAVING — Lọc sai chỗ](#11-anti-pattern-10-where-vs-having--lọc-sai-chỗ)
- [Anti-pattern #11: ORDER BY không có Index](#12-anti-pattern-11-order-by-không-có-index)
- [Anti-pattern #12: Quá nhiều JOIN — Khi nào nên denormalize](#13-anti-pattern-12-quá-nhiều-join--khi-nào-nên-denormalize)
- [Anti-pattern #13: COUNT(*) trên bảng lớn](#14-anti-pattern-13-count-trên-bảng-lớn)
- [Anti-pattern #14: INSERT/UPDATE từng row trong vòng lặp](#15-anti-pattern-14-insertupdate-từng-row-trong-vòng-lặp)
- [Anti-pattern #15: SELECT ... FOR UPDATE quá rộng](#16-anti-pattern-15-select--for-update-quá-rộng)
- [So sánh cách optimizer xử lý giữa Postgres / MySQL / Oracle](#17-so-sánh-cách-optimizer-xử-lý-giữa-postgres--mysql--oracle)
- [Công cụ phát hiện query chậm](#18-công-cụ-phát-hiện-query-chậm)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#19-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Bối cảnh: Khi dashboard 200ms biến thành 12 giây

Bạn đang phụ trách backend cho hệ thống e-commerce. Bảng `orders` có **20 triệu bản ghi**, bảng `order_items` có **80 triệu**, bảng `products` có **500,000**, bảng `users` có **2 triệu**.

```sql
CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    email       VARCHAR(255) UNIQUE NOT NULL,
    name        VARCHAR(100),
    phone       VARCHAR(20),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT REFERENCES users(id),
    status      VARCHAR(20) NOT NULL,   -- 'pending','paid','shipped','delivered','cancelled'
    total       NUMERIC(12,2),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    category_id INT,
    price       NUMERIC(10,2),
    stock       INT DEFAULT 0
);

CREATE TABLE order_items (
    id          BIGSERIAL PRIMARY KEY,
    order_id    BIGINT REFERENCES orders(id),
    product_id  BIGINT REFERENCES products(id),
    quantity    INT NOT NULL,
    unit_price  NUMERIC(10,2)
);

-- Index có sẵn
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
```

<SourceRef project="optimization-query-optimization-patterns" file="1-bối-cảnh-khi-dashboard-200ms-biến-thành-12-giây/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

Sprint review, PM nói: "Dashboard admin load chậm quá, trước 200ms giờ mất 12 giây". Bạn mở code ra, thấy một mớ query "trông có vẻ đúng" nhưng lại chậm kinh khủng. Mỗi query chậm **vì một lý do khác nhau**.

> [!IMPORTANT]
> Hầu hết query chậm **không phải vì thiếu index** — mà vì **cách viết query** khiến optimizer không thể dùng index đã có, hoặc bắt database làm việc thừa gấp trăm lần.

Trong doc này, ta sẽ mổ xẻ **15 anti-pattern phổ biến nhất**, mỗi cái kèm:

1. **Ví dụ thực tế** trên schema e-commerce ở trên.
2. **EXPLAIN ANALYZE** cho thấy chính xác database làm gì.
3. **Cách fix** — và benchmark trước/sau.
4. **So sánh** hành vi giữa Postgres, MySQL, Oracle.

Mục tiêu: sau khi đọc xong, bạn sẽ **ngửi được mùi** query chậm ngay lúc viết — không cần đợi production báo lỗi.

---

## 2. Anti-pattern #1: SELECT * — Kẻ giết Index-Only Scan

### 2.1. Câu chuyện

API trả danh sách đơn hàng cho admin dashboard. Developer viết:

```sql
SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20;
```

Trông đơn giản, có index trên `status` và `created_at`. Nhưng EXPLAIN cho thấy:

```text
 Limit  (actual time=0.845..234.567 rows=20 loops=1)
   ->  Sort  (actual time=0.843..234.540 rows=20 loops=1)
         Sort Key: created_at DESC
         Sort Method: top-N heapsort  Memory: 29kB
         ->  Bitmap Heap Scan on orders  (actual time=12.345..189.012 rows=850000 loops=1)
               Recheck Cond: (status = 'pending')
               Heap Blocks: exact=125432
               ->  Bitmap Index Scan on idx_orders_status  (actual time=8.123..8.123 rows=850000 loops=1)
                     Index Cond: (status = 'pending')
 Planning Time: 0.312 ms
 Execution Time: 234.891 ms
```

Database phải **fetch 850,000 rows từ heap** (bảng chính) chỉ để lấy tất cả cột, rồi sort, rồi lấy 20.

### 2.2. Vấn đề cốt lõi

`SELECT *` **bắt buộc** database phải quay về heap (bảng chính) để đọc tất cả cột. Dù index đã chứa đủ thông tin cần thiết, database vẫn phải thực hiện **Heap Fetch** cho mỗi row.

```d2 title="Chọn đủ cột có thể mở đường cho index-only scan"
direction: down
b0: "SELECT *" {
  n0: "Index không đủ cột"
  n1: "Index Scan + heap fetch khi plan cần"
  n0 -> n1
}
b1: "SELECT id,status" {
  n0: "Nếu index đủ cột và visibility phù hợp"
  n1: "Có thể dùng Index-Only Scan"
  n0 -> n1
}
```

**Index-Only Scan** là một trong những optimization mạnh nhất — database trả kết quả **chỉ từ index**, không đụng vào bảng. Nhưng `SELECT *` **giết chết** khả năng này.

### 2.3. Fix: Covering Index + chỉ lấy cột cần

```sql
-- Tạo covering index
CREATE INDEX idx_orders_status_created ON orders(status, created_at DESC)
    INCLUDE (id, total, user_id);

-- Query chỉ lấy cột cần
SELECT id, user_id, total, status, created_at
FROM orders
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 20;
```

EXPLAIN sau khi fix:

```text
 Limit  (actual time=0.034..0.089 rows=20 loops=1)
   ->  Index Only Scan Backward using idx_orders_status_created on orders
         (actual time=0.032..0.085 rows=20 loops=1)
         Index Cond: (status = 'pending')
         Heap Fetches: 0
 Planning Time: 0.198 ms
 Execution Time: 0.112 ms
```

**Từ 234ms → 0.1ms** — nhanh hơn **~2,300 lần**. Và `Heap Fetches: 0` — database **không đọc bảng** lần nào.

### 2.4. Tại sao SELECT * còn nguy hiểm hơn bạn nghĩ

| Hậu quả | Giải thích |
|----------|-----------|
| Giết Index-Only Scan | Như ở trên |
| Tăng network I/O | Truyền cột `description` (TEXT dài) qua mạng dù frontend không cần |
| Gây lỗi khi ALTER TABLE | Thêm cột mới → app code nhận thêm field không mong đợi → bug ẩn |
| Khó cache | Mỗi query trả object khác nhau tùy schema → cache invalidation phức tạp |
| Block parallel query | Postgres parallel query bị giới hạn khi phải fetch nhiều cột từ heap |

> [!WARNING]
> `SELECT *` trong production code là **technical debt**. Nó không chỉ chậm — nó còn làm hệ thống **giòn** và **khó maintain**.

### 2.5. Ngoại lệ hợp lý

- **Debug / adhoc query** trong `psql` hoặc DBeaver → OK
- **`SELECT * INTO temp_table`** để clone data → OK
- **Khi bạn thực sự cần tất cả cột** (export CSV chẳng hạn) → OK, nhưng xem xét batch

---

## 3. Anti-pattern #2: N+1 Query — Cái bẫy của ORM

### 3.1. Câu chuyện

Trang admin hiển thị 50 đơn hàng gần nhất kèm tên user. Code ORM (ví dụ Sequelize/TypeORM):

```javascript
// 1 query lấy orders
const orders = await Order.findAll({
  where: { status: 'paid' },
  order: [['created_at', 'DESC']],
  limit: 50,
});

// 50 query lấy user — mỗi order 1 query
for (const order of orders) {
  order.user = await User.findByPk(order.user_id);
}
```

Nhìn log SQL:

```sql
-- Query 1: lấy orders
SELECT * FROM orders WHERE status = 'paid' ORDER BY created_at DESC LIMIT 50;

-- Query 2-51: lấy từng user
SELECT * FROM users WHERE id = 1001;
SELECT * FROM users WHERE id = 1002;
SELECT * FROM users WHERE id = 1003;
... (47 lần nữa)
```

**51 round-trip** tới database. Mỗi round-trip mất ~0.5ms network latency → **25ms chỉ riêng network**, chưa kể query execution.

### 3.2. Vấn đề cốt lõi

> Playback dưới đây minh họa thứ tự các bước do tác giả chọn; không gửi request thật, không mô phỏng concurrency và tốc độ phát không phải latency. Bạn có thể chạy hoặc xem từng bước.

```d2 title="N+1: một query orders và N query users" mode=flow interactive=true
# @flow
# scenarios:
#   - id: main
#     label: "Kịch bản minh họa"
#     steps:
#       - edge: "(app -> db)[0]"
#         description: "App → Database: Lấy 50 orders — query 1"
#       - edge: "(db -> app)[0]"
#         description: "Database → App: order1, order2, ..., order50"
#       - edge: "(app -> db)[1]"
#         description: "App → Database: User của order1? — query 2"
#       - edge: "(db -> app)[1]"
#         description: "Database → App: user_1001"
#       - edge: "(app -> db)[2]"
#         description: "App → Database: User của order2? — query 3"
#       - edge: "(db -> app)[2]"
#         description: "Database → App: user_1002"
#       - edge: "(app -> db)[3]"
#         description: "App → Database: ... User của order50? — query 51"
#       - edge: "(db -> app)[3]"
#         description: "Database → App: user_1050"
# @endflow
shape: sequence_diagram
app: App
db: Database
app -> db: Lấy 50 orders — query 1
db -> app: order1, order2, ..., order50
app -> db: User của order1? — query 2
db -> app: user_1001
app -> db: User của order2? — query 3
db -> app: user_1002
app -> db: ... User của order50? — query 51
db -> app: user_1050
app.note: "Tổng 1 + N round-trips, N là số orders"
```

Vấn đề **scale tuyến tính**: 50 orders = 51 queries, 500 orders = 501 queries, 5000 orders = 5001 queries.

### 3.3. Fix: JOIN hoặc batch IN

**Cách 1 — JOIN (tốt nhất):**

```sql
SELECT o.id, o.status, o.total, o.created_at,
       u.id AS user_id, u.name, u.email
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'paid'
ORDER BY o.created_at DESC
LIMIT 50;
```

**1 query duy nhất**, database dùng Nested Loop + Index Scan trên `users(id)`:

```text
 Limit  (actual time=0.045..0.312 rows=50 loops=1)
   ->  Nested Loop  (actual time=0.043..0.298 rows=50 loops=1)
         ->  Index Scan Backward using idx_orders_created_at on orders
               (actual time=0.025..0.089 rows=50 loops=1)
               Filter: (status = 'paid')
         ->  Index Scan using users_pkey on users
               (actual time=0.003..0.003 rows=1 loops=50)
               Index Cond: (id = orders.user_id)
 Execution Time: 0.398 ms
```

**Cách 2 — Batch IN (khi JOIN không tiện):**

```sql
-- Query 1: lấy orders
SELECT id, user_id, status, total, created_at
FROM orders WHERE status = 'paid' ORDER BY created_at DESC LIMIT 50;

-- Query 2: lấy tất cả users trong 1 lần
SELECT id, name, email FROM users WHERE id IN (1001, 1002, 1003, ..., 1050);
```

**2 queries** thay vì 51. Cách này hữu ích khi bạn cần xử lý dữ liệu trung gian trước khi query tiếp.

### 3.4. ORM — cách bật eager loading đúng

```javascript
// Sequelize — eager loading
const orders = await Order.findAll({
  where: { status: 'paid' },
  order: [['created_at', 'DESC']],
  limit: 50,
  include: [{ model: User, attributes: ['id', 'name', 'email'] }],
});
// → 1 query với JOIN hoặc 2 queries với IN

// TypeORM — relations
const orders = await orderRepo.find({
  where: { status: 'paid' },
  order: { created_at: 'DESC' },
  take: 50,
  relations: ['user'],
});
```

```python
# Django — select_related (FK → JOIN)
orders = Order.objects.filter(status='paid') \
    .select_related('user') \
    .order_by('-created_at')[:50]

# Django — prefetch_related (M2M → 2 queries + IN)
orders = Order.objects.filter(status='paid') \
    .prefetch_related('items') \
    .order_by('-created_at')[:50]
```

### 3.5. Benchmark

| Cách | Queries | Network round-trips | Thời gian (50 orders) | Thời gian (500 orders) |
|------|---------|--------------------|-----------------------|------------------------|
| N+1 (loop) | 51 | 51 | ~35 ms | ~280 ms |
| Batch IN | 2 | 2 | ~2 ms | ~8 ms |
| JOIN | 1 | 1 | ~0.4 ms | ~3 ms |

> [!TIP]
> Hầu hết ORM **mặc định là lazy loading** (N+1). Bạn phải **chủ động bật** eager loading. Cách dễ nhất để phát hiện: bật **query log** trong development và đếm số queries.

---

## 4. Anti-pattern #3: Implicit Type Conversion — Silent Index Killer

### 4.1. Câu chuyện

Bảng `orders` có cột `id` kiểu `BIGINT`. API nhận `order_id` từ request params dạng **string**. Developer viết:

```sql
-- Từ app code: orderId = req.params.id (string "12345")
SELECT * FROM orders WHERE id = '12345';
```

Trên Postgres, query này vẫn **dùng index** vì Postgres tự cast `'12345'` → `12345` (cast hằng số, không đụng cột).

Nhưng trên MySQL, nếu **ngược lại** — cột là `VARCHAR`, query truyền `INT`:

```sql
-- Cột phone là VARCHAR(20), nhưng truyền số
SELECT * FROM users WHERE phone = 84901234567;
```

MySQL **cast toàn bộ cột `phone` thành số** để so sánh → **Seq Scan**, dù có index trên `phone`.

### 4.2. Vấn đề cốt lõi

Khi kiểu dữ liệu không khớp, database phải **convert** một trong hai bên. Nếu nó convert **cột** (thay vì hằng số), mọi index trên cột đó trở nên **vô dụng**.

```d2 title="Cast parameter hay cast column tạo access path khác nhau"
direction: down
query: "WHERE varchar_col=123"
param: "Cast 123 sang VARCHAR; so sánh chuỗi"
column: "Cast varchar_col sang số; so sánh numeric"
index: "String index có thể dùng khi ngữ nghĩa phù\nhợp"
scan: "Có thể cần convert nhiều row và mất range\nlookup"
error: "PostgreSQL thường báo type/operator\nmismatch nếu không có cast phù hợp"
query -> param: "Khả năng A"
query -> column: "Khả năng B, ví dụ MySQL"
query -> error: "Engine khác"
param -> index
column -> scan
```

### 4.3. Các trường hợp implicit conversion thường gặp

| Trường hợp | Postgres | MySQL | Oracle |
|------------|----------|-------|--------|
| `INT_col = '123'` | ✅ Cast hằng số | ✅ Cast hằng số | ✅ Cast hằng số |
| `VARCHAR_col = 123` | ❌ **Lỗi** (strict typing) | ❌ **Cast cột** → Seq Scan | ❌ **Cast cột** → Full Scan |
| `DATE_col = '2024-01-15'` | ✅ Cast string → date | ✅ Cast string → date | ✅ Cast string → date |
| `TIMESTAMP_col = DATE '2024-01-15'` | ✅ Promote date → timestamp | ⚠️ Tùy version | ✅ |
| `NUMERIC(10,2) = INT` | ✅ Promote INT | ✅ Promote INT | ✅ Promote INT |

> [!WARNING]
> MySQL là DB **dễ mắc nhất** vì nó **im lặng** convert mà không báo lỗi. Postgres strict hơn — sẽ báo lỗi kiểu type mismatch trong nhiều trường hợp.

### 4.4. Fix

```sql
-- ❌ Sai — truyền số cho cột VARCHAR
SELECT * FROM users WHERE phone = 84901234567;

-- ✅ Đúng — truyền đúng kiểu
SELECT * FROM users WHERE phone = '84901234567';
```

EXPLAIN trước/sau trên MySQL:

```text
-- Trước (implicit conversion)
+----+-------------+-------+------+---------------+------+------+------+---------+
| id | select_type | table | type | possible_keys | key  | rows | Extra            |
+----+-------------+-------+------+---------------+------+------+------+---------+
|  1 | SIMPLE      | users | ALL  | idx_phone     | NULL | 2000000 | Using where |
+----+-------------+-------+------+---------------+------+------+------+---------+

-- Sau (đúng kiểu)
+----+-------------+-------+------+---------------+-----------+------+---------+
| id | select_type | table | type | possible_keys | key       | rows | Extra   |
+----+-------------+-------+------+---------------+-----------+------+---------+
|  1 | SIMPLE      | users | ref  | idx_phone     | idx_phone |    1 | NULL    |
+----+-------------+-------+------+---------------+-----------+------+---------+
```

**Từ scan 2 triệu rows → scan 1 row.** Chỉ vì thêm dấu nháy đơn.

### 4.5. Cách phát hiện

```sql
-- MySQL: bật warnings
SHOW WARNINGS;

-- Postgres: sẽ báo lỗi trực tiếp
-- ERROR:  operator does not exist: character varying = integer

-- Tất cả DB: kiểm tra EXPLAIN
-- Nếu thấy "type conversion" hoặc key = NULL khi bạn nghĩ có index → nghi ngờ implicit cast
```

> [!TIP]
> **Rule of thumb**: luôn truyền **đúng kiểu dữ liệu** trong bind parameter. Hầu hết ORM/driver tự handle, nhưng raw query thì bạn phải tự lo.

---

## 5. Anti-pattern #4: Function trên cột — Giết index không cần dao

### 5.1. Câu chuyện

Dashboard cần lấy đơn hàng trong tháng 1/2024:

```sql
SELECT * FROM orders
WHERE EXTRACT(YEAR FROM created_at) = 2024
  AND EXTRACT(MONTH FROM created_at) = 1;
```

Có index `idx_orders_created_at` trên cột `created_at`. Nhưng:

```text
 Seq Scan on orders  (actual time=0.018..4521.345 rows=125000 loops=1)
   Filter: ((EXTRACT(year FROM created_at) = 2024) AND (EXTRACT(month FROM created_at) = 1))
   Rows Removed by Filter: 19875000
 Execution Time: 4521.678 ms
```

**Seq Scan** — dù có index. Đọc toàn bộ **20 triệu rows** chỉ để lấy 125,000.

### 5.2. Vấn đề cốt lõi

> [!IMPORTANT]
> Khi bạn bọc cột trong **function**, database **không thể** dùng B-Tree index trên cột đó. B-Tree sắp theo giá trị gốc của cột, không phải giá trị sau khi áp function.

```d2 title="Bọc cột bằng EXTRACT làm mất range liên tục"
direction: down
n0: "Index created_at: 2023-11-15 → 2023-12-01 → 2024-01-01 → 2024-01-15 → ..."
n1: "EXTRACT(MONTH FROM created_at) = 1"
n2: "Tháng 1 rải ở 2023-01, 2024-01, 2025-01..."
n3: "Không có một range liên tục theo created_at; có thể phải full scan"
n0 -> n1 -> n2 -> n3
```

### 5.3. Fix: Chuyển thành range condition

Diff làm rõ thay đổi ở predicate, không thay projection. Ví dụ giả định `created_at` là timestamp không kèm timezone; nếu dùng timestamptz, phải xác định biên tháng theo múi giờ nghiệp vụ. Khả năng dùng index không đảm bảo planner luôn chọn index — vẫn cần đo bằng EXPLAIN.

```code-diff
title: Từ EXTRACT trên cột sang khoảng nửa mở
language: sql
view: split
before:
  label: Hàm trên created_at
  code: |-
    SELECT * FROM orders
    WHERE EXTRACT(YEAR FROM created_at) = 2024
      AND EXTRACT(MONTH FROM created_at) = 1;
after:
  label: Range trên giá trị gốc
  code: |-
    -- ✅ Sargable — dùng được index range scan
    SELECT * FROM orders
    WHERE created_at >= '2024-01-01'
      AND created_at < '2024-02-01';
```

EXPLAIN sau fix:

```text
 Index Scan using idx_orders_created_at on orders
   (actual time=0.025..45.678 rows=125000 loops=1)
   Index Cond: ((created_at >= '2024-01-01') AND (created_at < '2024-02-01'))
 Execution Time: 52.345 ms
```

**Từ 4,521ms → 52ms** — nhanh hơn **~87 lần**.

### 5.4. Catalog các function-on-column thường gặp và cách fix

| Anti-pattern | Fix (Sargable) |
|-------------|----------------|
| `WHERE YEAR(created_at) = 2024` | `WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'` |
| `WHERE DATE(created_at) = '2024-01-15'` | `WHERE created_at >= '2024-01-15' AND created_at < '2024-01-16'` |
| `WHERE LOWER(email) = 'abc@test.com'` | Tạo expression index: `CREATE INDEX ON users(LOWER(email))` |
| `WHERE CAST(price AS INT) = 100` | `WHERE price >= 100 AND price < 101` |
| `WHERE COALESCE(phone, '') = '090...'` | `WHERE phone = '090...'` (hoặc expression index) |
| `WHERE ABS(amount) > 1000` | `WHERE amount > 1000 OR amount < -1000` |
| `WHERE TRIM(name) = 'John'` | Chuẩn hóa data lúc INSERT, không TRIM lúc SELECT |
| `WHERE created_at + INTERVAL '7 days' > NOW()` | `WHERE created_at > NOW() - INTERVAL '7 days'` |

> [!TIP]
> **Quy tắc SARGable** (Search ARGument Able): cột phải **đứng một mình** ở một bên phép so sánh, không bọc trong function hay expression. Chuyển mọi phép tính sang **phía hằng số**.

### 5.5. Expression Index — khi không thể tránh function

Đôi khi business logic bắt buộc phải dùng function — ví dụ case-insensitive email lookup:

```sql
-- Tạo expression index
CREATE INDEX idx_users_email_lower ON users(LOWER(email));

-- Query dùng đúng function như index
SELECT * FROM users WHERE LOWER(email) = 'abc@test.com';
```

```text
 Index Scan using idx_users_email_lower on users
   (actual time=0.025..0.028 rows=1 loops=1)
   Index Cond: (lower(email) = 'abc@test.com')
 Execution Time: 0.052 ms
```

> [!WARNING]
> Expression index **chỉ được dùng** khi query sử dụng **đúng function** giống hệt lúc tạo index. `LOWER(email)` trong index chỉ serve `WHERE LOWER(email) = ...`, không serve `WHERE email = ...`.

---

## 6. Anti-pattern #5: OR Conditions — Optimizer bó tay

### 6.1. Câu chuyện

Tìm đơn hàng theo email hoặc phone:

```sql
SELECT * FROM users
WHERE email = 'abc@test.com' OR phone = '0901234567';
```

Có index trên cả `email` (UNIQUE) và `phone`. Bạn nghĩ database sẽ dùng cả hai? Nhìn EXPLAIN:

```text
-- MySQL
+----+------+----------------------------+------+---------+------+---------+-------------+
| id | type | possible_keys              | key  | key_len | rows | filtered| Extra       |
+----+------+----------------------------+------+---------+------+---------+-------------+
|  1 | ALL  | idx_users_email,idx_phone   | NULL | NULL    | 2000000 | 19.00 | Using where |
+----+------+----------------------------+------+---------+------+---------+-------------+
```

**Full Table Scan** — dù có 2 index.

### 6.2. Vấn đề cốt lõi

Một single index scan chỉ duyệt **một cây B-Tree**. Điều kiện `OR` giữa **hai cột khác nhau** buộc optimizer phải chọn:

- Dùng index A (email) → vẫn phải scan toàn bảng cho điều kiện phone
- Dùng index B (phone) → vẫn phải scan toàn bảng cho điều kiện email
- Scan luôn toàn bảng → đơn giản hơn

Nhiều DB chọn **scan toàn bảng** vì ít overhead hơn merge hai index.

### 6.3. Fix: UNION ALL

```sql
SELECT * FROM users WHERE email = 'abc@test.com'
UNION ALL
SELECT * FROM users WHERE phone = '0901234567'
  AND (email IS DISTINCT FROM 'abc@test.com');  -- tránh duplicate
```

Hoặc đơn giản hơn nếu chấp nhận dedup:

```sql
SELECT * FROM users WHERE email = 'abc@test.com'
UNION
SELECT * FROM users WHERE phone = '0901234567';
```

Mỗi nhánh UNION dùng **riêng** index của nó:

```text
 Unique  (actual time=0.035..0.042 rows=1 loops=1)
   ->  Sort  (actual time=0.034..0.038 rows=2 loops=1)
         ->  Append  (actual time=0.012..0.028 rows=2 loops=1)
               ->  Index Scan using users_email_key on users
                     (actual time=0.011..0.012 rows=1 loops=1)
                     Index Cond: (email = 'abc@test.com')
               ->  Index Scan using idx_users_phone on users
                     (actual time=0.008..0.009 rows=1 loops=1)
                     Index Cond: (phone = '0901234567')
 Execution Time: 0.078 ms
```

### 6.4. Khi nào OR vẫn OK

| Trường hợp | Index dùng được? | Giải thích |
|------------|------------------|-----------|
| `WHERE status = 'paid' OR status = 'shipped'` | ✅ | Cùng 1 cột → optimizer convert thành `IN ('paid', 'shipped')` |
| `WHERE email = 'a' OR email = 'b'` | ✅ | Cùng 1 cột → `IN ('a', 'b')` |
| `WHERE email = 'a' OR phone = 'b'` | ❌ (thường) | Khác cột → UNION |
| `WHERE (a = 1 AND b = 2) OR (a = 3 AND b = 4)` | ⚠️ Tùy DB | Postgres có thể BitmapOr, MySQL thường scan |

> [!NOTE]
> Postgres có **BitmapOr** — merge kết quả từ 2 bitmap index scan. Nên Postgres **ít bị ảnh hưởng** bởi `OR` hơn MySQL. Nhưng UNION vẫn rõ ràng và portable hơn.

---

## 7. Anti-pattern #6: Correlated Subquery — Nested Loop ẩn

### 7.1. Câu chuyện

Lấy mỗi user kèm tổng số đơn hàng:

```sql
SELECT u.id, u.name, u.email,
       (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
FROM users u
WHERE u.created_at >= '2024-01-01';
```

### 7.2. Vấn đề cốt lõi

Subquery trong SELECT **chạy một lần cho mỗi row** của outer query. Nếu outer query trả 100,000 users → subquery chạy **100,000 lần**.

```text
 Seq Scan on users u  (actual time=0.045..8945.678 rows=100000 loops=1)
   Filter: (created_at >= '2024-01-01')
   SubPlan 1
     ->  Aggregate  (actual time=0.085..0.086 rows=1 loops=100000)
           ->  Index Scan using idx_orders_user_id on orders o
                 (actual time=0.012..0.078 rows=10 loops=100000)
                 Index Cond: (user_id = u.id)
 Execution Time: 8946.234 ms
```

`loops=100000` — subquery thực thi **100,000 lần**. Mỗi lần nhanh (0.085ms), nhưng nhân lên = **~9 giây**.

### 7.3. Fix: JOIN + GROUP BY

```sql
SELECT u.id, u.name, u.email, COALESCE(oc.order_count, 0) AS order_count
FROM users u
LEFT JOIN (
    SELECT user_id, COUNT(*) AS order_count
    FROM orders
    GROUP BY user_id
) oc ON oc.user_id = u.id
WHERE u.created_at >= '2024-01-01';
```

```text
 Hash Join  (actual time=345.123..412.456 rows=100000 loops=1)
   Hash Cond: (u.id = oc.user_id)
   ->  Seq Scan on users u  (actual time=0.012..45.678 rows=100000 loops=1)
         Filter: (created_at >= '2024-01-01')
   ->  Hash  (actual time=298.456..298.456 rows=1500000 loops=1)
         ->  Subquery Scan on oc  (actual time=0.025..245.678 rows=1500000 loops=1)
               ->  HashAggregate  (actual time=0.023..198.456 rows=1500000 loops=1)
                     Group Key: orders.user_id
                     ->  Seq Scan on orders  (actual time=0.008..98.765 rows=20000000 loops=1)
 Execution Time: 425.789 ms
```

**Từ 8,946ms → 425ms** — nhanh hơn **~21 lần**. Nhưng có thể tối ưu thêm — aggregate trước, lọc sau:

```sql
SELECT u.id, u.name, u.email, COALESCE(oc.order_count, 0) AS order_count
FROM users u
LEFT JOIN (
    SELECT user_id, COUNT(*) AS order_count
    FROM orders
    WHERE user_id IN (SELECT id FROM users WHERE created_at >= '2024-01-01')
    GROUP BY user_id
) oc ON oc.user_id = u.id
WHERE u.created_at >= '2024-01-01';
```

### 7.4. Khi nào correlated subquery vẫn OK

| Trường hợp | Correlated Sub OK? | Lý do |
|------------|-------------------|-------|
| Outer query trả **ít rows** (<100) | ✅ | Loops ít, overhead không đáng kể |
| `EXISTS (SELECT 1 FROM ...)` | ✅ | Optimizer thường convert thành semi-join hiệu quả |
| `LATERAL JOIN` (Postgres) | ✅ | Optimizer có nhiều strategy hơn subquery thường |
| Outer query trả **hàng nghìn+ rows** | ❌ | JOIN + GROUP BY gần như luôn tốt hơn |

> [!TIP]
> `EXISTS` **không phải** correlated subquery thường — hầu hết optimizer convert nó thành **semi-join**, chỉ cần tìm thấy 1 row là dừng. Nó hiệu quả hơn nhiều so với subquery trong SELECT.

---

## 8. Anti-pattern #7: OFFSET Pagination — Càng lật càng chậm

### 8.1. Câu chuyện

API phân trang danh sách đơn hàng:

```sql
-- Trang 1
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 0;       -- 2ms

-- Trang 100
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 1980;    -- 45ms

-- Trang 10,000
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 199980;  -- 3,200ms

-- Trang 100,000
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 1999980; -- 28,500ms
```

**Càng lật trang càng chậm — tuyến tính với OFFSET.**

### 8.2. Vấn đề cốt lõi

`OFFSET N` nghĩa là: **đọc N rows, vứt đi, rồi mới bắt đầu lấy**. Trang 100,000 → database đọc rồi vứt **~2 triệu rows**.

```d2 title="OFFSET lớn vẫn đọc các row bị bỏ"
direction: right
n0: "Đọc 2.000.000 rows"
n1: "OFFSET: bỏ 1.999.980 rows"
n2: "LIMIT: trả 20 rows"
n0 -> n1 -> n2
```

### 8.3. Fix: Keyset Pagination (Cursor-based)

Thay vì dùng OFFSET, dùng giá trị của **row cuối cùng** ở trang trước làm mốc:

```sql
-- Trang 1 (không có cursor)
SELECT id, user_id, status, total, created_at
FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- Trang tiếp theo: dùng created_at và id của row cuối trang trước
SELECT id, user_id, status, total, created_at
FROM orders
WHERE (created_at, id) < ('2024-03-15 10:30:00', 985432)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

EXPLAIN (trang 100,000 — cùng tốc độ như trang 1):

```text
 Limit  (actual time=0.035..0.089 rows=20 loops=1)
   ->  Index Scan Backward using idx_orders_created_at on orders
         (actual time=0.033..0.085 rows=20 loops=1)
         Index Cond: (created_at < '2024-03-15 10:30:00')
         Filter: (ROW(created_at, id) < ROW('2024-03-15 10:30:00', 985432))
 Execution Time: 0.112 ms
```

**0.1ms ở mọi trang** — không phụ thuộc vào vị trí.

### 8.4. So sánh OFFSET vs Keyset

| Tiêu chí | OFFSET | Keyset |
|----------|--------|--------|
| Tốc độ trang đầu | Nhanh | Nhanh |
| Tốc độ trang xa | **Chậm tuyến tính** | **Luôn nhanh** |
| Nhảy tới trang bất kỳ | ✅ Dễ | ❌ Không được |
| Data thay đổi giữa các trang | ⚠️ Duplicate/skip rows | ✅ Consistent |
| Cần gì từ client | `page_number` | `last_seen_cursor` |
| Phù hợp cho | Admin panel, trang ít data | Feed, infinite scroll, API |

> [!IMPORTANT]
> **OFFSET phù hợp cho**: admin panel hiển thị vài trăm trang, data ít thay đổi.
> **Keyset phù hợp cho**: feed, infinite scroll, API public, data lớn. **Hầu hết API production nên dùng keyset.**

### 8.5. Khi bắt buộc phải dùng OFFSET — Deferred Join

Nếu business yêu cầu "nhảy tới trang 500" (keyset không làm được), dùng **deferred join** để giảm chi phí:

```sql
-- Thay vì:
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 199980;

-- Dùng deferred join:
SELECT o.*
FROM orders o
JOIN (
    SELECT id FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 199980
) AS page ON page.id = o.id
ORDER BY o.created_at DESC;
```

Subquery chỉ đọc **id** từ index (Index-Only Scan), không fetch hàng triệu full rows. Sau đó JOIN lấy chi tiết chỉ cho 20 rows cần.

---

## 9. Anti-pattern #8: NOT IN với NULL — Kết quả sai âm thầm

### 9.1. Câu chuyện

Lấy products chưa bao giờ được đặt hàng:

```sql
SELECT * FROM products
WHERE id NOT IN (SELECT product_id FROM order_items);
```

Query chạy **đúng**, nhưng một ngày đẹp trời `order_items` có row mà `product_id = NULL` (do bug insert). Bất ngờ: **query trả 0 rows**.

### 9.2. Vấn đề cốt lõi

Trong SQL, `NOT IN` với subquery chứa **NULL** sẽ trả **empty set** — bất kể dữ liệu thực tế.

Lý do: `x NOT IN (1, 2, NULL)` tương đương:

```
x != 1 AND x != 2 AND x != NULL
```

`x != NULL` luôn trả `UNKNOWN` (không phải TRUE, không phải FALSE). `AND UNKNOWN` → kết quả cuối cùng là `UNKNOWN` → row bị loại.

```d2 title="NOT IN có NULL có thể tạo UNKNOWN"
direction: down
b0: "Không NULL trong tập" {
  n0: "NOT IN (1,2,3)"
  n1: "x!=1 AND x!=2 AND x!=3"
  n2: "Với x phù hợp: TRUE"
  n0 -> n1
  n1 -> n2
}
b1: "Có NULL trong tập" {
  n0: "NOT IN (1,2,NULL)"
  n1: "x!=1 AND x!=2 AND x!=NULL"
  n2: "Ví dụ TRUE AND TRUE AND UNKNOWN → UNKNOWN"
  n3: "WHERE không giữ row UNKNOWN"
  n0 -> n1
  n1 -> n2
  n2 -> n3
}
```

### 9.3. Fix: NOT EXISTS

```sql
-- ✅ An toàn với NULL — và thường nhanh hơn
SELECT * FROM products p
WHERE NOT EXISTS (
    SELECT 1 FROM order_items oi WHERE oi.product_id = p.id
);
```

`NOT EXISTS` chỉ kiểm tra **sự tồn tại**, không so sánh giá trị trực tiếp → không bị ảnh hưởng bởi NULL.

### 9.4. Performance: NOT IN vs NOT EXISTS vs LEFT JOIN

```sql
-- Cách 3: LEFT JOIN + IS NULL (anti-join)
SELECT p.*
FROM products p
LEFT JOIN order_items oi ON oi.product_id = p.id
WHERE oi.product_id IS NULL;
```

Benchmark trên 500,000 products, 80 triệu order_items:

| Cách | Thời gian | Plan | NULL-safe? |
|------|-----------|------|-----------|
| `NOT IN` | 12,400 ms | Subquery materialized + nested loop | ❌ |
| `NOT EXISTS` | 890 ms | Anti Join (Hash) | ✅ |
| `LEFT JOIN IS NULL` | 920 ms | Anti Join (Hash) | ✅ |

> [!TIP]
> `NOT EXISTS` và `LEFT JOIN ... IS NULL` thường cho cùng execution plan. Chọn cái nào **đọc dễ hơn** với team của bạn. `NOT EXISTS` thường rõ ý hơn.

---

## 10. Anti-pattern #9: DISTINCT / GROUP BY thừa — Che lỗi JOIN

### 10.1. Câu chuyện

Lấy danh sách đơn hàng kèm product info:

```sql
SELECT DISTINCT o.id, o.created_at, o.total, o.status
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
WHERE p.category_id = 5;
```

`DISTINCT` ở đây **không cần** — nhưng developer thêm vì "thấy có duplicate". Duplicate xảy ra vì 1 order có **nhiều items** → JOIN nhân bản rows. Thêm `DISTINCT` chỉ **che lỗi**, không fix root cause.

### 10.2. Vấn đề cốt lõi

`DISTINCT` trên kết quả lớn buộc database phải:

1. **Sort** toàn bộ kết quả (hoặc build **hash table**)
2. **Loại trùng** — tốn CPU và memory

```text
 HashAggregate  (actual time=2345.678..2567.890 rows=45000 loops=1)
   Group Key: o.id, o.created_at, o.total, o.status
   Peak Memory Usage: 12456 kB
   ->  Hash Join  (actual time=12.345..1890.123 rows=380000 loops=1)
         ...
```

380,000 rows nhân lên từ JOIN, rồi DISTINCT giảm về 45,000. Database làm **thừa 335,000 rows**.

### 10.3. Fix: EXISTS thay vì JOIN + DISTINCT

```sql
SELECT o.id, o.created_at, o.total, o.status
FROM orders o
WHERE EXISTS (
    SELECT 1 FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = o.id AND p.category_id = 5
);
```

```text
 Hash Semi Join  (actual time=12.345..189.012 rows=45000 loops=1)
   Hash Cond: (o.id = oi.order_id)
   ->  Seq Scan on orders o  (actual time=0.008..89.012 rows=20000000 loops=1)
   ->  Hash  (actual time=8.345..8.345 rows=52000 loops=1)
         ->  Hash Join  (actual time=1.234..6.789 rows=52000 loops=1)
               ...
 Execution Time: 198.456 ms
```

**Từ 2,567ms → 198ms** — nhanh hơn **~13 lần**. Không duplicate, không sort/hash thừa.

### 10.4. Dấu hiệu nhận biết DISTINCT thừa

| Dấu hiệu | Ý nghĩa |
|-----------|---------|
| `DISTINCT` sau khi JOIN 1-to-many | Bạn đang JOIN nhân bản rồi dedup → dùng `EXISTS` |
| `DISTINCT` trên primary key | Vô nghĩa — PK đã unique |
| `SELECT DISTINCT *` | Gần như chắc chắn **sai thiết kế query** |
| `GROUP BY` tất cả cột trong SELECT | Thường là biến tấu của `DISTINCT` — xem lại logic |

> [!WARNING]
> Nếu bạn phải thêm `DISTINCT` để "fix duplicate" — **dừng lại**. Duplicate là triệu chứng, không phải bệnh. Hãy xem lại JOIN condition — có thể bạn đang JOIN sai hoặc thiếu điều kiện.

---

## 11. Anti-pattern #10: WHERE vs HAVING — Lọc sai chỗ

### 11.1. Câu chuyện

Thống kê tổng doanh thu theo user, chỉ lấy user đăng ký từ 2024:

```sql
-- ❌ Sai: lọc bằng HAVING
SELECT u.id, u.name, SUM(o.total) AS revenue
FROM users u
JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.name
HAVING u.created_at >= '2024-01-01';
```

### 11.2. Vấn đề cốt lõi

Thứ tự thực thi SQL:

```d2 title="Lọc trước và sau aggregation"
direction: down
n0: "FROM / JOIN: join bảng"
n1: "WHERE: lọc rows"
n2: "GROUP BY: gom nhóm"
n3: "Aggregate: SUM, COUNT, AVG"
n4: "HAVING: lọc nhóm"
n5: "SELECT: chọn cột"
n6: "ORDER BY: sắp xếp"
n7: "LIMIT / OFFSET: cắt"
n0 -> n1 -> n2 -> n3 -> n4 -> n5 -> n6 -> n7
```

`HAVING` lọc **sau GROUP BY** — nghĩa là database phải:

1. JOIN toàn bộ `users` × `orders` (hàng triệu rows)
2. GROUP BY tất cả users
3. **Mới lọc** `created_at >= '2024-01-01'` → vứt đi phần lớn

`WHERE` lọc **trước GROUP BY** — giảm khối lượng data ngay từ đầu:

```sql
-- ✅ Đúng: lọc bằng WHERE
SELECT u.id, u.name, SUM(o.total) AS revenue
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id, u.name;
```

### 11.3. Benchmark

| Cách | Rows vào GROUP BY | Thời gian |
|------|-------------------|-----------|
| HAVING (lọc sau) | 20,000,000 (toàn bộ) | 4,500 ms |
| WHERE (lọc trước) | 1,200,000 (chỉ user từ 2024) | 380 ms |

> [!IMPORTANT]
> **HAVING** chỉ nên dùng cho điều kiện trên **kết quả aggregate** — ví dụ `HAVING SUM(total) > 10000` hoặc `HAVING COUNT(*) >= 5`. Bất kỳ điều kiện nào **không liên quan đến aggregate** → đặt ở `WHERE`.

---

## 12. Anti-pattern #11: ORDER BY không có Index

### 12.1. Câu chuyện

```sql
SELECT id, user_id, total, created_at
FROM orders
WHERE status = 'paid'
ORDER BY total DESC
LIMIT 20;
```

```text
 Limit  (actual time=1234.567..1234.589 rows=20 loops=1)
   ->  Sort  (actual time=1234.565..1234.578 rows=20 loops=1)
         Sort Key: total DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Bitmap Heap Scan on orders  (actual time=45.678..987.654 rows=850000 loops=1)
               Recheck Cond: (status = 'paid')
               ->  Bitmap Index Scan on idx_orders_status
                     Index Cond: (status = 'paid')
 Execution Time: 1234.890 ms
```

Database lọc 850,000 rows match `status = 'paid'`, rồi **sort toàn bộ** để lấy top 20. Sort 850,000 rows tốn **~1.2 giây**.

### 12.2. Fix: Composite index bao gồm sort column

```sql
CREATE INDEX idx_orders_status_total ON orders(status, total DESC);
```

```text
 Limit  (actual time=0.035..0.078 rows=20 loops=1)
   ->  Index Scan using idx_orders_status_total on orders
         (actual time=0.033..0.074 rows=20 loops=1)
         Index Cond: (status = 'paid')
 Execution Time: 0.098 ms
```

**Từ 1,234ms → 0.1ms**. Index đã **sắp sẵn** theo `(status, total DESC)` → database chỉ cần đọc 20 entries đầu tiên từ index, không sort gì cả.

### 12.3. Quy tắc xây composite index cho WHERE + ORDER BY

```d2 title="Range column có thể cản order theo cột phía sau"
direction: down
b0: "Equality rồi sort" {
  n0: "WHERE status=paid ORDER BY total DESC\nLIMIT 20"
  n1: "Candidate index (status,total DESC)"
  n0 -> n1
}
b1: "Equality, date range rồi sort total" {
  n0: "WHERE status=paid AND created_at >\n2024-01-01 ORDER BY total DESC"
  n1: "Candidate (status,created_at,total DESC)\ngiúp date range"
  n2: "Không tự cung cấp global total order qua\nnhiều dates"
  n3: "So với (status,total DESC) rồi filter\ncreated_at"
  n0 -> n1
  n1 -> n2
  n2 -> n3
}
```

Composite index thường bắt đầu từ equality prefix, rồi chọn giữa mục tiêu thu hẹp range và tránh sort. Lựa chọn cần đo lượng rows đọc thừa, thứ tự key và LIMIT, không có index tối ưu duy nhất cho mọi phân bố dữ liệu.

> [!TIP]
> **Equality columns trước, sort columns sau.** Nếu có range condition (`>`, `<`, `BETWEEN`), nó phải đặt **sau equality** nhưng **trước sort** sẽ **chặn** index sort — cân nhắc trade-off.

---

## 13. Anti-pattern #12: Quá nhiều JOIN — Khi nào nên denormalize

### 13.1. Câu chuyện

Report cần hiển thị: tên sản phẩm, tên category, tên supplier, tên warehouse, tên shipper, tên user, tên city — tất cả trong 1 query:

```sql
SELECT o.id, o.total,
       u.name AS user_name, c.name AS city_name,
       p.name AS product_name, cat.name AS category_name,
       s.name AS supplier_name, w.name AS warehouse_name,
       sh.name AS shipper_name
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN cities c ON c.id = u.city_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN categories cat ON cat.id = p.category_id
JOIN suppliers s ON s.id = p.supplier_id
JOIN warehouses w ON w.id = p.warehouse_id
JOIN shippers sh ON sh.id = o.shipper_id
WHERE o.created_at >= '2024-01-01'
ORDER BY o.created_at DESC
LIMIT 100;
```

**8 JOINs** — optimizer phải quyết định **thứ tự join**, loại join, và cách buffer. Số lượng plan khả thi tăng theo **giai thừa**: 8 bảng = 8! = 40,320 plan candidates.

### 13.2. Vấn đề cốt lõi

| Số bảng JOIN | Plan candidates | Planning time overhead |
|-------------|----------------|----------------------|
| 3 | 6 | Không đáng kể |
| 5 | 120 | Nhẹ |
| 8 | 40,320 | Đáng kể |
| 10 | 3,628,800 | Optimizer có thể **timeout** và chọn plan sub-optimal |
| 12+ | 479,001,600+ | Optimizer **cắt bớt** search space → plan có thể tệ |

> [!NOTE]
> Postgres giới hạn `join_collapse_limit` (mặc định 8) và `from_collapse_limit` (mặc định 8). Quá giới hạn → optimizer không thử tất cả hoán vị → có thể chọn plan xấu.

### 13.3. Fix: Denormalize cho read-heavy queries

**Materialized View** — tính trước và cache kết quả:

```sql
CREATE MATERIALIZED VIEW mv_order_report AS
SELECT o.id, o.total, o.created_at, o.status,
       u.name AS user_name,
       p.name AS product_name,
       cat.name AS category_name
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN categories cat ON cat.id = p.category_id
WHERE o.created_at >= '2024-01-01';

CREATE INDEX idx_mv_report_created ON mv_order_report(created_at DESC);

-- Refresh định kỳ (cron hoặc trigger)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_order_report;
```

Query report giờ chỉ cần:

```sql
SELECT * FROM mv_order_report ORDER BY created_at DESC LIMIT 100;
-- 0.5ms thay vì 2-3 giây
```

### 13.4. Khi nào denormalize

| Tiêu chí | Normalize (JOIN) | Denormalize |
|----------|-----------------|-------------|
| Tần suất read vs write | Write-heavy | **Read-heavy** (>10:1) |
| Consistency yêu cầu | Real-time | Chấp nhận eventually consistent |
| Số JOIN | ≤5 | **>5** |
| Query latency yêu cầu | Không strict | **<50ms** |
| Data volume | Nhỏ/trung | **Lớn** (>10M rows) |

---

## 14. Anti-pattern #13: COUNT(*) trên bảng lớn

### 14.1. Câu chuyện

Dashboard hiển thị "Tổng đơn hàng: 20,145,832":

```sql
SELECT COUNT(*) FROM orders;
```

```text
 Aggregate  (actual time=3456.789..3456.791 rows=1 loops=1)
   ->  Seq Scan on orders  (actual time=0.008..2345.678 rows=20000000 loops=1)
 Execution Time: 3456.890 ms
```

**3.5 giây** cho một con số duy nhất.

### 14.2. Vấn đề cốt lõi — MVCC

Trên Postgres, `COUNT(*)` **phải đọc từng row** vì **MVCC** — mỗi transaction thấy snapshot khác nhau của data. Postgres **không duy trì** số đếm sẵn.

MySQL InnoDB cũng tương tự — `COUNT(*)` phải scan index (nhanh hơn table scan, nhưng vẫn O(n)).

> [!NOTE]
> MyISAM (MySQL) lưu row count sẵn → `SELECT COUNT(*) FROM table` (không WHERE) trả về **ngay lập tức**. Nhưng MyISAM không có transaction, không ai dùng cho production nghiêm túc nữa.

### 14.3. Fix: Tuỳ mức chính xác cần

**Cách 1 — Xấp xỉ (nhanh nhất, <1ms):**

```sql
-- Postgres: estimate từ pg_class
SELECT reltuples::BIGINT AS estimate
FROM pg_class
WHERE relname = 'orders';
-- → 20,145,832 (sai số ~vài %, cập nhật sau ANALYZE/VACUUM)

-- MySQL: SHOW TABLE STATUS
SHOW TABLE STATUS LIKE 'orders';
-- Cột Rows cho estimate
```

**Cách 2 — Cache trong bảng riêng:**

```sql
CREATE TABLE stats (
    table_name VARCHAR(100) PRIMARY KEY,
    row_count  BIGINT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cập nhật bằng trigger hoặc background job
CREATE OR REPLACE FUNCTION update_orders_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE stats SET row_count = row_count + 1, updated_at = NOW()
        WHERE table_name = 'orders';
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE stats SET row_count = row_count - 1, updated_at = NOW()
        WHERE table_name = 'orders';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
```

<SourceRef project="optimization-query-optimization-patterns" file="143-fix-tuỳ-mức-chính-xác-cần/2.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

**Cách 3 — COUNT với điều kiện thì dùng Index:**

```sql
-- Nếu chỉ cần đếm 1 status
SELECT COUNT(*) FROM orders WHERE status = 'pending';
-- Với index trên status → Index-Only Scan, nhanh hơn nhiều

-- Hoặc covering index
CREATE INDEX idx_orders_status_covering ON orders(status) INCLUDE (id);
```

---

## 15. Anti-pattern #14: INSERT/UPDATE từng row trong vòng lặp

### 15.1. Câu chuyện

Import 10,000 products từ CSV:

```javascript
for (const product of products) {
  await db.query(
    'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3)',
    [product.name, product.price, product.stock]
  );
}
```

**10,000 round-trips**, mỗi cái: parse → plan → execute → commit → ACK. **Tổng: ~45 giây.**

### 15.2. Fix: Batch INSERT

```sql
-- Postgres: multi-value INSERT
INSERT INTO products (name, price, stock) VALUES
    ('Product 1', 29.99, 100),
    ('Product 2', 49.99, 50),
    ('Product 3', 19.99, 200),
    ... -- 1000 rows mỗi batch
;
```

```javascript
// Node.js: batch 1000 rows
const batchSize = 1000;
for (let i = 0; i < products.length; i += batchSize) {
  const batch = products.slice(i, i + batchSize);
  const values = batch.map((p, j) =>
    `($${j*3+1}, $${j*3+2}, $${j*3+3})`
  ).join(', ');
  const params = batch.flatMap(p => [p.name, p.price, p.stock]);
  await db.query(
    `INSERT INTO products (name, price, stock) VALUES ${values}`,
    params
  );
}
```

**Postgres-specific — COPY (nhanh nhất):**

```sql
COPY products (name, price, stock) FROM '/tmp/products.csv' CSV HEADER;
```

### 15.3. Benchmark: 10,000 rows

| Cách | Queries | Thời gian |
|------|---------|-----------|
| Loop từng row | 10,000 | **45,000 ms** |
| Batch 100 rows | 100 | **1,200 ms** |
| Batch 1,000 rows | 10 | **450 ms** |
| Single INSERT 10,000 | 1 | **380 ms** |
| COPY | 1 (stream) | **120 ms** |

> [!TIP]
> Batch size tối ưu thường từ **500–2,000 rows**. Quá lớn → risk lock contention và transaction log bloat. `COPY` luôn nhanh nhất cho bulk load trên Postgres.

### 15.4. UPDATE hàng loạt — dùng CTE hoặc temp table

```sql
-- Thay vì loop UPDATE từng row:
-- UPDATE products SET price = 29.99 WHERE id = 1;
-- UPDATE products SET price = 49.99 WHERE id = 2;
-- ...

-- Dùng CTE:
WITH new_prices (id, price) AS (
    VALUES (1, 29.99), (2, 49.99), (3, 19.99)
)
UPDATE products p
SET price = np.price
FROM new_prices np
WHERE p.id = np.id;
```

---

## 16. Anti-pattern #15: SELECT ... FOR UPDATE quá rộng

### 16.1. Câu chuyện

Xử lý payment: kiểm tra stock rồi trừ:

```sql
BEGIN;

-- Lock TẤT CẢ products (!)
SELECT * FROM products WHERE category_id = 5 FOR UPDATE;

-- Chỉ update 1 product
UPDATE products SET stock = stock - 1 WHERE id = 1234;

COMMIT;
```

### 16.2. Vấn đề cốt lõi

`FOR UPDATE` lock **tất cả rows** match WHERE condition. Lock giữ cho đến `COMMIT/ROLLBACK`. Trong khi transaction này giữ lock trên 500 products (category_id = 5), **mọi transaction khác** muốn update bất kỳ product nào trong category đó phải **đợi**.

```d2 title="Lock quá rộng làm hàng đợi lan rộng"
direction: right
a: "A: SELECT category_id=5 FOR UPDATE → lock 500 rows"
update: "A chỉ UPDATE 1 row, giữ thêm 499 lock tới COMMIT"
b: "B UPDATE id=5678 cùng category: BLOCKED"
others: "C, D, E... cùng chờ → queue buildup"
a -> update
update -> b: "chờ A commit"
b -> others
```

### 16.3. Fix: Lock chỉ row cần thiết

```sql
BEGIN;

-- Lock ĐÚNG 1 row cần update
SELECT * FROM products WHERE id = 1234 FOR UPDATE;

-- Kiểm tra stock
-- Nếu OK → update
UPDATE products SET stock = stock - 1 WHERE id = 1234;

COMMIT;
```

Hoặc dùng `FOR UPDATE SKIP LOCKED` cho queue pattern:

```sql
-- Worker lấy task tiếp theo, skip rows đang bị lock
SELECT * FROM task_queue
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

> [!WARNING]
> **Quy tắc**: `FOR UPDATE` chỉ lock **đúng rows bạn cần modify**. Lock scope càng nhỏ → throughput càng cao → deadlock càng ít.

---

## 17. So sánh cách optimizer xử lý giữa Postgres / MySQL / Oracle

Mỗi database có cách xử lý riêng cho các anti-pattern. Bảng dưới đây so sánh **hành vi mặc định** — không tính hints hay config tuning.

| Anti-pattern | PostgreSQL | MySQL (InnoDB) | Oracle |
|-------------|------------|----------------|--------|
| `SELECT *` + covering index | Index-Only Scan nếu visibility map OK | Covering index scan (dùng `EXPLAIN` kiểm tra `Using index`) | Index Fast Full Scan nếu tất cả cột trong index |
| N+1 | Không optimize tự động — phải fix ở app layer | Không optimize tự động | Không optimize tự động |
| Implicit type conversion | **Strict** — thường báo lỗi type mismatch | **Silent cast** — hay cast cột → kill index | **Silent cast** — tương tự MySQL |
| Function on column | Hỗ trợ **expression index** | Hỗ trợ **generated column + index** (MySQL 5.7+), **functional index** (MySQL 8.0.13+) | Hỗ trợ **function-based index** |
| OR cross-column | **BitmapOr** — merge 2 bitmap scans | Thường **Full Table Scan** hoặc index_merge (không ổn định) | **CONCATENATION** — tương tự UNION |
| Correlated subquery | Có thể convert thành **Semi Join / Anti Join** tự động | Từ MySQL 8.0.16+ có **subquery to semi-join** | **UNNEST** subquery tự động |
| OFFSET pagination | Không optimize — luôn đọc + vứt | Không optimize | **ROW_NUMBER** analytics efficient hơn |
| NOT IN NULL | Trả **empty set** (chuẩn SQL) | Trả **empty set** | Trả **empty set** |
| COUNT(*) full table | **Seq Scan** (MVCC) — không cache count | **Index scan** (chọn smallest index) — nhanh hơn Postgres | **Index Fast Full Scan** — nhanh |
| Batch INSERT | **COPY** nhanh nhất, multi-value INSERT OK | **LOAD DATA INFILE** nhanh nhất, multi-value INSERT OK | **SQL*Loader** hoặc **INSERT ALL** |

> [!TIP]
> Postgres **strict hơn** về type safety (tốt — bắt lỗi sớm). MySQL **linh hoạt hơn** nhưng dễ gây bug ẩn (implicit cast). Oracle **mạnh optimizer** nhất nhưng licensing đắt.

---

## 18. Công cụ phát hiện query chậm

### 18.1. PostgreSQL

```sql
-- Bật pg_stat_statements (phải thêm vào shared_preload_libraries)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top 10 query chậm nhất (tổng thời gian)
SELECT query,
       calls,
       total_exec_time::INT AS total_ms,
       mean_exec_time::INT AS avg_ms,
       rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- Top 10 query gọi nhiều nhất (N+1 suspect)
SELECT query, calls, mean_exec_time::INT AS avg_ms
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10;
```

<SourceRef project="optimization-query-optimization-patterns" file="181-postgresql/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

```sql
-- auto_explain — log plan cho query chậm
LOAD 'auto_explain';
SET auto_explain.log_min_duration = '100ms';
SET auto_explain.log_analyze = true;
```

### 18.2. MySQL

```sql
-- Bật slow query log
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 0.1;   -- log query > 100ms
SET GLOBAL log_queries_not_using_indexes = 'ON';

-- Xem slow queries
-- File: /var/lib/mysql/hostname-slow.log
-- Hoặc dùng mysqldumpslow để phân tích

-- Performance Schema — top queries
SELECT DIGEST_TEXT, COUNT_STAR, AVG_TIMER_WAIT/1000000000 AS avg_ms
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;
```

### 18.3. Oracle

```sql
-- AWR Report (Automatic Workload Repository)
-- Top SQL by elapsed time
SELECT sql_id, elapsed_time/1000000 AS elapsed_sec, executions, sql_text
FROM v$sql
ORDER BY elapsed_time DESC
FETCH FIRST 10 ROWS ONLY;

-- SQL Monitor (real-time)
SELECT DBMS_SQLTUNE.REPORT_SQL_MONITOR(sql_id => 'abc123') FROM dual;
```

### 18.4. Checklist review query trước khi deploy

- [ ] SELECT projection đúng các cột cần?
- [ ] Có N+1, cần batch/eager load/JOIN phù hợp?
- [ ] Bind parameter đúng kiểu?
- [ ] Function/cast trên key có sargable hoặc expression index?
- [ ] OR/UNION có giữ duplicates và NULL semantics đúng?
- [ ] Correlated subquery có lặp nhiều và có thể decorrelate đúng?
- [ ] OFFSET sâu có phù hợp keyset?
- [ ] NOT IN có NULL và DISTINCT có phản ánh đúng multiplicity?
- [ ] WHERE/HAVING đặt đúng semantics?
- [ ] ORDER BY/LIMIT và composite key có phù hợp access path?
- [ ] Nhiều JOIN: đã đo plan trước khi cân nhắc denormalize/MV?
- [ ] COUNT có cần exact, hay estimate/cache đủ dùng?
- [ ] Bulk write có thể batch/COPY?
- [ ] FOR UPDATE giới hạn đúng rows và duration?

---

## 19. Tóm tắt — Cheat sheet & 3 nguyên tắc

Quay lại câu hỏi đầu doc: **Tại sao dashboard 200ms biến thành 12 giây?**

> Không phải vì thiếu index — mà vì **cách viết query** khiến optimizer không thể dùng index đã có, hoặc bắt database làm nhiều việc thừa gấp trăm lần.

### 19.1. Cheat sheet anti-pattern → fix

| Anti-pattern / tình huống | Hướng xem xét, không áp dụng máy móc |
| --- | --- |
| SELECT * | Chọn cột cần và covering nếu có lợi |
| N+1 query | JOIN / eager loading / batching |
| Implicit conversion | Bind đúng kiểu |
| Function on column | SARGable predicate hoặc expression index |
| OR cross-column | Bitmap/index merge hoặc UNION; xử lý duplicates |
| Correlated subquery lặp nhiều | Decorrelate / JOIN + GROUP BY nếu cùng semantics |
| OFFSET sâu | Keyset / cursor pagination |
| NOT IN có NULL | NOT EXISTS nếu đúng ngữ nghĩa |
| DISTINCT thừa | Kiểm tra multiplicity / EXISTS |
| HAVING thay WHERE | Non-aggregate filter ở WHERE nếu tương đương |
| ORDER BY thiếu ordered access | Index phù hợp hoặc chấp nhận sort sau khi đo |
| Nhiều JOIN | Đo plan trước; không mặc định denormalize/MV |
| COUNT toàn bảng | Exact count, estimate hoặc cache theo yêu cầu |
| Loop INSERT | Batch / COPY |
| FOR UPDATE scope rộng | Chỉ lock rows và thời gian cần thiết |

### 19.2. Bảng impact ước tính

| Anti-pattern | Slow-down tiềm năng | Khó phát hiện? |
|-------------|---------------------|----------------|
| SELECT * | 10-2,000x | Trung — ẩn trong ORM |
| N+1 | 10-500x | Dễ — đếm queries trong log |
| Implicit cast | 100-10,000x | **Khó** — MySQL silent |
| Function on column | 50-1,000x | Trung — check EXPLAIN |
| OR cross-column | 5-100x | Dễ — check EXPLAIN |
| Correlated subquery | 10-100x | Trung — check loops count |
| OFFSET lớn | 10-1,000x | Dễ — trang xa = chậm |
| NOT IN NULL | ∞ (sai kết quả) | **Rất khó** — logic bug |
| DISTINCT thừa | 2-20x | Trung |
| HAVING thay WHERE | 2-50x | Dễ |
| ORDER BY no index | 5-500x | Trung |
| Nhiều JOIN | 2-100x | Trung — planning time |
| COUNT(*) full | Cố định O(n) | Dễ |
| Loop INSERT | 50-500x | Dễ |
| FOR UPDATE rộng | 1-∞ (contention) | **Khó** — chỉ thấy dưới load |

### 19.3. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Luôn chạy EXPLAIN ANALYZE trước khi deploy query mới.**
> Đọc kỹ: `Seq Scan` trên bảng lớn = 🚩. `loops=N` với N lớn = 🚩. `Rows Removed by Filter` lớn hơn `rows` nhiều lần = 🚩.
>
> **2. Query viết cho người đọc — index viết cho optimizer.**
> Hiểu thứ tự thực thi SQL (FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY). Đặt filter đúng chỗ. Truyền đúng kiểu. Giữ cột "sạch" — không bọc function.
>
> **3. Đo trước, optimize sau — nhưng đừng đợi production mới đo.**
> Bật `pg_stat_statements` / slow query log **ngay từ development**. Phát hiện N+1, implicit cast, missing index **trước** khi user phàn nàn.

### 19.4. Quote cuối

> Viết SQL giống viết văn — cùng ý nghĩa, nhưng **cách diễn đạt** quyết định hiệu quả. Một câu query "đúng kết quả" có thể chậm hơn **10,000 lần** so với câu query "đúng cách viết". Sự khác biệt nằm ở việc hiểu **optimizer nghĩ gì** — không phải bạn nghĩ gì.

Lần sau khi viết query, hãy tự hỏi: *"Mình đang bắt database làm bao nhiêu việc thừa?"* — Câu trả lời thường sẽ khiến bạn bất ngờ.
