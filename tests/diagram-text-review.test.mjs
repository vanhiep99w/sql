import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { visit } from 'unist-util-visit';
import { extractArticle, readArticles } from '../scripts/docs-content.mjs';
import { findTextDiagramCandidates, validateTextDiagramReview } from '../scripts/diagram-text-review.mjs';

const filename = 'content/docs/demo.md';
const article = (content) => ({ filename, ...extractArticle(filename, content) });

test('finds ASCII and diagram fences, including inside callouts and lists', () => {
  const articles = [article([
    '> [!TIP]', '> ```text', '> A → B → C', '> ```', '',
    '- Example', '', '  ```diagram', '  plain diagram without arrows', '  ```', '',
    '```sql', 'SELECT 1; -- A → B is a SQL comment', '```', '',
    '```d2', 'a -> b', '```', '',
    '```text', 'ordinary output without diagram marks', '```',
  ].join('\n'))];
  const candidates = findTextDiagramCandidates(articles);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].firstLine, 'A → B → C');
  assert.equal(candidates[1].language, 'diagram');
});

test('requires a reason for exceptions and fails new or changed ASCII blocks', () => {
  const candidates = findTextDiagramCandidates([article('```text\na → b\n```')]);
  assert.throws(() => validateTextDiagramReview(candidates, []), /review text\/ASCII/);
  const entry = { ...candidates[0], reason: 'Kept as exact output for this test.' };
  assert.doesNotThrow(() => validateTextDiagramReview(candidates, [entry]));
  assert.throws(() => validateTextDiagramReview(candidates, [{ ...entry, reason: ' ' }]), /Missing review reason/);
  assert.throws(() => validateTextDiagramReview(candidates, [entry, entry]), /Duplicate review/);
  const changed = findTextDiagramCandidates([article('```text\na → c\n```')]);
  assert.throws(() => validateTextDiagramReview(changed, [entry]), /review text\/ASCII/);
});

test('stale exceptions must be removed after converting text to D2', () => {
  const candidates = findTextDiagramCandidates([article('```text\na → b\n```')]);
  const entry = { ...candidates[0], reason: 'Test.' };
  const converted = findTextDiagramCandidates([article('```d2\na -> b\n```')]);
  assert.throws(() => validateTextDiagramReview(converted, [entry]), /stale text\/ASCII exception/);
});

test('repository diagram-like text is explicitly reviewed; no legacy diagram fences remain', async () => {
  const articles = await readArticles();
  const exceptions = JSON.parse(await readFile(new URL('../scripts/diagram-text-exceptions.json', import.meta.url), 'utf8'));
  validateTextDiagramReview(findTextDiagramCandidates(articles), exceptions);
  for (const data of articles) {
    visit(data.tree, 'code', (node) => {
      assert.ok(!['diagram', 'mermaid'].includes(node.lang), `${data.filename}:${node.position?.start.line}`);
      if (node.lang === 'd2') assert.match(node.meta ?? '', /title=/, `${data.filename}: D2 needs a caption`);
    });
  }
});
