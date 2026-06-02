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

## Cấu trúc lưu trữ phổ biến của Index

| Loại index            | Đặc trưng                                                 | Dạng dữ liệu hỗ trợ tốt                               | Mức độ phổ biến                                             |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| **B-Tree Index**      | Dạng cây cân bằng; các node chứa key + pointer.           | Tìm kiếm, sắp xếp, range query (`<`, `>`, `BETWEEN`). | 🔥 Rất phổ biến (mặc định trong MySQL, PostgreSQL, Oracle). |
| **Hash Index**        | Dựa trên hàm băm (hash function).                         | So sánh bằng (`=`).                                   | Thường chỉ dùng trong memory engine hoặc PostgreSQL.        |
| **Bitmap Index**      | Lưu trữ bit vector cho mỗi giá trị.                       | Cột có ít giá trị lặp (giới tính, trạng thái).        | Oracle, PostgreSQL.                                         |
| **GiST / GIN / BRIN** | Dành cho dữ liệu đặc biệt (JSON, vector, spatial, range). | Tìm kiếm full-text, khoảng, tọa độ.                   | PostgreSQL.                                                 |

## Cơ chế hoạt động của B-Tree Index

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

### Chi phí bảo trì Index

Index không miễn phí — mỗi thao tác ghi đều phải cập nhật index:

| Thao tác | Chi phí |
| --------- | ----------------------------------------------------------------------- |
| `INSERT` | Thêm entry vào index, có thể gây **page split** nếu node đầy. |
| `DELETE` | Đánh dấu entry đã xóa, có thể gây **page merge**. |
| `UPDATE` | Xóa entry cũ + thêm entry mới trong index. |

> **Page split** là khi một node B+Tree đầy, DB phải chia node thành 2 → tốn I/O và có thể gây index fragmentation theo thời gian.

---

> [!TIP]
> Bài này giới thiệu nền tảng về Index. Để tìm hiểu sâu hơn về **Composite Index, Covering Index, EXPLAIN, Selectivity, các lỗi thường gặp**, và **ví dụ thực tế**, hãy đọc bài [Index SQL — Deep Dive](/docs/optimization/index-sql-deep-dive).
