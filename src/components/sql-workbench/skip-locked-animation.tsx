'use client';

import { WorkbenchShell, type BaseFrame, type WorkbenchMode } from './workbench-shell';
import styles from './workbench.module.css';

type JobRow = {
  id: number;
  payload: string;
  status: string;
  owner?: string;
  state?: 'active' | 'matched' | 'warn' | 'bad' | 'dim';
};

type WorkerCard = {
  id: string;
  name: string;
  badge: string;
  badgeTone?: 'ok' | 'warn' | 'bad' | 'solid';
  detail: string;
  state?: 'active' | 'warn' | 'bad' | 'dim';
};

type SkipLockedFrame = BaseFrame & {
  jobs: JobRow[];
  workers: WorkerCard[];
};

const skipLockedModes: WorkbenchMode<SkipLockedFrame>[] = [
  {
    id: 'skip-locked',
    label: 'FOR UPDATE SKIP LOCKED',
    frames: [
      {
        phase: 'Khởi tạo Queue',
        action: '3 worker cùng chạy câu claim 1 job sẵn sàng (status = queued)',
        note: 'Bảng jobs đang có 4 job đang chờ xử lý theo thứ tự ưu tiên id = 101..104.',
        query: "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;",
        metrics: [
          { label: 'Đã claim', value: '0 job' },
          { label: 'Worker bị chặn', value: '0' },
          { label: 'Lỗi lock', value: '0' },
        ],
        stats: [
          { label: 'Song song', value: '3 worker sẵn sàng' },
          { label: 'Trùng lặp', value: '0 job' },
        ],
        logs: [],
        jobs: [
          { id: 101, payload: 'send_invoice', status: 'queued' },
          { id: 102, payload: 'sync_erp', status: 'queued' },
          { id: 103, payload: 'push_notif', status: 'queued' },
          { id: 104, payload: 'gen_pdf', status: 'queued' },
        ],
        workers: [
          { id: 'w1', name: 'Worker A', badge: 'SẴN SÀNG', detail: 'Chuẩn bị quét từ id 101' },
          { id: 'w2', name: 'Worker B', badge: 'SẴN SÀNG', detail: 'Chuẩn bị quét từ id 101' },
          { id: 'w3', name: 'Worker C', badge: 'SẴN SÀNG', detail: 'Chuẩn bị quét từ id 101' },
        ],
      },
      {
        phase: 'Worker A khóa #101',
        action: 'Worker A lấy row lock độc quyền trên job #101',
        note: 'Row #101 giờ đang giữ row-level exclusive lock trong transaction của Worker A.',
        query: "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;",
        gate: { text: 'Worker A giữ lock #101', tone: 'ok' },
        metrics: [
          { label: 'Đã claim', value: '1 job' },
          { label: 'Worker bị chặn', value: '0' },
          { label: 'Lỗi lock', value: '0' },
        ],
        stats: [
          { label: 'Worker A', value: 'Claim #101' },
          { label: 'Đang chờ', value: 'Worker B, C' },
        ],
        logs: [{ id: 'sl1', text: 'Worker A lock và claim thành công job #101.' }],
        newLogId: 'sl1',
        jobs: [
          { id: 101, payload: 'send_invoice', status: 'LOCKED (A)', state: 'matched' },
          { id: 102, payload: 'sync_erp', status: 'queued' },
          { id: 103, payload: 'push_notif', status: 'queued' },
          { id: 104, payload: 'gen_pdf', status: 'queued' },
        ],
        workers: [
          { id: 'w1', name: 'Worker A', badge: 'CLAIM #101', badgeTone: 'solid', detail: 'Đang giữ row lock #101', state: 'active' },
          { id: 'w2', name: 'Worker B', badge: 'ĐANG QUÉT', detail: 'Đụng #101 đã bị lock…' },
          { id: 'w3', name: 'Worker C', badge: 'ĐANG QUÉT', detail: 'Đụng #101 đã bị lock…' },
        ],
      },
      {
        phase: 'Worker B bỏ qua #101',
        action: 'Worker B thấy #101 đang lock → SKIP ngay sang #102 và khóa #102',
        note: 'Không dừng lại chờ Worker A commit. SKIP LOCKED nhảy qua mọi dòng đã khóa để lấy ngay job kế tiếp.',
        query: "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;",
        gate: { text: 'SKIP #101 → Worker B claim #102 tức thì', tone: 'ok' },
        metrics: [
          { label: 'Đã claim', value: '2 job' },
          { label: 'Worker bị chặn', value: '0' },
          { label: 'Lỗi lock', value: '0' },
        ],
        stats: [
          { label: 'Worker A', value: 'Claim #101' },
          { label: 'Worker B', value: 'Claim #102' },
        ],
        logs: [
          { id: 'sl1', text: 'Worker A lock và claim thành công job #101.' },
          { id: 'sl2', text: 'Worker B gặp #101 đang khóa → SKIP sang #102 và lock ngay #102.' },
        ],
        newLogId: 'sl2',
        jobs: [
          { id: 101, payload: 'send_invoice', status: 'LOCKED (A)', state: 'active' },
          { id: 102, payload: 'sync_erp', status: 'LOCKED (B)', state: 'matched' },
          { id: 103, payload: 'push_notif', status: 'queued' },
          { id: 104, payload: 'gen_pdf', status: 'queued' },
        ],
        workers: [
          { id: 'w1', name: 'Worker A', badge: 'CLAIM #101', badgeTone: 'ok', detail: 'UPDATE status=running → COMMIT', state: 'active' },
          { id: 'w2', name: 'Worker B', badge: 'CLAIM #102', badgeTone: 'solid', detail: 'Bỏ qua #101 → giữ lock #102', state: 'active' },
          { id: 'w3', name: 'Worker C', badge: 'ĐANG QUÉT', detail: 'Sắp bỏ qua #101, #102…' },
        ],
      },
      {
        phase: 'Song song tối đa',
        action: 'Worker C bỏ qua #101, #102 → claim #103: cả 3 worker cùng chạy không đụng hàng',
        note: 'Không worker nào phải chờ nhau, không job nào bị claim trùng. Sau khi UPDATE status=running và COMMIT, worker mới chạy tác vụ nặng bên ngoài DB.',
        query: "UPDATE jobs SET status = 'running' WHERE id = ...; COMMIT;",
        gate: { text: '3/3 Worker claim song song • 0 Wait • 0 Duplicate', tone: 'ok' },
        metrics: [
          { label: 'Đã claim', value: '3 job' },
          { label: 'Worker bị chặn', value: '0' },
          { label: 'Lỗi lock', value: '0' },
        ],
        stats: [
          { label: 'Throughput', value: '3× song song' },
          { label: 'Trùng lặp / Wait', value: '0 / 0' },
        ],
        logs: [
          { id: 'sl1', text: 'Worker A lock và claim thành công job #101.' },
          { id: 'sl2', text: 'Worker B gặp #101 đang khóa → SKIP sang #102 và lock ngay #102.' },
          { id: 'sl3', text: 'Worker C bỏ qua #101, #102 → claim #103. Cả 3 chạy song song trơn tru.' },
        ],
        newLogId: 'sl3',
        jobs: [
          { id: 101, payload: 'send_invoice', status: 'running (A)', state: 'active' },
          { id: 102, payload: 'sync_erp', status: 'running (B)', state: 'active' },
          { id: 103, payload: 'push_notif', status: 'running (C)', state: 'matched' },
          { id: 104, payload: 'gen_pdf', status: 'queued' },
        ],
        workers: [
          { id: 'w1', name: 'Worker A', badge: 'CHẠY #101', badgeTone: 'ok', detail: 'Đã commit claim, xử lý job', state: 'active' },
          { id: 'w2', name: 'Worker B', badge: 'CHẠY #102', badgeTone: 'ok', detail: 'Đã commit claim, xử lý job', state: 'active' },
          { id: 'w3', name: 'Worker C', badge: 'CHẠY #103', badgeTone: 'solid', detail: 'Bỏ qua #101, #102 → claim #103', state: 'active' },
        ],
      },
    ],
  },
  {
    id: 'for-update',
    label: 'FOR UPDATE (Chờ dây chuyền)',
    frames: [
      {
        phase: 'Worker A khóa #101',
        action: 'Worker A giữ row lock #101; Worker B và C cùng chọn #101 theo ORDER BY id',
        note: 'Không có SKIP LOCKED: mọi worker đều nhắm đúng dòng đầu tiên (#101).',
        query: "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE;",
        metrics: [
          { label: 'Đã claim', value: '1 job' },
          { label: 'Worker bị chặn', value: '0' },
        ],
        stats: [
          { label: 'Row đích chung', value: 'Job #101' },
          { label: 'Song song', value: 'Chưa biết' },
        ],
        logs: [{ id: 'fu1', text: 'Worker A khóa #101. Worker B và C đều tiến tới #101.' }],
        newLogId: 'fu1',
        jobs: [
          { id: 101, payload: 'send_invoice', status: 'LOCKED (A)', state: 'active' },
          { id: 102, payload: 'sync_erp', status: 'queued (rảnh)' },
          { id: 103, payload: 'push_notif', status: 'queued (rảnh)' },
        ],
        workers: [
          { id: 'w1', name: 'Worker A', badge: 'GIỮ #101', badgeTone: 'solid', detail: 'Đang chạy trong transaction', state: 'active' },
          { id: 'w2', name: 'Worker B', badge: 'ĐỤNG #101', badgeTone: 'warn', detail: 'Xin lock trên #101…', state: 'warn' },
          { id: 'w3', name: 'Worker C', badge: 'ĐỤNG #101', badgeTone: 'warn', detail: 'Xin lock trên #101…', state: 'warn' },
        ],
      },
      {
        phase: 'Tắc nghẽn (Lock Contention)',
        action: 'Worker B & C bị BLOCK cứng tại #101 dù #102 và #103 đang nằm rảnh!',
        note: 'Toàn bộ cụm worker xếp hàng nối đuôi sau 1 dòng đầu tiên → biến hệ thống đa worker thành chạy tuần tự, tăng nguy cơ cạn connection pool.',
        query: "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE;  -- BLOCKED",
        gate: { text: '2 Worker bị BLOCK chờ Worker A commit!', tone: 'bad' },
        metrics: [
          { label: 'Đã claim', value: '1 job' },
          { label: 'Worker bị chặn', value: '2 / 3', warn: true },
        ],
        stats: [
          { label: 'Throughput', value: '1× (tuần tự hóa)', tone: 'warn' },
          { label: 'Job bị bỏ đói', value: '#102, #103 nằm chờ', tone: 'warn' },
        ],
        logs: [
          { id: 'fu1', text: 'Worker A khóa #101. Worker B và C đều tiến tới #101.' },
          { id: 'fu2', text: 'Worker B & C treo ở trạng thái Lock Wait cho tới khi Worker A commit/rollback.', tone: 'warn' },
        ],
        newLogId: 'fu2',
        jobs: [
          { id: 101, payload: 'send_invoice', status: 'LOCKED (A) ← B,C chờ', state: 'warn' },
          { id: 102, payload: 'sync_erp', status: 'queued (chưa ai lấy)', state: 'dim' },
          { id: 103, payload: 'push_notif', status: 'queued (chưa ai lấy)', state: 'dim' },
        ],
        workers: [
          { id: 'w1', name: 'Worker A', badge: 'GIỮ #101', badgeTone: 'ok', detail: 'Chưa commit…', state: 'active' },
          { id: 'w2', name: 'Worker B', badge: 'BLOCKED', badgeTone: 'bad', detail: 'Đang chờ lock #101', state: 'bad' },
          { id: 'w3', name: 'Worker C', badge: 'BLOCKED', badgeTone: 'bad', detail: 'Đang chờ lock #101', state: 'bad' },
        ],
      },
    ],
  },
  {
    id: 'nowait',
    label: 'FOR UPDATE NOWAIT (Fail-fast)',
    frames: [
      {
        phase: 'Fail-fast ngay khi đụng lock',
        action: 'Worker B và C đụng #101 đang khóa → văng lỗi 55P03 (lock_not_available) lập tức',
        note: 'NOWAIT không chờ và cũng không nhảy sang #102. Nó phù hợp cho API sửa 1 bản ghi cụ thể muốn báo ngay "đang có người xử lý", KHÔNG hợp cho job queue.',
        query: "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE NOWAIT;",
        gate: { text: 'ERROR: could not obtain lock on row #101', tone: 'bad' },
        metrics: [
          { label: 'Đã claim', value: '1 job' },
          { label: 'Worker lỗi', value: '2 / 3', warn: true },
        ],
        stats: [
          { label: 'Mã lỗi PG', value: '55P03 lock_not_available', tone: 'warn' },
          { label: 'Use case đúng', value: 'Edit 1 order cụ thể' },
        ],
        logs: [{ id: 'nw1', text: 'Worker A giữ #101. Worker B & C fail ngay lập tức, phải retry từ ứng dụng.', tone: 'warn' }],
        newLogId: 'nw1',
        jobs: [
          { id: 101, payload: 'send_invoice', status: 'LOCKED (A)', state: 'active' },
          { id: 102, payload: 'sync_erp', status: 'queued (chưa quét tới)', state: 'dim' },
          { id: 103, payload: 'push_notif', status: 'queued (chưa quét tới)', state: 'dim' },
        ],
        workers: [
          { id: 'w1', name: 'Worker A', badge: 'CLAIM #101', badgeTone: 'ok', detail: 'Khóa thành công #101', state: 'active' },
          { id: 'w2', name: 'Worker B', badge: 'ERROR 55P03', badgeTone: 'bad', detail: 'Fail-fast: #101 đã bị khóa', state: 'bad' },
          { id: 'w3', name: 'Worker C', badge: 'ERROR 55P03', badgeTone: 'bad', detail: 'Fail-fast: #101 đã bị khóa', state: 'bad' },
        ],
      },
    ],
  },
];

export function SkipLockedAnimation() {
  return (
    <WorkbenchShell
      id="skip-locked-animation"
      title="Mô phỏng ba hành vi FOR UPDATE, NOWAIT và SKIP LOCKED với nhiều worker"
      modeAriaLabel="Chọn chế độ khóa dòng"
      modes={skipLockedModes}
      renderStage={(frame) => (
        <div className={styles.grid2}>
          <div className={styles.panelCard}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>Bảng jobs (Queue)</span>
              <span className={styles.badge}>ORDER BY id</span>
            </div>
            <div className={styles.rowList}>
              {frame.jobs.map((job) => (
                <div key={job.id} className={styles.rowStrip} data-state={job.state}>
                  <span><strong>#{job.id}</strong> {job.payload}</span>
                  <span>{job.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.panelCard}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>3 Worker song song</span>
              <span className={styles.badge}>LIMIT 1</span>
            </div>
            <div className={styles.rowList}>
              {frame.workers.map((w) => (
                <div key={w.id} className={styles.panelCard} data-state={w.state}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardTitle}>{w.name}</span>
                    <span className={styles.badge} data-tone={w.badgeTone}>{w.badge}</span>
                  </div>
                  <span className={styles.subText}>{w.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    />
  );
}
