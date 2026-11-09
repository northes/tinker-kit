import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'Window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'DocumentFragment',
  'ShadowRoot',
  'MutationObserver',
  'DOMRect',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? dom.window : dom.window[name],
  });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = dom.window.ResizeObserver = ResizeObserver;
Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' });
Object.defineProperty(dom.window.navigator, 'userAgent', {
  value:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

const domErrors = [];
dom.window.addEventListener('error', (event) => {
  domErrors.push(event.error);
});
afterEach(() => {
  assert.deepEqual(domErrors, [], '真实组件运行时不能产生未处理错误');
});
after(() => {
  dom.window.close();
});

const require = createRequire(import.meta.url);
const React = require('react');
const { act, createElement, forwardRef } = React;
const { createRoot } = require('react-dom/client');
const { EditorView } = require('@codemirror/view');
const { startCompletion, closeCompletion, completionStatus } = require('@codemirror/autocomplete');
const componentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(componentDir, '..');
const modules = new Map();
const t = (key) => key;
let initialContent = 'alphaValue alphaOther\nal';
const services = {
  ReadRemoteTextFile: () =>
    Object.assign(Promise.resolve({ content: initialContent, revision: 'original' }), {
      cancel: () => Promise.resolve(),
    }),
  SaveRemoteTextFile: async () => 'saved',
};

// 挂载真实 React、CodeMirror、Base UI Dialog 和 ConfirmDialog；仅隔离后端与无布局能力的滚动外壳。
function loadModule(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (id) => {
    if (id.endsWith('.css')) return {};
    if (id.includes('bindings/tinkerkit/fileservice')) return services;
    if (id === 'react-i18next') return { ...require(id), useTranslation: () => ({ t }) };
    if (id === '@phosphor-icons/react')
      return new Proxy(
        {},
        {
          get: () =>
            forwardRef(({ weight, size, children, ...props }, ref) =>
              createElement('svg', { ...props, ref }, children),
            ),
        },
      );
    if (id.endsWith('/ui/toast')) return { toast: { add() {} } };
    if (id.endsWith('/lib/backend-error')) return { formatBackendError: String };
    if (id.endsWith('/ui/scroll-area'))
      return {
        ScrollArea: forwardRef(({ children, className }, ref) =>
          createElement('div', { ref, className }, children),
        ),
      };
    if (!id.startsWith('.') && !id.startsWith('@/')) return require(id);
    const base = id.startsWith('@/') ? resolve(srcDir, id.slice(2)) : resolve(dirname(file), id);
    if (id.endsWith('.json')) return require(base);
    const target = ['.tsx', '.ts', '.js'].map((ext) => base + ext).find(existsSync);
    assert.ok(target, `无法解析 ${id}`);
    return loadModule(target);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}
const { RemoteTextEditorDialog } = loadModule(resolve(componentDir, 'RemoteTextEditorDialog.tsx'));

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '等待实际组件状态超时');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}
async function mountEditor({ dirty = false } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closed = 0;
  await act(async () => {
    root.render(
      createElement(
        React.StrictMode,
        null,
        createElement(RemoteTextEditorDialog, {
          sourceID: 'source',
          path: '/notes.txt',
          name: 'notes.txt',
          onClose: () => {
            closed++;
          },
          onSaved() {},
        }),
      ),
    );
  });
  await waitFor(() => document.querySelector('.cm-content'));
  const content = document.querySelector('.cm-content');
  const view = EditorView.findFromDOM(content);
  assert.ok(view);
  await act(async () => {
    view.focus();
    view.dispatch({
      selection: { anchor: view.state.doc.length + (dirty ? 1 : 0) },
      ...(dirty ? { changes: { from: view.state.doc.length, insert: 'p' } } : {}),
    });
    closeCompletion(view);
  });
  return {
    view,
    get closed() {
      return closed;
    },
    async complete() {
      await act(async () => {
        startCompletion(view);
      });
      await waitFor(
        () =>
          completionStatus(view.state) === 'active' &&
          document.querySelector('.cm-tooltip-autocomplete'),
      );
    },
    async escape({ repeat = false, release = true, propagateToDocument = false } = {}) {
      const event = new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        repeat,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        document.activeElement.dispatchEvent(event);
      });
      if (propagateToDocument) {
        // 即使捕获阶段已 stopPropagation，也再投递一次，验证 Dialog 对同一事件的拒绝。
        await act(async () => {
          document.dispatchEvent(event);
        });
      }
      if (release) {
        await act(async () => {
          document.activeElement.dispatchEvent(
            new dom.window.KeyboardEvent('keyup', {
              key: 'Escape',
              code: 'Escape',
              keyCode: 27,
              bubbles: true,
            }),
          );
        });
      }
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      return event;
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}
const openDialogs = () => [...document.querySelectorAll('[role="dialog"][data-open]')];
const discardDialog = () =>
  openDialogs().find((node) => node.textContent.includes('sshFilesTool.discardTextTitle'));

test('真实 DOM：补全打开时 Esc 仅关闭补全，干净和未保存文件都保留编辑器', async () => {
  for (const dirty of [false, true]) {
    const editor = await mountEditor({ dirty });
    try {
      await editor.complete();
      await editor.escape();
      assert.equal(document.querySelector('.cm-tooltip-autocomplete'), null);
      assert.equal(discardDialog(), undefined);
      assert.equal(openDialogs().length, 1);
      assert.equal(editor.closed, 0);
    } finally {
      await editor.unmount();
    }
  }
});

test('真实 DOM：同一次长按 Esc 的重复 keydown 不能关掉刚打开的确认框', async () => {
  const editor = await mountEditor({ dirty: true });
  try {
    await editor.escape({ release: false });
    assert.ok(discardDialog());
    await editor.escape({ repeat: true });
    assert.ok(discardDialog(), '长按 Esc 的同一次按键不能让确认框闪退');
    assert.equal(editor.closed, 0);
  } finally {
    await editor.unmount();
  }
});

test('真实 DOM：确认框不能重复消费打开它的同一个原生 Esc 事件', async () => {
  const editor = await mountEditor({ dirty: true });
  try {
    const event = await editor.escape();
    assert.ok(discardDialog());
    await act(async () => {
      document.activeElement.dispatchEvent(event);
    });
    assert.ok(discardDialog(), '重新进入另一条监听路径的同一事件不能关闭确认框');
    assert.equal(editor.closed, 0);
  } finally {
    await editor.unmount();
  }
});

test('真实 DOM：关闭补全的 Esc 泄漏到 document 监听时也不能打开确认框', async () => {
  const editor = await mountEditor({ dirty: true });
  try {
    await editor.complete();
    // 捕获阶段之后同一原生事件继续到达 document 级监听，模拟 stopPropagation 未生效。
    const event = await editor.escape({ propagateToDocument: true, release: false });
    assert.equal(document.querySelector('.cm-tooltip-autocomplete'), null);
    assert.equal(discardDialog(), undefined, '补全关闭时不能同时弹出未保存确认');
    assert.equal(openDialogs().length, 1);
    assert.equal(editor.closed, 0);
    await act(async () => {
      document.dispatchEvent(event);
    });
    assert.equal(discardDialog(), undefined);
    assert.equal(editor.closed, 0);
  } finally {
    await editor.unmount();
  }
});

test('真实 DOM：脏文件按 Esc 后确认框稳定打开，下一次 Esc 只取消确认', async () => {
  const editor = await mountEditor({ dirty: true });
  try {
    await editor.escape();
    assert.ok(discardDialog(), '第一次 Esc 后确认框不能闪退');
    assert.equal(openDialogs().length, 2);
    assert.equal(editor.closed, 0);
    await editor.escape();
    assert.equal(discardDialog(), undefined);
    assert.equal(openDialogs().length, 1);
    assert.equal(editor.closed, 0);
  } finally {
    await editor.unmount();
  }
});
