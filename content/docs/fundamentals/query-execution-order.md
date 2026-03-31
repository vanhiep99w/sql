---
title: "Thứ tự thực thi SQL Query"
description: "Hiểu đúng thứ tự database thực sự chạy một câu SELECT — từ FROM đến LIMIT — và tại sao nó quan trọng"
---

## Mục lục

- [Bạn viết vs Database chạy](#bạn-viết-vs-database-chạy)
- [Thứ tự thực thi đầy đủ](#thứ-tự-thực-thi-đầy-đủ)
- [Từng bước chi tiết](#từng-bước-chi-tiết)
  - [Bước 1 — FROM & JOIN](#bước-1--from--join)
  - [Bước 2 — WHERE](#bước-2--where)
  - [Bước 3 — GROUP BY](#bước-3--group-by)
  - [Bước 4 — HAVING](#bước-4--having)
  - [Bước 5 — SELECT](#bước-5--select)
  - [Bước 6 — DISTINCT](#bước-6--distinct)
  - [Bước 7 — ORDER BY](#bước-7--order-by)
  - [Bước 8 — LIMIT / OFFSET](#bước-8--limit--offset)
- [Ví dụ thực tế end-to-end](#ví-dụ-thực-tế-end-to-end)
- [Những lỗi hay gặp do nhầm thứ tự](#những-lỗi-hay-gặp-do-nhầm-thứ-tự)
- [Window Function nằm ở đâu?](#window-function-nằm-ở-đâu)
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

Nhưng database **không chạy theo thứ tự đó**. Database chạy theo thứ tự logic khác hoàn toàn.

Đây là nguồn gốc của hầu hết các lỗi mà developer hay gặp kiểu như:

- *"Tại sao dùng alias ở WHERE lại báo lỗi?"*
- *"Tại sao HAVING lại filter sau GROUP BY chứ không phải trước?"*
- *"Tại sao COUNT(*) trong WHERE không chạy được?"*

---

## Thứ tự thực thi đầy đủ

```
1. FROM / JOIN        → Xác định nguồn dữ liệu, tạo bảng trung gian lớn
2. WHERE              → Lọc từng row trước khi gom nhóm
3. GROUP BY           → Gom các row thành nhóm
4. HAVING             → Lọc các nhóm (sau khi đã gom)
5. SELECT             → Tính toán các cột cần trả về
6. DISTINCT           → Loại bỏ row trùng lặp
7. ORDER BY           → Sắp xếp kết quả
8. LIMIT / OFFSET     → Cắt lấy số lượng row cần thiết
```

Ghi nhớ nhanh: **F-W-G-H-S-D-O-L** *(From Where Group Having Select Distinct Order Limit)*

---

## Từng bước chi tiết

### Bước 1 — FROM & JOIN

**Database làm gì:** Đọc dữ liệu từ tất cả các bảng được chỉ định, sau đó thực hiện JOIN để tạo ra một bảng trung gian ("virtual table").

```sql
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p  ON o.product_id  = p.id
```

Kết quả bước này là một bảng khổng lồ chứa toàn bộ dữ liệu từ 3 bảng được ghép lại. Mọi bước tiếp theo đều làm việc trên bảng trung gian này.

> **Tại sao FROM trước?** Vì không biết lấy dữ liệu từ đâu thì không làm gì được cả.

---

### Bước 2 — WHERE

**Database làm gì:** Duyệt từng row trong bảng trung gian từ bước 1, giữ lại row nào thỏa điều kiện, bỏ đi row không thỏa.

```sql
WHERE o.status = 'completed'
  AND o.created_at >= '2024-01-01'
```

**Quan trọng:** Ở bước này, `GROUP BY` chưa chạy → các aggregate function như `COUNT()`, `SUM()` **chưa có giá trị** → không thể dùng trong WHERE.

```sql
-- ❌ SAI: COUNT chưa được tính ở bước WHERE
WHERE COUNT(o.id) > 5

-- ✅ ĐÚNG: dùng HAVING sau GROUP BY
HAVING COUNT(o.id) > 5
```

---

### Bước 3 — GROUP BY

**Database làm gì:** Gom các row có cùng giá trị ở cột chỉ định thành một nhóm. Mỗi nhóm sau này sẽ trở thành một row trong kết quả cuối.

```sql
GROUP BY c.id, c.name
```

Sau bước này, thay vì nhiều row riêng lẻ, database có các **nhóm** — mỗi nhóm đại diện cho một khách hàng. Các aggregate function (`COUNT`, `SUM`, `AVG`, `MAX`, `MIN`) bây giờ mới có thể tính được vì đã biết nhóm.

---

### Bước 4 — HAVING

**Database làm gì:** Lọc các **nhóm** (không phải row) dựa trên kết quả aggregate.

```sql
HAVING COUNT(o.id) > 5
   AND SUM(o.total_amount) > 1000000
```

**Sự khác biệt WHERE vs HAVING:**

| | WHERE | HAVING |
|---|---|---|
| Chạy ở bước | 2 (trước GROUP BY) | 4 (sau GROUP BY) |
| Lọc đơn vị | Từng **row** | Từng **nhóm** |
| Dùng aggregate? | ❌ Không | ✅ Có |
| Ảnh hưởng performance | Tốt hơn (bỏ row sớm) | Tốn hơn (đã gom rồi mới bỏ) |

> **Rule of thumb:** Nếu điều kiện không cần aggregate → dùng WHERE. Nếu cần aggregate → dùng HAVING.

---

### Bước 5 — SELECT

**Database làm gì:** Lúc này mới tính toán các cột bạn yêu cầu trả về — bao gồm expressions, alias, aggregate functions.

```sql
SELECT
  c.name,
  COUNT(o.id)          AS total_orders,
  SUM(o.total_amount)  AS revenue
```

**Đây là lý do alias không dùng được ở WHERE và HAVING:**

```sql
-- ❌ SAI: 'revenue' chưa tồn tại ở bước WHERE (bước 2)
SELECT SUM(total_amount) AS revenue
FROM orders
WHERE revenue > 1000000   -- Database chưa biết 'revenue' là gì!

-- ✅ ĐÚNG
SELECT SUM(total_amount) AS revenue
FROM orders
HAVING SUM(total_amount) > 1000000
```

> **Ngoại lệ:** PostgreSQL và một số DB cho phép dùng alias trong `ORDER BY` vì ORDER BY chạy sau SELECT. Nhưng trong WHERE/HAVING thì không.

---

### Bước 6 — DISTINCT

**Database làm gì:** Loại bỏ các row hoàn toàn giống nhau trong tập kết quả.

```sql
SELECT DISTINCT c.city
FROM customers c
```

DISTINCT chạy **sau SELECT** vì phải biết tập cột kết quả trước rồi mới so sánh được.

---

### Bước 7 — ORDER BY

**Database làm gì:** Sắp xếp tập kết quả theo cột/expression chỉ định.

```sql
ORDER BY revenue DESC, c.name ASC
```

ORDER BY chạy **sau SELECT** nên có thể dùng alias đã định nghĩa trong SELECT:

```sql
-- ✅ Hợp lệ vì ORDER BY chạy sau SELECT
SELECT SUM(total_amount) AS revenue
FROM orders
GROUP BY customer_id
ORDER BY revenue DESC   -- alias 'revenue' đã tồn tại ở bước 5
```

**Lưu ý:** ORDER BY là bước tốn kém (cần sort toàn bộ dataset). Nếu chỉ cần LIMIT vài row → database có thể tối ưu dùng heap sort thay vì full sort.

---

### Bước 8 — LIMIT / OFFSET

**Database làm gì:** Cắt lấy số lượng row theo yêu cầu, bỏ qua các row nằm trong OFFSET.

```sql
LIMIT 10 OFFSET 20   -- Lấy 10 row, bỏ qua 20 row đầu (trang 3)
```

LIMIT chạy **cuối cùng** vì phải có đầy đủ tập kết quả (đã sort) trước rồi mới biết row nào là row 1, 2, 3...

> **Vấn đề với OFFSET lớn:** `OFFSET 10000 LIMIT 10` vẫn phải scan qua 10,010 rows rồi mới bỏ 10,000 đi. Với dataset lớn, dùng **keyset pagination** (WHERE id > last_seen_id) sẽ hiệu quả hơn nhiều.

---

## Ví dụ thực tế end-to-end

**Bài toán:** Tìm top 5 khách hàng VIP năm 2024 — là những người đã mua ít nhất 3 đơn hoàn thành và tổng chi tiêu trên 10 triệu, sắp xếp theo doanh số giảm dần.

```sql
SELECT                                    -- Bước 5
    c.name,
    COUNT(o.id)         AS total_orders,
    SUM(o.total_amount) AS revenue
FROM orders o                             -- Bước 1
JOIN customers c ON o.customer_id = c.id  -- Bước 1
WHERE
    o.status     = 'completed'            -- Bước 2
    AND o.created_at >= '2024-01-01'      -- Bước 2
    AND o.created_at <  '2025-01-01'      -- Bước 2
GROUP BY c.id, c.name                     -- Bước 3
HAVING
    COUNT(o.id)         >= 3              -- Bước 4
    AND SUM(o.total_amount) > 10000000    -- Bước 4
ORDER BY revenue DESC                     -- Bước 7
LIMIT 5;                                  -- Bước 8
```

**Trace từng bước:**

```
Bước 1 — FROM + JOIN
  → Ghép orders + customers → bảng trung gian ~1,000,000 rows

Bước 2 — WHERE
  → Giữ lại orders năm 2024 + status='completed'
  → Còn ~200,000 rows

Bước 3 — GROUP BY c.id, c.name
  → Gom thành ~15,000 nhóm (15,000 khách hàng)

Bước 4 — HAVING
  → Giữ nhóm có >= 3 đơn VÀ tổng > 10tr
  → Còn ~800 nhóm

Bước 5 — SELECT
  → Tính COUNT, SUM cho 800 nhóm đó
  → 800 rows với 3 cột: name, total_orders, revenue

Bước 7 — ORDER BY revenue DESC
  → Sort 800 rows theo revenue

Bước 8 — LIMIT 5
  → Cắt lấy 5 rows đầu tiên
```

---

## Những lỗi hay gặp do nhầm thứ tự

### Lỗi 1: Dùng alias trong WHERE

```sql
-- ❌ Lỗi: column "discounted" does not exist
SELECT price * 0.9 AS discounted
FROM products
WHERE discounted < 100;

-- ✅ Fix: lặp lại expression hoặc dùng subquery
SELECT price * 0.9 AS discounted
FROM products
WHERE price * 0.9 < 100;

-- ✅ Fix cách khác: dùng subquery/CTE
SELECT * FROM (
  SELECT price * 0.9 AS discounted FROM products
) t
WHERE t.discounted < 100;
```

---

### Lỗi 2: Dùng aggregate trong WHERE

```sql
-- ❌ Lỗi: aggregate functions are not allowed in WHERE
SELECT customer_id, COUNT(*) AS cnt
FROM orders
WHERE COUNT(*) > 5
GROUP BY customer_id;

-- ✅ Fix: chuyển sang HAVING
SELECT customer_id, COUNT(*) AS cnt
FROM orders
GROUP BY customer_id
HAVING COUNT(*) > 5;
```

---

### Lỗi 3: SELECT * kết hợp GROUP BY

```sql
-- ❌ Lỗi: column "o.created_at" must appear in GROUP BY or aggregate
SELECT *
FROM orders o
JOIN customers c ON o.customer_id = c.id
GROUP BY c.id;

-- ✅ Fix: chỉ SELECT cột trong GROUP BY hoặc wrapped trong aggregate
SELECT c.id, c.name, COUNT(o.id) AS total_orders
FROM orders o
JOIN customers c ON o.customer_id = c.id
GROUP BY c.id, c.name;
```

---

### Lỗi 4: Nhầm WHERE và HAVING làm chậm query

```sql
-- ❌ Chậm: lọc status SAU KHI đã gom nhóm → xử lý nhiều data thừa
SELECT customer_id, COUNT(*) AS cnt
FROM orders
GROUP BY customer_id
HAVING status = 'completed';   -- Lọc attribute của row, không phải aggregate

-- ✅ Nhanh hơn: lọc status TRƯỚC khi gom nhóm → ít data hơn
SELECT customer_id, COUNT(*) AS cnt
FROM orders
WHERE status = 'completed'
GROUP BY customer_id;
```

---

## Window Function nằm ở đâu?

Window function (như `ROW_NUMBER()`, `RANK()`, `LAG()`, `SUM() OVER(...)`) chạy **sau SELECT nhưng trước ORDER BY**:

```
... → SELECT → [Window Functions] → DISTINCT → ORDER BY → LIMIT
```

Điều này có nghĩa là:

```sql
-- ✅ Có thể ORDER BY theo kết quả window function
SELECT
    name,
    salary,
    RANK() OVER (ORDER BY salary DESC) AS salary_rank
FROM employees
ORDER BY salary_rank;   -- ORDER BY chạy sau window function → OK
```

Nhưng **không thể dùng window function trong WHERE hay HAVING**:

```sql
-- ❌ Lỗi: window functions are not allowed in WHERE
SELECT name, salary
FROM employees
WHERE ROW_NUMBER() OVER (ORDER BY salary) <= 3;

-- ✅ Fix: wrap trong subquery hoặc CTE
SELECT * FROM (
  SELECT
    name,
    salary,
    ROW_NUMBER() OVER (ORDER BY salary DESC) AS rn
  FROM employees
) ranked
WHERE rn <= 3;
```

---

## Tổng kết nhanh

| Thứ tự | Mệnh đề | Làm gì | Biết gì |
|--------|---------|--------|---------|
| 1 | **FROM / JOIN** | Tạo bảng trung gian | Tất cả cột của các bảng |
| 2 | **WHERE** | Lọc từng row | Cột gốc, KHÔNG có aggregate, KHÔNG có alias SELECT |
| 3 | **GROUP BY** | Gom row thành nhóm | Cột gốc |
| 4 | **HAVING** | Lọc từng nhóm | Cột gốc + aggregate, KHÔNG có alias SELECT |
| 5 | **SELECT** | Tính cột trả về | Mọi thứ — tạo ra alias |
| 6 | **DISTINCT** | Bỏ row trùng | Kết quả sau SELECT |
| 7 | **ORDER BY** | Sắp xếp | Kết quả SELECT + alias ✅ |
| 8 | **LIMIT/OFFSET** | Cắt số row | Kết quả cuối cùng |

> **Quy tắc vàng:** Nếu bạn muốn dùng một thứ ở mệnh đề X, hỏi: *"Thứ đó đã tồn tại chưa ở bước X?"* Nếu chưa → lỗi. Giải pháp thường là subquery hoặc CTE để "đẩy" thứ đó ra bước trước.
