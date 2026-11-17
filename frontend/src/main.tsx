import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router';
import App from './App';
import { FatalErrorBoundaryRoot } from './components/FatalErrorBoundary';
import { Get as GetConfig } from '../bindings/tinkerkit/configservice';
import { GetSystemInfo } from '../bindings/tinkerkit/systeminfoservice';
import type { SystemInfo } from '../bindings/tinkerkit/models';
import { SSHProfileProvider } from './components/SSHProfileManagerDialog';
import { defaultSettings } from './app/default-settings';
import {
  applyWindowOpacity,
  clearNativeWindowBackground,
  rememberBoot,
} from './app/window-appearance';
import { resolveTheme } from './theme';
import './i18n';
import './index.css';

// 仅阻止浏览器默认菜单，保留事件传播，让自定义右键菜单正常触发。
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

// 首帧先按 UA 判断红绿灯，避免系统信息返回前标签钻进窗口按钮下面。
if (/Macintosh|Mac OS X/.test(navigator.userAgent)) {
  document.documentElement.dataset.windowControls = 'traffic-lights';
}

function applyTitlebar(info: SystemInfo) {
  const root = document.documentElement;
  if (info.os === 'darwin') {
    root.dataset.windowControls = 'traffic-lights';
    const major = Number.parseInt(info.version, 10);
    if (Number.isFinite(major) && major >= 27) root.dataset.titlebarVariant = 'tall';
  } else {
    delete root.dataset.windowControls;
  }
}

function paintBootTheme(mode: string, lightTheme: string, darkTheme: string) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(mode, lightTheme, darkTheme, systemDark);
  const root = document.documentElement;
  const dark = theme.endsWith('-dark');
  root.classList.toggle('dark', dark);
  root.dataset.theme = theme;
  root.style.colorScheme = dark ? 'dark' : 'light';
}

async function boot() {
  let os = '';
  let settings: Awaited<ReturnType<typeof GetConfig>> | null = null;
  try {
    const info = await GetSystemInfo();
    os = info.os;
    applyTitlebar(info);
  } catch {
    // 读取系统信息失败时保持默认标题栏几何，窗口外观也不应用。
  }
  try {
    settings = await GetConfig();
  } catch {
    settings = null;
  }
  rememberBoot(os, settings);
  const cfg = settings ?? defaultSettings;
  paintBootTheme(cfg.themeMode, cfg.lightTheme, cfg.darkTheme);
  // 渲染前只写 CSS 变量。原生窗底仍盖着首帧，避免先透出桌面。
  applyWindowOpacity(cfg.windowOpacity);
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <HashRouter>
        <FatalErrorBoundaryRoot>
          <SSHProfileProvider>
            <App />
          </SSHProfileProvider>
        </FatalErrorBoundaryRoot>
      </HashRouter>
    </React.StrictMode>,
  );
  clearNativeWindowBackground();
}

void boot();
