'use client';

import { WorkbenchShell, type BaseFrame, type WorkbenchMode } from './workbench-shell';
import styles from './workbench.module.css';

type BucketNode = {
  id: string;
  name: string;
  range: string;
  badge: string;
  badgeTone?: 'ok' | 'warn' | 'bad' | 'solid';
  detail: string;
  loadPct?: number;
  loadTone?: 'warn' | 'bad';
  state?: 'active' | 'warn' | 'bad' | 'dim';
};

type DistFrame = BaseFrame & {
  routerTitle: string;
  routerNote: string;
  buckets: BucketNode[];
};

const partitionModes: WorkbenchMode<DistFrame>[] = [
  {
    id: 'pruned',
    label: 'Có Partition Pruning (Đúng khóa)',
    frames: [
      {
        phase: 'Phân tích Partition Key',
        action: "Planner đọc predicate order_date = '2024-06-15' và so với biên RANGE",
        note: 'Điều kiện trực tiếp trên cột partition key (không bọc hàm) giúp Planner loại trừ các partition không thể chứa năm 2024 ngay lúc lập plan.',
        query: "SELECT * FROM orders WHERE order_date = '2024-06-15';  -- RANGE (order_date)",
        gate: { text: 'Cắt bỏ 3/4 partition không liên quan (Pruned!)', tone: 'ok' },
        metrics: [
          { label: 'Partition quét', value: '1 / 4' },
          { label: 'Bỏ qua (Pruned)', value: '3 partition' },
        ],
        stats: [
          { label: 'Dữ liệu quét', value: '40M / 130M rows' },
          { label: 'Pruning', value: 'Compile-time ✅' },
        ],
        logs: [{ id: 'p1', text: "Biên 2024-06-15 chỉ thuộc p_2024 → loại p_2021, p_2022, p_2023 trước khi mở file." }],
        newLogId: 'p1',
        routerTitle: 'Query Planner (Partition Pruning)',
        routerNote: "order_date = '2024-06-15' → chỉ giữ p_2024",
        buckets: [
          { id: 'p21', name: 'p_2021', range: '2021 (25M)', badge: 'PRUNED', detail: 'Bỏ qua hoàn toàn', state: 'dim' },
          { id: 'p22', name: 'p_2022', range: '2022 (30M)', badge: 'PRUNED', detail: 'Bỏ qua hoàn toàn', state: 'dim' },
          { id: 'p23', name: 'p_2023', range: '2023 (35M)', badge: 'PRUNED', detail: 'Bỏ qua hoàn toàn', state: 'dim' },
          { id: 'p24', name: 'p_2024', range: '2024 (40M)', badge: 'SCAN', badgeTone: 'solid', detail: 'Chỉ quét duy nhất partition này', state: 'active' },
        ],
      },
      {
        phase: 'Thực thi trên đúng p_2024',
        action: 'Chỉ dùng Local Index trong p_2024 để lấy đơn ngày 2024-06-15',
        note: 'Index của p_2024 nhỏ hơn nhiều so với 1 index khổng lồ của cả 4 năm, dễ nằm gọn trong Buffer Pool và không đụng file lạnh của 2021–2023.',
        query: "EXPLAIN SELECT * FROM orders WHERE order_date = '2024-06-15';  -- partitions: p_2024",
        gate: { text: 'Hoàn tất • 0 I/O trên p_2021..p_2023', tone: 'ok' },
        metrics: [
          { label: 'Partition quét', value: '1 / 4' },
          { label: 'Bỏ qua (Pruned)', value: '75% partition' },
        ],
        stats: [
          { label: 'Plan node', value: 'Index Scan on p_2024' },
          { label: 'Partition lạnh', value: 'Không mở file' },
        ],
        logs: [
          { id: 'p1', text: "Biên 2024-06-15 chỉ thuộc p_2024 → loại p_2021, p_2022, p_2023 trước khi mở file." },
          { id: 'p2', text: 'Quét đúng p_2024 bằng local index — bỏ qua 90M rows dữ liệu cũ.' },
        ],
        newLogId: 'p2',
        routerTitle: 'Executor',
        routerNote: 'Chỉ mở đúng 1 partition: p_2024',
        buckets: [
          { id: 'p21', name: 'p_2021', range: '2021 (25M)', badge: 'SKIPPED', detail: '0 page đọc', state: 'dim' },
          { id: 'p22', name: 'p_2022', range: '2022 (30M)', badge: 'SKIPPED', detail: '0 page đọc', state: 'dim' },
          { id: 'p23', name: 'p_2023', range: '2023 (35M)', badge: 'SKIPPED', detail: '0 page đọc', state: 'dim' },
          { id: 'p24', name: 'p_2024', range: '2024 (40M)', badge: 'HIT', badgeTone: 'ok', detail: 'Index Scan cục bộ hoàn tất', state: 'active' },
        ],
      },
    ],
  },
  {
    id: 'no-prune',
    label: 'Mất Pruning (Bọc hàm / Thiếu Partition Key)',
    frames: [
      {
        phase: 'Mất khả năng cắt tỉa',
        action: 'Bọc EXTRACT(YEAR FROM order_date) = 2024 hoặc lọc theo customer_id → phải quét CẢ 4 partition!',
        note: 'Khi cột partition bị bọc trong hàm (non-SARGable) hoặc query không có partition key, Planner không đối chiếu được với biên RANGE → Append tất cả partition con.',
        query: 'SELECT * FROM orders WHERE EXTRACT(YEAR FROM order_date) = 2024;  -- Không prune được!',
        gate: { text: 'NO PRUNING: Quét 4/4 partition (130M rows)!', tone: 'bad' },
        metrics: [
          { label: 'Partition quét', value: '4 / 4 (100%)', warn: true },
          { label: 'Bỏ qua (Pruned)', value: '0', warn: true },
        ],
        stats: [
          { label: 'Nguyên nhân', value: 'Bọc hàm trên partition key', tone: 'warn' },
          { label: 'Cách sửa', value: "order_date >= '2024-01-01' AND < '2025-01-01'" },
        ],
        logs: [{ id: 'np1', text: 'Bọc hàm EXTRACT(...) làm Planner bó tay → mở cả 4 partition p_2021..p_2024!', tone: 'warn' }],
        newLogId: 'np1',
        routerTitle: 'Query Planner (Append toàn bộ)',
        routerNote: 'Không đối chiếu được biên RANGE → fan-out 4/4 partition',
        buckets: [
          { id: 'p21', name: 'p_2021', range: '2021 (25M)', badge: 'SCAN', badgeTone: 'bad', detail: 'Bị quét oan dù 0 dòng 2024', state: 'bad' },
          { id: 'p22', name: 'p_2022', range: '2022 (30M)', badge: 'SCAN', badgeTone: 'bad', detail: 'Bị quét oan dù 0 dòng 2024', state: 'bad' },
          { id: 'p23', name: 'p_2023', range: '2023 (35M)', badge: 'SCAN', badgeTone: 'bad', detail: 'Bị quét oan dù 0 dòng 2024', state: 'bad' },
          { id: 'p24', name: 'p_2024', range: '2024 (40M)', badge: 'SCAN', badgeTone: 'warn', detail: 'Có dữ liệu nhưng gánh thêm 3 bảng kia', state: 'warn' },
        ],
      },
    ],
  },
];

