# SQL Learning

Tài liệu học SQL tiếng Việt — MySQL, PostgreSQL, Oracle. Next.js 16, Fumadocs và static export lên Cloudflare Pages.

## Mục lục

- [Phát triển và kiểm tra](#phát-triển-và-kiểm-tra)
- [Sơ đồ D2](#sơ-đồ-d2)
- [Learning components](#learning-components)
- [Kiểm kê và giới hạn](#kiểm-kê-và-giới-hạn)
- [Source Explorer](#source-explorer)
- [Deploy](#deploy)

## Phát triển và kiểm tra

Yêu cầu **Node.js 22 trở lên**. Không cần D2 CLI, Go hay Java.

```bash
npm ci
npm run dev
```

```bash
npm test                 # Parser, references, learning descriptors/MDX và text/ASCII
npm run typecheck
npm run docs:audit       # Snapshot kiểm kê 45 bài; không tự thêm exception
npm run diagrams:check   # Kiểm tra ASCII còn lại; render mọi D2, kể cả trong callout/list
npm run build            # Sinh source assets, compile docs, static export
npx playwright install chromium  # Chỉ lần đầu trên môi trường chưa có browser
npm run test:browser     # Chromium smoke trên dist/; cần Python 3
```

`predev` và `prebuild` tự chạy `npm run sources:build`. Sau khi sửa code trong bài khi dev server đang chạy, chạy lại `npm run sources:build` và mở lại drawer để đọc assets mới. Output website ở `dist/`; không commit output hay cache.

## Sơ đồ D2

Dùng [`@vanhiep99w/docs-kit@0.12.0`](https://www.npmjs.com/package/@vanhiep99w/docs-kit). `remarkD2` trong `source.config.ts` render SVG lúc build; `D2Diagram` và `D2InteractiveDiagram` được đăng ký tại `src/app/[[...slug]]/page.tsx`. Không đưa renderer/WASM vào client bundle. Light/dark theo theme của website.

````md
```d2 title="Refresh và đọc báo cáo"
direction: right
job: Job refresh
source: Bảng nguồn { shape: cylinder }
mv: MV — kết quả đã lưu { shape: cylinder }
reader: Người đọc
job -> source: đọc snapshot
source -> mv: công bố kết quả
reader -> mv: SELECT
```
````

Dùng tên node không trùng từ khóa D2 như `left`, `right`, `fill`. Đặt caption có ý nghĩa bằng `title`. Nhãn ngắn, có thể xuống dòng bằng `\n`; luồng dài nên tách giai đoạn hoặc dùng `direction: down`. Có thể chọn `layout="elk"`, `"dagre"`, `"tala"` riêng trên fence; mặc định ELK.

D2 thay flowchart, sequence/state diagram, kiến trúc, quan hệ cây và các timeline có thể biểu diễn chính xác bằng sequence diagram. **Giữ text** cho execution plan, log, bảng kết quả và payload/byte literal cần đối chiếu. Layout bit, timeline, sparkline và đồ thị giải thích định tính phải chuyển sang D2 kèm công thức/bảng giá trị; không giả vờ cạnh D2 có tỷ lệ định lượng. Các bảng so sánh/checklist chỉ bọc khung ASCII nên đổi sang Markdown, không ép thành graph. Mermaid runtime và plugin cũ đã được bỏ.

`npm run diagrams:check` duyệt cả các block lồng trong callout/list. Các khối text có dấu hiệu sơ đồ nhưng cần giữ được ghi tại `scripts/diagram-text-exceptions.json`, với file, content hash và lý do. Thêm/sửa khối ASCII có dấu hiệu sơ đồ sẽ yêu cầu rà soát lại; xóa/chuyển một khối cũng cần bỏ exception đã cũ. Đây là kiểm tra hỗ trợ review, không phải bộ phân loại tự động thay cho đọc nội dung. Khi chỉnh một bảng kết quả hoặc output được giữ lại, xác nhận lý do giữ vẫn đúng trước khi cập nhật hash; đừng tự thêm exception chỉ để test qua.

Cache D2 ở `.next/cache/docs-kit/d2`, nằm trong đường dẫn cache Next.js mà Cloudflare Pages hỗ trợ. Cache giúp build nhanh hơn nhưng không phải output để deploy; cần bật Build cache trong dashboard.

Logo MySQL/PostgreSQL lấy từ [D2 Icon Catalog](https://icons.d2lang.com/), lưu tại `content/diagram-assets/` cùng URL nguồn, SHA-256 và giấy phép. `assetsRoot` được allowlist đúng thư mục này trong host và focused checker; dùng đường dẫn tương đối từ bài để nhúng icon vào SVG lúc build. Không cần request tới catalog lúc đọc. Không gán logo hãng cho database trừu tượng.

## Learning components

Cả plugin trong `source.config.ts`, component map tại `src/app/[[...slug]]/page.tsx` và CSS tại `src/app/globals.css` đều phải được đăng ký. Dùng fence YAML, không tự tạo prepared props/SVG:

| Fence | Câu hỏi giải thích | Bài đang dùng |
|---|---|---|
| `code-walkthrough` | Vì sao predicate/version phải cập nhật trong một lệnh? | [Application concurrency](content/docs/fundamentals/application-concurrency-locking.md) |
| `code-diff` | Predicate đổi chính xác ở đâu? | [Query patterns](content/docs/optimization/query-optimization-patterns.md) |
| `terminal-session` | Chạy ở host nào và kiểm tra kết quả gì? | [Monitoring](content/docs/optimization/monitoring-slow-query-deep-dive.md) |
| `protocol-exchange` | Contract ETag/412 khác JSON version/409 thế nào? | [Application concurrency](content/docs/fundamentals/application-concurrency-locking.md) |
| `span-waterfall` | Latency giả định phân bổ vào các khoảng nào? | [Cold cache](content/docs/interview/first-query-slow-cold-cache.md) |

Các viewer không chạy SQL/shell/HTTP và không tự thu trace. Timing minh họa có `provenance.kind: illustrative`; output mong đợi của terminal không phải bằng chứng đã chạy lệnh. Giữ nội dung giải thích quan trọng ngoài descriptor; compact UI không hiện mọi metadata cũ.

## Kiểm kê và giới hạn

[Kiểm kê từng bài](reports/docs-kit-0.9.0.md): 45 bài, 376 D2, đủ 5 learning components; không còn Mermaid/ASCII diagram đã nhận diện nhưng chưa chuyển. 101 text artifact có dấu đồ họa được giữ với hash và lý do riêng (chủ yếu EXPLAIN, bảng kết quả và chú thích), không phải sơ đồ chưa chuyển.

`npm run docs:audit` đối chiếu snapshot, không tự cập nhật ngoại lệ. Sau khi review thay đổi thật, dùng `npm run docs:audit -- --write`. Detector là hỗ trợ review, không phải bộ phân loại ngữ nghĩa. Một số heading cũ chứa chữ “Mermaid” được giữ để không phá anchor URL; bên dưới chỉ còn D2.

Browser smoke kiểm tra toàn bộ route bài, light/dark, viewport 390px, 5 components, copy/bàn phím, Source Explorer/deep link và nội dung khi tắt JavaScript. Chưa kiểm chứng mọi SQL lab trên MySQL/PostgreSQL/Oracle thật, số liệu benchmark cũ hay deployment Cloudflare. Không deploy để thử tài liệu.

## Source Explorer

`src/components/docs-source-provider.tsx` đăng ký provider với `usePathname()` để đóng/reset drawer khi chuyển bài. `SourceRef` hỗ trợ mở drawer, chọn file, copy và deep link. CSS chính và Fumadocs adapter được import tại `src/app/globals.css`.

Nguồn chuẩn vẫn là **code fences trong bài**, không phải một bản sao trong thư mục examples. `scripts/build-source-examples.mjs`:

1. Đọc Markdown/MDX, lấy các snippet code theo heading và ngôn ngữ; walkthrough lấy snapshots, diff giữ after ở đường dẫn snippet fix cũ rồi bổ sung before, terminal lấy command. Không đưa descriptor YAML thành file code.
2. Đặt project ID theo đường dẫn, ví dụ `fundamentals-view-vs-materialized-view`.
3. Đặt file theo `<heading-slug>/<số-thứ-tự-trong-heading>.<extension>`.
4. Kiểm tra project, snapshot, file, region và line range của mọi reference; build lỗi nếu reference không tồn tại.
5. Highlight bằng Shiki với light/dark và `data-line`, sinh manifest cùng JSON có content hash tại `public/source-examples/`. Chỉ publish những project được tham chiếu.

Có thể mở toàn bộ snippet của bài:

```md
<SourceRef project="fundamentals-view-vs-materialized-view" variant="button">
Mở các đoạn code trong bài
</SourceRef>
```

Hoặc tham chiếu file và dòng cụ thể, dùng đường dẫn từ manifest/drawer:

```md
<SourceRef project="fundamentals-view-vs-materialized-view" file="51-tạo-bảng-và-dữ-liệu-mẫu/1.sql" lines="1-6" variant="button">
Đối chiếu schema và dữ liệu mẫu
</SourceRef>
```

`remarkSourceRefs` hỗ trợ component này trong `.md` mà không bật JSX cho toàn bộ prose có toán tử `<`. `.mdx` vẫn dùng component như bình thường. Khi đổi heading hoặc thêm/bớt snippet trước file đang tham chiếu, cập nhật `file` tương ứng rồi chạy `npm run sources:build`. Pipeline hiện sinh snapshot `article`; không tự suy ra named region từ code nên dùng `lines` để highlight.

Các file là **snippet độc lập**, có thể thuộc database khác nhau, là phiên bản thay thế, cố ý gây lỗi hoặc có thao tác dọn dữ liệu. Viewer không thực thi code; không ghép tất cả thành một script chạy tuần tự. Giữ code block ngắn trong bài, dùng reference ở những chỗ cần đối chiếu dài/nhiều snippet.

**Ranh giới tin cậy:** chỉ build Markdown/D2 và HTML highlight từ source tin cậy trong repository. SVG và HTML highlight được nhúng trực tiếp; không nhận input công khai không tin cậy. Assets source được publish công khai, không đưa secret vào ví dụ.

## Deploy

```bash
npm run deploy
```

Cloudflare Pages: dùng Node.js ≥22, build command `npm run build`, output directory `dist`. Source assets được Next.js copy từ `public/` vào static export; không cần API hoặc D2 server lúc đọc tài liệu.
