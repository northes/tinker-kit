import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePaletteQuery, searchIndexedItems } from './palette-fuzzy.ts';

function sshFilesSearchRow() {
  const label = '文件管理';
  const keywords = 'ssh sftp files upload download explorer 文件 上传 下载 目录';
  const raw = `${label} ${keywords}`.toLowerCase();
  return {
    id: 'ssh-files',
    label,
    text: raw.replace(/\s+/g, ''),
    pinyin: raw.replace(/\s+/g, ''),
    initials: 'sshfiles',
  };
}

test('normalizePaletteQuery collapses spaces', () => {
  assert.equal(normalizePaletteQuery('  SSH  File '), 'sshfile');
});

test('searchIndexedItems matches compact sshfile against ssh files tool text', () => {
  const hits = searchIndexedItems([sshFilesSearchRow()], 'sshfile');
  assert.ok(hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'ssh-files');
});
