'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { captureTransition } from './motion';
import { comparisonInputs, duplicateInputs, illustratedHash, indexEntries, inputs, ordersBuildInputs, pairId, sortedInputs, traces, type JoinRow, type Mode } from './trace';
import styles from './join-animation.module.css';

const joinModes = { loop: 'Nested Loop', hash: 'Hash Join', merge: 'Merge Join' };
const indexModes = { scan: 'Quét từng đơn', indexed: 'Tra index' };
const hashModes = { ordersBuild: 'Đơn trùng khóa và va chạm', duplicates: 'Khóa trùng hai bên: 2 × 3' };
const reducedMotion = '(prefers-reduced-motion: reduce)';

function Tokens({ rows, active, showHash = false }: { rows?: JoinRow[]; active?: Set<string>; showHash?: boolean }) {
  return rows?.map((row) => (
    <li key={row.id} data-row={row.id} data-active={active?.has(row.id)}
      className={`${styles.token} ${row.id.startsWith('c') ? styles.customer : styles.order}`}>
      <span>{row.label}{showHash && <small className={styles.hashValue}>hash {illustratedHash(row)}</small>}</span>
      <b aria-label={`Khóa ${row.key}`}>{row.key}</b>
    </li>
  ));
}

export function JoinAnimation() {
  return <Workbench id="join-animation" title="Mô phỏng ba thuật toán JOIN vật lý" />;
}

export function NestedLoopIndexAnimation() {
  return <Workbench id="nested-loop-index-animation" title="So sánh Nested Loop có và không dùng index" variant="index" />;
}

export function HashBucketAnimation() {
  return <Workbench id="hash-bucket-animation" title="Hash Join: dựng từ orders và duyệt bucket" variant="hash" />;
}

