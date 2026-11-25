import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  closeTabs,
  convertBlankTabToTool,
  cycleTabs,
  emptyWorkspace,
  openBlankTab,
  openOrFocusSettings,
  openPortForwardTab,
  openToolTab,
  parseTabCloseActivation,
  parseTabCloseButton,
  nextDragOverId,
  reorderWorkspaceTabs,
  setTabCustomTitle,
  tabDragShift,
  sortTabsForDisplay,
  startupWorkspace,
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
  { id: 'open:time-convert', page: 'time-convert' },
  { id: 'json:format', tool: 'json', action: 'format' },
  { id: 'json:schema:copy', tool: 'json', context: 'json.schema' },
  { id: 'text:copy', tool: 'text' },
  { id: 'orphan' },
];

test('非法标签偏好回退默认值', () => {
  assert.equal(parseTabCloseActivation('previous'), 'previous');
  assert.equal(parseTabCloseActivation(''), 'recent');
  assert.equal(parseTabCloseButton('hover'), 'hover');
  assert.equal(parseTabCloseButton('always'), 'always');
  assert.equal(parseTabCloseButton('bad'), 'always');
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

test('新开序号取仍打开同类的最大序号加一，设置不加序号', () => {
  let state = emptyWorkspace();
  const first = openToolTab(state, 'json');
  const second = openToolTab(first.state, 'json');
  const third = openToolTab(second.state, 'text');
  state = closeTab(third.state, second.tab.id, 'recent');
  const fourth = openToolTab(state, 'json');
  assert.equal(tabOrdinalLabel('JSON', first.tab.ordinal), 'JSON');
  assert.equal(tabOrdinalLabel('JSON', second.tab.ordinal), 'JSON 2');
  assert.equal(tabOrdinalLabel('文本', third.tab.ordinal), '文本');
  assert.equal(state.tabs.find((tab) => tab.id === first.tab.id)?.ordinal, 1);
  assert.equal(fourth.tab.ordinal, 2);
  assert.equal(tabOrdinalLabel('JSON', fourth.tab.ordinal), 'JSON 2');
  const keptHigh = openToolTab(fourth.state, 'json');
  const closedLow = closeTab(keptHigh.state, first.tab.id, 'recent');
  assert.equal(closedLow.tabs.find((tab) => tab.id === fourth.tab.id)?.ordinal, 2);
  assert.equal(closedLow.tabs.find((tab) => tab.id === keptHigh.tab.id)?.ordinal, 3);
  assert.equal(openToolTab(closedLow, 'json').tab.ordinal, 4);
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
  state = openToolTab(state, 'jwt').state;
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
  state = openToolTab(state, 'jwt').state;
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

test('已有端口转发标签时再打开只聚焦，空白标签留着', () => {
  const opened = openToolTab(emptyWorkspace(), 'port-forwards');
  const blank = openBlankTab(opened.state);
  const again = openPortForwardTab(blank.state);
  assert.equal(again.created, false);
  assert.equal(again.state.activeId, opened.tab.id);
  assert.notEqual(again.state, blank.state);
  assert.equal(again.state.tabs.length, 2);
  assert.equal(again.state.tabs.find((tab) => tab.id === blank.tab.id)?.kind, 'blank');
  assert.equal(again.state.tabs.filter((tab) => tab.toolId === 'port-forwards').length, 1);
  const focused = openPortForwardTab(again.state);
  assert.equal(focused.created, false);
  assert.equal(focused.state, again.state);
  assert.equal(focused.tab.id, opened.tab.id);
});

test('没有端口转发标签时，空白标签就地变成转发', () => {
  const started = startupWorkspace();
  const opened = openPortForwardTab(started);
  assert.equal(opened.created, true);
  assert.equal(opened.state.tabs.length, 1);
  assert.equal(opened.tab.id, started.tabs[0].id);
  assert.equal(opened.tab.kind, 'tool');
  assert.equal(opened.tab.toolId, 'port-forwards');
  assert.equal(opened.tab.ordinal, 1);
});

test('端口占用仍能开第二个标签', () => {
  const first = openToolTab(emptyWorkspace(), 'ports');
  const second = openToolTab(first.state, 'ports');
  assert.equal(second.state.tabs.filter((tab) => tab.toolId === 'ports').length, 2);
  assert.notEqual(second.tab.id, first.tab.id);
  assert.equal(second.tab.ordinal, 2);
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

test('空白标签转成工具时按该工具已开标签计序号，不沿用空白序号', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'json').state;
  const firstBlank = openBlankTab(state);
  const secondBlank = openBlankTab(firstBlank.state);
  assert.equal(secondBlank.tab.ordinal, 2);
  const converted = convertBlankTabToTool(secondBlank.state, secondBlank.tab.id, 'json');
  assert.equal(converted.tabs.find((item) => item.id === secondBlank.tab.id)?.ordinal, 3);
  assert.equal(converted.tabs.find((item) => item.id === firstBlank.tab.id)?.ordinal, 1);
  const closedHigh = closeTab(secondBlank.state, secondBlank.tab.id, 'recent');
  assert.equal(closedHigh.tabs.find((item) => item.id === firstBlank.tab.id)?.ordinal, 1);
  assert.equal(openBlankTab(closedHigh).tab.ordinal, 2);
});

test('固定的标签排到最前，组内相对顺序不变', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'text').state;
  state = openToolTab(state, 'jwt').state;
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
    ['json', 'jwt', 'text', 'base64'],
  );
  assert.equal(toggleTabPin(state, 'missing'), state);
  const unsorted = sortTabsForDisplay([text, { ...json, pinned: true }, time]);
  assert.deepEqual(
    unsorted.map((tab) => tab.id),
    [json.id, text.id, time.id],
  );
});

test('只在同一固定组内调整顺序，跨组取消，新标签仍加在未固定区末尾', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'text').state;
  state = openToolTab(state, 'jwt').state;
  state = openToolTab(state, 'base64').state;
  const [json, text, time, base64] = state.tabs;
  state = toggleTabPin(state, json.id);
  state = toggleTabPin(state, text.id);
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [json.id, text.id, time.id, base64.id],
  );

  const swappedPinned = reorderWorkspaceTabs(state, text.id, json.id);
  assert.notEqual(swappedPinned, state);
  assert.deepEqual(
    swappedPinned.tabs.map((tab) => tab.id),
    [text.id, json.id, time.id, base64.id],
  );
  assert.equal(swappedPinned.tabs[0].pinned, true);
  assert.equal(swappedPinned.tabs[1].pinned, true);
  assert.equal(swappedPinned.activeId, state.activeId);
  assert.equal(swappedPinned.nextId, state.nextId);
  assert.equal(swappedPinned.activationSeq, state.activationSeq);

  const swappedUnpinned = reorderWorkspaceTabs(state, base64.id, time.id);
  assert.deepEqual(
    swappedUnpinned.tabs.map((tab) => tab.id),
    [json.id, text.id, base64.id, time.id],
  );
  const unpinnedGroup = toggleTabPin(state, text.id);
  assert.deepEqual(
    unpinnedGroup.tabs.map((tab) => tab.id),
    [json.id, text.id, time.id, base64.id],
  );
  const movedForward = reorderWorkspaceTabs(unpinnedGroup, base64.id, text.id);
  assert.deepEqual(
    movedForward.tabs.map((tab) => tab.id),
    [json.id, base64.id, text.id, time.id],
  );
  const movedBackward = reorderWorkspaceTabs(unpinnedGroup, text.id, base64.id);
  assert.deepEqual(
    movedBackward.tabs.map((tab) => tab.id),
    [json.id, time.id, base64.id, text.id],
  );

  assert.equal(reorderWorkspaceTabs(state, json.id, time.id), state);
  assert.equal(reorderWorkspaceTabs(state, time.id, text.id), state);
  assert.equal(reorderWorkspaceTabs(state, json.id, json.id), state);
  assert.equal(reorderWorkspaceTabs(state, 'missing', time.id), state);
  assert.equal(reorderWorkspaceTabs(state, json.id, 'missing'), state);
  assert.equal(reorderWorkspaceTabs(state, '', time.id), state);

  const opened = openToolTab(swappedUnpinned, 'cron');
  assert.deepEqual(
    opened.state.tabs.map((tab) => tab.toolId),
    ['json', 'text', 'base64', 'jwt', 'cron'],
  );
  const blank = openBlankTab(swappedUnpinned);
  assert.equal(blank.state.tabs.at(-1)?.kind, 'blank');
  assert.equal(blank.state.tabs.at(-1)?.pinned, undefined);

  const unpinned = toggleTabPin(swappedPinned, text.id);
  assert.deepEqual(
    unpinned.tabs.map((tab) => tab.id),
    [json.id, text.id, time.id, base64.id],
  );
  assert.equal(unpinned.tabs[0].pinned, true);
  assert.equal(unpinned.tabs[1].pinned, undefined);

  const pinnedAgain = toggleTabPin(swappedUnpinned, base64.id);
  assert.deepEqual(
    pinnedAgain.tabs.map((tab) => tab.id),
    [json.id, text.id, base64.id, time.id],
  );
  assert.equal(pinnedAgain.tabs[2].pinned, true);
  assert.equal(pinnedAgain.tabs[3].pinned, undefined);
});

