export type NodeKind = 'root' | 'internal' | 'leaf';

export type TreeNode = {
  id: string;
  label: string;
  kind: NodeKind;
  keys: number[];
  capacity?: number;
  rangeHint?: string;
  badge?: string;
  active?: boolean;
  visited?: boolean;
  full?: boolean;
  isNew?: boolean;
  pendingParent?: boolean;
};

export type TreeEdge = {
  from: string;
  to: string;
  label?: string;
  active?: boolean;
  dashed?: boolean;
  /** Which branch slot on the parent node (0..parent.keys.length). */
  branchIndex: number;
};

export type SiblingLink = {
  from: string;
  to: string;
  active?: boolean;
  isNew?: boolean;
};

export type ResultItem = {
  key: number;
  detail: string;
};

export type ChangeItem = {
  id: string;
  text: string;
};

export type FlyMove = {
  fromAttr: string;
  toAttr: string;
};

export type Frame = {
  phase: string;
  action: string;
  note: string;
  query: string;
  gate?: { text: string; tone?: 'ok' | 'miss' | 'warn' };
  incoming?: { key: number; label: string; tone?: 'insert' | 'promote' };
  levels: TreeNode[][];
  edges: TreeEdge[];
  siblingLinks: SiblingLink[];
  comparingKeys?: Record<string, number[]>;
  matchedKeys?: Record<string, number[]>;
  stoppedKeys?: Record<string, number[]>;
  newKeys?: Record<string, number[]>;
  pagesRead?: string[];
  results?: ResultItem[];
  newResultKey?: number;
  changes?: ChangeItem[];
  newChangeId?: string;
  height: number;
  leafCount: number;
  splits?: number;
  flyMoves?: FlyMove[];
  /** Map newly created nodeId -> origin nodeId from the previous frame so split nodes glide out smoothly. */
  spawnFrom?: Record<string, string>;
};

function baseSearchLevels(overrides: Partial<Record<'root' | 'leaf-a' | 'leaf-b' | 'leaf-c', Partial<TreeNode>>> = {}): TreeNode[][] {
  const root: TreeNode = {
    id: 'root', label: 'Root', kind: 'root', keys: [30, 60], ...overrides.root,
  };
  const leafA: TreeNode = {
    id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [5, 10, 20], rangeHint: '< 30', ...overrides['leaf-a'],
  };
  const leafB: TreeNode = {
    id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30, 42, 55], rangeHint: '30..59', ...overrides['leaf-b'],
  };
  const leafC: TreeNode = {
    id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75, 90], rangeHint: '≥ 60', ...overrides['leaf-c'],
  };
  return [[root], [leafA, leafB, leafC]];
}

function baseThreeEdges(activeTo?: string): TreeEdge[] {
  return [
    { from: 'root', to: 'leaf-a', label: '< 30', branchIndex: 0, active: activeTo === 'leaf-a' },
    { from: 'root', to: 'leaf-b', label: '30..59', branchIndex: 1, active: activeTo === 'leaf-b' },
    { from: 'root', to: 'leaf-c', label: '≥ 60', branchIndex: 2, active: activeTo === 'leaf-c' },
  ];
}

function baseThreeSiblings(activePair?: [string, string]): SiblingLink[] {
  return [
    { from: 'leaf-a', to: 'leaf-b', active: activePair?.[0] === 'leaf-a' && activePair?.[1] === 'leaf-b' },
    { from: 'leaf-b', to: 'leaf-c', active: activePair?.[0] === 'leaf-b' && activePair?.[1] === 'leaf-c' },
  ];
}

