import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Key,
  PencilSimple,
  Power,
  SidebarSimple,
  Trash,
} from '@phosphor-icons/react';
import { Application, Browser } from '@wailsio/runtime';
import { useTranslation } from 'react-i18next';
import i18n, { SUPPORTED_LANGUAGES } from '../i18n';
import type { Config as Settings, SSHKnownHost } from '../../bindings/changeme/models';
import {
  DeleteSSHKnownHost,
  GetSSHKnownHosts,
  UpdateSSHKnownHost,
} from '../../bindings/changeme/configservice';
import { CheckForUpdates, GetCurrentVersion } from '../../bindings/changeme/updateservice';
import { ClearHistoryDialog } from './HistoryPage';
import {
  ToolLayout,
  ToolLayoutHeader,
  ToolLayoutScrollableContent,
  type Icon,
  type ToolId,
} from './shared';
import { toast } from './ui/toast';
import { GITHUB_REPO_URL } from '../repositoryUrl';
import { THEME_MODE_OPTIONS, type ThemeMode } from '../theme';
import { cn } from '@/lib/utils';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';

const TRAY_MATCH_DEFAULT_TOOLS: readonly ToolId[] = [
  'json',
  'time',
  'text',
  'base64',
  'diff',
  'jwt',
  'url',
];
const EDITOR_FONT_SIZES = [12, 14, 16, 18] as const;
const settingRowClass = 'flex min-h-8 items-center justify-between gap-5';
const settingLabelClass = 'text-xs leading-[1.4] font-medium text-foreground';
const settingHintClass = 'text-[10px] leading-[1.4] text-muted-foreground';
const settingStackClass =
  'divide-y divide-border [&>:not(:first-child)]:pt-3 [&>:not(:last-child)]:pb-3';

export type ToolDefinition = {
  id: ToolId;
  nameKey: string;
  descriptionKey: string;
  icon: Icon;
  keywords: string;
};
type BooleanSettingKey = 'trayMatchEnabled' | 'autoOverwrite' | 'autoCheckUpdates';
type ChoiceOption<T extends string | number> = { id: T; label: string };

function SettingSwitch({
  selected,
  onChange,
  isDisabled = false,
  id,
  describedBy,
}: {
  selected: boolean;
  onChange: (v: boolean) => void;
  isDisabled?: boolean;
  id?: string;
  describedBy?: string;
}) {
  return (
    <Switch
      id={id}
      checked={selected}
      onCheckedChange={onChange}
      disabled={isDisabled}
      size="sm"
      aria-describedby={describedBy}
    />
  );
}

function SettingsGroup({
  title,
  subtitle,
  children,
  divider = true,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  divider?: boolean;
}) {
  return (
    <section
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_minmax(320px,520px)] gap-5 py-4 max-[700px]:grid-cols-1 max-[700px]:gap-2.5',
        divider && 'border-t border-border',
      )}
    >
      <div>
        <h2 className="mb-1 text-xs leading-[1.25] font-semibold tracking-[.01em] text-foreground">
          {title}
        </h2>
        <p className="m-0 text-[10px] leading-[1.5] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Setting({
  label,
  description,
  children,
}: {
  label?: string;
  description?: string;
  children: React.ReactNode;
}) {
  const controlId = useId();
  const isSwitch = isValidElement(children) && children.type === SettingSwitch;
  const switchProps = isSwitch
    ? (children.props as { isDisabled?: boolean; describedBy?: string })
    : undefined;
  const switchDisabled = Boolean(switchProps?.isDisabled);
  const copy = label ? (
    <span className="flex min-w-0 flex-col gap-0.5">
      <strong className={settingLabelClass}>{label}</strong>
      {description ? <small className={settingHintClass}>{description}</small> : null}
    </span>
  ) : null;
  if (isSwitch) {
    return (
      <div className={settingRowClass}>
        {label ? (
          <label
            htmlFor={controlId}
            className={cn('min-w-0', switchDisabled ? 'cursor-not-allowed' : 'cursor-pointer')}
          >
            {copy}
          </label>
        ) : null}
        {cloneElement(children as ReactElement<{ id?: string; describedBy?: string }>, {
          id: controlId,
          describedBy: switchProps?.describedBy,
        })}
      </div>
    );
  }
  return (
    <div className={settingRowClass}>
      {copy}
      {children}
    </div>
  );
}

