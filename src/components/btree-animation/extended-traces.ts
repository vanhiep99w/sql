import type { BaseFrame, WorkbenchMode } from '../sql-workbench/workbench-shell';

export type ExtKeyState = 'comparing' | 'matched' | 'new' | 'stopped' | 'filtered' | 'discarded';

export type ExtTreeNode = {
  id: string;
  label: string;
  kind: 'root' | 'internal' | 'leaf';
  keys: string[];
  capacity?: number;
  rangeHint?: string;
  badge?: string;
  active?: boolean;
  visited?: boolean;
  full?: boolean;
  dim?: boolean;
};

export type ExtTreeEdge = {
  from: string;
  to: string;
  label?: string;
  active?: boolean;
  dashed?: boolean;
  branchIndex: number;
};

export type ExtSiblingLink = {
  from: string;
  to: string;
  active?: boolean;
};

export type StoragePage = {
  id: string;
  title: string;
  badge?: string;
  active?: boolean;
  dim?: boolean;
  rows: { id: string; text: string; matched?: boolean }[];
};

export type ExtTreeFrame = BaseFrame & {
  incoming?: { key: string; label: string; tone?: 'ok' | 'warn' };
  levels: ExtTreeNode[][];
  edges: ExtTreeEdge[];
  siblingLinks: ExtSiblingLink[];
  keyStates?: Record<string, Record<string, ExtKeyState>>;
  storage?: {
    dividerText: string;
    dividerActive?: boolean;
    dividerSkip?: boolean;
    pages: StoragePage[];
  };
};

