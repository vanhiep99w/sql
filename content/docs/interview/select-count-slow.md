---
title: "Vì sao SELECT count(*) lại chậm?"
description: "Câu hỏi phỏng vấn kinh điển: vì sao đếm số dòng một bảng trong PostgreSQL lại chậm dù có index, trong khi MySQL MyISAM trả về tức thì? Mổ xẻ MVCC visibility, heap scan, visibility map, index-only scan, vì sao DB không lưu sẵn row count, và các cách đếm nhanh (ước lượng, bảng đếm, trigger)."
---

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [Vì sao Postgres KHÔNG biết sẵn số dòng](#3-vì-sao-postgres-không-biết-sẵn-số-dòng)
- [count(*) phải làm gì ở tầng vật lý](#4-count-phải-làm-gì-ở-tầng-vật-lý)
- [Vì sao MySQL MyISAM "đếm tức thì" còn InnoDB thì không](#5-vì-sao-mysql-myisam-đếm-tức-thì-còn-innodb-thì-không)
- [Index-only scan & Visibility Map — vũ khí tăng tốc count](#6-index-only-scan--visibility-map--vũ-khí-tăng-tốc-count)
- [count(*) vs count(1) vs count(col) — có khác nhau không?](#7-count-vs-count1-vs-countcol--có-khác-nhau-không)
- [Các cách đếm nhanh trong thực tế](#8-các-cách-đếm-nhanh-trong-thực-tế)
- [Câu hỏi đào sâu](#9-câu-hỏi-đào-sâu)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#10-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi chạy `SELECT count(*) FROM orders` trên bảng 50 triệu dòng trong PostgreSQL — mất 8 giây. Bảng có primary key, có nhiều index. Vì sao chỉ **đếm số dòng** mà lại chậm thế? Trong khi ngày xưa dùng MySQL MyISAM thì `count(*)` trả về ngay lập tức?"*

Câu hỏi này kiểm tra xem bạn có hiểu **MVCC** và **cách dữ liệu được lưu vật lý** hay không — hay chỉ nghĩ "đếm thì phải nhanh chứ".

> [!IMPORTANT]
> `count(*)` chậm **không** phải vì Postgres kém. Nó chậm vì trong một database **MVCC**, **không tồn tại một con số "số dòng" duy nhất, đúng cho mọi người** — mỗi transaction nhìn thấy một số lượng dòng *khác nhau* tùy snapshot của nó. Vì vậy đếm chính xác buộc phải **duyệt và kiểm tra visibility từng dòng**.

---

## 2. Câu trả lời 30 giây

> Postgres dùng MVCC: mỗi dòng có nhiều phiên bản (tuple), và một tuple chỉ "visible" với một số transaction tùy `xmin`/`xmax`. Không có một row count toàn cục đúng cho mọi snapshot, nên `count(*)` phải **duyệt qua các tuple** và kiểm tra **tuple nào visible với tôi**. Trên bảng lớn, đây là một lần đọc gần như toàn bộ bảng (hoặc một index) → tốn I/O → chậm.
>
> MySQL **MyISAM** lưu sẵn số dòng trong metadata (vì nó không có MVCC giao dịch) nên `count(*)` không điều kiện trả về tức thì. **InnoDB** (có MVCC) thì giống Postgres — phải scan.
>
> Tăng tốc: dùng **index-only scan** (đếm trên index nhỏ thay vì heap, kết hợp visibility map), dùng **ước lượng** từ `pg_class.reltuples` nếu chấp nhận sai số, hoặc duy trì **bảng đếm/summary** cập nhật bằng trigger.

---

## 3. Vì sao Postgres KHÔNG biết sẵn số dòng

Trong một database không giao dịch, lưu một biến `row_count` rồi cộng/trừ mỗi lần insert/delete là đơn giản. Nhưng MVCC phá vỡ ý tưởng đó.

```diagram
Cùng một bảng orders, tại cùng một thời điểm:

  Transaction A (bắt đầu lúc T1):
     thấy 50,000,000 dòng

  Transaction B (bắt đầu lúc T2, sau khi A xóa 1 triệu nhưng chưa commit):
     vẫn thấy 50,000,000 dòng (không thấy thay đổi chưa commit của A)

  Transaction C (bắt đầu sau khi A commit + có insert mới):
     thấy 49,200,000 dòng
```

> [!NOTE]
> "Số dòng của bảng" **không phải** một con số tuyệt đối — nó **phụ thuộc snapshot** của transaction đang hỏi. Một biến đếm toàn cục sẽ sai với ít nhất một trong các transaction trên. Vì thế Postgres **không** giữ biến đếm, mà tính lại theo snapshot mỗi lần — và muốn chính xác thì phải kiểm tra từng tuple.

Nếu Postgres muốn duy trì counter chính xác cho mọi snapshot, nó sẽ phải khóa/serialize mọi insert/delete quanh một biến chung → giết chết concurrency. Đó là cái giá quá đắt cho một con số mà phần lớn thời gian ta không cần tuyệt đối chính xác.

---

## 4. count(*) phải làm gì ở tầng vật lý

```diagram
SELECT count(*) FROM orders;
─────────────────────────────
  → Chọn đường rẻ nhất để "chạm" mọi dòng:
      • Seq Scan toàn heap (đọc mọi page), HOẶC
      • Index-only scan trên index nhỏ nhất (nếu được)
  → Với MỖI tuple gặp: kiểm tra "có visible với snapshot của tôi không?"
      (xét xmin/xmax + commit status + visibility map)
  → Đếm các tuple visible
  → Trả về 1 con số
```

`EXPLAIN (ANALYZE, BUFFERS)` điển hình:

```text
 Finalize Aggregate  (actual time=8021.5..8021.5 rows=1 loops=1)
   ->  Gather  ...
         ->  Partial Aggregate  ...
               ->  Parallel Seq Scan on orders
                     (actual time=0.02..6900.1 rows=16,666,667 loops=3)
                     Buffers: shared read=410,256
 Execution Time: 8043.2 ms
```

Mấu chốt: `Seq Scan on orders` + `Buffers: shared read=410,256` — nó **đọc gần như toàn bộ bảng**. Đây là một query I/O-bound: chậm tỉ lệ thuận với **kích thước bảng**, không phải số dòng trả về (luôn là 1).

> [!TIP]
> Vì `count(*)` thường phải chạm toàn bộ data, nó cũng là nạn nhân kinh điển của **cold cache** (xem bài "Vì sao query đầu chậm"). Lần đầu đếm bảng lớn cực chậm vì đọc đĩa; lần sau nhanh hơn vì page đã nóng — nhưng vẫn phải scan.

---

## 5. Vì sao MySQL MyISAM "đếm tức thì" còn InnoDB thì không

| Engine | `count(*)` không điều kiện | Vì sao |
|--------|---------------------------|--------|
| **MyISAM** | Tức thì (O(1)) | Không MVCC, không transaction → lưu sẵn row count trong metadata bảng |
| **InnoDB** | Phải scan (O(n)) | Có MVCC như Postgres → cần kiểm tra visibility từng dòng |
| **PostgreSQL** | Phải scan (O(n)) | MVCC → như InnoDB |

> [!IMPORTANT]
> Đây là một **đánh đổi**, không phải MyISAM "giỏi hơn". MyISAM đếm nhanh **vì nó hy sinh giao dịch + concurrency** — không có MVCC nên chỉ cần một con số. Khi cần ACID, đồng thời cao, thì cái giá phải trả là `count(*)` không còn O(1). InnoDB và Postgres chọn ACID, nên chọn scan.

Lưu ý: ngay cả MyISAM cũng chỉ nhanh với `count(*)` **không có WHERE**. Thêm `WHERE` là phải scan như mọi engine.

---

## 6. Index-only scan & Visibility Map — vũ khí tăng tốc count

Postgres **có thể** đếm nhanh hơn nhiều nhờ **index-only scan** — không cần đọc heap, chỉ đọc một index nhỏ.

### 6.1. Vấn đề: index không tự biết tuple có visible không

Index entry trỏ về heap tuple, nhưng **bản thân index không lưu thông tin MVCC** (`xmin`/`xmax`). Bình thường, sau khi tìm thấy trong index, Postgres vẫn phải **quay về heap** để kiểm tra visibility → mất luôn lợi thế.

### 6.2. Lời giải: Visibility Map (VM)

Postgres giữ một **visibility map** — một bitmap nhỏ đánh dấu những heap page mà **mọi tuple trong page đều visible với mọi transaction** ("all-visible"). Nếu page đã all-visible, index-only scan **không cần** quay về heap.

```diagram
Index-only scan đếm:
   với mỗi entry index → page heap tương ứng có "all-visible" trong VM?
     ├─ CÓ  → tin index, không đọc heap  → nhanh
     └─ KHÔNG → phải đọc heap kiểm tra    → chậm phần này
```

```sql
-- Tạo điều kiện cho index-only scan + VM hiệu quả:
VACUUM (ANALYZE) orders;   -- VACUUM cập nhật visibility map

-- Đếm trên cột NOT NULL có index (vd PK) → optimizer có thể index-only scan
EXPLAIN (ANALYZE) SELECT count(*) FROM orders;
```

```text
 Aggregate ...
   ->  Index Only Scan using orders_pkey on orders
         Heap Fetches: 0           ← 0 lần quay về heap = lý tưởng
 Execution Time: 1120.4 ms          ← nhanh hơn seq scan nhiều
```

> [!WARNING]
> `Heap Fetches` cao = VM chưa cập nhật (vừa có nhiều ghi, chưa VACUUM) → index-only scan vẫn phải đọc heap → không nhanh hơn bao nhiêu. **VACUUM thường xuyên** (hoặc để autovacuum làm việc) là điều kiện để count nhanh.

---

## 7. count(*) vs count(1) vs count(col) — có khác nhau không?

Một hiểu lầm phổ biến: *"`count(1)` nhanh hơn `count(*)`"*. **Sai.**

| Biểu thức | Ý nghĩa | Hiệu năng |
|-----------|---------|-----------|
| `count(*)` | Đếm số **dòng** | Nhanh nhất (chuẩn) |
| `count(1)` | Đếm số dòng (1 luôn khác NULL) | **Giống hệt** `count(*)` |
| `count(col)` | Đếm số dòng có `col` **NOT NULL** | Có thể chậm hơn (phải đọc/kiểm tra cột đó) |

> [!NOTE]
> `count(*)` và `count(1)` được optimizer xử lý **y hệt** — không có chuyện cái nào nhanh hơn. `count(col)` thì **khác về ngữ nghĩa**: nó bỏ qua dòng có `col IS NULL`, và buộc phải đọc giá trị cột đó nên có thể chậm hơn (đặc biệt nếu cột không nằm trong index đang dùng). Dùng `count(*)` khi muốn "số dòng", dùng `count(col)` chỉ khi thật sự muốn "số dòng có cột đó khác NULL".

---

## 8. Các cách đếm nhanh trong thực tế

Tùy mức độ chính xác bạn cần:

### 8.1. Ước lượng (đủ cho dashboard, phân trang "khoảng N kết quả")

```sql
-- Lấy ước lượng từ statistics — TỨC THÌ, không scan
SELECT reltuples::bigint AS approx_rows
FROM pg_class
WHERE relname = 'orders';

-- Ước lượng số dòng khớp một query bất kỳ (đọc từ planner)
EXPLAIN SELECT * FROM orders WHERE status = 'paid';
-- → đọc "rows=..." trong plan
```

`reltuples` được autovacuum/analyze cập nhật → có thể lệch chút sau nhiều ghi, nhưng cho dashboard thì quá đủ và **nhanh gấp hàng nghìn lần**.

### 8.2. Bảng đếm duy trì bằng trigger (cần chính xác + đọc nhiều)

```sql
CREATE TABLE counters (table_name text PRIMARY KEY, n bigint);
INSERT INTO counters VALUES ('orders', (SELECT count(*) FROM orders));

CREATE FUNCTION bump_orders_counter() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN UPDATE counters SET n = n + 1 WHERE table_name='orders';
  ELSIF TG_OP = 'DELETE' THEN UPDATE counters SET n = n - 1 WHERE table_name='orders';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_count
AFTER INSERT OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION bump_orders_counter();
```

> [!WARNING]
> Bảng đếm bằng trigger **chính xác nhưng tạo điểm tranh chấp (hot row)**: mọi insert/delete cùng update **một dòng** trong `counters` → contention cao khi ghi đồng thời nhiều. Giải pháp giảm contention: chia counter thành nhiều shard (nhiều dòng) rồi cộng lại, hoặc dùng bảng "delta" + gộp định kỳ.

### 8.3. count(*) thật nhưng có index hỗ trợ

Nếu cần chính xác mà chấp nhận chậm hơn ước lượng: đảm bảo có **index nhỏ** trên cột NOT NULL + VACUUM đều để index-only scan hoạt động (mục 6).

### 8.4. Bảng so sánh

| Cách | Độ chính xác | Tốc độ | Khi nào dùng |
|------|:-:|:-:|--------------|
| `count(*)` (seq scan) | Tuyệt đối | Chậm | Cần chính xác, ít gọi |
| `count(*)` (index-only scan) | Tuyệt đối | Trung bình | Cần chính xác + VACUUM đều |
| `pg_class.reltuples` | Ước lượng | Tức thì | Dashboard, "khoảng N" |
| `EXPLAIN` rows | Ước lượng (có WHERE) | Tức thì | Ước lượng số khớp filter |
| Bảng đếm + trigger | Tuyệt đối | Đọc tức thì | Đọc rất nhiều, ghi vừa |

---

## 9. Câu hỏi đào sâu

> **"`count(*)` có WHERE thì sao?"**
> Phải đánh giá điều kiện trên từng dòng. Nếu WHERE có index chọn lọc tốt → đếm trên tập nhỏ → nhanh. Nếu WHERE không selective → gần như scan toàn bảng → chậm như count không điều kiện.

> **"Vì sao `EXISTS` / `LIMIT 1` nhanh hơn nhiều?"**
> `SELECT EXISTS(SELECT 1 FROM orders WHERE ...)` dừng **ngay khi tìm thấy dòng đầu tiên**, không đếm hết. Nếu bạn chỉ cần biết "có hay không" thì đừng dùng `count(*) > 0` — dùng `EXISTS`.

> **"Đếm nhanh khi phân trang ('Page 5 of 1,234')?"**
> Hiển thị tổng số trang chính xác cho bảng lớn rất đắt. Thực tế: dùng ước lượng ("khoảng 1,200 trang"), hoặc bỏ tổng số trang và dùng keyset pagination (xem bài "OFFSET pagination").

> **"`SELECT count(*)` chạy song song được không?"**
> Có — Postgres hỗ trợ **parallel seq scan** cho count trên bảng lớn (thấy `Parallel Seq Scan`/`Gather` trong plan). Vẫn phải đọc hết data, chỉ là chia cho nhiều worker.

---

## 10. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 10.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  count(*) chậm vì: MVCC → không có row count toàn cục          │
│                    → phải kiểm tra visibility từng tuple        │
│                    → gần như scan toàn bảng (I/O-bound)         │
│  ─────────────────────────────────────────────────────────     │
│  Tăng tốc:                                                     │
│   • Chấp nhận ước lượng → pg_class.reltuples (tức thì)          │
│   • Cần chính xác → index-only scan + VACUUM (Heap Fetches=0)   │
│   • Đọc nhiều + chính xác → bảng đếm + trigger (coi chừng hot row)│
│   • Chỉ cần "có hay không" → EXISTS, đừng count > 0             │
│  ─────────────────────────────────────────────────────────     │
│  count(*) == count(1)  ≠  count(col)  (col bỏ NULL)            │
╰───────────────────────────────────────────────────────────────╯
```

### 10.2. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Hỏi "có cần chính xác tuyệt đối không?" trước khi đếm.**
> 90% trường hợp (dashboard, "khoảng N kết quả") chỉ cần ước lượng → dùng `reltuples`, nhanh gấp hàng nghìn lần và không scan.
>
> **2. Đừng dùng `count(*) > 0` để kiểm tra tồn tại.**
> Dùng `EXISTS` — nó dừng ở dòng đầu tiên thay vì đếm hết.
>
> **3. Nếu cần count chính xác thường xuyên trên bảng lớn → duy trì counter, đừng đếm lại.**
> Bảng đếm bằng trigger (chú ý contention) hoặc summary table cập nhật định kỳ. Đếm lại 50 triệu dòng mỗi lần load trang là lãng phí.

### 10.3. Quote cuối

> `count(*)` chậm không phải vì database yếu — mà vì bạn đang hỏi một câu **không có câu trả lời duy nhất** trong thế giới MVCC: "bảng có bao nhiêu dòng?" thật ra là "bảng có bao nhiêu dòng **mà tôi được phép thấy ngay lúc này?**". Hiểu điều đó, bạn sẽ ngừng đếm khi không cần, và đếm thông minh khi thật sự cần.
