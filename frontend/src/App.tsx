import { Clipboard, Events } from '@wailsio/runtime';
import type { SetStateAction } from 'react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import {
  Get as GetConfig,
  ResolveSSHHostKeyPrompt,
  Save as SaveConfig,
  SaveImageSources,
} from '../bindings/tinkerkit/configservice';
import { Log as LogFrontend } from '../bindings/tinkerkit/logservice';
import type { Config as Settings } from '../bindings/tinkerkit/models';
import { CheckForUpdates, SetAutoCheckEnabled } from '../bindings/tinkerkit/updateservice';
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
} from './app/definitions';
import { isToolId, paletteToolId, resolveSidebarTools, routePath } from './app/navigation';
import { buildIndex } from './app/palette-search';
import { WorkspaceTabBar } from './app/WorkspaceTabBar';
import {
  activateTab,
  activeTab,
  closeTab,
  closeTabs,
  cycleTabs,
  emptyWorkspace,
  openOrFocusSettings,
  openToolTab,
  parseTabCloseActivation,
  parseTabCloseButton,
  parseTabOrientation,
  visiblePaletteCommands,
  type WorkspaceState,
  type WorkspaceTab,
} from './app/workspace-tabs';
import { parseJsonLoose, type PendingAction, type ToolId } from './components/shared';
import { TaskCenter } from './components/TaskCenter';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog';
import { Button } from './components/ui/button';
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

const ServiceManagerTool = lazy(() => import('./components/ServiceManagerTool'));

const SshFilesTool = lazy(() => import('./components/SshFilesTool'));

const PortTool = lazy(() => import('./components/PortTool'));

const NetworkTestTool = lazy(() => import('./components/NetworkTestTool'));

const SettingsPage = lazy(() => import('./components/SettingsPage'));

function toolSlotClass(active: boolean) {
  return active
    ? 'tool-slot relative isolate z-10 h-full min-h-0 overflow-hidden bg-background'
    : 'tool-slot absolute inset-0 isolate z-0 h-full min-h-0 overflow-hidden invisible opacity-0 pointer-events-none is-hidden';
}

