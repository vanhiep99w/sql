---
title: "B+Tree hoạt động như thế nào?"
description: "Giải thích B+Tree theo trình tự đơn giản: tìm kiếm, range scan, page split, xóa, cập nhật và cách index trỏ tới row thật."
---

<Callout type="info" title="Cách đọc tài liệu này">
  Các phần được sắp xếp từ cơ bản đến nâng cao và tiếp tục dùng cùng một ví dụ với bảng `users`.
</Callout>

## Mục lục

- [Vấn đề khi không có index](#vấn-đề-khi-không-có-index)
- [Toàn cảnh B Plus Tree](#toàn-cảnh-b-plus-tree)
- [Root internal và leaf](#root-internal-và-leaf)
  - [Root và internal node giữ gì](#root-và-internal-node-giữ-gì)
  - [Leaf node giữ gì](#leaf-node-giữ-gì)
- [Tìm một giá trị cụ thể](#tìm-một-giá-trị-cụ-thể)
- [Vì sao cây luôn thấp](#vì-sao-cây-luôn-thấp)
- [Quét dữ liệu theo khoảng](#quét-dữ-liệu-theo-khoảng)
- [Chèn dữ liệu khi page còn chỗ](#chèn-dữ-liệu-khi-page-còn-chỗ)
- [Chia page khi page đã đầy](#chia-page-khi-page-đã-đầy)
- [Xóa và cập nhật dữ liệu](#xóa-và-cập-nhật-dữ-liệu)
  - [Khi xóa một row](#khi-xóa-một-row)
  - [Khi cập nhật indexed key](#khi-cập-nhật-indexed-key)
- [Đi từ index tới row thật](#đi-từ-index-tới-row-thật)
  - [PostgreSQL lưu row locator như thế nào](#postgresql-lưu-row-locator-như-thế-nào)
  - [MySQL InnoDB lưu row locator như thế nào](#mysql-innodb-lưu-row-locator-như-thế-nào)
- [Composite index](#composite-index)
- [Khi nào B Plus Tree không hiệu quả](#khi-nào-b-plus-tree-không-hiệu-quả)
  - [Trường hợp query trả quá nhiều row](#trường-hợp-query-trả-quá-nhiều-row)
  - [Trường hợp không có điểm bắt đầu rõ ràng](#trường-hợp-không-có-điểm-bắt-đầu-rõ-ràng)
  - [Trường hợp key quá rộng](#trường-hợp-key-quá-rộng)
  - [Trường hợp có quá nhiều index](#trường-hợp-có-quá-nhiều-index)
- [Theo dõi B Plus Tree bằng EXPLAIN](#theo-dõi-b-plus-tree-bằng-explain)
  - [Đọc plan PostgreSQL](#đọc-plan-postgresql)
  - [Đọc plan MySQL](#đọc-plan-mysql)
- [Các câu hỏi thường gặp](#các-câu-hỏi-thường-gặp)
- [Tóm tắt bằng một ví dụ hoàn chỉnh](#tóm-tắt-bằng-một-ví-dụ-hoàn-chỉnh)

## Vấn đề khi không có index

Giả sử bảng `users` có một triệu row:

```sql
CREATE TABLE users (
    id         BIGINT PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    email      VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL
);
```

Ta cần tìm user có `id = 42`:

```sql
SELECT *
FROM users
WHERE id = 42;
```

Nếu không có index phù hợp, database có thể phải kiểm tra lần lượt rất nhiều row:

```text
Row 1  → không phải 42
Row 2  → không phải 42
Row 3  → không phải 42
...
Row 42 → tìm thấy
...
```

Cách đọc lần lượt như vậy gọi là **table scan** hoặc **sequential scan**. Nếu row cần tìm nằm gần cuối bảng, database có thể phải đọc gần như toàn bộ bảng.

B+Tree giải quyết vấn đề bằng cách tạo một đường đi ngắn tới vùng chứa `42`:

```text
Không có index: đọc nhiều row để tìm 42
Có B+Tree:      chọn đúng nhánh → tới đúng page → tìm 42
```

Hãy hình dung B+Tree giống mục lục của một cuốn sách. Ta không đọc từ trang đầu để tìm chương 8. Ta mở mục lục, tìm vị trí của chương 8 rồi đi thẳng tới trang đó.

<Callout type="idea" title="Ý chính">
  B+Tree không làm dữ liệu biến mất. Nó giúp database biết nên bắt đầu đọc ở đâu.
</Callout>

## Toàn cảnh B Plus Tree

B+Tree là một cây có nhiều nhánh. Các giá trị trong cây luôn được sắp xếp.

Ta dùng cây nhỏ sau trong các phần tiếp theo:

```text
                         Root
                      [ 30 | 60 ]
                     /      |      \
                    /       |       \
                   ▼        ▼        ▼
               Leaf A     Leaf B     Leaf C
[5, 10, 20] ⇄ [30, 42, 55] ⇄ [60, 75, 90]
```

Cây này có hai tầng:

1. Tầng trên là `Root`.
2. Tầng dưới gồm ba `Leaf`.

Root chia dữ liệu thành ba khoảng:

| Nhánh | Khoảng giá trị |
| --- | --- |
| Nhánh trái | Nhỏ hơn `30` |
| Nhánh giữa | Từ `30` đến nhỏ hơn `60` |
| Nhánh phải | Từ `60` trở lên |

Các leaf cũng được nối với nhau:

```text
Leaf A ⇄ Leaf B ⇄ Leaf C
```

Nhờ liên kết này, database có thể đọc một khoảng giá trị liên tục mà không cần quay lại root.

Tên **B+Tree** dễ gây hiểu lầm. Chữ `B` không có nghĩa là binary. Một node không chỉ có hai nhánh. Trong database thực tế, một node có thể có hàng trăm nhánh.

<Callout type="idea" title="Ý chính">
  Root chọn khoảng cần tìm. Leaf giữ các giá trị đã sắp xếp. Các leaf nối với nhau để hỗ trợ range scan.
</Callout>

## Root internal và leaf

B+Tree có ba loại node. Với cây nhỏ, đôi khi không cần internal node ở giữa.

| Loại node | Công việc chính |
| --- | --- |
| Root node | Điểm bắt đầu của mọi lần tìm kiếm |
| Internal node | Chọn nhánh tiếp theo khi cây có nhiều tầng |
| Leaf node | Giữ index entry và thông tin để tìm row |

**Node** trong sơ đồ thường tương ứng với một **page** trong database. Page là khối dữ liệu mà database đọc từ ổ đĩa vào memory.

Ví dụ, PostgreSQL thường dùng page 8 KiB. InnoDB thường dùng page 16 KiB theo cấu hình mặc định.

### Root và internal node giữ gì

Root và internal node chủ yếu giữ:

- Giá trị dùng để chia khoảng.
- Con trỏ tới node con.

Ví dụ:

```text
[ 30 | 60 ]

key < 30       → đi sang trái
30 ≤ key < 60  → đi vào giữa
key ≥ 60       → đi sang phải
```

Root không cần chứa toàn bộ row của user. Nó chỉ cần đủ thông tin để chọn đúng đường.

### Leaf node giữ gì

Leaf giữ **index entry**. Một entry thường gồm:

```text
indexed key + thông tin để tìm row thật
```

Ví dụ đơn giản:

```text
42 → vị trí của row có id = 42
```

Thông tin bên phải có thể là địa chỉ row hoặc primary key. Cách lưu cụ thể phụ thuộc database. Phần “Đi từ index tới row thật” sẽ giải thích kỹ hơn.

<Callout type="info" title="Một cách nhớ đơn giản">
  Root và internal node giống biển chỉ đường. Leaf giống mục lục có số trang cụ thể.
</Callout>

## Tìm một giá trị cụ thể

Ta chạy lại query:

```sql
SELECT *
FROM users
WHERE id = 42;
```

Cây hiện tại:

```text
                         Root
                      [ 30 | 60 ]
                     /      |      \
                    /       |       \
                   ▼        ▼        ▼
              [5,10,20] [30,42,55] [60,75,90]
```

Database tìm `42` theo từng bước.

**Đọc root**

Database so sánh `42` với `30` và `60`:

```text
42 ≥ 30
42 < 60
```

Vậy `42` nằm trong nhánh giữa.

**Đi tới leaf ở giữa**

Leaf giữa chứa:

```text
[30, 42, 55]
```

Database tìm thấy entry `42` trong leaf này.

**Lấy thông tin về row**

Entry `42` cho database biết cách đi tới row thật:

```text
42 → row locator → row của user 42
```

Toàn bộ đường đi:

```text
Root [30 | 60]
        │
        │ chọn khoảng 30 ≤ key < 60
        ▼
Leaf [30, 42, 55]
          │
          │ tìm thấy 42
          ▼
Row của user 42
```

Nếu cây có thêm internal node, database chỉ lặp lại bước “so sánh rồi chọn nhánh” thêm vài lần.

<Callout type="idea" title="Ý chính">
  Exact lookup gồm ba việc: chọn nhánh, tìm entry trong leaf, rồi lấy row thật.
</Callout>

## Vì sao cây luôn thấp

Một binary tree chỉ có tối đa hai nhánh ở mỗi node. B+Tree có thể có hàng trăm nhánh.

Số nhánh của một node gọi là **fanout**.

Giả sử mỗi internal page trỏ được tới `300` page con. Mỗi leaf giữ được `250` entry.

Một cây có ba tầng dữ liệu có thể quản lý gần đúng:

```text
300 × 300 × 250 = 22.500.000 entries
```

Đây chỉ là ví dụ để tạo trực giác. Số thật phụ thuộc:

- Kích thước page.
- Độ rộng của key.
- Metadata của database.
- Page đang đầy bao nhiêu phần trăm.

Điều quan trọng là: một bảng có hàng triệu row không tạo ra một cây có hàng triệu tầng. Cây thường chỉ cao vài tầng.

B+Tree còn luôn giữ các leaf ở cùng độ sâu:

```text
Đúng:
Root → Internal → Leaf
Root → Internal → Leaf
Root → Internal → Leaf

Không đúng:
Root → Leaf
Root → Internal → Internal → Leaf
```

Tính chất này gọi là **cân bằng**. Vì cây cân bằng, mọi lookup đi qua số tầng gần như giống nhau.

Ta thường nói lookup có độ phức tạp `O(log N)`. Trong thực tế, điều cần quan tâm hơn là số page phải đọc. Nếu root và internal page đã nằm trong cache, database có thể chỉ cần đọc leaf và data page.

<Callout type="idea" title="Ý chính">
  B+Tree nhanh vì một page chứa nhiều đường đi. Fanout lớn giúp cây chỉ cao vài tầng.
</Callout>

## Quét dữ liệu theo khoảng

B+Tree không chỉ nhanh với dấu bằng. Nó còn rất phù hợp với các điều kiện khoảng:

```sql
SELECT *
FROM users
WHERE id BETWEEN 35 AND 75;
```

Database thực hiện hai giai đoạn.

**Giai đoạn 1 — Tìm điểm bắt đầu**

Database đi từ root tới leaf có giá trị đầu tiên lớn hơn hoặc bằng `35`.

Với dữ liệu mẫu, giá trị đầu tiên phù hợp là `42`:

```text
Leaf B: [30, 42, 55]
             ▲
             bắt đầu tại đây
```

**Giai đoạn 2 — Đi dọc các leaf**

Database đọc tiếp các entry theo thứ tự:

```text
Leaf B              Leaf C
[30, 42, 55]   ⇄   [60, 75, 90]
     └──┬──┘       └──┬──┘
      42, 55        60, 75
```

Khi gặp `90`, database biết đã vượt quá giới hạn `75` và dừng.

Kết quả là:

```text
42, 55, 60, 75
```

Database chỉ đi từ root xuống một lần. Sau đó nó đi ngang qua các leaf liền kề.

Cơ chế tương tự giúp `ORDER BY` và `LIMIT` chạy nhanh khi thứ tự index phù hợp:

```sql
CREATE INDEX idx_users_created_at
ON users (created_at DESC);

SELECT *
FROM users
ORDER BY created_at DESC
LIMIT 10;
```

Database có thể đọc 10 entry đầu tiên của index rồi dừng. Nó không nhất thiết phải lấy toàn bộ bảng ra để sort.

<Callout type="idea" title="Ý chính">
  Range scan gồm một lần tìm điểm bắt đầu, sau đó đọc các leaf liên tiếp cho tới điểm dừng.
</Callout>

## Chèn dữ liệu khi page còn chỗ

Giả sử leaf đang chứa:

```text
[30, 42, 55]
```

Ta chèn user có `id = 47`:

```sql
INSERT INTO users (id, name, email, created_at)
VALUES (47, 'An', 'an@example.com', CURRENT_TIMESTAMP);
```

Database thực hiện các bước:

1. Đi từ root tới leaf chứa khoảng của `47`.
2. Tìm vị trí đúng giữa `42` và `55`.
3. Thêm entry `47` vào leaf.
4. Giữ các entry theo đúng thứ tự.

Kết quả:

```text
Trước: [30, 42,     55]
Sau:   [30, 42, 47, 55]
```

Nếu page vẫn còn chỗ, thao tác kết thúc tại đây. Cấu trúc cây không thay đổi.

Database còn phải ghi transaction log để phục hồi khi có sự cố. Phần đó không thay đổi ý tưởng chính của việc chèn: **tìm đúng leaf rồi đặt key vào đúng vị trí**.

<Callout type="idea" title="Ý chính">
  Khi leaf còn chỗ, insert chỉ cần tìm leaf và thêm entry theo thứ tự.
</Callout>

## Chia page khi page đã đầy

Bây giờ giả sử mỗi leaf trong ví dụ chỉ giữ tối đa bốn key.

Leaf sau đã đầy:

```text
[30, 42, 45, 55]
```

Ta cần chèn `47`. Leaf không còn chỗ cho entry mới.

Database phải thực hiện **page split**. Page split nghĩa là chia một page thành hai page.

**Trước khi split:**

```text
Parent
  │
  ▼
[30, 42, 45, 55]  ← page đầy
```

**Sau khi thêm `47` và split:**

```text
Parent thêm separator 45
          /       \
         ▼         ▼
   [30, 42]  ⇄  [45, 47, 55]
```

Quá trình gồm các bước:

1. Tạo một leaf mới.
2. Chia các entry sang hai leaf.
3. Nối hai leaf với nhau.
4. Thêm separator vào parent để parent biết đường tới leaf mới.

Trong ví dụ, separator là `45`. Khi tìm key từ `45` trở lên, parent sẽ chọn leaf bên phải.

Nếu parent cũng đầy, parent tiếp tục split. Việc split có thể đi lên nhiều tầng.

Nếu root đầy và phải split, database tạo root mới:

```text
Root cũ đầy
    │
    ▼
Split root cũ thành hai node
    │
    ▼
Tạo root mới trỏ tới hai node đó
```

Đây là cách duy nhất cây cao thêm một tầng.

Page split làm `INSERT` tốn thêm I/O. Tuy nhiên, split không xảy ra ở mọi lần insert. Nó chỉ cần thiết khi page đích không đủ chỗ.

<Callout type="warn" title="Không nên hiểu quá máy móc">
  Database thực tế có chiến lược chọn điểm split riêng. Hai page sau split không bắt buộc luôn đầy đúng 50 phần trăm.
</Callout>

## Xóa và cập nhật dữ liệu

### Khi xóa một row

Giả sử ta xóa user `42`:

```sql
DELETE FROM users
WHERE id = 42;
```

Về mặt logic, entry `42` không còn được dùng:

```text
Trước: [30, 42, 47, 55]
Sau:   [30,     47, 55]
```

Hai page quá thưa có thể được gộp lại. Thao tác này gọi là **page merge**.

Tuy nhiên, database dùng MVCC không nhất thiết xóa vật lý hoặc merge page ngay lập tức. **MVCC** là cơ chế cho phép nhiều transaction nhìn thấy các phiên bản dữ liệu phù hợp với thời điểm của chúng.

Một transaction cũ có thể vẫn cần thấy row vừa bị xóa. Vì vậy, database thường đánh dấu entry, chờ cleanup rồi mới tái sử dụng không gian.

Ví dụ:

- PostgreSQL dùng `VACUUM` để dọn các version không còn cần thiết.
- InnoDB có quá trình purge cho mục đích tương tự.

Do đó, chạy `DELETE` không có nghĩa file index sẽ nhỏ lại ngay.

### Khi cập nhật indexed key

Giả sử có index trên `email`:

```sql
CREATE INDEX idx_users_email
ON users (email);
```

Ta đổi email:

```sql
UPDATE users
SET email = 'new@example.com'
WHERE id = 42;
```

Vị trí của email cũ và email mới trong B+Tree có thể khác nhau. Database không thể luôn sửa nguyên tại vị trí cũ.

Về mặt logic, nó phải:

1. Loại entry của email cũ.
2. Tìm vị trí của email mới.
3. Thêm entry mới vào vị trí đúng.

Đó là lý do nhiều index làm `INSERT`, `UPDATE` và `DELETE` chậm hơn. Mỗi index liên quan đều cần được bảo trì.

<Callout type="idea" title="Ý chính">
  Index tăng tốc đọc nhưng tạo thêm việc khi ghi. Xóa có thể được dọn sau; cập nhật indexed key gần giống xóa key cũ rồi chèn key mới.
</Callout>

## Đi từ index tới row thật

Tìm thấy leaf entry chưa chắc đã có đủ dữ liệu cho câu `SELECT`.

Xét query:

```sql
SELECT id, name, email
FROM users
WHERE email = 'an@example.com';
```

Index trên `email` giúp tìm entry nhanh:

```text
'an@example.com' → thông tin để tìm row
```

Database có thể phải dùng thông tin đó để đọc row thật từ table.

Cách thực hiện khác nhau giữa PostgreSQL và MySQL InnoDB.

### PostgreSQL lưu row locator như thế nào

PostgreSQL thường lưu table theo dạng heap. Leaf của B-tree index giữ key và một **TID**.

TID là địa chỉ của tuple trong heap:

```text
TID = (số block, vị trí item trong block)
```

Đường đi đơn giản:

```text
Index trên email
'an@example.com' → TID (917, 4)
                         │
                         ▼
Heap block 917, item 4 → row của An
```

PostgreSQL thường phải đọc cả index page và heap page.

Nếu index chứa đủ các cột cần trả về, PostgreSQL có thể dùng `Index Only Scan`. Dù vậy, nó đôi khi vẫn cần kiểm tra heap để xác nhận row có visible với transaction hiện tại hay không.

### MySQL InnoDB lưu row locator như thế nào

InnoDB lưu row data tại leaf của primary-key index.

```text
Primary-key B+Tree
42 → toàn bộ row có id = 42
```

Leaf của secondary index thường giữ secondary key và primary key:

```text
Secondary index trên email
'an@example.com' → primary key 42
                         │
                         ▼
Primary-key tree
42 → toàn bộ row
```

Vì vậy, query qua secondary index có thể cần hai lần đi qua B+Tree:

1. Tìm email để lấy primary key.
2. Dùng primary key để lấy row thật.

Nếu secondary index đã chứa đủ cột query cần, lần tìm thứ hai có thể được bỏ qua. Trường hợp đó gọi là **covering index**.

| Database | Leaf của secondary index thường giữ gì |
| --- | --- |
| PostgreSQL | Indexed key và TID trỏ tới heap tuple |
| MySQL InnoDB | Secondary key và primary-key value |
| Oracle | Indexed key và ROWID |
| SQL Server | Row locator phụ thuộc table là heap hay clustered |

<Callout type="idea" title="Ý chính">
  Index entry là điểm bắt đầu. Query vẫn có thể cần thêm một lần đọc để lấy row thật.
</Callout>

## Composite index

**Composite index** là index có nhiều cột:

```sql
CREATE INDEX idx_orders_customer_status_created
ON orders (customer_id, status, created_at);
```

Đây là một B+Tree duy nhất. Mỗi key là một tuple:

```text
(customer_id, status, created_at)
```

Database sắp tuple từ trái sang phải, giống cách sắp từ trong từ điển.

Ví dụ:

```text
(10, 'paid',    '2026-01-01')
(10, 'paid',    '2026-01-02')
(10, 'pending', '2025-12-30')
(11, 'paid',    '2024-01-01')
```

Cách so sánh diễn ra từng bước:

1. So `customer_id` trước.
2. Nếu `customer_id` bằng nhau, so `status`.
3. Nếu cả hai bằng nhau, so `created_at`.

Vì vậy, index trên hỗ trợ tốt query sau:

```sql
WHERE customer_id = 10;
```

Nó cũng hỗ trợ tốt:

```sql
WHERE customer_id = 10
  AND status = 'paid';
```

Và:

```sql
WHERE customer_id = 10
  AND status = 'paid'
  AND created_at >= '2026-01-01';
```

Nhưng nếu query chỉ có:

```sql
WHERE status = 'paid';
```

Các entry `paid` nằm rải trong từng nhóm customer:

```text
customer 10: cancelled, paid, pending
customer 11: cancelled, paid, pending
customer 12: cancelled, paid, pending
```

Database không có một điểm bắt đầu duy nhất cho toàn bộ giá trị `paid`. Đây là lý do xuất hiện **leftmost prefix rule**.

Cách nhớ đơn giản:

```text
Index (a, b, c)

Dễ dùng: a
Dễ dùng: a + b
Dễ dùng: a + b + c
Khó dùng trực tiếp: b
Khó dùng trực tiếp: c
```

Một số database có thể dùng skip scan trong vài trường hợp. Tuy nhiên, không nên dựa vào ngoại lệ này khi thiết kế index chính.

<Callout type="idea" title="Ý chính">
  Composite index sắp cả tuple từ trái sang phải. Muốn tìm nhanh, query thường phải bắt đầu từ cột bên trái của index.
</Callout>

## Khi nào B Plus Tree không hiệu quả

Có index không có nghĩa database luôn dùng index.

### Trường hợp query trả quá nhiều row

Giả sử 95 phần trăm user có trạng thái `active`:

```sql
SELECT *
FROM users
WHERE status = 'active';
```

Index có thể tìm điểm bắt đầu của nhóm `active`. Nhưng database vẫn phải đọc gần như toàn bộ nhóm đó và lấy rất nhiều row thật.

Trong trường hợp này, table scan có thể rẻ hơn:

```text
Index scan:
đọc index → lấy nhiều row locator → đọc rất nhiều data page

Table scan:
đọc tuần tự toàn bộ table một lần
```

Optimizer là bộ phận ước lượng chi phí và chọn execution plan. Nếu nó cho rằng index đắt hơn, nó sẽ chọn table scan.

### Trường hợp không có điểm bắt đầu rõ ràng

B+Tree phù hợp khi query tạo được một khoảng liên tục trong thứ tự của index.

Các pattern sau thường khó dùng B+Tree thông thường:

```sql
WHERE name LIKE '%an';
```

Dấu `%` ở đầu khiến database không biết prefix để tìm điểm bắt đầu.

```sql
WHERE LOWER(email) = 'an@example.com';
```

Index trên `email` gốc không tự động có thứ tự theo kết quả của `LOWER(email)`. Ta có thể cần expression index phù hợp.

```sql
WHERE status = 'paid';
```

Query này không dễ dùng index `(customer_id, status)` vì thiếu cột bên trái.

### Trường hợp key quá rộng

Key rộng làm mỗi page chứa ít entry hơn:

```text
Key nhỏ  → nhiều entry trong page → fanout lớn → cây thấp hơn
Key rộng → ít entry trong page    → fanout nhỏ → index lớn hơn
```

Primary key rộng còn đặc biệt đáng chú ý trong InnoDB. Primary-key value được lưu trong mỗi secondary index. Primary key càng rộng, các secondary index càng lớn.

### Trường hợp có quá nhiều index

Mỗi index cần:

- Dung lượng lưu trữ.
- Memory trong buffer pool khi được đọc.
- Cập nhật khi `INSERT`, `UPDATE` hoặc `DELETE`.

Không nên tạo index cho mọi cột. Hãy bắt đầu từ query quan trọng, tạo index phù hợp rồi kiểm tra bằng `EXPLAIN ANALYZE`.

<Callout type="idea" title="Ý chính">
  B+Tree hiệu quả khi query đọc một phần nhỏ, liên tục theo thứ tự index. Nếu query cần phần lớn table, scan tuần tự có thể tốt hơn.
</Callout>

## Theo dõi B Plus Tree bằng EXPLAIN

Ta không cần nhìn trực tiếp từng page để biết index có giúp query hay không. Execution plan cho thấy database định đọc dữ liệu theo cách nào.

### Đọc plan PostgreSQL

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at
FROM orders
WHERE customer_id = 42
  AND created_at >= '2026-01-01'
ORDER BY created_at;
```

Với index `(customer_id, created_at)`, ta có thể thấy:

```text
Index Scan using idx_orders_customer_created on orders
  Index Cond: ((customer_id = 42)
               AND (created_at >= '2026-01-01'))
  Buffers: shared hit=8
```

Hãy đọc theo thứ tự:

1. `Index Scan` cho biết database đang đi qua index.
2. `Index Cond` cho biết điều kiện nào xác định vùng cần đọc trong B+Tree.
3. `Filter` nếu có là điều kiện kiểm tra sau khi đã đọc row.
4. `Rows Removed by Filter` lớn cho thấy database đang đọc nhiều row rồi loại bỏ.
5. `Buffers` cho biết query đã đụng tới bao nhiêu page.

### Đọc plan MySQL

```sql
EXPLAIN ANALYZE
SELECT id, created_at
FROM orders
WHERE customer_id = 42
  AND created_at >= '2026-01-01'
ORDER BY created_at;
```

Trong kết quả `EXPLAIN`, chú ý:

| Trường | Ý nghĩa đơn giản |
| --- | --- |
| `key` | Index được chọn |
| `type` | Cách truy cập như `ref`, `range`, `index` hoặc `ALL` |
| `rows` | Số row database ước lượng phải đọc |
| `Using index` | Index đã chứa đủ dữ liệu query cần |
| `Using filesort` | Database vẫn phải sort riêng |

<Callout type="warn" title="Luôn kiểm tra plan thật">
  Đừng kết luận query nhanh chỉ vì đã tạo index. Hãy chạy `EXPLAIN ANALYZE` trên dữ liệu có phân bố gần với production.
</Callout>

## Các câu hỏi thường gặp

**B+Tree có phải binary tree không?**

Không. Một node B+Tree có thể có hàng trăm nhánh. Đây là lý do cây vẫn thấp khi có hàng triệu row.

**B-Tree và B+Tree khác nhau thế nào?**

Trong B+Tree, dữ liệu hoặc row locator nằm ở leaf. Internal node chủ yếu dùng để điều hướng. Các leaf thường nối với nhau, nên range scan dễ thực hiện.

Nhiều database gọi index của họ là “B-tree index” dù implementation có nhiều đặc điểm của B+Tree. Hãy xem tài liệu của database cụ thể thay vì chỉ dựa vào tên.

**Tại sao leaf phải nối với nhau?**

Sau khi tìm điểm bắt đầu của một range, database có thể đi sang leaf kế tiếp. Nó không cần quay lại root để tìm từng giá trị.

**Một triệu row cần bao nhiêu bước?**

Không nên lấy `log₂(1.000.000)` rồi kết luận cần khoảng 20 lần đọc page. B+Tree không phải cây nhị phân. Vì fanout lớn, cây của một triệu row thường chỉ cao vài tầng.

**Page split có xảy ra ở mọi lần insert không?**

Không. Split chỉ xảy ra khi page đích không còn đủ chỗ.

**DELETE có làm file index nhỏ ngay không?**

Thường là không. MVCC và cleanup khiến việc tái sử dụng hoặc trả lại dung lượng diễn ra sau đó.

**Tại sao optimizer không dùng index của tôi?**

Các lý do phổ biến gồm:

- Query trả quá nhiều row.
- Composite index thiếu điều kiện cho cột bên trái.
- Cột bị bọc trong hàm.
- Kiểu dữ liệu bị cast không phù hợp.
- Statistics chưa phản ánh đúng dữ liệu.
- Chi phí lấy row thật cao hơn table scan.

## Tóm tắt bằng một ví dụ hoàn chỉnh

Hãy ghép toàn bộ quá trình khi chạy:

```sql
SELECT *
FROM users
WHERE id BETWEEN 35 AND 75
ORDER BY id;
```

Cây:

```text
                         Root
                      [ 30 | 60 ]
                     /      |      \
                    /       |       \
                   ▼        ▼        ▼
              [5,10,20] [30,42,55] [60,75,90]
```

Database làm lần lượt:

1. Đọc root.
2. Xác định `35` thuộc nhánh giữa.
3. Đi tới leaf `[30, 42, 55]`.
4. Tìm entry đầu tiên lớn hơn hoặc bằng `35`, tức `42`.
5. Đọc `42` và `55`.
6. Đi qua sibling link sang leaf `[60, 75, 90]`.
7. Đọc `60` và `75`.
8. Gặp `90`, lớn hơn giới hạn `75`, nên dừng.
9. Dùng row locator để lấy các row thật nếu index chưa chứa đủ dữ liệu.
10. Trả kết quả `42, 55, 60, 75` theo đúng thứ tự.

Đó là toàn bộ ý tưởng cốt lõi của B+Tree:

```text
Chọn đúng nhánh
      ↓
Tìm đúng leaf
      ↓
Đọc entry theo thứ tự
      ↓
Đi ngang qua leaf khi cần range
      ↓
Lấy row thật
```

<Cards>
  <Card title="Index SQL" href="/optimization/index-sql-deep-dive/" description="Tìm hiểu selectivity, covering index và các loại index phổ biến." />
  <Card title="Composite Index" href="/optimization/composite-index-deep-dive/" description="Hiểu kỹ thứ tự cột và leftmost prefix rule." />
  <Card title="EXPLAIN ANALYZE" href="/optimization/explain-analyze-deep-dive/" description="Đọc execution plan và kiểm tra số page thực tế." />
</Cards>
