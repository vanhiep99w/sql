'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import styles from './workbench.module.css';

const reducedMotion = '(prefers-reduced-motion: reduce)';

export type MetricItem = {
  label: string;
  value: string;
  warn?: boolean;
};

export type StatItem = {
  label: string;
  value: string;
  tone?: 'warn';
};

export type LogItem = {
  id: string;
  text: string;
  tone?: 'warn';
};

export type BaseFrame = {
  phase: string;
  action: string;
  note: string;
  query: string;
  gate?: { text: string; tone?: 'ok' | 'miss' | 'warn' | 'bad' };
  metrics: MetricItem[];
  stats: StatItem[];
  logs: LogItem[];
  newLogId?: string;
};

export type WorkbenchMode<F extends BaseFrame> = {
  id: string;
  label: string;
  frames: F[];
};

type Props<F extends BaseFrame> = {
  id: string;
  title: string;
  modeAriaLabel: string;
  disclaimer?: string;
  statsHeading?: string;
  logsHeading?: string;
  emptyLogsText?: string;
  modes: WorkbenchMode<F>[];
  initialModeId?: string;
  renderStage: (frame: F, modeId: string) => ReactNode;
};

export function WorkbenchShell<F extends BaseFrame>({
  id,
  title,
  modeAriaLabel,
  disclaimer = 'Mô hình minh họa rút gọn theo cơ chế hoạt động; không đo thời gian thực thi thật.',
  statsHeading = 'Thông số bước hiện tại',
  logsHeading = 'Diễn biến từng bước',
  emptyLogsText = 'Bấm Bước sau để theo dõi diễn biến từng bước.',
  modes,
  initialModeId,
  renderStage,
}: Props<F>) {
  const defaultMode = initialModeId ?? modes[0].id;
  const [cursor, setCursor] = useState<{ mode: string; step: number; playing: boolean }>({
    mode: defaultMode,
    step: 0,
    playing: false,
  });
  const [speed, setSpeed] = useState(1300);
  const label = useId();

  const currentMode = modes.find((m) => m.id === cursor.mode) ?? modes[0];
  const frames = currentMode.frames;
  const step = Math.min(cursor.step, frames.length - 1);
  const frame = frames[step];
  const last = frames.length - 1;
  const { playing } = cursor;

  const seek = useCallback((nextStep: number, nextMode = currentMode.id) => {
    setCursor({ mode: nextMode, step: nextStep, playing: false });
  }, [currentMode.id]);

  const forward = useCallback((autoplay: boolean) => {
    const from = step === last ? 0 : step;
    const next = from + 1;
    setCursor({ mode: currentMode.id, step: next, playing: autoplay && next < last });
  }, [currentMode.id, step, last]);

  const backward = useCallback(() => {
    if (step === 0) return;
    setCursor({ mode: currentMode.id, step: step - 1, playing: false });
  }, [currentMode.id, step]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => forward(true), speed);
    return () => window.clearTimeout(timer);
  }, [playing, forward, speed]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(reducedMotion);
    const onChange = () => {
      if (media.matches) setCursor((prev) => ({ ...prev, playing: false }));
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return (
    <section id={id} className={`${styles.lab} not-prose`} aria-label={title}>
      {modes.length > 1 && (
        <div className={styles.modes} role="group" aria-label={modeAriaLabel}>
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={currentMode.id === m.id}
              onClick={() => { if (currentMode.id !== m.id) seek(0, m.id); }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

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

      <div className={styles.metrics} aria-label="Thông số tóm tắt">
        {frame.metrics.map((metric) => (
          <span key={metric.label} className={metric.warn ? styles.metricWarn : undefined}>
            {metric.label}: <strong>{metric.value}</strong>
          </span>
        ))}
        <small>{disclaimer}</small>
      </div>

      <div className={styles.stage}>
        <div className={styles.canvas} data-zone="stage">
          <div className={styles.canvasHeader}>
            <code className={styles.queryPill}>{frame.query}</code>
            {frame.gate && (
              <div className={styles.statusRow}>
                <strong className={styles.gate} data-tone={frame.gate.tone}>
                  {frame.gate.text}
                </strong>
              </div>
            )}
          </div>

          {renderStage(frame, currentMode.id)}

          <div className={styles.event} aria-live="polite" aria-atomic="true">
            <span className={styles.index}>{frame.phase}</span>
            <h4>{frame.action}</h4>
            <p>{frame.note}</p>
          </div>
        </div>

        <div className={styles.summary}>
          <section className={styles.summaryBox} aria-labelledby={`${label}-stats`}>
            <h3 className={styles.sectionTitle} id={`${label}-stats`}>
              <span className={styles.index} aria-hidden="true">01</span> {statsHeading}
            </h3>
            <div className={styles.statGrid}>
              {frame.stats.map((stat) => (
                <div key={stat.label} className={styles.statCard} data-tone={stat.tone}>
                  <small>{stat.label}</small>
                  <strong>{stat.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.summaryBox} data-zone="logs" aria-labelledby={`${label}-logs`}>
            <h3 className={styles.sectionTitle} id={`${label}-logs`}>
              <span className={styles.index} aria-hidden="true">02</span> {logsHeading}
              <span className={`${styles.index} ${styles.count}`}>{frame.logs.length} BƯỚC</span>
            </h3>
            {!frame.logs.length ? (
              <p className={styles.empty}>{emptyLogsText}</p>
            ) : (
              <ol className={styles.logList} aria-label="Nhật ký mô phỏng">
                {frame.logs.map((entry, idx) => (
                  <li
                    key={entry.id}
                    className={styles.logItem}
                    data-tone={entry.tone}
                    data-new={entry.id === frame.newLogId ? 'true' : undefined}
                  >
                    <span>0{idx + 1}</span>
                    {entry.text}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>

      <noscript><p>Bật JavaScript để chạy mô phỏng tương tác.</p></noscript>
    </section>
  );
}
