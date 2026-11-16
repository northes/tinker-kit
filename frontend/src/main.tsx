import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router';
import App from './App';
import { FatalErrorBoundaryRoot } from './components/FatalErrorBoundary';
import { GetSystemInfo } from '../bindings/tinkerkit/systeminfoservice';
import { SSHProfileProvider } from './components/SSHProfileManagerDialog';
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

// macOS 27 起系统窗口的红绿灯区域更宽更高，标题栏需切换为 tall 几何；
// 其余平台（含旧版 macOS）沿用默认标题栏实现。没有红绿灯的平台不为窗口按钮留白。
void GetSystemInfo()
  .then((info) => {
    const root = document.documentElement;
    if (info.os === 'darwin') {
      root.dataset.windowControls = 'traffic-lights';
      const major = Number.parseInt(info.version, 10);
      if (Number.isFinite(major) && major >= 27) root.dataset.titlebarVariant = 'tall';
    } else {
      delete root.dataset.windowControls;
    }
  })
  .catch(() => {
    // 读取系统信息失败时保持默认标题栏几何。
  });

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
