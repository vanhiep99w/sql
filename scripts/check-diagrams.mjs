import { unified } from 'unified';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { readArticles } from './docs-content.mjs';

const processor = unified().use(remarkD2, {
  cacheDir: '.next/cache/docs-kit/d2', defaultCaption: 'Sơ đồ',
});
let count = 0;
const failures = [];
for (const article of await readArticles()) {
  const blocks = article.tree.children.filter((node) => node.type === 'code' && node.lang === 'd2');
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
