import { useEffect, useRef, useState } from 'react';
import { Events } from '@wailsio/runtime';
import { ArrowCircleUp, X } from '@phosphor-icons/react';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { useTranslation } from 'react-i18next';
import { InstallUpdate, RestartApp } from '../../bindings/changeme/updateservice';
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
            toast.add({ title: t('updatePill.error'), type: 'error' });
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
            description: payload(e)?.message || '',
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
    void InstallUpdate().catch(() => {
      if (!errorHandled.current) {
        toast.add({ title: t('updatePill.error'), type: 'error' });
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
  if (working)
    return (
      <div
        className="relative top-px z-[3] flex h-6 max-w-[min(340px,calc(100vw-220px))] flex-none items-center self-center gap-1.5 ml-auto rounded-full border border-border bg-card py-0 px-1.5 text-foreground [--wails-draggable:no-drag]"
        role="status"
      >
        <Spinner className="size-3.5 flex-none self-center text-primary motion-reduce:animate-none" />
        <span className="update-pill__text block min-w-0 self-center overflow-hidden text-ellipsis whitespace-nowrap text-[10px] leading-[14px] text-foreground">
          {label}
          {state === 'downloading' && percent > 0 ? ` ${percent}%` : ''}
        </span>
      </div>
    );
  return (
    <div
      className="relative top-px z-[3] flex h-6 max-w-[min(340px,calc(100vw-220px))] flex-none items-center self-center gap-1.5 ml-auto overflow-hidden rounded-full border border-border bg-card py-0 px-0.5 text-foreground [--wails-draggable:no-drag] cursor-pointer hover:border-muted-foreground hover:bg-muted"
      role="status"
    >
      <Button
        variant="ghost"
        className="flex h-full min-w-0 flex-none cursor-pointer gap-[5px] border-0 bg-transparent p-0 text-inherit hover:bg-transparent hover:text-inherit [&_svg]:size-3.5 [&_svg]:text-primary"
        onClick={start}
        aria-label={label}
      >
        <ArrowCircleUp data-icon="inline-start" size={14} weight="duotone" />
        <span className="update-pill__text block min-w-0 self-center overflow-hidden text-ellipsis whitespace-nowrap text-[10px] leading-[14px] text-foreground">
          {label}
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="flex-none cursor-pointer rounded-full border-0 bg-transparent text-muted-foreground opacity-[.72] hover:bg-accent hover:text-foreground hover:opacity-100 [&_svg]:size-[11px] [&_svg]:shrink-0"
        aria-label={t('updatePill.dismiss')}
        title={t('updatePill.dismiss')}
        onClick={dismiss}
      >
        <X size={11} weight="regular" />
      </Button>
    </div>
  );
}
