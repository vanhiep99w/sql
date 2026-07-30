---
title: "Vì sao query đầu tiên mất 2s, các query sau chỉ 50ms?"
description: "Một câu hỏi phỏng vấn kinh điển: index tốt, execution plan tốt, nhưng lần chạy ĐẦU TIÊN mất 2 giây trong khi các lần sau chỉ 50ms. Mổ xẻ chi tiết cold cache vs warm cache: buffer pool, OS page cache, random I/O, hint bits, JIT warmup, prepared statement, và cách dùng EXPLAIN (ANALYZE, BUFFERS) để chứng minh."
---

## Mục lục

- [Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)](#2-câu-trả-lời-30-giây-nếu-phỏng-vấn-hỏi-nhanh)
- [Hiểu lầm cốt lõi: "Plan tốt" không có nghĩa "data đã ở trong RAM"](#3-hiểu-lầm-cốt-lõi-plan-tốt-không-có-nghĩa-data-đã-ở-trong-ram)
- [Hai tầng cache giữa query và đĩa cứng](#4-hai-tầng-cache-giữa-query-và-đĩa-cứng)
- [Lần chạy đầu tiên đi qua những đâu — từng bước](#5-lần-chạy-đầu-tiên-đi-qua-những-đâu--từng-bước)
- [Bằng chứng số 1: EXPLAIN (ANALYZE, BUFFERS) — hit vs read](#6-bằng-chứng-số-1-explain-analyze-buffers--hit-vs-read)
- [Vì sao random I/O lần đầu lại đắt đến thế](#7-vì-sao-random-io-lần-đầu-lại-đắt-đến-thế)
- [Thủ phạm ẩn #1: Hint bits — lần đọc đầu sau khi ghi](#8-thủ-phạm-ẩn-1-hint-bits--lần-đọc-đầu-sau-khi-ghi)
- [Thủ phạm ẩn #2: JIT compilation warmup](#9-thủ-phạm-ẩn-2-jit-compilation-warmup)
- [Thủ phạm ẩn #3: Plan cache & prepared statement](#10-thủ-phạm-ẩn-3-plan-cache--prepared-statement)
- [Những thủ phạm khác hay bị quên](#11-những-thủ-phạm-khác-hay-bị-quên)
- [Checklist chẩn đoán — tìm đúng nguyên nhân trong 5 phút](#12-checklist-chẩn-đoán--tìm-đúng-nguyên-nhân-trong-5-phút)
- [Cách xử lý — làm gì với "query đầu chậm"](#13-cách-xử-lý--làm-gì-với-query-đầu-chậm)
- [Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp](#14-câu-hỏi-đào-sâu-mà-người-phỏng-vấn-sẽ-hỏi-tiếp)
- [Tóm tắt — Cheat sheet & 3 nguyên tắc](#15-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Bảng của tôi có index tốt. `EXPLAIN` cho thấy execution plan dùng đúng index, không seq scan, cost thấp. Nhưng khi tôi chạy câu query **lần đầu tiên**, nó mất **2 giây**. Chạy lại đúng câu đó (cùng tham số) thì chỉ mất **50ms**. Chạy lần ba, lần tư cũng ~50ms. Tại sao? Và làm sao để chứng minh nguyên nhân?"*

Đây là một trong những câu hỏi tách biệt **người học thuộc** với **người hiểu hệ thống**. Người chỉ biết "tối ưu = thêm index" sẽ bối rối: *"Index có rồi, plan đẹp rồi, sao vẫn chậm?"* Người hiểu sâu sẽ hỏi ngược lại ngay: **"2 giây đó tiêu vào việc gì — CPU hay I/O? Và lần đầu khác lần sau ở chỗ data nằm ở đâu."**

> [!IMPORTANT]
> Mấu chốt: `EXPLAIN` cho bạn biết database **định làm gì** (chiến lược), chứ không cho biết **data đang nằm ở đâu** (RAM hay đĩa). Một plan hoàn hảo vẫn phải đọc data — và lần đầu, data thường nằm trên **đĩa**, không phải trong **RAM**. Sự khác biệt 2s vs 50ms gần như luôn là sự khác biệt giữa **đọc từ đĩa (cold cache)** và **đọc từ RAM (warm cache)**.

---

## 2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)

> Lần chạy đầu tiên, các **page** chứa data và index **chưa nằm trong bộ nhớ** (buffer pool + OS page cache trống — *cold cache*). Database phải đọc chúng từ đĩa bằng **random I/O**, vốn rất chậm. Những page đó sau đó được **giữ lại trong RAM**. Các lần chạy sau đọc thẳng từ RAM (*warm cache*) → nhanh gấp hàng chục lần. Plan không đổi, index không đổi — chỉ **vị trí của data** đổi từ đĩa sang RAM.
>
> Để chứng minh: chạy `EXPLAIN (ANALYZE, BUFFERS)` hai lần. Lần đầu sẽ thấy `Buffers: shared read=N` lớn (đọc từ đĩa) và `I/O Timings` cao; lần sau sẽ thấy `shared hit=N` (trúng cache) và thời gian sụt xuống.

Phần còn lại của doc giải thích **tại sao** và **các thủ phạm phụ** (hint bits, JIT, plan cache) mà một câu trả lời sâu cần đề cập.

---

## 3. Hiểu lầm cốt lõi: "Plan tốt" không có nghĩa "data đã ở trong RAM"

Nhiều người nghĩ pipeline của một query chỉ có:

```diagram
❌ Mô hình sai (thiếu một nửa):
   Query  →  Optimizer chọn plan  →  Chạy plan  →  Kết quả
                  (index tốt!)        (nhanh!)
```

Thực tế, giữa "chạy plan" và "kết quả" có một bước **đọc dữ liệu vật lý** mà plan không kiểm soát được:

```diagram
✅ Mô hình đúng:
   Query
     ▼
   Parse + Plan        ← EXPLAIN cho bạn thấy phần NÀY
     ▼
   Execute plan
     ▼
   Cần page P?  ──► Page P có trong buffer pool (RAM)?
                     ├─ CÓ  (cache HIT)  → đọc RAM   → ~nano giây
                     └─ KHÔNG (cache MISS) → đọc ĐĨA → ~mili giây  ← 2s nằm ở đây!
     ▼
   Kết quả
```

`EXPLAIN` đánh giá plan dựa trên **cost ước lượng** — số trừu tượng, **không** tính tới việc page đang nóng hay lạnh. Cùng một plan, cùng một index:

- **Cold cache**: mọi page phải đọc từ đĩa → chậm.
- **Warm cache**: mọi page đã trong RAM → nhanh.

> [!NOTE]
> Đây là lý do người ta nói *"EXPLAIN nói dối về thời gian"*. Cost trong `EXPLAIN` (không `ANALYZE`) là đơn vị ước lượng, không phải mili-giây, và **không** phản ánh trạng thái cache. Chỉ `EXPLAIN (ANALYZE, BUFFERS)` mới cho bạn thời gian thật + nguồn gốc của page.

---

## 4. Hai tầng cache giữa query và đĩa cứng

Khi database cần một page, nó đi qua một chuỗi cache. Hiểu chuỗi này là hiểu toàn bộ câu hỏi.

```diagram
╭──────────────────────────────────────────────────────────────╮
│                                                              │
│   Query thực thi, cần Page P                                 │
│        │                                                     │
│        ▼                                                     │
│   ┌─ Tầng 1: BUFFER POOL của database (RAM) ──────────────┐  │
│   │  Postgres: shared_buffers (mặc định 128MB)            │  │
│   │  MySQL:    innodb_buffer_pool_size                    │  │
│   │  → HIT: trả page tức thì (~100 ns)                    │  │
│   └───────────────────┬──────────────────────────────────┘  │
│                       │ MISS                                 │
│                       ▼                                      │
│   ┌─ Tầng 2: OS PAGE CACHE (RAM, do kernel quản lý) ──────┐  │
│   │  Postgres dựa rất nhiều vào tầng này                  │  │
│   │  → HIT: copy vào buffer pool (~vài µs)                │  │
│   └───────────────────┬──────────────────────────────────┘  │
│                       │ MISS                                 │
│                       ▼                                      │
│   ┌─ Tầng 3: ĐĨA (SSD/NVMe/HDD) ───────────────────────────┐ │
│   │  SSD: ~50-150 µs / page random read                   │ │
│   │  HDD: ~5-10 MS / page random read (chậm gấp ~100 lần) │ │
│   │  → Đây là nơi "2 giây" sinh ra                        │ │
│   └────────────────────────────────────────────────────────┘ │
╰──────────────────────────────────────────────────────────────╯
```

Thang thời gian để cảm nhận khoảng cách (ước lượng):

| Nguồn của 1 page | Độ trễ điển hình | So với buffer pool |
|------------------|-----------------:|-------------------:|
| Buffer pool (RAM, database) | ~100 ns | 1× |
| OS page cache (RAM, kernel) | ~1–5 µs | ~10–50× |
| SSD NVMe (random read) | ~50–150 µs | ~500–1500× |
| HDD (random read, seek) | ~5–10 ms | ~50,000–100,000× |

> [!IMPORTANT]
> Một query đụng 5,000 page. Nếu tất cả trong buffer pool: `5,000 × 100ns = 0.5ms`. Nếu tất cả phải đọc random từ HDD: `5,000 × 8ms = 40 giây`. Cùng plan, cùng index — chênh nhau **gần 100,000 lần** chỉ vì page nóng hay lạnh. Con số "2s lần đầu, 50ms lần sau" của bạn nằm gọn trong khoảng này.

---

## 5. Lần chạy đầu tiên đi qua những đâu — từng bước

Giả sử bạn vừa kết nối tới database mới khởi động (hoặc bảng lâu không truy cập, đã bị đẩy khỏi cache). Bạn chạy:

```sql
SELECT * FROM orders WHERE user_id = 12345 ORDER BY created_at DESC LIMIT 20;
-- idx_orders_user_date (user_id, created_at DESC) tồn tại, plan dùng đúng nó
```

```diagram
LẦN ĐẦU (cold):
  1. Đọc root page của idx_orders_user_date     → MISS → đĩa  (~8ms)
  2. Đọc internal page (tầng giữa B-Tree)        → MISS → đĩa  (~8ms)
  3. Đọc leaf page chứa user_id=12345            → MISS → đĩa  (~8ms)
  4. Với mỗi entry leaf → đọc HEAP page tương ứng → MISS → đĩa  (mỗi cái ~8ms)
       (20 row có thể nằm rải ở 20 page khác nhau → 20 lần random I/O!)
  5. Sắp xếp, LIMIT, trả kết quả                  → CPU (nhanh)
  → Tổng: hàng chục–trăm lần random read = ~2 giây

LẦN SAU (warm):
  1–4. Tất cả page index + heap GIỜ đã trong buffer pool → HIT toàn bộ (RAM)
  5.   CPU như cũ
  → Tổng: ~50ms
```

Chú ý bước 4: index trỏ bạn tới đúng row, nhưng **20 row đó nằm rải rác** trên nhiều heap page khác nhau (vì chúng được insert ở những thời điểm khác nhau). Mỗi page là **một lần random read riêng biệt**. Đây là lý do "chỉ lấy 20 dòng" mà lần đầu vẫn chậm: không phải vì quét nhiều, mà vì **mỗi dòng ở một chỗ trên đĩa**.

> [!TIP]
> Đây cũng là lý do **clustered index / CLUSTER / index-only scan** giúp ích: nếu các row liên quan nằm **kề nhau vật lý**, hoặc nếu dữ liệu cần lấy **đã có sẵn trong index** (không phải nhảy về heap), số lần random I/O lần đầu giảm mạnh.

---

## 6. Bằng chứng số 1: EXPLAIN (ANALYZE, BUFFERS) — hit vs read

Đây là công cụ chứng minh quan trọng nhất. `BUFFERS` cho biết mỗi node đọc bao nhiêu page từ **cache (hit)** và bao nhiêu từ **đĩa (read)**.

### 6.1. Lần chạy đầu (cold)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE user_id = 12345 ORDER BY created_at DESC LIMIT 20;
```

```text
 Limit  (actual time=1980.114..1980.142 rows=20 loops=1)
   Buffers: shared hit=3 read=2118
   I/O Timings: shared read=1923.443
   ->  Index Scan using idx_orders_user_date on orders
         (actual time=12.330..1979.880 rows=20 loops=1)
         Index Cond: (user_id = 12345)
         Buffers: shared hit=3 read=2118
         I/O Timings: shared read=1923.443
 Planning Time: 0.210 ms
 Execution Time: 1980.310 ms
```

Đọc kỹ:
- `Buffers: shared hit=3 read=2118` → chỉ 3 page trong cache, **2118 page đọc từ đĩa**.
- `I/O Timings: shared read=1923.443` → trong tổng ~1980ms, có **1923ms chỉ để đọc đĩa**. CPU gần như không làm gì.

→ Bằng chứng đanh thép: 97% thời gian là **chờ I/O**, không phải tính toán.

### 6.2. Lần chạy thứ hai (warm)

```text
 Limit  (actual time=0.071..0.095 rows=20 loops=1)
   Buffers: shared hit=2121
   ->  Index Scan using idx_orders_user_date on orders
         (actual time=0.060..0.088 rows=20 loops=1)
         Index Cond: (user_id = 12345)
         Buffers: shared hit=2121
 Planning Time: 0.060 ms
 Execution Time: 48.900 ms
```

- `Buffers: shared hit=2121` — **toàn bộ hit**, `read=0`. Không còn dòng `I/O Timings` (không đọc đĩa).
- Thời gian sụt từ 1980ms xuống ~49ms.

> [!IMPORTANT]
> **Đây là toàn bộ câu trả lời, dưới dạng số liệu.** Cùng một plan (`Index Scan using idx_orders_user_date`), cùng số page đụng tới (~2120), nhưng lần đầu `read=2118` (đĩa) → 2s, lần sau `hit=2121` (RAM) → 50ms. Nếu trong phỏng vấn bạn dẫn ra được `Buffers` và `I/O Timings`, người phỏng vấn biết bạn **thật sự hiểu**, không đoán mò.

### 6.3. Mẹo đọc nhanh

| Bạn thấy | Nghĩa là |
|----------|----------|
| `shared read=N` lớn, `I/O Timings` cao | Cold cache — đang đọc đĩa (thủ phạm chính) |
| `shared hit=N`, `read=0` | Warm cache — đọc toàn RAM |
| `Execution Time` cao nhưng `I/O Timings` thấp | Không phải I/O — nghi JIT/CPU/sort/lock (xem mục 9, 11) |
| `Planning Time` cao bất thường | Nghi plan-time overhead, không phải execution (xem mục 10) |

---

## 7. Vì sao random I/O lần đầu lại đắt đến thế

Không phải mọi đọc đĩa đều như nhau. Câu hỏi sâu hơn: *tại sao 2000 page lại mất 2 giây, trong khi đọc tuần tự 2000 page có thể chỉ vài chục ms?*

```diagram
SEQUENTIAL READ (quét tuần tự, vd seq scan):
   Page 0 → 1 → 2 → 3 → ...   (liền kề nhau trên đĩa)
   → Đĩa + OS làm READ-AHEAD (đọc trước cả cụm)
   → SSD/HDD đọc rất nhanh khi tuần tự

RANDOM READ (index scan nhảy lung tung):
   Page 2118 → 5 → 9904 → 31 → 7762 → ...   (rải khắp đĩa)
   → Không read-ahead được (không đoán được page kế tiếp)
   → HDD: mỗi lần phải SEEK (di chuyển đầu đọc) ~5-10ms
   → SSD: không seek nhưng vẫn tốn latency mỗi I/O + không gộp được
```

Nghịch lý quan trọng: **index scan sinh ra random I/O**. Khi cold cache, một index scan trả về nhiều row (mỗi row một heap page) có thể **chậm hơn** cả seq scan — đây là lý do optimizer dùng tham số `random_page_cost` (mặc định 4.0) cao hơn `seq_page_cost` (1.0) để phạt random access.

> [!NOTE]
> Trên SSD/NVMe, khoảng cách random vs sequential nhỏ hơn HDD rất nhiều. Đó là lý do trên hệ thống SSD, nhiều DBA chỉnh `random_page_cost` xuống ~1.1 để optimizer "dám" dùng index hơn. Nhưng kể cả SSD, **cold random read vẫn chậm hơn warm read hàng trăm lần** — nên hiện tượng "lần đầu chậm" vẫn tồn tại.

---

## 8. Thủ phạm ẩn #1: Hint bits — lần đọc đầu sau khi ghi

Đây là chi tiết "ăn điểm" trong phỏng vấn Postgres mà ít người biết. Đôi khi lần đọc đầu chậm **không chỉ vì I/O đọc** mà còn vì **I/O ghi** — do **hint bits**.

Trong MVCC, mỗi tuple có `xmin`/`xmax` (transaction tạo/xóa nó). Để biết một tuple có "visible" không, Postgres phải kiểm tra trạng thái commit của transaction đó trong `pg_xact` (commit log) — một thao tác tốn kém. Để khỏi kiểm tra lại mỗi lần, lần **đầu tiên** một tuple được đọc sau khi commit, Postgres ghi một **hint bit** vào header tuple ("transaction này đã commit rồi").

```diagram
INSERT/UPDATE 1 triệu row, COMMIT.
   ▼
SELECT lần đầu trên các row đó:
   - Với mỗi tuple: kiểm tra pg_xact → set hint bit
   - Set hint bit = SỬA page → page thành DIRTY
   - Page dirty phải được GHI xuống đĩa (bởi checkpoint/bgwriter)
   → Lần SELECT đầu vừa ĐỌC vừa GHI → chậm bất ngờ

SELECT lần sau:
   - Hint bit đã có → không cần kiểm tra pg_xact, không sửa page
   → Nhanh
```

Triệu chứng đặc trưng: bạn vừa `INSERT`/`COPY` một lượng lớn data, rồi `SELECT count(*)` lần đầu **chậm và sinh write I/O** (thấy `Buffers: ... dirtied=N` và `written=N` trong `EXPLAIN (ANALYZE, BUFFERS)`), dù chỉ là một câu đọc.

> [!WARNING]
> Nếu "query đầu chậm" xảy ra **ngay sau một lần ghi lớn** (bulk insert/restore/migration), nghi ngay **hint bits** chứ không chỉ cold read. Cách làm dịu: chạy `VACUUM` (hoặc `VACUUM FREEZE`) sau khi load data lớn — nó set hint bit (và freeze) một lần, để các SELECT sau không phải gánh.

---

## 9. Thủ phạm ẩn #2: JIT compilation warmup

Từ Postgres 11+, optimizer có thể **JIT-compile** (biên dịch sang mã máy bằng LLVM) các biểu thức cho query phức tạp/cost cao. Việc biên dịch này tốn **CPU thời gian** ở **lần đầu**.

```text
 ...
 Planning Time: 0.5 ms
 JIT:
   Functions: 14
   Options: Inlining true, Optimization true, Expressions true, Deforming true
   Timing: Generation 3.2 ms, Inlining 25.1 ms, Optimization 380.4 ms, Emission 210.7 ms, Total 619.4 ms
 Execution Time: 720.0 ms
```

Ở đây ~619ms là **JIT**, không phải đọc data. Dấu hiệu nhận biết: `Execution Time` cao nhưng `I/O Timings` thấp, và có block `JIT:` với `Optimization`/`Emission` lớn.

- JIT cache **không** được tái sử dụng giữa các câu query khác nhau theo cách bạn mong đợi — nhưng với cùng prepared statement nó có thể đỡ hơn.
- Nếu query của bạn không thực sự nặng về CPU, JIT có thể **làm hại nhiều hơn lợi**.

> [!TIP]
> Nếu nghi JIT là thủ phạm "lần đầu chậm", thử tắt và đo lại:
> ```sql
> SET jit = off;   -- hoặc nâng jit_above_cost để JIT chỉ kích hoạt với query thật sự nặng
> ```
> Nếu lần đầu nhanh hẳn lên → JIT chính là nguyên nhân (hoặc một phần).

---

## 10. Thủ phạm ẩn #3: Plan cache & prepared statement

Câu hỏi nói "execution plan tốt" — nhưng **việc tạo ra plan đó** cũng tốn thời gian (parse + plan). Với hầu hết query thì planning chỉ ~0.2ms (không đáng kể so với 2s), nhưng có vài trường hợp planning lần đầu đắt:

- Query đụng **rất nhiều bảng/partition** → optimizer phải xét nhiều join order → planning có thể tới hàng trăm ms.
- Lần đầu, các **catalog/statistics** (`pg_statistic`, `pg_class`) cũng chưa nằm trong cache → đọc chúng cũng là cold read.

Với **prepared statement**, plan được cache lại sau vài lần chạy (Postgres dùng cơ chế generic vs custom plan sau 5 lần execute). Nhưng lưu ý: điều này tiết kiệm **planning time**, không tiết kiệm **I/O của data** — nên nó hiếm khi là nguyên nhân của khoảng cách 2s → 50ms (vốn chủ yếu là I/O).

> [!NOTE]
> Đừng nhầm hai loại "cache":
> - **Plan cache / prepared statement** → tiết kiệm thời gian **lập plan** (`Planning Time`).
> - **Buffer pool / OS page cache** → tiết kiệm thời gian **đọc data** (`Execution Time`, `I/O Timings`).
> Khoảng cách 2s vs 50ms gần như luôn thuộc loại thứ hai. Nhìn `Planning Time` vs `Execution Time` để biết bạn đang gặp loại nào.

---

## 11. Những thủ phạm khác hay bị quên

Để câu trả lời thật đầy đủ, đây là các nguyên nhân phụ có thể góp phần vào "lần đầu chậm":

| Thủ phạm | Dấu hiệu | Ghi chú |
|----------|----------|---------|
| **Connection/TLS handshake** | Lần đầu trong session chậm | Đo trong cùng 1 session để loại trừ |
| **Lazy catalog loading** | Bảng/schema lần đầu truy cập | Catalog cache (`relcache`/`syscache`) ấm dần |
| **TOAST fetch** | Cột lớn (text/jsonb/bytea) | Giá trị lớn lưu ngoài, đọc thêm page cold |
| **Auto-explain/auto-analyze chạy nền** | Bất chợt chậm sau khi data đổi nhiều | autovacuum/analyze có thể giành I/O |
| **Read-ahead chưa kích hoạt** | Cold sequential cũng hơi chậm lần đầu | OS chưa "đoán" được pattern |
| **Spectre/NUMA/CPU scaling** | Hiếm, môi trường cloud | CPU governor nâng tần số sau tải |
| **Lock chờ** | `Execution Time` cao, I/O thấp, không JIT | Lần đầu kẹt lock từ txn khác |

> [!TIP]
> Quy tắc loại trừ: nếu `I/O Timings` cao → cold cache (mục 4–7). Nếu I/O thấp mà thời gian vẫn cao → soi `JIT` (mục 9), `Planning Time` (mục 10), `dirtied/written` (hint bits, mục 8), hoặc lock.

---

## 12. Checklist chẩn đoán — tìm đúng nguyên nhân trong 5 phút

```diagram
╭──────────────────────────────────────────────────────────────╮
│ B1. Chạy: EXPLAIN (ANALYZE, BUFFERS) <query>  — HAI lần       │
│                                                              │
│ B2. Nhìn dòng Buffers ở lần ĐẦU:                              │
│     • shared read=N lớn?  ──► COLD CACHE (I/O đọc)            │
│       └─ I/O Timings cao xác nhận → nguyên nhân chính (mục 6) │
│                                                              │
│ B3. Có dirtied=N / written=N ở câu SELECT?                   │
│     • Có, và vừa bulk-write xong ──► HINT BITS (mục 8)        │
│                                                              │
│ B4. Execution Time cao NHƯNG I/O Timings thấp?               │
│     • Có block JIT: với Optimization/Emission lớn ──► JIT     │
│     • Planning Time cao ──► plan/catalog cold (mục 10)        │
│     • Không gì trên đây ──► nghi LOCK / sort / CPU (mục 11)   │
│                                                              │
│ B5. Lần CHẠY 2 nhanh hẳn + Buffers chuyển sang hit?          │
│     • Đúng ──► xác nhận hiệu ứng cache (cold→warm)            │
╰──────────────────────────────────────────────────────────────╯
```

---

## 13. Cách xử lý — làm gì với "query đầu chậm"

Trước hết: **đây thường KHÔNG phải bug.** Cold cache là bản chất của hệ thống có phân tầng RAM/đĩa. Nhưng nếu "lần đầu chậm" gây đau (ví dụ API timeout ở request đầu), có các hướng:

| Hướng | Khi nào dùng | Đánh đổi |
|-------|--------------|----------|
| **Tăng `shared_buffers` / buffer pool** | RAM dư, working set vừa | Nhiều RAM hơn cho DB |
| **`pg_prewarm`** nạp sẵn bảng/index nóng vào cache | Sau restart, biết trước bảng hot | Tốn RAM + thời gian warmup |
| **Chạy query "mồi" lúc khởi động** (warmup script) | API/service cần latency ổn định | Phải bảo trì danh sách query mồi |
| **`VACUUM (FREEZE)` sau bulk load** | Lần đầu chậm vì hint bits | Tốn I/O lúc vacuum |
| **`SET jit = off` / nâng `jit_above_cost`** | Lần đầu chậm vì JIT | Mất lợi ích JIT cho query nặng CPU |
| **Index-only scan / covering index** | Giảm random heap fetch | Index lớn hơn, ghi chậm hơn |
| **`CLUSTER` theo index** | Row liên quan rải rác heap | Cần lock + bảo trì định kỳ |
| **Hạ `random_page_cost`** (SSD) | Optimizer né index không cần thiết | Chỉ chỉnh khi hiểu hệ quả |

```sql
-- Ví dụ: nạp trước bảng + index nóng vào buffer pool sau khi DB khởi động
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
SELECT pg_prewarm('orders');
SELECT pg_prewarm('idx_orders_user_date');
```

> [!IMPORTANT]
> Đừng "tối ưu" một query mà **lần sau đã 50ms**. Nếu warm cache đã đủ nhanh và bảng được truy cập thường xuyên (luôn nóng), thì "lần đầu 2s" có thể là **non-issue**. Chỉ xử lý khi nó thực sự ảnh hưởng người dùng (ví dụ query hiếm khi chạy → luôn cold, hoặc service vừa restart đã bị tải nặng ngay).

---

## 14. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp

Chuẩn bị sẵn cho các câu "vặn" tiếp theo:

> **"Nếu tôi chạy query với tham số `user_id` KHÁC ở lần hai thì sao?"**
> Vẫn có thể nhanh nếu các page index/heap cho user đó **tình cờ** đã nóng (vd cùng leaf page), nhưng nếu data ở vùng đĩa khác → lại cold → lại chậm. Cache nóng theo **page**, không theo **giá trị query**.

> **"Restart database thì cache còn không?"**
> `shared_buffers` (buffer pool) **mất** khi restart Postgres. OS page cache **mất** khi reboot máy. Sau restart → mọi thứ cold trở lại → query đầu chậm trở lại. (Đây là lý do có `pg_prewarm`.)

> **"Làm sao biết working set có vừa RAM không?"**
> So sánh tổng size bảng+index nóng với `shared_buffers` + RAM trống. Dùng `pg_buffercache` để xem buffer pool đang chứa gì. Nếu working set > RAM → page liên tục bị **evict** → cache miss thường xuyên ngay cả khi "đã chạy rồi".

> **"MySQL có khác Postgres không?"**
> Khái niệm giống nhau (InnoDB buffer pool ≈ shared_buffers). Khác biệt: InnoDB dùng **clustered index** (data nằm theo PK) → random heap fetch ít hơn cho lookup theo PK; MySQL không có "hint bits" kiểu Postgres nhưng có **change buffer**, **adaptive hash index**, và cũng cần warmup buffer pool sau restart (`innodb_buffer_pool_dump_at_shutdown`/`load_at_startup` để nạp lại).

> **"Vì sao không cache luôn KẾT QUẢ query?"**
> Postgres **không** có query result cache (MySQL từng có nhưng đã bỏ ở 8.0 vì khó invalidate đúng). Cache ở tầng **page** linh hoạt hơn: nó tăng tốc **mọi** query đụng page đó, và không phải lo invalidate kết quả khi data đổi.

---

## 15. Tóm tắt — Cheat sheet & 3 nguyên tắc

### 15.1. Cheat sheet

```diagram
╭───────────────────────────────────────────────────────────────╮
│  Triệu chứng: query đầu 2s, các query sau 50ms                │
│  ───────────────────────────────────────────────────────────  │
│  Nguyên nhân #1 (90%): COLD CACHE                             │
│     → Buffers: shared read=N lớn + I/O Timings cao            │
│     → Fix: warmup / pg_prewarm / tăng buffer pool             │
│                                                               │
│  #2: HINT BITS (ngay sau bulk write)                          │
│     → Buffers: dirtied/written > 0 ở câu SELECT               │
│     → Fix: VACUUM (FREEZE) sau khi load                       │
│                                                               │
│  #3: JIT WARMUP (query nặng CPU)                              │
│     → block JIT: Optimization/Emission lớn, I/O thấp          │
│     → Fix: SET jit=off / nâng jit_above_cost                  │
│                                                               │
│  #4: PLAN/CATALOG COLD (nhiều bảng/partition)                │
│     → Planning Time cao                                       │
│     → Fix: prepared statement / giảm số partition             │
╰───────────────────────────────────────────────────────────────╯
```

### 15.2. Một câu để nhớ

> **EXPLAIN nói database ĐỊNH làm gì; BUFFERS nói data ĐANG ở đâu.** Khoảng cách 2s → 50ms là khoảng cách từ **đĩa** tới **RAM**.

### 15.3. 3 nguyên tắc áp dụng ngay

> [!IMPORTANT]
> **1. Luôn dùng `EXPLAIN (ANALYZE, BUFFERS)`, không chỉ `EXPLAIN`.**
> `EXPLAIN` thường cho cost ước lượng và không biết cache nóng/lạnh. Chỉ `ANALYZE, BUFFERS` mới phơi bày `hit` vs `read` và `I/O Timings` — bằng chứng thật của "lần đầu chậm".
>
> **2. Đo HAI lần và so sánh.**
> Lần đầu (cold) vs lần hai (warm) cho bạn thấy ngay hiệu ứng cache. Nếu lần hai vẫn chậm → không phải cache, phải đào sang JIT/lock/plan.
>
> **3. Phân biệt "chậm vì I/O" và "chậm vì CPU/plan".**
> `I/O Timings` cao → cold cache. I/O thấp mà vẫn chậm → JIT, planning, hint-bit write, hoặc lock. Sai hướng chẩn đoán = tối ưu nhầm chỗ.

### 15.4. Quote cuối

> Một index tốt và một plan đẹp chỉ trả lời câu hỏi *"đi đường nào"*. Chúng không trả lời *"dữ liệu đang nằm ở RAM hay trên đĩa"* — và đó mới là thứ quyết định 2 giây hay 50 mili-giây. Kỹ sư giỏi không dừng ở `EXPLAIN`; họ đọc `BUFFERS`, hiểu phân tầng cache, và biết rằng **performance không chỉ là chiến lược, mà còn là vị trí của từng byte**.
