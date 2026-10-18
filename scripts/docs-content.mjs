import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkFrontmatter from 'remark-frontmatter';
import { promoteSourceRefs } from './remark-source-refs.mjs';
import GithubSlugger from 'github-slugger';
import { visit } from 'unist-util-visit';
import { parse } from 'yaml';

export const docsDir = 'content/docs';
const markdown = unified().use(remarkParse).use(remarkFrontmatter);
const mdx = unified().use(remarkParse).use(remarkFrontmatter).use(remarkMdx);
const extensions = {
  sql: 'sql', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
  java: 'java', python: 'py', bash: 'sh', json: 'json', lua: 'lua',
  ini: 'ini', http: 'http', xml: 'xml', redis: 'redis',
};

export async function listDocs(directory = docsDir) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listDocs(filename));
    else if (/\.mdx?$/.test(entry.name)) files.push(filename);
  }
  return files.sort();
}

function nodeText(node) {
  return node.value ?? (node.children ?? []).map(nodeText).join('');
}

// Article snippets are the canonical source. Files remain separate: SQL labs can
// contain alternative engines, intentional failures and destructive cleanup.
export function extractArticle(filename, content) {
  const tree = (filename.endsWith('.mdx') ? mdx : markdown).parse(content);
  promoteSourceRefs(tree);
  const relative = path.relative(docsDir, filename).replaceAll(path.sep, '/').replace(/\.mdx?$/, '');
  const project = relative.replaceAll('/', '-');
  const slugger = new GithubSlugger();
  const counters = new Map();
  const files = [];
  const references = [];
  let section = 'intro';
  let sectionTitle = 'Giới thiệu';
  visit(tree, (node) => {
    if (node.type === 'heading') {
      sectionTitle = nodeText(node);
      section = slugger.slug(sectionTitle) || 'section';
    }
    if (node.type === 'code') {
      // Keep the original snippet's path when migrating it to a descriptor.
      // Descriptors are validated by the learning plugins in checks/build.
      let snippets = [{ language: node.lang, code: node.value }];
      if (['code-walkthrough', 'code-diff', 'terminal-session'].includes(node.lang)) {
        const data = parse(node.value);
        if (node.lang === 'code-walkthrough') {
          snippets = data.snapshots.map((s) => ({ language: s.language ?? data.language, code: s.code }));
        } else if (node.lang === 'code-diff') {
          // The replaced fix snippet remains first; the old version is additional.
          snippets = [data.after, data.before].map((s) => ({ language: data.language, code: s.code }));
        } else {
          snippets = data.steps.map((s) => ({ language: 'bash', code: s.command }));
        }
      }
      for (const snippet of snippets) {
        if (!extensions[snippet.language]) continue;
        const number = (counters.get(section) ?? 0) + 1;
        counters.set(section, number);
        files.push({
          path: `${section}/${number}.${extensions[snippet.language]}`,
          displayPath: `${sectionTitle} / ${number}.${extensions[snippet.language]}`,
          language: snippet.language === 'redis' ? 'text' : snippet.language,
          code: snippet.code,
          regions: {},
          position: node.position,
        });
      }
    }
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      if (node.name !== 'SourceRef') return;
      const attrs = {};
      for (const attr of node.attributes) {
        if (attr.type !== 'mdxJsxAttribute' || typeof attr.value !== 'string') {
          throw new Error(`${filename}: SourceRef attributes must be static strings`);
        }
        attrs[attr.name] = attr.value;
      }
      references.push(attrs);
    }
  });
  const title = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? project;
  return { project, title, files, references, tree };
}

export async function readArticles() {
  return Promise.all((await listDocs()).map(async (filename) => ({
    filename,
    ...extractArticle(filename, await readFile(filename, 'utf8')),
  })));
}

export function validateReferences(articles) {
  const referenced = new Set(articles.flatMap((a) => a.references.map((ref) => ref.project)));
  const projects = new Map(articles.filter((a) => referenced.has(a.project)).map((a) => [a.project, a]));
  for (const article of articles) {
    for (const ref of article.references) {
      const error = (message) => { throw new Error(`${article.filename}: ${message}`); };
      const target = projects.get(ref.project);
      if (!target) error(`unknown SourceRef project ${ref.project}`);
      if (ref.snapshot && ref.snapshot !== 'article') error(`unknown snapshot ${ref.snapshot}`);
      const file = target.files.find((f) => f.path === (ref.file ?? target.files[0]?.path));
      if (!file) error(`unknown source file ${ref.file}`);
      if (ref.region && ref.lines) error('choose region OR lines');
      if (ref.region && !file.regions[ref.region]) error(`unknown region ${ref.region}`);
      if (ref.lines) {
        const range = /^(\d+)(?:-(\d+))?$/.exec(ref.lines);
        if (!range || +range[1] < 1 || +(range[2] ?? range[1]) < +range[1]
          || +(range[2] ?? range[1]) > file.code.split('\n').length) error(`invalid lines ${ref.lines}`);
      }
    }
  }
  return [...projects.values()];
}