export function PartitionPruningAnimation() {
  return (
    <WorkbenchShell
      id="partition-pruning-animation"
      title="Mô phỏng Partition Pruning: lọc đúng partition key so với bọc hàm mất pruning"
      modeAriaLabel="Chọn kịch bản Partition Pruning"
      modes={partitionModes}
      renderStage={(frame) => <DistributionStage frame={frame} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Sharding Routing: Single-Shard vs Scatter-Gather vs Hot Shard
// ---------------------------------------------------------------------------
const shardingModes: WorkbenchMode<DistFrame>[] = [
  {
    id: 'single',
    label: 'Single-Shard Lookup (Đúng Shard Key)',
    frames: [
      {
        phase: 'Hash Routing tới đúng 1 Shard',
        action: 'Router tính hash(author_id = 42) % 4 = 2 → gửi query thẳng tới Shard 2',
        note: 'Chỉ 1 network hop, không cần merge kết quả từ các shard khác. Tail latency phụ thuộc duy nhất 1 node.',
        query: 'SELECT * FROM posts WHERE author_id = 42 ORDER BY created_at DESC LIMIT 20;',
        gate: { text: '1/4 Shard được gọi • P99 ổn định', tone: 'ok' },
        metrics: [
          { label: 'Shard chạm tới', value: '1 / 4' },
          { label: 'Latency tổng', value: '12 ms' },
        ],
        stats: [
          { label: 'Định tuyến', value: 'hash(42) % 4 = Shard 2' },
          { label: 'Merge / Sort', value: 'Không cần' },
        ],
        logs: [{ id: 'sh1', text: 'Query chứa shard key author_id=42 → định tuyến thẳng Shard 2 (12ms).' }],
        newLogId: 'sh1',
        routerTitle: 'Shard Router',
        routerNote: 'hash(author_id=42) % 4 → Shard 2',
        buckets: [
          { id: 's0', name: 'Shard 0', range: 'hash % 4 == 0', badge: 'IDLE', detail: 'Không nhận query', loadPct: 22, state: 'dim' },
          { id: 's1', name: 'Shard 1', range: 'hash % 4 == 1', badge: 'IDLE', detail: 'Không nhận query', loadPct: 25, state: 'dim' },
          { id: 's2', name: 'Shard 2', range: 'hash % 4 == 2', badge: 'TARGET (12ms)', badgeTone: 'solid', detail: 'Trả thẳng 20 posts', loadPct: 28, state: 'active' },
          { id: 's3', name: 'Shard 3', range: 'hash % 4 == 3', badge: 'IDLE', detail: 'Không nhận query', loadPct: 24, state: 'dim' },
        ],
      },
    ],
  },
  {
    id: 'scatter',
    label: 'Scatter-Gather (Thiếu Shard Key)',
    frames: [
      {
        phase: 'Fan-out toàn cụm & chờ node chậm nhất',
        action: 'Query lọc theo hashtag (không có author_id) → Router phải bắn tới TẤT CẢ 4 shard rồi merge',
        note: 'Shard 0, 1, 2 xong trong 15–20ms nhưng Shard 3 bị GC/I/O spike mất 185ms → toàn bộ request phải chờ 185ms! Đó là hiệu ứng khuếch đại tail latency của scatter-gather.',
        query: "SELECT * FROM posts WHERE hashtag = '#sql' ORDER BY created_at DESC LIMIT 20;",
        gate: { text: 'Scatter-Gather 4/4 Shard • Bị kéo chậm theo Shard 3 (185ms)!', tone: 'bad' },
        metrics: [
          { label: 'Shard chạm tới', value: '4 / 4 (100%)', warn: true },
          { label: 'Latency tổng', value: 'max = 185 ms', warn: true },
        ],
        stats: [
          { label: 'Fan-out', value: 'Gấp 4× QPS lên DB', tone: 'warn' },
          { label: 'Giải pháp', value: 'Search Index / Derived Table' },
        ],
        logs: [{ id: 'sg1', text: 'Thiếu shard key → bắn cả 4 shard, đợi Shard 3 (185ms) rồi mới merge + sort trả client.', tone: 'warn' }],
        newLogId: 'sg1',
        routerTitle: 'Shard Router (Scatter-Gather + Merge)',
        routerNote: 'Fan-out 4 shards → chờ max(15, 18, 14, 185) = 185ms',
        buckets: [
          { id: 's0', name: 'Shard 0', range: '15 ms', badge: 'DONE', badgeTone: 'warn', detail: 'Xong sớm, chờ merge', loadPct: 55, state: 'warn' },
          { id: 's1', name: 'Shard 1', range: '18 ms', badge: 'DONE', badgeTone: 'warn', detail: 'Xong sớm, chờ merge', loadPct: 58, state: 'warn' },
          { id: 's2', name: 'Shard 2', range: '14 ms', badge: 'DONE', badgeTone: 'warn', detail: 'Xong sớm, chờ merge', loadPct: 52, state: 'warn' },
          { id: 's3', name: 'Shard 3', range: '185 ms (SLOW!)', badge: 'BOTTLENECK', badgeTone: 'bad', detail: 'Kéo tụt latency cả request', loadPct: 92, loadTone: 'bad', state: 'bad' },
        ],
      },
    ],
  },
  {
    id: 'hot-shard',
    label: 'Hot Shard (Celebrity / Skew)',
    frames: [
      {
        phase: 'Lệch tải cực đoan trên 1 Shard',
        action: 'Tài khoản Celebrity (author_id = 1) chiếm 80% traffic → dồn toàn bộ vào Shard 0',
        note: 'Thêm 10 shard mới cũng KHÔNG cứu được Shard 0 vì mọi request cho author_id = 1 vẫn hash về đúng 1 chỗ. Cần cache tầng đọc, salting key hoặc tách tenant VIP.',
        query: '-- 80% traffic đổ vào celebrity author_id = 1 → hash(1) % 4 = Shard 0',
        gate: { text: 'HOT SHARD: Shard 0 quá tải 96% CPU trong khi 3 shard kia rảnh!', tone: 'bad' },
        metrics: [
          { label: 'Shard 0 CPU', value: '96% (QUÁ TẢI)', warn: true },
          { label: 'Shard 1–3 CPU', value: '~10%' },
        ],
        stats: [
          { label: 'Nguyên nhân', value: 'Key skew (Celebrity / Tenant lớn)', tone: 'warn' },
          { label: 'Xử lý', value: 'Read Cache / Key Salting / Dedicated Shard' },
        ],
        logs: [{ id: 'hs1', text: 'Shard 0 chạm ngưỡng 96% CPU & timeout dù tổng tải toàn cụm mới chỉ ~30%!', tone: 'warn' }],
        newLogId: 'hs1',
        routerTitle: 'Shard Router (Key Skew)',
        routerNote: '80% request có cùng author_id = 1 → đâm hết vào Shard 0',
        buckets: [
          { id: 's0', name: 'Shard 0', range: 'author_id = 1 (VIP)', badge: '96% CPU 🔥', badgeTone: 'bad', detail: 'Quá tải, queue tăng vọt!', loadPct: 96, loadTone: 'bad', state: 'bad' },
          { id: 's1', name: 'Shard 1', range: 'Users thường', badge: '11% CPU', detail: 'Gần như nhàn rỗi', loadPct: 11, state: 'dim' },
          { id: 's2', name: 'Shard 2', range: 'Users thường', badge: '9% CPU', detail: 'Gần như nhàn rỗi', loadPct: 9, state: 'dim' },
          { id: 's3', name: 'Shard 3', range: 'Users thường', badge: '12% CPU', detail: 'Gần như nhàn rỗi', loadPct: 12, state: 'dim' },
        ],
      },
    ],
  },
];

export function ShardingRoutingAnimation() {
  return (
    <WorkbenchShell
      id="sharding-routing-animation"
      title="Mô phỏng định tuyến Sharding: Single-Shard, Scatter-Gather và Hot Shard"
      modeAriaLabel="Chọn kịch bản Sharding"
      modes={shardingModes}
      renderStage={(frame) => <DistributionStage frame={frame} />}
    />
  );
}

function DistributionStage({ frame }: { frame: DistFrame }) {
  return (
    <div className={styles.tierStack}>
      <div className={styles.panelCard} data-state="active">
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>{frame.routerTitle}</span>
          <span className={styles.badge} data-tone="ok">ROUTER</span>
        </div>
        <span className={styles.subText}>{frame.routerNote}</span>
      </div>

      <div className={styles.grid4}>
        {frame.buckets.map((b) => (
          <div key={b.id} className={styles.panelCard} data-state={b.state}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>{b.name}</span>
              <span className={styles.badge} data-tone={b.badgeTone}>{b.badge}</span>
            </div>
            <span className={styles.subText}>{b.range}</span>
            {b.loadPct !== undefined && (
              <div className={styles.barTrack} aria-label={`Mức tải ${b.loadPct}%`}>
                <div className={styles.barFill} data-tone={b.loadTone} style={{ width: `${b.loadPct}%` }} />
              </div>
            )}
            <span className={styles.subText}>{b.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
