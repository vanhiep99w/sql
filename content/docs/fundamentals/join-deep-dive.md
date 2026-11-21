---
title: "JOIN & Join Algorithms"
description: "Mổ xẻ chi tiết JOIN trong SQL — INNER/LEFT/RIGHT/FULL/CROSS, và 3 thuật toán vật lý Nested Loop / Hash Join / Merge Join. Optimizer chọn thuật toán nào và tại sao, join order, driving table, kèm EXPLAIN ANALYZE và benchmark."
---

# JOIN & Join Algorithms — Deep Dive

<SourceRef project="fundamentals-join-deep-dive" variant="button">
Mở các đoạn code trong bài
</SourceRef>

Các file trong Source Explorer là **snippet độc lập**, giữ nguyên ngữ cảnh và database của từng mục; không chạy nối tiếp tất cả như một script.

## Mục lục

- [Bối cảnh: Cùng một JOIN, hai plan, chênh nhau 400 lần](#1-bối-cảnh-cùng-một-join-hai-plan-chênh-nhau-400-lần)
- [JOIN logic vs JOIN vật lý — Hai tầng khác nhau](#2-join-logic-vs-join-vật-lý--hai-tầng-khác-nhau)
- [Các loại JOIN logic — INNER, LEFT, RIGHT, FULL, CROSS](#3-các-loại-join-logic--inner-left-right-full-cross)
- [Các loại JOIN vật lý](#các-loại-join-vật-lý)
- [Nested Loop Join — Thuật toán đơn giản nhất](#4-nested-loop-join--thuật-toán-đơn-giản-nhất)
- [Hash Join — Vũ khí cho bảng lớn không sắp xếp](#5-hash-join--vũ-khí-cho-bảng-lớn-không-sắp-xếp)
  - [Dùng bảng nào để dựng bảng băm và xử lý khóa trùng?](#511-dùng-bảng-nào-để-dựng-bảng-băm-và-xử-lý-khóa-trùng)
  - [Tìm đúng dòng trong bucket](#512-tìm-đúng-dòng-trong-bucket)
- [Merge Join — Khi dữ liệu đã sắp xếp sẵn](#6-merge-join--khi-dữ-liệu-đã-sắp-xếp-sẵn)
  - [Vì sao cần thứ tự và lấy thứ tự từ đâu?](#62-điều-kiện-tiên-quyết-cả-hai-đầu-vào-phải-sorted)
- [Bảng so sánh 3 thuật toán](#7-bảng-so-sánh-3-thuật-toán)
- [Optimizer chọn thuật toán nào — Cost model](#8-optimizer-chọn-thuật-toán-nào--cost-model)
- [Driving Table & Join Order — Ai chạy trước quyết định tất cả](#9-driving-table--join-order--ai-chạy-trước-quyết-định-tất-cả)
- [Đọc EXPLAIN cho JOIN — Từng dòng một](#10-đọc-explain-cho-join--từng-dòng-một)
- [OUTER JOIN ảnh hưởng thuật toán như thế nào](#11-outer-join-ảnh-hưởng-thuật-toán-như-thế-nào)
- [Semi Join & Anti Join — EXISTS, IN, NOT EXISTS](#12-semi-join--anti-join--exists-in-not-exists)
- [So sánh giữa Postgres / MySQL / Oracle / SQL Server](#13-so-sánh-giữa-postgres--mysql--oracle--sql-server)
- [Anti-patterns cần tránh](#14-anti-patterns-cần-tránh)
- [Tóm tắt — Cheat sheet](#15-tóm-tắt--cheat-sheet)

---

## 1. Bối cảnh: Cùng một JOIN, hai plan, chênh nhau 400 lần

Bạn có 2 bảng trong hệ thống e-commerce:

```sql
CREATE TABLE customers (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT,
    country    TEXT
);
-- 1,000,000 rows

CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    customer_id BIGINT REFERENCES customers(id),
    total       NUMERIC(10,2),
    created_at  TIMESTAMPTZ
);
-- 50,000,000 rows
CREATE INDEX idx_orders_customer ON orders(customer_id);
```

Bạn viết một câu JOIN tưởng như vô hại:

```sql
SELECT c.name, o.total
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE c.country = 'Vietnam';
```

- Nếu `Vietnam` chỉ có **50 khách** → optimizer chọn **Nested Loop**, chạy trong **8ms**.
- Nếu `Vietnam` có **900,000 khách** → optimizer chọn **Hash Join**, chạy trong **3.2 giây**.

Nhưng nếu optimizer **đoán sai** số khách (do statistics cũ), nó có thể chọn Nested Loop cho 900,000 khách → **3.400 giây** (gần 1 giờ). Cùng câu SQL, cùng dữ liệu, **chênh nhau hơn 400.000 lần**.

> [!IMPORTANT]
> Bạn viết `JOIN` — đó là **ý định logic**. Database dịch nó thành **một trong ba thuật toán vật lý**: Nested Loop, Hash Join, hoặc Merge Join. Chọn sai thuật toán là nguyên nhân số một khiến JOIN chậm. Hiểu ba thuật toán này = hiểu 80% việc tối ưu JOIN.

Trong doc này ta sẽ mổ xẻ:

1. Sự khác nhau giữa **JOIN logic** (bạn viết) và **JOIN vật lý** (DB chạy).
2. Ba thuật toán, cách chúng hoạt động **từng bước**, kèm chi phí cụ thể.
3. Cách **optimizer** dựa vào cost model để chọn.
4. Vì sao **join order** và **driving table** quyết định tất cả.
5. Cách **đọc EXPLAIN** để biết DB đang làm gì.

---

## 2. JOIN logic vs JOIN vật lý — Hai tầng khác nhau

Đây là điểm nhầm lẫn lớn nhất của người mới. `INNER JOIN`, `LEFT JOIN` là **cú pháp logic** — mô tả **kết quả mong muốn**. Chúng **không** quyết định cách DB thực thi.

```d2 title="JOIN logic và thuật toán vật lý"
direction: down
logic: "Tầng logic: INNER / LEFT / RIGHT / FULL / CROSS — row nào xuất hiện?"
physical: "Tầng vật lý: Nested Loop / Hash / Merge — ghép row bằng cách nào?"
logic -> physical: "optimizer dịch"
```

Ví dụ minh họa: cùng một `INNER JOIN` dưới đây có thể được thực thi bằng **cả ba** thuật toán tùy dữ liệu và index:

```sql
SELECT * FROM a JOIN b ON a.id = b.a_id;
```

| Tình huống | Thuật toán optimizer chọn |
|-----------|---------------------------|
| `a` nhỏ (10 row), `b` có index trên `a_id` | Nested Loop |
| `a` và `b` đều lớn, không có index phù hợp | Hash Join |
| `a` và `b` đều lớn, cả hai đã sort theo cột join | Merge Join |

> [!NOTE]
> Bạn **không** viết `NESTED LOOP JOIN` trong SQL chuẩn. Optimizer tự chọn. Bạn chỉ có thể *gợi ý* (hint) ở một số DB — xem [phần so sánh](#13-so-sánh-giữa-postgres--mysql--oracle--sql-server).

---

## 3. Các loại JOIN logic — INNER, LEFT, RIGHT, FULL, CROSS

Trước khi vào thuật toán, cần chắc chắn về ngữ nghĩa logic. Dùng 2 bảng nhỏ:

```
customers                    orders
┌────┬─────────┐            ┌────┬─────────────┬───────┐
│ id │ name    │            │ id │ customer_id │ total │
├────┼─────────┤            ├────┼─────────────┼───────┤
│ 1  │ An      │            │ 10 │ 1           │ 100   │
│ 2  │ Bình    │            │ 11 │ 1           │ 200   │
│ 3  │ Chi     │            │ 12 │ 2           │ 150   │
└────┴─────────┘            │ 13 │ 9 (rác)     │ 999   │
                            └────┴─────────────┴───────┘
```

### 3.1. INNER JOIN — Chỉ giữ row khớp cả hai bên

```sql
SELECT c.name, o.total
FROM customers c
INNER JOIN orders o ON o.customer_id = c.id;
```

```
name │ total
─────┼──────
An   │ 100
An   │ 200
Bình │ 150
```

Chi (id=3) không có order → **bị loại**. Order id=13 (customer_id=9 không tồn tại) → **bị loại**.

### 3.2. LEFT JOIN — Giữ tất cả bên trái

```sql
SELECT c.name, o.total
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id;
```

```
name │ total
─────┼──────
An   │ 100
An   │ 200
Bình │ 150
Chi  │ NULL   ← Chi vẫn xuất hiện, cột bên phải là NULL
```

### 3.3. RIGHT JOIN — Giữ tất cả bên phải

Đối xứng với LEFT. `A RIGHT JOIN B` ≡ `B LEFT JOIN A`. Thực tế hiếm dùng — người ta viết lại thành LEFT cho dễ đọc.

### 3.4. FULL OUTER JOIN — Giữ cả hai bên

```
name │ total
─────┼──────
An   │ 100
An   │ 200
Bình │ 150
Chi  │ NULL   ← customer không có order
NULL │ 999    ← order không có customer
```

### 3.5. CROSS JOIN — Tích Descartes

Mỗi row bên trái ghép với **mọi** row bên phải. 3 customer × 4 order = **12 row**. Nguy hiểm khi quên điều kiện JOIN → tạo ra "accidental cross join" bùng nổ số row.

```d2 title="3.5. CROSS JOIN — Tích Descartes"
direction: right
A: "INNER\nchỉ phần giao"
B: "LEFT\ntất cả trái + giao"
C: "FULL\ntất cả hai bên"
D: "CROSS\nmọi cặp có thể"
```

> [!TIP]
> `WHERE b.col = x` trên cột của bảng **outer** (bên phải LEFT JOIN) sẽ **âm thầm biến LEFT JOIN thành INNER JOIN**, vì row NULL bị `WHERE` loại bỏ. Muốn giữ ngữ nghĩa LEFT, đặt điều kiện vào `ON` chứ không phải `WHERE`.

---

## Các loại JOIN vật lý

`INNER JOIN` nói **cặp dòng nào được giữ lại**. Nó không nói database phải tìm các cặp đó như thế nào. Với phép ghép theo dấu `=` dưới đây, cả ba thuật toán đều có thể cho cùng kết quả:

- **Nested Loop Join:** giữ một khách rồi tìm đơn khớp. Bản mô phỏng quét lại danh sách đơn từ đầu cho mỗi khách.
- **Hash Join:** đưa khách vào các bucket theo khóa, rồi dùng khóa trên từng đơn để dò bucket. Cùng bucket vẫn phải kiểm tra khóa thật.
- **Merge Join:** đi qua hai dãy đã sắp theo khóa. Nếu hai khóa khác nhau, tiến bên có khóa nhỏ hơn; nếu bằng nhau, ghép đủ các cặp trong nhóm cùng khóa.

Đây là câu SQL mà cả ba chế độ bên dưới minh họa:

```sql
SELECT c.id AS customer_id, c.name, o.id AS order_id
FROM customers AS c
INNER JOIN orders AS o ON c.id = o.customer_id;
```

`c.id` là mã khách, còn `o.customer_id` là mã khách ghi trên đơn. Hai cột này là khóa ghi trong ô vuông trên mỗi thẻ. `o.id` chỉ là **mã đơn** dùng để nhận diện kết quả, không phải khóa đem ra so.

<JoinAnimation />

Bấm **Bước sau** trong **Merge Join** và để ý khóa `1`: An ghép với cả đơn `#10` lẫn `#11`. Bình ghép với đơn `#12`. Chi không có đơn khớp, còn đơn `#13` trỏ tới khóa `9` không có khách tương ứng, nên cả hai đều không xuất hiện trong kết quả `INNER JOIN`. Số bước mô phỏng không phải thước đo hiệu năng.

---

## 4. Nested Loop Join — Thuật toán đơn giản nhất

### 4.1. Ý tưởng

Giống hai vòng lặp `for` lồng nhau:

```
for mỗi row R trong OUTER table:       -- bảng ngoài (driving/outer)
    for mỗi row S trong INNER table:   -- bảng trong (inner/probed)
        if R khớp S theo điều kiện join:
            xuất (R, S)
```

> [!NOTE]
> **Lấy một dòng từ outer, rồi tìm các dòng khớp trong inner.** Outer có 3 dòng thì tìm trong inner 3 lượt, mỗi lượt cho một dòng outer.
>
> Outer thường là bên còn ít dòng sau khi lọc, không nhất thiết là bảng nhỏ hơn. Ví dụ: lọc lấy **3 đơn hàng** từ bảng `orders`, rồi tìm khách của từng đơn trong `customers`. Lúc này `orders` có thể là outer, dù cả bảng `orders` lớn hơn `customers`.

### 4.2. Ví dụ cụ thể

`customers` có 3 row, `orders` có 4 row:

```d2 title="Nested Loop kiểm tra từng outer row với inner input"
direction: right
an: "Outer: An"
binh: "Outer: Bình"
chi: "Outer: Chi"
scan_an: "Quét 4 orders → khớp 10, 11"
scan_b: "Quét 4 orders → khớp 12"
scan_c: "Quét 4 orders → không khớp"
an -> scan_an
binh -> scan_b
chi -> scan_c
```

Nếu quét thô (không index): chi phí = `số row outer × số row inner` = 3 × 4 = **12 phép so sánh**. Với 1 triệu × 50 triệu = **50.000 tỉ phép** → không khả thi.

### 4.3. Cứu tinh: Index trên bảng inner

Vòng ngoài vẫn lấy từng khách. **Index chỉ thay đổi cách vòng trong tìm đơn:** thay vì thử mọi dòng `orders`, database dùng `c.id` để tra đúng khóa `orders.customer_id`. Chạy cùng câu `SELECT` trước và sau khi tạo index để so sánh. Index bổ sung một cách tìm đơn cho optimizer, không đổi điều kiện JOIN hay kết quả:

```sql
-- Tạo index trên cột JOIN của bảng orders (inner).
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- Câu SELECT của mô phỏng: lấy tên khách và mã đơn khớp.
SELECT c.id AS customer_id, c.name, o.id AS order_id
FROM customers AS c
INNER JOIN orders AS o ON c.id = o.customer_id;
```

Thử **Quét từng đơn**, rồi chuyển sang **Tra index**. Với An (`id = 1`), cách quét phải thử cả bốn đơn; cách tra index tìm khóa `1` và lấy thẳng đơn `#10` và `#11`. Với Chi (`id = 3`), index không có khóa tương ứng nên không cần lấy dòng nào từ `orders`.

<NestedLoopIndexAnimation />

Cả hai cách đều trả về 3 cặp. Bản quét thử **12 cặp khách–đơn**; bản có index thực hiện **3 lượt tra khóa**, một lượt cho mỗi khách. Đây là hai loại thao tác khác nhau: một lượt tra có thể phải đi qua nhiều trang B-tree và lấy nhiều dòng khớp. Mô phỏng chỉ hiển thị các mục lá theo khóa, không đo số lần đọc đĩa hay thời gian chạy.

Index giúp rõ nhất khi outer còn ít dòng sau lọc và mỗi khóa chỉ khớp ít đơn. Nếu phần lớn đơn đều phải được lấy, optimizer có thể chọn cách khác.

### 4.4. EXPLAIN thực tế

```sql
EXPLAIN ANALYZE
SELECT c.name, o.total
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE c.country = 'Vietnam';   -- chỉ 50 khách
```

```text
 Nested Loop  (cost=0.86..842.13 rows=520 width=40)
              (actual time=0.041..7.912 rows=487 loops=1)
   ->  Index Scan using idx_customers_country on customers c
              (actual time=0.018..0.203 rows=50 loops=1)   ← OUTER: 50 row
         Index Cond: (country = 'Vietnam')
   ->  Index Scan using idx_orders_customer on orders o
              (actual time=0.004..0.142 rows=10 loops=50)  ← INNER: chạy 50 LẦN
         Index Cond: (customer_id = c.id)
 Execution Time: 8.104 ms
```

> [!TIP]
> Trong `EXPLAIN ANALYZE` của PostgreSQL, node con thứ nhất dưới `Nested Loop` là **outer**, node con thứ hai là **inner**. Đọc thứ tự trong plan, đừng suy ra từ thứ tự `FROM ... JOIN ...`. Ví dụ trên, inner `Index Scan` có `loops=50` vì được gọi một lượt cho mỗi khách; `loops` đếm số lần chạy node, không phải số lần đọc đĩa.

### 4.5. Khi nào Nested Loop thành thảm họa

Khi outer **lớn** mà optimizer vẫn chọn Nested Loop (thường do đoán sai số row):

```text
 Nested Loop  (actual time=... rows=900000 loops=1)
   ->  Seq Scan on customers   (rows=900000 loops=1)   ← OUTER: 900K row!
   ->  Index Scan on orders    (rows=50 loops=900000)  ← chạy 900,000 LẦN
```

900.000 lần đọc index → hàng nghìn giây. Trường hợp này Hash Join sẽ nhanh hơn hàng trăm lần.

---

## 5. Hash Join — Vũ khí cho bảng lớn không sắp xếp

### 5.1. Ý tưởng: xây bảng băm rồi dò

Hash Join gồm **2 pha**:

```d2 title="Hash Join gồm hai pha"
direction: right
n0: "BUILD: đọc đầu vào được chọn để dựng bảng băm"
n1: "Băm khóa JOIN → đưa từng dòng vào bucket"
n2: "PROBE: đọc từng dòng của đầu vào còn lại"
n3: "Băm cột join → tra hash table"
n4: "Khớp thì xuất kết quả"
n0 -> n1 -> n2 -> n3 -> n4
```

```d2 title="Build customers, probe orders"
direction: right
hash_table: Hash table từ customers {
  a: hash(1) → An
  b: hash(2) → Bình
  c: hash(3) → Chi
}
o1: Order customer_id=1
o2: Order customer_id=2
o9: Order customer_id=9
miss: Không có key 9 — bỏ
o1 -> hash_table.a: khớp An
o2 -> hash_table.b: khớp Bình
o9 -> miss
```

> [!NOTE]
> **Hai bucket trong mô phỏng là hai ngăn của cùng một hash table**, không phải hai bảng. Hash Join dựng bảng băm từ `customers`; `orders` chỉ dò vào đó. Demo dùng `key % 2` nên khóa `1` và `3` cùng vào bucket `1`. Khi dò, database vẫn phải so khóa thật để biết dòng nào khớp.
>
> PostgreSQL không cố định hai bucket. Số bucket được chọn dựa trên số dòng ước tính ở phía build và ngân sách bộ nhớ, và có thể thay đổi lúc chạy. Ví dụ ở [mục 5.4](#54-explain-thực-tế), `Buckets: 131072` nghĩa là **131.072 ngăn**; `Batches: 4` nghĩa là **4 lô xử lý**, không phải 4 ngăn hay 4 bảng.

#### 5.1.1. Dùng bảng nào để dựng bảng băm và xử lý khóa trùng?

**Chọn phía build** nghĩa là quyết định lấy dòng từ bảng nào để đưa vào bảng băm. Ví dụ, nếu dùng `customers` để dựng bảng băm, database đưa từng khách vào bucket theo `customers.id`. Sau đó, database đọc từng đơn từ `orders` và dùng `orders.customer_id` để dò. Lúc này `customers` là phía **build** (dựng bảng băm), còn `orders` là phía **probe** (dò bảng băm).

Optimizer thường dựng bảng băm từ phía ước tính có ít dữ liệu hơn **sau khi lọc**. Nó cân nhắc số dòng, độ rộng dòng và chi phí của plan, không chỉ kích thước bảng gốc. Trong `EXPLAIN` của PostgreSQL, nhìn node con dưới `Hash` ở [mục 5.4](#54-explain-thực-tế) để biết dữ liệu dùng để dựng bảng băm đến từ đâu.

Giả sử `orders` là phía **build**: database dùng các dòng đơn hàng để dựng bảng băm và băm theo **`orders.customer_id`**, không phải mã đơn `orders.id`. Nếu đơn `#10` và `#11` đều có `customer_id = 1`, chúng vào cùng bucket nhưng vẫn là **hai mục riêng**, không ghi đè nhau. Khi `customers` làm phía **probe**, khách An (`id = 1`) ghép với cả hai đơn. Nếu hai phía có lần lượt 2 và 3 dòng cùng một khóa, `INNER JOIN` xuất đủ **2 × 3 = 6 cặp** cho khóa đó. Bạn có thể chạy cả hai tình huống trong [mô phỏng bên dưới](#hash-bucket-animation).

#### 5.1.2. Tìm đúng dòng trong bucket

Giả sử khóa đang dò là `1`, hash đầy đủ là `101`, và ta chọn bucket bằng `hash % 2`. Đây là số minh họa, không phải giá trị hash thật của PostgreSQL. Cả hash `101` và `103` đều dẫn tới **bucket `1`**. Khi duyệt từng mục trong bucket, PostgreSQL so hash đầy đủ **trước khi so khóa thật**:

| Mục trong bucket `1` | PostgreSQL làm gì? |
| --- | --- |
| Hash `103`, khóa `3` | `103 ≠ 101`: bỏ mục này mà không cần so khóa. |
| Hash `101`, khóa `1` | Hash trùng: so khóa `1 = 1` rồi xuất cặp khớp. |

Hash trùng **chưa đủ** để kết luận khóa trùng. Ngược lại, nếu nhiều dòng thật sự có cùng khóa, Hash Join phải xuất đủ các cặp khớp. Tăng số bucket có thể giảm va chạm giữa các khóa khác nhau, nhưng không tách các dòng có cùng khóa.

Bấm **Bước sau** để đưa từng đơn vào bảng băm. Khi An dò bucket `1`, hãy theo dõi ba trường hợp:

- Đơn `#13` có khóa `9`, hash `109`: cùng bucket nhưng bị loại ở bước **so hash**.
- Đơn `#15` có khóa `11`, hash `101`: qua bước so hash, nhưng bị loại ở bước **so khóa thật** vì `11 ≠ 1`.
- Hai đơn `#10` và `#11` cùng có khóa `1`, hash `101`: cả hai đều khớp và tạo **hai cặp riêng**.

Mô phỏng dùng `hash = 100 + (key % 10)` và `bucket = hash % 2` để dễ thấy hai kiểu va chạm; đây không phải hàm băm của PostgreSQL. Chế độ **2 × 3** dùng hai dòng khách giả lập cùng khóa `1` để cho thấy vì sao kết quả có sáu cặp.

<HashBucketAnimation />

### 5.2. Vì sao nhanh

Với khóa có kích thước cố định, tính hash và chọn bucket thường là `O(1)`. Nhưng nếu bucket có `k` mục, lượt dò của `INNER JOIN` có thể phải duyệt cả `k` mục, tức `O(k)`. Ví dụ, bucket có 1.000 mục thì tìm được bucket không có nghĩa là bỏ qua 1.000 mục đó; bước so hash chỉ giúp loại nhanh các mục có hash khác.

Bảng băm là cấu trúc tạm, thường được **dựng lại mỗi lần chạy query**; tái sử dụng execution plan không đồng nghĩa tái sử dụng bảng băm. Pha build phải đọc và băm từng dòng phía build, và nếu thiếu bộ nhớ còn có thể phải ghi batch ra đĩa. Đổi lại, mỗi dòng probe chỉ cần dò một bucket thay vì quét lại toàn bộ phía build.

Khi hash phân bố tốt và bảng băm vừa bộ nhớ, tổng chi phí kỳ vọng gần `O(số dòng build + số dòng probe + số cặp khớp)`. Đây là lợi thế so với Nested Loop quét thô, nhất là khi cả hai đầu vào lớn và không có index phù hợp.

### 5.3. Cái giá: RAM và không tận dụng order

- Cần **RAM** để chứa hash table. Ở Postgres, nếu build input lớn hơn `work_mem`, hash table **tràn ra đĩa** (batched hash join) → chậm đi nhiều.
- Kết quả **không được sắp xếp** theo cột join.
- Chỉ hỗ trợ **equi-join** (`=`). Không dùng được cho `a.x < b.y`.

### 5.4. EXPLAIN thực tế

```sql
EXPLAIN ANALYZE
SELECT c.name, o.total
FROM customers c
JOIN orders o ON o.customer_id = c.id;   -- không filter → cả 2 bảng lớn
```

```text
 Hash Join  (cost=32150..1284301 rows=50000000 width=40)
            (actual time=412..3187 rows=49999500 loops=1)
   Hash Cond: (o.customer_id = c.id)
   ->  Seq Scan on orders o        (rows=50000000 loops=1)   ← PROBE (lớn)
   ->  Hash  (rows=1000000)                                  ← BUILD (nhỏ)
         Buckets: 131072  Batches: 4  Memory Usage: 6144kB   ← Batches>1 = tràn đĩa
         ->  Seq Scan on customers c  (rows=1000000 loops=1)
 Execution Time: 3204 ms
```

> [!IMPORTANT]
> Đọc dòng `Batches: N`. Nếu `Batches > 1`, hash table **không đủ RAM** và phải chia batch ghi ra đĩa. Tăng `work_mem` (Postgres) hoặc `join_buffer_size` (MySQL) có thể đưa về `Batches: 1` và tăng tốc đáng kể.

---

## 6. Merge Join — Khi dữ liệu đã sắp xếp sẵn

### 6.1. Ý tưởng: hai con trỏ chạy song song

Giống việc ghép hai danh sách **đã sắp xếp** (như bước merge trong merge sort):

```d2 title="Merge Join đi theo thứ tự key của hai input"
direction: right
customers: Customers sort theo id {
  an: 1 — An
  binh: 2 — Bình
  chi: 3 — Chi
}
orders: Orders sort theo customer_id {
  a: 1 — order thứ nhất
  b: 1 — order thứ hai
  c: 2
  d: 9 — không có customer tương ứng
}
customers.an -> orders.a: khớp
customers.an -> orders.b: khớp
customers.binh -> orders.c: khớp
customers.chi -> orders.d: hết customers; không match key 9
```

Merge Join tiến qua các **nhóm khóa theo thứ tự**, không quét lại cả đầu vào cho mỗi dòng. Nếu hai bên đều có nhiều dòng cùng khóa, nó vẫn phải giữ hoặc đọc lại nhóm khớp để xuất đủ mọi cặp.

### 6.2. Điều kiện tiên quyết: cả hai đầu vào phải sorted

Lấy cùng câu JOIN trong mô phỏng:

```sql
SELECT c.name, o.id AS order_id
FROM customers AS c
JOIN orders AS o ON c.id = o.customer_id;
```

Merge Join cần **các dòng đi vào bộ ghép** theo cùng thứ tự của hai khóa trong `ON`. Ở đây là `customers.id` bên khách và `orders.customer_id` bên đơn, **không phải `orders.id`**. Ví dụ, bộ ghép nhận hai dãy tăng dần:

| Khách theo `customers.id` | Đơn theo `orders.customer_id` |
| --- | --- |
| `1` — An | `1` — #10 |
| `2` — Bình | `1` — #11 |
| `3` — Chi | `2` — #12 |
| | `9` — #13 |

An ghép với cả `#10` và `#11`, rồi Bình ghép với `#12`. Khi còn Chi (`3`) và đơn `#13` (`9`), Merge Join có thể bỏ qua Chi ngay: dãy đơn đã tăng dần, nên từ vị trí hiện tại trở đi không thể gặp lại khóa `3`.

**Thứ tự đó đến từ đâu?**

- **Đã có thứ tự nhờ index:** nếu PostgreSQL dùng B-tree trên `customers.id` và `orders.customer_id` để đọc tuần tự theo khóa, hai đầu vào đã đúng thứ tự mà không cần node `Sort`. Không có nghĩa là các dòng trong bảng trên đĩa phải được xếp sẵn. Xem hai node `Index Scan` ở [mục 6.4](#64-explain-thực-tế).
- **Chưa có thứ tự, nhưng sắp xếp ít dòng:** giả sử phía khách đã có thứ tự, còn phía đơn sau khi lọc theo `created_at` chỉ còn **200 dòng**. PostgreSQL có thể thêm `Sort` theo `customer_id` cho **200 dòng đã lọc**, không phải sắp xếp cả bảng `orders`. Nếu tổng chi phí ước tính thấp hơn các plan khác, Merge Join vẫn có thể được chọn.

Nếu cả hai phía có nhiều dòng chưa sắp xếp, chi phí `Sort` có thể làm Hash Join rẻ hơn. Con số 200 chỉ để minh họa, không phải ngưỡng chọn thuật toán.

### 6.3. Điểm mạnh riêng

- Khi hai đầu vào đã đúng thứ tự, Merge Join có thể xử lý dần mà không cần dựng bảng băm cho toàn bộ một phía.
- Nếu thứ tự mà plan giữ được trùng với `ORDER BY` cần thiết, PostgreSQL có thể tránh thêm một bước `Sort`. Bạn **không cần** thêm `ORDER BY` để dùng Merge Join; chỉ thêm khi muốn SQL bảo đảm thứ tự **kết quả trả về**.

### 6.4. EXPLAIN thực tế

```text
 Merge Join  (actual time=0.06..1820 rows=49999500 loops=1)
   Merge Cond: (c.id = o.customer_id)
   ->  Index Scan using customers_pkey on customers c   (rows=1000000)
   ->  Index Scan using idx_orders_customer on orders o (rows=50000000)
 Execution Time: 1912 ms
```

Không có node `Sort` → cả hai đầu vào lấy từ Index Scan (đã sorted). Đây là Merge Join lý tưởng.

---

## 7. Bảng so sánh 3 thuật toán

| Tiêu chí | Nested Loop | Hash Join | Merge Join |
|----------|-------------|-----------|------------|
| **Ý tưởng** | 2 vòng lặp lồng nhau | Build hash + probe | 2 con trỏ trên dữ liệu sorted |
| **Độ phức tạp** | O(M × N), hoặc O(M × log N) nếu inner có index | O(M + N) | O(M + N) nếu đã sort; +O(N log N) nếu phải sort |
| **Tốt nhất khi** | Outer nhỏ + inner có index | Cả hai lớn, equi-join, không sorted | Cả hai lớn + đã sorted sẵn |
| **Cần RAM** | Rất ít | Nhiều (hash table) | Ít |
| **Loại join** | Mọi loại (=, <, >, range) | Chỉ equi-join (=) | Equi + một số range |
| **Kết quả sorted?** | Theo outer | Không | Có (theo cột join) |
| **Điểm chết** | Outer lớn → cực chậm | Build tràn RAM → tràn đĩa | Phải sort 2 bảng lớn |
| **Điển hình** | OLTP, lookup vài row | OLAP, join 2 bảng lớn | Join theo PK/FK đã index |

```d2 title="7. Bảng so sánh 3 thuật toán"
direction: down
Start: "JOIN a và b"
Q1: "Một bảng\nrất nhỏ?" { shape: diamond }
NL: "Nested Loop"
Q2: "Cả hai đã\nsorted theo\ncột join?" { shape: diamond }
MJ: "Merge Join"
Q3: "Equi-join\nvà đủ RAM?" { shape: diamond }
HJ: "Hash Join"
MJ2: "Merge Join\n+ Sort"
Start -> Q1
Q1 -> NL: "Có, và bảng kia\ncó index"
Q1 -> Q2: "Không"
Q2 -> MJ: "Có"
Q2 -> Q3: "Không"
Q3 -> HJ: "Có"
Q3 -> MJ2: "Không"
```

---

## 8. Optimizer chọn thuật toán nào — Cost model

Optimizer **không** chạy thử cả ba rồi chọn. Nó dùng statistics để ước tính chi phí và chọn plan rẻ nhất trong số các phương án đã xét. Với cùng điều kiện `c.id = o.customer_id`, đây là ba tình huống dễ gặp:

| Tình huống | PostgreSQL thường cân nhắc | Vì sao? |
| --- | --- | --- |
| Sau khi lọc chỉ còn **5 khách**, có index phù hợp trên `orders.customer_id`. | **Nested Loop** | Tra index cho từng khách (5 lượt), thay vì đọc hết `orders`. |
| Còn **rất nhiều khách**, phải đọc phần lớn đơn, hai đầu vào chưa có thứ tự phù hợp và bảng băm dự kiến vừa bộ nhớ. | **Hash Join** | Dựng bảng băm từ một phía, rồi dò theo khóa cho từng dòng phía kia. Tránh phải tra lặp lại nhiều lượt vào bảng đơn. |
| Hai đầu vào **đã theo thứ tự khóa JOIN**, hoặc chỉ cần sắp xếp ít dòng sau lọc. | **Merge Join** | Đi dọc hai dãy để ghép. Ví dụ, phía khách đã có thứ tự và chỉ cần `Sort` 200 dòng phía đơn. Xem [mục 6.2](#62-điều-kiện-tiên-quyết-cả-hai-đầu-vào-phải-sorted). |

Không có ngưỡng cố định kiểu “trên 1.000 dòng thì chọn Hash Join”. Đổi bộ lọc có thể đổi số dòng ước tính, cách đọc bảng và cả thuật toán JOIN.

### 8.1. Công thức trực giác (Postgres)

```
Nested Loop cost ≈ cost_outer + (rows_outer × cost_1_lookup_inner)
Hash Join cost   ≈ cost_build + cost_probe + cost_dựng_hash
Merge Join cost  ≈ cost_sort_a + cost_sort_b + cost_merge
```

Với **Nested Loop**, `rows_outer` đặc biệt quan trọng vì nó quyết định số lượt chạy phía inner. Nếu optimizer ước tính chỉ có 5 dòng outer nhưng thực tế là 5 triệu, một plan Nested Loop trông có vẻ rẻ có thể phải tra inner nhiều hơn dự kiến. Với **Hash Join**, hãy để ý kích thước bảng băm; với **Merge Join**, hãy để ý có cần `Sort` hay không. Xem thêm [Statistics & Query Planner](/optimization/statistics-query-planner-deep-dive/).

### 8.2. Ví dụ đoán sai statistics

```text
->  Nested Loop  (cost=... rows=5 ...) (actual ... rows=5000000 ...)
                              ▲                          ▲
                        optimizer đoán 5           thực tế 5 triệu
```

Dòng trên cho thấy PostgreSQL ước tính sai **số dòng đầu ra của phép JOIN**. Muốn biết nó có ước tính sai số lượt tra inner không, hãy so `rows` và `actual rows` ở **node con outer**, rồi xem `loops` ở **node con inner**. Nếu thống kê đã cũ, chạy `ANALYZE` trên bảng liên quan có thể giúp; sai lệch lớn không tự nó chứng minh thống kê đã cũ.

---

## 9. Driving Table & Join Order — Ai chạy trước quyết định tất cả

### 9.1. Driving table là gì

Khi join nhiều bảng, DB phải chọn **thứ tự** ghép. Bảng được xử lý đầu tiên gọi là **driving table** (bảng dẫn). Nguyên tắc vàng:

> [!TIP]
> **Bảng có ít row nhất sau khi lọc nên làm driving table.** Lọc sớm để giảm số row càng nhiều càng tốt trước khi join sang bảng lớn — đây gọi là "lọc trước, join sau".

### 9.2. Ví dụ 3 bảng

```sql
SELECT *
FROM customers c
JOIN orders o    ON o.customer_id = c.id
JOIN products p  ON p.id = o.product_id
WHERE c.country = 'Vietnam'         -- lọc còn 50 row
  AND p.category = 'Electronics';   -- lọc còn 200 row
```

Thứ tự tốt: bắt đầu từ `customers` (50 row sau lọc) → join `orders` → cuối cùng `products`. Bắt đầu từ `orders` (50 triệu row) sẽ là thảm họa.

### 9.3. Số lượng join order bùng nổ

Với N bảng, số thứ tự join khả thi là **N!** (giai thừa):

| Số bảng | Số join order |
|---------|--------------|
| 3 | 6 |
| 5 | 120 |
| 10 | 3,628,800 |

Vì thế optimizer có giới hạn (Postgres: `join_collapse_limit`, `geqo_threshold`). Vượt ngưỡng, nó chuyển sang thuật toán di truyền (GEQO) để tìm plan "đủ tốt" thay vì tối ưu tuyệt đối.

---

## 10. Đọc EXPLAIN cho JOIN — Từng dòng một

Plan là **cây**: đọc từ **trong ra ngoài**, từ **dưới lên**. Node con thực thi trước, kết quả đưa lên node cha.

```text
 Hash Join                          ← (3) ghép kết quả 2 node con
   Hash Cond: (o.customer_id = c.id)
   ->  Seq Scan on orders o         ← (1) probe input, chạy trước
   ->  Hash                         ← (2) build input
         ->  Seq Scan on customers c
```

Thứ tự thực thi thật: (1) quét customers dựng hash → (2) → (3) quét orders dò hash.

| Bạn thấy trong EXPLAIN | Nghĩa là |
|------------------------|----------|
| `Nested Loop` + `loops=N` cao | Vòng lặp chạy N lần — coi chừng N lớn |
| `Hash Join` + `Batches > 1` | Hash tràn RAM, đang dùng đĩa |
| `Merge Join` + node `Sort` | Phải sort trước — tốn chi phí |
| `rows=` (est) lệch xa `rows=` (actual) | Statistics sai → dễ chọn nhầm thuật toán |
| `Rows Removed by Filter` cao | Đọc thừa nhiều row rồi vứt |

> [!NOTE]
> Chi tiết cách đọc mọi node và con số trong plan: xem doc [EXPLAIN / EXPLAIN ANALYZE — Deep Dive](/optimization/explain-analyze-deep-dive/).

---

## 11. OUTER JOIN ảnh hưởng thuật toán như thế nào

OUTER JOIN (LEFT/RIGHT/FULL) ràng buộc thứ tự và thuật toán:

- **LEFT JOIN**: bảng trái **bắt buộc** là bên "giữ tất cả row" → optimizer không được tự do đảo thứ tự như INNER JOIN. Điều này giới hạn không gian tối ưu.
- **FULL OUTER JOIN**: chỉ **Hash Join** và **Merge Join** hỗ trợ; **Nested Loop không** làm được FULL (vì phải giữ dấu row chưa khớp ở cả hai bên). Postgres sẽ luôn dùng Hash/Merge cho FULL.
- **Anti/Semi join** (dưới đây) có thuật toán riêng.

> [!TIP]
> INNER JOIN cho optimizer nhiều tự do đảo thứ tự nhất → thường tối ưu tốt hơn. Chỉ dùng OUTER JOIN khi thực sự cần giữ row không khớp; đừng dùng LEFT JOIN "cho chắc" khi INNER là đủ.

---

## 12. Semi Join & Anti Join — EXISTS, IN, NOT EXISTS

Đây là hai loại join "ẩn" mà optimizer sinh ra từ subquery.

### 12.1. Semi Join — "tồn tại ít nhất một khớp"

`EXISTS` và `IN` sinh ra **Semi Join**: chỉ cần **một** row bên phải khớp là giữ row bên trái, và **không nhân bản** row trái (khác INNER JOIN).

```sql
-- Lấy khách có ÍT NHẤT một order
SELECT * FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```

```text
 Hash Semi Join  (actual ... rows=... )
   Hash Cond: (c.id = o.customer_id)
```

Semi Join dừng ngay khi tìm thấy khớp đầu tiên → thường rẻ hơn INNER JOIN + DISTINCT.

### 12.2. Anti Join — "không có khớp nào"

`NOT EXISTS` sinh ra **Anti Join**: giữ row trái khi **không** có row phải nào khớp.

```sql
-- Lấy khách CHƯA từng order
SELECT * FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```

```text
 Hash Anti Join  (actual ... rows=... )
```

> [!IMPORTANT]
> Ưu tiên `NOT EXISTS` hơn `NOT IN` khi cột có thể NULL. `NOT IN` với một giá trị NULL trong danh sách sẽ trả về **rỗng một cách âm thầm** (three-valued logic). `NOT EXISTS` không dính bẫy này. Xem chi tiết trong [Query Optimization Patterns](/optimization/query-optimization-patterns/).

---

## 13. So sánh giữa Postgres / MySQL / Oracle / SQL Server

| Đặc điểm | PostgreSQL | MySQL (8.0+) | Oracle | SQL Server |
|----------|-----------|--------------|--------|------------|
| Nested Loop | ✅ | ✅ | ✅ | ✅ |
| Hash Join | ✅ | ✅ (từ 8.0.18) | ✅ | ✅ |
| Merge Join | ✅ | ❌ (không có) | ✅ | ✅ |
| FULL OUTER JOIN | ✅ | ❌ (giả lập bằng UNION) | ✅ | ✅ |
| Tham số buffer | `work_mem` | `join_buffer_size` | `pga_aggregate_target` | memory grant |
| Join hint | ❌ (chỉ `enable_*` toàn cục) | ✅ (`/*+ ... */`) | ✅ (mạnh nhất) | ✅ (`OPTION`) |
| Xem plan | `EXPLAIN ANALYZE` | `EXPLAIN ANALYZE` / `FORMAT=JSON` | `DBMS_XPLAN` | Execution Plan (SSMS) |

> [!NOTE]
> **MySQL trước 8.0.18 chỉ có Nested Loop** (biến thể Block Nested Loop dùng `join_buffer`). Đây là lý do MySQL cũ join hai bảng lớn không index rất chậm — không có Hash Join để cứu.

---

## 14. Anti-patterns cần tránh

- **Quên điều kiện JOIN → Cross Join vô tình**: `FROM a, b` mà thiếu `WHERE a.id = b.a_id` → bùng nổ M×N row.
- **JOIN rồi mới lọc, thay vì lọc rồi mới JOIN**: đặt điều kiện lọc sớm để giảm driving table.
- **Điều kiện lọc trên cột outer đặt sai vào WHERE của LEFT JOIN**: âm thầm biến LEFT thành INNER.
- **Hàm bọc quanh cột join**: `ON UPPER(a.name) = UPPER(b.name)` → không dùng được index → ép Hash/Nested Loop chậm.
- **JOIN quá nhiều bảng (10+) trong một query**: optimizer quá tải, cân nhắc denormalize hoặc chia nhỏ.
- **Kiểu dữ liệu cột join không khớp**: `a.id BIGINT` join `b.id VARCHAR` → implicit conversion → mất index.

> [!TIP]
> Nếu JOIN chậm bất ngờ, việc đầu tiên: chạy `EXPLAIN ANALYZE` và so `estimated rows` với `actual rows`. Lệch nhiều → `ANALYZE` lại bảng. Đúng thì soi thuật toán và index.

---

## 15. Tóm tắt — Cheat sheet

| Thuật toán | Tình huống nên bắt đầu xem xét |
| --- | --- |
| Nested Loop | Outer nhỏ sau lọc, inner có index phù hợp; lookup OLTP |
| Hash Join | Equality join trên inputs lớn, memory đủ hoặc chấp nhận spill |
| Merge Join | Inputs đã có thứ tự key phù hợp hoặc chi phí sort hợp lý |

- Chọn driving input theo cardinality sau lọc và plan, không chỉ kích thước bảng gốc.
- Đưa predicate hợp lệ xuống sớm khi optimizer có thể làm.
- Giữ kiểu dữ liệu join tương thích; index tùy access path, không bắt buộc cả hai phía.
- Estimated rows lệch actual rows thì kiểm tra statistics và `ANALYZE`.
- INNER JOIN thường cho optimizer nhiều tự do reorder hơn, nhưng không mặc định mọi INNER đều nhanh hơn OUTER.

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|-------------|------------------------|------------|
| Nested Loop với `loops` cực lớn | Optimizer đoán sai outer nhỏ | `ANALYZE`, kiểm tra statistics |
| Hash Join `Batches > 1` | Thiếu RAM cho hash | Tăng `work_mem` / `join_buffer_size` |
| Merge Join có node `Sort` lớn | Không có index để lấy sorted | Tạo index trên cột join |
| Query nhanh dần rồi chậm | Statistics lỗi thời sau khi data lớn lên | Lịch `ANALYZE`/autovacuum |
| JOIN trả nhiều row hơn mong đợi | Thiếu điều kiện join → cross | Kiểm tra `ON` đầy đủ |

---

## Tài liệu tham khảo

- [PostgreSQL — Join Methods](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [Use The Index, Luke — Joins](https://use-the-index-luke.com/sql/join)
- [EXPLAIN / EXPLAIN ANALYZE — Deep Dive](/optimization/explain-analyze-deep-dive/)
- [Statistics & Query Planner — Deep Dive](/optimization/statistics-query-planner-deep-dive/)
- [Query Optimization Patterns](/optimization/query-optimization-patterns/)
