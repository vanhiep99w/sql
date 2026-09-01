---
title: "Query nhanh ở staging nhưng chậm ở production?"
description: "Câu hỏi phỏng vấn: cùng một query, cùng schema, nhanh ở staging nhưng chậm ở production. Mổ xẻ khác biệt data distribution, statistics, plan flip, parameter sniffing/generic plan, kích thước data & cache, cấu hình khác nhau, concurrency/lock, và cách tái hiện + chẩn đoán."
---

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [Nguyên nhân 1: Kích thước & phân bố dữ liệu khác nhau](#3-nguyên-nhân-1-kích-thước--phân-bố-dữ-liệu-khác-nhau)
- [Nguyên nhân 2: Statistics khác → plan flip](#4-nguyên-nhân-2-statistics-khác--plan-flip)
- [Nguyên nhân 3: Parameter sniffing & generic vs custom plan](#5-nguyên-nhân-3-parameter-sniffing--generic-vs-custom-plan)
- [Nguyên nhân 4: Cache & phần cứng — cold vs warm, RAM, đĩa](#6-nguyên-nhân-4-cache--phần-cứng--cold-vs-warm-ram-đĩa)
- [Nguyên nhân 5: Cấu hình DB khác nhau](#7-nguyên-nhân-5-cấu-hình-db-khác-nhau)
- [Nguyên nhân 6: Concurrency, lock & tải thật](#8-nguyên-nhân-6-concurrency-lock--tải-thật)
- [Nguyên nhân 7: Bloat & maintenance](#9-nguyên-nhân-7-bloat--maintenance)
- [Quy trình tái hiện & chẩn đoán](#10-quy-trình-tái-hiện--chẩn-đoán)
- [Câu hỏi đào sâu](#11-câu-hỏi-đào-sâu)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#12-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi viết một query, test ở staging chạy 20ms, ai cũng duyệt. Lên production nó chạy **6 giây** và làm nghẽn hệ thống. Cùng một câu SQL, cùng schema, cùng version Postgres. Vì sao? Và làm sao tôi đáng lẽ phải phát hiện sớm?"*

> [!IMPORTANT]
> Cùng một câu SQL **không** đảm bảo cùng một **execution plan** hay cùng một **chi phí thực thi**. Plan phụ thuộc **dữ liệu** (kích thước, phân bố, statistics), và chi phí thực thi phụ thuộc **môi trường** (RAM, cache, đĩa, cấu hình, tải đồng thời). Staging và production khác nhau ở gần như tất cả những thứ đó — nên "nhanh ở staging" gần như **không nói lên gì** về production.

---

## 2. Câu trả lời 30 giây

> Vì staging và production khác nhau ở những thứ quyết định hiệu năng:
> - **Data**: staging ít dòng, phân bố đều; production nhiều dòng, lệch (skew) → optimizer chọn **plan khác** (plan flip), và chi phí thật khác hẳn.
> - **Statistics**: thống kê ở hai nơi khác nhau → ước lượng selectivity khác → plan khác.
> - **Parameter sniffing / generic plan**: prepared statement ở production có thể dùng generic plan tệ cho giá trị lệch.
> - **Cache & phần cứng**: production cache bị nhiều query khác cạnh tranh; data lớn hơn RAM → cache miss; đĩa/cấu hình khác.
> - **Concurrency/lock**: production có tải thật, lock contention, autovacuum chạy nền.
> - **Bloat**: bảng production phình do update/delete lâu ngày.
>
> Phòng tránh: test trên **bản sao production** (kích thước + phân bố thật), luôn `EXPLAIN (ANALYZE, BUFFERS)` ở môi trường giống prod, và so plan giữa hai nơi.

---

## 3. Nguyên nhân 1: Kích thước & phân bố dữ liệu khác nhau

Đây là nguyên nhân số một và sâu nhất.

```diagram
STAGING:  orders có 10,000 dòng, status phân bố ĐỀU
   WHERE status='paid' → khớp ~2,500 (25%)
   → optimizer: "ít dòng, bảng nhỏ" → plan đơn giản, nhanh

PRODUCTION: orders có 80,000,000 dòng, status LỆCH
   WHERE status='paid' → khớp 60,000,000 (75%)
   → cùng query nhưng khớp 60 triệu dòng → seq scan khổng lồ / sort tràn đĩa
   → 6 giây
```

Hai khác biệt ẩn:
- **Quy mô**: thuật toán O(n) hoặc O(n log n) ở 10k dòng là tức thì; ở 80 triệu dòng là vài giây. Một nested loop join "nhanh" ở staging có thể thành thảm họa ở production.
- **Phân bố (skew)**: ở staging mọi giá trị đều phổ biến như nhau; ở production có giá trị chiếm 90%, có giá trị hiếm. Selectivity thật khác hẳn → query lọc theo giá trị phổ biến lôi về lượng dòng khổng lồ.

> [!WARNING]
> Test trên data "nhỏ và đều" là cái bẫy nguy hiểm nhất. Nó **giấu** cả hai vấn đề: scale và skew. Một query đụng phải "hot user" có 5 triệu đơn (trong khi user trung bình có 10 đơn) sẽ không bao giờ lộ ra ở staging nơi mọi user đều có 10 đơn.

---

## 4. Nguyên nhân 2: Statistics khác → plan flip

Optimizer chọn plan dựa trên **statistics** (`pg_statistic`). Staging và production có thống kê **khác nhau** → có thể sinh **plan hoàn toàn khác** cho cùng câu SQL.

```diagram
STAGING stats:  "status='paid' ước lượng 2,500 dòng"
   → optimizer chọn Index Scan → nhanh

PROD stats:     "status='paid' ước lượng 60,000,000 dòng"
   → optimizer chọn Seq Scan + Hash Join → khác plan hoàn toàn
```

Hiện tượng "cùng SQL, plan khác giữa hai môi trường" gọi là **plan flip**. Nó cũng xảy ra **ngay trên production** theo thời gian khi data đổi và statistics cập nhật — query đang nhanh bỗng chậm sau một lần autovacuum/analyze đổi ước lượng.

> [!TIP]
> Cách kiểm chứng: chạy `EXPLAIN` (không cần ANALYZE) ở **cả hai** môi trường và **so sánh plan**. Nếu plan khác nhau → đây là plan flip do statistics/data. Đừng chỉ nhìn thời gian — nhìn **hình dạng plan**.

---

## 5. Nguyên nhân 3: Parameter sniffing & generic vs custom plan

Với **prepared statement** (phổ biến khi dùng ORM/driver), Postgres sau ~5 lần execute có thể chuyển sang **generic plan** — một plan **không phụ thuộc giá trị tham số cụ thể**.

```diagram
Query: SELECT * FROM orders WHERE user_id = $1

  Custom plan (theo từng giá trị): tốt cho cả user thường lẫn hot user
  Generic plan (1 plan cho mọi $1): dựa trên selectivity TRUNG BÌNH

  → Nếu $1 = hot_user (5 triệu đơn) nhưng generic plan giả định
    "user trung bình 10 đơn" → chọn Index Scan → 5 triệu random fetch → CHẬM
```

Ở staging (ít gọi, data đều), generic plan vô hại. Ở production (gọi nhiều, có hot value), generic plan có thể tệ thảm hại với một số giá trị — gọi là **parameter sniffing problem** (thuật ngữ SQL Server) hoặc generic plan issue (Postgres).

```sql
-- Postgres: ép luôn dùng custom plan (đánh giá lại mỗi lần) nếu cần
SET plan_cache_mode = force_custom_plan;
```

> [!NOTE]
> Đây là lý do một query "lúc nhanh lúc chậm **ngay trên production**" tùy theo tham số. Cùng câu SQL, cùng môi trường, nhưng `user_id` khác nhau → trúng generic plan tệ. Staging hiếm khi tái hiện vì không có phân bố lệch.

---

## 6. Nguyên nhân 4: Cache & phần cứng — cold vs warm, RAM, đĩa

```diagram
STAGING:  toàn bộ bảng 10k dòng nằm gọn trong RAM → mọi truy cập là cache HIT
PRODUCTION: bảng 80M dòng > RAM → cache MISS thường xuyên → đọc đĩa
```

- **Working set vs RAM**: nếu data nóng vượt `shared_buffers` + RAM → page liên tục bị evict → cache miss → đọc đĩa (xem bài "query đầu chậm / cold cache").
- **Phần cứng**: staging có thể chạy trên SSD nhanh/CPU mạnh, production trên storage mạng (EBS) độ trễ cao hơn, hoặc ngược lại.
- **Cold start**: production vừa failover/restart → cache lạnh → query đầu cực chậm.

> [!IMPORTANT]
> Một query chạm 2,000 page: ở staging tất cả trong RAM → 0.5ms; ở production phải đọc đĩa mạng → có thể vài giây. **Cùng plan, cùng số page** — khác nhau chỉ ở data có nằm trong RAM không. Staging "nhanh" thường chỉ vì **mọi thứ vừa RAM**.

---

## 7. Nguyên nhân 5: Cấu hình DB khác nhau

Staging thường dùng cấu hình mặc định hoặc nhỏ; production được tune (hoặc ngược lại). Các tham số ảnh hưởng plan & tốc độ:

| Tham số | Ảnh hưởng |
|---------|-----------|
| `shared_buffers` | Kích thước buffer pool → tỉ lệ cache hit |
| `work_mem` | Bộ nhớ cho sort/hash; thấp → tràn đĩa (external sort) |
| `effective_cache_size` | Gợi ý optimizer về RAM khả dụng → ảnh hưởng chọn index scan |
| `random_page_cost` | Cao → né index; thấp (SSD) → ưu index |
| `max_parallel_workers_per_gather` | Có parallel scan hay không |
| `jit` | Bật JIT → warmup cho query nặng |

> [!WARNING]
> `work_mem` là thủ phạm âm thầm: staging có thể đủ RAM để sort trong bộ nhớ (`Sort Method: quicksort`), production với cùng `work_mem` nhưng data lớn hơn → `Sort Method: external merge Disk: ...` → chậm gấp nhiều lần. So `Sort Method` trong `EXPLAIN ANALYZE` giữa hai nơi.

---

## 8. Nguyên nhân 6: Concurrency, lock & tải thật

Staging thường chỉ có **bạn** chạy query. Production có hàng nghìn query đồng thời:

- **Lock contention**: query của bạn chờ lock từ transaction khác (vd một `UPDATE` dài, một migration, một `VACUUM FULL`).
- **Tài nguyên chia sẻ**: CPU, I/O bandwidth, buffer pool bị nhiều query khác giành → query của bạn chậm dù plan tốt.
- **Autovacuum/analyze chạy nền**: chiếm I/O đúng lúc cao điểm.
- **Connection pool cạn**: chờ lấy connection cũng tính vào "chậm".

```diagram
EXPLAIN ANALYZE cho thấy Execution Time chỉ 50ms,
nhưng người dùng thấy 6 giây
   → thời gian KHÔNG nằm trong execution: nằm ở chờ lock / chờ connection / hàng đợi
   → kiểm tra pg_stat_activity, wait events, lock
```

> [!TIP]
> Nếu `EXPLAIN (ANALYZE)` chạy nhanh khi bạn tự chạy, nhưng app báo chậm → vấn đề không nằm ở plan mà ở **tải đồng thời / lock / pool**. Soi `pg_stat_activity`, `pg_locks`, và wait events thay vì tiếp tục tối ưu query.

---

## 9. Nguyên nhân 7: Bloat & maintenance

Bảng/index production phình theo thời gian do MVCC dead tuple (update/delete nhiều) — staging mới tinh thì không.

```diagram
STAGING:  bảng vừa tạo, không bloat → 1,000 page
PRODUCTION: cùng số dòng "sống" nhưng nhiều dead tuple → 4,000 page
   → seq scan đọc gấp 4 lần số page → chậm
   → index cũng bloat → index scan chậm
```

Liên hệ bài "INSERT/UPDATE/DELETE & Index" và VACUUM: thiếu vacuum → bloat → mọi thứ chậm dần. Một query chỉ chậm ở production có thể đơn giản vì bảng đó đã bloat 4x.

---

## 10. Quy trình tái hiện & chẩn đoán

```diagram
╭──────────────────────────────────────────────────────────────╮
│ B1. Lấy EXPLAIN (ANALYZE, BUFFERS) Ở PRODUCTION (an toàn:    │
│     dùng read-replica hoặc transaction read-only)            │
│                                                              │
│ B2. So PLAN production vs staging:                           │
│     • Plan KHÁC nhau → plan flip (data/statistics) → mục 3,4 │
│     • Plan GIỐNG nhưng prod chậm → môi trường (cache, IO,    │
│       lock, work_mem) → mục 6,7,8                            │
│                                                              │
│ B3. So rows ước lượng vs actual ở prod:                      │
│     • Lệch → ANALYZE / tăng statistics target                │
│                                                              │
│ B4. Soi dấu hiệu môi trường trong plan:                      │
│     • Buffers read cao → cache miss (mục 6)                  │
│     • Sort Method: external → work_mem thấp (mục 7)          │
│     • Heap Fetches cao → VM/bloat (mục 9)                    │
│                                                              │
│ B5. Execution Time nhanh nhưng app chậm?                     │
│     • → lock/concurrency/pool (pg_stat_activity) (mục 8)     │
│                                                              │
│ B6. Tham số ($1) cụ thể mới chậm? → parameter sniffing (5)   │
╰──────────────────────────────────────────────────────────────╯
```

> [!IMPORTANT]
> **Vàng ròng để phòng tránh: test trên dữ liệu giống production.** Hoặc clone/anonymize production data về staging, hoặc dùng read-replica để chạy `EXPLAIN ANALYZE`. Một staging với 10k dòng đều tăm tắp **không bao giờ** phát hiện được vấn đề scale + skew + bloat của 80 triệu dòng production.

---

## 11. Câu hỏi đào sâu

> **"Làm sao chạy EXPLAIN ANALYZE an toàn trên production?"**
> `EXPLAIN (ANALYZE)` **thực sự chạy** query → cẩn thận với UPDATE/DELETE (bọc trong `BEGIN; ... ROLLBACK;`). An toàn nhất: chạy trên **read-replica**, hoặc dùng `EXPLAIN` (không ANALYZE) để xem plan mà không thực thi.

> **"`pg_stat_statements` giúp gì?"**
> Nó tổng hợp thời gian/số lần gọi mỗi query trên production → tìm ra query nào thật sự tốn tài nguyên (chứ không phải đoán). Đây là điểm khởi đầu chuẩn để biết "chậm ở đâu".

> **"Vì sao một query đang nhanh bỗng chậm dù không đổi gì?"**
> Plan flip do statistics cập nhật khi data vượt một ngưỡng selectivity; hoặc data skew tăng dần; hoặc bloat tích lũy; hoặc một index bị drop/invalid. "Không đổi code" không có nghĩa "không đổi điều kiện".

> **"Locust/k6 test có thay được không?"**
> Load test giúp lộ vấn đề concurrency/lock/pool (mục 8) mà EXPLAIN một mình không thấy. Kết hợp: EXPLAIN cho plan + load test cho hành vi dưới tải.

---

## 12. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 12.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  "Nhanh staging, chậm prod" — vì sao:                         │
│  ─────────────────────────────────────────────────────────     │
│  PLAN khác (data/statistics):                                 │
│   • Scale + skew dữ liệu → plan flip                          │
│   • Statistics khác → ước lượng selectivity khác              │
│   • Parameter sniffing / generic plan tệ cho giá trị lệch     │
│  PLAN giống nhưng prod chậm (môi trường):                     │
│   • Cache miss (data > RAM), đĩa/cấu hình khác                │
│   • work_mem thấp → sort tràn đĩa                             │
│   • Lock/concurrency/pool dưới tải thật                       │
│   • Bloat (thiếu VACUUM)                                       │
│  ─────────────────────────────────────────────────────────     │
│  Phòng tránh: test trên DATA GIỐNG PROD + EXPLAIN ANALYZE      │
│               + so plan hai môi trường                         │
╰───────────────────────────────────────────────────────────────╯
```

### 12.2. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. "Nhanh ở staging" không chứng minh gì nếu data không giống prod.**
> Scale và skew là hai thứ staging nhỏ luôn giấu. Test trên bản sao production (kích thước + phân bố thật) trước khi tin một query "đã tối ưu".
>
> **2. So PLAN, đừng chỉ so thời gian.**
> `EXPLAIN` ở cả hai nơi: plan khác → vấn đề data/statistics; plan giống mà chậm → vấn đề môi trường (cache/work_mem/lock/bloat). Hai hướng sửa hoàn toàn khác nhau.
>
> **3. Nếu EXPLAIN nhanh mà app chậm → nhìn ra ngoài query.**
> Lock, connection pool, concurrency, autovacuum. Đừng tối ưu plan đã tốt; soi `pg_stat_activity`/`pg_stat_statements`.

### 12.3. Quote cuối

> Một query không chạy trong chân không — nó chạy trên **dữ liệu thật**, trong một **môi trường thật**, dưới **tải thật**. Staging cho bạn cảm giác an toàn giả tạo vì nó tước bỏ cả ba. Kỹ sư giỏi không hỏi "query này nhanh không?" mà hỏi "nhanh với **bao nhiêu dữ liệu**, **phân bố thế nào**, **dưới tải nào**?". Câu trả lời cho ba câu đó mới là hiệu năng thật.
