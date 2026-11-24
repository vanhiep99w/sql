'use client';

import { WorkbenchShell, type BaseFrame, type WorkbenchMode } from './workbench-shell';
import styles from './workbench.module.css';

type TxStep = {
  id: string;
  label: string;
  state?: 'active' | 'matched' | 'warn' | 'bad' | 'dim';
};

type IsoFrame = BaseFrame & {
  tx1Title: string;
  tx1Badge: string;
  tx1Tone?: 'ok' | 'warn' | 'bad' | 'solid';
  tx1Steps: TxStep[];
  tx2Title: string;
  tx2Badge: string;
  tx2Tone?: 'ok' | 'warn' | 'bad' | 'solid';
  tx2Steps: TxStep[];
  dbRows: { id: string; text: string; state?: 'active' | 'matched' | 'warn' | 'bad' }[];
};

const isolationModes: WorkbenchMode<IsoFrame>[] = [
  {
    id: 'write-skew-rr',
    label: 'Write Skew ở REPEATABLE READ (Lọt!)',
    frames: [
      {
        phase: 'Bước 1 — Cùng mở snapshot',
        action: 'T1 và T2 cùng đọc COUNT(*) WHERE on_call = true → cả hai đều thấy 2 bác sĩ trực',
        note: 'Quy tắc nghiệp vụ: luôn phải còn ít nhất 1 bác sĩ trực. Ở REPEATABLE READ, T1 và T2 đều giữ snapshot ban đầu có An = true, Bình = true.',
        query: '-- T1 & T2 (REPEATABLE READ): SELECT COUNT(*) FROM doctors WHERE on_call = true;  -- cùng ra 2',
        metrics: [
          { label: 'Bác sĩ đang trực', value: '2 (An, Bình)' },
          { label: 'Isolation', value: 'REPEATABLE READ' },
        ],
        stats: [
          { label: 'T1 thấy', value: '2 người trực' },
          { label: 'T2 thấy', value: '2 người trực' },
        ],
        logs: [{ id: 'w1', text: 'T1 và T2 cùng chụp snapshot trước khi ai ghi → cả hai đều thấy count = 2.' }],
        newLogId: 'w1',
        tx1Title: 'Session T1 (cho An nghỉ)',
        tx1Badge: 'COUNT = 2',
        tx1Tone: 'ok',
        tx1Steps: [{ id: 'a1', label: 'BEGIN REPEATABLE READ; SELECT count → 2', state: 'active' }],
        tx2Title: 'Session T2 (cho Bình nghỉ)',
        tx2Badge: 'COUNT = 2',
        tx2Tone: 'ok',
        tx2Steps: [{ id: 'b1', label: 'BEGIN REPEATABLE READ; SELECT count → 2', state: 'active' }],
        dbRows: [
          { id: 'an', text: 'An | on_call = true', state: 'matched' },
          { id: 'binh', text: 'Bình | on_call = true', state: 'matched' },
        ],
      },
      {
        phase: 'Bước 2 — Sửa 2 dòng khác nhau',
        action: 'T1 UPDATE An = false; T2 UPDATE Bình = false — không đụng chung dòng nên KHÔNG conflict!',
        note: 'PostgreSQL REPEATABLE READ chỉ chặn write-write conflict trên CÙNG MỘT ROW. Ở đây T1 sửa dòng An, T2 sửa dòng Bình nên cả hai đều ghi thành công.',
        query: "-- T1: UPDATE doctors SET on_call=false WHERE name='An';  |  T2: ... WHERE name='Binh';",
        gate: { text: 'Sửa 2 row khác nhau → REPEATABLE READ không chặn!', tone: 'warn' },
        metrics: [
          { label: 'Row conflict', value: '0 (2 row riêng)' },
          { label: 'Rủi ro', value: 'Write Skew!', warn: true },
        ],
        stats: [
          { label: 'T1 khóa row', value: 'An' },
          { label: 'T2 khóa row', value: 'Bình' },
        ],
        logs: [
          { id: 'w1', text: 'T1 và T2 cùng chụp snapshot trước khi ai ghi → cả hai đều thấy count = 2.' },
          { id: 'w2', text: 'T1 sửa An, T2 sửa Bình → không trùng row lock nên cả hai không hề chờ nhau.', tone: 'warn' },
        ],
        newLogId: 'w2',
        tx1Title: 'Session T1 (cho An nghỉ)',
        tx1Badge: 'UPDATE An',
        tx1Tone: 'warn',
        tx1Steps: [
          { id: 'a1', label: 'SELECT count → 2 (đủ điều kiện)' },
          { id: 'a2', label: "UPDATE doctors SET on_call=false WHERE name='An'", state: 'warn' },
        ],
        tx2Title: 'Session T2 (cho Bình nghỉ)',
        tx2Badge: 'UPDATE Bình',
        tx2Tone: 'warn',
        tx2Steps: [
          { id: 'b1', label: 'SELECT count → 2 (đủ điều kiện)' },
          { id: 'b2', label: "UPDATE doctors SET on_call=false WHERE name='Binh'", state: 'warn' },
        ],
        dbRows: [
          { id: 'an', text: 'An | on_call = false (T1)', state: 'warn' },
          { id: 'binh', text: 'Bình | on_call = false (T2)', state: 'warn' },
        ],
      },
      {
        phase: 'Bước 3 — Cả 2 COMMIT',
        action: 'Cả hai COMMIT thành công → 0 bác sĩ trực! Vi phạm invariant (Write Skew)',
        note: 'Không có bất kỳ thứ tự tuần tự nào (T1→T2 hay T2→T1) cho ra kết quả 0 người trực. Đây chính là giới hạn lớn nhất của Snapshot Isolation / REPEATABLE READ.',
        query: '-- T1: COMMIT (OK)  |  T2: COMMIT (OK)  → 0 bác sĩ trực!',
        gate: { text: 'WRITE SKEW: 0 bác sĩ trực — vi phạm nghiệp vụ!', tone: 'bad' },
        metrics: [
          { label: 'Bác sĩ đang trực', value: '0 (SAI!)', warn: true },
          { label: 'Kết quả', value: 'Write Skew', warn: true },
        ],
        stats: [
          { label: 'Trạng thái DB', value: 'An=false, Bình=false', tone: 'warn' },
          { label: 'Cách chặn', value: 'SERIALIZABLE / SELECT FOR UPDATE' },
        ],
        logs: [
          { id: 'w1', text: 'T1 và T2 cùng chụp snapshot trước khi ai ghi → cả hai đều thấy count = 2.' },
          { id: 'w2', text: 'T1 sửa An, T2 sửa Bình → không trùng row lock nên cả hai không hề chờ nhau.', tone: 'warn' },
          { id: 'w3', text: 'Cả T1 & T2 đều COMMIT → 0 bác sĩ trực! Phải nâng lên SERIALIZABLE hoặc lock tường minh.', tone: 'warn' },
        ],
        newLogId: 'w3',
        tx1Title: 'Session T1',
        tx1Badge: 'COMMITTED',
        tx1Tone: 'warn',
        tx1Steps: [
          { id: 'a1', label: 'SELECT count → 2' },
          { id: 'a2', label: 'UPDATE An = false → COMMIT ✅' },
        ],
        tx2Title: 'Session T2',
        tx2Badge: 'COMMITTED',
        tx2Tone: 'bad',
        tx2Steps: [
          { id: 'b1', label: 'SELECT count → 2' },
          { id: 'b2', label: 'UPDATE Bình = false → COMMIT ✅ (LỌT!)', state: 'bad' },
        ],
        dbRows: [
          { id: 'an', text: 'An | on_call = false', state: 'bad' },
          { id: 'binh', text: 'Bình | on_call = false', state: 'bad' },
        ],
      },
    ],
  },
  {
    id: 'write-skew-ser',
    label: 'SERIALIZABLE (SSI chặn Write Skew)',
    frames: [
      {
        phase: 'Theo dõi Predicate Dependency',
        action: 'T1 & T2 cùng đọc predicate on_call = true → Postgres gắn SIREAD lock lên tập điều kiện',
        note: 'Serializable Snapshot Isolation (SSI) theo dõi rw-dependency: T1 đọc thứ T2 sắp sửa, và T2 đọc thứ T1 sắp sửa.',
        query: 'BEGIN ISOLATION LEVEL SERIALIZABLE;  -- Postgres bật SSI predicate tracking',
        gate: { text: 'Phát hiện vòng phụ thuộc rw-antidependency giữa T1 ↔ T2', tone: 'warn' },
        metrics: [
          { label: 'Isolation', value: 'SERIALIZABLE' },
          { label: 'SSI Cycle', value: 'T1 ↔ T2', warn: true },
        ],
        stats: [
          { label: 'T1 ghi', value: 'An (nằm trong tập T2 đọc)' },
          { label: 'T2 ghi', value: 'Bình (nằm trong tập T1 đọc)' },
        ],
        logs: [{ id: 'sr1', text: 'SSI ghi nhận T1 và T2 cùng phụ thuộc chéo vào tập predicate on_call = true.' }],
        newLogId: 'sr1',
        tx1Title: 'Session T1 (SERIALIZABLE)',
        tx1Badge: 'SIREAD TRACKED',
        tx1Tone: 'ok',
        tx1Steps: [{ id: 's1', label: 'SELECT count → 2; UPDATE An = false', state: 'active' }],
        tx2Title: 'Session T2 (SERIALIZABLE)',
        tx2Badge: 'SIREAD TRACKED',
        tx2Tone: 'warn',
        tx2Steps: [{ id: 's2', label: 'SELECT count → 2; UPDATE Bình = false', state: 'warn' }],
        dbRows: [
          { id: 'an', text: 'An | on_call = false (chờ commit)', state: 'active' },
          { id: 'binh', text: 'Bình | on_call = false (chờ commit)', state: 'warn' },
        ],
      },
      {
        phase: 'T2 bị ABORT với lỗi 40001',
        action: 'T1 COMMIT thành công → T2 bấm COMMIT bị Postgres hủy ngay (serialization_failure)!',
        note: 'Ứng dụng bắt mã lỗi SQLSTATE 40001 và retry T2: lần chạy lại T2 sẽ thấy chỉ còn 1 bác sĩ trực nên từ chối cho Bình nghỉ — invariant được bảo vệ tuyệt đối.',
        query: '-- T1: COMMIT (OK)  |  T2: COMMIT → ERROR 40001: could not serialize access',
        gate: { text: 'T2 ABORT (40001) • Còn lại Bình trực (Invariant an toàn!)', tone: 'ok' },
        metrics: [
          { label: 'Bác sĩ đang trực', value: '1 (Bình — ĐÚNG)' },
          { label: 'T2 trạng thái', value: 'ABORT 40001', warn: true },
        ],
        stats: [
          { label: 'T1 kết quả', value: 'COMMIT (An nghỉ)' },
          { label: 'T2 kết quả', value: 'ABORT → App retry' },
        ],
        logs: [
          { id: 'sr1', text: 'SSI ghi nhận T1 và T2 cùng phụ thuộc chéo vào tập predicate on_call = true.' },
          { id: 'sr2', text: 'T1 COMMIT trước → T2 bị hủy với lỗi 40001. Invariant còn ≥ 1 bác sĩ trực được giữ vững!' },
        ],
        newLogId: 'sr2',
        tx1Title: 'Session T1',
        tx1Badge: 'COMMITTED',
        tx1Tone: 'solid',
        tx1Steps: [{ id: 's1', label: 'UPDATE An = false → COMMIT ✅', state: 'matched' }],
        tx2Title: 'Session T2',
        tx2Badge: 'ABORT 40001',
        tx2Tone: 'bad',
        tx2Steps: [{ id: 's2', label: 'ROLLBACK: could not serialize access (retry!)', state: 'bad' }],
        dbRows: [
          { id: 'an', text: 'An | on_call = false', state: 'active' },
          { id: 'binh', text: 'Bình | on_call = true (GIỮ NGUYÊN)', state: 'matched' },
        ],
      },
    ],
  },
  {
    id: 'non-repeatable',
    label: 'Non-Repeatable Read (RC vs RR)',
    frames: [
      {
        phase: 'Read Committed — 2 lần đọc ra 2 số',
        action: 'T1 đọc balance = 100 → T2 cập nhật thành 200 và COMMIT → T1 đọc lại trong CÙNG transaction ra 200',
        note: 'Ở Read Committed, mỗi câu SELECT lấy một snapshot mới nhất tại thời điểm câu lệnh chạy. Ở Repeatable Read, T1 giữ nguyên snapshot đầu tiên nên cả 2 lần đều ra 100.',
        query: '-- READ COMMITTED: T1 đọc lần 1 → 100 | T2 COMMIT 200 | T1 đọc lần 2 → 200',
        gate: { text: 'Read Committed: 100 → 200 (khác nhau) | Repeatable Read: 100 → 100', tone: 'warn' },
        metrics: [
          { label: 'Lần đọc 1', value: '100' },
          { label: 'Lần đọc 2 (RC)', value: '200', warn: true },
          { label: 'Lần đọc 2 (RR)', value: '100' },
        ],
        stats: [
          { label: 'Read Committed', value: 'Snapshot theo từng câu lệnh' },
          { label: 'Repeatable Read', value: 'Snapshot theo cả transaction' },
        ],
        logs: [{ id: 'nr1', text: 'Read Committed tạo snapshot mới mỗi SELECT nên thấy 200 sau khi T2 commit.' }],
        newLogId: 'nr1',
        tx1Title: 'Session T1 (READ COMMITTED)',
        tx1Badge: '100 ≠ 200',
        tx1Tone: 'warn',
        tx1Steps: [
          { id: 'r1', label: 'SELECT balance → 100 (snap #1)' },
          { id: 'r2', label: 'SELECT balance → 200 (snap #2 sau T2 commit!)', state: 'warn' },
        ],
        tx2Title: 'Session T2 (Writer)',
        tx2Badge: 'COMMITTED',
        tx2Tone: 'ok',
        tx2Steps: [{ id: 'r3', label: 'UPDATE balance = 200; COMMIT;', state: 'active' }],
        dbRows: [{ id: 'bal', text: 'account #1 | balance = 200 (committed)', state: 'active' }],
      },
    ],
  },
];

