import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getJsonTableCellValue, planJsonTableColumns } from './json-table-pivot.ts';

const pageDataShape = [
  {
    id: 1,
    rowData: [
      { fieldName: 'attendanceDate', fieldValue: '2024-01-01' },
      { fieldName: 'signInTime', fieldValue: 1704164645123 },
      { fieldName: 'note', fieldValue: null },
    ],
  },
  {
    id: 2,
    rowData: [
      { fieldName: 'attendanceDate', fieldValue: '2024-01-02' },
      { fieldName: 'signInTime', fieldValue: '09:00' },
    ],
  },
];

function fieldHeaders(plan) {
  return plan.map((column) => (column.kind === 'field' ? column.field : column.header));
}

function pivotFieldKeys(plan) {
  return plan.filter((column) => column.kind === 'pivot').map((column) => column.fieldKey);
}

test('pageData 形状展平后列为 id 与各 fieldName，单元格为 fieldValue', () => {
  const plan = planJsonTableColumns(pageDataShape, true);
  assert.deepEqual(fieldHeaders(plan), ['id', 'attendanceDate', 'signInTime', 'note']);
  const noteCol = plan[3];
  assert.equal(getJsonTableCellValue(pageDataShape[0], noteCol), null);
  assert.equal(getJsonTableCellValue(pageDataShape[1], noteCol), null);
  const signInCol = plan.find((c) => c.kind === 'pivot' && c.columnName === 'signInTime');
  assert.equal(getJsonTableCellValue(pageDataShape[0], signInCol), 1704164645123);
});

test('关闭展平时仍为一字段一列', () => {
  const plan = planJsonTableColumns(pageDataShape, false);
  assert.deepEqual(fieldHeaders(plan), ['id', 'rowData']);
});

test('第三键、非对象元素、对象值不展平', () => {
  const extraKey = [
    {
      rowData: [
        { fieldName: 'a', fieldValue: '1', extra: 'x' },
        { fieldName: 'b', fieldValue: '2' },
      ],
    },
  ];
  assert.ok(planJsonTableColumns(extraKey, true).some((c) => c.kind === 'field' && c.field === 'rowData'));

  const badElement = [{ rowData: [{ fieldName: 'a', fieldValue: '1' }, 'x'] }];
  assert.ok(planJsonTableColumns(badElement, true).some((c) => c.kind === 'field' && c.field === 'rowData'));

  const nestedValue = [{ rowData: [{ fieldName: 'a', fieldValue: { nested: 1 } }] }];
  assert.ok(planJsonTableColumns(nestedValue, true).some((c) => c.kind === 'field' && c.field === 'rowData'));
});

test('列名重复、空列名、仅一行且两键均可作列名时不展平', () => {
  const dupNames = [{ rowData: [{ fieldName: 'a', fieldValue: 1 }, { fieldName: 'a', fieldValue: 2 }] }];
  assert.ok(planJsonTableColumns(dupNames, true).some((c) => c.kind === 'field' && c.field === 'rowData'));

  const emptyName = [{ rowData: [{ fieldName: '', fieldValue: 1 }, { fieldName: 'b', fieldValue: 2 }] }];
  assert.ok(planJsonTableColumns(emptyName, true).some((c) => c.kind === 'field' && c.field === 'rowData'));

  const singleRowBothName = [{ rowData: [{ k: 'a', v: '1' }, { k: 'b', v: '2' }] }];
  assert.ok(planJsonTableColumns(singleRowBothName, true).some((c) => c.kind === 'field' && c.field === 'rowData'));
});

test('多行间集合全同或全不同时不展平', () => {
  const bothVary = [
    { rowData: [{ name: 'a', val: '1' }, { name: 'b', val: '2' }] },
    { rowData: [{ name: 'c', val: '3' }, { name: 'd', val: '4' }] },
  ];
  assert.ok(planJsonTableColumns(bothVary, true).some((c) => c.kind === 'field' && c.field === 'rowData'));

  const bothSame = [
    { rowData: [{ fieldName: 'a', fieldValue: '1' }, { fieldName: 'b', fieldValue: '2' }] },
    { rowData: [{ fieldName: 'b', fieldValue: '2' }, { fieldName: 'a', fieldValue: '1' }] },
  ];
  assert.ok(planJsonTableColumns(bothSame, true).some((c) => c.kind === 'field' && c.field === 'rowData'));

  const bothVaryNamed = [
    { rowData: [{ fieldName: 'a', fieldValue: '1' }, { fieldName: 'b', fieldValue: '2' }] },
    { rowData: [{ fieldName: 'c', fieldValue: '3' }, { fieldName: 'd', fieldValue: '4' }] },
  ];
  assert.ok(
    planJsonTableColumns(bothVaryNamed, true).some((c) => c.kind === 'field' && c.field === 'rowData'),
  );
});

