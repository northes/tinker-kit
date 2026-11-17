import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  closeTabs,
  convertBlankTabToTool,
  cycleTabs,
  DEFAULT_TAB_STRIP_WIDTH,
  emptyWorkspace,
  MAX_TAB_STRIP_WIDTH,
  MIN_TAB_STRIP_WIDTH,
  openBlankTab,
  openOrFocusSettings,
  openToolTab,
  parseTabCloseActivation,
  parseTabCloseButton,
  parseTabOrientation,
  parseTabStripWidth,
  setTabCustomTitle,
  sortTabsForDisplay,
  startupWorkspace,
  TAB_STRIP_FOCUS_PADDING,
  tabOrdinalLabel,
  toggleTabPin,
  visiblePaletteCommands,
  workspaceTabLabel,
} from './workspace-tabs.ts';

const commands = [
  { id: 'nav:new-tab', workspaceAction: 'new-tab' },
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

test('纵向标签条宽度夹在 140–360，缺失或越界回退默认值', () => {
  assert.equal(DEFAULT_TAB_STRIP_WIDTH, 176);
  assert.equal(parseTabStripWidth(undefined), 176);
  assert.equal(parseTabStripWidth(0), 176);
  assert.equal(parseTabStripWidth(Number.NaN), 176);
  assert.equal(parseTabStripWidth(120), MIN_TAB_STRIP_WIDTH);
  assert.equal(parseTabStripWidth(400), MAX_TAB_STRIP_WIDTH);
  assert.equal(parseTabStripWidth(220.4), 220);
  assert.equal(TAB_STRIP_FOCUS_PADDING, 8);
});

test('该工具标签全部关掉后再开，序号从 1 重新计', () => {
  let state = emptyWorkspace();
  const a = openToolTab(state, 'json');
  state = openToolTab(a.state, 'json').state;
  state = openToolTab(state, 'json').state;
  const jsonTabs = state.tabs.filter((tab) => tab.toolId === 'json');
  assert.deepEqual(
    jsonTabs.map((tab) => tab.ordinal),
    [1, 2, 3],
  );
  state = closeTabs(
    state,
    jsonTabs.map((tab) => tab.id),
    'recent',
  );
  const reopened = openToolTab(state, 'json');
  assert.equal(reopened.tab.ordinal, 1);
  assert.equal(tabOrdinalLabel('JSON', reopened.tab.ordinal), 'JSON');
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
  assert.ok(
    closed.tabs.find((tab) => tab.id === closed.activeId).activatedAt > state.activationSeq,
  );
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

test('关掉最后一个补一个空白标签，循环在不足两个时不做事', () => {
  const opened = openToolTab(emptyWorkspace(), 'json');
  const closed = closeTab(opened.state, opened.tab.id, 'recent');
  assert.equal(closed.tabs.length, 1);
  assert.equal(closed.tabs[0].kind, 'blank');
  assert.equal(closed.activeId, closed.tabs[0].id);
  assert.equal(cycleTabs(opened.state, -1), opened.state);
  const two = openToolTab(opened.state, 'text').state;
  const cycled = cycleTabs(two, 1);
  assert.equal(cycled.activeId, two.tabs[0].id);
  assert.equal(cycleTabs(cycled, -1).activeId, two.tabs[1].id);
  const withSettings = openOrFocusSettings(two);
  assert.equal(cycleTabs(withSettings, 1).activeId, withSettings.tabs[0].id);
});

test('启动带一个空白标签，空白标签就地变成工具', () => {
  const started = startupWorkspace();
  assert.equal(started.tabs.length, 1);
  assert.equal(started.tabs[0].kind, 'blank');
  assert.equal(started.tabs[0].ordinal, 1);
  const again = openBlankTab(started);
  assert.equal(again.tab.kind, 'blank');
  assert.equal(again.tab.ordinal, 2);
  assert.equal(tabOrdinalLabel('新标签', again.tab.ordinal), '新标签 2');
  const converted = convertBlankTabToTool(again.state, again.tab.id, 'json');
  const tab = converted.tabs.find((item) => item.id === again.tab.id);
  assert.equal(tab?.kind, 'tool');
  assert.equal(tab?.toolId, 'json');
  assert.equal(tab?.ordinal, 1);
  const blankAgain = openBlankTab(converted);
  const second = convertBlankTabToTool(blankAgain.state, blankAgain.tab.id, 'json');
  const jsonTabs = second.tabs.filter((item) => item.toolId === 'json');
  assert.deepEqual(
    jsonTabs.map((item) => item.ordinal),
    [1, 2],
  );
  const empty = closeTabs(
    second,
    jsonTabs.map((item) => item.id),
    'recent',
  );
  assert.equal(empty.tabs.length, 1);
  assert.equal(empty.tabs[0].kind, 'blank');
});

test('固定的标签排到最前，组内相对顺序不变', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'text').state;
  state = openToolTab(state, 'time').state;
  const [json, text, time] = state.tabs;
  state = toggleTabPin(state, time.id);
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [time.id, json.id, text.id],
  );
  assert.equal(state.tabs[0].pinned, true);
  state = toggleTabPin(state, json.id);
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [time.id, json.id, text.id],
  );
  assert.equal(state.tabs[1].pinned, true);
  state = toggleTabPin(state, time.id);
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [json.id, time.id, text.id],
  );
  assert.equal(state.tabs[0].pinned, true);
  assert.equal(state.tabs[1].pinned, undefined);
  assert.equal('pinned' in state.tabs[1], false);
  const opened = openToolTab(state, 'base64');
  assert.deepEqual(
    opened.state.tabs.map((tab) => tab.toolId),
    ['json', 'time', 'text', 'base64'],
  );
  assert.equal(toggleTabPin(state, 'missing'), state);
  const unsorted = sortTabsForDisplay([text, { ...json, pinned: true }, time]);
  assert.deepEqual(
    unsorted.map((tab) => tab.id),
    [json.id, text.id, time.id],
  );
});

