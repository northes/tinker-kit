import { completionStatus, type CompletionContext } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { useMemo, type Ref } from 'react';
import { quietEditorTheme } from '../codeMirrorTheme';
import { editorCompletions } from '../codeMirrorCompletion';
import '../../styles/tools/editor.css';

// 仅标记词法类别；表达式校验与匹配仍由 Go 过滤器负责。
const filterLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === '"') {
      stream.next();
      while (!stream.eol()) {
        const char = stream.next();
        if (char === '\\' && /["\\]/.test(stream.peek() ?? '')) stream.next();
        else if (char === '"') break;
      }
      return 'string';
    }
    if (stream.match(/^(?:and|or|not)(?=\s|[()"]|$)/)) return 'keyword';
    if (stream.match(/^@[^\s()"]+/)) return 'typeName';
    if (stream.match(/^[()]/)) return 'bracket';
    stream.next();
    stream.eatWhile(/[^\s()"]/);
    return null;
  },
});

const singleLine = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || transaction.newDoc.lines === 1) return transaction;
  const changes: { from: number; to: number; insert: string }[] = [];
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes.push({ from, to, insert: inserted.toString().replace(/[\r\n]+/g, ' ') });
  });
  return { changes };
});

const compactTheme = EditorView.theme({
  '&': { height: '100%', borderRadius: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'hidden', borderRadius: 'inherit' },
  '.cm-content': { padding: '5px 0', minHeight: '0' },
  '.cm-line': { padding: '0 10px' },
});
const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  bracketMatching: false,
  closeBrackets: false,
  autocompletion: false,
  searchKeymap: false,
};

export function LogFilterInput({
  value,
  names,
  editorRef,
  onCompletionChange,
  regex,
  onChange,
  label,
  open,
  popupID,
  onFocus,
  onClick,
}: {
  value: string;
  names: string[];
  editorRef: Ref<ReactCodeMirrorRef>;
  onCompletionChange: (active: boolean) => void;
  regex: boolean;
  onChange: (value: string) => void;
  label: string;
  open: boolean;
  popupID: string;
  onFocus: () => void;
  onClick: () => void;
}) {
  const extensions = useMemo(
    () => [
      singleLine,
      compactTheme,
      EditorView.updateListener.of((update) => {
        onCompletionChange(completionStatus(update.state) !== null);
      }),
      EditorView.contentAttributes.of({
        'aria-label': label,
        'aria-expanded': String(open),
        'aria-controls': open ? popupID : '',
        'aria-haspopup': 'dialog',
        'aria-multiline': 'false',
        autocapitalize: 'off',
      }),
      ...(regex
        ? []
        : [
            filterLanguage,
            ...editorCompletions({
              tooltipClass: () => 'editor-autocomplete text-sm [--code-editor-font-size:14px]',
              override: [
                (context: CompletionContext) => {
                  const before = context.state.sliceDoc(0, context.pos);
                  let from = before.lastIndexOf('@');
                  if (from < 0) return null;
                  const prefix = before.slice(from);
                  if (!/^@(?:"(?:\\.|[^"\\])*|[^\s()"]*)$/.test(prefix)) return null;
                  // 当前 @ 必须位于表达式开头或左括号之后。
                  const preceding = before.slice(0, from).trimEnd();
                  if (preceding && !preceding.endsWith('(')) return null;
                  // 起点前的引号必须闭合，不能补全正文字符串中的 @。
                  const priorTokens =
                    preceding.match(/"(?:\\.|[^"\\])*"|"(?:\\.|[^"\\])*$|[^"]+/g) ?? [];
                  if (
                    priorTokens.some(
                      (token) => token.startsWith('"') && !/^"(?:\\.|[^"\\])*"$/.test(token),
                    )
                  )
                    return null;
                  const query = prefix.slice(1).replace(/^"/, '').toLowerCase();
                  return {
                    from,
                    filter: false,
                    options: names
                      .filter((name) => name.toLowerCase().includes(query))
                      .map((name) => ({
                        label: name,
                        type: 'variable',
                        apply:
                          '@' + (/^[^\s()"@]+$/.test(name) ? name : JSON.stringify(name)) + ' ',
                      })),
                  };
                },
              ],
              activateOnTyping: true,
            }),
          ]),
    ],
    [label, open, popupID, regex, names, onCompletionChange],
  );
  return (
    <div className="h-full min-w-0 [--code-editor-font-size:14px]" onClick={onClick}>
      <CodeMirror
        ref={editorRef}
        value={value}
        height="30px"
        placeholder={label}
        theme={quietEditorTheme}
        basicSetup={basicSetup}
        extensions={extensions}
        indentWithTab={false}
        spellCheck={false}
        onFocus={onFocus}
        onChange={onChange}
      />
    </div>
  );
}
