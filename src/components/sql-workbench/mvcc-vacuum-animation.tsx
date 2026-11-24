'use client';

import { WorkbenchShell, type BaseFrame, type WorkbenchMode } from './workbench-shell';
import styles from './workbench.module.css';

type TupleSlot = {
  id: string;
  ctid: string;
  meta: string;
  value: string;
  state?: 'active' | 'matched' | 'warn' | 'bad' | 'dead' | 'free' | 'dim';
};

type ReaderLane = {
  id: string;
  title: string;
  badge: string;
  badgeTone?: 'ok' | 'warn' | 'bad' | 'solid';
  sees: string;
  state?: 'active' | 'warn' | 'bad' | 'dim';
};

type MvccFrame = BaseFrame & {
  leftTitle: string;
  leftBadge: string;
  tuples: TupleSlot[];
  rightTitle: string;
  rightBadge: string;
  lanes: ReaderLane[];
};

const mvccModes: WorkbenchMode<MvccFrame>[] = [
  {
    id: 'pg-snapshot',
    label: 'PostgreSQL MVCC (xmin / xmax)',
    frames: [
      {
        phase: 'Trạng thái ban đầu',
        action: 'Tuple v1 (balance = 100) sống trong Heap Page 0 với xmin = 98, xmax = 0',
        note: 'Tx A mở snapshot (xid=100) và đọc balance = 100. Chưa có lock nào chặn người đọc.',
        query: '-- Tx A (snapshot=100): BEGIN; SELECT balance FROM accounts WHERE id = 1;',
        metrics: [
          { label: 'Live tuple', value: '1' },
          { label: 'Dead tuple', value: '0' },
          { label: 'Reader bị block', value: '0' },
        ],
        stats: [
          { label: 'Tx A thấy', value: 'balance = 100' },
          { label: 'Heap Page 0', value: '1 tuple sống' },
        ],
        logs: [{ id: 'm1', text: 'Tx A (snap=100) thấy v1 vì xmin=98 < 100 và xmax=0.' }],
        newLogId: 'm1',
        leftTitle: 'Heap Page 0 (PostgreSQL)',
        leftBadge: '1 TUPLE',
        tuples: [
          { id: 'v1', ctid: '(0,1)', meta: 'xmin=98, xmax=0', value: 'v1: balance=100', state: 'matched' },
          { id: 'e2', ctid: '(0,2)', meta: 'trống', value: '— slot trống —', state: 'free' },
        ],
        rightTitle: 'Các Transaction đồng thời',
        rightBadge: 'SNAPSHOT',
        lanes: [
          { id: 'txa', title: 'Tx A (Repeatable Read)', badge: 'snap = 100', badgeTone: 'solid', sees: 'Đọc v1 → balance = 100', state: 'active' },
          { id: 'txb', title: 'Tx B (Writer)', badge: 'chưa chạy', sees: 'Chuẩn bị UPDATE balance = 250' },
        ],
      },
      {
        phase: 'Tx B chạy UPDATE & COMMIT',
        action: 'UPDATE không ghi đè v1: đánh dấu v1.xmax = 101 và INSERT thêm v2 (xmin = 101)',
        note: 'Trong PostgreSQL, UPDATE = đánh dấu bản cũ + tạo bản mới ngay trong Heap. Cả hai bản cùng tồn tại song song.',
        query: '-- Tx B (xid=101): UPDATE accounts SET balance = 250 WHERE id = 1; COMMIT;',
        gate: { text: 'v1 vẫn giữ nguyên cho Tx A • v2 xuất hiện cho Tx mới', tone: 'ok' },
        metrics: [
          { label: 'Live tuple', value: '1 (v2)' },
          { label: 'Bản cũ giữ lại', value: '1 (v1)', warn: true },
          { label: 'Reader bị block', value: '0' },
        ],
        stats: [
          { label: 'v1 (0,1)', value: 'xmin=98, xmax=101' },
          { label: 'v2 (0,2)', value: 'xmin=101, xmax=0' },
        ],
        logs: [
          { id: 'm1', text: 'Tx A (snap=100) thấy v1 vì xmin=98 < 100 và xmax=0.' },
          { id: 'm2', text: 'Tx B (xid=101) set v1.xmax=101, chèn v2 (balance=250, xmin=101) và COMMIT.' },
        ],
        newLogId: 'm2',
        leftTitle: 'Heap Page 0 (PostgreSQL)',
        leftBadge: '2 VERSIONS',
        tuples: [
          { id: 'v1', ctid: '(0,1)', meta: 'xmin=98, xmax=101', value: 'v1: balance=100', state: 'warn' },
          { id: 'v2', ctid: '(0,2)', meta: 'xmin=101, xmax=0', value: 'v2: balance=250', state: 'active' },
        ],
        rightTitle: 'Các Transaction đồng thời',
        rightBadge: 'KHÔNG BLOCK',
        lanes: [
          { id: 'txa', title: 'Tx A (snap = 100)', badge: 'VẪN MỞ', badgeTone: 'warn', sees: 'Đang giữ snapshot 100…', state: 'warn' },
          { id: 'txb', title: 'Tx B (xid = 101)', badge: 'COMMITTED', badgeTone: 'ok', sees: 'Ghi xong v2 (250) không chờ Tx A', state: 'active' },
        ],
      },
      {
        phase: 'Hai góc nhìn song song',
        action: 'Tx A đọc lại vẫn thấy 100; Tx C mới mở (snap=102) thấy ngay 250',
        note: 'Tx A bỏ qua v2 (vì xmin 101 ≥ 100) và vẫn thấy v1 (vì xmax 101 xảy ra sau snapshot 100). Chỉ khi Tx A kết thúc, v1 mới trở thành dead tuple để VACUUM dọn.',
        query: '-- Tx A đọc lại → 100 | Tx C (snap=102) đọc → 250',
        gate: { text: 'Reader không chặn Writer • Writer không chặn Reader', tone: 'ok' },
        metrics: [
          { label: 'Tx A thấy', value: 'v1 (100)' },
          { label: 'Tx C thấy', value: 'v2 (250)' },
          { label: 'Lock wait', value: '0' },
        ],
        stats: [
          { label: 'Visibility Tx A', value: 'v1 visible, v2 ẩn' },
          { label: 'Visibility Tx C', value: 'v1 ẩn, v2 visible' },
        ],
        logs: [
          { id: 'm1', text: 'Tx A (snap=100) thấy v1 vì xmin=98 < 100 và xmax=0.' },
          { id: 'm2', text: 'Tx B (xid=101) set v1.xmax=101, chèn v2 (balance=250, xmin=101) và COMMIT.' },
          { id: 'm3', text: 'Tx A vẫn thấy 100 ổn định; Tx C (snap=102) thấy 250. v1 chỉ dọn được sau khi Tx A đóng.' },
        ],
        newLogId: 'm3',
        leftTitle: 'Heap Page 0 (PostgreSQL)',
        leftBadge: 'MULTI-VERSION',
        tuples: [
          { id: 'v1', ctid: '(0,1)', meta: 'visible với Tx A', value: 'v1: balance=100', state: 'warn' },
          { id: 'v2', ctid: '(0,2)', meta: 'visible với Tx C', value: 'v2: balance=250', state: 'matched' },
        ],
        rightTitle: 'Kết quả đọc đồng thời',
        rightBadge: 'MVCC',
        lanes: [
          { id: 'txa', title: 'Tx A (snap = 100)', badge: 'THẤY 100', badgeTone: 'warn', sees: 'xmin=98 < 100 < xmax=101 → v1', state: 'warn' },
          { id: 'txc', title: 'Tx C (snap = 102)', badge: 'THẤY 250', badgeTone: 'solid', sees: 'xmin=101 < 102, xmax=0 → v2', state: 'active' },
        ],
      },
    ],
  },
  {
    id: 'hot-vs-nonhot',
    label: 'HOT Update vs Non-HOT (Tác động Index)',
    frames: [
      {
        phase: 'Non-HOT Update (Đụng cột có Index)',
        action: 'UPDATE status = paid tạo ctid mới (0,5) → MỌI index trên bảng phải thêm entry mới!',
        note: 'Dù bạn chỉ sửa cột status, tuple mới có địa chỉ (0,5) khác (0,1). Mọi index (idx_pk, idx_email, idx_status…) đều phải ghi thêm con trỏ mới trỏ tới (0,5) và để lại entry cũ (0,1).',
        query: "UPDATE orders SET status = 'paid' WHERE id = 42;  -- status có index",
        gate: { text: 'Non-HOT: 12 index = 12 lần ghi index + bloat', tone: 'bad' },
        metrics: [
          { label: 'Index phải ghi', value: 'Tất cả (N/N)', warn: true },
          { label: 'Entry thừa', value: '+N stale', warn: true },
        ],
        stats: [
          { label: 'CTID đổi', value: '(0,1) → (0,5)', tone: 'warn' },
          { label: 'Write Amp', value: 'Rất cao khi nhiều index', tone: 'warn' },
        ],
        logs: [{ id: 'h1', text: 'Sửa cột có index → KHÔNG kích hoạt HOT → toàn bộ index phải chèn entry trỏ tới (0,5).', tone: 'warn' }],
        newLogId: 'h1',
        leftTitle: 'Heap Page 0',
        leftBadge: 'NON-HOT',
        tuples: [
          { id: 't1', ctid: '(0,1)', meta: 'dead (xmax=200)', value: 'status=new', state: 'dead' },
          { id: 't2', ctid: '(0,5)', meta: 'live (xmin=200)', value: 'status=paid', state: 'active' },
        ],
        rightTitle: 'Các Index trên bảng orders',
        rightBadge: 'PHẢI CẬP NHẬT HẾT',
        lanes: [
          { id: 'i1', title: 'idx_pk (id)', badge: 'GHI THÊM', badgeTone: 'bad', sees: '42 → (0,1) [cũ] + 42 → (0,5) [mới]', state: 'bad' },
          { id: 'i2', title: 'idx_status (status)', badge: 'GHI THÊM', badgeTone: 'bad', sees: 'new → (0,1) + paid → (0,5)', state: 'bad' },
          { id: 'i3', title: 'idx_email (email)', badge: 'GHI THÊM', badgeTone: 'bad', sees: 'Dù email KHÔNG đổi vẫn phải thêm → (0,5)!', state: 'bad' },
        ],
      },
      {
        phase: 'HOT Update (Heap-Only Tuple)',
        action: 'Sửa cột KHÔNG có index + còn chỗ cùng Page 0 → 0 lần ghi vào bất kỳ index nào!',
        note: 'PostgreSQL nối chuỗi HOT trực tiếp trong Page 0: (0,1) → (0,2). Mọi index vẫn trỏ về (0,1) rồi tự trượt theo HOT chain sang (0,2). Đây là lý do FILLFACTOR < 100 giúp bảng update nhiều chạy cực nhanh.',
        query: "UPDATE orders SET note = 'vip' WHERE id = 42;  -- note không có index, cùng page",
        gate: { text: 'HOT Update: 0 Index Write • Không sinh Index Bloat!', tone: 'ok' },
        metrics: [
          { label: 'Index phải ghi', value: '0 / N' },
          { label: 'Điều kiện', value: 'Cùng page + không đụng cột index' },
        ],
        stats: [
          { label: 'HOT Chain', value: '(0,1) ⟶ (0,2) trong Page 0' },
          { label: 'Index Write', value: '0 entry mới' },
        ],
        logs: [
          { id: 'h1', text: 'Sửa cột có index → KHÔNG kích hoạt HOT → toàn bộ index phải chèn entry trỏ tới (0,5).', tone: 'warn' },
          { id: 'h2', text: 'HOT Update: (0,1) chuyển tiếp nội bộ tới (0,2) ngay trong Page 0 → mọi index giữ nguyên!' },
        ],
        newLogId: 'h2',
        leftTitle: 'Heap Page 0 (Còn free space)',
        leftBadge: 'HOT CHAIN',
        tuples: [
          { id: 't1', ctid: '(0,1)', meta: 'HOT redirect → (0,2)', value: 'note=null', state: 'warn' },
          { id: 't2', ctid: '(0,2)', meta: 'live (HOT tuple)', value: 'note=vip', state: 'matched' },
        ],
        rightTitle: 'Các Index trên bảng orders',
        rightBadge: '0 INDEX WRITE',
        lanes: [
          { id: 'i1', title: 'idx_pk (id)', badge: 'GIỮ NGUYÊN', badgeTone: 'ok', sees: '42 → (0,1) ⟶ tự nhảy tới (0,2)', state: 'active' },
          { id: 'i2', title: 'idx_status (status)', badge: 'GIỮ NGUYÊN', badgeTone: 'ok', sees: 'Không cần ghi thêm entry', state: 'active' },
          { id: 'i3', title: 'idx_email (email)', badge: 'GIỮ NGUYÊN', badgeTone: 'ok', sees: 'Không sinh bloat index', state: 'active' },
        ],
      },
    ],
  },
  {
    id: 'pg-vs-innodb',
    label: 'PostgreSQL Heap vs InnoDB Undo Log',
    frames: [
      {
        phase: 'So sánh 2 kiến trúc MVCC',
        action: 'PostgreSQL lưu version ngay trên Heap; InnoDB ghi đè tại chỗ và đẩy bản cũ vào Undo Log',
        note: 'Vì khác kiến trúc lưu version nên PostgreSQL cần VACUUM để dọn dead tuple trên bảng chính, còn MySQL InnoDB có Purge thread dọn Undo Log và không bị table bloat kiểu Postgres nhưng rollback tx dài sẽ rất nặng.',
        query: '-- Cùng chạy 2 lần UPDATE: balance 100 → 200 → 300',
        gate: { text: 'Heap Versioning (PG) vs In-Place + Undo Chain (InnoDB)', tone: 'ok' },
        metrics: [
          { label: 'PG bản cũ nằm ở', value: 'Heap Page' },
          { label: 'InnoDB bản cũ nằm ở', value: 'Undo Log' },
        ],
        stats: [
          { label: 'PostgreSQL', value: 'Cần VACUUM; Rollback O(1)' },
          { label: 'MySQL InnoDB', value: 'Cần Purge Undo; đọc cũ đi ngược chain' },
        ],
        logs: [{ id: 'cmp1', text: 'PG phình Heap khi update nhiều (cần VACUUM); InnoDB giữ Clustered Page gọn, bản cũ nối chuỗi trong Undo Log.' }],
        newLogId: 'cmp1',
        leftTitle: 'PostgreSQL (Heap-based)',
        leftBadge: '3 TUPLES TRONG HEAP',
        tuples: [
          { id: 'p1', ctid: '(0,1)', meta: 'dead (xmax=101)', value: 'balance = 100', state: 'dead' },
          { id: 'p2', ctid: '(0,2)', meta: 'dead (xmax=102)', value: 'balance = 200', state: 'dead' },
          { id: 'p3', ctid: '(0,3)', meta: 'live (xmin=102)', value: 'balance = 300', state: 'matched' },
        ],
        rightTitle: 'MySQL InnoDB (Undo Log Chain)',
        rightBadge: 'IN-PLACE + UNDO',
        lanes: [
          { id: 'ib1', title: 'Clustered Leaf (1 row tại chỗ)', badge: 'HIỆN TẠI', badgeTone: 'solid', sees: 'id=1 | balance=300 | trx=102 | roll_ptr ↓', state: 'active' },
          { id: 'ib2', title: 'Undo Record #2', badge: 'UNDO LOG', badgeTone: 'warn', sees: 'balance=200 | trx=101 | roll_ptr ↓', state: 'warn' },
          { id: 'ib3', title: 'Undo Record #1', badge: 'UNDO LOG', sees: 'balance=100 | trx=98 | (bản gốc)' },
        ],
      },
    ],
  },
];

