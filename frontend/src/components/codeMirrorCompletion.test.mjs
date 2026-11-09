import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete';
import { EditorState, Prec } from '@codemirror/state';
import { keymap, runScopeHandlers, tooltips } from '@codemirror/view';
import ts from 'typescript';
import { DialogStore } from '../../node_modules/@base-ui/react/dialog/store/DialogStore.js';
import { createChangeEventDetails } from '../../node_modules/@base-ui/react/internals/createBaseUIEventDetails.js';

function loadExpression(path, predicate, context) {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let expression;
  function visit(node) {
    if (predicate(node, source)) expression = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, path);
  const code = ts.transpileModule(
    `globalThis.action = (${expression.getText(source).replace(/^export\s+/, '')});`,
    {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    },
  ).outputText;
  runInNewContext(code, context);
  return context.action;
}

// 使用实际 CodeMirror 状态与键位调度，并重放 Base UI 的 Esc 关闭处理；无需 DOM。
function editorDialog(dirty = true, overrides = {}) {
  let discardOpen = false;
  let closed = false;
  const context = {
    acceptCompletion,
    autocompletion,
    closeCompletion,
    completionStatus,
    Prec,
    keymap,
    tooltips,
    consumedEscapes: { current: new WeakSet() },
    document: { body: {} },
    saving: false,
    formatting: false,
    dirty,
    discardOpen: false,
    viewRef: { current: null },
    ...overrides,
    setDiscardOpen: (open) => {
      discardOpen = open;
      context.discardOpen = open;
    },
    onClose: () => {
      closed = true;
    },
  };
  const extensions = loadExpression(
    './codeMirrorCompletion.ts',
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'editorCompletions',
    context,
  );
  context.requestClose = loadExpression(
    './RemoteTextEditorDialog.tsx',
    (node, source) =>
      ts.isArrowFunction(node) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.name.getText(source) === 'requestClose',
    context,
  );
  const onOpenChange = loadExpression(
    './RemoteTextEditorDialog.tsx',
    (node, source) =>
      ts.isArrowFunction(node) &&
      ts.isJsxExpression(node.parent) &&
      ts.isJsxAttribute(node.parent.parent) &&
      node.parent.parent.name.text === 'onOpenChange' &&
      node.parent.parent.parent.parent.tagName.getText(source) === 'Dialog',
    context,
  );
  const store = new DialogStore({ open: true }, 'remote-editor', false);
  store.context.onOpenChange = onOpenChange;
  const dismiss = loadExpression(
    '../../node_modules/@base-ui/react/floating-ui-react/hooks/useDismiss.js',
    (node) =>
      ts.isArrowFunction(node) &&
      ts.isCallExpression(node.parent) &&
      ts.isVariableDeclaration(node.parent.parent) &&
      node.parent.parent.name.text === 'closeOnEscapeKeyDown',
    {
      open: true,
      enabled: true,
      escapeKey: true,
      escapeKeyBubbles: false,
      isComposingRef: { current: false },
      hasBlockingChild: () => false,
      _event: { isReactEvent: () => false },
      _reasons: { REASONS: { escapeKey: 'escape-key' } },
      _createBaseUIEventDetails: { createChangeEventDetails },
      store,
    },
  );
  const view = {
    state: EditorState.create({
      doc: 'ex',
      selection: { anchor: 2 },
      extensions: extensions({ override: [() => ({ from: 0, options: [{ label: 'example' }] })] }),
    }),
    dispatch(spec) {
      this.state = this.state.update(spec).state;
    },
  };
  context.viewRef.current = view;
  return {
    view,
    store,
    dismiss,
    requestDismiss(reason, event = {}) {
      const details = createChangeEventDetails(reason, {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...event,
      });
      store.setOpen(false, details);
      return details;
    },
    press(key = 'Escape') {
      const event = {
        key,
        keyCode: key === 'Escape' ? 27 : 9,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
      };
      const handled = runScopeHandlers(view, event, 'editor');
      if (handled) event.preventDefault();
      if (!event.propagationStopped) dismiss(event);
      return { handled, event };
    },
    get discardOpen() {
      return discardOpen;
    },
    get closed() {
      return closed;
    },
  };
}

test('补全已开启时第一次 Esc 只关闭补全，第二次才询问是否放弃修改', () => {
  const dialog = editorDialog();
  assert.equal(startCompletion(dialog.view), true);
  assert.notEqual(completionStatus(dialog.view.state), null);
  const first = dialog.press();
  assert.equal(completionStatus(dialog.view.state), null);
  assert.equal(dialog.discardOpen, false, '关闭补全的同一次 Esc 不应触发放弃修改确认');
  assert.equal(first.handled, true);
  assert.equal(first.event.propagationStopped, true);
  dialog.press();
  assert.equal(dialog.discardOpen, true);
});

test('未开启补全时 Esc 保留有修改确认、无修改直接关闭的行为', () => {
  const dirty = editorDialog();
  dirty.press();
  assert.equal(dirty.discardOpen, true);
  assert.equal(dirty.closed, false);
  assert.equal(dirty.store.state.open, true, '等待放弃修改确认时，编辑器本身必须保持打开');
  const clean = editorDialog(false);
  clean.press();
  assert.equal(clean.discardOpen, false);
  assert.equal(clean.closed, true);
});

test('Dialog 直接收到 Esc 时也必须先关闭补全，干净文件不能被直接关闭', () => {
  for (const dirty of [false, true]) {
    const dialog = editorDialog(dirty);
    startCompletion(dialog.view);
    const details = dialog.requestDismiss('escape-key');
    assert.equal(completionStatus(dialog.view.state), null);
    assert.equal(details.isCanceled, true);
    assert.equal(dialog.store.state.open, true);
    assert.equal(dialog.closed, false);
    assert.equal(dialog.discardOpen, false);
  }
});

test('已被编辑器消费或长按重复的 Esc 不关闭编辑器', () => {
  for (const event of [{ defaultPrevented: true }, { repeat: true }]) {
    const dialog = editorDialog(false);
    dialog.requestDismiss('escape-key', event);
    assert.equal(dialog.store.state.open, true);
    assert.equal(dialog.closed, false);
  }
});

test('点击背景时先显示确认，确认存在期间编辑器保持打开', () => {
  const dialog = editorDialog();
  dialog.requestDismiss('outside-press');
  assert.equal(dialog.discardOpen, true);
  assert.equal(dialog.store.state.open, true);
  dialog.press();
  assert.equal(dialog.store.state.open, true);
  assert.equal(dialog.closed, false);
});

test('保存或格式化期间 Esc 不能改变编辑器的真实打开状态', () => {
  for (const busy of ['saving', 'formatting']) {
    const dialog = editorDialog(true, { [busy]: true });
    dialog.press();
    assert.equal(dialog.discardOpen, false);
    assert.equal(dialog.closed, false);
    assert.equal(dialog.store.state.open, true);
  }
});

test('没有可接受的补全时 Tab 仍交还原有缩进或焦点导航', () => {
  const dialog = editorDialog();
  const { handled, event } = dialog.press('Tab');
  assert.equal(handled, false);
  assert.equal(event.propagationStopped, false);
  assert.equal(dialog.discardOpen, false);
});
