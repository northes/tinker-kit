import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const name of [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'DocumentFragment',
  'Event',
  'KeyboardEvent',
  'CompositionEvent',
  'MouseEvent',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? dom.window : dom.window[name],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});

const require = createRequire(import.meta.url);
const React = require('react');
const { act, createElement, forwardRef } = React;
const { createRoot } = require('react-dom/client');
const componentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(componentDir, '..');
const modules = new Map();

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
    if (id === '@phosphor-icons/react') {
      return new Proxy(
        {},
        {
          get: () => forwardRef((props, ref) => createElement('svg', { ...props, ref })),
        },
      );
    }
    if (id === 'react-i18next') return { useTranslation: () => ({ t: (key) => key }) };
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

const { ToolSearchField } = loadModule(resolve(componentDir, 'shared.tsx'));

function pressEnter(input, { isComposing = false, keyCode = 13 } = {}) {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    isComposing,
  });
  Object.defineProperty(event, 'keyCode', { get: () => keyCode });
  Object.defineProperty(event, 'isComposing', { get: () => isComposing });
  input.dispatchEvent(event);
}

async function mount(value = '测试') {
  const submitted = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(ToolSearchField, {
        value,
        onValueChange() {},
        onSubmit(next) {
          submitted.push(next);
        },
      }),
    );
  });
  const input = host.querySelector('input');
  assert.ok(input);
  return {
    input,
    submitted,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

after(() => {
  dom.window.close();
});

test('有内容时不渲染清空按钮，Esc 也不改内容', async () => {
  const changes = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(ToolSearchField, {
        value: 'json',
        onValueChange(next) {
          changes.push(next);
        },
      }),
    );
  });
  const input = host.querySelector('input');
  assert.ok(input);
  assert.equal(host.querySelector('button'), null);
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.deepEqual(changes, []);
  assert.equal(input.value, 'json');
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test('普通回车提交当前搜索词', async () => {
  const view = await mount('json');
  await act(async () => {
    pressEnter(view.input);
  });
  assert.deepEqual(view.submitted, ['json']);
  await view.unmount();
});

test('输入法组合中的回车只上屏，不提交', async () => {
  const view = await mount('ceshi');
  await act(async () => {
    pressEnter(view.input, { isComposing: true, keyCode: 229 });
    pressEnter(view.input, { isComposing: false, keyCode: 229 });
  });
  assert.deepEqual(view.submitted, []);
  await act(async () => {
    pressEnter(view.input);
  });
  assert.deepEqual(view.submitted, ['ceshi']);
  await view.unmount();
});

test('WebKit 在 compositionend 之后补发的回车仍然只上屏', async () => {
  const view = await mount('测试');
  await act(async () => {
    view.input.dispatchEvent(
      new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '测试' }),
    );
    // 同一次按键处理里同步补发，isComposing 已经是 false。
    pressEnter(view.input, { isComposing: false, keyCode: 13 });
  });
  assert.deepEqual(view.submitted, []);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    pressEnter(view.input, { isComposing: false, keyCode: 13 });
  });
  assert.deepEqual(view.submitted, ['测试']);
  await view.unmount();
});
