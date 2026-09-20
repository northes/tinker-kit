import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HardDrives, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { ConfirmDialog } from './ConfirmDialog';

type Strings = {
  title: ReactNode;
  description: ReactNode;
  listTitle: ReactNode;
  add: ReactNode;
  edit: string;
  remove: string;
  empty: ReactNode;
  emptyHint: ReactNode;
  save: ReactNode;
  done: ReactNode;
  back: ReactNode;
  discardTitle: ReactNode;
  discardDescription: ReactNode;
  discardConfirm: ReactNode;
  removeTitle: ReactNode;
  removeDescription: (name: string) => ReactNode;
  formTitle: (editing: boolean) => ReactNode;
};

export function TargetHostManagerDialog<TItem, TDraft>({
  open,
  onOpenChange,
  items,
  itemKey,
  itemName,
  createDraft,
  toDraft,
  commitDraft,
  saveItems,
  renderMeta,
  renderForm,
  renderFormActions,
  canAdd = true,
  saving = false,
  strings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: TItem[];
  itemKey: (item: TItem) => string;
  itemName: (item: TItem) => string;
  createDraft: () => TDraft;
  toDraft: (item: TItem) => TDraft;
  commitDraft: (draft: TDraft, previous: TItem[]) => Promise<TItem[] | string> | TItem[] | string;
  saveItems: (items: TItem[]) => Promise<void>;
  renderMeta: (item: TItem) => ReactNode;
  renderForm: (args: { draft: TDraft; setDraft: (draft: TDraft) => void }) => ReactNode;
  renderFormActions?: (draft: TDraft) => ReactNode;
  canAdd?: boolean;
  saving?: boolean;
  strings: Strings;
}) {
  const [baseline, setBaseline] = useState<TItem[]>([]);
  const [draftItems, setDraftItems] = useState<TItem[]>([]);
  const [formDraft, setFormDraft] = useState<TDraft | null>(null);
  const [formBaseline, setFormBaseline] = useState('');
  const [formError, setFormError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [removeItem, setRemoveItem] = useState<TItem | null>(null);
  const [discardAction, setDiscardAction] = useState<'close' | 'back' | null>(null);

  useEffect(() => {
    if (!open) return;
    setBaseline(items);
    setDraftItems(items);
    setFormDraft(null);
    setFormBaseline('');
    setFormError('');
    setSaveError('');
  }, [open]);

  const collectionDirty = useMemo(
    () => JSON.stringify(baseline) !== JSON.stringify(draftItems),
    [baseline, draftItems],
  );
  const formDirty = formDraft !== null && JSON.stringify(formDraft) !== formBaseline;
  const requestClose = () => {
    if (saving) return;
    if (collectionDirty || formDirty) setDiscardAction('close');
    else onOpenChange(false);
  };
  const startForm = (next: TDraft) => {
    setFormDraft(next);
    setFormBaseline(JSON.stringify(next));
    setFormError('');
  };
  const requestBack = () => {
    if (formDirty) setDiscardAction('back');
    else setFormDraft(null);
  };
  const submitForm = async () => {
    if (formDraft === null || saving) return;
    const next = await commitDraft(formDraft, draftItems);
    if (typeof next === 'string') {
      setFormError(next);
      return;
    }
    setDraftItems(next);
    setFormDraft(null);
    setFormError('');
  };
  const persist = async () => {
    if (saving) return;
    setSaveError('');
    try {
      await saveItems(draftItems);
      onOpenChange(false);
    } catch (error) {
      setSaveError(String(error));
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent
          className="flex max-h-[min(760px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
          showCloseButton
        >
          <DialogHeader className="flex-none border-b border-border px-6 py-5">
            <DialogTitle className="text-base">
              {formDraft === null
                ? strings.title
                : strings.formTitle(formBaseline !== JSON.stringify(createDraft()))}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {strings.description}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1 px-6 py-5 [padding-inline-end:var(--overlay-scrollbar-size)]">
            {formDraft === null ? (
              <div className="grid gap-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-foreground">{strings.listTitle}</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canAdd || saving}
                    onClick={() => startForm(createDraft())}
                  >
                    <Plus data-icon="inline-start" weight="duotone" />
                    {strings.add}
                  </Button>
                </div>
                {draftItems.length ? (
                  <div className="divide-y divide-border border-y border-border">
                    {draftItems.map((item) => (
                      <div key={itemKey(item)} className="flex min-w-0 items-center gap-2 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-foreground">
                            {itemName(item)}
                          </div>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                            {renderMeta(item)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={saving}
                          aria-label={strings.edit}
                          onClick={() => startForm(toDraft(item))}
                        >
                          <PencilSimple weight="duotone" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={saving}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={strings.remove}
                          onClick={() => setRemoveItem(item)}
                        >
                          <Trash weight="duotone" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-2 border-y border-dashed border-border py-10 text-center">
                    <HardDrives size={28} weight="duotone" className="text-muted-foreground" />
                    <p className="m-0 text-xs font-medium text-foreground">{strings.empty}</p>
                    <p className="m-0 max-w-xs text-[10px] leading-4 text-muted-foreground">
                      {strings.emptyHint}
                    </p>
                  </div>
                )}
                {saveError ? (
                  <p className="m-0 text-xs text-destructive" role="alert">
                    {saveError}
                  </p>
                ) : null}
              </div>
            ) : (
              <form
                id="target-host-form"
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitForm();
                }}
              >
                {renderForm({
                  draft: formDraft,
                  setDraft: (next) => {
                    setFormError('');
                    setFormDraft(next);
                  },
                })}
                {formError ? (
                  <p className="m-0 text-xs text-destructive" role="alert">
                    {formError}
                  </p>
                ) : null}
              </form>
            )}
          </ScrollArea>
          <DialogFooter className="mx-0 mb-0 flex-none rounded-b-xl px-6 py-4">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => (formDraft === null ? requestClose() : requestBack())}
            >
              {formDraft === null ? strings.done : strings.back}
            </Button>
            {formDraft === null ? (
              <Button disabled={saving || !collectionDirty} onClick={() => void persist()}>
                {saving ? <Spinner data-icon="inline-start" /> : null}
                {strings.save}
              </Button>
            ) : (
              <>
                {renderFormActions?.(formDraft)}
                <Button type="submit" form="target-host-form" disabled={saving}>
                  {strings.save}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removeItem !== null}
        onOpenChange={(next) => {
          if (!next) setRemoveItem(null);
        }}
        title={strings.removeTitle}
        description={removeItem ? strings.removeDescription(itemName(removeItem)) : ''}
        confirmLabel={strings.remove}
        destructive
        onConfirm={() => {
          if (removeItem)
            setDraftItems((current) =>
              current.filter((item) => itemKey(item) !== itemKey(removeItem)),
            );
          setRemoveItem(null);
        }}
      />
      <ConfirmDialog
        open={discardAction !== null}
        onOpenChange={(next) => {
          if (!next) setDiscardAction(null);
        }}
        title={strings.discardTitle}
        description={strings.discardDescription}
        confirmLabel={strings.discardConfirm}
        destructive
        onConfirm={() => {
          const action = discardAction;
          setDiscardAction(null);
          setFormDraft(null);
          if (action === 'close') onOpenChange(false);
        }}
      />
    </>
  );
}
