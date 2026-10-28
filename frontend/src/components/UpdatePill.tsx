import { useEffect, useRef, useState } from 'react';
import { Events } from '@wailsio/runtime';
import { ArrowCircleUp, X } from '@phosphor-icons/react';
import { Button } from './ui/button';
import { PixelAlignedSpinner } from './PixelAlignedSpinner';
import { useTranslation } from 'react-i18next';
import { InstallUpdate, RestartApp } from '../../bindings/tinkerkit/updateservice';
import { formatBackendError } from '../lib/backend-error';
import { toast } from './ui/toast';
import './UpdatePill.css';

type PillState = 'checking' | 'available' | 'downloading' | 'applying' | 'restarting';
const payload = (event: any) => event?.data ?? event;
const formatVersion = (value: unknown) => {
  const v = String(value ?? '')
    .trim()
    .replace(/^v/i, '');
  return v ? `v${v}` : '';
};

// 顶栏胶囊与左组的 28px 图标按钮同高、同基线；两侧光学内边距统一为 10px。
const pillShell =
  'relative top-(--app-titlebar-item-offset) z-[3] ml-auto flex h-7 max-w-[min(340px,calc(100vw-220px))] flex-none select-none items-center gap-1.5 self-center rounded-full border border-border bg-card pl-2.5 text-foreground transition-colors [--wails-draggable:no-drag]';

export default function UpdatePill() {
  const { t } = useTranslation();
  const [state, setStateRaw] = useState<PillState | null>(null);
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const stateRef = useRef<PillState | null>(null);
  const dismissed = useRef(false);
  const errorHandled = useRef(false);
  const setState = (next: PillState | null) => {
    stateRef.current = next;
    setStateRaw(next);
  };
  useEffect(() => {
    const on = (name: string, handler: (event: any) => void) => {
      void Events.On(name, handler);
    };
    const onLocalCheck = (event: Event) => {
      const state = (event as CustomEvent<PillState | 'finished' | 'available'>).detail;
      if (state === 'checking') {
        dismissed.current = false;
        setPercent(0);
        setState('checking');
      } else if (state === 'finished' && stateRef.current === 'checking') setState(null);
    };
    window.addEventListener('tinkerkit:update-check', onLocalCheck);
    (on('wails:updater:update-available', (e) => {
      if (dismissed.current) return;
      setVersion(formatVersion(payload(e)?.version));
      setPercent(0);
      errorHandled.current = false;
      setState('available');
    }),
      on('wails:updater:no-update', () => setState(null)),
      on('wails:updater:download-started', () => {
        setPercent(0);
        setState('downloading');
      }),
      on('wails:updater:download-progress', (e) => {
        const p = payload(e);
        if (p?.total) setPercent(Math.round((p.written / p.total) * 100));
      }),
      on('wails:updater:verifying', () => setState('applying')),
      on('wails:updater:installing', () => setState('applying')),
      on('wails:updater:update-ready', () => {
        setState('restarting');
        void RestartApp().catch(() => {
          if (!errorHandled.current) {
            toast.add({ title: t('updatePill.restartFailed'), type: 'error' });
            setState('available');
          }
        });
      }),
      on('wails:updater:error', (e) => {
        if (
          stateRef.current === 'downloading' ||
          stateRef.current === 'applying' ||
          stateRef.current === 'restarting'
        ) {
          errorHandled.current = true;
          toast.add({
            title: t('updatePill.error'),
            description: formatBackendError(payload(e)?.message) || '',
            type: 'error',
          });
          setState('available');
        }
      }));
    return () => {
      window.removeEventListener('tinkerkit:update-check', onLocalCheck);
    };
  }, [t]);
  const start = () => {
    errorHandled.current = false;
    setState('downloading');
    void InstallUpdate().catch((error) => {
      if (!errorHandled.current) {
        toast.add({
          title: t('updatePill.error'),
          description: formatBackendError(error) || undefined,
          type: 'error',
        });
        setState('available');
      }
    });
  };
  const dismiss = () => {
    dismissed.current = true;
    setState(null);
  };
  if (!state) return null;
  const working = state !== 'available';
  const label =
    state === 'checking'
      ? t('updatePill.checking')
      : state === 'available'
        ? t('updatePill.available', { version })
        : state === 'downloading'
          ? t('updatePill.downloading')
          : state === 'applying'
            ? t('updatePill.applying')
            : t('updatePill.restarting');
  // 进度只在真正下载时出现；完成后进入准备/重启阶段，胶囊回到不带刻度的状态文字。
  const downloading = state === 'downloading' && percent > 0;
  if (working)
    return (
      <div className={`${pillShell} overflow-hidden pr-2.5`} role="status">
        {downloading ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 bg-primary/10"
            style={{ width: `${percent}%` }}
          />
        ) : null}
        <PixelAlignedSpinner
          aria-hidden="true"
          className="relative size-3.5 flex-none text-primary"
        />
        <span className="update-pill__text relative min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] leading-[14px]">
          {label}
        </span>
        {downloading ? (
          <span className="relative flex-none font-mono text-[10px] leading-[14px] tabular-nums text-muted-foreground">
            {percent}%
          </span>
        ) : null}
      </div>
    );
  return (
    <div
      className={`${pillShell} overflow-hidden pr-1 hover:border-muted-foreground/40`}
      role="status"
    >
      <Button
        variant="ghost"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-full border-0 bg-transparent p-0 text-inherit hover:bg-transparent hover:text-inherit hover:[&_svg]:text-primary"
        onClick={start}
      >
        <ArrowCircleUp size={14} weight="duotone" className="flex-none text-primary/70" />
        <span className="update-pill__text min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] leading-[14px]">
          {label}
        </span>
      </Button>
      <span aria-hidden="true" className="h-3.5 w-px flex-none bg-border" />
      <Button
        variant="ghost"
        size="icon-xs"
        className="flex-none rounded-full border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t('updatePill.dismiss')}
        title={t('updatePill.dismiss')}
        onClick={dismiss}
      >
        <X size={12} weight="duotone" />
      </Button>
    </div>
  );
}
