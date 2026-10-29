import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import ts from 'typescript';

function parseFile(path, kind) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
}

function findNode(source, predicate) {
  let found;
  function visit(node) {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found);
  return found;
}

const componentSource = parseFile('./TextTool.tsx', ts.ScriptKind.TSX);
const component = findNode(
  componentSource,
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'AffixHistoryCombobox',
);
// 执行依赖实际的浮层关闭回调，覆盖关闭时从选中值回填输入框的行为。
const baseSource = parseFile(
  '../../node_modules/@base-ui/react/combobox/root/AriaCombobox.js',
  ts.ScriptKind.JS,
);
const closeCallback = findNode(
  baseSource,
  (node) => ts.isVariableDeclaration(node) && node.name.getText(baseSource) === 'handleUnmount',
).initializer.arguments[0];

function field(entries = [], initialValue = '') {
  let input = initialValue;
  const context = {
    React: { createElement },
    useTranslation: () => ({ t: (key) => key }),
    Button: 'button',
    Trash: 'svg',
    ScrollableText: 'div',
    ...Object.fromEntries(
      [
        'Combobox',
        'ComboboxInput',
        'ComboboxContent',
        'ComboboxList',
        'ComboboxItem',
        'ComboboxEmpty',
      ].map((name) => [name, name]),
    ),
  };
  const code = ts.transpileModule(
    `${component.getText(componentSource)}\nglobalThis.render = AffixHistoryCombobox;`,
    {
      compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
    },
  ).outputText;
  runInNewContext(code, context);
  const render = () =>
    context.render({
      id: 'affix',
      label: '字符',
      value: input,
      entries,
      onChange: (next) => {
        input = next;
      },
      onDelete() {},
    }).props;
  return {
    type(next) {
      render().onInputValueChange(next);
    },
    select(next) {
      render().onValueChange(next);
    },
    removeHistory() {
      entries = [];
    },
    close() {
      const props = render();
      const noOp = () => {};
      runInNewContext(`(${closeCallback.getText(baseSource)})()`, {
        setMounted: noOp,
        onOpenChangeComplete: noOp,
        setQueryChangedAfterOpen: noOp,
        setCloseQuery: noOp,
        setIndices: noOp,
        selectionMode: 'single',
        single: true,
        multiple: false,
        store: { state: { inputInsidePopup: false } },
        inputRef: { current: { value: input } },
        selectedValue: props.value,
        itemToStringLabel: undefined,
        _resolveValueLabel: { stringifyAsLabel: (value) => value ?? '' },
        _createBaseUIEventDetails: { createChangeEventDetails: (reason) => ({ reason }) },
        _reasons: { REASONS: { inputClear: 'input-clear', none: 'none' } },
        setInputValue: (next) => props.onInputValueChange(next),
      });
    },
    get value() {
      return input;
    },
  };
}

test('首次输入任意字符后关闭下拉框仍保留输入，含空格和中文', () => {
  for (const value of ['新字符', '  ', '$&\\']) {
    const input = field();
    input.type(value);
    input.close();
    assert.equal(input.value, value);
  }
});

test('修改已有历史值后，关闭下拉框保留新文字', () => {
  const input = field(['旧字符'], '旧字符');
  input.type('旧字符加新字符');
  input.close();
  assert.equal(input.value, '旧字符加新字符');
});

test('选择历史值后同步回填，历史项变化不会清除当前输入', () => {
  const input = field(['历史字符']);
  input.select('历史字符');
  assert.equal(input.value, '历史字符');
  input.removeHistory();
  input.close();
  assert.equal(input.value, '历史字符');
});

test('手动删除全部文字后，关闭下拉框保持空值', () => {
  const input = field(['旧字符'], '旧字符');
  input.type('');
  input.close();
  assert.equal(input.value, '');
});
