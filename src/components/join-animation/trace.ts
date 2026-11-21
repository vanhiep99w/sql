export type JoinRow = { id: string; label: string; key: number };
export type Pair = readonly [JoinRow, JoinRow];
type State = {
  left?: JoinRow[];
  right?: JoinRow[];
  sorted?: boolean;
  gate?: '=' | '≠' | '<' | '>';
  buckets?: readonly JoinRow[][];
  bucket?: number;
  build?: JoinRow;
  pair?: Pair;
  comparisons?: number;
  probes?: number;
  indexKey?: number;
};
export type Frame = State & { phase: string; action: string; note: string; pairs: Pair[] };
type Add = (phase: string, action: string, note: string, state?: State) => void;
type Compare = (c: JoinRow, o: JoinRow, state?: State & { phase?: string; note?: string }) => void;

const customers: JoinRow[] = [
  { id: 'c3', label: 'Chi', key: 3 }, { id: 'c1', label: 'An', key: 1 }, { id: 'c2', label: 'Bình', key: 2 },
];
const orders: JoinRow[] = [
  { id: 'o10', label: '#10', key: 1 }, { id: 'o13', label: '#13', key: 9 },
  { id: 'o12', label: '#12', key: 2 }, { id: 'o11', label: '#11', key: 1 },
];
const sortKeys = (rows: JoinRow[]) => [...rows].sort((a, b) => a.key - b.key);
export const sortedInputs = { customers: sortKeys(customers), orders: sortKeys(orders) };
export const inputs = { customers, orders };
const hash = ({ key }: JoinRow) => key % 2;

// The trace records semantic actions, independent of playback or animation.
function makeTrace(action: string, note: string, run: (add: Add, compare: Compare) => void) {
  const pairs: Pair[] = [];
  const frames: Frame[] = [{ phase: 'SẴN SÀNG', action, note, pairs: [] }];
  const add: Add = (phase, action, note, state = {}) => {
    if (state.pair) pairs.push(state.pair);
    frames.push({ phase, action, note, ...state, pairs: [...pairs] });
  };
  const compare: Compare = (c, o, state = {}) => {
    const match = c.key === o.key;
    const { phase = 'SO KHÓA', note = '', ...rest } = state;
    const compared: State = { ...rest, left: [c], right: [o], gate: match ? '=' : '≠' };
    add(phase, `${c.key} ${match ? '=' : '≠'} ${o.key} · ${match ? 'Khớp khóa' : 'Không ghép'}`,
      note || (match ? `${c.label} và đơn ${o.label} cùng khóa ${c.key}.` : `Bỏ qua cặp ${c.label} và ${o.label}.`), compared);
    if (match) add('XUẤT', `Ghép ${c.label} với đơn ${o.label}`, 'Cặp khớp rời bộ xử lý và xuất hiện trong kết quả.',
      { ...compared, pair: [c, o] });
  };
  run(add, compare);
  return frames;
}
function nestedLoop(outer: JoinRow[]) {
  return makeTrace('Giữ khách, quét đơn', 'Bấm Bước sau. Quan sát thẻ khách đứng yên trong khi các đơn lần lượt đi qua.', (add, compare) => {
    let comparisons = 0;
    for (const c of outer) {
      add('GIỮ KHÁCH', `Giữ ${c.label} ở vòng ngoài`, 'Quay về đầu danh sách orders và thử lần lượt từng đơn.', { left: [c], comparisons });
      for (const o of orders) compare(c, o, { comparisons: ++comparisons });
    }
    add('HOÀN TẤT', 'Cùng 3 cặp kết quả', 'Đã thử 3 × 4 = 12 cặp vì phiên bản này quét toàn bộ orders cho mỗi khách.', { comparisons });
  });
}

// Show ordered leaf entries, not the internal pages of a B-tree.
const ordersByCustomer = new Map<number, JoinRow[]>();
for (const order of sortedInputs.orders) {
  const entries = ordersByCustomer.get(order.key) ?? [];
  entries.push(order);
  ordersByCustomer.set(order.key, entries);
}
export const indexEntries = Array.from(ordersByCustomer);
export const comparisonInputs = { customers: sortedInputs.customers, orders };

