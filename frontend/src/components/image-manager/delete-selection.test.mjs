import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createImageDeleteItems,
  excludeImageDeleteTag,
  imageDeletePreview,
} from './delete-selection.ts';

const image = (id, repository, digest, tags = []) => ({
  id,
  repository,
  digest,
  tags,
  name: tags[0] ?? '',
});
const row = (image, reference = '') => ({
  key: reference || image.id,
  reference,
  tag: reference.split(':').at(-1) ?? '',
  image,
});

test('本机和 SSH 移除 Tag 时只排除对应行，保留同一镜像的其它所选 Tag', () => {
  const app = image('sha256:app', 'app', 'sha256:manifest', ['app:v1', 'app:v2']);
  for (const sourceKind of ['local', 'ssh']) {
    const items = createImageDeleteItems([row(app, 'app:v1'), row(app, 'app:v2')], sourceKind, [
      app,
    ]);
    const result = excludeImageDeleteTag(items, 'app:v1');
    assert.deepEqual([...result.removedKeys], ['app:v1']);
    assert.deepEqual(imageDeletePreview(result.items), {
      targets: [{ imageID: 'app:v2', expectedDigest: 'sha256:manifest' }],
      digests: ['sha256:manifest'],
      tags: ['app:v2'],
    });
    assert.deepEqual(imageDeletePreview(items).tags, ['app:v1', 'app:v2']);
  }
});

test('Registry 移除关联 Tag 时一起排除同仓库同 digest 的全部所选行', () => {
  const v1 = image('app-v1', 'app', 'sha256:shared', ['app:v1']);
  const v2 = image('app-v2', 'app', 'sha256:shared', ['app:v2']);
  const stable = image('app-stable', 'app', 'sha256:shared', ['app:stable']);
  const other = image('other-v1', 'other', 'sha256:shared', ['other:v1']);
  const otherStable = image('other-stable', 'other', 'sha256:shared', ['other:stable']);
  const images = [v1, v2, stable, other, otherStable];
  const items = createImageDeleteItems(
    [row(v1, 'app:v1'), row(v2, 'app:v2'), row(other, 'other:v1')],
    'registry',
    images,
  );
  assert.deepEqual(imageDeletePreview(items).tags, ['app:stable', 'other:stable']);
  const result = excludeImageDeleteTag(items, 'app:stable');
  assert.deepEqual([...result.removedKeys], ['app:v1', 'app:v2']);
  assert.deepEqual(imageDeletePreview(result.items), {
    targets: [{ imageID: 'other:v1', expectedDigest: 'sha256:shared' }],
    digests: ['sha256:shared'],
    tags: ['other:stable'],
  });
});

test('同一 Registry 记录的多个 Tag 按行区分已选项与关联项', () => {
  const app = image('app', 'app', 'sha256:app', ['app:v1', 'app:v2', 'app:stable']);
  const items = createImageDeleteItems([row(app, 'app:v1'), row(app, 'app:v2')], 'registry', [app]);
  assert.deepEqual(imageDeletePreview(items).tags, ['app:stable']);
  const result = excludeImageDeleteTag(items, 'app:stable');
  assert.deepEqual([...result.removedKeys], ['app:v1', 'app:v2']);
  assert.deepEqual(result.items, []);
  assert.deepEqual(imageDeletePreview(result.items), { targets: [], digests: [], tags: [] });
});

test('移除后同步收敛 digest、Tag 与实际删除请求，保留未关联的勾选', () => {
  const app = image('app', 'app', 'sha256:app', ['app:v1']);
  const other = image('other', 'other', 'sha256:other', ['other:v1']);
  const items = createImageDeleteItems([row(app, 'app:v1'), row(other, 'other:v1')], 'local', [
    app,
    other,
  ]);
  const result = excludeImageDeleteTag(items, 'app:v1');
  const selected = new Set(['app:v1', 'other:v1', 'outside:v1']);
  for (const key of result.removedKeys) selected.delete(key);
  assert.deepEqual([...selected], ['other:v1', 'outside:v1']);
  assert.deepEqual(imageDeletePreview(result.items), {
    targets: [{ imageID: 'other:v1', expectedDigest: 'sha256:other' }],
    digests: ['sha256:other'],
    tags: ['other:v1'],
  });
});

test('确认快照不受后台镜像和 tags 刷新的影响', () => {
  const app = image('app', 'app', 'sha256:before', ['app:v1', 'app:stable']);
  const items = createImageDeleteItems([row(app, 'app:v1')], 'registry', [app]);
  app.digest = 'sha256:after';
  app.tags.splice(0, app.tags.length, 'app:changed');
  assert.deepEqual(imageDeletePreview(items), {
    targets: [{ imageID: 'app:v1', expectedDigest: 'sha256:before' }],
    digests: ['sha256:before'],
    tags: ['app:stable'],
  });
  assert.deepEqual([...excludeImageDeleteTag(items, 'app:stable').removedKeys], ['app:v1']);
});

test('悬空镜像保留完整 ID，缺少 digest 的 Registry 项不误关联', () => {
  const dangling = image('sha256:local', '', '', []);
  assert.deepEqual(
    imageDeletePreview(createImageDeleteItems([row(dangling)], 'local', [dangling])),
    {
      targets: [{ imageID: 'sha256:local', expectedDigest: '' }],
      digests: ['sha256:local'],
      tags: [],
    },
  );
  const pending = image('pending', 'app', '', ['app:v1', 'app:stable']);
  const pendingItems = createImageDeleteItems([row(pending, 'app:v1')], 'registry', [pending]);
  assert.deepEqual(imageDeletePreview(pendingItems).tags, []);
  assert.deepEqual(excludeImageDeleteTag(pendingItems, 'app:stable').items, pendingItems);
});

test('重复目标只提交一次，移除同一 Tag 时排除全部对应行', () => {
  const app = image('app', 'app', 'sha256:app', ['app:v1']);
  const first = row(app, 'app:v1');
  const second = { ...first, key: 'second-row' };
  const items = createImageDeleteItems([first, second], 'local', [app]);
  assert.equal(imageDeletePreview(items).targets.length, 1);
  const result = excludeImageDeleteTag(items, 'app:v1');
  assert.deepEqual([...result.removedKeys], ['app:v1', 'second-row']);
  assert.deepEqual(result.items, []);
});
