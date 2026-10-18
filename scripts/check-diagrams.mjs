import { unified } from 'unified';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { readArticles } from './docs-content.mjs';
import { visit } from 'unist-util-visit';
import { readFile } from 'node:fs/promises';
import { findTextDiagramCandidates, validateTextDiagramReview } from './diagram-text-review.mjs';

const processor = unified().use(remarkD2, {
  cacheDir: '.next/cache/docs-kit/d2', defaultCaption: 'Sơ đồ',
  assetsRoot: 'content/diagram-assets',
});
let count = 0;
const failures = [];
const articles = await readArticles();
const exceptions = JSON.parse(await readFile(new URL('./diagram-text-exceptions.json', import.meta.url), 'utf8'));
const candidates = findTextDiagramCandidates(articles);
validateTextDiagramReview(candidates, exceptions);
console.log(`[text-review] ${candidates.length} reviewed exceptions; no unreviewed text/ASCII candidates`);
for (const article of articles) {
  const blocks = [];
  visit(article.tree, 'code', (node) => {
    if (node.lang === 'd2') blocks.push(node);
  });
  if (!blocks.length) continue;
  try {
    await processor.run(article.tree, { path: article.filename });
    count += blocks.length;
    console.log(`[d2] ${article.filename}: ${blocks.length}`);
  } catch (error) {
    failures.push(`${article.filename}: ${error.message}`);
  }
}
if (failures.length) throw new Error(failures.join('\n'));
console.log(`[d2] ${count} diagrams rendered successfully (light + dark)`);