export function MvccSnapshotAnimation({ initialMode = 'pg-snapshot' }: { initialMode?: string }) {
  return (
    <WorkbenchShell
      id={initialMode === 'hot-vs-nonhot' ? 'hot-update-animation' : 'mvcc-snapshot-animation'}
      title="Mô phỏng cơ chế MVCC, Snapshot xmin/xmax, HOT Update và so sánh InnoDB Undo Log"
      modeAriaLabel="Chọn kịch bản MVCC"
      modes={mvccModes}
      initialModeId={initialMode}
      renderStage={(frame) => (
        <div className={styles.grid2}>
          <div className={styles.panelCard}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>{frame.leftTitle}</span>
              <span className={styles.badge} data-tone="ok">{frame.leftBadge}</span>
            </div>
            <div className={styles.rowList}>
              {frame.tuples.map((t) => (
                <div key={t.id} className={styles.rowStrip} data-state={t.state}>
                  <span><strong>{t.ctid}</strong> {t.value}</span>
                  <span>{t.meta}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.panelCard}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>{frame.rightTitle}</span>
              <span className={styles.badge}>{frame.rightBadge}</span>
            </div>
            <div className={styles.rowList}>
              {frame.lanes.map((lane) => (
                <div key={lane.id} className={styles.panelCard} data-state={lane.state}>
                  <div className={styles.cardHead}>
                    <span className={styles.cardTitle}>{lane.title}</span>
                    <span className={styles.badge} data-tone={lane.badgeTone}>{lane.badge}</span>
                  </div>
                  <span className={styles.subText}>{lane.sees}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    />
  );
}

export function HotUpdateAnimation() {
  return <MvccSnapshotAnimation initialMode="hot-vs-nonhot" />;
}

// ---------------------------------------------------------------------------
// VACUUM vs VACUUM FULL (postgresql/vacuum.md)
// ---------------------------------------------------------------------------
type VacPage = {
  id: string;
  title: string;
  vmBit: '0' | '1';
  state?: 'active' | 'warn' | 'dim';
  slots: { id: string; text: string; state: 'matched' | 'dead' | 'free' | 'active' }[];
};

type VacuumFrame = BaseFrame & {
  pages: VacPage[];
};

const vacuumModes: WorkbenchMode<VacuumFrame>[] = [
  {
    id: 'vacuum',
    label: 'VACUUM thường (Giữ size, tái sử dụng FSM)',
    frames: [
      {
        phase: 'Trước VACUUM (Bloat)',
        action: 'Sau nhiều UPDATE/DELETE: 5 dead tuples chiếm đầy Page 0 & Page 1 (VM bit = 0)',
        note: 'Page 2 chỉ toàn live tuple nên Visibility Map bit = 1. Dung lượng bảng trên đĩa là 3 pages (24 KiB).',
        query: '-- Bảng có 4 live tuples, 5 dead tuples rải trên 3 pages',
        gate: { text: '5 Dead Tuples • Bảng phình 3 pages', tone: 'warn' },
        metrics: [
          { label: 'Dung lượng file', value: '3 pages' },
          { label: 'Dead tuples', value: '5', warn: true },
          { label: 'Lock đọc/ghi', value: 'Không chặn' },
        ],
        stats: [
          { label: 'Live / Dead', value: '4 live / 5 dead', tone: 'warn' },
          { label: 'Trả dung lượng OS', value: 'Chưa' },
        ],
        logs: [{ id: 'v0', text: 'Page 0 (VM=0) và Page 1 (VM=0) chứa nhiều dead tuples; Page 2 (VM=1) sạch.' }],
        newLogId: 'v0',
        pages: [
          {
            id: 'p0', title: 'Page 0', vmBit: '0', state: 'warn',
            slots: [
              { id: 's1', text: 'DEAD #1', state: 'dead' },
              { id: 's2', text: 'LIVE A', state: 'matched' },
              { id: 's3', text: 'DEAD #2', state: 'dead' },
            ],
          },
          {
            id: 'p1', title: 'Page 1', vmBit: '0', state: 'warn',
            slots: [
              { id: 's4', text: 'DEAD #3', state: 'dead' },
              { id: 's5', text: 'DEAD #4', state: 'dead' },
              { id: 's6', text: 'LIVE B', state: 'matched' },
            ],
          },
          {
            id: 'p2', title: 'Page 2', vmBit: '1', state: 'dim',
            slots: [
              { id: 's7', text: 'LIVE C', state: 'matched' },
              { id: 's8', text: 'LIVE D', state: 'matched' },
              { id: 's9', text: 'DEAD #5', state: 'dead' },
            ],
          },
        ],
      },
      {
        phase: 'Chạy VACUUM',
        action: 'VACUUM bỏ qua page sạch (VM=1), dọn dead tuples thành slot trống trong FSM',
        note: 'Không cần Exclusive Lock (app vẫn SELECT/INSERT/UPDATE bình thường). Tuy nhiên kích thước file trên OS VẪN LÀ 3 PAGES vì Page 2 ở cuối còn LIVE C, D.',
        query: 'VACUUM orders;  -- Non-blocking, cập nhật Free Space Map & Visibility Map',
        gate: { text: 'Dead = 0 • File VẪN 3 pages • Slot trống sẵn cho INSERT mới', tone: 'ok' },
        metrics: [
          { label: 'Dung lượng file', value: '3 pages (không giảm)' },
          { label: 'Dead tuples', value: '0' },
          { label: 'Lock đọc/ghi', value: 'Không chặn' },
        ],
        stats: [
          { label: 'Free Space Map', value: '5 slot sẵn tái sử dụng' },
          { label: 'Dung lượng OS', value: 'Vẫn 3 pages' },
        ],
        logs: [
          { id: 'v0', text: 'Page 0 (VM=0) và Page 1 (VM=0) chứa nhiều dead tuples; Page 2 (VM=1) sạch.' },
          { id: 'v1', text: 'VACUUM đánh dấu 5 slot trống vào FSM, bật VM=1. File không co lại nhưng INSERT mới sẽ lấp vào chỗ trống!' },
        ],
        newLogId: 'v1',
        pages: [
          {
            id: 'p0', title: 'Page 0', vmBit: '1', state: 'active',
            slots: [
              { id: 's1', text: 'FREE (FSM)', state: 'free' },
              { id: 's2', text: 'LIVE A', state: 'matched' },
              { id: 's3', text: 'FREE (FSM)', state: 'free' },
            ],
          },
          {
            id: 'p1', title: 'Page 1', vmBit: '1', state: 'active',
            slots: [
              { id: 's4', text: 'FREE (FSM)', state: 'free' },
              { id: 's5', text: 'FREE (FSM)', state: 'free' },
              { id: 's6', text: 'LIVE B', state: 'matched' },
            ],
          },
          {
            id: 'p2', title: 'Page 2', vmBit: '1',
            slots: [
              { id: 's7', text: 'LIVE C', state: 'matched' },
              { id: 's8', text: 'LIVE D', state: 'matched' },
              { id: 's9', text: 'FREE (FSM)', state: 'free' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'vacuum-full',
    label: 'VACUUM FULL (Nén file, ACCESS EXCLUSIVE)',
    frames: [
      {
        phase: 'Khóa bảng & viết file mới',
        action: 'VACUUM FULL giữ ACCESS EXCLUSIVE lock (chặn mọi SELECT/DML) để dồn 4 live tuples sang file mới',
        note: 'Toàn bộ live tuples A, B, C, D được copy khít vào 2 pages mới, rồi file cũ 3 pages bị xóa và trả dung lượng thật về cho OS.',
        query: 'VACUUM FULL orders;  -- CẢNH BÁO: khóa toàn bộ đọc & ghi trên bảng!',
        gate: { text: 'File co từ 3 → 2 pages • BẢNG BỊ KHÓA HOÀN TOÀN lúc chạy', tone: 'warn' },
        metrics: [
          { label: 'Dung lượng file', value: '2 pages (giảm 33%)' },
          { label: 'Dead tuples', value: '0' },
          { label: 'Lock đọc/ghi', value: 'ACCESS EXCLUSIVE!', warn: true },
        ],
        stats: [
          { label: 'Trả đĩa cho OS', value: 'Có (đổi file mới)' },
          { label: 'Production tip', value: 'Dùng pg_repack thay thế', tone: 'warn' },
        ],
        logs: [{ id: 'vf1', text: 'Copy A, B, C, D gọn vào file mới (2 pages) và trả 1 page về OS. Chặn 100% traffic trong lúc chạy!', tone: 'warn' }],
        newLogId: 'vf1',
        pages: [
          {
            id: 'np0', title: 'New Page 0', vmBit: '1', state: 'active',
            slots: [
              { id: 's1', text: 'LIVE A', state: 'matched' },
              { id: 's2', text: 'LIVE B', state: 'matched' },
              { id: 's3', text: 'LIVE C', state: 'matched' },
            ],
          },
          {
            id: 'np1', title: 'New Page 1', vmBit: '1', state: 'active',
            slots: [
              { id: 's4', text: 'LIVE D', state: 'matched' },
              { id: 's5', text: 'FREE', state: 'free' },
              { id: 's6', text: 'FREE', state: 'free' },
            ],
          },
          {
            id: 'old', title: 'Old Page 2 (ĐÃ XÓA)', vmBit: '1', state: 'dim',
            slots: [
              { id: 's7', text: 'Trả dung lượng về OS', state: 'free' },
            ],
          },
        ],
      },
    ],
  },
];

export function VacuumBloatAnimation() {
  return (
    <WorkbenchShell
      id="vacuum-bloat-animation"
      title="Mô phỏng VACUUM thường (FSM & Visibility Map) so với VACUUM FULL"
      modeAriaLabel="Chọn loại VACUUM"
      modes={vacuumModes}
      renderStage={(frame) => (
        <div className={styles.grid3}>
          {frame.pages.map((page) => (
            <div key={page.id} className={styles.panelCard} data-state={page.state}>
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>{page.title}</span>
                <span className={styles.badge} data-tone={page.vmBit === '1' ? 'ok' : 'warn'}>
                  VM={page.vmBit}
                </span>
              </div>
              <div className={styles.rowList}>
                {page.slots.map((slot) => (
                  <div key={slot.id} className={styles.rowStrip} data-state={slot.state}>
                    <span>{slot.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    />
  );
}
