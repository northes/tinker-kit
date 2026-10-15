import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageImportEntry } from '../../bindings/tinkerkit/models';
import { formatBackendError } from '../lib/backend-error';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import { Spinner } from './ui/spinner';

export function ImageImportDialog({
  entries,
  onClose,
  onSubmit,
}: {
  entries: ImageImportEntry[];
  onClose: () => void;
  onSubmit: (entries: ImageImportEntry[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const formID = useId();
  const [targets, setTargets] = useState(() => entries.map((entry) => entry.target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const duplicate = targets.some(
    (target, index) =>
      target.trim() && targets.findIndex((item) => item.trim() === target.trim()) !== index,
  );
  const ready =
    !duplicate &&
    targets.every(
      (target, index) =>
        target.trim() && !(entries[index].conflict && target.trim() === entries[index].target),
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('imageManagerTool.importPreviewTitle')}</DialogTitle>
          <DialogDescription>{t('imageManagerTool.importPreviewBody')}</DialogDescription>
        </DialogHeader>
        <ScrollArea
          element="form"
          id={formID}
          className="max-h-[55vh] min-h-0"
          options={{ overflow: { x: 'hidden' } }}
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !ready) return;
            setBusy(true);
            setError('');
            try {
              await onSubmit(
                entries.map((entry, index) => ({ ...entry, target: targets[index].trim() })),
              );
            } catch (reason) {
              setError(formatBackendError(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-4">
            {entries.map((entry, index) => {
              const inputID = `${formID}-${index}`;
              const conflict = entry.conflict && targets[index].trim() === entry.target;
              return (
                <div key={`${entry.path}-${index}`} className="grid gap-2">
                  <div className="min-w-0 text-xs">
                    <p className="m-0 break-all font-mono">{entry.reference}</p>
                    <p className="m-0 break-all text-muted-foreground">
                      {entry.path.split(/[\\/]/).pop()} · {(entry.platforms ?? []).join(', ')}
                    </p>
                  </div>
                  <Label htmlFor={inputID}>{t('imageManagerTool.importTarget')}</Label>
                  <Input
                    id={inputID}
                    value={targets[index]}
                    disabled={busy}
                    required
                    autoFocus={index === 0}
                    placeholder={t('imageManagerTool.importTargetPlaceholder')}
                    aria-invalid={Boolean(conflict || duplicate)}
                    aria-describedby={conflict ? `${inputID}-conflict` : undefined}
                    onChange={(event) => {
                      setError('');
                      setTargets((current) =>
                        current.map((target, position) =>
                          position === index ? event.target.value : target,
                        ),
                      );
                    }}
                  />
                  {conflict ? (
                    <p
                      id={`${inputID}-conflict`}
                      className="m-0 text-xs text-destructive"
                      role="alert"
                    >
                      {t('imageManagerTool.importRenameRequired')}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </ScrollArea>
        {error || duplicate ? (
          <p className="m-0 break-all text-xs text-destructive" role="alert">
            {error || t('imageManagerTool.importDuplicateTargets')}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('imageManagerTool.cancel')}
          </Button>
          <Button type="submit" form={formID} disabled={busy || !ready}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {t('imageManagerTool.importTar')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
