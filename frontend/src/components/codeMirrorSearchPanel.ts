import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
  SearchQuery,
} from '@codemirror/search';
import {
  EditorView,
  runScopeHandlers,
  ViewPlugin,
  type Panel,
  type ViewUpdate,
} from '@codemirror/view';
import i18n from '../i18n';

// 命中数超过上限就停止统计并显示 “N+”，避免大文档每次输入都全量扫描。
const MAX_MATCHES = 1000;

// 记录每个编辑器当前的面板实例，供快捷键直接展开替换行。
const searchPanels = new WeakMap<EditorView, AppSearchPanel>();

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(path: string) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const node = document.createElementNS(SVG_NS, 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

function button(className: string, label: string, content: Node | string) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.title = label;
  el.setAttribute('aria-label', label);
  el.append(content);
  return el;
}

// 自定义搜索面板：类似 VSCode 的查找/替换浮层，替换行可折叠。
class AppSearchPanel implements Panel {
  dom: HTMLElement;
  private view: EditorView;
  private query: SearchQuery;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private replaceRow: HTMLDivElement;
  private replaceToggle: HTMLButtonElement;
  private countEl: HTMLSpanElement;
  private caseButton: HTMLButtonElement;
  private regexpButton: HTMLButtonElement;
  private wordButton: HTMLButtonElement;
  private replaceOpen = false;
  // 记录打开面板时的光标位置，作为「第一个命中」的搜索起点。
  private origin: number;
  private destroyed = false;

  constructor(view: EditorView) {
    this.view = view;
    searchPanels.set(view, this);
    this.query = getSearchQuery(view.state);
    this.origin = view.state.selection.main.to;
    const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

    this.searchField = document.createElement('input');
    this.searchField.className = 'cm-app-search-input';
    this.searchField.placeholder = t('searchPanel.find');
    this.searchField.setAttribute('aria-label', t('searchPanel.find'));
    this.searchField.setAttribute('main-field', 'true');
    this.searchField.addEventListener('input', () => this.commit());

    this.countEl = document.createElement('span');
    this.countEl.className = 'cm-app-search-count';
    this.countEl.setAttribute('aria-live', 'polite');

    const prevButton = button(
      'cm-app-search-button',
      t('searchPanel.previous'),
      icon('M4 10 8 6 12 10'),
    );
    prevButton.addEventListener('click', () => {
      findPrevious(view);
      view.focus();
    });
    const nextButton = button(
      'cm-app-search-button',
      t('searchPanel.next'),
      icon('M4 6 8 10 12 6'),
    );
    nextButton.addEventListener('click', () => {
      findNext(view);
      view.focus();
    });
    const closeButton = button(
      'cm-app-search-button cm-app-search-close',
      t('searchPanel.close'),
      icon('M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5'),
    );
    closeButton.addEventListener('click', () => {
      closeSearchPanel(view);
      view.focus();
    });

    this.caseButton = this.makeToggle(t('searchPanel.matchCase'), 'Aa');
    this.regexpButton = this.makeToggle(t('searchPanel.regexp'), '.*');
    this.wordButton = this.makeToggle(t('searchPanel.wholeWord'), '\\b');

    const findRow = document.createElement('div');
    findRow.className = 'cm-app-search-row';
    this.replaceToggle = button(
      'cm-app-search-caret',
      t('searchPanel.toggleReplace'),
      icon('M6 4 10 8 6 12'),
    );
    this.replaceToggle.setAttribute('aria-expanded', 'false');
    findRow.append(
      this.replaceToggle,
      this.searchField,
      this.countEl,
      prevButton,
      nextButton,
      this.caseButton,
      this.regexpButton,
      this.wordButton,
      closeButton,
    );

    this.replaceField = document.createElement('input');
    this.replaceField.className = 'cm-app-search-input';
    this.replaceField.placeholder = t('searchPanel.replace');
    this.replaceField.setAttribute('aria-label', t('searchPanel.replace'));
    this.replaceField.addEventListener('input', () => this.commit());
    const replaceButton = button(
      'cm-app-search-button cm-app-search-text',
      t('searchPanel.replace'),
      t('searchPanel.replace'),
    );
    replaceButton.addEventListener('click', () => {
      replaceNext(view);
      this.replaceField.focus();
    });
    const replaceAllButton = button(
      'cm-app-search-button cm-app-search-text',
      t('searchPanel.replaceAll'),
      t('searchPanel.replaceAll'),
    );
    replaceAllButton.addEventListener('click', () => {
      replaceAll(view);
      this.replaceField.focus();
    });

    this.replaceRow = document.createElement('div');
    this.replaceRow.className = 'cm-app-search-row cm-app-search-replace';
    this.replaceRow.hidden = true;
    this.replaceRow.append(this.replaceField, replaceButton, replaceAllButton);

    this.replaceToggle.addEventListener('click', () => {
      this.setReplaceOpen(!this.replaceOpen);
      if (this.replaceOpen) this.replaceField.focus();
    });

    this.dom = document.createElement('div');
    this.dom.className = 'cm-app-search';
    this.dom.addEventListener('keydown', (event) => this.keydown(event));
    this.dom.append(findRow, this.replaceRow);

    this.setQuery(this.query);
    this.updateCount();
    // 打开时若已有查询，默认选中第一个命中；延后到本次更新结束后再派发。
    if (this.query.search) {
      queueMicrotask(() => {
        if (!this.destroyed) this.selectFirstMatch();
      });
    }
  }

