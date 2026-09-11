import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { BracketsCurly, CaretDown, Check } from '@phosphor-icons/react';

export type ToolId =
  | 'json'
  | 'time'
  | 'text'
  | 'base64'
  | 'diff'
  | 'jwt'
  | 'url'
  | 'image'
  | 'image-manager'
  | 'ssh-files';
export type PendingAction = {
  tool: ToolId;
  action: string;
  input: string;
  output?: string;
  mode?: string;
  target?: 'before' | 'after';
  pane?: 'input' | 'result';
};
export type Icon = typeof BracketsCurly;

export function stripJsonComments(s: string) {
  let out = '',
    inStr = false,
    esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function stripTrailingCommas(s: string) {
  let out = '',
    inStr = false,
    esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

export function parseJsonLoose(s: string) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(s)));
}

export function decodeBase64(raw: string): string | null {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  if (padded.length % 4 === 1) return null;
  try {
    const decoded = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const norm = (x: string) => x.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return norm(btoa(decoded)) === norm(raw) ? decoded : null;
  } catch {
    return null;
  }
}

export function decodeBase64Text(raw: string): string | null {
  const decoded = decodeBase64(raw);
  if (decoded === null) return null;
  try {
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    const normalize = (value: string) =>
      value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return normalize(encoded) === normalize(raw) ? text : null;
  } catch {
    return null;
  }
}

export function hasComments(s: string) {
  return stripJsonComments(s) !== s;
}

export function formatJsonPreserve(src: string) {
  const toks: Array<{ t: string; v: string; ls: boolean }> = [];
  let i = 0,
    ls = true;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      let v = q;
      i++;
      while (i < src.length) {
        const ch = src[i];
        v += ch;
        i++;
        if (ch === '\\') {
          if (i < src.length) {
            v += src[i];
            i++;
          }
          continue;
        }
        if (ch === q) break;
      }
      toks.push({ t: 'str', v, ls });
      ls = false;
    } else if (c === '/' && src[i + 1] === '/') {
      let v = '';
      while (i < src.length && src[i] !== '\n') {
        v += src[i];
        i++;
      }
      toks.push({ t: 'line', v, ls });
      ls = false;
    } else if (c === '/' && src[i + 1] === '*') {
      let v = '/*';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        v += src[i];
        i++;
      }
      if (src[i]) {
        v += '*/';
        i += 2;
      }
      toks.push({ t: 'block', v, ls });
      ls = false;
    } else if ('{}[],:'.includes(c)) {
      toks.push({ t: c, v: c, ls });
      ls = false;
      i++;
    } else if (/\s/.test(c)) {
      if (c === '\n') ls = true;
      i++;
    } else {
      let v = '';
      while (i < src.length && !/[\s{}[\]:,'"\/]/.test(src[i])) {
        v += src[i];
        i++;
      }
      toks.push({ t: 'v', v, ls });
      ls = false;
    }
  }
  let out = '',
    depth = 0,
    lsOut = true,
    inValue = false;
  const ind = () => '  '.repeat(depth);
  const nl = () => {
    out += '\n' + ind();
    lsOut = true;
  };
  for (let k = 0; k < toks.length; k++) {
    const x = toks[k];
    if (x.t === '{' || x.t === '[') {
      const close = x.t === '{' ? '}' : ']';
      if (k + 1 < toks.length && toks[k + 1].t === close) {
        if (!lsOut && !inValue) nl();
        out += x.t + close;
        lsOut = false;
        inValue = false;
        k++;
        continue;
      }
      if (!inValue && !lsOut) nl();
      out += x.t;
      depth++;
      nl();
      lsOut = true;
      inValue = false;
    } else if (x.t === '}' || x.t === ']') {
      depth = Math.max(0, depth - 1);
      out = out.replace(/\s+$/, '');
      nl();
      out += x.t;
      lsOut = false;
      inValue = false;
    } else if (x.t === ':') {
      out += ': ';
      lsOut = false;
      inValue = true;
    } else if (x.t === ',') {
      out += ',';
      nl();
      inValue = false;
    } else if (x.t === 'line') {
      if (x.ls) {
        if (!lsOut) nl();
        out += x.v;
        nl();
      } else {
        if (!lsOut) out += ' ';
        out += x.v;
        nl();
      }
    } else if (x.t === 'block') {
      if (x.ls) {
        if (!lsOut) nl();
        out += x.v;
        lsOut = false;
      } else {
        if (!lsOut) out += ' ';
        out += x.v;
        lsOut = false;
      }
    } else {
      if (!inValue && !lsOut) nl();
      out += x.v;
      lsOut = false;
      inValue = false;
    }
  }
  return out;
}

