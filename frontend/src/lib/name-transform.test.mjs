import assert from 'node:assert/strict';
import test from 'node:test';
import { transformName } from './name-transform.ts';
import { buildRenamePreview as filePreview } from '../components/ssh-files/rename.ts';
import { buildRenamePreview as imagePreview } from '../components/image-manager/rename.ts';
import { normalizeRemotePath, remoteParent } from '../components/ssh-files/paths.ts';

const form = (mode, patch = {}) => ({ mode, value: '-new', find: '', replacement: '', ...patch });
const entry = (path, isDir = false) => ({ path, isDir });
const image = (reference) => ({ reference });

test('基本重命名保留字面替换、全部匹配和空查找语义', () => {
  assert.equal(transformName('a.a', form('prefix')), '-newa.a');
  assert.equal(transformName('a.a', form('suffix')), 'a.a-new');
  assert.equal(transformName('a.a', form('replace', { find: '.', replacement: '$&' })), 'a$&a');
  assert.equal(transformName('aaa', form('replace', { find: 'a', replacement: 'b' })), 'bbb');
  assert.equal(transformName('aaa', form('replace', { replacement: 'b' })), 'aaa');
  assert.equal(transformName('aaa', form('custom', { value: '' })), '');
});

test('文件后缀位于扩展名前，目录和隐藏文件保留原有规则', () => {
  const paths = ['/a.txt', '/archive.tar.gz', '/folder.dir', '/.env'];
  const results = filePreview(
    paths,
    form('suffix'),
    paths.map((p) => entry(p, p === '/folder.dir')),
  );
  assert.deepEqual(
    results.map((r) => r.target),
    ['/a-new.txt', '/archive.tar-new.gz', '/folder.dir-new', '/.env-new'],
  );
  assert.ok(results.every((r) => r.status === 'ok'));
});

test('文件预览区分非法目标、重复目标、已有目标和未变化', () => {
  for (const value of ['.', '..', 'a/b', 'a\\b']) {
    assert.equal(
      filePreview(['/a'], form('custom', { value }), [entry('/a')])[0].status,
      'invalid',
    );
  }
  assert.equal(
    filePreview(['/a'], form('custom', { value: ' ' }), [entry('/a')])[0].status,
    'empty',
  );
  assert.equal(
    filePreview(['/a'], form('custom', { value: 'a' }), [entry('/a')])[0].status,
    'unchanged',
  );
  assert.deepEqual(
    filePreview(['/a', '/b'], form('custom', { value: 'c' }), []).map((r) => r.status),
    ['duplicate', 'duplicate'],
  );
  assert.equal(
    filePreview(['/a'], form('custom', { value: 'b' }), [entry('/b')])[0].status,
    'occupied',
  );
  assert.equal(
    filePreview(['/a', '/b'], form('prefix', { value: '' }), []).every(
      (r) => r.status === 'unchanged',
    ),
    true,
  );
});

test('镜像 Tag 重命名保留带端口的仓库名和空 Tag 回退', () => {
  const rows = [image('registry:5000/team/app:old')];
  const rename = { ...form('suffix'), scope: 'tag' };
  assert.deepEqual(imagePreview(rows, rename, true), [
    { source: rows[0].reference, target: 'registry:5000/team/app:old-new', status: 'ok' },
  ]);
  assert.equal(
    imagePreview(rows, { ...form('custom', { value: '' }), scope: 'tag' }, true)[0].status,
    'unchanged',
  );
});

test('镜像预览保留跨仓库限制和重复目标校验', () => {
  const rows = [image('team/app:v1'), image('team/app:v2')];
  assert.deepEqual(
    imagePreview(rows, { ...form('custom', { value: 'latest' }), scope: 'tag' }, true).map(
      (r) => r.status,
    ),
    ['duplicate', 'duplicate'],
  );
  const rename = { ...form('custom', { value: 'other/app:v1' }), scope: 'name' };
  assert.equal(imagePreview(rows.slice(0, 1), rename, true)[0].status, 'crossRepository');
  assert.equal(imagePreview(rows.slice(0, 1), rename, false)[0].status, 'ok');
});

test('远程路径保留根目录、父目录和点路径规范化', () => {
  assert.equal(normalizeRemotePath(' /a/./b/../c// '), '/a/c');
  assert.equal(normalizeRemotePath('../../'), '/');
  assert.equal(remoteParent('/a'), '/');
  assert.equal(remoteParent('/a/b/'), '/a');
});
