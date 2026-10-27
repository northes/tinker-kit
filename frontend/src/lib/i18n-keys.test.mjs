import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 文案 key 的静态校验：中英资源结构一致，且代码里字面量写出的 key 一定存在。
// 动态拼接的 key（模板字符串、labelKey 间接引用）不在此检查范围内。
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function flatten(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') flatten(child, path, out);
    else out[path] = child;
  }
  return out;
}

function sources(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'locales') return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const zh = flatten(JSON.parse(readFileSync(join(srcRoot, 'locales/zh-CN.json'), 'utf8')));
const en = flatten(JSON.parse(readFileSync(join(srcRoot, 'locales/en-US.json'), 'utf8')));

const literalKey = /\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g;
const transKey = /\bi18nKey=["']([A-Za-z0-9_.-]+)["']/g;

function usedKeys() {
  const used = new Map();
  for (const file of sources(srcRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of [literalKey, transKey]) {
      for (const match of text.matchAll(pattern)) {
        const key = match[1];
        if (!used.has(key)) used.set(key, relative(srcRoot, file));
      }
    }
  }
  return used;
}

test('中英文资源 key 结构一致', () => {
  const onlyZh = Object.keys(zh).filter((key) => !(key in en));
  const onlyEn = Object.keys(en).filter((key) => !(key in zh));
  assert.deepEqual(onlyZh, [], '只存在于 zh-CN 的 key');
  assert.deepEqual(onlyEn, [], '只存在于 en-US 的 key');
});

test('代码中字面量引用的 key 在资源里存在', () => {
  const missing = [...usedKeys()]
    .filter(([key]) => !(key in zh))
    .map(([key, file]) => `${key} (${file})`)
    .sort();
  assert.deepEqual(missing, [], '缺失的 locale key');
});
