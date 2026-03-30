---
title: "PL/SQL"
description: "PL/SQL — ngôn ngữ lập trình procedural của Oracle: blocks, procedures, functions, packages, cursors và exception handling"
---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Block Structure](#block-structure)
- [Biến & Kiểu dữ liệu](#biến--kiểu-dữ-liệu)
- [Control Flow](#control-flow)
- [Cursors](#cursors)
- [Procedures & Functions](#procedures--functions)
- [Packages](#packages)
- [Triggers](#triggers)
- [Exception Handling](#exception-handling)
- [Performance Tips](#performance-tips)
- [Tóm tắt](#tóm-tắt)

---

## Tổng quan

**PL/SQL** (Procedural Language/SQL) là extension procedural của Oracle SQL — cho phép viết logic lập trình (biến, vòng lặp, điều kiện, exception handling) kết hợp với SQL statements.

PL/SQL code chạy trực tiếp trên Oracle server — giảm network round-trips so với việc xử lý logic ở application layer.

| PL/SQL | SQL thuần |
| ------ | --------- |
| Có biến, vòng lặp, điều kiện | Không |
| Exception handling | Không |
| Reusable (procedure, function, package) | Không |
| Chạy trên server | Tùy |
| Phức tạp để maintain | Đơn giản hơn |

> [!NOTE]
> Dùng PL/SQL khi cần xử lý phức tạp sát DB (batch processing, data transformation, triggers). Tránh dùng cho business logic nên ở application layer — khó test, khó version control.

---

## Block Structure

Mọi PL/SQL code đều là **block**. Cấu trúc chuẩn:

```sql
DECLARE
  -- Khai báo biến, constants, cursors (optional)
  v_name    VARCHAR2(100);
  v_count   NUMBER := 0;
BEGIN
  -- Logic chính: SQL statements, control flow, procedure calls
  SELECT COUNT(*) INTO v_count FROM employees;
  DBMS_OUTPUT.PUT_LINE('Count: ' || v_count);
EXCEPTION
  -- Xử lý lỗi (optional)
  WHEN NO_DATA_FOUND THEN
    DBMS_OUTPUT.PUT_LINE('No data found');
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('Error: ' || SQLERRM);
END;
/
```

- `/` ở cuối: chạy anonymous block trong SQL*Plus hoặc SQL Developer.
- `DECLARE` và `EXCEPTION` là optional — `BEGIN...END` là phần bắt buộc.

### Anonymous Block vs Named Block

| | Anonymous Block | Named Block (Procedure/Function/Package) |
| - | --------------- | ---------------------------------------- |
| Lưu trong DB | Không | Có |
| Tái sử dụng | Không | Có |
| Dùng khi | Script một lần, test | Business logic tái sử dụng |

---

## Biến & Kiểu dữ liệu

### Khai báo biến

```sql
DECLARE
  -- Scalar variables
  v_name      VARCHAR2(100);           -- NULL by default
  v_salary    NUMBER(10,2) := 0;       -- khởi tạo giá trị
  v_active    BOOLEAN := TRUE;
  v_today     DATE := SYSDATE;

  -- Anchored types (%TYPE) — tự động khớp với column type
  v_emp_name  employees.first_name%TYPE;   -- lấy type từ column
  v_salary2   employees.salary%TYPE;

  -- Record type (%ROWTYPE) — toàn bộ row của bảng
  v_emp_row   employees%ROWTYPE;

  -- Constants
  c_tax_rate  CONSTANT NUMBER := 0.1;
BEGIN
  NULL; -- placeholder
END;
/
```

> [!TIP]
> Dùng `%TYPE` và `%ROWTYPE` thay vì hardcode type — khi column type thay đổi, PL/SQL tự cập nhật, không cần sửa code.

### INTO clause — lấy dữ liệu từ SQL

```sql
DECLARE
  v_name   VARCHAR2(100);
  v_salary NUMBER;
BEGIN
  -- SELECT INTO: chỉ dùng khi query trả về đúng 1 row
  SELECT first_name, salary
  INTO   v_name, v_salary
  FROM   employees
  WHERE  employee_id = 100;

  DBMS_OUTPUT.PUT_LINE(v_name || ' earns ' || v_salary);
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    DBMS_OUTPUT.PUT_LINE('Employee not found');
  WHEN TOO_MANY_ROWS THEN
    DBMS_OUTPUT.PUT_LINE('Multiple rows returned');
END;
/
```

---

## Control Flow

### IF / ELSIF / ELSE

```sql
BEGIN
  IF v_salary > 10000 THEN
    DBMS_OUTPUT.PUT_LINE('Senior');
  ELSIF v_salary > 5000 THEN
    DBMS_OUTPUT.PUT_LINE('Mid-level');
  ELSE
    DBMS_OUTPUT.PUT_LINE('Junior');
  END IF;
END;
/
```

### CASE

```sql
BEGIN
  -- Simple CASE
  CASE v_department_id
    WHEN 10 THEN DBMS_OUTPUT.PUT_LINE('HR');
    WHEN 20 THEN DBMS_OUTPUT.PUT_LINE('IT');
    ELSE         DBMS_OUTPUT.PUT_LINE('Other');
  END CASE;

  -- Searched CASE
  CASE
    WHEN v_salary > 10000 THEN DBMS_OUTPUT.PUT_LINE('High');
    WHEN v_salary > 5000  THEN DBMS_OUTPUT.PUT_LINE('Medium');
    ELSE                       DBMS_OUTPUT.PUT_LINE('Low');
  END CASE;
END;
/
```

### Loops

```sql
DECLARE
  v_i NUMBER := 1;
BEGIN
  -- Basic LOOP
  LOOP
    EXIT WHEN v_i > 5;
    DBMS_OUTPUT.PUT_LINE('i = ' || v_i);
    v_i := v_i + 1;
  END LOOP;

  -- WHILE LOOP
  v_i := 1;
  WHILE v_i <= 5 LOOP
    DBMS_OUTPUT.PUT_LINE('i = ' || v_i);
    v_i := v_i + 1;
  END WHILE LOOP;

  -- FOR LOOP (tự tăng i, không cần khai báo)
  FOR i IN 1..5 LOOP
    DBMS_OUTPUT.PUT_LINE('i = ' || i);
  END LOOP;

  -- FOR LOOP ngược
  FOR i IN REVERSE 5..1 LOOP
    DBMS_OUTPUT.PUT_LINE('i = ' || i);
  END LOOP;
END;
/
```

---

## Cursors

Cursor là con trỏ đến result set của SQL query — dùng khi query trả về nhiều row.

### Implicit Cursor

Oracle tự tạo implicit cursor cho mỗi SQL statement. Có thể kiểm tra kết quả qua `SQL%`:

```sql
BEGIN
  UPDATE employees SET salary = salary * 1.1 WHERE department_id = 20;

  IF SQL%FOUND THEN
    DBMS_OUTPUT.PUT_LINE('Updated ' || SQL%ROWCOUNT || ' rows');
  ELSE
    DBMS_OUTPUT.PUT_LINE('No rows updated');
  END IF;
END;
/
```

| Attribute | Ý nghĩa |
| --------- | ------- |
| `SQL%FOUND` | TRUE nếu câu lệnh ảnh hưởng ít nhất 1 row |
| `SQL%NOTFOUND` | TRUE nếu không có row nào |
| `SQL%ROWCOUNT` | Số rows bị ảnh hưởng |
| `SQL%ISOPEN` | Luôn FALSE với implicit cursor |

### Explicit Cursor

```sql
DECLARE
  CURSOR emp_cursor IS
    SELECT employee_id, first_name, salary
    FROM   employees
    WHERE  department_id = 20;

  v_id     employees.employee_id%TYPE;
  v_name   employees.first_name%TYPE;
  v_salary employees.salary%TYPE;
BEGIN
  OPEN emp_cursor;
  LOOP
    FETCH emp_cursor INTO v_id, v_name, v_salary;
    EXIT WHEN emp_cursor%NOTFOUND;
    DBMS_OUTPUT.PUT_LINE(v_id || ': ' || v_name || ' - ' || v_salary);
  END LOOP;
  CLOSE emp_cursor;
END;
/
```

### Cursor FOR Loop (khuyến nghị)

Gọn hơn — tự OPEN, FETCH, CLOSE:

```sql
DECLARE
  CURSOR emp_cursor IS
    SELECT employee_id, first_name, salary
    FROM   employees
    WHERE  department_id = 20;
BEGIN
  FOR emp_rec IN emp_cursor LOOP
    DBMS_OUTPUT.PUT_LINE(emp_rec.first_name || ': ' || emp_rec.salary);
  END LOOP;
  -- Cursor tự đóng sau khi loop xong
END;
/
```

Hoặc inline query:

```sql
BEGIN
  FOR emp_rec IN (SELECT first_name, salary FROM employees WHERE dept_id = 20) LOOP
    DBMS_OUTPUT.PUT_LINE(emp_rec.first_name || ': ' || emp_rec.salary);
  END LOOP;
END;
/
```

### Cursor với Parameters

```sql
DECLARE
  CURSOR emp_cursor(p_dept_id NUMBER) IS
    SELECT first_name, salary
    FROM   employees
    WHERE  department_id = p_dept_id;
BEGIN
  FOR rec IN emp_cursor(20) LOOP
    DBMS_OUTPUT.PUT_LINE(rec.first_name);
  END LOOP;
END;
/
```

---

## Procedures & Functions

### Stored Procedure

```sql
CREATE OR REPLACE PROCEDURE raise_salary(
  p_emp_id  IN  employees.employee_id%TYPE,
  p_percent IN  NUMBER,
  p_new_sal OUT employees.salary%TYPE
) AS
  v_current_sal employees.salary%TYPE;
BEGIN
  SELECT salary INTO v_current_sal
  FROM   employees
  WHERE  employee_id = p_emp_id;

  p_new_sal := v_current_sal * (1 + p_percent / 100);

  UPDATE employees
  SET    salary = p_new_sal
  WHERE  employee_id = p_emp_id;

  COMMIT;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE_APPLICATION_ERROR(-20001, 'Employee ' || p_emp_id || ' not found');
END raise_salary;
/
```

```sql
-- Gọi procedure
DECLARE
  v_new_sal NUMBER;
BEGIN
  raise_salary(100, 10, v_new_sal);
  DBMS_OUTPUT.PUT_LINE('New salary: ' || v_new_sal);
END;
/
```

**Parameter modes:**

| Mode | Mô tả |
| ---- | ----- |
| `IN` | Read-only input (default) |
| `OUT` | Write-only output |
| `IN OUT` | Read + write |

### Stored Function

Giống procedure nhưng **trả về giá trị** và có thể dùng trong SQL:

```sql
CREATE OR REPLACE FUNCTION get_annual_salary(
  p_emp_id IN employees.employee_id%TYPE
) RETURN NUMBER AS
  v_salary NUMBER;
BEGIN
  SELECT salary * 12 INTO v_salary
  FROM   employees
  WHERE  employee_id = p_emp_id;
  RETURN v_salary;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RETURN NULL;
END get_annual_salary;
/
```

```sql
-- Dùng trong SQL
SELECT first_name, get_annual_salary(employee_id) AS annual_sal
FROM   employees
WHERE  department_id = 20;

-- Hoặc trong PL/SQL
DECLARE
  v_sal NUMBER;
BEGIN
  v_sal := get_annual_salary(100);
END;
/
```

---

## Packages

Package là cách **nhóm các procedures, functions, types, cursors, variables** liên quan thành 1 unit. Tương tự namespace hoặc module trong ngôn ngữ khác.

### Package Specification (Interface)

```sql
CREATE OR REPLACE PACKAGE emp_management AS
  -- Public types
  TYPE emp_record_t IS RECORD (
    emp_id   NUMBER,
    emp_name VARCHAR2(100),
    salary   NUMBER
  );

  -- Public constants
  c_max_raise_percent CONSTANT NUMBER := 20;

  -- Public procedure/function signatures
  PROCEDURE hire_employee(
    p_name       IN  VARCHAR2,
    p_dept_id    IN  NUMBER,
    p_salary     IN  NUMBER,
    p_emp_id     OUT NUMBER
  );

  FUNCTION get_headcount(p_dept_id IN NUMBER) RETURN NUMBER;

END emp_management;
/
```

### Package Body (Implementation)

```sql
CREATE OR REPLACE PACKAGE BODY emp_management AS

  -- Private variable (chỉ accessible trong package)
  v_last_hired_id NUMBER;

  PROCEDURE hire_employee(
    p_name    IN  VARCHAR2,
    p_dept_id IN  NUMBER,
    p_salary  IN  NUMBER,
    p_emp_id  OUT NUMBER
  ) AS
  BEGIN
    INSERT INTO employees (first_name, department_id, salary)
    VALUES (p_name, p_dept_id, p_salary)
    RETURNING employee_id INTO p_emp_id;

    v_last_hired_id := p_emp_id;
    COMMIT;
  END hire_employee;

  FUNCTION get_headcount(p_dept_id IN NUMBER) RETURN NUMBER AS
    v_count NUMBER;
  BEGIN
    SELECT COUNT(*) INTO v_count
    FROM   employees
    WHERE  department_id = p_dept_id;
    RETURN v_count;
  END get_headcount;

END emp_management;
/
```

```sql
-- Gọi package
DECLARE
  v_new_id NUMBER;
BEGIN
  emp_management.hire_employee('John Doe', 20, 5000, v_new_id);
  DBMS_OUTPUT.PUT_LINE('Hired employee ID: ' || v_new_id);
  DBMS_OUTPUT.PUT_LINE('Headcount: ' || emp_management.get_headcount(20));
END;
/
```

**Lợi ích của Package:**
- **Encapsulation**: ẩn implementation detail, expose public API qua spec.
- **Performance**: Oracle load toàn bộ package vào Shared Pool lần đầu — các calls sau nhanh hơn.
- **State**: package-level variables giữ state trong session (dùng cẩn thận trong multi-session).

---

## Triggers

Trigger tự động thực thi khi có DML (INSERT/UPDATE/DELETE) hoặc DDL event trên bảng.

### DML Trigger

```sql
CREATE OR REPLACE TRIGGER trg_employees_audit
AFTER INSERT OR UPDATE OR DELETE ON employees
FOR EACH ROW
BEGIN
  IF INSERTING THEN
    INSERT INTO employees_audit (action, emp_id, action_time)
    VALUES ('INSERT', :NEW.employee_id, SYSDATE);

  ELSIF UPDATING THEN
    INSERT INTO employees_audit (action, emp_id, old_salary, new_salary, action_time)
    VALUES ('UPDATE', :NEW.employee_id, :OLD.salary, :NEW.salary, SYSDATE);

  ELSIF DELETING THEN
    INSERT INTO employees_audit (action, emp_id, action_time)
    VALUES ('DELETE', :OLD.employee_id, SYSDATE);
  END IF;
END;
/
```

| Keyword | Ý nghĩa |
| ------- | ------- |
| `:NEW.column` | Giá trị mới (INSERT, UPDATE) |
| `:OLD.column` | Giá trị cũ (UPDATE, DELETE) |
| `INSERTING` | TRUE nếu trigger fired bởi INSERT |
| `UPDATING` | TRUE nếu fired bởi UPDATE |
| `DELETING` | TRUE nếu fired bởi DELETE |

### BEFORE vs AFTER

```sql
-- BEFORE trigger: có thể modify :NEW, dùng để validate/transform
CREATE OR REPLACE TRIGGER trg_check_salary
BEFORE INSERT OR UPDATE OF salary ON employees
FOR EACH ROW
BEGIN
  IF :NEW.salary < 0 THEN
    RAISE_APPLICATION_ERROR(-20002, 'Salary cannot be negative');
  END IF;
  -- Có thể sửa giá trị
  :NEW.salary := ROUND(:NEW.salary, 2);
END;
/
```

> [!IMPORTANT]
> Tránh lạm dụng triggers — khó debug, ẩn logic, dễ gây performance issues. Chỉ dùng cho audit logging, constraints phức tạp mà không implement được bằng CHECK constraint.

---

## Exception Handling

### Predefined Exceptions

```sql
BEGIN
  -- ...
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    -- SELECT INTO không tìm được row
    NULL;
  WHEN TOO_MANY_ROWS THEN
    -- SELECT INTO trả về > 1 row
    NULL;
  WHEN DUP_VAL_ON_INDEX THEN
    -- Unique constraint violation
    NULL;
  WHEN VALUE_ERROR THEN
    -- Type conversion error, size overflow
    NULL;
  WHEN ZERO_DIVIDE THEN
    NULL;
  WHEN OTHERS THEN
    -- Bắt tất cả exceptions còn lại
    DBMS_OUTPUT.PUT_LINE('Unexpected error: ' || SQLERRM);
    RAISE; -- re-raise để caller xử lý tiếp
END;
/
```

### RAISE_APPLICATION_ERROR

Tạo custom error để trả về application:

```sql
-- Error number: -20000 đến -20999 (reserved cho user-defined)
RAISE_APPLICATION_ERROR(-20001, 'Invalid employee ID: ' || p_emp_id);
```

### SQLCODE và SQLERRM

```sql
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('Error code: ' || SQLCODE);
    DBMS_OUTPUT.PUT_LINE('Error message: ' || SQLERRM);
    -- Log to error table
    INSERT INTO error_log (error_code, error_msg, created_at)
    VALUES (SQLCODE, SUBSTR(SQLERRM, 1, 500), SYSDATE);
    COMMIT;
    RAISE;
END;
```

### User-Defined Exceptions

```sql
DECLARE
  e_invalid_dept EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_invalid_dept, -20100);  -- associate với error number
BEGIN
  IF v_dept_id NOT IN (10, 20, 30) THEN
    RAISE e_invalid_dept;
  END IF;
EXCEPTION
  WHEN e_invalid_dept THEN
    DBMS_OUTPUT.PUT_LINE('Invalid department');
END;
/
```

---

## Performance Tips

### Bulk Operations — FORALL & BULK COLLECT

Row-by-row processing trong PL/SQL ("row-by-agonizing-row") rất chậm vì mỗi SQL call là 1 context switch giữa PL/SQL engine và SQL engine.

**BULK COLLECT** — fetch nhiều rows cùng lúc:

```sql
DECLARE
  TYPE emp_id_list IS TABLE OF employees.employee_id%TYPE;
  TYPE salary_list IS TABLE OF employees.salary%TYPE;

  v_emp_ids   emp_id_list;
  v_salaries  salary_list;
BEGIN
  -- Fetch tất cả vào collection (1 context switch)
  SELECT employee_id, salary
  BULK COLLECT INTO v_emp_ids, v_salaries
  FROM employees
  WHERE department_id = 20;

  -- Hoặc theo batch để tránh memory issues
  FOR i IN 1..v_emp_ids.COUNT LOOP
    DBMS_OUTPUT.PUT_LINE(v_emp_ids(i) || ': ' || v_salaries(i));
  END LOOP;
END;
/
```

**FORALL** — thực thi DML cho toàn collection (1 context switch):

```sql
DECLARE
  TYPE emp_id_list IS TABLE OF employees.employee_id%TYPE;
  v_emp_ids emp_id_list;
BEGIN
  SELECT employee_id BULK COLLECT INTO v_emp_ids
  FROM   employees WHERE department_id = 20;

  -- Thay vì FOR loop (N context switches):
  -- FOR i IN 1..v_emp_ids.COUNT LOOP
  --   UPDATE employees SET salary = salary * 1.1 WHERE employee_id = v_emp_ids(i);
  -- END LOOP;

  -- Dùng FORALL (1 context switch):
  FORALL i IN 1..v_emp_ids.COUNT
    UPDATE employees SET salary = salary * 1.1
    WHERE  employee_id = v_emp_ids(i);

  DBMS_OUTPUT.PUT_LINE(SQL%ROWCOUNT || ' rows updated');
END;
/
```

| Cách | Context Switches | Performance |
| ---- | ---------------- | ----------- |
| Row-by-row loop | N | Chậm nhất |
| BULK COLLECT | 1 | Nhanh |
| FORALL | 1 | Nhanh nhất cho DML |

### Bind Variables

```sql
-- Tránh: mỗi câu SQL với literal khác nhau là hard parse riêng
EXECUTE IMMEDIATE 'UPDATE emp SET sal = 5000 WHERE id = 1';
EXECUTE IMMEDIATE 'UPDATE emp SET sal = 6000 WHERE id = 2';

-- Dùng bind variables: 1 execution plan tái sử dụng
EXECUTE IMMEDIATE 'UPDATE emp SET sal = :sal WHERE id = :id'
  USING 5000, 1;
EXECUTE IMMEDIATE 'UPDATE emp SET sal = :sal WHERE id = :id'
  USING 6000, 2;
```

---

## Tóm tắt

| Concept | Dùng khi |
| ------- | -------- |
| **Anonymous Block** | Script một lần, test nhanh |
| **Procedure** | Logic có side effects (INSERT/UPDATE/DELETE), không cần return value |
| **Function** | Tính toán, trả về giá trị, có thể dùng trong SQL |
| **Package** | Nhóm các procedures/functions liên quan, ẩn implementation |
| **Cursor** | Xử lý query trả về nhiều rows |
| **Trigger** | Audit logging, enforce complex constraints |
| **BULK COLLECT + FORALL** | Batch processing hiệu năng cao |
| **Exception Handling** | Luôn có WHEN OTHERS ở outer block, log lỗi trước khi RAISE |

> [!TIP]
> Rule of thumb: nếu logic có thể viết bằng SQL thuần (WITH, window functions, MERGE), hãy dùng SQL. Chỉ dùng PL/SQL khi logic thực sự cần procedural control flow mà SQL không diễn đạt được.
