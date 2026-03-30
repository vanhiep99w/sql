---
title: "Index trong SQL"
description: "Tìm hiểu về Index — khái niệm, cấu trúc lưu trữ, B-Tree, Clustered vs Non-Clustered Index"
---

## Mục lục

- [Khái niệm & mục đích của Index](#khái-niệm--mục-đích-của-index)
- [Cấu trúc lưu trữ phổ biến của Index](#cấu-trúc-lưu-trữ-phổ-biến-của-index)
- [Cơ chế hoạt động của B-Tree Index](#cơ-chế-hoạt-động-của-b-tree-index)

---

## Khái niệm & mục đích của Index

- Index (chỉ mục) trong SQL là cấu trúc dữ liệu đặc biệt mà database sử dụng để tăng tốc độ truy xuất dữ liệu trên bảng.
- Nó hoạt động tương tự như mục lục (index) của một quyển sách.
  | Lợi ích | Giải thích |
  | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | 🚀 **Tăng tốc truy vấn SELECT** | DB không phải đọc toàn bộ bảng (full table scan) mà chỉ đọc vùng cần. |
  | 🔎 **Hỗ trợ tìm kiếm theo điều kiện (WHERE)** | Đặc biệt hiệu quả với các cột thường được lọc (`id`, `email`, `status`, `created_at`). |
  | 🧮 **Tăng tốc JOIN, GROUP BY, ORDER BY** | Vì index đã sắp xếp dữ liệu sẵn theo key, DB giảm chi phí sort hoặc hash. |
  | 📈 **Cải thiện hiệu năng khi dùng UNIQUE constraint** | UNIQUE index giúp kiểm tra trùng lặp nhanh hơn. |

### Khi nào nên và không nên tạo Index

- Cột thường xuất hiện trong WHERE, JOIN, ORDER BY, GROUP BY.
- Cột có độ chọn lọc cao (selectivity cao) → nhiều giá trị khác nhau (ví dụ email, user_id).
- Bảng có số lượng bản ghi lớn (hàng trăm ngàn đến hàng triệu dòng).

### Không nên tạo Index khi:

| Trường hợp                                                              | Lý do                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Cột có **ít giá trị lặp lại** (ví dụ `is_active` = true/false)          | DB phải đọc gần hết bảng dù có index.                                  |
| Bảng **nhỏ** (vài trăm dòng)                                            | Full scan nhanh hơn lookup index.                                      |
| Cột **thường xuyên cập nhật**                                           | Mỗi lần INSERT/UPDATE/DELETE, DB phải cập nhật index → tốn tài nguyên. |
| Cột **dùng cho tính toán tạm** (ví dụ `age = YEAR(NOW()) - birth_year`) | DB không dùng index vì phải tính lại giá trị.                          |

- Các loại index cơ bản (giới thiệu sơ bộ)
  | Loại index | Đặc điểm chính | DB hỗ trợ |
  | -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
  | **B-Tree (Balanced Tree)** | Mặc định trong hầu hết DBMS. Tốt cho truy vấn `<`, `>`, `BETWEEN`, `=`. | MySQL, PostgreSQL, Oracle |
  | **Hash Index** | Tối ưu cho `=` (so sánh bằng). Không dùng cho `>` hoặc `ORDER BY`. | PostgreSQL (Memory Engine) |
  | **Bitmap Index** | Lưu trữ bit cho mỗi giá trị — tốt cho cột có ít giá trị distinct. | Oracle, PostgreSQL |
  | **Full-text Index** | Tìm kiếm văn bản tự nhiên (`MATCH ... AGAINST`). | MySQL, PostgreSQL |
  | **GiST / GIN / BRIN** | Các dạng nâng cao trong PostgreSQL cho dữ liệu không truyền thống (JSON, vector, spatial). | PostgreSQL |

## CẤU TRÚC LƯU TRỮ PHỔ BIẾN CỦA INDEX

### Tổng quan các loại cấu trúc lưu trữ

| Loại index            | Đặc trưng                                                 | Dạng dữ liệu hỗ trợ tốt                               | Mức độ phổ biến                                             |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| **B-Tree Index**      | Dạng cây cân bằng; các node chứa key + pointer.           | Tìm kiếm, sắp xếp, range query (`<`, `>`, `BETWEEN`). | 🔥 Rất phổ biến (mặc định trong MySQL, PostgreSQL, Oracle). |
| **Hash Index**        | Dựa trên hàm băm (hash function).                         | So sánh bằng (`=`).                                   | Thường chỉ dùng trong memory engine hoặc PostgreSQL.        |
| **Bitmap Index**      | Lưu trữ bit vector cho mỗi giá trị.                       | Cột có ít giá trị lặp (giới tính, trạng thái).        | Oracle, PostgreSQL.                                         |
| **GiST / GIN / BRIN** | Dành cho dữ liệu đặc biệt (JSON, vector, spatial, range). | Tìm kiếm full-text, khoảng, tọa độ.                   | PostgreSQL.                                                 |

### Cấu trúc của B-Tree Index

- "B-Tree" = Balanced Tree — cây cân bằng.
- Mỗi node chứa:
  - Một số key (giá trị của cột được index).
  - Các pointer (con trỏ) đến node con hoặc tới dữ liệu thực (row).

```css
                 [50]
                /    \
          [20, 30]   [60, 70, 80]
/* Ví dụ tìm giá trị 70: */
/* So sánh với 50 → lớn hơn → đi sang nhánh phải. */
/* Trong node [60, 70, 80] → thấy 70 → trỏ đến dòng thật trong bảng. */
```

### Clustered Index — "Index chính"

- Clustered Index là cách sắp xếp vật lý của bảng.
- Dữ liệu trong bảng được lưu theo thứ tự của key trong index.
  - Nói cách khác: bản thân bảng là index.
- clustered Index là một dạng B-Tree (hoặc B+-Tree) được xây trên cột PRIMARY KEY (hoặc cột được chỉ định làm clustered index).
  | Thuộc tính | Giá trị |
  | ------------------ | -------------------------------------------------------- |
  | Số lượng | Mỗi bảng **chỉ có 1** clustered index. |
  | Cấu trúc | Leaf node chứa **dữ liệu thực tế** (không phải pointer). |
  | Khi không khai báo | DB tự chọn primary key (hoặc tạo hidden clustered key). |

### Non-Clustered Index — "Bảng phụ song song"

- Non-Clustered Index là cấu trúc riêng biệt (bảng phụ) chứa key và con trỏ đến dòng thực tế.
- Dữ liệu không bị sắp xếp lại trong bảng chính.
  | Tiêu chí | Clustered Index | Non-Clustered Index |
  | ------------------------------- | --------------------------------- | --------------------------------------------- |
  | Tổ chức dữ liệu | Dữ liệu thật nằm trong leaf node. | Leaf node chứa pointer đến dữ liệu. |
  | Thứ tự vật lý của bảng | Theo key của index. | Không thay đổi thứ tự bảng. |
  | Số lượng tối đa | 1 | Nhiều (tuỳ DBMS). |
  | Truy vấn `SELECT ... WHERE key` | Rất nhanh (1 bước). | Chậm hơn (2 bước: tìm pointer → lấy dữ liệu). |
  | Dung lượng | Ít hơn | Nhiều hơn (vì lưu pointer). |
  | Tác động khi INSERT | Có thể sắp xếp lại dữ liệu. | Chỉ thêm entry mới vào index. |
  | Dùng cho `ORDER BY`, `GROUP BY` | Tối ưu hơn. | Phải sort thêm. |

## CƠ CHẾ HOẠT ĐỘNG CỦA B-TREE INDEX

- Một B-Tree index (thường là B+Tree trong MySQL InnoDB, PostgreSQL, Oracle) được chia thành các node (page).

```css
               [Root Node]
                   │
         ┌─────────┴─────────┐
     [Internal Node] ... [Internal Node]
           │                     │
     ┌─────┴─────┐         ┌─────┴─────┐
  [Leaf Node]  [Leaf Node]  [Leaf Node]  ...
```

### Các loại node trong B+Tree

| Loại node | Vai trò |
| -------------- | ----------------------------------------------------------------------- |
| **Root Node** | Node gốc, điểm khởi đầu tìm kiếm. |
| **Internal Node** | Chứa key để định hướng (không chứa dữ liệu thực). |
| **Leaf Node** | Chứa key + dữ liệu thực (hoặc pointer tới row). Các leaf node liên kết với nhau thành linked list — hỗ trợ range scan hiệu quả. |

### Quy trình tìm kiếm trong B+Tree

Ví dụ tìm `id = 42` trong bảng có B+Tree index:

```
1. Bắt đầu từ Root Node
2. So sánh 42 với các key trong root → đi theo nhánh phù hợp
3. Duyệt qua Internal Node (mỗi bước loại bỏ một nửa tập dữ liệu)
4. Đến Leaf Node chứa key = 42 → lấy pointer (rowid / primary key)
5. Dùng pointer để fetch dữ liệu thực từ bảng
```

- Độ phức tạp: **O(log n)** — bảng 1 triệu dòng chỉ cần ~20 bước so sánh.

### Range Scan với B+Tree

Vì các Leaf Node được liên kết thành linked list, truy vấn range rất hiệu quả:

```sql
SELECT * FROM orders WHERE created_at BETWEEN '2024-01-01' AND '2024-03-31';
```

```
1. Tìm Leaf Node chứa '2024-01-01' → O(log n)
2. Duyệt sang phải qua linked list cho đến khi vượt '2024-03-31' → O(k)
   (k = số dòng trong range)
```

### Chi phí bảo trì Index

Index không miễn phí — mỗi thao tác ghi đều phải cập nhật index:

| Thao tác | Chi phí |
| --------- | ----------------------------------------------------------------------- |
| `INSERT` | Thêm entry vào index, có thể gây **page split** nếu node đầy. |
| `DELETE` | Đánh dấu entry đã xóa, có thể gây **page merge**. |
| `UPDATE` | Xóa entry cũ + thêm entry mới trong index. |

> **Page split** là khi một node B+Tree đầy, DB phải chia node thành 2 → tốn I/O và có thể gây index fragmentation theo thời gian.
