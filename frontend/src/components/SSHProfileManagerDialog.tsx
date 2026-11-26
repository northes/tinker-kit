import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  CheckCircle,
  DotsThreeOutlineVertical,
  DownloadSimple,
  Eye,
  EyeClosed,
  PencilSimple,
  Plus,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import type { SSHProfile } from '../../bindings/tinkerkit/models';
import {
  DeleteSSHProfile,
  GetSSHProfiles,
  ImportSSHProfilesFromLocal,
  SaveSSHProfile,
  TestSSHProfile,
} from '../../bindings/tinkerkit/sshprofileservice';
import { ConfirmDialog } from './ConfirmDialog';
import { ToolSearchField } from './shared';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';
import { Label } from './ui/label';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';
import { toast } from './ui/toast';
import { backendErrorKey, formatBackendError } from '../lib/backend-error';
import { cn } from '@/lib/utils';

type SSHProfileContextValue = {
  profiles: SSHProfile[];
  reload: () => Promise<SSHProfile[]>;
  openManager: (selectedProfileID?: string) => void;
};

const SSHProfileContext = createContext<SSHProfileContextValue | null>(null);

export const emptyProfile: SSHProfile = {
  id: '',
  name: '',
  origin: 'manual',
  originAlias: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  privateKey: '',
  privateKeyPath: '',
  keyPassphrase: '',
  jumpProfileID: '',
  originUpdatedAt: '',
};

function profileAddress(profile: SSHProfile) {
  const host = profile.host || profile.originAlias;
  return `${profile.username ? `${profile.username}@` : ''}${host}:${profile.port || 22}`;
}

// profileJumpCandidates 排除配置自身和所有经它转发的配置：后者当跳板机会形成环路。
function profileJumpCandidates(profiles: SSHProfile[], profileID: string) {
  if (!profileID) return profiles;
  const blocked = new Set<string>([profileID]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const profile of profiles) {
      if (profile.id && profile.jumpProfileID && blocked.has(profile.jumpProfileID)) {
        if (!blocked.has(profile.id)) {
          blocked.add(profile.id);
          expanded = true;
        }
      }
    }
  }
  return profiles.filter((profile) => !blocked.has(profile.id));
}

function errorMessage(error: unknown) {
  return formatBackendError(error);
}

