import { FilePlus, FolderSimplePlus } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Spinner } from '../ui/spinner';
import { errorMessage } from './model';

export type CreateEntryKind = 'file' | 'folder';

export function CreateEntryDialog({
  kind,
  parentPath,
  onCreate,
  onClose,
}: {
  kind: CreateEntryKind;
  parentPath: string;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const isFile = kind === 'file';
  const Icon = isFile ? FilePlus : FolderSimplePlus;

  const create = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t(isFile ? 'sshFilesTool.fileNameRequired' : 'sshFilesTool.folderNameRequired'));
      return;
    }
    if (trimmed === '.' || trimmed === '..' || /[\\/\0]/.test(trimmed)) {
      setError(t(isFile ? 'sshFilesTool.fileNameInvalid' : 'sshFilesTool.folderNameInvalid'));
      return;
    }
    setCreating(true);
    setError('');
    try {
      await onCreate(trimmed);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !creating) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(isFile ? 'sshFilesTool.createFile' : 'sshFilesTool.createFolderTitle')}
          </DialogTitle>
          <DialogDescription className="break-words">
            {t(isFile ? 'sshFilesTool.createFileDesc' : 'sshFilesTool.createFolderDesc', {
              path: parentPath,
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          id="ssh-create-entry-form"
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Label htmlFor="ssh-create-entry-name">
            {t(isFile ? 'sshFilesTool.fileName' : 'sshFilesTool.folderName')}
          </Label>
          <Input
            id="ssh-create-entry-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={isFile ? t('sshFilesTool.fileNamePlaceholder') : undefined}
            disabled={creating}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'ssh-create-entry-error' : 'ssh-create-entry-hint'}
            autoFocus
          />
          <p id="ssh-create-entry-hint" className="text-sm text-muted-foreground">
            {t(isFile ? 'sshFilesTool.fileNameHint' : 'sshFilesTool.folderNameHint')}
          </p>
          {error ? (
            <p id="ssh-create-entry-error" className="text-sm text-destructive" role="alert">
              {t(isFile ? 'sshFilesTool.fileCreateFailed' : 'sshFilesTool.folderCreateFailed')}:{' '}
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={creating} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="ssh-create-entry-form" disabled={creating}>
            {creating ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Icon data-icon="inline-start" weight="duotone" />
            )}
            {t('sshFilesTool.createFolderAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