const exactTrace: Frame[] = [
  {
    phase: 'SẴN SÀNG',
    action: 'Tìm user có id = 42',
    note: 'Bấm Bước sau để đi từ Root xuống đúng leaf thay vì quét từ đầu bảng.',
    query: 'SELECT * FROM users WHERE id = 42;',
    levels: baseSearchLevels(),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(),
    pagesRead: [],
    results: [],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'ĐỌC ROOT',
    action: 'So sánh 42 với separator 30 và 60',
    note: '42 ≥ 30 và 42 < 60, nên chỉ cần đi theo nhánh giữa tới Leaf B. Bỏ qua Leaf A và Leaf C.',
    query: 'SELECT * FROM users WHERE id = 42;',
    gate: { text: '30 ≤ 42 < 60 · nhánh giữa', tone: 'ok' },
    levels: baseSearchLevels({ root: { active: true, badge: 'ĐANG ĐỌC' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { root: [30, 60] },
    pagesRead: ['Root'],
    results: [],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'CHỌN NHÁNH',
    action: 'Đi xuống Leaf B [30, 42, 55]',
    note: 'Đọc trang Leaf B. Các key trong leaf luôn được giữ theo thứ tự tăng dần.',
    query: 'SELECT * FROM users WHERE id = 42;',
    gate: { text: 'Root → Leaf B', tone: 'ok' },
    levels: baseSearchLevels({ root: { visited: true }, 'leaf-b': { active: true, badge: 'ĐANG ĐỌC' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    pagesRead: ['Root', 'Leaf B'],
    results: [],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'KIỂM TRA LEAF',
    action: 'So sánh 30 với 42 trong Leaf B',
    note: '30 < 42 nên tiếp tục kiểm tra entry kế tiếp trong Leaf B.',
    query: 'SELECT * FROM users WHERE id = 42;',
    gate: { text: '30 < 42 · đi tiếp', tone: 'miss' },
    levels: baseSearchLevels({ root: { visited: true }, 'leaf-b': { active: true, badge: 'ĐANG ĐỌC' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { 'leaf-b': [30] },
    pagesRead: ['Root', 'Leaf B'],
    results: [],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'TÌM THẤY',
    action: 'Khớp key 42 → lấy row locator',
    note: 'Entry 42 trong Leaf B chứa thông tin trỏ tới row thật của user 42 (TID ở PostgreSQL hoặc dữ liệu row ở PK InnoDB).',
    query: 'SELECT * FROM users WHERE id = 42;',
    gate: { text: '42 = 42 · Khớp', tone: 'ok' },
    levels: baseSearchLevels({ root: { visited: true }, 'leaf-b': { active: true, badge: 'KHỚP' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    matchedKeys: { 'leaf-b': [42] },
    pagesRead: ['Root', 'Leaf B'],
    results: [{ key: 42, detail: 'Row locator → user #42' }],
    newResultKey: 42,
    flyMoves: [{ fromAttr: '[data-key-id="leaf-b:42"]', toAttr: '[data-result-key="42"]' }],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'HOÀN TẤT',
    action: 'Hoàn tất sau 2 page index',
    note: 'Chỉ đọc Root và Leaf B, không chạm tới Leaf A hay Leaf C. Nếu Root đã nằm trong cache, chỉ cần đọc Leaf B và data page.',
    query: 'SELECT * FROM users WHERE id = 42;',
    gate: { text: '2 page index đã đọc', tone: 'ok' },
    levels: baseSearchLevels({ root: { visited: true }, 'leaf-b': { visited: true } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    matchedKeys: { 'leaf-b': [42] },
    pagesRead: ['Root', 'Leaf B'],
    results: [{ key: 42, detail: 'Row locator → user #42' }],
    height: 2,
    leafCount: 3,
  },
];

const rangeTrace: Frame[] = [
  {
    phase: 'SẴN SÀNG',
    action: 'Quét khoảng 35 ≤ id ≤ 75',
    note: 'Range scan gồm 2 pha: đi từ Root xuống điểm bắt đầu (≥ 35), sau đó đi ngang qua sibling link tới khi vượt 75.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    levels: baseSearchLevels(),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(),
    pagesRead: [],
    results: [],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'PHA 1 · ĐỌC ROOT',
    action: 'Tìm điểm bắt đầu cho cận dưới 35',
    note: '35 nằm trong khoảng [30, 60), nên điểm bắt đầu của range nằm ở Leaf B.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '30 ≤ 35 < 60 · vào Leaf B', tone: 'ok' },
    levels: baseSearchLevels({ root: { active: true, badge: 'ĐANG ĐỌC' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { root: [30, 60] },
    pagesRead: ['Root'],
    results: [],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'PHA 1 · ĐIỂM BẮT ĐẦU',
    action: 'Vào Leaf B, bỏ qua 30 vì 30 < 35',
    note: 'Database chỉ đi từ Root xuống một lần duy nhất cho cả câu BETWEEN.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '30 < 35 · bỏ qua', tone: 'miss' },
    levels: baseSearchLevels({ root: { visited: true }, 'leaf-b': { active: true, badge: 'ĐANG ĐỌC' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { 'leaf-b': [30] },
    pagesRead: ['Root', 'Leaf B'],
    results: [],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'PHA 2 · LẤY ENTRY',
    action: 'Bắt đầu lấy tại key 42',
    note: '42 là giá trị đầu tiên ≥ 35 và vẫn ≤ 75 → đưa vào kết quả.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '35 ≤ 42 ≤ 75 · Lấy', tone: 'ok' },
    levels: baseSearchLevels({ root: { visited: true }, 'leaf-b': { active: true, badge: 'ĐANG QUÉT' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    matchedKeys: { 'leaf-b': [42] },
    pagesRead: ['Root', 'Leaf B'],
    results: [{ key: 42, detail: 'Từ Leaf B' }],
    newResultKey: 42,
    flyMoves: [{ fromAttr: '[data-key-id="leaf-b:42"]', toAttr: '[data-result-key="42"]' }],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'PHA 2 · LẤY ENTRY',
    action: 'Lấy tiếp key 55 trong Leaf B',
    note: '55 vẫn nằm trong [35, 75] → đưa vào kết quả. Đã đọc tới cuối Leaf B.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '35 ≤ 55 ≤ 75 · Lấy', tone: 'ok' },
    levels: baseSearchLevels({ root: { visited: true }, 'leaf-b': { active: true, badge: 'ĐANG QUÉT' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    matchedKeys: { 'leaf-b': [42, 55] },
    pagesRead: ['Root', 'Leaf B'],
    results: [
      { key: 42, detail: 'Từ Leaf B' },
      { key: 55, detail: 'Từ Leaf B' },
    ],
    newResultKey: 55,
    flyMoves: [{ fromAttr: '[data-key-id="leaf-b:55"]', toAttr: '[data-result-key="55"]' }],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'PHA 2 · SIBLING LINK',
    action: 'Đi ngang từ Leaf B sang Leaf C',
    note: 'Nhờ liên kết giữa các leaf, database sang thẳng Leaf C mà không cần quay lại Root.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: 'Leaf B → Leaf C', tone: 'ok' },
    levels: baseSearchLevels({
      root: { visited: true },
      'leaf-b': { visited: true },
      'leaf-c': { active: true, badge: 'ĐANG QUÉT' },
    }),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(['leaf-b', 'leaf-c']),
    matchedKeys: { 'leaf-b': [42, 55] },
    pagesRead: ['Root', 'Leaf B', 'Leaf C'],
    results: [
      { key: 42, detail: 'Từ Leaf B' },
      { key: 55, detail: 'Từ Leaf B' },
    ],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'PHA 2 · LẤY ENTRY',
    action: 'Lấy key 60 trong Leaf C',
    note: '60 nằm trong khoảng [35, 75] → đưa vào kết quả.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '35 ≤ 60 ≤ 75 · Lấy', tone: 'ok' },
    levels: baseSearchLevels({
      root: { visited: true },
      'leaf-b': { visited: true },
      'leaf-c': { active: true, badge: 'ĐANG QUÉT' },
    }),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(['leaf-b', 'leaf-c']),
    matchedKeys: { 'leaf-b': [42, 55], 'leaf-c': [60] },
    pagesRead: ['Root', 'Leaf B', 'Leaf C'],
    results: [
      { key: 42, detail: 'Từ Leaf B' },
      { key: 55, detail: 'Từ Leaf B' },
      { key: 60, detail: 'Từ Leaf C' },
    ],
    newResultKey: 60,
    flyMoves: [{ fromAttr: '[data-key-id="leaf-c:60"]', toAttr: '[data-result-key="60"]' }],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'PHA 2 · LẤY ENTRY',
    action: 'Lấy key 75 trong Leaf C',
    note: '75 bằng cận trên 75 → vẫn thuộc kết quả.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '35 ≤ 75 ≤ 75 · Lấy', tone: 'ok' },
    levels: baseSearchLevels({
      root: { visited: true },
      'leaf-b': { visited: true },
      'leaf-c': { active: true, badge: 'ĐANG QUÉT' },
    }),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(['leaf-b', 'leaf-c']),
    matchedKeys: { 'leaf-b': [42, 55], 'leaf-c': [60, 75] },
    pagesRead: ['Root', 'Leaf B', 'Leaf C'],
    results: [
      { key: 42, detail: 'Từ Leaf B' },
      { key: 55, detail: 'Từ Leaf B' },
      { key: 60, detail: 'Từ Leaf C' },
      { key: 75, detail: 'Từ Leaf C' },
    ],
    newResultKey: 75,
    flyMoves: [{ fromAttr: '[data-key-id="leaf-c:75"]', toAttr: '[data-result-key="75"]' }],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'DỪNG QUÉT',
    action: 'Gặp key 90 > 75 → dừng ngay',
    note: 'Vì các leaf được sắp tăng dần, mọi key phía sau 90 đều vượt 75 nên không cần đọc thêm.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '90 > 75 · Dừng', tone: 'miss' },
    levels: baseSearchLevels({
      root: { visited: true },
      'leaf-b': { visited: true },
      'leaf-c': { active: true, badge: 'DỪNG' },
    }),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(['leaf-b', 'leaf-c']),
    matchedKeys: { 'leaf-b': [42, 55], 'leaf-c': [60, 75] },
    stoppedKeys: { 'leaf-c': [90] },
    pagesRead: ['Root', 'Leaf B', 'Leaf C'],
    results: [
      { key: 42, detail: 'Từ Leaf B' },
      { key: 55, detail: 'Từ Leaf B' },
      { key: 60, detail: 'Từ Leaf C' },
      { key: 75, detail: 'Từ Leaf C' },
    ],
    height: 2,
    leafCount: 3,
  },
  {
    phase: 'HOÀN TẤT',
    action: 'Trả về 42, 55, 60, 75 theo đúng thứ tự',
    note: '1 lần đi từ Root xuống + 1 bước đi ngang qua sibling link. Dữ liệu đã sắp sẵn theo id, không cần sort lại.',
    query: 'SELECT * FROM users WHERE id BETWEEN 35 AND 75;',
    gate: { text: '3 page · 4 kết quả', tone: 'ok' },
    levels: baseSearchLevels({
      root: { visited: true },
      'leaf-b': { visited: true },
      'leaf-c': { visited: true },
    }),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(['leaf-b', 'leaf-c']),
    matchedKeys: { 'leaf-b': [42, 55], 'leaf-c': [60, 75] },
    pagesRead: ['Root', 'Leaf B', 'Leaf C'],
    results: [
      { key: 42, detail: 'Từ Leaf B' },
      { key: 55, detail: 'Từ Leaf B' },
      { key: 60, detail: 'Từ Leaf C' },
      { key: 75, detail: 'Từ Leaf C' },
    ],
    height: 2,
    leafCount: 3,
  },
];

// --- Workbench 2: Insert & Page Split ---

function insertRoomLevels(
  leafBKeys: number[],
  overrides: Partial<Record<'root' | 'leaf-a' | 'leaf-b' | 'leaf-c', Partial<TreeNode>>> = {},
): TreeNode[][] {
  return [
    [{ id: 'root', label: 'Root', kind: 'root', keys: [30, 60], capacity: 4, ...overrides.root }],
    [
      { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [5, 10, 20], capacity: 4, rangeHint: '< 30', ...overrides['leaf-a'] },
      { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: leafBKeys, capacity: 4, rangeHint: '30..59', ...overrides['leaf-b'] },
      { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75, 90], capacity: 4, rangeHint: '≥ 60', ...overrides['leaf-c'] },
    ],
  ];
}

const insertRoomTrace: Frame[] = [
  {
    phase: 'SẴN SÀNG',
    action: 'Chèn key 47 khi Leaf B còn chỗ (3/4)',
    note: 'Giả sử mỗi leaf giữ tối đa 4 key. Leaf B đang có [30, 42, 55], vẫn còn 1 chỗ trống.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    incoming: { key: 47, label: 'Key cần chèn', tone: 'insert' },
    levels: insertRoomLevels([30, 42, 55]),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(),
    changes: [],
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'ĐỌC ROOT',
    action: 'Tìm leaf đích cho key 47',
    note: 'So sánh tại Root: 30 ≤ 47 < 60, nên đi xuống nhánh giữa tới Leaf B.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: '30 ≤ 47 < 60 · tới Leaf B', tone: 'ok' },
    incoming: { key: 47, label: 'Key cần chèn', tone: 'insert' },
    levels: insertRoomLevels([30, 42, 55], { root: { active: true, badge: 'ĐANG ĐỌC' } }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { root: [30, 60] },
    changes: [{ id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' }],
    newChangeId: 'find',
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'CHỌN VỊ TRÍ',
    action: 'Leaf B còn chỗ → tìm chỗ giữa 42 và 55',
    note: 'Leaf B mới có 3/4 key. Để giữ thứ tự tăng dần, 47 phải đứng sau 42 và trước 55.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: '42 < 47 < 55 · Còn 1 chỗ', tone: 'ok' },
    incoming: { key: 47, label: 'Chèn vào Leaf B', tone: 'insert' },
    levels: insertRoomLevels([30, 42, 55], {
      root: { visited: true },
      'leaf-b': { active: true, badge: 'CÒN CHỖ 3/4' },
    }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { 'leaf-b': [42, 55] },
    changes: [
      { id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' },
      { id: 'slot', text: 'Leaf B còn 1 chỗ, vị trí giữa 42 và 55' },
    ],
    newChangeId: 'slot',
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'CHÈN ENTRY',
    action: 'Đặt 47 vào Leaf B → [30, 42, 47, 55]',
    note: 'Entry 47 được chèn đúng thứ tự. Root và các leaf khác không cần thay đổi.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: 'Đã chèn 47 (4/4)', tone: 'ok' },
    levels: insertRoomLevels([30, 42, 47, 55], {
      root: { visited: true },
      'leaf-b': { active: true, badge: 'ĐÃ CẬP NHẬT' },
    }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    newKeys: { 'leaf-b': [47] },
    flyMoves: [
      { fromAttr: '[data-incoming-key="47"]', toAttr: '[data-key-id="leaf-b:47"]' },
    ],
    changes: [
      { id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' },
      { id: 'slot', text: 'Leaf B còn 1 chỗ, vị trí giữa 42 và 55' },
      { id: 'write', text: 'Chèn 47 vào Leaf B: [30, 42, 47, 55]' },
    ],
    newChangeId: 'write',
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'HOÀN TẤT',
    action: 'Kết thúc · không cần split page',
    note: 'Khi leaf còn chỗ, insert chỉ sửa đúng một leaf page (kèm ghi transaction log). Cấu trúc cây giữ nguyên.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: '0 lần split · 2 tầng', tone: 'ok' },
    levels: insertRoomLevels([30, 42, 47, 55], { 'leaf-b': { visited: true } }),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(),
    newKeys: { 'leaf-b': [47] },
    changes: [
      { id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' },
      { id: 'slot', text: 'Leaf B còn 1 chỗ, vị trí giữa 42 và 55' },
      { id: 'write', text: 'Chèn 47 vào Leaf B: [30, 42, 47, 55]' },
    ],
    height: 2,
    leafCount: 3,
    splits: 0,
  },
];

const leafSplitTrace: Frame[] = [
  {
    phase: 'SẴN SÀNG',
    action: 'Chèn key 47 vào Leaf B đã đầy (4/4)',
    note: 'Giả sử mỗi leaf chứa tối đa 4 key. Leaf B đang giữ [30, 42, 45, 55] — không còn chỗ trống.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    incoming: { key: 47, label: 'Key cần chèn', tone: 'insert' },
    levels: insertRoomLevels([30, 42, 45, 55], { 'leaf-b': { full: true, badge: 'ĐẦY 4/4' } }),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(),
    changes: [],
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'TÌM LEAF ĐÍCH',
    action: 'Đi từ Root tới Leaf B',
    note: '30 ≤ 47 < 60 → Root chỉ đường tới Leaf B.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: '30 ≤ 47 < 60 · tới Leaf B', tone: 'ok' },
    incoming: { key: 47, label: 'Key cần chèn', tone: 'insert' },
    levels: insertRoomLevels([30, 42, 45, 55], {
      root: { active: true, badge: 'ĐANG ĐỌC' },
      'leaf-b': { full: true, badge: 'ĐẦY 4/4' },
    }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { root: [30, 60] },
    changes: [{ id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' }],
    newChangeId: 'find',
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'TRÀN PAGE',
    action: 'Leaf B đầy 4/4 → kích hoạt Page Split',
    note: 'Không thể đặt 5 key [30, 42, 45, 47, 55] vào cùng một leaf giới hạn 4 key. Database phải tách page.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: '5 > 4 · Phải chia page', tone: 'warn' },
    incoming: { key: 47, label: 'Không đủ chỗ', tone: 'insert' },
    levels: insertRoomLevels([30, 42, 45, 55], {
      root: { visited: true },
      'leaf-b': { active: true, full: true, badge: 'TRÀN 5/4' },
    }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { 'leaf-b': [45, 55] },
    changes: [
      { id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' },
      { id: 'overflow', text: 'Leaf B tràn (4/4) khi nhận thêm 47' },
    ],
    newChangeId: 'overflow',
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'TÁCH LEAF',
    action: 'Tạo Leaf B2, chia key và nối sibling',
    note: 'Leaf B giữ [30, 42]; Leaf B2 nhận [45, 47, 55] và được nối sibling giữa Leaf B và Leaf C. Còn thiếu con trỏ từ Root.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: 'Chia → [30, 42] | [45, 47, 55]', tone: 'ok' },
    incoming: { key: 45, label: 'Separator cần đưa lên Root', tone: 'promote' },
    levels: [
      [{ id: 'root', label: 'Root', kind: 'root', keys: [30, 60], capacity: 4, visited: true }],
      [
        { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [5, 10, 20], capacity: 4, rangeHint: '< 30' },
        { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30, 42], capacity: 4, rangeHint: '30..44', active: true },
        { id: 'leaf-b2', label: 'Leaf B2', kind: 'leaf', keys: [45, 47, 55], capacity: 4, rangeHint: '45..59', active: true, isNew: true, pendingParent: true, badge: 'MỚI' },
        { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75, 90], capacity: 4, rangeHint: '≥ 60' },
      ],
    ],
    edges: [
      { from: 'root', to: 'leaf-a', label: '< 30', branchIndex: 0 },
      { from: 'root', to: 'leaf-b', label: '30..44', branchIndex: 0.82, active: true },
      { from: 'root', to: 'leaf-b2', label: 'chờ 45', branchIndex: 1.18, dashed: true },
      { from: 'root', to: 'leaf-c', label: '≥ 60', branchIndex: 2 },
    ],
    siblingLinks: [
      { from: 'leaf-a', to: 'leaf-b' },
      { from: 'leaf-b', to: 'leaf-b2', active: true, isNew: true },
      { from: 'leaf-b2', to: 'leaf-c', active: true, isNew: true },
    ],
    newKeys: { 'leaf-b2': [47] },
    comparingKeys: { 'leaf-b2': [45] },
    spawnFrom: { 'leaf-b2': 'leaf-b' },
    flyMoves: [
      { fromAttr: '[data-key-id="leaf-b:45"]', toAttr: '[data-key-id="leaf-b2:45"]' },
      { fromAttr: '[data-key-id="leaf-b:55"]', toAttr: '[data-key-id="leaf-b2:55"]' },
      { fromAttr: '[data-incoming-key="47"]', toAttr: '[data-key-id="leaf-b2:47"]' },
    ],
    changes: [
      { id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' },
      { id: 'overflow', text: 'Leaf B tràn (4/4) khi nhận thêm 47' },
      { id: 'split', text: 'Tách Leaf B → [30, 42] + Leaf B2 [45, 47, 55]' },
      { id: 'sib', text: 'Nối sibling: Leaf B ↔ Leaf B2 ↔ Leaf C' },
    ],
    newChangeId: 'split',
    height: 2,
    leafCount: 4,
    splits: 1,
  },
  {
    phase: 'ĐẨY SEPARATOR',
    action: 'Thêm separator 45 vào Root',
    note: 'Root sao chép khóa nhỏ nhất của Leaf B2 là 45 để điều hướng. Key 45 vẫn ở lại Leaf B2 vì B+Tree giữ mọi entry ở leaf.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: 'Root: 30 | 45 | 60', tone: 'ok' },
    levels: [
      [{ id: 'root', label: 'Root', kind: 'root', keys: [30, 45, 60], capacity: 4, active: true, badge: 'THÊM 45' }],
      [
        { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [5, 10, 20], capacity: 4, rangeHint: '< 30' },
        { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30, 42], capacity: 4, rangeHint: '30..44', visited: true },
        { id: 'leaf-b2', label: 'Leaf B2', kind: 'leaf', keys: [45, 47, 55], capacity: 4, rangeHint: '45..59', visited: true, isNew: true },
        { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75, 90], capacity: 4, rangeHint: '≥ 60' },
      ],
    ],
    edges: [
      { from: 'root', to: 'leaf-a', label: '< 30', branchIndex: 0 },
      { from: 'root', to: 'leaf-b', label: '30..44', branchIndex: 1 },
      { from: 'root', to: 'leaf-b2', label: '45..59', branchIndex: 2, active: true },
      { from: 'root', to: 'leaf-c', label: '≥ 60', branchIndex: 3 },
    ],
    siblingLinks: [
      { from: 'leaf-a', to: 'leaf-b' },
      { from: 'leaf-b', to: 'leaf-b2' },
      { from: 'leaf-b2', to: 'leaf-c' },
    ],
    newKeys: { root: [45], 'leaf-b2': [47] },
    flyMoves: [
      { fromAttr: '[data-key-id="leaf-b2:45"]', toAttr: '[data-key-id="root:45"]' },
    ],
    changes: [
      { id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' },
      { id: 'overflow', text: 'Leaf B tràn (4/4) khi nhận thêm 47' },
      { id: 'split', text: 'Tách Leaf B → [30, 42] + Leaf B2 [45, 47, 55]' },
      { id: 'sib', text: 'Nối sibling: Leaf B ↔ Leaf B2 ↔ Leaf C' },
      { id: 'promote', text: 'Sao chép separator 45 lên Root → 4 nhánh' },
    ],
    newChangeId: 'promote',
    height: 2,
    leafCount: 4,
    splits: 1,
  },
  {
    phase: 'HOÀN TẤT',
    action: 'Xong Leaf Split · cây vẫn cao 2 tầng',
    note: 'Root vẫn còn chỗ cho separator 45 nên cây chưa tăng chiều cao. Điểm split thật trên từng database có thể khác tỷ lệ 50/50.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);',
    gate: { text: '1 lần split · 4 leaf · 2 tầng', tone: 'ok' },
    levels: [
      [{ id: 'root', label: 'Root', kind: 'root', keys: [30, 45, 60], capacity: 4, visited: true }],
      [
        { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [5, 10, 20], capacity: 4, rangeHint: '< 30' },
        { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30, 42], capacity: 4, rangeHint: '30..44' },
        { id: 'leaf-b2', label: 'Leaf B2', kind: 'leaf', keys: [45, 47, 55], capacity: 4, rangeHint: '45..59' },
        { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75, 90], capacity: 4, rangeHint: '≥ 60' },
      ],
    ],
    edges: [
      { from: 'root', to: 'leaf-a', label: '< 30', branchIndex: 0 },
      { from: 'root', to: 'leaf-b', label: '30..44', branchIndex: 1 },
      { from: 'root', to: 'leaf-b2', label: '45..59', branchIndex: 2 },
      { from: 'root', to: 'leaf-c', label: '≥ 60', branchIndex: 3 },
    ],
    siblingLinks: [
      { from: 'leaf-a', to: 'leaf-b' },
      { from: 'leaf-b', to: 'leaf-b2' },
      { from: 'leaf-b2', to: 'leaf-c' },
    ],
    newKeys: { root: [45], 'leaf-b2': [47] },
    changes: [
      { id: 'find', text: 'Root chọn nhánh 30..59 → Leaf B' },
      { id: 'overflow', text: 'Leaf B tràn (4/4) khi nhận thêm 47' },
      { id: 'split', text: 'Tách Leaf B → [30, 42] + Leaf B2 [45, 47, 55]' },
      { id: 'sib', text: 'Nối sibling: Leaf B ↔ Leaf B2 ↔ Leaf C' },
      { id: 'promote', text: 'Sao chép separator 45 lên Root → 4 nhánh' },
    ],
    height: 2,
    leafCount: 4,
    splits: 1,
  },
];

// Mode 3: Root Split (2 keys/node limit so the height growth from 2 -> 3 is crystal clear)
function rootSplitInitialLevels(overrides: Partial<Record<'root' | 'leaf-a' | 'leaf-b' | 'leaf-c', Partial<TreeNode>>> = {}): TreeNode[][] {
  return [
    [{ id: 'root', label: 'Root', kind: 'root', keys: [30, 60], capacity: 2, full: true, badge: 'ĐẦY 2/2', ...overrides.root }],
    [
      { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [10, 20], capacity: 2, rangeHint: '< 30', ...overrides['leaf-a'] },
      { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30, 42], capacity: 2, rangeHint: '30..59', full: true, badge: 'ĐẦY 2/2', ...overrides['leaf-b'] },
      { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75], capacity: 2, rangeHint: '≥ 60', ...overrides['leaf-c'] },
    ],
  ];
}

const rootSplitTrace: Frame[] = [
  {
    phase: 'SẴN SÀNG',
    action: 'Chèn 47 khi cả Leaf B và Root đều đầy (2/2)',
    note: 'Thu nhỏ giới hạn xuống 2 key/page để quan sát split lan từ leaf lên tận Root và làm cây cao thêm 1 tầng.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);  -- max 2 key/page',
    incoming: { key: 47, label: 'Key cần chèn', tone: 'insert' },
    levels: rootSplitInitialLevels(),
    edges: baseThreeEdges(),
    siblingLinks: baseThreeSiblings(),
    changes: [],
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'TÌM LEAF ĐÍCH',
    action: 'Đi tới Leaf B [30, 42] đã đầy 2/2',
    note: '30 ≤ 47 < 60 → vào Leaf B. Leaf B không còn chỗ cho 47 nên phải split.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);  -- max 2 key/page',
    gate: { text: 'Leaf B đầy 2/2', tone: 'warn' },
    incoming: { key: 47, label: 'Key cần chèn', tone: 'insert' },
    levels: rootSplitInitialLevels({
      root: { visited: true, badge: 'ĐẦY 2/2' },
      'leaf-b': { active: true, full: true, badge: 'TRÀN 3/2' },
    }),
    edges: baseThreeEdges('leaf-b'),
    siblingLinks: baseThreeSiblings(),
    comparingKeys: { 'leaf-b': [30, 42] },
    changes: [{ id: 'find', text: 'Leaf B [30, 42] đầy khi chèn 47' }],
    newChangeId: 'find',
    height: 2,
    leafCount: 3,
    splits: 0,
  },
  {
    phase: 'TÁCH LEAF',
    action: 'Tách Leaf B → [30] và Leaf B2 [42, 47]',
    note: 'Tạo Leaf B2, nối sibling, và cần đẩy separator 42 lên Root.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);  -- max 2 key/page',
    gate: { text: 'Đẩy separator 42 lên Root', tone: 'ok' },
    incoming: { key: 42, label: 'Separator cần đẩy lên Root', tone: 'promote' },
    levels: [
      [{ id: 'root', label: 'Root', kind: 'root', keys: [30, 60], capacity: 2, full: true, badge: 'ĐẦY 2/2' }],
      [
        { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [10, 20], capacity: 2, rangeHint: '< 30' },
        { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30], capacity: 2, rangeHint: '30..41', active: true },
        { id: 'leaf-b2', label: 'Leaf B2', kind: 'leaf', keys: [42, 47], capacity: 2, rangeHint: '42..59', active: true, isNew: true, pendingParent: true, badge: 'MỚI' },
        { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75], capacity: 2, rangeHint: '≥ 60' },
      ],
    ],
    edges: [
      { from: 'root', to: 'leaf-a', label: '< 30', branchIndex: 0 },
      { from: 'root', to: 'leaf-b', label: '30..41', branchIndex: 0.82 },
      { from: 'root', to: 'leaf-b2', label: 'chờ 42', branchIndex: 1.18, dashed: true },
      { from: 'root', to: 'leaf-c', label: '≥ 60', branchIndex: 2 },
    ],
    siblingLinks: [
      { from: 'leaf-a', to: 'leaf-b' },
      { from: 'leaf-b', to: 'leaf-b2', active: true, isNew: true },
      { from: 'leaf-b2', to: 'leaf-c', active: true, isNew: true },
    ],
    newKeys: { 'leaf-b2': [47] },
    comparingKeys: { 'leaf-b2': [42] },
    spawnFrom: { 'leaf-b2': 'leaf-b' },
    flyMoves: [
      { fromAttr: '[data-key-id="leaf-b:42"]', toAttr: '[data-key-id="leaf-b2:42"]' },
      { fromAttr: '[data-incoming-key="47"]', toAttr: '[data-key-id="leaf-b2:47"]' },
    ],
    changes: [
      { id: 'find', text: 'Leaf B [30, 42] đầy khi chèn 47' },
      { id: 'leaf-split', text: 'Tách Leaf B → [30] + Leaf B2 [42, 47]' },
    ],
    newChangeId: 'leaf-split',
    height: 2,
    leafCount: 4,
    splits: 1,
  },
  {
    phase: 'ROOT TRÀN',
    action: 'Root [30, 60] đã đầy → không chứa thêm được 42',
    note: 'Nhận thêm 42 sẽ thành 3 separator [30, 42, 60] vượt giới hạn 2/2. Database phải split cả Root.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);  -- max 2 key/page',
    gate: { text: '[30, 42, 60] > 2 · Split Root', tone: 'warn' },
    incoming: { key: 42, label: 'Đẩy lên tầng mới', tone: 'promote' },
    levels: [
      [{ id: 'root', label: 'Root cũ', kind: 'root', keys: [30, 60], capacity: 2, active: true, full: true, badge: 'TRÀN 3/2' }],
      [
        { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [10, 20], capacity: 2, rangeHint: '< 30' },
        { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30], capacity: 2, rangeHint: '30..41' },
        { id: 'leaf-b2', label: 'Leaf B2', kind: 'leaf', keys: [42, 47], capacity: 2, rangeHint: '42..59', pendingParent: true },
        { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75], capacity: 2, rangeHint: '≥ 60' },
      ],
    ],
    edges: [
      { from: 'root', to: 'leaf-a', label: '< 30', branchIndex: 0 },
      { from: 'root', to: 'leaf-b', label: '30..41', branchIndex: 0.82 },
      { from: 'root', to: 'leaf-b2', label: 'chờ 42', branchIndex: 1.18, dashed: true },
      { from: 'root', to: 'leaf-c', label: '≥ 60', branchIndex: 2 },
    ],
    siblingLinks: [
      { from: 'leaf-a', to: 'leaf-b' },
      { from: 'leaf-b', to: 'leaf-b2' },
      { from: 'leaf-b2', to: 'leaf-c' },
    ],
    comparingKeys: { root: [30, 60] },
    newKeys: { 'leaf-b2': [47] },
    changes: [
      { id: 'find', text: 'Leaf B [30, 42] đầy khi chèn 47' },
      { id: 'leaf-split', text: 'Tách Leaf B → [30] + Leaf B2 [42, 47]' },
      { id: 'root-full', text: 'Root cũ [30, 60] tràn khi nhận separator 42' },
    ],
    newChangeId: 'root-full',
    height: 2,
    leafCount: 4,
    splits: 1,
  },
  {
    phase: 'TẠO ROOT MỚI',
    action: 'Tách Root thành 2 Internal và đẩy 42 lên Root mới',
    note: 'Khác với leaf split, khi tách internal/root thì separator giữa (42) được đẩy hẳn lên Root mới. Hai nhánh con giữ [30] và [60].',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);  -- max 2 key/page',
    gate: { text: 'Chiều cao: 2 → 3 tầng', tone: 'ok' },
    levels: [
      [{ id: 'new-root', label: 'Root mới', kind: 'root', keys: [42], capacity: 2, active: true, isNew: true, badge: 'TẦNG 1' }],
      [
        { id: 'int-a', label: 'Internal A', kind: 'internal', keys: [30], capacity: 2, rangeHint: '< 42', isNew: true },
        { id: 'int-b', label: 'Internal B', kind: 'internal', keys: [60], capacity: 2, rangeHint: '≥ 42', isNew: true },
      ],
      [
        { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [10, 20], capacity: 2, rangeHint: '< 30' },
        { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30], capacity: 2, rangeHint: '30..41' },
        { id: 'leaf-b2', label: 'Leaf B2', kind: 'leaf', keys: [42, 47], capacity: 2, rangeHint: '42..59' },
        { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75], capacity: 2, rangeHint: '≥ 60' },
      ],
    ],
    edges: [
      { from: 'new-root', to: 'int-a', label: '< 42', branchIndex: 0, active: true },
      { from: 'new-root', to: 'int-b', label: '≥ 42', branchIndex: 1, active: true },
      { from: 'int-a', to: 'leaf-a', label: '< 30', branchIndex: 0 },
      { from: 'int-a', to: 'leaf-b', label: '30..41', branchIndex: 1 },
      { from: 'int-b', to: 'leaf-b2', label: '42..59', branchIndex: 0, active: true },
      { from: 'int-b', to: 'leaf-c', label: '≥ 60', branchIndex: 1 },
    ],
    siblingLinks: [
      { from: 'leaf-a', to: 'leaf-b' },
      { from: 'leaf-b', to: 'leaf-b2' },
      { from: 'leaf-b2', to: 'leaf-c' },
    ],
    newKeys: { 'new-root': [42], 'leaf-b2': [47] },
    spawnFrom: { 'new-root': 'root', 'int-a': 'root', 'int-b': 'root' },
    flyMoves: [
      { fromAttr: '[data-incoming-key="42"]', toAttr: '[data-key-id="new-root:42"]' },
      { fromAttr: '[data-key-id="root:30"]', toAttr: '[data-key-id="int-a:30"]' },
      { fromAttr: '[data-key-id="root:60"]', toAttr: '[data-key-id="int-b:60"]' },
    ],
    changes: [
      { id: 'find', text: 'Leaf B [30, 42] đầy khi chèn 47' },
      { id: 'leaf-split', text: 'Tách Leaf B → [30] + Leaf B2 [42, 47]' },
      { id: 'root-full', text: 'Root cũ [30, 60] tràn khi nhận separator 42' },
      { id: 'root-split', text: 'Tạo Root mới [42] + Internal A [30] & B [60]' },
    ],
    newChangeId: 'root-split',
    height: 3,
    leafCount: 4,
    splits: 2,
  },
  {
    phase: 'HOÀN TẤT',
    action: 'Cây cao 3 tầng · mọi leaf vẫn cùng độ sâu',
    note: 'Root split là cách duy nhất B+Tree tăng chiều cao — cây mọc lên phía trên nên tất cả leaf luôn nằm ở cùng tầng cuối.',
    query: 'INSERT INTO users (id, ...) VALUES (47, ...);  -- max 2 key/page',
    gate: { text: '2 lần split · 3 tầng cân bằng', tone: 'ok' },
    levels: [
      [{ id: 'new-root', label: 'Root mới', kind: 'root', keys: [42], capacity: 2, visited: true }],
      [
        { id: 'int-a', label: 'Internal A', kind: 'internal', keys: [30], capacity: 2, rangeHint: '< 42', visited: true },
        { id: 'int-b', label: 'Internal B', kind: 'internal', keys: [60], capacity: 2, rangeHint: '≥ 42', visited: true },
      ],
      [
        { id: 'leaf-a', label: 'Leaf A', kind: 'leaf', keys: [10, 20], capacity: 2, rangeHint: '< 30' },
        { id: 'leaf-b', label: 'Leaf B', kind: 'leaf', keys: [30], capacity: 2, rangeHint: '30..41' },
        { id: 'leaf-b2', label: 'Leaf B2', kind: 'leaf', keys: [42, 47], capacity: 2, rangeHint: '42..59' },
        { id: 'leaf-c', label: 'Leaf C', kind: 'leaf', keys: [60, 75], capacity: 2, rangeHint: '≥ 60' },
      ],
    ],
    edges: [
      { from: 'new-root', to: 'int-a', label: '< 42', branchIndex: 0 },
      { from: 'new-root', to: 'int-b', label: '≥ 42', branchIndex: 1 },
      { from: 'int-a', to: 'leaf-a', label: '< 30', branchIndex: 0 },
      { from: 'int-a', to: 'leaf-b', label: '30..41', branchIndex: 1 },
      { from: 'int-b', to: 'leaf-b2', label: '42..59', branchIndex: 0 },
      { from: 'int-b', to: 'leaf-c', label: '≥ 60', branchIndex: 1 },
    ],
    siblingLinks: [
      { from: 'leaf-a', to: 'leaf-b' },
      { from: 'leaf-b', to: 'leaf-b2' },
      { from: 'leaf-b2', to: 'leaf-c' },
    ],
    newKeys: { 'new-root': [42], 'leaf-b2': [47] },
    changes: [
      { id: 'find', text: 'Leaf B [30, 42] đầy khi chèn 47' },
      { id: 'leaf-split', text: 'Tách Leaf B → [30] + Leaf B2 [42, 47]' },
      { id: 'root-full', text: 'Root cũ [30, 60] tràn khi nhận separator 42' },
      { id: 'root-split', text: 'Tạo Root mới [42] + Internal A [30] & B [60]' },
    ],
    height: 3,
    leafCount: 4,
    splits: 2,
  },
];

export const traces = {
  exact: exactTrace,
  range: rangeTrace,
  insertRoom: insertRoomTrace,
  leafSplit: leafSplitTrace,
  rootSplit: rootSplitTrace,
};

export type Mode = keyof typeof traces;
