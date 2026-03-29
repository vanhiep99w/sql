---
title: "Tổng quan SQL"
description: "Các khái niệm cơ bản về SQL — loại câu lệnh, stored procedures, triggers, views và CTE"
---

## Mục lục

- [SQL là gì và tại sao quan trọng](#sql-là-gì-và-tại-sao-quan-trọng)
- [Các loại câu lệnh SQL](#các-loại-câu-lệnh-sql)
  - [DDL — Data Definition Language](#ddl--data-definition-language)
  - [DML — Data Manipulation Language](#dml--data-manipulation-language)
  - [DQL — Data Query Language](#dql--data-query-language)
  - [DCL — Data Control Language](#dcl--data-control-language)
  - [TCL — Transaction Control Language](#tcl--transaction-control-language)
- [Stored Procedures](#stored-procedures)
- [Trigger](#trigger)
- [View](#view)
- [CTE — Common Table Expression](#cte--common-table-expression)
- [B-Tree vs Binary Tree](#b-tree-vs-binary-tree)

---

## SQL là gì và tại sao quan trọng

**SQL** (Structured Query Language) là ngôn ngữ tiêu chuẩn để tương tác với cơ sở dữ liệu quan hệ (Relational Database). Hầu hết mọi hệ thống phần mềm — từ ứng dụng web, mobile đến hệ thống tài chính, thương mại điện tử — đều cần lưu trữ và truy vấn dữ liệu, và SQL là công cụ chính để làm điều đó.

**Tại sao SQL quan trọng:**

- **Chuẩn hóa**: SQL là tiêu chuẩn ANSI/ISO, hoạt động trên hầu hết các RDBMS như MySQL, PostgreSQL, Oracle, SQL Server.
- **Đơn giản và mạnh mẽ**: Cú pháp khai báo (declarative) giúp mô tả *cần gì* thay vì *làm thế nào*.
- **Tối ưu hiệu suất**: Query engine tự động tối ưu execution plan.
- **Hệ sinh thái lớn**: Hàng triệu developer, công cụ, tài liệu hỗ trợ.

## Các loại câu lệnh SQL

SQL được chia thành 5 nhóm câu lệnh chính, mỗi nhóm phục vụ mục đích khác nhau:

| Nhóm | Tên đầy đủ | Mục đích | Ví dụ lệnh |
|------|-----------|---------|------------|
| DDL | Data Definition Language | Định nghĩa cấu trúc database | `CREATE`, `ALTER`, `DROP`, `TRUNCATE` |
| DML | Data Manipulation Language | Thao tác dữ liệu | `INSERT`, `UPDATE`, `DELETE` |
| DQL | Data Query Language | Truy vấn dữ liệu | `SELECT` |
| DCL | Data Control Language | Quản lý quyền truy cập | `GRANT`, `REVOKE` |
| TCL | Transaction Control Language | Quản lý transaction | `COMMIT`, `ROLLBACK`, `SAVEPOINT` |

### DDL — Data Definition Language

DDL dùng để tạo, sửa đổi, xóa các đối tượng trong database như table, index, schema. Các lệnh DDL **tự động commit** — không thể rollback.

```sql
-- Tạo bảng
CREATE TABLE employees (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(255) UNIQUE,
    department  VARCHAR(50),
    salary      DECIMAL(12, 2),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Thêm cột mới
ALTER TABLE employees ADD COLUMN phone VARCHAR(20);

-- Đổi tên cột
ALTER TABLE employees RENAME COLUMN phone TO phone_number;

-- Xóa bảng (toàn bộ cấu trúc + dữ liệu)
DROP TABLE employees;

-- Xóa dữ liệu nhưng giữ cấu trúc bảng
TRUNCATE TABLE employees;
```

### DML — Data Manipulation Language

DML dùng để thêm, sửa, xóa dữ liệu bên trong bảng. Khác với DDL, các lệnh DML **có thể rollback** nếu nằm trong transaction.

```sql
-- Thêm dữ liệu
INSERT INTO employees (name, email, department, salary)
VALUES ('Nguyễn Văn A', 'a@company.com', 'Engineering', 25000000);

-- Cập nhật dữ liệu
UPDATE employees
SET salary = salary * 1.1
WHERE department = 'Engineering';

-- Xóa dữ liệu có điều kiện
DELETE FROM employees
WHERE id = 5;
```

### DQL — Data Query Language

DQL chỉ gồm câu lệnh `SELECT` — dùng để truy vấn và lấy dữ liệu từ database. Đây là câu lệnh được sử dụng nhiều nhất.

```sql
-- Truy vấn cơ bản
SELECT name, email, salary
FROM employees
WHERE department = 'Engineering'
ORDER BY salary DESC
LIMIT 10;

-- Truy vấn với JOIN
SELECT e.name, d.department_name, e.salary
FROM employees e
INNER JOIN departments d ON e.department_id = d.id
WHERE e.salary > 20000000;

-- Truy vấn với aggregate
SELECT department, COUNT(*) AS total, AVG(salary) AS avg_salary
FROM employees
GROUP BY department
HAVING AVG(salary) > 15000000;
```

### DCL — Data Control Language

DCL dùng để quản lý quyền truy cập, bảo mật dữ liệu trong database.

```sql
-- Cấp quyền SELECT và INSERT cho user
GRANT SELECT, INSERT ON employees TO 'app_user'@'localhost';

-- Thu hồi quyền
REVOKE INSERT ON employees FROM 'app_user'@'localhost';

-- Cấp tất cả quyền trên schema
GRANT ALL PRIVILEGES ON DATABASE mydb TO admin_user;
```

### TCL — Transaction Control Language

TCL dùng để quản lý transaction — đảm bảo tính toàn vẹn dữ liệu khi thực hiện nhiều thao tác liên quan.

```sql
-- Transaction cơ bản
BEGIN;

UPDATE accounts SET balance = balance - 1000000 WHERE id = 1;
UPDATE accounts SET balance = balance + 1000000 WHERE id = 2;

COMMIT;  -- Xác nhận tất cả thay đổi

-- Rollback khi có lỗi
BEGIN;

UPDATE accounts SET balance = balance - 1000000 WHERE id = 1;
-- Phát hiện lỗi...
ROLLBACK;  -- Hủy tất cả thay đổi

-- Sử dụng SAVEPOINT
BEGIN;
UPDATE accounts SET balance = balance - 500000 WHERE id = 1;
SAVEPOINT sp1;
UPDATE accounts SET balance = balance - 300000 WHERE id = 1;
-- Muốn hủy thao tác sau savepoint
ROLLBACK TO SAVEPOINT sp1;
COMMIT;
```

## Stored Procedures

Stored Procedure là một tập hợp các câu lệnh SQL được lưu trữ trong database, có thể tái sử dụng và nhận tham số đầu vào. Procedure chạy trực tiếp trên database server nên giảm lượng dữ liệu truyền qua mạng và tăng hiệu suất.

**Ưu điểm:**
- Tái sử dụng logic phức tạp
- Giảm network round-trip
- Kiểm soát bảo mật (cấp quyền execute thay vì truy cập trực tiếp bảng)

**Nhược điểm:**
- Khó debug, khó viết unit test
- Logic phân tán giữa application và database
- Khác biệt cú pháp giữa các RDBMS

### Cú pháp MySQL

```sql
DELIMITER //

CREATE PROCEDURE transfer_money(
    IN from_account INT,
    IN to_account INT,
    IN amount DECIMAL(12, 2)
)
BEGIN
    DECLARE current_balance DECIMAL(12, 2);

    -- Kiểm tra số dư
    SELECT balance INTO current_balance
    FROM accounts WHERE id = from_account;

    IF current_balance < amount THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Số dư không đủ';
    END IF;

    -- Thực hiện chuyển tiền
    START TRANSACTION;
        UPDATE accounts SET balance = balance - amount WHERE id = from_account;
        UPDATE accounts SET balance = balance + amount WHERE id = to_account;
    COMMIT;
END //

DELIMITER ;

-- Gọi procedure
CALL transfer_money(1, 2, 5000000);
```

### Cú pháp PostgreSQL

```sql
CREATE OR REPLACE FUNCTION transfer_money(
    from_account INT,
    to_account INT,
    amount DECIMAL(12, 2)
)
RETURNS VOID AS $$
DECLARE
    current_balance DECIMAL(12, 2);
BEGIN
    SELECT balance INTO current_balance
    FROM accounts WHERE id = from_account;

    IF current_balance < amount THEN
        RAISE EXCEPTION 'Số dư không đủ';
    END IF;

    UPDATE accounts SET balance = balance - amount WHERE id = from_account;
    UPDATE accounts SET balance = balance + amount WHERE id = to_account;
END;
$$ LANGUAGE plpgsql;

-- Gọi function
SELECT transfer_money(1, 2, 5000000);
```

## Trigger

Trigger là cơ chế tự động thực thi một tập hợp câu lệnh SQL **trước** hoặc **sau** khi xảy ra sự kiện `INSERT`, `UPDATE`, hoặc `DELETE` trên bảng.

**Khi nào nên dùng Trigger:**
- Tự động ghi log thay đổi dữ liệu (audit trail)
- Duy trì tính toàn vẹn dữ liệu phức tạp
- Tự động cập nhật bảng tổng hợp

**Khi nào KHÔNG nên dùng:**
- Logic nghiệp vụ phức tạp → nên để ở application layer
- Trigger gọi trigger khác (cascade) → khó kiểm soát

### Cú pháp và ví dụ

```sql
-- MySQL: Trigger ghi log khi cập nhật salary
CREATE TRIGGER log_salary_change
AFTER UPDATE ON employees
FOR EACH ROW
BEGIN
    IF OLD.salary <> NEW.salary THEN
        INSERT INTO salary_audit (employee_id, old_salary, new_salary, changed_at)
        VALUES (OLD.id, OLD.salary, NEW.salary, NOW());
    END IF;
END;

-- PostgreSQL: Trigger function + trigger
CREATE OR REPLACE FUNCTION log_salary_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.salary <> NEW.salary THEN
        INSERT INTO salary_audit (employee_id, old_salary, new_salary, changed_at)
        VALUES (OLD.id, OLD.salary, NEW.salary, NOW());
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salary_change_trigger
AFTER UPDATE ON employees
FOR EACH ROW
EXECUTE FUNCTION log_salary_change();
```

### Các loại Trigger

| Loại | Thời điểm | Mô tả |
|------|-----------|--------|
| `BEFORE INSERT` | Trước khi thêm | Validate hoặc transform dữ liệu trước khi lưu |
| `AFTER INSERT` | Sau khi thêm | Ghi log, cập nhật bảng tổng hợp |
| `BEFORE UPDATE` | Trước khi sửa | Kiểm tra điều kiện trước khi cho phép sửa |
| `AFTER UPDATE` | Sau khi sửa | Ghi log thay đổi |
| `BEFORE DELETE` | Trước khi xóa | Ngăn xóa nếu vi phạm logic |
| `AFTER DELETE` | Sau khi xóa | Dọn dẹp dữ liệu liên quan |

## View

View là một bảng ảo (virtual table) được tạo từ câu lệnh `SELECT`. View không lưu dữ liệu thật mà chỉ lưu câu truy vấn — mỗi lần truy cập View, câu truy vấn sẽ được thực thi lại.

### Cú pháp cơ bản

```sql
-- Tạo view
CREATE VIEW v_employee_summary AS
SELECT
    e.id,
    e.name,
    d.department_name,
    e.salary,
    CASE
        WHEN e.salary > 30000000 THEN 'Senior'
        WHEN e.salary > 15000000 THEN 'Mid'
        ELSE 'Junior'
    END AS level
FROM employees e
JOIN departments d ON e.department_id = d.id;

-- Sử dụng view như bảng thường
SELECT * FROM v_employee_summary WHERE level = 'Senior';
```

### Regular View vs Materialized View

| Đặc điểm | Regular View | Materialized View |
|-----------|-------------|-------------------|
| Lưu dữ liệu | ❌ Không — chạy query mỗi lần | ✅ Có — lưu kết quả trên đĩa |
| Tốc độ truy vấn | Chậm hơn (phụ thuộc query gốc) | Nhanh hơn (đọc từ cache) |
| Dữ liệu real-time | ✅ Luôn mới nhất | ❌ Cần `REFRESH` để cập nhật |
| Hỗ trợ index | ❌ Không | ✅ Có thể tạo index |
| Use case | Report đơn giản, ẩn logic phức tạp | Dashboard, aggregate nặng, data warehouse |

```sql
-- PostgreSQL: Materialized View
CREATE MATERIALIZED VIEW mv_monthly_revenue AS
SELECT
    DATE_TRUNC('month', order_date) AS month,
    SUM(total_amount) AS revenue,
    COUNT(*) AS order_count
FROM orders
GROUP BY DATE_TRUNC('month', order_date);

-- Cập nhật dữ liệu
REFRESH MATERIALIZED VIEW mv_monthly_revenue;

-- Cập nhật không lock read
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_revenue;
```

## CTE — Common Table Expression

CTE (Common Table Expression) là cách đặt tên cho một tập kết quả tạm thời trong phạm vi một câu lệnh SQL. CTE giúp viết query phức tạp dễ đọc hơn và hỗ trợ truy vấn đệ quy (recursive).

### CTE cơ bản

```sql
-- Tìm nhân viên có lương cao hơn trung bình phòng ban
WITH dept_avg AS (
    SELECT department_id, AVG(salary) AS avg_salary
    FROM employees
    GROUP BY department_id
)
SELECT e.name, e.salary, da.avg_salary
FROM employees e
JOIN dept_avg da ON e.department_id = da.department_id
WHERE e.salary > da.avg_salary;
```

### Recursive CTE

Recursive CTE cho phép truy vấn đệ quy — rất hữu ích với dữ liệu dạng cây (hierarchical data) như cây phòng ban, menu đa cấp.

```sql
-- Truy vấn cây phòng ban
WITH RECURSIVE dept_tree AS (
    -- Base case: phòng ban gốc
    SELECT id, name, parent_id, 0 AS depth
    FROM departments
    WHERE parent_id IS NULL

    UNION ALL

    -- Recursive case: con của phòng ban trước đó
    SELECT d.id, d.name, d.parent_id, dt.depth + 1
    FROM departments d
    JOIN dept_tree dt ON d.parent_id = dt.id
)
SELECT
    REPEAT('  ', depth) || name AS department_hierarchy,
    depth
FROM dept_tree
ORDER BY depth, name;
```

**Kết quả ví dụ:**

```
department_hierarchy        | depth
----------------------------|------
Công ty ABC                 | 0
  Khối Kỹ thuật             | 1
  Khối Kinh doanh           | 1
    Phòng Backend            | 2
    Phòng Frontend           | 2
    Phòng Bán hàng Online    | 2
```

## B-Tree vs Binary Tree

Đây là hai cấu trúc dữ liệu khác nhau, thường bị nhầm lẫn vì tên gọi tương tự. Trong database, **B-Tree** được sử dụng rộng rãi cho index.

### So sánh chi tiết

| Đặc điểm | Binary Tree | B-Tree |
|-----------|------------|--------|
| Số con mỗi node | Tối đa **2** | Tối đa **m** (m lớn, thường 100+) |
| Chiều cao | Cao (O(log₂ n)) | Thấp (O(log_m n)) |
| Dữ liệu lưu ở | Mọi node | Chỉ ở leaf node (B+Tree) hoặc mọi node (B-Tree) |
| Phù hợp cho | Dữ liệu trong memory | Dữ liệu trên **đĩa** (disk I/O) |
| Range query | Không tối ưu | ✅ Rất tốt (leaf nodes liên kết nhau) |
| Use case | Tìm kiếm in-memory, BST | **Database index**, filesystem |

### Diagram so sánh

```
Binary Tree (mỗi node tối đa 2 con):

          [50]
         /    \
      [30]    [70]
      /  \    /  \
   [20] [40][60] [80]


B-Tree bậc 3 (mỗi node tối đa 3 key, 4 con):

            [30 | 60]
           /    |    \
    [10|20]  [40|50]  [70|80|90]
```

### Tại sao Database dùng B-Tree thay vì Binary Tree?

1. **Giảm Disk I/O**: Mỗi node B-Tree chứa nhiều key → ít lần đọc đĩa hơn. Ví dụ: 1 triệu record, Binary Tree cần ~20 lần đọc đĩa (log₂ 1M), B-Tree bậc 100 chỉ cần ~3 lần (log₁₀₀ 1M).

2. **Range Query hiệu quả**: Trong B+Tree (biến thể phổ biến nhất), các leaf node được liên kết nhau bằng pointer → duyệt range rất nhanh.

3. **Tận dụng page size**: Database đọc dữ liệu theo page (thường 4KB-16KB). Mỗi node B-Tree được thiết kế vừa 1 page → tối ưu I/O.

```
B+Tree (biến thể dùng trong database):

         [30 | 60]              ← Internal nodes (chỉ chứa key)
        /    |    \
  [10|20] [30|40|50] [60|70|80] ← Leaf nodes (chứa key + data pointer)
     ↔         ↔         ↔     ← Leaf nodes liên kết nhau (doubly linked list)

→ Range query WHERE id BETWEEN 20 AND 50:
  Tìm leaf chứa 20, sau đó duyệt tuần tự qua linked list đến 50.
```

### Các loại Index trong Database

| Loại Index | Cấu trúc | Phù hợp với | Không phù hợp |
|-----------|----------|-------------|----------------|
| B-Tree | B+Tree | `=`, `>`, `<`, `>=`, `<=`, `BETWEEN` | `LIKE '%abc'` |
| Hash | Hash table | Chỉ `=` | Range query, sắp xếp |
| Bitmap | Bitmap array | Dữ liệu lặp nhiều (gender, status) | Dữ liệu unique, bảng cập nhật thường xuyên |

> **Lưu ý**: Khi sử dụng `LIKE` với wildcard ở đầu (`LIKE '%keyword'`), B-Tree index **không được sử dụng** vì không thể xác định vị trí bắt đầu tìm kiếm trong cây.
