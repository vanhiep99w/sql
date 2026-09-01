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

```
┌───────────────────────────────────────────────────────┐
│                    ACID Properties                    │
├──────────────┬──────────────┬───────────┬─────────────┤
│  Atomicity   │ Consistency  │ Isolation │ Durability  │
│  (Nguyên tử) │ (Nhất quán)  │ (Cô lập)  │ (Bền vững)  │
│              │              │           │             │
│  Tất cả hoặc │ Dữ liệu      │ Các TX    │ Dữ liệu     │
│  không gì    │ luôn hợp lệ  │ độc lập   │ không mất   │
└──────────────┴──────────────┴───────────┴─────────────┘
```

### Atomicity — Tính nguyên tử

Atomicity đảm bảo rằng **tất cả** các thao tác trong transaction thành công, hoặc **không thao tác nào** được áp dụng. Không có trạng thái "thực hiện một nửa".

**Ví dụ chuyển tiền:**

Giả sử A chuyển 5.000.000₫ cho B. Transaction gồm 2 bước:
1. Trừ 5.000.000₫ từ tài khoản A
2. Cộng 5.000.000₫ vào tài khoản B

```
Trường hợp KHÔNG có Atomicity:
┌─────────────────────────────────────────────────┐
│ Bước 1: A: 10M → 5M        ✅ Thành công        │
│ Bước 2: B: 3M → ???        ❌ Lỗi hệ thống!     │
│                                                 │
│ Kết quả: A mất 5M, B không nhận được gì         │
│ → 5M biến mất khỏi hệ thống! 💸                 │
└─────────────────────────────────────────────────┘

Trường hợp CÓ Atomicity:
┌─────────────────────────────────────────────────┐
│ Bước 1: A: 10M → 5M        ✅ Thành công        │
│ Bước 2: B: 3M → ???        ❌ Lỗi hệ thống!     │
│                                                 │
│ → ROLLBACK: A: 5M → 10M    ↩️  Hoàn tác         │
│ Kết quả: A vẫn 10M, B vẫn 3M — không mất tiền   │
└─────────────────────────────────────────────────┘
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

```
Timeline minh họa Isolation:

Transaction A:    |--READ x=100--|--UPDATE x=200--|--COMMIT--|
Transaction B:              |--READ x=???--|

Không có Isolation: B đọc x = 200 (dữ liệu chưa commit)
Có Isolation:       B đọc x = 100 (dữ liệu đã commit trước đó)
```

### Durability — Tính bền vững

Durability đảm bảo rằng khi transaction đã **COMMIT thành công**, dữ liệu sẽ **không bị mất** dù hệ thống crash, mất điện, hay gặp sự cố phần cứng.

**Cơ chế đảm bảo Durability:**

#### WAL — Write-Ahead Logging

WAL (Write-Ahead Logging) là kỹ thuật cốt lõi: mọi thay đổi được ghi vào **log file trước** khi ghi vào data file thực tế.

```
Quy trình ghi dữ liệu với WAL:

1. Transaction thực thi UPDATE
2. Ghi thay đổi vào WAL (redo log) trên đĩa  ← Bắt buộc trước COMMIT
3. Trả về COMMIT OK cho client
4. Background process ghi dữ liệu từ buffer vào data file (checkpoint)

┌──────────┐    ┌──────────┐    ┌──────────────┐
│  Client  │───→│ WAL Log  │───→│  Data Files  │
│          │    │ (on disk)│    │  (on disk)   │
└──────────┘    └──────────┘    └──────────────┘
                 Ghi trước ↑      Ghi sau ↑
                 (đồng bộ)        (bất đồng bộ)
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

```text
TX1: UPDATE balance = 0 WHERE id = 1    -- chưa COMMIT
TX2: SELECT balance WHERE id = 1        -- đọc được 0
TX1: ROLLBACK                           -- số dư trở lại 10M
```

TX2 đã đọc và có thể sử dụng giá trị `0`. Tuy nhiên, sau khi TX1 rollback, giá trị `0` không còn tồn tại. Có thể hiểu TX2 đã nhìn thấy một **bản nháp chưa được xác nhận**.

> Dấu hiệu nhận biết: transaction khác **chưa commit** tại thời điểm dữ liệu được đọc. Dirty Read chỉ cần một lần `SELECT` là có thể xảy ra.

### Non-Repeatable Read