export function IsolationAnomalyAnimation() {
  return (
    <WorkbenchShell
      id="isolation-anomaly-animation"
      title="Mô phỏng Isolation Levels: Write Skew (Repeatable Read vs Serializable) và Non-Repeatable Read"
      modeAriaLabel="Chọn kịch bản Isolation Level"
      modes={isolationModes}
      renderStage={(frame) => (
        <div className={styles.tierStack}>
          <div className={styles.grid2}>
            <div className={styles.panelCard}>
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>{frame.tx1Title}</span>
                <span className={styles.badge} data-tone={frame.tx1Tone}>{frame.tx1Badge}</span>
              </div>
              <div className={styles.rowList}>
                {frame.tx1Steps.map((s) => (
                  <div key={s.id} className={styles.rowStrip} data-state={s.state}>
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.panelCard}>
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>{frame.tx2Title}</span>
                <span className={styles.badge} data-tone={frame.tx2Tone}>{frame.tx2Badge}</span>
              </div>
              <div className={styles.rowList}>
                {frame.tx2Steps.map((s) => (
                  <div key={s.id} className={styles.rowStrip} data-state={s.state}>
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.panelCard}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>Trạng thái dữ liệu trong Database</span>
              <span className={styles.badge}>TABLE STATE</span>
            </div>
            <div className={styles.grid2}>
              {frame.dbRows.map((row) => (
                <div key={row.id} className={styles.rowStrip} data-state={row.state}>
                  <span>{row.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Lock Mechanics: Deadlock & Gap / Next-Key Lock (fundamentals/lock.md)
// ---------------------------------------------------------------------------
type LockFrame = BaseFrame & {
  kind: 'deadlock' | 'gap';
  deadlock?: {
    tx1: { badge: string; tone?: 'ok' | 'warn' | 'bad'; detail: string; state?: 'active' | 'warn' | 'bad' };
    tx2: { badge: string; tone?: 'ok' | 'warn' | 'bad'; detail: string; state?: 'active' | 'warn' | 'bad' };
    rows: { id: string; text: string; owner: string; state?: 'active' | 'warn' | 'bad' }[];
    waitGraph: string;
    cycle?: boolean;
  };
  gap?: {
    segments: { id: string; kind: 'gap' | 'key'; text: string; locked?: boolean; blocked?: boolean }[];
    tx1Text: string;
    tx2Text: string;
    tx2Tone: 'ok' | 'warn' | 'bad';
  };
};

const lockModes: WorkbenchMode<LockFrame>[] = [
  {
    id: 'deadlock',
    label: 'Deadlock & Wait-For Graph',
    frames: [
      {
        kind: 'deadlock',
        phase: 'Bước 1 — Giữ khóa chéo',
        action: 'TX1 khóa độc quyền Row A (id=1); TX2 khóa độc quyền Row B (id=2)',
        note: 'Mỗi transaction đang giữ 1 tài nguyên riêng nên chưa có xung đột.',
        query: '-- TX1: UPDATE accounts SET bal-=10 WHERE id=1  |  TX2: ... WHERE id=2',
        metrics: [
          { label: 'Wait-For Edge', value: '0' },
          { label: 'Chu trình', value: 'Chưa' },
        ],
        stats: [
          { label: 'TX1 đang giữ', value: 'X-Lock Row A' },
          { label: 'TX2 đang giữ', value: 'X-Lock Row B' },
        ],
        logs: [{ id: 'd1', text: 'TX1 lấy X-Lock trên Row A; TX2 lấy X-Lock trên Row B.' }],
        newLogId: 'd1',
        deadlock: {
          tx1: { badge: 'GIỮ A', tone: 'ok', detail: 'Đang giữ X-Lock Row A', state: 'active' },
          tx2: { badge: 'GIỮ B', tone: 'ok', detail: 'Đang giữ X-Lock Row B', state: 'active' },
          rows: [
            { id: 'ra', text: 'Row A (id=1)', owner: 'X-Lock: TX1', state: 'active' },
            { id: 'rb', text: 'Row B (id=2)', owner: 'X-Lock: TX2', state: 'active' },
          ],
          waitGraph: 'Wait-For Graph: chưa có cạnh chờ nào',
        },
      },
      {
        kind: 'deadlock',
        phase: 'Bước 2 — Hình thành chu trình chờ',
        action: 'TX1 xin Row B (chờ TX2) và TX2 xin Row A (chờ TX1) → DEADLOCK!',
        note: 'Wait-For Graph xuất hiện vòng kín TX1 → TX2 → TX1. Cả hai không bao giờ tự thoát được nếu database không can thiệp.',
        query: '-- TX1 xin Row B (chờ TX2)  +  TX2 xin Row A (chờ TX1)  ⇒ DEADLOCK!',
        gate: { text: 'CYCLE DETECTED: TX1 → TX2 → TX1', tone: 'bad' },
        metrics: [
          { label: 'Wait-For Edge', value: '2 (Chu trình!)', warn: true },
          { label: 'Trạng thái', value: 'DEADLOCK', warn: true },
        ],
        stats: [
          { label: 'Wait-For Graph', value: 'TX1 ↔ TX2', tone: 'warn' },
          { label: 'Cách tránh', value: 'Luôn lock theo thứ tự id tăng dần' },
        ],
        logs: [
          { id: 'd1', text: 'TX1 lấy X-Lock trên Row A; TX2 lấy X-Lock trên Row B.' },
          { id: 'd2', text: 'TX1 chờ B (của TX2) và TX2 chờ A (của TX1) → Deadlock Detector phát hiện vòng lặp!', tone: 'warn' },
        ],
        newLogId: 'd2',
        deadlock: {
          tx1: { badge: 'CHỜ B (TX2)', tone: 'bad', detail: 'Giữ A, bị block khi xin B', state: 'bad' },
          tx2: { badge: 'CHỜ A (TX1)', tone: 'bad', detail: 'Giữ B, bị block khi xin A', state: 'bad' },
          rows: [
            { id: 'ra', text: 'Row A (id=1)', owner: 'TX1 giữ ← TX2 chờ', state: 'bad' },
            { id: 'rb', text: 'Row B (id=2)', owner: 'TX2 giữ ← TX1 chờ', state: 'bad' },
          ],
          waitGraph: 'Wait-For Graph: TX1 ──chờ B──▶ TX2 ──chờ A──▶ TX1 (CHU TRÌNH ĐỎ!)',
          cycle: true,
        },
      },
      {
        kind: 'deadlock',
        phase: 'Bước 3 — Deadlock Detector hủy nạn nhân',
        action: 'Database ROLLBACK TX2 (nạn nhân), nhả Row B → TX1 lấy được Row B và hoàn tất!',
        note: 'Database tự chọn 1 victim (thường là transaction tốn ít chi phí rollback hơn) để hủy với lỗi deadlock_detected (40P01 / 1213), giải phóng khóa cho TX1 chạy tiếp.',
        query: '-- ERROR 40P01: deadlock detected (TX2 rolled back) → TX1 lấy B & COMMIT',
        gate: { text: 'TX2 ROLLBACK • TX1 tiếp tục lấy B và COMMIT', tone: 'ok' },
        metrics: [
          { label: 'TX1', value: 'COMMIT ✅' },
          { label: 'TX2', value: 'ROLLBACK (Victim)', warn: true },
        ],
        stats: [
          { label: 'Giải phóng khóa', value: 'Row B mở cho TX1' },
          { label: 'Phòng ngừa', value: 'Lock A trước B ở mọi service' },
        ],
        logs: [
          { id: 'd1', text: 'TX1 lấy X-Lock trên Row A; TX2 lấy X-Lock trên Row B.' },
          { id: 'd2', text: 'TX1 chờ B (của TX2) và TX2 chờ A (của TX1) → Deadlock Detector phát hiện vòng lặp!', tone: 'warn' },
          { id: 'd3', text: 'Deadlock Detector hủy TX2 → Row B được nhả → TX1 lấy B và COMMIT thành công.' },
        ],
        newLogId: 'd3',
        deadlock: {
          tx1: { badge: 'COMMITTED', tone: 'ok', detail: 'Lấy được cả A & B → xong!', state: 'active' },
          tx2: { badge: 'ABORTED', tone: 'bad', detail: 'ERROR 40P01: deadlock detected', state: 'bad' },
          rows: [
            { id: 'ra', text: 'Row A (id=1)', owner: 'X-Lock: TX1', state: 'active' },
            { id: 'rb', text: 'Row B (id=2)', owner: 'X-Lock: TX1', state: 'active' },
          ],
          waitGraph: 'Wait-For Graph đã được phá vỡ — hết chu trình',
        },
      },
    ],
  },
  {
    id: 'gap-lock',
    label: 'Gap Lock & Next-Key Lock (InnoDB)',
    frames: [
      {
        kind: 'gap',
        phase: 'TX1 khóa khoảng trên Index salary',
        action: 'TX1 chạy SELECT ... WHERE salary BETWEEN 10M AND 20M FOR UPDATE',
        note: 'InnoDB không chỉ khóa 2 bản ghi 10M và 20M mà đặt Next-Key / Gap Lock lên khoảng trống (10M, 20M) và (20M, 30M) để ngăn dòng mới chen vào giữa.',
        query: 'SELECT * FROM employees WHERE salary BETWEEN 10 AND 20 FOR UPDATE;  -- InnoDB',
        gate: { text: 'Khóa cả Record (10M, 20M) lẫn khoảng trống (10M..20M)', tone: 'warn' },
        metrics: [
          { label: 'Record Lock', value: '10M, 20M' },
          { label: 'Gap Lock', value: '(10M, 20M), (20M, 30M)', warn: true },
        ],
        stats: [
          { label: 'Mục đích', value: 'Chặn Phantom Read' },
          { label: 'Áp dụng trên', value: 'Index leaf entries + khoảng hở' },
        ],
        logs: [{ id: 'gl1', text: 'TX1 khóa record 10M, 20M cùng các gap xung quanh trên B+Tree index salary.' }],
        newLogId: 'gl1',
        gap: {
          segments: [
            { id: 'g0', kind: 'gap', text: '(-∞, 10M)' },
            { id: 'k1', kind: 'key', text: '10M', locked: true },
            { id: 'g1', kind: 'gap', text: 'GAP (10M, 20M)', locked: true },
            { id: 'k2', kind: 'key', text: '20M', locked: true },
            { id: 'g2', kind: 'gap', text: 'GAP (20M, 30M)', locked: true },
            { id: 'k3', kind: 'key', text: '30M' },
          ],
          tx1Text: 'TX1 giữ Next-Key Lock bảo vệ trọn vùng 10M..20M',
          tx2Text: 'TX2 chuẩn bị INSERT salary = 15M (chưa tồn tại!)',
          tx2Tone: 'warn',
        },
      },
      {
        kind: 'gap',
        phase: 'TX2 chèn 15M bị Gap Lock chặn đứng',
        action: 'TX2 chạy INSERT salary = 15M → rơi đúng khoảng GAP (10M, 20M) đang bị khóa → BLOCKED!',
        note: 'Dù dòng 15M hoàn toàn chưa tồn tại trong bảng, Gap Lock vẫn chặn TX2 chèn vào để TX1 đọc lại không bao giờ bị Phantom Read.',
        query: "INSERT INTO employees (name, salary) VALUES ('Bình', 15);  -- BLOCKED bởi Gap Lock!",
        gate: { text: 'INSERT 15M bị BLOCK tại GAP (10M, 20M) → Chặn Phantom Read!', tone: 'bad' },
        metrics: [
          { label: 'INSERT 15M', value: 'BLOCKED', warn: true },
          { label: 'Phantom Read', value: 'Đã bị chặn' },
        ],
        stats: [
          { label: 'Lý do block', value: 'Insert Intention đụng Gap Lock', tone: 'warn' },
          { label: 'Lưu ý', value: 'PostgreSQL không dùng Gap Lock (dùng SSI)' },
        ],
        logs: [
          { id: 'gl1', text: 'TX1 khóa record 10M, 20M cùng các gap xung quanh trên B+Tree index salary.' },
          { id: 'gl2', text: 'TX2 chèn 15M rơi vào GAP (10M, 20M) đang khóa → buộc chờ TX1 commit.', tone: 'warn' },
        ],
        newLogId: 'gl2',
        gap: {
          segments: [
            { id: 'g0', kind: 'gap', text: '(-∞, 10M)' },
            { id: 'k1', kind: 'key', text: '10M', locked: true },
            { id: 'g1', kind: 'gap', text: '15M ✕ BLOCKED', locked: true, blocked: true },
            { id: 'k2', kind: 'key', text: '20M', locked: true },
            { id: 'g2', kind: 'gap', text: 'GAP (20M, 30M)', locked: true },
            { id: 'k3', kind: 'key', text: '30M' },
          ],
          tx1Text: 'TX1 an toàn đọc lại khoảng 10M..20M → vẫn chỉ {10M, 20M}',
          tx2Text: 'TX2 (INSERT 15M): BLOCKED chờ Gap Lock (10M, 20M) mở!',
          tx2Tone: 'bad',
        },
      },
    ],
  },
];

export function LockMechanicsAnimation() {
  return (
    <WorkbenchShell
      id="lock-mechanics-animation"
      title="Mô phỏng Deadlock (Wait-For Graph) và Gap / Next-Key Lock trong InnoDB"
      modeAriaLabel="Chọn cơ chế khóa"
      modes={lockModes}
      renderStage={(frame) => {
        if (frame.kind === 'deadlock' && frame.deadlock) {
          const d = frame.deadlock;
          return (
            <div className={styles.tierStack}>
              <div className={styles.grid2}>
                <div className={styles.panelCard} data-state={d.tx1.state}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardTitle}>Transaction 1 (TX1)</span>
                    <span className={styles.badge} data-tone={d.tx1.tone}>{d.tx1.badge}</span>
                  </div>
                  <span className={styles.subText}>{d.tx1.detail}</span>
                </div>
                <div className={styles.panelCard} data-state={d.tx2.state}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardTitle}>Transaction 2 (TX2)</span>
                    <span className={styles.badge} data-tone={d.tx2.tone}>{d.tx2.badge}</span>
                  </div>
                  <span className={styles.subText}>{d.tx2.detail}</span>
                </div>
              </div>

              <div className={styles.grid2}>
                {d.rows.map((r) => (
                  <div key={r.id} className={styles.rowStrip} data-state={r.state}>
                    <strong>{r.text}</strong>
                    <span>{r.owner}</span>
                  </div>
                ))}
              </div>

              <div className={styles.rowStrip} data-state={d.cycle ? 'bad' : 'active'}>
                <span>{d.waitGraph}</span>
              </div>
            </div>
          );
        }

        const g = frame.gap!;
        return (
          <div className={styles.tierStack}>
            <div className={styles.gapStrip} aria-label="Dải index leaf và các khoảng gap">
              {g.segments.map((seg) =>
                seg.kind === 'key' ? (
                  <span key={seg.id} className={styles.gapKey} data-locked={seg.locked ? 'true' : undefined}>
                    {seg.text}
                  </span>
                ) : (
                  <span
                    key={seg.id}
                    className={styles.gapZone}
                    data-locked={seg.locked ? 'true' : undefined}
                    data-blocked={seg.blocked ? 'true' : undefined}
                  >
                    {seg.text}
                  </span>
                ),
              )}
            </div>
            <div className={styles.grid2}>
              <div className={styles.panelCard} data-state="active">
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle}>TX1 (Reader + FOR UPDATE)</span>
                  <span className={styles.badge} data-tone="ok">GIỮ GAP LOCK</span>
                </div>
                <span className={styles.subText}>{g.tx1Text}</span>
              </div>
              <div className={styles.panelCard} data-state={g.tx2Tone === 'bad' ? 'bad' : 'warn'}>
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle}>TX2 (Concurrent INSERT)</span>
                  <span className={styles.badge} data-tone={g.tx2Tone}>
                    {g.tx2Tone === 'bad' ? 'BLOCKED' : 'CHUẨN BỊ'}
                  </span>
                </div>
                <span className={styles.subText}>{g.tx2Text}</span>
              </div>
            </div>
          </div>
        );
      }}
    />
  );
}
