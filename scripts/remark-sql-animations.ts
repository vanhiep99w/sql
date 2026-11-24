import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

// Only exact, standalone markers are supported in Markdown; not arbitrary JSX.
const markers = new Map([
  ['<PrimaryKeySplitAnimation />', 'PrimaryKeySplitAnimation'],
  ['<CompositeIndexAnimation />', 'CompositeIndexAnimation'],
  ['<ClusteredLookupAnimation />', 'ClusteredLookupAnimation'],
  ['<LikePatternAnimation />', 'LikePatternAnimation'],
  ['<OffsetPaginationAnimation />', 'OffsetPaginationAnimation'],
  ['<SkipLockedAnimation />', 'SkipLockedAnimation'],
  ['<MvccSnapshotAnimation />', 'MvccSnapshotAnimation'],
  ['<HotUpdateAnimation />', 'HotUpdateAnimation'],
  ['<VacuumBloatAnimation />', 'VacuumBloatAnimation'],
  ['<IsolationAnomalyAnimation />', 'IsolationAnomalyAnimation'],
  ['<LockMechanicsAnimation />', 'LockMechanicsAnimation'],
  ['<PartitionPruningAnimation />', 'PartitionPruningAnimation'],
  ['<ShardingRoutingAnimation />', 'ShardingRoutingAnimation'],
  ['<QueryPipelineAnimation />', 'QueryPipelineAnimation'],
  ['<LeftJoinFilterAnimation />', 'LeftJoinFilterAnimation'],
  ['<ColdWarmCacheAnimation />', 'ColdWarmCacheAnimation'],
]);

export function remarkSqlAnimations() {
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
