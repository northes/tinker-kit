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
  PencilSimple,
  Plus,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import type { SSHProfile } from '../../bindings/changeme/models';
import {
  DeleteSSHProfile,
  GetSSHConfigProfiles,
  GetSSHProfiles,
  ImportSSHConfigProfile,
  RefreshSSHConfigProfile,
  SaveSSHProfile,
  TestSSHProfile,
} from '../../bindings/changeme/sshprofileservice';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';
import { toast } from './ui/toast';

type ManagerOptions = {
  select?: boolean;
  onSelect?: (profile: SSHProfile) => void;
};

type SSHProfileContextValue = {
  profiles: SSHProfile[];
  reload: () => Promise<void>;
  openManager: (options?: ManagerOptions) => void;
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
  originUpdatedAt: '',
};

function profileAddress(profile: SSHProfile) {
  const host = profile.host || profile.originAlias;
  return `${profile.username ? `${profile.username}@` : ''}${host}:${profile.port || 22}`;
}

function profileIsImported(profile: SSHProfile) {
  return profile.origin === 'ssh-config';
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export function useSSHProfiles() {
  const value = useContext(SSHProfileContext);
  if (!value) throw new Error('useSSHProfiles must be used inside SSHProfileProvider');
  return value;
}

export function SSHProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<SSHProfile[]>([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const selectRef = useRef<((profile: SSHProfile) => void) | undefined>(undefined);

  const reload = useCallback(async () => {
    const next = await GetSSHProfiles();
    setProfiles(next ?? []);
  }, []);

  useEffect(() => {
    void reload().catch(() => setProfiles([]));
  }, [reload]);

  const openManager = useCallback((options: ManagerOptions = {}) => {
    selectRef.current = options.onSelect;
    setSelectMode(options.select === true);
    setManagerOpen(true);
  }, []);

  const handleSelect = useCallback((profile: SSHProfile) => {
    selectRef.current?.(profile);
    selectRef.current = undefined;
    setManagerOpen(false);
  }, []);

  return (
    <SSHProfileContext.Provider value={{ profiles, reload, openManager }}>
      {children}
      <SSHProfileManagerDialog
        open={managerOpen}
        selectMode={selectMode}
        profiles={profiles}
        onProfilesChange={setProfiles}
        onSelect={handleSelect}
        onOpenChange={(open) => {
          if (!open) selectRef.current = undefined;
          setManagerOpen(open);
        }}
      />
    </SSHProfileContext.Provider>
  );
}

function SSHProfileManagerDialog({
  open,
  selectMode,
  profiles,
  onProfilesChange,
  onSelect,
  onOpenChange,
}: {
  open: boolean;
  selectMode: boolean;
  profiles: SSHProfile[];
  onProfilesChange: (profiles: SSHProfile[]) => void;
  onSelect: (profile: SSHProfile) => void;
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
  const [localProfiles, setLocalProfiles] = useState<SSHProfile[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [discardAction, setDiscardAction] = useState<'close' | 'back' | null>(null);
  const formBaselineRef = useRef<SSHProfile>({ ...emptyProfile });
  const imported = profileIsImported(draft);

  useEffect(() => {
    if (!open) return;
    setView('list');
    setDraft(emptyProfile);
    formBaselineRef.current = { ...emptyProfile };
    setFormError('');
    setListError('');
    setDiscardAction(null);
    void loadLocalProfiles();
  }, [open]);

  const loadLocalProfiles = async () => {
    setLocalLoading(true);
    setListError('');
    try {
      setLocalProfiles((await GetSSHConfigProfiles()) ?? []);
    } catch (reason) {
      setLocalProfiles([]);
      setListError(errorMessage(reason));
    } finally {
      setLocalLoading(false);
    }
  };

  const refreshProfiles = async () => {
    setLoading(true);
    setListError('');
    try {
      onProfilesChange((await GetSSHProfiles()) ?? []);
      await loadLocalProfiles();
    } catch (reason) {
      setListError(errorMessage(reason));
    } finally {
      setLoading(false);
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
      if (!imported) {
        if (authMode === 'password') {
          payload.privateKey = '';
          payload.privateKeyPath = '';
          payload.keyPassphrase = '';
        } else {
          payload.password = '';
        }
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

  const importProfile = async (candidate: SSHProfile) => {
    setBusy(true);
    setListError('');
    try {
      const saved = await ImportSSHConfigProfile(candidate.originAlias);
      onProfilesChange([...profiles, saved]);
      toast.add({ title: t('sshProfiles.importSucceeded'), type: 'success' });
    } catch (reason) {
      setListError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const refreshImported = async (profile: SSHProfile) => {
    setBusy(true);
    setListError('');
    try {
      const updated = await RefreshSSHConfigProfile(profile.id);
      onProfilesChange(profiles.map((item) => (item.id === updated.id ? updated : item)));
      if (draft.id === updated.id) {
        setDraft(updated);
        formBaselineRef.current = { ...updated };
      }
      toast.add({ title: t('sshProfiles.updateSucceeded'), type: 'success' });
    } catch (reason) {
      const message = errorMessage(reason);
      if (view === 'form' && draft.id === profile.id) setFormError(message);
      else setListError(message);
    } finally {
      setBusy(false);
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
        <DialogContent className="flex max-h-[min(760px,calc(100dvh-32px))] w-[min(680px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <DialogHeader className="flex-none border-b border-border px-6 py-5">
            <DialogTitle className="text-base">
              {view === 'list'
                ? t('sshProfiles.title')
                : draft.id
                  ? t('sshProfiles.editTitle')
                  : t('sshProfiles.newTitle')}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {view === 'list' ? t('sshProfiles.description') : t('sshProfiles.formDescription')}
            </DialogDescription>
          </DialogHeader>
          {listError && view === 'list' ? (
            <div
              className="mx-6 mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <WarningCircle weight="duotone" className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{listError}</span>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [padding-inline-end:var(--overlay-scrollbar-hit-size)]">
            {view === 'list' ? (
              <div className="grid gap-6">
                <section className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-foreground">
                      {t('sshProfiles.savedTitle')}
                    </h3>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void refreshProfiles()}
                        disabled={loading || busy}
                        aria-label={t('sshProfiles.refresh')}
                      >
                        <ArrowClockwise
                          weight="duotone"
                          className={loading ? 'animate-spin motion-reduce:animate-none' : ''}
                        />
                      </Button>
                      <Button variant="outline" size="sm" onClick={startNew} disabled={busy}>
                        <Plus data-icon="inline-start" weight="duotone" />
                        {t('sshProfiles.add')}
                      </Button>
                    </div>
                  </div>
                  {profiles.length ? (
                    <div className="divide-y divide-border border-y border-border">
                      {profiles.map((profile) => (
                        <div key={profile.id} className="flex min-w-0 items-center gap-2 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-xs font-medium text-foreground">
                                {profile.name}
                              </span>
                              <Badge
                                variant={profileIsImported(profile) ? 'secondary' : 'outline'}
                                className="h-5 text-[10px]"
                              >
                                {profileIsImported(profile)
                                  ? t('sshProfiles.originLocal')
                                  : t('sshProfiles.originManual')}
                              </Badge>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                              <span className="truncate font-mono">{profileAddress(profile)}</span>
                              {profileIsImported(profile) ? (
                                <span className="truncate">{profile.originAlias}</span>
                              ) : null}
                            </div>
                          </div>
                          {selectMode ? (
                            <Button size="sm" variant="outline" onClick={() => onSelect(profile)}>
                              {t('sshProfiles.select')}
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => startEdit(profile)}
                            disabled={busy}
                            aria-label={t('sshProfiles.edit')}
                          >
                            <PencilSimple weight="duotone" />
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
                              <DotsThreeOutlineVertical weight="duotone" />
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
                                    <CheckCircle data-icon="inline-start" weight="duotone" />
                                  )}
                                  {t('sshProfiles.test')}
                                </DropdownMenuItem>
                                {profileIsImported(profile) ? (
                                  <DropdownMenuItem
                                    onClick={() => void refreshImported(profile)}
                                    disabled={busy}
                                  >
                                    <ArrowClockwise data-icon="inline-start" weight="duotone" />
                                    {t('sshProfiles.updateFromLocal')}
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleteTarget(profile)}
                                disabled={busy}
                              >
                                <Trash data-icon="inline-start" weight="duotone" />
                                {t('sshProfiles.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="border-y border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                      {t('sshProfiles.empty')}
                    </div>
                  )}
                </section>
                <section className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-foreground">
                      {t('sshProfiles.localTitle')}
                    </h3>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void loadLocalProfiles()}
                      disabled={localLoading || busy}
                      aria-label={t('sshProfiles.refresh')}
                    >
                      <ArrowClockwise
                        weight="duotone"
                        className={localLoading ? 'animate-spin motion-reduce:animate-none' : ''}
                      />
                    </Button>
                  </div>
                  {localProfiles.length ? (
                    <div className="divide-y divide-border border-y border-border">
                      {localProfiles.map((candidate) => {
                        const exists = profiles.some(
                          (profile) =>
                            profile.origin === 'ssh-config' &&
                            profile.originAlias === candidate.originAlias,
                        );
                        return (
                          <div
                            key={candidate.originAlias}
                            className="flex min-w-0 items-center gap-2 py-2.5"
                          >
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-foreground">
                                {candidate.originAlias}
                              </span>
                              <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
                                {profileAddress(candidate)}
                              </span>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void importProfile(candidate)}
                              disabled={exists || busy}
                            >
                              {exists ? (
                                t('sshProfiles.imported')
                              ) : (
                                <>
                                  <DownloadSimple data-icon="inline-start" weight="duotone" />
                                  {t('sshProfiles.import')}
                                </>
                              )}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="border-y border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                      {t('sshProfiles.localEmpty')}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="mx-auto grid w-full max-w-[560px] gap-5">
                {imported ? (
                  <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <CheckCircle weight="duotone" className="mt-0.5 size-4 shrink-0" />
                    <span>{t('sshProfiles.importedHint', { alias: draft.originAlias })}</span>
                  </div>
                ) : null}
                <div className="grid gap-4">
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
                        disabled={imported}
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
                        disabled={imported}
                        onChange={(event) => setField('port', Number(event.target.value))}
                      />
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ssh-profile-username">{t('sshProfiles.username')}</Label>
                    <Input
                      id="ssh-profile-username"
                      value={draft.username}
                      disabled={imported}
                      onChange={(event) => setField('username', event.target.value)}
                    />
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
                        disabled={imported}
                        onClick={() => setAuthMode('password')}
                      >
                        {t('sshProfiles.authPassword')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={authMode === 'key' ? 'secondary' : 'ghost'}
                        aria-pressed={authMode === 'key'}
                        disabled={imported}
                        onClick={() => setAuthMode('key')}
                      >
                        {t('sshProfiles.authKey')}
                      </Button>
                    </div>
                  </div>
                  {authMode === 'password' ? (
                    <div className="grid gap-1.5">
                      <Label htmlFor="ssh-profile-password">{t('sshProfiles.password')}</Label>
                      <Input
                        id="ssh-profile-password"
                        type="password"
                        value={draft.password}
                        disabled={imported}
                        onChange={(event) => setField('password', event.target.value)}
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
                          disabled={imported}
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
                          disabled={imported}
                          onChange={(event) => setField('privateKeyPath', event.target.value)}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ssh-profile-key-passphrase">
                          {t('sshProfiles.keyPassphrase')}
                        </Label>
                        <Input
                          id="ssh-profile-key-passphrase"
                          type="password"
                          value={draft.keyPassphrase}
                          disabled={imported}
                          onChange={(event) => setField('keyPassphrase', event.target.value)}
                        />
                      </div>
                    </>
                  )}
                </div>
                {formError ? (
                  <p className="m-0 text-xs text-destructive" role="alert">
                    {formError}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                  <Button
                    variant="outline"
                    onClick={() => void test(draft)}
                    disabled={busy || Boolean(testingID)}
                  >
                    {testingID ? <Spinner data-icon="inline-start" /> : null}
                    {t('sshProfiles.test')}
                  </Button>
                  {imported ? (
                    <Button
                      variant="outline"
                      onClick={() => void refreshImported(draft)}
                      disabled={busy}
                    >
                      {t('sshProfiles.updateFromLocal')}
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="mx-0 mb-0 flex-none rounded-b-xl px-6 py-4">
            <Button
              variant="outline"
              onClick={() => (view === 'list' ? requestClose(false) : requestBack())}
              disabled={busy}
            >
              {view === 'list' ? t('common.cancel') : t('sshProfiles.back')}
            </Button>
            {view === 'form' ? (
              <Button onClick={() => void save()} disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {t('common.save')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sshProfiles.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('sshProfiles.deleteDescription', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {t('sshProfiles.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={discardAction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) setDiscardAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sshProfiles.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sshProfiles.discardDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const action = discardAction;
                setDiscardAction(null);
                setFormError('');
                if (action === 'back') setView('list');
                else onOpenChange(false);
              }}
            >
              {t('sshProfiles.discardConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
