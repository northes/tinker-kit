import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { normalizeRemotePath } from './paths.ts';

// 执行实际事件函数，隔离原生表单与 Wails 调度，不复制业务逻辑。
function loadAction(file, name, context) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let action;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      action = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(action, name);
  const code = ts.transpileModule(`globalThis.action = (${action.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  runInNewContext(code, context);
  return context.action;
}

function browserContext() {
  const calls = { file: [], folder: [], reload: [], reset: 0, toast: [] };
  const prefix = 'source\0profile\0fingerprint\0';
  const context = {
    sourceID: 'source',
    activeSourceProfileID: 'profile',
    profileListingKey: 'fingerprint',
    currentPath: '/home',
    showHidden: false,
    sourceUsable: true,
    isLoading: false,
    creationViewKeyRef: { current: 'view' },
    createEntryTarget: null,
    normalizeRemotePath,
    t: (key) => key,
    directoryCache: new Map([
      [prefix + '/home\0false', { path: '/home' }],
      [prefix + '/home\0true', { path: '/home' }],
      [prefix + '/other\0false', { path: '/other' }],
      ['other-source\0/home', { path: '/home' }],
    ]),
    setCreateEntryTarget: (target) => {
      context.createEntryTarget = target;
    },
    CreateRemoteTextFile: async (...args) => {
      calls.file.push(args);
    },
    CreateRemoteDirectory: async (...args) => {
      calls.folder.push(args);
    },
    loadDirectory: async (...args) => {
      calls.reload.push(args);
    },
    resetSearchState: () => {
      calls.reset++;
    },
    toast: { add: (message) => calls.toast.push(message) },
  };
  return {
    context,
    calls,
    request: loadAction('../SshFilesTool.tsx', 'requestCreateEntry', context),
    execute: loadAction('../SshFilesTool.tsx', 'executeCreateEntry', context),
  };
}

test('空白菜单新建文件调用文本接口并刷新当前目录，文件夹沿用同一创建流程', async () => {
  for (const kind of ['file', 'folder']) {
    const { context, calls, request, execute } = browserContext();
    request(kind);
    assert.equal(context.createEntryTarget.kind, kind);
    await execute('notes.txt');
    assert.deepEqual(calls[kind], [['source', '/home/notes.txt']]);
    assert.equal(calls[kind === 'file' ? 'folder' : 'file'].length, 0);
    assert.deepEqual(calls.reload, [['source', '/home', false, true]]);
    assert.equal(calls.reset, 1);
    assert.equal(context.directoryCache.size, 2);
    assert.equal(
      calls.toast[0].title,
      kind === 'file' ? 'sshFilesTool.fileCreated' : 'sshFilesTool.folderCreated',
    );
  }
});

test('失败不清空缓存、不刷新目录，错误交给创建弹窗展示', async () => {
  const { context, calls, request, execute } = browserContext();
  request('file');
  context.CreateRemoteTextFile = async () => {
    throw new Error('permission denied');
  };
  await assert.rejects(execute('notes.txt'), /permission denied/);
  assert.equal(context.directoryCache.size, 4);
  assert.equal(calls.reload.length, 0);
  assert.equal(calls.toast.length, 0);
});

test('提交前上下文已变化时不创建文件，加载中不能打开创建弹窗', async () => {
  const { context, calls, request, execute } = browserContext();
  context.isLoading = true;
  request('file');
  assert.equal(context.createEntryTarget, null);
  context.isLoading = false;
  request('file');
  context.creationViewKeyRef.current = 'another-view';
  await assert.rejects(execute('notes.txt'), /createContextChanged/);
  assert.equal(calls.file.length, 0);
});

test('异步完成后不跳回旧来源或旧目录，但仍失效原目录缓存', async () => {
  const { context, calls, request, execute } = browserContext();
  request('file');
  context.CreateRemoteTextFile = async () => {
    context.creationViewKeyRef.current = 'another-view';
  };
  await execute('notes.txt');
  assert.equal(calls.reload.length, 0);
  assert.equal(calls.reset, 0);
  assert.equal(context.directoryCache.size, 2);
});

function dialogContext(name, onCreate = async () => {}) {
  const context = {
    name,
    creating: false,
    isFile: true,
    error: '',
    closed: false,
    t: (key) => key,
    errorMessage: (reason) => reason.message,
    onCreate,
    onClose: () => {
      context.closed = true;
    },
    setCreating: (value) => {
      context.creating = value;
    },
    setError: (value) => {
      context.error = value;
    },
  };
  return { context, create: loadAction('./CreateEntryDialog.tsx', 'create', context) };
}

test('文件名为空、越级、带路径或空字符时不发请求', async () => {
  for (const name of ['', ' ', '.', '..', 'a/b', 'a\\b', 'bad\0name']) {
    const { context, create } = dialogContext(name, async () => assert.fail('不应创建无效文件名'));
    await create();
    assert.ok(context.error, name);
    assert.equal(context.closed, false);
  }
});

test('纯文本文件名不被追加扩展名，失败后保留名称与错误以供重试', async () => {
  let createdName;
  const success = dialogContext('  notes  ', async (name) => {
    createdName = name;
  });
  await success.create();
  assert.equal(createdName, 'notes');
  assert.equal(success.context.closed, true);
  const failure = dialogContext('notes.txt', async () => {
    throw new Error('target exists');
  });
  await failure.create();
  assert.equal(failure.context.name, 'notes.txt');
  assert.equal(failure.context.error, 'target exists');
  assert.equal(failure.context.creating, false);
  assert.equal(failure.context.closed, false);
});