export const samples = {
  json: '{"project":"TinkerKit","version":1,"features":["search","clipboard","privacy"],"owner":{"team":"developer experience","active":true}}',
  text: '  Build tools that stay out of the way.\nShip faster, keep data local.  ',
};

export function Reveal({
  children,
  index,
  fill,
  active,
}: {
  children: React.ReactNode;
  index?: number;
  fill?: boolean;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (active !== undefined) {
      setVisible(active);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);
  return (
    <div
      ref={ref}
      className={`${fill ? 'h-full min-h-0 ' : ''}transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}
      style={{ transitionDelay: `${(index ?? 0) * 80}ms` }}
    >
      {children}
    </div>
  );
}

export function ToolLayoutHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="row-start-1 mt-[5px] mb-3.5 min-w-0 text-muted-foreground">
      <h1 className="m-0 text-[19px] leading-tight font-semibold tracking-[-.01em] text-foreground">
        {title}
      </h1>
      {subtitle ? <p className="mt-1 mb-0 text-[10px] leading-[1.5]">{subtitle}</p> : null}
    </header>
  );
}

export function ToolLayoutToolbar({
  left,
  right,
  className = '',
  rightClassName = '',
}: {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
  rightClassName?: string;
}) {
  if (!left && !right) return null;
  return (
    <div
      className={`tool-layout-toolbar row-start-2 flex min-w-0 flex-wrap items-end gap-4 pb-3 max-[700px]:flex-col max-[700px]:items-stretch${className ? ` ${className}` : ''}`}
    >
      {left ? <div className="flex min-w-0 flex-wrap items-end gap-4">{left}</div> : null}
      {right ? (
        <div
          className={`ml-auto flex min-w-0 flex-wrap items-end gap-2 max-[700px]:ml-0${rightClassName ? ` ${rightClassName}` : ''}`}
        >
          {right}
        </div>
      ) : null}
    </div>
  );
}

export function ToolLayoutToolbarGroup({
  children,
  className = '',
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-wrap items-end gap-5${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

export function ToolLayoutContent({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`tool-layout-content row-start-3 h-full min-h-0 min-w-0 overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

export function ToolLayoutScrollableContent({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`tool-layout-content row-start-3 h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [padding-inline-end:var(--overlay-scrollbar-hit-size)] ${className}`}
    >
      {children}
    </div>
  );
}

export function ToolLayoutFooter({ children }: { children?: ReactNode }) {
  return <footer className="row-start-4 min-h-0 min-w-0">{children}</footer>;
}

export function ToolLayout({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden px-7 pt-5 pb-[26px] max-[700px]:px-[18px] max-[700px]:pt-3.5 max-[700px]:pb-4 ${className}`}
    >
      {children}
    </section>
  );
}

export type ToolBarAction =
  | {
      key: string;
      label: string;
      icon?: Icon;
      variant: 'primary' | 'secondary' | 'tertiary' | 'danger';
      type?: undefined;
      disabled?: boolean;
      onPress: () => void;
    }
  | {
      key: string;
      label: string;
      type: 'select';
      disabled?: boolean;
      options: Array<{ key: string; label: string }>;
      onSelect: (value: string) => void;
    }
  | {
      key: string;
      label: string;
      variant: 'primary' | 'secondary' | 'tertiary' | 'danger';
      type: 'split';
      disabled?: boolean;
      onPress: () => void;
      menuLabel: string;
      menuChecked: boolean;
      menuItemLabel: string;
      onMenuToggle: () => void;
    };

const buttonVariant = {
  primary: 'default',
  secondary: 'outline',
  tertiary: 'ghost',
  danger: 'destructive',
} as const;

export function ToolActionBar({ label, actions }: { label: string; actions: ToolBarAction[] }) {
  return (
    <div
      className="mt-3 flex min-h-[30px] flex-wrap items-center justify-end gap-1.5"
      role="toolbar"
      aria-label={label}
    >
      {actions.map((action) =>
        action.type === 'select' ? (
          <Select
            key={action.key}
            value={null}
            disabled={action.disabled}
            items={action.options.map((option) => ({ value: option.key, label: option.label }))}
            onValueChange={(v) => {
              if (v !== null) action.onSelect(v);
            }}
          >
            <SelectTrigger className="h-[30px] min-w-24 flex-none px-[11px] text-[11px] hover:bg-accent hover:text-accent-foreground [&_svg]:size-3.5">
              <SelectValue placeholder={action.label} />
            </SelectTrigger>
            <SelectContent>
              {action.options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : action.type === 'split' ? (
          <div
            key={action.key}
            className="inline-flex h-[30px] flex-none items-stretch"
            role="group"
            aria-label={action.label}
          >
            <Button
              variant={buttonVariant[action.variant]}
              disabled={action.disabled}
              onClick={action.onPress}
              className="h-[30px] flex-none rounded-r-none px-2.5 text-[11px] focus-visible:z-1 [&_svg]:size-3.5"
            >
              {action.label}
            </Button>
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant={buttonVariant[action.variant]}
                    size="icon-sm"
                    className={`relative h-[30px] w-[30px] min-w-[30px] flex-none rounded-l-none p-0 text-[11px] before:pointer-events-none before:absolute before:top-[6px] before:bottom-[6px] before:left-0 before:w-px before:bg-[color-mix(in_srgb,var(--primary-foreground)_28%,transparent)] focus-visible:z-1 [&_svg]:size-3.5 ${action.disabled ? 'opacity-50' : ''}`}
                    aria-label={action.menuLabel}
                  />
                }
              >
                <CaretDown size={12} weight="duotone" />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-auto min-w-0 overflow-hidden p-1 [scrollbar-gutter:auto]"
                role="menu"
              >
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={action.menuChecked}
                  className="flex min-h-7 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs whitespace-nowrap text-popover-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={action.onMenuToggle}
                >
                  <Check
                    data-icon="inline-start"
                    size={12}
                    weight="duotone"
                    className={action.menuChecked ? undefined : 'opacity-0'}
                    aria-hidden
                  />
                  <span>{action.menuItemLabel}</span>
                </button>
              </PopoverContent>
            </Popover>
          </div>
        ) : (
          <Button
            key={action.key}
            variant={buttonVariant[action.variant]}
            disabled={action.disabled}
            onClick={action.onPress}
            className="h-[30px] flex-none px-[11px] text-[11px] [&_svg]:size-3.5"
          >
            {action.icon && <action.icon data-icon="inline-start" size={14} weight="duotone" />}
            {action.label}
          </Button>
        ),
      )}
    </div>
  );
}
export function useHistory(initial: string) {
  const [value, setValueState] = useState(initial);
  const valueRef = useRef(initial);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastAt = useRef(0);
  const commit = (next: string, opts?: { isolate?: boolean }) => {
    const cur = valueRef.current;
    if (next === cur) return;
    const now = Date.now();
    if (!opts?.isolate && now - lastAt.current < 600 && past.current.length)
      past.current[past.current.length - 1] = cur;
    else {
      past.current.push(cur);
      if (past.current.length > 100) past.current.shift();
    }
    future.current = [];
    lastAt.current = now;
    valueRef.current = next;
    setValueState(next);
  };
  const undo = () => {
    if (!past.current.length) return;
    future.current.push(valueRef.current);
    valueRef.current = past.current.pop()!;
    setValueState(valueRef.current);
    lastAt.current = 0;
  };
  const redo = () => {
    if (!future.current.length) return;
    past.current.push(valueRef.current);
    valueRef.current = future.current.pop()!;
    setValueState(valueRef.current);
    lastAt.current = 0;
  };
  return { value, setValue: commit, undo, redo };
}

export function undoRedoKey(e: React.KeyboardEvent, undo: () => void, redo: () => void) {
  if (e.nativeEvent.isComposing) return false;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
    return true;
  }
  if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) {
    e.preventDefault();
    redo();
    return true;
  }
  return false;
}

export function useFocusOnActivate(active: boolean, focus: () => void) {
  const prev = useRef(active);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (active && !prev.current) focusRef.current();
    prev.current = active;
  }, [active]);
}