function ChoiceGroup<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  const radiosRef = useRef<Array<HTMLElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const focusIndex = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.id);
    radiosRef.current[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const last = options.length - 1;
    if (last < 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusIndex(index === last ? 0 : index + 1);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusIndex(index === 0 ? last : index - 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusIndex(last);
    }
  };
  return (
    <div
      className={cn(
        settingRowClass,
        'max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-2',
      )}
    >
      <strong id={labelId} className={settingLabelClass}>
        {label}
      </strong>
      <div role="radiogroup" aria-labelledby={labelId} className="flex min-w-0 flex-none flex-wrap">
        {options.map((option, index) => {
          const checked = option.id === value;
          return (
            <Button
              key={String(option.id)}
              type="button"
              role="radio"
              variant={checked ? 'default' : 'ghost'}
              aria-checked={checked}
              tabIndex={checked || (selectedIndex < 0 && index === 0) ? 0 : -1}
              className="flex-none"
              onClick={() => onChange(option.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              ref={(node) => {
                radiosRef.current[index] = node;
              }}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function settingsErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.error === 'string' && value.error) return value.error;
  }
  return '';
}

function SSHKnownHostsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<SSHKnownHost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<SSHKnownHost | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SSHKnownHost | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const hostsID = useId();
  const publicKeyID = useId();
  const commentID = useId();
  const loadRequestRef = useRef(0);
  const reload = useCallback(() => {
    const requestID = loadRequestRef.current + 1;
    loadRequestRef.current = requestID;
    setLoading(true);
    setError('');
    void GetSSHKnownHosts()
      .then((next) => {
        if (requestID === loadRequestRef.current) setEntries(next ?? []);
      })
      .catch((reason) => {
        if (requestID === loadRequestRef.current) {
          setError(settingsErrorMessage(reason) || t('settings.sshKnownHostsLoadFailed'));
        }
      })
      .finally(() => {
        if (requestID === loadRequestRef.current) setLoading(false);
      });
  }, [t]);

  useEffect(() => {
    if (!open) {
      loadRequestRef.current += 1;
      setLoading(false);
      setEditing(null);
      setDeleteTarget(null);
      setDeleteError('');
      setError('');
      return;
    }
    reload();
  }, [open, reload]);

  const handleOpenChange = (next: boolean) => {
    if (!next && (saving || deleting)) return;
    if (!next) {
      setEditing(null);
      setDeleteTarget(null);
      setDeleteError('');
      setError('');
    }
    onOpenChange(next);
  };
  const save = async () => {
    if (!editing || saving) return;
    const targetID = editing.id;
    setSaving(true);
    setError('');
    try {
      const updated = await UpdateSSHKnownHost(editing);
      setEntries((current) => current.map((entry) => (entry.id === targetID ? updated : entry)));
      setEditing(null);
    } catch (reason) {
      setError(settingsErrorMessage(reason) || t('settings.sshKnownHostsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await DeleteSSHKnownHost(target.id);
      setDeleteTarget(null);
      reload();
    } catch (reason) {
      setDeleteError(settingsErrorMessage(reason) || t('settings.sshKnownHostsDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };
  const canSave = Boolean(editing?.hosts.trim() && editing.publicKey.trim());

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[min(720px,calc(100dvh-32px))] w-[min(640px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <DialogHeader className="flex-none border-b border-border px-6 py-5">
            <DialogTitle className="text-base">
              {t(editing ? 'settings.sshKnownHostsEditTitle' : 'settings.sshKnownHostsTitle')}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {t(editing ? 'settings.sshKnownHostsEditDesc' : 'settings.sshKnownHostsDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto border-b border-border px-6 py-5 [padding-inline-end:var(--overlay-scrollbar-hit-size)]">
            {editing ? (
              <div className="grid gap-4">
                {error ? (
                  <p className="m-0 text-xs text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="grid gap-1.5">
                  <Label htmlFor={hostsID}>{t('settings.sshKnownHostsHosts')}</Label>
                  <Input
                    id={hostsID}
                    value={editing.hosts}
                    disabled={saving}
                    onChange={(event) => {
                      setError('');
                      setEditing((current) =>
                        current ? { ...current, hosts: event.target.value } : current,
                      );
                    }}
                  />
                  <p className="m-0 text-[10px] leading-4 text-muted-foreground">
                    {t('settings.sshKnownHostsHostsHint')}
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={publicKeyID}>{t('settings.sshKnownHostsPublicKey')}</Label>
                  <Textarea
                    id={publicKeyID}
                    className="min-h-28 font-mono text-xs"
                    value={editing.publicKey}
                    disabled={saving}
                    onChange={(event) => {
                      setError('');
                      setEditing((current) =>
                        current ? { ...current, publicKey: event.target.value } : current,
                      );
                    }}
                  />
                </div>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t('settings.sshKnownHostsFingerprint')}
                  </span>
                  <code className="break-all rounded-md border bg-muted/30 px-2 py-1 text-xs">
                    {editing.fingerprint}
                  </code>
                  <p className="m-0 text-[10px] leading-4 text-muted-foreground">
                    {t('settings.sshKnownHostsFingerprintHint')}
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={commentID}>{t('settings.sshKnownHostsComment')}</Label>
                  <Input
                    id={commentID}
                    value={editing.comment}
                    disabled={saving}
                    onChange={(event) => {
                      setError('');
                      setEditing((current) =>
                        current ? { ...current, comment: event.target.value } : current,
                      );
                    }}
                  />
                </div>
              </div>
            ) : loading ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <Spinner className="size-6 text-primary motion-reduce:animate-none" />
                <span>{t('settings.sshKnownHostsLoading')}</span>
              </div>
            ) : error ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center">
                <p className="m-0 text-xs text-destructive" role="alert">
                  {error}
                </p>
                <Button variant="outline" size="sm" onClick={reload}>
                  <ArrowsClockwise data-icon="inline-start" weight="duotone" />
                  {t('settings.sshKnownHostsRetry')}
                </Button>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-1.5 text-center">
                <p className="m-0 text-sm font-medium text-foreground">
                  {t('settings.sshKnownHostsEmpty')}
                </p>
                <p className="m-0 text-xs leading-5 text-muted-foreground">
                  {t('settings.sshKnownHostsEmptyHint')}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0 max-[560px]:flex-col"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <code className="min-w-0 break-all text-xs font-medium text-foreground">
                          {entry.hosts}
                        </code>
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {entry.keyType}
                        </span>
                        {entry.marker ? (
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {entry.marker}
                          </span>
                        ) : null}
                      </div>
                      <code className="mt-1 block break-all text-[10px] text-muted-foreground">
                        {entry.fingerprint}
                      </code>
                      {entry.comment ? (
                        <p className="m-0 mt-1 break-words text-[10px] leading-4 text-muted-foreground">
                          {entry.comment}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1 max-[560px]:w-full">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          setError('');
                          setEditing({ ...entry });
                        }}
                      >
                        <PencilSimple data-icon="inline-start" weight="duotone" />
                        {t('settings.sshKnownHostsEdit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
                        onClick={() => {
                          setDeleteError('');
                          setDeleteTarget(entry);
                        }}
                      >
                        <Trash data-icon="inline-start" weight="duotone" />
                        {t('settings.sshKnownHostsDelete')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="mx-0 mb-0 flex-none rounded-b-xl px-6 py-4">
            {editing ? (
              <>
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setError('');
                    setEditing(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button disabled={saving || !canSave} onClick={() => void save()}>
                  {saving ? <Spinner data-icon="inline-start" /> : null}
                  {t('common.save')}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('common.close')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next && !deleting) {
            setDeleteTarget(null);
            setDeleteError('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.sshKnownHostsDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t('settings.sshKnownHostsDeleteDesc', { hosts: deleteTarget.hosts })
                : null}
              {deleteError ? (
                <span className="mt-2 block text-xs text-destructive" role="alert">
                  {deleteError}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? <Spinner data-icon="inline-start" /> : null}
              {t('settings.sshKnownHostsDeleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function trayMatchToolSet(toolIds: string[] | null | undefined) {
  return new Set((toolIds ?? TRAY_MATCH_DEFAULT_TOOLS) as ToolId[]);
}

export default function SettingsPage({
  settings,
  setSettings,
  setThemeMode: setThemeModeWithTransition,
  clearHistory,
  tools,
  sidebarManaging,
  onToggleSidebarManage,
  flushSettingsSave,
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  setThemeMode: (update: React.SetStateAction<Settings>) => void;
  clearHistory: () => void;
  tools: ToolDefinition[];
  sidebarManaging: boolean;
  onToggleSidebarManage: () => void;
  flushSettingsSave: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [checking, setChecking] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [version, setVersion] = useState('');
  const [sshKnownHostsOpen, setSSHKnownHostsOpen] = useState(false);
  const trayMatchMinHintId = useId();
  useEffect(() => {
    void GetCurrentVersion().then(setVersion);
  }, []);
  const update = (key: BooleanSettingKey, value: boolean) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const checkUpdates = async () => {
    setChecking(true);
    window.dispatchEvent(new CustomEvent('devutils:update-check', { detail: 'checking' }));
    try {
      const available = await CheckForUpdates();
      if (!available) toast.add({ title: t('settings.upToDate'), type: 'success' });
      window.dispatchEvent(
        new CustomEvent('devutils:update-check', {
          detail: available ? 'available' : 'finished',
        }),
      );
    } catch {
      toast.add({
        title: t('settings.updateFailed'),
        description: t('settings.updateFailedDesc'),
        type: 'error',
      });
      window.dispatchEvent(new CustomEvent('devutils:update-check', { detail: 'finished' }));
    } finally {
      setChecking(false);
    }
  };
  const matchableTools = tools.filter((tool) => TRAY_MATCH_DEFAULT_TOOLS.includes(tool.id));
  const toggleTrayTool = (tool: ToolId, value: boolean) =>
    setSettings((current) => {
      const selected = new Set(
        [...trayMatchToolSet(current.trayMatchTools)].filter((id) =>
          TRAY_MATCH_DEFAULT_TOOLS.includes(id),
        ),
      );
      if (value) selected.add(tool);
      else {
        if (selected.size <= 1 && selected.has(tool)) return current;
        selected.delete(tool);
      }
      const trayMatchTools = matchableTools
        .filter((item) => selected.has(item.id))
        .map((item) => item.id);
      if (trayMatchTools.length === 0) return current;
      return { ...current, trayMatchTools };
    });
  const setThemeMode = (value: ThemeMode) =>
    setThemeModeWithTransition((current) => ({ ...current, themeMode: value }));
  const setLanguage = (code: string) => {
    setSettings((current) => ({ ...current, language: code }));
    i18n.changeLanguage(code);
  };
  const quitApp = async () => {
    setQuitting(true);
    try {
      await flushSettingsSave();
    } catch {
      setQuitting(false);
      setConfirmQuit(false);
      return;
    }
    try {
      await Application.Quit();
    } catch {
      toast.add({
        title: t('settings.quitFailed'),
        description: t('settings.quitFailedDesc'),
        type: 'error',
      });
      setQuitting(false);
    }
  };
  const trayTools = new Set(
    [...trayMatchToolSet(settings.trayMatchTools)].filter((id) =>
      TRAY_MATCH_DEFAULT_TOOLS.includes(id),
    ),
  );
  const lastTrayToolLocked = trayTools.size <= 1;
  const defaultTrayTools = matchableTools.filter((tool) =>
    TRAY_MATCH_DEFAULT_TOOLS.includes(tool.id),
  );
  const extraTrayTools = matchableTools.filter(
    (tool) => !TRAY_MATCH_DEFAULT_TOOLS.includes(tool.id),
  );
  const themeModeOptions = THEME_MODE_OPTIONS.map(({ id, labelKey }) => ({
    id,
    label: t(labelKey),
  }));
  const fontSizeOptions = EDITOR_FONT_SIZES.map((size) => ({
    id: size,
    label: `${size}px`,
  }));
  const languageOptions = SUPPORTED_LANGUAGES.map((language) => ({
    id: language.code,
    label: t(language.labelKey),
  }));
  const renderTrayToolSwitch = (tool: ToolDefinition) => {
    const selected = trayTools.has(tool.id);
    const restricted = selected && lastTrayToolLocked;
    return (
      <Setting key={tool.id} label={t(tool.nameKey)}>
        <SettingSwitch
          selected={selected}
          onChange={(value) => toggleTrayTool(tool.id, value)}
          isDisabled={restricted}
          describedBy={restricted ? trayMatchMinHintId : undefined}
        />
      </Setting>
    );
  };

  return (
    <div className="h-full min-h-0">
      <ToolLayout>
        <ToolLayoutHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
        <ToolLayoutScrollableContent>
          <SettingsGroup
            divider={false}
            title={t('settings.appearance')}
            subtitle={t('settings.appearanceSubtitle')}
          >
            <ChoiceGroup
              label={t('settings.themeMode')}
              value={settings.themeMode as ThemeMode}
              options={themeModeOptions}
              onChange={setThemeMode}
            />
          </SettingsGroup>
          <SettingsGroup title={t('settings.workspace')} subtitle={t('settings.workspaceSubtitle')}>
            <Setting
              label={t('settings.adjustSidebar')}
              description={t('settings.adjustSidebarDesc')}
            >
              <Button
                id="sidebar-manage-trigger"
                variant="outline"
                aria-expanded={sidebarManaging}
                aria-controls="app-sidebar"
                onClick={onToggleSidebarManage}
              >
                <SidebarSimple data-icon="inline-start" weight="duotone" />
                {t(sidebarManaging ? 'sidebar.done' : 'settings.adjustSidebar')}
              </Button>
            </Setting>
          </SettingsGroup>
          <SettingsGroup title={t('settings.editor')} subtitle={t('settings.editorSubtitle')}>
            <ChoiceGroup
              label={t('settings.editorFontSize')}
              value={settings.codeEditorFontSize || 16}
              options={fontSizeOptions}
              onChange={(size) =>
                setSettings((current) => ({
                  ...current,
                  codeEditorFontSize: size,
                }))
              }
            />
          </SettingsGroup>
          <SettingsGroup title={t('settings.language')} subtitle={t('settings.languageSubtitle')}>
            <ChoiceGroup
              label={t('settings.language')}
              value={settings.language}
              options={languageOptions}
              onChange={setLanguage}
            />
          </SettingsGroup>
          <SettingsGroup title={t('settings.clipboard')} subtitle={t('settings.clipboardSubtitle')}>
            <div className="flex flex-col gap-3">
              <div className="divide-y divide-border">
                <Setting label={t('settings.trayMatch')} description={t('settings.trayMatchDesc')}>
                  <SettingSwitch
                    selected={settings.trayMatchEnabled}
                    onChange={(value) => update('trayMatchEnabled', value)}
                  />
                </Setting>
                {settings.trayMatchEnabled ? (
                  <Setting
                    label={t('settings.autoOverwrite')}
                    description={t('settings.autoOverwriteDesc')}
                  >
                    <SettingSwitch
                      selected={settings.autoOverwrite}
                      onChange={(value) => update('autoOverwrite', value)}
                    />
                  </Setting>
                ) : null}
              </div>
              {settings.trayMatchEnabled ? (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                  <div className="flex flex-col gap-0.5">
                    <strong className={settingLabelClass}>{t('settings.trayMatchTools')}</strong>
                    <small className={settingHintClass}>{t('settings.trayMatchToolsDesc')}</small>
                  </div>
                  <div>
                    <div className="flex flex-col gap-0.5 pb-2">
                      <strong className={settingLabelClass}>
                        {t('settings.trayMatchToolsDefault')}
                      </strong>
                      <small className={settingHintClass}>
                        {t('settings.trayMatchToolsDefaultDesc')}
                      </small>
                    </div>
                    <div className="grid grid-cols-2 gap-x-5 max-[700px]:grid-cols-1">
                      {defaultTrayTools.map(renderTrayToolSwitch)}
                    </div>
                  </div>
                  {extraTrayTools.length > 0 ? (
                    <div className="border-t border-border pt-3">
                      <div className="flex flex-col gap-0.5 pb-2">
                        <strong className={settingLabelClass}>
                          {t('settings.trayMatchToolsExtra')}
                        </strong>
                        <small className={settingHintClass}>
                          {t('settings.trayMatchToolsExtraDesc')}
                        </small>
                      </div>
                      <div className="grid grid-cols-2 gap-x-5 max-[700px]:grid-cols-1">
                        {extraTrayTools.map(renderTrayToolSwitch)}
                      </div>
                    </div>
                  ) : null}
                  {lastTrayToolLocked ? (
                    <p id={trayMatchMinHintId} className={cn('m-0', settingHintClass)}>
                      {t('settings.trayMatchToolsMin')}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className={cn('m-0 border-t border-border pt-3', settingHintClass)}>
                  {t('settings.trayMatchDisabledHint')}
                </p>
              )}
            </div>
          </SettingsGroup>
          <SettingsGroup title={t('settings.updates')} subtitle={t('settings.updatesSubtitle')}>
            <div className={settingStackClass}>
              <Setting
                label={t('settings.autoCheckUpdates')}
                description={t('settings.autoCheckUpdatesDesc')}
              >
                <SettingSwitch
                  selected={settings.autoCheckUpdates}
                  onChange={(value) => update('autoCheckUpdates', value)}
                />
              </Setting>
              <Setting
                label={t('settings.currentVersion')}
                description={version ? `v${version}` : undefined}
              >
                <Button variant="outline" disabled={checking} onClick={() => void checkUpdates()}>
                  <ArrowsClockwise data-icon="inline-start" weight="duotone" />
                  {t(checking ? 'settings.checkingUpdates' : 'settings.checkUpdates')}
                </Button>
              </Setting>
            </div>
          </SettingsGroup>
          <SettingsGroup title={t('settings.ssh')} subtitle={t('settings.sshSubtitle')}>
            <Setting
              label={t('settings.sshKnownHosts')}
              description={t('settings.sshKnownHostsDesc')}
            >
              <Button variant="outline" onClick={() => setSSHKnownHostsOpen(true)}>
                <Key data-icon="inline-start" weight="duotone" />
                {t('settings.manageSSHKnownHosts')}
              </Button>
            </Setting>
          </SettingsGroup>
          <SettingsGroup title={t('settings.privacy')} subtitle={t('settings.privacySubtitle')}>
            <Setting label={t('settings.history')} description={t('settings.historyDesc')}>
              <Button variant="destructive" onClick={() => setConfirmClear(true)}>
                <Trash data-icon="inline-start" weight="duotone" />
                {t('settings.clearHistory')}
              </Button>
            </Setting>
          </SettingsGroup>
          <SettingsGroup title={t('settings.about')} subtitle={t('settings.aboutSubtitle')}>
            <Setting label={t('settings.projectLink')} description={t('settings.projectLinkDesc')}>
              <Button variant="outline" onClick={() => void Browser.OpenURL(GITHUB_REPO_URL)}>
                <ArrowSquareOut data-icon="inline-start" weight="duotone" />
                {t('settings.openProject')}
              </Button>
            </Setting>
          </SettingsGroup>
          <SettingsGroup
            title={t('settings.application')}
            subtitle={t('settings.applicationSubtitle')}
          >
            <Setting label={t('settings.quit')} description={t('settings.quitDesc')}>
              <Button variant="outline" onClick={() => setConfirmQuit(true)}>
                <Power data-icon="inline-start" weight="duotone" />
                {t('settings.quit')}
              </Button>
            </Setting>
          </SettingsGroup>
        </ToolLayoutScrollableContent>
      </ToolLayout>
      <ClearHistoryDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={clearHistory}
      />
      <SSHKnownHostsDialog open={sshKnownHostsOpen} onOpenChange={setSSHKnownHostsOpen} />
      <AlertDialog
        open={confirmQuit}
        onOpenChange={(open) => {
          if (!open && !quitting) setConfirmQuit(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('quitDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('quitDialog.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={quitting}>{t('quitDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={quitting} onClick={() => void quitApp()}>
              {t('quitDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
