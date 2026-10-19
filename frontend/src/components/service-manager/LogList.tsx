import { CaretDown } from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServiceLogLine } from '../../../bindings/tinkerkit/models';
import { ansiPlainText, parseAnsi, type AnsiSpan } from '../../lib/ansi';
import { WheelText } from '../shared';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { dayKeyOf, logDayKey, logTime } from './model';

const LOG_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,5fr)] items-start gap-3 px-3';

export function LogList({
  lines,
  query,
  highlightPatterns,
  regex,
  caseSensitive,
  sourceLabels,
  highlightLevels,
}: {
  lines: ServiceLogLine[];
  query: string;
  highlightPatterns: Record<string, string | undefined>;
  regex: boolean;
  caseSensitive: boolean;
  sourceLabels?: Map<string, string>;
  highlightLevels: boolean;
}) {
  const { t } = useTranslation();
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [activeDay, setActiveDay] = useState('');
  const dayKeys = useMemo(() => lines.map(logDayKey), [lines]);
  const multiDay = useMemo(() => dayKeys.some((key) => key !== dayKeys[0]), [dayKeys]);
  const showDate = multiDay || (dayKeys.length > 0 && dayKeys[0] !== dayKeyOf(new Date()));
  const dayKeysRef = useRef(dayKeys);
  const showDateRef = useRef(showDate);
  const getItemKey = useCallback((index: number) => lines[index].sequence, [lines]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewport,
    getItemKey,
    estimateSize: () => 24,
    overscan: 20,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;
  useEffect(() => {
    if (!viewport) return;
    const update = () => {
      const next = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 8;
      stickToBottom.current = next;
      setAtBottom(next);
      if (!showDateRef.current) {
        setActiveDay('');
        return;
      }
      const keys = dayKeysRef.current;
      const cache = virtualizer.measurementsCache;
      let lo = 0;
      let hi = cache.length - 1;
      let index = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cache[mid].start <= viewport.scrollTop) {
          index = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const day = keys[index] ?? '';
      setActiveDay((current) => (current === day ? current : day));
    };
    update();
    viewport.addEventListener('scroll', update, { passive: true });
    return () => viewport.removeEventListener('scroll', update);
  }, [viewport, virtualizer]);
  useEffect(() => {
    dayKeysRef.current = dayKeys;
    showDateRef.current = showDate;
    if (!showDate) setActiveDay('');
  }, [dayKeys, showDate]);
  const scrollToBottom = () => {
    stickToBottom.current = true;
    setAtBottom(true);
    if (!viewport) return;
    if (lines.length) virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
  };
  const lastSequence = lines.length ? lines[lines.length - 1].sequence : 0;
  useEffect(() => {
    if (!viewport || !stickToBottom.current || lines.length === 0) return;
    virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    // 动态行高在测量后总高度还会增长，连续几帧贴底以跟上测量结果。
    let cancelled = false;
    let frame = 0;
    let raf = 0;
    const pin = () => {
      if (cancelled) return;
      viewport.scrollTop = viewport.scrollHeight;
      if (frame++ < 2) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [lastSequence, lines.length, viewport, virtualizer]);
  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div
        className={`${LOG_GRID} border-b py-1 text-[10px] font-medium tracking-[.04em] text-muted-foreground uppercase`}
      >
        <span>{t('serviceManagerTool.logTime')}</span>
        <span>{t('serviceManagerTool.logService')}</span>
        <span>{t('serviceManagerTool.logContent')}</span>
      </div>
      <div className="relative min-h-0">
        <ScrollArea
          className="h-full min-h-0 font-mono text-xs [padding-inline-end:var(--overlay-scrollbar-size)]"
          options={{ overflow: { x: 'hidden' } }}
          onViewport={setViewport}
        >
          <div className="w-full">
            {paddingTop > 0 ? <div style={{ height: paddingTop }} /> : null}
            {virtualRows.map((row) => {
              const line = lines[row.index];
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  className={`w-full border-b py-1 ${LOG_GRID} ${highlightLevels ? logLevelBackground(line.text) : ''}`}
                >
                  <WheelText className="text-muted-foreground">{logTime(line)}</WheelText>
                  <WheelText className="text-primary">
                    {sourceLabels?.get(line.monitorID) ?? line.name}
                  </WheelText>
                  <span className="break-all whitespace-pre-wrap">
                    {renderLogText(
                      line.text,
                      highlightPatterns[line.name] ?? query,
                      regex,
                      caseSensitive,
                    )}
                  </span>
                </div>
              );
            })}
            {paddingBottom > 0 ? <div style={{ height: paddingBottom }} /> : null}
          </div>
        </ScrollArea>
        {showDate && activeDay ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 px-3 pt-0.5">
            <span className="inline-block rounded bg-popover/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground ring-1 ring-border">
              {activeDay}
            </span>
          </div>
        ) : null}
        {!atBottom && lines.length ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="absolute right-3 bottom-3 z-10 rounded-full bg-card shadow-md hover:bg-muted dark:bg-card dark:hover:bg-muted"
            title={t('serviceManagerTool.scrollToBottom')}
            aria-label={t('serviceManagerTool.scrollToBottom')}
            onClick={scrollToBottom}
          >
            <CaretDown weight="duotone" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function renderLogText(
  text: string,
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): ReactNode {
  const { text: plain, spans } = parseAnsi(text);
  const ranges = logMatchRanges(plain, query, regex, caseSensitive);
  if (!ranges.length) {
    if (spans.length === 1 && !spans[0].className && !spans[0].style) return spans[0].text;
    return spans.map((span, index) => logSpan(span, span.text, index));
  }
  const nodes: ReactNode[] = [];
  let position = 0;
  let key = 0;
  for (const span of spans) {
    const spanEnd = position + span.text.length;
    let consumed = 0;
    for (const range of ranges) {
      if (range.end <= position) continue;
      if (range.start >= spanEnd) break;
      const start = Math.max(range.start, position);
      const stop = Math.min(range.end, spanEnd);
      if (start > position + consumed)
        nodes.push(logSpan(span, span.text.slice(consumed, start - position), key++));
      nodes.push(logSpan(span, span.text.slice(start - position, stop - position), key++, true));
      consumed = stop - position;
    }
    if (consumed < span.text.length) nodes.push(logSpan(span, span.text.slice(consumed), key++));
    position = spanEnd;
  }
  return nodes;
}

function logSpan(span: AnsiSpan, content: string, key: number, marked = false): ReactNode {
  if (!content) return null;
  if (marked) {
    return (
      <mark key={key} className="rounded-[2px] bg-warning font-medium text-neutral-950">
        {content}
      </mark>
    );
  }
  if (!span.className && !span.style) return content;
  return (
    <span key={key} className={span.className || undefined} style={span.style}>
      {content}
    </span>
  );
}

function logMatchRanges(
  text: string,
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): Array<{ start: number; end: number }> {
  if (!query) return [];
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    return [];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[0]) {
      pattern.lastIndex += 1;
      continue;
    }
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function logLevelBackground(text: string) {
  const plain = ansiPlainText(text);
  if (/\bERROR\b/i.test(plain)) return 'bg-destructive/15';
  if (/\bWARN(?:ING)?\b/i.test(plain)) return 'bg-warning/20';
  return '';
}