**Non-Repeatable Read** xảy ra khi một transaction đọc cùng một row hai lần nhưng nhận được hai kết quả khác nhau. Nguyên nhân là transaction khác đã cập nhật và **commit** row đó ở giữa hai lần đọc.

Ví dụ, số dư ban đầu là `10M`:

```text
TX1: SELECT balance WHERE id = 1        -- lần 1: đọc được 10M

TX2: UPDATE balance = 8M WHERE id = 1
TX2: COMMIT                             -- 8M đã trở thành dữ liệu chính thức

TX1: SELECT balance WHERE id = 1        -- lần 2: đọc được 8M
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

```text
Dirty Read:
UPDATE → READ → ROLLBACK
         ↑
         Đọc khi thay đổi chưa commit

Non-Repeatable Read:
READ lần 1 → UPDATE + COMMIT → READ lần 2
                                  ↑
                                  Kết quả khác lần 1
```

Khi gặp một ví dụ, hãy đặt hai câu hỏi theo thứ tự:

1. **Giá trị được đọc đã commit chưa?** Nếu chưa, đó là Dirty Read.
2. **Cùng dữ liệu có được đọc hai lần và cho kết quả khác nhau không?** Nếu có, đó là Non-Repeatable Read.

Nói ngắn gọn: **Dirty Read quan tâm dữ liệu có hợp lệ hay chưa; Non-Repeatable Read quan tâm hai lần đọc có nhất quán hay không.**

### Phantom Read

**Phantom Read** xảy ra khi một transaction chạy lại cùng một query nhưng nhận được **tập rows khác**. Transaction khác đã thêm, xóa hoặc làm một row đi vào/đi ra khỏi điều kiện tìm kiếm rồi commit ở giữa hai lần đọc.

Ví dụ, ban đầu phòng IT có 10 nhân viên:

```text
TX1: SELECT * FROM employees WHERE dept = 'IT'
     -- lần 1: nhận được 10 rows

TX2: INSERT INTO employees (id, name, dept)
     VALUES (99, 'Bình', 'IT')
TX2: COMMIT

TX1: SELECT * FROM employees WHERE dept = 'IT'
     -- lần 2: nhận được 11 rows, xuất hiện thêm nhân viên Bình
```

Các row cũ không nhất thiết bị thay đổi. Một row mới xuất hiện trong kết quả giống như một "bóng ma", vì vậy hiện tượng này được gọi là Phantom Read.

> Dấu hiệu nhận biết: cùng một **điều kiện tìm kiếm** nhưng danh sách rows ở lần đọc sau có thêm hoặc bớt phần tử.

### Phân biệt Non-Repeatable Read và Phantom Read

Hai hiện tượng có cùng cấu trúc nên rất dễ nhầm:

```text
TX1 đọc lần 1
TX2 thay đổi dữ liệu rồi COMMIT
TX1 đọc lần 2 → kết quả khác
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

```text
Non-Repeatable Read: cùng một row       → nội dung khác
Phantom Read:       cùng một điều kiện → danh sách rows khác
```

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

```
TX1: SELECT balance → 10M
TX2: SELECT balance → 10M
TX1: UPDATE balance = 10M - 3M = 7M; COMMIT;
TX2: UPDATE balance = 10M - 5M = 5M; COMMIT;
→ Kết quả: 5M (mất cập nhật -3M của TX1, đáng lẽ phải là 2M)
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

```
ACID:                                    BASE:
┌─────────────────────┐                  ┌─────────────────────┐
│  Transaction A      │                  │  Write to Node 1    │
│  ↓                  │                  │  ↓                  │
│  Lock → Write → OK  │                  │  Acknowledge client │
│  ↓                  │                  │  ↓                  │
│  Tất cả node đồng bộ│                  │  Async replicate    │
│  ↓                  │                  │  ↓                  │
│  COMMIT             │                  │  Node 2, 3 cập nhật │
│                     │                  │  sau vài ms ~ vài s │
│ ✅ Strong consistent│                  │  ✅ Eventually      │
│ ❌ Chậm hơn         │                  │     consistent      │
└─────────────────────┘                  │  ✅ Nhanh hơn       │
                                         └─────────────────────┘
```

**Khi nào chọn ACID:**
- Hệ thống tài chính, ngân hàng, thanh toán
- Dữ liệu yêu cầu chính xác tuyệt đối
- Inventory management (quản lý kho)

**Khi nào chọn BASE:**
- Social media feeds, likes, views count
- Log aggregation, analytics
- Hệ thống cần throughput cao, chấp nhận dữ liệu "cuối cùng nhất quán"
