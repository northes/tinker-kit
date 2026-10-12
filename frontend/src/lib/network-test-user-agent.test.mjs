import assert from 'node:assert/strict';
import test from 'node:test';

import {
  presetUserAgent,
  selectedUserAgent,
  userAgentPresets,
  userAgentSelectionFor,
  USER_AGENT_CUSTOM_SELECTION,
  USER_AGENT_DEFAULT_SELECTION,
} from './network-test-user-agent.ts';

// 预设的 UA 串必须符合真实浏览器的格式，且版本号与下拉标签用的 version 一致：标签写着 154、
// 串里却是别的版本，用户按标签选到的就不是他以为的身份。
test('presets emit browser-shaped user agents', () => {
  for (const preset of userAgentPresets) {
    const agent = presetUserAgent(preset);
    assert.ok(agent.startsWith('Mozilla/5.0 ('), agent);
    if (preset.browser === 'chrome') {
      assert.match(agent, /AppleWebKit\/537\.36 \(KHTML, like Gecko\)/);
      assert.ok(agent.includes(`Chrome/${preset.version}.0.0.0`), agent);
      assert.ok(agent.endsWith('Safari/537.36'), agent);
    } else {
      assert.ok(agent.includes(`Gecko/20100101 Firefox/${preset.version}.0`), agent);
      assert.ok(agent.includes(`rv:${preset.version}.0`), agent);
    }
    assert.ok(
      preset.platform === 'mac' ? agent.includes('Macintosh;') : agent.includes('Windows NT 10.0'),
      agent,
    );
  }
});

test('presets cover Chrome and Firefox on both platforms', () => {
  const identities = userAgentPresets.map((preset) => `${preset.browser}/${preset.platform}`);
  assert.deepEqual([...identities].sort(), [
    'chrome/mac',
    'chrome/windows',
    'firefox/mac',
    'firefox/windows',
  ]);
  assert.equal(new Set(userAgentPresets.map((preset) => preset.id)).size, userAgentPresets.length);
});

// 保存值还原成下拉选项：空值=工具默认，命中预设=该预设，其它串=自定义。
test('selection round-trips through saved values', () => {
  assert.equal(userAgentSelectionFor(''), USER_AGENT_DEFAULT_SELECTION);
  assert.equal(userAgentSelectionFor('   '), USER_AGENT_DEFAULT_SELECTION);
  for (const preset of userAgentPresets) {
    assert.equal(userAgentSelectionFor(presetUserAgent(preset)), preset.id);
  }
  assert.equal(userAgentSelectionFor('curl/8.0'), USER_AGENT_CUSTOM_SELECTION);
});

// 实际发送的值：预设用生成的串，自定义用输入框内容（去掉首尾空白），默认交给后端填。
test('selection resolves to the sent user agent', () => {
  assert.equal(selectedUserAgent(USER_AGENT_DEFAULT_SELECTION, 'ignored'), '');
  assert.equal(selectedUserAgent(USER_AGENT_CUSTOM_SELECTION, '  curl/8.0  '), 'curl/8.0');
  assert.equal(selectedUserAgent(USER_AGENT_CUSTOM_SELECTION, ''), '');
  for (const preset of userAgentPresets) {
    assert.equal(selectedUserAgent(preset.id, ''), presetUserAgent(preset));
  }
  assert.equal(selectedUserAgent('stale-preset-id', 'curl/8.0'), 'curl/8.0');
});
