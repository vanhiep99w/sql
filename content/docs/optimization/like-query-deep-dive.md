---
title: "LIKE, Pattern Search & B-Tree"
description: "Mổ xẻ chi tiết tại sao LIKE '%keyword%' bỏ qua index — character set, collation, B-Tree internals, access vs filter predicate, bind parameter trap, trigram GIN, full-text search, suffix index. Kèm benchmark và EXPLAIN ANALYZE."
---

## Mục lục

- [Bối cảnh: Câu chuyện 15 giây trên bảng 10 triệu rows](#1-bối-cảnh-câu-chuyện-15-giây-trên-bảng-10-triệu-rows)
- [Database nhìn String như thế nào — Charset & Collation](#2-database-nhìn-string-như-thế-nào--charset--collation)
- [B-Tree Refresher — 3 điểm cốt lõi (kèm số cụ thể)](#3-b-tree-refresher--3-điểm-cốt-lõi-kèm-số-cụ-thể)
- [LIKE biến thành Range Scan như thế nào](#4-like-biến-thành-range-scan-như-thế-nào)
- [Access Predicate vs Filter Predicate — Mổ xẻ với EXPLAIN](#5-access-predicate-vs-filter-predicate--mổ-xẻ-với-explain)
- [Catalog các biến tấu LIKE và performance tương ứng](#6-catalog-các-biến-tấu-like-và-performance-tương-ứng)
- [Bind Parameter Trap — Cached Plan & cách debug](#7-bind-parameter-trap--cached-plan--cách-debug)
- [So sánh xử lý LIKE giữa Postgres / MySQL / Oracle / SQL Server](#8-so-sánh-xử-lý-like-giữa-postgres--mysql--oracle--sql-server)
- [Giải pháp 1: Trigram Index (GIN) — Deep dive](#9-giải-pháp-1-trigram-index-gin--deep-dive)
- [Giải pháp 2: Full-Text Search — Deep dive](#10-giải-pháp-2-full-text-search--deep-dive)
- [Giải pháp 3: Suffix Search bằng Reversed Column](#11-giải-pháp-3-suffix-search-bằng-reversed-column)
- [Giải pháp 4: Expression Index, Functional Index & Case-Insensitive](#12-giải-pháp-4-expression-index-functional-index--case-insensitive)
- [Giải pháp 5: External Search Engine (Elasticsearch / Meilisearch / Typesense)](#13-giải-pháp-5-external-search-engine-elasticsearch--meilisearch--typesense)
- [Real-world scenarios — Auto-complete, Search bar, Log search, Email lookup](#14-real-world-scenarios--auto-complete-search-bar-log-search-email-lookup)
- [Anti-patterns cần tránh](#15-anti-patterns-cần-tránh)
- [Monitoring & Maintenance](#16-monitoring--maintenance)
- [Migration playbook — Từ LIKE chậm sang giải pháp đúng](#17-migration-playbook--từ-like-chậm-sang-giải-pháp-đúng)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#18-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Bối cảnh: Câu chuyện 15 giây trên bảng 10 triệu rows

Bạn đang xây nền tảng học lập trình. Bảng `courses` có **10 triệu bản ghi**:

```sql
CREATE TABLE courses (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    instructor  TEXT,
    price       NUMERIC(10, 2),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- 10,000,000 rows, ~3.5 GB data + ~1.2 GB index
```

User gõ vào thanh tìm kiếm, bạn viết câu query đơn giản nhất có thể:

```sql
SELECT * FROM courses WHERE title LIKE '%database%';
```

Nhấn Enter, đợi… **1 giây, 3 giây, 15 giây**. Bạn thêm index, tưởng sẽ cứu được:

```sql
CREATE INDEX idx_courses_title ON courses (title);
```

Chạy lại — vẫn **15 giây**. Index như **không tồn tại**. Bạn `EXPLAIN ANALYZE`:

```text
                                  QUERY PLAN
─────────────────────────────────────────────────────────────────────────────
 Seq Scan on courses  (cost=0.00..285431.00 rows=1000 width=124)
                     (actual time=0.029..15234.567 rows=842 loops=1)
   Filter: (title ~~ '%database%'::text)
   Rows Removed by Filter: 9999158
 Planning Time: 0.124 ms
 Execution Time: 15234.901 ms
```

Optimizer **biết** có index `idx_courses_title`, nhưng vẫn chọn **Seq Scan**. Tại sao?

> [!IMPORTANT]
> Vấn đề **không** nằm ở server yếu hay thiếu RAM. Vấn đề nằm ở **một ký tự duy nhất — dấu `%`** và **vị trí** bạn đặt nó.

Trong doc này, ta sẽ mổ xẻ từng lớp:

1. Cách database **so sánh string** (charset + collation).
2. Cách **B-Tree nhảy** tới đúng vị trí.
3. Cơ chế **optimizer** cắt nhỏ câu LIKE thành access predicate + filter predicate.
4. Tại sao **bind parameter** lại khiến query chạy chậm sau vài lần.
5. **5 giải pháp** từ trivial đến distributed — và khi nào dùng cái nào.

Mục tiêu: sau khi đọc xong, bạn hiểu vì sao **xê dịch dấu `%` vài ký tự** có thể thay đổi hiệu năng **hàng trăm lần**.

---

## 2. Database nhìn String như thế nào — Charset & Collation

### 2.1. String = dãy byte

Khi bạn lưu chuỗi `"SQL"`, database **không** thấy 3 ký tự như mắt người. Nó thấy một **dãy byte** được mã hóa theo **character set** — phổ biến nhất là `UTF-8`.

```
"SQL"     (UTF-8)  →   0x53 0x51 0x4C                       (3 byte)
"phở"     (UTF-8)  →   0x70 0x68 0xE1 0xBB 0x9F             (5 byte)
"漢字"    (UTF-8)  →   0xE6 0xBC 0xA2 0xE5 0xAD 0x97        (6 byte)
"🚀"      (UTF-8)  →   0xF0 0x9F 0x9A 0x80                  (4 byte)
```

Vài hệ quả ít người để ý:

| Hiện tượng | Giải thích |
|------------|-----------|
| `LENGTH('phở')` trả 5 trong MySQL `utf8mb4` | Đếm theo **byte**, không phải ký tự |
| `CHAR_LENGTH('phở')` trả 3 | Đếm theo **ký tự** (codepoint) |
| MySQL `utf8` (cũ) chỉ chứa được 3-byte UTF-8 → không lưu được emoji | Phải dùng `utf8mb4` để có đủ 4-byte |
| Postgres `bytea` ≠ `text` | `bytea` so sánh byte thuần, `text` so theo collation |

### 2.2. Mã hóa thôi chưa đủ — Collation xuất hiện

Khi bạn viết `ORDER BY name`, database cần biết:

- Chữ `A` đứng trước hay sau chữ `B`?
- Chữ `é` có **bằng** chữ `e` không?
- `'apple'` và `'Apple'` có giống nhau không?
- Chữ `ß` (tiếng Đức) bằng `ss` hay `SS`?
- Chữ `i` không chấm (tiếng Thổ) có bằng `I` không?

**Collation** là bộ quy tắc trả lời các câu hỏi này.

| Collation | `'apple'` vs `'Apple'` | `'é'` vs `'e'` | `'ä'` vs `'a'` | Ghi chú |
|-----------|------------------------|----------------|----------------|---------|
| `C` / `POSIX` (Postgres) | Khác | Khác | Khác | So byte-by-byte, nhanh nhất |
| `en_US.UTF-8` | Khác (case-sensitive) | Khác | Khác | Locale linguistic |
| `utf8_bin` (MySQL) | Khác | Khác | Khác | So byte |
| `utf8_general_ci` | Bằng | Bằng | Bằng | Case-insensitive, accent-insensitive |
| `utf8mb4_unicode_ci` | Bằng | Bằng | Bằng | Tuân Unicode Collation Algorithm |
| `utf8mb4_0900_ai_ci` (MySQL 8) | Bằng | Bằng | Bằng | Unicode 9.0, accent-insensitive |
| `und-x-icu` (Postgres ICU) | Khác | Bằng | Bằng | ICU library |

### 2.3. Tại sao collation lại quan trọng cho LIKE?

> [!IMPORTANT]
> **B-Tree index sắp xếp dữ liệu dựa trên collation.** Cùng một cột, hai collation khác nhau → **thứ tự trên cây hoàn toàn khác**. Đây là lý do tại sao một số pattern `LIKE` dùng được index, một số thì không.

Ví dụ kinh điển trên Postgres — bảng cùng dữ liệu, hai cách build index:

```sql
-- Cách 1: index với default collation (locale-aware)
CREATE INDEX idx_a ON courses (title);

-- Cách 2: index với text_pattern_ops (so byte-by-byte)
CREATE INDEX idx_b ON courses (title text_pattern_ops);
```

Query:

```sql
SELECT * FROM courses WHERE title LIKE 'SQL%';
```

Kết quả:

| Index | Dùng được cho `LIKE 'SQL%'`? | Dùng được cho `ORDER BY title`? |
|-------|------------------------------|--------------------------------|
| `idx_a` (default collation, không phải `C`) | **❌ Không** (trừ khi locale là `C`) | ✅ Có |
| `idx_b` (`text_pattern_ops`) | ✅ Có | ❌ Không (sai thứ tự) |

> [!TIP]
> Nếu cluster Postgres của bạn dùng locale `en_US.UTF-8` (mặc định), muốn `LIKE 'prefix%'` dùng được B-Tree index, **bắt buộc** phải tạo index với `text_pattern_ops` (cho `LIKE`) hoặc `varchar_pattern_ops` (cho `VARCHAR`).

```sql
-- Đúng cách cho prefix search trên Postgres
CREATE INDEX idx_courses_title_pattern
  ON courses (title text_pattern_ops);

-- Nếu cần ORDER BY và LIKE prefix cùng lúc → tạo 2 index
CREATE INDEX idx_courses_title_sort ON courses (title);
CREATE INDEX idx_courses_title_lke  ON courses (title text_pattern_ops);
```

MySQL không có vấn đề này — InnoDB B-Tree mặc định dùng được cho cả `ORDER BY` và `LIKE 'prefix%'`.

---

## 3. B-Tree Refresher — 3 điểm cốt lõi (kèm số cụ thể)

Trước khi đi vào phần chính, có **3 ý** ta cần nhớ về B-Tree (chính xác là B+Tree mà hầu hết DB dùng).

### 3.1. Cây rất thấp — sức mạnh của logarit

Mỗi node B-Tree nhồi được **hàng trăm key** vào một page (8KB Postgres, 16KB MySQL). Dù bảng có hàng triệu hay hàng tỷ dòng, chỉ cần **3–4 lần nhảy** là tới leaf.

```
                            [Root  page]               ← page 1
                          /      |      \
                  [Inter1]   [Inter2]   [Inter3]       ← Internal pages
                  /  |  \    /  |  \    /  |  \
              [L1][L2][L3]...                          ← Leaf pages
                ⇄   ⇄   ⇄  (linked list ngang)
```

Với fanout trung bình **~200 keys/page**:

| Số rows | Số leaf pages | Cao của cây | Page reads để tìm 1 row |
|---------|---------------|-------------|-------------------------|
| 1,000 | ~5 | 1 | 1-2 |
| 100,000 | ~500 | 2 | 2-3 |
| 10,000,000 | ~50,000 | 3 | 3-4 |
| 1,000,000,000 | ~5,000,000 | 4 | 4-5 |

> [!NOTE]
> Với 1 tỷ rows, vẫn chỉ tốn **4-5 page reads** = vài chục microseconds. Đó là sức mạnh của logarit.

### 3.2. Leaf node được nối bằng linked list (B+Tree)

Một khi tìm được leaf đầu tiên, database có thể **đi thẳng sang phải** mà không cần quay lại root. Đây là cơ chế làm **range scan** cực nhanh — chìa khóa để hiểu prefix search.

```
[L1] ⇄ [L2] ⇄ [L3] ⇄ [L4] ⇄ [L5] ⇄ [L6] ⇄ ...
        ↑                          ↑
      start                       stop
```

Cơ chế này dùng cho:

- `WHERE x BETWEEN 100 AND 200`
- `WHERE x >= '2024-01-01'`
- `WHERE name LIKE 'A%'`
- `ORDER BY x LIMIT 10`

### 3.3. B-Tree chỉ tìm hiệu quả khi biết bắt đầu từ đâu

Đây là **điểm mấu chốt** của toàn bộ doc — đọc lại 3 lần nếu cần.

> [!IMPORTANT]
> B-Tree cần một **giá trị cụ thể ở đầu chuỗi** để biết rẽ trái hay rẽ phải tại mỗi node. **Không có điểm bắt đầu → không có B-Tree.**

Hãy giữ ý này trong đầu khi đọc các phần tiếp theo. Tất cả "ma thuật" của LIKE đều xoay quanh việc **có hay không có prefix**.

---

## 4. LIKE biến thành Range Scan như thế nào

### 4.1. Trường hợp đẹp: `LIKE 'SQL%'`

Khi bạn viết:

```sql
SELECT * FROM courses WHERE title LIKE 'SQL%';
```

Database **không** quét tìm chuỗi chứa `'SQL'`. Nó làm việc tinh vi hơn — **biến câu LIKE thành range scan**:

```
Optimizer đọc prefix 'SQL' → tính:

   start_key = 'SQL'
   end_key   = 'SQM'    ← (ký tự cuối '\x4C' + 1 = '\x4D')

→ Tương đương:  title >= 'SQL'  AND  title < 'SQM'
```

Quy trình thực thi (`Index Range Scan`):

```diagram
╭───────────────────────────────────────────────────────╮
│ 1. Nhảy xuống leaf chứa 'SQL'    (3 page reads)       │
│ 2. Đi thẳng sang phải qua linked list                 │
│ 3. Mỗi entry: lấy CTID/RowID → fetch row data         │
│ 4. Dừng khi gặp key >= 'SQM'                          │
╰───────────────────────────────────────────────────────╯
```

EXPLAIN tương ứng (Postgres, sau khi có `text_pattern_ops` index):

```text
 Bitmap Heap Scan on courses  (actual rows=12 loops=1)
   Filter: (title ~~ 'SQL%')
   ->  Bitmap Index Scan on idx_courses_title_pattern
         Index Cond: ((title ~>=~ 'SQL') AND (title ~<~ 'SQM'))
 Execution Time: 0.412 ms
```

**Từ 15 giây → 0.4 milliseconds** — nhanh hơn ~37,000 lần. Mà chỉ vì optimizer **biết** start key.

### 4.2. Trường hợp xấu: `LIKE '%database%'`

```sql
SELECT * FROM courses WHERE title LIKE '%database%';
```

Dấu `%` đứng đầu nghĩa là **bất kỳ chuỗi nào cũng có thể đứng trước**. Optimizer **không tính được `start_key`** — không có điểm bắt đầu trên cây.

Kết quả: **bỏ index, chuyển sang Sequential Scan**, đọc toàn bảng từ đầu đến cuối, áp filter trên từng row.

```text
 Seq Scan on courses  (actual time=0.029..15234.567 rows=842 loops=1)
   Filter: (title ~~ '%database%')
   Rows Removed by Filter: 9999158
 Execution Time: 15234.901 ms
```

### 4.3. Bảng so sánh nhanh

```diagram
╭──────────────────────────────────────────────────────────╮
│  LIKE 'SQL%'        →  Index Range Scan       O(log n)   │
│  LIKE '%SQL'        →  Sequential Scan        O(n)       │
│  LIKE '%SQL%'       →  Sequential Scan        O(n)       │
│  LIKE 'SQL%able'    →  Index Range Scan       O(k)*      │
│  LIKE 'S_L%'        →  Index Range Scan + filter         │
│  LIKE '_QL%'        →  Sequential Scan        O(n)       │
│  LIKE '%'           →  ⚠️ Match all → Seq Scan           │
│  LIKE 'SQL'         →  Index Unique Scan (= equality)    │
╰──────────────────────────────────────────────────────────╯
  * k = số rows match prefix 'SQL'
```

Hai dòng đáng chú ý:

- **`LIKE '_QL%'`**: dấu `_` ở đầu (single-character wildcard) cũng **giết** prefix. Không có điểm bắt đầu cố định.
- **`LIKE 'S_L%'`**: prefix cố định = `'S'`, sau đó `_L%` là filter. Index dùng được nhưng chỉ giới hạn ở phạm vi `'S'`.

---

## 5. Access Predicate vs Filter Predicate — Mổ xẻ với EXPLAIN

Trường hợp `LIKE 'SQL%able'` thú vị — index **có** được dùng, nhưng hiệu quả thì… **còn tùy**. Để hiểu, cần phân biệt **2 loại predicate**:

| Loại | Định nghĩa | Tác dụng |
|------|-----------|----------|
| **Access Predicate** | Phần **trước dấu `%` đầu tiên** | Tính `start_key`/`end_key` — quyết định **quét bao nhiêu rows trên index** |
| **Filter Predicate** | Phần còn lại | Chỉ **lọc sau khi đã quét** — **không** giảm phạm vi quét |

**Chênh lệch chi phí giữa hai loại này có thể lên tới hàng trăm lần.**

### 5.1. Ví dụ minh họa với số

Cột `code` có các entry trong B-Tree (sort theo collation `C`):

```
SID-AAA, SID-AAB, SID-AAC, SID-AAD, SID-ABA, SID-ABB, SID-ABC,
SID-XAA, SID-XAB, SID-XAC, SID-XAD, SID-XBA, SID-XBB, SID-XBC,
SID-YAA, SID-YAB, SID-YBA, SID-YBB
```

| Query | Access Predicate | Range trên index | Entries quét | Khớp |
|-------|------------------|------------------|--------------|------|
| `LIKE 'S%XAC'` | `S` | `S → T` | **18** | 1 |
| `LIKE 'SID%XAC'` | `SID` | `SID → SIE` | **18** | 1 |
| `LIKE 'SID-%XAC'` | `SID-` | `SID- → SID.` | **18** | 1 |
| `LIKE 'SID-X%C'` | `SID-X` | `SID-X → SID-Y` | **7** | 3 |
| `LIKE 'SID-XA%C'` | `SID-XA` | `SID-XA → SID-XB` | **4** | 2 |
| `LIKE 'SID-XAC%'` | `SID-XAC` | `SID-XAC → SID-XAD` | **1** | 1 |

> [!TIP]
> **Prefix càng dài → access predicate càng chặt → phạm vi quét càng nhỏ.** Trên bảng 10 triệu dòng, chênh lệch giữa "prefix 1 ký tự" và "prefix 10 ký tự" là **hàng trăm đến hàng nghìn lần**.

### 5.2. EXPLAIN làm rõ access vs filter (Oracle style)

Oracle là DB duy nhất hiển thị rõ 2 loại predicate trong `dbms_xplan`:

```text
| Id | Operation                   | Name           |
|  0 | SELECT STATEMENT            |                |
|  1 |  TABLE ACCESS BY INDEX ROWID| COURSES        |
|  2 |   INDEX RANGE SCAN          | IDX_TITLE      |

Predicate Information:
   2 - access("TITLE" LIKE 'SID-X%' AND "TITLE" >= 'SID-X' AND "TITLE" < 'SID-Y')
       filter("TITLE" LIKE 'SID-X%C')
```

`access(...)` = scan range. `filter(...)` = lọc sau. Đây là cách Oracle "tự thú" rằng pattern `'%C'` ở cuối chỉ là filter, không thu hẹp scan.

Postgres không hiển thị tách bạch như vậy, nhưng có thể suy ra từ `Index Cond` (access) vs `Filter` (filter):

```text
Bitmap Index Scan on idx_courses_title_pattern
   Index Cond: ((title ~>=~ 'SID-X') AND (title ~<~ 'SID-Y'))
   Filter:     (title ~~ 'SID-X%C')
```

### 5.3. Bẫy mà nhiều người mắc

```sql
WHERE title LIKE 'SQL%advanced%basic';
```

Database **chỉ dùng `SQL`** làm access predicate. Toàn bộ `%advanced%basic` chỉ là filter — **không giúp thu hẹp phạm vi quét một chút nào**.

> [!WARNING]
> Thêm chữ vào **giữa** không làm query nhanh hơn. **Chỉ prefix trước dấu `%` đầu tiên mới có tác dụng.**

Nói cách khác:

```diagram
'SQL%advanced%basic'        ──→  access = 'SQL'        (chỉ 3 ký tự)
'SQL_advanced%basic'        ──→  access = 'SQL_a...'   (nhiều ký tự hơn)
'SQLadvanced%basic'         ──→  access = 'SQLadvanced'(11 ký tự!)
```

Càng cố định prefix → càng nhanh.

---

## 6. Catalog các biến tấu LIKE và performance tương ứng

Đây là phần thực hành quan trọng nhất. Bảng 10 triệu rows. Cùng cột `title` với index `text_pattern_ops`. Đo trên Postgres 16, SSD NVMe, shared_buffers=4GB:

### 6.1. Các pattern thường gặp

| # | Pattern | Index? | Approx time | Ghi chú |
|---|---------|--------|-------------|---------|
| 1 | `title = 'SQL Mastery'` | ✅ Unique Scan | **0.2 ms** | Equality, nhanh nhất |
| 2 | `title LIKE 'SQL Mastery'` | ✅ Equivalent với `=` | **0.2 ms** | Không có wildcard → optimizer convert |
| 3 | `title LIKE 'SQL%'` | ✅ Range Scan | **0.5 ms** | Prefix |
| 4 | `title LIKE 'SQL Mas%'` | ✅ Range Scan | **0.4 ms** | Prefix dài hơn |
| 5 | `title LIKE 'S%'` | ✅ Range Scan | **120 ms** | Prefix quá ngắn, match nhiều |
| 6 | `title LIKE '%'` | ❌ Match all → Seq Scan | **2,400 ms** | Trả toàn bộ |
| 7 | `title LIKE '%SQL'` | ❌ Seq Scan | **15,200 ms** | Suffix — không có anchor |
| 8 | `title LIKE '%SQL%'` | ❌ Seq Scan | **15,800 ms** | Substring — không có anchor |
| 9 | `title LIKE 'SQL%Mastery'` | ✅ Range + filter | **0.6 ms** | Prefix `SQL`, filter `%Mastery` |
| 10 | `title LIKE 'SQL%Mas%ry'` | ✅ Range + 2 filters | **0.7 ms** | Vẫn dùng prefix `SQL` |
| 11 | `title LIKE '_QL%'` | ❌ Seq Scan | **14,900 ms** | `_` ở đầu = không có anchor |
| 12 | `title LIKE 'S_L%'` | ✅ Range + filter | **350 ms** | Prefix `S`, filter `_L` |
| 13 | `title LIKE '_'` | ❌ Seq Scan | **2,100 ms** | Single char wildcard |
| 14 | `title ILIKE 'SQL%'` | ❌ Seq Scan (case-insensitive) | **15,500 ms** | `ILIKE` không dùng B-Tree thường — xem mục 12 |
| 15 | `LOWER(title) LIKE 'sql%'` | ❌ Seq Scan | **15,400 ms** | Function trên cột → kill index, trừ khi có expression index |
| 16 | `title NOT LIKE 'SQL%'` | ❌ Seq Scan | **15,100 ms** | NOT là negation, không dùng index range |
| 17 | `title ~ '^SQL'` (regex) | ✅ Range Scan* | **0.5 ms** | Postgres có thể optimize regex anchor `^literal` |
| 18 | `title ~* 'sql'` (regex CI) | ❌ Seq Scan | **18,000 ms** | Case-insensitive regex |
| 19 | `title SIMILAR TO 'SQL%'` | ✅ Range Scan | **0.5 ms** | Postgres-specific, tương tự LIKE |
| 20 | `title LIKE '' ESCAPE '\'` | ❌ Match nothing | **0.1 ms** | Empty pattern |

> [!TIP]
> Trường hợp #17 và #19 ít người biết — Postgres **đủ thông minh** để nhận ra regex `'^SQL'` tương đương `LIKE 'SQL%'` và dùng được index `text_pattern_ops`.

### 6.2. Các "trick" lừa index không dùng được

Tất cả các pattern dưới đây **giết** index trên cột `title`:

```sql
-- Function trên cột
WHERE LOWER(title) = 'sql mastery'
WHERE UPPER(title) LIKE 'SQL%'
WHERE SUBSTRING(title, 1, 3) = 'SQL'
WHERE TRIM(title) = 'SQL Mastery'

-- Concat hoặc tính toán trên cột
WHERE title || ' ' = 'SQL Mastery '
WHERE LENGTH(title) = 11

-- CAST ngầm hoặc tường minh
WHERE title::varchar = 'SQL Mastery'
WHERE id = '123'    -- nếu id là INT mà bạn truyền string, vài DB CAST sai bên

-- Collation khác với index
WHERE title COLLATE "C" = 'SQL Mastery'    -- nếu index không tạo COLLATE C
```

**Quy tắc vàng**: index chỉ dùng được nếu bạn áp predicate **trực tiếp lên cột raw**, không qua function/expression — trừ khi có **expression index** tương ứng (xem mục 12).

---

## 7. Bind Parameter Trap — Cached Plan & cách debug

Trong thực tế, bạn **hiếm khi hard-code** giá trị. Bạn dùng **bind parameter**:

```sql
PREPARE q AS SELECT * FROM courses WHERE title LIKE $1;
EXECUTE q('SQL%');
EXECUTE q('%database%');
```

Hoặc trong app code:

```javascript
// Node.js + pg
await client.query('SELECT * FROM courses WHERE title LIKE $1', [pattern]);
```

```java
// Java + JDBC
PreparedStatement ps = conn.prepareStatement("SELECT * FROM courses WHERE title LIKE ?");
ps.setString(1, pattern);
```

Vấn đề: khi optimizer **biên dịch** câu query này, nó **không biết giá trị thực** là gì. Bạn có thể truyền `'SQL%'` lần này, `'%database%'` lần sau. Mà plan lại được **cache** để tái sử dụng (vì biên dịch lại tốn CPU).

### 7.1. Cách mỗi DB xử lý

#### Oracle — Bind Variable Peeking

Lần đầu compile, Oracle **"peek"** giá trị thực và build plan tối ưu cho giá trị đó. Plan được cache.

- **Lần 1**: `EXECUTE q('SQL%')` → peek thấy prefix đẹp → plan dùng index → nhanh.
- **Lần 2**: `EXECUTE q('%database%')` → **dùng lại plan cũ** → buộc đi qua index, nhưng vì không có prefix để nhảy → **lướt qua TỪNG entry trên cây** → chậm hơn cả Seq Scan!

Từ Oracle 11g có **Adaptive Cursor Sharing** — phát hiện skew và re-compile, nhưng không phải lúc nào cũng kích hoạt.

#### SQL Server — Parameter Sniffing

Cơ chế tương tự Oracle peeking. Tên gọi là "parameter sniffing". Gây ra **Parameter Sniffing Issues** kinh điển:

- Query chạy nhanh trong môi trường test (lần đầu compile với dữ liệu nhỏ).
- Production chạy chậm vì plan đã cache cho dữ liệu nhỏ.

Fix:

```sql
-- Option 1: recompile mỗi lần
SELECT * FROM courses WHERE title LIKE @pattern
OPTION (RECOMPILE);

-- Option 2: optimize for specific value
OPTION (OPTIMIZE FOR (@pattern = 'SQL%'));

-- Option 3: optimize for unknown
OPTION (OPTIMIZE FOR UNKNOWN);
```

#### MySQL — Đơn giản hơn

MySQL không cache plan giữa các `EXECUTE` của cùng một `PREPARE` quá mạnh — mỗi lần execute thường re-evaluate. Ít bị bẫy này hơn, nhưng cũng tốn CPU hơn.

#### PostgreSQL — Custom Plan vs Generic Plan

Cơ chế **thú vị nhất**:

```diagram
╭──────────────────────────────────────────────────────────╮
│  Lần 1-5:  Custom Plan  (tối ưu riêng cho mỗi giá trị)   │
│             │                                            │
│             ▼                                            │
│  Lần 6+:   Thử tính Generic Plan (không phụ thuộc giá trị)│
│             │                                            │
│             ├─ Generic cost ≤ Custom cost trung bình     │
│             │     → Chuyển sang Generic vĩnh viễn        │
│             │                                            │
│             └─ Với LIKE: Generic Plan giả định           │
│                trường hợp xấu nhất (%...) → bỏ index     │
│                → Sequential Scan ❌                      │
╰──────────────────────────────────────────────────────────╯
```

### 7.2. Kịch bản kinh điển — "query nhanh lúc test, chậm lúc deploy"

> [!WARNING]
> - Query chạy **nhanh** trong môi trường test (custom plan).
> - Sau **5-6 lần chạy** tự nhiên **chậm hẳn** (chuyển sang generic plan).
> - Chạy tay (`psql`, `mysql` CLI) → **nhanh**, nhưng gọi từ app (qua connection pool) → **chậm**.
> - Restart app → nhanh lại vài phút, rồi chậm lại.

### 7.3. Debug & fix trên Postgres

```sql
-- Xem chế độ plan cache hiện tại
SHOW plan_cache_mode;

-- Force custom plan để xác nhận đây là vấn đề
SET plan_cache_mode = force_custom_plan;
-- Chạy lại query → nếu nhanh hẳn → đúng là generic plan vấn đề

-- Force generic plan để debug ngược
SET plan_cache_mode = force_generic_plan;

-- Tăng threshold (default 5 → 100): trì hoãn việc chuyển sang generic
ALTER SYSTEM SET plan_cache_mode = 'auto';

-- Trong Postgres 16+:
ALTER ROLE app_user SET plan_cache_mode = 'force_custom_plan';
```

Cách clean nhất: **không dùng bind parameter cho LIKE pattern**. Build SQL với escape thủ công:

```javascript
// Anti-pattern: bind parameter ẩn pattern khỏi optimizer
client.query('SELECT * FROM courses WHERE title LIKE $1', [pattern]);

// Better: literal pattern (nhưng phải escape cẩn thận để tránh SQL injection!)
const escaped = pattern.replace(/[\\%_]/g, '\\$&');
const sql = `SELECT * FROM courses WHERE title LIKE '${escapedAndQuoted}'`;
```

> [!CAUTION]
> Không bao giờ tự nối string vào SQL nếu chưa **escape** kỹ. Dùng library escape có sẵn (e.g. `pg.escapeLiteral` trong node-postgres) thay vì replace tay.

Hoặc dùng `EXPLAIN (GENERIC_PLAN)` để xem plan generic ngay khi viết query:

```sql
EXPLAIN (GENERIC_PLAN) SELECT * FROM courses WHERE title LIKE $1;
```

---

## 8. So sánh xử lý LIKE giữa Postgres / MySQL / Oracle / SQL Server

| Aspect | Postgres | MySQL (InnoDB) | Oracle | SQL Server |
|--------|----------|----------------|--------|-----------|
| **B-Tree default dùng được `LIKE 'prefix%'`?** | ❌ (cần `text_pattern_ops` nếu locale ≠ C) | ✅ | ✅ (cần NLS settings phù hợp) | ✅ |
| **Case-insensitive LIKE** | `ILIKE` hoặc `LOWER(col) LIKE` | `utf8_..._ci` collation | `NLS_COMP=LINGUISTIC + NLS_SORT=BINARY_CI` | Collation `_CI_` |
| **Plan caching** | Custom 5 lần → Generic | Per-statement, ít cache | Bind peeking + Adaptive Cursor Sharing | Parameter sniffing |
| **Trigram-like index** | `pg_trgm` (GIN/GIST) | `ngram` parser (full-text) | Oracle Text `CTXCAT`/`CONTEXT` | Full-Text Search |
| **Full-text search built-in** | `tsvector` + GIN | `FULLTEXT INDEX` | Oracle Text | SQL Server FTS |
| **Functional/Expression index** | ✅ | ✅ (MySQL 8+) | ✅ | ✅ (Computed column) |
| **Hiện rõ access vs filter trong EXPLAIN** | Một phần (Index Cond vs Filter) | Khó nhìn | ✅ Rõ ràng nhất | ✅ |

### 8.1. Ví dụ MySQL với FULLTEXT

```sql
CREATE TABLE courses (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255),
    description TEXT,
    FULLTEXT KEY ft_title_desc (title, description) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tìm kiếm
SELECT * FROM courses
WHERE MATCH(title, description) AGAINST('database' IN NATURAL LANGUAGE MODE);

-- Boolean mode (operator + - * "")
SELECT * FROM courses
WHERE MATCH(title, description) AGAINST('+sql -mysql' IN BOOLEAN MODE);
```

### 8.2. Ví dụ Oracle Text

```sql
CREATE INDEX idx_title_ctx ON courses(title)
    INDEXTYPE IS CTXSYS.CONTEXT;

SELECT * FROM courses
WHERE CONTAINS(title, 'database', 1) > 0;
```

---

## 9. Giải pháp 1: Trigram Index (GIN) — Deep dive

Khi bạn **thực sự cần** tìm `%keyword%` (ví dụ thanh tìm kiếm cho khách hàng) thì làm sao?

### 9.1. Ý tưởng: tìm theo mảnh ký tự

Thay vì lưu cả chuỗi, ta tách nó thành **tất cả các nhóm 3 ký tự liên tiếp** (trigram). Postgres `pg_trgm` thêm 2 space ở đầu và 1 ở cuối:

```sql
SELECT show_trgm('cdsa');
-- {"  c"," cd","cds","dsa","sa "}

SELECT show_trgm('database');
-- {"  d"," da","aba","abas","ase","atab","bas","data","se ","tab"}
```

> [!NOTE]
> **Tại sao 3 ký tự (trigram), không phải 2 hay 4?**
> - **Bigram (2)**: chỉ có ~26²=676 tổ hợp (cho ASCII) → quá phổ biến, mỗi bigram match hàng triệu rows → chọn lọc kém.
> - **4-gram**: ~456,976 tổ hợp → chọn lọc tốt nhưng không dùng được cho query ngắn như `%db%`.
> - **Trigram (3)**: ~17,576 tổ hợp → điểm cân bằng giữa selectivity và usability.

### 9.2. GIN — Generalized Inverted Index

Sau khi có các trigram, database lưu chúng trong một loại index đặc biệt: **GIN** (Generalized Inverted Index). Cấu trúc:

```
Posting tree (B-Tree of trigrams)

   "abc" ──→ [posting list: 1, 5, 8, 12, 99, 1000, ...]
   "abd" ──→ [posting list: 2, 7]
   "abe" ──→ [posting list: 4, 15, 22, ...]
   "atab"──→ [posting list: 1, 8, 99]
   "data"──→ [posting list: 1, 8, 99]
   "dba" ──→ [posting list: 3, 9, 11, ...]
   ...
```

Mỗi entry trong posting list **đã sort theo CTID/RowID** → cho phép **set intersection** cực nhanh.

### 9.3. Quy trình query `LIKE '%database%'`

```diagram
╭───────────────────────────────────────────────────────────────╮
│ 1. Tách query: trigrams("database")                           │
│    = { "dat", "ata", "tab", "aba", "bas", "ase" }             │
│                                                               │
│ 2. Với mỗi trigram, lấy posting list:                         │
│    "dat" → [1, 5, 8, 12, ...]                                 │
│    "ata" → [1, 8, 12, 99, ...]                                │
│    "tab" → [1, 8, ...]                                        │
│    "aba" → [1, 8, ...]                                        │
│    "bas" → [1, 8, ...]                                        │
│    "ase" → [1, 8, ...]                                        │
│                                                               │
│ 3. INTERSECTION (merge join các posting list đã sort):        │
│    → [1, 8]                                                   │
│                                                               │
│ 4. RECHECK: fetch row 1, 8 → kiểm tra có thực sự chứa         │
│    chuỗi "database" liên tiếp không (vì GIN chỉ biết các      │
│    trigram cùng tồn tại, không biết chúng có sát nhau)        │
│                                                               │
│ 5. Trả về row 1 và 8                                          │
╰───────────────────────────────────────────────────────────────╯
```

**Từ 15 giây Seq Scan → còn ~3-10 milliseconds.**

### 9.4. Setup trong Postgres

```sql
-- 1. Bật extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Tạo GIN index cho LIKE / ILIKE
CREATE INDEX idx_courses_title_trgm
  ON courses USING GIN (title gin_trgm_ops);

-- 3. Bây giờ tất cả các pattern này dùng index:
SELECT * FROM courses WHERE title LIKE '%database%';
SELECT * FROM courses WHERE title ILIKE '%DATABASE%';
SELECT * FROM courses WHERE title LIKE '%db%';
SELECT * FROM courses WHERE title ~ 'data.*base';
SELECT * FROM courses WHERE title ~* '(sql|mysql|postgres)';
```

### 9.5. GIN vs GIST cho trigram

`pg_trgm` hỗ trợ **cả 2** loại index:

| Aspect | GIN | GIST |
|--------|-----|------|
| **Tốc độ search** | Nhanh hơn (10-100x với pattern phổ biến) | Chậm hơn |
| **Tốc độ insert** | Chậm hơn (có `gin_pending_list` để batch) | Nhanh hơn |
| **Kích thước** | Lớn hơn 3-5x | Lớn hơn 2-3x |
| **Hỗ trợ similarity ranking** (`%`, `<->`) | ✅ | ✅ |
| **K-NN search** (`ORDER BY col <-> 'query'`) | ❌ | ✅ |
| **Use case** | Write ít, read nhiều | Write nhiều, fuzzy match top-K |

```sql
-- GIN (default)
CREATE INDEX idx_t_gin ON courses USING GIN (title gin_trgm_ops);

-- GIST (cho similarity + KNN)
CREATE INDEX idx_t_gist ON courses USING GIST (title gist_trgm_ops);

-- KNN search: tìm 10 title tương tự nhất với 'sql mstery' (sai chính tả)
SELECT title, title <-> 'sql mstery' AS distance
FROM courses
ORDER BY title <-> 'sql mstery'
LIMIT 10;
```

### 9.6. Similarity & Fuzzy matching

`pg_trgm` tặng kèm operator **similarity**:

```sql
-- Set threshold (default 0.3)
SET pg_trgm.similarity_threshold = 0.4;

-- % operator: trả TRUE nếu similarity >= threshold
SELECT * FROM courses WHERE title % 'datebase';  -- typo

-- similarity() function: trả số 0..1
SELECT title, similarity(title, 'datebase') AS sim
FROM courses
WHERE title % 'datebase'
ORDER BY sim DESC;
```

Đây là cách build **typo-tolerant search** chỉ với Postgres, không cần Elasticsearch.

### 9.7. Đánh đổi của GIN trigram

| Aspect | Trigram GIN | B-Tree thường |
|--------|-------------|---------------|
| **Dung lượng index** | 3-5x larger | baseline |
| **Insert time** | 2-5x slower (có `gin_pending_list` để batch) | baseline |
| **Update time** | Tệ với cột thay đổi nhiều | baseline |
| **Search `%abc%`** | ✅ Nhanh | ❌ Không dùng được |
| **Search `abc%`** | ✅ Cũng nhanh | ✅ Nhanh hơn chút |
| **`ORDER BY col`** | ❌ | ✅ |

> [!TIP]
> **Khi nào dùng GIN trigram**:
> - Search bar cho admin, internal tool — write ít, query đa dạng.
> - Username, email, mã sản phẩm — cần search substring chính xác.
>
> **Khi nào KHÔNG dùng**:
> - Bảng cực write-heavy (logs).
> - Cần ranking theo độ liên quan (ngôn ngữ) → dùng FTS.
> - > 100M rows → cân nhắc Elasticsearch.

### 9.8. Tuning `gin_pending_list`

GIN có "pending list" để batch insert — tránh re-balance cây mỗi lần. Khi list đầy, autovacuum sẽ merge vào index chính:

```sql
-- Xem kích thước pending list
SELECT * FROM gin_metapage_info(get_raw_page('idx_courses_title_trgm', 0));

-- Force merge pending list (khi search bị chậm vì pending list to)
SELECT gin_clean_pending_list('idx_courses_title_trgm');

-- Tăng kích thước pending list cho bulk insert
ALTER INDEX idx_courses_title_trgm SET (gin_pending_list_limit = 16384);
```

---

## 10. Giải pháp 2: Full-Text Search — Deep dive

Khi trigram không đáp ứng được yêu cầu **ngữ nghĩa**. Trigram chỉ so khớp **mảnh ký tự**, không hiểu được:

```
"optimizing", "optimize", "optimization", "optimizer"
```

cùng một từ gốc. User gõ `"optimizing"` thì **không** ra được các từ kia bằng trigram.

**Full-Text Search** sinh ra để giải quyết đúng điều đó.

### 10.1. 3 bước xử lý

```diagram
╭──────────────────────────────────────────────────────────────╮
│  Document: "SQL tips to optimize database queries"           │
│                                                              │
│  Bước 1 — Tokenization (parser tách câu thành từ):           │
│  → [SQL, tips, to, optimize, database, queries]              │
│                                                              │
│  Bước 2 — Normalization (qua dictionary chain):              │
│   2a. Stopword filter (bỏ từ phổ biến):                      │
│        Anh: a, an, the, to, of, in, on...                    │
│        Việt: và, hoặc, là, của, với...                       │
│   → [SQL, tips, optimize, database, queries]                 │
│                                                              │
│   2b. Stemming (đưa về dạng gốc bằng rule Porter/Snowball):  │
│   → [sql, tip, optim, databas, queri]                        │
│                                                              │
│  Bước 3 — Inverted Index:                                    │
│   "optim"  → [doc 1, doc 5, doc 8]                           │
│   "queri"  → [doc 1, doc 3, doc 8]                           │
╰──────────────────────────────────────────────────────────────╯
```

> [!NOTE]
> `optim` hay `databas` không phải từ thật. Không sao — miễn là **mọi biến thể của một từ đều quy về cùng một gốc**, đó mới là mục tiêu. Mục tiêu của stemming **không phải** ra đúng từ điển, mà là **deterministic mapping**.

### 10.2. tsvector & tsquery

Postgres dùng 2 type chính:

```sql
-- Văn bản gốc → tsvector
SELECT to_tsvector('english', 'SQL tips to optimize database queries');
-- Result: 'databas':5 'optim':4 'queri':6 'sql':1 'tip':2

-- Query string → tsquery
SELECT to_tsquery('english', 'optimize & query');
-- Result: 'optim' & 'queri'

-- Operator @@: tsvector matches tsquery?
SELECT to_tsvector('english', 'I optimize my queries')
       @@ to_tsquery('english', 'optimize & query');
-- → true
```

Mỗi từ trong `tsvector` đi kèm **vị trí** (position) trong câu gốc — cho phép tính ranking dựa trên khoảng cách.

### 10.3. Inverted Index — như mục lục cuối sách

Thay vì lưu *"document chứa từ gì"*, nó lưu *"từ này xuất hiện trong document nào"*. Các phép truy vấn logic trở nên cực nhanh:

| Phép | Postgres operator | Cách thực hiện |
|------|------------------|---------------|
| Chứa cả `A` và `B` | `'a & b'` | **Intersection** 2 posting list |
| Chứa `A` hoặc `B` | `'a \| b'` | **Union** |
| Chứa `A` nhưng không có `B` | `'a & !b'` | **Difference** |
| Cụm từ `"a b"` chính xác | `'a <-> b'` | Intersection + check position liền kề |
| Trong khoảng N từ | `'a <N> b'` | Position-aware |

Tất cả chỉ cần **duyệt song song một lượt** là xong (vì đã sort sẵn).

### 10.4. Khi user search `"optimizing queries"`

```
1. Normalize query  →  to_tsquery('english', 'optimize & query')
                    →  'optim' & 'queri'

2. Tra inverted index:
     "optim" → [1, 5, 8]
     "queri" → [1, 3, 8]

3. Intersection  →  [1, 8]

4. Trả về docs 1 và 8
```

Đây chính là lý do gõ `"optimizing"` vẫn tìm được bài chứa `"optimized"`, `"optimization"` — tất cả đều quy về `"optim"`.

### 10.5. Ranking — `ts_rank` & `ts_rank_cd`

Thêm một thứ mà LIKE **không làm được** — **ranking theo độ liên quan**:

```sql
SELECT title,
       ts_rank(tsv, query) AS rank
FROM courses,
     to_tsquery('english', 'optimize & query') query
WHERE tsv @@ query
ORDER BY rank DESC
LIMIT 10;
```

| Function | Đặc điểm |
|----------|----------|
| `ts_rank` | Đếm tần suất từ khóa, có normalization theo độ dài document |
| `ts_rank_cd` | "Cover density" — xét cả khoảng cách giữa các từ khóa (gần nhau → điểm cao hơn) |

### 10.6. Weight — gán trọng số cho từng phần document

Ví dụ keyword trong tiêu đề quan trọng hơn trong nội dung:

```sql
ALTER TABLE courses ADD COLUMN tsv tsvector;

UPDATE courses SET tsv =
   setweight(to_tsvector('english', coalesce(title, '')),       'A') ||
   setweight(to_tsvector('english', coalesce(instructor, '')),  'B') ||
   setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
   setweight(to_tsvector('english', coalesce(body, '')),        'D');

-- Default weights: {0.1, 0.2, 0.4, 1.0} cho {D, C, B, A}
-- Custom:
SELECT ts_rank('{0.1, 0.2, 0.4, 1.0}', tsv, query) FROM ...
```

### 10.7. Generated Column + GIN Index (production setup)

```sql
ALTER TABLE courses ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')),       'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX idx_courses_tsv ON courses USING GIN (tsv);

-- Query
SELECT id, title,
       ts_rank_cd(tsv, query) AS rank,
       ts_headline('english', description, query) AS snippet
FROM courses, websearch_to_tsquery('english', 'sql optimization') query
WHERE tsv @@ query
ORDER BY rank DESC
LIMIT 20;
```

### 10.8. Các query function tiện dụng

| Function | Dùng cho | Ví dụ input |
|----------|---------|-------------|
| `to_tsquery` | Syntax chính xác | `'sql & optim'` |
| `plainto_tsquery` | Plain text → AND tất cả từ | `'sql optimization'` → `'sql & optim'` |
| `phraseto_tsquery` | Cụm từ chính xác | `'sql optimization'` → `'sql <-> optim'` |
| `websearch_to_tsquery` | Syntax giống Google | `'sql "optim*" -mysql'` |

> [!TIP]
> Production nên dùng **`websearch_to_tsquery`** — user quen với cú pháp Google: dấu `"`, `-`, `OR`.

### 10.9. Highlighting — `ts_headline`

```sql
SELECT ts_headline(
  'english',
  description,
  websearch_to_tsquery('english', 'sql optimization'),
  'StartSel=<mark>, StopSel=</mark>, MaxWords=20, MinWords=5'
)
FROM courses LIMIT 1;
-- → "...Learn <mark>SQL</mark> <mark>optimization</mark> with..."
```

### 10.10. Multilingual

Postgres ship sẵn 20+ dictionaries (`english`, `german`, `french`, `spanish`, ...). Tiếng Việt không có sẵn — cần tự build:

```sql
-- Tiếng Việt: dùng "simple" dictionary (không stem) + custom stopword
CREATE TEXT SEARCH CONFIGURATION vietnamese (COPY = simple);

CREATE TEXT SEARCH DICTIONARY vietnamese_stop (
    TEMPLATE = simple,
    STOPWORDS = vietnamese  -- file vietnamese.stop trong $SHAREDIR/tsearch_data
);

ALTER TEXT SEARCH CONFIGURATION vietnamese
    ALTER MAPPING FOR asciiword, word, asciihword, hword WITH vietnamese_stop;
```

Hoặc dùng community extension `dict_xsyn`, `pgroonga` cho CJK languages.

---

## 11. Giải pháp 3: Suffix Search bằng Reversed Column

Một **trick nhỏ nhưng hiệu quả bất ngờ** — nếu bạn chỉ cần tìm theo **hậu tố cố định** (email domain, file extension, mã có suffix có nghĩa):

```sql
-- ❌ Không dùng được index
WHERE email LIKE '%@cdsa.com';
WHERE filename LIKE '%.pdf';
WHERE phone LIKE '%9999';   -- last 4 digits
```

### 11.1. Ý tưởng: reverse → biến suffix thành prefix

Thêm một cột chứa **chuỗi đảo ngược**, rồi tìm bằng prefix:

```sql
-- Postgres
ALTER TABLE users ADD COLUMN email_reversed text
  GENERATED ALWAYS AS (reverse(email)) STORED;

CREATE INDEX idx_users_email_rev
  ON users (email_reversed text_pattern_ops);

-- Suffix search → biến thành prefix search!
SELECT * FROM users
WHERE email_reversed LIKE reverse('@cdsa.com') || '%';
-- Tức:  WHERE email_reversed LIKE 'moc.asdc@%'
```

EXPLAIN:

```text
Index Scan using idx_users_email_rev on users
   Index Cond: ((email_reversed ~>=~ 'moc.asdc@') AND
                (email_reversed ~<~ 'moc.asdc'))
   Filter: (email_reversed ~~ 'moc.asdc@%')
 Execution Time: 0.31 ms
```

### 11.2. Use cases

| Use case | Pattern | Reversed pattern |
|----------|---------|------------------|
| Email domain | `LIKE '%@gmail.com'` | `LIKE 'moc.liamg@%'` |
| File extension | `LIKE '%.pdf'` | `LIKE 'fdp.%'` |
| Phone suffix | `LIKE '%9999'` | `LIKE '9999%'` |
| Domain hosting | `LIKE '%.vn'` | `LIKE 'nv.%'` |
| Product code suffix | `LIKE '%-VN-2024'` | `LIKE '4202-NV-%'` |

### 11.3. Function-based index (alternative)

Nếu không muốn thêm cột:

```sql
-- Postgres function-based index
CREATE INDEX idx_email_rev_func
  ON users (reverse(email) text_pattern_ops);

-- Query phải dùng cùng expression
SELECT * FROM users
WHERE reverse(email) LIKE reverse('@cdsa.com') || '%';
```

> [!TIP]
> Generated column (mục 11.1) **tốt hơn** function-based index cho production: dễ debug, dễ query, và performance tương đương.

### 11.4. Trade-off

- **+** Đơn giản, không cần extension.
- **+** Dùng được B-Tree → tốc độ tương đương prefix search.
- **−** Tăng dung lượng table (~bằng kích thước cột gốc).
- **−** Insert/update chậm hơn chút (phải tính reverse).
- **−** Chỉ hoạt động cho **suffix cố định** — không hoạt động cho `%middle%`.

---

## 12. Giải pháp 4: Expression Index, Functional Index & Case-Insensitive

Vấn đề case-insensitive là **rất phổ biến** và đáng có section riêng.

### 12.1. Vấn đề

```sql
-- User gõ "MASTERY", bạn muốn match cả "Mastery", "mastery", "MASTERY"
SELECT * FROM courses WHERE LOWER(title) = LOWER('MASTERY');
-- → Seq Scan, vì LOWER(title) không match index trên title
```

### 12.2. Expression Index

Postgres / Oracle / SQL Server (computed column) đều hỗ trợ:

```sql
-- Postgres
CREATE INDEX idx_courses_lower_title
  ON courses (LOWER(title) text_pattern_ops);

-- Query phải dùng CHÍNH XÁC cùng expression
SELECT * FROM courses WHERE LOWER(title) LIKE LOWER('SQL%');
-- → Index Range Scan ✅
```

```sql
-- MySQL 8+
CREATE INDEX idx_courses_lower_title
  ON courses ((LOWER(title)));
```

```sql
-- SQL Server (computed column persisted)
ALTER TABLE courses ADD title_lower AS LOWER(title) PERSISTED;
CREATE INDEX idx_courses_title_lower ON courses(title_lower);
```

### 12.3. CITEXT — Postgres extension

```sql
CREATE EXTENSION IF NOT EXISTS citext;

ALTER TABLE users ALTER COLUMN email TYPE citext;
-- Bây giờ mọi so sánh trên cột email tự động case-insensitive

CREATE INDEX idx_users_email ON users (email);
SELECT * FROM users WHERE email = 'USER@EXAMPLE.COM';
-- → match user@example.com
```

### 12.4. ILIKE + GIN trigram

Đã đề cập ở mục 9 — `pg_trgm` GIN index hỗ trợ ILIKE tự động:

```sql
CREATE INDEX idx_title_trgm ON courses USING GIN (title gin_trgm_ops);
SELECT * FROM courses WHERE title ILIKE '%database%';
-- → Bitmap Index Scan ✅
```

### 12.5. Collation-based (cleanest cho Postgres 12+)

```sql
-- Tạo collation case-insensitive
CREATE COLLATION case_insensitive (
    provider = icu,
    locale = 'und-u-ks-level2',
    deterministic = false
);

-- Apply lên cột
ALTER TABLE courses ALTER COLUMN title TYPE text COLLATE case_insensitive;

CREATE INDEX idx_courses_title ON courses (title);

-- Tự động case-insensitive
SELECT * FROM courses WHERE title = 'SQL MASTERY';
SELECT * FROM courses WHERE title LIKE 'SQL%';
```

> [!TIP]
> Đây là cách **cleanest** cho Postgres modern — không cần `LOWER()` khắp app, không cần CITEXT extension.

---

## 13. Giải pháp 5: External Search Engine (Elasticsearch / Meilisearch / Typesense)

Khi scale lên **hàng trăm triệu rows**, hoặc cần:

- Multi-language với CJK (Chinese, Japanese, Korean), Vietnamese, Arabic, ...
- **Fuzzy / typo-tolerant** ở mức cao (`levenshtein distance`).
- **Faceted search** (filter theo nhiều dimension đồng thời).
- **Geo search**.
- **Synonyms** (TV ↔ television, US ↔ United States).
- **Autocomplete suggester** với personalization.

→ Lúc này Postgres FTS bắt đầu đuối. Move sang search engine chuyên dụng.

### 13.1. So sánh nhanh

| Engine | Strength | Weakness | Use case |
|--------|----------|----------|----------|
| **Elasticsearch** | Mature, distributed, full-text powerful, aggregations | Phức tạp, RAM-hungry, license phức tạp | Log search, e-commerce, enterprise |
| **OpenSearch** | Apache 2.0 fork của ES | Tương tự ES | Khi cần license rõ ràng |
| **Meilisearch** | Setup 5 phút, typo-tolerant tốt, REST API friendly | Single-node (cluster ở enterprise tier) | Search bar startup, blog, SaaS |
| **Typesense** | Tương tự Meilisearch, có cluster | Ít plugin hơn ES | App search, e-commerce nhỏ-vừa |
| **Sonic** | Cực nhẹ (RAM <30MB) | Ít feature | Edge devices, small project |
| **pg_search / ZomboDB** | Postgres + ES embedded | Phức tạp ops | Khi muốn ES nhưng giữ Postgres |

### 13.2. Bản chất bên trong vẫn là Inverted Index

> [!IMPORTANT]
> Tất cả các search engine trên đều dùng **inverted index** (Lucene cho ES/OpenSearch, custom cho Meilisearch/Typesense). Khác biệt chủ yếu là:
> - **Distributed**: shard + replica trên nhiều node.
> - **Ranking algorithm**: BM25 (ES default), tf-idf, custom learning-to-rank.
> - **Tokenizer**: support nhiều language tốt hơn Postgres.
> - **API**: REST/JSON-first, dễ tích hợp.

### 13.3. Pattern phổ biến: Postgres + Elasticsearch sync

```diagram
╭───────────────╮     CDC      ╭───────────────╮
│  Postgres     │─────────────▶│ Elasticsearch │
│  (source of   │  Debezium /  │  (search +    │
│   truth)      │  logical rep │   aggregation)│
╰───────────────╯              ╰───────────────╯
       ▲                              ▲
       │ writes                       │ search queries
       │                              │
       ╰──────── App ─────────────────╯
```

- **Postgres** giữ canonical data, transaction integrity.
- **Elasticsearch** index data cho search & aggregations.
- **CDC tool** (Debezium, Postgres logical replication) sync near-realtime.

---

## 14. Real-world scenarios — Auto-complete, Search bar, Log search, Email lookup

### 14.1. Auto-complete cho search box

**Yêu cầu**: user gõ vài ký tự, suggest 10 kết quả gần đúng. Latency < 50ms.

**Giải pháp**: B-Tree prefix index. Đơn giản, đủ dùng.

```sql
CREATE INDEX idx_courses_title_pattern
  ON courses (title text_pattern_ops);

SELECT title FROM courses
WHERE title ILIKE $1 || '%'
ORDER BY popularity DESC
LIMIT 10;
```

> [!TIP]
> Nếu cần case-insensitive autocomplete với index — dùng expression index hoặc collation `case_insensitive` (mục 12).

### 14.2. Search bar cho admin dashboard

**Yêu cầu**: search trong title + description, hỗ trợ partial match, không cần ranking phức tạp.

**Giải pháp**: GIN trigram.

```sql
CREATE INDEX idx_courses_search_trgm ON courses
  USING GIN ((title || ' ' || description) gin_trgm_ops);

SELECT * FROM courses
WHERE (title || ' ' || description) ILIKE '%' || $1 || '%'
LIMIT 50;
```

### 14.3. User-facing content search (bài viết, khóa học)

**Yêu cầu**: search trên nội dung dài, hỗ trợ stem, có ranking, highlight.

**Giải pháp**: Postgres FTS + GIN tsvector.

```sql
ALTER TABLE courses ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', description), 'B')
  ) STORED;

CREATE INDEX idx_courses_tsv ON courses USING GIN (tsv);

SELECT id, title,
       ts_rank_cd(tsv, q) AS rank,
       ts_headline('english', description, q,
                   'MaxWords=20, MinWords=5') AS snippet
FROM courses, websearch_to_tsquery('english', $1) q
WHERE tsv @@ q
ORDER BY rank DESC, popularity DESC
LIMIT 20;
```

### 14.4. Email lookup theo domain

**Yêu cầu**: "tất cả user có email `@company.com`" cho marketing campaign.

**Giải pháp**: Reversed column + B-Tree.

```sql
ALTER TABLE users ADD COLUMN email_rev text
  GENERATED ALWAYS AS (reverse(lower(email))) STORED;

CREATE INDEX idx_users_email_rev
  ON users (email_rev text_pattern_ops);

SELECT * FROM users
WHERE email_rev LIKE reverse(lower($1)) || '%';
-- Input: '@company.com' → search 'moc.ynapmoc@%'
```

### 14.5. Log search trên 500M rows

**Yêu cầu**: search log messages chứa pattern bất kỳ, range thời gian, group theo level/service.

**Giải pháp**: Move khỏi Postgres → Elasticsearch / Loki / Clickhouse.

```diagram
╭──────────╮  Fluent Bit   ╭───────────────╮  Kibana
│   App    │──────────────▶│ Elasticsearch │ ◀──── User
│  logs    │  / Vector     │  + index      │
╰──────────╯               ╰───────────────╯
```

Postgres không phải tool cho log search ở scale này — write rate cao + cardinality lớn sẽ phá GIN index.

### 14.6. Phone number search "last 4 digits"

**Yêu cầu**: contact center nhập 4 số cuối → tìm khách hàng.

**Giải pháp**: thêm cột `phone_last4`.

```sql
ALTER TABLE customers ADD COLUMN phone_last4 char(4)
  GENERATED ALWAYS AS (right(phone, 4)) STORED;

CREATE INDEX idx_customers_phone_last4 ON customers (phone_last4);

SELECT * FROM customers WHERE phone_last4 = $1;
```

> [!TIP]
> Khi pattern search có cấu trúc cố định, **derived column** với index B-Tree đơn giản thường thắng cả trigram/FTS về tốc độ và đơn giản ops.

### 14.7. Product code search "starts-with, then contains"

**Yêu cầu**: code dạng `VN-2024-XXXX`, user có thể search theo prefix hoặc partial substring.

**Giải pháp**: kết hợp **2 index**:

```sql
-- B-Tree cho prefix search (case thường gặp nhất, nhanh nhất)
CREATE INDEX idx_products_code_prefix ON products (code text_pattern_ops);

-- GIN trigram cho substring search (fallback)
CREATE INDEX idx_products_code_trgm ON products USING GIN (code gin_trgm_ops);
```

Logic ứng dụng: thử prefix trước, không có hits thì fallback substring.

---

## 15. Anti-patterns cần tránh

### 15.1. ❌ Dùng LIKE cho equality

```sql
-- Anti: thừa wildcard không cần thiết
WHERE name LIKE 'John Smith'

-- Đúng:
WHERE name = 'John Smith'
```

Một số DB convert tự động, nhưng đừng dựa vào.

### 15.2. ❌ Function trên cột mà không có expression index

```sql
-- Anti: kill index
WHERE LOWER(email) = 'user@example.com'
WHERE DATE(created_at) = '2024-01-01'
WHERE EXTRACT(YEAR FROM created_at) = 2024

-- Đúng:
WHERE email = 'USER@EXAMPLE.COM' COLLATE case_insensitive
WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02'
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'
```

### 15.3. ❌ Wrapping mọi search trong `'%...%'`

```sql
-- Anti: app code đè dấu % vào mọi search
const sql = `SELECT * FROM x WHERE name LIKE '%${input}%'`;

-- Đúng: hiểu user intent
-- - "starts with" → '${input}%'
-- - "exact" → '${input}'
-- - "contains" → cần GIN trigram, chứ không phải B-Tree
```

### 15.4. ❌ LIKE để filter trên cột không phải text

```sql
-- Anti: forces CAST
WHERE id::text LIKE '123%'

-- Đúng: range trên numeric
WHERE id BETWEEN 1230000 AND 1239999
```

### 15.5. ❌ Đặt GIN trigram trên cột thay đổi liên tục

GIN insert/update chậm. Nếu cột thay đổi >100 lần/giây → GIN sẽ thành bottleneck. Cân nhắc:

- Tách bảng "hot" (write) và "cold" (search).
- Dùng search engine external sync qua CDC.

### 15.6. ❌ Tin vào `EXPLAIN` mà không `EXPLAIN ANALYZE`

`EXPLAIN` cho cost ước lượng. `EXPLAIN ANALYZE` thực sự chạy query và đo thời gian. Statistics cũ có thể khiến cost ước lượng sai hoàn toàn.

```sql
-- Production query debug
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM courses WHERE title LIKE '%database%';
```

### 15.7. ❌ Quên `ANALYZE` sau bulk load

```sql
COPY courses FROM '/tmp/data.csv';
-- Quên: ANALYZE courses;
-- → Statistics outdated → planner chọn plan tệ
```

---

## 16. Monitoring & Maintenance

### 16.1. Tìm các query LIKE chậm

Postgres với `pg_stat_statements`:

```sql
SELECT
    substring(query, 1, 80) AS query,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    round(mean_exec_time::numeric, 2) AS mean_ms,
    rows
FROM pg_stat_statements
WHERE query ILIKE '%LIKE%'
   OR query ILIKE '%ILIKE%'
ORDER BY total_exec_time DESC
LIMIT 20;
```

### 16.2. Kiểm tra index có được dùng không

```sql
SELECT
    schemaname, relname AS table,
    indexrelname AS index,
    idx_scan, idx_tup_read, idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
-- → Index có 0 lần scan = candidate to drop
```

### 16.3. Kích thước GIN index

```sql
SELECT
    indexrelname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    idx_scan
FROM pg_stat_user_indexes
WHERE indexrelname LIKE '%trgm%' OR indexrelname LIKE '%tsv%'
ORDER BY pg_relation_size(indexrelid) DESC;
```

### 16.4. GIN pending list health

```sql
-- Pending list lớn = search chậm, cần vacuum/clean
SELECT
    n.nspname, c.relname,
    pg_size_pretty(pg_relation_size(c.oid)) AS index_size,
    s.idx_scan
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
WHERE c.relam = (SELECT oid FROM pg_am WHERE amname = 'gin');

-- Manual clean
SELECT gin_clean_pending_list('idx_courses_title_trgm');
```

### 16.5. Vacuum & Reindex

```sql
-- Vacuum để clean dead tuples (cũng giải quyết bloat)
VACUUM (ANALYZE) courses;

-- Reindex để chống bloat của index
REINDEX INDEX CONCURRENTLY idx_courses_title_trgm;

-- Postgres 12+
REINDEX TABLE CONCURRENTLY courses;
```

---

## 17. Migration playbook — Từ LIKE chậm sang giải pháp đúng

Bạn thừa hưởng app dùng `LIKE '%...%'` khắp nơi. Làm sao migrate an toàn?

### 17.1. Bước 1 — Đo & phân loại

```sql
-- Lấy top 20 query chứa LIKE chậm nhất
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE query ~* 'LIKE|ILIKE'
ORDER BY total_exec_time DESC
LIMIT 20;
```

Phân loại từng query:

| Pattern | Giải pháp |
|---------|-----------|
| `'literal%'` | B-Tree + `text_pattern_ops` |
| `'%literal'` | Reversed column + B-Tree |
| `'%literal%'` (short, internal) | GIN trigram |
| `'%literal%'` (content, user-facing) | FTS tsvector |
| ILIKE bất kỳ | GIN trigram (hỗ trợ cả ILIKE) |

### 17.2. Bước 2 — Add index CONCURRENTLY

```sql
-- Không block writes
CREATE INDEX CONCURRENTLY idx_courses_title_trgm
  ON courses USING GIN (title gin_trgm_ops);
```

> [!CAUTION]
> `CREATE INDEX CONCURRENTLY` không thể chạy trong transaction. Nếu fail, để lại `INVALID` index — phải `DROP INDEX` rồi tạo lại.

### 17.3. Bước 3 — Verify với EXPLAIN

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM courses WHERE title LIKE '%database%';
-- Confirm: Bitmap Index Scan on idx_courses_title_trgm
```

### 17.4. Bước 4 — Monitor production

- Theo dõi `idx_scan` trên index mới — phải > 0 sau vài giờ.
- Theo dõi `mean_exec_time` của query gốc trong `pg_stat_statements` — phải giảm.
- Theo dõi `pg_stat_user_tables.n_tup_upd` để biết write overhead.

### 17.5. Bước 5 — Cleanup index không dùng

Sau 1-2 tuần, drop các B-Tree cũ nếu được thay thế hoàn toàn:

```sql
SELECT indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE relname = 'courses' AND idx_scan = 0;

DROP INDEX CONCURRENTLY idx_old_unused;
```

---

## 18. Tóm tắt — Cheat sheet & 3 nguyên tắc

Quay lại câu hỏi đầu doc: **Tại sao index không hoạt động với `LIKE '%database%'`?**

> B-Tree cần **prefix** để biết bắt đầu từ đâu. Dấu `%` ở đầu đồng nghĩa với **không có điểm bắt đầu** → index bị bỏ qua.

### 18.1. Cheat sheet pattern → giải pháp

```diagram
╭───────────────────────────────────────────────────────────────╮
│  Pattern               Status              Fix                │
│  ─────────────────────────────────────────────────────────    │
│  'abc%'                ✅ B-Tree           text_pattern_ops   │
│  'abc%xyz'             ⚠️ Access='abc'    Dùng prefix dài hơn │
│  '%abc'                ❌ Seq Scan         Reversed column    │
│  '%abc%'               ❌ Seq Scan         GIN trigram        │
│  ILIKE bất kỳ          ❌ Seq Scan         GIN trigram        │
│  Natural language      ❌ Seq Scan         FTS tsvector + GIN │
│  Typo-tolerant         ❌ Seq Scan         pg_trgm similarity │
│  Multi-field, ranking  ❌ Seq Scan         FTS + setweight    │
│  > 100M rows + facet   ❌ Postgres slow    Elasticsearch      │
╰───────────────────────────────────────────────────────────────╯
```

### 18.2. So sánh các giải pháp

| Giải pháp | Setup | Index size | Insert cost | Search `%x%` | Ranking | Typo-tolerant |
|-----------|-------|-----------|-------------|--------------|---------|---------------|
| B-Tree `text_pattern_ops` | Dễ | 1x | Nhẹ | ❌ | ❌ | ❌ |
| Reversed column | Dễ | 2x | Nhẹ | ❌ (chỉ suffix) | ❌ | ❌ |
| GIN trigram | Trung | 3-5x | Nặng | ✅ | △ similarity | ✅ |
| FTS (tsvector) | Trung | 2-3x | Trung | △ (full word) | ✅ | ❌ |
| Elasticsearch | Khó | External | External | ✅ | ✅ | ✅ |

### 18.3. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Luôn đặt prefix trước `%` khi có thể.**
> `'abc%'` nhanh hơn `'%abc'` hàng nghìn lần. Prefix càng dài, càng tốt.
>
> **2. Đừng bắt `LIKE` làm việc nó không sinh ra để làm.**
> - **Trigram GIN** cho substring search trên ký tự.
> - **Full-Text Search** cho ngữ nghĩa (stemming, stopword, ranking).
> - **Reversed column** cho suffix cố định.
> - **Elasticsearch / Meilisearch** khi scale lớn.
>
> **3. Lần tới khi viết `LIKE`, hãy dừng một giây và tự hỏi:**
> > *"Database có biết bắt đầu tìm từ đâu trên cây không?"*
>
> Nếu câu trả lời là **không** — bạn đã biết phải fix ở đâu rồi.

### 18.4. Quote cuối

> Hiểu cơ chế → fix đúng chỗ → cải thiện hàng trăm lần với một dòng SQL. Đó là vẻ đẹp khi ta đào sâu vào hiểu **bản chất** mọi thứ thay vì copy giải pháp từ Stack Overflow.

Lần sau khi thấy query chậm dù "có index" — hãy nhớ: **vấn đề có thể chỉ là vị trí của một dấu `%`.**
