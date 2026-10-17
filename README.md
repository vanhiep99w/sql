# SQL Learning

Tài liệu học SQL tiếng Việt — MySQL, PostgreSQL, Oracle. Next.js 16, Fumadocs và static export lên Cloudflare Pages.

## Mục lục

- [Phát triển và kiểm tra](#phát-triển-và-kiểm-tra)
- [Sơ đồ D2](#sơ-đồ-d2)
- [Source Explorer](#source-explorer)
- [Deploy](#deploy)

## Phát triển và kiểm tra

Yêu cầu **Node.js 22 trở lên**. Không cần D2 CLI, Go hay Java.

```bash
npm ci
npm run dev
```

```bash
npm test                 # Parser, references, Markdown component và URL helpers
npm run typecheck
npm run diagrams:check   # Render tất cả D2 ở cả light/dark; lỗi kèm file/vị trí
npm run build            # Sinh source assets, compile docs, static export
```

`predev` và `prebuild` tự chạy `npm run sources:build`. Sau khi sửa code trong bài khi dev server đang chạy, chạy lại `npm run sources:build` và mở lại drawer để đọc assets mới. Output website ở `dist/`; không commit output hay cache.

## Sơ đồ D2

Dùng [`@vanhiep99w/docs-kit@0.5.0`](https://www.npmjs.com/package/@vanhiep99w/docs-kit). `remarkD2` trong `source.config.ts` render SVG lúc build; `D2Diagram` được đăng ký tại `src/app/[[...slug]]/page.tsx`. Không đưa renderer/WASM vào client bundle. Light/dark theo theme của website.

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

D2 thay flowchart, sequence/state diagram, kiến trúc và quan hệ cây phù hợp. **Giữ text** cho execution plan, log, bảng kết quả, bit layout, ví dụ căn vị trí, timeline SQL cần đối chiếu và các bảng/checklist chỉ bọc khung ASCII. Không chuyển chúng thành ảnh chỉ để đồng nhất hình thức. Mermaid runtime và plugin cũ đã được bỏ.

Cache D2 ở `.next/cache/docs-kit/d2`, nằm trong đường dẫn cache Next.js mà Cloudflare Pages hỗ trợ. Cache giúp build nhanh hơn nhưng không phải output để deploy; cần bật Build cache trong dashboard.

## Source Explorer

`src/components/docs-source-provider.tsx` đăng ký provider với `usePathname()` để đóng/reset drawer khi chuyển bài. `SourceRef` hỗ trợ mở drawer, chọn file, copy và deep link. CSS chính và Fumadocs adapter được import tại `src/app/globals.css`.

Nguồn chuẩn vẫn là **code fences trong bài**, không phải một bản sao trong thư mục examples. `scripts/build-source-examples.mjs`:

1. Đọc Markdown/MDX, lấy các snippet code theo heading và ngôn ngữ.
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