export const traces = {
  loop: nestedLoop(customers),
  scan: nestedLoop(comparisonInputs.customers),
  indexed: makeTrace('Dùng mã khách để tra index', 'Bấm Bước sau để tra khóa 1 của An trên index orders.customer_id đã có sẵn.', (add) => {
    let probes = 0;
    for (const c of comparisonInputs.customers) {
      const matches = ordersByCustomer.get(c.key) ?? [];
      const state = { left: [c], indexKey: c.key, probes: ++probes };
      add('TRA INDEX', `Tìm customer_id = ${c.key}`, matches.length
        ? `Index dẫn tới ${matches.map((order) => order.label).join(' và ')}. Không cần thử các mã khách khác.`
        : `Không có mục nào cho khóa ${c.key}; không cần lấy dòng nào từ orders.`, state);
      for (const o of matches) {
        add('XUẤT', `Ghép ${c.label} với đơn ${o.label}`, `Lấy dòng được index trỏ tới và xuất cặp có cùng khóa ${c.key}.`,
          { ...state, right: [o], gate: '=', pair: [c, o] });
      }
    }
    add('HOÀN TẤT', 'Cùng 3 cặp kết quả', 'Đã tra index 3 lượt, mỗi khách một lượt, kể cả Chi không có đơn khớp.', { probes });
  }),
  hash: makeTrace('Xây bucket trước, dò sau', 'Thẻ khách sẽ vào bucket theo id % 2. Chưa có kết quả ở pha Build.', (add, compare) => {
    const buckets: [JoinRow[], JoinRow[]] = [[], []];
    const view = (bucket?: number) => ({ buckets: buckets.map((entries) => [...entries]), bucket });
    for (const c of customers) {
      const b = hash(c);
      buckets[b].push(c);
      add('BUILD', `Đưa ${c.label} vào bucket ${b}`, `${c.key} % 2 = ${b}. Lưu thẻ cùng khóa thật.`, { ...view(b), build: c });
    }
    for (const o of orders) {
      const b = hash(o);
      add('PROBE', `Đơn ${o.label} dò bucket ${b}`, `${o.key} % 2 = ${b}. Trùng bucket chưa phải trùng khóa.`, { ...view(b), right: [o] });
      for (const c of buckets[b]) {
        compare(c, o, { ...view(b), phase: 'PROBE · SO KHÓA',
          note: c.key === o.key ? '' : `Cùng bucket ${b}, nhưng khóa ${c.key} khác khóa ${o.key}.` });
      }
    }
    add('HOÀN TẤT', 'Cùng 3 cặp kết quả', 'Đơn #13 dò bucket 1 nhưng không có khóa 9, nên không sinh kết quả.', view());
  }),
  merge: makeTrace('Sắp xếp trước khi ghép', 'Hai dãy dùng chung thứ tự tăng dần của khóa JOIN.', (add, compare) => {
    add('CHUẨN BỊ', 'Xếp cả hai dãy theo khóa', 'Trong database, thứ tự có thể đến từ index scan phù hợp hoặc bước Sort.', { sorted: true });
    const { customers: left, orders: right } = sortedInputs;
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      const c = left[i];
      const o = right[j];
      if (c.key !== o.key) {
        const advanceLeft = c.key < o.key;
        const gate = advanceLeft ? '<' : '>';
        add('DỊCH CON TRỎ', `${c.key} ${gate} ${o.key} · tiến bên ${advanceLeft ? 'customers' : 'orders'}`,
          'Dãy bên kia đã sắp xếp, nên dòng có khóa nhỏ hơn không thể khớp với bất kỳ dòng nào còn lại ở đó.',
          { sorted: true, left: [c], right: [o], gate });
        if (advanceLeft) i++;
        else j++;
        continue;
      }
      const groupL = [];
      const groupR = [];
      while (left[i]?.key === c.key) groupL.push(left[i++]);
      while (right[j]?.key === o.key) groupR.push(right[j++]);
      add('GOM NHÓM', `Giữ cả hai nhóm khóa ${c.key}`, `Ghép đủ ${groupL.length} × ${groupR.length} cặp rồi mới chuyển sang nhóm khác.`,
        { sorted: true, left: groupL, right: groupR, gate: '=' });
      for (const a of groupL) for (const b of groupR) compare(a, b, { sorted: true, phase: 'GHÉP TRONG NHÓM' });
    }
    add('HOÀN TẤT', 'Cùng 3 cặp kết quả', `Đã đi hết dãy ${i === left.length ? 'customers' : 'orders'}.`, { sorted: true });
  }),
};

export type Mode = keyof typeof traces;
export const pairId = ([c, o]: Pair) => `${c.id}-${o.id}`;
