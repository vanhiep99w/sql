import { createHash } from 'node:crypto';
import { visit } from 'unist-util-visit';

const textLanguages = new Set(['', 'text', 'plaintext', 'diagram']);
// A review aid, not a diagram parser: some query outputs and byte layouts also
// match. Those need an explicit exception rather than an automatic conversion.
const diagramMarks = /[┌┐└┘├┤┬┴┼│→▼↓⇄╭╰]|-->|─[►▶]/u;

export function findTextDiagramCandidates(articles) {
  const candidates = [];
  for (const article of articles) {
    visit(article.tree, 'code', (node) => {
      const language = node.lang ?? '';
      if (!textLanguages.has(language)) return;
      if (language !== 'diagram' && !diagramMarks.test(node.value)) return;
      candidates.push({
        file: article.filename,
        line: node.position?.start.line,
        language,
        sha256: createHash('sha256').update(node.value).digest('hex'),
        firstLine: node.value.split('\n')[0],
      });
    });
  }
  return candidates;
}

export function validateTextDiagramReview(candidates, exceptions) {
  const key = (entry) => `${entry.file}:${entry.sha256}`;
  const reviewed = new Map();
  for (const entry of exceptions) {
    if (!entry.reason?.trim()) throw new Error(`Missing review reason: ${entry.file}`);
    if (reviewed.has(key(entry))) throw new Error(`Duplicate review exception: ${entry.file}`);
    reviewed.set(key(entry), entry);
  }
  const remaining = new Set(candidates.map(key));
  const problems = [];
  for (const candidate of candidates) {
    if (!reviewed.has(key(candidate))) {
      problems.push(`${candidate.file}:${candidate.line}: review text/ASCII block or convert it to D2 (${candidate.firstLine})`);
    }
  }
  for (const entry of exceptions) {
    if (!remaining.has(key(entry))) problems.push(`${entry.file}: stale text/ASCII exception (${entry.firstLine})`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
}
