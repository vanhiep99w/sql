'use client';

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { captureTransition } from './motion';
import { traces, type Frame, type Mode, type TreeNode } from './trace';
import styles from './btree-animation.module.css';

const searchModes: Partial<Record<Mode, string>> = {
  exact: 'Tìm chính xác (id = 42)',
  range: 'Quét khoảng (35..75)',
};

const splitModes: Partial<Record<Mode, string>> = {
  insertRoom: 'Chèn còn chỗ (47)',
  leafSplit: 'Chia leaf đầy (Page Split)',
  rootSplit: 'Root đầy → Tăng chiều cao',
};

const reducedMotion = '(prefers-reduced-motion: reduce)';

type ComputedEdge = {
  key: string;
  d: string;
  lx: number;
  ly: number;
  label?: string;
  active?: boolean;
  dashed?: boolean;
};

function keyState(frame: Frame, nodeId: string, key: number) {
  if (frame.stoppedKeys?.[nodeId]?.includes(key)) return 'stopped';
  if (frame.matchedKeys?.[nodeId]?.includes(key)) return 'matched';
  if (frame.newKeys?.[nodeId]?.includes(key)) return 'new';
  if (frame.comparingKeys?.[nodeId]?.includes(key)) return 'comparing';
  return undefined;
}

function NodeCard({ node, frame }: { node: TreeNode; frame: Frame }) {
  const emptySlots = node.capacity && node.kind === 'leaf'
    ? Math.max(0, node.capacity - node.keys.length)
    : 0;

  return (
    <div
      className={styles.node}
      data-node={node.id}
      data-kind={node.kind}
      data-active={node.active ? 'true' : undefined}
      data-visited={node.visited ? 'true' : undefined}
      data-full={node.full ? 'true' : undefined}
      data-new={node.isNew ? 'true' : undefined}
      data-pending={node.pendingParent ? 'true' : undefined}
      aria-label={`${node.label}: ${node.keys.join(', ')}`}
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
            data-state={keyState(frame, node.id, key)}
          >
            {key}
          </span>
        ))}
        {Array.from({ length: emptySlots }, (_, index) => (
          <span key={`empty-${index}`} className={styles.keySlotEmpty} aria-hidden="true">·</span>
        ))}
      </div>
    </div>
  );
}

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

function computeEdges(viewport: HTMLElement, frame: Frame): ComputedEdge[] {
  if (!viewport.offsetWidth || !viewport.offsetHeight) return [];

  const nodesById = new Map<string, TreeNode>();
  for (const level of frame.levels) {
    for (const node of level) nodesById.set(node.id, node);
  }

  const out: ComputedEdge[] = [];
  for (const edge of frame.edges) {
    const parentEl = viewport.querySelector<HTMLElement>(`[data-node="${edge.from}"]`);
    const childEl = viewport.querySelector<HTMLElement>(`[data-node="${edge.to}"]`);
    const parentNode = nodesById.get(edge.from);
    if (!parentEl || !childEl || !parentNode) continue;

    // Use offset geometry instead of getBoundingClientRect so active FLIP transforms never skew wires.
    const pBox = layoutBoxIn(parentEl, viewport);
    const cBox = layoutBoxIn(childEl, viewport);
    const totalBranches = Math.max(1, parentNode.keys.length + 1);
    const ratio = (edge.branchIndex + 0.5) / totalBranches;
    const x1 = pBox.left + pBox.width * ratio;
    const y1 = pBox.top + pBox.height;
    const x2 = cBox.left + cBox.width * 0.5;
    const y2 = cBox.top;
    const midY = y1 + (y2 - y1) * 0.52;
    const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    const lx = x1 + (x2 - x1) * 0.56;
    const ly = y1 + (y2 - y1) * 0.52;
    out.push({
      key: `${edge.from}-${edge.to}-${edge.branchIndex}`,
      d,
      lx,
      ly,
      label: edge.label,
      active: edge.active,
      dashed: edge.dashed,
    });
  }
  return out;
}

export function BTreeSearchAnimation() {
  return (
    <Workbench
      id="btree-search-animation"
      title="Mô phỏng tìm kiếm và quét khoảng trên B+Tree"
      variant="search"
    />
  );
}

