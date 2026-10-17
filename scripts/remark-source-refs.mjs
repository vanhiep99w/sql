import { visit } from 'unist-util-visit';

/** Parse the deliberately small, static SourceRef syntax used in .md files. */
export function parseSourceRef(value) {
  const match = /^<SourceRef\b([^>]*?)(?:\s*\/>|>([^<]*)<\/SourceRef>)\s*$/.exec(value);
  if (!match) throw new Error('SourceRef must have static string attributes and a plain-text label');
  const attributes = [];
  let rest = match[1].trim();
  while (rest) {
    const attr = /^([\w-]+)="([^"]*)"(?:\s+|$)/.exec(rest);
    if (!attr) throw new Error(`Invalid SourceRef attribute: ${rest}`);
    if (attributes.some((a) => a.name === attr[1])) throw new Error(`Duplicate SourceRef attribute ${attr[1]}`);
    attributes.push({ type: 'mdxJsxAttribute', name: attr[1], value: attr[2] });
    rest = rest.slice(attr[0].length).trim();
  }
  return {
    type: 'mdxJsxFlowElement', name: 'SourceRef', attributes,
    children: match[2] ? [{ type: 'text', value: match[2].trim() }] : [],
  };
}

// Fumadocs compiles .md as Markdown, not MDX. Explicitly promote only this
// trusted component; do not enable JSX parsing for SQL operators in prose.
export function promoteSourceRefs(tree) {
  visit(tree, 'paragraph', (paragraph) => {
    // CommonMark parses a single-line inline reference as opening HTML, text,
    // closing HTML. Promote that sequence without touching ordinary HTML/code.
    for (let i = 0; i < paragraph.children.length; i++) {
      const start = paragraph.children[i];
      if (start.type !== 'html' || !/^<SourceRef\b/.test(start.value)) continue;
      let end = i;
      let value = start.value;
      while (!value.includes('</SourceRef>') && !/\/>\s*$/.test(value)) {
        const next = paragraph.children[++end];
        if (!next || !['text', 'html'].includes(next.type)) {
          throw new Error('SourceRef requires a plain-text label and a closing tag');
        }
        value += next.value;
      }
      const node = parseSourceRef(value);
      node.type = 'mdxJsxTextElement';
      paragraph.children.splice(i, end - i + 1, node);
    }
  });
  visit(tree, 'html', (node, index, parent) => {
    if (!/^<SourceRef\b/.test(node.value) || index === undefined || !parent) return;
    parent.children[index] = { ...parseSourceRef(node.value), position: node.position };
  });
}

export function remarkSourceRefs() {
  return promoteSourceRefs;
}
