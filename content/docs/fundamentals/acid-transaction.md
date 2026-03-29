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

Transaction đọc dữ liệu **chưa được commit** từ transaction khác. Nếu transaction kia rollback, dữ liệu đọc được là sai.

```
TX1: UPDATE balance = 0 WHERE id = 1   (chưa COMMIT)
TX2: SELECT balance FROM ... WHERE id = 1  → đọc được 0
TX1: ROLLBACK                              → balance thực tế vẫn là 10M
TX2: đã dùng giá trị sai (0) để tính toán → SAI!
```

### Non-Repeatable Read

Cùng một câu `SELECT` trong transaction, chạy 2 lần cho kết quả **khác nhau** vì transaction khác đã commit thay đổi.

```
TX1: SELECT salary WHERE id = 1  → 20M
TX2: UPDATE salary = 25M WHERE id = 1; COMMIT;
TX1: SELECT salary WHERE id = 1  → 25M   ← Kết quả khác lần trước!
```

### Phantom Read

Transaction đọc một tập rows, transaction khác thêm/xóa rows thỏa mãn điều kiện, khi đọc lại thì thấy rows "ma" xuất hiện/biến mất.

```
TX1: SELECT COUNT(*) FROM employees WHERE dept = 'IT'  → 10
TX2: INSERT INTO employees (..., dept='IT'); COMMIT;
TX1: SELECT COUNT(*) FROM employees WHERE dept = 'IT'  → 11  ← Phantom!
```

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
