---
title: "Isolation Levels"
description: "4 mức độ cô lập trong SQL — Read Uncommitted, Read Committed, Repeatable Read, Serializable"
---

## Mục lục

- [Tại sao cần Isolation Levels](#tại-sao-cần-isolation-levels)
- [Các vấn đề đọc dữ liệu đồng thời](#các-vấn-đề-đọc-dữ-liệu-đồng-thời)
- [4 mức Isolation Level](#4-mức-isolation-level)
  - [Read Uncommitted](#read-uncommitted)
  - [Read Committed](#read-committed)
  - [Repeatable Read](#repeatable-read)
  - [Serializable](#serializable)
- [Bảng so sánh tổng hợp](#bảng-so-sánh-tổng-hợp)
- [Default Isolation Level theo Database](#default-isolation-level-theo-database)
- [Mermaid Diagram minh họa](#mermaid-diagram-minh-họa)
- [Sự khác biệt giữa các Database](#sự-khác-biệt-giữa-các-database)
  - [PostgreSQL — chỉ có 3 behavior thực sự](#postgresql--chỉ-có-3-behavior-thực-sự)
  - [MySQL InnoDB — Repeatable Read mạnh hơn chuẩn](#mysql-innodb--repeatable-read-mạnh-hơn-chuẩn)
  - [PostgreSQL vs MySQL — Serializable khác nhau hoàn toàn](#postgresql-vs-mysql--serializable-khác-nhau-hoàn-toàn)
  - [Oracle — chỉ 2 level thực sự](#oracle--chỉ-2-level-thực-sự)
  - [SQL Server — có thêm level SNAPSHOT](#sql-server--có-thêm-level-snapshot)
  - [Bảng so sánh tổng hợp theo Database](#bảng-so-sánh-tổng-hợp-theo-database)
- [Khi nào chọn level nào](#khi-nào-chọn-level-nào)

---

## Tại sao cần Isolation Levels

Trong hệ thống thực tế, **hàng nghìn transaction** có thể chạy đồng thời trên cùng một database. Nếu không kiểm soát, các transaction sẽ can thiệp lẫn nhau, gây ra dữ liệu sai lệch.

Tuy nhiên, cô lập hoàn toàn (chạy tuần tự) sẽ **giết chết hiệu suất**. Isolation Levels cho phép ta **cân bằng** giữa tính đúng đắn và hiệu suất — chọn mức cô lập phù hợp với từng use case.

```
Hiệu suất cao ◄──────────────────────────────► Tính đúng đắn cao

Read Uncommitted → Read Committed → Repeatable Read → Serializable
   (ít lock)                                          (nhiều lock)
```

## Các vấn đề đọc dữ liệu đồng thời

Trước khi tìm hiểu các level, cần nắm rõ 3 vấn đề chính:

| Vấn đề | Mô tả | Mức độ nghiêm trọng |
|--------|--------|---------------------|
| **Dirty Read** | Đọc dữ liệu **chưa commit** từ transaction khác | 🔴 Cao |
| **Non-Repeatable Read** | Cùng query, chạy 2 lần cho **kết quả khác** (do row bị update) | 🟡 Trung bình |
| **Phantom Read** | Cùng query, chạy 2 lần thấy **thêm/bớt row** (do insert/delete) | 🟠 Trung bình |

## 4 mức Isolation Level

### Read Uncommitted

Mức cô lập **thấp nhất**. Transaction có thể đọc dữ liệu mà transaction khác đã thay đổi nhưng **chưa commit** (dirty read).

**Đặc điểm:**
- Không đặt read lock
- Hiệu suất cao nhất
- Rủi ro dữ liệu sai lệch cao nhất
- Rất hiếm khi được sử dụng trong thực tế

**Ví dụ minh họa Dirty Read:**

```sql
-- Session 1: Cập nhật salary nhưng CHƯA commit
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
BEGIN;
UPDATE employees SET salary = 50000000 WHERE id = 1;
-- CHƯA COMMIT!

-- Session 2: Đọc dữ liệu chưa commit
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
BEGIN;
SELECT salary FROM employees WHERE id = 1;
-- Kết quả: 50000000 ← Dirty Read! Dữ liệu chưa commit

-- Session 1: Rollback!
ROLLBACK;
-- salary thực tế vẫn là giá trị cũ, nhưng Session 2 đã dùng 50M để tính toán → SAI
```

```
Timeline:

Session 1: |--BEGIN--|--UPDATE salary=50M--|------------|--ROLLBACK--|
Session 2:              |--BEGIN--|--SELECT salary--|
                                     → 50M (DIRTY!) ❌
                                  Giá trị thực: vẫn là giá trị cũ
```

### Read Committed

Mức cô lập **mặc định** của PostgreSQL và Oracle. Transaction chỉ đọc được dữ liệu đã **commit**. Tránh được dirty read nhưng vẫn có thể gặp non-repeatable read.

**Đặc điểm:**
- Mỗi câu SELECT lấy snapshot tại thời điểm nó chạy
- Nếu transaction khác commit giữa 2 lần SELECT → kết quả khác nhau
- Phù hợp cho hầu hết các ứng dụng thông thường

**Ví dụ minh họa Non-Repeatable Read:**

```sql
-- Session 1
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN;
SELECT salary FROM employees WHERE id = 1;
-- Kết quả: 20000000

    -- Session 2 chạy xen kẽ
    BEGIN;
    UPDATE employees SET salary = 30000000 WHERE id = 1;
    COMMIT;

-- Session 1 đọc lại
SELECT salary FROM employees WHERE id = 1;
-- Kết quả: 30000000 ← Non-Repeatable Read! Khác lần đọc trước
COMMIT;
```

```
Timeline:

Session 1: |--BEGIN--|--SELECT→20M--|---------------------|--SELECT→30M--|--COMMIT--|
Session 2:                   |--BEGIN--|--UPDATE=30M--|--COMMIT--|
                                                                 ↑
                                              Session 1 đọc lại → thấy giá trị mới
```

### Repeatable Read

Transaction **đóng băng snapshot** tại thời điểm transaction bắt đầu. Mọi lần đọc trong transaction đều thấy cùng dữ liệu — tránh dirty read và non-repeatable read. Tuy nhiên, **phantom read** vẫn có thể xảy ra (theo chuẩn SQL).

**Đặc điểm:**
- Snapshot được tạo khi transaction bắt đầu (hoặc khi chạy SELECT đầu tiên)
- Đây là default level của MySQL InnoDB
- MySQL InnoDB thực tế đã ngăn cả phantom read nhờ **gap locking**

**Ví dụ minh họa Phantom Read (theo chuẩn SQL):**

```sql
-- Session 1
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;
SELECT COUNT(*) FROM employees WHERE department = 'IT';
-- Kết quả: 10

    -- Session 2
    BEGIN;
    INSERT INTO employees (name, department) VALUES ('Nguyễn Mới', 'IT');
    COMMIT;

-- Session 1 đọc lại
SELECT COUNT(*) FROM employees WHERE department = 'IT';
-- Theo chuẩn SQL: có thể thấy 11 (Phantom Read)
-- MySQL InnoDB: vẫn thấy 10 (gap lock ngăn phantom)
COMMIT;
```

```
Timeline:

Session 1: |--BEGIN--|--COUNT=10--|--------------------------|--COUNT=???--|
Session 2:                |--BEGIN--|--INSERT new row--|--COMMIT--|
                                                                  ↑
                                    Chuẩn SQL: COUNT=11 (Phantom Read)
                                    MySQL InnoDB: COUNT=10 (Gap Lock ngăn)
```

### Serializable

Mức cô lập **cao nhất**. Các transaction chạy đồng thời cho kết quả **giống hệt** như khi chạy tuần tự (serial). Ngăn tất cả các vấn đề: dirty read, non-repeatable read, phantom read.

**Đặc điểm:**
- PostgreSQL dùng **SSI** (Serializable Snapshot Isolation) — phát hiện conflict và abort transaction
- MySQL dùng **locking** — tất cả SELECT tự động thành `SELECT ... LOCK IN SHARE MODE`
- Hiệu suất thấp nhất, throughput giảm đáng kể
- Có thể gây **deadlock** và cần retry logic

**Ví dụ:**

```sql
-- PostgreSQL: Serializable
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN;

SELECT SUM(amount) FROM transactions WHERE account_id = 1;
-- PostgreSQL ghi nhận dependency

INSERT INTO transactions (account_id, amount) VALUES (1, -500000);
-- Nếu transaction khác cũng đọc/ghi cùng dữ liệu
-- → PostgreSQL phát hiện serialization conflict
-- → Abort 1 trong 2 transaction

COMMIT;
-- ERROR: could not serialize access due to read/write dependencies
-- → Application cần RETRY transaction
```

```sql
-- MySQL: Serializable
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN;

SELECT * FROM accounts WHERE id = 1;
-- MySQL tự động thêm LOCK IN SHARE MODE
-- → Block các transaction khác muốn UPDATE row này

UPDATE accounts SET balance = balance - 500000 WHERE id = 1;
COMMIT;
```

## Bảng so sánh tổng hợp

| Isolation Level | Dirty Read | Non-Repeatable Read | Phantom Read | Hiệu suất |
|----------------|-----------|-------------------|-------------|-----------|
| **Read Uncommitted** | ⚠️ Có thể xảy ra | ⚠️ Có thể xảy ra | ⚠️ Có thể xảy ra | ⚡ Cao nhất |
| **Read Committed** | ✅ Ngăn chặn | ⚠️ Có thể xảy ra | ⚠️ Có thể xảy ra | ⚡ Cao |
| **Repeatable Read** | ✅ Ngăn chặn | ✅ Ngăn chặn | ⚠️ Có thể xảy ra* | 🔄 Trung bình |
| **Serializable** | ✅ Ngăn chặn | ✅ Ngăn chặn | ✅ Ngăn chặn | 🐌 Thấp nhất |

> *MySQL InnoDB ở Repeatable Read đã ngăn phantom read nhờ gap locking. Tuy nhiên theo chuẩn SQL, phantom read vẫn được phép ở level này.

## Default Isolation Level theo Database

| Database | Default Level | Ghi chú |
|----------|--------------|---------|
| **MySQL (InnoDB)** | Repeatable Read | Sử dụng MVCC + gap locking, ngăn cả phantom read |
| **PostgreSQL** | Read Committed | Sử dụng MVCC, hỗ trợ SSI cho Serializable |
| **Oracle** | Read Committed | Chỉ hỗ trợ Read Committed và Serializable |
| **SQL Server** | Read Committed | Hỗ trợ thêm `SNAPSHOT` isolation (tương tự Repeatable Read) |

**Cách kiểm tra và thay đổi isolation level:**

```sql
-- MySQL: Kiểm tra
SELECT @@transaction_isolation;
-- Thay đổi cho session hiện tại
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
-- Thay đổi global
SET GLOBAL TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- PostgreSQL: Kiểm tra
SHOW default_transaction_isolation;
-- Thay đổi cho transaction hiện tại
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- Thay đổi trong postgresql.conf
-- default_transaction_isolation = 'read committed'
```

## Mermaid Diagram minh họa

### Dirty Read (Read Uncommitted)

```mermaid
sequenceDiagram
    participant TX1 as Transaction 1
    participant DB as Database
    participant TX2 as Transaction 2

    TX1->>DB: BEGIN
    TX1->>DB: UPDATE salary = 50M (id=1)
    Note over DB: salary = 50M (uncommitted)

    TX2->>DB: BEGIN
    TX2->>DB: SELECT salary (id=1)
    DB-->>TX2: salary = 50M ⚠️ Dirty Read!

    TX1->>DB: ROLLBACK ❌
    Note over DB: salary trở lại giá trị cũ
    Note over TX2: Đã dùng 50M để tính toán → SAI!
```

### Phantom Read (Read Committed / Repeatable Read)

```mermaid
sequenceDiagram
    participant TX1 as Transaction 1
    participant DB as Database
    participant TX2 as Transaction 2

    TX1->>DB: BEGIN
    TX1->>DB: SELECT COUNT(*) WHERE dept='IT'
    DB-->>TX1: COUNT = 10

    TX2->>DB: BEGIN
    TX2->>DB: INSERT INTO employees (dept='IT')
    TX2->>DB: COMMIT ✅
    Note over DB: Thêm 1 row mới dept='IT'

    TX1->>DB: SELECT COUNT(*) WHERE dept='IT'
    DB-->>TX1: COUNT = 11 ⚠️ Phantom Read!
    Note over TX1: Row "ma" xuất hiện!
    TX1->>DB: COMMIT
```

### Lost Update

```mermaid
sequenceDiagram
    participant TX1 as Transaction 1
    participant DB as Database
    participant TX2 as Transaction 2

    TX1->>DB: SELECT balance → 10M
    TX2->>DB: SELECT balance → 10M

    TX1->>DB: UPDATE balance = 10M - 3M = 7M
    TX1->>DB: COMMIT ✅

    TX2->>DB: UPDATE balance = 10M - 5M = 5M
    TX2->>DB: COMMIT ✅

    Note over DB: balance = 5M ❌
    Note over DB: Mất update -3M của TX1
    Note over DB: Đáng lẽ = 10M - 3M - 5M = 2M
```

## Sự khác biệt giữa các Database

Chuẩn SQL định nghĩa 4 isolation levels, nhưng mỗi database **implement khác nhau** — thậm chí cùng tên level nhưng behavior không giống nhau.

### PostgreSQL — chỉ có 3 behavior thực sự

PostgreSQL dùng **MVCC thuần túy** cho mọi read operation. Điều này có nghĩa là reader không bao giờ block writer và ngược lại — và **dirty read không thể xảy ra** dù bạn set level nào.

```
Chuẩn SQL:   READ UNCOMMITTED → READ COMMITTED → REPEATABLE READ → SERIALIZABLE
PostgreSQL:  READ UNCOMMITTED ↗
                              READ COMMITTED  → REPEATABLE READ → SERIALIZABLE
                              (behavior giống nhau)
```

| Level (set) | Behavior thực tế trong PostgreSQL |
|-------------|----------------------------------|
| READ UNCOMMITTED | Hoạt động **giống READ COMMITTED** — MVCC không bao giờ show uncommitted data |
| READ COMMITTED | Snapshot mới cho **mỗi statement** trong transaction |
| REPEATABLE READ | Snapshot cố định từ statement **đầu tiên** của transaction — ngăn cả phantom read |
| SERIALIZABLE | Dùng **SSI** (Serializable Snapshot Isolation) — optimistic, phát hiện conflict sau |

**PostgreSQL REPEATABLE READ ngăn cả phantom read** — khác với chuẩn SQL (chuẩn SQL chỉ yêu cầu ngăn non-repeatable read ở level này). Lý do: snapshot MVCC đã "đóng băng" toàn bộ view của data, insert mới từ transaction khác không thể lọt vào.

```sql
-- PostgreSQL: REPEATABLE READ vẫn ngăn phantom read
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT COUNT(*) FROM employees WHERE dept = 'IT';  -- = 10

-- Session khác INSERT + COMMIT

SELECT COUNT(*) FROM employees WHERE dept = 'IT';  -- vẫn = 10 (không phải 11)
COMMIT;
```

---

### MySQL InnoDB — Repeatable Read mạnh hơn chuẩn

MySQL default là **REPEATABLE READ** và dùng kết hợp **MVCC + Gap Lock** để ngăn phantom read — behavior vượt chuẩn SQL.

| Level | Cơ chế | Phantom Read |
|-------|--------|-------------|
| READ UNCOMMITTED | Không dùng MVCC | ⚠️ Có thể xảy ra |
| READ COMMITTED | MVCC snapshot per-statement | ⚠️ Có thể xảy ra |
| REPEATABLE READ | MVCC snapshot + **Gap Lock** | ✅ Ngăn được (bonus!) |
| SERIALIZABLE | Tất cả SELECT → `LOCK IN SHARE MODE` | ✅ Ngăn được |

**Gap Lock** là gì: MySQL lock cả "khoảng trống" giữa các row thỏa điều kiện WHERE, ngăn INSERT vào vùng đó từ transaction khác.

```sql
-- MySQL: SELECT này tạo gap lock trên khoảng dept='IT'
SELECT * FROM employees WHERE dept = 'IT' FOR UPDATE;
-- → Transaction khác không INSERT được vào dept='IT' cho đến khi COMMIT
```

---

### PostgreSQL vs MySQL — Serializable khác nhau hoàn toàn

Đây là điểm khác biệt lớn nhất:

| | PostgreSQL Serializable | MySQL Serializable |
|--|------------------------|-------------------|
| **Cơ chế** | SSI — Serializable Snapshot Isolation | Pessimistic Locking |
| **Approach** | **Optimistic** — chạy trước, phát hiện conflict sau | **Pessimistic** — block ngay từ đầu |
| **Khi conflict** | Abort 1 transaction → app phải retry | Block và chờ transaction kia xong |
| **Throughput** | Cao hơn khi ít conflict | Thấp hơn — nhiều lock contention |
| **Deadlock** | Ít hơn | Nhiều hơn (do locking) |
| **SELECT** | Không thêm lock | Tự động thêm `LOCK IN SHARE MODE` |

```sql
-- PostgreSQL Serializable: chạy bình thường, lỗi xảy ra khi COMMIT
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT SUM(amount) FROM accounts WHERE user_id = 1;
INSERT INTO transactions ...;
COMMIT;
-- ERROR: could not serialize access due to read/write dependencies
-- → App cần retry

-- MySQL Serializable: block ngay khi SELECT
BEGIN;
SELECT * FROM accounts WHERE user_id = 1;
-- ^ Tự động thêm LOCK IN SHARE MODE
-- → Transaction khác muốn UPDATE row này phải chờ
```

---

### Oracle — chỉ 2 level thực sự

Oracle **không hỗ trợ** `READ UNCOMMITTED` và `REPEATABLE READ`. Nếu set 2 level đó sẽ báo lỗi hoặc bị ignore.

```sql
-- Oracle: chỉ hỗ trợ 2 level này
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;   -- ✅ Default
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;     -- ✅

SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; -- ❌ ORA-02179: valid options: READ COMMITTED or SERIALIZABLE
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;  -- ❌ Không hỗ trợ
```

Oracle Serializable dùng **SCN (System Change Number)** — mỗi transaction có một SCN snapshot, đọc data tại thời điểm đó xuyên suốt transaction.

---

### SQL Server — có thêm level SNAPSHOT

SQL Server hỗ trợ chuẩn 4 level + thêm **SNAPSHOT** isolation (phải enable thủ công):

```sql
-- Enable SNAPSHOT isolation cho database
ALTER DATABASE mydb SET ALLOW_SNAPSHOT_ISOLATION ON;

-- Dùng SNAPSHOT
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;
```

| Level | Cơ chế | Ghi chú |
|-------|--------|---------|
| READ UNCOMMITTED | Không lock | Dirty read có thể xảy ra |
| READ COMMITTED | Lock-based (default) | Giải phóng read lock ngay sau mỗi read |
| READ COMMITTED SNAPSHOT | MVCC-based | Phải enable `READ_COMMITTED_SNAPSHOT ON` |
| REPEATABLE READ | Lock-based | Giữ read lock đến hết transaction |
| SNAPSHOT | MVCC-based | Tương đương Repeatable Read nhưng không block |
| SERIALIZABLE | Lock-based | Lock cả range |

> SQL Server có 2 chế độ READ COMMITTED: lock-based (default) và MVCC-based (`READ_COMMITTED_SNAPSHOT`). Nhiều team bật RCSI để giảm blocking mà không đổi isolation level.

---

### Bảng so sánh tổng hợp theo Database

| | MySQL InnoDB | PostgreSQL | Oracle | SQL Server |
|--|-------------|-----------|--------|-----------|
| **Default level** | Repeatable Read | Read Committed | Read Committed | Read Committed |
| **MVCC** | ✅ (+ Gap Lock) | ✅ (thuần MVCC) | ✅ (SCN-based) | ✅ (opt-in RCSI) |
| **READ UNCOMMITTED** | ✅ (dirty read) | ✅ (= Read Committed!) | ❌ | ✅ |
| **READ COMMITTED** | ✅ | ✅ | ✅ | ✅ |
| **REPEATABLE READ** | ✅ (+ ngăn phantom) | ✅ (= ngăn phantom) | ❌ | ✅ |
| **SERIALIZABLE** | ✅ (locking) | ✅ (SSI) | ✅ (SCN) | ✅ (locking) |
| **SNAPSHOT** | ❌ | ❌ | ❌ | ✅ (extra level) |
| **Phantom Read** ở RR | ✅ Ngăn (gap lock) | ✅ Ngăn (MVCC) | N/A | ⚠️ Có thể xảy ra |

---

## Khi nào chọn level nào

### Read Uncommitted

**Use case:** Hầu như không dùng trong production. Chỉ phù hợp cho:
- Đọc dữ liệu thống kê gần đúng (approximate count)
- Monitoring dashboard không cần chính xác tuyệt đối
- Debug trong development

### Read Committed

**Use case:** Phù hợp cho đa số ứng dụng thông thường:
- Web application CRUD cơ bản
- API endpoint đọc dữ liệu
- Report không yêu cầu snapshot nhất quán
- Hệ thống cần throughput cao

### Repeatable Read

**Use case:** Khi cần đọc nhất quán trong suốt transaction:
- Hệ thống tài chính tính toán số dư
- Batch processing đọc dữ liệu nhiều lần
- Report cần snapshot nhất quán (đọc nhiều bảng liên quan)
- Kiểm tra inventory trước khi đặt hàng

### Serializable

**Use case:** Khi tính đúng đắn là tối quan trọng:
- Chuyển tiền giữa các tài khoản
- Booking (đặt vé máy bay, phòng khách sạn) — tránh overbooking
- Auction system (đấu giá)
- Bất kỳ logic nào dạng "đọc → kiểm tra → ghi" cần serializable

**Lưu ý khi dùng Serializable:**

```sql
-- Luôn cần retry logic khi dùng Serializable
-- vì transaction có thể bị abort do serialization conflict

-- Ví dụ pseudocode:
-- max_retries = 3
-- for i in range(max_retries):
--     try:
--         execute_transaction()
--         break
--     except SerializationFailure:
--         if i == max_retries - 1:
--             raise
--         continue
```

### Bảng quyết định nhanh

| Tình huống | Isolation Level khuyên dùng |
|-----------|---------------------------|
| CRUD API thông thường | Read Committed |
| Đọc report đơn giản | Read Committed |
| Batch job tính toán | Repeatable Read |
| Chuyển tiền ngân hàng | Serializable |
| Đặt vé / booking | Serializable |
| Dashboard monitoring | Read Uncommitted / Read Committed |
| E-commerce checkout | Repeatable Read + `SELECT FOR UPDATE` |
| Analytics / data warehouse | Read Committed |
