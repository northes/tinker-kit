import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router';
import App from './App';
import { FatalErrorBoundaryRoot } from './components/FatalErrorBoundary';
import { GetSystemInfo } from '../bindings/changeme/systeminfoservice';
import { SSHProfileProvider } from './components/SSHProfileManagerDialog';
import './i18n';
import './index.css';

// macOS 27 起系统窗口的红绿灯区域更宽更高，标题栏需切换为 tall 几何；
// 其余平台（含旧版 macOS）沿用默认标题栏实现。
void GetSystemInfo()
  .then((info) => {
    const major = Number.parseInt(info.version, 10);
    if (info.os === 'darwin' && Number.isFinite(major) && major >= 27) {
      document.documentElement.dataset.titlebarVariant = 'tall';
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