  // 选中从 origin 起的第一个命中（没有则环绕到文档开头），并滚动到可见。
  private selectFirstMatch() {
    const query = this.query;
    if (!query.valid || !query.search) return;
    const state = this.view.state;
    let match = query.getCursor(state, this.origin).next();
    if (match.done && this.origin > 0) {
      match = query.getCursor(state, 0, this.origin).next();
    }
    if (match.done) return;
    this.view.dispatch({
      selection: { anchor: match.value.from, head: match.value.to },
      effects: EditorView.scrollIntoView(match.value.from, { y: 'center' }),
      userEvent: 'select.search',
    });
  }

  private makeToggle(label: string, text: string) {
    const el = button('cm-app-search-toggle', label, text);
    el.setAttribute('aria-pressed', 'false');
    el.addEventListener('click', () => {
      el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true'));
      this.commit();
    });
    return el;
  }

  private isOn(el: HTMLButtonElement) {
    return el.getAttribute('aria-pressed') === 'true';
  }

  private commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.isOn(this.caseButton),
      regexp: this.isOn(this.regexpButton),
      wholeWord: this.isOn(this.wordButton),
    });
    const matchChanged =
      query.search !== this.query.search ||
      query.caseSensitive !== this.query.caseSensitive ||
      query.regexp !== this.query.regexp ||
      query.wholeWord !== this.query.wholeWord;
    if (!query.eq(this.query)) {
      if (!query.search) this.origin = this.view.state.selection.main.to;
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
    if (matchChanged) this.selectFirstMatch();
  }

  private setQuery(query: SearchQuery) {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseButton.setAttribute('aria-pressed', String(query.caseSensitive));
    this.regexpButton.setAttribute('aria-pressed', String(query.regexp));
    this.wordButton.setAttribute('aria-pressed', String(query.wholeWord));
  }

  private updateCount() {
    const query = this.query;
    if (!query.search || !query.valid) {
      this.countEl.textContent = '';
      return;
    }
    const view = this.view;
    const selection = view.state.selection.main;
    let total = 0;
    let current = 0;
    const cursor = query.getCursor(view.state);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      total += 1;
      if (next.value.from === selection.from && next.value.to === selection.to) current = total;
      if (total >= MAX_MATCHES) break;
    }
    const capped = total >= MAX_MATCHES;
    const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
    this.countEl.textContent =
      total === 0
        ? t('searchPanel.noResults')
        : t('searchPanel.matches', {
            current,
            total,
            suffix: capped ? '+' : '',
          });
  }

  private keydown(event: KeyboardEvent) {
    if (runScopeHandlers(this.view, event, 'search-panel')) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
      return;
    }
    if (event.key === 'Enter' && event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }

  update(update: ViewUpdate) {
    let queryChanged = false;
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (!effect.is(setSearchQuery)) continue;
        queryChanged = true;
        if (!effect.value.eq(this.query)) this.setQuery(effect.value);
      }
    }
    if (queryChanged || update.docChanged || update.selectionSet) this.updateCount();
  }

  mount() {
    this.searchField.select();
  }

  // 快捷键打开时直接展开替换行。
  showReplace() {
    this.setReplaceOpen(true);
  }

  private setReplaceOpen(open: boolean) {
    this.replaceOpen = open;
    this.replaceRow.hidden = !open;
    this.replaceToggle.setAttribute('aria-expanded', String(open));
  }

  destroy() {
    this.destroyed = true;
  }

  get top() {
    return true;
  }
}

// 焦点在编辑器内时取该编辑器；否则取当前可见的第一个编辑器，模态弹窗打开时只在弹窗内查找。
function visibleEditorDom() {
  const active = document.activeElement;
  const focused = active instanceof HTMLElement ? active.closest<HTMLElement>('.cm-editor') : null;
  if (focused) return focused;
  const modal = document.querySelector<HTMLElement>(
    '[role="dialog"][data-open], [role="alertdialog"][data-open]',
  );
  for (const dom of (modal ?? document).querySelectorAll<HTMLElement>('.cm-editor')) {
    const style = getComputedStyle(dom);
    if (style.display === 'none' || style.visibility !== 'visible') continue;
    if (dom.getClientRects().length > 0) return dom;
  }
  return null;
}

// 打开搜索替换面板并展开替换行。
function openEditorSearchWithReplace(view: EditorView) {
  openSearchPanel(view);
  searchPanels.get(view)?.showReplace();
}

// Cmd/Ctrl+R 在当前界面存在可见编辑器时打开搜索替换面板，替代 WebView 刷新。
function openEditorSearchOnShortcut(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented) return;
  if (event.key.toLowerCase() !== 'r' || event.shiftKey || event.altKey) return;
  if (!event.metaKey && !event.ctrlKey) return;
  const dom = visibleEditorDom();
  if (!dom) return;
  const view = EditorView.findFromDOM(dom);
  if (!view) return;
  event.preventDefault();
  openEditorSearchWithReplace(view);
}

let shortcutEditorCount = 0;

// 编辑器全部卸载后移除监听，避免在没有编辑器的页面抢占 Cmd/Ctrl+R。
const searchShortcutPlugin = ViewPlugin.fromClass(
  class {
    constructor() {
      shortcutEditorCount += 1;
      if (shortcutEditorCount === 1)
        document.addEventListener('keydown', openEditorSearchOnShortcut, true);
    }
    destroy() {
      shortcutEditorCount -= 1;
      if (shortcutEditorCount === 0)
        document.removeEventListener('keydown', openEditorSearchOnShortcut, true);
    }
  },
);

// 附加到 EditorView 组合中；各工具通过 quietEditorTheme 共享同一个自定义面板。
export const appSearchPanel = [
  search({
    createPanel: (view: EditorView) => new AppSearchPanel(view),
  }),
  searchShortcutPlugin,
];
