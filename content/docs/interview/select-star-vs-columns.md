---
title: "SELECT * vs SELECT cột cần — khác nhau thật sự ở đâu?"
description: "Câu hỏi phỏng vấn: SELECT * và SELECT chỉ vài cột khác nhau ra sao về hiệu năng? Mổ xẻ index-only scan, covering index, TOAST/giá trị lớn, băng thông mạng, projection, vì sao SELECT * phá vỡ index-only scan, và các tác hại ngầm khác."
---

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [Tác hại 1: Phá vỡ Index-Only Scan (lớn nhất)](#3-tác-hại-1-phá-vỡ-index-only-scan-lớn-nhất)
- [Tác hại 2: TOAST — cột lớn kéo theo I/O ẩn](#4-tác-hại-2-toast--cột-lớn-kéo-theo-io-ẩn)
- [Tác hại 3: Băng thông mạng & bộ nhớ ứng dụng](#5-tác-hại-3-băng-thông-mạng--bộ-nhớ-ứng-dụng)
- [Tác hại 4-6: Sort/hash phình, ORM, fragility khi schema đổi](#6-tác-hại-4-6-sorthash-phình-orm-fragility-khi-schema-đổi)
- [Bằng chứng: EXPLAIN so SELECT * vs cột cần](#7-bằng-chứng-explain-so-select--vs-cột-cần)
- [Khi nào SELECT * chấp nhận được](#8-khi-nào-select--chấp-nhận-được)
- [Câu hỏi đào sâu](#9-câu-hỏi-đào-sâu)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#10-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"`SELECT *` và `SELECT id, name` có khác nhau về hiệu năng không? Database vẫn phải đọc cả dòng từ đĩa mà, đúng không? Vậy chọn ít cột thì nhanh hơn ở chỗ nào?"*

Câu hỏi này tưởng đơn giản nhưng phơi bày một hiểu lầm sâu: *"đằng nào cũng đọc cả dòng"*. Người hiểu hệ thống sẽ chỉ ra rằng số cột bạn chọn ảnh hưởng tới **việc có dùng được index-only scan không**, **có phải fetch TOAST không**, và nhiều thứ ở tầng mạng/bộ nhớ.

> [!IMPORTANT]
> Khác biệt lớn nhất **không** nằm ở "đọc bao nhiêu byte mỗi dòng" mà ở chỗ: `SELECT *` thường **buộc database phải chạm vào heap** (vì cần mọi cột), trong khi `SELECT` đúng các cột nằm trong index có thể được phục vụ **hoàn toàn từ index** (index-only scan) — bỏ qua heap, nhanh hơn nhiều lần.

---

## 2. Câu trả lời 30 giây

> Có, khác — và không chỉ vì kích thước dữ liệu trả về. Các khác biệt chính:
> 1. **Index-only scan**: nếu mọi cột bạn cần đều có trong index, DB đọc **chỉ index**, không quay về heap. `SELECT *` cần mọi cột → phải fetch heap → mất lợi thế này.
> 2. **TOAST**: cột lớn (text/jsonb/bytea) được lưu **ngoài** dòng. `SELECT *` kéo theo cả chúng → I/O ẩn lớn dù bạn không cần.
> 3. **Mạng + bộ nhớ**: gửi thừa cột tốn băng thông, RAM ứng dụng, deserialization.
> 4. **Sort/hash phình**: cột thừa làm node sort/hash/join giữ nhiều data hơn → dễ tràn ra đĩa (`work_mem`).
> 5. **Fragility**: `SELECT *` vỡ khi schema đổi thứ tự/thêm cột; che mất việc thiếu index.
>
> Quy tắc: **chỉ chọn cột bạn thật sự dùng** — vừa nhanh, vừa mở đường cho covering index.

---

## 3. Tác hại 1: Phá vỡ Index-Only Scan (lớn nhất)

Đây là khác biệt quan trọng nhất và hay bị bỏ qua.

```sql
CREATE INDEX idx_orders_user ON orders (user_id, status);

-- ✅ Index-Only Scan: mọi cột cần (user_id, status) đều CÓ trong index
SELECT user_id, status FROM orders WHERE user_id = 42;
```

```text
 Index Only Scan using idx_orders_user on orders
   Index Cond: (user_id = 42)
   Heap Fetches: 0          ← KHÔNG chạm heap → rất nhanh
```

```sql
-- ❌ SELECT *: cần created_at, total, note... KHÔNG có trong index
SELECT * FROM orders WHERE user_id = 42;
```

```text
 Index Scan using idx_orders_user on orders   ← KHÔNG phải "Index ONLY"
   Index Cond: (user_id = 42)
   →  với mỗi entry, fetch heap để lấy các cột còn lại (random I/O)
```

```diagram
SELECT user_id, status          SELECT *
─────────────────────           ──────────
 chỉ đọc index (nhỏ, nóng)       đọc index RỒI nhảy về heap mỗi dòng
 Heap Fetches: 0                 Heap Fetches: N (random I/O)
 → nhanh                         → chậm hơn nhiều khi N lớn
```

> [!TIP]
> **Covering index** = index chứa đủ mọi cột một query cần (kể cả cột chỉ để trả về, qua `INCLUDE`):
> ```sql
> CREATE INDEX idx_orders_cover ON orders (user_id, status) INCLUDE (created_at, total);
> ```
> Với covering index, ngay cả query trả về nhiều cột vẫn index-only scan được. Nhưng covering index chỉ khả thi khi bạn **biết rõ cần cột nào** — điều mà `SELECT *` cố tình **không** nói ra.

---

## 4. Tác hại 2: TOAST — cột lớn kéo theo I/O ẩn

Postgres lưu mỗi tuple trong page 8KB. Giá trị **quá lớn** (text dài, jsonb, bytea) không vừa → được nén và lưu **ngoài** ở **TOAST table** riêng, trong dòng chính chỉ giữ con trỏ.

```diagram
Heap tuple (orders):
   [ id | user_id | status | ... | jsonb_payload → TOAST pointer ]
                                                       │
                                                       ▼
   TOAST table (lưu riêng, đọc thêm page khi cần)
   [ chunk 1 | chunk 2 | ... ]   ← jsonb 50KB nằm ở đây
```

- `SELECT id, status` → **không** đụng TOAST → nhanh.
- `SELECT *` → kéo theo `jsonb_payload` → phải đọc + giải nén TOAST chunks → **I/O ẩn** lớn, dù bạn chẳng dùng cột đó.

> [!WARNING]
> Một bảng có cột `jsonb`/`text` lớn: `SELECT *` có thể chậm gấp **nhiều lần** `SELECT` các cột nhỏ, **chỉ vì** lôi theo TOAST. Đây là thủ phạm phổ biến khiến "query đơn giản mà chậm" — bạn quên rằng `*` bao gồm cả cái cột payload 50KB.

---

## 5. Tác hại 3: Băng thông mạng & bộ nhớ ứng dụng

Ngay cả khi không có index-only scan hay TOAST, cột thừa vẫn tốn kém ở tầng truyền tải:

```diagram
SELECT *  trên bảng 30 cột, trả 10,000 dòng:
   → serialize 30 cột × 10k dòng ở server
   → đẩy qua mạng (băng thông)
   → deserialize 30 cột × 10k dòng ở client (CPU + RAM)
   → ORM map thành 10k object đầy đủ field

SELECT id, name (2 cột):
   → ~1/15 dữ liệu truyền + map
```

Với API trả JSON, mỗi cột thừa = thêm byte mạng cho **mọi** request, nhân với QPS → tốn kém thật sự ở quy mô lớn.

---

## 6. Tác hại 4-6: Sort/hash phình, ORM, fragility khi schema đổi

### 4. Sort / Hash / Join giữ nhiều data hơn

Khi query có `ORDER BY`, `DISTINCT`, hash join... các node trung gian phải **giữ các dòng trong bộ nhớ**. Càng nhiều cột → mỗi dòng càng to → dễ vượt `work_mem` → **tràn ra đĩa** (external sort/merge) → chậm đột biến.

```text
 Sort  (... Sort Method: external merge  Disk: 412800kB)   ← tràn đĩa vì dòng to
```

Chọn ít cột giúp dòng nhỏ hơn → sort/hash nằm gọn trong RAM.

### 5. ORM N+1 và over-fetching

`SELECT *` qua ORM thường nạp **mọi cột + đôi khi cả quan hệ lazy**, dễ dẫn tới over-fetch và che giấu vấn đề N+1. Chọn cột (projection / DTO) buộc bạn ý thức về data thật sự cần.

### 6. Fragility khi schema thay đổi

```sql
-- Code dựa vào thứ tự cột của SELECT * sẽ VỠ khi ai đó ALTER TABLE thêm/đổi cột
rows = query("SELECT * FROM orders");
total = rows[0][4];   -- ❌ cột thứ 5 hôm nay, mai thành cột khác
```

`SELECT *` còn khiến **view/materialized view** và các phụ thuộc dễ vỡ, và che mất việc thiếu index (vì luôn phải fetch heap nên không ai nhận ra thiếu covering index).

> [!NOTE]
> `SELECT *` không chỉ là vấn đề tốc độ — nó là vấn đề **độ bền và bảo trì**. Code rõ ràng về cột cần là code dễ đọc, dễ tối ưu, và không vỡ khi schema tiến hóa.

---

## 7. Bằng chứng: EXPLAIN so SELECT * vs cột cần

```sql
-- Bảng orders có idx_orders_user (user_id, status), và cột note TEXT lớn (TOAST)

EXPLAIN (ANALYZE, BUFFERS) SELECT user_id, status FROM orders WHERE user_id = 42;
```

```text
 Index Only Scan using idx_orders_user on orders
   Index Cond: (user_id = 42)
   Heap Fetches: 0
   Buffers: shared hit=4
 Execution Time: 0.07 ms
```

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE user_id = 42;
```

```text
 Index Scan using idx_orders_user on orders
   Index Cond: (user_id = 42)
   Buffers: shared hit=512 read=1840      ← fetch heap + TOAST
 Execution Time: 14.9 ms
```

Cùng `WHERE`, cùng index, nhưng `SELECT *`: `Index Scan` (không phải *Only*), `Buffers` cao gấp trăm lần (đọc heap + TOAST), chậm ~200 lần. Đây là toàn bộ câu trả lời dưới dạng số.

> [!TIP]
> Trong `EXPLAIN`, dấu hiệu vàng: **`Index Only Scan` + `Heap Fetches: 0`** = lý tưởng. Nếu thấy `Index Scan` (thiếu chữ "Only") trong khi bạn nghĩ đáng lẽ index-only được → kiểm tra xem có phải bạn đang chọn cột ngoài index (hoặc `SELECT *`) không.

---

## 8. Khi nào SELECT * chấp nhận được

`SELECT *` không phải tội ác tuyệt đối. Chấp nhận được khi:

| Tình huống | Vì sao OK |
|------------|-----------|
| Khám phá dữ liệu thủ công (`psql`, ad-hoc) | Không phải đường nóng, tiện |
| `EXISTS (SELECT * FROM ...)` | `*` ở đây không đọc cột nào — chỉ kiểm tra tồn tại |
| `COUNT(*)` | Không lấy cột nào, chỉ đếm dòng |
| Bảng thật sự nhỏ + cần mọi cột | Khác biệt không đáng kể |
| Bạn **thật sự** dùng mọi cột | Liệt kê hết cũng vậy (nhưng vẫn nên explicit) |

> [!NOTE]
> Lưu ý `SELECT *` trong `EXISTS(...)` và `COUNT(*)` **không** kéo theo cột nào — optimizer hiểu đó chỉ là "có dòng/đếm dòng". Đây là ngoại lệ hợp lệ, đừng nhầm với `SELECT * FROM` lấy data.

---

## 9. Câu hỏi đào sâu

> **"Vậy luôn liệt kê cột là tối ưu tuyệt đối?"**
> Gần như luôn tốt hơn cho đường nóng. Nhưng nếu bạn thật sự cần toàn bộ 30 cột và không có covering index khả thi, thì `SELECT *` và liệt kê 30 cột tương đương về I/O — khác biệt còn lại chỉ là độ rõ ràng/bền vững.

> **"`INCLUDE` trong index khác gì thêm cột vào index key?"**
> Cột trong `INCLUDE` **không** tham gia sắp xếp/seek (không phải key), chỉ được **chứa kèm** để phục vụ index-only scan. Nhẹ hơn việc đưa vào key, và không ảnh hưởng thứ tự index.

> **"MySQL InnoDB có khác không?"**
> InnoDB dùng **clustered index** (data nằm theo PK). Secondary index chứa PK; nếu query chỉ cần cột trong secondary index + PK → covering, không cần "back to clustered index" (tương tự index-only scan). `SELECT *` vẫn buộc về clustered index để lấy đủ cột.

> **"Cột TOAST có luôn bị đọc khi SELECT *?"**
> Chỉ khi giá trị đủ lớn để bị toast hóa. Giá trị nhỏ vẫn nằm inline. Nhưng bạn không kiểm soát được điều đó từ phía query — nên cách an toàn là **không chọn cột lớn nếu không cần**.

---

## 10. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 10.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  SELECT * tốn kém vì:                                          │
│   1. Phá Index-Only Scan → buộc fetch heap (Heap Fetches > 0)  │
│   2. Kéo theo TOAST (text/jsonb/bytea lớn) → I/O ẩn            │
│   3. Băng thông mạng + RAM/CPU client                          │
│   4. Sort/hash phình → dễ tràn work_mem ra đĩa                 │
│   5. ORM over-fetch, che N+1                                   │
│   6. Vỡ khi schema đổi; che việc thiếu covering index          │
│  ─────────────────────────────────────────────────────────     │
│  Chọn cột cần → mở đường covering index (INCLUDE) → index-only │
│  Ngoại lệ OK: EXISTS(SELECT *), COUNT(*), ad-hoc, bảng nhỏ     │
╰───────────────────────────────────────────────────────────────╯
```

### 10.2. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Trên đường nóng, luôn liệt kê đúng cột cần.**
> Không chỉ tiết kiệm byte — nó mở đường cho index-only scan và covering index, nơi tốc độ tăng hàng chục–trăm lần.
>
> **2. Cảnh giác với cột lớn (jsonb/text/bytea).**
> `SELECT *` lôi theo TOAST. Nếu không cần payload lớn, đừng chọn nó — đây là nguyên nhân ẩn của nhiều query "chậm vô lý".
>
> **3. Đọc `Heap Fetches` trong EXPLAIN.**
> `Index Only Scan` + `Heap Fetches: 0` là mục tiêu. Nếu query của bạn không đạt được dù đáng lẽ phải, kiểm tra xem có đang chọn thừa cột (hoặc `*`) không.

### 10.3. Quote cuối

> `SELECT *` là cách nói với database: *"cho tôi mọi thứ, tôi sẽ tự lọc sau"* — và database buộc phải đọc, toast, truyền, sắp xếp mọi thứ đó, kể cả cái bạn không bao giờ dùng. Liệt kê đúng cột cần không phải sự cầu kỳ — nó là cách bạn cho optimizer biết mục tiêu thật, để nó có thể chọn con đường ngắn nhất: chỉ chạm index, không bao giờ về heap.
