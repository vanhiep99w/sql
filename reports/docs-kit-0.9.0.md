# Kiểm kê docs-kit 0.9.0 — SQL

## Mục lục

- [Phạm vi và kết quả](#phạm-vi-và-kết-quả)
- [Theo từng bài](#theo-từng-bài)
- [Phân loại artifact](#phân-loại-artifact)
- [Giới hạn](#giới-hạn)

## Phạm vi và kết quả

Kiểm kê toàn bộ **45 bài** trong nguồn chuẩn `content/docs`, kể cả fence lồng trong callout/list. Tái tạo bằng `npm run docs:audit -- --write`; kiểm tra snapshot bằng `npm run docs:audit`.

- **376 D2**, Mermaid/diagram fence hoặc Mermaid component: **0**.
- **5 learning components** được dùng: `code-walkthrough`: 1, `code-diff`: 1, `terminal-session`: 1, `protocol-exchange`: 1, `span-waterfall`: 1.
- **101 text artifact có dấu hiệu đồ họa đã review**, không còn candidate chưa phân loại. Hash/nội dung đầu/lý do riêng từng khối: `scripts/diagram-text-exceptions.json`.
- Đợt này chuyển 8 khối đồ họa còn trong ngoại lệ cũ: MVCC ID timeline; leaf linkage; encoded-key flow; checkpoint/WAL sparkline; join complexity plot; 2 layout UUID; planner cost plot. Các đồ thị định tính chuyển thành quan hệ/công thức, không giả vờ có tỷ lệ đo.
- MySQL/PostgreSQL dùng logo từ [D2 Icon Catalog](https://icons.d2lang.com/), lưu local với provenance/SHA-256; renderer nhúng vào SVG light/dark. Không cần gọi catalog lúc đọc.
- URL bài, frontmatter và meta.json giữ nguyên. Source Explorer giữ provider, reference validator và các deep link hiện có; extractor đọc cả snapshot walkthrough, after/before diff và command terminal.

## Theo từng bài

| Bài | D2 | Learning | Artifact đã review |
|---|---:|---:|---:|
| `comparison/mysql-vs-postgresql.md` | 2 | 0 | 0 |
| `fundamentals/acid-transaction.md` | 11 | 0 | 0 |
| `fundamentals/application-concurrency-locking.md` | 6 | 2 | 0 |
| `fundamentals/delete-vs-truncate.md` | 11 | 0 | 1 |
| `fundamentals/isolation-levels.md` | 10 | 0 | 3 |
| `fundamentals/join-deep-dive.md` | 7 | 0 | 10 |
| `fundamentals/lock.md` | 8 | 0 | 0 |
| `fundamentals/locking-isolation-relationship.md` | 22 | 0 | 1 |
| `fundamentals/mvcc.md` | 13 | 0 | 1 |
| `fundamentals/query-execution-order.md` | 4 | 0 | 0 |
| `fundamentals/sql-overview.md` | 2 | 0 | 0 |
| `fundamentals/subquery-vs-cte-vs-temp-table.md` | 3 | 0 | 8 |
| `fundamentals/view-vs-materialized-view.md` | 8 | 0 | 0 |
| `interview/add-column-large-table-zero-downtime.md` | 8 | 0 | 0 |
| `interview/fast-staging-slow-production.md` | 6 | 0 | 0 |
| `interview/first-query-slow-cold-cache.md` | 7 | 1 | 2 |
| `interview/for-update-skip-locked.md` | 8 | 0 | 0 |
| `interview/in-vs-exists-vs-join.md` | 5 | 0 | 1 |
| `interview/index-not-used-seq-scan.md` | 3 | 0 | 1 |
| `interview/logical-vs-physical-query-execution.md` | 11 | 0 | 2 |
| `interview/offset-pagination-slow.md` | 2 | 0 | 2 |
| `interview/postgresql-connection-exhaustion.md` | 12 | 0 | 0 |
| `interview/read-explain-analyze-postgresql.md` | 2 | 0 | 2 |
| `interview/select-count-slow.md` | 3 | 0 | 2 |
| `interview/select-star-vs-columns.md` | 3 | 0 | 4 |
| `interview/sharding-at-scale.md` | 12 | 0 | 1 |
| `mysql/innodb.md` | 7 | 0 | 0 |
| `mysql/replication.md` | 8 | 0 | 0 |
| `optimization/b-plus-tree-deep-dive.md` | 26 | 0 | 0 |
| `optimization/clustered-vs-nonclustered-index.md` | 14 | 0 | 0 |
| `optimization/composite-index-deep-dive.md` | 10 | 0 | 18 |
| `optimization/dml-index-impact-deep-dive.md` | 16 | 0 | 1 |
| `optimization/explain-analyze-deep-dive.md` | 2 | 0 | 15 |
| `optimization/index-sql-deep-dive.md` | 25 | 0 | 0 |
| `optimization/join-algorithms-deep-dive.md` | 10 | 0 | 5 |
| `optimization/like-query-deep-dive.md` | 11 | 0 | 3 |
| `optimization/monitoring-slow-query-deep-dive.md` | 2 | 1 | 3 |
| `optimization/primary-key-uuid-vs-integer-deep-dive.md` | 16 | 0 | 0 |
| `optimization/query-optimization-patterns.md` | 9 | 1 | 12 |
| `optimization/sql-partition-deep-dive.md` | 11 | 0 | 0 |
| `optimization/statistics-query-planner-deep-dive.md` | 4 | 0 | 3 |
| `oracle/architecture.md` | 3 | 0 | 0 |
| `oracle/plsql.md` | 0 | 0 | 0 |
| `postgresql/interview.md` | 1 | 0 | 0 |
| `postgresql/vacuum.md` | 12 | 0 | 0 |

## Phân loại artifact

Giữ code, log, HTTP/JSON payload, EXPLAIN tree, bảng dữ liệu/kết quả, checklist và biểu thức số dưới dạng text/code. Dấu `->` trong execution plan hay chú thích `←` không biến output thành sơ đồ. Không dùng exception cho timeline, sparkline hoặc quan hệ leaf/field; những khối đó đã chuyển D2. Việc tăng số ngoại lệ từ bản cũ đến từ mở rộng detector cho mũi tên ASCII, dấu chú thích hai chiều và marker Unicode, không phải thêm sơ đồ mới.

## Giới hạn

Detector là công cụ hỗ trợ, không chứng minh semantics. Các text fences đã được đọc để phân biệt artifact với hình vẽ; kiểm thử ngăn ngoại lệ cũ/stale hoặc khối mới chưa review. Số đo có sẵn trong bài không được tái đo; SpanWaterfall được gắn provenance illustrative. Build/browser smoke xác minh render và tương tác, không xác minh mọi SQL lab trên các database thật hay deployment Cloudflare.