export function BTreeSplitAnimation() {
  return (
    <Workbench
      id="btree-split-animation"
      title="Mô phỏng chèn dữ liệu và chia page trên B+Tree"
      variant="split"
    />
  );
}

function Workbench({
  id,
  title,
  variant,
}: {
  id: string;
  title: string;
  variant: 'search' | 'split';
}) {
  const isSplit = variant === 'split';
  const modes = isSplit ? splitModes : searchModes;
  const initialMode: Mode = isSplit ? 'insertRoom' : 'exact';
  const [cursor, setCursor] = useState<{ mode: Mode; step: number; playing: boolean }>({
    mode: initialMode,
    step: 0,
    playing: false,
  });
  const [speed, setSpeed] = useState(1300);
  const [computedEdges, setComputedEdges] = useState<ComputedEdge[]>([]);

  const { mode, step, playing } = cursor;
  const frames = traces[mode];
  const frame = frames[step];
  const last = frames.length - 1;

  const root = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof captureTransition> | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const heightAnimating = useRef(false);
  const label = useId();

  const clearMotion = useCallback(() => {
    pending.current = null;
    cleanup.current?.();
    cleanup.current = null;
  }, []);

  const refreshEdges = useCallback(() => {
    if (!viewport.current) return;
    setComputedEdges(computeEdges(viewport.current, frame));
  }, [frame]);

  useLayoutEffect(() => {
    refreshEdges();
  }, [refreshEdges]);

  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!heightAnimating.current) refreshEdges();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [refreshEdges]);

  useLayoutEffect(() => {
    const start = pending.current;
    pending.current = null;
    if (!start || !layer.current || matchMedia(reducedMotion).matches) return;
    const end = start(layer.current);
    cleanup.current = end;
    return () => {
      if (cleanup.current !== end) return;
      end();
      cleanup.current = null;
    };
  }, [cursor]);

  useEffect(() => {
    const media = matchMedia(reducedMotion);
    media.addEventListener('change', clearMotion);
    return () => media.removeEventListener('change', clearMotion);
  }, [clearMotion]);

  const transitionCallbacks = useCallback(() => ({
    onHeightAnimating: (active: boolean) => {
      heightAnimating.current = active;
      if (!active) refreshEdges();
    },
  }), [refreshEdges]);

  const forward = useCallback((autoplay: boolean) => {
    const from = step === last ? 0 : step;
    const next = from + 1;
    clearMotion();
    if (root.current && !matchMedia(reducedMotion).matches) {
      pending.current = captureTransition(root.current, frames[step], frames[next], 'forward', transitionCallbacks());
    }
    setCursor({ mode, step: next, playing: autoplay && next < last });
  }, [mode, step, last, frames, clearMotion, transitionCallbacks]);

  const backward = useCallback(() => {
    if (step === 0) return;
    const prev = step - 1;
    clearMotion();
    if (root.current && !matchMedia(reducedMotion).matches) {
      pending.current = captureTransition(root.current, frames[step], frames[prev], 'backward', transitionCallbacks());
    }
    setCursor({ mode, step: prev, playing: false });
  }, [mode, step, frames, clearMotion, transitionCallbacks]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => forward(true), speed);
    return () => window.clearTimeout(timer);
  }, [playing, forward, speed]);

  function seek(next: number, nextMode: Mode = mode) {
    clearMotion();
    setCursor({ mode: nextMode, step: next, playing: false });
  }

  const siblingMap = new Map(frame.siblingLinks.map((link) => [`${link.from}->${link.to}`, link]));

  return (
    <section id={id} className={`${styles.lab} not-prose`} aria-label={title} ref={root}>
      <div
        className={styles.modes}
        role="group"
        aria-label={isSplit ? 'Chọn tình huống chèn và chia page' : 'Chọn kiểu truy vấn B+Tree'}
      >
        {(Object.keys(modes) as Mode[]).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={mode === name}
            onClick={() => { if (mode !== name) seek(0, name); }}
          >
            {modes[name]}
          </button>
        ))}
      </div>

      <div className={styles.transport}>
        <div className={styles.controls} role="group" aria-label="Điều khiển mô phỏng">
          <button
            className={styles.play}
            type="button"
            onClick={() => (playing ? seek(step) : forward(true))}
          >
            {playing ? 'Tạm dừng' : step === last ? 'Chạy lại' : 'Chạy'}
          </button>
          <button type="button" disabled={step === 0} onClick={backward}>
            Bước trước
          </button>
          <button type="button" disabled={step === last} onClick={() => forward(false)}>
            Bước sau
          </button>
          <button type="button" onClick={() => seek(0)}>
            Về đầu
          </button>
        </div>

        <label className={styles.speed}>
          Tốc độ
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            <option value={2600}>0,5×</option>
            <option value={1300}>1×</option>
            <option value={650}>2×</option>
          </select>
        </label>

        <div className={styles.scrub}>
          <input
            type="range"
            min={0}
            max={last}
            value={step}
            aria-label="Bước mô phỏng"
            aria-valuetext={`Bước ${step} trên ${last}`}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span aria-hidden="true">{step} / {last}</span>
        </div>
      </div>

      <div className={styles.metrics} aria-label="Thông số mô phỏng B+Tree">
        {isSplit ? (
          <>
            <span>Chiều cao: <strong>{frame.height} tầng</strong></span>
            <span>Số leaf: <strong>{frame.leafCount}</strong></span>
            <span>Số lần split: <strong>{frame.splits ?? 0}</strong></span>
          </>
        ) : (
          <>
            <span>Page index đã đọc: <strong>{frame.pagesRead?.length ?? 0}</strong></span>
            <span>Kết quả: <strong>{frame.results?.length ?? 0} key</strong></span>
          </>
        )}
        <small>Mô hình fanout nhỏ để minh họa cấu trúc; không đo thời gian hay I/O đĩa thật.</small>
      </div>

      <div className={styles.stage}>
        <div className={styles.canvas} data-zone="tree">
          <div className={styles.canvasHeader}>
            <code className={styles.queryPill}>{frame.query}</code>
            <div className={styles.statusRow}>
              {frame.incoming && (
                <span
                  className={styles.incomingChip}
                  data-tone={frame.incoming.tone}
                  data-incoming-key={frame.incoming.key}
                >
                  <span>{frame.incoming.label}</span>
                  <b>{frame.incoming.key}</b>
                </span>
              )}
              {frame.gate && (
                <strong className={styles.gate} data-tone={frame.gate.tone}>
                  {frame.gate.text}
                </strong>
              )}
            </div>
          </div>

          <div className={styles.treeViewport} data-tree-viewport ref={viewport}>
            <svg className={styles.svgLayer} data-svg-layer aria-hidden="true">
              {computedEdges.map((edge) => {
                const textWidth = edge.label ? Math.max(34, edge.label.length * 7 + 12) : 0;
                return (
                  <g key={edge.key}>
                    <path
                      d={edge.d}
                      data-edge-key={edge.key}
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
                        <text
                          className={styles.edgeLabelText}
                          data-active={edge.active ? 'true' : undefined}
                        >
                          {edge.label}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>

            <div className={styles.levels}>
              {frame.levels.map((level, levelIndex) => {
                const isLeafLevel = levelIndex === frame.levels.length - 1;
                return (
                  <div
                    key={levelIndex}
                    className={isLeafLevel ? styles.leafRow : styles.levelRow}
                    data-level={levelIndex + 1}
                  >
                    {level.map((node, nodeIndex) => {
                      const nextNode = isLeafLevel ? level[nodeIndex + 1] : undefined;
                      const link = nextNode ? siblingMap.get(`${node.id}->${nextNode.id}`) : undefined;
                      return (
                        <Fragment key={node.id}>
                          <NodeCard node={node} frame={frame} />
                          {link && (
                            <span
                              className={styles.siblingSlot}
                              data-sibling={`${link.from}-${link.to}`}
                              data-active={link.active ? 'true' : undefined}
                              aria-label={`Liên kết sibling giữa ${node.label} và ${nextNode!.label}`}
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

          <div className={styles.event} aria-live="polite" aria-atomic="true">
            <span className={styles.index}>{frame.phase}</span>
            <h4>{frame.action}</h4>
            <p>{frame.note}</p>
          </div>
        </div>

        <div className={styles.summary}>
          {isSplit ? (
            <>
              <section className={styles.summaryBox} aria-labelledby={`${label}-stats`}>
                <h3 className={styles.sectionTitle} id={`${label}-stats`}>
                  <span className={styles.index} aria-hidden="true">01</span> Trạng thái cây
                </h3>
                <div className={styles.statGrid}>
                  <div className={styles.statCard}>
                    <small>Chiều cao</small>
                    <strong>{frame.height} tầng</strong>
                  </div>
                  <div className={styles.statCard}>
                    <small>Số leaf</small>
                    <strong>{frame.leafCount} page</strong>
                  </div>
                  <div className={styles.statCard}>
                    <small>Page split</small>
                    <strong>{frame.splits ?? 0} lần</strong>
                  </div>
                </div>
              </section>
              <section className={styles.summaryBox} data-zone="changes" aria-labelledby={`${label}-changes`}>
                <h3 className={styles.sectionTitle} id={`${label}-changes`}>
                  <span className={styles.index} aria-hidden="true">02</span> Biến đổi cấu trúc
                  <span className={`${styles.index} ${styles.count}`}>{frame.changes?.length ?? 0} BƯỚC</span>
                </h3>
                {!frame.changes?.length && (
                  <p className={styles.empty}>Bấm Bước sau để theo dõi từng thay đổi trên cây.</p>
                )}
                <ol className={styles.changeList} aria-label="Nhật ký biến đổi cấu trúc B+Tree">
                  {frame.changes?.map((change, idx) => (
                    <li
                      key={change.id}
                      className={styles.changeItem}
                      data-new={change.id === frame.newChangeId ? 'true' : undefined}
                    >
                      <span>0{idx + 1}</span>
                      {change.text}
                    </li>
                  ))}
                </ol>
              </section>
            </>
          ) : (
            <>
              <section className={styles.summaryBox} data-zone="pages" aria-labelledby={`${label}-pages`}>
                <h3 className={styles.sectionTitle} id={`${label}-pages`}>
                  <span className={styles.index} aria-hidden="true">01</span> Đường đi qua các page
                  <span className={`${styles.index} ${styles.count}`}>{frame.pagesRead?.length ?? 0} PAGE</span>
                </h3>
                {!frame.pagesRead?.length ? (
                  <p className={styles.empty}>Chưa đọc page nào. Bấm Bước sau để bắt đầu từ Root.</p>
                ) : (
                  <ol className={styles.trail} aria-label="Các page index đã đọc">
                    {frame.pagesRead.map((pageName, idx) => (
                      <Fragment key={`${pageName}-${idx}`}>
                        {idx > 0 && <span className={styles.trailArrow} aria-hidden="true">→</span>}
                        <li className={styles.trailChip}>{pageName}</li>
                      </Fragment>
                    ))}
                  </ol>
                )}
              </section>
              <section className={styles.summaryBox} data-zone="output" aria-labelledby={`${label}-output`}>
                <h3 className={styles.sectionTitle} id={`${label}-output`}>
                  <span className={styles.index} aria-hidden="true">02</span> Kết quả tìm thấy
                  <span className={`${styles.index} ${styles.count}`}>{frame.results?.length ?? 0} KEY</span>
                </h3>
                {!frame.results?.length ? (
                  <p className={styles.empty}>Các key khớp điều kiện sẽ xuất hiện tại đây theo đúng thứ tự.</p>
                ) : (
                  <ul className={styles.resultList} aria-label="Các key khớp trên B+Tree">
                    {frame.results.map((item) => (
                      <li
                        key={item.key}
                        className={styles.resultItem}
                        data-result-key={item.key}
                        data-new={item.key === frame.newResultKey ? 'true' : undefined}
                      >
                        <code>{item.key}</code>
                        <span>{item.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      <noscript><p>Bật JavaScript để chạy mô phỏng B+Tree.</p></noscript>
      <div className={styles.layer} ref={layer} aria-hidden="true" data-animation-layer />
    </section>
  );
}
