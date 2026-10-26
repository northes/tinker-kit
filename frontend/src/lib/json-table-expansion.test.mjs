import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsonTableExpansion, jsonTableChildPath } from './json-table-expansion.ts';

test('表格卸载后重新订阅，object 和多层节点仍保持展开', () => {
  const expansion = createJsonTableExpansion();
  const object = jsonTableChildPath('', 'object');
  const child = jsonTableChildPath(object, 'child');
  const unsubscribe = expansion.subscribe(object, () => {});
  expansion.toggle(object);
  expansion.toggle(child);
  unsubscribe();

  const remount = expansion.subscribe(object, () => {});
  assert.equal(expansion.isExpanded(object), true);
  assert.equal(expansion.isExpanded(child), true);
  remount();

  expansion.toggle(object);
  assert.equal(expansion.isExpanded(object), false);
  expansion.toggle(object);
  assert.equal(expansion.isExpanded(child), true);
});

test('展开一个节点只通知该节点，不刷新兄弟节点及整张表', () => {
  const expansion = createJsonTableExpansion();
  let firstUpdates = 0;
  let secondUpdates = 0;
  const unsubscribeFirst = expansion.subscribe('/first', () => firstUpdates++);
  const unsubscribeSecond = expansion.subscribe('/second', () => secondUpdates++);
  expansion.toggle('/first');
  assert.equal(firstUpdates, 1);
  assert.equal(secondUpdates, 0);

  unsubscribeFirst();
  expansion.toggle('/first');
  assert.equal(firstUpdates, 1);
  unsubscribeSecond();
});

test('同一路径的多个订阅独立清理，重新挂载后继续通知', () => {
  const expansion = createJsonTableExpansion();
  let updates = 0;
  const first = expansion.subscribe('/object', () => updates++);
  const second = expansion.subscribe('/object', () => updates++);
  first();
  expansion.toggle('/object');
  assert.equal(updates, 1);
  second();
  const remount = expansion.subscribe('/object', () => updates++);
  expansion.toggle('/object');
  assert.equal(updates, 2);
  remount();
});

test('对象数组、空键和带斜线或波浪号的属性路径不会冲突', () => {
  const paths = [
    jsonTableChildPath('', 'a/b'),
    jsonTableChildPath(jsonTableChildPath('', 'a'), 'b'),
    jsonTableChildPath('', 'a~1b'),
    jsonTableChildPath('', ''),
    jsonTableChildPath(jsonTableChildPath('', 0), 'nested'),
    jsonTableChildPath(jsonTableChildPath('', 1), 'nested'),
  ];
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths[0], '/a~1b');
  assert.equal(paths[2], '/a~01b');
});

test('输入、结果及重新打开的预览会话不共享展开状态', () => {
  const input = createJsonTableExpansion();
  const result = createJsonTableExpansion();
  input.toggle('/object');
  assert.equal(result.isExpanded('/object'), false);
  assert.equal(createJsonTableExpansion().isExpanded('/object'), false);
});