test('越过相邻标签后，中线前回摆不会把落点弹回去', () => {
  const slots = [
    { id: 'a', mid: 50 },
    { id: 'b', mid: 150 },
    { id: 'c', mid: 250 },
  ];
  assert.equal(nextDragOverId(slots, 'a', 149), 'a');
  assert.equal(nextDragOverId(slots, 'a', 150), 'b');
  assert.equal(nextDragOverId(slots, 'b', 149), 'b');
  assert.equal(nextDragOverId(slots, 'b', 151), 'b');
  assert.equal(nextDragOverId(slots, 'b', 50), 'a');
  assert.equal(nextDragOverId(slots, 'b', 250), 'c');
  assert.equal(nextDragOverId(slots, 'a', 250), 'c');
  assert.equal(nextDragOverId(slots, 'a', 200), 'b');
  assert.equal(nextDragOverId(slots, 'c', 50), 'a');
  assert.equal(nextDragOverId(slots, 'c', 149), 'b');
  assert.equal(tabDragShift(0, 2, 0, 100), 0);
  assert.equal(tabDragShift(0, 2, 1, 100), -100);
  assert.equal(tabDragShift(0, 2, 2, 100), -100);
  assert.equal(tabDragShift(2, 0, 1, 100), 100);
});

test('关闭其他标签保留固定和被右键的标签，并激活后者', () => {
  let state = openToolTab(emptyWorkspace(), 'json').state;
  state = openToolTab(state, 'text').state;
  state = openToolTab(state, 'jwt').state;
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
  assert.equal(closed.tabs.find((tab) => tab.id === json.id).ordinal, json.ordinal);
  assert.equal(closed.tabs.find((tab) => tab.id === time.id).ordinal, time.ordinal);
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