// ---------------------------------------------------------------------------
// 1. Primary Key: Sequential (BIGSERIAL / UUIDv7) vs Random (UUIDv4)
// ---------------------------------------------------------------------------
export const primaryKeyModes: WorkbenchMode<ExtTreeFrame>[] = [
  {
    id: 'sequential',
    label: 'Sequential (BIGSERIAL / UUIDv7)',
    frames: [
      {
        phase: 'Bắt đầu',
        action: 'Chèn 4 key tăng dần vào cây đang có 2 leaf đầy',
        note: 'Mọi key mới đều lớn hơn key hiện có nên luôn đi về leaf ngoài cùng bên phải (rightmost leaf).',
        query: 'INSERT INTO users (id) VALUES (50), (60), (70), (80);  -- hoặc UUIDv7',
        metrics: [
          { label: 'Số leaf', value: '2 page' },
          { label: 'Page split', value: '0 lần' },
          { label: 'Độ đầy TB', value: '75%' },
        ],
        stats: [
          { label: 'Page split', value: '0 lần' },
          { label: 'Độ đầy TB', value: '6 / 8 slot (75%)' },
          { label: 'Leaf nóng', value: '1 (Leaf B)' },
        ],
        logs: [],
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['30'] }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['10', '20', '25', '28'], capacity: 4, badge: '100%' },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['30', '40'], capacity: 4, badge: '50%' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'l2', label: '≥ 30', branchIndex: 1 },
        ],
        siblingLinks: [{ from: 'l1', to: 'l2' }],
      },
      {
        phase: 'Insert 1–2',
        action: 'Chèn 50 và 60 vào cuối Leaf B (còn chỗ)',
        note: 'Cả hai insert rơi đúng vào 1 hot page (Leaf B đang nằm sẵn trong Buffer Pool). Leaf A không bao giờ bị chạm lại.',
        query: 'INSERT INTO users (id) VALUES (50), (60);',
        incoming: { label: 'Append', key: '50, 60' },
        gate: { text: 'Rightmost hit • 0 split', tone: 'ok' },
        metrics: [
          { label: 'Số leaf', value: '2 page' },
          { label: 'Page split', value: '0 lần' },
          { label: 'Độ đầy TB', value: '100%' },
        ],
        stats: [
          { label: 'Page split', value: '0 lần' },
          { label: 'Độ đầy TB', value: '8 / 8 slot (100%)' },
          { label: 'Leaf nóng', value: '1 (Leaf B)' },
        ],
        logs: [{ id: 's1', text: 'Chèn 50, 60 nối đuôi Leaf B — đầy 4/4 (100%), không đụng Leaf A.' }],
        newLogId: 's1',
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['30'], visited: true }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['10', '20', '25', '28'], capacity: 4, badge: '100%', dim: true },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['30', '40', '50', '60'], capacity: 4, active: true, full: true, badge: 'ĐẦY' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'l2', label: '≥ 30', branchIndex: 1, active: true },
        ],
        siblingLinks: [{ from: 'l1', to: 'l2' }],
        keyStates: { l2: { '50': 'new', '60': 'new' } },
      },
      {
        phase: 'Rightmost Split',
        action: 'Chèn 70: cấp Leaf C mới ở rìa phải, giữ nguyên Leaf B đầy 100%',
        note: 'Tối ưu rightmost-split (PostgreSQL/InnoDB): không tách đôi 50/50 lãng phí mà giữ Leaf B đầy gần 100%, mở Leaf C mới cho 70.',
        query: 'INSERT INTO users (id) VALUES (70);',
        incoming: { label: 'Append', key: '70' },
        gate: { text: 'Rightmost append split (không cắt đôi)', tone: 'ok' },
        metrics: [
          { label: 'Số leaf', value: '3 page' },
          { label: 'Page split', value: '1 lần' },
          { label: 'Độ đầy TB', value: '75%' },
        ],
        stats: [
          { label: 'Page split', value: '1 lần (rìa phải)' },
          { label: 'Độ đầy cũ', value: 'Leaf A/B: 100%' },
          { label: 'Leaf nóng', value: '1 (Leaf C)' },
        ],
        logs: [
          { id: 's1', text: 'Chèn 50, 60 nối đuôi Leaf B — đầy 4/4 (100%), không đụng Leaf A.' },
          { id: 's2', text: 'Leaf B đầy → mở Leaf C mới đặt 70, đẩy separator 70 lên Root; Leaf B giữ 100%.' },
        ],
        newLogId: 's2',
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['30', '70'], active: true }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['10', '20', '25', '28'], capacity: 4, badge: '100%', dim: true },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['30', '40', '50', '60'], capacity: 4, badge: '100%', visited: true },
            { id: 'l3', label: 'Leaf C', kind: 'leaf', keys: ['70'], capacity: 4, active: true, badge: 'MỚI' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'l2', label: '30..69', branchIndex: 1 },
          { from: 'root', to: 'l3', label: '≥ 70', branchIndex: 2, active: true },
        ],
        siblingLinks: [
          { from: 'l1', to: 'l2' },
          { from: 'l2', to: 'l3', active: true },
        ],
        keyStates: { root: { '70': 'new' }, l3: { '70': 'new' } },
      },
      {
        phase: 'Hoàn tất',
        action: 'Chèn 80 vào Leaf C — working set chỉ 1 page, không fragmentation',
        note: 'Các page lịch sử (Leaf A, Leaf B) kín 100% và ổn định. Chỉ 1 leaf cuối cùng cần giữ nóng trong RAM.',
        query: 'INSERT INTO users (id) VALUES (80);  -- hoàn tất 4 insert',
        incoming: { label: 'Append', key: '80' },
        gate: { text: 'Gọn • Ít WAL • Cache hit cực cao', tone: 'ok' },
        metrics: [
          { label: 'Số leaf', value: '3 page' },
          { label: 'Page split', value: '1 lần' },
          { label: 'Độ đầy TB', value: '83%' },
        ],
        stats: [
          { label: 'Tổng split', value: '1 lần' },
          { label: 'Độ đầy TB', value: '10 / 12 slot (83%)' },
          { label: 'Page đã chạm', value: '2 / 3 leaf' },
        ],
        logs: [
          { id: 's1', text: 'Chèn 50, 60 nối đuôi Leaf B — đầy 4/4 (100%), không đụng Leaf A.' },
          { id: 's2', text: 'Leaf B đầy → mở Leaf C mới đặt 70, đẩy separator 70 lên Root; Leaf B giữ 100%.' },
          { id: 's3', text: 'Chèn 80 vào Leaf C. Kết quả: 3 leaf, 1 split, độ đầy trung bình 83%.' },
        ],
        newLogId: 's3',
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['30', '70'], visited: true }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['10', '20', '25', '28'], capacity: 4, badge: '100%' },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['30', '40', '50', '60'], capacity: 4, badge: '100%' },
            { id: 'l3', label: 'Leaf C', kind: 'leaf', keys: ['70', '80'], capacity: 4, active: true, badge: '50%' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'l2', label: '30..69', branchIndex: 1 },
          { from: 'root', to: 'l3', label: '≥ 70', branchIndex: 2, active: true },
        ],
        siblingLinks: [
          { from: 'l1', to: 'l2' },
          { from: 'l2', to: 'l3' },
        ],
        keyStates: { l3: { '80': 'matched' } },
      },
    ],
  },
  {
    id: 'uuidv4',
    label: 'UUIDv4 (Random Insert)',
    frames: [
      {
        phase: 'Bắt đầu',
        action: 'Chèn 3 UUIDv4 ngẫu nhiên vào cây có 2 leaf đã đầy',
        note: 'Các tiền tố hex ngẫu nhiên (vd 2c.., 9a.., 4e..) rơi rải rác vào giữa các leaf cũ thay vì nối đuôi.',
        query: "INSERT INTO users (id) VALUES ('2c..'), ('9a..'), ('4e..');  -- UUIDv4 random",
        metrics: [
          { label: 'Số leaf', value: '2 page' },
          { label: 'Page split', value: '0 lần' },
          { label: 'Độ đầy TB', value: '100%' },
        ],
        stats: [
          { label: 'Page split', value: '0 lần' },
          { label: 'Độ đầy TB', value: '8 / 8 slot (100%)' },
          { label: 'Random I/O', value: 'Chưa phát sinh' },
        ],
        logs: [],
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['70..'] }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['1a..', '20..', '44..', '6b..'], capacity: 4, full: true, badge: 'ĐẦY' },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['70..', '8f..', 'b2..', 'e9..'], capacity: 4, full: true, badge: 'ĐẦY' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 70..', branchIndex: 0 },
          { from: 'root', to: 'l2', label: '≥ 70..', branchIndex: 1 },
        ],
        siblingLinks: [{ from: 'l1', to: 'l2' }],
      },
      {
        phase: 'Split #1 (Giữa cây)',
        action: "Chèn '2c..' rơi vào Leaf A đang đầy → tách đôi 50/50",
        note: 'Phải đọc cold page Leaf A từ disk, cấp Leaf A2 mới, di chuyển 44.. và 6b.. sang. Cả 2 leaf chỉ còn ~50–75% đầy.',
        query: "INSERT INTO users (id) VALUES ('2c..');",
        incoming: { label: 'Random', key: '2c..', tone: 'warn' },
        gate: { text: 'Page Split #1 tại Leaf A (50/50)', tone: 'warn' },
        metrics: [
          { label: 'Số leaf', value: '3 page' },
          { label: 'Page split', value: '1 lần', warn: true },
          { label: 'Độ đầy TB', value: '75%' },
        ],
        stats: [
          { label: 'Page split', value: '1 lần', tone: 'warn' },
          { label: 'Độ đầy TB', value: '9 / 12 slot (75%)' },
          { label: 'Ô trống bỏ phí', value: '3 slot' },
        ],
        logs: [{ id: 'u1', text: "Insert '2c..' làm split Leaf A → sinh Leaf A2, để trống 3 slot rải rác.", tone: 'warn' }],
        newLogId: 'u1',
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['44..', '70..'], active: true }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['1a..', '20..', '2c..'], capacity: 4, active: true, badge: '75%' },
            { id: 'l1b', label: 'Leaf A2', kind: 'leaf', keys: ['44..', '6b..'], capacity: 4, active: true, badge: '50%' },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['70..', '8f..', 'b2..', 'e9..'], capacity: 4, full: true, badge: 'ĐẦY' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 44..', branchIndex: 0, active: true },
          { from: 'root', to: 'l1b', label: '44..6f', branchIndex: 1, active: true },
          { from: 'root', to: 'l2', label: '≥ 70..', branchIndex: 2 },
        ],
        siblingLinks: [
          { from: 'l1', to: 'l1b', active: true },
          { from: 'l1b', to: 'l2' },
        ],
        keyStates: { root: { '44..': 'new' }, l1: { '2c..': 'new' }, l1b: { '44..': 'comparing', '6b..': 'comparing' } },
      },
      {
        phase: 'Split #2 (Nhánh khác)',
        action: "Chèn '9a..' nhảy sang Leaf B đầy → tiếp tục tách đôi Leaf B2",
        note: 'Mỗi insert nhảy sang một vùng hoàn toàn khác của cây, phá hỏng cache locality và nhân đôi WAL full-page writes.',
        query: "INSERT INTO users (id) VALUES ('9a..');",
        incoming: { label: 'Random', key: '9a..', tone: 'warn' },
        gate: { text: 'Page Split #2 tại Leaf B (50/50)', tone: 'bad' },
        metrics: [
          { label: 'Số leaf', value: '4 page', warn: true },
          { label: 'Page split', value: '2 lần', warn: true },
          { label: 'Độ đầy TB', value: '63%', warn: true },
        ],
        stats: [
          { label: 'Page split', value: '2 lần', tone: 'warn' },
          { label: 'Độ đầy TB', value: '10 / 16 slot (63%)', tone: 'warn' },
          { label: 'Ô trống phân mảnh', value: '6 / 16 slot', tone: 'warn' },
        ],
        logs: [
          { id: 'u1', text: "Insert '2c..' làm split Leaf A → sinh Leaf A2, để trống 3 slot rải rác.", tone: 'warn' },
          { id: 'u2', text: "Insert '9a..' nhảy sang Leaf B → split thêm Leaf B2; độ đầy tụt còn 63%.", tone: 'warn' },
        ],
        newLogId: 'u2',
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['44..', '70..', '9a..'], active: true }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['1a..', '20..', '2c..'], capacity: 4, badge: '75%' },
            { id: 'l1b', label: 'Leaf A2', kind: 'leaf', keys: ['44..', '6b..'], capacity: 4, badge: '50%' },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['70..', '8f..'], capacity: 4, active: true, badge: '50%' },
            { id: 'l2b', label: 'Leaf B2', kind: 'leaf', keys: ['9a..', 'b2..', 'e9..'], capacity: 4, active: true, badge: '75%' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 44..', branchIndex: 0 },
          { from: 'root', to: 'l1b', label: '44..6f', branchIndex: 1 },
          { from: 'root', to: 'l2', label: '70..99', branchIndex: 2, active: true },
          { from: 'root', to: 'l2b', label: '≥ 9a..', branchIndex: 3, active: true },
        ],
        siblingLinks: [
          { from: 'l1', to: 'l1b' },
          { from: 'l1b', to: 'l2' },
          { from: 'l2', to: 'l2b', active: true },
        ],
        keyStates: { root: { '9a..': 'new' }, l2b: { '9a..': 'new' } },
      },
      {
        phase: 'Kết quả Bloat',
        action: "Chèn '4e..' lại nhảy về Leaf A2 — nhiều page nửa rỗng & RAM phình to",
        note: 'Cùng lượng key nhưng UUIDv4 tạo nhiều page hơn, độ đầy trung bình thấp (~55–69%), working set phải ôm gần như toàn bộ index trong Buffer Pool.',
        query: "INSERT INTO users (id) VALUES ('4e..');  -- phân mảnh trên cả 4 leaf",
        incoming: { label: 'Random', key: '4e..', tone: 'warn' },
        gate: { text: 'Index Bloat • Random I/O • 2 split / 3 insert', tone: 'bad' },
        metrics: [
          { label: 'Số leaf', value: '4 page', warn: true },
          { label: 'Page split', value: '2 lần', warn: true },
          { label: 'Độ đầy TB', value: '69%', warn: true },
        ],
        stats: [
          { label: 'Tổng split', value: '2 lần / 3 insert', tone: 'warn' },
          { label: 'Độ đầy TB', value: '11 / 16 slot (69%)', tone: 'warn' },
          { label: 'Leaf phải chạm', value: '4 / 4 leaf (toàn cây)', tone: 'warn' },
        ],
        logs: [
          { id: 'u1', text: "Insert '2c..' làm split Leaf A → sinh Leaf A2, để trống 3 slot rải rác.", tone: 'warn' },
          { id: 'u2', text: "Insert '9a..' nhảy sang Leaf B → split thêm Leaf B2; độ đầy tụt còn 63%.", tone: 'warn' },
          { id: 'u3', text: "Insert '4e..' quay lại Leaf A2 → mọi vùng cây đều phải nạp RAM, bloat tăng nhanh.", tone: 'warn' },
        ],
        newLogId: 'u3',
        levels: [
          [{ id: 'root', label: 'Root', kind: 'root', keys: ['44..', '70..', '9a..'], visited: true }],
          [
            { id: 'l1', label: 'Leaf A', kind: 'leaf', keys: ['1a..', '20..', '2c..'], capacity: 4, badge: '75%' },
            { id: 'l1b', label: 'Leaf A2', kind: 'leaf', keys: ['44..', '4e..', '6b..'], capacity: 4, active: true, badge: '75%' },
            { id: 'l2', label: 'Leaf B', kind: 'leaf', keys: ['70..', '8f..'], capacity: 4, badge: '50%' },
            { id: 'l2b', label: 'Leaf B2', kind: 'leaf', keys: ['9a..', 'b2..', 'e9..'], capacity: 4, badge: '75%' },
          ],
        ],
        edges: [
          { from: 'root', to: 'l1', label: '< 44..', branchIndex: 0 },
          { from: 'root', to: 'l1b', label: '44..6f', branchIndex: 1, active: true },
          { from: 'root', to: 'l2', label: '70..99', branchIndex: 2 },
          { from: 'root', to: 'l2b', label: '≥ 9a..', branchIndex: 3 },
        ],
        siblingLinks: [
          { from: 'l1', to: 'l1b' },
          { from: 'l1b', to: 'l2' },
          { from: 'l2', to: 'l2b' },
        ],
        keyStates: { l1b: { '4e..': 'new' } },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 2. Composite Index & Leftmost Prefix
// Index: (a, b, c) — ví dụ (customer, status, day)
// ---------------------------------------------------------------------------
function compositeBaseLevels(overrides: Partial<Record<'root' | 'la' | 'lb' | 'lc', Partial<ExtTreeNode>>> = {}): ExtTreeNode[][] {
  return [
    [{ id: 'root', label: 'Root idx(a, b, c)', kind: 'root', keys: ['(10, M, 05)', '(20, A, 01)'], ...overrides.root }],
    [
      { id: 'la', label: 'Leaf A', kind: 'leaf', keys: ['(10, A, 02)', '(10, A, 08)', '(10, C, 05)'], rangeHint: '< (10,M,05)', ...overrides.la },
      { id: 'lb', label: 'Leaf B', kind: 'leaf', keys: ['(10, M, 05)', '(10, P, 02)', '(10, P, 09)'], rangeHint: '(10,M)..(20,A)', ...overrides.lb },
      { id: 'lc', label: 'Leaf C', kind: 'leaf', keys: ['(20, A, 01)', '(20, C, 05)', '(20, P, 05)'], rangeHint: '≥ (20,A,01)', ...overrides.lc },
    ],
  ];
}

const compositeBaseEdges = (active?: string[]): ExtTreeEdge[] => [
  { from: 'root', to: 'la', label: '< (10,M)', branchIndex: 0, active: active?.includes('la') },
  { from: 'root', to: 'lb', label: '(10,M)..', branchIndex: 1, active: active?.includes('lb') },
  { from: 'root', to: 'lc', label: '≥ (20,A)', branchIndex: 2, active: active?.includes('lc') },
];

export const compositeIndexModes: WorkbenchMode<ExtTreeFrame>[] = [
  {
    id: 'prefix',
    label: 'Đủ Leftmost: a=10 AND b=A',
    frames: [
      {
        phase: 'Root Seek',
        action: 'So sánh tiền tố (10, A, *) với separator ở Root',
        note: 'Index sắp xếp theo (a, b, c). Có đủ a và b từ trái sang → Root chọn ngay đúng nhánh trái (< (10, M, 05)).',
        query: "SELECT * FROM orders WHERE a = 10 AND b = 'A';  -- Index (a, b, c)",
        gate: { text: 'Access Predicate: (a = 10, b = A)', tone: 'ok' },
        metrics: [
          { label: 'Entry đã đọc', value: '0' },
          { label: 'Bị Filter loại', value: '0' },
          { label: 'Khớp', value: '0' },
        ],
        stats: [
          { label: 'Access Cond', value: 'a=10, b=A' },
          { label: 'Filter Cond', value: 'Không có' },
          { label: 'Leaf cần đọc', value: '1 / 3 leaf' },
        ],
        logs: [{ id: 'c1', text: 'Root so sánh (10, A) < (10, M, 05) → nhảy thẳng xuống Leaf A.' }],
        newLogId: 'c1',
        levels: compositeBaseLevels({ root: { active: true }, lb: { dim: true }, lc: { dim: true } }),
        edges: compositeBaseEdges(['la']),
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: { root: { '(10, M, 05)': 'comparing' } },
      },
      {
        phase: 'Leaf Scan',
        action: 'Đọc liên tiếp (10, A, 02) và (10, A, 08) rồi dừng ngay ở (10, C, 05)',
        note: 'Mọi dòng khớp nằm gom sát nhau trong Leaf A. Vừa gặp b = C > A, database dừng lập tức — không cần đụng Leaf B, C.',
        query: "SELECT * FROM orders WHERE a = 10 AND b = 'A';",
        gate: { text: 'Dừng sớm tại (10, C, 05) • 0 dòng thừa', tone: 'ok' },
        metrics: [
          { label: 'Entry đã đọc', value: '3' },
          { label: 'Bị Filter loại', value: '0' },
          { label: 'Khớp', value: '2' },
        ],
        stats: [
          { label: 'Access Cond', value: 'a=10, b=A' },
          { label: 'Filter Cond', value: 'Không có' },
          { label: 'Hiệu suất đọc', value: '2/3 (rất cao)' },
        ],
        logs: [
          { id: 'c1', text: 'Root so sánh (10, A) < (10, M, 05) → nhảy thẳng xuống Leaf A.' },
          { id: 'c2', text: 'Khớp (10, A, 02), (10, A, 08). Gặp (10, C, 05) vượt khoảng → DỪNG.' },
        ],
        newLogId: 'c2',
        levels: compositeBaseLevels({ root: { visited: true }, la: { active: true }, lb: { dim: true }, lc: { dim: true } }),
        edges: compositeBaseEdges(['la']),
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: {
          la: { '(10, A, 02)': 'matched', '(10, A, 08)': 'matched', '(10, C, 05)': 'stopped' },
        },
      },
    ],
  },
  {
    id: 'gap',
    label: 'Gap / Range chặn cột sau: a=10 AND c=05',
    frames: [
      {
        phase: 'Gap ở cột b',
        action: 'Bỏ qua cột b → chỉ dùng được a = 10 để Seek',
        note: 'Root chỉ biết mọi key có a = 10 nằm ở Leaf A và Leaf B. Giá trị c = 05 nằm rải rác dưới nhiều b khác nhau (A, C, M, P).',
        query: 'SELECT * FROM orders WHERE a = 10 AND c = 05;  -- Thiếu b (gap)',
        gate: { text: 'Access: a = 10 • Filter: c = 05', tone: 'warn' },
        metrics: [
          { label: 'Entry đã đọc', value: '0' },
          { label: 'Bị Filter loại', value: '0' },
          { label: 'Khớp', value: '0' },
        ],
        stats: [
          { label: 'Access Cond', value: 'Chỉ a = 10' },
          { label: 'Filter Cond', value: 'c = 05 (sau khi đọc)', tone: 'warn' },
          { label: 'Phạm vi quét', value: 'Toàn bộ a = 10' },
        ],
        logs: [{ id: 'g1', text: 'Không có điều kiện b → phải duyệt toàn bộ vùng a = 10 từ đầu Leaf A.', tone: 'warn' }],
        newLogId: 'g1',
        levels: compositeBaseLevels({ root: { active: true }, lc: { dim: true } }),
        edges: compositeBaseEdges(['la']),
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: { root: { '(10, M, 05)': 'comparing' } },
      },
      {
        phase: 'Access + Filter (Leaf A)',
        action: 'Đọc mọi entry của a = 10 trong Leaf A rồi lọc c = 05',
        note: '(10, A, 02) và (10, A, 08) vẫn phải đọc rồi gạch bỏ (Filter). Chỉ (10, C, 05) thỏa c = 05.',
        query: 'SELECT * FROM orders WHERE a = 10 AND c = 05;',
        gate: { text: '2 entry bị Filter loại bỏ ở Leaf A', tone: 'warn' },
        metrics: [
          { label: 'Entry đã đọc', value: '3' },
          { label: 'Bị Filter loại', value: '2', warn: true },
          { label: 'Khớp', value: '1' },
        ],
        stats: [
          { label: 'Đã đọc', value: '3 entry' },
          { label: 'Bị lọc bỏ', value: '2 entry', tone: 'warn' },
          { label: 'Khớp', value: '1 entry' },
        ],
        logs: [
          { id: 'g1', text: 'Không có điều kiện b → phải duyệt toàn bộ vùng a = 10 từ đầu Leaf A.', tone: 'warn' },
          { id: 'g2', text: 'Leaf A: loại (10,A,02), (10,A,08); giữ (10,C,05). Chưa dừng vì vẫn còn a = 10.' },
        ],
        newLogId: 'g2',
        levels: compositeBaseLevels({ root: { visited: true }, la: { active: true }, lc: { dim: true } }),
        edges: compositeBaseEdges(['la']),
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: {
          la: { '(10, A, 02)': 'filtered', '(10, A, 08)': 'filtered', '(10, C, 05)': 'matched' },
        },
      },
      {
        phase: 'Trượt sang Leaf B',
        action: 'Phải đọc tiếp toàn bộ Leaf B cho tới khi a > 10 mới dám dừng',
        note: 'Tương tự khi cột b dùng RANGE (vd b > A AND c = 05): các giá trị c không còn liên tục nên phải đọc 6 entry mới lấy 2 khớp!',
        query: 'SELECT * FROM orders WHERE a = 10 AND c = 05;',
        gate: { text: 'Đọc 6 entry, Filter bỏ 4 • Tương tự Range trên b', tone: 'bad' },
        metrics: [
          { label: 'Entry đã đọc', value: '6', warn: true },
          { label: 'Bị Filter loại', value: '4', warn: true },
          { label: 'Khớp', value: '2' },
        ],
        stats: [
          { label: 'Đã đọc', value: '6 entry (2 leaf)', tone: 'warn' },
          { label: 'Bị lọc bỏ', value: '4 / 6 (67% lãng phí)', tone: 'warn' },
          { label: 'Cách sửa', value: 'Đặt cột = trước Range' },
        ],
        logs: [
          { id: 'g1', text: 'Không có điều kiện b → phải duyệt toàn bộ vùng a = 10 từ đầu Leaf A.', tone: 'warn' },
          { id: 'g2', text: 'Leaf A: loại (10,A,02), (10,A,08); giữ (10,C,05). Chưa dừng vì vẫn còn a = 10.' },
          { id: 'g3', text: 'Leaf B: giữ (10,M,05), loại (10,P,02) và (10,P,09). Chỉ dừng khi tới Leaf C (a=20).', tone: 'warn' },
        ],
        newLogId: 'g3',
        levels: compositeBaseLevels({ root: { visited: true }, la: { visited: true }, lb: { active: true }, lc: { dim: true } }),
        edges: compositeBaseEdges(['la']),
        siblingLinks: [{ from: 'la', to: 'lb', active: true }, { from: 'lb', to: 'lc' }],
        keyStates: {
          la: { '(10, A, 02)': 'filtered', '(10, A, 08)': 'filtered', '(10, C, 05)': 'matched' },
          lb: { '(10, M, 05)': 'matched', '(10, P, 02)': 'filtered', '(10, P, 09)': 'filtered' },
        },
      },
    ],
  },
  {
    id: 'violation',
    label: 'Vi phạm Leftmost: WHERE b = C',
    frames: [
      {
        phase: 'Root bó tay',
        action: 'Không có cột đầu tiên a → Root không chọn được nhánh nào',
        note: 'Các dòng có b = C xuất hiện ở cả a = 10 (Leaf A) lẫn a = 20 (Leaf C). Không tồn tại start_key để nhảy thẳng.',
        query: "SELECT * FROM orders WHERE b = 'C';  -- Thiếu cột leftmost a",
        gate: { text: 'Không thể Seek từ Root → Quét toàn bộ cây', tone: 'bad' },
        metrics: [
          { label: 'Leaf phải đọc', value: '3 / 3 leaf', warn: true },
          { label: 'Bị lọc bỏ', value: '7 / 9', warn: true },
          { label: 'Khớp', value: '2' },
        ],
        stats: [
          { label: 'Access Cond', value: 'Không có', tone: 'warn' },
          { label: 'Chiến lược', value: 'Full Index / Seq Scan', tone: 'warn' },
          { label: 'Hiệu quả', value: 'Rất thấp (2/9)' },
        ],
        logs: [{ id: 'v1', text: 'b = C nằm rải ở mọi giá trị a → không thể cắt nhánh tại Root.', tone: 'warn' }],
        newLogId: 'v1',
        levels: compositeBaseLevels({ root: { active: true, full: true } }),
        edges: [
          { from: 'root', to: 'la', label: '?', branchIndex: 0, dashed: true },
          { from: 'root', to: 'lb', label: '?', branchIndex: 1, dashed: true },
          { from: 'root', to: 'lc', label: '?', branchIndex: 2, dashed: true },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
      },
      {
        phase: 'Full Scan mọi Leaf',
        action: 'Buộc phải duyệt cả 3 leaf (9 entry) mới tìm ra 2 dòng b = C',
        note: 'Trên bảng lớn, Optimizer sẽ bỏ qua index này và chuyển thẳng sang Sequential Scan (hoặc Skip Scan nếu số giá trị distinct của a rất nhỏ).',
        query: "SELECT * FROM orders WHERE b = 'C';",
        gate: { text: 'Quét 9/9 entry • 7 entry bị loại', tone: 'bad' },
        metrics: [
          { label: 'Leaf phải đọc', value: '3 / 3 leaf', warn: true },
          { label: 'Bị lọc bỏ', value: '7 / 9', warn: true },
          { label: 'Khớp', value: '2' },
        ],
        stats: [
          { label: 'Đã đọc', value: '9 / 9 entry', tone: 'warn' },
          { label: 'Bị lọc bỏ', value: '7 entry', tone: 'warn' },
          { label: 'Khắc phục', value: 'Tạo index bắt đầu bằng b' },
        ],
        logs: [
          { id: 'v1', text: 'b = C nằm rải ở mọi giá trị a → không thể cắt nhánh tại Root.', tone: 'warn' },
          { id: 'v2', text: 'Phải quét trọn Leaf A → Leaf B → Leaf C để nhặt (10, C, 05) và (20, C, 05).', tone: 'warn' },
        ],
        newLogId: 'v2',
        levels: compositeBaseLevels({ la: { active: true }, lb: { active: true }, lc: { active: true } }),
        edges: compositeBaseEdges(),
        siblingLinks: [{ from: 'la', to: 'lb', active: true }, { from: 'lb', to: 'lc', active: true }],
        keyStates: {
          la: { '(10, A, 02)': 'filtered', '(10, A, 08)': 'filtered', '(10, C, 05)': 'matched' },
          lb: { '(10, M, 05)': 'filtered', '(10, P, 02)': 'filtered', '(10, P, 09)': 'filtered' },
          lc: { '(20, A, 01)': 'filtered', '(20, C, 05)': 'matched', '(20, P, 05)': 'filtered' },
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 3. Clustered vs Nonclustered Index (InnoDB PK vs Postgres CTID vs Double Lookup vs Covering)
// ---------------------------------------------------------------------------
export const clusteredLookupModes: WorkbenchMode<ExtTreeFrame>[] = [
  {
    id: 'clustered',
    label: 'Clustered (InnoDB PK)',
    frames: [
      {
        phase: 'Root → Leaf',
        action: 'Tìm id = 42 trên Clustered Index (Primary Key)',
        note: 'Root điều hướng xuống Leaf B chứa khoảng 30..59.',
        query: 'SELECT id, email, total FROM orders WHERE id = 42;  -- InnoDB Clustered PK',
        gate: { text: 'Chỉ 1 cây B+Tree chứa luôn row data', tone: 'ok' },
        metrics: [
          { label: 'Cây đã duyệt', value: '1 cây' },
          { label: 'Table/Heap Jump', value: '0 lần' },
        ],
        stats: [
          { label: 'Kiến trúc', value: 'Clustered PK' },
          { label: 'Bước nhảy thêm', value: '0 lần' },
        ],
        logs: [{ id: 'cl1', text: 'Root so sánh 30 ≤ 42 < 60 → đi xuống Leaf B.' }],
        newLogId: 'cl1',
        levels: [
          [{ id: 'root', label: 'Clustered Root (id)', kind: 'root', keys: ['30', '60'], active: true }],
          [
            { id: 'la', label: 'Leaf A', kind: 'leaf', keys: ['10 | row', '20 | row'], dim: true },
            { id: 'lb', label: 'Leaf B', kind: 'leaf', keys: ['30 | row', '42 | an@.. | 950k', '55 | row'] },
            { id: 'lc', label: 'Leaf C', kind: 'leaf', keys: ['60 | row', '75 | row'], dim: true },
          ],
        ],
        edges: [
          { from: 'root', to: 'la', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '30..59', branchIndex: 1, active: true },
          { from: 'root', to: 'lc', label: '≥ 60', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
      },
      {
        phase: 'Xong ngay tại Leaf',
        action: 'Tìm thấy 42 và lấy đủ toàn bộ cột row ngay tại Leaf B',
        note: 'Leaf của Clustered Index chính là data page. Không tồn tại bảng heap tách rời nên 0 lần random lookup thêm.',
        query: 'SELECT id, email, total FROM orders WHERE id = 42;',
        gate: { text: 'Trả kết quả ngay tại Leaf • 0 Extra Lookup', tone: 'ok' },
        metrics: [
          { label: 'Cây đã duyệt', value: '1 cây' },
          { label: 'Table/Heap Jump', value: '0 lần' },
        ],
        stats: [
          { label: 'Kiến trúc', value: 'Clustered PK' },
          { label: 'Tổng page đọc', value: '2 (Root + Leaf B)' },
        ],
        logs: [
          { id: 'cl1', text: 'Root so sánh 30 ≤ 42 < 60 → đi xuống Leaf B.' },
          { id: 'cl2', text: 'Leaf B chứa sẵn (42, an@.., 950k) → trả kết quả ngay, không cần nhảy tiếp.' },
        ],
        newLogId: 'cl2',
        levels: [
          [{ id: 'root', label: 'Clustered Root (id)', kind: 'root', keys: ['30', '60'], visited: true }],
          [
            { id: 'la', label: 'Leaf A', kind: 'leaf', keys: ['10 | row', '20 | row'], dim: true },
            { id: 'lb', label: 'Leaf B (Data Page)', kind: 'leaf', keys: ['30 | row', '42 | an@.. | 950k', '55 | row'], active: true, badge: 'FULL ROW' },
            { id: 'lc', label: 'Leaf C', kind: 'leaf', keys: ['60 | row', '75 | row'], dim: true },
          ],
        ],
        edges: [
          { from: 'root', to: 'la', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '30..59', branchIndex: 1, active: true },
          { from: 'root', to: 'lc', label: '≥ 60', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: { lb: { '42 | an@.. | 950k': 'matched' } },
      },
    ],
  },
  {
    id: 'pg-heap',
    label: 'PostgreSQL (Nonclustered → Heap CTID)',
    frames: [
      {
        phase: 'Bước 1 — Tra Index',
        action: "Tìm email = 'an@..' trên B+Tree để lấy con trỏ vật lý ctid (3, 2)",
        note: 'Mọi index trong PostgreSQL đều là Nonclustered. Leaf chỉ lưu key + ctid (số page và slot trong bảng Heap).',
        query: "SELECT email, total FROM orders WHERE email = 'an@..';  -- PostgreSQL",
        gate: { text: 'Leaf trả về ctid = (page 3, slot 2)', tone: 'ok' },
        metrics: [
          { label: 'Index page', value: '2' },
          { label: 'Heap Fetch', value: 'Sắp nhảy' },
        ],
        stats: [
          { label: 'Row locator', value: 'ctid (3, 2)' },
          { label: 'Còn thiếu cột', value: 'total (nằm ở Heap)' },
        ],
        logs: [{ id: 'pg1', text: "Index Leaf tìm thấy an@.. → lấy ctid = (page 3, slot 2)." }],
        newLogId: 'pg1',
        levels: [
          [{ id: 'root', label: 'idx_email Root', kind: 'root', keys: ['chi@..'], visited: true }],
          [
            { id: 'la', label: 'Leaf A', kind: 'leaf', keys: ['an@.. → (3,2)', 'binh@.. → (1,4)'], active: true },
            { id: 'lb', label: 'Leaf B', kind: 'leaf', keys: ['chi@.. → (2,1)', 'dung@.. → (3,1)'], dim: true },
          ],
        ],
        edges: [
          { from: 'root', to: 'la', label: '< chi', branchIndex: 0, active: true },
          { from: 'root', to: 'lb', label: '≥ chi', branchIndex: 1 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }],
        keyStates: { la: { 'an@.. → (3,2)': 'matched' } },
        storage: {
          dividerText: '↓ Nhảy trực tiếp theo địa chỉ vật lý ctid (3, 2) xuống Heap Table',
          dividerActive: false,
          pages: [
            { id: 'hp1', title: 'Heap Page 1', dim: true, rows: [{ id: 'r1', text: '(1,4) binh@.. | 400k' }] },
            { id: 'hp2', title: 'Heap Page 2', dim: true, rows: [{ id: 'r2', text: '(2,1) chi@.. | 210k' }] },
            { id: 'hp3', title: 'Heap Page 3', rows: [{ id: 'r3', text: '(3,1) dung@.. | 180k' }, { id: 'r4', text: '(3,2) an@.. | 950k' }] },
          ],
        },
      },
      {
        phase: 'Bước 2 — Heap Fetch',
        action: 'Đọc thẳng Heap Page 3, slot 2 để lấy cột total = 950k',
        note: 'Chi phí chỉ là 1 lần nhảy thẳng O(1) tới Heap page theo ctid (không phải duyệt thêm cây thứ 2 như InnoDB secondary index).',
        query: "SELECT email, total FROM orders WHERE email = 'an@..';",
        gate: { text: 'Heap Fetch O(1) theo ctid (3, 2) thành công', tone: 'ok' },
        metrics: [
          { label: 'Index page', value: '2' },
          { label: 'Heap Fetch', value: '1 page' },
        ],
        stats: [
          { label: 'Tổng page đọc', value: '3 (2 Index + 1 Heap)' },
          { label: 'Độ phức tạp nhảy', value: '1 bước thẳng (CTID)' },
        ],
        logs: [
          { id: 'pg1', text: "Index Leaf tìm thấy an@.. → lấy ctid = (page 3, slot 2)." },
          { id: 'pg2', text: 'Nhảy thẳng tới Heap Page 3 slot 2 → lấy total = 950k và kiểm tra MVCC visibility.' },
        ],
        newLogId: 'pg2',
        levels: [
          [{ id: 'root', label: 'idx_email Root', kind: 'root', keys: ['chi@..'], visited: true }],
          [
            { id: 'la', label: 'Leaf A', kind: 'leaf', keys: ['an@.. → (3,2)', 'binh@.. → (1,4)'], visited: true },
            { id: 'lb', label: 'Leaf B', kind: 'leaf', keys: ['chi@.. → (2,1)', 'dung@.. → (3,1)'], dim: true },
          ],
        ],
        edges: [
          { from: 'root', to: 'la', label: '< chi', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '≥ chi', branchIndex: 1 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }],
        keyStates: { la: { 'an@.. → (3,2)': 'matched' } },
        storage: {
          dividerText: '↓ Heap Fetch thẳng tới Page 3, Slot 2',
          dividerActive: true,
          pages: [
            { id: 'hp1', title: 'Heap Page 1', dim: true, rows: [{ id: 'r1', text: '(1,4) binh@.. | 400k' }] },
            { id: 'hp2', title: 'Heap Page 2', dim: true, rows: [{ id: 'r2', text: '(2,1) chi@.. | 210k' }] },
            { id: 'hp3', title: 'Heap Page 3', active: true, badge: 'HIT', rows: [{ id: 'r3', text: '(3,1) dung@.. | 180k' }, { id: 'r4', text: '(3,2) an@.. | 950k', matched: true }] },
          ],
        },
      },
    ],
  },
  {
    id: 'innodb-double',
    label: 'InnoDB Secondary (Double Lookup)',
    frames: [
      {
        phase: 'Cây #1 — Secondary Index',
        action: "Duyệt idx_email tìm 'an@..' → chỉ lấy được Primary Key (id = 42)",
        note: 'Secondary Index trong InnoDB KHÔNG lưu địa chỉ vật lý mà lưu giá trị Primary Key (để tránh sửa mọi secondary index khi clustered page split).',
        query: "SELECT email, total FROM orders WHERE email = 'an@..';  -- InnoDB Secondary",
        gate: { text: 'Lấy được PK = 42 (chưa có cột total)', tone: 'warn' },
        metrics: [
          { label: 'Cây đã duyệt', value: '1 / 2 cây' },
          { label: 'Tổng page đọc', value: '2' },
        ],
        stats: [
          { label: 'Bước 1', value: 'idx_email → PK = 42' },
          { label: 'Bước 2', value: 'Phải tra tiếp cây PK', tone: 'warn' },
        ],
        logs: [{ id: 'in1', text: "Duyệt cây Secondary idx_email → tìm thấy an@.. trỏ tới PK id = 42." }],
        newLogId: 'in1',
        levels: [
          [{ id: 'root', label: 'Secondary Root (email)', kind: 'root', keys: ['chi@..'], visited: true }],
          [
            { id: 'la', label: 'Sec Leaf A', kind: 'leaf', keys: ['an@.. → PK:42', 'binh@.. → PK:15'], active: true },
            { id: 'lb', label: 'Sec Leaf B', kind: 'leaf', keys: ['chi@.. → PK:60', 'dung@.. → PK:75'], dim: true },
          ],
        ],
        edges: [
          { from: 'root', to: 'la', label: '< chi', branchIndex: 0, active: true },
          { from: 'root', to: 'lb', label: '≥ chi', branchIndex: 1 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }],
        keyStates: { la: { 'an@.. → PK:42': 'matched' } },
        storage: {
          dividerText: '↓ Double Lookup: dùng PK = 42 duyệt tiếp Cây #2 (Clustered Primary Key)',
          dividerActive: false,
          pages: [
            { id: 'pk-r', title: 'Clustered Root (id)', rows: [{ id: 'r0', text: '30 | 60 → chọn nhánh 30..59' }] },
            { id: 'pk-a', title: 'PK Leaf A (<30)', dim: true, rows: [{ id: 'r1', text: 'id=15 | binh@.. | 400k' }] },
            { id: 'pk-b', title: 'PK Leaf B (30..59)', rows: [{ id: 'r2', text: 'id=42 | an@.. | 950k' }] },
          ],
        },
      },
      {
        phase: 'Cây #2 — Clustered PK Lookup',
        action: 'Đi từ Root xuống Leaf B của Clustered Index để lấy toàn bộ row id = 42',
        note: 'Đây gọi là Bookmark Lookup / Double Lookup: phải đi qua 2 cây B+Tree. Vì vậy PK quá dài (như UUID 16B) làm phình toàn bộ secondary index.',
        query: "SELECT email, total FROM orders WHERE email = 'an@..';",
        gate: { text: 'Hoàn tất Double Lookup (2 cây B+Tree)', tone: 'warn' },
        metrics: [
          { label: 'Cây đã duyệt', value: '2 cây', warn: true },
          { label: 'Tổng page đọc', value: '4 page', warn: true },
        ],
        stats: [
          { label: 'Cây #1 (Secondary)', value: '2 page → PK = 42' },
          { label: 'Cây #2 (Clustered)', value: '2 page → total = 950k', tone: 'warn' },
        ],
        logs: [
          { id: 'in1', text: "Duyệt cây Secondary idx_email → tìm thấy an@.. trỏ tới PK id = 42." },
          { id: 'in2', text: 'Duyệt tiếp Clustered Root → PK Leaf B lấy row id=42 (total=950k). Tổng 4 page!', tone: 'warn' },
        ],
        newLogId: 'in2',
        levels: [
          [{ id: 'root', label: 'Secondary Root (email)', kind: 'root', keys: ['chi@..'], visited: true }],
          [
            { id: 'la', label: 'Sec Leaf A', kind: 'leaf', keys: ['an@.. → PK:42', 'binh@.. → PK:15'], visited: true },
            { id: 'lb', label: 'Sec Leaf B', kind: 'leaf', keys: ['chi@.. → PK:60', 'dung@.. → PK:75'], dim: true },
          ],
        ],
        edges: [
          { from: 'root', to: 'la', label: '< chi', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '≥ chi', branchIndex: 1 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }],
        keyStates: { la: { 'an@.. → PK:42': 'matched' } },
        storage: {
          dividerText: '↓ Double Lookup đang duyệt Cây Clustered PK với id = 42',
          dividerActive: true,
          pages: [
            { id: 'pk-r', title: 'Clustered Root (id)', active: true, badge: 'ĐỌC #3', rows: [{ id: 'r0', text: '30 ≤ 42 < 60 → PK Leaf B' }] },
            { id: 'pk-a', title: 'PK Leaf A (<30)', dim: true, rows: [{ id: 'r1', text: 'id=15 | binh@.. | 400k' }] },
            { id: 'pk-b', title: 'PK Leaf B (30..59)', active: true, badge: 'ĐỌC #4', rows: [{ id: 'r2', text: 'id=42 | an@.. | 950k', matched: true }] },
          ],
        },
      },
    ],
  },
  {
    id: 'covering',
    label: 'Covering Index (Index-Only Scan)',
    frames: [
      {
        phase: 'Index-Only Scan',
        action: 'Index (email) INCLUDE (total) đã chứa sẵn mọi cột cần SELECT',
        note: 'Database trả thẳng kết quả từ Leaf A mà KHÔNG nhảy xuống Heap (Postgres) hay Cây Clustered PK (InnoDB).',
        query: "SELECT email, total FROM orders WHERE email = 'an@..';  -- idx(email) INCLUDE(total)",
        gate: { text: '0 Table/Heap Fetch • Index-Only Scan!', tone: 'ok' },
        metrics: [
          { label: 'Index page', value: '2' },
          { label: 'Table/Heap Jump', value: '0 lần' },
        ],
        stats: [
          { label: 'Chiến lược', value: 'Index-Only Scan' },
          { label: 'Tiết kiệm', value: 'Bỏ hoàn toàn bước nhảy' },
        ],
        logs: [{ id: 'cv1', text: 'Leaf A có sẵn cả email lẫn total = 950k → trả kết quả ngay, bỏ qua hoàn toàn Heap/Table.' }],
        newLogId: 'cv1',
        levels: [
          [{ id: 'root', label: 'Covering Root (email)', kind: 'root', keys: ['chi@..'], visited: true }],
          [
            { id: 'la', label: 'Leaf A (+total)', kind: 'leaf', keys: ['an@.. | 950k', 'binh@.. | 400k'], active: true, badge: 'ĐỦ CỘT' },
            { id: 'lb', label: 'Leaf B (+total)', kind: 'leaf', keys: ['chi@.. | 210k', 'dung@.. | 180k'], dim: true },
          ],
        ],
        edges: [
          { from: 'root', to: 'la', label: '< chi', branchIndex: 0, active: true },
          { from: 'root', to: 'lb', label: '≥ chi', branchIndex: 1 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }],
        keyStates: { la: { 'an@.. | 950k': 'matched' } },
        storage: {
          dividerText: '✕ Bỏ qua hoàn toàn bước đọc Heap / Clustered Table (0 Random I/O)',
          dividerSkip: true,
          pages: [
            { id: 'hp1', title: 'Heap / Table Page 1', dim: true, rows: [{ id: 'r1', text: 'Không cần chạm tới' }] },
            { id: 'hp2', title: 'Heap / Table Page 2', dim: true, rows: [{ id: 'r2', text: 'Không cần chạm tới' }] },
            { id: 'hp3', title: 'Heap / Table Page 3', dim: true, rows: [{ id: 'r3', text: 'Không cần chạm tới' }] },
          ],
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 4. LIKE, Pattern Search & B-Tree
// ---------------------------------------------------------------------------
function likeLevels(overrides: Partial<Record<'root' | 'la' | 'lb' | 'lc', Partial<ExtTreeNode>>> = {}): ExtTreeNode[][] {
  return [
    [{ id: 'root', label: 'Root idx_title', kind: 'root', keys: ['SQL', 'Web'], ...overrides.root }],
    [
      { id: 'la', label: 'Leaf A', kind: 'leaf', keys: ['Go', 'Java', 'Rust'], rangeHint: '< SQL', ...overrides.la },
      { id: 'lb', label: 'Leaf B', kind: 'leaf', keys: ['SQL-101', 'SQL-DB', 'SQL-Tuning'], rangeHint: 'SQL..Web', ...overrides.lb },
      { id: 'lc', label: 'Leaf C', kind: 'leaf', keys: ['SQLite', 'Web-SQL', 'Zig'], rangeHint: '≥ Web', ...overrides.lc },
    ],
  ];
}

export const likePatternModes: WorkbenchMode<ExtTreeFrame>[] = [
  {
    id: 'prefix',
    label: "LIKE 'SQL%' (Range Scan)",
    frames: [
      {
        phase: 'Biến đổi thành Range',
        action: "Optimizer viết lại LIKE 'SQL%' thành title >= 'SQL' AND title < 'SQM'",
        note: 'Vì có tiền tố cố định ở đầu, B+Tree tính được ngay start_key = SQL và nhảy thẳng xuống Leaf B, bỏ qua Leaf A.',
        query: "SELECT title FROM courses WHERE title LIKE 'SQL%';  -- Range ['SQL', 'SQM')",
        gate: { text: "start_key = 'SQL' • end_key = 'SQM'", tone: 'ok' },
        metrics: [
          { label: 'Leaf đã đọc', value: '0' },
          { label: 'Khớp', value: '0' },
        ],
        stats: [
          { label: 'Access Cond', value: "title >= 'SQL' AND < 'SQM'" },
          { label: 'Filter Cond', value: 'Không cần' },
        ],
        logs: [{ id: 'lk1', text: "Root so sánh 'SQL' → chọn nhánh giữa (Leaf B), bỏ qua Leaf A." }],
        newLogId: 'lk1',
        levels: likeLevels({ root: { active: true }, la: { dim: true } }),
        edges: [
          { from: 'root', to: 'la', label: '< SQL', branchIndex: 0 },
          { from: 'root', to: 'lb', label: 'SQL..Web', branchIndex: 1, active: true },
          { from: 'root', to: 'lc', label: '≥ Web', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: { root: { SQL: 'comparing' } },
      },
      {
        phase: 'Trượt Sibling & Dừng sớm',
        action: 'Nhặt 3 key ở Leaf B → trượt sang Leaf C lấy SQLite → dừng ngay tại Web-SQL',
        note: "Gặp 'Web-SQL' ≥ 'SQM', database dừng lập tức mà không đọc tới 'Zig'.",
        query: "SELECT title FROM courses WHERE title LIKE 'SQL%';",
        gate: { text: "Dừng ngay tại 'Web-SQL' ≥ 'SQM' • 4 khớp", tone: 'ok' },
        metrics: [
          { label: 'Leaf đã đọc', value: '2 / 3' },
          { label: 'Khớp', value: '4' },
        ],
        stats: [
          { label: 'Entry đã quét', value: '5 / 9 entry' },
          { label: 'Kết quả', value: '4 khớp (0 bị lọc)' },
        ],
        logs: [
          { id: 'lk1', text: "Root so sánh 'SQL' → chọn nhánh giữa (Leaf B), bỏ qua Leaf A." },
          { id: 'lk2', text: "Leaf B khớp SQL-101, SQL-DB, SQL-Tuning → sang Leaf C khớp SQLite → gặp Web-SQL DỪNG." },
        ],
        newLogId: 'lk2',
        levels: likeLevels({ root: { visited: true }, la: { dim: true }, lb: { visited: true }, lc: { active: true } }),
        edges: [
          { from: 'root', to: 'la', label: '< SQL', branchIndex: 0 },
          { from: 'root', to: 'lb', label: 'SQL..Web', branchIndex: 1, active: true },
          { from: 'root', to: 'lc', label: '≥ Web', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc', active: true }],
        keyStates: {
          lb: { 'SQL-101': 'matched', 'SQL-DB': 'matched', 'SQL-Tuning': 'matched' },
          lc: { SQLite: 'matched', 'Web-SQL': 'stopped' },
        },
      },
    ],
  },
  {
    id: 'leading',
    label: "LIKE '%SQL%' (Leading Wildcard)",
    frames: [
      {
        phase: 'Không có Start Key',
        action: "Dấu '%' đứng đầu phá hủy thứ tự từ điển của B+Tree",
        note: "'Web-SQL' nằm ở Leaf C, còn 'SQL-101' ở Leaf B. Không biết ký tự đầu là gì nên Root không thể loại bất kỳ nhánh nào.",
        query: "SELECT title FROM courses WHERE title LIKE '%SQL%';  -- Không có prefix",
        gate: { text: 'Không tính được start_key → Quét toàn bảng/cây', tone: 'bad' },
        metrics: [
          { label: 'Leaf đã đọc', value: '3 / 3', warn: true },
          { label: 'Bị Filter bỏ', value: '4', warn: true },
        ],
        stats: [
          { label: 'Access Cond', value: 'Không có', tone: 'warn' },
          { label: 'Giải pháp đúng', value: 'pg_trgm (GIN) / FTS' },
        ],
        logs: [{ id: 'lw1', text: "Leading '%' buộc đọc trọn 9/9 entry từ Leaf A tới Leaf C rồi so chuỗi từng dòng.", tone: 'warn' }],
        newLogId: 'lw1',
        levels: likeLevels({ root: { full: true }, la: { active: true }, lb: { active: true }, lc: { active: true } }),
        edges: [
          { from: 'root', to: 'la', label: '?', branchIndex: 0, dashed: true },
          { from: 'root', to: 'lb', label: '?', branchIndex: 1, dashed: true },
          { from: 'root', to: 'lc', label: '?', branchIndex: 2, dashed: true },
        ],
        siblingLinks: [{ from: 'la', to: 'lb', active: true }, { from: 'lb', to: 'lc', active: true }],
        keyStates: {
          la: { Go: 'filtered', Java: 'filtered', Rust: 'filtered' },
          lb: { 'SQL-101': 'matched', 'SQL-DB': 'matched', 'SQL-Tuning': 'matched' },
          lc: { SQLite: 'matched', 'Web-SQL': 'matched', Zig: 'filtered' },
        },
      },
    ],
  },
  {
    id: 'access-filter',
    label: "LIKE 'SQL%DB' (Access + Filter)",
    frames: [
      {
        phase: 'Access trên prefix + Filter đuôi',
        action: "Dùng 'SQL%' để thu hẹp khoảng, rồi lọc hậu tố 'DB' trên từng entry",
        note: "Prefix 'SQL' giúp bỏ qua Leaf A, nhưng DB vẫn phải đọc toàn bộ 4 dòng bắt đầu bằng 'SQL' và loại 3 dòng không kết thúc bằng 'DB'.",
        query: "SELECT title FROM courses WHERE title LIKE 'SQL%DB';",
        gate: { text: "Access: 'SQL%' • Filter: '%DB' (bỏ 3/4)", tone: 'warn' },
        metrics: [
          { label: 'Đọc trong khoảng', value: '4' },
          { label: 'Bị Filter bỏ', value: '3', warn: true },
          { label: 'Khớp', value: '1' },
        ],
        stats: [
          { label: 'Access Cond', value: "['SQL', 'SQM')" },
          { label: 'Filter Cond', value: "đuôi 'DB' (bỏ 3 dòng)", tone: 'warn' },
        ],
        logs: [{ id: 'af1', text: "Seek 'SQL' vào Leaf B → đọc 4 entry SQL*, chỉ giữ SQL-DB, loại SQL-101, SQL-Tuning, SQLite." }],
        newLogId: 'af1',
        levels: likeLevels({ root: { visited: true }, la: { dim: true }, lb: { active: true }, lc: { active: true } }),
        edges: [
          { from: 'root', to: 'la', label: '< SQL', branchIndex: 0 },
          { from: 'root', to: 'lb', label: 'SQL..Web', branchIndex: 1, active: true },
          { from: 'root', to: 'lc', label: '≥ Web', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc', active: true }],
        keyStates: {
          lb: { 'SQL-101': 'filtered', 'SQL-DB': 'matched', 'SQL-Tuning': 'filtered' },
          lc: { SQLite: 'filtered', 'Web-SQL': 'stopped' },
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 5. OFFSET Pagination vs Keyset (Seek) Pagination
// ---------------------------------------------------------------------------
function paginationLevels(overrides: Partial<Record<'root' | 'la' | 'lb' | 'lc', Partial<ExtTreeNode>>> = {}): ExtTreeNode[][] {
  return [
    [{ id: 'root', label: 'Root idx_id', kind: 'root', keys: ['30', '50'], ...overrides.root }],
    [
      { id: 'la', label: 'Leaf 1', kind: 'leaf', keys: ['10', '15', '20', '25'], rangeHint: '< 30', ...overrides.la },
      { id: 'lb', label: 'Leaf 2', kind: 'leaf', keys: ['30', '35', '40', '45'], rangeHint: '30..49', ...overrides.lb },
      { id: 'lc', label: 'Leaf 3', kind: 'leaf', keys: ['50', '55', '60', '65'], rangeHint: '≥ 50', ...overrides.lc },
    ],
  ];
}

export const offsetPaginationModes: WorkbenchMode<ExtTreeFrame>[] = [
  {
    id: 'offset',
    label: 'OFFSET 8 LIMIT 3 (Quét rồi vứt)',
    frames: [
      {
        phase: 'Bắt đầu từ đầu Leaf',
        action: 'OFFSET không nhảy cóc được — phải đi tới Leaf 1 để đếm từ dòng #1',
        note: 'Database không biết dòng thứ 9 có id bao nhiêu nếu chưa đếm qua 8 dòng đứng trước nó.',
        query: 'SELECT id FROM events ORDER BY id ASC LIMIT 3 OFFSET 8;',
        gate: { text: 'Chi phí O(OFFSET + LIMIT) = O(8 + 3)', tone: 'warn' },
        metrics: [
          { label: 'Đã đọc', value: '0 dòng' },
          { label: 'Vứt bỏ', value: '0 dòng' },
          { label: 'Trả về', value: '0 / 3' },
        ],
        stats: [
          { label: 'Leaf đã đọc', value: '1 (Leaf 1)' },
          { label: 'Đã vứt bỏ', value: '0 / 8' },
        ],
        logs: [{ id: 'o1', text: 'Đi xuống Leaf 1 để bắt đầu đếm và bỏ qua 8 dòng đầu tiên.' }],
        newLogId: 'o1',
        levels: paginationLevels({ root: { active: true }, la: { active: true } }),
        edges: [
          { from: 'root', to: 'la', label: 'Đầu cây', branchIndex: 0, active: true },
          { from: 'root', to: 'lb', label: '30..49', branchIndex: 1 },
          { from: 'root', to: 'lc', label: '≥ 50', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
      },
      {
        phase: 'Đọc & Vứt Leaf 1–2',
        action: 'Đọc qua trọn Leaf 1 và Leaf 2 rồi vứt sạch cả 8 dòng (10..45)',
        note: 'Tốn I/O và CPU đọc 2 page đầu chỉ để đếm đủ OFFSET = 8 rồi bỏ đi không dùng.',
        query: 'SELECT id FROM events ORDER BY id ASC LIMIT 3 OFFSET 8;',
        gate: { text: 'Đã đọc và vứt bỏ 8 dòng (Leaf 1 & Leaf 2)', tone: 'bad' },
        metrics: [
          { label: 'Đã đọc', value: '8 dòng', warn: true },
          { label: 'Vứt bỏ', value: '8 dòng', warn: true },
          { label: 'Trả về', value: '0 / 3' },
        ],
        stats: [
          { label: 'Leaf đã đọc', value: '2 (Leaf 1, 2)', tone: 'warn' },
          { label: 'Đã vứt bỏ', value: '8 / 8 dòng', tone: 'warn' },
        ],
        logs: [
          { id: 'o1', text: 'Đi xuống Leaf 1 để bắt đầu đếm và bỏ qua 8 dòng đầu tiên.' },
          { id: 'o2', text: 'Đọc & vứt 10, 15, 20, 25 (Leaf 1) → trượt sang Leaf 2 vứt tiếp 30, 35, 40, 45.', tone: 'warn' },
        ],
        newLogId: 'o2',
        levels: paginationLevels({ root: { visited: true }, la: { visited: true }, lb: { active: true } }),
        edges: [
          { from: 'root', to: 'la', label: 'Đầu cây', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '30..49', branchIndex: 1 },
          { from: 'root', to: 'lc', label: '≥ 50', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb', active: true }, { from: 'lb', to: 'lc' }],
        keyStates: {
          la: { '10': 'discarded', '15': 'discarded', '20': 'discarded', '25': 'discarded' },
          lb: { '30': 'discarded', '35': 'discarded', '40': 'discarded', '45': 'discarded' },
        },
      },
      {
        phase: 'Lấy 3 dòng ở Leaf 3',
        action: 'Tới Leaf 3 mới nhặt 50, 55, 60 — tổng cộng đọc 11 dòng để lấy 3',
        note: 'Ở trang 50.000 (OFFSET 1.000.000), database phải đọc và vứt bỏ 1.000.000 dòng trước khi trả về 20 dòng!',
        query: 'SELECT id FROM events ORDER BY id ASC LIMIT 3 OFFSET 8;',
        gate: { text: 'Đọc 11 dòng • Vứt 8 dòng (73% công vô ích)', tone: 'bad' },
        metrics: [
          { label: 'Đã đọc', value: '11 dòng', warn: true },
          { label: 'Vứt bỏ', value: '8 dòng', warn: true },
          { label: 'Trả về', value: '3 / 3' },
        ],
        stats: [
          { label: 'Tổng page đọc', value: '4 page (Root + 3 Leaf)', tone: 'warn' },
          { label: 'Tỉ lệ lãng phí', value: '8 / 11 dòng bị vứt', tone: 'warn' },
        ],
        logs: [
          { id: 'o1', text: 'Đi xuống Leaf 1 để bắt đầu đếm và bỏ qua 8 dòng đầu tiên.' },
          { id: 'o2', text: 'Đọc & vứt 10, 15, 20, 25 (Leaf 1) → trượt sang Leaf 2 vứt tiếp 30, 35, 40, 45.', tone: 'warn' },
          { id: 'o3', text: 'Tới Leaf 3 mới lấy được 50, 55, 60. Càng lật sâu, số leaf bị vứt tăng tuyến tính.' },
        ],
        newLogId: 'o3',
        levels: paginationLevels({ root: { visited: true }, la: { visited: true }, lb: { visited: true }, lc: { active: true } }),
        edges: [
          { from: 'root', to: 'la', label: 'Đầu cây', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '30..49', branchIndex: 1 },
          { from: 'root', to: 'lc', label: '≥ 50', branchIndex: 2 },
        ],
        siblingLinks: [{ from: 'la', to: 'lb', active: true }, { from: 'lb', to: 'lc', active: true }],
        keyStates: {
          la: { '10': 'discarded', '15': 'discarded', '20': 'discarded', '25': 'discarded' },
          lb: { '30': 'discarded', '35': 'discarded', '40': 'discarded', '45': 'discarded' },
          lc: { '50': 'matched', '55': 'matched', '60': 'matched' },
        },
      },
    ],
  },
  {
    id: 'keyset',
    label: 'Keyset / Seek (WHERE id > 45 LIMIT 3)',
    frames: [
      {
        phase: 'Seek thẳng theo Cursor',
        action: 'Dùng mốc id > 45 → Root nhảy thẳng xuống Leaf 3, bỏ qua Leaf 1 & Leaf 2',
        note: 'Keyset pagination biến "đếm bỏ qua" thành B+Tree Seek O(log N) bất kể bạn đang ở trang 1 hay trang 50.000.',
        query: 'SELECT id FROM events WHERE id > 45 ORDER BY id ASC LIMIT 3;',
        gate: { text: 'Seek trực tiếp vào Leaf 3 • Bỏ qua 2 Leaf đầu', tone: 'ok' },
        metrics: [
          { label: 'Đã đọc', value: '0 dòng' },
          { label: 'Vứt bỏ', value: '0 dòng' },
          { label: 'Trả về', value: '0 / 3' },
        ],
        stats: [
          { label: 'Leaf bỏ qua', value: 'Leaf 1, Leaf 2 (0 đọc)' },
          { label: 'Chi phí', value: 'O(log N + LIMIT)' },
        ],
        logs: [{ id: 'k1', text: 'Root so sánh cursor 45 → nhảy thẳng tới vùng ≥ 50 (Leaf 3).' }],
        newLogId: 'k1',
        levels: paginationLevels({ root: { active: true }, la: { dim: true }, lb: { dim: true } }),
        edges: [
          { from: 'root', to: 'la', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '30..49', branchIndex: 1 },
          { from: 'root', to: 'lc', label: '≥ 50', branchIndex: 2, active: true },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: { root: { '50': 'comparing' } },
      },
      {
        phase: 'Nhặt ngay 3 dòng',
        action: 'Lấy ngay 50, 55, 60 và dừng — 0 dòng bị vứt bỏ!',
        note: 'Hiệu năng ổn định như nhau ở mọi độ sâu trang, đồng thời không bị lệch/lặp dòng khi có dữ liệu mới chèn vào đầu bảng.',
        query: 'SELECT id FROM events WHERE id > 45 ORDER BY id ASC LIMIT 3;',
        gate: { text: 'Đọc 3 dòng • Vứt 0 dòng • 2 page tổng cộng', tone: 'ok' },
        metrics: [
          { label: 'Đã đọc', value: '3 dòng' },
          { label: 'Vứt bỏ', value: '0 dòng' },
          { label: 'Trả về', value: '3 / 3' },
        ],
        stats: [
          { label: 'Tổng page đọc', value: '2 page (Root + Leaf 3)' },
          { label: 'Tỉ lệ lãng phí', value: '0%' },
        ],
        logs: [
          { id: 'k1', text: 'Root so sánh cursor 45 → nhảy thẳng tới vùng ≥ 50 (Leaf 3).' },
          { id: 'k2', text: 'Nhặt ngay 50, 55, 60 rồi dừng. Tốc độ trang 50.000 nhanh ngang trang 1!' },
        ],
        newLogId: 'k2',
        levels: paginationLevels({ root: { visited: true }, la: { dim: true }, lb: { dim: true }, lc: { active: true } }),
        edges: [
          { from: 'root', to: 'la', label: '< 30', branchIndex: 0 },
          { from: 'root', to: 'lb', label: '30..49', branchIndex: 1 },
          { from: 'root', to: 'lc', label: '≥ 50', branchIndex: 2, active: true },
        ],
        siblingLinks: [{ from: 'la', to: 'lb' }, { from: 'lb', to: 'lc' }],
        keyStates: { lc: { '50': 'matched', '55': 'matched', '60': 'matched' } },
      },
    ],
  },
];
