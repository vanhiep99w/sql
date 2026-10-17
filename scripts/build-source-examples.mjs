import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHighlighter } from 'shiki';
import { readArticles, validateReferences } from './docs-content.mjs';

const output = new URL('../public/source-examples/', import.meta.url);
const articles = validateReferences(await readArticles());
const highlighter = await createHighlighter({
  themes: ['github-light', 'github-dark'],
  langs: [...new Set(articles.flatMap((a) => a.files.map((f) => f.language)))].filter((l) => l !== 'text'),
});
const assets = new Map();
const manifest = [];
try {
  for (const article of articles) {
    const files = article.files.map(({ position, ...file }) => ({
      ...file,
      html: highlighter.codeToHtml(file.code, {
        lang: file.language,
        themes: { light: 'github-light', dark: 'github-dark' },
        transformers: [{ line(node, line) { node.properties['data-line'] = line; } }],
      }),
    }));
    const json = JSON.stringify({
      project: article.project, snapshot: 'article', defaultFile: files[0].path, files,
    });
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
    const asset = `${article.project}.${hash}.json`;
    assets.set(asset, json);
    manifest.push({
      id: article.project, title: article.title, defaultSnapshot: 'article',
      snapshots: [{ id: 'article', title: 'Snippets trong bài', asset }],
    });
  }
  // Validate and highlight everything before replacing any previously valid assets.
  await mkdir(output, { recursive: true });
  for (const [name, json] of assets) await writeFile(new URL(name, output), json);
  await writeFile(new URL('manifest.json', output), JSON.stringify(manifest));
  for (const name of await readdir(output)) {
    if (name !== 'manifest.json' && !assets.has(name)) await rm(new URL(name, output));
  }
  console.log(`[source-examples] ${articles.length} articles; ${articles.reduce((n, a) => n + a.files.length, 0)} snippets; references validated`);
} finally {
  highlighter.dispose();
}
