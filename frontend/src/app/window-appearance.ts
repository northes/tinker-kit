import { Window } from '@wailsio/runtime';
import type { Config as Settings } from '../../bindings/tinkerkit/models';

export const WINDOW_OPACITY_MIN = 30;
export const WINDOW_OPACITY_MAX = 100;

// boot 在首帧渲染前写入。设置页用它决定是否展示窗口外观，不在这里嗅探 UA。
export let hostOS = '';
export let bootSettings: Settings | null = null;

let opacityPreview: number | null = null;

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

// applyWindowOpacity 只在 macOS 把透明度写到 CSS 变量和原生窗底。其它平台保持不透明。
export function applyWindowOpacity(opacity: number) {
  const root = document.documentElement;
  const mac = hostOS === 'darwin';
  const clamped = mac ? clampWindowOpacity(opacityPreview ?? opacity) : WINDOW_OPACITY_MAX;
  root.style.setProperty('--window-opacity', mac ? String(clamped / 100) : '1');
  const dark = root.classList.contains('dark');
  const [r, g, b] = dark ? [27, 27, 27] : [235, 235, 235];
  const alpha = mac ? Math.round((clamped / 100) * 255) : 255;
  void Window.SetBackgroundColour(r, g, b, alpha).catch((error: unknown) => {
    console.error(error);
  });
}
