// 网络测试工具的 User-Agent 预设：模拟 Chrome 与 Firefox 的请求身份（版本号取自本机当前安装的
// 浏览器），macOS 与 Windows 各一份。
//
// 版本号只写在 version 字段里：UA 串与下拉标签都由它生成，避免出现「标签写着 154、串里却是别的
// 版本」；其它版本用「自定义」输入。标签文案在 locale 的 networkTestTool.userAgent.option.*，
// 通过 {{version}} 插值取这里的版本号。

export type UserAgentPreset = {
  id: string;
  labelKey: string;
  browser: 'chrome' | 'firefox';
  platform: 'mac' | 'windows';
  version: string;
};

export const USER_AGENT_DEFAULT_SELECTION = '__network-test-user-agent-default__';
export const USER_AGENT_CUSTOM_SELECTION = '__network-test-user-agent-custom__';

export const userAgentPresets: UserAgentPreset[] = [
  {
    id: 'chromeMac',
    labelKey: 'networkTestTool.userAgent.option.chromeMac',
    browser: 'chrome',
    platform: 'mac',
    version: '154',
  },
  {
    id: 'chromeWindows',
    labelKey: 'networkTestTool.userAgent.option.chromeWindows',
    browser: 'chrome',
    platform: 'windows',
    version: '154',
  },
  {
    id: 'firefoxMac',
    labelKey: 'networkTestTool.userAgent.option.firefoxMac',
    browser: 'firefox',
    platform: 'mac',
    version: '146',
  },
  {
    id: 'firefoxWindows',
    labelKey: 'networkTestTool.userAgent.option.firefoxWindows',
    browser: 'firefox',
    platform: 'windows',
    version: '146',
  },
];

/** 生成预设对应的 User-Agent 串：Chrome 只上报主版本，Firefox 上报主次版本。 */
export function presetUserAgent(preset: UserAgentPreset) {
  if (preset.browser === 'chrome') {
    const platform =
      preset.platform === 'mac'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'Windows NT 10.0; Win64; x64';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${preset.version}.0.0.0 Safari/537.36`;
  }
  const platform =
    preset.platform === 'mac' ? 'Macintosh; Intel Mac OS X 10.15' : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${platform}; rv:${preset.version}.0) Gecko/20100101 Firefox/${preset.version}.0`;
}

/**
 * 下拉选项与自定义文本决定实际发送的 User-Agent：空串表示使用工具默认标识（由后端决定）。
 * 选项已经失效（例如旧配置里的预设 id）时按自定义文本处理，不静默换成别的身份。
 */
export function selectedUserAgent(selection: string, custom: string) {
  if (selection === USER_AGENT_DEFAULT_SELECTION) return '';
  const preset = userAgentPresets.find((item) => item.id === selection);
  return preset ? presetUserAgent(preset) : custom.trim();
}

/**
 * 把保存或恢复的 User-Agent 还原成下拉选项：空值表示工具默认，命中预设就选预设，其余按自定义处理
 * （输入的串直接作为下拉的当前值）。
 */
export function userAgentSelectionFor(value: string) {
  const agent = value.trim();
  if (!agent) return USER_AGENT_DEFAULT_SELECTION;
  return (
    userAgentPresets.find((preset) => presetUserAgent(preset) === agent)?.id ??
    USER_AGENT_CUSTOM_SELECTION
  );
}
