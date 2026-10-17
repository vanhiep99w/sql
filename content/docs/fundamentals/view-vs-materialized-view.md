---
title: "View vs Materialized View"
description: "So sánh View và Materialized View từ cơ chế thực thi, index, độ mới dữ liệu đến refresh, locking và vận hành production. Có lab PostgreSQL, cách đo hiệu năng và đối chiếu Oracle, SQL Server, MySQL."
---

<Callout type="info" title="Phạm vi và cách đọc">

**MV** trong bài là **Materialized View**, không phải MVCC. Bài dành cho người đã biết `SELECT`, `JOIN` và `GROUP BY`.

Phần nguyên lý áp dụng rộng rãi. Cú pháp và lab chính dùng **PostgreSQL 17**; những cơ chế riêng của Oracle, SQL Server và MySQL được tách rõ. Không mặc định rằng MV trên mọi database đều refresh giống PostgreSQL.

</Callout>

<SourceRef project="fundamentals-view-vs-materialized-view" variant="button">
Mở các đoạn code trong bài
</SourceRef>

Các file trong Source Explorer là **snippet độc lập**, giữ nguyên ngữ cảnh và database của từng mục; không chạy nối tiếp tất cả như một script.

## Mục lục

- [1. Bài toán và câu trả lời ngắn](#1-bài-toán-và-câu-trả-lời-ngắn)
- [2. View hoạt động như thế nào](#2-view-hoạt-động-như-thế-nào)
  - [2.1. View là một đối tượng chứa định nghĩa truy vấn](#21-view-là-một-đối-tượng-chứa-định-nghĩa-truy-vấn)
  - [2.2. View không bắt buộc phải đọc toàn bộ dữ liệu nguồn](#22-view-không-bắt-buộc-phải-đọc-toàn-bộ-dữ-liệu-nguồn)
  - [2.3. View không có index riêng trong PostgreSQL](#23-view-không-có-index-riêng-trong-postgresql)
  - [2.4. Dữ liệu của View mới theo snapshot của truy vấn](#24-dữ-liệu-của-view-mới-theo-snapshot-của-truy-vấn)
- [3. Materialized View hoạt động như thế nào](#3-materialized-view-hoạt-động-như-thế-nào)
  - [3.1. MV lưu kết quả thay vì tính lại ở mỗi lần đọc](#31-mv-lưu-kết-quả-thay-vì-tính-lại-ở-mỗi-lần-đọc)
  - [3.2. Luồng đọc và luồng cập nhật tách nhau](#32-luồng-đọc-và-luồng-cập-nhật-tách-nhau)
  - [3.3. MV giống bảng ở khả năng đọc, nhưng không phải bảng tùy ý ghi](#33-mv-giống-bảng-ở-khả-năng-đọc-nhưng-không-phải-bảng-tùy-ý-ghi)
  - [3.4. MV có thể cũ nhưng vẫn đúng tại thời điểm đã tính](#34-mv-có-thể-cũ-nhưng-vẫn-đúng-tại-thời-điểm-đã-tính)
- [4. So sánh tổng quan và khác biệt giữa các database](#4-so-sánh-tổng-quan-và-khác-biệt-giữa-các-database)
  - [4.1. Bảng so sánh trong PostgreSQL](#41-bảng-so-sánh-trong-postgresql)
  - [4.2. Không mang cơ chế của database này sang database khác](#42-không-mang-cơ-chế-của-database-này-sang-database-khác)
  - [4.3. Oracle và SQL Server chuyển một phần chi phí sang đường ghi](#43-oracle-và-sql-server-chuyển-một-phần-chi-phí-sang-đường-ghi)
  - [4.4. MySQL TEMPTABLE không phải Materialized View bền vững](#44-mysql-temptable-không-phải-materialized-view-bền-vững)
- [5. Lab PostgreSQL từ đầu đến cuối](#5-lab-postgresql-từ-đầu-đến-cuối)
  - [5.1. Tạo bảng và dữ liệu mẫu](#51-tạo-bảng-và-dữ-liệu-mẫu)
  - [5.2. Tạo View và MV cùng logic](#52-tạo-view-và-mv-cùng-logic)
  - [5.3. Quan sát kết quả trước và sau khi ghi dữ liệu](#53-quan-sát-kết-quả-trước-và-sau-khi-ghi-dữ-liệu)
  - [5.4. Refresh rồi đối chiếu lại](#54-refresh-rồi-đối-chiếu-lại)
  - [5.5. Thử WITH NO DATA và bootstrap lần đầu](#55-thử-with-no-data-và-bootstrap-lần-đầu)
- [6. Hiệu năng và cách đo đúng](#6-hiệu-năng-và-cách-đo-đúng)
  - [6.1. MV có thể tiết kiệm những bước nào](#61-mv-có-thể-tiết-kiệm-những-bước-nào)
  - [6.2. Benchmark phải so cùng logic và cùng dữ liệu](#62-benchmark-phải-so-cùng-logic-và-cùng-dữ-liệu)
  - [6.3. Tính cả refresh vào tổng chi phí](#63-tính-cả-refresh-vào-tổng-chi-phí)
- [7. Full refresh và incremental refresh](#7-full-refresh-và-incremental-refresh)
  - [7.1. PostgreSQL core tính lại truy vấn định nghĩa](#71-postgresql-core-tính-lại-truy-vấn-định-nghĩa)
  - [7.2. Incremental refresh cần hiểu đủ các dạng thay đổi](#72-incremental-refresh-cần-hiểu-đủ-các-dạng-thay-đổi)
  - [7.3. Chọn các đại lượng có thể tổng hợp lại](#73-chọn-các-đại-lượng-có-thể-tổng-hợp-lại)
- [8. Concurrent refresh và locking trong PostgreSQL](#8-concurrent-refresh-và-locking-trong-postgresql)
  - [8.1. Refresh thường và refresh concurrent](#81-refresh-thường-và-refresh-concurrent)
  - [8.2. Điều kiện của unique index](#82-điều-kiện-của-unique-index)
  - [8.3. Quan sát lock bằng hai session](#83-quan-sát-lock-bằng-hai-session)
  - [8.4. Công bố dữ liệu mới và refresh chồng nhau](#84-công-bố-dữ-liệu-mới-và-refresh-chồng-nhau)
- [9. Độ mới dữ liệu và tính nhất quán](#9-độ-mới-dữ-liệu-và-tính-nhất-quán)
  - [9.1. Refresh thành công không đồng nghĩa dữ liệu mới tới lúc kết thúc](#91-refresh-thành-công-không-đồng-nghĩa-dữ-liệu-mới-tới-lúc-kết-thúc)
  - [9.2. Lịch chạy không phải cam kết độ trễ](#92-lịch-chạy-không-phải-cam-kết-độ-trễ)
  - [9.3. Event time không phải mốc dữ liệu đã đồng bộ](#93-event-time-không-phải-mốc-dữ-liệu-đã-đồng-bộ)
  - [9.4. Nhiều MV có thể lệch phiên bản](#94-nhiều-mv-có-thể-lệch-phiên-bản)
  - [9.5. Kết hợp lịch sử bằng MV và dữ liệu mới bằng View](#95-kết-hợp-lịch-sử-bằng-mv-và-dữ-liệu-mới-bằng-view)
- [10. Vận hành MV trong production](#10-vận-hành-mv-trong-production)
  - [10.1. Job refresh cần một chủ sở hữu và hợp đồng rõ ràng](#101-job-refresh-cần-một-chủ-sở-hữu-và-hợp-đồng-rõ-ràng)
  - [10.2. Ghi metadata thành công cùng transaction với refresh](#102-ghi-metadata-thành-công-cùng-transaction-với-refresh)
  - [10.3. Theo dõi tuổi dữ liệu và lỗi refresh](#103-theo-dõi-tuổi-dữ-liệu-và-lỗi-refresh)
  - [10.4. Theo dõi lock và ngân sách tài nguyên](#104-theo-dõi-lock-và-ngân-sách-tài-nguyên)
  - [10.5. Statistics và dọn phiên bản cũ](#105-statistics-và-dọn-phiên-bản-cũ)
  - [10.6. Thay đổi định nghĩa mà vẫn có đường rollback](#106-thay-đổi-định-nghĩa-mà-vẫn-có-đường-rollback)
- [11. Quyền truy cập và khả năng ghi](#11-quyền-truy-cập-và-khả-năng-ghi)
  - [11.1. Một số View cho phép ghi xuống bảng nguồn](#111-một-số-view-cho-phép-ghi-xuống-bảng-nguồn)
  - [11.2. Quyền của người đọc và quyền của người refresh là hai việc](#112-quyền-của-người-đọc-và-quyền-của-người-refresh-là-hai-việc)
  - [11.3. MV không tự kế thừa bảo mật theo từng người đọc từ bảng nguồn](#113-mv-không-tự-kế-thừa-bảo-mật-theo-từng-người-đọc-từ-bảng-nguồn)
- [12. Các lỗi thiết kế dễ gặp](#12-các-lỗi-thiết-kế-dễ-gặp)
  - [12.1. Lỗi về hiệu năng và tính đúng](#121-lỗi-về-hiệu-năng-và-tính-đúng)
  - [12.2. Lỗi về freshness và thay đổi schema](#122-lỗi-về-freshness-và-thay-đổi-schema)
- [13. Khi nào nên chọn View hoặc MV](#13-khi-nào-nên-chọn-view-hoặc-mv)
  - [13.1. Quy trình ra quyết định](#131-quy-trình-ra-quyết-định)
  - [13.2. Áp dụng vào những tình huống thực tế](#132-áp-dụng-vào-những-tình-huống-thực-tế)
  - [13.3. Tính trong database và tính trong Java khác nhau ở đâu](#133-tính-trong-database-và-tính-trong-java-khác-nhau-ở-đâu)
  - [13.4. Vì sao nhiều project đưa phép tính vào View hoặc MV](#134-vì-sao-nhiều-project-đưa-phép-tính-vào-view-hoặc-mv)
  - [13.5. Vì sao nhiều application vẫn giữ logic trong Java](#135-vì-sao-nhiều-application-vẫn-giữ-logic-trong-java)
  - [13.6. Kiến trúc kết hợp và cách chọn nơi thực thi](#136-kiến-trúc-kết-hợp-và-cách-chọn-nơi-thực-thi)
- [14. Phân biệt MV với các cơ chế dễ nhầm](#14-phân-biệt-mv-với-các-cơ-chế-dễ-nhầm)
- [15. Câu hỏi thường gặp](#15-câu-hỏi-thường-gặp)
- [16. Checklist và tóm tắt](#16-checklist-và-tóm-tắt)
  - [16.1. Checklist trước khi dùng MV](#161-checklist-trước-khi-dùng-mv)
  - [16.2. Bảy điểm cần nhớ](#162-bảy-điểm-cần-nhớ)
- [17. Dọn lab và đọc tiếp](#17-dọn-lab-và-đọc-tiếp)
- [18. Tài liệu tham khảo](#18-tài-liệu-tham-khảo)

## 1. Bài toán và câu trả lời ngắn

Một dashboard cần doanh thu theo ngày và khách hàng. Để trả lời, database phải đọc đơn hàng, lọc trạng thái thanh toán rồi cộng số tiền:

```sql
SELECT
    customer_id,
    (order_at AT TIME ZONE 'UTC')::date AS order_day,
    COUNT(*) AS order_count,
    SUM(amount) AS revenue
FROM orders
WHERE status = 'paid'
GROUP BY customer_id, (order_at AT TIME ZONE 'UTC')::date;
```

Nếu nhiều màn hình dùng chung logic này, bạn muốn đặt tên cho nó. Nếu hàng nghìn request liên tục yêu cầu cùng kết quả, bạn còn muốn tránh tính lại phép tổng hợp đắt tiền.

Đó là hai nhu cầu khác nhau:

- **View** đặt tên và đóng gói một truy vấn. View thông thường lưu **định nghĩa truy vấn**, không lưu một bộ kết quả để tái sử dụng giữa các request.
- **Materialized View** lưu **kết quả đã tính** cùng với định nghĩa truy vấn. Cách giữ kết quả đó cập nhật phụ thuộc database.

```d2 title="View chạy logic, MV đọc kết quả đã lưu"
direction: right
view: View thông thường {
  select: SELECT View
  query: Thực thi logic trên dữ liệu nguồn
  select -> query
}
mv: Materialized View — PostgreSQL {
  refresh: REFRESH
  query: Thực thi logic
  storage: Lưu kết quả vào MV { shape: cylinder }
  read: SELECT MV
  refresh -> query -> storage
  read -> storage: đọc kết quả đã lưu
}
```

Trong ví dụ dashboard:

- Dùng View để mọi nơi thống nhất định nghĩa “doanh thu từ đơn đã thanh toán”.
- Cân nhắc MV nếu tổng hợp dữ liệu quá tốn kém và dashboard chấp nhận một độ trễ cập nhật đã xác định.

<Callout type="idea" title="Nhớ một câu">

**View tái sử dụng logic. MV tái sử dụng kết quả.** MV không xóa chi phí tính toán; nó chuyển chi phí đó sang lúc tạo hoặc duy trì dữ liệu đã lưu.

</Callout>

## 2. View hoạt động như thế nào

### 2.1. View là một đối tượng chứa định nghĩa truy vấn

Ví dụ một View chỉ chứa đơn đã thanh toán:

```sql
CREATE VIEW paid_orders AS
SELECT id, customer_id, order_at, amount
FROM orders
WHERE status = 'paid';
```

Ứng dụng có thể dùng tên đó như một bảng trong `SELECT`:

```sql
SELECT id, amount
FROM paid_orders
WHERE customer_id = 42;
```

Database lưu định nghĩa của `paid_orders` trong **system catalog** — tập thông tin nội bộ về bảng, cột, quyền và các đối tượng khác.

Khi truy vấn View, PostgreSQL đưa định nghĩa của View vào quá trình xử lý câu SQL. **Planner**, hay bộ lập kế hoạch, chọn cách đọc dữ liệu nguồn. **Execution plan** là kế hoạch gồm các bước như quét bảng, đọc index, join và tổng hợp.

Có thể hình dung truy vấn trên như sau:

```sql
SELECT id, amount
FROM orders
WHERE status = 'paid'
  AND customer_id = 42;
```

Đây là cách giải thích logic, không phải cam kết rằng database luôn tạo đúng văn bản SQL này hoặc một plan cố định.

### 2.2. View không bắt buộc phải đọc toàn bộ dữ liệu nguồn

Một View lọc đơn đã thanh toán không có nghĩa database phải dựng tất cả đơn đã thanh toán rồi mới tìm khách hàng 42.

Planner có thể thực hiện **predicate pushdown** — đưa điều kiện lọc từ truy vấn bên ngoài xuống bước đọc dữ liệu nguồn:

```sql
CREATE INDEX orders_paid_customer_idx
ON orders (customer_id)
WHERE status = 'paid';
```

Với index này, truy vấn qua `paid_orders` có thể đọc trực tiếp các đơn của khách hàng cần tìm.

Tuy nhiên, không phải mọi điều kiện đều đẩy xuống được. Các phép tổng hợp, `LIMIT`, window function hoặc quy tắc bảo mật có thể giới hạn biến đổi hợp lệ.

**Kết luận:** View không tự làm truy vấn nhanh hơn hay chậm hơn. Hãy xem plan của truy vấn thực tế, gồm cả điều kiện phía ngoài View.

### 2.3. View không có index riêng trong PostgreSQL

Với View thông thường, dữ liệu vẫn nằm ở các bảng nguồn. Vì vậy bạn tạo index trên bảng nguồn, không tạo index trên View:

```sql
-- Hợp lệ: index trên bảng nguồn.
CREATE INDEX orders_customer_time_idx
ON orders (customer_id, order_at);

-- Không hợp lệ với View thông thường trong PostgreSQL:
-- CREATE INDEX paid_orders_customer_idx ON paid_orders (customer_id);
```

Nếu một truy vấn chậm do đọc quá nhiều đơn hàng, sửa index hoặc cách viết điều kiện có thể đã đủ. Chưa cần chuyển sang MV.

**SQL Server indexed view** là trường hợp khác. Khi được tạo index theo các điều kiện của SQL Server, View đó có dữ liệu được lưu vật lý. Phần so sánh database sẽ giải thích riêng cơ chế này.

### 2.4. Dữ liệu của View mới theo snapshot của truy vấn

Giả sử một transaction khác vừa đổi đơn hàng từ `pending` sang `paid` và đã `COMMIT`. Một `SELECT` mới qua View trong PostgreSQL ở mức `READ COMMITTED` sẽ thấy thay đổi đó nếu commit xảy ra trước snapshot của statement.

**Snapshot** là góc nhìn xác định những phiên bản dữ liệu nào được phép đọc. Nó không phải bản sao vật lý của toàn bộ database.

Vì vậy, “View luôn là dữ liệu mới nhất” cần hiểu đúng:

- `READ COMMITTED`: mỗi statement lấy góc nhìn mới khi statement bắt đầu.
- `REPEATABLE READ`: transaction giữ một góc nhìn ổn định; câu `SELECT` sau có thể chưa thấy commit mới từ transaction khác.
- Nếu đọc View trên read replica, dữ liệu còn phụ thuộc độ trễ sao chép của replica.

**Điểm cần nhớ:** View không có độ trễ do lưu kết quả riêng. Nhưng nó vẫn tuân theo isolation level và nguồn dữ liệu mà bạn đang đọc.

## 3. Materialized View hoạt động như thế nào

### 3.1. MV lưu kết quả thay vì tính lại ở mỗi lần đọc

Ví dụ trong PostgreSQL:

```sql
CREATE MATERIALIZED VIEW daily_revenue AS
SELECT
    customer_id,
    (order_at AT TIME ZONE 'UTC')::date AS order_day,
    COUNT(*) AS order_count,
    SUM(amount) AS revenue
FROM orders
WHERE status = 'paid'
GROUP BY customer_id, (order_at AT TIME ZONE 'UTC')::date;
```

Lệnh này chạy truy vấn và lưu các dòng tổng hợp. Sau đó:

```sql
SELECT order_day, revenue
FROM daily_revenue
WHERE customer_id = 42
ORDER BY order_day;
```

Phần tổng hợp đơn hàng không cần chạy lại chỉ vì có thêm một request đọc MV. PostgreSQL đọc quan hệ vật lý của `daily_revenue`, có thể dùng index riêng của MV.

Số dòng giảm được phụ thuộc **grain**, tức đơn vị chi tiết của mỗi dòng kết quả. Trong ví dụ này, mỗi dòng đại diện cho **một khách hàng trong một ngày**.

Nếu hàng triệu đơn gom thành vài chục nghìn nhóm, MV có thể giúp rất nhiều. Nếu MV chỉ sao chép gần như toàn bộ các dòng nguồn, lợi ích cần được đo lại.

### 3.2. Luồng đọc và luồng cập nhật tách nhau

```d2 title="3.2. Luồng đọc và luồng cập nhật tách nhau"
direction: right
App: "Ứng dụng"
V: "View: định nghĩa SQL"
P: "Planner và executor"
T: "Bảng nguồn" { shape: cylinder }
M: "MV: kết quả đã lưu" { shape: cylinder }
Job: "Job refresh"
R: "Chạy truy vấn định nghĩa"
Writer: "INSERT / UPDATE / DELETE"
App -> V: "SELECT View"
V -> P
P -> T
App -> M: "SELECT MV"
Job -> R
R -> T
R -> M: "Công bố kết quả mới"
Writer -> T
```

Sơ đồ thể hiện PostgreSQL core. Ghi vào bảng nguồn **không tự động cập nhật** MV.

Bạn phải gọi:

```sql
REFRESH MATERIALIZED VIEW daily_revenue;
```

Hoặc thiết lập một job để gọi lệnh đó theo lịch. Việc `SELECT` từ MV không tự kích hoạt refresh.

### 3.3. MV giống bảng ở khả năng đọc, nhưng không phải bảng tùy ý ghi

Trong PostgreSQL, MV có thể:

- Lưu dữ liệu bền vững qua nhiều session.
- Có index riêng.
- Có statistics để planner ước lượng dữ liệu.
- Được `ANALYZE` và `VACUUM`.
- Được cấp quyền đọc độc lập với các bảng nguồn.

Nhưng bạn không trực tiếp dùng `INSERT`, `UPDATE` hoặc `DELETE` để sửa nội dung MV như một bảng thông thường. Nội dung được sinh từ truy vấn định nghĩa qua quá trình refresh.

So với `CREATE TABLE AS SELECT`, MV còn nhớ truy vấn nguồn để dùng cho `REFRESH`. Bảng tạo bằng `CREATE TABLE AS` không tự có cơ chế đó.

### 3.4. MV có thể cũ nhưng vẫn đúng tại thời điểm đã tính

Giả sử doanh thu trong MV là 300. Sau đó một đơn đã thanh toán trị giá 70 được commit vào bảng nguồn:

```text
Bảng nguồn: doanh thu hiện tại = 370
MV:         doanh thu đã lưu  = 300
```

MV chưa phản ánh đơn mới, chứ phép cộng trước đó không sai. Đây là **staleness** — độ cũ của dữ liệu đã lưu so với nguồn hiện tại.

Với dashboard tham khảo, độ cũ vài phút có thể chấp nhận được. Với kiểm tra số dư trước khi chuyển tiền, kết quả cũ có thể dẫn tới quyết định sai.

**Hãy định nghĩa độ mới cần thiết trước khi chọn MV.** “Có thể chậm một chút” chưa phải yêu cầu đủ rõ để vận hành.

## 4. So sánh tổng quan và khác biệt giữa các database

### 4.1. Bảng so sánh trong PostgreSQL

| Tiêu chí | View thông thường | Materialized View |
|---|---|---|
| Lưu gì | Định nghĩa truy vấn | Định nghĩa và kết quả truy vấn |
| Dữ liệu kết quả riêng, bền vững | Không | Có |
| Khi đọc | Thực thi logic trên nguồn theo plan | Đọc dữ liệu đã lưu |
| Độ mới | Theo snapshot của truy vấn và nguồn đọc | Theo lần tạo hoặc refresh đã thành công |
| Index riêng | Không | Có |
| Statistics cho kết quả riêng | Không; planner dựa vào nguồn và phép biến đổi | Có thể thu thập bằng `ANALYZE` |
| Tác động trực tiếp lên ghi bảng nguồn | Không có chi phí duy trì kết quả View | Không tự duy trì trong PostgreSQL core |
| Chi phí tính toán lớn | Chủ yếu lúc đọc | Chủ yếu lúc tạo hoặc refresh |
| Storage cho kết quả | Không | Có, gồm dữ liệu và index |
| Ghi trực tiếp qua đối tượng | Một số View đơn giản cho phép | Không hỗ trợ DML trực tiếp |
| Cần job refresh | Không | Có nếu cần cập nhật định kỳ |
| Truy vấn bảng nguồn tự dùng MV | Không áp dụng | PostgreSQL core không tự rewrite sang MV |
| Rủi ro vận hành chính | Query đắt, logic khó tối ưu, cấu hình quyền sai | Dữ liệu cũ, refresh lỗi, locking, thiếu tài nguyên |
| Nhu cầu điển hình | Tái sử dụng logic và tạo giao diện dữ liệu | Tái sử dụng kết quả tính toán đắt |

View vẫn có metadata và dependency. “Không lưu kết quả” không có nghĩa đối tượng View hoàn toàn không chiếm dung lượng.

### 4.2. Không mang cơ chế của database này sang database khác

| Database | Cơ chế lưu kết quả | Cách duy trì điển hình | Tự dùng kết quả đã lưu khi query nguồn |
|---|---|---|---|
| PostgreSQL 17 core | Materialized View | `REFRESH`, tính lại toàn bộ truy vấn | Không tự rewrite sang MV |
| Oracle | Materialized View | Complete hoặc fast refresh; on demand hoặc on commit khi đủ điều kiện | Có query rewrite khi đủ điều kiện và cấu hình |
| SQL Server | Indexed view | Duy trì cùng các thao tác DML lên bảng nguồn | Có thể, phụ thuộc edition, cấu hình và optimizer |
| MySQL 8.4 | Không có MV native | Tự xây summary table và job hoặc pipeline | Không có cơ chế MV native để rewrite |

Trong bảng này:

- **Complete/full refresh** tính lại toàn bộ kết quả định nghĩa.
- **Fast/incremental refresh** cập nhật kết quả dựa trên phần thay đổi, nếu hệ thống hỗ trợ và query đủ điều kiện.
- **Query rewrite** là việc optimizer thay truy vấn nguồn bằng cách đọc kết quả đã tổng hợp phù hợp.
- **DML** là nhóm thao tác thay đổi dữ liệu như `INSERT`, `UPDATE`, `DELETE`.

### 4.3. Oracle và SQL Server chuyển một phần chi phí sang đường ghi

Oracle có thể dùng `REFRESH FAST ON COMMIT` cho MV đủ điều kiện. Khi transaction commit thay đổi các bảng liên quan, database thực hiện công việc duy trì MV theo cấu hình đó.

Fast refresh thường cần **materialized view log**, tức cấu trúc ghi lại thay đổi phục vụ refresh, cùng các điều kiện trên truy vấn định nghĩa. Không phải thêm từ khóa `FAST` là mọi truy vấn đều refresh tăng dần được.

Dùng `DBMS_MVIEW.EXPLAIN_MVIEW` để kiểm tra khả năng của một định nghĩa cụ thể. Nếu muốn query rewrite, kiểm tra thêm cấu hình và khả năng rewrite của truy vấn cần tối ưu.

Với SQL Server, indexed view cần đáp ứng các yêu cầu như:

- Định nghĩa có `WITH SCHEMABINDING`, ràng buộc với schema nguồn.
- Biểu thức phù hợp với yêu cầu deterministic — cùng đầu vào cho cùng đầu ra.
- Tạo unique clustered index đầu tiên trên View.
- Các `SET` option bắt buộc phải đúng, cả ở những session ghi bảng nguồn.
- Với `GROUP BY`, có `COUNT_BIG(*)` và tuân thủ các giới hạn khác.

Indexed view được duy trì khi các bảng nguồn thay đổi. Chi phí này có thể làm thao tác ghi chậm hơn. Khả năng optimizer tự sử dụng indexed view còn phụ thuộc edition; `NOEXPAND` là một hint khi truy vấn, không phải công tắc duy trì dữ liệu.

<Callout type="warn" title="Hai khẳng định không được dùng cho mọi database">

“MV luôn phải refresh bằng cron” chỉ phù hợp với một số cách triển khai. “MV không ảnh hưởng đường ghi” cũng không đúng với indexed view hoặc MV được duy trì lúc commit.

**Luôn chỉ rõ database và cơ chế duy trì đang nói tới.**

</Callout>

### 4.4. MySQL TEMPTABLE không phải Materialized View bền vững

MySQL có các thuật toán xử lý View như `MERGE`, `TEMPTABLE` và `UNDEFINED`.

Với `TEMPTABLE`, kết quả View được đưa vào bảng tạm nội bộ để xử lý statement hiện tại. Đó không phải một MV được lưu để mọi request dùng lại và refresh theo lịch.

Nếu cần hành vi tương tự MV trên MySQL 8.4, bạn thường xây một bảng tổng hợp thông thường. Khi đó, logic refresh, xử lý lỗi và tính nhất quán là trách nhiệm của thiết kế đó.

## 5. Lab PostgreSQL từ đầu đến cuối

Lab dùng schema riêng `mv_view_lab`. Ngày báo cáo được xác định theo **UTC** để kết quả không thay đổi theo timezone của session.

Các đoạn trong phần này chạy theo thứ tự trên database thử nghiệm. Không cần extension. Nếu schema đã tồn tại từ lần chạy trước, dùng bước dọn lab cuối bài sau khi xác nhận đó chỉ là dữ liệu thử nghiệm.

<Steps>
<Step>

### 5.1. Tạo bảng và dữ liệu mẫu

```sql
CREATE SCHEMA mv_view_lab;

CREATE TABLE mv_view_lab.orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL,
    order_at    timestamptz NOT NULL,
    status      text NOT NULL
                CHECK (status IN ('pending', 'paid', 'cancelled')),
    amount      numeric(14, 2) NOT NULL CHECK (amount >= 0)
);

INSERT INTO mv_view_lab.orders
    (customer_id, order_at, status, amount)
VALUES
    (1, '2026-05-01 10:00:00+00', 'paid',    100.00),
    (1, '2026-05-01 10:30:00+00', 'paid',    200.00),
    (2, '2026-05-01 11:00:00+00', 'paid',     50.00),
    (1, '2026-05-02 09:00:00+00', 'pending', 400.00),
    (2, '2026-05-02 10:00:00+00', 'paid',     80.00);
```

<SourceRef project="fundamentals-view-vs-materialized-view" file="51-tạo-bảng-và-dữ-liệu-mẫu/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

Ở đây “doanh thu” là tổng `amount` của các đơn có trạng thái hiện tại là `paid`. Lab không mô hình hóa refund, nhiều loại tiền tệ hoặc thời điểm ghi nhận kế toán.

</Step>
<Step>

### 5.2. Tạo View và MV cùng logic

```sql
CREATE VIEW mv_view_lab.v_daily_revenue AS
SELECT
    customer_id,
    (order_at AT TIME ZONE 'UTC')::date AS order_day,
    COUNT(*) AS order_count,
    SUM(amount) AS revenue
FROM mv_view_lab.orders
WHERE status = 'paid'
GROUP BY customer_id, (order_at AT TIME ZONE 'UTC')::date;

CREATE MATERIALIZED VIEW mv_view_lab.mv_daily_revenue AS
SELECT customer_id, order_day, order_count, revenue
FROM mv_view_lab.v_daily_revenue
WITH DATA;

CREATE UNIQUE INDEX mv_daily_revenue_customer_day_uq
ON mv_view_lab.mv_daily_revenue (customer_id, order_day);

ANALYZE mv_view_lab.orders;
ANALYZE mv_view_lab.mv_daily_revenue;
```

<SourceRef project="fundamentals-view-vs-materialized-view" file="52-tạo-view-và-mv-cùng-logic/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

MV có thể lấy nguồn từ một View. Trong lab, cách này giúp chỉ định nghĩa phép tổng hợp tại một nơi. Nó cũng tạo dependency: MV phụ thuộc vào View nguồn.

Index unique dùng đúng grain `(customer_id, order_day)`. Hai thành phần này không có `NULL` trong dữ liệu kết quả vì các cột nguồn tương ứng là `NOT NULL`.

Index này vừa có thể hỗ trợ truy vấn theo khách hàng và ngày, vừa đáp ứng điều kiện unique index cho concurrent refresh ở phần sau.

</Step>
<Step>

### 5.3. Quan sát kết quả trước và sau khi ghi dữ liệu

```sql
SELECT 'view' AS source, order_count, revenue
FROM mv_view_lab.v_daily_revenue
WHERE customer_id = 1 AND order_day = DATE '2026-05-01'
UNION ALL
SELECT 'mv' AS source, order_count, revenue
FROM mv_view_lab.mv_daily_revenue
WHERE customer_id = 1 AND order_day = DATE '2026-05-01'
ORDER BY source;
```

Cả hai cùng trả về `order_count = 2`, `revenue = 300.00`.

Thêm một đơn mới và commit:

```sql
BEGIN;

INSERT INTO mv_view_lab.orders
    (customer_id, order_at, status, amount)
VALUES
    (1, '2026-05-01 12:00:00+00', 'paid', 70.00);

COMMIT;
```

Chạy lại truy vấn so sánh ở trên trong một statement mới, với `READ COMMITTED`:

| Nguồn | order_count | revenue |
|---|---:|---:|
| `view` | 3 | 370.00 |
| `mv` | 2 | 300.00 |

Không có lỗi đồng bộ bí ẩn: MV chưa được refresh.

</Step>
<Step>

### 5.4. Refresh rồi đối chiếu lại

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY
    mv_view_lab.mv_daily_revenue;

SELECT 'view' AS source, order_count, revenue
FROM mv_view_lab.v_daily_revenue
WHERE customer_id = 1 AND order_day = DATE '2026-05-01'
UNION ALL
SELECT 'mv' AS source, order_count, revenue
FROM mv_view_lab.mv_daily_revenue
WHERE customer_id = 1 AND order_day = DATE '2026-05-01'
ORDER BY source;
```

Bây giờ cả hai trả về `order_count = 3`, `revenue = 370.00`.

`CONCURRENTLY` cho phép các `SELECT` thông thường tiếp tục đọc MV trong lúc refresh. Nó không biến truy vấn tổng hợp thành refresh tăng dần.

</Step>
<Step>

### 5.5. Thử WITH NO DATA và bootstrap lần đầu

Bạn có thể tạo định nghĩa MV mà chưa chạy truy vấn để đổ dữ liệu:

```sql
CREATE MATERIALIZED VIEW mv_view_lab.mv_lazy AS
SELECT customer_id, order_day, order_count, revenue
FROM mv_view_lab.v_daily_revenue
WITH NO DATA;

CREATE UNIQUE INDEX mv_lazy_customer_day_uq
ON mv_view_lab.mv_lazy (customer_id, order_day);
```

MV lúc này ở trạng thái **unpopulated** — chưa được đổ dữ liệu và chưa thể quét. Đây không phải MV hợp lệ có 0 dòng.

Hai lệnh sau được minh họa dưới dạng comment vì chúng **cố ý gây lỗi**:

```sql
-- SELECT * FROM mv_view_lab.mv_lazy;
-- ERROR: materialized view "mv_lazy" has not been populated

-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_view_lab.mv_lazy;
-- ERROR: CONCURRENTLY cannot be used when the materialized view is not populated
```

Lần đầu cần refresh thường. Từ lần sau mới dùng concurrent refresh:

```sql
REFRESH MATERIALIZED VIEW mv_view_lab.mv_lazy;

SELECT COUNT(*) FROM mv_view_lab.mv_lazy;
-- 3 nhóm trong dữ liệu mẫu, nếu chưa chạy phần benchmark.

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_view_lab.mv_lazy;
```

</Step>
</Steps>

<Callout type="warn" title="Không dùng WITH NO DATA để giữ bản cũ">

`REFRESH MATERIALIZED VIEW ... WITH NO DATA` loại bỏ dữ liệu hiện có và làm MV không thể truy vấn cho tới lần populate tiếp theo. Nó không phải cách trì hoãn refresh trong khi tiếp tục phục vụ bản cũ.

</Callout>

## 6. Hiệu năng và cách đo đúng

### 6.1. MV có thể tiết kiệm những bước nào

Với truy vấn doanh thu, plan qua View có thể có dạng:

```d2 title="Truy vấn báo cáo từ nguồn"
direction: right
n0: "Đọc orders phù hợp"
n1: "Nhóm theo customer_id và order_day"
n2: "Tính COUNT và SUM"
n3: "Trả kết quả"
n0 -> n1 -> n2 -> n3
```

Plan qua MV có thể có dạng:

```d2 title="Truy vấn báo cáo từ MV"
direction: right
n0: "Đọc mv_daily_revenue phù hợp"
n1: "Trả kết quả"
n0 -> n1
```

Đây là sơ đồ các bước, **không phải output benchmark thực tế**. Planner có thể chọn index scan, bitmap scan hoặc sequential scan tùy dữ liệu và điều kiện.

MV thường có lợi khi nó loại bỏ công việc đắt như tổng hợp nhiều dòng, join nhiều bảng hoặc truy cập nguồn từ xa. Nhưng một MV lớn, index không phù hợp hoặc truy vấn trả gần hết dữ liệu vẫn có thể chậm.

### 6.2. Benchmark phải so cùng logic và cùng dữ liệu

Có thể mở rộng lab bằng dữ liệu tổng hợp. Đoạn này thêm 500.000 đơn, nên chỉ chạy trên database thử nghiệm:

```sql
INSERT INTO mv_view_lab.orders
    (customer_id, order_at, status, amount)
SELECT
    (g % 1000) + 1,
    TIMESTAMPTZ '2026-05-01 00:00:00+00'
        + ((g / 1000) % 30) * INTERVAL '1 day'
        + (g % 86400) * INTERVAL '1 second',
    CASE WHEN g % 5 = 0 THEN 'pending' ELSE 'paid' END,
    ((g % 10000) + 1)::numeric / 100
FROM generate_series(1, 500000) AS s(g);
```

Cho phương án View một index phù hợp, thay vì so MV có index với bảng nguồn chưa tối ưu:

```sql
CREATE INDEX orders_paid_customer_day_idx
ON mv_view_lab.orders (
    customer_id,
    ((order_at AT TIME ZONE 'UTC')::date)
)
INCLUDE (amount)
WHERE status = 'paid';

ANALYZE mv_view_lab.orders;

REFRESH MATERIALIZED VIEW mv_view_lab.mv_daily_revenue;
ANALYZE mv_view_lab.mv_daily_revenue;
```

Index biểu thức ở đây khớp cách tính ngày UTC trong View. `INCLUDE (amount)` lưu thêm giá trị cần cho phép cộng trong index. Việc có thể tránh đọc bảng hoàn toàn còn phụ thuộc visibility và plan được chọn.

Đo hai truy vấn:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT order_day, order_count, revenue
FROM mv_view_lab.v_daily_revenue
WHERE customer_id = 42
  AND order_day >= DATE '2026-05-01'
  AND order_day < DATE '2026-05-08'
ORDER BY order_day;

EXPLAIN (ANALYZE, BUFFERS)
SELECT order_day, order_count, revenue
FROM mv_view_lab.mv_daily_revenue
WHERE customer_id = 42
  AND order_day >= DATE '2026-05-01'
  AND order_day < DATE '2026-05-08'
ORDER BY order_day;
```

`ANALYZE` trong `EXPLAIN` thực sự chạy truy vấn. `BUFFERS` cho biết các block dữ liệu được chạm tới, đọc từ cache hoặc cần đọc vào cache.

Ghi lại:

- `Execution Time`, số dòng và các bước trong plan.
- Block `shared hit`, `shared read`, và temp I/O nếu có.
- Thời gian refresh thường và concurrent refresh.
- Dung lượng MV và các index.
- Độ trễ của truy vấn nghiệp vụ khác khi refresh đang chạy.

Chạy nhiều lần để tách ảnh hưởng **warm cache**, tức dữ liệu đã có trong bộ nhớ, khỏi lần đọc đầu. Với production, cần đo thêm dưới tải đồng thời thay vì chỉ nhìn một lần chạy đơn lẻ.

Dữ liệu sinh ở lab chỉ nhằm minh họa cách đo. Nó có phân bố đơn giản và tương quan nhân tạo, không đại diện cho dữ liệu thực tế của mọi hệ thống.

### 6.3. Tính cả refresh vào tổng chi phí

Giả sử trong cùng một khoảng thời gian:

- `Q`: số lần đọc báo cáo.
- `R`: số lần refresh.
- `C_base`: chi phí mỗi lần đọc và tính trực tiếp từ nguồn.
- `C_mv`: chi phí mỗi lần đọc MV.
- `C_refresh`: chi phí mỗi lần refresh.

Mô hình đơn giản là:

```text
Không dùng MV: Q × C_base
Dùng MV:      Q × C_mv + R × C_refresh
```

MV đáng cân nhắc về chi phí khi:

```text
Q × (C_base - C_mv) > R × C_refresh
```

Các chi phí phải được đo bằng đơn vị có thể so sánh. Cộng thời gian chạy đơn lẻ chỉ là một ước lượng sơ bộ, không mô hình hóa hết cache, song song và tranh chấp tài nguyên.

Ví dụ **giả định**, không phải benchmark: mỗi lần đọc trực tiếp tốn 200 đơn vị, đọc MV tốn 5, một refresh tốn 10.000. Với một lần refresh, cần khoảng 52 lần đọc để bù được chi phí refresh trong mô hình này.

Nhưng ngay cả khi tổng chi phí tăng, bạn vẫn có thể chọn MV để đáp ứng độ trễ đọc của dashboard. Ngược lại, tổng chi phí giảm chưa đủ nếu MV làm nghiệp vụ dùng dữ liệu quá cũ.

**Đánh giá đồng thời ba thứ: độ trễ đọc, tổng tài nguyên và độ mới dữ liệu.**

## 7. Full refresh và incremental refresh

### 7.1. PostgreSQL core tính lại truy vấn định nghĩa

Trong PostgreSQL 17 core, cả hai lệnh sau đều chạy lại truy vấn nguồn:

```sql
REFRESH MATERIALIZED VIEW mv_view_lab.mv_daily_revenue;

REFRESH MATERIALIZED VIEW CONCURRENTLY
    mv_view_lab.mv_daily_revenue;
```

Refresh thường tạo dữ liệu thay thế cho MV. Concurrent refresh cũng tính một bộ kết quả mới, sau đó đối chiếu với kết quả cũ để áp dụng khác biệt.

Dù chỉ thêm một đơn hàng, phần truy vấn nguồn vẫn phải được thực thi theo định nghĩa. Nó không tự hiểu rằng chỉ cần tăng doanh thu của một nhóm thêm 70.

<Callout type="warn" title="CONCURRENTLY không có nghĩa là incremental">

`CONCURRENTLY` chủ yếu thay đổi cách cho phép đọc MV và cách áp dụng kết quả refresh. Nó không cung cấp incremental view maintenance cho truy vấn nguồn trong PostgreSQL core.

</Callout>

### 7.2. Incremental refresh cần hiểu đủ các dạng thay đổi

Với một đơn đã thanh toán trị giá 70, thay đổi cần áp dụng không phải lúc nào cũng là “cộng 70”:

| Thay đổi nguồn | Điều chỉnh nhóm tổng hợp |
|---|---|
| Thêm đơn `paid` trị giá 70 | Tăng tổng 70, tăng số đơn 1 |
| Sửa tiền từ 70 thành 90 | Tăng tổng thêm 20 |
| Chuyển `paid` thành `cancelled` | Giảm tổng 70, giảm số đơn 1 |
| Xóa đơn `paid` | Loại đóng góp của đơn đó |
| Đổi khách hàng hoặc ngày của đơn `paid` | Trừ nhóm cũ và cộng nhóm mới |
| Đổi thuộc tính ở bảng được join | Có thể ảnh hưởng nhiều dòng hoặc nhiều nhóm |

Một pipeline tự xây thường dùng trigger hoặc **CDC**, tức cơ chế thu thập thay đổi từ database để xử lý ở hệ thống khác.

Nếu có retry, cần **idempotency** — xử lý lại cùng một sự kiện không làm cộng hoặc trừ thêm lần nữa. Ví dụ: ghi nhận `event_id` đã xử lý và cập nhật summary trong cùng một transaction.

Ngoài ra còn cần giải quyết thứ tự sự kiện, mất sự kiện, backfill và đối chiếu với nguồn. Đó là một hệ thống duy trì dữ liệu, không chỉ là câu `UPDATE summary SET revenue = revenue + 70`.

**Nếu cần incremental trên PostgreSQL, hãy đánh giá extension hoặc summary table cùng pipeline cụ thể. Không giả định MV core đã có chức năng đó.**

### 7.3. Chọn các đại lượng có thể tổng hợp lại

Một MV theo ngày có thể phục vụ báo cáo theo tháng nếu lưu đủ thông tin.

Với lab, `amount` luôn khác `NULL`, nên `order_count` chính là số giá trị tham gia `SUM(amount)`. Có thể tính giá trị đơn trung bình theo tháng như sau:

```sql
SELECT
    customer_id,
    date_trunc('month', order_day::timestamp)::date AS order_month,
    SUM(revenue) AS monthly_revenue,
    SUM(order_count) AS monthly_order_count,
    SUM(revenue) / NULLIF(SUM(order_count), 0) AS avg_order_amount
FROM mv_view_lab.mv_daily_revenue
GROUP BY customer_id,
         date_trunc('month', order_day::timestamp)::date;
```

Không dùng `AVG` của các giá trị trung bình theo ngày. Một ngày có 1 đơn và một ngày có 100 đơn không được mang cùng trọng số.

| Đại lượng | Thông tin cần để tổng hợp lại hoặc duy trì |
|---|---|
| `SUM` | Tổng của các nhóm con |
| `COUNT` | Số lượng của các nhóm con |
| `AVG` | Tổng và số giá trị khác `NULL` |
| `MIN` hoặc `MAX` | Có thể cần đọc lại nguồn khi giá trị cực trị bị xóa |
| `COUNT(DISTINCT ...)` | Không thể cộng tùy ý số distinct của các nhóm có phần tử trùng nhau |

Ví dụ một khách hàng mua trong hai ngày vẫn chỉ là một khách hàng distinct của cả tháng. Cộng distinct theo ngày sẽ đếm khách hàng đó hai lần.

## 8. Concurrent refresh và locking trong PostgreSQL

### 8.1. Refresh thường và refresh concurrent

| Điểm so sánh | Refresh thường | Refresh với `CONCURRENTLY` |
|---|---|---|
| `SELECT` thông thường trên MV | Có thể bị chặn trong lúc refresh | Được phép tiếp tục đọc |
| Relation lock chính trên MV | `AccessExclusiveLock` | `ExclusiveLock`, tương thích với lock đọc thông thường |
| Unique index bắt buộc | Không | Có, đáp ứng điều kiện ở phần sau |
| MV phải populated trước | Không | Có |
| Kết hợp `WITH NO DATA` | Được | Không được |
| Công việc trên nguồn | Chạy lại truy vấn định nghĩa | Chạy lại truy vấn định nghĩa |
| Áp dụng kết quả | Thay thế dữ liệu vật lý | Đối chiếu và áp dụng khác biệt |
| Tài nguyên và thời gian | Thường thuận lợi khi thay đổi nhiều dòng | Có thêm công việc đối chiếu; cần đo |

Tên `ExclusiveLock` không có nghĩa chặn mọi `SELECT`. Các lock mode của PostgreSQL có ma trận tương thích riêng.

Concurrent refresh cũng không có nghĩa “không lock”. Nó vẫn phải đồng bộ với refresh khác và một số thao tác DDL. **DDL** là nhóm lệnh thay đổi cấu trúc như `ALTER` hoặc `DROP`.

### 8.2. Điều kiện của unique index

Để dùng `REFRESH ... CONCURRENTLY`, PostgreSQL yêu cầu có ít nhất một unique index phù hợp:

- Index dùng cột của MV, không phải expression index.
- Index bao phủ tất cả các dòng, không có điều kiện `WHERE`.
- Index phải hợp lệ để PostgreSQL sử dụng.
- MV đã được populate.

Ví dụ trong lab:

```sql
CREATE UNIQUE INDEX mv_daily_revenue_customer_day_uq
ON mv_view_lab.mv_daily_revenue (customer_id, order_day);
```

Index này đã được tạo ở phần lab; không chạy lại lệnh nếu nó còn tồn tại.

Unique index chỉ áp dụng cho “7 ngày gần đây” không đáp ứng điều kiện. Index unique trên một biểu thức ghép chuỗi các cột cũng không đáp ứng điều kiện.

Nên chọn một khóa ổn định, có ý nghĩa theo grain và không có `NULL`. Tính không `NULL` là khuyến nghị thiết kế ở đây, không phải một điều kiện cú pháp riêng bắt buộc của lệnh refresh.

### 8.3. Quan sát lock bằng hai session

Trong **session A**, giữ transaction đọc mở khoảng 15 giây:

```sql
BEGIN;
SELECT COUNT(*) FROM mv_view_lab.mv_daily_revenue;
SELECT pg_sleep(15);
COMMIT;
```

Trong lúc A chưa commit, thử một trong hai phương án dưới đây ở **session B**:

<Tabs items={['Refresh thường', 'Concurrent refresh']}>
<Tab value="Refresh thường">

```sql
SET lock_timeout = '1s';
REFRESH MATERIALIZED VIEW mv_view_lab.mv_daily_revenue;
RESET lock_timeout;
```

Refresh thường cần lock không tương thích với lock đọc đang được A giữ. Nếu A vẫn chưa commit sau thời gian chờ, B nhận lỗi `lock_timeout`.

</Tab>
<Tab value="Concurrent refresh">

```sql
SET lock_timeout = '1s';
REFRESH MATERIALIZED VIEW CONCURRENTLY
    mv_view_lab.mv_daily_revenue;
RESET lock_timeout;
```

Lock đọc của A không tự chặn concurrent refresh. B có thể hoàn thành nếu không có blocker khác hoặc lỗi khác.

</Tab>
</Tabs>

Các đoạn session B dùng autocommit. Nếu tự bọc chúng trong transaction và gặp lỗi, cần `ROLLBACK` trước khi tiếp tục.

### 8.4. Công bố dữ liệu mới và refresh chồng nhau

Với concurrent refresh, các `SELECT` thông thường không đọc một kết quả bị cập nhật dở dang. Thay đổi của refresh chỉ được công bố khi transaction refresh commit.

Ở `READ COMMITTED`, một statement đang đọc vẫn tuân theo snapshot của nó. Statement mới sau commit có thể thấy bộ kết quả mới. Transaction giữ snapshot lâu có thể tiếp tục nhìn dữ liệu cũ.

PostgreSQL chỉ cho một refresh chạy tại một thời điểm trên cùng một MV. Nếu nhiều job gửi lệnh, các lệnh có thể xếp hàng chờ thay vì làm MV mới hơn nhanh hơn.

**Thiết kế scheduler để bỏ qua hoặc gộp lượt chạy thừa, không để hàng đợi refresh tích lũy vô hạn.**

<Callout type="info" title="Concurrent refresh được phép ở trong transaction">

`REFRESH MATERIALIZED VIEW CONCURRENTLY` có thể chạy trong `BEGIN` / `COMMIT`. Đừng nhầm với giới hạn của `CREATE INDEX CONCURRENTLY`, vốn không được chạy trong transaction block.

</Callout>

## 9. Độ mới dữ liệu và tính nhất quán

### 9.1. Refresh thành công không đồng nghĩa dữ liệu mới tới lúc kết thúc

Xét lịch **giả định**:

```d2 title="Mốc đọc nguồn khác mốc công bố MV"
direction: down
n0: "10:00 — refresh bắt đầu đọc theo snapshot"
n1: "10:01 — đơn mới được commit, ngoài\nsnapshot đó"
n2: "10:02 — refresh công bố kết quả đầu"
n3: "10:05 — refresh tiếp theo bắt đầu"
n4: "10:07 — công bố kết quả tiếp theo"
n0 -> n1
n1 -> n2
n2 -> n3
n3 -> n4
```

Đây là lịch giả định, không biểu diễn khoảng cách thời gian theo tỷ lệ. Đơn commit 10:01 không tự xuất hiện trong snapshot nguồn đã lấy trước đó.

Đơn commit lúc 10:01 không nằm trong snapshot nguồn của lần refresh đầu. Dù dashboard thấy “refreshed at 10:02”, đơn đó chỉ xuất hiện sau lần refresh tiếp theo.

Có hai mốc khác nhau:

- **Thời điểm đọc nguồn**: kết quả phản ánh góc nhìn nguồn của lần refresh.
- **Thời điểm công bố thành công**: người đọc có thể bắt đầu thấy kết quả mới.

Với các bảng PostgreSQL cục bộ, truy vấn nguồn dùng snapshot và quy tắc isolation của transaction. Với nguồn từ xa qua foreign data wrapper, cần kiểm tra thêm mức bảo đảm của hệ thống nguồn; không mặc định có snapshot toàn cục giữa nhiều database.

### 9.2. Lịch chạy không phải cam kết độ trễ

Giả sử job được lên lịch bắt đầu mỗi `P` phút và mỗi lượt mất tối đa `D` phút. Khi các job đều thành công và không xếp hàng, độ cũ của snapshot ngay trước lượt công bố kế tiếp có thể xấp xỉ `P + D`.

Nếu còn chậm lịch hoặc chờ lock, cộng thêm phần trễ đó. Nếu job lỗi mà không phục hồi, độ cũ có thể tăng không giới hạn.

Vì vậy một yêu cầu **freshness SLO** — mục tiêu vận hành về độ mới — nên viết cụ thể, ví dụ:

> Báo cáo phản ánh các thay đổi đã commit vào bảng nguồn trong vòng tối đa 10 phút, trong điều kiện vận hành bình thường; cảnh báo khi không đạt mục tiêu.

Để đáp ứng, đo cả thời gian refresh, độ trễ scheduler và tuổi dữ liệu đang phục vụ. Không chỉ kiểm tra “cron vẫn chạy”.

### 9.3. Event time không phải mốc dữ liệu đã đồng bộ

Một đơn có `order_at = '2026-05-01'` có thể được nhập bổ sung vào database ngày 10/5. Đây là dữ liệu đến muộn.

`MAX(order_at)` trong MV không chứng minh rằng mọi đơn trước mốc đó đã có trong kết quả. Nó cũng không phát hiện việc hủy một đơn cũ.

Nếu pipeline có **watermark**, tức mốc tiến độ nguồn đã được xử lý, watermark phải gắn với quy tắc ingestion hoặc log thay đổi của pipeline. Nó không tự xuất hiện chỉ vì MV có cột thời gian.

**Tách ba thứ:** thời gian nghiệp vụ của dữ liệu, tiến độ nhập dữ liệu và thời điểm refresh MV.

### 9.4. Nhiều MV có thể lệch phiên bản

Giả sử phần trăm doanh thu được tính từ:

```text
MV_A: doanh thu của một nhóm khách hàng
MV_B: tổng doanh thu của toàn bộ khách hàng
```

Nếu A và B refresh ở các thời điểm nguồn khác nhau, tỷ lệ có thể không khớp. Bọc hai refresh trong một transaction ở `READ COMMITTED` giúp công bố cùng commit, nhưng mỗi statement vẫn có thể lấy snapshot nguồn khác nhau.

Nếu cần cùng góc nhìn cho các nguồn PostgreSQL cục bộ, có thể thiết kế một transaction `REPEATABLE READ` refresh các MV theo thứ tự phù hợp. Cần kiểm thử locking, thời gian transaction và cơ chế retry của thiết kế đó.

Nếu MV_B lấy dữ liệu từ MV_A, refresh A trước B. Refresh B không tự kéo theo refresh A.

**Kết luận:** đồng thời công bố và đồng nhất snapshot là hai yêu cầu khác nhau. Nhiều báo cáo cần cả hai.

### 9.5. Kết hợp lịch sử bằng MV và dữ liệu mới bằng View

Một thiết kế có thể dùng MV cho các ngày đã chốt, và View cho phần mới:

```sql
-- Ví dụ cutoff cố định cho một lần công bố báo cáo.
SELECT customer_id, order_day, order_count, revenue
FROM mv_view_lab.mv_daily_revenue
WHERE order_day < DATE '2026-05-02'
UNION ALL
SELECT customer_id, order_day, order_count, revenue
FROM mv_view_lab.v_daily_revenue
WHERE order_day >= DATE '2026-05-02';
```

Hai điều kiện không chồng lấn nên không tự đếm hai lần một nhóm ngày. Tuy nhiên, phần lịch sử vẫn có thể sai so với hiện tại nếu có đơn nhập muộn, hủy đơn hoặc sửa tiền ở ngày đã chốt.

Dùng cách này khi có quy tắc chốt dữ liệu rõ ràng hoặc cơ chế tính lại lịch sử. Cutoff phải được quản lý cùng phiên bản dữ liệu, không tùy ý trôi theo `CURRENT_DATE` trong khi MV chưa được cập nhật tương ứng.

## 10. Vận hành MV trong production

### 10.1. Job refresh cần một chủ sở hữu và hợp đồng rõ ràng

Trước khi lên lịch, xác định:

- Ai chịu trách nhiệm khi refresh lỗi hoặc dữ liệu quá cũ.
- Lịch chạy, timeout và chính sách bỏ qua lượt chạy chồng nhau.
- Refresh thường hay concurrent; có chấp nhận chặn người đọc hay không.
- Những MV phụ thuộc phải refresh theo thứ tự nào.
- Chỉ số nào phát cảnh báo và hành động khi cảnh báo xảy ra.

Bạn có thể dùng scheduler của ứng dụng, cron của hệ điều hành hoặc extension như `pg_cron`. PostgreSQL core không tự refresh MV định kỳ chỉ vì đã tạo đối tượng.

### 10.2. Ghi metadata thành công cùng transaction với refresh

Bảng trạng thái dưới đây là ví dụ tối thiểu, có thể thử tiếp trong lab:

```sql
CREATE TABLE mv_view_lab.refresh_state (
    job_name                   text PRIMARY KEY,
    last_success_started_at    timestamptz,
    last_success_completed_at  timestamptz,
    success_count              bigint NOT NULL DEFAULT 0
);

INSERT INTO mv_view_lab.refresh_state (job_name)
VALUES ('mv_daily_revenue');
```

Script dưới đây dành cho **psql**, không gửi nguyên văn qua driver SQL vì có các lệnh `\gset`, `\if` và `\echo` của psql:

```sql
\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Chọn namespace/key riêng và dùng thống nhất ở mọi worker.
SELECT pg_try_advisory_xact_lock(81731, 1) AS got_refresh_lock
\gset

\if :got_refresh_lock
    -- Chưa công bố mốc thành công: thay đổi này còn trong transaction.
    UPDATE mv_view_lab.refresh_state
    SET last_success_started_at = clock_timestamp()
    WHERE job_name = 'mv_daily_revenue';

    REFRESH MATERIALIZED VIEW CONCURRENTLY
        mv_view_lab.mv_daily_revenue;

    UPDATE mv_view_lab.refresh_state
    SET last_success_completed_at = clock_timestamp(),
        success_count = success_count + 1
    WHERE job_name = 'mv_daily_revenue';
\else
    \echo 'Skipped: another cooperating worker is refreshing this MV.'
\endif

COMMIT;
```

<SourceRef project="fundamentals-view-vs-materialized-view" file="102-ghi-metadata-thành-công-cùng-transaction-với-refresh/2.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

**Advisory lock** là lock do ứng dụng tự quy ước để phối hợp công việc. `pg_try_advisory_xact_lock` không chờ nếu lock đã được giữ, và tự giải phóng ở cuối transaction.

Nếu refresh thất bại, transaction rollback. Mốc thành công cũ được giữ nguyên. Nếu script thành công, dữ liệu MV và metadata được công bố trong cùng một commit.

`last_success_started_at` được lấy ngay trước lệnh refresh. Nó là mốc khởi đầu bảo thủ để ước lượng độ cũ, **không phải timestamp chính xác của snapshot nội bộ**. Nếu phải chờ lock, snapshot nguồn thực tế có thể được lấy muộn hơn.

`last_success_completed_at` được ghi trước `COMMIT`; nó cũng không phải thời điểm commit chính xác. Giữ phần sau refresh ngắn để khoảng chênh lệch nhỏ.

<Callout type="warn" title="Script thành công không có nghĩa một refresh mới vừa chạy">

Nhánh không lấy được advisory lock chủ động bỏ qua lượt chạy và vẫn kết thúc thành công. Scheduler cần phân biệt **success**, **skipped** và **failed** qua log hoặc metric.

Các job không tuân theo cùng advisory key vẫn có thể gửi refresh. Database tiếp tục bảo vệ bằng lock riêng, nhưng chính sách bỏ qua của ứng dụng không áp dụng cho chúng.

</Callout>

Với worker dùng driver, thực hiện cùng transaction nhưng đọc kết quả boolean bằng code ứng dụng. Nếu gặp lỗi, rollback transaction trước khi tái sử dụng connection trong pool.

### 10.3. Theo dõi tuổi dữ liệu và lỗi refresh

Một truy vấn theo dõi tối thiểu:

```sql
SELECT
    job_name,
    last_success_started_at,
    last_success_completed_at,
    clock_timestamp() - last_success_started_at AS estimated_source_age,
    last_success_completed_at - last_success_started_at AS refresh_duration,
    success_count,
    CASE
        WHEN last_success_completed_at IS NULL THEN 'never_refreshed'
        WHEN clock_timestamp() - last_success_started_at
             > INTERVAL '10 minutes' THEN 'stale'
        ELSE 'within_target'
    END AS freshness_status
FROM mv_view_lab.refresh_state;
```

Mốc 10 phút là ví dụ yêu cầu, không phải mặc định phù hợp cho mọi hệ thống. Tuổi tính từ thời điểm bắt đầu phản ánh độ cũ tốt hơn chỉ tính từ lúc kết thúc.

Bảng ví dụ chỉ lưu trạng thái thành công. Attempt thất bại bị rollback cùng transaction, nên phải ghi lỗi, số lần retry và lượt bị bỏ qua ở log hoặc hệ thống giám sát bên ngoài transaction đó.

Trong `pg_matviews`, `ispopulated = true` chỉ cho biết MV đã có thể quét. Nó không chứng minh dữ liệu còn mới:

```sql
SELECT schemaname, matviewname, ispopulated, hasindexes
FROM pg_matviews
WHERE schemaname = 'mv_view_lab';
```

### 10.4. Theo dõi lock và ngân sách tài nguyên

Quan sát relation lock đang giữ hoặc chờ trên MV:

```sql
SELECT
    a.pid,
    l.mode,
    l.granted,
    a.state,
    a.wait_event_type,
    a.wait_event,
    clock_timestamp() - a.query_start AS query_age,
    pg_blocking_pids(a.pid) AS blocking_pids
FROM pg_locks AS l
JOIN pg_stat_activity AS a ON a.pid = l.pid
WHERE l.locktype = 'relation'
  AND l.relation = 'mv_view_lab.mv_daily_revenue'::regclass;
```

Quan sát storage:

```sql
SELECT
    pg_size_pretty(pg_relation_size(
        'mv_view_lab.mv_daily_revenue')) AS data_size,
    pg_size_pretty(pg_indexes_size(
        'mv_view_lab.mv_daily_revenue')) AS index_size,
    pg_size_pretty(pg_total_relation_size(
        'mv_view_lab.mv_daily_revenue')) AS total_size;
```

Trong refresh, có thể cần đồng thời giữ dữ liệu cũ, dữ liệu mới và không gian làm việc. Không dự toán disk chỉ bằng kích thước MV sau khi chạy xong.

Ngoài disk, theo dõi CPU, I/O, temp file, WAL và replication lag. **WAL** là log phục vụ khôi phục và sao chép thay đổi. Refresh có thể gây áp lực lên các hệ thống đó dù người đọc MV không bị chặn.

### 10.5. Statistics và dọn phiên bản cũ

Sau thay đổi lớn về phân bố hoặc số dòng, thu thập lại statistics:

```sql
ANALYZE mv_view_lab.mv_daily_revenue;
```

Concurrent refresh áp dụng các thay đổi lên dữ liệu lưu, nên có thể tạo phiên bản dòng cũ cần dọn. Kiểm tra autovacuum thay vì mặc định MV không cần bảo trì.

Khi phù hợp, có thể chạy:

```sql
VACUUM (ANALYZE) mv_view_lab.mv_daily_revenue;
```

`VACUUM` chạy ngoài transaction block. Không chèn lệnh này vào giữa script `BEGIN` / `COMMIT` ở trên.

Không bắt buộc chạy full vacuum hay analyze sau mọi refresh nhỏ. **Dựa vào statistics, mức thay đổi và số liệu giám sát để chọn lịch bảo trì.**

### 10.6. Thay đổi định nghĩa mà vẫn có đường rollback

PostgreSQL không có `CREATE OR REPLACE MATERIALIZED VIEW` tương đương View thông thường. Một thay đổi lớn nên triển khai theo kiểu phiên bản hóa:

<Steps>
<Step>

Tạo MV phiên bản mới với tên khác, ví dụ `mv_daily_revenue_v2`. Thiết lập các index, ownership và quyền cần thiết.

</Step>
<Step>

Populate phiên bản mới bằng refresh thường nếu nó được tạo với `WITH NO DATA`. Đo tài nguyên và đối chiếu kết quả trước khi đưa vào phục vụ.

</Step>
<Step>

Chuyển một View giao diện ổn định sang đọc MV mới bằng `CREATE OR REPLACE VIEW`, nếu hợp đồng cột vẫn tương thích. Hoặc triển khai ứng dụng đọc tên mới.

</Step>
<Step>

Cập nhật job refresh và giám sát sang phiên bản mới. Giữ MV cũ và kế hoạch duy trì nó trong cửa sổ rollback.

</Step>
<Step>

Chỉ xóa phiên bản cũ sau khi đã xác nhận không còn dependency và hết thời gian rollback.

</Step>
</Steps>

Ví dụ tạo lớp giao diện ổn định cho bản đầu trong lab:

```sql
CREATE VIEW mv_view_lab.daily_revenue_api AS
SELECT customer_id, order_day, order_count, revenue
FROM mv_view_lab.mv_daily_revenue;
```

Khi đã có bản v2, thay định nghĩa của View giao diện để trỏ tới v2. Hợp đồng cột, quyền trên MV mới và thời gian chờ DDL đều cần kiểm tra.

**Chỉ rename hai MV chưa đủ để đổi dependency của View hiện có.** PostgreSQL liên kết đối tượng theo định danh nội bộ, không phải luôn tra lại bằng tên trong mỗi request.

Không dùng `DROP ... CASCADE` như một cách migration tiện lợi trên production. Nó có thể xóa các đối tượng phụ thuộc mà ứng dụng vẫn cần.

## 11. Quyền truy cập và khả năng ghi

### 11.1. Một số View cho phép ghi xuống bảng nguồn

View đơn giản trên một bảng có thể tự động cho phép ghi trong PostgreSQL:

```sql
CREATE VIEW mv_view_lab.v_paid_orders AS
SELECT id, customer_id, order_at, status, amount
FROM mv_view_lab.orders
WHERE status = 'paid'
WITH CASCADED CHECK OPTION;
```

Ví dụ sau sửa `amount` ở bảng `orders`, không sửa một bộ dữ liệu riêng của View. Dùng rollback để không làm thay đổi kết quả lab:

```sql
BEGIN;

UPDATE mv_view_lab.v_paid_orders
SET amount = 250.00
WHERE id = 2;

ROLLBACK;
```

`WITH CHECK OPTION` yêu cầu dữ liệu mới vẫn thỏa điều kiện View. Ví dụ đổi `status` của một dòng sang `cancelled` qua View trên sẽ bị từ chối:

```sql
-- Cố ý gây lỗi nếu bỏ comment:
-- UPDATE mv_view_lab.v_paid_orders
-- SET status = 'cancelled'
-- WHERE id = 2;
```

Không có `CHECK OPTION`, một View có thể cho phép cập nhật khiến dòng vừa sửa không còn xuất hiện qua View.

View có `GROUP BY` như `v_daily_revenue` không tự động updatable. Một số View phức tạp có thể được lập trình cách ghi bằng `INSTEAD OF` trigger; đó là logic riêng cần thiết kế, không phải thuộc tính mặc định của mọi View.

### 11.2. Quyền của người đọc và quyền của người refresh là hai việc

Trong PostgreSQL, quyền trên bảng nguồn qua View thường được kiểm tra theo owner của View. Từ PostgreSQL 15, View có thể dùng `security_invoker = true` để kiểm tra theo người thực hiện truy vấn.

Chọn cơ chế theo hợp đồng truy cập. Không bật `security_invoker` rồi mặc định người dùng không cần quyền trên bảng nguồn nữa.

Với MV, người đọc nhận dữ liệu đã lưu. User chạy refresh không nhất thiết chính là user đọc báo cáo. Trong PostgreSQL 17, có thể cấp quyền `MAINTAIN` cho role refresh; phiên bản cũ hơn có yêu cầu quyền khác.

Ví dụ dưới đây giả định các role đã tồn tại:

```sql
GRANT USAGE ON SCHEMA mv_view_lab TO reporting_reader, refresh_worker;

GRANT SELECT ON mv_view_lab.mv_daily_revenue TO reporting_reader;

GRANT MAINTAIN ON mv_view_lab.mv_daily_revenue TO refresh_worker;

GRANT SELECT, UPDATE ON mv_view_lab.refresh_state TO refresh_worker;
```

Worker còn cần môi trường thực thi phù hợp. Quá trình refresh thực thi truy vấn nguồn theo ngữ cảnh owner của MV; hãy kiểm tra quyền của owner và các function mà định nghĩa gọi tới.

Không cần cấp superuser chỉ để giải quyết việc chạy một refresh job.

### 11.3. MV không tự kế thừa bảo mật theo từng người đọc từ bảng nguồn

**Row-level security**, viết tắt RLS, là cơ chế giới hạn những dòng một user được đọc hoặc thay đổi.

Giả sử bảng `orders` có RLS theo tenant, tức từng tổ chức sử dụng ứng dụng. Một MV chứa kết quả của nhiều tenant không tự áp lại policy trên `orders` theo mỗi người đang `SELECT` từ MV.

Dữ liệu đã được sinh ở thời điểm refresh. Một biểu thức phụ thuộc `CURRENT_USER` trong định nghĩa MV cũng được tính lúc refresh, không tính lại theo người đọc sau này.

Vì vậy:

- Không cấp quyền đọc trực tiếp MV đa tenant cho mọi user rồi kỳ vọng RLS nguồn sẽ bảo vệ.
- Nếu dùng lớp View bảo mật phía trên MV, phải thiết kế và kiểm thử cách xác định tenant được phép đọc.
- View dùng để giới hạn dòng có thể cần `security_barrier`, tùy thiết kế. Một câu `WHERE` đơn giản chưa đủ để kết luận đó là ranh giới bảo mật an toàn.
- Quyền bị thu hồi hoặc dữ liệu bị xóa ở nguồn chưa tự xóa bản đã lưu trong MV; cần chính sách cập nhật và lưu giữ dữ liệu.

**Xem MV là một bản dữ liệu cần bảo vệ riêng, không chỉ là một cách viết query khác.**

## 12. Các lỗi thiết kế dễ gặp

### 12.1. Lỗi về hiệu năng và tính đúng

| Lỗi | Vì sao có vấn đề | Cách sửa |
|---|---|---|
| Tạo View rồi kỳ vọng aggregate đã được cache | View không lưu kết quả dùng lại giữa request | Đo truy vấn; tối ưu nguồn hoặc chọn MV |
| Tạo MV cho mọi query chậm | Chi phí chuyển sang refresh, storage và vận hành | Xác định nút thắt trước bằng plan |
| Gọi concurrent refresh mỗi request | Vẫn tính lại truy vấn, các refresh có thể xếp hàng | Dùng scheduler và gộp lượt chạy |
| Query bảng nguồn rồi mong PostgreSQL tự dùng MV | Core không tự query rewrite sang MV | Query MV hoặc View giao diện trỏ tới MV |
| Thêm `CURRENT_TIMESTAMP` vào mọi dòng MV để “đánh dấu” | Timestamp đổi mỗi refresh, có thể khiến cả kết quả bị coi là khác | Lưu metadata một lần trong bảng trạng thái |
| MV có `ORDER BY`, nên không sort ở query cuối | Thứ tự kết quả không được bảo đảm nếu query cuối không có `ORDER BY` | Sort ở truy vấn phục vụ người dùng |
| Cộng distinct hoặc lấy trung bình của trung bình | Có thể đếm trùng hoặc sai trọng số | Lưu đúng đại lượng có thể tổng hợp lại |
| Join một đơn với nhiều dòng chi tiết rồi cộng tiền đơn | Đóng góp của một đơn bị nhân lên | Kiểm tra grain và quan hệ join trước khi aggregate |

Ví dụ lỗi join: một đơn trị giá 100 có 3 dòng sản phẩm. Nếu join thành 3 dòng rồi `SUM(orders.amount)`, kết quả là 300. Lưu kết quả đó vào MV chỉ khiến bạn đọc nhanh một kết quả sai.

### 12.2. Lỗi về freshness và thay đổi schema

| Lỗi | Vì sao có vấn đề | Cách sửa |
|---|---|---|
| Chỉ kiểm tra job vừa kết thúc | Snapshot nguồn có thể cũ hơn mốc kết thúc | Theo dõi mốc bắt đầu và tiến độ nguồn phù hợp |
| Lọc “7 ngày gần đây” bằng `CURRENT_DATE` trong MV rồi không refresh | Cửa sổ thời gian không tự dịch khi chỉ đọc MV | Refresh theo hợp đồng hoặc quản lý cutoff riêng |
| Chỉ cộng các đơn mới | Bỏ sót update, delete, hủy đơn và dữ liệu đến muộn | Thiết kế đủ các dạng thay đổi và đối chiếu nguồn |
| Dùng `SELECT *` để làm hợp đồng View | Khó kiểm soát cột và thay đổi schema | Liệt kê cột và đặt alias rõ ràng |
| Đổi định nghĩa View nguồn nhưng không refresh MV | Nội dung MV vẫn là bộ kết quả đã lưu trước đó | Xem thay đổi logic là thay đổi phiên bản dữ liệu |
| Cho job retry vô hạn không có cảnh báo | Hệ thống có thể phục vụ dữ liệu cũ hàng giờ | Giới hạn retry, cảnh báo theo tuổi dữ liệu |
| Chỉ dự phòng disk bằng dung lượng MV cuối cùng | Refresh còn cần kết quả mới và không gian trung gian | Đo dung lượng đỉnh trong quá trình refresh |

Trong PostgreSQL, `SELECT *` ở định nghĩa View được xác định theo các cột tại thời điểm tạo View. Thêm cột vào bảng nguồn không tự thêm cột đó vào View đã tạo.

Với `CREATE OR REPLACE VIEW`, các cột hiện có phải giữ tên, thứ tự và kiểu tương thích theo quy tắc PostgreSQL; có thể thêm cột ở cuối. Đừng coi lệnh này là cách tùy ý thay hợp đồng mà không ảnh hưởng người dùng.

## 13. Khi nào nên chọn View hoặc MV

### 13.1. Quy trình ra quyết định

```d2 title="13.1. Quy trình ra quyết định"
direction: down
A: "Cần tái sử dụng logic truy vấn?"
V: "View là một lớp giao diện phù hợp"
B: "Bắt đầu từ truy vấn trực tiếp"
C: "Độ trễ đọc đã đạt mục tiêu?"
K: "Chưa cần MV chỉ vì muốn dùng MV"
D: "Đã đo plan và tối ưu query/index nguồn?"
O: "Tối ưu và đo lại"
E: "Công việc đắt được lặp lại đủ nhiều?"
F: "Xem lại workload và kiến trúc xử lý"
G: "Chấp nhận độ trễ cập nhật đã định nghĩa?"
H: "Refresh đáp ứng freshness và ngân sách tài nguyên?"
M: "MV là ứng viên tốt: triển khai và giám sát"
I: "Đánh giá incremental, summary table hoặc hệ analytics"
J: "Đọc nguồn hoặc cơ chế duy trì đồng bộ; đo chi phí ghi"
A -> V: "Có"
A -> B: "Không"
V -> C
B -> C
C -> K: "Có"
C -> D: "Không"
D -> O: "Chưa"
O -> C
D -> E: "Rồi"
E -> F: "Không"
E -> G: "Có"
G -> H: "Có"
H -> M: "Có"
H -> I: "Không"
G -> J: "Không"
```

View và MV không nhất thiết loại trừ nhau. Lab đã dùng View để đóng gói logic, rồi dùng MV để lưu kết quả của logic đó.

### 13.2. Áp dụng vào những tình huống thực tế

| Tình huống | Lựa chọn nên bắt đầu xem xét |
|---|---|
| Chuẩn hóa tên cột và logic join cho nhiều API | View |
| Lọc một vài đơn theo khách hàng, đã có index tốt | View hoặc truy vấn trực tiếp |
| Dashboard tổng hợp hàng triệu dòng, chấp nhận trễ 5–10 phút | MV với lịch refresh và freshness metric |
| Report được đọc rất ít, full refresh còn đắt hơn đọc nguồn | Truy vấn trực tiếp, batch report hoặc thiết kế khác |
| Kiểm tra số dư hoặc tồn kho trước khi ghi giao dịch | Nguồn có thẩm quyền cùng transaction/concurrency control |
| Cần summary cập nhật gần tức thời trên PostgreSQL | Đánh giá summary table hoặc cơ chế incremental cụ thể |
| Oracle cần tổng hợp được cập nhật lúc commit | Kiểm tra MV fast refresh on commit và chi phí commit |
| SQL Server cần kết quả vật lý được duy trì theo DML | Kiểm tra indexed view và ảnh hưởng write workload |
| MySQL cần dashboard tính sẵn | Summary table cùng job hoặc pipeline |

“Chọn View” không tự làm kiểm tra tồn kho an toàn. Để tránh hai transaction cùng bán một lượng hàng, vẫn cần kiểm soát ghi như update có điều kiện, lock phù hợp hoặc isolation phù hợp.

**View/MV quyết định cách tổ chức và phục vụ dữ liệu. Tính đúng của giao dịch còn cần thiết kế transaction.**

### 13.3. Tính trong database và tính trong Java khác nhau ở đâu

Một câu hỏi thường gặp là: “Java cũng tính được, tại sao nhiều project đưa logic vào View hoặc MV? Vì sao những project khác lại giữ logic ở application?”

Trước hết, cần tách **nơi viết code** khỏi **nơi thực thi phép tính**. SQL nằm trong Java repository — lớp truy cập dữ liệu của ứng dụng — vẫn có thể được database thực thi. Không cần tạo View thì mới tính được ở tầng database.

Ví dụ tính doanh thu của khách hàng 1 trong ngày 1/5 theo hai cách.

**Cách A: tải các giá trị về rồi cộng trong Java.** Đoạn dưới minh họa repository trả danh sách `OrderAmount`. Đây là một projection, tức kiểu dữ liệu chỉ chứa những thuộc tính cần đọc; mỗi phần tử có một giá trị `amount` khác `null`:

```java
long customerId = 1L;
Instant from = Instant.parse("2026-05-01T00:00:00Z");
Instant to = Instant.parse("2026-05-02T00:00:00Z");

List<OrderAmount> rows = repository.findPaidOrderAmounts(
    customerId, from, to
);

BigDecimal revenue = rows.stream()
    .map(OrderAmount::amount)
    .reduce(BigDecimal.ZERO, BigDecimal::add);
```

Database lọc và trả các giá trị. JDBC chuyển chúng qua mạng; Java tạo object rồi cộng trong JVM, tức môi trường thực thi Java.

**Cách B: yêu cầu database cộng và chỉ trả một kết quả.** Truy vấn sau chạy được trên bảng lab:

```sql
SELECT COALESCE(SUM(amount), 0) AS revenue
FROM mv_view_lab.orders
WHERE customer_id = 1
  AND status = 'paid'
  AND order_at >= TIMESTAMPTZ '2026-05-01 00:00:00+00'
  AND order_at < TIMESTAMPTZ '2026-05-02 00:00:00+00';
```

`COALESCE` đưa kết quả về 0 nếu không có dòng phù hợp. Trong ứng dụng, bind khách hàng và hai mốc thời gian bằng tham số thay vì ghép chuỗi SQL.

```d2 title="Giảm dữ liệu ở database hay cộng trong Java"
direction: right
java: Cộng trong Java {
  db: DB
  amounts: Nhiều giá trị amount
  sum: Java cộng
  result: Một giá trị revenue
  db -> amounts -> sum -> result
}
sql: Cộng bằng SQL gọi từ Java {
  sum: DB đọc và cộng
  result: Một giá trị revenue
  app: Java nhận kết quả
  sum -> result -> app
}
```

SQL trực tiếp hoặc một truy vấn JPQL có `SUM` cũng có thể đi theo cách B. **JPQL** là ngôn ngữ truy vấn trên các entity, tức đối tượng ánh xạ với dữ liệu quan hệ, của Java Persistence API (JPA).

Thư viện triển khai JPA, chẳng hạn Hibernate, chuyển truy vấn đó sang SQL để database xử lý.

View đóng gói cách B thành một đối tượng dùng lại. MV còn lưu kết quả để tránh tính lại trong những lần đọc sau.

<Callout type="info" title="Có nhiều hơn hai lựa chọn">

Không chỉ có “MV/View” hoặc “Java”. Bạn có thể **tính bằng SQL trực tiếp từ repository**, **đóng gói SQL trong View**, **tính sẵn bằng MV**, hoặc **tính trên dữ liệu đã tải vào Java**.

Chọn nơi thực thi phép tính trước. Sau đó mới chọn cách tổ chức và tái sử dụng nó.

</Callout>

### 13.4. Vì sao nhiều project đưa phép tính vào View hoặc MV

**1. Giảm dữ liệu phải chuyển về application.**

Một báo cáo có thể đọc 1 triệu dòng nhưng chỉ trả 100 nhóm tổng hợp. Database xử lý `GROUP BY` rồi gửi 100 dòng thường hợp lý hơn việc gửi 1 triệu dòng để Java nhóm lại.

Lợi ích không chỉ là tốc độ cộng. Bạn giảm network I/O, chuyển đổi kiểu dữ liệu và số object trong JVM. Cũng giảm công việc của **garbage collector**, bộ phận thu hồi bộ nhớ của Java.

Nếu stream dữ liệu bằng cursor thay vì tải cả danh sách, bạn có thể giảm bộ nhớ đỉnh phía application. Nhưng vẫn phải truyền những giá trị đó qua mạng.

**2. Tận dụng cách xử lý tập dữ liệu của database.**

Ví dụ `WHERE customer_id = 42 GROUP BY order_day` cho planner cơ hội dùng index, đưa bộ lọc xuống sớm và chọn cách tổng hợp phù hợp.

Database còn có thể tối ưu thứ tự join hoặc thực thi song song khi plan và cấu hình cho phép. Java hoàn toàn có thể xử lý dữ liệu hiệu quả, nhưng một vòng lặp ở application không tự có những thông tin và lựa chọn truy cập nguồn đó.

Điều này không chứng minh SQL luôn nhanh hơn Java. **Lợi thế thường nằm ở việc lọc và giảm dữ liệu ngay tại nguồn, không phải ngôn ngữ nào cộng số nhanh hơn.**

**3. Dùng chung một định nghĩa dữ liệu.**

Giả sử API, dashboard và công cụ BI đều cần “doanh thu đã thanh toán, nhóm ngày theo UTC”. **BI**, hay business intelligence, là nhóm công cụ phân tích và báo cáo dữ liệu.

Một View có thể cung cấp định nghĩa đó cho nhiều consumer, thay vì từng nơi viết lại phép lọc và tính ngày. Khi các consumer cùng dùng đúng giao diện này, nguy cơ lệch công thức giảm đi.

Đổi lại, bạn tạo một dependency dùng chung. Cần quản lý owner, phiên bản và migration của View; không sửa công thức mà bỏ qua các bên đang sử dụng.

Trong kiến trúc microservice, một View dùng chung cũng không tự giải quyết quyền sở hữu dữ liệu giữa các service. Chỉ chia sẻ giao diện database khi đó là một hợp đồng kiến trúc có chủ đích.

**4. Tính một lần để phục vụ nhiều lượt đọc.**

Một dashboard doanh thu giống nhau được gọi hàng nghìn lần là trường hợp phù hợp để đánh giá MV. Phép tổng hợp đắt được chuyển sang job refresh; các request đọc kết quả nhỏ hơn.

Đây là lợi ích riêng của **MV**, không phải của View thông thường. Nếu View vẫn tổng hợp hàng triệu dòng mỗi request, tải tính toán đó vẫn ở database.

Dùng MV khi độ mới chấp nhận được và ngân sách refresh đã được đo. Nếu báo cáo chỉ được đọc một lần mỗi ngày, tính sẵn quá thường xuyên có thể không có lợi.

**5. Dễ tính trên một góc nhìn nguồn nhất quán.**

Một statement SQL tổng hợp các bảng PostgreSQL cục bộ tuân theo snapshot của statement. Nó không phải ghép các kết quả từ những lần đọc ở thời điểm tùy ý.

Tuy nhiên, Java tải toàn bộ đầu vào bằng một `SELECT` cũng có thể nhận dữ liệu từ cùng một snapshot đó. Java dùng transaction và isolation phù hợp cũng có thể tổ chức nhiều lần đọc nhất quán.

**Tính nhất quán phụ thuộc cách đọc và transaction, không phải cứ SQL thì đúng còn Java thì sai.**

### 13.5. Vì sao nhiều application vẫn giữ logic trong Java

**1. Logic quyết định nghiệp vụ khác phép tổng hợp dữ liệu.**

Ví dụ một checkout cần xác định khách hàng có được dùng coupon không, chọn chính sách khuyến mãi và gọi dịch vụ vận chuyển để lấy phí giao hàng.

Những quyết định đó thường phụ thuộc request, trạng thái workflow và thông tin ngoài database. Java có thể là nơi tự nhiên để tổ chức chúng thành các policy và phối hợp các dịch vụ.

Một phép `SUM` trên dữ liệu đã ghi nhận là bài toán khác với “đơn hàng này có được giảm giá hay không”. **Đừng gom cả hai thành một loại “logic tính toán”.**

**2. Thuận tiện kiểm thử, thay đổi và triển khai business rule.**

Ví dụ chính sách giảm giá đổi theo chiến dịch. Team có thể kiểm thử từng kịch bản bằng object Java rồi triển khai cùng service sở hữu chính sách đó.

SQL vẫn kiểm thử được, thường bằng integration test trên database. Nhưng một View được nhiều hệ thống dùng chung cần thêm phối hợp thay đổi và quản lý tương thích.

Đây là lựa chọn về ownership và quy trình phát triển, không phải khẳng định SQL không thể chứa business rule.

**3. Có các phép tính không phù hợp với mô hình quan hệ.**

Ví dụ chạy một mô hình dự đoán, xử lý tài liệu hoặc dùng thư viện thuật toán chuyên biệt trên một tập dữ liệu đã được lọc nhỏ. Application hoặc worker riêng có thể là nơi phù hợp hơn database.

Trong trường hợp này, database vẫn nên lọc và lấy đủ đầu vào cần thiết. Không cần tải cả bảng chỉ vì bước xử lý cuối nằm ở Java.

**4. Bảo vệ tài nguyên của database phục vụ giao dịch.**

Nếu database đang chịu tải ghi cao, thêm một phép tính CPU nặng có thể làm tăng độ trễ của giao dịch khác. **Scale out** là bổ sung nhiều instance để chia tải; application hoặc worker thường dễ mở rộng theo cách này hơn một database primary.

Tuy nhiên, chuyển phép tính ra ngoài chỉ có lợi khi chi phí lấy dữ liệu và giữ kết quả cập nhật còn chấp nhận được. Tải đi tải lại hàng triệu dòng mỗi request có thể làm vấn đề nặng hơn.

Có thể cần một hệ thống analytics riêng hoặc pipeline dữ liệu, chứ không chỉ thay `SUM` bằng Java Stream.

**5. Tập dữ liệu nhỏ hoặc đã có sẵn trong bộ nhớ.**

Một giỏ hàng có 5 dòng, đã được tải để hiển thị và xử lý checkout, thường không cần thêm một query chỉ để cộng các dòng đó.

Nhiều ứng dụng cũng chọn tính trong Java do quy ước của ORM, tức thư viện ánh xạ giữa object và dữ liệu quan hệ, hoặc vì ban đầu dữ liệu ít. Cách đó có thể hoàn toàn đủ tốt. Nhưng khi dữ liệu tăng, cần đo lại thay vì coi đây là nguyên tắc bất biến.

**Giữ ở Java khi nó phù hợp với nghiệp vụ và workload. Đưa phép lọc/tổng hợp xuống SQL khi việc chuyển dữ liệu lên để tính đang trở thành chi phí lớn.**

### 13.6. Kiến trúc kết hợp và cách chọn nơi thực thi

Một thiết kế thường hợp lý cho hệ thống bán hàng là:

```d2 title="Phân chia trách nhiệm giữa Java và database"
direction: right
n0: "Java: quyết định chính sách, xử lý checkout"
n1: "Database: lưu giao dịch và giá trị đã chốt"
n2: "SQL / View / MV: tổng hợp báo cáo"
n0 -> n1 -> n2
```

Ví dụ:

1. Java xác định coupon, phí vận chuyển và số tiền cần thanh toán.
2. Transaction ghi đơn hàng, các thành phần giá và phiên bản chính sách cần lưu giữ.
3. Database bảo vệ các ràng buộc như khóa unique, số tiền hợp lệ và thao tác trừ tồn kho nguyên tử theo thiết kế.
4. View hoặc MV tổng hợp số tiền đã ghi nhận thành báo cáo doanh thu.

**Nguyên tử** nghĩa là thao tác không bị chia thành các bước quan sát hoặc cập nhật dở dang. Ví dụ tránh đọc tồn kho bằng Java, kiểm tra rồi ghi lại mà không có cơ chế chống hai transaction cùng tiêu thụ số hàng đó.

Ở đây, Java và database không cần mỗi bên tính lại toàn bộ cùng một công thức. Java sở hữu quyết định nghiệp vụ; báo cáo tổng hợp các **fact**, tức sự kiện hoặc giá trị nghiệp vụ đã được ghi nhận.

Không tính lại giá của đơn cũ bằng chính sách khuyến mãi hiện tại. Nếu cần kiểm toán, lưu các thành phần và phiên bản chính sách đủ để giải thích giá đã chốt.

| Bài toán | Nơi nên bắt đầu xem xét |
|---|---|
| Lọc, join hoặc tổng hợp nhiều dòng trong cùng database | SQL trực tiếp; View nếu cần đóng gói dùng chung |
| Cùng kết quả tổng hợp đắt được đọc nhiều lần, chấp nhận trễ | MV sau khi đo refresh và freshness |
| Quyết định theo workflow, request hoặc API bên ngoài | Java/application sở hữu nghiệp vụ |
| Phép tính nhỏ trên dữ liệu đã tải và cần dùng tiếp | Java thường hợp lý |
| Thuật toán nặng hoặc cần thư viện chuyên biệt | Application/worker; lấy đầu vào đã lọc |
| Ràng buộc cần bảo vệ trước các transaction đồng thời | Cơ chế transaction và constraint ở database, phối hợp với application |

Trước khi chọn, trả lời các câu hỏi cụ thể:

- Đầu vào ở đâu, có bao nhiêu dòng và sau phép tính còn bao nhiêu dòng?
- Kết quả có phụ thuộc người dùng, request, chính sách hoặc hệ thống bên ngoài không?
- Cần dữ liệu mới tới mức nào? Cùng kết quả có được đọc lại nhiều lần không?
- Chi phí CPU, I/O, network và bộ nhớ đang nằm ở đâu?
- Ai sở hữu công thức, kiểm thử nó và chịu trách nhiệm khi thay đổi?

<Callout type="idea" title="Nguyên tắc chọn tầng">

**Đưa xử lý tập dữ liệu về gần dữ liệu. Đưa quyết định nghiệp vụ về nơi sở hữu nghiệp vụ. Dùng MV khi cần tái sử dụng kết quả, không chỉ vì có thể viết phép tính bằng SQL.**

Ranh giới không tuyệt đối: một business rule đơn giản vẫn có thể triển khai tốt bằng SQL. Quyết định cuối cần dựa trên tính đúng, ownership, phép đo và khả năng vận hành.

</Callout>

## 14. Phân biệt MV với các cơ chế dễ nhầm

| Cơ chế | Lưu kết quả ở phạm vi nào | Điểm khác MV PostgreSQL |
|---|---|---|
| CTE với `MATERIALIZED` | Trong quá trình thực thi statement chứa CTE | Không có một đối tượng bền vững để nhiều request dùng lại |
| Temp table | Thường theo session hoặc transaction | Bạn tự đổ và sửa dữ liệu; phạm vi sống khác MV |
| Summary table thông thường | Bền vững | Cho phép DML trực tiếp; bạn tự thiết kế việc duy trì |
| Result cache ở ứng dụng | Theo cache key và chính sách cache | Phải xử lý invalidation, tham số và ngữ cảnh quyền |
| Read replica | Bản sao dữ liệu được truyền từ nguồn | Không tự loại bỏ công việc join/aggregate; có replication lag |
| Index thông thường | Lưu cấu trúc hỗ trợ truy cập bảng | Không phải kết quả tùy ý của một truy vấn tổng hợp |

**Invalidation** là việc loại bỏ hoặc cập nhật kết quả cache khi nguồn thay đổi. MV cũng có bài toán giữ kết quả mới, nhưng cơ chế refresh và vị trí lưu khác cache ứng dụng.

Nếu cần hàng trăm biến thể báo cáo theo tham số tùy ý, một MV cho mỗi bộ tham số có thể không hợp lý. Thường nên chọn grain dùng chung rồi lọc hoặc tổng hợp tiếp, miễn là MV còn giữ đủ chiều dữ liệu.

Ví dụ MV theo `(customer_id, order_day)` có thể phục vụ truy vấn theo khách hàng và tháng. Nhưng nó không trả lời được doanh thu theo sản phẩm nếu đã bỏ mất chiều sản phẩm.

## 15. Câu hỏi thường gặp

<Accordions type="single">
<Accordion title="MV có luôn nhanh hơn View không?">

Không. MV giúp tránh tính lại logic nguồn, nhưng vẫn có chi phí đọc, lọc, sort và index. Khi dữ liệu nguồn ít hoặc index nguồn đã rất tốt, lợi ích có thể nhỏ. Đo cả truy vấn đọc và công việc refresh.

</Accordion>
<Accordion title="SELECT từ MV có tự cập nhật dữ liệu không?">

Không trong PostgreSQL core. `SELECT` đọc bộ kết quả đang lưu. Muốn thay đổi nội dung phải refresh; việc lên lịch là trách nhiệm của cơ chế vận hành bạn chọn.

</Accordion>
<Accordion title="Vì sao MV có unique index mà concurrent refresh vẫn lỗi?">

Kiểm tra MV đã populated chưa. Kiểm tra index có partial predicate, biểu thức hoặc trạng thái không hợp lệ không. Unique index phải đáp ứng điều kiện của concurrent refresh, không chỉ có chữ `UNIQUE` trong một câu lệnh tạo index nào đó.

</Accordion>
<Accordion title="Refresh không có dòng kết quả có khác WITH NO DATA không?">

Có. Refresh bình thường với truy vấn trả 0 dòng tạo MV đã populated, có thể `SELECT` và nhận 0 dòng. `WITH NO DATA` làm MV unpopulated và không thể quét.

</Accordion>
<Accordion title="Concurrent refresh có chạy trong transaction được không?">

Có. Bạn có thể dùng cùng transaction để refresh và ghi metadata thành công. Lock vẫn được giữ đến cuối transaction, nên không làm thêm công việc dài sau refresh mà chưa commit.

</Accordion>
<Accordion title="Có nên refresh MV sau mỗi lần ghi một đơn hàng không?">

Thường không với full refresh trong PostgreSQL. Nó có thể biến mỗi thay đổi nhỏ thành một lần tính lại lớn. Nếu yêu cầu buộc summary phải mới theo mỗi lần ghi, hãy thiết kế cơ chế duy trì đồng bộ hoặc incremental phù hợp và kiểm thử chi phí ghi.

</Accordion>
<Accordion title="MV có dùng như một bản sao lưu hoặc audit log được không?">

Không nên. Refresh thay thế trạng thái lưu, không giữ lịch sử các lần thay đổi. Backup, audit và báo cáo đã chốt cần cơ chế lưu giữ cùng chính sách riêng.

</Accordion>
<Accordion title="Thêm index vào MV rồi vì sao planner vẫn chọn sequential scan?">

Với MV nhỏ hoặc query đọc phần lớn các dòng, quét tuần tự có thể rẻ hơn đọc index. Kiểm tra statistics và plan; đừng ép index chỉ vì đã tạo nó.

</Accordion>
</Accordions>

## 16. Checklist và tóm tắt

### 16.1. Checklist trước khi dùng MV

- [ ] Xác định rõ database, phiên bản và cơ chế duy trì kết quả.
- [ ] Định nghĩa grain, khóa nhóm, timezone và ý nghĩa của từng metric.
- [ ] Kiểm chứng logic nguồn đúng trước khi tối ưu bằng MV.
- [ ] Đo truy vấn gốc sau khi đã xem xét index và cách viết query.
- [ ] Đo độ trễ đọc, thời gian refresh và ảnh hưởng lên tải khác.
- [ ] Định nghĩa freshness SLO và hành vi khi dữ liệu quá cũ.
- [ ] Chọn refresh thường hoặc concurrent dựa trên yêu cầu đọc.
- [ ] Có unique index phù hợp nếu dùng concurrent refresh PostgreSQL.
- [ ] Có cách xử lý lượt chạy chồng nhau, timeout, retry và cảnh báo.
- [ ] Ghi metadata thành công đúng transaction; ghi thất bại ra giám sát.
- [ ] Dự phòng tài nguyên đỉnh, không chỉ dung lượng cuối của MV.
- [ ] Kiểm tra statistics, autovacuum và replication lag.
- [ ] Kiểm tra quyền theo tenant, ownership và ngữ cảnh refresh.
- [ ] Có kế hoạch cho update, delete, dữ liệu đến muộn và backfill.
- [ ] Có thứ tự refresh cho dependency và kế hoạch migration/rollback.

### 16.2. Bảy điểm cần nhớ

1. **View lưu logic; MV lưu kết quả.** Chúng giải quyết hai nhu cầu khác nhau và có thể dùng cùng nhau.
2. **View không phải cache.** Planner vẫn tối ưu trên nguồn; index nguồn vẫn rất quan trọng.
3. **MV chuyển chi phí, không làm chi phí biến mất.** Tính cả refresh, storage và vận hành.
4. **Độ mới là một hợp đồng nghiệp vụ.** Lịch refresh không tự bảo đảm hợp đồng đó.
5. **PostgreSQL concurrent refresh không phải incremental refresh.** Nó vẫn chạy lại truy vấn nguồn.
6. **Cơ chế khác nhau giữa các database.** Oracle MV và SQL Server indexed view không được suy luận hoàn toàn từ PostgreSQL.
7. **Kết quả lưu riêng cần bảo vệ riêng.** Quyền, RLS, migration và dữ liệu đã bị xóa ở nguồn đều phải được xem xét.

## 17. Dọn lab và đọc tiếp

Nếu không còn cần dữ liệu thử nghiệm, dọn toàn bộ schema lab:

```sql
-- Chỉ chạy trên database thử nghiệm, sau khi xác nhận schema này
-- không chứa đối tượng ngoài phạm vi lab.
DROP SCHEMA mv_view_lab CASCADE;
```

`CASCADE` ở đây là thao tác dọn một schema thử nghiệm được tạo riêng. Không sao chép cách này sang schema nghiệp vụ.

<Cards>
  <Card title="Subquery vs CTE vs Temp Table" href="/fundamentals/subquery-vs-cte-vs-temp-table/" description="Phân biệt các cách tổ chức kết quả trung gian với đối tượng View và MV." />
  <Card title="MVCC" href="/fundamentals/mvcc/" description="Hiểu snapshot và vì sao người đọc có thể thấy những phiên bản dữ liệu khác nhau." />
  <Card title="EXPLAIN ANALYZE" href="/optimization/explain-analyze-deep-dive/" description="Đọc execution plan và đo truy vấn nguồn so với truy vấn MV." />
  <Card title="Statistics và Query Planner" href="/optimization/statistics-query-planner-deep-dive/" description="Hiểu vai trò của ANALYZE và ước lượng dữ liệu." />
</Cards>

## 18. Tài liệu tham khảo

Các đặc điểm theo database trong bài được đối chiếu với tài liệu chính thức:

- [PostgreSQL 17 — CREATE VIEW](https://www.postgresql.org/docs/17/sql-createview.html): định nghĩa, updatable View, `CHECK OPTION`, quyền và `security_invoker`.
- [PostgreSQL 17 — Materialized Views](https://www.postgresql.org/docs/17/rules-materializedviews.html): dữ liệu lưu vật lý, index và cách truy vấn MV.
- [PostgreSQL 17 — CREATE MATERIALIZED VIEW](https://www.postgresql.org/docs/17/sql-creatematerializedview.html): tạo MV và trạng thái `WITH NO DATA`.
- [PostgreSQL 17 — REFRESH MATERIALIZED VIEW](https://www.postgresql.org/docs/17/sql-refreshmaterializedview.html): concurrent refresh, unique index, quyền `MAINTAIN` và giới hạn refresh.
- [Oracle Database 19c — Basic Materialized Views](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/basic-materialized-views.html): complete/fast refresh, materialized view log, on commit và query rewrite.
- [SQL Server — Create Indexed Views](https://learn.microsoft.com/en-us/sql/relational-databases/views/create-indexed-views?view=sql-server-ver17): schema binding, index, `SET` option và ảnh hưởng lên DML.
- [MySQL 8.4 — FAQ về Views](https://dev.mysql.com/doc/refman/8.4/en/faqs-views.html): không có Materialized View native.
- [MySQL 8.4 — View Processing Algorithms](https://dev.mysql.com/doc/refman/8.4/en/view-algorithms.html): phân biệt `MERGE`, `TEMPTABLE` và `UNDEFINED`.
