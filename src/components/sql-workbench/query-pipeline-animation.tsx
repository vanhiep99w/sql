'use client';

import { Fragment } from 'react';
import { WorkbenchShell, type BaseFrame, type WorkbenchMode } from './workbench-shell';
import styles from './workbench.module.css';

type PipelineStep = {
  name: string;
  state: 'done' | 'active' | 'skip' | 'idle';
};

type TableRow = {
  id: string;
  cells: string[];
  state?: 'active' | 'warn' | 'bad' | 'dim';
};

type PipelineFrame = BaseFrame & {
  steps: PipelineStep[];
  tableTitle: string;
  columns: string[];
  rows: TableRow[];
};

const pipelineModes: WorkbenchMode<PipelineFrame>[] = [
  {
    id: 'logical-order',
    label: 'Thứ tự Logic (FROM → LIMIT)',
    frames: [
      {
        phase: 'Bước 1 — FROM & JOIN',
        action: 'Ghép bảng customers × orders tạo tập dữ liệu trung gian ban đầu (5 dòng)',
        note: 'Dù bạn viết SELECT ở dòng 1, database luôn bắt đầu từ FROM và JOIN để biết đang làm việc với tập dòng nào.',
        query: "SELECT c.name, COUNT(*) AS cnt FROM customers c JOIN orders o ON o.cid=c.id WHERE o.status='paid' GROUP BY c.name HAVING COUNT(*)>=2 ORDER BY cnt DESC LIMIT 1;",
        metrics: [
          { label: 'Giai đoạn', value: 'FROM / JOIN' },
          { label: 'Số dòng', value: '5 dòng' },
        ],
        stats: [
          { label: 'Đang chạy', value: '1. FROM & JOIN' },
          { label: 'Alias SELECT', value: 'Chưa tồn tại!' },
        ],
        logs: [{ id: 'q1', text: 'FROM/JOIN ghép customers & orders ra 5 dòng thô (cả paid lẫn cancelled).' }],
        newLogId: 'q1',
        steps: [
          { name: '1. FROM/JOIN', state: 'active' },
          { name: '2. WHERE', state: 'idle' },
          { name: '3. GROUP BY', state: 'idle' },
          { name: '4. HAVING', state: 'idle' },
          { name: '5. SELECT', state: 'idle' },
          { name: '6. ORDER/LIMIT', state: 'idle' },
        ],
        tableTitle: 'Tập trung gian sau FROM + JOIN (5 dòng)',
        columns: ['c.name', 'o.id', 'o.status'],
        rows: [
          { id: 'r1', cells: ['An', '101', 'paid'], state: 'active' },
          { id: 'r2', cells: ['An', '102', 'paid'], state: 'active' },
          { id: 'r3', cells: ['An', '103', 'cancelled'], state: 'active' },
          { id: 'r4', cells: ['Bình', '104', 'paid'], state: 'active' },
          { id: 'r5', cells: ['Chi', '105', 'cancelled'], state: 'active' },
        ],
      },
      {
        phase: 'Bước 2 — WHERE (Lọc từng dòng)',
        action: "WHERE o.status = 'paid' loại bỏ 2 dòng cancelled (#103 và #105) trước khi gom nhóm",
        note: 'WHERE chạy TRƯỚC GROUP BY nên không được dùng COUNT(*) trong WHERE — nhưng lọc càng sớm ở WHERE thì GROUP BY càng nhẹ.',
        query: "WHERE o.status = 'paid'  -- Loại dòng #103, #105",
        gate: { text: 'Giữ 3 dòng paid • Loại 2 dòng cancelled', tone: 'ok' },
        metrics: [
          { label: 'Giai đoạn', value: 'WHERE' },
          { label: 'Còn lại', value: '3 / 5 dòng' },
        ],
        stats: [
          { label: 'Đơn vị lọc', value: 'Từng ROW' },
          { label: 'Đã loại', value: '2 dòng cancelled' },
        ],
        logs: [
          { id: 'q1', text: 'FROM/JOIN ghép customers & orders ra 5 dòng thô (cả paid lẫn cancelled).' },
          { id: 'q2', text: "WHERE status='paid' gạch bỏ #103 (An) và #105 (Chi), còn lại 3 dòng." },
        ],
        newLogId: 'q2',
        steps: [
          { name: '1. FROM/JOIN', state: 'done' },
          { name: '2. WHERE', state: 'active' },
          { name: '3. GROUP BY', state: 'idle' },
          { name: '4. HAVING', state: 'idle' },
          { name: '5. SELECT', state: 'idle' },
          { name: '6. ORDER/LIMIT', state: 'idle' },
        ],
        tableTitle: 'Sau khi lọc WHERE o.status = paid',
        columns: ['c.name', 'o.id', 'o.status'],
        rows: [
          { id: 'r1', cells: ['An', '101', 'paid'], state: 'active' },
          { id: 'r2', cells: ['An', '102', 'paid'], state: 'active' },
          { id: 'r3', cells: ['An', '103', 'cancelled'], state: 'bad' },
          { id: 'r4', cells: ['Bình', '104', 'paid'], state: 'active' },
          { id: 'r5', cells: ['Chi', '105', 'cancelled'], state: 'bad' },
        ],
      },
      {
        phase: 'Bước 3 & 4 — GROUP BY → HAVING',
        action: 'GROUP BY gom thành 2 nhóm (An: 2, Bình: 1) → HAVING COUNT(*) >= 2 loại nhóm Bình',
        note: 'HAVING lọc trên NHÓM sau khi đã tính aggregate. Nếu viết alias cnt trong WHERE sẽ lỗi vì SELECT còn chưa chạy!',
        query: 'GROUP BY c.name  →  HAVING COUNT(*) >= 2',
        gate: { text: 'Nhóm An (2 đơn) ĐẠT • Nhóm Bình (1 đơn) bị HAVING loại', tone: 'ok' },
        metrics: [
          { label: 'Giai đoạn', value: 'GROUP BY + HAVING' },
          { label: 'Nhóm giữ lại', value: '1 / 2 nhóm' },
        ],
        stats: [
          { label: 'Đơn vị lọc HAVING', value: 'Từng GROUP' },
          { label: 'Kết quả', value: 'An (cnt = 2)' },
        ],
        logs: [
          { id: 'q1', text: 'FROM/JOIN ghép customers & orders ra 5 dòng thô (cả paid lẫn cancelled).' },
          { id: 'q2', text: "WHERE status='paid' gạch bỏ #103 (An) và #105 (Chi), còn lại 3 dòng." },
          { id: 'q3', text: 'GROUP BY gom thành {An: 2, Bình: 1} → HAVING loại Bình (1 < 2).' },
        ],
        newLogId: 'q3',
        steps: [
          { name: '1. FROM/JOIN', state: 'done' },
          { name: '2. WHERE', state: 'done' },
          { name: '3. GROUP BY', state: 'done' },
          { name: '4. HAVING', state: 'active' },
          { name: '5. SELECT', state: 'idle' },
          { name: '6. ORDER/LIMIT', state: 'idle' },
        ],
        tableTitle: 'Các nhóm sau GROUP BY & HAVING',
        columns: ['c.name', 'Orders trong nhóm', 'COUNT(*)'],
        rows: [
          { id: 'g1', cells: ['An', '#101, #102', '2  (≥ 2 ✅)'], state: 'active' },
          { id: 'g2', cells: ['Bình', '#104', '1  (< 2 ✕)'], state: 'bad' },
        ],
      },
      {
        phase: 'Bước 5 & 6 — SELECT → ORDER BY → LIMIT',
        action: 'Tính projection + alias cnt ở SELECT, cuối cùng mới ORDER BY cnt DESC LIMIT 1',
        note: 'Đây là lý do ORDER BY dùng được alias cnt (vì chạy SAU SELECT), còn WHERE thì KHÔNG dùng được alias của SELECT.',
        query: 'SELECT c.name, COUNT(*) AS cnt ... ORDER BY cnt DESC LIMIT 1;',
        gate: { text: 'Trả kết quả cuối cùng: (An, 2)', tone: 'ok' },
        metrics: [
          { label: 'Giai đoạn', value: 'SELECT → LIMIT' },
          { label: 'Output', value: '1 dòng' },
        ],
        stats: [
          { label: 'Alias cnt', value: 'Sinh ở SELECT → dùng ở ORDER BY' },
          { label: 'Kết quả', value: 'An | 2' },
        ],
        logs: [
          { id: 'q1', text: 'FROM/JOIN ghép customers & orders ra 5 dòng thô (cả paid lẫn cancelled).' },
          { id: 'q2', text: "WHERE status='paid' gạch bỏ #103 (An) và #105 (Chi), còn lại 3 dòng." },
          { id: 'q3', text: 'GROUP BY gom thành {An: 2, Bình: 1} → HAVING loại Bình (1 < 2).' },
          { id: 'q4', text: 'SELECT gắn alias cnt → ORDER BY cnt DESC → LIMIT 1 trả về (An, 2).' },
        ],
        newLogId: 'q4',
        steps: [
          { name: '1. FROM/JOIN', state: 'done' },
          { name: '2. WHERE', state: 'done' },
          { name: '3. GROUP BY', state: 'done' },
          { name: '4. HAVING', state: 'done' },
          { name: '5. SELECT', state: 'done' },
          { name: '6. ORDER/LIMIT', state: 'active' },
        ],
        tableTitle: 'Kết quả trả về Client',
        columns: ['name', 'cnt'],
        rows: [{ id: 'out1', cells: ['An', '2'], state: 'active' }],
      },
    ],
  },
  {
    id: 'left-join-on',
    label: 'LEFT JOIN: Filter trong ON (Giữ NULL)',
    frames: [
      {
        phase: 'Filter ngay lúc ghép ON',
        action: "ON o.customer_id = c.id AND o.status = 'paid' — chỉ ghép đơn paid, vẫn GIỮ mọi customer!",
        note: 'Bình chỉ có đơn cancelled (#103) và Chi không có đơn nào: vì điều kiện status = paid nằm trong ON của LEFT JOIN, Bình và Chi vẫn xuất hiện với paid_order_id = NULL.',
        query: "SELECT c.id, c.name, o.id AS paid_order_id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid';",
        gate: { text: 'Trả đủ 3 customer (Bình & Chi đi kèm NULL)', tone: 'ok' },
        metrics: [
          { label: 'Vị trí filter', value: 'Mệnh đề ON' },
          { label: 'Số dòng trả về', value: '3 / 3 customer' },
        ],
        stats: [
          { label: 'An (có đơn paid)', value: '1 | An | 101' },
          { label: 'Bình & Chi', value: 'Giữ lại với NULL ✅' },
        ],
        logs: [
          { id: 'on1', text: "ON lọc orders trước khi bảo toàn bảng trái → An ghép #101; Bình & Chi không khớp nên gắn NULL." },
        ],
        newLogId: 'on1',
        steps: [
          { name: '1. Lọc cặp khớp trong ON', state: 'active' },
          { name: '2. Bảo toàn bảng trái (NULL)', state: 'active' },
          { name: '3. WHERE (không có)', state: 'skip' },
        ],
        tableTitle: 'Kết quả LEFT JOIN ... ON ... AND o.status = paid',
        columns: ['c.id', 'c.name', 'paid_order_id', 'Ghi chú'],
        rows: [
          { id: 'l1', cells: ['1', 'An', '101', 'Khớp đơn #101 (paid)'], state: 'active' },
          { id: 'l2', cells: ['2', 'Bình', 'NULL', 'Đơn #103 là cancelled → giữ Bình + NULL'], state: 'warn' },
          { id: 'l3', cells: ['3', 'Chi', 'NULL', 'Không có đơn → giữ Chi + NULL'], state: 'warn' },
        ],
      },
    ],
  },
  {
    id: 'left-join-where',
    label: 'LEFT JOIN: Filter trong WHERE (Mất NULL!)',
    frames: [
      {
        phase: 'Bước 1 — LEFT JOIN xong trước',
        action: 'LEFT JOIN ghép toàn bộ orders theo customer_id (chưa lọc status)',
        note: 'Lúc này An có 2 dòng (#101 paid, #102 cancelled), Bình có 1 dòng (#103 cancelled), Chi có 1 dòng (o.status = NULL).',
        query: "SELECT c.id, c.name, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.status = 'paid';",
        metrics: [
          { label: 'Vị trí filter', value: 'Mệnh đề WHERE' },
          { label: 'Sau LEFT JOIN', value: '4 dòng' },
        ],
        stats: [
          { label: 'Bước hiện tại', value: 'Sau LEFT JOIN (trước WHERE)' },
          { label: 'Dòng NULL', value: 'Chi có o.status = NULL' },
        ],
        logs: [{ id: 'wh1', text: 'LEFT JOIN tạo 4 dòng: An(paid), An(cancelled), Bình(cancelled), Chi(NULL).' }],
        newLogId: 'wh1',
        steps: [
          { name: '1. LEFT JOIN xong', state: 'active' },
          { name: '2. WHERE o.status=paid', state: 'idle' },
        ],
        tableTitle: 'Tập trung gian ngay sau LEFT JOIN (trước WHERE)',
        columns: ['c.id', 'c.name', 'o.id', 'o.status'],
        rows: [
          { id: 'w1', cells: ['1', 'An', '101', 'paid'], state: 'active' },
          { id: 'w2', cells: ['1', 'An', '102', 'cancelled'] },
          { id: 'w3', cells: ['2', 'Bình', '103', 'cancelled'] },
          { id: 'w4', cells: ['3', 'Chi', 'NULL', 'NULL'], state: 'warn' },
        ],
      },
      {
        phase: 'Bước 2 — WHERE xóa sạch dòng NULL!',
        action: "WHERE o.status = 'paid' đánh giá NULL = 'paid' → UNKNOWN → xóa luôn Bình & Chi!",
        note: 'Đặt điều kiện cột bảng phải vào WHERE vô tình biến LEFT JOIN thành INNER JOIN! Optimizer thậm chí viết lại plan thành INNER JOIN luôn.',
        query: "WHERE o.status = 'paid'  -- NULL = 'paid' là UNKNOWN → bị loại!",
        gate: { text: 'Chỉ còn 1 dòng (An) • LEFT JOIN bị biến thành INNER JOIN!', tone: 'bad' },
        metrics: [
          { label: 'Vị trí filter', value: 'Mệnh đề WHERE', warn: true },
          { label: 'Còn lại', value: '1 / 3 customer', warn: true },
        ],
        stats: [
          { label: 'Hiệu ứng thực tế', value: 'Tương đương INNER JOIN', tone: 'warn' },
          { label: 'Dòng bị mất', value: 'Bình & Chi bị WHERE xóa', tone: 'warn' },
        ],
        logs: [
          { id: 'wh1', text: 'LEFT JOIN tạo 4 dòng: An(paid), An(cancelled), Bình(cancelled), Chi(NULL).' },
          { id: 'wh2', text: "WHERE chạy SAU LEFT JOIN → loại cả #102, #103 và dòng NULL của Chi. Mất ý nghĩa LEFT JOIN!", tone: 'warn' },
        ],
        newLogId: 'wh2',
        steps: [
          { name: '1. LEFT JOIN xong', state: 'done' },
          { name: '2. WHERE o.status=paid', state: 'active' },
        ],
        tableTitle: 'Sau khi WHERE o.status = paid chạy',
        columns: ['c.id', 'c.name', 'o.id', 'o.status'],
        rows: [
          { id: 'w1', cells: ['1', 'An', '101', 'paid ✅'], state: 'active' },
          { id: 'w2', cells: ['1', 'An', '102', 'cancelled ✕'], state: 'bad' },
          { id: 'w3', cells: ['2', 'Bình', '103', 'cancelled ✕'], state: 'bad' },
          { id: 'w4', cells: ['3', 'Chi', 'NULL', 'NULL ✕ (UNKNOWN)'], state: 'bad' },
        ],
      },
    ],
  },
];