test('值键重复为 0 且含空字符串时仍按列名键展平', () => {
  const rows = [
    {
      rowData: [
        { fieldName: 'hours', fieldValue: '0' },
        { fieldName: 'note', fieldValue: '' },
        { fieldName: 'extra', fieldValue: '0' },
      ],
    },
  ];
  const plan = planJsonTableColumns(rows, true);
  assert.deepEqual(pivotFieldKeys(plan), ['hours', 'note', 'extra']);
  const note = plan.find((column) => column.kind === 'pivot' && column.columnName === 'note');
  assert.equal(getJsonTableCellValue(rows[0], note), '');
});

test('fieldName 全体不重复且 fieldValue 有重复或 null 时展平', () => {
  const rows = [
    {
      rowData: [
        { fieldName: 'x', fieldValue: 'same' },
        { fieldName: 'y', fieldValue: null },
      ],
    },
    {
      rowData: [{ fieldName: 'x', fieldValue: 'same' }, { fieldName: 'z', fieldValue: 'other' }],
    },
  ];
  const plan = planJsonTableColumns(rows, true);
  assert.deepEqual(pivotFieldKeys(plan), ['x', 'y', 'z']);
});

test('缺字段或空数组其它行仍展平，缺失单元格为 null', () => {
  const rows = [
    { id: 1, rowData: [{ fieldName: 'a', fieldValue: 1 }, { fieldName: 'b', fieldValue: 2 }] },
    { id: 2 },
    { id: 3, rowData: [] },
    { id: 4, rowData: [{ fieldName: 'b', fieldValue: 'only-b' }] },
  ];
  const plan = planJsonTableColumns(rows, true);
  const colA = plan.find((c) => c.kind === 'pivot' && c.columnName === 'a');
  const colB = plan.find((c) => c.kind === 'pivot' && c.columnName === 'b');
  assert.ok(colA && colB);
  assert.equal(getJsonTableCellValue(rows[1], colA), null);
  assert.equal(getJsonTableCellValue(rows[2], colA), null);
  assert.equal(getJsonTableCellValue(rows[3], colA), null);
  assert.equal(getJsonTableCellValue(rows[3], colB), 'only-b');
});

test('null 或非数组整列不展平', () => {
  const nullRow = [{ rowData: null }];
  assert.ok(planJsonTableColumns(nullRow, true).some((c) => c.kind === 'field' && c.field === 'rowData'));

  const notArray = [{ rowData: 'x' }];
  assert.ok(planJsonTableColumns(notArray, true).some((c) => c.kind === 'field' && c.field === 'rowData'));
});

test('与同级字段重名时使用数组字段前缀；前缀仍冲突则不展平', () => {
  const prefix = [
    { id: 'conflict', rowData: [{ fieldName: 'id', fieldValue: 'inner' }] },
    { id: 'two', rowData: [{ fieldName: 'id', fieldValue: 'inner-2' }] },
  ];
  const plan = planJsonTableColumns(prefix, true);
  const pivot = plan.find((c) => c.kind === 'pivot');
  assert.equal(pivot.header, 'rowData.id');
  assert.equal(pivot.fieldKey, 'id');

  const stillConflict = [
    {
      id: 'taken-id',
      'rowData.id': 'taken',
      rowData: [{ fieldName: 'id', fieldValue: 'v' }],
    },
    { id: 'other', rowData: [{ fieldName: 'id', fieldValue: 'v2' }] },
  ];
  assert.ok(
    planJsonTableColumns(stillConflict, true).some((c) => c.kind === 'field' && c.field === 'rowData'),
  );
});

test('后出现的列名按该行顺序追加', () => {
  const rows = [
    { rowData: [{ fieldName: 'first', fieldValue: 1 }, { fieldName: 'second', fieldValue: 2 }] },
    { rowData: [{ fieldName: 'third', fieldValue: 3 }, { fieldName: 'first', fieldValue: 1 }] },
  ];
  const plan = planJsonTableColumns(rows, true);
  assert.deepEqual(
    plan.filter((c) => c.kind === 'pivot').map((c) => c.columnName),
    ['first', 'second', 'third'],
  );
});

test('两个数组字段展出同名列时，后一个表头带自己的字段前缀', () => {
  const rows = [
    {
      left: [{ fieldName: 'id', fieldValue: 1 }],
      right: [{ fieldName: 'id', fieldValue: 2 }],
    },
    {
      left: [{ fieldName: 'id', fieldValue: 3 }],
      right: [{ fieldName: 'id', fieldValue: 4 }],
    },
  ];
  const plan = planJsonTableColumns(rows, true);
  const headers = plan.filter((column) => column.kind === 'pivot').map((column) => column.header);
  assert.deepEqual(headers, ['id', 'right.id']);
});

test('普通列缺字段时返回 undefined', () => {
  const rows = [{ id: 1 }, { name: 'x' }];
  const plan = planJsonTableColumns(rows, false);
  const nameColumn = plan.find((column) => column.kind === 'field' && column.field === 'name');
  assert.equal(getJsonTableCellValue(rows[0], nameColumn), undefined);
});

test('时间格式化字段键使用列名键原始值', () => {
  const plan = planJsonTableColumns(pageDataShape, true);
  const signIn = plan.find((c) => c.kind === 'pivot' && c.columnName === 'signInTime');
  assert.equal(signIn.fieldKey, 'signInTime');
  assert.equal(signIn.header, 'signInTime');
});

