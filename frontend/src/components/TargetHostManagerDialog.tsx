import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DotsSixVertical, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { ConfirmDialog } from './ConfirmDialog';
import { formatBackendError } from '../lib/backend-error';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';

function SortableManagerItem({
  id,
  label,
  disabled = false,
  children,
}: {
  id: string;
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 ${disabled ? 'opacity-75' : ''} ${isDragging ? 'z-10 shadow-md' : ''}`}
    >
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="icon-sm"
        className="flex-none cursor-grab touch-none text-muted-foreground/60"
        {...attributes}
        {...listeners}
        aria-label={label}
      >
        <DotsSixVertical weight="duotone" />
      </Button>
      {children}
    </div>
  );
}

type Strings = {
  title: ReactNode;
  add: ReactNode;
  edit: string;
  remove: string;
  dragItem: (name: string) => string;
  empty: ReactNode;
  emptyHint: ReactNode;
  save: ReactNode;
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
  itemDisabled,
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
  itemDisabled?: (item: TItem) => boolean;
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
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
      setSaveError(formatBackendError(error));
    }
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      setDraftItems((current) =>
        arrayMove(
          current,
          current.findIndex((item) => itemKey(item) === active.id),
          current.findIndex((item) => itemKey(item) === over.id),
        ),
      );
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent
          className="flex h-[600px] max-h-[calc(100dvh-var(--app-titlebar-height)-4rem)] min-h-0 w-[min(560px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
          showCloseButton
        >
          <DialogHeader className="flex-none border-b border-border px-6 py-5">
            <DialogTitle className="text-base">
              {formDraft === null
                ? strings.title
                : strings.formTitle(formBaseline !== JSON.stringify(createDraft()))}
            </DialogTitle>
          </DialogHeader>
          {formDraft === null ? (
            <div className="min-h-0 flex-1 px-6 pt-4">
              <ScrollArea
                className="h-full min-h-0 [padding-inline-end:var(--overlay-scrollbar-size)]"
                scrollFade="y"
                options={{ scrollbars: { visibility: 'hidden' } }}
              >
                <div className="grid min-h-full content-start gap-2 py-1">
                  {draftItems.length ? (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={draftItems.map(itemKey)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="grid gap-2">
                          {draftItems.map((item) => (
                            <SortableManagerItem
                              key={itemKey(item)}
                              id={itemKey(item)}
                              label={strings.dragItem(itemName(item))}
                              disabled={itemDisabled?.(item) ?? false}
                            >
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
                                disabled={saving || (itemDisabled?.(item) ?? false)}
                                className="text-muted-foreground/60 hover:text-foreground disabled:opacity-35"
                                aria-label={strings.edit}
                                onClick={() => startForm(toDraft(item))}
                              >
                                <PencilSimple weight="duotone" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={saving || (itemDisabled?.(item) ?? false)}
                                className="text-muted-foreground/60 hover:text-destructive disabled:opacity-35"
                                aria-label={strings.remove}
                                onClick={() => setRemoveItem(item)}
                              >
                                <Trash weight="duotone" />
                              </Button>
                            </SortableManagerItem>
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  ) : (
                    <Empty className="min-h-48">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Plus />
                        </EmptyMedia>
                        <EmptyTitle>{strings.empty}</EmptyTitle>
                        <EmptyDescription>{strings.emptyHint}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  {saveError ? (
                    <p className="m-0 text-xs text-destructive" role="alert">
                      {saveError}
                    </p>
                  ) : null}
                </div>
              </ScrollArea>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1 px-6 py-5 [padding-inline-end:var(--overlay-scrollbar-size)]">
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
            </ScrollArea>
          )}
          <DialogFooter className="mx-0 mb-0 flex-none rounded-b-xl px-6 py-4">
            {formDraft === null ? (
              <>
                <Button
                  variant="outline"
                  disabled={!canAdd || saving}
                  onClick={() => startForm(createDraft())}
                >
                  <Plus data-icon="inline-start" weight="duotone" />
                  {strings.add}
                </Button>
                <Button disabled={saving || !collectionDirty} onClick={() => void persist()}>
                  {saving ? <Spinner data-icon="inline-start" /> : null}
                  {strings.save}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={saving} onClick={requestBack}>
                  {strings.back}
                </Button>
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