function renderPipelineStage(frame: PipelineFrame) {
  return (
    <div className={styles.tierStack}>
      <div className={styles.flowBar} aria-label="Tiến trình thực thi">
        {frame.steps.map((s, idx) => (
          <Fragment key={s.name}>
            {idx > 0 && <span className={styles.flowArrow} aria-hidden="true">→</span>}
            <span className={styles.flowStep} data-state={s.state}>{s.name}</span>
          </Fragment>
        ))}
      </div>

      <div className={styles.panelCard}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>{frame.tableTitle}</span>
          <span className={styles.badge} data-tone="ok">{frame.rows.length} DÒNG</span>
        </div>
        <div className={styles.miniTableWrap}>
          <table className={styles.miniTable}>
            <thead>
              <tr>
                {frame.columns.map((col) => <th key={col}>{col}</th>)}
              </tr>
            </thead>
            <tbody>
              {frame.rows.map((row) => (
                <tr key={row.id} data-state={row.state}>
                  {row.cells.map((cell, i) => <td key={i}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function QueryPipelineAnimation() {
  return (
    <WorkbenchShell
      id="query-pipeline-animation"
      title="Mô phỏng thứ tự thực thi SQL logic (FROM → WHERE → GROUP BY → HAVING → SELECT → LIMIT) và LEFT JOIN ON vs WHERE"
      modeAriaLabel="Chọn kịch bản thực thi SQL"
      modes={pipelineModes}
      initialModeId="logical-order"
      renderStage={renderPipelineStage}
    />
  );
}

export function LeftJoinFilterAnimation() {
  return (
    <WorkbenchShell
      id="left-join-filter-animation"
      title="Mô phỏng khác biệt khi đặt điều kiện lọc trong ON so với WHERE ở LEFT JOIN"
      modeAriaLabel="Chọn vị trí điều kiện lọc"
      modes={pipelineModes}
      initialModeId="left-join-on"
      renderStage={renderPipelineStage}
    />
  );
}
