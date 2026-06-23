---
title: "Vì sao OFFSET phân trang càng sâu càng chậm? — Deep Dive"
description: "Câu hỏi phỏng vấn: LIMIT 20 OFFSET 0 nhanh, nhưng LIMIT 20 OFFSET 1000000 chậm 3 giây dù cùng index. Mổ xẻ vì sao OFFSET phải quét và vứt bỏ N dòng, keyset/seek pagination thay thế, xử lý sort phức tạp, deferred join, và các đánh đổi thực tế."
---

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [OFFSET thật sự làm gì — quét rồi vứt bỏ](#3-offset-thật-sự-làm-gì--quét-rồi-vứt-bỏ)
- [Bằng chứng: EXPLAIN cho OFFSET nông vs sâu](#4-bằng-chứng-explain-cho-offset-nông-vs-sâu)
- [Keyset / Seek Pagination — lời giải đúng](#5-keyset--seek-pagination--lời-giải-đúng)
- [Phân trang theo nhiều cột & xử lý tie-break](#6-phân-trang-theo-nhiều-cột--xử-lý-tie-break)
- [Deferred Join — khi vẫn buộc phải dùng OFFSET](#7-deferred-join--khi-vẫn-buộc-phải-dùng-offset)
- [Đánh đổi: OFFSET vs Keyset](#8-đánh-đổi-offset-vs-keyset)
- [Câu hỏi đào sâu](#9-câu-hỏi-đào-sâu)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#10-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"API phân trang của tôi dùng `LIMIT 20 OFFSET ?`. Trang 1 (`OFFSET 0`) trả về trong 5ms. Nhưng trang 50,000 (`OFFSET 1000000`) mất **3 giây** — dù vẫn chỉ lấy 20 dòng và vẫn dùng đúng index `ORDER BY created_at`. Vì sao càng phân trang sâu càng chậm? Và sửa thế nào?"*

> [!IMPORTANT]
> Mấu chốt: `OFFSET N` **không** nhảy thẳng tới dòng thứ N. Database phải **tạo ra, sắp xếp, rồi vứt bỏ** N dòng đầu tiên trước khi trả về 20 dòng bạn cần. `OFFSET 1000000` nghĩa là "tính ra 1,000,020 dòng rồi quăng đi 1,000,000 dòng" — công sức tỉ lệ thuận với **độ sâu trang**, không phải kích thước trang.

---

## 2. Câu trả lời 30 giây

> `OFFSET N LIMIT K` buộc database **duyệt qua N + K dòng** theo thứ tự `ORDER BY`, rồi **bỏ đi N dòng đầu** và chỉ trả K dòng cuối. Càng phân trang sâu (N lớn), càng nhiều dòng bị quét rồi vứt → càng chậm. Đây là độ phức tạp **O(N)** theo offset.
>
> Lời giải: **keyset pagination** (còn gọi seek method / cursor-based) — thay vì "bỏ qua N dòng", ta nhớ **giá trị cuối** của trang trước và dùng `WHERE created_at < :last_seen ORDER BY created_at DESC LIMIT 20`. Câu này dùng index để **nhảy thẳng** tới vị trí cần, không quét bỏ gì → nhanh và **ổn định** dù ở trang nào.

---

## 3. OFFSET thật sự làm gì — quét rồi vứt bỏ

```diagram
SELECT * FROM events ORDER BY created_at DESC LIMIT 20 OFFSET 1000000;

  Index idx_events_created (created_at DESC)
       │
       ▼
   Đọc entry #1 → lấy row → đếm (1)      ┐
   Đọc entry #2 → lấy row → đếm (2)      │
   ...                                   │  VỨT BỎ
   Đọc entry #1,000,000 → đếm            ┘  (1 triệu dòng!)
   ───────────────────────────────────
   Đọc entry #1,000,001 → GIỮ            ┐
   ...                                   │  TRẢ VỀ (20 dòng)
   Đọc entry #1,000,020 → GIỮ            ┘
```

Database **không có cách nào** biết dòng thứ 1,000,001 nằm ở đâu mà không đi qua 1,000,000 dòng trước đó — vì thứ tự được quyết định bởi `ORDER BY`, và để biết "dòng nào đứng thứ một-triệu-lẻ-một theo created_at" thì phải duyệt từ đầu. Kể cả khi dùng index, nó vẫn phải **đi qua từng entry** của index.

> [!NOTE]
> Đây là lý do `OFFSET` rẻ ở trang đầu và đắt dần ở trang sau. Chi phí ≈ `O(OFFSET + LIMIT)`. Trang 1: bỏ 0. Trang 50,000: bỏ 1 triệu. Cùng `LIMIT 20`, nhưng công sức chênh nhau **50,000 lần**.

---

## 4. Bằng chứng: EXPLAIN cho OFFSET nông vs sâu

### 4.1. OFFSET nông (trang đầu)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM events ORDER BY created_at DESC LIMIT 20 OFFSET 0;
```

```text
 Limit  (actual time=0.03..0.06 rows=20 loops=1)
   Buffers: shared hit=4
   ->  Index Scan Backward using idx_events_created on events
         (actual time=0.02..0.05 rows=20 loops=1)
 Execution Time: 0.09 ms
```

Chỉ chạm 20 dòng (`rows=20`), 4 page. Nhanh.

### 4.2. OFFSET sâu (trang 50,000)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM events ORDER BY created_at DESC LIMIT 20 OFFSET 1000000;
```

```text
 Limit  (actual time=2980.1..2980.2 rows=20 loops=1)
   Buffers: shared hit=210,540 read=88,901
   ->  Index Scan Backward using idx_events_created on events
         (actual time=0.03..2890.4 rows=1,000,020 loops=1)
 Execution Time: 2980.4 ms
```

Nhìn `rows=1,000,020` ở node Index Scan — nó **thực sự đọc hơn 1 triệu dòng** rồi `Limit` mới vứt đi. `Buffers` nhảy lên ~300k page. Đây là bằng chứng "quét rồi bỏ".

> [!TIP]
> Khi debug pagination chậm, nhìn vào `rows=...` ở node bên dưới `Limit`. Nếu nó lớn hơn nhiều so với `LIMIT` của bạn → bạn đang trả giá cho OFFSET.

---

## 5. Keyset / Seek Pagination — lời giải đúng

Ý tưởng: thay vì "bỏ qua N dòng", nhớ **mốc** (cursor) là giá trị của dòng cuối trang trước, rồi yêu cầu "cho tôi 20 dòng **sau mốc đó**".

```sql
-- Trang đầu
SELECT id, created_at, title
FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- giả sử dòng cuối trả về có created_at = '2026-01-15 10:00:00', id = 84213

-- Trang kế: dùng mốc của dòng cuối, KHÔNG dùng OFFSET
SELECT id, created_at, title
FROM events
WHERE (created_at, id) < ('2026-01-15 10:00:00', 84213)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

```diagram
Keyset: dùng index để NHẢY THẲNG tới mốc, không quét bỏ:

  Index (created_at DESC, id DESC)
       │
       ▼  WHERE (created_at,id) < (mốc)  → tìm vị trí mốc bằng B-Tree (log n)
   [mốc] → đọc 20 entry kế tiếp → trả về
   (không đọc, không vứt 1 triệu dòng nào)
```

`EXPLAIN` cho keyset ở "trang 50,000" trông **giống hệt** trang đầu — vẫn chỉ `rows=20`, vài page, ~0.1ms. **Hiệu năng không đổi dù ở trang nào** (O(log n) tìm mốc + O(LIMIT) đọc).

> [!IMPORTANT]
> Điều kiện để keyset hoạt động: cột(s) trong `ORDER BY` phải có **index** khớp thứ tự, và phải có một **tie-breaker duy nhất** (thường là PK) để thứ tự xác định và không bỏ sót/lặp dòng khi có giá trị trùng. Dùng so sánh **row-values** `(a, b) < (:a, :b)` để diễn đạt đúng "sau mốc" trên nhiều cột.

---

## 6. Phân trang theo nhiều cột & xử lý tie-break

Nếu sắp theo cột **không duy nhất** (vd `created_at` có thể trùng), keyset cần thêm tie-breaker để không nhảy cóc:

```sql
-- ❌ Sai: created_at trùng nhau → có thể bỏ sót hoặc lặp dòng giữa các trang
WHERE created_at < :last_created_at
ORDER BY created_at DESC LIMIT 20;

-- ✅ Đúng: thêm id làm tie-breaker, so sánh row-value
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC LIMIT 20;
```

Index hỗ trợ phải khớp **đúng thứ tự và hướng** sort:

```sql
CREATE INDEX idx_events_created_id ON events (created_at DESC, id DESC);
```

> [!WARNING]
> So sánh row-value `(a, b) < (:a, :b)` **khác** với `a < :a AND b < :b`. Cái sau **sai** (loại nhầm các dòng cùng `a` nhưng `b` lớn hơn). Nếu DB không hỗ trợ row-value comparison, viết tay: `a < :a OR (a = :a AND b < :b)`.

---

## 7. Deferred Join — khi vẫn buộc phải dùng OFFSET

Đôi khi bạn **không thể** bỏ OFFSET (vd UI cho nhảy tới trang bất kỳ, hoặc framework ép). Một mẹo giảm đau: **deferred join** — phân trang trên một tập **chỉ chứa id** (nhẹ, dễ index-only), rồi mới join lấy đủ cột.

```sql
-- ❌ OFFSET trên bảng đầy đủ: mỗi dòng bị quét đều phải đọc HEAP (đắt)
SELECT * FROM events
ORDER BY created_at DESC LIMIT 20 OFFSET 1000000;

-- ✅ Deferred join: OFFSET trên index-only (chỉ id), rồi join lấy data
SELECT e.*
FROM events e
JOIN (
    SELECT id FROM events
    ORDER BY created_at DESC
    LIMIT 20 OFFSET 1000000
) AS page ON page.id = e.id
ORDER BY e.created_at DESC;
```

Subquery chỉ đọc index (nếu `(created_at, id)` covering) nên việc "quét rồi vứt" 1 triệu dòng rẻ hơn nhiều (không chạm heap). Chỉ 20 dòng cuối mới join về bảng đầy đủ. Vẫn O(N) nhưng hằng số nhỏ hơn nhiều.

> [!NOTE]
> Deferred join **giảm nhẹ**, không **xóa bỏ** vấn đề O(N) của OFFSET. Nó hữu ích như giải pháp tình thế. Lời giải triệt để vẫn là keyset.

---

## 8. Đánh đổi: OFFSET vs Keyset

| Tiêu chí | OFFSET | Keyset / Seek |
|----------|--------|---------------|
| Hiệu năng trang sâu | ❌ Chậm dần O(N) | ✅ Ổn định O(log n) |
| Nhảy tới trang bất kỳ ("trang 500") | ✅ Dễ | ❌ Khó (chỉ next/prev tự nhiên) |
| Hiển thị "Trang X / Y" | ✅ Được | ⚠️ Cần đếm riêng (xem bài count) |
| Ổn định khi data thay đổi giữa các trang | ❌ Lệch/lặp dòng khi có insert/delete | ✅ Mốc cố định, ít lệch |
| Độ phức tạp triển khai | ✅ Đơn giản | ⚠️ Cần cursor + index khớp |
| Hợp với | Trang nông, admin tool | Infinite scroll, API, feed, export lớn |

> [!IMPORTANT]
> Không có "luôn dùng keyset". OFFSET vẫn ổn cho **trang nông** (vài chục trang đầu) và khi cần **nhảy tới trang tùy ý**. Keyset thắng tuyệt đối cho **cuộn vô hạn / feed / duyệt sâu / export**. Nhiều hệ thống dùng **cả hai**: OFFSET cho UI bảng admin, keyset cho API mobile/feed.

---

## 9. Câu hỏi đào sâu

> **"Vì sao OFFSET còn gây kết quả KHÔNG NHẤT QUÁN?"**
> Giữa lúc bạn xem trang 2 và trang 3, nếu có dòng mới được insert ở đầu, mọi dòng dịch xuống → trang 3 sẽ **lặp lại** một dòng đã thấy ở trang 2 (hoặc bỏ sót). Keyset dùng mốc cố định nên không bị.

> **"Keyset có dùng được với sort phức tạp (nhiều cột, hướng khác nhau)?"**
> Được nhưng khó hơn: cần index khớp đúng tổ hợp hướng, và biểu thức WHERE row-value phải khớp. Với `ORDER BY a ASC, b DESC` thì điều kiện seek phức tạp hơn — cân nhắc chuẩn hóa hướng sort.

> **"Cursor-based pagination của GraphQL/Relay là gì?"**
> Chính là keyset được đóng gói: "cursor" thường là **mốc đã mã hóa base64** (vd `created_at + id`). `after: <cursor>` → dịch ra `WHERE (created_at,id) < (...)`.

> **"Đếm tổng số trang thì sao?"**
> Đắt trên bảng lớn (xem bài "count(*) chậm"). Thực tế: dùng ước lượng, hoặc bỏ tổng số trang và chỉ có "Tải thêm".

---

## 10. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 10.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  OFFSET N LIMIT K  →  quét N+K dòng, VỨT N → O(N) theo offset  │
│     → trang càng sâu càng chậm; còn gây lệch/lặp khi data đổi   │
│  ─────────────────────────────────────────────────────────     │
│  KEYSET:  WHERE (sort_cols, id) < (mốc trang trước)            │
│           ORDER BY sort_cols DESC, id DESC LIMIT K              │
│     → nhảy thẳng bằng index, O(log n), ổn định mọi trang        │
│     → cần index khớp thứ tự+hướng + tie-breaker duy nhất        │
│  ─────────────────────────────────────────────────────────     │
│  Vẫn cần OFFSET? → Deferred join (OFFSET trên id-only rồi join) │
╰───────────────────────────────────────────────────────────────╯
```

### 10.2. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Mặc định dùng keyset cho API/feed/cuộn vô hạn.**
> Không bao giờ để `OFFSET` lớn trên đường đi nóng. Keyset giữ hiệu năng không đổi dù trang thứ mấy.
>
> **2. Keyset cần index khớp + tie-breaker duy nhất.**
> `ORDER BY` cột(s) + PK, index `(cột..., id)` đúng hướng, và so sánh row-value `(a,id) < (:a,:id)` — đừng viết `a < :a AND id < :id`.
>
> **3. OFFSET không sai — chỉ sai chỗ.**
> Dùng OFFSET cho trang nông / admin / cần nhảy trang tùy ý. Đừng dùng nó cho duyệt sâu hay export hàng triệu dòng.

### 10.3. Quote cuối

> `OFFSET` chậm không phải vì database lười — mà vì bạn đang yêu cầu nó "đi tới dòng thứ một triệu" trong một danh sách mà thứ tự chỉ tồn tại lúc query chạy. Keyset đổi câu hỏi từ *"bỏ qua bao nhiêu dòng"* sang *"bắt đầu từ đâu"* — và đó là câu hỏi mà index trả lời được trong tích tắc.
