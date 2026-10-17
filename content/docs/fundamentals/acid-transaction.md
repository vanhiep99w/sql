---
title: "ACID Transaction"
description: "Hiểu sâu về ACID trong database — Atomicity, Consistency, Isolation, Durability"
---

## Mục lục

- [Transaction là gì](#transaction-là-gì)
- [ACID Properties](#acid-properties)
  - [Atomicity — Tính nguyên tử](#atomicity--tính-nguyên-tử)
  - [Consistency — Tính nhất quán](#consistency--tính-nhất-quán)
  - [Isolation — Tính cô lập](#isolation--tính-cô-lập)
  - [Durability — Tính bền vững](#durability--tính-bền-vững)
- [Ví dụ Transaction thực tế](#ví-dụ-transaction-thực-tế)
- [Các vấn đề khi không có ACID](#các-vấn-đề-khi-không-có-acid)
  - [Dirty Read](#dirty-read)
  - [Non-Repeatable Read](#non-repeatable-read)
  - [Phân biệt Dirty Read và Non-Repeatable Read](#phân-biệt-dirty-read-và-non-repeatable-read)
  - [Phantom Read](#phantom-read)
  - [Phân biệt Non-Repeatable Read và Phantom Read](#phân-biệt-non-repeatable-read-và-phantom-read)
  - [Lost Update](#lost-update)
- [ACID vs BASE](#acid-vs-base)

---

## Transaction là gì

Transaction là một **đơn vị công việc logic** (logical unit of work) bao gồm một hoặc nhiều câu lệnh SQL được thực thi như một khối thống nhất. Toàn bộ các câu lệnh trong transaction hoặc **thành công hết** hoặc **thất bại hết** — không có trạng thái trung gian.

```sql
-- Một transaction chuyển tiền điển hình
BEGIN;
    UPDATE accounts SET balance = balance - 2000000 WHERE id = 1;  -- Trừ tiền người gửi
    UPDATE accounts SET balance = balance + 2000000 WHERE id = 2;  -- Cộng tiền người nhận
    INSERT INTO transactions (from_id, to_id, amount, created_at)
        VALUES (1, 2, 2000000, NOW());                             -- Ghi log
COMMIT;
```

Nếu bất kỳ câu lệnh nào trong block trên thất bại, toàn bộ transaction sẽ bị **rollback** — đảm bảo dữ liệu không bị sai lệch.

## ACID Properties

**ACID** là bốn tính chất mà mọi transaction trong database quan hệ phải đảm bảo:

```d2 title="Bốn thuộc tính ACID"
direction: right
acid: "ACID Properties"
a: "Atomicity: nguyên tử — tất cả hoặc không gì"
c: "Consistency: nhất quán — dữ liệu hợp lệ"
i: "Isolation: cô lập — kiểm soát tương tác giữa transaction"
d: "Durability: bền vững — dữ liệu commit không mất theo cam kết"
acid -> a
acid -> c
acid -> i
acid -> d
```

### Atomicity — Tính nguyên tử

Atomicity đảm bảo rằng **tất cả** các thao tác trong transaction thành công, hoặc **không thao tác nào** được áp dụng. Không có trạng thái "thực hiện một nửa".

**Ví dụ chuyển tiền:**

Giả sử A chuyển 5.000.000₫ cho B. Transaction gồm 2 bước:
1. Trừ 5.000.000₫ từ tài khoản A
2. Cộng 5.000.000₫ vào tài khoản B

```d2 title="Atomicity bảo vệ giao dịch chuyển tiền"
direction: right
without: Không có Atomicity {
  debit: A từ 10M còn 5M — thành công
  fail: Cộng B từ 3M — lỗi hệ thống
  lost: A còn 5M, B vẫn 3M — mất 5M
  debit -> fail -> lost
}
with_atomicity: Có Atomicity {
  debit: A từ 10M còn 5M — thành công
  fail: Cộng B từ 3M — lỗi hệ thống
  rollback: ROLLBACK — A từ 5M về 10M
  safe: A vẫn 10M, B vẫn 3M — không mất tiền
  debit -> fail -> rollback -> safe
}
```

**Cơ chế hoạt động**: Database sử dụng **undo log** (rollback segment) để ghi lại trạng thái trước khi thay đổi. Nếu transaction fail, database dùng undo log để phục hồi dữ liệu về trạng thái ban đầu.

### Consistency — Tính nhất quán

Consistency đảm bảo rằng transaction chỉ chuyển database từ **một trạng thái hợp lệ** sang **một trạng thái hợp lệ khác**. Mọi ràng buộc (constraints, triggers, foreign keys, data types) phải được thỏa mãn trước và sau transaction.

**Các cơ chế đảm bảo Consistency:**

| Cơ chế | Mô tả | Ví dụ |
|--------|--------|-------|
| `NOT NULL` | Cột không được để trống | `email VARCHAR(255) NOT NULL` |
| `UNIQUE` | Giá trị không trùng lặp | `UNIQUE(email)` |
| `CHECK` | Điều kiện logic | `CHECK(balance >= 0)` |
| `FOREIGN KEY` | Tham chiếu toàn vẹn | `REFERENCES accounts(id)` |
| Trigger | Logic kiểm tra tùy chỉnh | Kiểm tra tổng tiền trước/sau |

```sql
-- Ví dụ: constraint đảm bảo số dư không âm
ALTER TABLE accounts
ADD CONSTRAINT chk_balance CHECK (balance >= 0);

-- Transaction vi phạm constraint → bị reject
BEGIN;
    UPDATE accounts SET balance = balance - 15000000 WHERE id = 1;
    -- Nếu balance hiện tại là 10M → balance = -5M → vi phạm CHECK
    -- → Transaction bị ROLLBACK tự động
COMMIT;
-- ERROR: new row violates check constraint "chk_balance"
```

### Isolation — Tính cô lập

Isolation đảm bảo rằng các transaction chạy đồng thời **không ảnh hưởng lẫn nhau**. Mỗi transaction hoạt động như thể nó là transaction duy nhất trên hệ thống.

Mức độ cô lập được cấu hình qua **Isolation Levels** — từ thấp (hiệu suất cao, ít an toàn) đến cao (an toàn, hiệu suất thấp).

> 📖 Xem chi tiết tại [Isolation Levels](./isolation-levels)

```d2 title="Isolation quyết định B có thể thấy version nào"
shape: sequence_diagram
a: "Transaction A"
db: "Database"
b: "Transaction B"
a -> db: "READ x=100; UPDATE x=200 chưa commit"
b -> db: "READ x=? khi A chưa commit"
db.note2: "Engine/level cho dirty read có thể trả\n200; snapshot read không thấy ghi chưa\ncommit có thể đọc bản 100"
a -> db: "COMMIT"
```

### Durability — Tính bền vững

Durability đảm bảo rằng khi transaction đã **COMMIT thành công**, dữ liệu sẽ **không bị mất** dù hệ thống crash, mất điện, hay gặp sự cố phần cứng.

**Cơ chế đảm bảo Durability:**

#### WAL — Write-Ahead Logging

WAL (Write-Ahead Logging) là kỹ thuật cốt lõi: mọi thay đổi được ghi vào **log file trước** khi ghi vào data file thực tế.

```d2 title="Write-ahead logging: ghi log trước"
direction: right
n0: "Transaction thực thi UPDATE"
n1: "Ghi thay đổi và flush WAL xuống disk trước xác nhận commit"
n2: "Trả COMMIT OK cho client"
n3: "Background process ghi buffer xuống data file — checkpoint"
n0 -> n1 -> n2 -> n3
```

**Nếu hệ thống crash** sau bước 3 nhưng trước bước 4:
- Khi restart, database đọc WAL log và **replay** các thay đổi chưa được ghi vào data file.
- Dữ liệu được phục hồi hoàn toàn.

| Database | Cơ chế Durability |
|----------|------------------|
| PostgreSQL | WAL (Write-Ahead Log) |
| MySQL InnoDB | Redo Log + Doublewrite Buffer |
| Oracle | Redo Log + Archive Log |
| SQL Server | Transaction Log |

## Ví dụ Transaction thực tế

### MySQL

```sql
-- Chuyển tiền với kiểm tra đầy đủ
START TRANSACTION;

-- Kiểm tra số dư
SELECT balance INTO @sender_balance
FROM accounts WHERE id = 1 FOR UPDATE;  -- Lock row

IF @sender_balance >= 5000000 THEN
    UPDATE accounts SET balance = balance - 5000000 WHERE id = 1;
    UPDATE accounts SET balance = balance + 5000000 WHERE id = 2;

    INSERT INTO transfer_log (from_id, to_id, amount, status, created_at)
    VALUES (1, 2, 5000000, 'SUCCESS', NOW());

    COMMIT;
ELSE
    INSERT INTO transfer_log (from_id, to_id, amount, status, created_at)
    VALUES (1, 2, 5000000, 'FAILED_INSUFFICIENT', NOW());

    ROLLBACK;
END IF;
```

### PostgreSQL

```sql
-- Sử dụng block PL/pgSQL cho logic phức tạp
DO $$
DECLARE
    sender_balance DECIMAL(12, 2);
    transfer_amount DECIMAL(12, 2) := 5000000;
BEGIN
    -- Lock row và lấy số dư
    SELECT balance INTO sender_balance
    FROM accounts WHERE id = 1 FOR UPDATE;

    IF sender_balance < transfer_amount THEN
        RAISE EXCEPTION 'Số dư không đủ. Hiện tại: %, Cần: %',
            sender_balance, transfer_amount;
    END IF;

    UPDATE accounts SET balance = balance - transfer_amount WHERE id = 1;
    UPDATE accounts SET balance = balance + transfer_amount WHERE id = 2;

    INSERT INTO transfer_log (from_id, to_id, amount, status)
    VALUES (1, 2, transfer_amount, 'SUCCESS');

    -- Tự động COMMIT khi block kết thúc thành công
EXCEPTION
    WHEN OTHERS THEN
        -- Tự động ROLLBACK khi có exception
        INSERT INTO transfer_log (from_id, to_id, amount, status, error_message)
        VALUES (1, 2, transfer_amount, 'FAILED', SQLERRM);
        RAISE;
END $$;
```

## Các vấn đề khi không có ACID

Khi không đảm bảo ACID, hệ thống sẽ gặp các vấn đề nghiêm trọng về tính toàn vẹn dữ liệu:

### Dirty Read

**Dirty Read** xảy ra khi một transaction đọc thay đổi **chưa được commit** của transaction khác. Thay đổi này vẫn chỉ là dữ liệu tạm thời và có thể bị rollback.

Ví dụ, số dư ban đầu là `10M`:

```d2 title="Dirty read rồi writer rollback"
shape: sequence_diagram
a: "TX1"
db: "Database"
b: "TX2"
a -> db: "UPDATE balance=0 WHERE id=1; chưa COMMIT"
b -> db: "SELECT balance WHERE id=1"
db -> b: "0 — dirty read nếu engine/level cho phép"
a -> db: "ROLLBACK: balance trở lại 10M"
```

TX2 đã đọc và có thể sử dụng giá trị `0`. Tuy nhiên, sau khi TX1 rollback, giá trị `0` không còn tồn tại. Có thể hiểu TX2 đã nhìn thấy một **bản nháp chưa được xác nhận**.

> Dấu hiệu nhận biết: transaction khác **chưa commit** tại thời điểm dữ liệu được đọc. Dirty Read chỉ cần một lần `SELECT` là có thể xảy ra.

### Non-Repeatable Read

**Non-Repeatable Read** xảy ra khi một transaction đọc cùng một row hai lần nhưng nhận được hai kết quả khác nhau. Nguyên nhân là transaction khác đã cập nhật và **commit** row đó ở giữa hai lần đọc.

Ví dụ, số dư ban đầu là `10M`:

```d2 title="Hai lần đọc có thể thấy hai commit khác nhau"
shape: sequence_diagram
a: "TX1"
db: "Database"
b: "TX2"
a -> db: "SELECT balance WHERE id=1"
db -> a: "10M"
b -> db: "UPDATE balance=8M WHERE id=1; COMMIT"
a -> db: "SELECT lần 2"
db -> a: "8M trong ví dụ non-repeatable read"
```

Cả `10M` và `8M` đều là dữ liệu hợp lệ tại thời điểm TX1 nhìn thấy chúng. Vấn đề là TX1 không giữ được một góc nhìn nhất quán trong suốt transaction: cùng một row nhưng lần đọc sau không lặp lại được kết quả lần đầu.

> Dấu hiệu nhận biết: có **hai lần đọc** trong cùng một transaction và transaction khác **commit ở giữa**.

### Phân biệt Dirty Read và Non-Repeatable Read

Hai hiện tượng trông giống nhau vì đều có một transaction đang đọc trong lúc transaction khác thay đổi dữ liệu. Điểm khác biệt quan trọng nhất là thay đổi đó **đã commit hay chưa**.

| Tiêu chí | Dirty Read | Non-Repeatable Read |
|---|---|---|
| Dữ liệu được đọc | Chưa commit | Đã commit |
| Số lần đọc cần thiết | Một lần là đủ | Phải đọc cùng dữ liệu ít nhất hai lần |
| Nếu transaction ghi rollback | Giá trị đã đọc có thể biến mất | Không liên quan vì thay đổi đã commit |
| Vấn đề chính | Đọc phải dữ liệu tạm thời, có thể không bao giờ trở thành sự thật | Kết quả thay đổi giữa hai lần đọc trong cùng transaction |
| Thường có thể xảy ra ở | `READ UNCOMMITTED` | `READ COMMITTED` |

Có thể ghi nhớ bằng hai timeline ngắn:

```d2 title="Dirty read và non-repeatable read"
direction: right
dirty: Dirty Read {
  update: UPDATE chưa commit
  read: READ thấy thay đổi chưa commit
  rollback: ROLLBACK
  update -> read -> rollback
}
repeat: Non-Repeatable Read {
  first: READ lần 1
  update: UPDATE + COMMIT từ transaction khác
  second: READ lần 2 có kết quả khác
  first -> update -> second
}
```

Khi gặp một ví dụ, hãy đặt hai câu hỏi theo thứ tự:

1. **Giá trị được đọc đã commit chưa?** Nếu chưa, đó là Dirty Read.
2. **Cùng dữ liệu có được đọc hai lần và cho kết quả khác nhau không?** Nếu có, đó là Non-Repeatable Read.

Nói ngắn gọn: **Dirty Read quan tâm dữ liệu có hợp lệ hay chưa; Non-Repeatable Read quan tâm hai lần đọc có nhất quán hay không.**

### Phantom Read

**Phantom Read** xảy ra khi một transaction chạy lại cùng một query nhưng nhận được **tập rows khác**. Transaction khác đã thêm, xóa hoặc làm một row đi vào/đi ra khỏi điều kiện tìm kiếm rồi commit ở giữa hai lần đọc.

Ví dụ, ban đầu phòng IT có 10 nhân viên:

```d2 title="Phantom row sau một INSERT commit"
shape: sequence_diagram
a: "TX1"
db: "employees"
b: "TX2"
a -> db: "SELECT WHERE dept=IT"
db -> a: "10 rows"
b -> db: "INSERT (99, Bình, IT); COMMIT"
a -> db: "SELECT lại WHERE dept=IT"
db -> a: "11 rows nếu level/engine cho phantom trong\nví dụ"
```

Các row cũ không nhất thiết bị thay đổi. Một row mới xuất hiện trong kết quả giống như một "bóng ma", vì vậy hiện tượng này được gọi là Phantom Read.

> Dấu hiệu nhận biết: cùng một **điều kiện tìm kiếm** nhưng danh sách rows ở lần đọc sau có thêm hoặc bớt phần tử.

### Phân biệt Non-Repeatable Read và Phantom Read

Hai hiện tượng có cùng cấu trúc nên rất dễ nhầm:

```d2 title="Hai lần đọc xen giữa một commit"
direction: right
n0: "TX1 đọc lần 1"
n1: "TX2 thay đổi dữ liệu rồi COMMIT"
n2: "TX1 đọc lần 2: kết quả khác"
n0 -> n1
n1 -> n2
```

Điểm khác biệt nằm ở **thứ đã thay đổi**:

| Tiêu chí | Non-Repeatable Read | Phantom Read |
|---|---|---|
| Cái thay đổi | Giá trị của cùng một row | Tập rows thỏa điều kiện |
| Query điển hình | `WHERE id = 1` | `WHERE dept = 'IT'` |
| Thao tác thường gây ra | `UPDATE` | `INSERT` hoặc `DELETE` |
| Kết quả lần hai | Vẫn row đó nhưng nội dung khác | Có row xuất hiện hoặc biến mất |
| Câu hỏi để nhận biết | "Cùng một đối tượng có đổi thông tin không?" | "Danh sách đối tượng có thêm hoặc bớt không?" |

Ví dụ đời thường:

- **Non-Repeatable Read:** đọc hồ sơ của An hai lần; lần đầu lương `20M`, lần sau lương `25M`.
- **Phantom Read:** đọc danh sách nhân viên IT hai lần; lần sau xuất hiện thêm nhân viên Bình.

Có thể ghi nhớ ngắn gọn:

| Hiện tượng | Đối tượng so sánh | Khác biệt |
| --- | --- | --- |
| Non-Repeatable Read | Cùng một row | Nội dung khác |
| Phantom Read | Cùng một điều kiện | Danh sách rows khác |

Một trường hợp dễ gây nhầm là transaction khác dùng `UPDATE` để thay đổi phòng ban:

```sql
UPDATE employees
SET dept = 'IT'
WHERE id = 5;
COMMIT;
```

Nếu TX1 chạy lại `SELECT * FROM employees WHERE dept = 'IT'` và thấy `id = 5` xuất hiện thêm, hiện tượng vẫn mang tính chất **Phantom Read**. Điều quan trọng không phải loại câu lệnh là `INSERT` hay `UPDATE`, mà là **tập rows thỏa điều kiện đã thay đổi**.

Nói ngắn gọn: **Non-Repeatable Read theo dõi một row cụ thể; Phantom Read theo dõi một tập rows được xác định bởi điều kiện.**

### Lost Update

Hai transaction cùng đọc và cập nhật một giá trị, transaction sau ghi đè kết quả của transaction trước.

```d2 title="Lost update khi ghi lại số dư đã tính từ dữ liệu cũ"
shape: sequence_diagram
t1: "TX1"
db: "Database"
t2: "TX2"
t1 -> db: "SELECT balance = 10M"
t2 -> db: "SELECT balance = 10M"
t1 -> db: "UPDATE 10M - 3M = 7M; COMMIT"
t2 -> db: "UPDATE 10M - 5M = 5M; COMMIT"
db.note4: "Còn 5M: mất cập nhật -3M của TX1; đúng ra\nlà 2M"
```

## ACID vs BASE

Trong hệ thống phân tán, đặc biệt là NoSQL, mô hình **BASE** thường được sử dụng thay cho ACID để đạt hiệu suất và khả năng mở rộng cao hơn.

| Đặc điểm | ACID | BASE |
|-----------|------|------|
| Viết tắt | Atomicity, Consistency, Isolation, Durability | Basically Available, Soft state, Eventually consistent |
| Ưu tiên | **Tính đúng đắn** (correctness) | **Tính sẵn sàng** (availability) |
| Consistency | Strong consistency | Eventual consistency |
| Phù hợp | Tài chính, ngân hàng, thanh toán | Mạng xã hội, analytics, IoT |
| Database | MySQL, PostgreSQL, Oracle | MongoDB, Cassandra, DynamoDB |
| Scalability | Vertical (scale up) | Horizontal (scale out) |
| Lý thuyết nền | ACID properties | CAP theorem |

```d2 title="Đồng bộ trước xác nhận và nhân bản bất đồng bộ"
direction: right
sync: Ví dụ xác nhận sau bước đồng bộ {
  tx: Transaction A
  write: Lock / write
  sync: Hoàn thành đồng bộ theo cấu hình hệ thống
  commit: Xác nhận commit
  tx -> write -> sync -> commit
}
async: Ví dụ nhân bản bất đồng bộ {
  write: Write vào node 1
  ack: Xác nhận client
  replicate: Async replicate
  update: Node 2 và 3 cập nhật sau
  write -> ack -> replicate -> update
}
```

Đồng bộ trước xác nhận có thể tăng độ trễ; nhân bản bất đồng bộ có thể để các bản sao lệch tạm thời. Đây là ví dụ về **thời điểm xác nhận và replication**, không phải định nghĩa bắt buộc của ACID hay BASE. Một database có transaction ACID vẫn có thể dùng replica bất đồng bộ.

**Khi nào chọn ACID:**
- Hệ thống tài chính, ngân hàng, thanh toán
- Dữ liệu yêu cầu chính xác tuyệt đối
- Inventory management (quản lý kho)

**Khi nào chọn BASE:**
- Social media feeds, likes, views count
- Log aggregation, analytics
- Hệ thống cần throughput cao, chấp nhận dữ liệu "cuối cùng nhất quán"
