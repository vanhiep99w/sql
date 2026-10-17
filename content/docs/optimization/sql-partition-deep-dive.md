---
title: "SQL Partitioning"
description: "Deep dive vào SQL Partitioning — Range, List, Hash, Partition Pruning, Global vs Local Index"
---

<SourceRef project="optimization-sql-partition-deep-dive" variant="button">
Mở các đoạn code trong bài
</SourceRef>

Các file trong Source Explorer là **snippet độc lập**, giữ nguyên ngữ cảnh và database của từng mục; không chạy nối tiếp tất cả như một script.

## Mục lục

- [Nền tảng Partitioning](#1-nền-tảng-partitioning)
- [Các loại Partition](#2-các-loại-partition)
- [Range Partitioning — Chi tiết](#3-range-partitioning--chi-tiết)
- [List Partitioning — Chi tiết](#4-list-partitioning--chi-tiết)
- [Hash Partitioning — Chi tiết](#5-hash-partitioning--chi-tiết)
- [Key Partitioning](#6-key-partitioning)
- [Composite (Sub) Partitioning](#7-composite-sub-partitioning)
- [Partition Pruning](#8-partition-pruning)
- [Partitioning vs Indexing](#9-partitioning-vs-indexing)
- [Global vs Local Indexes](#10-global-vs-local-indexes)
- [Các lỗi thường gặp & Cách phòng tránh](#11-các-lỗi-thường-gặp--cách-phòng-tránh)
- [Ví dụ thực tế](#12-ví-dụ-thực-tế)
- [Thao tác bảo trì Partition](#13-thao-tác-bảo-trì-partition)
- [Best Practices](#14-best-practices)

---

## 1. Nền tảng Partitioning

### Table Partitioning là gì?

**Partitioning** là kỹ thuật database chia một bảng lớn thành các phần nhỏ hơn, dễ quản lý hơn gọi là **partition**. Mỗi partition được lưu riêng biệt nhưng ứng dụng vẫn thấy như một bảng logic duy nhất.

```d2 title="Một logical table chia thành nhiều partitions"
direction: down
single: Không partition {
  table: Orders — ví dụ 100 triệu rows
  scan: Không có pruning theo partition
  table -> scan
}
partitioned: Có partition theo năm {
  orders: Logical table orders
  p2022: orders_2022 — Jan–Dec 2022, 20M rows
  p2023: orders_2023 — Jan–Dec 2023, 30M rows
  p2024: orders_2024 — Jan–Dec 2024, 50M rows
  query: Query năm 2024
  orders -> p2022
  orders -> p2023
  orders -> p2024
  query -> p2024: pruning các năm khác
}
```

Ví dụ data ban đầu:

| id | customer_id | order_date | total | status |
| --- | --- | --- | --- | --- |
| 1 | 100 | 2020-01-01 | 50.00 | done |
| 2 | 101 | 2020-01-02 | 75.00 | done |
| N | 999 | 2024-12-01 | 99.00 | pending |

Partitioning có thể giúp lifecycle, drop dữ liệu cũ, maintenance và pruning. Không partition vẫn có thể dùng index để tránh full scan; partitioning cũng không tự bảo đảm backup riêng, parallel query hoặc thao tác “instant” ở mọi engine. Phân bố rows theo năm trong hai mô hình chỉ là ví dụ riêng, không phải cùng dataset đã đo.

### Tại sao dùng Partitioning?

| Lợi ích | Giải thích | Ví dụ |
|---------|------------|-------|
| **Hiệu năng query** | Partition pruning bỏ qua partition không liên quan | Query dữ liệu 2024 chỉ scan partition 2024 |
| **Xóa dữ liệu nhanh** | DROP partition thay vì DELETE hàng triệu row | Xóa dữ liệu 2020: `DROP PARTITION p_2020` (tức thì) |
| **Bảo trì dễ hơn** | Backup/restore từng partition riêng | Chỉ backup partition tháng hiện tại |
| **Thao tác song song** | Nhiều partition xử lý đồng thời | Rebuild index song song trên các partition |
| **Tăng availability** | Thao tác cấp partition không lock toàn bộ bảng | Thêm partition mà không block query |
| **Tối ưu storage** | Các partition khác nhau có thể dùng tablespace khác nhau | Archive partition lên storage rẻ hơn |

### Khi nào nên dùng Partitioning

```d2 title="Khi nào nên dùng Partitioning"
direction: down
A: "Should I Partition This Table?"
B: "Table size > 10GB?" { shape: diamond }
C: "❌ Probably not needed"
D: "Clear partition key?" { shape: diamond }
E: "Can derive partition key?" { shape: diamond }
F: "Query patterns match partition key?" { shape: diamond }
G: "⚠️ Partitioning may not help"
H: "Need to delete old data?" { shape: diamond }
I: "✅ Strong candidate for partitioning"
J: "Need parallel processing?" { shape: diamond }
K: "⚠️ Consider carefully"
L: "Choose Partition Type"
M: "Time-based data?" { shape: diamond }
N: "RANGE partition by date"
O: "Discrete categories?" { shape: diamond }
P: "LIST partition"
Q: "HASH partition for distribution"
A -> B
B -> C: "No"
B -> D: "Yes"
D -> E: "No"
D -> F: "Yes"
E -> C: "No"
E -> F: "Yes"
F -> G: "No"
F -> H: "Yes"
H -> I: "Yes"
H -> J: "No"
J -> I: "Yes"
J -> K: "No"
I -> L
L -> M
M -> N: "Yes"
M -> O: "No"
O -> P: "Yes"
O -> Q: "No"
```

### Khi nào KHÔNG nên dùng Partitioning

| Trường hợp | Lý do | Thay thế |
|------------|-------|----------|
| **Bảng nhỏ** (< 1GB) | Chi phí không đáng | Dùng index |
| **Không có partition key rõ ràng** | Không thể prune hiệu quả | Dùng index |
| **Query trải tất cả partition** | Không có lợi ích pruning | Dùng index |
| **Cross-partition join thường xuyên** | Giảm hiệu năng | Xem lại schema |
| **Transaction nhỏ, tần suất cao** | Overhead partition | Dùng index |

---

## 2. Các loại Partition

### Tổng quan các loại Partition

| Loại | Cách hoạt động | Phù hợp với | Ví dụ |
|------|--------------|----------|--------|
| **RANGE** | Row được gán theo khoảng giá trị | Dữ liệu time-series, ID tuần tự | `order_date` theo năm/tháng |
| **LIST** | Row được gán theo giá trị rời rạc | Danh mục, khu vực, trạng thái | `country` IN ('US', 'UK', 'JP') |
| **HASH** | Row phân bổ bằng hàm hash | Phân bổ đều, không có key tự nhiên | `user_id` MOD 4 |
| **KEY** | Giống HASH nhưng dùng hash nội bộ MySQL | Tương tự HASH, chỉ MySQL | `user_id` |
| **COMPOSITE** | Kết hợp các loại trên | Yêu cầu phức tạp | RANGE theo ngày, sau đó LIST theo khu vực |

### So sánh trực quan

```d2 title="Ba cách phân chia partition key"
grid-columns: 1
range_node: RANGE theo order_date {
  grid-columns: 2
  p2022: 2022-01-01 tới trước 2023-01-01
  p2023: 2023-01-01 tới trước 2024-01-01
  p2024: 2024-01-01 tới trước 2025-01-01
  future: Future từ 2025
}
list_node: LIST theo region {
  grid-columns: 2
  americas: AMERICAS — US, CA, MX, BR, AR
  europe: EUROPE — UK, DE, FR, ES, IT
  asia: ASIA — JP, CN, KR, IN, SG
  other: OTHER — values còn lại theo rule
}
hash_node: HASH — ví dụ identity modulo bốn {
  grid-columns: 2
  p0: P0 — remainder 0, keys 4,8,12,16...
  p1: P1 — remainder 1, keys 1,5,9,13...
  p2: P2 — remainder 2, keys 2,6,10,14...
  p3: P3 — remainder 3, keys 3,7,11,15...
}
```

RANGE thường phù hợp dữ liệu thời gian/lifecycle; LIST phù hợp tập categories đã biết; HASH giúp phân phối khi không có natural range/list key. Identity modulo chỉ là mô hình số học cho ví dụ, không phải hàm hash thực tế chung của các database.

### Ma trận quyết định chọn loại Partition

| Criteria | RANGE | LIST | HASH |
|----------|-------|------|------|
| **Data has natural ordering** | ✅ Best | ❌ | ❌ |
| **Data has discrete categories** | ❌ | ✅ Best | ❌ |
| **Need even distribution** | ⚠️ Depends | ⚠️ Depends | ✅ Best |
| **Query by range** | ✅ Excellent | ❌ | ❌ |
| **Query by specific values** | ⚠️ OK | ✅ Excellent | ❌ |
| **Easy to add partitions** | ✅ Yes | ✅ Yes | ⚠️ Requires reorg |
| **Easy to drop old data** | ✅ Yes | ✅ Yes | ❌ No |

---

## 3. Range Partitioning — Chi tiết

### Range Partitioning hoạt động như thế nào

Range partitioning divides data based on value ranges. Each partition holds rows where the partition key falls within a specified range.

```d2 title="RANGE partition route theo khoảng ngày"
direction: right
n0: "INSERT id=1, order_date=2023-06-15, amount=100"
n1: "Kiểm tra 2023-01-01 ≤ order_date < 2024-01-01"
n2: "Route tới partition p_2023"
n0 -> n1 -> n2
```

Bảng ví dụ có `id INT`, `order_date DATE`, `amount DECIMAL(10,2)` và partition key `order_date`. Các mốc được quản lý từ khoảng lịch sử tới `MAXVALUE`; các phần SQL bên dưới định nghĩa chính xác boundary theo database.

### Cú pháp Range Partition

```sql
-- MySQL: Range Partition by Date
CREATE TABLE orders (
    id INT NOT NULL AUTO_INCREMENT,
    customer_id INT NOT NULL,
    order_date DATE NOT NULL,
    amount DECIMAL(10,2),
    PRIMARY KEY (id, order_date)  -- partition key must be in PK!
) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p_2022 VALUES LESS THAN (2023),
    PARTITION p_2023 VALUES LESS THAN (2024),
    PARTITION p_2024 VALUES LESS THAN (2025),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- PostgreSQL: Range Partition by Date
CREATE TABLE orders (
    id SERIAL,
    customer_id INT NOT NULL,
    order_date DATE NOT NULL,
    amount DECIMAL(10,2)
) PARTITION BY RANGE (order_date);

CREATE TABLE orders_2022 PARTITION OF orders
    FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');
CREATE TABLE orders_2023 PARTITION OF orders
    FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
CREATE TABLE orders_2024 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- PostgreSQL: Default partition for unmatched values
CREATE TABLE orders_default PARTITION OF orders DEFAULT;
```

<SourceRef project="optimization-sql-partition-deep-dive" file="cú-pháp-range-partition/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

### Range Partition theo tháng (Pattern phổ biến)

```sql
-- MySQL: Monthly partitions
CREATE TABLE logs (
    id BIGINT NOT NULL AUTO_INCREMENT,
    log_date DATETIME NOT NULL,
    message TEXT,
    PRIMARY KEY (id, log_date)
) PARTITION BY RANGE (TO_DAYS(log_date)) (
    PARTITION p_2024_01 VALUES LESS THAN (TO_DAYS('2024-02-01')),
    PARTITION p_2024_02 VALUES LESS THAN (TO_DAYS('2024-03-01')),
    PARTITION p_2024_03 VALUES LESS THAN (TO_DAYS('2024-04-01')),
    -- ... more months
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- PostgreSQL: Monthly partitions with automatic naming
CREATE TABLE logs (
    id BIGSERIAL,
    log_date TIMESTAMP NOT NULL,
    message TEXT
) PARTITION BY RANGE (log_date);

-- Create partitions for each month
CREATE TABLE logs_2024_01 PARTITION OF logs
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE logs_2024_02 PARTITION OF logs
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- ... etc
```

<SourceRef project="optimization-sql-partition-deep-dive" file="range-partition-theo-tháng-pattern-phổ-biến/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

### Ví dụ query với Range Partition

```sql
-- This query ONLY scans p_2024 partition (partition pruning)
SELECT * FROM orders 
WHERE order_date >= '2024-01-01' AND order_date < '2024-06-01';

-- Check which partitions will be scanned
EXPLAIN SELECT * FROM orders WHERE order_date = '2024-03-15';
-- MySQL output will show: partitions: p_2024
-- PostgreSQL output will show: only orders_2024 scanned
```

---

## 4. List Partitioning — Chi tiết

### List Partitioning hoạt động như thế nào

List partitioning assigns rows to partitions based on discrete values. Each partition contains rows matching specific values in a list.

```d2 title="LIST partition ánh xạ giá trị tới partition"
direction: right
us: "US / CA / MX"
eu: "UK / DE / FR"
asia: "JP / CN / KR"
other: "Giá trị khác"
pa: "p_americas"
pe: "p_europe"
ps: "p_asia"
po: "p_other — catch-all"
us -> pa
eu -> pe
asia -> ps
other -> po
```

Bảng `customers(id INT, name VARCHAR(100), country VARCHAR(2))` dùng `PARTITION BY LIST (country)`. Ví dụ insert `(1, 'John', 'DE')`: `DE IN (UK, DE, FR)` nên route tới `p_europe`. Cú pháp catch-all/default tùy database.

### Cú pháp List Partition

```sql
-- MySQL: List Partition by Region
CREATE TABLE customers (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(100),
    country VARCHAR(2) NOT NULL,
    PRIMARY KEY (id, country)
) PARTITION BY LIST COLUMNS (country) (
    PARTITION p_americas VALUES IN ('US', 'CA', 'MX', 'BR', 'AR'),
    PARTITION p_europe VALUES IN ('UK', 'DE', 'FR', 'ES', 'IT'),
    PARTITION p_asia VALUES IN ('JP', 'CN', 'KR', 'IN', 'SG'),
    PARTITION p_other VALUES IN ('AU', 'NZ', 'ZA')
);

-- PostgreSQL: List Partition
CREATE TABLE customers (
    id SERIAL,
    name VARCHAR(100),
    country VARCHAR(2) NOT NULL
) PARTITION BY LIST (country);

CREATE TABLE customers_americas PARTITION OF customers
    FOR VALUES IN ('US', 'CA', 'MX', 'BR', 'AR');
CREATE TABLE customers_europe PARTITION OF customers
    FOR VALUES IN ('UK', 'DE', 'FR', 'ES', 'IT');
CREATE TABLE customers_asia PARTITION OF customers
    FOR VALUES IN ('JP', 'CN', 'KR', 'IN', 'SG');
CREATE TABLE customers_other PARTITION OF customers DEFAULT;
```

<SourceRef project="optimization-sql-partition-deep-dive" file="cú-pháp-list-partition/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

### Các trường hợp dùng List Partition

| Use Case | Partition Key | Partition Values |
|----------|---------------|------------------|
| **Geographic** | country/region | Americas, Europe, Asia |
| **Status** | order_status | pending, processing, shipped, delivered |
| **Category** | product_category | electronics, clothing, food |
| **Tenant** | tenant_id | tenant_a, tenant_b, tenant_c |
| **Priority** | priority_level | low, medium, high, critical |

---

## 5. Hash Partitioning — Chi tiết

### Hash Partitioning hoạt động như thế nào

Hash partitioning distributes rows across partitions using a hash function. This ensures even distribution when there's no natural range or list key.

```d2 title="HASH partition: mô hình hash modulo bốn"
direction: right
u101: user_id 101
u102: user_id 102
u103: user_id 103
u104: user_id 104
u105: user_id 105
p0: P0 — user 103, 105
p1: P1 — user 102
p2: P2 — user 101
p3: P3 — user 104
u101 -> p2: 2847362 mod 4 = 2
u102 -> p1: 9283741 mod 4 = 1
u103 -> p0: 1827364 mod 4 = 0
u104 -> p3: 5738291 mod 4 = 3
u105 -> p0: 8273648 mod 4 = 0
```

Bảng ví dụ là `user_sessions(session_id VARCHAR(64), user_id INT)`. Các hash trên là **số minh họa**, không phải công thức hash cụ thể của mọi engine. Hash có thể phân bố gần đều ở quy mô lớn, nhưng không bảo đảm đúng 25% từng partition. Biết key và hàm routing thì xác định được partition; range trên key thường không prune được về một partition như RANGE partitioning.

### Cú pháp Hash Partition

```sql
-- MySQL: Hash Partition
CREATE TABLE user_sessions (
    id BIGINT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    session_data JSON,
    created_at TIMESTAMP,
    PRIMARY KEY (id, user_id)
) PARTITION BY HASH (user_id) PARTITIONS 8;

-- MySQL: Linear Hash (easier to add/remove partitions)
CREATE TABLE user_sessions (
    id BIGINT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    session_data JSON,
    PRIMARY KEY (id, user_id)
) PARTITION BY LINEAR HASH (user_id) PARTITIONS 8;

-- PostgreSQL: Hash Partition
CREATE TABLE user_sessions (
    id BIGSERIAL,
    user_id INT NOT NULL,
    session_data JSONB,
    created_at TIMESTAMP
) PARTITION BY HASH (user_id);

CREATE TABLE user_sessions_p0 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE user_sessions_p1 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE user_sessions_p2 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE user_sessions_p3 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

<SourceRef project="optimization-sql-partition-deep-dive" file="cú-pháp-hash-partition/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

### Hash vs Linear Hash (MySQL)

| Aspect | HASH | LINEAR HASH |
|--------|------|-------------|
| **Distribution** | Very even | Slightly less even |
| **Add partition** | Requires reorganizing all data | Only ~50% data moves |
| **Remove partition** | Requires reorganizing all data | Only ~50% data moves |
| **Performance** | Better for queries | Similar |
| **Use case** | Fixed partition count | Need flexibility |

---

## 6. Key Partitioning

### Key Partitioning (chỉ MySQL)

Key partitioning is similar to hash partitioning, but MySQL manages the hashing algorithm internally. It can use columns that aren't integers.

```sql
-- MySQL: Key Partition (uses internal hash)
CREATE TABLE orders (
    order_id VARCHAR(36) NOT NULL,  -- UUID
    customer_email VARCHAR(255) NOT NULL,
    order_date DATE,
    PRIMARY KEY (order_id)
) PARTITION BY KEY (order_id) PARTITIONS 4;

-- Key partition with multiple columns
CREATE TABLE user_actions (
    user_id INT,
    action_type VARCHAR(50),
    action_date DATE,
    PRIMARY KEY (user_id, action_type, action_date)
) PARTITION BY KEY (user_id, action_type) PARTITIONS 8;

-- Key partition using primary key (no column specified)
CREATE TABLE items (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(100),
    PRIMARY KEY (id)
) PARTITION BY KEY () PARTITIONS 4;  -- Uses PRIMARY KEY
```

<SourceRef project="optimization-sql-partition-deep-dive" file="key-partitioning-chỉ-mysql/1.sql" variant="button">
Đối chiếu snippet trong Source Explorer
</SourceRef>

### So sánh Key và Hash Partitioning

| Aspect | KEY | HASH |
|--------|-----|------|
| **Column types** | Any type | Integer only (or expression) |
| **Algorithm** | MySQL internal (MD5-based) | User-visible MOD operation |
| **Multiple columns** | ✅ Yes | ❌ No (need expression) |
| **Predictability** | ❌ Cannot predict partition | ⚠️ Can calculate |
| **Primary key** | Can use PK implicitly | Must specify column |

---

## 7. Composite (Sub) Partitioning

### Composite Partitioning là gì?

Composite partitioning combines two partitioning methods. The table is first partitioned by one method, then each partition is further divided (subpartitioned) by another method.

```d2 title="Composite partition: RANGE rồi HASH"
direction: down
sales: sales
p2023: RANGE year 2023 {
  s0: sp0
  s1: sp1
  s2: sp2
  s3: sp3
}
p2024: RANGE year 2024 {
  s0: sp0
  s1: sp1 — đích trong ví dụ
  s2: sp2
  s3: sp3
}
p2025: RANGE year 2025 {
  s0: sp0
  s1: sp1
  s2: sp2
  s3: sp3
}
sales -> p2023
sales -> p2024
sales -> p2025
query: WHERE year = 2024 AND store_id = 5
query -> p2024.s1: pruning theo routing minh họa
```

Ba partition năm × bốn subpartition hash = 12 vùng dữ liệu. Với quy tắc hash trong ví dụ đưa store 5 tới sp1, query chỉ cần `p_2024_sp1`. Kiểm tra routing thực tế của engine, không mặc định mọi hash là `store_id % 4`.

### Cú pháp Composite Partition

```sql
-- MySQL: RANGE + HASH composite
CREATE TABLE sales (
    id BIGINT NOT NULL AUTO_INCREMENT,
    sale_date DATE NOT NULL,
    store_id INT NOT NULL,
    amount DECIMAL(10,2),
    PRIMARY KEY (id, sale_date, store_id)
)
PARTITION BY RANGE (YEAR(sale_date))
SUBPARTITION BY HASH (store_id)
SUBPARTITIONS 4 (
    PARTITION p_2022 VALUES LESS THAN (2023),
    PARTITION p_2023 VALUES LESS THAN (2024),
    PARTITION p_2024 VALUES LESS THAN (2025),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- MySQL: RANGE + LIST composite
CREATE TABLE orders (
    id BIGINT NOT NULL AUTO_INCREMENT,
    order_date DATE NOT NULL,
    region VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2),
    PRIMARY KEY (id, order_date, region)
)
PARTITION BY RANGE (YEAR(order_date))
SUBPARTITION BY LIST COLUMNS (region) (
    PARTITION p_2023 VALUES LESS THAN (2024) (
        SUBPARTITION p_2023_us VALUES IN ('US'),
        SUBPARTITION p_2023_eu VALUES IN ('UK', 'DE', 'FR'),
        SUBPARTITION p_2023_asia VALUES IN ('JP', 'CN')
    ),
    PARTITION p_2024 VALUES LESS THAN (2025) (
        SUBPARTITION p_2024_us VALUES IN ('US'),
        SUBPARTITION p_2024_eu VALUES IN ('UK', 'DE', 'FR'),
        SUBPARTITION p_2024_asia VALUES IN ('JP', 'CN')
    )
);
```

### Các trường hợp dùng Composite Partition

| Combination | Use Case | Example |
|-------------|----------|---------|
| **RANGE + HASH** | Time-series with even distribution | Logs by month, then hash by server_id |
| **RANGE + LIST** | Time-series with regional data | Sales by year, then by region |
| **LIST + HASH** | Categories with even distribution | Product type, then hash by product_id |

---

## 8. Partition Pruning

### Partition Pruning là gì?

**Partition pruning** is the database optimizer's ability to skip partitions that cannot contain matching rows. This is the PRIMARY performance benefit of partitioning.

```d2 title="Partition pruning loại bỏ vùng không liên quan"
direction: right
q1: "Q1: order_date = 2024-06-15"
q2: "Q2: 2023-01-01 ≤ order_date < 2024-07-01"
q3: "Q3: customer_id = 12345 — không lọc partition key"
p0: p_2020 — 20M
p1: p_2021 — 25M
p2: p_2022 — 30M
p3: p_2023 — 35M
p4: p_2024 — 40M
q1 -> p4
q2 -> p3
q2 -> p4
q3 -> p0
q3 -> p1
q3 -> p2
q3 -> p3
q3 -> p4
```

Tổng dữ liệu minh họa là 150 triệu rows. Q1 giữ partition 40M rows; Q2 giữ 35M + 40M = 75M rows; Q3 không loại bỏ partition bằng điều kiện `customer_id` này. Tỷ lệ 150/40 hoặc 150/75 chỉ mô tả lượng dữ liệu trong các partition, **không cam kết query nhanh hơn cùng tỷ lệ**; index trong partition còn có thể giảm lượng rows thực đọc.

### Điều kiện để Pruning hoạt động

| Condition Type | RANGE Partition | LIST Partition | HASH Partition |
|----------------|-----------------|----------------|----------------|
| `= value` | ✅ Yes | ✅ Yes | ✅ Yes |
| `IN (values)` | ✅ Yes | ✅ Yes | ✅ Yes |
| `< value` | ✅ Yes | ❌ No | ❌ No |
| `> value` | ✅ Yes | ❌ No | ❌ No |
| `BETWEEN a AND b` | ✅ Yes | ❌ No | ❌ No |
| `LIKE 'prefix%'` | ⚠️ Sometimes | ❌ No | ❌ No |
| `IS NULL` | ✅ Yes | ✅ Yes | ❌ No |
| Function on column | ❌ Usually No | ❌ No | ❌ No |

### Kiểm tra Partition Pruning

```sql
-- MySQL: Check which partitions will be scanned
EXPLAIN SELECT * FROM orders WHERE order_date = '2024-06-15';
-- Look for "partitions: p_2024" in output

EXPLAIN PARTITIONS SELECT * FROM orders WHERE order_date = '2024-06-15';
-- Explicit partition information

-- PostgreSQL: Check partition pruning
EXPLAIN (ANALYZE, COSTS OFF) 
SELECT * FROM orders WHERE order_date = '2024-06-15';
-- Output shows which child tables are scanned

-- PostgreSQL: Enable partition pruning (usually enabled by default)
SET enable_partition_pruning = on;
```

### Pruning KHÔNG hoạt động - Nguyên nhân thường gặp

```sql
-- ❌ Function on partition key prevents pruning
SELECT * FROM orders WHERE YEAR(order_date) = 2024;
-- Rewrite as:
SELECT * FROM orders 
WHERE order_date >= '2024-01-01' AND order_date < '2025-01-01';

-- ❌ Type mismatch prevents pruning
SELECT * FROM orders WHERE order_date = '2024-06-15 00:00:00';
-- If partition key is DATE, not DATETIME

-- ❌ OR condition may prevent pruning
SELECT * FROM orders 
WHERE order_date = '2024-01-01' OR customer_id = 100;
-- customer_id is not partition key - must scan all

-- ❌ Subquery may prevent pruning
SELECT * FROM orders 
WHERE order_date IN (SELECT max_date FROM some_table);
```

---

## 9. Partitioning vs Indexing

### Khi nào dùng cái nào

```d2 title="Index và partitioning giải quyết hai chiều khác nhau"
direction: right
indexing: Indexing {
  index: B-Tree — key + row locator
  table: Table data rows
  index -> table: lookup
}
partitioning: Partitioning {
  table: Logical table
  p1: Partition P1 data
  p2: Partition P2 data
  p3: Partition P3 data
  table -> p1
  table -> p2
  table -> p3
}
```

Index hướng tới lookup/access path; partitioning chia dữ liệu theo rule và hỗ trợ pruning/lifecycle. Có thể dùng **cả hai**: mỗi partition vẫn có indexes. Các ngưỡng “dưới 15%” hoặc “trên 10 GB” là kinh nghiệm minh họa, không phải điều kiện cần/đủ để một kỹ thuật có lợi.

### Bảng so sánh

| Khía cạnh | Indexing | Partitioning |
|--------|----------|--------------|
| **Primary purpose** | Speed up queries | Manage large data sets |
| **Data organization** | Separate structure | Divides table physically |
| **Query performance** | Any selective query | Only queries using partition key |
| **Write performance** | Slower (index update) | Similar or better |
| **Delete old data** | Slow (row by row) | Fast (drop partition) |
| **Storage overhead** | Additional space for index | Minimal overhead |
| **Maintenance** | Index rebuild | Partition add/drop/merge |
| **Parallelism** | Limited | Query parallel across partitions |

### Using Both Together

```sql
-- Best practice: Partition + Local Index

-- Step 1: Create partitioned table
CREATE TABLE orders (
    id BIGINT NOT NULL AUTO_INCREMENT,
    customer_id INT NOT NULL,
    order_date DATE NOT NULL,
    status VARCHAR(20),
    amount DECIMAL(10,2),
    PRIMARY KEY (id, order_date)
) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p_2023 VALUES LESS THAN (2024),
    PARTITION p_2024 VALUES LESS THAN (2025),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- Step 2: Add indexes for common queries
-- Local index (per partition) on customer_id
CREATE INDEX idx_customer ON orders(customer_id);

-- Local index on status
CREATE INDEX idx_status ON orders(status);

-- Query using both partition pruning AND index:
SELECT * FROM orders 
WHERE order_date >= '2024-01-01'   -- Partition pruning
  AND customer_id = 12345;          -- Index lookup within partition
```

---

## 10. Global vs Local Indexes

### Hiểu về Global vs Local Index

```d2 title="Local index và global index"
direction: down
local: Local indexes {
  p1: Partition 1 {
    index1: Index 1
    data1: Data
    index1 -> data1
  }
  p2: Partition 2 {
    index2: Index 2
    data2: Data
    index2 -> data2
  }
  p3: Partition 3 {
    index3: Index 3
    data3: Data
    index3 -> data3
  }
}
global: Global index — engine có hỗ trợ {
  index: customer_id → partition + row pointer
  p1: Partition 1 data
  p2: Partition 2 data
  p3: Partition 3 data
  index -> p1
  index -> p2
  index -> p3
}
```

Local index được duy trì theo partition; query không prune được có thể phải xét nhiều index. Global index bao phủ nhiều partition, nhưng partition maintenance còn phải xử lý tính hợp lệ của index toàn cục. **Oracle hỗ trợ global index; PostgreSQL core không có global index xuyên partition tương đương** — index trên partitioned table đại diện cho các index cục bộ của partition.

### Bảng so sánh

| Khía cạnh | Local Index | Global Index |
|--------|-------------|--------------|
| **Scope** | Per partition | Entire table |
| **Query without partition key** | Scans all partition indexes | Single index lookup |
| **Drop partition** | Fast (local index dropped too) | May invalidate global index |
| **Add partition** | Fast (new local index) | May need index update |
| **Maintenance** | Distributed | Centralized |
| **MySQL support** | ✅ Yes (only option) | ❌ No |
| **PostgreSQL support** | ✅ Yes (default) | ⚠️ Limited |
| **Oracle support** | ✅ Yes | ✅ Yes |

### MySQL: Tất cả Index đều là Local

```sql
-- MySQL only supports local (partition-wise) indexes
CREATE TABLE orders (
    id BIGINT NOT NULL AUTO_INCREMENT,
    customer_id INT NOT NULL,
    order_date DATE NOT NULL,
    PRIMARY KEY (id, order_date),  -- Must include partition key
    INDEX idx_customer (customer_id, order_date)  -- Local index
) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p_2023 VALUES LESS THAN (2024),
    PARTITION p_2024 VALUES LESS THAN (2025)
);

-- Query without partition key searches ALL local indexes
EXPLAIN SELECT * FROM orders WHERE customer_id = 100;
-- Shows: partitions: p_2023,p_2024 (both scanned)

-- Query WITH partition key uses partition pruning + local index
EXPLAIN SELECT * FROM orders 
WHERE customer_id = 100 AND order_date >= '2024-01-01';
-- Shows: partitions: p_2024 (only one scanned)
```

### PostgreSQL: Tạo Index dạng Global

```sql
-- PostgreSQL: Create index on parent table (behaves like local indexes)
CREATE TABLE orders (
    id BIGSERIAL,
    customer_id INT NOT NULL,
    order_date DATE NOT NULL
) PARTITION BY RANGE (order_date);

-- Create partitions
CREATE TABLE orders_2024 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- Index on parent creates local indexes on all partitions
CREATE INDEX idx_customer ON orders(customer_id);
-- This creates orders_2024_customer_id_idx automatically

-- For true global unique constraint (PostgreSQL 11+)
-- The unique constraint must include partition key
CREATE UNIQUE INDEX idx_unique ON orders(id, order_date);
```

---

## 11. Các lỗi thường gặp & Cách phòng tránh

### Lỗi 1: Chọn sai Partition Key

```sql
-- ❌ BAD: Partition by rarely-queried column
CREATE TABLE orders (...)
PARTITION BY RANGE (created_by_user_id);  -- Users rarely query by this!

-- Most queries are:
SELECT * FROM orders WHERE order_date = '2024-01-15';  -- No pruning!
SELECT * FROM orders WHERE customer_id = 100;  -- No pruning!

-- ✅ GOOD: Partition by commonly-queried column
CREATE TABLE orders (...)
PARTITION BY RANGE (YEAR(order_date));

-- Now date queries benefit from pruning
SELECT * FROM orders WHERE order_date = '2024-01-15';  -- Prunes to p_2024!
```

### Lỗi 2: Quá nhiều hoặc quá ít Partition

| Thiết kế minh họa cho 100M rows | Điểm cần xem xét |
| --- | --- |
| 2 partitions × 50M | Granularity lifecycle/pruning có thể còn thô |
| 1.000 partitions × 100K | Nhiều metadata, planning và file/resources overhead |
| 50 partitions × 2M | Một candidate cân bằng để benchmark |

Các khoảng 1–100M rows/partition, 1–50 GB/partition, 12–100 partitions hoặc monthly/quarterly là **heuristic**, không phải chuẩn bắt buộc. MySQL có giới hạn tổng số partitions/subpartitions theo engine/version (ví dụ thường gặp 8.192); PostgreSQL và các workload khác có giới hạn vận hành riêng. Chọn theo retention, pruning, maintenance, planning time và tài nguyên.

### Lỗi 3: Thiếu MAXVALUE/DEFAULT Partition

```sql
-- ❌ BAD: No catch-all partition
CREATE TABLE orders (...)
PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p_2023 VALUES LESS THAN (2024),
    PARTITION p_2024 VALUES LESS THAN (2025)
);

-- What happens when 2025 data arrives?
INSERT INTO orders (order_date) VALUES ('2025-01-15');
-- ERROR: Table has no partition for value 2025

-- ✅ GOOD: Include MAXVALUE partition
CREATE TABLE orders (...)
PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p_2023 VALUES LESS THAN (2024),
    PARTITION p_2024 VALUES LESS THAN (2025),
    PARTITION p_future VALUES LESS THAN MAXVALUE  -- Catch-all
);

-- PostgreSQL: DEFAULT partition
CREATE TABLE orders_default PARTITION OF orders DEFAULT;
```

### Lỗi 4: Primary Key không chứa Partition Key (MySQL)

```sql
-- ❌ BAD: MySQL requires partition key in primary key
CREATE TABLE orders (
    id INT PRIMARY KEY,  -- Error! partition key not included
    order_date DATE
) PARTITION BY RANGE (YEAR(order_date)) (...);
-- ERROR: A PRIMARY KEY must include all columns in the partition function

-- ✅ GOOD: Include partition key in primary key
CREATE TABLE orders (
    id INT,
    order_date DATE,
    PRIMARY KEY (id, order_date)  -- Both columns
) PARTITION BY RANGE (YEAR(order_date)) (...);

-- Or use a composite unique constraint
CREATE TABLE orders (
    id INT AUTO_INCREMENT,
    order_date DATE,
    PRIMARY KEY (id, order_date),
    UNIQUE KEY (id)  -- This won't work either!
) PARTITION BY RANGE (YEAR(order_date)) (...);
-- ERROR: UNIQUE KEY must include partition key too
```

### Lỗi 5: Query không dùng Partition Key

```sql
-- Setup: orders partitioned by order_date
CREATE TABLE orders (...) PARTITION BY RANGE (YEAR(order_date));

-- ❌ BAD: Query doesn't use partition key
SELECT * FROM orders WHERE customer_id = 100;
-- Scans ALL partitions! No pruning benefit.

-- ❌ BAD: Function on partition key
SELECT * FROM orders WHERE YEAR(order_date) = 2024;
-- May not prune in all databases

-- ✅ GOOD: Direct comparison on partition key
SELECT * FROM orders 
WHERE order_date >= '2024-01-01' AND order_date < '2025-01-01';
-- Prunes to p_2024 only

-- ✅ GOOD: Combine partition key with other filters
SELECT * FROM orders 
WHERE order_date >= '2024-01-01' 
  AND order_date < '2025-01-01'
  AND customer_id = 100;
-- Prunes to p_2024, then uses index on customer_id
```

### Lỗi 6: Không lên kế hoạch bảo trì Partition

```sql
-- ❌ BAD: No automation for new partitions
-- Table created in 2023 with partitions up to 2025
-- In 2025, application crashes because no partition exists!

-- ✅ GOOD: Schedule partition maintenance

-- Option 1: MAXVALUE partition + regular reorganization
-- Create with MAXVALUE
CREATE TABLE orders (...) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p_2024 VALUES LESS THAN (2025),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- Monthly cron job to add new partition:
-- ALTER TABLE orders REORGANIZE PARTITION p_future INTO (
--     PARTITION p_2025 VALUES LESS THAN (2026),
--     PARTITION p_future VALUES LESS THAN MAXVALUE
-- );

-- Option 2: PostgreSQL pg_partman extension
-- Automatically creates and maintains partitions
CREATE EXTENSION pg_partman;
SELECT partman.create_parent('public.orders', 'order_date', 'native', 'monthly');
```

### Bảng tóm tắt đầy đủ các lỗi

| Mistake | Symptom | Solution |
|---------|---------|----------|
| **Wrong partition key** | No pruning, full scans | Partition by commonly-queried column |
| **Too many partitions** | Slow planning, metadata overhead | Keep under 100-200 partitions |
| **Too few partitions** | Large partitions, limited benefit | Aim for 1-100M rows per partition |
| **No MAXVALUE/DEFAULT** | Insert errors for new data | Always include catch-all partition |
| **PK missing partition key** | MySQL error on create | Include partition key in all unique constraints |
| **Function on partition key** | No pruning | Use direct comparisons |
| **No maintenance plan** | Future inserts fail | Automate partition creation |
| **Cross-partition queries** | Full scans | Redesign schema or accept cost |

---

## 12. Ví dụ thực tế

### Ví dụ 1: Bảng đơn hàng E-Commerce

```sql
-- Scenario: 500M orders over 5 years
-- Requirements: 
--   - Fast queries for recent orders
--   - Easy archival of old data
--   - Monthly reporting

-- MySQL Implementation
CREATE TABLE orders (
    id BIGINT NOT NULL AUTO_INCREMENT,
    customer_id INT NOT NULL,
    order_date DATE NOT NULL,
    status ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled'),
    total_amount DECIMAL(10,2),
    shipping_address_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, order_date),
    INDEX idx_customer_date (customer_id, order_date),
    INDEX idx_status (status, order_date)
) PARTITION BY RANGE (TO_DAYS(order_date)) (
    PARTITION p_2022_q1 VALUES LESS THAN (TO_DAYS('2022-04-01')),
    PARTITION p_2022_q2 VALUES LESS THAN (TO_DAYS('2022-07-01')),
    PARTITION p_2022_q3 VALUES LESS THAN (TO_DAYS('2022-10-01')),
    PARTITION p_2022_q4 VALUES LESS THAN (TO_DAYS('2023-01-01')),
    PARTITION p_2023_q1 VALUES LESS THAN (TO_DAYS('2023-04-01')),
    PARTITION p_2023_q2 VALUES LESS THAN (TO_DAYS('2023-07-01')),
    PARTITION p_2023_q3 VALUES LESS THAN (TO_DAYS('2023-10-01')),
    PARTITION p_2023_q4 VALUES LESS THAN (TO_DAYS('2024-01-01')),
    PARTITION p_2024_q1 VALUES LESS THAN (TO_DAYS('2024-04-01')),
    PARTITION p_2024_q2 VALUES LESS THAN (TO_DAYS('2024-07-01')),
    PARTITION p_2024_q3 VALUES LESS THAN (TO_DAYS('2024-10-01')),
    PARTITION p_2024_q4 VALUES LESS THAN (TO_DAYS('2025-01-01')),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- Query for customer's recent orders (pruned to recent partitions)
SELECT * FROM orders 
WHERE customer_id = 12345 
  AND order_date >= '2024-01-01'
ORDER BY order_date DESC 
LIMIT 20;

-- Archive old data by dropping partition
ALTER TABLE orders DROP PARTITION p_2022_q1;
-- Instant! No DELETE needed
```

### Ví dụ 2: Ứng dụng SaaS Multi-Tenant

```sql
-- Scenario: SaaS with 100+ tenants
-- Requirements:
--   - Data isolation per tenant
--   - Easy tenant data deletion
--   - Fair resource distribution

-- PostgreSQL Implementation with LIST partitioning
CREATE TABLE tenant_data (
    id BIGSERIAL,
    tenant_id INT NOT NULL,
    data_type VARCHAR(50),
    payload JSONB,
    created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY LIST (tenant_id);

-- Create partition for each tenant
CREATE TABLE tenant_data_t1 PARTITION OF tenant_data FOR VALUES IN (1);
CREATE TABLE tenant_data_t2 PARTITION OF tenant_data FOR VALUES IN (2);
CREATE TABLE tenant_data_t3 PARTITION OF tenant_data FOR VALUES IN (3);
-- ... more tenants

-- Default for new tenants
CREATE TABLE tenant_data_default PARTITION OF tenant_data DEFAULT;

-- Each tenant's queries only hit their partition
SELECT * FROM tenant_data WHERE tenant_id = 1;
-- Scans only tenant_data_t1

-- Delete tenant = drop partition
DROP TABLE tenant_data_t3;  -- Instantly removes tenant 3's data
```

### Ví dụ 3: Log Time-Series với chính sách retention

```sql
-- Scenario: Application logs, 10M rows/day
-- Requirements:
--   - 90-day retention
--   - Fast recent queries
--   - Automated cleanup

-- MySQL Implementation with daily partitions
CREATE TABLE app_logs (
    id BIGINT NOT NULL AUTO_INCREMENT,
    log_date DATE NOT NULL,
    log_time TIME NOT NULL,
    level ENUM('DEBUG', 'INFO', 'WARN', 'ERROR'),
    service VARCHAR(50),
    message TEXT,
    metadata JSON,
    PRIMARY KEY (id, log_date),
    INDEX idx_level_date (level, log_date),
    INDEX idx_service_date (service, log_date)
) PARTITION BY RANGE (TO_DAYS(log_date)) (
    -- Generate 90+ daily partitions
    PARTITION p_20241001 VALUES LESS THAN (TO_DAYS('2024-10-02')),
    PARTITION p_20241002 VALUES LESS THAN (TO_DAYS('2024-10-03')),
    -- ... more days
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- Automated partition management script (run daily via cron)
-- 1. Add new partition for tomorrow
-- 2. Drop partition older than 90 days

-- Add tomorrow's partition
SET @tomorrow = DATE_ADD(CURDATE(), INTERVAL 1 DAY);
SET @day_after = DATE_ADD(CURDATE(), INTERVAL 2 DAY);
SET @part_name = CONCAT('p_', DATE_FORMAT(@tomorrow, '%Y%m%d'));

-- DROP old partition (90 days ago)
SET @old_date = DATE_SUB(CURDATE(), INTERVAL 90 DAY);
SET @old_part_name = CONCAT('p_', DATE_FORMAT(@old_date, '%Y%m%d'));
-- ALTER TABLE app_logs DROP PARTITION {old_part_name};
```

### Ví dụ 4: Phân bổ dữ liệu theo địa lý

```sql
-- Scenario: Global company with regional compliance
-- Requirements:
--   - Data residency by region
--   - Regional performance optimization
--   - Compliance reporting by region

-- Composite: LIST by region, then RANGE by date
CREATE TABLE customer_transactions (
    id BIGINT NOT NULL AUTO_INCREMENT,
    customer_id INT NOT NULL,
    region VARCHAR(10) NOT NULL,
    transaction_date DATE NOT NULL,
    amount DECIMAL(12,2),
    currency VARCHAR(3),
    PRIMARY KEY (id, region, transaction_date)
)
PARTITION BY LIST COLUMNS (region)
SUBPARTITION BY RANGE (TO_DAYS(transaction_date))
SUBPARTITIONS 12 (  -- Monthly subpartitions
    PARTITION p_americas VALUES IN ('US', 'CA', 'MX', 'BR') (
        SUBPARTITION p_americas_m01 VALUES LESS THAN (TO_DAYS('2024-02-01')),
        SUBPARTITION p_americas_m02 VALUES LESS THAN (TO_DAYS('2024-03-01')),
        -- ... more months
        SUBPARTITION p_americas_future VALUES LESS THAN MAXVALUE
    ),
    PARTITION p_europe VALUES IN ('UK', 'DE', 'FR', 'ES') (
        SUBPARTITION p_europe_m01 VALUES LESS THAN (TO_DAYS('2024-02-01')),
        SUBPARTITION p_europe_m02 VALUES LESS THAN (TO_DAYS('2024-03-01')),
        -- ... more months
        SUBPARTITION p_europe_future VALUES LESS THAN MAXVALUE
    ),
    PARTITION p_asia VALUES IN ('JP', 'CN', 'KR', 'SG') (
        SUBPARTITION p_asia_m01 VALUES LESS THAN (TO_DAYS('2024-02-01')),
        SUBPARTITION p_asia_m02 VALUES LESS THAN (TO_DAYS('2024-03-01')),
        -- ... more months
        SUBPARTITION p_asia_future VALUES LESS THAN MAXVALUE
    )
);

-- Query for European transactions in March
SELECT * FROM customer_transactions
WHERE region IN ('UK', 'DE', 'FR', 'ES')
  AND transaction_date >= '2024-03-01'
  AND transaction_date < '2024-04-01';
-- Scans only: p_europe_m03 subpartition
```

---

## 13. Thao tác bảo trì Partition

### Thêm Partition mới

```sql
-- MySQL: Add partition (requires MAXVALUE partition to reorganize)
ALTER TABLE orders REORGANIZE PARTITION p_future INTO (
    PARTITION p_2025_q1 VALUES LESS THAN (TO_DAYS('2025-04-01')),
    PARTITION p_2025_q2 VALUES LESS THAN (TO_DAYS('2025-07-01')),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- PostgreSQL: Simply create new partition
CREATE TABLE orders_2025_q1 PARTITION OF orders
    FOR VALUES FROM ('2025-01-01') TO ('2025-04-01');
```

### Xóa Partition cũ

```sql
-- MySQL: Drop partition (instant, no row-by-row delete)
ALTER TABLE orders DROP PARTITION p_2022_q1;

-- PostgreSQL: Drop partition table
DROP TABLE orders_2022_q1;
-- Or detach first (keeps data accessible)
ALTER TABLE orders DETACH PARTITION orders_2022_q1;
```

### Gộp Partition

```sql
-- MySQL: Merge adjacent partitions
ALTER TABLE orders REORGANIZE PARTITION p_2023_q1, p_2023_q2 INTO (
    PARTITION p_2023_h1 VALUES LESS THAN (TO_DAYS('2023-07-01'))
);
```

### Tách Partition

```sql
-- MySQL: Split a partition into smaller ones
ALTER TABLE orders REORGANIZE PARTITION p_2024 INTO (
    PARTITION p_2024_q1 VALUES LESS THAN (TO_DAYS('2024-04-01')),
    PARTITION p_2024_q2 VALUES LESS THAN (TO_DAYS('2024-07-01')),
    PARTITION p_2024_q3 VALUES LESS THAN (TO_DAYS('2024-10-01')),
    PARTITION p_2024_q4 VALUES LESS THAN (TO_DAYS('2025-01-01'))
);
```

### Exchange Partition (Nâng cao)

```sql
-- MySQL: Exchange partition with non-partitioned table
-- Useful for bulk loading

-- 1. Create staging table with same structure (no partitions)
CREATE TABLE orders_staging LIKE orders;
ALTER TABLE orders_staging REMOVE PARTITIONING;

-- 2. Bulk load data into staging
LOAD DATA INFILE 'orders_2024_q4.csv' INTO TABLE orders_staging;

-- 3. Exchange staging with partition (instant!)
ALTER TABLE orders EXCHANGE PARTITION p_2024_q4 WITH TABLE orders_staging;

-- PostgreSQL: ATTACH existing table as partition
CREATE TABLE orders_2024_q4 (...);  -- Non-partitioned
-- Load data into orders_2024_q4
ALTER TABLE orders ATTACH PARTITION orders_2024_q4
    FOR VALUES FROM ('2024-10-01') TO ('2025-01-01');
```

### Tóm tắt thao tác bảo trì

| Operation | MySQL Syntax | PostgreSQL Syntax | Notes |
|-----------|--------------|-------------------|-------|
| **Add partition** | `REORGANIZE PARTITION` | `CREATE ... PARTITION OF` | MySQL needs MAXVALUE to reorganize |
| **Drop partition** | `DROP PARTITION` | `DROP TABLE` partition | Data deleted instantly |
| **Detach partition** | Not available | `DETACH PARTITION` | Keeps data accessible |
| **Merge partitions** | `REORGANIZE PARTITION` | Not available | Combine adjacent partitions |
| **Split partition** | `REORGANIZE PARTITION` | Manual | Create new, move data |
| **Exchange partition** | `EXCHANGE PARTITION` | `ATTACH PARTITION` | Bulk load pattern |
| **Truncate partition** | `TRUNCATE PARTITION` | `TRUNCATE` partition table | Remove all data |

---

## 14. Best Practices

### Checklist thiết kế Partition

**Trước khi triển khai:**

- [ ] Workload/lifecycle có lợi từ partitioning? Không chỉ dựa trên ngưỡng dung lượng.
- [ ] Chọn partition key theo predicates, phân bố và retention.
- [ ] Ước lượng số partitions từ kỳ retention và maintenance, đo planning overhead.

**Schema:**

- [ ] Primary/unique constraints đáp ứng quy tắc partition key của engine.
- [ ] Có MAXVALUE/DEFAULT hoặc quy trình từ chối/route ngoài khoảng theo yêu cầu.
- [ ] Tạo local indexes phù hợp; xác nhận hỗ trợ global index nếu muốn dùng.
- [ ] Hạn chế cập nhật partition key nếu việc di chuyển row đắt.

**Vận hành:**

- [ ] Tự động tạo partitions, ví dụ scheduler/pg_partman khi phù hợp.
- [ ] Có lịch drop/archive theo retention và backup/restore đã thử.
- [ ] Theo dõi size/skew, metadata và planning time.
- [ ] EXPLAIN xác nhận pruning, không chỉ thấy DDL partition.
- [ ] Đo cross-partition queries và write cost.

### Mẹo hiệu năng

| Tip | Explanation |
|-----|-------------|
| **Always include partition key in queries** | Enables partition pruning |
| **Use direct comparisons, not functions** | `date >= '2024-01-01'` not `YEAR(date) = 2024` |
| **Keep partition count reasonable** | 10-200 partitions typically |
| **Monitor partition sizes** | Uneven sizes indicate poor key choice |
| **Index within partitions** | Local indexes still improve query speed |
| **Use covering indexes** | Avoid table access after index scan |
| **Batch cross-partition operations** | Full scans are expensive |

### Các pattern SQL thường dùng

```sql
-- ✅ GOOD: Query with partition key
SELECT * FROM orders 
WHERE order_date >= '2024-01-01' AND order_date < '2024-02-01'
  AND status = 'pending';

-- ✅ GOOD: Aggregate with partition pruning
SELECT DATE(order_date) as day, COUNT(*), SUM(amount)
FROM orders
WHERE order_date >= '2024-01-01' AND order_date < '2024-02-01'
GROUP BY DATE(order_date);

-- ⚠️ CAUTION: Cross-partition join (may scan all)
SELECT o.*, c.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE c.region = 'US';
-- Better: Add order_date filter if possible

-- ✅ GOOD: DELETE old data (drop partition)
ALTER TABLE orders DROP PARTITION p_2022_q1;

-- ❌ BAD: DELETE without partition key
DELETE FROM orders WHERE status = 'cancelled';
-- Scans all partitions!

-- ✅ GOOD: DELETE with partition key
DELETE FROM orders 
WHERE order_date < '2023-01-01' AND status = 'cancelled';
-- Prunes to old partitions
```

---

## Thẻ tham chiếu nhanh

### Chọn loại Partition

```d2 title="Chọn loại Partition"
direction: down
A: "Choose Partition Type"
B: "Data has time component?" { shape: diamond }
C: "RANGE by date/timestamp"
D: "Discrete categories?" { shape: diamond }
E: "LIST by category"
F: "Need even distribution?" { shape: diamond }
G: "HASH by ID"
H: "Reconsider partitioning"
A -> B
B -> C: "Yes"
B -> D: "No"
D -> E: "Yes"
D -> F: "No"
F -> G: "Yes"
F -> H: "No"
```

### Cú pháp tham chiếu nhanh

```sql
-- RANGE (MySQL)
PARTITION BY RANGE (YEAR(date_col)) (
    PARTITION p1 VALUES LESS THAN (2024),
    PARTITION p2 VALUES LESS THAN MAXVALUE
);

-- RANGE (PostgreSQL)
PARTITION BY RANGE (date_col);
CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');

-- LIST (MySQL)
PARTITION BY LIST COLUMNS (region) (
    PARTITION p_us VALUES IN ('US', 'CA'),
    PARTITION p_eu VALUES IN ('UK', 'DE')
);

-- LIST (PostgreSQL)
PARTITION BY LIST (region);
CREATE TABLE t_us PARTITION OF t FOR VALUES IN ('US', 'CA');

-- HASH (MySQL)
PARTITION BY HASH (user_id) PARTITIONS 4;

-- HASH (PostgreSQL)
PARTITION BY HASH (user_id);
CREATE TABLE t_p0 PARTITION OF t FOR VALUES WITH (MODULUS 4, REMAINDER 0);
```

### Cheat Sheet thao tác Partition

| Task | MySQL | PostgreSQL |
|------|-------|------------|
| Add partition | `REORGANIZE PARTITION` | `CREATE ... PARTITION OF` |
| Drop partition | `ALTER ... DROP PARTITION` | `DROP TABLE` |
| List partitions | `SHOW CREATE TABLE` | `\d+ table_name` |
| Check pruning | `EXPLAIN PARTITIONS` | `EXPLAIN ANALYZE` |
| Truncate partition | `ALTER ... TRUNCATE PARTITION` | `TRUNCATE` partition |

---

## Tổng kết

> **Nguyên tắc vàng của Partitioning:**
> 1. Chỉ partition bảng lớn (>10GB) với partition key rõ ràng
> 2. Chọn partition key dựa trên query pattern, không chỉ cấu trúc dữ liệu
> 3. Luôn có MAXVALUE/DEFAULT partition để an toàn
> 4. Bao gồm partition key trong WHERE để pruning hoạt động
> 5. Lên kế hoạch automation bảo trì trước khi go live
> 6. Giám sát kích thước partition để đảm bảo cân bằng
> 7. Kết hợp với index để đạt hiệu năng tốt nhất
> 8. Dùng DROP PARTITION thay vì DELETE cho dữ liệu cũ
