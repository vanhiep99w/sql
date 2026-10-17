import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { extractArticle, readArticles, validateReferences } from '../scripts/docs-content.mjs';
import { parseSourceRef, remarkSourceRefs } from '../scripts/remark-source-refs.mjs';
import { readSourceURL, writeSourceURL } from '@vanhiep99w/docs-kit/source-explorer';

const filename = 'content/docs/fundamentals/demo.md';
const article = (body) => ({ filename, ...extractArticle(filename, body) });
const sql = '## Ví dụ\n\n```sql\nSELECT 1;\nSELECT 2;\n```\n';
const ref = '<SourceRef project="fundamentals-demo" file="ví-dụ/1.sql" lines="1-2">Mở code</SourceRef>';

test('extracts separate snippets by heading and language without frontmatter headings', () => {
  const data = article('---\ntitle: "Demo"\n---\n\n' + sql + '\n```java\nclass Example {}\n```');
  assert.equal(data.title, 'Demo');
  assert.equal(data.project, 'fundamentals-demo');
  assert.deepEqual(data.files.map((f) => f.path), ['ví-dụ/1.sql', 'ví-dụ/2.java']);
  assert.equal(data.files[0].code, 'SELECT 1;\nSELECT 2;');
  assert.equal(data.files[0].position.start.line, 7);
});

test('ignores text, diagram fences and SourceRef examples inside code', () => {
  const data = article('```text\n' + ref + '\n```\n\n```d2\na -> b\n```');
  assert.equal(data.references.length, 0);
  assert.equal(data.files.length, 0);
});

test('duplicate headings get distinct, deterministic file paths', () => {
  const data = article(sql + '\n' + sql);
  assert.deepEqual(data.files.map((f) => f.path), ['ví-dụ/1.sql', 'ví-dụ-1/1.sql']);
});

test('supports inline, multiline and self-closing references in Markdown', () => {
  for (const source of [ref, ref.replace('>Mở code<', '>\nMở code\n<'), '<SourceRef project="fundamentals-demo" />']) {
    const data = article(sql + '\n' + source);
    assert.equal(data.references.length, 1);
    assert.equal(validateReferences([data]).length, 1);
  }
});

test('supports actual MDX references without enabling JSX for plain Markdown prose', () => {
  const data = extractArticle(filename.replace('.md', '.mdx'), sql + '\n' + ref);
  assert.equal(data.references[0].project, 'fundamentals-demo');
  assert.doesNotThrow(() => article('So sánh x < 3 và y > 1.\n\n' + sql));
});

test('rejects dynamic, duplicate and malformed reference attributes', () => {
  for (const source of [
    '<SourceRef project={value} />',
    '<SourceRef project="a" project="b" />',
    '<SourceRef project="a">',
  ]) assert.throws(() => parseSourceRef(source));
});

test('fails unknown project, snapshot, file, region and invalid line ranges', () => {
  const data = article(sql + '\n' + ref);
  for (const invalid of [
    { project: 'missing' }, { snapshot: 'missing' }, { file: 'missing.sql' },
    { region: 'missing' }, { lines: '0' }, { lines: '2-1' }, { lines: '1-3' }, { lines: 'abc' },
  ]) {
    assert.throws(() => validateReferences([{ ...data, references: [{ ...data.references[0], ...invalid }] }]));
  }
});

test('cross-article references publish the target even without a self-reference', () => {
  const target = article(sql);
  const source = { ...article(''), project: 'source', references: [{ project: target.project }] };
  assert.deepEqual(validateReferences([target, source]).map((a) => a.project), [target.project]);
});

test('Markdown compilation renders SourceRef as a component, not inert HTML', async () => {
  const result = await evaluate('x < 3\n\n' + ref, {
    ...runtime, format: 'md', remarkPlugins: [remarkSourceRefs],
  });
  const html = renderToStaticMarkup(createElement(result.default, {
    components: { SourceRef: ({ children, file }) => createElement('button', { 'data-file': file }, children) },
  }));
  assert.match(html, /x &lt; 3/);
  assert.match(html, /<button data-file="ví-dụ\/1.sql">Mở code<\/button>/);
  assert.doesNotMatch(html, /<SourceRef/);
});

test('source deep links retain unrelated query params and the article anchor', () => {
  const original = new URL('https://example.com/page/?mode=review#example');
  const request = { project: 'demo', file: 'ví-dụ/1.sql', lines: '1-2' };
  const next = writeSourceURL(original, request);
  assert.deepEqual(readSourceURL(next), { ...request, region: undefined, snapshot: undefined });
  assert.equal(next.searchParams.get('mode'), 'review');
  assert.equal(next.hash, '#example');
  const closed = writeSourceURL(next, null);
  assert.equal(closed.searchParams.get('mode'), 'review');
  assert.equal(closed.searchParams.has('source'), false);
});

test('all repository references resolve and Mermaid fences have been migrated', async () => {
  const articles = await readArticles();
  assert.ok(validateReferences(articles).length > 0);
  for (const data of articles) {
    assert.ok(!data.tree.children.some((node) => node.type === 'code' && node.lang === 'mermaid'), data.filename);
  }
});
