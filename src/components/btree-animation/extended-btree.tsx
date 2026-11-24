'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WorkbenchShell, type WorkbenchMode } from '../sql-workbench/workbench-shell';
import {
  clusteredLookupModes,
  compositeIndexModes,
  likePatternModes,
  offsetPaginationModes,
  primaryKeyModes,
  type ExtTreeFrame,
  type ExtTreeNode,
} from './extended-traces';
import styles from './extended-btree.module.css';

type ComputedEdge = {
  key: string;
  d: string;
  lx: number;
  ly: number;
  label?: string;
  active?: boolean;
  dashed?: boolean;
};

function layoutBoxIn(el: HTMLElement, container: HTMLElement) {
  let left = 0;
  let top = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== container) {
    left += cur.offsetLeft;
    top += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

function computeEdges(viewport: HTMLElement, frame: ExtTreeFrame): ComputedEdge[] {
  if (!viewport.offsetWidth || !viewport.offsetHeight) return [];
  const nodesById = new Map<string, ExtTreeNode>();
  for (const level of frame.levels) {
    for (const node of level) nodesById.set(node.id, node);
  }
  const out: ComputedEdge[] = [];
  for (const edge of frame.edges) {
    const parentEl = viewport.querySelector<HTMLElement>(`[data-node="${edge.from}"]`);
    const childEl = viewport.querySelector<HTMLElement>(`[data-node="${edge.to}"]`);
    const parentNode = nodesById.get(edge.from);
    if (!parentEl || !childEl || !parentNode) continue;
    const pBox = layoutBoxIn(parentEl, viewport);
    const cBox = layoutBoxIn(childEl, viewport);
    const totalBranches = Math.max(1, parentNode.keys.length + 1);
    const ratio = (edge.branchIndex + 0.5) / totalBranches;
    const x1 = pBox.left + pBox.width * ratio;
    const y1 = pBox.top + pBox.height;
    const x2 = cBox.left + cBox.width * 0.5;
    const y2 = cBox.top;
    const midY = y1 + (y2 - y1) * 0.52;
    out.push({
      key: `${edge.from}-${edge.to}-${edge.branchIndex}`,
      d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      lx: x1 + (x2 - x1) * 0.56,
      ly: y1 + (y2 - y1) * 0.52,
      label: edge.label,
      active: edge.active,
      dashed: edge.dashed,
    });
  }
  return out;
}

function TreeStage({ frame }: { frame: ExtTreeFrame }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ComputedEdge[]>([]);

  const refresh = useCallback(() => {
    if (!viewport.current) return;
    setEdges(computeEdges(viewport.current, frame));
  }, [frame]);

  useLayoutEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refresh);
    observer.observe(el);
    return () => observer.disconnect();
  }, [refresh]);

  const siblingMap = new Map(frame.siblingLinks.map((link) => [`${link.from}->${link.to}`, link]));

  return (
    <>
      {frame.incoming && (
        <div className={styles.incomingRow}>
          <span className={styles.incomingChip} data-tone={frame.incoming.tone}>
            <span>{frame.incoming.label}</span>
            <b>{frame.incoming.key}</b>
          </span>
        </div>
      )}

      <div className={styles.treeViewport} ref={viewport} data-tree-viewport>
        <svg className={styles.svgLayer} aria-hidden="true">
          {edges.map((edge) => {
            const textWidth = edge.label ? Math.max(36, edge.label.length * 6.8 + 12) : 0;
            return (
              <g key={edge.key}>
                <path
                  d={edge.d}
                  className={styles.edgePath}
                  data-active={edge.active ? 'true' : undefined}
                  data-dashed={edge.dashed ? 'true' : undefined}
                />
                {edge.label && (
                  <g transform={`translate(${edge.lx.toFixed(1)}, ${edge.ly.toFixed(1)})`}>
                    <rect
                      x={-textWidth / 2}
                      y={-9}
                      width={textWidth}
                      height={18}
                      rx={3}
                      className={styles.edgeLabelBg}
                      data-active={edge.active ? 'true' : undefined}
                    />
                    <text className={styles.edgeLabelText} data-active={edge.active ? 'true' : undefined}>
                      {edge.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        <div className={styles.levels}>
          {frame.levels.map((level, levelIdx) => {
            const isLeaf = levelIdx === frame.levels.length - 1;
            return (
              <div key={levelIdx} className={isLeaf ? styles.leafRow : styles.levelRow} data-level={levelIdx + 1}>
                {level.map((node, nodeIdx) => {
                  const next = isLeaf ? level[nodeIdx + 1] : undefined;
                  const link = next ? siblingMap.get(`${node.id}->${next.id}`) : undefined;
                  const emptySlots = node.capacity && node.kind === 'leaf'
                    ? Math.max(0, node.capacity - node.keys.length)
                    : 0;
                  return (
                    <Fragment key={node.id}>
                      <div
                        className={styles.node}
                        data-node={node.id}
                        data-kind={node.kind}
                        data-active={node.active ? 'true' : undefined}
                        data-visited={node.visited ? 'true' : undefined}
                        data-full={node.full ? 'true' : undefined}
                        data-dim={node.dim ? 'true' : undefined}
                      >
                        <div className={styles.nodeHeader}>
                          <span className={styles.nodeTitle}>{node.label}</span>
                          {node.badge
                            ? <span className={styles.nodeBadge}>{node.badge}</span>
                            : node.rangeHint && <span className={styles.rangeTag}>{node.rangeHint}</span>}
                        </div>
                        <div className={styles.keys}>
                          {node.keys.map((key) => (
                            <span
                              key={key}
                              className={styles.keyCell}
                              data-key-id={`${node.id}:${key}`}
                              data-state={frame.keyStates?.[node.id]?.[key]}
                            >
                              {key}
                            </span>
                          ))}
                          {Array.from({ length: emptySlots }, (_, idx) => (
                            <span key={`empty-${idx}`} className={styles.keySlotEmpty} aria-hidden="true">·</span>
                          ))}
                        </div>
                      </div>
                      {link && (
                        <span
                          className={styles.siblingSlot}
                          data-active={link.active ? 'true' : undefined}
                          aria-hidden="true"
                        >
                          ↔
                        </span>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {frame.storage && (
        <>
          <div
            className={styles.jumpDivider}
            data-active={frame.storage.dividerActive ? 'true' : undefined}
            data-skip={frame.storage.dividerSkip ? 'true' : undefined}
          >
            {frame.storage.dividerText}
          </div>
          <div className={styles.storageGrid} data-zone="storage">
            {frame.storage.pages.map((page) => (
              <div
                key={page.id}
                className={styles.storagePage}
                data-active={page.active ? 'true' : undefined}
                data-dim={page.dim ? 'true' : undefined}
              >
                <div className={styles.nodeHeader}>
                  <span className={styles.nodeTitle}>{page.title}</span>
                  {page.badge && <span className={styles.nodeBadge}>{page.badge}</span>}
                </div>
                {page.rows.map((row) => (
                  <div key={row.id} className={styles.storageRow} data-matched={row.matched ? 'true' : undefined}>
                    <span>{row.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ExtBTreeWorkbench({
  id,
  title,
  modeAriaLabel,
  modes,
}: {
  id: string;
  title: string;
  modeAriaLabel: string;
  modes: WorkbenchMode<ExtTreeFrame>[];
}) {
  return (
    <WorkbenchShell
      id={id}
      title={title}
      modeAriaLabel={modeAriaLabel}
      disclaimer="Mô hình fanout nhỏ để minh họa cấu trúc B+Tree; không đo I/O đĩa thật."
      modes={modes}
      renderStage={(frame) => <TreeStage frame={frame} />}
    />
  );
}

export function PrimaryKeySplitAnimation() {
  return (
    <ExtBTreeWorkbench
      id="primary-key-split-animation"
      title="Mô phỏng chèn Sequential (BIGSERIAL / UUIDv7) vs Random (UUIDv4) trên B+Tree"
      modeAriaLabel="Chọn chiến lược Primary Key"
      modes={primaryKeyModes}
    />
  );
}

export function CompositeIndexAnimation() {
  return (
    <ExtBTreeWorkbench
      id="composite-index-animation"
      title="Mô phỏng Composite Index, Leftmost Prefix và Access vs Filter Predicate"
      modeAriaLabel="Chọn kịch bản truy vấn Composite Index"
      modes={compositeIndexModes}
    />
  );
}

export function ClusteredLookupAnimation() {
  return (
    <ExtBTreeWorkbench
      id="clustered-lookup-animation"
      title="Mô phỏng đường đi từ Index tới Row thật: Clustered, Heap CTID, Double Lookup và Covering"
      modeAriaLabel="Chọn kiến trúc lưu trữ Index"
      modes={clusteredLookupModes}
    />
  );
}

export function LikePatternAnimation() {
  return (
    <ExtBTreeWorkbench
      id="like-pattern-animation"
      title="Mô phỏng truy vấn LIKE trên B+Tree: Prefix Range Scan vs Leading Wildcard"
      modeAriaLabel="Chọn mẫu LIKE"
      modes={likePatternModes}
    />
  );
}

export function OffsetPaginationAnimation() {
  return (
    <ExtBTreeWorkbench
      id="offset-pagination-animation"
      title="Mô phỏng phân trang OFFSET vs Keyset / Seek trên B+Tree"
      modeAriaLabel="Chọn chiến lược phân trang"
      modes={offsetPaginationModes}
    />
  );
}
