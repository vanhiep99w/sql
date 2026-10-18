import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compile } from '@mdx-js/mdx';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { learningPlugins, learningComponents } from '../scripts/learning-components.mjs';
import { readArticles, extractArticle, validateReferences } from '../scripts/docs-content.mjs';

const processor = () => learningPlugins.reduce((p, plugin) => p.use(plugin), unified());

test('all five installed learning plugins compile real article descriptors to MDX components', async () => {
  const seen = new Set();
  for (const article of await readArticles()) {
    const blocks = [];
    visit(article.tree, 'code', (node) => {
      if (learningComponents[node.lang]) blocks.push(node);
    });
    for (const block of blocks) {
      const code = String(await compile(`\`\`\`${block.lang}\n${block.value}\n\`\`\``, {
        format: 'md', remarkPlugins: learningPlugins,
      }));
      assert.match(code, new RegExp(learningComponents[block.lang]), article.filename);
      seen.add(block.lang);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(learningComponents).sort());
});

test('plugins fail invalid ranges, JSON bodies, terminal contexts and span parents', async () => {
  const invalid = [
    ['code-walkthrough', 'title: Bad\nsnapshots: [{id: a, code: SELECT 1}]\nsteps: [{id: x, snapshot: a, title: X, description: X, ranges: [[0, 2]]}]'],
    ['code-diff', 'title: Bad\nlanguage: sql\nbefore: {code: SELECT 1}\nafter: {code: SELECT 2}\nannotations: [{id: x, side: after, title: Bad, description: Bad, ranges: [[1, 9]]}]'],
    ['terminal-session', 'title: Bad\ncontext: {kind: production}\nsteps: [{id: x, command: echo test}]'],
    ['protocol-exchange', 'title: Bad\nvariants: [{id: a, title: A, request: {method: GET, url: /}, response: {status: 200, body: {kind: json, json: "{bad}"}}}]'],
    ['span-waterfall', 'title: Bad\nunit: ms\nprovenance: {kind: illustrative, description: Demo}\nspans: [{id: a, parent: missing, name: A, service: db, start: 0, duration: 1}]'],
  ];
  for (const [lang, value] of invalid) {
    await assert.rejects(processor().run({ type: 'root', children: [{ type: 'code', lang, value }] }), undefined, lang);
  }
});

test('host keeps plugin, MDX component and CSS registration aligned', async () => {
  const config = await readFile('source.config.ts', 'utf8');
  const page = await readFile('src/app/[[...slug]]/page.tsx', 'utf8');
  const css = await readFile('src/app/globals.css', 'utf8');
  for (const [fence, component] of Object.entries(learningComponents)) {
    assert.match(config, new RegExp(`remark${component}`));
    assert.match(page, new RegExp(`\\b${component},`));
    assert.ok(css.includes(`styles/${fence}.css`));
  }
  assert.match(page, /D2InteractiveDiagram,/);
  assert.match(config, /assetsRoot: 'content\/diagram-assets'/);
});

test('migrated code stays in Source Explorer with its original path and content', async () => {
  const articles = await readArticles();
  validateReferences(articles);
  const walkthrough = articles.find((a) => a.project === 'fundamentals-application-concurrency-locking');
  const sql = walkthrough.files.find((f) => f.path === 'sql-cập-nhật-có-điều-kiện/1.sql');
  assert.equal(sql.code, 'UPDATE products\nSET price = :price,\n    version = version + 1,\n    updated_at = CURRENT_TIMESTAMP\nWHERE id = :id\n  AND version = :expected_version;');
  const diff = articles.find((a) => a.project === 'optimization-query-optimization-patterns');
  assert.ok(diff.files.find((f) => f.path === '53-fix-chuyển-thành-range-condition/1.sql')?.code.includes("created_at < '2024-02-01'"));
  const terminal = articles.find((a) => a.project === 'optimization-monitoring-slow-query-deep-dive');
  assert.equal(terminal.files.find((f) => f.path === '43-mysql-slow-query-log/2.sh')?.code, 'pt-query-digest /var/log/mysql/slow.log');
});

test('nested learning fences expose only authored source snippets, never YAML as code', () => {
  const article = extractArticle('content/docs/demo.md', '> ```terminal-session\n> title: Demo\n> context: {kind: local}\n> steps: [{id: x, command: echo demo}]\n> ```');
  assert.equal(article.files[0].code, 'echo demo');
  assert.equal(article.files[0].path, 'intro/1.sh');
});
