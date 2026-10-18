import { readFile, writeFile } from 'node:fs/promises';
import { visit } from 'unist-util-visit';
import { readArticles } from './docs-content.mjs';
import { findTextDiagramCandidates, validateTextDiagramReview } from './diagram-text-review.mjs';
import { learningComponents } from './learning-components.mjs';

const articles = await readArticles();
const exceptions = JSON.parse(await readFile('scripts/diagram-text-exceptions.json', 'utf8'));
const candidates = findTextDiagramCandidates(articles);
validateTextDiagramReview(candidates, exceptions);
const counts = {};
const rows = [];
for (const article of articles) {
  const row = { d2: 0, learning: 0, artifacts: candidates.filter((c) => c.file === article.filename).length };
  visit(article.tree, (node) => {
    if (node.type === 'code') {
      const lang = node.lang ?? '(plain)';
      counts[lang] = (counts[lang] ?? 0) + 1;
      if (/^(mermaid|diagram)$/i.test(lang)) throw new Error(`${article.filename}: legacy ${lang} fence`);
      if (lang === 'd2') row.d2++;
      if (learningComponents[lang]) row.learning++;
    }
    if (['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type) && /mermaid/i.test(node.name ?? '')) {
      throw new Error(`${article.filename}: legacy Mermaid component`);
    }
    if (node.type === 'html' && /<(?:Mermaid|pre\b[^>]*class=["'][^"']*mermaid)/i.test(node.value)) {
      throw new Error(`${article.filename}: legacy Mermaid HTML`);
    }
  });
  rows.push(`| \`${article.filename.replace('content/docs/', '')}\` | ${row.d2} | ${row.learning} | ${row.artifacts} |`);
}
const report = `# Kiểm kê docs-kit 0.9.0 — SQL

## Mục lục

- [Phạm vi và kết quả](#phạm-vi-và-kết-quả)
- [Theo từng bài](#theo-từng-bài)
- [Phân loại artifact](#phân-loại-artifact)
- [Giới hạn](#giới-hạn)

## Phạm vi và kết quả

Kiểm kê toàn bộ **${articles.length} bài** trong nguồn chuẩn \`content/docs\`, kể cả fence lồng trong callout/list. Tái tạo bằng \`npm run docs:audit -- --write\`; kiểm tra snapshot bằng \`npm run docs:audit\`.

- **${counts.d2} D2**, Mermaid/diagram fence hoặc Mermaid component: **0**.
- **${Object.keys(learningComponents).length} learning components** được dùng: ${Object.keys(learningComponents).map((f) => `\`${f}\`: ${counts[f] ?? 0}`).join(', ')}.
- **${candidates.length} text artifact có dấu hiệu đồ họa đã review**, không còn candidate chưa phân loại. Hash/nội dung đầu/lý do riêng từng khối: \`scripts/diagram-text-exceptions.json\`.
- Đợt này chuyển 8 khối đồ họa còn trong ngoại lệ cũ: MVCC ID timeline; leaf linkage; encoded-key flow; checkpoint/WAL sparkline; join complexity plot; 2 layout UUID; planner cost plot. Các đồ thị định tính chuyển thành quan hệ/công thức, không giả vờ có tỷ lệ đo.
- MySQL/PostgreSQL dùng logo từ [D2 Icon Catalog](https://icons.d2lang.com/), lưu local với provenance/SHA-256; renderer nhúng vào SVG light/dark. Không cần gọi catalog lúc đọc.
- URL bài, frontmatter và meta.json giữ nguyên. Source Explorer giữ provider, reference validator và các deep link hiện có; extractor đọc cả snapshot walkthrough, after/before diff và command terminal.

## Theo từng bài

| Bài | D2 | Learning | Artifact đã review |
|---|---:|---:|---:|
${rows.join('\n')}

## Phân loại artifact

Giữ code, log, HTTP/JSON payload, EXPLAIN tree, bảng dữ liệu/kết quả, checklist và biểu thức số dưới dạng text/code. Dấu \`->\` trong execution plan hay chú thích \`←\` không biến output thành sơ đồ. Không dùng exception cho timeline, sparkline hoặc quan hệ leaf/field; những khối đó đã chuyển D2. Việc tăng số ngoại lệ từ bản cũ đến từ mở rộng detector cho mũi tên ASCII, dấu chú thích hai chiều và marker Unicode, không phải thêm sơ đồ mới.

## Giới hạn

Detector là công cụ hỗ trợ, không chứng minh semantics. Các text fences đã được đọc để phân biệt artifact với hình vẽ; kiểm thử ngăn ngoại lệ cũ/stale hoặc khối mới chưa review. Số đo có sẵn trong bài không được tái đo; SpanWaterfall được gắn provenance illustrative. Build/browser smoke xác minh render và tương tác, không xác minh mọi SQL lab trên các database thật hay deployment Cloudflare.
`;
const path = 'reports/docs-kit-0.9.0.md';
if (process.argv.includes('--write')) await writeFile(path, report);
else if (await readFile(path, 'utf8') !== report) throw new Error('Inventory changed: review content, then npm run docs:audit -- --write');
console.log(`[docs-audit] ${articles.length} articles; ${counts.d2} D2; 5 learning examples; 0 legacy diagrams; ${candidates.length} reviewed artifacts`);
