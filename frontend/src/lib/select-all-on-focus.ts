import type { FocusEvent, MouseEvent } from 'react';

// 这次指针按下会在松开时把选区收成光标；只记下尚未聚焦的那一次。
const pendingPointerSelect = new WeakSet<HTMLInputElement>();

function canSelect(input: HTMLInputElement) {
  return !input.disabled && input.value.length > 0;
}

function isMouseEvent(
  event: FocusEvent<HTMLInputElement> | MouseEvent<HTMLInputElement>,
): event is MouseEvent<HTMLInputElement> {
  return event.type === 'mousedown' || event.type === 'mouseup';
}

/**
 * 主机 / 地址输入框获得焦点时全选现有文字。
 * 同时挂到 onMouseDown / onMouseUp：首次点入先记下，聚焦时全选；
 * mouseup 再补一次并取消默认动作，避免浏览器把选区收到点击位置。
 * 已经聚焦后再点不拦截，光标仍落在点击处。
 * 空内容或禁用时不做任何事。
 *
 * Base UI 1.7 的 Combobox 打开浮层不会改选区（只有 Home/End 会移动光标，
 * 受控 inputValue 不变时 React 也不会重写 input.value）。选区被清掉来自浏览器的 mouseup。
 */
export function selectAllOnFocus(
  event: FocusEvent<HTMLInputElement> | MouseEvent<HTMLInputElement>,
) {
  const input = event.currentTarget;

  if (isMouseEvent(event)) {
    if (event.type === 'mousedown') {
      if (event.button !== 0 || !canSelect(input) || input.ownerDocument.activeElement === input) {
        pendingPointerSelect.delete(input);
        return;
      }
      pendingPointerSelect.add(input);
      return;
    }
    if (!pendingPointerSelect.delete(input) || !canSelect(input)) return;
    event.preventDefault();
    input.select();
    return;
  }

  if (!canSelect(input)) return;
  input.select();
}
