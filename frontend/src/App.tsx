import {
  CaretLeft as ArrowLeft,
  CaretRight as ArrowRight,
  SidebarSimple,
} from '@phosphor-icons/react';
import { Clipboard, Events } from '@wailsio/runtime';
import type { SetStateAction } from 'react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import {
  AppendHistory,
  ClearHistory,
  Get as GetConfig,
  GetHistoryContent,
  ResolveSSHHostKeyPrompt,
  Save as SaveConfig,
  SaveImageSources,
} from '../bindings/changeme/configservice';
import { Log as LogFrontend } from '../bindings/changeme/logservice';
import type { Config as Settings, SidebarToolConfig } from '../bindings/changeme/models';
import { CheckForUpdates, SetAutoCheckEnabled } from '../bindings/changeme/updateservice';
import { detectBase64, detectJwt } from './app/clipboard';
import { CommandPalette } from './app/CommandPalette';
import { defaultSettings } from './app/default-settings';
import {
  paletteItems,
  tools,
  type IndexedItem,
  type Page,
  type PaletteContext,
  type Romanize,
  type SidebarMode,
} from './app/definitions';
import { restoreFocusAfterManage } from './app/focus';
import {
  availablePage,
  IMAGE_MANAGER_DETAIL_PATH,
  imageManagerDetailRoute,
  isPage,
  isToolId,
  pageFromLocation,
  paletteToolId,
  resolveSidebarTools,
  routeMatchesPage,
  routePath,
} from './app/navigation';
import { buildIndex } from './app/palette-search';
import { Sidebar } from './app/Sidebar';
import { normalizeHistoryDetail, type HistoryItem } from './components/HistoryPage';
import { parseJsonLoose, type PendingAction, type ToolId } from './components/shared';
import { TaskCenter } from './components/TaskCenter';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog';
import { Button } from './components/ui/button';
import { ScrollArea } from './components/ui/scroll-area';
import { toast, Toaster } from './components/ui/toast';
import UpdatePill from './components/UpdatePill';
import { SUPPORTED_LANGUAGES } from './i18n';
import { formatBackendError } from './lib/backend-error';
import { EDITOR_FONT_SIZES } from './settings-options';
import { resolveTheme, THEME_MODE_OPTIONS } from './theme';
import { parseTimeInput } from './utils/time';
import { parseSupportedUrl } from './utils/url';

