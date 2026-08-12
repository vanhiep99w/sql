---
title: "Clustered và Nonclustered Index"
description: "Giải thích mối quan hệ giữa clustered, nonclustered, B+Tree, composite index và hành vi mặc định của SQL Server, MySQL InnoDB, PostgreSQL."
---

<Callout type="info" title="Mục tiêu">
  Sau tài liệu này, bạn sẽ biết vì sao `CREATE INDEX` thường tạo nonclustered index, vì sao bạn không cần tự tạo clustered index trong nhiều hệ quản trị, và vì sao một index có thể đồng thời là clustered, B+Tree, composite và unique.
</Callout>

## Mục lục

- [Vấn đề nằm ở cách phân loại](#vấn-đề-nằm-ở-cách-phân-loại)
  - [Trục quan hệ với dữ liệu](#trục-quan-hệ-với-dữ-liệu)
  - [Trục cấu trúc dữ liệu](#trục-cấu-trúc-dữ-liệu)
  - [Trục số lượng cột](#trục-số-lượng-cột)
  - [Trục thuộc tính và phạm vi](#trục-thuộc-tính-và-phạm-vi)
- [Mô hình clustered index](#mô-hình-clustered-index)
  - [Leaf page chứa gì](#leaf-page-chứa-gì)
  - [Tại sao mỗi bảng chỉ có một clustered index](#tại-sao-mỗi-bảng-chỉ-có-một-clustered-index)
  - [Clustered không có nghĩa file luôn liền mạch](#clustered-không-có-nghĩa-file-luôn-liền-mạch)
- [Mô hình nonclustered index](#mô-hình-nonclustered-index)
  - [Row locator là gì](#row-locator-là-gì)
  - [Lookup về bảng gốc](#lookup-về-bảng-gốc)
  - [Covering index tránh lookup](#covering-index-tránh-lookup)
- [SQL Server hoạt động thế nào](#sql-server-hoạt-động-thế-nào)
  - [CREATE INDEX mặc định là nonclustered](#create-index-mặc-định-là-nonclustered)
  - [Primary key thường tạo clustered index](#primary-key-thường-tạo-clustered-index)
  - [Bảng không có clustered index là heap](#bảng-không-có-clustered-index-là-heap)
  - [Row locator trong SQL Server](#row-locator-trong-sql-server)
  - [Tự chọn clustered key khác primary key](#tự-chọn-clustered-key-khác-primary-key)
- [MySQL InnoDB hoạt động thế nào](#mysql-innodb-hoạt-động-thế-nào)
  - [Primary key là clustered index](#primary-key-là-clustered-index)
  - [Secondary index lưu primary key](#secondary-index-lưu-primary-key)
  - [Khi bảng không có primary key](#khi-bảng-không-có-primary-key)
- [PostgreSQL hoạt động thế nào](#postgresql-hoạt-động-thế-nào)
  - [Index và heap là hai cấu trúc riêng](#index-và-heap-là-hai-cấu-trúc-riêng)
  - [Lệnh CLUSTER không được duy trì liên tục](#lệnh-cluster-không-được-duy-trì-liên-tục)
- [So sánh nhanh giữa các hệ quản trị](#so-sánh-nhanh-giữa-các-hệ-quản-trị)
- [Quan hệ với B plus Tree và composite index](#quan-hệ-với-b-plus-tree-và-composite-index)
  - [Một index có nhiều nhãn cùng lúc](#một-index-có-nhiều-nhãn-cùng-lúc)
  - [Ví dụ phân loại hoàn chỉnh](#ví-dụ-phân-loại-hoàn-chỉnh)
- [Cách chọn clustered key](#cách-chọn-clustered-key)
  - [Hẹp](#hẹp)
  - [Ổn định](#ổn-định)
  - [Tăng dần thường có lợi](#tăng-dần-thường-có-lợi)
  - [Đủ duy nhất](#đủ-duy-nhất)
  - [Phù hợp truy vấn quan trọng](#phù-hợp-truy-vấn-quan-trọng)
- [Khi nào clustered index có lợi](#khi-nào-clustered-index-có-lợi)
- [Khi nào nonclustered index có lợi](#khi-nào-nonclustered-index-có-lợi)
- [Cách kiểm tra index hiện tại](#cách-kiểm-tra-index-hiện-tại)
  - [Kiểm tra trên SQL Server](#kiểm-tra-trên-sql-server)
  - [Kiểm tra trên MySQL](#kiểm-tra-trên-mysql)
  - [Kiểm tra trên PostgreSQL](#kiểm-tra-trên-postgresql)
- [Các hiểu lầm thường gặp](#các-hiểu-lầm-thường-gặp)
- [Quy trình thiết kế thực tế](#quy-trình-thiết-kế-thực-tế)
- [Tóm tắt](#tóm-tắt)

## Vấn đề nằm ở cách phân loại

`Clustered`, `nonclustered`, `B+Tree` và `composite` không phải bốn lựa chọn loại trừ nhau. Chúng trả lời các câu hỏi khác nhau về cùng một index.

Hãy phân loại index theo bốn trục:

```text
Một index
│
├── Quan hệ với row data
│   ├── Clustered
│   └── Nonclustered hoặc secondary
│
├── Cấu trúc dữ liệu
│   ├── B+Tree
│   ├── Hash
│   ├── GIN, GiST, BRIN
│   └── Cấu trúc khác
│
├── Số cột trong key
│   ├── Single-column
│   └── Composite
│
└── Thuộc tính và phạm vi
    ├── Unique hoặc non-unique
    ├── Covering
    ├── Filtered hoặc partial
    └── Function hoặc expression
```

### Trục quan hệ với dữ liệu

Trục này hỏi:

> Leaf page của index liên hệ với row thật như thế nào?

- Với clustered index, leaf level chính là nơi chứa row data của bảng.
- Với nonclustered index, leaf level là một cấu trúc riêng. Nó chứa index key và thông tin để tìm row thật.

### Trục cấu trúc dữ liệu

Trục này hỏi:

> Database tổ chức index bằng thuật toán và cấu trúc nào?

B+Tree là cấu trúc phổ biến nhất cho index tổng quát vì nó hỗ trợ tốt:

- So sánh bằng `=`.
- So sánh khoảng `<`, `>`, `BETWEEN`.
- Prefix như `LIKE 'abc%'` trong điều kiện phù hợp.
- `ORDER BY`.
- Đọc tuần tự một khoảng key.

Cả clustered index lẫn nonclustered index đều có thể dùng cấu trúc B+Tree.

### Trục số lượng cột

Trục này hỏi:

> Index key gồm một hay nhiều cột?

```sql
-- Single-column index
CREATE INDEX idx_users_email
ON users (email);

-- Composite index
CREATE INDEX idx_orders_customer_date
ON orders (customer_id, created_at);
```

Composite chỉ có nghĩa là key gồm nhiều cột. Nó không tự nói index là clustered hay nonclustered.

### Trục thuộc tính và phạm vi

Một index còn có thể mang các thuộc tính khác:

- `UNIQUE`: không cho phép trùng key.
- Covering: chứa đủ cột mà query cần đọc.
- Filtered hoặc partial: chỉ index một phần row.
- Expression: index kết quả của biểu thức như `LOWER(email)`.

<Callout type="idea" title="Cách nhớ quan trọng nhất">
  `Clustered` nói về quan hệ với row data. `B+Tree` nói về cấu trúc. `Composite` nói về số cột. `Unique` nói về ràng buộc. Một index có thể mang tất cả các nhãn này cùng lúc.
</Callout>

## Mô hình clustered index

Clustered index tổ chức row data của bảng tại leaf level theo clustered key.

Ví dụ một bảng được cluster theo `id`:

```text
                         Root page
                      [ 100 | 200 ]
                     /      |      \
                    ▼       ▼       ▼
               Internal pages nếu cây lớn
                    │       │
                    ▼       ▼

Leaf level cũng là data pages:

[ id=1, toàn bộ row ] ⇄ [ id=2, toàn bộ row ] ⇄ ... ⇄ [ id=300, toàn bộ row ]
```

Khi tìm `id = 200`, database đi qua B+Tree và tới thẳng row data ở leaf. Không cần một cấu trúc bảng khác để lấy row đó.

### Leaf page chứa gì

Trong clustered index, leaf page chứa toàn bộ các cột của row:

```text
Clustered leaf entry
┌──────────────────────────────────────────────────────────┐
│ id = 42                                                  │
│ customer_id = 7                                          │
│ status = 'paid'                                          │
│ created_at = '2026-02-10 09:30:00'                       │
│ total = 950000                                           │
└──────────────────────────────────────────────────────────┘
```

Các tầng root và internal không cần chứa toàn bộ row. Chúng chủ yếu chứa separator key và con trỏ tới page con.

### Tại sao mỗi bảng chỉ có một clustered index

Row data chỉ có thể nằm ở leaf level của một cấu trúc tổ chức chính.

Nếu bảng đã cluster theo `id`, row được nhóm theo thứ tự logic của `id`:

```text
1, 2, 3, 4, 5, ...
```

Nó không thể đồng thời được tổ chức toàn bộ theo `email`:

```text
a@example.com, b@example.com, c@example.com, ...
```

Vì vậy, một bảng chỉ có tối đa một clustered index theo mô hình của SQL Server và InnoDB.

### Clustered không có nghĩa file luôn liền mạch

Cụm từ “dữ liệu được sắp xếp vật lý” dễ gây hiểu lầm.

Điều được đảm bảo chủ yếu là **thứ tự logic ở leaf level**. Các page được liên kết theo thứ tự key. Sau nhiều lần insert, update và page split, các page không nhất thiết nằm cạnh nhau trong file hoặc trên thiết bị lưu trữ.

```text
Thứ tự logic:
Page 8  → Page 31 → Page 14 → Page 52
key 1-9   key 10-19 key 20-29  key 30-39

Vị trí trong file không nhất thiết:
Page 8  → Page 9 → Page 10 → Page 11
```

Hiện tượng page theo thứ tự logic nhưng phân tán về vị trí gọi là **fragmentation**. Do đó, đừng hiểu clustered index là “toàn bộ file luôn được xếp lại hoàn hảo sau mỗi lần ghi”.

## Mô hình nonclustered index

Nonclustered index là một B+Tree tách khỏi nơi chứa row data.

Ví dụ index trên `email`:

```text
Nonclustered B+Tree trên email

'a@example.com' → row locator
'b@example.com' → row locator
'c@example.com' → row locator
                         │
                         ▼
                 Nơi chứa row thật
```

Leaf entry thường chứa:

```text
nonclustered key + row locator + included columns nếu có
```

### Row locator là gì

**Row locator** là thông tin giúp database đi từ leaf của nonclustered index tới row thật.

Nó phụ thuộc vào hệ quản trị và cách bảng được lưu:

| Hệ quản trị hoặc kiểu bảng | Row locator thường là gì |
| --- | --- |
| SQL Server, bảng là heap | RID gồm file, page và slot |
| SQL Server, bảng có clustered index | Clustered key |
| MySQL InnoDB secondary index | Primary-key value |
| PostgreSQL B-tree index | TID trỏ tới heap tuple |
| Oracle B-tree index | ROWID |

### Lookup về bảng gốc

Xét query:

```sql
SELECT name, address
FROM users
WHERE email = 'an@example.com';
```

Giả sử nonclustered index chỉ có `email`:

```sql
CREATE INDEX idx_users_email
ON users (email);
```

Database thực hiện:

```text
Bước 1: tìm 'an@example.com' trong idx_users_email
                         │
                         ▼
Bước 2: lấy row locator
                         │
                         ▼
Bước 3: đọc row thật để lấy name và address
```

Trên SQL Server, bước 3 có thể xuất hiện trong execution plan dưới tên:

- `Key Lookup` nếu bảng có clustered index.
- `RID Lookup` nếu bảng là heap.

Một lookup không nhất thiết đáng lo. Vấn đề xuất hiện khi query trả hàng chục nghìn row và phải lookup lặp lại rất nhiều lần.

### Covering index tránh lookup

Nếu index đã chứa đủ dữ liệu query cần, database có thể trả kết quả ngay từ index.

Ví dụ trên SQL Server hoặc PostgreSQL:

```sql
CREATE INDEX idx_users_email_cover
ON users (email)
INCLUDE (name, address);
```

Leaf lúc này có thể được hình dung như sau:

```text
email            row locator    included data
---------------  -------------  -------------------------
an@example.com   ...            name='An', address='HCM'
```

Query không cần quay về bảng gốc để lấy `name` và `address`.

<Callout type="warn" title="Covering phụ thuộc query">
  Covering không phải một loại cấu trúc cố định. Cùng một index có thể cover query A nhưng không cover query B nếu query B cần thêm cột khác.
</Callout>

## SQL Server hoạt động thế nào

SQL Server là hệ quản trị sử dụng thuật ngữ `CLUSTERED` và `NONCLUSTERED` rõ nhất trong cú pháp DDL.

### CREATE INDEX mặc định là nonclustered

Lệnh sau mặc định tạo nonclustered index:

```sql
CREATE INDEX idx_users_email
ON dbo.users (email);
```

Có thể viết rõ ràng hơn:

```sql
CREATE NONCLUSTERED INDEX idx_users_email
ON dbo.users (email);
```

Vì vậy, nếu bạn chỉ nói tới những index được tạo bằng cú pháp `CREATE INDEX` thông thường trên SQL Server, chúng thường là nonclustered index.

### Primary key thường tạo clustered index

Bạn có thể chưa từng viết `CREATE CLUSTERED INDEX`, nhưng clustered index đã được tạo gián tiếp khi khai báo primary key:

```sql
CREATE TABLE dbo.users (
    id    BIGINT       NOT NULL PRIMARY KEY,
    email VARCHAR(255) NOT NULL
);
```

Trong trường hợp thông thường, SQL Server tạo unique clustered index để thực thi primary key.

Mô hình bảng trở thành:

```text
PK_users
└── UNIQUE CLUSTERED INDEX trên id

idx_users_email
└── NONCLUSTERED INDEX trên email
```

Primary key và clustered index vẫn là hai khái niệm khác nhau:

- Primary key là ràng buộc logic: định danh duy nhất và không null.
- Clustered index là cách tổ chức row data.

SQL Server thường ghép hai vai trò này, nhưng không bắt buộc.

<Callout type="warn" title="Khai báo rõ khi schema không theo mặc định">
  Nếu bảng đã có clustered index khác, hoặc bạn không muốn primary key làm clustered key, hãy khai báo `PRIMARY KEY NONCLUSTERED` rõ ràng. Đừng dựa vào suy đoán về mặc định trong migration phức tạp.
</Callout>

### Bảng không có clustered index là heap

Một bảng SQL Server không có clustered index được gọi là **heap**.

```sql
CREATE TABLE dbo.event_logs (
    event_id  BIGINT        NOT NULL,
    event_type VARCHAR(50)  NOT NULL,
    payload   VARCHAR(MAX)  NULL
);
```

Nếu chưa tạo clustered index, row nằm trong heap. Heap không có B+Tree chính tổ chức toàn bộ row theo một key.

Bạn vẫn có thể tạo nonclustered index trên heap:

```sql
CREATE NONCLUSTERED INDEX idx_event_logs_type
ON dbo.event_logs (event_type);
```

Leaf của index này dùng RID để tìm row trong heap.

### Row locator trong SQL Server

Có hai trường hợp chính.

**Trường hợp một — base table là heap:**

```text
Nonclustered index leaf
'paid' → RID (file_id, page_id, slot_id)
                    │
                    ▼
              Row trong heap
```

**Trường hợp hai — base table có clustered index:**

```text
Nonclustered index leaf
'paid' → clustered key id=42
                    │
                    ▼
Clustered B+Tree trên id
42 → toàn bộ row
```

Đây là lý do clustered key quá rộng làm các nonclustered index lớn hơn. Giá trị clustered key phải xuất hiện như row locator trong các nonclustered index.

### Tự chọn clustered key khác primary key

Bạn có thể để primary key là nonclustered và tạo clustered index trên cột khác:

```sql
CREATE TABLE dbo.orders (
    id          BIGINT       NOT NULL,
    customer_id BIGINT       NOT NULL,
    created_at  DATETIME2    NOT NULL,
    status      VARCHAR(30)  NOT NULL,

    CONSTRAINT pk_orders
        PRIMARY KEY NONCLUSTERED (id)
);

CREATE CLUSTERED INDEX cx_orders_created_id
ON dbo.orders (created_at, id);
```

Thiết kế này có thể phù hợp nếu workload chủ yếu đọc dữ liệu theo khoảng thời gian:

```sql
SELECT *
FROM dbo.orders
WHERE created_at >= '2026-02-01'
  AND created_at <  '2026-03-01';
```

Tuy nhiên, clustered key `(created_at, id)` rộng hơn `id`. Nó cũng được mang vào các nonclustered index làm row locator. Vì vậy, quyết định này phải dựa trên workload và đo bằng execution plan, không chỉ dựa trên một query riêng lẻ.

## MySQL InnoDB hoạt động thế nào

InnoDB không yêu cầu bạn viết `CREATE CLUSTERED INDEX`. Engine tự chọn clustered key theo quy tắc của nó.

### Primary key là clustered index

Với bảng:

```sql
CREATE TABLE users (
    id    BIGINT       NOT NULL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    name  VARCHAR(100) NOT NULL
) ENGINE = InnoDB;
```

InnoDB tổ chức row data tại leaf của primary-key B+Tree:

```text
Primary-key B+Tree

Root và internal pages
          │
          ▼
Leaf pages:
[id=1, email=..., name=...] ⇄ [id=2, email=..., name=...] ⇄ ...
```

Nói ngắn gọn: trong InnoDB, bảng được tổ chức theo primary key.

### Secondary index lưu primary key

Tạo index trên `email`:

```sql
CREATE INDEX idx_users_email
ON users (email);
```

Leaf của secondary index thường lưu `email` và primary key:

```text
Secondary index idx_users_email

'an@example.com' → id=42
                       │
                       ▼
Primary-key B+Tree

id=42 → toàn bộ row
```

Nếu query chỉ cần `email` và `id`, secondary index có thể đã đủ dữ liệu:

```sql
SELECT id, email
FROM users
WHERE email = 'an@example.com';
```

Nếu query cần `name`, InnoDB thường phải dùng `id=42` để tìm tiếp trong clustered primary-key tree:

```sql
SELECT id, email, name
FROM users
WHERE email = 'an@example.com';
```

Quá trình tìm secondary index rồi tìm tiếp primary-key tree thường được gọi là **secondary lookup** hoặc **back to table lookup**.

### Khi bảng không có primary key

InnoDB vẫn cần một clustered key. Quy tắc đơn giản hóa là:

1. Nếu có primary key, dùng primary key.
2. Nếu không có, tìm unique index phù hợp với các cột `NOT NULL`.
3. Nếu vẫn không có, tạo row ID ẩn nội bộ.

Ví dụ không nên dùng cho bảng nghiệp vụ quan trọng:

```sql
CREATE TABLE logs (
    message    TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL
) ENGINE = InnoDB;
```

InnoDB vẫn hoạt động, nhưng clustered key bị ẩn. Ứng dụng không thể dùng key đó một cách rõ ràng để phân trang, tham chiếu hoặc debug.

<Callout type="idea" title="Thực hành tốt với InnoDB">
  Hãy khai báo primary key rõ ràng, hẹp và ổn định. Primary key không chỉ thực thi tính duy nhất; nó còn ảnh hưởng trực tiếp tới cách lưu bảng và kích thước mọi secondary index.
</Callout>

## PostgreSQL hoạt động thế nào

PostgreSQL không duy trì clustered index theo nghĩa của SQL Server hoặc InnoDB.

### Index và heap là hai cấu trúc riêng

Table row của PostgreSQL thường nằm trong heap. Một B-tree index là cấu trúc tách riêng và giữ TID trỏ tới heap tuple.

```text
PostgreSQL B-tree index trên email

'an@example.com' → TID (block 917, item 4)
                               │
                               ▼
PostgreSQL heap

block 917, item 4 → row thật
```

Vì update có thể tạo phiên bản row mới theo cơ chế MVCC, vị trí tuple trong heap có thể thay đổi qua thời gian. Index vẫn là cấu trúc riêng trỏ tới các tuple phù hợp.

Do đó, gọi mọi PostgreSQL index là “nonclustered index” có thể giúp tạo trực giác, nhưng đây không phải cách phân loại chính thức và đầy đủ trong PostgreSQL.

### Lệnh CLUSTER không được duy trì liên tục

PostgreSQL có lệnh:

```sql
CLUSTER users USING idx_users_created_at;
```

Lệnh này viết lại bảng theo thứ tự của index tại thời điểm chạy. Sau đó, các lệnh `INSERT` và `UPDATE` mới không bắt buộc duy trì thứ tự đó.

```text
Ngay sau CLUSTER:
created_at tăng tương đối theo vị trí heap

Sau nhiều INSERT và UPDATE:
row mới có thể nằm ở vị trí khác
correlation giảm dần
```

PostgreSQL ghi nhớ index đã dùng để `CLUSTER`, nhưng điều đó không biến index thành clustered index được duy trì liên tục.

<Callout type="warn" title="Không đồng nhất SQL Server với PostgreSQL">
  `CLUSTER` của PostgreSQL là thao tác sắp xếp lại bảng tại một thời điểm. `CLUSTERED INDEX` của SQL Server là cấu trúc lưu trữ được duy trì khi dữ liệu thay đổi. Hai khái niệm không tương đương.
</Callout>

## So sánh nhanh giữa các hệ quản trị

| Câu hỏi | SQL Server | MySQL InnoDB | PostgreSQL |
| --- | --- | --- | --- |
| Row data có nằm tại leaf của một index chính không? | Có, nếu bảng có clustered index | Có, tại primary-key tree hoặc clustered key được InnoDB chọn | Không theo mô hình mặc định; row nằm trong heap |
| Có cú pháp `CREATE CLUSTERED INDEX` không? | Có | Không dùng theo cách SQL Server | Không theo nghĩa SQL Server |
| `CREATE INDEX` thông thường tạo gì? | Nonclustered index | Secondary index | Index riêng trỏ tới heap |
| Primary key thường làm gì? | Thường được thực thi bằng unique clustered index nếu thiết kế cho phép | Là clustered index | Tạo unique index riêng; table vẫn là heap |
| Bảng không có primary key hoặc clustered index | Có thể là heap | InnoDB chọn unique key phù hợp hoặc tạo hidden row ID | Vẫn là heap table bình thường |
| Secondary index trỏ bằng gì? | RID nếu heap; clustered key nếu clustered table | Primary-key value | TID của heap tuple |
| Có bao nhiêu cấu trúc clustered chính? | Tối đa một | Một do InnoDB chọn | Không có clustered index được duy trì liên tục |

Câu hỏi “tất cả index tôi tạo đều là nonclustered phải không?” có câu trả lời thực tế như sau:

| Nếu bạn dùng | Câu trả lời ngắn |
| --- | --- |
| SQL Server và chỉ viết `CREATE INDEX ...` | Thường đúng; lệnh này mặc định nonclustered |
| MySQL InnoDB | Index tạo thêm là secondary; primary key đã đóng vai trò clustered |
| PostgreSQL | Index là cấu trúc riêng trỏ tới heap; không nên áp nguyên mô hình clustered của SQL Server |

## Quan hệ với B plus Tree và composite index

### Một index có nhiều nhãn cùng lúc

Xét câu SQL Server sau:

```sql
CREATE UNIQUE NONCLUSTERED INDEX ux_users_tenant_email
ON dbo.users (tenant_id, email);
```

Có thể phân loại nó như sau:

```text
Quan hệ với row data: Nonclustered
Cấu trúc phổ biến:     B+Tree
Số cột key:            Composite
Tính duy nhất:         Unique
Covering:              Tùy query cần những cột nào
```

Không có mâu thuẫn giữa các nhãn này.

### Ví dụ phân loại hoàn chỉnh

**Ví dụ một — SQL Server primary key mặc định:**

```sql
CREATE TABLE dbo.users (
    id BIGINT NOT NULL PRIMARY KEY
);
```

```text
Clustered + B+Tree + single-column + unique
```

**Ví dụ hai — SQL Server composite clustered index:**

```sql
CREATE CLUSTERED INDEX cx_orders_created_id
ON dbo.orders (created_at, id);
```

```text
Clustered + B+Tree + composite + non-unique hoặc unique tùy khai báo
```

**Ví dụ ba — MySQL secondary composite index:**

```sql
CREATE INDEX idx_orders_customer_date
ON orders (customer_id, created_at);
```

```text
Secondary + B+Tree + composite + non-unique
```

**Ví dụ bốn — PostgreSQL partial composite index:**

```sql
CREATE INDEX idx_orders_pending_customer_date
ON orders (customer_id, created_at)
WHERE status = 'pending';
```

```text
B-tree mặc định + composite + partial + cấu trúc riêng trỏ tới heap
```

<Callout type="idea" title="Công thức đọc một index">
  Hãy hỏi lần lượt: row data nằm ở đâu, index dùng cấu trúc gì, key gồm cột nào, có unique không, có filter không, và có cover query đang xét không.
</Callout>

## Cách chọn clustered key

Phần này áp dụng trực tiếp khi bạn chọn clustered index trong SQL Server. Nó cũng áp dụng gián tiếp khi chọn primary key cho InnoDB.

Một clustered key tốt thường có năm đặc điểm.

### Hẹp

Key hẹp giúp mỗi page chứa được nhiều entry hơn. Nó cũng giảm kích thước row locator trong các secondary hoặc nonclustered index.

So sánh:

```text
BIGINT key:               8 bytes
UUID dạng BINARY(16):    16 bytes
VARCHAR(100):            có thể lớn hơn nhiều
```

Nếu clustered key tăng thêm 20 byte và bảng có năm nonclustered index, phần tăng có thể bị nhân lên trên rất nhiều index entry.

**Kết luận:** ưu tiên kiểu dữ liệu nhỏ nhất nhưng vẫn đủ miền giá trị và yêu cầu nghiệp vụ.

### Ổn định

Update clustered key có thể khiến row phải chuyển vị trí logic và yêu cầu cập nhật row locator trong nhiều index liên quan.

Không nên chọn cột thường xuyên thay đổi:

```text
email
status
last_login_at
updated_at
```

Các key ổn định thường phù hợp hơn:

```text
identity hoặc sequence id
mã định danh bất biến
UUID bất biến nếu nghiệp vụ cần UUID
```

**Kết luận:** clustered key nên gần như không đổi sau khi insert.

### Tăng dần thường có lợi

Key tăng dần như identity hoặc sequence thường chèn vào vùng cuối của B+Tree. Điều này thường giảm insert rải rác và page split so với key ngẫu nhiên.

```text
Key tăng dần:
1001, 1002, 1003 → thường chèn gần cuối

Key ngẫu nhiên:
8f..., 1a..., c4... → chèn vào nhiều vùng khác nhau
```

Tuy nhiên, workload ghi cực lớn có thể tạo contention ở page cuối. SQL Server và InnoDB có các cơ chế và chiến lược riêng để xử lý. Vì vậy, “tăng dần luôn tốt” không phải luật tuyệt đối.

**Kết luận:** mặc định hãy ưu tiên key tăng dần; chỉ đổi chiến lược khi phép đo cho thấy hotspot thật sự.

### Đủ duy nhất

SQL Server cho phép clustered index không unique:

```sql
CREATE CLUSTERED INDEX cx_orders_created_at
ON dbo.orders (created_at);
```

Nếu nhiều row có cùng `created_at`, SQL Server cần thông tin nội bộ để phân biệt các row trùng key. Một clustered key unique rõ ràng thường dễ dự đoán hơn.

Cách phổ biến là thêm `id`:

```sql
CREATE UNIQUE CLUSTERED INDEX cx_orders_created_id
ON dbo.orders (created_at, id);
```

Đổi lại, key composite rộng hơn. Hãy cân bằng tính duy nhất với kích thước key.

### Phù hợp truy vấn quan trọng

Clustered key ảnh hưởng lớn tới query đọc range và query lấy nhiều row liền kề theo key.

Ví dụ workload theo thời gian:

```sql
SELECT *
FROM orders
WHERE created_at >= @from
  AND created_at <  @to;
```

Cluster theo `created_at` có thể giảm việc đọc page rải rác. Nhưng nếu phần lớn query tìm chính xác bằng `id`, cluster theo `id` có thể đơn giản và hiệu quả hơn.

Đừng chọn clustered key chỉ vì một quy tắc chung. Hãy xem:

1. Query nào chạy thường xuyên nhất.
2. Query nào nhạy cảm latency nhất.
3. Mỗi query trả một row hay một range lớn.
4. Tần suất insert và update.
5. Kích thước và số lượng secondary index.

## Khi nào clustered index có lợi

Clustered index thường có lợi cho các pattern sau.

**Đọc theo khoảng của clustered key:**

```sql
SELECT *
FROM orders
WHERE id BETWEEN 100000 AND 110000;
```

Các row ở leaf đã nằm gần nhau theo thứ tự logic của `id`.

**Đọc có thứ tự và giới hạn:**

```sql
SELECT TOP (100) *
FROM dbo.orders
ORDER BY id DESC;
```

Database có thể đọc từ cuối clustered index và dừng sớm.

**Tìm một row theo clustered key:**

```sql
SELECT *
FROM dbo.orders
WHERE id = 42;
```

Leaf chứa row data nên không cần key lookup thêm.

**Tránh heap cho bảng OLTP phổ biến:**

Heap không tự động xấu, nhưng nhiều bảng nghiệp vụ được truy cập theo primary key sẽ dễ quản lý và dễ dự đoán hơn khi có clustered index phù hợp.

Clustered index không đảm bảo luôn nhanh nhất. Một nonclustered covering index nhỏ hơn có thể nhanh hơn vì query phải đọc ít page hơn.

## Khi nào nonclustered index có lợi

Một bảng chỉ có một clustered organization nhưng có nhiều access pattern:

```text
Tìm order theo id
Tìm order theo customer_id
Tìm order theo status và created_at
Tìm order theo payment_reference
```

Nonclustered index cung cấp nhiều đường truy cập bổ sung:

```sql
CREATE INDEX idx_orders_customer_date
ON orders (customer_id, created_at);

CREATE INDEX idx_orders_status_date
ON orders (status, created_at);

CREATE UNIQUE INDEX ux_orders_payment_reference
ON orders (payment_reference);
```

Mỗi index giải quyết một nhóm query. Đổi lại, mỗi index làm tăng:

- Dung lượng lưu trữ.
- Chi phí `INSERT`.
- Chi phí `DELETE`.
- Chi phí `UPDATE` khi cột được index thay đổi.
- Công việc bảo trì và ghi log.

<Callout type="warn" title="Không tạo index cho mọi cột">
  Index là một cấu trúc phải được duy trì, không phải bản tăng tốc miễn phí. Hãy thiết kế từ query quan trọng rồi xác nhận bằng execution plan.
</Callout>

## Cách kiểm tra index hiện tại

### Kiểm tra trên SQL Server

Liệt kê loại index:

```sql
SELECT
    i.name,
    i.type_desc,
    i.is_primary_key,
    i.is_unique,
    i.is_unique_constraint
FROM sys.indexes AS i
WHERE i.object_id = OBJECT_ID(N'dbo.users')
ORDER BY i.index_id;
```

Các giá trị thường gặp:

```text
HEAP
CLUSTERED
NONCLUSTERED
```

Liệt kê key columns theo thứ tự:

```sql
SELECT
    i.name AS index_name,
    i.type_desc,
    ic.key_ordinal,
    c.name AS column_name,
    ic.is_included_column
FROM sys.indexes AS i
JOIN sys.index_columns AS ic
  ON ic.object_id = i.object_id
 AND ic.index_id = i.index_id
JOIN sys.columns AS c
  ON c.object_id = ic.object_id
 AND c.column_id = ic.column_id
WHERE i.object_id = OBJECT_ID(N'dbo.users')
ORDER BY i.index_id, ic.key_ordinal, c.column_id;
```

Nếu `index_id = 0`, bảng là heap. Nếu có `index_id = 1`, đó là clustered index.

### Kiểm tra trên MySQL

Xem các index:

```sql
SHOW INDEX FROM users;
```

Xem DDL đầy đủ:

```sql
SHOW CREATE TABLE users;
```

MySQL không hiển thị một cột đơn giản tên là `is_clustered` cho InnoDB. Hãy xác định primary key từ `Key_name = 'PRIMARY'`. Với InnoDB, primary key đó là clustered key thông thường.

Kiểm tra query có lookup về clustered tree hay index đã cover:

```sql
EXPLAIN ANALYZE
SELECT id, email
FROM users
WHERE email = 'an@example.com';
```

Trong `EXPLAIN` truyền thống, `Using index` thường cho biết query có thể lấy dữ liệu từ index mà không cần đọc toàn bộ row từ clustered tree.

### Kiểm tra trên PostgreSQL

Liệt kê index và access method:

```sql
SELECT
    i.relname AS index_name,
    am.amname AS index_method,
    ix.indisprimary AS is_primary,
    ix.indisunique AS is_unique,
    ix.indisclustered AS marked_for_cluster
FROM pg_class AS t
JOIN pg_index AS ix
  ON ix.indrelid = t.oid
JOIN pg_class AS i
  ON i.oid = ix.indexrelid
JOIN pg_am AS am
  ON am.oid = i.relam
WHERE t.oid = 'public.users'::regclass
ORDER BY i.relname;
```

`indisclustered = true` chỉ cho biết index được đánh dấu là index dùng cho lệnh `CLUSTER`. Nó không có nghĩa PostgreSQL đang duy trì bảng theo index đó sau mọi lần ghi.

Kiểm tra cách query truy cập dữ liệu:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, email
FROM users
WHERE email = 'an@example.com';
```

Các node thường gặp:

```text
Seq Scan
Index Scan
Index Only Scan
Bitmap Index Scan
Bitmap Heap Scan
```

## Các hiểu lầm thường gặp

**“Primary key luôn là clustered index.”**

Sai khi nói chung cho mọi database.

- SQL Server thường dùng primary key làm clustered index theo thiết kế mặc định, nhưng có thể chọn `NONCLUSTERED`.
- InnoDB dùng primary key làm clustered key.
- PostgreSQL tạo unique index cho primary key nhưng table vẫn là heap.

**“Clustered index là một loại khác với B+Tree.”**

Sai vì hai thuật ngữ nằm trên hai trục khác nhau. Clustered index của SQL Server và primary-key index của InnoDB đều thường được triển khai bằng cấu trúc dạng B+Tree.

**“Composite index là nonclustered index.”**

Sai. Composite chỉ nghĩa là có nhiều cột. SQL Server cho phép composite clustered index:

```sql
CREATE CLUSTERED INDEX cx_orders_date_id
ON dbo.orders (created_at, id);
```

**“Tôi không tạo clustered index nên bảng không có clustered index.”**

Không chắc. Primary key hoặc storage engine có thể đã tạo hoặc chọn clustered organization cho bạn.

**“Clustered index khiến mọi query nhanh hơn.”**

Sai. Nó ưu tiên một trật tự chính. Query theo access pattern khác vẫn có thể cần nonclustered index.

**“Nonclustered index luôn cần hai lần đọc.”**

Không luôn đúng. Nếu index cover query, database có thể trả kết quả từ index. Ngoài ra, các page cần thiết có thể đã ở trong memory.

**“Clustered index có nghĩa page luôn liên tiếp trên đĩa.”**

Sai. B+Tree duy trì thứ tự logic của leaf. Page split và fragmentation có thể khiến vị trí vật lý phân tán.

**“PostgreSQL CLUSTER giống SQL Server clustered index.”**

Sai. PostgreSQL `CLUSTER` là thao tác rewrite tại một thời điểm và không duy trì thứ tự đó liên tục.

## Quy trình thiết kế thực tế

Dùng quy trình sau thay vì bắt đầu bằng câu hỏi “nên tạo loại index nào?”.

**Bước một — Xác định DBMS và storage engine**

```text
SQL Server?
MySQL InnoDB?
PostgreSQL?
Oracle?
```

Cùng một từ “index” nhưng row locator và storage model khác nhau.

**Bước hai — Kiểm tra cấu trúc hiện tại**

Xác nhận:

- Primary key là cột nào.
- Bảng đang là heap hay clustered table.
- Có những index nào.
- Key columns và included columns là gì.

**Bước ba — Thu thập query quan trọng**

Không thiết kế index chỉ từ schema. Hãy lấy query thật, tần suất chạy và số row trả về.

```sql
SELECT id, status, created_at, total
FROM orders
WHERE customer_id = ?
ORDER BY created_at DESC
LIMIT 50;
```

**Bước bốn — Thiết kế access key**

Với query trên, composite index hợp lý thường bắt đầu bằng:

```sql
(customer_id, created_at DESC)
```

`customer_id` tạo nhóm cần tìm. `created_at` giữ thứ tự trong nhóm và giúp dừng sau 50 row.

**Bước năm — Xem có cần covering không**

Nếu lookup về bảng gốc chiếm phần lớn chi phí, cân nhắc include các cột nhỏ, ổn định và thực sự cần:

```sql
-- SQL Server hoặc PostgreSQL
CREATE INDEX idx_orders_customer_date
ON orders (customer_id, created_at DESC)
INCLUDE (status, total);
```

**Bước sáu — Kiểm tra execution plan**

Dùng công cụ của DBMS:

```text
SQL Server: Actual Execution Plan, STATISTICS IO, STATISTICS TIME
PostgreSQL: EXPLAIN (ANALYZE, BUFFERS)
MySQL:      EXPLAIN ANALYZE
```

Đừng chỉ kiểm tra “index có được dùng không”. Hãy kiểm tra:

- Database đọc bao nhiêu row và page.
- Có lookup lặp lại không.
- Có sort không.
- Estimate có gần actual không.
- Query có trả quá nhiều row khiến table scan hợp lý hơn không.

**Bước bảy — Đo chi phí ghi**

Sau khi thêm index, đo lại `INSERT`, `UPDATE`, `DELETE`, dung lượng và thời gian bảo trì.

<Callout type="idea" title="Nguyên tắc cuối cùng">
  Tên loại index chỉ giúp xây mental model. Quyết định đúng phải dựa trên DBMS cụ thể, query cụ thể, dữ liệu cụ thể và execution plan thật.
</Callout>

## Tóm tắt

Hãy ghi nhớ bốn câu sau:

```text
Clustered / nonclustered  → row data nằm ở đâu?
B+Tree / hash             → index dùng cấu trúc gì?
Single / composite        → key có bao nhiêu cột?
Unique / partial / cover  → index có thuộc tính gì?
```

Về câu hỏi “tại sao tôi chưa bao giờ tự tạo clustered index?”:

- Trên SQL Server, `CREATE INDEX` mặc định thường tạo nonclustered index. Primary key có thể đã tạo clustered index cho bạn.
- Trên MySQL InnoDB, primary key tự đóng vai trò clustered index. Các index tạo thêm là secondary index.
- Trên PostgreSQL, table thường là heap và index là cấu trúc riêng. Lệnh `CLUSTER` không tương đương clustered index được duy trì liên tục.

Một schema phổ biến có thể được đọc như sau:

```text
Primary key
└── Clustered B+Tree, single-column, unique

Index trên (customer_id, created_at)
└── Nonclustered B+Tree, composite, non-unique

Unique index trên email
└── Nonclustered B+Tree, single-column, unique
```

<Cards>
  <Card title="B+Tree hoạt động như thế nào" href="/optimization/b-plus-tree-deep-dive/" description="Hiểu root, internal page, leaf page, range scan và page split." />
  <Card title="Composite Index" href="/optimization/composite-index-deep-dive/" description="Hiểu thứ tự cột và leftmost prefix rule." />
  <Card title="Index SQL" href="/optimization/index-sql-deep-dive/" description="Tổng quan selectivity, covering index và chiến lược tối ưu." />
</Cards>
