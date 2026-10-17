---
title: "Tôi đã tạo index rồi mà query vẫn Seq Scan?"
description: "Câu hỏi phỏng vấn: đã CREATE INDEX trên đúng cột trong WHERE mà optimizer vẫn chọn Seq Scan. Mổ xẻ 10 nguyên nhân: selectivity thấp, type mismatch/implicit cast, function trên cột, LIKE '%x%', statistics cũ, OR, NULL, sai thứ tự composite, bảng nhỏ, và cách chẩn đoán bằng EXPLAIN."
---

<SourceRef project="interview-index-not-used-seq-scan" variant="button">
Mở các đoạn code trong bài
</SourceRef>

Các file trong Source Explorer là **snippet độc lập**, giữ nguyên ngữ cảnh và database của từng mục; không chạy nối tiếp tất cả như một script.

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [Tư duy nền: optimizer chọn theo CHI PHÍ, không theo "có index hay không"](#3-tư-duy-nền-optimizer-chọn-theo-chi-phí-không-theo-có-index-hay-không)
- [Nguyên nhân 1: Selectivity thấp — index không đáng dùng](#4-nguyên-nhân-1-selectivity-thấp--index-không-đáng-dùng)
- [Nguyên nhân 2: Type mismatch / implicit cast](#5-nguyên-nhân-2-type-mismatch--implicit-cast)
- [Nguyên nhân 3: Function/biểu thức bọc quanh cột](#6-nguyên-nhân-3-functionbiểu-thức-bọc-quanh-cột)
- [Nguyên nhân 4: LIKE '%x%' và leading wildcard](#7-nguyên-nhân-4-like-x-và-leading-wildcard)
- [Nguyên nhân 5: Statistics cũ / sai](#8-nguyên-nhân-5-statistics-cũ--sai)
- [Nguyên nhân 6-10: OR, NULL, composite sai thứ tự, ORDER BY, bảng nhỏ](#9-nguyên-nhân-6-10-or-null-composite-sai-thứ-tự-order-by-bảng-nhỏ)
- [Quy trình chẩn đoán bằng EXPLAIN](#10-quy-trình-chẩn-đoán-bằng-explain)
- [Câu hỏi đào sâu](#11-câu-hỏi-đào-sâu)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#12-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi có `CREATE INDEX idx_orders_status ON orders(status)`. Tôi chạy `SELECT * FROM orders WHERE status = 'paid'`. Nhưng `EXPLAIN` cho thấy **Seq Scan**, không dùng index! Index sờ sờ ra đó. Optimizer bị lỗi à? Làm sao bắt nó dùng index?"*

> [!IMPORTANT]
> 99% trường hợp optimizer **không** bị lỗi — nó cố tình **không** dùng index vì một trong hai lý do: (a) dùng index **đắt hơn** seq scan trong trường hợp này, hoặc (b) nó **không thể** dùng index vì cách bạn viết query/đặt kiểu dữ liệu. Câu hỏi này kiểm tra xem bạn hiểu **optimizer quyết định theo chi phí** hay chỉ nghĩ "có index là phải dùng".

---

## 2. Câu trả lời 30 giây

> Optimizer chọn plan theo **chi phí ước lượng**, không theo "có index hay không". Hai nhóm nguyên nhân khiến nó bỏ index:
>
> **(A) Dùng index không đáng** — điều kiện khớp quá nhiều dòng (selectivity thấp). Nếu `status='paid'` chiếm 70% bảng, đọc index rồi nhảy về heap từng dòng (random I/O) còn **đắt hơn** quét tuần tự cả bảng → seq scan rẻ hơn → optimizer chọn đúng.
>
> **(B) Không thể dùng index** — query làm index "vô hiệu": **type mismatch** (`user_id = '123'` khi cột là bigint mà... thực ra cast ngược), **function trên cột** (`LOWER(email) = ...`), **leading wildcard** (`LIKE '%abc'`), **statistics cũ** khiến optimizer ước lượng sai, hoặc bảng quá nhỏ.
>
> Chẩn đoán: `EXPLAIN (ANALYZE, BUFFERS)` so `rows` ước lượng vs thực tế; nếu lệch lớn → ANALYZE lại. Kiểm tra kiểu dữ liệu, bỏ function khỏi cột, dùng expression index nếu cần.

---

## 3. Tư duy nền: optimizer chọn theo CHI PHÍ, không theo "có index hay không"

```d2 title="Optimizer chọn plan theo estimated cost"
direction: down
query: "Cách rẻ nhất để lấy dữ liệu?"
seq: "Seq Scan: đọc tuần tự table pages"
idx: "Index Scan: đọc index và fetch heap"
only: "Index-Only: đủ cột; xét thêm visibility"
bitmap: "Bitmap: gom row locations rồi đọc heap\ntheo page"
choose: "Chọn estimated cost thấp nhất"
query -> seq
query -> idx
query -> only
query -> bitmap
seq -> choose
idx -> choose
only -> choose
bitmap -> choose
```

Không chỉ kiểm tra index có tồn tại hay không. Cache, độ phân bố key và cost model ảnh hưởng quyết định.

> [!NOTE]
> Index scan dùng **random I/O** (nhảy lung tung trên heap), trong khi seq scan dùng **sequential I/O** (đọc liền mạch, có read-ahead). Sequential nhanh hơn random nhiều — nên nếu phải lấy *nhiều* dòng, seq scan thắng. Index chỉ thắng khi lấy **một phần nhỏ** dữ liệu. Đây là gốc rễ của nguyên nhân #1.

---

## 4. Nguyên nhân 1: Selectivity thấp — index không đáng dùng

**Selectivity** = phần dữ liệu mà điều kiện lọc ra. Index hiệu quả khi selectivity **cao** (lọc ra ít dòng).

```d2 title="Hai độ chọn lọc tạo ra chi phí khác nhau"
direction: down
b0: "paid — 70% của bảng 50M rows" {
  n0: "Index: 35M entries và nhiều heap fetch"
  n1: "Seq Scan: 50M rows tuần tự"
  n2: "Trong ví dụ cost model chọn Seq Scan"
  n0 -> n1
  n1 -> n2
}
b1: "refunded — 0,1%" {
  n0: "Index: khoảng 50K entries và heap fetch"
  n1: "Seq Scan vẫn xét cả 50M rows"
  n2: "Trong ví dụ cost model chọn Index Scan"
  n0 -> n1
  n1 -> n2
}
```

> [!IMPORTANT]
> Rule of thumb: nếu điều kiện khớp hơn ~**5-10%** số dòng, seq scan thường thắng. Đây **không phải bug** — đó là optimizer làm đúng việc. Một cột `status` chỉ có 3-4 giá trị (low cardinality) thường **không đáng** đánh index B-Tree thường; cân nhắc **partial index** cho giá trị hiếm:
> ```sql
> CREATE INDEX idx_orders_refunded ON orders(id) WHERE status = 'refunded';
> ```

Trên cùng một bảng, **cùng một index** có thể được dùng cho giá trị hiếm và bị bỏ cho giá trị phổ biến — vì selectivity khác nhau. Optimizer dựa vào **statistics** để biết điều này (xem nguyên nhân #5).

---

## 5. Nguyên nhân 2: Type mismatch / implicit cast

Nếu kiểu của cột và kiểu của hằng/tham số không khớp, DB có thể phải **cast cả cột** → index trên cột gốc trở nên vô dụng.

```sql
-- Cột phone là VARCHAR, nhưng query truyền số
SELECT * FROM users WHERE phone = 84901234567;
-- → DB phải cast phone::bigint cho từng dòng → index trên phone (text) vô hiệu → Seq Scan

-- ✅ Truyền đúng kiểu (chuỗi)
SELECT * FROM users WHERE phone = '84901234567';   -- dùng index
```

Tình huống kinh điển khác: so sánh `bigint` với `numeric`, `timestamp` với `timestamptz`, `int` với `text`. Postgres khá nghiêm về kiểu; cast ngầm có thể chặn index.

> [!WARNING]
> Trong code ứng dụng, driver/ORM đôi khi bind sai kiểu (vd bind số cho cột text, hoặc ngược lại). Kiểm tra trong `EXPLAIN` xem có xuất hiện cast kiểu `(phone)::bigint` quanh **cột** không — nếu cast bọc **cột** (không phải bọc hằng số) thì index thường bị vô hiệu.

---

## 6. Nguyên nhân 3: Function/biểu thức bọc quanh cột

Index B-Tree thường lưu **giá trị nguyên gốc của cột**. Nếu bạn bọc cột trong một function, giá trị đó **không có trong index**:

```sql
-- ❌ Index trên email vô hiệu vì LOWER() biến đổi cột
SELECT * FROM users WHERE LOWER(email) = 'a@b.com';   -- Seq Scan

-- Cách sửa 1: Expression index (index trên chính biểu thức)
CREATE INDEX idx_users_email_lower ON users (LOWER(email));
-- giờ query trên dùng được index

-- ❌ Tương tự với ngày
SELECT * FROM orders WHERE DATE(created_at) = '2026-01-01';   -- vô hiệu index trên created_at

-- ✅ Viết lại thành range (sargable) → dùng index trên created_at
SELECT * FROM orders
WHERE created_at >= '2026-01-01' AND created_at < '2026-01-02';
```

> [!NOTE]
> Thuật ngữ: điều kiện dùng được index gọi là **sargable** (Search ARGument ABLE). `col = value` và `col BETWEEN a AND b` là sargable. `func(col) = value`, `col + 1 = value`, `col || 'x' = ...` thường **không** sargable. Quy tắc: **để cột đứng một mình một bên dấu so sánh**, đưa mọi biến đổi sang phía hằng số.

---

## 7. Nguyên nhân 4: LIKE '%x%' và leading wildcard

```sql
-- ✅ Prefix search — DÙNG được index B-Tree
SELECT * FROM products WHERE name LIKE 'iPhone%';

-- ❌ Leading wildcard — KHÔNG dùng được B-Tree
SELECT * FROM products WHERE name LIKE '%phone%';   -- Seq Scan
```

Vì B-Tree sắp theo thứ tự từ **đầu chuỗi**. `'iPhone%'` xác định được khoảng đầu để seek. `'%phone%'` thì ký tự đầu là bất kỳ → không seek được → phải quét hết.

Giải pháp cho tìm kiếm chứa/đầy đủ văn bản:

```sql
-- pg_trgm GIN index cho LIKE/ILIKE chứa chuỗi
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_products_name_trgm ON products USING GIN (name gin_trgm_ops);
-- giờ '%phone%' dùng được GIN

-- Hoặc full-text search cho tìm theo từ
CREATE INDEX idx_products_fts ON products USING GIN (to_tsvector('english', name));
```

> [!TIP]
> Xem bài chuyên sâu về vấn đề này trong mục Tối ưu hóa (LIKE query deep dive) để hiểu trigram, độ chọn lọc của pattern, và collation ảnh hưởng prefix scan ra sao.

---

## 8. Nguyên nhân 5: Statistics cũ / sai

Optimizer ước lượng selectivity dựa trên **statistics** (`pg_statistic`, cập nhật bởi `ANALYZE`/autovacuum). Nếu thống kê cũ, nó có thể ước lượng sai → chọn plan sai.

```sql
-- Triệu chứng: rows ước lượng LỆCH XA rows thực tế
EXPLAIN (ANALYZE) SELECT * FROM orders WHERE status = 'refunded';
```

```text
 Seq Scan on orders
   (cost=... rows=2,500,000 ...)        ← ước lượng 2.5 triệu
   (actual ... rows=5,000 ...)          ← thực tế chỉ 5 nghìn!
   Filter: (status = 'refunded')
```

Ước lượng 2.5 triệu (sai) khiến nó nghĩ "nhiều dòng quá, seq scan đi". Thực tế chỉ 5k → đáng lẽ phải index scan. Sửa:

```sql
ANALYZE orders;   -- cập nhật statistics
-- Với cột phân bố lệch, tăng độ chi tiết histogram:
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;
ANALYZE orders;
```

> [!IMPORTANT]
> Dấu hiệu vàng của "statistics sai": **`rows` ước lượng lệch xa `rows` thực tế** trong `EXPLAIN ANALYZE`. Đây là điều đầu tiên cần kiểm tra khi plan có vẻ "ngu". Sau bulk load / restore / migration lớn, **luôn chạy `ANALYZE`** trước khi đánh giá hiệu năng.

---

## 9. Nguyên nhân 6-10: OR, NULL, composite sai thứ tự, ORDER BY, bảng nhỏ

### 6. OR giữa các cột khác nhau

```sql
-- ❌ OR ngăn dùng một index đơn
SELECT * FROM users WHERE email = 'a@b.com' OR phone = '0900';
-- → có thể Seq Scan, hoặc BitmapOr hai index (nếu cả hai cột có index)

-- ✅ UNION tách thành 2 truy vấn dùng index riêng
SELECT * FROM users WHERE email = 'a@b.com'
UNION
SELECT * FROM users WHERE phone = '0900';
```

### 7. Composite index sai thứ tự cột (leftmost prefix)

```sql
CREATE INDEX idx ON orders (user_id, created_at);

WHERE user_id = 42                       -- ✅ dùng (prefix trái)
WHERE user_id = 42 AND created_at > ...  -- ✅ dùng cả hai
WHERE created_at > ...                   -- ❌ KHÔNG dùng (bỏ qua cột trái user_id)
```

Index composite chỉ dùng được khi query chạm tới **prefix bên trái**. Lọc riêng `created_at` không tận dụng được index `(user_id, created_at)`.

### 8. IS NULL / NOT trên cột

`!=`, `NOT IN`, `IS NOT NULL` thường có selectivity thấp (khớp nhiều) → seq scan. `IS NULL` dùng được index nếu DB index cả NULL (Postgres có) và NULL hiếm.

### 9. ORDER BY + LIMIT chọn index khác

Đôi khi optimizer bỏ index trên WHERE để dùng index trên `ORDER BY` (tránh sort), hoặc ngược lại — tùy `LIMIT` và cost. Đây là quyết định hợp lý, không phải lỗi.

### 10. Bảng quá nhỏ

Với bảng vài trăm dòng (nằm gọn trong 1-2 page), **seq scan luôn rẻ hơn** index scan. Optimizer bỏ index là đúng — đừng lo lắng.

> [!NOTE]
> Khi test trên bảng nhỏ ở local rồi thấy "index không được dùng", đừng vội kết luận. Trên bảng nhỏ, seq scan là **tối ưu**. Hành vi thật chỉ lộ ra ở khối lượng giống production (liên hệ bài "nhanh ở staging, chậm ở production").

---

## 10. Quy trình chẩn đoán bằng EXPLAIN

```d2 title="Điều tra vì sao planner chọn Seq Scan"
direction: down
explain: "EXPLAIN (ANALYZE, BUFFERS) với query an\ntoàn"
rows: "Estimated rows lệch actual?"
stats: "Kiểm tra statistics; ANALYZE khi phù hợp"
predicate: "Soi Filter / Index Cond: function, cast\nhoặc type mismatch"
selectivity: "Đo tỷ lệ match và lượng pages / rows cần\nđọc"
pattern: "Kiểm tra leading wildcard, OR, composite\nprefix; bảng nhỏ có thể scan rẻ hơn"
remeasure: "Đổi một thứ rồi đo lại"
explain -> rows
rows -> stats: "Lệch lớn"
rows -> predicate: "Tiếp tục"
predicate -> selectivity
selectivity -> pattern
stats -> remeasure
pattern -> remeasure
```

Không có ngưỡng 10% cố định quyết định Seq Scan cho mọi workload. Nếu đếm tỷ lệ match bằng query riêng, tính cả chi phí của phép đo đó.

Công cụ ép buộc (chỉ để **chẩn đoán**, không để vá production):

```sql
SET enable_seqscan = off;   -- ép thử index scan để SO SÁNH cost
EXPLAIN (ANALYZE) SELECT ...;
SET enable_seqscan = on;    -- nhớ bật lại!
```

> [!WARNING]
> `enable_seqscan = off` chỉ để **kiểm chứng** xem index scan có thật sự nhanh hơn không. **Đừng** để nó trong production — nó là cờ toàn cục/phiên, không phải cách sửa đúng. Nếu index scan thật sự nhanh hơn mà optimizer không chọn → vấn đề nằm ở **statistics** hoặc **cost params** (`random_page_cost`), hãy sửa gốc.

---

## 11. Câu hỏi đào sâu

> **"Postgres có query hints như Oracle không?"**
> Không có hint chính thức (kiểu `/*+ INDEX(...) */`). Triết lý của Postgres: sửa **nguyên nhân** (statistics, cost params, viết lại query) thay vì ép plan. Có extension `pg_hint_plan` nhưng hiếm dùng.

> **"`random_page_cost` ảnh hưởng thế nào?"**
> Mặc định 4.0 (giả định HDD). Trên SSD, random read rẻ hơn nhiều → giảm xuống ~1.1 khiến optimizer "dám" dùng index hơn. Đây là một chỉnh sửa phổ biến trên hệ thống SSD.

> **"Bitmap Index Scan là gì, sao đôi khi thấy nó thay vì Index Scan?"**
> Khi cần lấy **vừa phải** số dòng: Postgres gom các ctid qua index thành một bitmap, **sắp theo thứ tự page**, rồi đọc heap **gần như tuần tự** → tránh random I/O lộn xộn. Đây là điểm cân bằng giữa Index Scan (ít dòng) và Seq Scan (nhiều dòng).

> **"Index có nhưng `SELECT *` — có ảnh hưởng không?"**
> Có. `SELECT *` cần mọi cột → không thể index-only scan → phải fetch heap → tăng chi phí index scan → optimizer dễ nghiêng về seq scan hơn (liên hệ bài "SELECT * vs cột cần").

---

## 12. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 12.1. Cheat sheet

**Có thể không đáng dùng index:**

- Tỷ lệ match lớn, rows rộng hoặc nhiều heap fetch.
- Bảng nhỏ khiến scan có cost thấp.
- Statistics cũ có thể gây ước lượng sai.

**Predicate có thể thiếu ordered access phù hợp:**

- Cast/type mismatch hoặc function bọc cột.
- Leading wildcard cần xét trigram/search access thay cho prefix B-Tree.
- OR nhiều cột có thể cần kết hợp indexes hoặc viết lại đúng ngữ nghĩa.
- Composite key thiếu prefix phù hợp; xem thêm scan/skip scan theo engine.

Dùng `EXPLAIN ANALYZE`, so estimated/actual rows, `Filter`/`Index Cond`, I/O và đo selectivity. Không coi tỷ lệ 10% hoặc “bảng nhỏ luôn thắng” là luật cố định.

### 12.2. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Seq Scan không phải lúc nào cũng là lỗi.**
> Với điều kiện khớp nhiều dòng hoặc bảng nhỏ, seq scan là **tối ưu**. Đừng "sửa" cái không hỏng.
>
> **2. Giữ cột "trần" trong điều kiện (sargable).**
> Đừng bọc cột trong function/cast/biểu thức. Đưa mọi biến đổi sang phía hằng số, hoặc tạo expression index.
>
> **3. Khi plan có vẻ sai, kiểm tra statistics ĐẦU TIÊN.**
> So `rows` ước lượng vs thực tế trong `EXPLAIN ANALYZE`. Lệch lớn → `ANALYZE`. Đây là nguyên nhân #1 của plan "ngu" sau bulk load.

### 12.3. Quote cuối

> Optimizer không phục vụ index của bạn — nó phục vụ **chi phí thấp nhất**. "Có index mà vẫn seq scan" gần như luôn có nghĩa: hoặc index không đáng dùng (và optimizer đúng), hoặc bạn đã vô tình **giấu** index khỏi nó bằng một cái cast, một function, hay một dấu `%` đặt sai chỗ. Hiểu cách optimizer tính tiền, bạn sẽ thôi đổ lỗi cho nó và bắt đầu nói chuyện cùng ngôn ngữ với nó.
