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
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
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
  ArrowCounterClockwise,
  ArrowsClockwise,
  BellRinging,
  Copy,
  DotsThreeOutlineVertical,
  DownloadSimple,
  Key,
  PencilSimple,
  Power,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { Application, Browser } from '@wailsio/runtime';
import { useTranslation } from 'react-i18next';
import i18n, { SUPPORTED_LANGUAGES } from '../i18n';
import type { Config as Settings, SSHKnownHost } from '../../bindings/tinkerkit/models';
import {
  DeleteSSHKnownHost,
  GetSSHKnownHosts,
  ExportConfig,
  ImportConfig,
  IsAutostartEnabled,
  ResetConfig,
  SetAutostart,
  UpdateSSHKnownHost,
} from '../../bindings/tinkerkit/configservice';
import { CheckForUpdates, GetCurrentVersion } from '../../bindings/tinkerkit/updateservice';
import {
  ToolActionButton,
  ToolLayout,
  ToolLayoutContent,
  ToolSearchField,
  type Icon,
  type ToolId,
} from './shared';
import { toast } from './ui/toast';
import { GITHUB_REPO_URL } from '../repositoryUrl';
import { THEME_MODE_OPTIONS, type ThemeMode } from '../theme';
import {
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_MIN,
  applyWindowOpacity,
  clampWindowOpacity,
  hostOS,
  setWindowOpacityPreview,
} from '../app/window-appearance';
import { EDITOR_FONT_SIZES } from '../settings-options';
import { cn } from '@/lib/utils';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';
import { useSSHProfiles } from './SSHProfileManagerDialog';
import { ConfirmDialog } from './ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { ToolOrderList } from '../app/ToolOrderList';
import { resolveSidebarTools } from '../app/navigation';
import { formatBackendError } from '../lib/backend-error';
import { showTaskNotificationPermissionDialog } from '../lib/task-notification-feedback';
import {
  IsAvailable as IsTaskNotificationAvailable,
  RequestAuthorization as RequestTaskNotificationAuthorization,
  Send as SendTaskNotification,
} from '../../bindings/tinkerkit/tasknotificationservice';

// Keep in sync with Go config normalization and the frontend's initial settings.
const TRAY_MATCHABLE_TOOLS: readonly ToolId[] = [
  'json',
  'time',
  'text',
  'base64',
  'diff',
  'jwt',
  'url',
];
const DIFF_CLIPBOARD_TARGET_MODES = ['off', 'alternate', 'before', 'after'] as const;
type DiffClipboardTargetMode = (typeof DIFF_CLIPBOARD_TARGET_MODES)[number];
const TAB_WIDTH_PRESETS = [112, 128, 148, 168, 196] as const;
type TabWidthPreset = (typeof TAB_WIDTH_PRESETS)[number];
const TAB_WIDTH_MODES = ['fixed', 'auto'] as const;
type TabWidthMode = (typeof TAB_WIDTH_MODES)[number];
const settingRowClass = 'flex min-h-8 items-center justify-between gap-5';
const settingLabelClass = 'text-xs leading-[1.4] font-medium text-foreground';
const settingHintClass = 'text-[10px] leading-[1.4] text-muted-foreground';

export type ToolDefinition = {
  id: ToolId;
  nameKey: string;
  descriptionKey: string;
  icon: Icon;
  keywords: string;
};
type BooleanSettingKey = 'trayMatchEnabled' | 'autoCheckUpdates';
type ChoiceOption<T extends string | number> = { id: T; label: string };
type SettingsCategory =
  'preferences' | 'workspace' | 'tools' | 'automation' | 'connections' | 'data' | 'about';

const SETTINGS_CATEGORIES: SettingsCategory[] = [
  'preferences',
  'workspace',
  'tools',
  'automation',
  'connections',
  'data',
  'about',
];

function SettingSwitch({
  selected,
  onChange,
  isDisabled = false,
  ariaLabel,
  id,
  describedBy,
}: {
  selected: boolean;
  onChange: (v: boolean) => void;
  isDisabled?: boolean;
  ariaLabel?: string;
  id?: string;
  describedBy?: string;
}) {
  return (
    <Switch
      id={id}
      checked={selected}
      onCheckedChange={onChange}
      disabled={isDisabled}
      aria-label={ariaLabel}
      size="sm"
      aria-describedby={describedBy}
    />
  );
}