type SaveWaiter = {
  target: Settings;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

type ImageSourceSaveRequest = {
  patch: Pick<Settings, 'dockerCLIPath' | 'imageSources'>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

type SSHHostKeyPrompt = {
  id: string;
  address: string;
  fingerprint: string;
  knownFingerprints: string[];
  changed: boolean;
};

function parseSSHHostKeyPrompt(value: unknown): SSHHostKeyPrompt | null {
  if (!value || typeof value !== 'object') return null;
  const prompt = value as Record<string, unknown>;
  if (
    typeof prompt.id !== 'string' ||
    typeof prompt.address !== 'string' ||
    typeof prompt.fingerprint !== 'string' ||
    !prompt.id ||
    !prompt.address ||
    !prompt.fingerprint
  )
    return null;
  return {
    id: prompt.id,
    address: prompt.address,
    fingerprint: prompt.fingerprint,
    knownFingerprints: Array.isArray(prompt.knownFingerprints)
      ? prompt.knownFingerprints.filter((item): item is string => typeof item === 'string')
      : [],
    changed: prompt.changed === true,
  };
}

function normalizedImageSource(source: NonNullable<Settings['imageSources']>[number]) {
  const value = source as unknown as Record<string, unknown>;
  const kind = String(value.kind ?? '').trim();
  const registry = kind === 'registry';
  const ssh = kind === 'ssh';
  let registryURL = registry
    ? String(value.registryURL ?? '')
        .trim()
        .replace(/\/+$/, '')
    : '';
  try {
    const parsed = new URL(registryURL);
    if (parsed.protocol === 'https:') {
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      registryURL = parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // 保留服务端可接受的非标准地址，由服务端负责最终校验。
  }
  return {
    id: String(value.id ?? ''),
    name: String(value.name ?? '').trim(),
    kind,
    sshProfileID: ssh ? String(value.sshProfileID ?? '').trim() : '',
    registryURL,
    registryUsername: registry ? String(value.registryUsername ?? '').trim() : '',
    registryPassword: registry ? String(value.registryPassword ?? '') : '',
  };
}

function logFrontend(message: string) {
  void LogFrontend(message).catch((error) => {
    console.error('[frontend] logservice failed', error);
  });
}

const JsonTool = lazy(() => import('./components/JsonTool'));

const TimeTool = lazy(() => import('./components/TimeTool'));

const TextTool = lazy(() => import('./components/TextTool'));

const TextGeneratorTool = lazy(() => import('./components/TextGeneratorTool'));

const Base64Tool = lazy(() => import('./components/Base64Tool'));

const DiffTool = lazy(() => import('./components/DiffTool'));

const JwtTool = lazy(() => import('./components/JwtTool'));

const UrlTool = lazy(() => import('./components/UrlTool'));

const QrCodeTool = lazy(() => import('./components/QrCodeTool'));

const ImageTool = lazy(() => import('./components/ImageTool'));

const ImageManagerTool = lazy(() => import('./components/ImageManagerTool'));

const ImageManagerDetailPage = lazy(() => import('./components/ImageManagerDetailPage'));

const ServiceManagerTool = lazy(() => import('./components/ServiceManagerTool'));

const SshFilesTool = lazy(() => import('./components/SshFilesTool'));

const PortTool = lazy(() => import('./components/PortTool'));

const NetworkTestTool = lazy(() => import('./components/NetworkTestTool'));

const SettingsPage = lazy(() => import('./components/SettingsPage'));

const HistoryPage = lazy(() => import('./components/HistoryPage'));

function toolSlotClass(active: boolean) {
  return active
    ? 'tool-slot relative isolate z-10 h-full min-h-0 overflow-hidden bg-background'
    : 'tool-slot absolute inset-0 isolate z-0 h-full min-h-0 overflow-hidden invisible opacity-0 pointer-events-none is-hidden';
}

function historyIndex() {
  const index = window.history.state?.idx;
  return typeof index === 'number' ? index : 0;
}

function AppShell() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigationType = useNavigationType();
  const routerNavigate = useNavigate();
  const workspaceRef = useRef<HTMLElement>(null);
  const page = pageFromLocation(location.pathname, location.search);
  const imageDetailRoute = imageManagerDetailRoute(location.pathname, location.search);
  const [visited, setVisited] = useState<Set<Page>>(() => new Set([page]));
  const pageRef = useRef<Page>(page);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [romanize, setRomanize] = useState<Romanize>(() => (text) => text);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [settingsCommandRequest, setSettingsCommandRequest] = useState<{
    id: number;
    action: 'quit';
  } | null>(null);
  const settingsCommandId = useRef(0);
  const [jsonSchemaOpen, setJsonSchemaOpen] = useState(false);
  const [jsonPipelineOpen, setJsonPipelineOpen] = useState(false);
  const [matchDialog, setMatchDialog] = useState<null | {
    tool: ToolId;
    input: string;
    mode?: string;
    target?: 'before' | 'after';
  }>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [sidebarManaging, setSidebarManaging] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [sshHostKeyPrompt, setSSHHostKeyPrompt] = useState<SSHHostKeyPrompt | null>(null);
  const sshHostKeyPromptResponseRef = useRef<string | null>(null);
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const nextDiffTarget = useRef<'before' | 'after'>('before');
  const settingsReady = useRef(false);
  const saveInFlight = useRef(false);
  const saveQueued = useRef(false);
  const saveWaiters = useRef<SaveWaiter[]>([]);
  const imageSourceSaveRequests = useRef<ImageSourceSaveRequest[]>([]);
  const persistLatestRef = useRef<() => Promise<void>>(async () => {});
  const startPersistLatest = () => {
    void persistLatestRef.current().catch((error) => {
      console.error('[settings] persist failed', error);
    });
  };
  const manageEntered = useRef(false);
  const manageFocusRestoreRef = useRef<HTMLElement | null>(null);
  const lastFocusedRef = useRef<Element | null>(null);
  const themeTransitionRef = useRef<{
    transition: ViewTransition;
    restore: () => void;
  } | null>(null);
  useEffect(
    () => () => {
      const active = themeTransitionRef.current;
      themeTransitionRef.current = null;
      active?.transition.skipTransition();
      active?.restore();
    },
    [],
  );
  const theme = resolveTheme(
    settings.themeMode,
    settings.lightTheme,
    settings.darkTheme,
    systemDark,
  );
  const setSettingsWithThemeTransition = (update: SetStateAction<Settings>) => {
    const current = settingsRef.current;
    const next = typeof update === 'function' ? update(current) : update;
    const nextTheme = resolveTheme(next.themeMode, next.lightTheme, next.darkTheme, systemDark);
    const currentTheme = resolveTheme(
      current.themeMode,
      current.lightTheme,
      current.darkTheme,
      systemDark,
    );
    const active = themeTransitionRef.current;
    themeTransitionRef.current = null;
    active?.transition.skipTransition();
    active?.restore();
    if (nextTheme === currentTheme) {
      setSettings(next);
      return;
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const viewTransitionDocument = document as Document & {
      startViewTransition?: (updateCallback: () => void) => ViewTransition;
    };
    if (!viewTransitionDocument.startViewTransition || reducedMotion) {
      setSettings(next);
      return;
    }
    const root = document.documentElement;
    const previousName = root.style.viewTransitionName;
    const restore = () => {
      root.style.viewTransitionName = previousName;
    };
    // 只捕获旧页面；新页面保持真实渲染和点击能力。
    root.style.viewTransitionName = 'root';
    const transition = viewTransitionDocument.startViewTransition(() => {
      if (themeTransitionRef.current?.transition !== transition) return;
      root.style.viewTransitionName = 'none';
      flushSync(() => setSettings(next));
    });
    themeTransitionRef.current = { transition, restore };
    const finish = () => {
      if (themeTransitionRef.current?.transition !== transition) return;
      themeTransitionRef.current = null;
      restore();
    };
    void transition.finished.then(finish, (error: unknown) => {
      finish();
      console.error('[theme] transition update failed', error);
    });
  };
  const currentHistoryIndex = historyIndex();
  const [maxHistoryIndex, setMaxHistoryIndex] = useState(currentHistoryIndex);
  const canGoBack = currentHistoryIndex > 0;
  const canGoForward = currentHistoryIndex < maxHistoryIndex;
  const dismissOverlays = () => {
    closePalette();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  const navigatePage = (next: Page) => {
    logFrontend(`[route] navigatePage from=${page} to=${next}`);
    routerNavigate(routePath(next));
    dismissOverlays();
  };
  const openImageManagerDetail = (sourceId: string, imageId: string) => {
    const params = new URLSearchParams({ source: sourceId, image: imageId });
    routerNavigate(`${IMAGE_MANAGER_DETAIL_PATH}?${params.toString()}`);
    dismissOverlays();
  };
  const respondSSHHostKeyPrompt = (accepted: boolean) => {
    const prompt = sshHostKeyPrompt;
    if (!prompt || sshHostKeyPromptResponseRef.current === prompt.id) return;
    sshHostKeyPromptResponseRef.current = prompt.id;
    setSSHHostKeyPrompt(null);
    void ResolveSSHHostKeyPrompt(prompt.id, accepted)
      .catch((error) => {
        logFrontend(`[ssh] host key prompt response failed: ${String(error)}`);
        toast.add({
          title: t('sshHostKeyDialog.responseFailed'),
          description: formatBackendError(error),
          type: 'error',
        });
      })
      .finally(() => {
        if (sshHostKeyPromptResponseRef.current === prompt.id) {
          sshHostKeyPromptResponseRef.current = null;
        }
      });
  };
  const navigate = navigatePage;
  useEffect(() => {
    const off = Events.On('ssh:host-key', (event) => {
      const prompt = parseSSHHostKeyPrompt(event.data);
      if (!prompt) return;
      setSSHHostKeyPrompt((current) => current ?? prompt);
    });
    return () => off();
  }, []);
  useEffect(() => {
    const next = pageFromLocation(location.pathname, location.search);
    logFrontend(
      `[route] location pathname=${location.pathname} key=${location.key} type=${navigationType} page=${next}`,
    );
    if (!routeMatchesPage(location.pathname, location.search, next))
      routerNavigate(routePath(next), { replace: true });
  }, [location.key, location.pathname, location.search, navigationType, routerNavigate]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const dark = theme.endsWith('-dark');
    root.classList.toggle('dark', dark);
    root.dataset.theme = theme;
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.style.setProperty('--code-editor-font-size', `${settings.codeEditorFontSize || 16}px`);
  }, [theme, settings.codeEditorFontSize]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (settings.language && i18n.language !== settings.language)
      i18n.changeLanguage(settings.language);
  }, [i18n, settings.language]);
  useEffect(() => {
    if (!paletteOpen || romanize('中') !== '中') return;
    void import('pinyin-pro').then(({ pinyin }) =>
      setRomanize(
        () => (text) =>
          pinyin(text, { toneType: 'none', type: 'array' })
            .join('')
            .replace(/\s+/g, '')
            .toLowerCase(),
      ),
    );
  }, [paletteOpen, romanize]);
  useEffect(() => {
    pageRef.current = page;
    setVisited((current) => (current.has(page) ? current : new Set(current).add(page)));
  }, [page]);
  useEffect(() => {
    setMaxHistoryIndex((current) => {
      const next =
        navigationType === 'PUSH' ? currentHistoryIndex : Math.max(current, currentHistoryIndex);
      return current === next ? current : next;
    });
  }, [currentHistoryIndex, location.key, navigationType]);
  useEffect(() => {
    void Events.On('navigate', (event) => {
      logFrontend(`[event] navigate data=${String(event.data)}`);
      if (isPage(event.data)) navigatePage(event.data);
    });
  }, []);
  useEffect(() => {
    const off = Events.On('mouse:navigate', (event) => {
      logFrontend(`[event] mouse:navigate data=${String(event.data)}`);
      if (event.data === 'back') routerNavigate(-1);
      if (event.data === 'forward') routerNavigate(1);
    });
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4)
        logFrontend(`[dom] mouse button=${event.button} type=${event.type}`);
    };
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      off();
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [routerNavigate]);
  useEffect(() => {
    const onSchema = (event: Event) => setJsonSchemaOpen((event as CustomEvent<boolean>).detail);
    window.addEventListener('tinkerkit:json-schema', onSchema);
    return () => window.removeEventListener('tinkerkit:json-schema', onSchema);
  }, []);
  useEffect(() => {
    const onPipeline = (event: Event) =>
      setJsonPipelineOpen((event as CustomEvent<boolean>).detail);
    window.addEventListener('tinkerkit:json-pipeline', onPipeline);
    return () => window.removeEventListener('tinkerkit:json-pipeline', onPipeline);
  }, []);
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      routerNavigate(event.button === 3 ? -1 : 1);
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [routerNavigate]);
  useEffect(() => {
    const off = Events.On('tray:analyze', (event) => {
      if (typeof event.data === 'string') analyzeClipboard(event.data);
    });
    return () => off();
  }, []);
  useLayoutEffect(() => workspaceRef.current?.scrollTo(0, 0), [page]);
  useEffect(() => {
    GetConfig()
      .then((c) => {
        settingsReady.current = true;
        setSettings(c);
      })
      .catch(() => {
        settingsReady.current = true;
      });
  }, []);
  persistLatestRef.current = async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    try {
      while (saveQueued.current || imageSourceSaveRequests.current.length > 0) {
        const sourceRequest = imageSourceSaveRequests.current.shift();
        if (sourceRequest) {
          const candidate = { ...settingsRef.current, ...sourceRequest.patch };
          try {
            await SaveImageSources(candidate.dockerCLIPath ?? '', candidate.imageSources ?? []);
            const canonical = await GetConfig();
            const candidateSources = (candidate.imageSources ?? []).map(normalizedImageSource);
            const canonicalSources = (canonical.imageSources ?? []).map(normalizedImageSource);
            if (JSON.stringify(canonicalSources) !== JSON.stringify(candidateSources))
              throw new Error(t('toast.settingsCanonicalMismatch'));
            const committed = {
              ...settingsRef.current,
              dockerCLIPath: canonical.dockerCLIPath,
              imageSources: canonical.imageSources,
            };
            settingsRef.current = committed;
            setSettingsWithThemeTransition(committed);
            sourceRequest.resolve();
          } catch (error) {
            sourceRequest.reject(error);
          }
          continue;
        }
        saveQueued.current = false;
        const cfg = settingsRef.current;
        try {
          await SaveConfig(cfg);
          const completed = saveWaiters.current.filter((waiter) => waiter.target === cfg);
          saveWaiters.current = saveWaiters.current.filter((waiter) => waiter.target !== cfg);
          completed.forEach((waiter) => waiter.resolve());
          if (settingsRef.current !== cfg) {
            saveQueued.current = true;
            continue;
          }
          void SetAutoCheckEnabled(cfg.autoCheckUpdates);
          setHistoryRevision((current) => current + 1);
        } catch (error) {
          toast.add({ title: t('toast.settingsFailed'), type: 'error' });
          const failed = saveWaiters.current.filter((waiter) => waiter.target === cfg);
          saveWaiters.current = saveWaiters.current.filter((waiter) => waiter.target !== cfg);
          failed.forEach((waiter) => waiter.reject(error));
          if (settingsRef.current !== cfg) saveQueued.current = true;
        }
      }
    } finally {
      saveInFlight.current = false;
      if (saveQueued.current) startPersistLatest();
      else {
        // 仅由对应配置对象的 SaveConfig 结果结算 waiter。
        const orphaned = saveWaiters.current;
        saveWaiters.current = [];
        orphaned.forEach((waiter) =>
          waiter.reject(new Error('Settings save snapshot was superseded')),
        );
      }
    }
  };
  const flushSettingsSave = (target: Settings = settingsRef.current) => {
    if (!settingsReady.current) return Promise.resolve();
    saveQueued.current = true;
    const pending = new Promise<void>((resolve, reject) => {
      saveWaiters.current.push({ target, resolve, reject });
    });
    startPersistLatest();
    return pending;
  };
  const saveImageManagerSettings = (patch: Pick<Settings, 'dockerCLIPath' | 'imageSources'>) => {
    const transaction = new Promise<void>((resolve, reject) => {
      imageSourceSaveRequests.current.push({ patch, resolve, reject });
    });
    saveQueued.current = true;
    startPersistLatest();
    return transaction;
  };
  useEffect(() => {
    if (!settingsReady.current) return;
    saveQueued.current = true;
    startPersistLatest();
  }, [settings]);
  useEffect(() => {
    const lastPage = page === 'image-manager-detail' ? 'image-manager' : page;
    localStorage.setItem('devutils.lastPage', JSON.stringify(lastPage));
  }, [page]);
  const sidebarMode = (settings.sidebarMode as SidebarMode) || 'full';
  const layoutSidebarMode = sidebarManaging ? 'full' : sidebarMode;
  const resolvedSidebarTools = useMemo(
    () => resolveSidebarTools(settings.sidebarTools),
    [settings.sidebarTools],
  );
  const enabledToolIds = useMemo(
    () =>
      resolvedSidebarTools
        .filter((item) => item.enabled && isToolId(item.id))
        .map((item) => item.id as ToolId),
    [resolvedSidebarTools],
  );
  const enabledToolSet = useMemo(() => new Set(enabledToolIds), [enabledToolIds]);
  const sidebarPage = page === 'image-manager-detail' ? 'image-manager' : page;
  useLayoutEffect(() => {
    if (sidebarManaging) return;
    const next = availablePage(page, resolvedSidebarTools);
    if (next !== page) routerNavigate(routePath(next), { replace: true });
  }, [page, resolvedSidebarTools, routerNavigate, sidebarManaging]);
  useLayoutEffect(() => {
    if (sidebarManaging) {
      if (!manageEntered.current) {
        manageEntered.current = true;
        const active = document.activeElement;
        manageFocusRestoreRef.current = active instanceof HTMLElement ? active : null;
        const handle = document.querySelector<HTMLElement>('[data-sidebar-drag-handle]');
        (handle ?? document.getElementById('sidebar-manage-done'))?.focus();
      }
      return;
    }
    if (!manageEntered.current) return;
    if (availablePage(page, resolvedSidebarTools) !== page) return;
    manageEntered.current = false;
    const previous = manageFocusRestoreRef.current;
    manageFocusRestoreRef.current = null;
    restoreFocusAfterManage(previous);
  }, [page, resolvedSidebarTools, sidebarManaging]);
  const indexed = useMemo(() => {
    const isTool = tools.some((tool) => tool.id === page);
    const contexts = new Set<PaletteContext>();
    if (jsonSchemaOpen && page === 'json') contexts.add('json.schema');
    if (jsonPipelineOpen && page === 'json') contexts.add('json.pipeline');
    const items = paletteItems.filter((item) => {
      const toolId = paletteToolId(item);
      if (toolId && !enabledToolSet.has(toolId)) return false;
      return (
        (!isTool || !item.tool || item.tool === page) &&
        (!item.context || contexts.has(item.context))
      );
    });
    return buildIndex(
      items.map((item) => ({
        ...item,
        label: t(
          item.labelKey,
          item.settingsAction === 'toggle-display-mode'
            ? {
                current: t(
                  THEME_MODE_OPTIONS.find(({ id }) => id === settings.themeMode)?.labelKey ??
                    'settings.themeModeSystem',
                ),
              }
            : item.settingsAction === 'toggle-language'
              ? {
                  current: t(
                    SUPPORTED_LANGUAGES.find(({ code }) => code === settings.language)?.labelKey ??
                      'settings.languages.zh-CN',
                  ),
                }
              : item.settingsAction === 'toggle-font-size'
                ? { current: `${settings.codeEditorFontSize || 16}px` }
                : undefined,
        ),
        group: t(item.groupKey),
        subgroup: item.subgroupKey ? t(item.subgroupKey) : '',
      })),
      romanize,
    );
  }, [
    t,
    jsonSchemaOpen,
    jsonPipelineOpen,
    page,
    romanize,
    enabledToolSet,
    settings.themeMode,
    settings.language,
    settings.codeEditorFontSize,
  ]);
  const record = (
    tool: ToolId,
    action: string,
    detail: string,
    input: string,
    output = '',
    meta?: { mode?: string; mediaType?: string; name?: string; bytes?: number },
  ) => {
    void AppendHistory({
      tool,
      action,
      detail: normalizeHistoryDetail(detail),
      mode: meta?.mode ?? '',
      mediaType: meta?.mediaType ?? '',
      name: meta?.name ?? '',
      bytes: meta?.bytes ?? new TextEncoder().encode(input).length,
      input,
      output,
    }).catch(() => toast.add({ title: t('toast.historyAppendFailed'), type: 'error' }));
  };
  const openHistory = async (item: HistoryItem) => {
    if (!enabledToolSet.has(item.tool)) return;
    try {
      const content = await GetHistoryContent(item.id);
      setPending({
        tool: item.tool,
        action: 'restore',
        input: content.input,
        output: content.output,
        mode: item.mode,
      });
      navigate(item.tool);
    } catch {
      toast.add({ title: t('toast.historyReadFailed'), type: 'error' });
    }
  };
  const clearHistory = () => {
    void ClearHistory().catch(() =>
      toast.add({ title: t('toast.historyClearFailed'), type: 'error' }),
    );
  };
  const cycleSidebar = () => {
    if (sidebarManaging) return;
    setSettings((s) => ({
      ...s,
      sidebarMode: s.sidebarMode === 'full' ? 'icon' : s.sidebarMode === 'icon' ? 'hidden' : 'full',
    }));
  };
  const toggleSidebarManage = () => setSidebarManaging((current) => !current);
  const updateSidebarTools = (sidebarTools: SidebarToolConfig[]) =>
    setSettings((current) => ({ ...current, sidebarTools }));
  const openPalette = () => {
    lastFocusedRef.current = document.activeElement;
    setPaletteOpen(true);
  };
  const closePalette = () => {
    setPaletteOpen(false);
    requestAnimationFrame(() => {
      const el = lastFocusedRef.current;
      if (el instanceof HTMLElement) el.focus();
    });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!paletteOpen) lastFocusedRef.current = document.activeElement;
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape' && paletteOpen) closePalette();
      else if (event.key === 'Escape' && sidebarManaging) setSidebarManaging(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, closePalette, sidebarManaging]);
  const checkForUpdates = useCallback(() => {
    void (async () => {
      window.dispatchEvent(new CustomEvent('tinkerkit:update-check', { detail: 'checking' }));
      try {
        const available = await CheckForUpdates();
        if (!available) toast.add({ title: t('settings.upToDate'), type: 'success' });
        window.dispatchEvent(
          new CustomEvent('tinkerkit:update-check', {
            detail: available ? 'available' : 'finished',
          }),
        );
      } catch (error) {
        toast.add({
          title: t('settings.updateFailed'),
          description: formatBackendError(error) || t('settings.updateFailedDesc'),
          type: 'error',
        });
        window.dispatchEvent(new CustomEvent('tinkerkit:update-check', { detail: 'finished' }));
      }
    })();
  }, [t]);
  useEffect(() => {
    const off = Events.On('check-updates', checkForUpdates);
    return () => off();
  }, [checkForUpdates]);
  const run = (item: IndexedItem) => {
    const toolId = paletteToolId(item);
    if (toolId && !enabledToolSet.has(toolId)) return;
    if (!item.toggle) setPaletteOpen(false);
    if (item.settingsAction) {
      switch (item.settingsAction) {
        case 'quit':
          settingsCommandId.current += 1;
          setSettingsCommandRequest({ id: settingsCommandId.current, action: item.settingsAction });
          if (page !== 'settings') navigate('settings');
          return;
        case 'check-updates':
          checkForUpdates();
          return;
        case 'toggle-display-mode':
          setSettingsWithThemeTransition((current) => {
            const modes = THEME_MODE_OPTIONS.map(({ id }) => id);
            const currentIndex = modes.indexOf(current.themeMode as (typeof modes)[number]);
            return {
              ...current,
              themeMode: modes[(currentIndex + 1 + modes.length) % modes.length],
            };
          });
          return;
        case 'toggle-language':
          setSettings((current) => {
            const currentIndex = SUPPORTED_LANGUAGES.findIndex(
              ({ code }) => code === current.language,
            );
            const next = SUPPORTED_LANGUAGES[(currentIndex + 1) % SUPPORTED_LANGUAGES.length];
            return { ...current, language: next.code };
          });
          return;
        case 'toggle-font-size':
          setSettings((current) => {
            const currentIndex = EDITOR_FONT_SIZES.indexOf(
              (current.codeEditorFontSize || 16) as (typeof EDITOR_FONT_SIZES)[number],
            );
            return {
              ...current,
              codeEditorFontSize: EDITOR_FONT_SIZES[(currentIndex + 1) % EDITOR_FONT_SIZES.length],
            };
          });
          return;
        case 'toggle-sidebar':
          toggleSidebarManage();
          return;
      }
    }
    if (item.historyDelta) {
      setPending(null);
      routerNavigate(item.historyDelta);
      return;
    }
    if (!item.tool) {
      setPending(null);
      navigate(item.page!);
      return;
    }
    const tool = item.tool;
    const action = item.action ?? 'open';
    const needsInput = !!item.needsInput;
    const apply = async () => {
      let input = '';
      if (needsInput) {
        input = (await Clipboard.Text().catch(() => '')) || '';
        if (!input.trim()) {
          setPending(null);
          navigate(tool);
          toast.add({
            title: t('toast.clipboardEmpty'),
            description: t('toast.clipboardEmptyDesc'),
            type: 'warning',
          });
          return;
        }
      }
      if (tool === 'diff' && action === 'fill' && item.target === 'alternate') {
        const t = nextDiffTarget.current;
        nextDiffTarget.current = t === 'before' ? 'after' : 'before';
        setPending({ tool, action, input, target: t });
        navigate(tool);
        return;
      }
      setPending({
        tool,
        action,
        input,
        mode: item.mode,
        target: item.target === 'alternate' ? undefined : item.target,
        pane: item.pane,
      });
      navigate(tool);
    };
    apply();
  };
  const analyzeClipboard = (text: string) => {
    if (!settingsRef.current.trayMatchEnabled) return;
    const currentSettings = settingsRef.current;
    if (!currentSettings.trayMatchEnabled) return;
    const s = text.trim();
    if (!s) return;
    const currentPage = pageRef.current;
    const enabledSidebarTools = new Set(
      resolveSidebarTools(currentSettings.sidebarTools)
        .filter((item) => item.enabled)
        .map((item) => item.id),
    );
    const trayTools = new Set(
      (
        currentSettings.trayMatchTools ?? ['json', 'time', 'text', 'base64', 'diff', 'jwt', 'url']
      ).filter((id) => enabledSidebarTools.has(id)),
    );
    let tool: ToolId | null = null;
    let mode: string | undefined;
    let target: 'before' | 'after' | undefined;
    if (
      currentPage === 'diff' &&
      trayTools.has('diff') &&
      enabledSidebarTools.has('diff') &&
      currentSettings.diffClipboardTargetMode !== 'off'
    ) {
      tool = 'diff';
      target =
        currentSettings.diffClipboardTargetMode === 'before'
          ? 'before'
          : currentSettings.diffClipboardTargetMode === 'after'
            ? 'after'
            : nextDiffTarget.current;
    } else {
      const parsedTime = parseTimeInput(s);
      if (parsedTime && trayTools.has('time')) tool = 'time';
      else if (trayTools.has('url') && parseSupportedUrl(s)) tool = 'url';
      else if (trayTools.has('jwt') && detectJwt(s)) tool = 'jwt';
      else {
        mode = detectBase64(s) ?? undefined;
        if (mode && trayTools.has('base64')) tool = 'base64';
        else
          try {
            parseJsonLoose(s);
            if (trayTools.has('json')) tool = 'json';
          } catch {}
        if (!tool && trayTools.has('text')) tool = 'text';
      }
    }
    if (!tool || !enabledSidebarTools.has(tool)) return;
    const apply = (match: {
      tool: ToolId;
      input: string;
      mode?: string;
      target?: 'before' | 'after';
    }) => {
      if (
        match.tool === 'diff' &&
        match.target &&
        currentSettings.diffClipboardTargetMode === 'alternate'
      )
        nextDiffTarget.current = match.target === 'before' ? 'after' : 'before';
      setPending({
        tool: match.tool,
        action: 'open',
        input: match.input,
        mode: match.mode,
        target: match.target,
      });
      navigate(match.tool);
      toast.add({
        title: t('toast.trayAutoFilled', { tool: t(`tools.${match.tool}.name`) }),
        type: 'success',
      });
    };
    const match = { tool, input: text, mode, target };
    if (currentSettings.autoOverwrite) {
      apply(match);
    } else {
      // 关闭自动覆盖时，先跳到对应工具（让用户看到将被填入/覆盖的内容），再弹窗询问。
      navigate(tool);
      setMatchDialog(match);
    }
  };
  return (
    <>
      <Toaster />
      <TaskCenter
        settings={settings}
        onSettingsChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
      />
      <div className="app-shell relative grid h-dvh grid-rows-[var(--app-titlebar-height)_minmax(0,1fr)] bg-background">
        <div className="ambient pointer-events-none absolute inset-0 z-0" />
        <header
          className="titlebar relative z-[2] grid grid-cols-3 h-full cursor-default pointer-events-auto select-none items-center border-b border-border bg-background px-4 [--wails-draggable:drag]"
          data-wails-drag
        >
          <div className="flex min-w-0 items-center pl-[calc(var(--app-titlebar-pad-left)-1rem)]">
            <Button
              variant="ghost"
              size="icon-sm"
              className="sidebar-toggle relative top-(--app-titlebar-toggle-offset) flex-none self-center rounded-lg text-muted-foreground [--wails-draggable:no-drag] hover:bg-muted hover:text-foreground"
              onClick={cycleSidebar}
              disabled={sidebarManaging}
              aria-label={t('sidebar.toggle')}
              title={t('sidebar.toggle')}
            >
              <SidebarSimple size={16} weight="duotone" />
            </Button>
            <div className="titlebar-navigation relative top-(--app-titlebar-item-offset) ml-1 flex h-7 items-center gap-0.5 self-center [--wails-draggable:no-drag]">
              <Button
                variant="ghost"
                disabled={!canGoBack}
                size="icon-sm"
                className="titlebar-navigation-button flex-none text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-[15px]"
                onClick={() => routerNavigate(-1)}
                aria-label={t('titlebar.back')}
                title={t('titlebar.back')}
              >
                <ArrowLeft size={15} weight="duotone" />
              </Button>
              <Button
                variant="ghost"
                disabled={!canGoForward}
                size="icon-sm"
                className="titlebar-navigation-button flex-none text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-[15px]"
                onClick={() => routerNavigate(1)}
                aria-label={t('titlebar.forward')}
                title={t('titlebar.forward')}
              >
                <ArrowRight size={15} weight="duotone" />
              </Button>
            </div>
          </div>
          <div className="pointer-events-none flex min-w-0 items-center justify-center">
            <h1 className="m-0 truncate text-sm font-semibold text-foreground">
              {t(
                sidebarPage === 'settings'
                  ? 'settings.title'
                  : sidebarPage === 'history'
                    ? 'history.title'
                    : `tools.${sidebarPage}.name`,
              )}
            </h1>
          </div>
          <div className="flex min-w-0 items-center justify-end [&>*]:max-w-full">
            <UpdatePill />
          </div>
        </header>
        <div
          className={`main relative z-[1] grid min-h-0 ${layoutSidebarMode === 'hidden' ? 'grid-cols-[0px_minmax(0,1fr)] [&_.sidebar]:invisible [&_.sidebar]:overflow-hidden' : layoutSidebarMode === 'icon' ? 'grid-cols-[56px_minmax(0,1fr)] [&_.sidebar]:overflow-hidden [&_.sidebar]:pt-3 [&_.sidebar-heading]:hidden [&_.sidebar-item]:justify-center [&_.sidebar-item]:px-0 [&_.sidebar-item_span]:hidden [&_.sidebar-palette_kbd]:hidden [&_.sidebar-palette_span]:hidden [&_.sidebar-palette]:justify-center' : 'grid-cols-[232px_minmax(0,1fr)]'}`}
        >
          <Sidebar
            page={sidebarPage}
            onNavigate={navigate}
            onOpenPalette={openPalette}
            managing={sidebarManaging}
            sidebarTools={resolvedSidebarTools}
            onSidebarToolsChange={updateSidebarTools}
            onExitManage={() => setSidebarManaging(false)}
          />
          <main
            className={`workspace relative min-h-0 w-full overflow-x-hidden overflow-y-auto bg-background${tools.some((tool) => tool.id === page) || page === 'history' || page === 'settings' || page === 'image-manager-detail' ? ' overflow-y-hidden' : ''}`}
            ref={workspaceRef}
          >
            {' '}
            <div className={toolSlotClass(page === 'json')}>
              {visited.has('json') && (
                <Suspense fallback={null}>
                  <JsonTool
                    active={page === 'json'}
                    theme={theme}
                    autoFormatOnFill={settings.jsonAutoFormatOnFill !== false}
                    onAutoFormatOnFillChange={(jsonAutoFormatOnFill) =>
                      setSettings((current) => ({ ...current, jsonAutoFormatOnFill }))
                    }
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'time')}>
              {visited.has('time') && (
                <Suspense fallback={null}>
                  <TimeTool
                    active={page === 'time'}
                    resultOrder={settings.timeResultOrder ?? []}
                    hiddenResults={settings.hiddenTimeResults ?? []}
                    weekStart={settings.timeWeekStart === 'sunday' ? 'sunday' : 'monday'}
                    ntpServers={settings.ntpServers ?? []}
                    onSaveResults={(timeResultOrder, hiddenTimeResults) =>
                      setSettings((current) => ({ ...current, timeResultOrder, hiddenTimeResults }))
                    }
                    onWeekStartChange={(timeWeekStart) =>
                      setSettings((current) => ({ ...current, timeWeekStart }))
                    }
                    onNtpServersChange={(ntpServers) =>
                      setSettings((current) => ({ ...current, ntpServers }))
                    }
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'text')}>
              {visited.has('text') && (
                <Suspense fallback={null}>
                  <TextTool
                    active={page === 'text'}
                    theme={theme}
                    alwaysShowSearch={settings.textAlwaysShowSearch === true}
                    onAlwaysShowSearchChange={(textAlwaysShowSearch) =>
                      setSettings((current) => ({ ...current, textAlwaysShowSearch }))
                    }
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'text-generator')}>
              {visited.has('text-generator') && (
                <Suspense fallback={null}>
                  <TextGeneratorTool
                    active={page === 'text-generator'}
                    sources={settings.textGeneratorSources ?? []}
                    onSourcesChange={(textGeneratorSources) =>
                      setSettings((current) => ({ ...current, textGeneratorSources }))
                    }
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'base64')}>
              {visited.has('base64') && (
                <Suspense fallback={null}>
                  <Base64Tool
                    active={page === 'base64'}
                    theme={theme}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'diff')}>
              {visited.has('diff') && (
                <Suspense fallback={null}>
                  <DiffTool
                    active={page === 'diff'}
                    theme={theme}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'jwt')}>
              {visited.has('jwt') && (
                <Suspense fallback={null}>
                  <JwtTool
                    active={page === 'jwt'}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'url')}>
              {visited.has('url') && (
                <Suspense fallback={null}>
                  <UrlTool
                    active={page === 'url'}
                    theme={theme}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'qrcode')}>
              {visited.has('qrcode') && (
                <Suspense fallback={null}>
                  <QrCodeTool
                    active={page === 'qrcode'}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'image')}>
              {visited.has('image') && (
                <Suspense fallback={null}>
                  <ImageTool
                    active={page === 'image'}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'image-manager')}>
              {visited.has('image-manager') && (
                <Suspense fallback={null}>
                  <ImageManagerTool
                    active={page === 'image-manager'}
                    settings={settings}
                    onSettingsChange={saveImageManagerSettings}
                    onOpenDetail={openImageManagerDetail}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'image-manager-detail')}>
              {visited.has('image-manager-detail') && imageDetailRoute ? (
                <Suspense fallback={null}>
                  <ImageManagerDetailPage
                    active={page === 'image-manager-detail'}
                    imageId={imageDetailRoute.imageId}
                    onBack={() => routerNavigate(-1)}
                    record={record}
                    sourceId={imageDetailRoute.sourceId}
                  />
                </Suspense>
              ) : null}
            </div>
            <div className={toolSlotClass(page === 'service-manager')}>
              {visited.has('service-manager') && (
                <Suspense fallback={null}>
                  <ServiceManagerTool
                    active={page === 'service-manager'}
                    record={record}
                    highlightLevels={settings.serviceLogHighlightLevels}
                    setHighlightLevels={(value) =>
                      setSettings((current) => ({ ...current, serviceLogHighlightLevels: value }))
                    }
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'ports')}>
              {visited.has('ports') && (
                <Suspense fallback={null}>
                  <PortTool active={page === 'ports'} />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'network-test')}>
              {visited.has('network-test') && (
                <Suspense fallback={null}>
                  <NetworkTestTool
                    active={page === 'network-test'}
                    record={record}
                    pending={pending}
                    clearPending={() => setPending(null)}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'ssh-files')}>
              {visited.has('ssh-files') && (
                <Suspense fallback={null}>
                  <SshFilesTool active={page === 'ssh-files'} />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'settings')}>
              {page === 'settings' && (
                <Suspense fallback={null}>
                  <SettingsPage
                    settings={settings}
                    setSettings={setSettings}
                    setThemeMode={setSettingsWithThemeTransition}
                    onConfigReplaced={(config) => {
                      setSettingsWithThemeTransition(config);
                      void i18n.changeLanguage(config.language || 'zh-CN');
                      void SetAutoCheckEnabled(config.autoCheckUpdates);
                    }}
                    tools={tools}
                    clearHistory={clearHistory}
                    sidebarManaging={sidebarManaging}
                    onToggleSidebarManage={toggleSidebarManage}
                    commandRequest={settingsCommandRequest}
                    onCommandRequestHandled={(id) =>
                      setSettingsCommandRequest((current) => (current?.id === id ? null : current))
                    }
                    flushSettingsSave={flushSettingsSave}
                  />
                </Suspense>
              )}
            </div>
            <div className={toolSlotClass(page === 'history')}>
              {visited.has('history') && (
                <Suspense fallback={null}>
                  <HistoryPage
                    active={page === 'history'}
                    openHistory={openHistory}
                    clear={clearHistory}
                    enabledToolIds={enabledToolIds}
                    historyRevision={historyRevision}
                  />
                </Suspense>
              )}
            </div>
          </main>
        </div>
        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          indexed={indexed}
          run={run}
          page={sidebarPage}
        />
      </div>
      <AlertDialog
        open={sshHostKeyPrompt !== null}
        onOpenChange={(open) => {
          if (!open) respondSSHHostKeyPrompt(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sshHostKeyDialog.title')}</AlertDialogTitle>
            {sshHostKeyPrompt ? (
              <AlertDialogDescription render={<div />} className="space-y-3 text-left">
                <p className="m-0">
                  {t(
                    sshHostKeyPrompt.changed
                      ? 'sshHostKeyDialog.changedDescription'
                      : 'sshHostKeyDialog.unknownDescription',
                    { address: sshHostKeyPrompt.address },
                  )}
                </p>
                {sshHostKeyPrompt.knownFingerprints.length > 0 ? (
                  <div className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {t('sshHostKeyDialog.knownFingerprints')}
                    </span>
                    {sshHostKeyPrompt.knownFingerprints.map((fingerprint) => (
                      <code
                        key={fingerprint}
                        className="break-all rounded-md border bg-muted/30 px-2 py-1 text-xs"
                      >
                        {fingerprint}
                      </code>
                    ))}
                  </div>
                ) : null}
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t('sshHostKeyDialog.currentFingerprint')}
                  </span>
                  <code className="break-all rounded-md border bg-muted/30 px-2 py-1 text-xs">
                    {sshHostKeyPrompt.fingerprint}
                  </code>
                </div>
                <p className="m-0 text-xs">{t('sshHostKeyDialog.verifyHint')}</p>
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('sshHostKeyDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => respondSSHHostKeyPrompt(true)}>
              {t(sshHostKeyPrompt?.changed ? 'sshHostKeyDialog.update' : 'sshHostKeyDialog.trust')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={matchDialog !== null}
        onOpenChange={(open) => {
          if (!open) setMatchDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('matchDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="w-full text-left">
              <p className="m-0">
                {t('matchDialog.bodyPrefix')}
                <strong>{matchDialog ? t(`tools.${matchDialog.tool}.name`) : ''}</strong>
                {t('matchDialog.bodySuffix')}
              </p>
              {matchDialog ? (
                <ScrollArea className="mt-2 h-24 rounded-md border bg-muted/30 px-2 py-1">
                  <code className="block text-xs leading-5 break-all whitespace-pre-wrap">
                    {matchDialog.input}
                  </code>
                </ScrollArea>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('matchDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const d = matchDialog;
                setMatchDialog(null);
                if (d && enabledToolSet.has(d.tool)) {
                  if (
                    d.tool === 'diff' &&
                    d.target &&
                    settings.diffClipboardTargetMode === 'alternate'
                  )
                    nextDiffTarget.current = d.target === 'before' ? 'after' : 'before';
                  setPending({
                    tool: d.tool,
                    action: 'open',
                    input: d.input,
                    mode: d.mode,
                    target: d.target,
                  });
                }
              }}
            >
              {t('matchDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default AppShell;