test('关闭其他标签保留固定和被右键的标签，并激活后者', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'text').state;
  state = openToolTab(state, 'time').state;
  state = openToolTab(state, 'json').state;
  const [json, text, time, json2] = state.tabs;
  state = toggleTabPin(state, json.id);
  assert.equal(state.activeId, json2.id);
  const closed = closeOtherTabs(state, time.id, 'previous');
  assert.deepEqual(
    closed.tabs.map((tab) => tab.id),
    [json.id, time.id],
  );
  assert.equal(closed.activeId, time.id);
  assert.ok(closed.activationSeq > state.activationSeq);
  assert.equal(closed.tabs.find((tab) => tab.id === time.id).activatedAt, closed.activationSeq);
  assert.equal(closed.tabs.find((tab) => tab.id === json.id).activatedAt, json.activatedAt);
  assert.equal(closed.nextOrdinal.json, state.nextOrdinal.json);
  assert.equal(closed.nextOrdinal.time, state.nextOrdinal.time);
  assert.equal(closed.nextOrdinal.text, undefined);
  const again = closeOtherTabs(closed, time.id, 'next');
  assert.deepEqual(
    again.tabs.map((tab) => tab.id),
    [json.id, time.id],
  );
  assert.equal(again.activeId, time.id);
  assert.ok(again.activationSeq > closed.activationSeq);
  assert.equal(closeOtherTabs(state, 'missing', 'recent'), state);
  const onlyPinned = closeOtherTabs(
    toggleTabPin(toggleTabPin(state, text.id), time.id),
    json2.id,
    'recent',
  );
  assert.equal(onlyPinned.activeId, json2.id);
  assert.equal(onlyPinned.tabs.length, state.tabs.length);
});

test('工具标签可以改显示名，空白则恢复默认', () => {
  const opened = openToolTab(emptyWorkspace(), 'json');
  const named = setTabCustomTitle(opened.state, opened.tab.id, '  草稿  ');
  assert.equal(named.tabs[0].customTitle, '草稿');
  assert.equal(workspaceTabLabel(named.tabs[0], 'JSON'), '草稿');
  const cleared = setTabCustomTitle(named, opened.tab.id, '   ');
  assert.equal(cleared.tabs[0].customTitle, undefined);
  assert.equal('customTitle' in cleared.tabs[0], false);
  assert.equal(workspaceTabLabel(cleared.tabs[0], 'JSON'), 'JSON');
  assert.equal(setTabCustomTitle(named, opened.tab.id, '草稿'), named);
  const blank = openBlankTab(emptyWorkspace());
  assert.equal(setTabCustomTitle(blank.state, blank.tab.id, '名字'), blank.state);
  const settings = openOrFocusSettings(emptyWorkspace());
  assert.equal(setTabCustomTitle(settings, settings.tabs[0].id, '名字'), settings);
  assert.equal(setTabCustomTitle(opened.state, 'missing', '名字'), opened.state);
});

test('命令面板按当前标签过滤，打开工具的顺序跟配置走', () => {
  const enabled = ['text', 'json'];
  assert.deepEqual(
    visiblePaletteCommands(commands, { kind: 'empty' }, enabled, new Set()).map((item) => item.id),
    ['nav:new-tab', 'nav:settings', 'open:text', 'open:json'],
  );
  assert.deepEqual(
    visiblePaletteCommands(commands, { kind: 'blank' }, enabled, new Set()).map((item) => item.id),
    ['nav:new-tab', 'nav:settings', 'open:text', 'open:json'],
  );
  assert.deepEqual(
    visiblePaletteCommands(commands, { kind: 'settings' }, enabled, new Set()).map(
      (item) => item.id,
    ),
    ['nav:new-tab', 'nav:settings', 'settings:quit', 'open:text', 'open:json'],
  );
  assert.deepEqual(
    visiblePaletteCommands(commands, { kind: 'tool', toolId: 'json' }, enabled, new Set()).map(
      (item) => item.id,
    ),
    ['nav:new-tab', 'nav:settings', 'open:text', 'open:json', 'json:format'],
  );
  assert.deepEqual(
    visiblePaletteCommands(
      commands,
      { kind: 'tool', toolId: 'json' },
      enabled,
      new Set(['json.schema']),
    ).map((item) => item.id),
    ['nav:new-tab', 'nav:settings', 'open:text', 'open:json', 'json:format', 'json:schema:copy'],
  );
});
