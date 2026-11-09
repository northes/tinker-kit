import { acceptCompletion, autocompletion, closeCompletion } from '@codemirror/autocomplete';
import { Prec } from '@codemirror/state';
import { keymap, tooltips } from '@codemirror/view';
import '../styles/tools/editor.css';

export function editorCompletions(config: Parameters<typeof autocompletion>[0] = {}) {
  return [
    autocompletion({ tooltipClass: () => 'editor-autocomplete', ...config }),
    tooltips({ position: 'fixed', parent: document.body }),
    Prec.high(
      keymap.of([
        { key: 'Tab', run: acceptCompletion },
        // 补全消费 Esc 时阻止继续关闭外层弹窗；无补全时交回原有关闭行为。
        { key: 'Escape', run: closeCompletion, stopPropagation: true },
      ]),
    ),
  ];
}
