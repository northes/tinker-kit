import { Window } from '@wailsio/runtime';
import type { Config as Settings } from '../../bindings/tinkerkit/models';

export const WINDOW_OPACITY_MIN = 30;
export const WINDOW_OPACITY_MAX = 100;

// boot 在首帧渲染前写入。设置页用它决定是否展示窗口外观，不在这里嗅探 UA。
export let hostOS = '';
export let bootSettings: Settings | null = null;

let opacityPreview: number | null = null;
// 首帧画出之前保持创建时的不透明窗底。归零之后不再按滑块回写 alpha。
let nativeBackgroundCleared = false;

export function rememberBoot(os: string, settings: Settings | null) {
  hostOS = os;
  bootSettings = settings;
}

export function clampWindowOpacity(value: number): number {
  if (!Number.isFinite(value)) return WINDOW_OPACITY_MAX;
  const rounded = Math.round(value);
  if (rounded < WINDOW_OPACITY_MIN) return WINDOW_OPACITY_MIN;
  if (rounded > WINDOW_OPACITY_MAX) return WINDOW_OPACITY_MAX;
  return rounded;
}

export function setWindowOpacityPreview(value: number | null) {
  opacityPreview = value == null ? null : clampWindowOpacity(value);
}

function chromeRGB(): [number, number, number] {
  return document.documentElement.classList.contains('dark') ? [27, 27, 27] : [235, 235, 235];
}

function setNativeWindowAlpha(alpha: number) {
  const [r, g, b] = chromeRGB();
  void Window.SetBackgroundColour(r, g, b, alpha).catch((error: unknown) => {
    console.error(error);
  });
}

// applyWindowOpacity 只把透明度写进 CSS。macOS 的原生窗底在首帧之后恒为 0，避免和 color-mix 叠成两层。
export function applyWindowOpacity(opacity: number) {
  const mac = hostOS === 'darwin';
  const clamped = mac ? clampWindowOpacity(opacityPreview ?? opacity) : WINDOW_OPACITY_MAX;
  document.documentElement.style.setProperty('--window-opacity', mac ? String(clamped / 100) : '1');
  if (!mac) {
    setNativeWindowAlpha(255);
    return;
  }
  if (!nativeBackgroundCleared) return;
  setNativeWindowAlpha(0);
}

// render 调用返回后排一帧再归零。React 提交先于这一帧，空窗仍由创建时的不透明窗底盖着。
export function clearNativeWindowBackground() {
  if (hostOS !== 'darwin') return;
  requestAnimationFrame(() => {
    nativeBackgroundCleared = true;
    setNativeWindowAlpha(0);
  });
}
