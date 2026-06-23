---
title: "IN vs EXISTS vs JOIN — khi nào khác nhau? — Deep Dive"
description: "Câu hỏi phỏng vấn: IN (subquery), EXISTS, và JOIN có cho cùng kết quả không, và cái nào nhanh hơn? Mổ xẻ semi-join, cách optimizer biến đổi, cái bẫy NOT IN với NULL, anti-join (NOT EXISTS), nhân bản dòng khi JOIN, và khi nào thật sự khác nhau."
---

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [Semi-Join: chìa khóa hiểu IN và EXISTS](#3-semi-join-chìa-khóa-hiểu-in-và-exists)
- [IN (subquery) — optimizer thường biến thành semi-join](#4-in-subquery--optimizer-thường-biến-thành-semi-join)
- [EXISTS — semi-join tường minh, dừng ở dòng đầu](#5-exists--semi-join-tường-minh-dừng-ở-dòng-đầu)
- [JOIN — khác biệt chí mạng: NHÂN BẢN dòng](#6-join--khác-biệt-chí-mạng-nhân-bản-dòng)
- [Cái bẫy lớn nhất: NOT IN + NULL](#7-cái-bẫy-lớn-nhất-not-in--null)
- [NOT EXISTS vs NOT IN vs LEFT JOIN ... IS NULL (anti-join)](#8-not-exists-vs-not-in-vs-left-join--is-null-anti-join)
- [Bảng quyết định & hiệu năng](#9-bảng-quyết-định--hiệu-năng)
- [Câu hỏi đào sâu](#10-câu-hỏi-đào-sâu)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#11-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"`WHERE id IN (SELECT ...)`, `WHERE EXISTS (SELECT ...)`, và `JOIN` — ba cách này có cho cùng kết quả không? Cái nào nhanh nhất? Khi nào chúng thật sự khác nhau?"*

> [!IMPORTANT]
> Hai ý cần tách bạch: **(1) Kết quả** — `IN` và `EXISTS` (dạng semi-join) thường tương đương nhau; còn `JOIN` có thể cho kết quả **khác** vì nó **nhân bản dòng**. **(2) Hiệu năng** — với optimizer hiện đại, `IN` và `EXISTS` thường được biến đổi thành **cùng một semi-join plan** → tốc độ ngang nhau. Khác biệt thật sự nằm ở các trường hợp biên: **NULL**, **nhân bản dòng**, và **anti-join**.

---

## 2. Câu trả lời 30 giây

> - **`IN (subquery)` và `EXISTS`**: thường cho **cùng kết quả** và optimizer thường biến cả hai thành **semi-join** (mỗi dòng bên trái chỉ cần tìm 1 match bên phải là đủ) → **tốc độ tương đương**. Đừng tin câu "EXISTS luôn nhanh hơn IN" — điều đó đã lỗi thời với optimizer hiện đại.
> - **`JOIN`**: cho kết quả **khác** nếu bảng bên phải có nhiều dòng match — nó **nhân bản** dòng bên trái. Muốn giống IN/EXISTS phải thêm `DISTINCT` (và lúc đó thường chậm hơn semi-join).
> - **Cái bẫy**: `NOT IN (subquery)` mà subquery trả về **NULL** → toàn bộ kết quả thành **rỗng/sai** một cách âm thầm. Dùng `NOT EXISTS` thay thế — nó an toàn với NULL.
>
> Quy tắc: kiểm tra tồn tại → `EXISTS`/`IN`; loại trừ → `NOT EXISTS`; cần cột từ bảng kia → `JOIN`.

---

## 3. Semi-Join: chìa khóa hiểu IN và EXISTS

**Semi-join** là phép: *"trả về các dòng bên trái mà **tồn tại ít nhất một** dòng match bên phải"* — và **không** lấy cột nào của bên phải, **không** nhân bản.

```diagram
users                 orders (user_id)
┌────┐                ┌──────────┐
│ 1  │ ──match──►     │ uid=1    │   (3 đơn)
│ 2  │ ──match──►     │ uid=2    │   (1 đơn)
│ 3  │   (no match)   │ uid=1    │
└────┘                │ uid=1    │
                      └──────────┘

SEMI-JOIN (users có ít nhất 1 đơn):
   → trả về user 1, user 2   ← MỖI user 1 LẦN, dù user 1 có 3 đơn
   → user 3 bị loại (không có đơn)
```

Mấu chốt: semi-join trả **mỗi dòng trái tối đa một lần**, và **dừng tìm ngay khi gặp match đầu tiên** bên phải. Đây chính là ngữ nghĩa của `IN` và `EXISTS`.

---

## 4. IN (subquery) — optimizer thường biến thành semi-join

```sql
SELECT * FROM users u
WHERE u.id IN (SELECT user_id FROM orders WHERE status = 'paid');
```

```text
 Hash Semi Join
   Hash Cond: (u.id = orders.user_id)
   ->  Seq Scan on users u
   ->  Hash
         ->  Seq Scan on orders
               Filter: (status = 'paid')
```

Optimizer **không** chạy subquery lặp đi lặp lại cho mỗi user. Nó nhận ra đây là semi-join và chọn **Hash Semi Join** (hoặc Merge/Nested Loop Semi Join tùy data) — duyệt một lần, mỗi user chỉ cần biết "có/không".

> [!NOTE]
> `IN (subquery)` **khác** `IN (danh sách hằng)`. `IN (1,2,3)` chỉ là chuỗi `OR`. `IN (SELECT ...)` là semi-join. Bài này nói về dạng subquery.

---

## 5. EXISTS — semi-join tường minh, dừng ở dòng đầu

```sql
SELECT * FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid');
```

`EXISTS` diễn đạt **chính xác** ngữ nghĩa semi-join: "có tồn tại dòng nào thỏa không?". Nó **dừng ngay** khi tìm thấy dòng đầu tiên (short-circuit). `SELECT 1` hay `SELECT *` bên trong **không quan trọng** — optimizer chỉ quan tâm "có hay không", không đọc cột.

```text
 Hash Semi Join          ← cùng plan với IN ở trên!
   Hash Cond: (u.id = o.user_id)
   ...
```

> [!IMPORTANT]
> Với Postgres/optimizer hiện đại, `IN (subquery)` và `EXISTS` thường cho **cùng một plan semi-join** → **hiệu năng như nhau**. Câu thần chú cũ "EXISTS nhanh hơn IN" xuất phát từ các DB/engine đời cũ không biết biến đổi IN thành semi-join (chạy subquery lặp lại). Đừng áp dụng máy móc — hãy `EXPLAIN` để kiểm chứng.

---

## 6. JOIN — khác biệt chí mạng: NHÂN BẢN dòng

Đây là chỗ `JOIN` **thật sự khác** IN/EXISTS về **kết quả**.

```sql
-- JOIN thường (inner join)
SELECT u.*
FROM users u
JOIN orders o ON o.user_id = u.id AND o.status = 'paid';
```

```diagram
user 1 có 3 đơn 'paid':
   JOIN → user 1 xuất hiện 3 LẦN trong kết quả (mỗi đơn 1 dòng)
   IN/EXISTS → user 1 xuất hiện 1 LẦN

→ Kết quả KHÁC NHAU về số dòng!
```

Muốn `JOIN` cho kết quả giống IN/EXISTS, phải khử trùng lặp:

```sql
SELECT DISTINCT u.*
FROM users u
JOIN orders o ON o.user_id = u.id AND o.status = 'paid';
```

Nhưng `DISTINCT` trên toàn bộ cột của `u` thường **đắt** (phải sort/hash khử trùng) — chậm hơn semi-join vốn không bao giờ tạo ra trùng lặp ngay từ đầu.

> [!WARNING]
> Lỗi kinh điển: dùng `JOIN` để "lọc users có đơn paid", quên rằng nó nhân bản → `COUNT(*)` bị thổi phồng, hoặc `SUM` bị tính trùng. Nếu bạn **chỉ cần lọc** (không lấy cột từ orders) → dùng `EXISTS`/`IN`, **không** dùng JOIN. Chỉ dùng JOIN khi bạn **thật sự cần cột** từ bảng kia.

| Mục đích | Nên dùng |
|----------|----------|
| Lọc dòng trái theo "có tồn tại match" | `EXISTS` / `IN` (semi-join, không nhân bản) |
| Cần lấy cột từ bảng phải | `JOIN` (chấp nhận nhân bản, hoặc xử lý phù hợp) |
| Lọc + cần đúng 1 dòng/match | `JOIN` + `DISTINCT` hoặc `LATERAL ... LIMIT 1` |

---

## 7. Cái bẫy lớn nhất: NOT IN + NULL

Đây là câu "bẫy" yêu thích của người phỏng vấn — và là bug thật trong production.

```sql
-- Muốn: users CHƯA có đơn nào
SELECT * FROM users u
WHERE u.id NOT IN (SELECT user_id FROM orders);
```

Nếu cột `orders.user_id` có **bất kỳ giá trị NULL nào**, query trên trả về **0 dòng** (hoặc thiếu dòng) — **âm thầm sai**.

```diagram
NOT IN (1, 2, NULL)  được hiểu là:
   id != 1  AND  id != 2  AND  id != NULL
                                 └─────────┘
                          id != NULL  →  UNKNOWN (không phải TRUE)

→ Với MỌI id, biểu thức không bao giờ TRUE chắc chắn → loại hết → KẾT QUẢ RỖNG
```

Logic ba trạng thái (3-valued logic) của SQL: so sánh với NULL cho `UNKNOWN`, và `... AND UNKNOWN` không bao giờ thành `TRUE`. Vì vậy chỉ **một** NULL trong tập con là đủ phá hỏng toàn bộ `NOT IN`.

> [!IMPORTANT]
> **`NOT IN (subquery)` là nguy hiểm** nếu cột con có thể NULL. Nó không báo lỗi — chỉ **lặng lẽ trả sai**. Đây là một trong những bug khó phát hiện nhất. **Quy tắc an toàn: luôn ưu tiên `NOT EXISTS` thay cho `NOT IN`** khi loại trừ theo subquery.

---

## 8. NOT EXISTS vs NOT IN vs LEFT JOIN ... IS NULL (anti-join)

Ba cách diễn đạt "anti-join" (lấy dòng trái **không** có match):

```sql
-- ✅ An toàn với NULL, optimizer biến thành Anti-Join
SELECT * FROM users u
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);

-- ⚠️ Bẫy NULL (mục 7) — tránh trừ khi chắc chắn cột con NOT NULL
SELECT * FROM users u
WHERE u.id NOT IN (SELECT user_id FROM orders);

-- ✅ An toàn, cũng thành Anti-Join (nhưng dài dòng hơn)
SELECT u.* FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.user_id IS NULL;
```

```text
-- NOT EXISTS → plan:
 Hash Anti Join
   Hash Cond: (u.id = o.user_id)
```

**Anti-join** là phép đối của semi-join: "trả dòng trái mà **không tồn tại** match bên phải". `NOT EXISTS` và `LEFT JOIN ... IS NULL` đều được optimizer biến thành Anti Join → an toàn NULL + hiệu quả.

| Cách | An toàn NULL | Plan | Ghi chú |
|------|:-:|------|---------|
| `NOT EXISTS` | ✅ | Anti Join | **Khuyến nghị** — an toàn + rõ ràng |
| `NOT IN` | ❌ | Anti Join chỉ khi cột con NOT NULL | Bẫy NULL, tránh |
| `LEFT JOIN ... IS NULL` | ✅ | Anti Join | OK, nhưng verbose; cẩn thận cột IS NULL phải là cột join NOT NULL |

> [!TIP]
> Khi dùng `LEFT JOIN ... WHERE x IS NULL`, chọn `x` là cột **không thể NULL tự nhiên** ở bảng phải (thường là khóa join hoặc PK của bảng phải) — nếu chọn cột mà bản thân nó có thể NULL ngay cả khi match, bạn sẽ lọc sai.

---

## 9. Bảng quyết định & hiệu năng

```diagram
╭──────────────────────────────────────────────────────────────╮
│  Mục đích                          → Dùng                     │
│  ─────────────────────────────────────────────────────────    │
│  "Có tồn tại match?" (lọc)         → EXISTS hoặc IN (≈ nhau)   │
│  "Không có match?" (loại trừ)      → NOT EXISTS (KHÔNG NOT IN) │
│  "Cần cột từ bảng kia"             → JOIN                      │
│  "Lọc nhưng JOIN nhân bản"         → EXISTS (tránh DISTINCT)   │
│  "Mỗi match lấy 1 dòng + cột kia"  → LATERAL / DISTINCT ON     │
╰──────────────────────────────────────────────────────────────╯
```

Về hiệu năng (Postgres hiện đại):

| So sánh | Kết luận |
|---------|----------|
| `IN (subquery)` vs `EXISTS` | Thường **cùng plan semi-join** → tương đương. `EXPLAIN` để chắc |
| `EXISTS` vs `JOIN+DISTINCT` (chỉ lọc) | `EXISTS` thường **nhanh hơn** (không tạo trùng rồi khử) |
| `NOT EXISTS` vs `NOT IN` | `NOT EXISTS` **an toàn + thường nhanh hơn**; `NOT IN` có bẫy NULL |
| `JOIN` (cần cột phải) | Không thay được bằng IN/EXISTS — khác mục đích |

> [!NOTE]
> Hiệu năng thực tế vẫn phụ thuộc **index** và **data**. Semi-join/anti-join có thể chạy bằng Nested Loop (tốt khi bảng trái nhỏ + index bên phải), Hash (bảng lớn), hoặc Merge. `EXPLAIN ANALYZE` là trọng tài cuối cùng — đừng chọn theo niềm tin.

---

## 10. Câu hỏi đào sâu

> **"Có khi nào IN thật sự chậm hơn EXISTS không?"**
> Có, ở các DB/optimizer cũ không biến IN thành semi-join (chạy subquery lặp), hoặc khi subquery trả tập **rất lớn** mà bị materialize. Trên Postgres hiện đại thì hiếm. Với **correlated** subquery, EXISTS thường tự nhiên hơn.

> **"`IN` với danh sách hằng cực dài (10,000 phần tử) thì sao?"**
> Có thể chậm/parse lâu. Cân nhắc đưa các giá trị vào `VALUES`/temp table rồi `JOIN`/`EXISTS`, hoặc `= ANY(ARRAY[...])`.

> **"`= ANY(array)` vs `IN`?"**
> `IN (a,b,c)` tương đương `= ANY(ARRAY[a,b,c])` trong Postgres. `ANY` tiện khi truyền một mảng tham số từ ứng dụng (tránh dựng chuỗi IN động).

> **"LATERAL join liên quan gì?"**
> Khi cần "với mỗi dòng trái, lấy **vài** dòng liên quan bên phải" (top-N per group), `LATERAL` + `LIMIT` mạnh hơn IN/EXISTS/JOIN thường. Ví dụ: lấy 3 đơn mới nhất của mỗi user.

---

## 11. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 11.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  IN (subquery) ≈ EXISTS  → semi-join, KHÔNG nhân bản, ≈ tốc độ │
│  JOIN                    → NHÂN BẢN dòng nếu nhiều match        │
│                            (cần DISTINCT để giống IN/EXISTS)    │
│  ─────────────────────────────────────────────────────────     │
│  Loại trừ (anti-join):                                         │
│    NOT EXISTS   → ✅ an toàn NULL, khuyến nghị                  │
│    NOT IN       → ❌ BẪY NULL: 1 NULL → kết quả rỗng/sai        │
│    LEFT JOIN .. IS NULL → ✅ an toàn, verbose                   │
│  ─────────────────────────────────────────────────────────     │
│  Chỉ lọc → EXISTS/IN ; cần cột bảng kia → JOIN                 │
│  EXPLAIN để xác nhận plan, đừng tin "EXISTS luôn nhanh hơn IN"  │
╰───────────────────────────────────────────────────────────────╯
```

### 11.2. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Chỉ lọc thì dùng EXISTS/IN, đừng JOIN.**
> JOIN nhân bản dòng → sai `COUNT`/`SUM` và phải `DISTINCT` tốn kém. Dùng JOIN **chỉ khi** cần cột từ bảng kia.
>
> **2. Loại trừ thì dùng NOT EXISTS, đừng NOT IN.**
> `NOT IN` với cột con có NULL trả kết quả **rỗng/sai âm thầm**. `NOT EXISTS` an toàn với NULL và thường nhanh hơn.
>
> **3. Đừng tin câu "EXISTS luôn nhanh hơn IN".**
> Optimizer hiện đại biến cả hai thành semi-join như nhau. `EXPLAIN` mới là sự thật. Chọn theo **ngữ nghĩa rõ ràng**, để tối ưu cho optimizer lo.

### 11.3. Quote cuối

> `IN`, `EXISTS`, `JOIN` không phải ba cách viết của cùng một thứ — chúng diễn đạt ba **ý định** khác nhau: *"có tồn tại không"*, *"có tồn tại không (tường minh)"*, và *"ghép dữ liệu lại"*. Khi bạn chọn đúng theo ý định, kết quả đúng và optimizer thường tự lo phần tốc độ. Khi bạn chọn theo lời đồn ("cái này nhanh hơn"), bạn dễ rơi vào bẫy NULL hoặc nhân bản dòng — những lỗi không báo, chỉ âm thầm cho ra số sai.
