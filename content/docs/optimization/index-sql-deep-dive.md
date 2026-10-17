---
title: "Index SQL"
description: "Deep dive vào SQL Index — B-Tree, Composite Index, EXPLAIN, Selectivity, Covering Index"
---

<SourceRef project="optimization-index-sql-deep-dive" variant="button">
Mở các đoạn code trong bài
</SourceRef>

Các file trong Source Explorer là **snippet độc lập**, giữ nguyên ngữ cảnh và database của từng mục; không chạy nối tiếp tất cả như một script.

## Mục lục

- [Nền tảng Index](#1-nền-tảng-index)
- [Cấu trúc lưu trữ Index](#2-cấu-trúc-lưu-trữ-index)
- [B-Tree Index — Chi tiết](#3-b-tree-index--chi-tiết)
- [Clustered vs Non-Clustered Index](#4-clustered-vs-non-clustered-index)
- [Composite Index & Thứ tự cột](#5-composite-index--thứ-tự-cột)
- [Index và Query Execution](#6-index-và-query-execution)
- [Index Selectivity & Cardinality](#7-index-selectivity--cardinality)
- [Các lỗi thường gặp & Cách phòng tránh](#8-các-lỗi-thường-gặp--cách-phòng-tránh)
- [Ví dụ thực tế](#9-ví-dụ-thực-tế)
- [Chiến lược tối ưu Index](#10-chiến-lược-tối-ưu-index)
- [Monitoring & Bảo trì](#11-monitoring--bảo-trì)
- [Tại sao Index không được sử dụng](#12-tại-sao-index-không-được-sử-dụng--deep-dive-với-ví-dụ)
- [Làm sao biết Index nào sẽ được dùng](#13-làm-sao-biết-index-nào-sẽ-được-dùng)
- [Tóm tắt Best Practices](#14-tóm-tắt-best-practices)

---

## 1. Nền tảng Index

### Index là gì?

**Index** (chỉ mục) là cấu trúc dữ liệu riêng biệt lưu trữ con trỏ tới các row trong bảng, được tổ chức sao cho việc tra cứu diễn ra nhanh chóng. Hãy hình dung nó như mục lục của một cuốn sách — thay vì đọc từng trang để tìm chủ đề, bạn tra mục lục để biết ngay số trang.

```d2 title="Scan toàn bảng và tìm kiếm qua B-Tree"
direction: down
b0: "Không có index email phù hợp" {
  n0: "Query email=john@example.com"
  n1: "Kiểm tra Row 1 → Row 2 → ..."
  n2: "Có thể phải xét tới toàn bộ bảng; mô hình\nO(n)"
  n0 -> n1
  n1 -> n2
}
b1: "B-Tree lookup" {
  n0: "Index root"
  n1: "Chọn range a–m rồi j–k"
  n2: "Leaf john@example.com → row locator"
  n3: "Đọc Row 4; chi phí tìm đường theo chiều\ncao cây"
  n0 -> n1
  n1 -> n2
  n2 -> n3
}
```

Số so sánh thực tế phụ thuộc fanout và cấu trúc page. Với một triệu entries, không mặc định B+Tree cần 20 page reads như cây nhị phân; các đường rẽ chỉ là minh họa.

### So sánh hiệu năng

| Số row trong bảng | Full Table Scan | B-Tree Index Lookup | Cải thiện tốc độ |
|---------------|-----------------|---------------------|-------------------|
| 1,000 | 1,000 comparisons | ~10 comparisons | **100x faster** |
| 10,000 | 10,000 comparisons | ~14 comparisons | **714x faster** |
| 100,000 | 100,000 comparisons | ~17 comparisons | **5,882x faster** |
| 1,000,000 | 1,000,000 comparisons | ~20 comparisons | **50,000x faster** |
| 10,000,000 | 10,000,000 comparisons | ~24 comparisons | **416,667x faster** |

### Tóm tắt lợi ích của Index

| Lợi ích | Giải thích | Ví dụ |
|---------|------------|-------|
| **Tăng tốc SELECT** | DB chỉ đọc các block liên quan thay vì toàn bộ bảng | `WHERE email = ?` dùng index thay vì scan hết row |
| **Tối ưu điều kiện WHERE** | Index cung cấp đường đi trực tiếp tới row khớp | `WHERE status = 'active' AND created_at > '2024-01-01'` |
| **Tăng tốc JOIN** | Index trên foreign key giúp join nhanh hơn | `JOIN orders ON users.id = orders.user_id` |
| **Cải thiện ORDER BY / GROUP BY** | Dữ liệu đã sắp xếp sẵn trong index | `ORDER BY created_at DESC` dùng thứ tự index |
| **Đảm bảo UNIQUE constraint** | UNIQUE index kiểm tra trùng lặp hiệu quả | Ngăn email trùng trong bảng users |

### Khi nào nên tạo Index

```d2 title="Khi nào nên tạo Index"
direction: down
A: "Should I Create an Index?"
B: "Column frequently in WHERE?" { shape: diamond }
C: "High Selectivity?" { shape: diamond }
D: "Column in JOIN/ORDER BY?" { shape: diamond }
E: "✅ Create Index"
F: "Read-heavy workload?" { shape: diamond }
G: "Large table?>10K rows" { shape: diamond }
H: "❌ Probably Don't Need"
I: "⚠️ Consider Bitmap/Partial Index"
J: "Choose Index Type"
K: "Equality only?" { shape: diamond }
L: "Hash Index"
M: "B-Tree Index"
A -> B
B -> C: "Yes"
B -> D: "No"
C -> E: "Yes (>10% distinct)"
C -> F: "No (<10% distinct)"
D -> G: "Yes"
D -> H: "No"
F -> I: "Yes"
F -> H: "No"
G -> E: "Yes"
G -> H: "No"
E -> J
J -> K
K -> L: "Yes"
K -> M: "No"
```

### Khi nào KHÔNG nên tạo Index

| Trường hợp | Lý do | Ví dụ |
|------------|-------|-------|
| **Bảng nhỏ** (< 1000 rows) | Full scan nhanh hơn chi phí lookup index | Bảng cấu hình, bảng lookup |
| **Cột selectivity thấp** | Index scan vẫn đọc phần lớn bảng | `gender` (M/F), `is_active` (true/false) |
| **Cột cập nhật thường xuyên** | Mỗi UPDATE đều phải cập nhật index | `view_count`, `last_login_at` |
| **Cột bọc trong hàm** | Index không được dùng nếu cột nằm trong function | `WHERE YEAR(created_at) = 2024` |
| **Bảng write-heavy** | Bảo trì index làm chậm INSERT/UPDATE/DELETE | Bảng ghi log tần suất cao |

---

## 2. Cấu trúc lưu trữ Index

### Tổng quan các loại Index

| Loại Index | Cấu trúc dữ liệu | Phù hợp với | Toán tử hỗ trợ | Database hỗ trợ |
|------------|---------------|----------|---------------------|------------------|
| **B-Tree** | Balanced Tree | Range queries, equality, sorting | `=`, `<`, `>`, `<=`, `>=`, `BETWEEN`, `LIKE 'abc%'` | MySQL, PostgreSQL, Oracle, SQL Server |
| **Hash** | Hash Table | Equality only | `=` | PostgreSQL, MySQL (Memory Engine) |
| **Bitmap** | Bit vectors | Low-cardinality columns | `=`, `IN`, `AND`, `OR` | Oracle, PostgreSQL |
| **GiST** | Generalized Search Tree | Spatial, full-text, custom types | `@>`, `<@`, `&&`, `~` | PostgreSQL |
| **GIN** | Generalized Inverted Index | Arrays, JSONB, full-text | `@>`, `?`, `?&`, `?|` | PostgreSQL |
| **BRIN** | Block Range Index | Large tables with natural ordering | Range queries on correlated data | PostgreSQL |

### So sánh B-Tree và Hash Index

```d2 title="B-Tree có thứ tự, Hash ánh xạ vào bucket"
direction: down
btree: B-Tree — balanced, sorted {
  m: M
  e: E
  r: R
  a: A
  f: F
  h: H
  n: N
  s: S
  z: Z
  m -> e
  m -> r
  e -> a
  e -> f
  e -> h
  r -> n
  r -> s
  r -> z
}
hash_index: Hash Index {
  john: john@example.com
  jane: jane@example.com
  bob: bob@example.com
  b42: Bucket 42 → row pointers
  b17: Bucket 17 → row pointer
  john -> b42
  bob -> b42: collision
  jane -> b17
}
```

B-Tree hỗ trợ so sánh bằng, khoảng (`<`, `>`, `BETWEEN`), `ORDER BY` và prefix `LIKE 'abc%'` khi điều kiện phù hợp. Hash index hướng tới equality; không cung cấp thứ tự để phục vụ range scan, sort hoặc prefix search. Độ trễ equality thực tế cần đo, không mặc định Hash luôn nhanh hơn B-Tree.

### Bitmap Index — Chi tiết

```d2 title="Bitmap vectors kết hợp predicate bằng AND"
direction: right
status: "Bitmap status=active"
dept: "Bitmap department=sales"
and_node: "Bitwise AND"
locations: "Row IDs / vị trí có bit phù hợp"
rows: "Đọc rows phù hợp"
status -> and_node
dept -> and_node
and_node -> locations
locations -> rows
```

| Status | Bits cho các row IDs 1..10 trong ví dụ |
| --- | --- |
| active | 1 0 1 0 1 0 1 0 1 0 |
| inactive | 0 1 0 0 0 1 0 1 0 1 |
| pending | 0 0 0 1 0 0 0 0 0 0 |

Đây là minh họa bitmap cho bảng employees có status active/inactive/pending. Bitmap index lưu bền phù hợp một số workload OLAP ít ghi và key ít distinct; không đồng nhất với Bitmap Index/Heap Scan tạm thời của PostgreSQL. Chi phí khi update và khả năng hỗ trợ phụ thuộc engine.

---

## 3. B-Tree Index — Chi tiết

### Cấu trúc B-Tree giải thích

B-Tree (Balanced Tree) is the most common index structure. Most databases actually use **B+Tree** variant.

```d2 title="B+Tree: data ở leaf và liên kết range scan"
direction: down
root: "Root: 50 | 100"
i1: "Internal: 20 | 30"
i2: "Internal: 60 | 80"
i3: "Internal: 120 | 150"
l1: "Leaf: 10, 25, 35\n→ data pointers"
l2: "Leaf: 55, 75, 90\n→ data pointers"
l3: "Leaf: 110, 140, 180\n→ data pointers"
root -> i1
root -> i2
root -> i3
i1 -> l1
i2 -> l2
i3 -> l3
l1 <-> l2: leaf links
l2 <-> l3: leaf links
```

| Đặc điểm | B-Tree | B+Tree |
|---|---|---|
| Vị trí data / row reference | Có thể ở mọi tầng | Ở leaf |
| Liên kết leaf | Không bắt buộc | Có để duyệt range |
| Range scan | Duyệt cấu trúc cây | Tới leaf đầu rồi đi ngang |
| I/O và dung lượng | Phụ thuộc triển khai | Leaf links thuận lợi cho range; internal chỉ giữ key nên có thể tăng fanout |

### Quy trình tìm kiếm trong B-Tree

```d2 title="Quy trình tìm kiếm trong B-Tree"
shape: sequence_diagram
Q: "Query"
R: "Root Node"
I: "Internal Node"
L: "Leaf Node"
D: "Data Page"
Q -> R: "Search for key = 75"
R.note7: "Compare: 75 > 50, 75 < 100\nGo to middle child"
R -> I: "Navigate to [60|80]"
I.note9: "Compare: 75 > 60, 75 < 80\nGo to middle child"
I -> L: "Navigate to leaf [75]"
L.note11: "Found key 75!\nGet row pointer"
L -> D: "Fetch actual row data"
D -> Q: "Return row data" { style.stroke-dash: 3 }
Q.note14: "Q / D: Total: 3 node reads + 1 data read\nO(log n) complexity"
```

### Độ phức tạp các thao tác B-Tree

| Operation | Average Case | Worst Case | Description |
|-----------|-------------|------------|-------------|
| **Search** | O(log n) | O(log n) | Tree height determines lookups |
| **Insert** | O(log n) | O(log n) | May cause node splits |
| **Delete** | O(log n) | O(log n) | May cause node merges |
| **Range Scan** | O(log n + k) | O(log n + k) | k = number of matching rows |

### Minh họa Node Split

```d2 title="Split B-Tree node và đẩy key lên parent"
direction: down
before: Trước khi insert 45 {
  parent: "30"
  a: "10 | 20"
  b: "35 | 40 | 50 | 55 — full, tối đa 4 key"
  parent -> a
  parent -> b
}
after: Sau split {
  parent: "30 | 45 — promote 45"
  a: "10 | 20"
  b: "35 | 40"
  c: "50 | 55"
  parent -> a
  parent -> b
  parent -> c
}
before.b -> after.parent: Insert 45, split node
```

Split tăng I/O và có thể lan lên root. Đây là một phần chi phí duy trì index khi INSERT.

---

## 4. Clustered vs Non-Clustered Index

### So sánh trực quan

```d2 title="Clustered leaf chứa row, nonclustered leaf chứa locator"
direction: down
clustered: Clustered B+Tree {
  root: Index Root
  a: Internal A
  b: Internal B
  r1: "Row id=1, name=A, email=..."
  r2: "Row id=2, name=B, email=..."
  r3: "Row id=5, name=C, email=..."
  r4: "Row id=10, name=D, email=..."
  root -> a
  root -> b
  a -> r1
  a -> r2
  b -> r3
  b -> r4
}
nonclustered: Nonclustered index email {
  root: Index Root
  low: a–m
  high: n–z
  entry: Key + row locator
  root -> low
  root -> high
  low -> entry
}
table: Heap hoặc clustered table chứa row thật
nonclustered.entry -> table: bookmark lookup
```

Một table chỉ có một clustered order nhưng có thể có nhiều nonclustered indexes. Clustered leaf chứa row nên tránh lookup riêng khi dữ liệu đã đủ ở leaf. Nonclustered thường nhỏ hơn nếu chỉ giữ key và locator; query thiếu cột vẫn cần lookup. INSERT và page split phụ thuộc key, tải và engine, không có cam kết nonclustered luôn ghi nhanh hơn.

### Bảng so sánh chi tiết

| Aspect | Clustered Index | Non-Clustered Index |
|--------|----------------|---------------------|
| **Count per table** | Only 1 | Multiple (up to 999 in SQL Server) |
| **Data storage** | Leaf nodes contain actual data | Leaf nodes contain pointers |
| **Physical order** | Determines physical row order | Does not affect physical order |
| **Speed for key lookup** | Fastest (1 lookup) | Slower (2 lookups: index → data) |
| **Speed for range scan** | Very fast (sequential I/O) | Slower (random I/O to fetch rows) |
| **Size** | Larger (contains all data) | Smaller (keys + pointers only) |
| **INSERT impact** | May require page splits and data movement | Only updates index structure |
| **Default in MySQL InnoDB** | Primary Key | Other indexes |
| **Default in PostgreSQL** | None (heap table) | All indexes are non-clustered |

### Vấn đề Bookmark Lookup

**Bookmark Lookup** (also called Key Lookup in SQL Server, or RID Lookup for heap tables) occurs when the database finds rows using a non-clustered index but must then go back to the base table (or clustered index) to retrieve additional columns not stored in the index.

```d2 title="Bookmark lookup và covering index"
direction: right
lookup: Index chỉ có email {
  search: Tìm john@example.com
  pointer: Row pointer 1234
  row: "Đọc Row 1234\nid=5, name=John, address=123 Main St"
  search -> pointer -> row
}
covering: Index giữ đủ cột cần đọc {
  leaf: "email=john@example.com\nINCLUDE name=John, address=123 Main St"
  result: Trả cột từ index khi engine và visibility cho phép
  leaf -> result
}
```

Query cần `id, email, name, address` theo email có thể phải đọc thêm table cho mỗi match nếu index chỉ có email. Nhiều match có thể dẫn tới nhiều page fetch, nhưng không đồng nghĩa một physical I/O cho mỗi row. Ví dụ covering: `CREATE INDEX idx_email_cover ON users(email) INCLUDE (name, address);` — thêm `id` nếu engine/index chưa mang sẵn cột này mà query cần nó.

### Tại sao Bookmark Lookup là vấn đề

| Reason | Explanation | Impact |
|--------|-------------|--------|
| **Random I/O Operations** | Each lookup jumps to a different location in the table/clustered index, causing random disk seeks | Random I/O is 10-100x slower than sequential I/O on HDDs, still 2-10x slower on SSDs |
| **I/O Amplification** | Finding 1,000 rows in index requires 1,000 additional table lookups | Query that should read 10 pages ends up reading 1,000+ pages |
| **Buffer Pool Pollution** | Each lookup loads a full data page into memory just for one row | Pushes out frequently used pages, degrading overall cache efficiency |
| **Unpredictable Latency** | Pages may or may not be cached; performance varies wildly | Query times can range from 5ms to 500ms depending on cache state |
| **Tipping Point Problem** | Optimizer may abandon index entirely if too many lookups needed | Index becomes useless when selectivity drops below threshold (~1-5%) |
| **Lock Contention** | More pages accessed means more locks held longer | Increases blocking in high-concurrency environments |

### Điểm giới hạn: Khi Index chậm hơn Full Scan

```d2 title="Bookmark lookup có thể làm đổi plan khi tỷ lệ match tăng"
direction: down
b0: "Cancelled: 0,1% bảng một triệu rows" {
  n0: "Ví dụ khoảng 5 index pages + 1.000\nbookmark page accesses"
  n1: "So với full scan 10.000 pages"
  n2: "Index có thể rẻ hơn"
  n0 -> n1
  n1 -> n2
}
b1: "Active: 30%" {
  n0: "Ví dụ khoảng 1.500 index pages và 300.000\nrow lookups"
  n1: "Nhiều random access; cache và page reuse\nquyết định I/O"
  n2: "Full scan 10.000 pages có thể rẻ hơn"
  n0 -> n1
  n1 -> n2
}
```

Giả sử 100 rows/page, bảng có khoảng 10.000 pages. Số row lookups **không đồng nghĩa** số physical disk reads: cache, grouping và số row/page ảnh hưởng mạnh. Các tỷ lệ 5–15% hay 15–30% chỉ là kinh nghiệm minh họa, không phải ngưỡng bắt buộc của optimizer.

### Ví dụ thực tế: Tìm kiếm sản phẩm E-Commerce

```sql
-- Scenario: E-commerce site with 5 million products
-- Table: products (id, name, category_id, price, description, image_url, 
--                  stock_qty, created_at, rating, review_count)
-- Size: ~2GB data, 500 bytes average per row

-- Index exists: CREATE INDEX idx_category ON products(category_id);

-- Query: Show products in "Electronics" category for listing page
SELECT id, name, price, image_url, rating
FROM products
WHERE category_id = 42  -- Electronics: 150,000 products (3%)
ORDER BY rating DESC
LIMIT 50;
```

```d2 title="E-commerce: fetch nhiều rows rồi mới sort và LIMIT"
direction: right
n0: "Scan idx_category: category_id=42 →\n150.000 product IDs; ví dụ 500 index pages"
n1: "Bookmark lookup lấy name, price,\nimage_url, rating cho các matches"
n2: "Sort 150.000 rows theo rating trong memory\nhoặc temp storage"
n3: "Trả TOP 50; đã fetch nhiều hơn số rows cần\ntrả"
n0 -> n1
n1 -> n2
n2 -> n3
```

| Metric minh họa | Plan nhiều bookmark lookups | Kỳ vọng ban đầu của developer |
| --- | --- | --- |
| Logical page accesses | 150.500 | Khoảng 50 |
| Execution Time | 2–8 giây | Dưới 50 ms |
| Memory sort | 75 MB+ | Dưới 1 MB |
| CPU Time | 500 ms+ | Dưới 10 ms |

Các số liệu là tình huống giả định, không phải benchmark. Cache lạnh có thể làm tăng physical reads; không mặc định mỗi lookup luôn tương ứng một disk read.

### Giải pháp: Covering Index

```sql
-- SOLUTION 1: Covering Index with INCLUDE (SQL Server/PostgreSQL)
CREATE INDEX idx_category_covering 
ON products(category_id, rating DESC) 
INCLUDE (name, price, image_url);

-- SOLUTION 2: Composite Covering Index (MySQL/All databases)
CREATE INDEX idx_category_covering 
ON products(category_id, rating DESC, name, price, image_url);

-- Now the query execution:
-- Step 1: Index seek to category_id = 42
-- Step 2: Data already sorted by rating in index
-- Step 3: First 50 entries have ALL needed columns
-- Step 4: Return immediately - NO table access needed!
```

| Metric minh họa | Before bookmark | After covering | So sánh trong ví dụ |
| --- | --- | --- | --- |
| Logical page accesses | 150.500 | 5 | 30.000× |
| Physical reads | Tới 150.000 | 0–5 | Phụ thuộc cache |
| Execution Time | 2–8 giây | 2–10 ms | Không phải cam kết 200–400× |
| Memory sort | 75 MB+ | Không sort riêng nếu index thật sự cung cấp order | Tùy plan |
| MySQL Extra | Using index condition | Using index | Hai thông tin khác nhau |

Trade-off minh họa: index từ khoảng 200 MB tới 400 MB, thêm chi phí INSERT/UPDATE. Query đọc hơn 100.000 lần/ngày có thể đáng tối ưu, nhưng cần benchmark thực tế và ngân sách ghi/storage.

### Khi nào cần xử lý Bookmark Lookup

| Factor | Create Covering Index | Keep Bookmark Lookup |
|--------|----------------------|---------------------|
| **Query frequency** | High (1000s/day) | Low (few times/day) |
| **Result set size** | Small (< 100 rows typically) | Large or variable |
| **Column sizes** | Small columns (int, date, short varchar) | Large columns (TEXT, BLOB) |
| **Write frequency** | Read-heavy table | Write-heavy table |
| **Storage constraints** | Plenty of disk space | Limited storage |

### Phát hiện Bookmark Lookup

```sql
-- MySQL: Look for "Using index condition" vs "Using index"
EXPLAIN SELECT id, name, price FROM products WHERE category_id = 42;
-- "Using index" = Covering index (good!)
-- "Using index condition" or no mention = Bookmark lookup happening

-- SQL Server: Look for "Key Lookup" or "RID Lookup" operators
SET STATISTICS IO ON;
SELECT id, name, price FROM products WHERE category_id = 42;
-- Check for "Key Lookup" in execution plan

-- PostgreSQL: Look for "Index Scan" vs "Index Only Scan"
EXPLAIN (ANALYZE, BUFFERS) SELECT id, name, price FROM products WHERE category_id = 42;
-- "Index Only Scan" = Covering index (good!)
-- "Index Scan" + "Heap Fetches: X" = Bookmark lookups happening
```

---

## 5. Composite Index & Thứ tự cột

### Tầm quan trọng của thứ tự cột

```d2 title="Composite key theo thứ tự cột"
direction: right
n0: "customer_id"
n1: "status trong cùng customer_id"
n2: "created_at trong cùng customer_id và\nstatus"
n0 -> n1
n1 -> n2
```

Ví dụ `CREATE INDEX idx_orders ON orders(customer_id, status, created_at)` giống danh bạ sắp theo họ → tên → thành phố.

| customer_id | status | created_at | Row locator |
| --- | --- | --- | --- |
| 100 | active | 2024-01-01 | Row 5 |
| 100 | active | 2024-01-15 | Row 12 |
| 100 | pending | 2024-01-10 | Row 8 |
| 101 | active | 2024-01-05 | Row 3 |
| 101 | complete | 2024-01-20 | Row 15 |
| 102 | active | 2024-01-02 | Row 1 |

Leftmost-prefix là điểm bắt đầu để suy luận access path; vẫn kiểm tra tối ưu riêng của engine bằng plan.

### Query nào sử dụng được Index?

| Query | Uses Index? | Explanation |
|-------|-------------|-------------|
| `WHERE customer_id = 100` | ✅ Yes | Uses first column |
| `WHERE customer_id = 100 AND status = 'active'` | ✅ Yes | Uses first two columns |
| `WHERE customer_id = 100 AND status = 'active' AND created_at > '2024-01-01'` | ✅ Yes | Uses all three columns |
| `WHERE status = 'active'` | ❌ No | Skips first column! |
| `WHERE created_at > '2024-01-01'` | ❌ No | Skips first two columns! |
| `WHERE customer_id = 100 AND created_at > '2024-01-01'` | ⚠️ Partial | Only uses customer_id, can't skip status |
| `WHERE status = 'active' AND customer_id = 100` | ✅ Yes | Optimizer reorders (same as first two) |

### Hướng dẫn chọn thứ tự cột

```d2 title="Hướng dẫn chọn thứ tự cột"
direction: down
A: "Designing Composite Index"
B: "What columns to include?" { shape: diamond }
C: "List all columns used in WHERE/JOIN/ORDER BY"
D: "How to order columns?" { shape: diamond }
E: "Rule 1: Equality conditions FIRST"
F: "Rule 2: Range conditions LAST"
G: "Rule 3: High selectivity columns earlier"
H: "Rule 4: ORDER BY columns at end"
I: "Example: status = 'active' before created_at > ?"
J: "Range operators: >, <, BETWEEN, LIKE"
K: "user_id (high) before status (low)"
L: "Allows index-only sort, no filesort"
M: "Final Index Design"
N: "CREATE INDEX idx_optimal ON table(equality_col1, equality_col2, range_col)"
A -> B
B -> C
C -> D
D -> E
D -> F
D -> G
D -> H
E -> I
F -> J
G -> K
H -> L
I -> M
J -> M
K -> M
L -> M
M -> N
```

### Ví dụ thực tế: Tối ưu query chậm

```sql
-- Original slow query
SELECT * FROM orders 
WHERE status = 'pending' 
  AND customer_id = 12345 
  AND created_at BETWEEN '2024-01-01' AND '2024-12-31'
ORDER BY created_at DESC;

-- Analysis:
-- status = 'pending'      → Equality (low selectivity: ~5 values)
-- customer_id = 12345     → Equality (high selectivity: millions of values)
-- created_at BETWEEN      → Range
-- ORDER BY created_at     → Sorting

-- ❌ BAD INDEX: (status, created_at, customer_id)
-- Why bad: Low selectivity first, range before equality

-- ✅ GOOD INDEX: (customer_id, status, created_at)
-- Why good: 
--   1. customer_id (high selectivity) filters most rows first
--   2. status (equality) further filters
--   3. created_at (range + sort) at end - can use for both filter AND sort!

CREATE INDEX idx_orders_optimal ON orders(customer_id, status, created_at);
```

<SourceRef project="optimization-index-sql-deep-dive" file="ví-dụ-thực-tế-tối-ưu-query-chậm/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

---

## 6. Index và Query Execution

### Database chọn Index như thế nào

```d2 title="Database chọn Index như thế nào"
direction: down
A: "Query Arrives"
B: "Query Parser"
C: "Query Optimizer"
D: "Analyze Available Indexes" { shape: diamond }
E: "Calculate Cost for Each Plan"
F: "Index Scan Cost < Full Scan Cost?" { shape: diamond }
G: "Use Index"
H: "Full Table Scan"
I: "Covering Index?" { shape: diamond }
J: "Index-Only Scan"
K: "Index Scan + Bookmark Lookup"
L: "Return Results"
cost_factors: "Cost Factors" {
  M: "Estimated rows to return"
  N: "Index selectivity"
  O: "I/O cost per row"
  P: "CPU cost for comparisons"
}
A -> B
B -> C
C -> D
D -> E
E -> F
F -> G: "Yes"
F -> H: "No"
G -> I
I -> J: "Yes"
I -> K: "No"
J -> L
K -> L
H -> L
```

### Hiểu kết quả EXPLAIN

```sql
-- MySQL EXPLAIN example
EXPLAIN SELECT * FROM users WHERE email = 'john@example.com';
```

| Column EXPLAIN MySQL | Ý nghĩa |
| --- | --- |
| type | Access method: system, const, eq_ref, ref, range, index, ALL |
| possible_keys | Indexes có thể xét |
| key | Index planner thực sự chọn |
| key_len | Số byte key được dùng trong access |
| rows | Ước lượng rows cần xét |
| Extra | Using index, Using filesort, ... |

| id | select_type | table | type | possible_keys | key | key_len | rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SIMPLE | users | ref | idx_email | idx_email | 767 | 1 |

`const` là lookup tối đa một row; `eq_ref` là unique lookup mỗi join input row; `ref` có thể nhiều matches; `range` đọc khoảng; `index` quét index; `ALL` quét table. Tên type riêng lẻ không đủ kết luận plan tốt hay xấu.

### Các giá trị "Extra" thường gặp

| Giá trị Extra | Ý nghĩa | Đánh giá |
|-------------|---------|----------|
| `Using index` | Covering index — không cần truy cập bảng | ✅ Xuất sắc |
| `Using where` | Điều kiện WHERE được áp dụng sau khi lookup index | ⚠️ Bình thường |
| `Using filesort` | Sắp xếp trên memory/disk, không dùng index | ⚠️ Có thể chậm |
| `Using temporary` | Tạo bảng tạm cho GROUP BY/DISTINCT | ⚠️ Có thể chậm |
| `Using index condition` | Index condition pushdown (ICP) | ✅ Tốt |
| `Full scan on NULL key` | Subquery phải full scan | ❌ Xấu |

---

## 7. Index Selectivity & Cardinality

### Hiểu về Selectivity

**Selectivity** = Mức độ mà index có thể thu hẹp kết quả tìm kiếm
**Cardinality** = Số lượng giá trị phân biệt (distinct) trong một cột

| Column của users một triệu rows | Distinct values | Số matches minh họa | Suy luận ban đầu |
| --- | --- | --- | --- |
| id primary key | 1.000.000 | 1 mỗi key | Lookup thường có lợi |
| email unique | 1.000.000 | 1 mỗi key | Lookup thường có lợi |
| country | 200 | Khoảng 5.000 nếu phân bố đều | Đo phân bố và query projection |
| gender | 3 | Khoảng 333.333 nếu đều | Scan có thể rẻ hơn lookup nhiều rows |
| is_active | 2 | Khoảng 50% nếu đều | Không kết luận index vô dụng cho mọi query |

Giả định phân bố đều chỉ phục vụ minh họa. Cardinality không thay thế selectivity của **giá trị cụ thể**; covering, partial predicate và skew có thể thay đổi plan.

### Ngưỡng Selectivity

| Selectivity | % bảng | Index hữu ích? | Khuyến nghị |
|-------------|---------|---------------|----------------|
| < 1% | Rất ít row | ✅ Chắc chắn | Index sẽ được dùng |
| 1-5% | Phần nhỏ | ✅ Thường có | Index thường được dùng |
| 5-15% | Vừa phải | ⚠️ Có thể | Tùy thuộc row size và optimizer |
| 15-30% | Phần lớn | ⚠️ Khó | Full scan thường nhanh hơn |
| > 30% | Hầu hết bảng | ❌ Không | Full scan nhanh hơn |

### Kiểm tra Cardinality trong thực tế

```sql
-- MySQL: Check index cardinality
SHOW INDEX FROM users;

-- PostgreSQL: Check distinct values
SELECT 
    attname AS column,
    n_distinct AS estimated_distinct_values,
    CASE 
        WHEN n_distinct > 0 THEN n_distinct::text
        ELSE (reltuples * -n_distinct)::bigint::text || ' (fraction: ' || n_distinct || ')'
    END AS cardinality
FROM pg_stats
WHERE tablename = 'users';

-- Manual calculation
SELECT 
    COUNT(DISTINCT email) AS email_cardinality,
    COUNT(DISTINCT gender) AS gender_cardinality,
    COUNT(*) AS total_rows,
    COUNT(DISTINCT email)::float / COUNT(*) AS email_selectivity,
    COUNT(DISTINCT gender)::float / COUNT(*) AS gender_selectivity
FROM users;
```

<SourceRef project="optimization-index-sql-deep-dive" file="kiểm-tra-cardinality-trong-thực-tế/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

---

## 8. Các lỗi thường gặp & Cách phòng tránh

### Lỗi #1: Dùng hàm trên cột đã đánh Index

```sql
-- ❌ BAD: Index on created_at will NOT be used
SELECT * FROM orders WHERE YEAR(created_at) = 2024;

-- Why? Function transforms the column value
-- Database cannot use index because it must evaluate YEAR() for each row

-- ✅ GOOD: Rewrite to use range
SELECT * FROM orders 
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';
```

### Lỗi #2: Chuyển đổi kiểu ngầm định

```sql
-- Table definition: phone_number VARCHAR(20)

-- ❌ BAD: Comparing string to number causes implicit conversion
SELECT * FROM users WHERE phone_number = 1234567890;
-- Database converts EVERY phone_number to number before comparing = full scan!

-- ✅ GOOD: Match the data type
SELECT * FROM users WHERE phone_number = '1234567890';
```

### Lỗi #3: LIKE với wildcard ở đầu

```sql
-- ❌ BAD: Leading wildcard cannot use index
SELECT * FROM products WHERE name LIKE '%phone%';
-- Must scan all values to find matches anywhere in string

-- ⚠️ PARTIAL: Trailing wildcard CAN use index
SELECT * FROM products WHERE name LIKE 'phone%';
-- Can seek to 'phone' in index, then scan forward

-- ✅ BETTER: Use Full-Text Index for search
CREATE FULLTEXT INDEX idx_products_name ON products(name);
SELECT * FROM products WHERE MATCH(name) AGAINST('phone');
```

### Lỗi #4: Điều kiện OR làm mất Index

```sql
-- ❌ BAD: OR can prevent index usage
SELECT * FROM orders 
WHERE customer_id = 100 OR status = 'pending';
-- Index on (customer_id, status) can't efficiently handle OR

-- ✅ GOOD: Use UNION instead
SELECT * FROM orders WHERE customer_id = 100
UNION
SELECT * FROM orders WHERE status = 'pending';
-- Each subquery can use appropriate index
```

### Lỗi #5: Sai thứ tự cột trong Composite Index

```sql
-- Index: (status, customer_id, created_at)

-- ❌ Query can't fully use index
SELECT * FROM orders WHERE customer_id = 100;
-- status is first in index, must be specified first!

-- ✅ Query uses full index
SELECT * FROM orders WHERE status = 'active' AND customer_id = 100;
```

### Bảng tham chiếu đầy đủ các lỗi

| Mistake | Example | Why Index Fails | Prevention |
|---------|---------|-----------------|------------|
| **Function on column** | `WHERE YEAR(date) = 2024` | Value transformed before comparison | Rewrite as range condition |
| **Implicit type conversion** | `WHERE varchar_col = 123` | Column values converted | Match data types exactly |
| **Leading wildcard** | `WHERE name LIKE '%john%'` | No starting point in index | Use full-text search |
| **OR conditions** | `WHERE a = 1 OR b = 2` | Can't use single index efficiently | Use UNION or multiple indexes |
| **Wrong column order** | Index (a,b), query uses only b | Left prefix rule violation | Create index (b) or query both a,b |
| **NOT / != operators** | `WHERE status != 'deleted'` | Must scan for non-matches | Rewrite as positive condition |
| **NULL comparisons** | `WHERE col IS NULL` | Depends on database | Check if index includes NULLs |
| **Expressions** | `WHERE price * 1.1 > 100` | Computation on indexed column | Move computation: `price > 100/1.1` |
| **Too many indexes** | 10+ indexes on one table | Slows down writes significantly | Keep 3-5 well-designed indexes |
| **Over-indexing** | Index every column | Storage waste, slow writes | Only index queried columns |

### Minh họa: Các pattern "giết" Index

| Pattern | Vấn đề có thể gặp | Candidate cần kiểm tra |
| --- | --- | --- |
| LOWER(email)=... | Index email gốc không cung cấp expression order | Index LOWER(email) hoặc chuẩn hóa theo hợp đồng dữ liệu |
| VARCHAR account_id so với integer 12345 | Numeric conversion có thể cản string lookup | Bind chuỗi 12345 với đúng kiểu |
| status <> deleted | Có thể match phần lớn bảng | Đo tỷ lệ match; positive IN chỉ khi tương đương và vẫn phải đo |

---

## 9. Ví dụ thực tế

### Ví dụ 1: Tối ưu query đơn hàng E-Commerce

```sql
-- Scenario: Orders table with 10 million rows
-- Frequent query: Find recent orders for a customer

-- Before optimization: Query takes 15 seconds
SELECT order_id, status, total, created_at
FROM orders
WHERE customer_id = 12345
  AND status IN ('pending', 'processing')
  AND created_at > NOW() - INTERVAL 30 DAY
ORDER BY created_at DESC
LIMIT 20;

-- EXPLAIN shows: type=ALL, rows=10000000 (Full table scan!)
```

```d2 title="Thiết kế và đo composite index cho query orders"
direction: down
n0: "Phân loại predicate: customer_id equality,\nstatus IN, created_at range"
n1: "Xét nhu cầu ORDER BY created_at DESC"
n2: "So candidate\n(customer_id,status,created_at) với\n(customer_id,created_at,status)"
n3: "Tạo candidate index trong môi trường phù\nhợp"
n4: "EXPLAIN và benchmark lại, gồm cả scan,\nsort và chi phí ghi"
n0 -> n1
n1 -> n2
n2 -> n3
n3 -> n4
```

Ví dụ DDL: `CREATE INDEX idx_orders_customer_status_date ON orders(customer_id, status, created_at);`. Candidate A đưa status trước range; candidate B có thể cần lọc status sau access range. **IN nhiều status không tự bảo đảm** candidate A trả được thứ tự `created_at` toàn cục mà không sort. Mốc 15 giây → 5 ms (3.000×) là ví dụ minh họa của bài, không phải kết quả luôn đạt được.

### Ví dụ 2: Tìm kiếm user với Partial Match

```sql
-- Scenario: Search users by name (millions of users)
-- Current index: (name)
-- Problem: Users search like "John%" works, but "John Doe" search is slow

-- Query that's slow:
SELECT * FROM users 
WHERE first_name LIKE 'John%' AND last_name LIKE 'Doe%';

-- Current index: (first_name)
-- Issue: Only first_name uses index, last_name requires full scan of matched rows
```

**Solution: Composite index with both columns**

```sql
-- Create composite index
CREATE INDEX idx_users_name ON users(first_name, last_name);

-- Now both conditions can use the index
-- EXPLAIN shows: type=range, key=idx_users_name

-- For full-text search needs, add full-text index
CREATE FULLTEXT INDEX idx_users_fulltext ON users(first_name, last_name);
SELECT * FROM users WHERE MATCH(first_name, last_name) AGAINST('John Doe');
```

### Ví dụ 3: Covering Index loại bỏ Bookmark Lookup

```sql
-- Scenario: Dashboard showing order summary
-- Query runs millions of times per day

SELECT customer_id, COUNT(*) as order_count, SUM(total) as total_spent
FROM orders
WHERE created_at > NOW() - INTERVAL 7 DAY
GROUP BY customer_id;

-- Current index: (created_at)
-- Problem: After finding rows by date, must go to table for customer_id and total
```

```d2 title="Covering index giảm lần truy cập bảng"
direction: right
before: Trước — index chỉ có created_at {
  index: created_at + row pointer
  table: Table row chứa customer_id, total, ...
  index -> table: lookup thêm
}
after: Sau — index có đủ cột {
  leaf: created_at + customer_id + total
  result: Query có thể lấy các cột từ index
  leaf -> result
}
```

Có thể dùng key `(created_at, customer_id, total)` hoặc `ON orders(created_at) INCLUDE (customer_id, total)` trong PostgreSQL / SQL Server khi phù hợp. MySQL báo `Using index` cho covering access. PostgreSQL vẫn có thể phải kiểm tra heap visibility; xem thêm bài [Clustered vs Nonclustered](/optimization/clustered-vs-nonclustered-index/).

---

## 10. Chiến lược tối ưu Index

### Chiến lược 1: Phân tích query pattern trước

```sql
-- MySQL: Find slow queries
SELECT * FROM mysql.slow_log ORDER BY query_time DESC LIMIT 100;

-- PostgreSQL: Find most time-consuming queries
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY total_time DESC
LIMIT 20;

-- Focus on: High frequency + High execution time queries
```

### Chiến lược 2: Dùng Partial Index (PostgreSQL)

```sql
-- Full index: Indexes ALL 10 million rows
CREATE INDEX idx_orders_status ON orders(status);

-- Partial index: Only indexes 'pending' orders (maybe 10,000 rows)
CREATE INDEX idx_orders_pending ON orders(created_at)
WHERE status = 'pending';

-- Benefits:
-- • Much smaller index (10K vs 10M entries)
-- • Faster to maintain
-- • Faster to scan
-- • Uses less memory
```

### Chiến lược 3: Lịch bảo trì Index

| Task | Frequency | MySQL Command | PostgreSQL Command |
|------|-----------|---------------|-------------------|
| **Analyze statistics** | Daily | `ANALYZE TABLE orders;` | `ANALYZE orders;` |
| **Check fragmentation** | Weekly | `SHOW INDEX FROM orders;` | `SELECT * FROM pg_stat_user_indexes;` |
| **Rebuild index** | Monthly | `ALTER TABLE orders ENGINE=InnoDB;` | `REINDEX INDEX idx_name;` |
| **Find unused indexes** | Monthly | Query performance_schema | Query pg_stat_user_indexes |

### Chiến lược 4: Các query giám sát Index

```sql
-- MySQL: Find unused indexes
SELECT 
    t.TABLE_SCHEMA,
    t.TABLE_NAME,
    s.INDEX_NAME,
    s.COLUMN_NAME,
    s.SEQ_IN_INDEX,
    (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE 
     TABLE_SCHEMA = t.TABLE_SCHEMA AND TABLE_NAME = t.TABLE_NAME) AS total_indexes
FROM information_schema.TABLES t
JOIN information_schema.STATISTICS s ON t.TABLE_SCHEMA = s.TABLE_SCHEMA 
    AND t.TABLE_NAME = s.TABLE_NAME
LEFT JOIN performance_schema.table_io_waits_summary_by_index_usage u
    ON s.TABLE_SCHEMA = u.OBJECT_SCHEMA 
    AND s.TABLE_NAME = u.OBJECT_NAME 
    AND s.INDEX_NAME = u.INDEX_NAME
WHERE u.INDEX_NAME IS NULL
  AND s.INDEX_NAME != 'PRIMARY';

-- PostgreSQL: Find unused indexes
SELECT 
    schemaname || '.' || relname AS table,
    indexrelname AS index,
    pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
    idx_scan AS times_used
FROM pg_stat_user_indexes i
JOIN pg_index USING (indexrelid)
WHERE idx_scan < 50  -- Used less than 50 times
  AND indisunique IS FALSE
ORDER BY pg_relation_size(i.indexrelid) DESC;
```

<SourceRef project="optimization-index-sql-deep-dive" file="chiến-lược-4-các-query-giám-sát-index/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

---

## 11. Monitoring & Bảo trì

### Các chỉ số sức khỏe Index

| Metric | Vùng healthy trong ví dụ | Warning minh họa | Critical minh họa |
| --- | --- | --- | --- |
| Index hit ratio | >99% | 95–99% | <95% |
| Index scans / scan count | >90% | 70–90% | <70% |
| Index bloat | <20% | 20–50% | >50% |
| Unused indexes | 0 | 1–3 | >3 |
| Missing-index suggestions | 0 | 1–2 | >2 |
| Index size / table size | <50% | 50–100% | >100% |

Các ngưỡng này là dashboard minh họa, **không phải SLO mặc định**. Ví dụ workload analytics có thể Seq Scan đúng, và index/table size >100% không tự chứng minh có sự cố. Đặt cảnh báo theo workload và xu hướng.

### PostgreSQL: Phát hiện Index Bloat

```sql
-- Check index bloat
SELECT
    schemaname || '.' || tablename AS table_name,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan AS index_scans,
    ROUND(100.0 * pg_relation_size(indexrelid) / 
          NULLIF(pg_relation_size(tablename::regclass), 0), 2) AS index_to_table_ratio
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;

-- Rebuild bloated index (PostgreSQL)
REINDEX INDEX CONCURRENTLY idx_orders_customer;
```

### MySQL: Thống kê Index InnoDB

```sql
-- Check index statistics
SELECT 
    TABLE_NAME,
    INDEX_NAME,
    COLUMN_NAME,
    CARDINALITY,
    INDEX_TYPE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'your_database'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Update statistics
ANALYZE TABLE orders;
```

### Checklist bảo trì Index

```d2 title="Checklist bảo trì Index"
direction: down
A: "Weekly Index Review"
B: "Check slow query log" { shape: diamond }
C: "Analyze EXPLAIN plans"
D: "Check index usage stats"
E: "Missing index?" { shape: diamond }
F: "Design and create index"
G: "Index exists but not used?" { shape: diamond }
H: "Check for index-killer patterns"
I: "Check for bloat/fragmentation"
J: "Rewrite query to use index"
K: "Unused indexes?" { shape: diamond }
L: "Consider dropping"
M: "Bloat > 30%?" { shape: diamond }
N: "REINDEX / OPTIMIZE TABLE"
O: "Index health OK"
A -> B
B -> C: "Slow queries found"
B -> D: "No issues"
C -> E
E -> F: "Yes"
E -> G: "No"
G -> H: "Yes"
G -> I: "No"
H -> J
D -> K
K -> L: "Yes"
K -> I: "No"
I -> M
M -> N: "Yes"
M -> O: "No"
F -> O
J -> O
L -> O
N -> O
```

---

## Thẻ tham chiếu nhanh

### Cú pháp tạo Index

```sql
-- Basic index
CREATE INDEX idx_name ON table(column);

-- Unique index
CREATE UNIQUE INDEX idx_email ON users(email);

-- Composite index
CREATE INDEX idx_composite ON orders(customer_id, status, created_at);

-- Partial index (PostgreSQL)
CREATE INDEX idx_active ON users(email) WHERE is_active = true;

-- Covering index with INCLUDE (PostgreSQL/SQL Server)
CREATE INDEX idx_covering ON orders(customer_id) INCLUDE (total, status);

-- Functional index (PostgreSQL/MySQL 8.0+)
CREATE INDEX idx_lower_email ON users((LOWER(email)));

-- Full-text index
CREATE FULLTEXT INDEX idx_search ON products(name, description);

-- Drop index
DROP INDEX idx_name ON table;  -- MySQL
DROP INDEX idx_name;           -- PostgreSQL
```

<SourceRef project="optimization-index-sql-deep-dive" file="cú-pháp-tạo-index/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

### Ma trận quyết định chọn Index

| Query Type | Recommended Index | Example |
|------------|-------------------|---------|
| Exact match (`=`) | B-Tree or Hash | `WHERE email = 'x'` → Index on email |
| Range (`<`, `>`, `BETWEEN`) | B-Tree | `WHERE price > 100` → Index on price |
| Prefix search (`LIKE 'abc%'`) | B-Tree | `WHERE name LIKE 'John%'` → Index on name |
| Full-text search | Full-Text Index | `WHERE MATCH(content)` → FULLTEXT on content |
| Low cardinality | Bitmap (Oracle/PG) | `WHERE status IN (...)` → Bitmap on status |
| JSON/Array contains | GIN (PostgreSQL) | `WHERE tags @> '{java}'` → GIN on tags |
| Geospatial | GiST (PostgreSQL) | `WHERE point @> box` → GiST on point |

### Tóm tắt tác động hiệu năng

| Operation | Without Index | With Index | Notes |
|-----------|--------------|------------|-------|
| SELECT with WHERE | O(n) | O(log n) | Massive improvement |
| INSERT | Fast | Slower | Must update all indexes |
| UPDATE (indexed col) | O(n) lookup | O(log n) lookup, O(log n) update | Net benefit if selective |
| DELETE | O(n) lookup | O(log n) lookup | Faster with index |
| JOIN | O(n * m) | O(n * log m) | Index on foreign key |
| ORDER BY | O(n log n) filesort | O(log n + k) | If index matches sort |

---

---

## 12. Tại sao Index không được sử dụng — Deep Dive với ví dụ

Phần này tập trung vào các tình huống bạn TẠO index nhưng database LẠI Bỏ QUA nó.

### Tổng quan: Các tình huống Index bị bỏ qua

Một index tồn tại nhưng query vẫn full scan có thể do:

1. Function/expression hoặc cast không khớp key index.
2. Type conversion làm đổi ngữ nghĩa so sánh.
3. LIKE thiếu leading prefix.
4. OR cần nhiều access paths.
5. Predicate NOT/!=/<> hoặc IS NULL/IS NOT NULL có selectivity khác nhau.
6. Nhiều rows cần trả khiến scan rẻ hơn.
7. Composite key order không phù hợp.
8. Statistics cũ gây estimate sai.
9. Bảng nhỏ, table scan thực sự rẻ.
10. Index hint không áp dụng hoặc không được engine ưu tiên như mong đợi.

Không có ngưỡng tỷ lệ rows cố định cho mọi hệ thống; hãy đo plan, rows và I/O trước khi sửa.

### Lỗi 1: Dùng hàm trên cột đã đánh Index

```sql
-- Setup
CREATE TABLE users (
    id INT PRIMARY KEY,
    email VARCHAR(255),
    created_at DATETIME,
    first_name VARCHAR(100)
);
CREATE INDEX idx_email ON users(email);
CREATE INDEX idx_created_at ON users(created_at);
CREATE INDEX idx_first_name ON users(first_name);

-- ❌ INDEX NOT USED: Function wraps the column
SELECT * FROM users WHERE LOWER(email) = 'john@example.com';
SELECT * FROM users WHERE YEAR(created_at) = 2024;
SELECT * FROM users WHERE SUBSTRING(first_name, 1, 3) = 'Joh';
SELECT * FROM users WHERE created_at + INTERVAL 1 DAY > NOW();

-- Why? Database must apply function to EVERY row before comparing
-- Index stores original values, not function results
```

<SourceRef project="optimization-index-sql-deep-dive" file="lỗi-1-dùng-hàm-trên-cột-đã-đánh-index-1/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

```d2 title="Function trên cột có thể khác key index đang lưu"
direction: down
b0: "Index email" {
  n0: "Các keys: John@Example.com,\nJANE@COMPANY.COM, bob@test.org"
  n1: "Index được tạo cho giá trị email gốc"
  n0 -> n1
}
b1: "Predicate LOWER(email)" {
  n0: "Tìm john@example.com sau khi LOWER"
  n1: "Không tự có ordered access trên expression\nchưa được index"
  n0 -> n1
}
```

Các lựa chọn theo hợp đồng dữ liệu và engine:

1. Lưu email chuẩn hóa lowercase và so sánh trực tiếp: `SELECT * FROM users WHERE email = 'john@example.com';` nếu đây là ngữ nghĩa mong muốn.
2. Expression index, ví dụ `CREATE INDEX idx_email_lower ON users((LOWER(email)));`, rồi query cùng expression; kiểm tra cú pháp từng database.
3. MySQL generated column: `ALTER TABLE users ADD email_lower VARCHAR(255) GENERATED ALWAYS AS (LOWER(email)) STORED;` rồi `CREATE INDEX idx_email_lower ON users(email_lower);`.

Collation và khả năng rewrite của engine cũng ảnh hưởng, không khẳng định mọi LOWER luôn full scan.

**Date Function Examples:**

```sql
-- ❌ BAD: Function on date column
SELECT * FROM orders WHERE YEAR(created_at) = 2024;
SELECT * FROM orders WHERE DATE(created_at) = '2024-01-15';
SELECT * FROM orders WHERE MONTH(created_at) = 12;

-- ✅ GOOD: Range conditions (index-friendly)
SELECT * FROM orders 
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';

SELECT * FROM orders 
WHERE created_at >= '2024-01-15' AND created_at < '2024-01-16';

SELECT * FROM orders 
WHERE created_at >= '2024-12-01' AND created_at < '2025-01-01';
```

### Lỗi 2: Chuyển đổi kiểu ngầm định

```sql
-- Setup
CREATE TABLE accounts (
    id INT PRIMARY KEY,
    account_number VARCHAR(20),  -- String type!
    phone VARCHAR(15),
    zipcode VARCHAR(10)
);
CREATE INDEX idx_account ON accounts(account_number);
CREATE INDEX idx_phone ON accounts(phone);

-- ❌ INDEX NOT USED: Comparing string column with number
SELECT * FROM accounts WHERE account_number = 12345;
SELECT * FROM accounts WHERE phone = 1234567890;

-- What happens internally:
-- MySQL converts: VARCHAR → INT for comparison
-- This means: CAST(account_number AS INT) = 12345
-- Now it's a function on column → index ignored!
```

```d2 title="Chuyển VARCHAR sang số làm mất đường lookup chuỗi"
direction: right
n0: "Column account_number: VARCHAR(20)"
n1: "Predicate dùng integer 12345"
n2: "Trong ví dụ MySQL: so sánh theo số,\nconvert giá trị cột"
n3: "Có thể mất hiệu quả string index và mất ý\nnghĩa chuỗi"
n0 -> n1
n1 -> n2
n2 -> n3
```

| Giá trị chuỗi | Giá trị số trong ví dụ |
| --- | --- |
| 12345 | 12345 |
| 12346 | 12346 |
| 00123 | 123 |
| ABC12 | 0, có thể kèm warning/error tùy ngữ cảnh |

Khớp kiểu bind parameter và column: `SELECT * FROM accounts WHERE account_number = '12345';`. Chuyển kiểu có thể làm mất leading zeros hoặc tạo kết quả không mong muốn; kiểm tra SQL mode và engine.

**Type Conversion Rules:**

| Column Type | Query Value | Index Used? | Fix |
|-------------|-------------|-------------|-----|
| VARCHAR | `= 12345` (int) | ❌ No | `= '12345'` |
| INT | `= '12345'` (string) | ✅ Yes* | `= 12345` |
| DATE | `= '2024-01-15'` (string) | ✅ Yes | OK as-is |
| DATETIME | `= '2024-01-15'` | ⚠️ Partial | Include time or use range |

*MySQL converts string to int without function on column

### Lỗi 3: LIKE với Leading Wildcard

```sql
CREATE INDEX idx_name ON products(name);

-- ❌ INDEX NOT USED: Leading wildcard
SELECT * FROM products WHERE name LIKE '%phone%';
SELECT * FROM products WHERE name LIKE '%Apple%';

-- ⚠️ INDEX PARTIALLY USED: Trailing wildcard only
SELECT * FROM products WHERE name LIKE 'iPhone%';  -- Uses index!
SELECT * FROM products WHERE name LIKE 'Samsung Galaxy%';  -- Uses index!

-- ❌ INDEX NOT USED: Wildcard at start
SELECT * FROM products WHERE name LIKE '%Phone 15';
```

```d2 title="LIKE prefix có điểm bắt đầu; substring thì không"
direction: down
b0: "LIKE iPhone%" {
  n0: "B-Tree theo name: Apple Watch, Galaxy\nPhone, iPhone 15, MacBook, Pixel, Samsung\nTV"
  n1: "Seek vào prefix iPhone nếu\ncollation/operator class phù hợp"
  n2: "Scan trong khoảng prefix"
  n0 -> n1
  n1 -> n2
}
b1: "LIKE %Phone%" {
  n0: "Phone có thể xuất hiện ở bất kỳ vị trí nào"
  n1: "Không có một prefix range đơn giản"
  n2: "Cần scan hoặc access path search chuyên\ndụng"
  n0 -> n1
  n1 -> n2
}
```

Các hướng khác tùy nhu cầu:

- Full-text theo token: MySQL `CREATE FULLTEXT INDEX idx_name_ft ON products(name);`, query `MATCH(name) AGAINST('phone')`. **Không đồng nghĩa** substring matching.
- Suffix: index expression `REVERSE(name)`, rồi so pattern đảo tương ứng; ví dụ `REVERSE(name) LIKE REVERSE('%Phone 15')` khi engine hỗ trợ dùng index.
- PostgreSQL trigram: `CREATE INDEX idx_name_trgm ON products USING gin(name gin_trgm_ops);`, dùng pattern như `name LIKE '%phone%'` khi extension và plan phù hợp.

### Lỗi 4: Điều kiện OR

```sql
CREATE INDEX idx_customer ON orders(customer_id);
CREATE INDEX idx_status ON orders(status);

-- ❌ INDEX MAY NOT BE USED EFFICIENTLY
SELECT * FROM orders 
WHERE customer_id = 100 OR status = 'pending';

-- Why? Single index can't handle OR between different columns
-- Database might choose full table scan if:
-- • Both conditions return many rows
-- • Cost of index merge > full scan
```

```d2 title="OR có thể kết hợp hai tập row locations"
direction: right
customer: "idx_customer: customer_id=100 →\n{1,5,10,...}"
status: "idx_status: status=pending → {2,5,15,...}"
union: "UNION row IDs → {1,2,5,10,15,...}"
fetch: "Fetch rows theo IDs"
customer -> union
status -> union
union -> fetch
```

Query là `customer_id=100 OR status='pending'`. Chỉ lookup một nhánh không đủ trả đúng cả hai điều kiện. Engine có thể dùng index merge/BitmapOr, hoặc scan nếu hai nhánh trả nhiều rows.

Có thể viết hai SELECT với `UNION`, nhưng **không bảo đảm** optimizer dùng cả hai index. `UNION` loại trùng; `UNION ALL` cần xử lý trường hợp một row thỏa cả hai nhánh. Composite `(customer_id,status)` không tự giải quyết OR giữa hai cột bằng một prefix seek; chọn thiết kế theo plan và ngữ nghĩa.

### Lỗi 5: Toán tử NOT, !=, <>

```sql
CREATE INDEX idx_status ON orders(status);

-- ❌ INDEX OFTEN NOT USED
SELECT * FROM orders WHERE status != 'deleted';
SELECT * FROM orders WHERE status <> 'cancelled';
SELECT * FROM orders WHERE NOT status = 'archived';

-- Why? Negative conditions often match MOST rows
-- Full scan might be faster than index scan + row lookup
```

```d2 title="Predicate phủ 99% bảng thường làm lookup kém hấp dẫn"
direction: down
b0: "Index path" {
  n0: "status != deleted trả 990.000 trong một\ntriệu rows"
  n1: "Duyệt entries và lấy rows; có thể nhiều\nrandom heap accesses"
  n0 -> n1
}
b1: "Table scan" {
  n0: "Đọc tuần tự bảng"
  n1: "Lọc bỏ 10.000 deleted rows"
  n2: "Có thể rẻ hơn trong cost model"
  n0 -> n1
  n1 -> n2
}
```

| Status | Rows | Tỷ lệ |
| --- | --- | --- |
| active | 500.000 | 50% |
| completed | 400.000 | 40% |
| pending | 90.000 | 9% |
| deleted | 10.000 | 1% |

Không đồng nhất 990.000 lookups với 990.000 physical reads. Viết `status IN ('active','completed','pending')` chỉ đúng nếu bao quát đúng ngữ nghĩa, và không tự làm 99% rows thành ít selective. Có thể đánh giá partial index `ON orders(created_at) WHERE status != 'deleted'` hoặc `ON orders(created_at) WHERE is_deleted = FALSE`; nếu giữ 99% bảng, lợi ích vẫn cần đo.

### Lỗi 6: Selectivity thấp / Cardinality thấp

```sql
CREATE INDEX idx_gender ON users(gender);  -- Only 'M', 'F', 'Other'
CREATE INDEX idx_active ON users(is_active);  -- Only TRUE, FALSE

-- ❌ INDEX IGNORED BY OPTIMIZER
SELECT * FROM users WHERE gender = 'M';  -- Returns 50% of table
SELECT * FROM users WHERE is_active = TRUE;  -- Returns 90% of table

-- Optimizer calculates:
-- "Using index returns too many rows, full scan is faster"
```

```d2 title="Optimizer so chi phí index và full scan khi trả nhiều rows"
direction: down
b0: "Index Scan" {
  n0: "Đọc index"
  n1: "Nhiều bookmark / heap lookups"
  n2: "Random access và cache ảnh hưởng tổng cost"
  n0 -> n1
  n1 -> n2
}
b1: "Full scan" {
  n0: "Đọc table pages theo access path scan"
  n1: "Lọc kết quả"
  n2: "Có thể rẻ hơn khi cần phần lớn dữ liệu"
  n0 -> n1
  n1 -> n2
}
```

Không có luật “15–30% thì phải full scan”. Các lựa chọn cần đo gồm:

- Thêm điều kiện giảm số rows thực cần: index `(gender,created_at)`, query `gender='M' AND created_at>'2024-01-01'`.
- Covering theo engine, ví dụ `ON users(gender) INCLUDE(name,email)` để phục vụ `SELECT name,email ...`; PostgreSQL còn xét visibility.
- Chấp nhận full scan nếu thật sự rẻ hơn. Các số 500.000 lookups hay 10–100× I/O chỉ là mô hình minh họa, không phải benchmark.

### Lỗi 7: Sai thứ tự cột trong Composite Index

```sql
CREATE INDEX idx_status_customer_date ON orders(status, customer_id, created_at);

-- ✅ INDEX USED (follows left-to-right rule)
SELECT * FROM orders WHERE status = 'active';
SELECT * FROM orders WHERE status = 'active' AND customer_id = 100;
SELECT * FROM orders WHERE status = 'active' AND customer_id = 100 
                      AND created_at > '2024-01-01';

-- ❌ INDEX NOT USED (skips leftmost column)
SELECT * FROM orders WHERE customer_id = 100;  -- Skips 'status'!
SELECT * FROM orders WHERE created_at > '2024-01-01';  -- Skips 'status' and 'customer_id'!

-- ⚠️ INDEX PARTIALLY USED
SELECT * FROM orders WHERE status = 'active' AND created_at > '2024-01-01';
-- Uses 'status' only, can't use 'created_at' (skipped customer_id)
```

```d2 title="Customer 100 rải qua nhiều nhóm status trong composite key"
direction: right
query: "WHERE customer_id=100"
active: "Nhóm status=active"
pending: "Nhóm status=pending"
a: "Rows 5,12 của customer 100"
p: "Row 15 của customer 100"
query -> active
query -> pending
active -> a
pending -> p
```

Index đang xét là `(status,customer_id,created_at)`, sắp theo status trước.

| status | customer_id | created_at | Row |
| --- | --- | --- | --- |
| active | 100 | 2024-01-01 | 5 |
| active | 100 | 2024-01-15 | 12 |
| active | 101 | 2024-01-05 | 3 |
| active | 102 | 2024-01-10 | 8 |
| pending | 100 | 2024-01-20 | 15 |
| pending | 103 | 2024-01-02 | 1 |

Một prefix seek đơn giản không gom mọi customer 100 thành một khoảng theo cột đầu; engine vẫn có thể chọn scan/skip scan khác. Với query chủ yếu theo customer, đánh giá index `(customer_id)` hoặc `(customer_id,status,created_at)` cho query có thêm status và range date.

### Lỗi 8: Statistics lỗi thời

```sql
-- After massive data changes (bulk insert/delete)
-- Index statistics become stale

-- Symptom: Optimizer makes wrong decisions
-- Query uses wrong index or ignores good index

-- ✅ SOLUTION: Update statistics

-- MySQL
ANALYZE TABLE orders;

-- PostgreSQL
ANALYZE orders;
-- Or more aggressive:
VACUUM ANALYZE orders;

-- SQL Server
UPDATE STATISTICS orders;
-- Or:
EXEC sp_updatestats;
```

---

## 13. Làm sao biết Index nào sẽ được dùng

### Sử dụng EXPLAIN (MySQL)

```sql
-- Basic EXPLAIN
EXPLAIN SELECT * FROM orders WHERE customer_id = 100;

-- EXPLAIN with more details
EXPLAIN FORMAT=JSON SELECT * FROM orders WHERE customer_id = 100;

-- EXPLAIN ANALYZE (MySQL 8.0+) - Actually executes query
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 100;
```

| id | select_type | table | type | possible_keys | key | key_len | rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SIMPLE | orders | ref | idx_customer | idx_cust | 4 | 150 |

| Field | Đọc như thế nào |
| --- | --- |
| possible_keys | Indexes có thể dùng |
| key | Index thực sự chọn |
| key_len | Số byte key dùng cho access |
| rows | Estimated rows |
| type | system / const / eq_ref / ref / range / index / ALL |
| Extra | Thông tin thực thi bổ sung |

| Extra | Ý nghĩa |
| --- | --- |
| Using index | Covering access trong MySQL |
| Using where | Có filter |
| Using filesort | Có sort ngoài thứ tự access hiện tại |
| Using temporary | Có internal temporary table |
| Using index condition | Index condition pushdown |

`system`/`const`/`eq_ref` mô tả các kiểu lookup hẹp; `ref`/`range` vẫn có thể trả nhiều rows; `index` quét index; `ALL` quét table. Không xếp “tốt/xấu” chỉ theo tên access type.

### Sử dụng EXPLAIN (PostgreSQL)

```sql
-- Basic EXPLAIN
EXPLAIN SELECT * FROM orders WHERE customer_id = 100;

-- With actual execution stats
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 100;

-- More verbose
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) 
SELECT * FROM orders WHERE customer_id = 100;
```

Ví dụ PostgreSQL — giữ execution plan để đối chiếu:

```text
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 100;
Index Scan using idx_customer on orders
  (cost=0.43..8.45 rows=1 width=100)
  (actual time=0.025..0.026 rows=1 loops=1)
  Index Cond: (customer_id = 100)
Planning Time: 0.085 ms
Execution Time: 0.045 ms
```

| Scan type | Ý nghĩa |
| --- | --- |
| Seq Scan | Scan table |
| Index Scan | Đọc index rồi fetch rows |
| Index Only Scan | Có đủ cột ở index; PostgreSQL vẫn có thể kiểm tra heap visibility |
| Bitmap Index Scan | Xây bitmap row locations |
| Bitmap Heap Scan | Đọc heap theo bitmap |

`cost=startup_cost..total_cost rows=X width=Y`: cost là đơn vị planner, rows là ước lượng, width là độ rộng row trung bình theo byte. `actual time=X..Y rows=Z loops=N`: time theo milliseconds; rows và time ở node lặp là giá trị trung bình mỗi loop.

### Đọc EXPLAIN: Ví dụ thực tế

```sql
-- Example 1: Good - Index is used
EXPLAIN SELECT * FROM users WHERE email = 'john@example.com';
```
```text
Index Scan using idx_email on users
  Index Cond: (email = 'john@example.com')
```

Index được dùng; tiếp tục kiểm tra rows, loops và I/O để đánh giá hiệu quả.

```sql
-- Example 2: Bad - Full table scan
EXPLAIN SELECT * FROM users WHERE LOWER(email) = 'john@example.com';
```
```text
Seq Scan on users
  Filter: (lower(email) = 'john@example.com')
```

Plan này scan và filter LOWER(email). Kiểm tra expression index hoặc cách chuẩn hóa dữ liệu; không kết luận mọi Seq Scan đều sai.

```sql
-- Example 3: Covering index (best)
EXPLAIN SELECT email, name FROM users WHERE email = 'john@example.com';
-- Index: CREATE INDEX idx_email_cover ON users(email) INCLUDE (name);
```
```text
Index Only Scan using idx_email_cover on users
  Index Cond: (email = 'john@example.com')
```

Covering path được chọn. PostgreSQL còn có thể đọc heap để kiểm tra visibility, xem Heap Fetches.

### Sơ đồ chẩn đoán nhanh

```d2 title="Sơ đồ chẩn đoán nhanh"
direction: down
A: "Query is slow"
B: "Run EXPLAIN"
C: "Check 'type' or scan type" { shape: diamond }
D: "❌ No index used!"
E: "⚠️ Index used but check..."
F: "✅ Index used efficiently"
G: "Index exists?" { shape: diamond }
H: "Create appropriate index"
I: "Why not used?" { shape: diamond }
J: "Check for functions on column"
K: "Check for type mismatch"
L: "Check column order"
M: "Check selectivity"
N: "Check 'Extra' field" { shape: diamond }
O: "✅ Covering index - Perfect!"
P: "⚠️ Add ORDER BY column to index"
Q: "⚠️ Optimize GROUP BY"
R: "Rewrite query or create functional index"
S: "Fix data types in query"
T: "Create index with correct column order"
U: "Combine with selective columns or accept full scan"
A -> B
B -> C
C -> D: "ALL / Seq Scan"
C -> E: "index / Index Scan"
C -> F: "ref / const"
D -> G
G -> H: "No"
G -> I: "Yes"
I -> J
I -> K
I -> L
I -> M
E -> N
N -> O: "Using index"
N -> P: "Using filesort"
N -> Q: "Using temporary"
J -> R
K -> S
L -> T
M -> U
```

---

## 14. Tóm tắt Best Practices

### Nên và Không nên

| Category | ✅ DO | ❌ DON'T |
|----------|-------|---------|
| **Chọn cột** | Đánh index cột trong WHERE, JOIN, ORDER BY | Đánh index mọi cột |
| **Thứ tự cột** | Đặt cột equality trước, range sau | Thứ tự ngẫu nhiên trong composite index |
| **Selectivity** | Đánh index cột selectivity cao | Đánh index cột boolean/gender riêng |
| **Viết query** | Dùng đúng data type | So sánh varchar với int |
| **Viết query** | Dùng range cho ngày tháng | Dùng YEAR()/MONTH() |
| **Viết query** | Dùng trailing wildcard LIKE 'abc%' | Dùng leading wildcard LIKE '%abc' |
| **Số lượng index** | 3-5 index thiết kế tốt | 10+ index mỗi bảng |
| **Bảo trì** | Chạy ANALYZE định kỳ | Bỏ qua statistics lỗi thời |
| **Giám sát** | Kiểm tra slow query log | Giả định index đang hoạt động |
| **Covering** | Bao gồm cột SELECT thường dùng | Luôn SELECT * |

### Checklist thiết kế Index

**Trước khi tạo:**

- [ ] Xác định workload từ slow query log và query patterns.
- [ ] Kiểm tra index tương tự/overlap.
- [ ] Đo selectivity theo giá trị thật, không chỉ số distinct.
- [ ] Tính write/storage cost.

**Thiết kế:**

- [ ] Xét equality prefix, ranges và nhu cầu ORDER BY/LIMIT cùng nhau.
- [ ] Đừng coi selectivity cao luôn phải đứng đầu mọi composite index.
- [ ] Kiểm tra order nhiều range/IN và covering theo engine.

**Sau khi tạo:**

- [ ] Đọc EXPLAIN, so rows và actual I/O/time.
- [ ] Xác nhận hiệu năng query cải thiện dưới tải tương đương.
- [ ] Đo tác động ghi và memory/cache.

**Vận hành:** theo dõi usage, index thừa, statistics và bloat. Rebuild chỉ khi có lý do và kế hoạch, không chạy định kỳ máy móc.

### Quick Reference: Index Problem Diagnosis

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| EXPLAIN shows `ALL` / `Seq Scan` | No usable index | Create appropriate index |
| EXPLAIN shows index but query slow | Bookmark lookups | Create covering index |
| Index exists but `key` is NULL | Function/type issue | Check query for issues |
| `rows` estimate very high | Low selectivity | Add more selective columns |
| `Using filesort` in Extra | ORDER BY not in index | Add ORDER BY column to index |
| `Using temporary` in Extra | GROUP BY optimization | Review GROUP BY columns |
| Index used for some queries, not others | Column order mismatch | Check left-prefix rule |
| Query was fast, now slow | Stale statistics | Run ANALYZE |

### SQL to Check Index Health

```sql
-- MySQL: Find queries not using indexes
SELECT * FROM sys.statements_with_full_table_scans 
ORDER BY no_index_used_count DESC 
LIMIT 10;

-- MySQL: Find unused indexes
SELECT 
    object_schema AS database_name,
    object_name AS table_name,
    index_name
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE index_name IS NOT NULL
  AND count_star = 0
  AND object_schema NOT IN ('mysql', 'performance_schema');

-- PostgreSQL: Find unused indexes
SELECT 
    schemaname || '.' || relname AS table,
    indexrelname AS index,
    pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
    idx_scan AS scans
FROM pg_stat_user_indexes i
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%pkey%'
ORDER BY pg_relation_size(i.indexrelid) DESC;

-- PostgreSQL: Index hit ratio
SELECT 
    sum(idx_blks_hit) / nullif(sum(idx_blks_hit + idx_blks_read), 0) AS index_hit_ratio
FROM pg_statio_user_indexes;
-- Should be > 0.99 (99%)
```

---

## Summary

> **Golden Rules of Indexing:**
> 1. Always analyze before creating - use EXPLAIN
> 2. Index columns in WHERE, JOIN, ORDER BY, GROUP BY
> 3. Put high selectivity columns first in composite indexes
> 4. Avoid functions on indexed columns
> 5. Monitor and remove unused indexes
> 6. Consider covering indexes for frequently run queries
> 7. Update statistics regularly
> 8. Don't over-index - each index slows writes
