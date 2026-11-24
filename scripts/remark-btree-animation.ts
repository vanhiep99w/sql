import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

// Only exact, standalone markers are supported in Markdown; not arbitrary JSX.
const markers = new Map([
  ['<BTreeSearchAnimation />', 'BTreeSearchAnimation'],
  ['<BTreeSplitAnimation />', 'BTreeSplitAnimation'],
]);

export function remarkBTreeAnimation() {
  return (tree: Root) => {
    visit(tree, 'html', (node, index, parent) => {
      const name = markers.get(node.value.trim());
      if (!name || index === undefined || parent?.type !== 'root') return;
      parent.children[index] = {
        type: 'mdxJsxFlowElement', name, attributes: [], children: [], position: node.position,
      };
    });
  };
}
