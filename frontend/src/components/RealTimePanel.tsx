import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowClockwise, DotsNine, GearSix, Globe, Plus, X } from '@phosphor-icons/react';
import { GetRealTime } from '../../bindings/changeme/realtimeservice';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { NtpServerDialog } from './NtpServerDialog';
import { TimezoneCombobox } from './TimezoneCombobox';
import { getSystemTimeZone, getTimeZoneOptions } from '../utils/time';
import { worldLandDots } from '../utils/worldLandDots';

type ClockEntry = { id: string; zone: string };
const mapReferenceTime = new Date(Date.UTC(2025, 0, 15, 12));
const initialZones = ['Asia/Shanghai', 'UTC', 'America/New_York'];
const cityZones: Array<{ longitude: number; latitude: number; zone: string }> = [
  { longitude: -157.8, latitude: 21.3, zone: 'Pacific/Honolulu' },
  { longitude: -149.9, latitude: 61.2, zone: 'America/Anchorage' },
  { longitude: -123.1, latitude: 49.3, zone: 'America/Vancouver' },
  { longitude: -118.2, latitude: 34.1, zone: 'America/Los_Angeles' },
  { longitude: -104.9, latitude: 39.7, zone: 'America/Denver' },
  { longitude: -87.6, latitude: 41.9, zone: 'America/Chicago' },
  { longitude: -74, latitude: 40.7, zone: 'America/New_York' },
  { longitude: -66.9, latitude: 10.5, zone: 'America/Caracas' },
  { longitude: -46.6, latitude: -23.5, zone: 'America/Sao_Paulo' },
  { longitude: -25.7, latitude: 37.7, zone: 'Atlantic/Azores' },
  { longitude: -21.9, latitude: 64.1, zone: 'Atlantic/Reykjavik' },
  { longitude: -0.1, latitude: 51.5, zone: 'Europe/London' },
  { longitude: 2.3, latitude: 48.9, zone: 'Europe/Paris' },
  { longitude: 28, latitude: -26.2, zone: 'Africa/Johannesburg' },
  { longitude: 31.2, latitude: 30, zone: 'Africa/Cairo' },
  { longitude: 37.6, latitude: 55.8, zone: 'Europe/Moscow' },
  { longitude: 55.3, latitude: 25.2, zone: 'Asia/Dubai' },
  { longitude: 67, latitude: 24.9, zone: 'Asia/Karachi' },
  { longitude: 77.2, latitude: 28.6, zone: 'Asia/Kolkata' },
  { longitude: 85.3, latitude: 27.7, zone: 'Asia/Kathmandu' },
  { longitude: 100.5, latitude: 13.8, zone: 'Asia/Bangkok' },
  { longitude: 103.8, latitude: 1.3, zone: 'Asia/Singapore' },
  { longitude: 106.8, latitude: -6.2, zone: 'Asia/Jakarta' },
  { longitude: 121.5, latitude: 31.2, zone: 'Asia/Shanghai' },
  { longitude: 127, latitude: 37.6, zone: 'Asia/Seoul' },
  { longitude: 139.7, latitude: 35.7, zone: 'Asia/Tokyo' },
  { longitude: 151.2, latitude: -33.9, zone: 'Australia/Sydney' },
  { longitude: 174.8, latitude: -36.9, zone: 'Pacific/Auckland' },
  { longitude: -171.8, latitude: -13.8, zone: 'Pacific/Apia' },
];

