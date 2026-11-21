import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

// Only an exact, standalone marker is supported in Markdown; not arbitrary JSX.
export function remarkJoinAnimation() {
  return (tree: Root) => {
    visit(tree, 'html', (node, index, parent) => {
      if (node.value.trim() !== '<JoinAnimation />' || index === undefined || parent?.type !== 'root') return;
      parent.children[index] = {
        type: 'mdxJsxFlowElement', name: 'JoinAnimation', attributes: [], children: [], position: node.position,
      };
    });
  };
}
