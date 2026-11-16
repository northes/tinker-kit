import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateTab,
  closeTab,
  closeTabs,
  cycleTabs,
  emptyWorkspace,
  openOrFocusSettings,
  openToolTab,
  parseTabCloseActivation,
  parseTabCloseButton,
  parseTabOrientation,
  tabOrdinalLabel,
  visiblePaletteCommands,
} from './workspace-tabs.ts';

const commands = [
  { id: 'nav:settings', page: 'settings' },
  { id: 'settings:quit', settingsAction: 'quit' },
  { id: 'open:json', page: 'json' },
  { id: 'open:text', page: 'text' },
  { id: 'open:time', page: 'time' },
  { id: 'json:format', tool: 'json', action: 'format' },
  { id: 'json:schema:copy', tool: 'json', context: 'json.schema' },
  { id: 'text:copy', tool: 'text' },
  { id: 'orphan' },
];

test('非法标签偏好回退默认值', () => {
  assert.equal(parseTabOrientation('vertical'), 'vertical');
  assert.equal(parseTabOrientation('nope'), 'horizontal');
  assert.equal(parseTabOrientation(undefined), 'horizontal');
  assert.equal(parseTabCloseActivation('previous'), 'previous');
  assert.equal(parseTabCloseActivation(''), 'recent');
  assert.equal(parseTabCloseButton('hover'), 'hover');
  assert.equal(parseTabCloseButton('always'), 'always');
  assert.equal(parseTabCloseButton('bad'), 'always');
});

test('工具序号只增不回收，设置不加序号', () => {
  let state = emptyWorkspace();
  const first = openToolTab(state, 'json');
  const second = openToolTab(first.state, 'json');
  const third = openToolTab(second.state, 'text');
  state = closeTab(third.state, second.tab.id, 'recent');
  const fourth = openToolTab(state, 'json');
  assert.equal(tabOrdinalLabel('JSON', first.tab.ordinal), 'JSON');
  assert.equal(tabOrdinalLabel('JSON', second.tab.ordinal), 'JSON 2');
  assert.equal(tabOrdinalLabel('文本', third.tab.ordinal), '文本');
  assert.equal(fourth.tab.ordinal, 3);
  assert.equal(tabOrdinalLabel('JSON', fourth.tab.ordinal), 'JSON 3');
  state = openOrFocusSettings(fourth.state);
  const settings = state.tabs.find((tab) => tab.kind === 'settings');
  assert.equal(settings?.ordinal, 0);
  assert.equal(state.tabs.filter((tab) => tab.kind === 'settings').length, 1);
  const again = openOrFocusSettings(state);
  assert.equal(again.tabs.length, state.tabs.length);
  assert.equal(again.activeId, settings?.id);
});

test('新标签加在末尾并成为当前，点已有标签只切换', () => {
  const first = openToolTab(emptyWorkspace(), 'json');
  const second = openToolTab(first.state, 'text');
  assert.deepEqual(
    second.state.tabs.map((tab) => tab.id),
    [first.tab.id, second.tab.id],
  );
  assert.equal(second.state.activeId, second.tab.id);
  const back = activateTab(second.state, first.tab.id);
  assert.equal(back.activeId, first.tab.id);
  assert.equal(back.tabs.length, 2);
  assert.ok(back.tabs[0].activatedAt > second.state.tabs[0].activatedAt);
});

test('关掉非当前标签不改变当前，关掉当前才按规则重选', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'text').state;
  state = openToolTab(state, 'time').state;
  const [json, text, time] = state.tabs;
  const closedOther = closeTab(state, json.id, 'previous');
  assert.equal(closedOther.activeId, time.id);
  assert.deepEqual(
    closedOther.tabs.map((tab) => tab.id),
    [text.id, time.id],
  );

  const recent = closeTab(state, time.id, 'recent');
  assert.equal(recent.activeId, text.id);

  const activatedJson = activateTab(state, json.id);
  const previous = closeTab(activatedJson, json.id, 'previous');
  assert.equal(previous.activeId, text.id);
  const next = closeTab(activateTab(state, json.id), json.id, 'next');
  assert.equal(next.activeId, text.id);
  const fromMiddle = closeTab(activateTab(state, text.id), text.id, 'next');
  assert.equal(fromMiddle.activeId, time.id);
  const fromEnd = closeTab(state, time.id, 'next');
  assert.equal(fromEnd.activeId, text.id);
});

test('最近使用按单调激活序号，而不是打开顺序', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'text').state;
  state = openToolTab(state, 'time').state;
  state = activateTab(state, state.tabs[0].id);
  const closed = closeTab(state, state.tabs[0].id, 'recent');
  assert.equal(closed.activeId, state.tabs[2].id);
  assert.ok(closed.tabs.find((tab) => tab.id === closed.activeId).activatedAt > state.activationSeq);
});

test('一次性关掉多个标签只应用一次激活规则', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'json').state;
  state = openOrFocusSettings(state);
  state = openToolTab(state, 'text').state;
  const [first, second, settings, text] = state.tabs;
  const stayed = closeTabs(state, [first.id, second.id], 'recent');
  assert.equal(stayed.activeId, text.id);
  assert.deepEqual(
    stayed.tabs.map((tab) => tab.id),
    [settings.id, text.id],
  );

  const viewing = activateTab(state, first.id);
  const picked = closeTabs(viewing, [first.id, second.id], 'next');
  assert.equal(picked.activeId, settings.id);
  const recent = closeTabs(viewing, [first.id, second.id], 'recent');
  assert.equal(recent.activeId, text.id);
});

test('关掉最后一个留下空标签条，循环在不足两个时不做事', () => {
  const opened = openToolTab(emptyWorkspace(), 'json');
  const empty = closeTab(opened.state, opened.tab.id, 'recent');
  assert.deepEqual(empty.tabs, []);
  assert.equal(empty.activeId, null);
  assert.equal(cycleTabs(empty, 1), empty);
  assert.equal(cycleTabs(opened.state, -1), opened.state);
  const two = openToolTab(opened.state, 'text').state;
  const cycled = cycleTabs(two, 1);
  assert.equal(cycled.activeId, two.tabs[0].id);
  assert.equal(cycleTabs(cycled, -1).activeId, two.tabs[1].id);
  const withSettings = openOrFocusSettings(two);
  assert.equal(cycleTabs(withSettings, 1).activeId, withSettings.tabs[0].id);
});

test('命令面板按当前标签过滤，打开工具的顺序跟配置走', () => {
  const enabled = ['text', 'json'];
  assert.deepEqual(
    visiblePaletteCommands(commands, { kind: 'empty' }, enabled, new Set()).map((item) => item.id),
    ['nav:settings', 'open:text', 'open:json'],
  );
  assert.deepEqual(
    visiblePaletteCommands(commands, { kind: 'settings' }, enabled, new Set()).map((item) => item.id),
    ['nav:settings', 'settings:quit', 'open:text', 'open:json'],
  );
  assert.deepEqual(
    visiblePaletteCommands(commands, { kind: 'tool', toolId: 'json' }, enabled, new Set()).map(
      (item) => item.id,
    ),
    ['nav:settings', 'open:text', 'open:json', 'json:format'],
  );
  assert.deepEqual(
    visiblePaletteCommands(
      commands,
      { kind: 'tool', toolId: 'json' },
      enabled,
      new Set(['json.schema']),
    ).map((item) => item.id),
    ['nav:settings', 'open:text', 'open:json', 'json:format', 'json:schema:copy'],
  );
});
