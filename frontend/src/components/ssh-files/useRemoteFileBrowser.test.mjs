import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('./useRemoteFileBrowser.ts', import.meta.url);
const source = ts.createSourceFile(
  file.pathname,
  readFileSync(file, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

// 执行实际搜索动作和事件消费者，仅隔离 React 状态调度与 Wails 传输。
function browserContext() {
  const calls = [];
  const context = {
    crypto: { randomUUID },
    sourceUsable: true,
    sourceID: 'source',
    currentPath: '/home',
    showHidden: false,
    searchMode: 'name',
    searchScope: 'recursive',
    searching: false,
    searchInput: '',
    entries: [],
    error: '',
    sourcesRequestRef: { current: 0 },
    directoryRequestRef: { current: 0 },
    searchRequestRef: { current: 0 },
    activeSearchIDRef: { current: '' },
    searchCallRef: { current: null },
    loadingKindRef: { current: null },
    loadingCallsRef: { current: new Set() },
    directoryLoadKeyRef: { current: '' },
    useCallback: (callback) => callback,
    errorMessage: (reason) => reason.message,
    SearchRemoteFiles: (...args) => {
      let resolve;
      let reject;
      const request = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const call = { args, resolve, reject, canceled: false };
      request.cancel = () => {
        // 允许旧调用迟到返回，验证取消之外的修订号保护。
        call.canceled = true;
        return Promise.resolve();
      };
      calls.push(call);
      return request;
    },
  };
  for (const state of [
    'Entries',
    'Selected',
    'LoadingCanceled',
    'SearchInput',
    'SearchQuery',
    'SearchActive',
    'Searching',
    'Loading',
    'Error',
    'LoadingSources',
  ]) {
    const key = state[0].toLowerCase() + state.slice(1);
    context[`set${state}`] = (value) => {
      context[key] = typeof value === 'function' ? value(context[key]) : value;
    };
  }
  const actions = new Map();
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ['executeSearch', 'cancelLoading', 'resetSearchState'].includes(node.name.getText(source))
    ) {
      actions.set(node.name.getText(source), node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'Events.On' &&
      node.arguments[0]?.text === 'ssh-files:search-results'
    ) {
      actions.set('receive', node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [name, action] of actions) {
    const code = ts.transpileModule(`globalThis.${name} = (${action.getText(source)});`, {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).outputText;
    runInNewContext(code, context);
  }
  assert.equal(actions.size, 4);
  const receive = (call, entries) =>
    context.receive({ data: { requestID: call.args.at(-1), entries } });
  return { context, calls, receive };
}

const paths = (context) => Array.from(context.entries, (entry) => entry.path);

function listingContext() {
  const componentFile = new URL('../SshFilesTool.tsx', import.meta.url);
  const component = ts.createSourceFile(
    componentFile.pathname,
    readFileSync(componentFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = [
    'activeSearchSort',
    'activeSortKey',
    'activeSortDirection',
    'sortedEntries',
    'changeSort',
  ];
  const actions = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(component)))
      actions.set(node.name.getText(component), node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(component);
  const context = {
    entries: [
      { path: '/z', name: 'z', isDir: false },
      { path: '/a', name: 'a', isDir: false },
    ],
    searchActive: true,
    searching: false,
    searchRevision: 1,
    searchSort: null,
    sortKey: 'name',
    sortDirection: 'desc',
    i18n: { language: 'zh-CN' },
    sizeValues: {},
    useMemo: (factory) => factory(),
    setSearchSort: (sort) => {
      context.searchSort = sort;
    },
    setSortKey: (key) => {
      context.sortKey = key;
    },
    setSortDirection: (direction) => {
      context.sortDirection = direction;
    },
  };
  const render = () => {
    for (const name of names) {
      const action = actions.get(name);
      assert.ok(action, name);
      const code = ts.transpileModule(`globalThis.${name} = (${action.getText(component)});`, {
        compilerOptions: { target: ts.ScriptTarget.ESNext },
      }).outputText;
      runInNewContext(code, context);
    }
    return Array.from(context.sortedEntries, (entry) => entry.path);
  };
  return { context, render };
}

test('列表默认保留搜索发现顺序，只有显式选择列排序时才重排', () => {
  const { context, render } = listingContext();
  assert.deepEqual(render(), ['/z', '/a']);
  context.changeSort('name');
  assert.deepEqual(render(), ['/a', '/z']);
});

test('快速完成的新搜索不沿用上一次手动排序，搜索排序不改变目录排序', () => {
  const { context, render } = listingContext();
  render();
  context.changeSort('name');
  assert.deepEqual(render(), ['/a', '/z']);
  // 直接渲染终态，覆盖 React 将 searching=true/false 合并而不运行中间 effect 的情况。
  context.searchRevision++;
  assert.deepEqual(render(), ['/z', '/a']);
  context.searchActive = false;
  assert.deepEqual(render(), ['/z', '/a']);
  assert.equal(context.sortDirection, 'desc');
});

test('搜索未结束时逐批展示并追加到末尾，最终响应补齐结果且忽略迟到事件', async () => {
  const { context, calls, receive } = browserContext();
  const done = context.executeSearch('needle');
  const call = calls[0];
  receive(call, [{ path: '/z' }]);
  assert.deepEqual(paths(context), ['/z']);
  assert.equal(context.searching, true);
  receive(call, [{ path: '/a' }]);
  assert.deepEqual(paths(context), ['/z', '/a']);
  call.resolve([{ path: '/z' }, { path: '/a' }, { path: '/last' }]);
  await done;
  assert.deepEqual(paths(context), ['/z', '/a', '/last']);
  assert.equal(context.searching, false);
  receive(call, [{ path: '/late' }]);
  assert.deepEqual(paths(context), ['/z', '/a', '/last']);
});

test('取消保留已展示结果，旧批次与旧响应不能污染重试搜索', async () => {
  const { context, calls, receive } = browserContext();
  const first = context.executeSearch('first');
  receive(calls[0], [{ path: '/first' }]);
  context.cancelLoading();
  assert.equal(calls[0].canceled, true);
  assert.equal(context.loadingCanceled, 'search');
  assert.deepEqual(paths(context), ['/first']);
  receive(calls[0], [{ path: '/late' }]);
  assert.deepEqual(paths(context), ['/first']);
  const second = context.executeSearch('second');
  assert.notEqual(calls[0].args.at(-1), calls[1].args.at(-1));
  receive(calls[1], [{ path: '/second' }]);
  receive(calls[0], [{ path: '/old' }]);
  calls[0].resolve([{ path: '/old' }]);
  await first;
  assert.deepEqual(paths(context), ['/second']);
  assert.equal(context.searching, true);
  calls[1].resolve([{ path: '/second' }]);
  await second;
});

test('不同窗口的搜索事件互相隔离', async () => {
  const left = browserContext();
  const right = browserContext();
  const doneLeft = left.context.executeSearch('needle');
  const doneRight = right.context.executeSearch('needle');
  left.receive(right.calls[0], [{ path: '/other-window' }]);
  right.receive(left.calls[0], [{ path: '/other-window' }]);
  assert.deepEqual(paths(left.context), []);
  assert.deepEqual(paths(right.context), []);
  left.calls[0].resolve([]);
  right.calls[0].resolve([]);
  await Promise.all([doneLeft, doneRight]);
});

test('搜索失败保留部分结果并报告错误，清除搜索会取消在途调用', async () => {
  const { context, calls, receive } = browserContext();
  const failed = context.executeSearch('needle');
  receive(calls[0], [{ path: '/found' }]);
  calls[0].reject(new Error('permission denied'));
  await failed;
  assert.deepEqual(paths(context), ['/found']);
  assert.equal(context.error, 'permission denied');
  const next = context.executeSearch('next');
  context.resetSearchState();
  assert.equal(calls[1].canceled, true);
  assert.equal(context.searchActive, false);
  receive(calls[1], [{ path: '/stale' }]);
  calls[1].resolve([{ path: '/stale' }]);
  await next;
  assert.deepEqual(paths(context), []);
});