function Workbench({ id, title, variant = 'join' }: { id: string; title: string; variant?: 'join' | 'index' | 'hash' }) {
  const comparison = variant === 'index';
  const hashDetails = variant === 'hash';
  const modes: Partial<Record<Mode, string>> = hashDetails ? hashModes : comparison ? indexModes : joinModes;
  const [cursor, setCursor] = useState({ mode: (hashDetails ? 'ordersBuild' : comparison ? 'scan' : 'loop') as Mode, step: 0, playing: false });
  const [speed, setSpeed] = useState(1300);
  const { mode, step, playing } = cursor;
  const frames = traces[mode];
  const frame = frames[step];
  const last = frames.length - 1;
  const rows = mode === 'duplicates' ? duplicateInputs : hashDetails ? ordersBuildInputs
    : comparison ? comparisonInputs : frame.sorted ? sortedInputs : inputs;
  const active = new Set([...(frame.left ?? []), ...(frame.right ?? []), ...(frame.build ? [frame.build] : [])].map((row) => row.id));
  const root = useRef<HTMLElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof captureTransition> | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const label = useId();

  const clearMotion = useCallback(() => {
    pending.current = null;
    cleanup.current?.();
    cleanup.current = null;
  }, []);

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

  const forward = useCallback((autoplay: boolean) => {
    const from = step === last ? 0 : step;
    const next = from + 1;
    clearMotion();
    if (root.current && !matchMedia(reducedMotion).matches) {
      // At restart the completed work area is cleared, but the inputs are still visible.
      pending.current = captureTransition(root.current, frames[step], frames[next]);
    }
    setCursor({ mode, step: next, playing: autoplay && next < last });
  }, [mode, step, last, frames, clearMotion]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => forward(true), speed);
    return () => window.clearTimeout(timer);
  }, [playing, forward, speed]);

  function seek(next: number, nextMode = mode) {
    clearMotion();
    setCursor({ mode: nextMode, step: next, playing: false });
  }

  return (
    <section id={id} className={`${styles.lab} not-prose`} aria-label={title} ref={root}>
      <div className={styles.modes} role="group" aria-label={hashDetails ? 'Chọn dữ liệu Hash Join' : comparison ? 'Chọn cách tìm đơn ở inner' : 'Chọn thuật toán'}>
        {(Object.keys(modes) as Mode[]).map((name) => (
          <button key={name} type="button" aria-pressed={mode === name} onClick={() => { if (mode !== name) seek(0, name); }}>{modes[name]}</button>
        ))}
      </div>
      <div className={styles.transport}>
        <div className={styles.controls} role="group" aria-label="Điều khiển mô phỏng">
          <button className={styles.play} type="button" onClick={() => playing ? seek(step) : forward(true)}>
            {playing ? 'Tạm dừng' : step === last ? 'Chạy lại' : 'Chạy'}
          </button>
          <button type="button" disabled={step === 0} onClick={() => seek(step - 1)}>Bước trước</button>
          <button type="button" disabled={step === last} onClick={() => forward(false)}>Bước sau</button>
          <button type="button" onClick={() => seek(0)}>Về đầu</button>
        </div>
        <label className={styles.speed}>Tốc độ
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            <option value={2600}>0,5×</option><option value={1300}>1×</option><option value={650}>2×</option>
          </select>
        </label>
        <div className={styles.scrub}>
          <input type="range" min={0} max={last} value={step} aria-label="Bước mô phỏng"
            aria-valuetext={`Bước ${step} trên ${last}`} onChange={(event) => seek(Number(event.target.value))} />
          <span aria-hidden="true">{step} / {last}</span>
        </div>
      </div>
      {comparison && (
        <div className={styles.metrics} aria-label="Số thao tác trên inner">
          {mode === 'indexed'
            ? <span><strong>{frame.probes ?? 0}</strong> lượt tra index</span>
            : <span><strong>{frame.comparisons ?? 0}</strong> cặp khách–đơn đã so</span>}
          <small>Hai bộ đếm đo thao tác khác nhau, không phải I/O hay thời gian.</small>
        </div>
      )}
      <div className={styles.stage}>
        <section className={styles.source} data-zone="inputs" aria-labelledby={`${label}-input`}>
          <h3 className={styles.sectionTitle} id={`${label}-input`}><span className={styles.index} aria-hidden="true">01</span> Đầu vào</h3>
          <div className={styles.decks}>
            <div><h4>customers</h4>{hashDetails && <small className={styles.role}>Dò theo id</small>}<ul className={styles.rows} aria-label="customers"><Tokens rows={rows.customers} active={active} /></ul></div>
            <div><h4>orders</h4>{hashDetails && <small className={styles.role}>Dựng theo customer_id</small>}<ul className={styles.rows} aria-label="orders"><Tokens rows={rows.orders} active={active} /></ul></div>
          </div>
        </section>
        <section className={styles.operator} aria-labelledby={`${label}-operator`}>
          <h3 className={styles.sectionTitle} id={`${label}-operator`}><span className={styles.index} aria-hidden="true">02</span> Bộ xử lý</h3>
          <div className={styles.slots}>
            <ul className={styles.slot} data-zone="left" aria-label="Khách đang xét"><Tokens rows={frame.left} showHash={hashDetails} /></ul>
            <strong className={styles.gate} data-gate data-value={frame.gate && frame.gate !== '=' ? 'miss' : ''} aria-hidden="true">{frame.gate ?? '·'}</strong>
            <ul className={styles.slot} data-zone="right" aria-label="Đơn đang xét"><Tokens rows={frame.right} showHash={hashDetails} /></ul>
          </div>
          {(mode === 'hash' || hashDetails) && (
            <div className={styles.bank} data-zone="bank" role="group" aria-label={hashDetails ? 'Bảng băm dựng từ orders' : 'Bảng băm, h(key) = key % 2'}>
              {[0, 1].map((index) => (
                <div key={index} className={styles.bucket} data-active={frame.bucket === index}>
                  <span className={styles.index}>BUCKET {index}</span>
                  <ul aria-label={`Bucket ${index}`}><Tokens rows={frame.buckets?.[index]} showHash={hashDetails}
                    active={hashDetails && frame.right?.length ? new Set(frame.right.map((row) => row.id)) : undefined} /></ul>
                </div>
              ))}
            </div>
          )}
          {mode === 'indexed' && (
            <div className={styles.indexPanel} data-zone="index">
              <span className={styles.index}>INDEX <code>orders.customer_id</code></span>
              <ul className={styles.entries} aria-label="Mục lá của index">
                {indexEntries.map(([key, entries]) => (
                  <li key={key} data-active={frame.indexKey === key}>
                    <b aria-label={`Khóa ${key}`}>{key}</b>
                    <span className={styles.refs}>{entries.map((order) => (
                      <code key={order.id} data-row={order.id}>{order.label}</code>
                    ))}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className={styles.event} aria-live="polite" aria-atomic="true">
            <span className={styles.index}>{frame.phase}</span><h4>{frame.action}</h4><p>{frame.note}</p>
          </div>
        </section>
        <section className={styles.result} data-zone="output" aria-labelledby={`${label}-output`}>
          <h3 className={styles.sectionTitle} id={`${label}-output`}>
            <span className={styles.index} aria-hidden="true">03</span> Kết quả <span className={styles.index}>{frame.pairs.length} CẶP</span>
          </h3>
          {frame.pairs.length === 0 && <p className={styles.empty}>Chỉ cặp có khóa bằng nhau đi tiếp.</p>}
          <ul className={styles.rows} aria-label="Các cặp INNER JOIN">
            {frame.pairs.map((pair) => (
              <li key={pairId(pair)} data-row={pairId(pair)} data-new={pair === frame.pair} className={styles.pair}>
                <code>{pair[0].key}</code><strong>{pair[0].label}</strong><code>{pair[1].label}</code>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <noscript><p>Bật JavaScript để chạy mô phỏng.</p></noscript>
      <div className={styles.layer} ref={layer} aria-hidden="true" data-animation-layer />
    </section>
  );
}
