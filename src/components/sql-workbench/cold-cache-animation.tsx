'use client';

import { WorkbenchShell, type BaseFrame, type WorkbenchMode } from './workbench-shell';
import styles from './workbench.module.css';

type PageSlot = {
  id: string;
  label: string;
  state: 'hit' | 'miss' | 'load' | 'empty' | 'idle';
};

type CacheTier = {
  id: string;
  name: string;
  latency: string;
  badge: string;
  badgeTone?: 'ok' | 'warn' | 'bad' | 'solid';
  state?: 'active' | 'warn' | 'bad' | 'dim';
  pages: PageSlot[];
};

type CacheFrame = BaseFrame & {
  tiers: CacheTier[];
};

const cacheModes: WorkbenchMode<CacheFrame>[] = [
  {
    id: 'cold',
    label: 'Lần chạy 1 — Cold Cache (~2s)',
    frames: [
      {
        phase: 'Khởi động lạnh',
        action: 'Query cần đọc 4 page (Idx Root, Idx Leaf, Heap P12, Heap P48) — Buffer Pool đang trống',
        note: 'Execution plan đã dùng đúng index, nhưng dữ liệu vẫn còn nằm nguội trên ổ đĩa (chưa có trong RAM).',
        query: 'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE user_id = 12345 LIMIT 20;',
        metrics: [
          { label: 'shared hit', value: '0' },
          { label: 'shared read', value: '0' },
          { label: 'Độ trễ minh họa', value: 'Cold start' },
        ],
        stats: [
          { label: 'Buffer Pool', value: '0 / 4 page cần' },
          { label: 'OS Page Cache', value: 'Trống (vừa restart)' },
        ],
        logs: [{ id: 'cc0', text: 'Query cần 4 page: Root, Leaf, Heap #12, Heap #48. Buffer Pool hoàn toàn trống.' }],
        newLogId: 'cc0',
        tiers: [
          {
            id: 'bp', name: 'Tầng 1: Buffer Pool (RAM DB)', latency: '~100 ns', badge: 'TRỐNG', state: 'dim',
            pages: [
              { id: 'b1', label: '·', state: 'empty' },
              { id: 'b2', label: '·', state: 'empty' },
              { id: 'b3', label: '·', state: 'empty' },
              { id: 'b4', label: '·', state: 'empty' },
            ],
          },
          {
            id: 'os', name: 'Tầng 2: OS Page Cache (RAM Kernel)', latency: '~2 µs', badge: 'TRỐNG', state: 'dim',
            pages: [
              { id: 'o1', label: '·', state: 'empty' },
              { id: 'o2', label: '·', state: 'empty' },
              { id: 'o3', label: '·', state: 'empty' },
              { id: 'o4', label: '·', state: 'empty' },
            ],
          },
          {
            id: 'disk', name: 'Tầng 3: Disk (SSD / HDD)', latency: '100 µs – 10 ms', badge: 'CHỨA DATA', badgeTone: 'warn',
            pages: [
              { id: 'd1', label: 'Root', state: 'idle' },
              { id: 'd2', label: 'Leaf', state: 'idle' },
              { id: 'd3', label: 'Heap #12', state: 'idle' },
              { id: 'd4', label: 'Heap #48', state: 'idle' },
            ],
          },
        ],
      },
      {
        phase: 'Cache Miss liên tiếp → Random Disk Read',
        action: 'Buffer Pool MISS → OS Page Cache MISS → phải phát sinh 4 random read từ Disk!',
        note: 'Mỗi random I/O xuống đĩa chậm hơn RAM từ hàng nghìn tới hàng chục nghìn lần. Trên bảng thực tế chạm hàng nghìn page rải rác, tổng thời gian vọt lên ~2 giây.',
        query: '-- Buffers: shared hit=0 read=4  (100% miss phải xuống Disk)',
        gate: { text: 'MISS ở cả 2 tầng RAM → Random Disk I/O (chậm 500×–50.000×)', tone: 'bad' },
        metrics: [
          { label: 'shared hit', value: '0', warn: true },
          { label: 'shared read', value: '4 (Disk!)', warn: true },
          { label: 'Độ trễ minh họa', value: '~2.000 ms', warn: true },
        ],
        stats: [
          { label: 'Cache Hit Ratio', value: '0%', tone: 'warn' },
          { label: 'Thủ phạm chính', value: 'Random Disk I/O', tone: 'warn' },
        ],
        logs: [
          { id: 'cc0', text: 'Query cần 4 page: Root, Leaf, Heap #12, Heap #48. Buffer Pool hoàn toàn trống.' },
          { id: 'cc1', text: '4/4 page đều MISS tại Buffer Pool & OS Cache → phải đọc vật lý từ Disk.', tone: 'warn' },
        ],
        newLogId: 'cc1',
        tiers: [
          {
            id: 'bp', name: 'Tầng 1: Buffer Pool (RAM DB)', latency: '~100 ns', badge: '4 MISS', badgeTone: 'bad', state: 'bad',
            pages: [
              { id: 'b1', label: 'Root ✕', state: 'miss' },
              { id: 'b2', label: 'Leaf ✕', state: 'miss' },
              { id: 'b3', label: 'H#12 ✕', state: 'miss' },
              { id: 'b4', label: 'H#48 ✕', state: 'miss' },
            ],
          },
          {
            id: 'os', name: 'Tầng 2: OS Page Cache (RAM Kernel)', latency: '~2 µs', badge: '4 MISS', badgeTone: 'bad', state: 'bad',
            pages: [
              { id: 'o1', label: 'Root ✕', state: 'miss' },
              { id: 'o2', label: 'Leaf ✕', state: 'miss' },
              { id: 'o3', label: 'H#12 ✕', state: 'miss' },
              { id: 'o4', label: 'H#48 ✕', state: 'miss' },
            ],
          },
          {
            id: 'disk', name: 'Tầng 3: Disk (SSD / HDD)', latency: '100 µs – 10 ms', badge: 'RANDOM READ', badgeTone: 'warn', state: 'warn',
            pages: [
              { id: 'd1', label: 'Root ↑', state: 'load' },
              { id: 'd2', label: 'Leaf ↑', state: 'load' },
              { id: 'd3', label: 'Heap #12 ↑', state: 'load' },
              { id: 'd4', label: 'Heap #48 ↑', state: 'load' },
            ],
          },
        ],
      },
      {
        phase: 'Nạp ấm (Warm-up)',
        action: 'Các page vừa đọc xong được giữ lại trong OS Cache & Buffer Pool cho các lần chạy sau',
        note: 'Lần chạy đầu tiên tuy chậm (~2s) nhưng vô tình làm ấm (warm up) bộ nhớ đệm. Từ lần chạy thứ 2 trở đi mọi thứ thay đổi hoàn toàn!',
        query: '-- Xong lần 1: cả 4 page đã nằm sẵn trong Buffer Pool!',
        gate: { text: 'Buffer Pool đã ấm (4/4 page nằm trên RAM)', tone: 'ok' },
        metrics: [
          { label: 'shared hit', value: '0' },
          { label: 'shared read', value: '4' },
          { label: 'Trạng thái cache', value: 'ĐÃ ẤM' },
        ],
        stats: [
          { label: 'Buffer Pool', value: '4/4 page đã nạp' },
          { label: 'Lần chạy kế', value: 'Chuyển tab Warm Cache →' },
        ],
        logs: [
          { id: 'cc0', text: 'Query cần 4 page: Root, Leaf, Heap #12, Heap #48. Buffer Pool hoàn toàn trống.' },
          { id: 'cc1', text: '4/4 page đều MISS tại Buffer Pool & OS Cache → phải đọc vật lý từ Disk.', tone: 'warn' },
          { id: 'cc2', text: 'Cả 4 page đã được nạp lên Buffer Pool & OS Cache sẵn sàng cho lần chạy sau.' },
        ],
        newLogId: 'cc2',
        tiers: [
          {
            id: 'bp', name: 'Tầng 1: Buffer Pool (RAM DB)', latency: '~100 ns', badge: 'ĐÃ NẠP 4 PAGE', badgeTone: 'ok', state: 'active',
            pages: [
              { id: 'b1', label: 'Root', state: 'load' },
              { id: 'b2', label: 'Leaf', state: 'load' },
              { id: 'b3', label: 'Heap #12', state: 'load' },
              { id: 'b4', label: 'Heap #48', state: 'load' },
            ],
          },
          {
            id: 'os', name: 'Tầng 2: OS Page Cache (RAM Kernel)', latency: '~2 µs', badge: 'ĐÃ NẠP', badgeTone: 'ok',
            pages: [
              { id: 'o1', label: 'Root', state: 'idle' },
              { id: 'o2', label: 'Leaf', state: 'idle' },
              { id: 'o3', label: 'Heap #12', state: 'idle' },
              { id: 'o4', label: 'Heap #48', state: 'idle' },
            ],
          },
          {
            id: 'disk', name: 'Tầng 3: Disk (SSD / HDD)', latency: '100 µs – 10 ms', badge: 'NGHỈ', state: 'dim',
            pages: [
              { id: 'd1', label: 'Root', state: 'idle' },
              { id: 'd2', label: 'Leaf', state: 'idle' },
              { id: 'd3', label: 'Heap #12', state: 'idle' },
              { id: 'd4', label: 'Heap #48', state: 'idle' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'warm',
    label: 'Lần chạy 2 — Warm Cache (~50ms)',
    frames: [
      {
        phase: '100% Buffer Pool HIT',
        action: 'Cùng câu SQL, cùng Execution Plan — nhưng cả 4 page đều HIT ngay tại Buffer Pool (RAM)!',
        note: 'Không cần chạm OS Page Cache hay ổ đĩa Disk. Trong EXPLAIN (ANALYZE, BUFFERS), bạn sẽ thấy shared hit tăng tối đa và shared read = 0.',
        query: '-- Buffers: shared hit=4 read=0  (0 Disk I/O • nhanh hơn ~40×)',
        gate: { text: '100% RAM HIT • 0 Disk I/O • ~50 ms!', tone: 'ok' },
        metrics: [
          { label: 'shared hit', value: '4 (100%)' },
          { label: 'shared read', value: '0' },
          { label: 'Độ trễ minh họa', value: '~50 ms' },
        ],
        stats: [
          { label: 'Cache Hit Ratio', value: '100% (shared hit=4)' },
          { label: 'Disk I/O', value: '0 lần đọc đĩa' },
        ],
        logs: [{ id: 'wc1', text: 'Cả 4 page (Root, Leaf, Heap #12, Heap #48) HIT ngay tại Buffer Pool (~100ns/page) — không đụng Disk!' }],
        newLogId: 'wc1',
        tiers: [
          {
            id: 'bp', name: 'Tầng 1: Buffer Pool (RAM DB)', latency: '~100 ns', badge: '4 / 4 HIT ⚡', badgeTone: 'solid', state: 'active',
            pages: [
              { id: 'b1', label: 'Root ✓', state: 'hit' },
              { id: 'b2', label: 'Leaf ✓', state: 'hit' },
              { id: 'b3', label: 'H#12 ✓', state: 'hit' },
              { id: 'b4', label: 'H#48 ✓', state: 'hit' },
            ],
          },
          {
            id: 'os', name: 'Tầng 2: OS Page Cache (RAM Kernel)', latency: '~2 µs', badge: 'KHÔNG CẦN ĐỤNG', state: 'dim',
            pages: [
              { id: 'o1', label: 'Root', state: 'idle' },
              { id: 'o2', label: 'Leaf', state: 'idle' },
              { id: 'o3', label: 'Heap #12', state: 'idle' },
              { id: 'o4', label: 'Heap #48', state: 'idle' },
            ],
          },
          {
            id: 'disk', name: 'Tầng 3: Disk (SSD / HDD)', latency: '100 µs – 10 ms', badge: '0 I/O', state: 'dim',
            pages: [
              { id: 'd1', label: 'Root', state: 'idle' },
              { id: 'd2', label: 'Leaf', state: 'idle' },
              { id: 'd3', label: 'Heap #12', state: 'idle' },
              { id: 'd4', label: 'Heap #48', state: 'idle' },
            ],
          },
        ],
      },
    ],
  },
];

export function ColdWarmCacheAnimation() {
  return (
    <WorkbenchShell
      id="cold-warm-cache-animation"
      title="Mô phỏng Cold Cache (Disk Read) so với Warm Cache (Buffer Pool Hit)"
      modeAriaLabel="Chọn trạng thái Cache"
      modes={cacheModes}
      renderStage={(frame) => (
        <div className={styles.tierStack}>
          {frame.tiers.map((tier) => (
            <div key={tier.id} className={styles.panelCard} data-state={tier.state}>
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>{tier.name} ({tier.latency})</span>
                <span className={styles.badge} data-tone={tier.badgeTone}>{tier.badge}</span>
              </div>
              <div className={styles.pageCells}>
                {tier.pages.map((p) => (
                  <span key={p.id} className={styles.pageCell} data-state={p.state}>
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    />
  );
}