function SortableClock({
  entry,
  zones,
  onRemove,
  onLocate,
  canRemove,
  now,
  waitingLabel,
  removeLabel,
  index,
  selected,
}: {
  entry: ClockEntry;
  zones: Array<{ id: string; label: string }>;
  onRemove: () => void;
  onLocate: () => void;
  canRemove: boolean;
  now: number | null;
  waitingLabel: string;
  removeLabel: string;
  index: number;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
  });
  const parts =
    now === null
      ? []
      : new Intl.DateTimeFormat('en-CA', {
          timeZone: entry.zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date(now));
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? '';
  const fraction =
    now === null
      ? null
      : Math.floor((now % 1000) * 1e6)
          .toString()
          .padStart(9, '0');
  const zoneName = zones.find((zone) => zone.id === entry.zone)?.label ?? entry.zone;
  const zoneOffset =
    now === null
      ? 'UTC'
      : (new Intl.DateTimeFormat('en-US', { timeZone: entry.zone, timeZoneName: 'shortOffset' })
          .formatToParts(new Date(now))
          .find((part) => part.type === 'timeZoneName')?.value ?? 'UTC');
  return (
    <div
      ref={setNodeRef}
      data-clock-id={entry.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`w-[290px] flex-none border-e border-border px-4 py-4 ${selected ? 'bg-accent' : ''} ${isDragging ? 'opacity-50' : ''}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <Button
          variant="ghost"
          className="h-7 w-10 min-w-10 flex-none cursor-grab gap-1 px-1 text-muted-foreground"
          aria-label={t('timeTool.realTime.dragZone', { zone: zoneName })}
          {...attributes}
          {...listeners}
        >
          <DotsNine size={17} weight="duotone" />
          <span className="font-mono text-[10px] tabular-nums">{index}</span>
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{zoneName}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {zoneOffset}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={removeLabel}
          disabled={!canRemove}
          onClick={onRemove}
        >
          <X size={14} />
        </Button>
      </div>
      <Button
        variant="ghost"
        className="block h-auto justify-start p-0 text-start font-mono text-[34px] font-medium leading-tight tabular-nums tracking-tight text-foreground hover:bg-transparent"
        onClick={onLocate}
        aria-label={t('timeTool.realTime.locate', { zone: zoneName })}
      >
        {now === null ? (
          '--:--:--.---'
        ) : (
          <>
            {value('hour')}:{value('minute')}:{value('second')}
            <span className="text-muted-foreground">.{fraction?.slice(0, 3)}</span>
          </>
        )}
      </Button>
      <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
        {now === null ? waitingLabel : `${value('year')}-${value('month')}-${value('day')}`}
      </div>
    </div>
  );
}

export default function RealTimePanel({
  ntpServers,
  onNtpServersChange,
}: {
  ntpServers: string[];
  onNtpServersChange: (ntpServers: string[]) => void;
}) {
  const { t } = useTranslation();
  const zones = useMemo(() => getTimeZoneOptions(), []);
  const [clocks, setClocks] = useState<ClockEntry[]>(() => {
    const selected = [
      getSystemTimeZone(),
      ...initialZones.filter((zone) => zone !== getSystemTimeZone()),
    ];
    return selected.map((zone, index) => ({ id: `clock-${index}`, zone }));
  });
  const [now, setNow] = useState<number | null>(null);
  const [syncState, setSyncState] = useState<'syncing' | 'synced' | 'error'>('syncing');
  const [focusedZone, setFocusedZone] = useState<string | null>(null);
  const [mapCandidate, setMapCandidate] = useState<string | null>(null);
  const [zoneToAdd, setZoneToAdd] = useState(getSystemTimeZone);
  const [ntpOpen, setNtpOpen] = useState(false);
  const anchor = useRef({ epoch: 0, performance: performance.now(), synced: false });
  const ntpServersRef = useRef(ntpServers);
  ntpServersRef.current = ntpServers;
  const syncInFlight = useRef(false);
  const clockViewport = useRef<HTMLElement | null>(null);
  const setClockViewport = useCallback((viewport: HTMLElement | null) => {
    clockViewport.current = viewport;
  }, []);
  const panelViewport = useRef<HTMLElement | null>(null);
  const setPanelViewport = useCallback((viewport: HTMLElement | null) => {
    panelViewport.current = viewport;
  }, []);
  const clockRow = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sync = useCallback(async () => {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncState('syncing');
    try {
      const epoch = await GetRealTime(ntpServersRef.current);
      anchor.current = { epoch, performance: performance.now(), synced: true };
      setNow(epoch);
      setSyncState('synced');
    } catch {
      setSyncState('error');
    } finally {
      syncInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    void sync();
    const update = window.setInterval(() => {
      if (anchor.current.synced)
        setNow(anchor.current.epoch + performance.now() - anchor.current.performance);
    }, 40);
    const resync = window.setInterval(() => void sync(), 30_000);
    return () => {
      window.clearInterval(update);
      window.clearInterval(resync);
    };
  }, [sync]);
  const addZone = (zone: string) =>
    setClocks((items) =>
      items.some((item) => item.zone === zone)
        ? items
        : [...items, { id: `clock-${crypto.randomUUID()}`, zone }],
    );
  const nearestZoneAtPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(),
      pointerX = event.clientX - rect.left,
      pointerY = event.clientY - rect.top,
      toPoint = (item: { longitude: number; latitude: number }) => ({
        x: ((item.longitude + 180) / 360) * rect.width,
        y: ((90 - item.latitude) / 180) * rect.height,
      });
    return cityZones.reduce((best, item) => {
      const current = toPoint(item),
        bestPoint = toPoint(best),
        distance = (current.x - pointerX) ** 2 + (current.y - pointerY) ** 2,
        bestDistance = (bestPoint.x - pointerX) ** 2 + (bestPoint.y - pointerY) ** 2;
      return distance < bestDistance ? item : best;
    }).zone;
  };
  const hoverMapPoint = (event: React.PointerEvent<SVGSVGElement>) => {
    setMapCandidate(nearestZoneAtPointer(event));
  };
  const addMapPoint = (event: React.PointerEvent<SVGSVGElement>) => {
    const zone = nearestZoneAtPointer(event);
    addZone(zone);
    setFocusedZone(zone);
    setMapCandidate(zone);
    setZoneToAdd(zone);
  };
  const locateClock = (clock: ClockEntry) => {
    setFocusedZone(clock.zone);
    setMapCandidate(null);
    const viewport = clockViewport.current;
    if (!viewport) return;
    const card = viewport.querySelector<HTMLElement>(`[data-clock-id="${clock.id}"]`);
    if (!card) return;
    const viewportRect = viewport.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const delta = cardRect.left - viewportRect.left - (viewportRect.width - cardRect.width) / 2;
    viewport.scrollBy({ left: delta, behavior: 'smooth' });
    const row = clockRow.current;
    const panel = panelViewport.current;
    if (!row || !panel) return;
    const panelRect = panel.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < panelRect.top || rowRect.bottom > panelRect.bottom) {
      panel.scrollBy({ top: rowRect.top - panelRect.top, behavior: 'smooth' });
    }
  };
  const mapPoint = (zone: string) => {
    const city = cityZones.find((item) => item.zone === zone);
    if (city) return city;
    const offsetLabel =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(mapReferenceTime)
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const offsetMatch = offsetLabel.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    const offset = offsetMatch
      ? (offsetMatch[1] === '-' ? -1 : 1) *
        (Number(offsetMatch[2]) + Number(offsetMatch[3] ?? 0) / 60)
      : 0;
    return { longitude: offset * 15, latitude: 0, zone };
  };
  const mapX = (zone: string) => ((mapPoint(zone).longitude + 180) / 360) * 900;
  const mapY = (zone: string) => ((90 - mapPoint(zone).latitude) / 180) * 300;
  const mapCandidateName = zones.find((zone) => zone.id === mapCandidate)?.label ?? mapCandidate;
  const mapCandidateColumn =
    mapCandidate === null ? null : Math.min(23, Math.max(0, Math.floor(mapX(mapCandidate) / 37.5)));
  const selectedZoneExists = clocks.some((clock) => clock.zone === zoneToAdd);
  return (
    <div className="h-full min-h-0">
      <ScrollArea
        className="h-full min-h-0"
        options={{ overflow: { x: 'hidden' } }}
        onViewport={setPanelViewport}
      >
        <div className="flex min-h-full flex-col">
          <div className="flex flex-none flex-col gap-2 border-b border-border px-1 pb-3">
            <div className="flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
              <span
                className={`size-1.5 flex-none rounded-full ${syncState === 'synced' ? 'bg-emerald-500' : syncState === 'error' ? 'bg-destructive' : 'bg-amber-500'}`}
              />
              <span className="min-w-0 flex-1 truncate" role="status" aria-live="polite">
                {t(`timeTool.realTime.sync.${syncState}`)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="flex-none"
                aria-label={t('timeTool.realTime.ntpConfigure')}
                title={t('timeTool.realTime.ntpConfigure')}
                onClick={() => setNtpOpen(true)}
              >
                <GearSix size={14} weight="duotone" />
                {t('timeTool.realTime.ntpTitle')}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="flex-none"
                aria-label={t('timeTool.realTime.syncNow')}
                title={t('timeTool.realTime.syncNow')}
                disabled={syncState === 'syncing'}
                onClick={() => void sync()}
              >
                <ArrowClockwise size={16} weight="duotone" />
              </Button>
            </div>
            <div className="flex min-w-0 items-end gap-2">
              <TimezoneCombobox
                value={zoneToAdd}
                onChange={(zone) => {
                  setZoneToAdd(zone);
                  setMapCandidate(null);
                }}
                zones={zones}
                label={t('timeTool.realTime.selectZone')}
                placeholder={t('timeTool.timezonePlaceholder')}
                emptyLabel={t('timeTool.timezoneNoResults')}
              />
              <Button
                variant="default"
                className="h-[46px] flex-none"
                disabled={selectedZoneExists}
                onClick={() => {
                  addZone(zoneToAdd);
                  setFocusedZone(zoneToAdd);
                }}
              >
                <Plus size={14} />
                {t(selectedZoneExists ? 'timeTool.realTime.alreadyAdded' : 'timeTool.realTime.add')}
              </Button>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {t('timeTool.realTime.sortHint')}
            </span>
          </div>
          <ScrollArea
            className="flex-none [padding-block-end:var(--overlay-scrollbar-size)]"
            options={{ overflow: { x: 'scroll', y: 'hidden' } }}
            onViewport={setClockViewport}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={({ active, over }) => {
                if (!over || active.id === over.id) return;
                setClocks((items) =>
                  arrayMove(
                    items,
                    items.findIndex((item) => item.id === active.id),
                    items.findIndex((item) => item.id === over.id),
                  ),
                );
              }}
            >
              <SortableContext
                items={clocks.map((clock) => clock.id)}
                strategy={horizontalListSortingStrategy}
              >
                <div ref={clockRow} className="flex w-max border-y border-border">
                  {clocks.map((entry, index) => (
                    <SortableClock
                      key={entry.id}
                      entry={entry}
                      zones={zones}
                      now={now}
                      removeLabel={t('timeTool.realTime.removeZone', {
                        zone: zones.find((zone) => zone.id === entry.zone)?.label ?? entry.zone,
                      })}
                      index={index + 1}
                      waitingLabel={t(
                        syncState === 'error'
                          ? 'timeTool.realTime.sync.error'
                          : 'timeTool.realTime.waiting',
                      )}
                      canRemove={clocks.length > 1}
                      selected={focusedZone === entry.zone}
                      onLocate={() => {
                        setFocusedZone(entry.zone);
                        setMapCandidate(null);
                      }}
                      onRemove={() =>
                        setClocks((items) =>
                          items.length > 1 ? items.filter((item) => item.id !== entry.id) : items,
                        )
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </ScrollArea>
          <div className="flex min-h-[190px] flex-1 flex-col border-t border-border pt-3">
            <div className="mb-2 flex items-center gap-2 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <Globe size={15} weight="duotone" />
              {t('timeTool.realTime.mapHint')}
            </div>
            <svg
              viewBox="0 0 900 300"
              preserveAspectRatio="none"
              role="img"
              aria-label={t('timeTool.realTime.mapDescription')}
              onPointerDown={(event) => addMapPoint(event)}
              onPointerMove={(event) => hoverMapPoint(event)}
              className="min-h-[120px] w-full flex-1 touch-none select-none rounded-sm bg-muted/25"
            >
              {mapCandidateColumn !== null && (
                <rect
                  x={mapCandidateColumn * 37.5}
                  y="0"
                  width="37.5"
                  height="300"
                  fill="currentColor"
                  className="text-primary/10"
                />
              )}
              {Array.from({ length: 25 }, (_, index) => (
                <line
                  key={index}
                  x1={index * 37.5}
                  x2={index * 37.5}
                  y1="0"
                  y2="300"
                  stroke="currentColor"
                  className="text-border/70"
                  strokeWidth=".7"
                />
              ))}
              {[-60, -30, 0, 30, 60].map((latitude) => (
                <line
                  key={latitude}
                  x1="0"
                  x2="900"
                  y1={((90 - latitude) / 180) * 300}
                  y2={((90 - latitude) / 180) * 300}
                  stroke="currentColor"
                  className="text-border/70"
                  strokeWidth=".7"
                />
              ))}
              <g fill="currentColor" className="text-muted-foreground/60">
                {worldLandDots.map(([x, y]) => (
                  <circle key={`${x}-${y}`} cx={x} cy={y} r="1.35" />
                ))}
              </g>
              {clocks.map((clock, index) => (
                <g
                  key={clock.id}
                  transform={`translate(${mapX(clock.zone)},${mapY(clock.zone)})`}
                  aria-label={t('timeTool.realTime.locate', {
                    zone: zones.find((zone) => zone.id === clock.zone)?.label ?? clock.zone,
                  })}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => locateClock(clock)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    locateClock(clock);
                  }}
                >
                  <circle r="12" fill="transparent" />
                  {focusedZone === clock.zone && (
                    <circle
                      r="5"
                      fill="none"
                      stroke="currentColor"
                      className="text-primary"
                      strokeWidth="3"
                    >
                      <animate
                        attributeName="r"
                        values="5;26"
                        dur="1.4s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="stroke-width"
                        values="3;0.5"
                        dur="1.4s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="opacity"
                        values="0.9;0"
                        dur="1.4s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  )}
                  <circle cy="0" r="5" fill="currentColor" className="text-primary" />
                  <text x="8" y="-7" fill="currentColor" className="text-foreground" fontSize="10">
                    {index + 1}
                  </text>
                </g>
              ))}
              {mapCandidate && (
                <g transform={`translate(${mapX(mapCandidate)},${mapY(mapCandidate)})`}>
                  <circle
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    className="text-primary/40"
                    strokeWidth="1.5"
                  />
                  <circle r="4" fill="currentColor" className="text-primary/50" />
                </g>
              )}
              <text
                x="16"
                y="282"
                fill="currentColor"
                className="text-muted-foreground"
                fontSize="11"
              >
                −180°
              </text>
              <text
                x="850"
                y="282"
                fill="currentColor"
                className="text-muted-foreground"
                fontSize="11"
              >
                +180°
              </text>
            </svg>
            <div className="flex min-h-9 items-center gap-2 px-1 pt-2 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {mapCandidate
                  ? t('timeTool.realTime.mapCandidate', { zone: mapCandidateName })
                  : t('timeTool.realTime.mapSelectHint')}
              </span>
              {mapCandidate && (
                <Button
                  size="sm"
                  className="flex-none"
                  disabled={clocks.some((clock) => clock.zone === mapCandidate)}
                  onClick={() => {
                    addZone(mapCandidate);
                    setFocusedZone(mapCandidate);
                    setZoneToAdd(mapCandidate);
                  }}
                >
                  <Plus size={14} />
                  {t(
                    clocks.some((clock) => clock.zone === mapCandidate)
                      ? 'timeTool.realTime.alreadyAdded'
                      : 'timeTool.realTime.add',
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
      <NtpServerDialog
        open={ntpOpen}
        onOpenChange={setNtpOpen}
        servers={ntpServers}
        onSave={(nextServers) => {
          ntpServersRef.current = nextServers;
          onNtpServersChange(nextServers);
          void sync();
        }}
      />
    </div>
  );
}
