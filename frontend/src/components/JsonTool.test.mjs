import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { createJsonTableExpansion } from '../lib/json-table-expansion.ts';
import { formatJsonTimeValue } from '../lib/json-time-format.ts';

// 直接执行组件的预览退出副作用，覆盖检测状态变化，不引入浏览器或另一套状态逻辑。
const source = ts.createSourceFile(
  'JsonTool.tsx',
  readFileSync(new URL('./JsonTool.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const previewSetters = ['setInputTableMode', 'setInputSchemaPreviewMode', 'setResultTableMode'];
const effects = new Map();
const tablePreviews = [];
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'JsonTablePreview') {
    let parent = node.parent;
    while (parent && !ts.isJsxExpression(parent)) parent = parent.parent;
    assert.ok(parent?.expression);
    tablePreviews.push(parent.expression.getText(source));
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
    const callback = node.arguments[0];
    const setters = new Set();
    function findSetters(child) {
      if (ts.isCallExpression(child) && previewSetters.includes(child.expression.getText(source))) {
        setters.add(child.expression.getText(source));
      }
      ts.forEachChild(child, findSetters);
    }
    findSetters(callback);
    for (const setter of setters) effects.set(setter, callback.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(effects.size, previewSetters.length);

function previewModes(status, overrides = {}) {
  const modes = { inputTable: true, inputSchema: true, resultTable: true };
  const context = {
    input: '{"type":"object"}',
    result: '[{"id":1}]',
    inputTableMode: true,
    inputSchemaPreviewMode: true,
    resultTableMode: true,
    inputInspection: { status },
    resultInspection: { status },
    inputPreview: { valid: status === 'ok' },
    inputIsSchema: status === 'ok',
    ...overrides,
    setInputTableMode: (value) => {
      modes.inputTable = value;
    },
    setInputSchemaPreviewMode: (value) => {
      modes.inputSchema = value;
    },
    setResultTableMode: (value) => {
      modes.resultTable = value;
    },
  };
  for (const callback of effects.values()) runInNewContext(`(${callback})()`, context);
  return modes;
}

const enabled = { inputTable: true, inputSchema: true, resultTable: true };
const disabled = { inputTable: false, inputSchema: false, resultTable: false };

test('切换工具的 idle 和恢复检测的 pending 不关闭预览', () => {
  for (const status of ['ok', 'idle', 'pending', 'ok']) {
    assert.deepEqual(previewModes(status), enabled, status);
  }
});

test('空内容和确定无效的检测结果仍关闭预览', () => {
  for (const status of ['empty', 'invalid']) {
    assert.deepEqual(previewModes(status), disabled, status);
  }
});

test('检测完成后，不再是 schema 的输入只关闭 schema 预览', () => {
  assert.deepEqual(previewModes('ok', { inputIsSchema: false }), {
    ...enabled,
    inputSchema: false,
  });
});

test('解析失败仍关闭输入表格，清空结果立即关闭结果表格', () => {
  assert.equal(previewModes('ok', { inputPreview: { valid: false } }).inputTable, false);
  assert.equal(previewModes('pending', { result: '' }).resultTable, false);
});

function tablePreviewElement(expression, active, status) {
  function JsonTablePreview() {}
  const context = {
    React: { createElement },
    JsonTablePreview,
    inputTableMode: true,
    resultTableMode: true,
    timeFormat: 'none',
    active,
    schema: true,
    pipelineMode: false,
    pathError: '',
    inputPreview: { value: { nested: { id: 1 } }, valid: status === 'ok' },
    resultPreview: { value: { nested: { id: 1 } }, valid: status === 'ok' },
    inputInspection: { status },
    resultInspection: { status },
    t: (key) => key,
  };
  const code = ts.transpileModule(`globalThis.element = (${expression});`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext },
    fileName: 'preview.tsx',
  }).outputText;
  runInNewContext(code, context);
  function find(element) {
    if (!element || typeof element !== 'object') return null;
    if (element.type === JsonTablePreview) return element;
    return [element.props?.children].flat().map(find).find(Boolean) ?? null;
  }
  return find(context.element);
}

test('切走和等待重新检测时，输入及结果表格的展开状态宿主不卸载', () => {
  assert.equal(tablePreviews.length, 2);
  for (const expression of tablePreviews) {
    for (const [active, status] of [
      [false, 'idle'],
      [true, 'pending'],
      [true, 'ok'],
    ]) {
      const element = tablePreviewElement(expression, active, status);
      assert.ok(element, `active=${active}, status=${status}`);
      assert.equal(element.props.active, active && status === 'ok');
    }
  }
});

test('实际预览和单元格函数在隐藏、等待检测及数据重解析后仍读取同一展开记录', () => {
  const tableSource = ts.createSourceFile(
    'JsonTablePreview.tsx',
    readFileSync(new URL('./JsonTablePreview.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functions = tableSource.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        ['ValueCell', 'ContainerCell', 'JsonTablePreview', 'scalar', 'stopToggle'].includes(
          node.name?.text,
        ),
    )
    .map((node) => node.getText(tableSource).replace(/^export /, ''))
    .join('\n');
  let state;
  let currentTimeFormat = 'none';
  const context = {
    React: { createElement },
    createJsonTableExpansion,
    formatJsonTimeValue,
    isContainer: (value) => value !== null && typeof value === 'object',
    // 仅替换 Hook 调度；执行的状态归属、快照读取和点击逻辑均来自实际组件。
    useState: (initialize) => [(state ??= initialize())],
    useContext: (ctx) => (ctx === context.TimeFormatContext ? currentTimeFormat : state),
    useCallback: (callback) => callback,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    ExpansionContext: { Provider: 'provider' },
    TimeFormatContext: { Provider: 'time-format' },
    TableCell: 'td',
    TableValue: 'table-value',
    NestedValue: 'nested-value',
  };
  const code = ts.transpileModule(
    `${functions}\nglobalThis.api = { ValueCell, ContainerCell, JsonTablePreview };`,
    {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext },
      fileName: 'preview.tsx',
    },
  ).outputText;
  runInNewContext(code, context);
  const { ValueCell, ContainerCell, JsonTablePreview } = context.api;
  const props = { value: { object: { child: 1 } }, t: (key) => key, timeFormat: 'none' };
  const preview = JsonTablePreview({ ...props, active: true });
  const cellProps = { value: props.value.object, t: props.t, path: '/object', depth: 0 };
  const collapsed = ContainerCell(cellProps);
  assert.equal(collapsed.props.children.props.expanded, false);
  collapsed.props.onClick({ stopPropagation() {} });
  assert.equal(ContainerCell(cellProps).props.children.props.expanded, true);

  assert.equal(JsonTablePreview({ ...props, active: false }), null);
  assert.equal(JsonTablePreview({ ...props, value: null, active: false }), null);
  const restored = JsonTablePreview({
    ...props,
    value: JSON.parse(JSON.stringify(props.value)),
    active: true,
    timeFormat: 'iso',
  });
  assert.equal(restored.props.value, preview.props.value);
  currentTimeFormat = 'iso';
  const timestamp = 1704164645123;
  const timeCell = ValueCell({ value: timestamp, t: props.t, path: '/time', fieldKey: 'time' });
  assert.equal(timeCell.props.children, '2024-01-02T03:04:05.123Z');
  assert.equal(timeCell.props.title, String(timestamp));
  const plainCell = ValueCell({ value: timestamp, t: props.t, path: '/id', fieldKey: 'id' });
  assert.equal(plainCell.props.children.props.children, String(timestamp));
  const remounted = ContainerCell({ ...cellProps, value: { child: 1 } });
  assert.equal(remounted.props.children.props.expanded, true);
  remounted.props.onClick({ stopPropagation() {} });
  assert.equal(ContainerCell(cellProps).props.children.props.expanded, false);
});
