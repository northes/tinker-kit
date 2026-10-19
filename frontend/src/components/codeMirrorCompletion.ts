import { acceptCompletion, autocompletion } from '@codemirror/autocomplete';
import { Prec } from '@codemirror/state';
import { keymap, tooltips } from '@codemirror/view';
import '../styles/tools/editor.css';

export function editorCompletions(config: Parameters<typeof autocompletion>[0] = {}) {
  return [
    autocompletion({ tooltipClass: () => 'editor-autocomplete', ...config }),
    tooltips({ position: 'fixed', parent: document.body }),
    Prec.high(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ];
}
