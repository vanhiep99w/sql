import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { remarkSourceRefs } from './scripts/remark-source-refs.mjs';
import { visit } from 'unist-util-visit';

const admonitionTypeMap: Record<string, string> = {
  note: 'info',
  tip: 'info',
  warning: 'warn',
  important: 'warn',
  caution: 'error',
};

function remarkGithubCallouts() {
  return (tree: import('mdast').Root) => {
    visit(tree, 'blockquote', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const firstChild = node.children[0];
      if (firstChild?.type !== 'paragraph') return;
      const firstTextNode = firstChild.children[0];
      if (firstTextNode?.type !== 'text') return;

      const match = firstTextNode.value.match(/^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\n?/i);
      if (!match) return;

      const type = match[1].toLowerCase();
      firstTextNode.value = firstTextNode.value.slice(match[0].length);

      let children = node.children;
      if (firstChild.children.length === 1 && firstTextNode.value === '') {
        children = node.children.slice(1);
      }

      (parent.children as unknown[])[index] = {
        type: 'mdxJsxFlowElement',
        name: 'Callout',
        attributes: [
          {
            type: 'mdxJsxAttribute',
            name: 'type',
            value: admonitionTypeMap[type] ?? 'info',
          },
        ],
        children,
      };
    });
  };
}

export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      remarkGithubCallouts,
      remarkSourceRefs,
      [remarkD2, {
        cacheDir: '.next/cache/docs-kit/d2',
        defaultCaption: 'Sơ đồ',
      }],
    ],
    rehypeCodeOptions: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      fallbackLanguage: 'plaintext',
    },
  },
});