function AppShell() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const workspaceElRef = useRef<HTMLElement>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState>(emptyWorkspace);
  const workspaceStateRef = useRef(workspace);
  workspaceStateRef.current = workspace;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [romanize, setRomanize] = useState<Romanize>(() => (text) => text);
  const [delivered, setDelivered] = useState<{
    tabId: string;
    action: PendingAction;
  } | null>(null);
  const [settingsCommandRequest, setSettingsCommandRequest] = useState<{
    id: number;
    action: 'quit';
  } | null>(null);
  const settingsCommandId = useRef(0);
  const [jsonSchemaOpen, setJsonSchemaOpen] = useState(false);
  const [jsonPipelineOpen, setJsonPipelineOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
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
  const commitWorkspace = (next: WorkspaceState) => {
    workspaceStateRef.current = next;
    setWorkspace(next);
  };
  const closeActivation = () => parseTabCloseActivation(settingsRef.current.tabCloseActivation);
  const openTool = (toolId: ToolId) => {
    const opened = openToolTab(workspaceStateRef.current, toolId);
    commitWorkspace(opened.state);
    return opened.tab;
  };
  const openSettingsTab = () => {
    commitWorkspace(openOrFocusSettings(workspaceStateRef.current));
  };
  const focusTab = (id: string) => {
    commitWorkspace(activateTab(workspaceStateRef.current, id));
  };
  const closeWorkspaceTab = (id: string) => {
    commitWorkspace(closeTab(workspaceStateRef.current, id, closeActivation()));
    setDelivered((current) => (current?.tabId === id ? null : current));
  };
  const closeCurrentTab = () => {
    const id = workspaceStateRef.current.activeId;
    if (id) closeWorkspaceTab(id);
  };
  const closeToolTabs = (toolId: string) => {
    const ids = workspaceStateRef.current.tabs
      .filter((tab) => tab.toolId === toolId)
      .map((tab) => tab.id);
    commitWorkspace(closeTabs(workspaceStateRef.current, ids, closeActivation()));
    setDelivered((current) => (current && ids.includes(current.tabId) ? null : current));
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
  const [sshLocate, setSshLocate] = useState<{
    tabId: string;
    locate: { id: number; sourceID: string; path: string };
  } | null>(null);
  const sshLocateIdRef = useRef(0);
  const locateSshUploadTarget = (sourceID: string, path: string) => {
    const tab = openTool('ssh-files');
    setSshLocate({
      tabId: tab.id,
      locate: { id: ++sshLocateIdRef.current, sourceID, path },
    });
  };
  useEffect(() => {
    const off = Events.On('ssh:host-key', (event) => {
      const prompt = parseSSHHostKeyPrompt(event.data);
      if (!prompt) return;
      setSSHHostKeyPrompt((current) => current ?? prompt);
    });
    return () => off();
  }, []);
  const currentTab = activeTab(workspace);
  const currentToolId = currentTab?.toolId;
  const routePage: Page | null = !currentTab
    ? null
    : currentTab.kind === 'settings'
      ? 'settings'
      : currentToolId && isToolId(currentToolId)
        ? currentToolId
        : null;
  const workspacePath = routePath(routePage);
  useEffect(() => {
    if (location.pathname !== workspacePath) routerNavigate(workspacePath, { replace: true });
  }, [location.pathname, routerNavigate, workspacePath]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const dark = theme.endsWith('-dark');
    root.classList.toggle('dark', dark);
    root.dataset.theme = theme;
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.style.setProperty('--code-editor-font-size', `${settings.codeEditorFontSize || 16}px`);
    root.dataset.showTabIcons = settings.showTabIcons ? 'true' : 'false';
  }, [theme, settings.codeEditorFontSize, settings.showTabIcons]);
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
    void Events.On('navigate', (event) => {
      logFrontend(`[event] navigate data=${String(event.data)}`);
      if (event.data === 'settings') openSettingsTab();
      else if (isToolId(String(event.data))) openTool(String(event.data) as ToolId);
    });
  }, []);
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
    const off = Events.On('tray:analyze', (event) => {
      if (typeof event.data === 'string') analyzeClipboard(event.data);
    });
    return () => off();
  }, []);
  useLayoutEffect(() => workspaceElRef.current?.scrollTo(0, 0), [workspace.activeId]);
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
  const toolTabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tab of workspace.tabs) {
      if (!tab.toolId) continue;
      counts[tab.toolId] = (counts[tab.toolId] ?? 0) + 1;
    }
    return counts;
  }, [workspace.tabs]);
  const indexed = useMemo(() => {
    const contexts = new Set<PaletteContext>();
    if (jsonSchemaOpen && currentTab?.toolId === 'json') contexts.add('json.schema');
    if (jsonPipelineOpen && currentTab?.toolId === 'json') contexts.add('json.pipeline');
    const scope = !currentTab
      ? ({ kind: 'empty' } as const)
      : currentTab.kind === 'settings'
        ? ({ kind: 'settings' } as const)
        : ({ kind: 'tool', toolId: currentTab.toolId ?? '' } as const);
    const items = visiblePaletteCommands(paletteItems, scope, enabledToolIds, contexts);
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
    currentTab,
    romanize,
    enabledToolIds,
    settings.themeMode,
    settings.language,
    settings.codeEditorFontSize,
  ]);
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
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!paletteOpen) lastFocusedRef.current = document.activeElement;
        setPaletteOpen((open) => !open);
        return;
      }
      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (!event.repeat) closeCurrentTab();
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
        event.preventDefault();
        if (!event.repeat)
          commitWorkspace(cycleTabs(workspaceStateRef.current, event.shiftKey ? -1 : 1));
        return;
      }
      if (event.key === 'Escape' && paletteOpen) closePalette();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, closePalette]);
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
  const deliver = (tabId: string, action: PendingAction) => {
    setDelivered({ tabId, action });
  };
  const run = (item: IndexedItem) => {
    const toolId = paletteToolId(item);
    if (toolId && !enabledToolSet.has(toolId)) return;
    if (!item.toggle) setPaletteOpen(false);
    if (item.settingsAction) {
      switch (item.settingsAction) {
        case 'quit':
          settingsCommandId.current += 1;
          setSettingsCommandRequest({ id: settingsCommandId.current, action: item.settingsAction });
          openSettingsTab();
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
      }
    }
    if (item.page === 'settings') {
      setDelivered(null);
      openSettingsTab();
      return;
    }
    if (item.page && isToolId(item.page)) {
      setDelivered(null);
      openTool(item.page);
      return;
    }
    if (!item.tool) return;
    const tab = activeTab(workspaceStateRef.current);
    if (!tab || tab.toolId !== item.tool) return;
    const tool = item.tool;
    const action = item.action ?? 'open';
    const needsInput = !!item.needsInput;
    const apply = async () => {
      let input = '';
      if (needsInput) {
        input = (await Clipboard.Text().catch(() => '')) || '';
        if (!input.trim()) {
          toast.add({
            title: t('toast.clipboardEmpty'),
            description: t('toast.clipboardEmptyDesc'),
            type: 'warning',
          });
          return;
        }
      }
      if (tool === 'diff' && action === 'fill' && item.target === 'alternate') {
        const side = nextDiffTarget.current;
        nextDiffTarget.current = side === 'before' ? 'after' : 'before';
        deliver(tab.id, { tool, action, input, target: side });
        return;
      }
      deliver(tab.id, {
        tool,
        action,
        input,
        mode: item.mode,
        target: item.target === 'alternate' ? undefined : item.target,
        pane: item.pane,
      });
    };
    void apply();
  };
  const analyzeClipboard = (text: string) => {
    const currentSettings = settingsRef.current;
    if (!currentSettings.trayMatchEnabled) return;
    const s = text.trim();
    if (!s) return;
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
    if (!tool || !enabledSidebarTools.has(tool)) return;
    const tab = openTool(tool);
    deliver(tab.id, { tool, action: 'open', input: text, mode });
    toast.add({
      title: t('toast.trayAutoFilled', { tool: t(`tools.${tool}.name`) }),
      type: 'success',
    });
  };
  const clearDelivered = () => setDelivered(null);
  const pendingFor = (tabId: string) => (delivered?.tabId === tabId ? delivered.action : null);
  const renderWorkspaceTab = (tab: WorkspaceTab) => {
    const active = tab.id === workspace.activeId;
    const pending = pendingFor(tab.id);
    const toolId = tab.kind === 'settings' ? 'settings' : tab.toolId;
    switch (toolId) {
      case 'json':
        return (
          <JsonTool
            active={active}
            theme={theme}
            autoFormatOnFill={settings.jsonAutoFormatOnFill !== false}
            onAutoFormatOnFillChange={(jsonAutoFormatOnFill) =>
              setSettings((current) => ({ ...current, jsonAutoFormatOnFill }))
            }
            pending={pending}
            clearPending={clearDelivered}
          />
        );
      case 'time':
        return (
          <TimeTool
            active={active}
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
            onNtpServersChange={(ntpServers) => setSettings((current) => ({ ...current, ntpServers }))}
            pending={pending}
            clearPending={clearDelivered}
          />
        );
      case 'text':
        return (
          <TextTool
            active={active}
            theme={theme}
            alwaysShowSearch={settings.textAlwaysShowSearch === true}
            onAlwaysShowSearchChange={(textAlwaysShowSearch) =>
              setSettings((current) => ({ ...current, textAlwaysShowSearch }))
            }
            pending={pending}
            clearPending={clearDelivered}
          />
        );
      case 'text-generator':
        return (
          <TextGeneratorTool
            active={active}
            sources={settings.textGeneratorSources ?? []}
            onSourcesChange={(textGeneratorSources) =>
              setSettings((current) => ({ ...current, textGeneratorSources }))
            }
            pending={pending}
            clearPending={clearDelivered}
          />
        );
      case 'base64':
        return (
          <Base64Tool active={active} theme={theme} pending={pending} clearPending={clearDelivered} />
        );
      case 'diff':
        return (
          <DiffTool active={active} theme={theme} pending={pending} clearPending={clearDelivered} />
        );
      case 'jwt':
        return <JwtTool active={active} pending={pending} clearPending={clearDelivered} />;
      case 'url':
        return (
          <UrlTool active={active} theme={theme} pending={pending} clearPending={clearDelivered} />
        );
      case 'qrcode':
        return <QrCodeTool active={active} pending={pending} clearPending={clearDelivered} />;
      case 'image':
        return <ImageTool active={active} pending={pending} clearPending={clearDelivered} />;
      case 'image-manager':
        return (
          <ImageManagerTool
            active={active}
            settings={settings}
            onSettingsChange={saveImageManagerSettings}
            pending={pending}
            clearPending={clearDelivered}
          />
        );
      case 'service-manager':
        return (
          <ServiceManagerTool
            active={active}
            highlightLevels={settings.serviceLogHighlightLevels}
            setHighlightLevels={(value) =>
              setSettings((current) => ({ ...current, serviceLogHighlightLevels: value }))
            }
            collapseLines={settings.serviceLogCollapseLines}
            setCollapseLines={(value) =>
              setSettings((current) => ({ ...current, serviceLogCollapseLines: value }))
            }
            taskNotificationMode={settings.taskNotificationMode}
          />
        );
      case 'ports':
        return <PortTool active={active} />;
      case 'network-test':
        return (
          <NetworkTestTool active={active} taskNotificationMode={settings.taskNotificationMode} />
        );
      case 'ssh-files':
        return (
          <SshFilesTool
            active={active}
            locate={sshLocate?.tabId === tab.id ? sshLocate.locate : null}
          />
        );
      case 'settings':
        return (
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
            toolTabCounts={toolTabCounts}
            onCloseToolTabs={closeToolTabs}
            commandRequest={settingsCommandRequest}
            onCommandRequestHandled={(id) =>
              setSettingsCommandRequest((current) => (current?.id === id ? null : current))
            }
            flushSettingsSave={flushSettingsSave}
          />
        );
      default:
        return null;
    }
  };
  const orientation = parseTabOrientation(settings.tabOrientation);
  const horizontal = orientation === 'horizontal';
  const tabBar = (
    <WorkspaceTabBar
      orientation={orientation}
      tabs={workspace.tabs}
      activeId={workspace.activeId}
      showIcons={settings.showTabIcons === true}
      closeButton={parseTabCloseButton(settings.tabCloseButton)}
      onActivate={focusTab}
      onClose={closeWorkspaceTab}
      onNewTab={openPalette}
    />
  );
  return (
    <>
      <Toaster />
      <TaskCenter
        settings={settings}
        onSettingsChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
        onLocateFileTarget={locateSshUploadTarget}
      />
      <div
        className={`app-shell relative h-dvh bg-background ${horizontal ? 'grid grid-rows-[var(--app-titlebar-height)_minmax(0,1fr)]' : 'grid grid-cols-[var(--workspace-tab-strip)_minmax(0,1fr)]'}`}
      >
        <div className="ambient pointer-events-none absolute inset-0 z-0" />
        {horizontal ? (
          <header
            className="relative z-[2] flex h-full min-w-0 items-center border-b border-border bg-background pl-(--workspace-traffic-inset) [--wails-draggable:drag]"
            data-wails-drag
          >
            {tabBar}
            <div className="flex min-w-0 items-center pr-3 [&>*]:max-w-full">
              <UpdatePill />
            </div>
          </header>
        ) : (
          <aside
            className="relative z-[2] flex h-full min-h-0 w-(--workspace-tab-strip) flex-col border-r border-border bg-background [--wails-draggable:drag]"
            data-wails-drag
          >
            <div className="h-(--workspace-traffic-block) shrink-0" />
            {tabBar}
          </aside>
        )}
        <div className="relative z-[1] min-h-0 min-w-0">
          {horizontal ? null : (
            <>
              <div
                className="absolute inset-x-0 top-0 z-20 h-(--app-titlebar-height) [--wails-draggable:drag]"
                data-wails-drag
              />
              <div className="absolute top-1.5 right-3 z-30 max-w-[min(340px,40vw)]">
                <UpdatePill />
              </div>
            </>
          )}
          <main
            className="workspace relative h-full min-h-0 w-full overflow-hidden bg-background"
            ref={workspaceElRef}
          >
            {workspace.tabs.map((tab) => (
              <div key={tab.id} className={toolSlotClass(tab.id === workspace.activeId)}>
                <Suspense fallback={null}>{renderWorkspaceTab(tab)}</Suspense>
              </div>
            ))}
          </main>
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        indexed={indexed}
        run={run}
        page={routePage ?? 'settings'}
      />
      <Dialog
        open={sshHostKeyPrompt !== null}
        onOpenChange={(open) => {
          if (!open) respondSSHHostKeyPrompt(false);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('sshHostKeyDialog.title')}</DialogTitle>
            {sshHostKeyPrompt ? (
              <DialogDescription render={<div />} className="space-y-3">
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
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t('sshHostKeyDialog.cancel')}
            </DialogClose>
            <Button onClick={() => respondSSHHostKeyPrompt(true)}>
              {t(sshHostKeyPrompt?.changed ? 'sshHostKeyDialog.update' : 'sshHostKeyDialog.trust')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default AppShell;