function SettingsGroup({
  title,
  children,
  divider = true,
}: {
  title: string;
  children: React.ReactNode;
  divider?: boolean;
}) {
  return (
    <section
      className={cn(
        'grid grid-cols-[10rem_minmax(0,1fr)] gap-5 py-3.5 max-[700px]:grid-cols-1 max-[700px]:gap-2',
        divider && 'border-t border-border',
      )}
    >
      <div>
        <h2 className="m-0 text-xs leading-[1.25] font-semibold tracking-[.01em] text-foreground">
          {title}
        </h2>
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
  hideLabel = false,
  fill = false,
  isDisabled = false,
}: {
  label: string;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  hideLabel?: boolean;
  fill?: boolean;
  isDisabled?: boolean;
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
        fill && 'w-full flex-col items-stretch gap-2',
        'max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-2',
      )}
    >
      {!hideLabel ? (
        <strong id={labelId} className={cn(settingLabelClass, 'shrink-0')}>
          {label}
        </strong>
      ) : null}
      <div
        role="radiogroup"
        aria-labelledby={hideLabel ? undefined : labelId}
        aria-label={hideLabel ? label : undefined}
        className={cn(
          'flex min-w-0 flex-none flex-wrap items-center gap-0.5 rounded-lg bg-muted/60 p-0.5',
          fill && 'w-full',
        )}
      >
        {options.map((option, index) => {
          const checked = option.id === value;
          return (
            <Button
              key={String(option.id)}
              type="button"
              role="radio"
              variant="ghost"
              size="xs"
              aria-checked={checked}
              tabIndex={checked || (selectedIndex < 0 && index === 0) ? 0 : -1}
              className={cn(
                'min-w-[3.5rem] flex-none text-xs',
                fill && 'flex-1',
                checked
                  ? 'bg-background text-foreground hover:bg-background hover:text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              disabled={isDisabled}
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
  return formatBackendError(error);
}

const SSH_KNOWN_HOST_DEFAULT_PORT = 22;

/**
 * 单一主机（主机名、IP、[host]:port）显示为 host:port，未写端口时按 22；
 * 含逗号、空白、通配符或否定项的匹配项保持原文，不编造端口。
 */
function sshKnownHostAddress(hosts: string) {
  const value = hosts.trim();
  if (!value || /[,\s*?!]/.test(value)) return hosts;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    const [, host, port] = bracketed;
    // IPv6 字面量去掉方括号后无法区分端口，保留原样以防误读。
    const shown = host.includes(':') ? `[${host}]` : host;
    return `${shown}:${port ?? SSH_KNOWN_HOST_DEFAULT_PORT}`;
  }
  const plain = /^([^:]+)(?::([^:]+))?$/.exec(value);
  if (!plain) return hosts;
  const port = plain[2];
  if (port === undefined) return `${plain[1]}:${SSH_KNOWN_HOST_DEFAULT_PORT}`;
  return /^\d+$/.test(port) ? `${plain[1]}:${port}` : hosts;
}

/** 复制成功的 toast 只引用短形式，不把整串 base64 塞进提示。 */
function sshKnownHostFingerprintShort(fingerprint: string) {
  const value = fingerprint.trim();
  const prefix = 'SHA256:';
  if (value.startsWith(prefix)) {
    const hash = value.slice(prefix.length);
    return `${prefix}${hash.length > 12 ? `${hash.slice(0, 12)}…` : hash}`;
  }
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SSHKnownHost | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const hostsID = useId();
  const publicKeyID = useId();
  const commentID = useId();
  const loadRequestRef = useRef(0);
  // 刚打开详情时的可编辑字段。脏检查不比较指纹、类型和标记。
  const editBaselineRef = useRef({ hosts: '', publicKey: '', comment: '' });
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
      setDiscardOpen(false);
      setDeleteTarget(null);
      setDeleteError('');
      setError('');
      setSearchQuery('');
      return;
    }
    reload();
  }, [open, reload]);

  const handleOpenChange = (next: boolean) => {
    if (!next && (saving || deleting)) return;
    if (!next) {
      setEditing(null);
      setDiscardOpen(false);
      setDeleteTarget(null);
      setDeleteError('');
      setError('');
      setSearchQuery('');
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
  const copyFingerprint = async (fingerprint: string) => {
    const short = sshKnownHostFingerprintShort(fingerprint);
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(fingerprint);
    } catch {
      // 失败分支直接返回，避免紧接着再弹一次成功提示。
      toast.add({ title: t('toast.copyFailed'), type: 'error' });
      return;
    }
    toast.add({ title: t('toast.copied', { value: short }) });
  };
  const startKnownHostEdit = (entry: SSHKnownHost) => {
    editBaselineRef.current = {
      hosts: entry.hosts,
      publicKey: entry.publicKey,
      comment: entry.comment ?? '',
    };
    setError('');
    setEditing({ ...entry });
  };
  const knownHostDirty = (entry: SSHKnownHost) => {
    const baseline = editBaselineRef.current;
    return (
      entry.hosts !== baseline.hosts ||
      entry.publicKey !== baseline.publicKey ||
      (entry.comment ?? '') !== baseline.comment
    );
  };
  const requestKnownHostBack = () => {
    if (!editing || saving) return;
    if (knownHostDirty(editing)) {
      setDiscardOpen(true);
      return;
    }
    setError('');
    setEditing(null);
  };
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredEntries = normalizedQuery
    ? entries.filter((entry) => {
        const needles = [
          entry.hosts,
          sshKnownHostAddress(entry.hosts),
          entry.keyType,
          entry.comment,
          entry.fingerprint,
        ];
        return needles.some(
          (value) => value && value.toLowerCase().includes(normalizedQuery),
        );
      })
    : entries;
  const showKnownHostsList = !loading && !error && entries.length > 0;

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
          {showKnownHostsList && !editing ? (
            // 搜索固定在滚动区之外：放在滚动内容里做 sticky 会在 OverlayScrollbars 视口中移位。
            <div className="flex-none px-6 pt-4 pb-3">
              <ToolSearchField
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder={t('sshProfiles.searchPlaceholder')}
                ariaLabel={t('settings.sshKnownHostsSearchLabel')}
              />
            </div>
          ) : null}
          <ScrollArea
            edgeOverlay
            className="min-h-0 flex-1 px-6"
          >
            {editing ? (
              <div className="py-5">
              <form
                className="grid gap-4"
                id="ssh-known-hosts-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSave && !saving) void save();
                }}
              >
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
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {t('settings.sshKnownHostsFingerprint')}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[11px]"
                      aria-label={t('common.copy')}
                      title={t('common.copy')}
                      onClick={() => void copyFingerprint(editing.fingerprint)}
                    >
                      <Copy data-icon="inline-start" weight="regular" />
                      {t('common.copy')}
                    </Button>
                  </div>
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
              </form>
              </div>
            ) : loading ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 py-5 text-center text-sm text-muted-foreground">
                <Spinner className="size-6 text-primary motion-reduce:animate-none" />
                <span>{t('settings.sshKnownHostsLoading')}</span>
              </div>
            ) : error ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-3 py-5 text-center">
                <p className="m-0 text-xs text-destructive" role="alert">
                  {error}
                </p>
                <ToolActionButton
                  variant="secondary"
                  icon={ArrowsClockwise}
                  label={t('settings.sshKnownHostsRetry')}
                  onPress={reload}
                />
              </div>
            ) : entries.length === 0 ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-1.5 py-5 text-center">
                <p className="m-0 text-sm font-medium text-foreground">
                  {t('settings.sshKnownHostsEmpty')}
                </p>
                <p className="m-0 text-xs leading-5 text-muted-foreground">
                  {t('settings.sshKnownHostsEmptyHint')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col pt-1 pb-5">
                {normalizedQuery && filteredEntries.length === 0 ? (
                  <div className="border-y border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                    {t('settings.sshKnownHostsSearchEmpty')}
                  </div>
                ) : (
                  <ul className="m-0 list-none p-0">
                    {filteredEntries.map((entry, index) => {
                      const address = sshKnownHostAddress(entry.hosts);
                      return (
                        <li
                          key={entry.id}
                          className={cn(
                            'flex min-w-0 items-start gap-3 rounded-md px-2 py-2.5 hover:bg-accent max-[560px]:flex-col',
                            index % 2 === 1 && 'bg-muted/30',
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <code className="min-w-0 break-all text-xs font-medium text-foreground">
                                {address}
                              </code>
                              <Badge variant="outline">{entry.keyType}</Badge>
                              {entry.marker ? (
                                <Badge variant="outline">{entry.marker}</Badge>
                              ) : null}
                            </div>
                            <code className="mt-1 block select-text break-all font-mono text-xs text-foreground">
                              {entry.fingerprint}
                            </code>
                            {entry.comment ? (
                              <p className="m-0 mt-1 break-words text-[10px] leading-4 text-muted-foreground">
                                {entry.comment}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1 max-[560px]:w-full max-[560px]:justify-end">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('settings.sshKnownHostsEditTitle')}
                              title={t('settings.sshKnownHostsEditTitle')}
                              onClick={() => startKnownHostEdit(entry)}
                            >
                              <PencilSimple weight="regular" />
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="text-muted-foreground"
                                    aria-label={t('sshProfiles.moreActions')}
                                  />
                                }
                              >
                                <DotsThreeOutlineVertical weight="regular" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-48">
                                <DropdownMenuGroup>
                                  <DropdownMenuItem
                                    onClick={() => void copyFingerprint(entry.fingerprint)}
                                  >
                                    <Copy data-icon="inline-start" weight="regular" />
                                    {t('common.copy')}
                                  </DropdownMenuItem>
                                </DropdownMenuGroup>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => {
                                    setDeleteError('');
                                    setDeleteTarget(entry);
                                  }}
                                >
                                  <Trash data-icon="inline-start" weight="regular" />
                                  {t('settings.sshKnownHostsDelete')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </ScrollArea>
          <DialogFooter className="mx-0 mb-0 flex-none rounded-b-xl px-6 py-4">
            {editing ? (
              <>
                <Button variant="outline" disabled={saving} onClick={requestKnownHostBack}>
                  {t('sshProfiles.back')}
                </Button>
                <Button type="submit" form="ssh-known-hosts-form" disabled={saving || !canSave}>
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
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null);
            setDeleteError('');
          }
        }}
        title={t('settings.sshKnownHostsDeleteTitle')}
        description={
          deleteTarget ? t('settings.sshKnownHostsDeleteDesc', { hosts: deleteTarget.hosts }) : null
        }
        error={deleteError}
        confirmLabel={t('settings.sshKnownHostsDeleteConfirm')}
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(next) => {
          if (!next && !saving) setDiscardOpen(false);
        }}
        title={t('settings.sshKnownHostsDiscardTitle')}
        description={t('settings.sshKnownHostsDiscardDescription')}
        confirmLabel={t('settings.sshKnownHostsDiscardConfirm')}
        destructive
        busy={saving}
        onConfirm={() => {
          setDiscardOpen(false);
          setError('');
          setEditing(null);
        }}
      />
    </>
  );
}

function trayMatchToolSet(toolIds: string[] | null | undefined) {
  return new Set((toolIds ?? TRAY_MATCHABLE_TOOLS) as ToolId[]);
}

function sliderNumber(value: number | readonly number[]): number | null {
  const next = Array.isArray(value) ? value[0] : value;
  return typeof next === 'number' ? next : null;
}

function WindowAppearanceSettings({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
}) {
  const { t } = useTranslation();
  const [opacityPreview, setOpacityPreview] = useState<number | null>(null);
  const savedOpacityRef = useRef(settings.windowOpacity);
  savedOpacityRef.current = settings.windowOpacity;
  useEffect(() => {
    return () => {
      setOpacityPreview(null);
      setWindowOpacityPreview(null);
      applyWindowOpacity(savedOpacityRef.current);
    };
  }, []);
  const opacity = opacityPreview ?? clampWindowOpacity(settings.windowOpacity);
  const previewOpacity = (value: number | readonly number[]) => {
    const next = sliderNumber(value);
    if (next == null) return;
    setOpacityPreview(next);
    setWindowOpacityPreview(next);
    applyWindowOpacity(settings.windowOpacity);
  };
  const commitOpacity = (value: number | readonly number[]) => {
    const next = sliderNumber(value);
    setOpacityPreview(null);
    setWindowOpacityPreview(null);
    if (next == null) return;
    setSettings((current) => ({ ...current, windowOpacity: clampWindowOpacity(next) }));
  };
  return (
    <>
      <Setting label={t('settings.windowOpacity')}>
        <div className="flex w-52 max-w-full items-center gap-3">
          <Slider
            aria-label={t('settings.windowOpacity')}
            className="w-36"
            min={WINDOW_OPACITY_MIN}
            max={WINDOW_OPACITY_MAX}
            step={1}
            value={[opacity]}
            onValueChange={previewOpacity}
            onValueCommitted={commitOpacity}
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {t('settings.windowOpacityValue', { value: opacity })}
          </span>
        </div>
      </Setting>
      <Setting label={t('settings.windowBlur')}>
        <SettingSwitch
          selected={settings.windowBlur !== false}
          onChange={(windowBlur) => setSettings((current) => ({ ...current, windowBlur }))}
        />
      </Setting>
    </>
  );
}

export default function SettingsPage({
  settings,
  setSettings,
  setThemeMode: setThemeModeWithTransition,
  tools,
  toolTabCounts,
  onCloseToolTabs,
  commandRequest,
  onCommandRequestHandled,
  flushSettingsSave,
  onConfigReplaced,
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  setThemeMode: (update: React.SetStateAction<Settings>) => void;
  tools: ToolDefinition[];
  toolTabCounts: Record<string, number>;
  onCloseToolTabs: (id: ToolId) => void;
  commandRequest: { id: number; action: 'quit' } | null;
  onCommandRequestHandled: (id: number) => void;
  flushSettingsSave: () => Promise<void>;
  onConfigReplaced: (config: Settings) => void;
}) {
  const { t } = useTranslation();
  const { openManager } = useSSHProfiles();
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [disableToolId, setDisableToolId] = useState<ToolId | null>(null);
  const [configAction, setConfigAction] = useState<'export' | 'import' | 'reset' | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [testingTaskNotification, setTestingTaskNotification] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const [autostartSaving, setAutostartSaving] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [version, setVersion] = useState('');
  const handledCommandRef = useRef<number | null>(null);
  const [sshKnownHostsOpen, setSSHKnownHostsOpen] = useState(false);
  const trayMatchMinHintId = useId();
  useEffect(() => {
    void GetCurrentVersion().then(setVersion);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void IsAutostartEnabled()
      .then((enabled) => {
        if (!cancelled) setAutostartEnabled(enabled);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.add({
            title: t('settings.autostartReadFailed'),
            description: formatBackendError(error),
            type: 'error',
          });
        }
      })
      .finally(() => {
        if (!cancelled) setAutostartLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);
  const setAutostart = async (enabled: boolean) => {
    setAutostartSaving(true);
    try {
      await SetAutostart(enabled);
      setAutostartEnabled(enabled);
    } catch (error) {
      toast.add({
        title: t('settings.autostartUpdateFailed'),
        description: formatBackendError(error),
        type: 'error',
      });
    } finally {
      setAutostartSaving(false);
    }
  };
  const update = (key: BooleanSettingKey, value: boolean) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const setToolEnabled = (id: ToolId, enabled: boolean) =>
    setSettings((current) => ({
      ...current,
      sidebarTools: resolveSidebarTools(current.sidebarTools).map((item) =>
        item.id === id ? { ...item, enabled } : item,
      ),
    }));
  const requestDisableTool = (id: ToolId) => {
    if ((toolTabCounts[id] ?? 0) === 0) {
      setToolEnabled(id, false);
      return;
    }
    setDisableToolId(id);
  };
  const checkUpdates = async () => {
    setChecking(true);
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
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (!commandRequest || handledCommandRef.current === commandRequest.id) return;
    handledCommandRef.current = commandRequest.id;
    setConfirmQuit(true);
    onCommandRequestHandled(commandRequest.id);
  }, [commandRequest, onCommandRequestHandled]);
  const sendTestTaskNotification = async () => {
    setTestingTaskNotification(true);
    try {
      if (!(await IsTaskNotificationAvailable())) {
        showTaskNotificationPermissionDialog();
        return;
      }
      if (!(await RequestTaskNotificationAuthorization())) {
        showTaskNotificationPermissionDialog();
        return;
      }
      await SendTaskNotification(
        `task-notification-test-${Date.now()}`,
        t('settings.taskNotificationTestTitle'),
        t('settings.taskNotificationTestBody'),
      );
      toast.add({ title: t('settings.taskNotificationTestSent'), type: 'success' });
    } catch {
      showTaskNotificationPermissionDialog();
    } finally {
      setTestingTaskNotification(false);
    }
  };
  const matchableTools = tools.filter((tool) => TRAY_MATCHABLE_TOOLS.includes(tool.id));
  const toggleTrayTool = (tool: ToolId, value: boolean) =>
    setSettings((current) => {
      const selected = new Set(
        [...trayMatchToolSet(current.trayMatchTools)].filter((id) =>
          TRAY_MATCHABLE_TOOLS.includes(id),
        ),
      );
      const disabledSidebarTools = new Set(
        (current.sidebarTools ?? []).filter((item) => !item.enabled).map((item) => item.id),
      );
      if (disabledSidebarTools.has(tool)) return current;
      if (value) selected.add(tool);
      else {
        const enabledSelected = [...selected].filter((id) => !disabledSidebarTools.has(id));
        if (enabledSelected.length <= 1 && enabledSelected.includes(tool)) return current;
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
  const runConfigAction = async () => {
    if (!configAction || configBusy) return;
    const action = configAction;
    setConfigBusy(true);
    try {
      if (action === 'export') {
        const path = await ExportConfig();
        if (path) toast.add({ title: t('settings.configExported'), type: 'success' });
      } else {
        const config = action === 'import' ? await ImportConfig() : await ResetConfig();
        if (config) {
          onConfigReplaced(config);
          window.dispatchEvent(new Event('tinkerkit:config-replaced'));
          toast.add({
            title: t(action === 'import' ? 'settings.configImported' : 'settings.configReset'),
            type: 'success',
          });
        }
      }
      setConfigAction(null);
    } catch (error) {
      toast.add({
        title: t(`settings.config${action[0].toUpperCase()}${action.slice(1)}Failed`),
        description: formatBackendError(error),
        type: 'error',
      });
      setConfigAction(null);
    } finally {
      setConfigBusy(false);
    }
  };
  const trayTools = new Set(
    [...trayMatchToolSet(settings.trayMatchTools)].filter((id) =>
      TRAY_MATCHABLE_TOOLS.includes(id),
    ),
  );
  const disabledSidebarToolIds = new Set(
    (settings.sidebarTools ?? []).filter((tool) => !tool.enabled).map((tool) => tool.id),
  );
  const enabledTrayTools = new Set([...trayTools].filter((id) => !disabledSidebarToolIds.has(id)));
  const lastTrayToolLocked = enabledTrayTools.size <= 1;
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
  const diffTargetMode = DIFF_CLIPBOARD_TARGET_MODES.includes(
    settings.diffClipboardTargetMode as DiffClipboardTargetMode,
  )
    ? (settings.diffClipboardTargetMode as DiffClipboardTargetMode)
    : 'alternate';
  const tabWidthMode: TabWidthMode = settings.tabWidthMode === 'auto' ? 'auto' : 'fixed';
  const tabWidthPreset = (TAB_WIDTH_PRESETS as readonly number[]).includes(settings.tabWidth)
    ? (settings.tabWidth as TabWidthPreset)
    : 128;
  const tabWidthOptions = TAB_WIDTH_PRESETS.map((size) => ({
    id: size,
    label: `${size}px`,
  }));
  const diffTargetOptions = DIFF_CLIPBOARD_TARGET_MODES.map((value) => ({
    value,
    label: t(`diffTool.targets.${value}`),
  }));
  const categoryOptions = SETTINGS_CATEGORIES.map((id) => ({
    id,
    label: t(`settings.categories.${id}.title`),
  }));
  const [category, setCategory] = useState<SettingsCategory>('preferences');
  const renderTrayToolSwitch = (tool: ToolDefinition) => {
    const selected = trayTools.has(tool.id);
    const sidebarDisabled = disabledSidebarToolIds.has(tool.id);
    const restricted = selected && !sidebarDisabled && lastTrayToolLocked;
    if (tool.id === 'diff') {
      const changeDiffTarget = (value: string | null) => {
        if (!value || !DIFF_CLIPBOARD_TARGET_MODES.includes(value as DiffClipboardTargetMode))
          return;
        const mode = value as DiffClipboardTargetMode;
        setSettings((current) => {
          const selectedTools = new Set(trayMatchToolSet(current.trayMatchTools));
          const disabledTools = new Set(
            (current.sidebarTools ?? []).filter((item) => !item.enabled).map((item) => item.id),
          );
          if (disabledTools.has('diff')) return current;
          const enabledSelected = [...selectedTools].filter((id) => !disabledTools.has(id));
          if (mode === 'off' && enabledSelected.length <= 1 && selectedTools.has('diff'))
            return current;
          if (mode === 'off') selectedTools.delete('diff');
          else selectedTools.add('diff');
          const trayMatchTools = matchableTools
            .filter((item) => selectedTools.has(item.id))
            .map((item) => item.id);
          if (trayMatchTools.length === 0) return current;
          return { ...current, diffClipboardTargetMode: mode, trayMatchTools };
        });
      };
      return (
        <Setting
          key={tool.id}
          label={t(tool.nameKey)}
          description={sidebarDisabled ? t('settings.trayMatchToolSidebarDisabled') : undefined}
        >
          <Select value={diffTargetMode} items={diffTargetOptions} onValueChange={changeDiffTarget}>
            <SelectTrigger
              className="w-44 max-w-full"
              aria-label={t('diffTool.clipboardTarget')}
              disabled={sidebarDisabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {diffTargetOptions.map(({ value, label }) => (
                  <SelectItem
                    key={value}
                    value={value}
                    disabled={value === 'off' && lastTrayToolLocked && selected}
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Setting>
      );
    }
    return (
      <Setting
        key={tool.id}
        label={t(tool.nameKey)}
        description={sidebarDisabled ? t('settings.trayMatchToolSidebarDisabled') : undefined}
      >
        <SettingSwitch
          selected={selected}
          onChange={(value) => toggleTrayTool(tool.id, value)}
          isDisabled={restricted || sidebarDisabled}
          describedBy={restricted ? trayMatchMinHintId : undefined}
        />
      </Setting>
    );
  };

  const renderCategoryPanel = (activeCategory: SettingsCategory) => {
    const categoryContent = (() => {
      switch (activeCategory) {
        case 'preferences':
          return (
            <>
              <SettingsGroup divider={false} title={t('settings.appearance')}>
                <div className="flex flex-col gap-3">
                  <ChoiceGroup
                    label={t('settings.themeMode')}
                    value={settings.themeMode as ThemeMode}
                    options={themeModeOptions}
                    onChange={setThemeMode}
                  />
                  {hostOS === 'darwin' ? (
                    <WindowAppearanceSettings settings={settings} setSettings={setSettings} />
                  ) : null}
                  <ChoiceGroup
                    label={t('settings.language')}
                    value={settings.language}
                    options={languageOptions}
                    onChange={setLanguage}
                  />
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
                </div>
              </SettingsGroup>
            </>
          );
        case 'workspace':
          return (
            <>
              <SettingsGroup divider={false} title={t('settings.tabs')}>
                <div className="flex flex-col gap-3">
                  <ChoiceGroup
                    label={t('settings.tabCloseActivation')}
                    value={
                      settings.tabCloseActivation === 'previous' ||
                      settings.tabCloseActivation === 'next'
                        ? settings.tabCloseActivation
                        : 'recent'
                    }
                    options={[
                      { id: 'previous', label: t('settings.tabCloseActivationPrevious') },
                      { id: 'next', label: t('settings.tabCloseActivationNext') },
                      { id: 'recent', label: t('settings.tabCloseActivationRecent') },
                    ]}
                    onChange={(tabCloseActivation) =>
                      setSettings((current) => ({ ...current, tabCloseActivation }))
                    }
                  />
                  <ChoiceGroup
                    label={t('settings.tabCloseButton')}
                    value={
                      settings.tabCloseButton === 'hover' || settings.tabCloseButton === 'never'
                        ? settings.tabCloseButton
                        : 'always'
                    }
                    options={[
                      { id: 'always', label: t('settings.tabCloseButtonAlways') },
                      { id: 'hover', label: t('settings.tabCloseButtonHover') },
                      { id: 'never', label: t('settings.tabCloseButtonNever') },
                    ]}
                    onChange={(tabCloseButton) =>
                      setSettings((current) => ({ ...current, tabCloseButton }))
                    }
                  />
                  <Setting label={t('settings.showTabIcons')}>
                    <SettingSwitch
                      selected={settings.showTabIcons === true}
                      onChange={(showTabIcons) =>
                        setSettings((current) => ({ ...current, showTabIcons }))
                      }
                    />
                  </Setting>
                  <ChoiceGroup
                    label={t('settings.tabWidthMode')}
                    value={tabWidthMode}
                    options={[
                      { id: 'fixed', label: t('settings.tabWidthModeFixed') },
                      { id: 'auto', label: t('settings.tabWidthModeAuto') },
                    ]}
                    onChange={(mode) =>
                      setSettings((current) => ({ ...current, tabWidthMode: mode }))
                    }
                  />
                  <div className="flex flex-col gap-0.5">
                    <ChoiceGroup
                      label={t('settings.tabWidth')}
                      value={tabWidthPreset}
                      options={tabWidthOptions}
                      isDisabled={tabWidthMode === 'auto'}
                      onChange={(tabWidth) => setSettings((current) => ({ ...current, tabWidth }))}
                    />
                    <p className={cn('m-0', settingHintClass)}>
                      {t('settings.tabWidthWithIconsHint')}
                    </p>
                  </div>
                </div>
              </SettingsGroup>
            </>
          );
        case 'tools':
          return (
            <>
              <SettingsGroup divider={false} title={t('settings.sidebarTools')}>
                <ToolOrderList
                  sidebarTools={resolveSidebarTools(settings.sidebarTools)}
                  tools={tools}
                  onChange={(sidebarTools) =>
                    setSettings((current) => ({ ...current, sidebarTools }))
                  }
                  onRequestDisable={requestDisableTool}
                />
              </SettingsGroup>
            </>
          );
        case 'automation':
          return (
            <>
              <SettingsGroup divider={false} title={t('settings.automation')}>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-3">
                    <Setting
                      label={t('settings.trayRecognition')}
                      description={t('settings.trayRecognitionEnabledDesc')}
                    >
                      <SettingSwitch
                        selected={settings.trayMatchEnabled}
                        onChange={(value) => update('trayMatchEnabled', value)}
                      />
                    </Setting>
                    <Setting label={t('settings.autostart')}>
                      <SettingSwitch
                        selected={autostartEnabled}
                        onChange={(enabled) => void setAutostart(enabled)}
                        isDisabled={autostartLoading || autostartSaving}
                      />
                    </Setting>
                  </div>
                  {settings.trayMatchEnabled ? (
                    <div className="flex flex-col gap-3 border-t border-border pt-3">
                      <strong className={settingLabelClass}>{t('settings.matchableTools')}</strong>
                      <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 max-[700px]:grid-cols-1">
                        {matchableTools.map(renderTrayToolSwitch)}
                      </div>
                      {lastTrayToolLocked ? (
                        <p id={trayMatchMinHintId} className={cn('m-0', settingHintClass)}>
                          {t('settings.matchableToolsMin')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsGroup>
              <SettingsGroup title={t('settings.taskNotifications')}>
                <div className="flex flex-col gap-3">
                  <ChoiceGroup
                    fill
                    label={t('settings.notificationTiming')}
                    value={settings.taskNotificationMode ?? 'unfocused'}
                    options={(['off', 'always', 'unfocused'] as const).map((id) => ({
                      id,
                      label: t(`settings.taskNotificationMode.${id}`),
                    }))}
                    onChange={(taskNotificationMode) =>
                      setSettings((current) => ({ ...current, taskNotificationMode }))
                    }
                  />
                  <div className="flex items-center justify-between gap-5 pt-3 max-[700px]:flex-col max-[700px]:items-start">
                    <strong className={settingLabelClass}>{t('settings.testNotifications')}</strong>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={testingTaskNotification}
                      onClick={() => void sendTestTaskNotification()}
                    >
                      {testingTaskNotification ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <BellRinging data-icon="inline-start" weight="regular" />
                      )}
                      {t(
                        testingTaskNotification
                          ? 'settings.taskNotificationTesting'
                          : 'settings.testTaskNotification',
                      )}
                    </Button>
                  </div>
                </div>
              </SettingsGroup>
            </>
          );
        case 'connections':
          return (
            <SettingsGroup divider={false} title={t('settings.ssh')}>
              <div className="flex flex-col gap-3">
                <Setting label={t('settings.sshProfiles')}>
                  <Button variant="outline" onClick={() => openManager()}>
                    <Key data-icon="inline-start" weight="regular" />
                    {t('settings.manageSSHProfiles')}
                  </Button>
                </Setting>
                <Setting
                  label={t('settings.sshKnownHosts')}
                  description={t('settings.sshKnownHostsDesc')}
                >
                  <Button variant="outline" onClick={() => setSSHKnownHostsOpen(true)}>
                    <Key data-icon="inline-start" weight="regular" />
                    {t('settings.manageSSHKnownHosts')}
                  </Button>
                </Setting>
              </div>
            </SettingsGroup>
          );
        case 'data':
          return (
            <>
              <SettingsGroup divider={false} title={t('settings.configManagement')}>
                <div className="flex flex-col gap-3">
                  <Setting label={t('settings.exportConfig')}>
                    <Button variant="outline" onClick={() => setConfigAction('export')}>
                      <DownloadSimple data-icon="inline-start" weight="regular" />
                      {t('settings.exportConfigAction')}
                    </Button>
                  </Setting>
                  <Setting label={t('settings.importConfig')}>
                    <Button variant="outline" onClick={() => setConfigAction('import')}>
                      <UploadSimple data-icon="inline-start" weight="regular" />
                      {t('settings.importConfigAction')}
                    </Button>
                  </Setting>
                  <Setting
                    label={t('settings.resetConfig')}
                    description={t('settings.resetConfigDesc')}
                  >
                    <Button variant="destructive" onClick={() => setConfigAction('reset')}>
                      <ArrowCounterClockwise data-icon="inline-start" weight="regular" />
                      {t('settings.resetConfigAction')}
                    </Button>
                  </Setting>
                </div>
              </SettingsGroup>
            </>
          );
        case 'about':
          return (
            <>
              <SettingsGroup divider={false} title={t('settings.updates')}>
                <div className="flex flex-col gap-3">
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
                    <Button
                      variant="outline"
                      disabled={checking}
                      onClick={() => void checkUpdates()}
                    >
                      <ArrowsClockwise data-icon="inline-start" weight="regular" />
                      {t(checking ? 'settings.checkingUpdates' : 'settings.checkUpdates')}
                    </Button>
                  </Setting>
                </div>
              </SettingsGroup>
              <SettingsGroup title={t('settings.application')}>
                <div className="flex flex-col gap-3">
                  <Setting label={t('settings.projectLink')}>
                    <Button variant="outline" onClick={() => void Browser.OpenURL(GITHUB_REPO_URL)}>
                      <ArrowSquareOut data-icon="inline-start" weight="regular" />
                      {t('settings.openProject')}
                    </Button>
                  </Setting>
                  <Setting label={t('settings.quit')}>
                    <Button variant="outline" onClick={() => setConfirmQuit(true)}>
                      <Power data-icon="inline-start" weight="regular" />
                      {t('settings.quitAction')}
                    </Button>
                  </Setting>
                </div>
              </SettingsGroup>
            </>
          );
      }
    })();
    return (
      <TabsContent value={activeCategory} className="h-full min-h-0 min-w-0">
        <ScrollArea
          className="h-full min-h-0 min-w-0 [padding-inline-end:var(--overlay-scrollbar-size)]"
          options={{ overflow: { x: 'hidden' } }}
        >
          <div className="min-w-0 max-w-[820px] px-1 pb-4">
            <div className="max-[700px]:border-b max-[700px]:border-border max-[700px]:pb-3 min-[701px]:sr-only">
              <h2 className="m-0 text-sm font-semibold text-foreground">
                {t(`settings.categories.${activeCategory}.title`)}
              </h2>
            </div>
            {categoryContent}
          </div>
        </ScrollArea>
      </TabsContent>
    );
  };

  return (
    <div className="h-full min-h-0">
      <ToolLayout>
        <ToolLayoutContent className="px-0">
          <Tabs
            orientation="vertical"
            value={category}
            onValueChange={(value) => setCategory(value as SettingsCategory)}
            className="grid h-full min-h-0 min-w-0 grid-cols-[180px_minmax(0,1fr)] gap-6 max-[700px]:block"
          >
            <TabsList className="hidden w-full min-[701px]:flex">
              {categoryOptions.map((option) => (
                <TabsTrigger
                  key={option.id}
                  value={option.id}
                  className="h-8 justify-start px-2.5 text-xs"
                >
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="flex h-full min-h-0 min-w-0 flex-col">
              <div className="mb-3 min-[701px]:hidden">
                <Select
                  value={category}
                  onValueChange={(value) => value && setCategory(value as SettingsCategory)}
                  items={categoryOptions.map(({ id, label }) => ({ value: id, label }))}
                >
                  <SelectTrigger
                    id="settings-category"
                    className="w-full"
                    aria-label={t('settings.categorySelector')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {categoryOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-h-0 min-w-0 flex-1">{renderCategoryPanel(category)}</div>
            </div>
          </Tabs>
        </ToolLayoutContent>
      </ToolLayout>
      <SSHKnownHostsDialog open={sshKnownHostsOpen} onOpenChange={setSSHKnownHostsOpen} />
      <ConfirmDialog
        open={configAction !== null}
        onOpenChange={(open) => !configBusy && !open && setConfigAction(null)}
        title={t(
          configAction === 'export'
            ? 'settings.exportConfigTitle'
            : configAction === 'import'
              ? 'settings.importConfigTitle'
              : 'settings.resetConfigTitle',
        )}
        description={t(
          configAction === 'export'
            ? 'settings.exportConfigWarning'
            : configAction === 'import'
              ? 'settings.importConfigWarning'
              : 'settings.resetConfigWarning',
        )}
        confirmLabel={t(
          configAction === 'export'
            ? 'settings.exportConfig'
            : configAction === 'import'
              ? 'settings.importConfig'
              : 'settings.resetConfig',
        )}
        destructive={configAction === 'reset'}
        busy={configBusy}
        onConfirm={() => void runConfigAction()}
      />
      <ConfirmDialog
        open={disableToolId !== null}
        onOpenChange={(open) => {
          if (!open) setDisableToolId(null);
        }}
        title={t('settings.disableToolTitle', {
          name: disableToolId ? t(`tools.${disableToolId}.name`) : '',
        })}
        description={t('settings.disableToolDescription', {
          name: disableToolId ? t(`tools.${disableToolId}.name`) : '',
          total: disableToolId ? (toolTabCounts[disableToolId] ?? 0) : 0,
        })}
        confirmLabel={t('settings.disableToolConfirm')}
        destructive
        onConfirm={() => {
          if (!disableToolId) return;
          onCloseToolTabs(disableToolId);
          setToolEnabled(disableToolId, false);
          setDisableToolId(null);
        }}
      />
      <ConfirmDialog
        open={confirmQuit}
        onOpenChange={(open) => {
          if (!open) setConfirmQuit(false);
        }}
        title={t('quitDialog.title')}
        description={t('quitDialog.body')}
        confirmLabel={t('quitDialog.confirm')}
        cancelLabel={t('quitDialog.cancel')}
        busy={quitting}
        onConfirm={() => void quitApp()}
      />
    </div>
  );
}