// 密码类输入：右侧按钮切换明文显示，开启时保留焦点与已输入内容。
function PasswordInput({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          variant="ghost"
          disabled={disabled}
          aria-pressed={visible}
          aria-label={t(visible ? 'sshProfiles.hidePassword' : 'sshProfiles.showPassword')}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeClosed /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function useSSHProfiles() {
  const value = useContext(SSHProfileContext);
  if (!value) throw new Error('useSSHProfiles must be used inside SSHProfileProvider');
  return value;
}

export function SSHProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<SSHProfile[]>([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [selectedProfileID, setSelectedProfileID] = useState('');

  const reload = useCallback(async () => {
    const next = (await GetSSHProfiles()) ?? [];
    setProfiles(next);
    return next;
  }, []);

  useEffect(() => {
    void reload().catch(() => setProfiles([]));
  }, [reload]);

  useEffect(() => {
    const refresh = () => void reload().catch(() => setProfiles([]));
    window.addEventListener('tinkerkit:config-replaced', refresh);
    return () => window.removeEventListener('tinkerkit:config-replaced', refresh);
  }, [reload]);

  const openManager = useCallback((profileID = '') => {
    setSelectedProfileID(profileID);
    setManagerOpen(true);
  }, []);

  return (
    <SSHProfileContext.Provider value={{ profiles, reload, openManager }}>
      {children}
      <SSHProfileManagerDialog
        open={managerOpen}
        selectedProfileID={selectedProfileID}
        profiles={profiles}
        onProfilesChange={setProfiles}
        onOpenChange={setManagerOpen}
      />
    </SSHProfileContext.Provider>
  );
}

function SSHProfileManagerDialog({
  open,
  selectedProfileID,
  profiles,
  onProfilesChange,
  onOpenChange,
}: {
  open: boolean;
  selectedProfileID: string;
  profiles: SSHProfile[];
  onProfilesChange: (profiles: SSHProfile[]) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'list' | 'form'>('list');
  const [draft, setDraft] = useState<SSHProfile>(emptyProfile);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [formError, setFormError] = useState('');
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [testingID, setTestingID] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SSHProfile | null>(null);
  const [listReady, setListReady] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [discardAction, setDiscardAction] = useState<'close' | 'back' | null>(null);
  const formBaselineRef = useRef<SSHProfile>({ ...emptyProfile });
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const selectedProfileRef = useRef<HTMLDivElement | null>(null);
  const centeredSelectionRef = useRef(false);
  const jumpCandidates = profileJumpCandidates(profiles, draft.id);
  const jumpMissing =
    Boolean(draft.jumpProfileID) &&
    !jumpCandidates.some((profile) => profile.id === draft.jumpProfileID);
  const jumpOptions = [
    { value: '', label: t('sshProfiles.jumpNone') },
    ...jumpCandidates.map((profile) => ({ value: profile.id, label: profile.name })),
    ...(jumpMissing ? [{ value: draft.jumpProfileID, label: t('sshProfiles.jumpMissing') }] : []),
  ];
  const jumpLabel = (profile: SSHProfile) => {
    if (!profile.jumpProfileID) return '';
    const name = profiles.find((item) => item.id === profile.jumpProfileID)?.name;
    return name ? t('sshProfiles.jumpVia', { name }) : t('sshProfiles.jumpMissing');
  };
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = (profile: SSHProfile) =>
    !normalizedQuery ||
    [
      profile.name,
      profile.originAlias,
      profile.host,
      profile.username,
      profileAddress(profile),
      jumpLabel(profile),
    ]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  const filteredProfiles = profiles.filter(matchesQuery);

  useEffect(() => {
    if (!open) {
      setListReady(false);
      return;
    }
    centeredSelectionRef.current = false;
    // 本机候选列表已去掉，打开时列表就是已保存配置，选中行可以立刻居中。
    setListReady(true);
    setView('list');
    setDraft(emptyProfile);
    formBaselineRef.current = { ...emptyProfile };
    setFormError('');
    setListError('');
    setSearchQuery('');
    setDiscardAction(null);
  }, [open]);

  useEffect(() => {
    if (
      !open ||
      !listReady ||
      !viewport ||
      view !== 'list' ||
      centeredSelectionRef.current ||
      !selectedProfileRef.current
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const selected = selectedProfileRef.current;
      if (!selected) return;
      const row = selected.getBoundingClientRect();
      const area = viewport.getBoundingClientRect();
      viewport.scrollTo({
        top: viewport.scrollTop + row.top - area.top - (viewport.clientHeight - row.height) / 2,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
      centeredSelectionRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, listReady, viewport, view, profiles, selectedProfileID]);

  const refreshProfiles = async () => {
    setLoading(true);
    setListError('');
    try {
      onProfilesChange((await GetSSHProfiles()) ?? []);
    } catch (reason) {
      setListError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  const importFromLocal = async () => {
    setBusy(true);
    setListError('');
    try {
      const result = await ImportSSHProfilesFromLocal();
      onProfilesChange(result.profiles ?? []);
      toast.add({
        title: t('sshProfiles.bulkImportSucceeded', {
          created: result.created,
          updated: result.updated,
        }),
        type: 'success',
      });
    } catch (reason) {
      if (backendErrorKey(reason) === 'errors.sshProfile.nothingToImport') {
        toast.add({ title: t('errors.sshProfile.nothingToImport'), type: 'error' });
      } else {
        setListError(errorMessage(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const startNew = () => {
    setDraft({ ...emptyProfile });
    formBaselineRef.current = { ...emptyProfile };
    setAuthMode('password');
    setFormError('');
    setView('form');
  };

  const startEdit = (profile: SSHProfile) => {
    setDraft({ ...profile });
    formBaselineRef.current = { ...profile };
    setAuthMode(
      profile.privateKey || profile.privateKeyPath || profile.keyPassphrase ? 'key' : 'password',
    );
    setFormError('');
    setView('form');
  };

  const formDirty =
    view === 'form' && JSON.stringify(draft) !== JSON.stringify(formBaselineRef.current);

  const requestBack = () => {
    if (formDirty && !busy) {
      setDiscardAction('back');
      return;
    }
    setView('list');
    setFormError('');
  };

  const requestClose = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    if (busy || testingID) return;
    if (formDirty) {
      setDiscardAction('close');
      return;
    }
    onOpenChange(false);
  };

  const save = async () => {
    setBusy(true);
    setFormError('');
    try {
      // 认证方式二选一：保存时清掉未选方式留下的旧字段，避免残留数据触发另一种认证。
      const payload: SSHProfile = { ...draft, port: Number(draft.port) || 22 };
      if (authMode === 'password') {
        payload.privateKey = '';
        payload.privateKeyPath = '';
        payload.keyPassphrase = '';
      } else {
        payload.password = '';
      }
      const saved = await SaveSSHProfile(payload);
      onProfilesChange(
        profiles.some((item) => item.id === saved.id)
          ? profiles.map((item) => (item.id === saved.id ? saved : item))
          : [...profiles, saved],
      );
      setDraft(saved);
      formBaselineRef.current = { ...saved };
      setView('list');
    } catch (reason) {
      setFormError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const test = async (profile: SSHProfile) => {
    setTestingID(profile.id || 'draft');
    setListError('');
    setFormError('');
    try {
      await TestSSHProfile(profile);
      toast.add({ title: t('sshProfiles.connectionSucceeded'), type: 'success' });
    } catch (reason) {
      const message = errorMessage(reason);
      if (view === 'form') setFormError(message);
      else setListError(message);
      toast.add({ title: t('sshProfiles.connectionFailed'), description: message, type: 'error' });
    } finally {
      setTestingID('');
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setListError('');
    try {
      await DeleteSSHProfile(deleteTarget.id);
      onProfilesChange(profiles.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      toast.add({ title: t('sshProfiles.deleteSucceeded'), type: 'success' });
    } catch (reason) {
      setListError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const setField = <K extends keyof SSHProfile>(key: K, value: SSHProfile[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="flex h-[min(760px,calc(100dvh-32px))] max-h-[min(760px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <DialogHeader className="flex-none border-b border-border px-6 py-5">
            <DialogTitle className="text-base">
              {view === 'list'
                ? t('sshProfiles.title')
                : draft.id
                  ? t('sshProfiles.editTitle')
                  : t('sshProfiles.newTitle')}
            </DialogTitle>
          </DialogHeader>
          {listError && view === 'list' ? (
            <div
              className="mx-6 mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <WarningCircle weight="regular" className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{listError}</span>
            </div>
          ) : null}
          {view === 'list' ? (
            // 搜索固定在滚动区之外：放在滚动内容里做 sticky 会在 OverlayScrollbars 视口中移位。
            <div className="flex-none px-6 pt-4 pb-3">
              <ToolSearchField
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder={t('sshProfiles.searchPlaceholder')}
                ariaLabel={t('sshProfiles.searchLabel')}
              />
            </div>
          ) : null}
          <ScrollArea
            className="min-h-0 flex-1 px-6"
            edgeOverlay
            onViewport={setViewport}
          >
            {view === 'list' ? (
              <div className="flex flex-col pt-1 pb-5">
                <section className="flex flex-col">
                  <div className="flex items-center justify-end gap-1 pb-3">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void refreshProfiles()}
                      disabled={loading || busy}
                      aria-label={t('sshProfiles.refresh')}
                    >
                      <ArrowClockwise
                        weight="regular"
                        className={loading ? 'animate-spin motion-reduce:animate-none' : ''}
                      />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void importFromLocal()}
                      disabled={busy || loading}
                    >
                      <DownloadSimple data-icon="inline-start" weight="regular" />
                      {t('sshProfiles.importFromLocal')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={startNew} disabled={busy}>
                      <Plus data-icon="inline-start" weight="regular" />
                      {t('sshProfiles.add')}
                    </Button>
                  </div>
                  {filteredProfiles.length ? (
                    <div>
                      {filteredProfiles.map((profile, index) => (
                        <div
                          key={profile.id}
                          ref={profile.id === selectedProfileID ? selectedProfileRef : undefined}
                          aria-current={profile.id === selectedProfileID ? 'true' : undefined}
                          className={cn(
                            'flex min-w-0 items-center gap-2 rounded-md px-3 py-2.5 hover:bg-accent',
                            index % 2 === 1 && 'bg-muted/30',
                            profile.id === selectedProfileID &&
                              'bg-primary/20 hover:bg-primary/20',
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-xs font-medium text-foreground">
                                {profile.name}
                              </span>
                              {testingID === profile.id ? (
                                <Spinner
                                  aria-label={t('sshProfiles.test')}
                                  className="motion-reduce:animate-none"
                                />
                              ) : null}
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                              <span className="truncate font-mono">
                                {profileAddress(profile)}
                              </span>
                              {profile.origin === 'ssh-config' && profile.originAlias ? (
                                <span className="truncate">{profile.originAlias}</span>
                              ) : null}
                              {profile.jumpProfileID ? (
                                <span className="truncate">{jumpLabel(profile)}</span>
                              ) : null}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => startEdit(profile)}
                            disabled={busy || testingID === profile.id}
                            aria-label={t('sshProfiles.edit')}
                            title={t('sshProfiles.edit')}
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
                                  disabled={busy}
                                  aria-label={t('sshProfiles.moreActions')}
                                />
                              }
                            >
                              <DotsThreeOutlineVertical weight="regular" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-48">
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  onClick={() => void test(profile)}
                                  disabled={busy || Boolean(testingID)}
                                >
                                  {testingID === profile.id ? (
                                    <Spinner data-icon="inline-start" />
                                  ) : (
                                    <CheckCircle data-icon="inline-start" weight="regular" />
                                  )}
                                  {t('sshProfiles.test')}
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleteTarget(profile)}
                                disabled={busy}
                              >
                                <Trash data-icon="inline-start" weight="regular" />
                                {t('sshProfiles.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="border-y border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                      {t(normalizedQuery ? 'sshProfiles.searchEmpty' : 'sshProfiles.empty')}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="mx-auto grid w-full max-w-[560px] gap-5 py-5">
                <form
                  className="grid gap-4"
                  id="ssh-profile-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!busy) void save();
                  }}
                >
                  <div className="grid gap-1.5">
                    <Label htmlFor="ssh-profile-name">{t('sshProfiles.name')}</Label>
                    <Input
                      id="ssh-profile-name"
                      value={draft.name}
                      onChange={(event) => setField('name', event.target.value)}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_112px]">
                    <div className="grid gap-1.5">
                      <Label htmlFor="ssh-profile-host">{t('sshProfiles.host')}</Label>
                      <Input
                        id="ssh-profile-host"
                        value={draft.host}
                        onChange={(event) => setField('host', event.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ssh-profile-port">{t('sshProfiles.port')}</Label>
                      <Input
                        id="ssh-profile-port"
                        type="number"
                        min={1}
                        max={65535}
                        value={draft.port}
                        onChange={(event) => setField('port', Number(event.target.value))}
                      />
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ssh-profile-username">{t('sshProfiles.username')}</Label>
                    <Input
                      id="ssh-profile-username"
                      value={draft.username}
                      onChange={(event) => setField('username', event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ssh-profile-jump">{t('sshProfiles.jumpTitle')}</Label>
                    <Select
                      items={jumpOptions}
                      value={draft.jumpProfileID}
                      onValueChange={(next) => setField('jumpProfileID', next ?? '')}
                      disabled={busy}
                    >
                      <SelectTrigger id="ssh-profile-jump" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {jumpOptions.map((option) => (
                            <SelectItem key={option.value || 'direct'} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t('sshProfiles.jumpHint')}
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <span className="text-sm leading-none font-medium">
                      {t('sshProfiles.authMethod')}
                    </span>
                    <div
                      role="group"
                      aria-label={t('sshProfiles.authMethod')}
                      className="flex w-fit gap-1"
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant={authMode === 'password' ? 'secondary' : 'ghost'}
                        aria-pressed={authMode === 'password'}
                        onClick={() => setAuthMode('password')}
                      >
                        {t('sshProfiles.authPassword')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={authMode === 'key' ? 'secondary' : 'ghost'}
                        aria-pressed={authMode === 'key'}
                        onClick={() => setAuthMode('key')}
                      >
                        {t('sshProfiles.authKey')}
                      </Button>
                    </div>
                    <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <WarningCircle weight="regular" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 break-words">
                        {t('sshProfiles.plaintextWarning')}
                      </span>
                    </p>
                  </div>
                  {authMode === 'password' ? (
                    <div className="grid gap-1.5">
                      <Label htmlFor="ssh-profile-password">{t('sshProfiles.password')}</Label>
                      <PasswordInput
                        id="ssh-profile-password"
                        value={draft.password}
                        onChange={(value) => setField('password', value)}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ssh-profile-private-key">
                          {t('sshProfiles.privateKey')}
                        </Label>
                        <Textarea
                          id="ssh-profile-private-key"
                          value={draft.privateKey}
                          onChange={(event) => setField('privateKey', event.target.value)}
                          className="min-h-24 font-mono text-xs"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ssh-profile-private-key-path">
                          {t('sshProfiles.privateKeyPath')}
                        </Label>
                        <Input
                          id="ssh-profile-private-key-path"
                          value={draft.privateKeyPath}
                          onChange={(event) => setField('privateKeyPath', event.target.value)}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ssh-profile-key-passphrase">
                          {t('sshProfiles.keyPassphrase')}
                        </Label>
                        <PasswordInput
                          id="ssh-profile-key-passphrase"
                          value={draft.keyPassphrase}
                          onChange={(value) => setField('keyPassphrase', value)}
                        />
                      </div>
                    </>
                  )}
                </form>
                {formError ? (
                  <p className="m-0 text-xs text-destructive" role="alert">
                    {formError}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                  <Button
                    variant="outline"
                    onClick={() => void test(draft)}
                    disabled={busy || Boolean(testingID)}
                  >
                    {testingID ? <Spinner data-icon="inline-start" /> : null}
                    {t('sshProfiles.test')}
                  </Button>
                </div>
              </div>
            )}
          </ScrollArea>
          <DialogFooter className="mx-0 mb-0 flex-none rounded-b-xl px-6 py-4">
            <Button
              variant="outline"
              onClick={() => (view === 'list' ? requestClose(false) : requestBack())}
              disabled={busy}
            >
              {view === 'list' ? t('common.close') : t('sshProfiles.back')}
            </Button>
            {view === 'form' ? (
              <Button type="submit" form="ssh-profile-form" disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {t('common.save')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null);
        }}
        title={t('sshProfiles.deleteTitle')}
        description={t('sshProfiles.deleteDescription', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('sshProfiles.deleteConfirm')}
        destructive
        busy={busy}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={discardAction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) setDiscardAction(null);
        }}
        title={t('sshProfiles.discardTitle')}
        description={t('sshProfiles.discardDescription')}
        confirmLabel={t('sshProfiles.discardConfirm')}
        destructive
        busy={busy}
        onConfirm={() => {
          const action = discardAction;
          setDiscardAction(null);
          setFormError('');
          if (action === 'back') setView('list');
          else onOpenChange(false);
        }}
      />
    </>
  );
}
