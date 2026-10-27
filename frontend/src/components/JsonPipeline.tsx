import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { json5 } from 'codemirror-json5';
import { EditorView } from '@codemirror/view';
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
} from '@dnd-kit/sortable';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Switch } from './ui/switch';
import {
  ArrowsOut,
  DotsSixVertical,
  Queue,
  Table as TableIcon,
  Trash,
} from '@phosphor-icons/react';
import type { Extension } from '@codemirror/state';
import { backendPathCompletions, backendValueCompletions } from './JsonPathCompletion';
import type { PipelineCompletionContext, PipelineEvaluation } from './useBackendPipelineEvaluation';
import { ReadPipelineTablePage } from '../../bindings/tinkerkit/jsonpipelineservice';
import type { PipelineTablePage } from '../../bindings/tinkerkit/models';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
import { Spinner } from './ui/spinner';
import { JsonErrorPanel } from './JsonErrorPanel';
import { JsonTablePreview } from './JsonTablePreview';
import { formatJsonTimeValue, type JsonTimeFormat } from '../lib/json-time-format';
import { isObject } from './JsonPipelineEngine';
import { parseJsonLoose } from './shared';
import { toast } from './ui/toast';
import '../styles/tools/editor.css';
import '../styles/tools/json.css';
import type {
  PipelineDirection,
  PipelineFilterOperator,
  PipelineItem,
  PipelineMatchMode,
  PipelineItemType,
  PipelineSortMode,
} from './JsonPipelineEngine';

class PipelineConfigError extends Error {
  constructor() {
    super('invalidConfig');
  }
}
const createPipelineId = () => `pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function newPipelineItem(type: PipelineItemType = 'extract'): PipelineItem {
  return {
    id: createPipelineId(),
    enabled: true,
    type,
    path: '$',
    sortMode: 'key',
    direction: 'asc',
    arrayPath: '$',
    itemPath: '$',
    operator: 'eq',
    matchMode: 'key',
    filterValue: '',
    template: '{$.name}?token={$.token}',
  };
}
const filterOperators: PipelineFilterOperator[] = [
  'gt',
  'gte',
  'eq',
  'lt',
  'lte',
  'includes',
  'excludes',
  'notNull',
  'notEmpty',
  'isNull',
  'isEmpty',
  'stringLengthGt',
  'stringLengthGte',
  'stringLengthEq',
  'stringLengthLt',
  'stringLengthLte',
];
const unaryFilterOperators: PipelineFilterOperator[] = ['notNull', 'notEmpty', 'isNull', 'isEmpty'];
const typeOptions: PipelineItemType[] = [
  'extract',
  'sort',
  'arraySort',
  'filter',
  'arrayDedupe',
  'arrayTrim',
  'template',
];
const configString = (item: Record<string, unknown>, key: string, fallback: string) => {
  const value = item[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new PipelineConfigError();
  return value;
};
export function parsePipelineConfig(source: string): PipelineItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new PipelineConfigError();
  }
  if (isObject(parsed) && parsed.version !== undefined && parsed.version !== 1)
    throw new PipelineConfigError();
  const items = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : null;
  if (!items) throw new PipelineConfigError();
  const result = items.map((raw) => {
    if (
      !isObject(raw) ||
      typeof raw.type !== 'string' ||
      !typeOptions.includes(raw.type as PipelineItemType)
    )
      throw new PipelineConfigError();
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
      throw new PipelineConfigError();
    if (raw.sortMode !== undefined && raw.sortMode !== 'key' && raw.sortMode !== 'value')
      throw new PipelineConfigError();
    if (raw.direction !== undefined && raw.direction !== 'asc' && raw.direction !== 'desc')
      throw new PipelineConfigError();
    if (
      raw.operator !== undefined &&
      (typeof raw.operator !== 'string' ||
        !filterOperators.includes(raw.operator as PipelineFilterOperator))
    )
      throw new PipelineConfigError();
    if (raw.matchMode !== undefined && raw.matchMode !== 'key' && raw.matchMode !== 'value')
      throw new PipelineConfigError();
    const item: PipelineItem = {
      id: createPipelineId(),
      enabled: raw.enabled ?? true,
      type: raw.type as PipelineItemType,
      path: configString(raw, 'path', '$'),
      sortMode: (raw.sortMode ?? 'key') as PipelineSortMode,
      direction: (raw.direction ?? 'asc') as PipelineDirection,
      arrayPath: configString(raw, 'arrayPath', '$'),
      itemPath: configString(raw, 'itemPath', '$'),
      operator: (raw.operator ?? 'eq') as PipelineFilterOperator,
      matchMode: (raw.matchMode ?? 'key') as PipelineMatchMode,
      filterValue: configString(raw, 'filterValue', ''),
      template: configString(raw, 'template', '{$.name}?token={$.token}'),
    };
    return item;
  });
  if (result.filter((item) => item.type === 'template').length > 1) throw new PipelineConfigError();
  const template = result.find((item) => item.type === 'template');
  return template ? [...result.filter((item) => item !== template), template] : result;
}
export function serializePipeline(rules: PipelineItem[]): string {
  return JSON.stringify({ version: 1, items: rules.map(({ id, ...item }) => item) }, null, 2);
}

function PipelineSelect({
  label,
  value,
  options,
  onSelect,
  className = '',
}: {
  label: string;
  value: string;
  options: Array<{ key: string; label: string }>;
  onSelect: (value: string) => void;
  className?: string;
}) {
  return (
    <Select
      items={options.map((option) => ({ value: option.key, label: option.label }))}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onSelect(next);
      }}
    >
      <SelectTrigger
        className={`json-pipeline-select h-[30px] min-h-[30px] w-full min-w-0 flex-1 justify-self-stretch px-[9px] text-[11px] ${className}`.trim()}
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
const pathFieldBasicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  closeBrackets: false,
};
const pathFieldWheelToHorizontal = EditorView.domEventHandlers({
  wheel: (event, view) => {
    const { deltaX, deltaY, deltaMode } = event;
    if (event.ctrlKey || (deltaX === 0 && deltaY === 0)) return false;
    const scroller = view.scrollDOM;
    if (scroller.scrollWidth <= scroller.clientWidth) return false;
    const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? scroller.clientWidth : 1;
    const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    scroller.scrollLeft += delta * scale;
    event.preventDefault();
    return true;
  },
});
function PathField({
  label,
  value,
  placeholder,
  onChange,
  theme,
  itemId,
  field,
  completionRef,
  template = false,
  className = '',
  onCreate,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  theme: Extension;
  itemId: string;
  field: string;
  completionRef: MutableRefObject<PipelineCompletionContext>;
  template?: boolean;
  className?: string;
  onCreate?: (view: EditorView) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(value);
  const completionExtensions = useMemo(() => {
    const getContext = () => completionRef.current;
    return [
      ...(field === 'filterValue'
        ? backendValueCompletions(getContext, itemId)
        : backendPathCompletions(getContext, itemId, field, template)),
    ];
  }, [completionRef, field, itemId, template]);
  const smallExtensions = useMemo(
    () => [pathFieldWheelToHorizontal, ...completionExtensions],
    [completionExtensions],
  );
  const expandedExtensions = useMemo(
    () => [...completionExtensions, EditorView.lineWrapping],
    [completionExtensions],
  );
  const openExpanded = () => {
    setDraft(value);
    setExpanded(true);
  };
  return (
    <>
      <div
        className={`json-pipeline-field flex min-w-0 items-center gap-2 @max-[520px]/pipeline-rules:items-stretch @max-[520px]/pipeline-rules:flex-col @max-[520px]/pipeline-rules:gap-[5px] ${className}`.trim()}
      >
        <span className="w-[86px] min-w-[86px] whitespace-nowrap font-mono text-[10px] font-medium leading-none tracking-[.02em] text-muted-foreground @max-[520px]/pipeline-rules:w-auto @max-[520px]/pipeline-rules:min-w-0">
          {label}
        </span>
        <div className="relative min-w-0 flex-1">
          <CodeMirror
            className="json-cm json-pipeline-path-cm w-full overflow-visible rounded-lg border border-input bg-card"
            height="30px"
            value={value}
            placeholder={placeholder}
            onChange={onChange}
            spellCheck={false}
            theme={theme}
            indentWithTab={false}
            basicSetup={pathFieldBasicSetup}
            extensions={smallExtensions}
            onCreateEditor={(view) => {
              view.contentDOM.setAttribute('aria-label', label);
              onCreate?.(view);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="json-pipeline-expand absolute top-0 right-1 bottom-0 my-auto text-muted-foreground"
            aria-label={t('jsonTool.pipeline.expandField')}
            title={t('jsonTool.pipeline.expandField')}
            onClick={openExpanded}
          >
            <ArrowsOut size={12} weight="duotone" />
          </Button>
        </div>
      </div>
      <Dialog
        open={expanded}
        onOpenChange={(next) => {
          if (!next) setExpanded(false);
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col sm:max-w-2xl">
          <DialogHeader className="flex-none">
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <CodeMirror
            className="json-cm json-pipeline-expanded-cm w-full"
            height="100%"
            value={draft}
            placeholder={placeholder}
            onChange={setDraft}
            spellCheck={false}
            theme={theme}
            indentWithTab={false}
            autoFocus
            basicSetup={pathFieldBasicSetup}
            extensions={expandedExtensions}
            onCreateEditor={(view) => view.contentDOM.setAttribute('aria-label', label)}
          />
          <DialogFooter className="flex-none">
            <Button type="button" variant="outline" onClick={() => setExpanded(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onChange(draft);
                setExpanded(false);
              }}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
function SelectField({
  label,
  value,
  options,
  onSelect,
  className = '',
}: {
  label: string;
  value: string;
  options: Array<{ key: string; label: string }>;
  onSelect: (value: string) => void;
  className?: string;
}) {
  return (
    <label
      className={`json-pipeline-field json-pipeline-select-field flex min-w-0 items-center gap-2 @max-[520px]/pipeline-rules:items-stretch @max-[520px]/pipeline-rules:flex-col @max-[520px]/pipeline-rules:gap-[5px] ${className}`.trim()}
    >
      <span className="w-[86px] min-w-[86px] whitespace-nowrap font-mono text-[10px] font-medium leading-none tracking-[.02em] text-muted-foreground @max-[520px]/pipeline-rules:w-auto @max-[520px]/pipeline-rules:min-w-0">
        {label}
      </span>
      <PipelineSelect label={label} value={value} options={options} onSelect={onSelect} />
    </label>
  );
}

function PipelineRuleRow({
  item,
  index,
  labels,
  theme,
  completionRef,
  onUpdate,
  onTypeChange,
  onRemove,
  onFirstEditorCreate,
}: {
  item: PipelineItem;
  index: number;
  labels: Record<PipelineItemType, string>;
  theme: Extension;
  completionRef: MutableRefObject<PipelineCompletionContext>;
  onUpdate: (id: string, patch: Partial<PipelineItem>) => void;
  onTypeChange: (item: PipelineItem, type: PipelineItemType) => void;
  onRemove: (id: string) => void;
  onFirstEditorCreate: (id: string, view: EditorView) => void;
}) {
  const { t } = useTranslation();
  const listOperator = item.operator === 'includes' || item.operator === 'excludes';
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  // 纵向列表排序只允许垂直位移：dnd-kit 的 transform 仍会带上指针的 x 偏移，
  // 直接透传会让被拖动项横向溢出容器，出现横向滚动条。
  const style = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
    zIndex: isDragging ? 1 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`json-pipeline-item min-w-0 rounded-lg bg-muted/70 p-3${item.enabled ? '' : ' opacity-[.55]'}${isDragging ? ' shadow-md' : ''}`}
    >
      <div className="json-pipeline-item-header grid min-w-0 select-none grid-cols-[28px_24px_minmax(0,1fr)_28px_28px] items-center gap-2">
        <Button
          ref={setActivatorNodeRef}
          variant="ghost"
          size="icon-sm"
          className="json-pipeline-drag flex-none cursor-grab touch-none text-muted-foreground"
          {...attributes}
          {...listeners}
          aria-label={t('jsonTool.pipeline.drag')}
          title={t('jsonTool.pipeline.drag')}
        >
          <DotsSixVertical size={14} weight="duotone" />
        </Button>
        <span className="json-pipeline-index w-6 min-w-6 text-center font-mono text-[10px] font-medium leading-none text-muted-foreground">
          {String(index + 1).padStart(2, '0')}
        </span>
        <PipelineSelect
          label={t('jsonTool.pipeline.type')}
          value={item.type}
          options={typeOptions.map((type) => ({ key: type, label: labels[type] }))}
          onSelect={(value) => onTypeChange(item, value as PipelineItemType)}
          className="json-pipeline-type w-full min-w-0 justify-self-stretch"
        />
        <Switch
          size="sm"
          className="json-pipeline-enabled flex-none justify-self-end"
          checked={item.enabled}
          onCheckedChange={(checked) => onUpdate(item.id, { enabled: checked })}
          aria-label={t('jsonTool.pipeline.enableItem')}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="json-pipeline-delete flex-none text-muted-foreground"
          onClick={() => onRemove(item.id)}
          aria-label={t('jsonTool.pipeline.delete')}
          title={t('jsonTool.pipeline.delete')}
        >
          <Trash size={14} weight="duotone" />
        </Button>
      </div>
      <div className="json-pipeline-item-body min-w-0 pt-3">
        {item.type === 'extract' && (
          <PathField
            label={t('jsonTool.pipeline.path')}
            value={item.path}
            placeholder={t('jsonTool.pipeline.pathPlaceholder')}
            onChange={(value) => onUpdate(item.id, { path: value })}
            theme={theme}
            itemId={item.id}
            field="path"
            completionRef={completionRef}
            onCreate={(view) => onFirstEditorCreate(item.id, view)}
          />
        )}{' '}
        {item.type === 'sort' && (
          <div className="json-pipeline-inline-fields grid grid-cols-2 gap-x-2 gap-y-2.5 @max-[520px]/pipeline-rules:grid-cols-1">
            <SelectField
              label={t('jsonTool.pipeline.sortMode')}
              value={item.sortMode}
              options={[
                { key: 'key', label: t('jsonTool.sortByKey') },
                { key: 'value', label: t('jsonTool.sortByValue') },
              ]}
              onSelect={(value) => onUpdate(item.id, { sortMode: value as PipelineSortMode })}
            />
            <SelectField
              label={t('jsonTool.pipeline.direction')}
              value={item.direction}
              options={[
                { key: 'asc', label: t('jsonTool.sortOrderAsc') },
                { key: 'desc', label: t('jsonTool.sortOrderDesc') },
              ]}
              onSelect={(value) => onUpdate(item.id, { direction: value as PipelineDirection })}
            />
          </div>
        )}{' '}
        {item.type === 'arraySort' && (
          <div className="json-pipeline-fields grid grid-cols-2 gap-x-2 gap-y-2.5 @max-[520px]/pipeline-rules:grid-cols-1">
            <PathField
              label={t('jsonTool.pipeline.arrayPath')}
              value={item.arrayPath}
              placeholder={t('jsonTool.pipeline.arrayPathPlaceholder')}
              onChange={(value) => onUpdate(item.id, { arrayPath: value })}
              theme={theme}
              itemId={item.id}
              field="arrayPath"
              completionRef={completionRef}
              onCreate={(view) => onFirstEditorCreate(item.id, view)}
            />
            <PathField
              label={t('jsonTool.pipeline.itemPath')}
              value={item.itemPath}
              placeholder={t('jsonTool.pipeline.itemPathPlaceholder')}
              onChange={(value) => onUpdate(item.id, { itemPath: value })}
              theme={theme}
              itemId={item.id}
              field="itemPath"
              completionRef={completionRef}
            />
            <SelectField
              label={t('jsonTool.pipeline.direction')}
              value={item.direction}
              options={[
                { key: 'asc', label: t('jsonTool.sortOrderAsc') },
                { key: 'desc', label: t('jsonTool.sortOrderDesc') },
              ]}
              onSelect={(value) => onUpdate(item.id, { direction: value as PipelineDirection })}
            />
          </div>
        )}{' '}
        {item.type === 'filter' && (
          <div className="json-pipeline-fields grid grid-cols-2 gap-x-2 gap-y-2.5 @max-[520px]/pipeline-rules:grid-cols-1">
            <PathField
              label={t('jsonTool.pipeline.arrayPath')}
              value={item.arrayPath}
              placeholder={t('jsonTool.pipeline.arrayPathPlaceholder')}
              onChange={(value) => onUpdate(item.id, { arrayPath: value })}
              theme={theme}
              itemId={item.id}
              field="arrayPath"
              completionRef={completionRef}
              onCreate={(view) => onFirstEditorCreate(item.id, view)}
            />
            <PathField
              label={t('jsonTool.pipeline.itemPath')}
              value={item.itemPath}
              placeholder={t('jsonTool.pipeline.itemPathPlaceholder')}
              onChange={(value) => onUpdate(item.id, { itemPath: value })}
              theme={theme}
              itemId={item.id}
              field="itemPath"
              completionRef={completionRef}
            />
            <SelectField
              label={t('jsonTool.pipeline.operator')}
              value={item.operator}
              options={filterOperators.map((operator) => ({
                key: operator,
                label: t(`jsonTool.pipeline.operators.${operator}`),
              }))}
              onSelect={(value) => onUpdate(item.id, { operator: value as PipelineFilterOperator })}
              className={
                unaryFilterOperators.includes(item.operator)
                  ? 'col-span-2 @max-[520px]/pipeline-rules:col-span-1'
                  : ''
              }
            />
            {!unaryFilterOperators.includes(item.operator) ? (
              <PathField
                label={
                  item.operator.startsWith('stringLength')
                    ? t('jsonTool.pipeline.filterLength')
                    : listOperator
                      ? t('jsonTool.pipeline.filterList')
                      : t('jsonTool.pipeline.filterValue')
                }
                value={item.filterValue}
                placeholder={
                  item.operator.startsWith('stringLength')
                    ? t('jsonTool.pipeline.filterLengthPlaceholder')
                    : listOperator
                      ? t('jsonTool.pipeline.filterListPlaceholder')
                      : undefined
                }
                onChange={(value) => onUpdate(item.id, { filterValue: value })}
                theme={theme}
                itemId={item.id}
                field="filterValue"
                completionRef={completionRef}
              />
            ) : null}
          </div>
        )}{' '}
        {item.type === 'arrayDedupe' && (
          <div className="json-pipeline-fields grid grid-cols-2 gap-x-2 gap-y-2.5 @max-[520px]/pipeline-rules:grid-cols-1">
            <PathField
              label={t('jsonTool.pipeline.arrayPath')}
              value={item.arrayPath}
              placeholder={t('jsonTool.pipeline.arrayPathPlaceholder')}
              onChange={(value) => onUpdate(item.id, { arrayPath: value })}
              theme={theme}
              itemId={item.id}
              field="arrayPath"
              completionRef={completionRef}
              onCreate={(view) => onFirstEditorCreate(item.id, view)}
            />
            <PathField
              label={t('jsonTool.pipeline.dedupeItemPath')}
              value={item.itemPath}
              placeholder={t('jsonTool.pipeline.dedupeItemPathPlaceholder')}
              onChange={(value) => onUpdate(item.id, { itemPath: value })}
              theme={theme}
              itemId={item.id}
              field="itemPath"
              completionRef={completionRef}
            />
          </div>
        )}{' '}
        {item.type === 'arrayTrim' && (
          <div className="json-pipeline-fields grid grid-cols-2 gap-x-2 gap-y-2.5 @max-[520px]/pipeline-rules:grid-cols-1">
            <PathField
              label={t('jsonTool.pipeline.arrayPath')}
              value={item.arrayPath}
              placeholder={t('jsonTool.pipeline.arrayPathPlaceholder')}
              onChange={(value) => onUpdate(item.id, { arrayPath: value })}
              theme={theme}
              itemId={item.id}
              field="arrayPath"
              completionRef={completionRef}
              onCreate={(view) => onFirstEditorCreate(item.id, view)}
            />
            <SelectField
              label={t('jsonTool.pipeline.matchMode')}
              value={item.matchMode}
              options={[
                { key: 'key', label: t('jsonTool.pipeline.matchModes.key') },
                { key: 'value', label: t('jsonTool.pipeline.matchModes.value') },
              ]}
              onSelect={(value) => onUpdate(item.id, { matchMode: value as PipelineMatchMode })}
            />
            <PathField
              label={
                item.matchMode === 'value'
                  ? t('jsonTool.pipeline.trimValues')
                  : t('jsonTool.pipeline.trimKeys')
              }
              value={item.filterValue}
              placeholder={t('jsonTool.pipeline.trimValuesPlaceholder')}
              onChange={(value) => onUpdate(item.id, { filterValue: value })}
              theme={theme}
              itemId={item.id}
              field="filterValue"
              completionRef={completionRef}
              className="col-span-2 @max-[520px]/pipeline-rules:col-span-1"
            />
          </div>
        )}{' '}
        {item.type === 'template' && (
          <PathField
            label={t('jsonTool.pipeline.template')}
            value={item.template}
            placeholder={t('jsonTool.pipeline.templatePlaceholder')}
            onChange={(value) => onUpdate(item.id, { template: value })}
            theme={theme}
            itemId={item.id}
            field="template"
            completionRef={completionRef}
            template
            onCreate={(view) => onFirstEditorCreate(item.id, view)}
          />
        )}{' '}
      </div>
    </div>
  );
}

export function PipelineOutputPane({
  evaluation,
  theme,
  foldExt,
  active,
  timeFormat,
}: {
  evaluation: PipelineEvaluation;
  theme: Extension;
  foldExt: Extension;
  active: boolean;
  timeFormat: JsonTimeFormat;
}) {
  const { t } = useTranslation();
  const [outputTableMode, setOutputTableMode] = useState(false);
  const [tablePage, setTablePage] = useState<PipelineTablePage | null>(null);
  const [tableRows, setTableRows] = useState<unknown[]>([]);
  const [tableLoading, setTableLoading] = useState(false);
  const output = evaluation.previewText;
  const error = evaluation.status === 'error' ? evaluation.error : null;
  const loading = evaluation.status === 'loading';
  const canTable =
    evaluation.status === 'ok' && evaluation.format === 'json' && !!evaluation.resultID;
  const smallOutput = evaluation.previewComplete && canTable;
  const smallPreview = useMemo(() => {
    if (!smallOutput) return { valid: false, value: null };
    try {
      return { valid: true, value: parseJsonLoose(output) };
    } catch {
      return { valid: false, value: null };
    }
  }, [output, smallOutput]);
  useEffect(() => {
    if (outputTableMode && !canTable) setOutputTableMode(false);
  }, [canTable, outputTableMode]);
  useEffect(() => {
    if (outputTableMode) {
      setTablePage(null);
      setTableRows([]);
    }
  }, [evaluation.resultID, outputTableMode]);
  const loadTablePage = async (offset: number) => {
    if (!evaluation.resultID) return;
    setTableLoading(true);
    try {
      const page = await ReadPipelineTablePage({
        resultID: evaluation.resultID,
        offset,
        limit: 200,
      });
      if (page.expired || page.invalid) return;
      const parsed = JSON.parse(page.rowsJSON || '[]') as unknown[];
      setTablePage(page);
      setTableRows((current) => (offset === 0 ? parsed : [...current, ...parsed]));
    } catch {
      // 结果过期或后端不可用时保持当前表格。
    } finally {
      setTableLoading(false);
    }
  };
  useEffect(() => {
    if (outputTableMode && evaluation.resultID && !smallOutput && tablePage === null)
      void loadTablePage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputTableMode, evaluation.resultID, smallOutput, tablePage]);
  return (
    <section className="json-pipeline-output json-pane flex h-full min-h-0 min-w-0 flex-col gap-2">
      <span className="json-pane-label flex-none font-mono text-[10px] font-medium leading-none tracking-[.04em] text-muted-foreground uppercase">
        {t('jsonTool.pipeline.output')}
      </span>
      <div className="json-pipeline-output-field json-pane-editor relative flex min-h-0 min-w-0 flex-1">
        <Button
          type="button"
          variant={outputTableMode ? 'secondary' : 'ghost'}
          size="icon-sm"
          className="json-table-toggle absolute top-2 right-2 z-20"
          aria-label={t('jsonTool.tablePreview')}
          title={t(outputTableMode ? 'jsonTool.tablePreviewOn' : 'jsonTool.tablePreview')}
          onClick={() => {
            if (!canTable) {
              toast.add({ title: t('jsonTool.tablePreviewNotJson'), type: 'warning' });
              return;
            }
            setOutputTableMode((current) => !current);
          }}
        >
          <TableIcon weight="duotone" />
        </Button>
        {error ? (
          <JsonErrorPanel
            title={t('jsonTool.pipeline.errorTitle')}
            description={t(`jsonTool.pipeline.errors.${error.code}`)}
            item={
              error.item !== undefined
                ? t('jsonTool.pipeline.errorItem', {
                    item: String(error.item + 1).padStart(2, '0'),
                  })
                : undefined
            }
            path={
              error.path
                ? { label: t('jsonTool.pipeline.errorPath'), value: error.path }
                : undefined
            }
          />
        ) : (
          <CodeMirror
            className="json-cm json-pipeline-cm"
            height="100%"
            value={output}
            editable={false}
            theme={theme}
            extensions={evaluation.previewComplete ? [json5(), foldExt] : [foldExt]}
            onCreateEditor={(view) =>
              view.contentDOM.setAttribute('aria-label', t('jsonTool.pipeline.output'))
            }
          />
        )}
        {!error && (
          <div
            className={`json-table-layer${outputTableMode ? ' is-visible' : ''}`}
            aria-hidden={!outputTableMode}
            {...(!outputTableMode ? { inert: true } : {})}
          >
            {smallOutput && smallPreview.valid ? (
              <JsonTablePreview
                value={smallPreview.value}
                t={t}
                active={active && outputTableMode}
                timeFormat={timeFormat}
              />
            ) : (
              <div className="json-table-scroll">
                <table className="json-table-data">
                  <thead>
                    <tr>
                      {(tablePage?.columns ?? []).map((column) => (
                        <th key={column} className="json-table-key">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {(tablePage?.columns ?? []).map((column) => {
                          const value = (row as Record<string, unknown>)?.[column];
                          const formattedTime =
                            active && outputTableMode
                              ? formatJsonTimeValue(column, value, timeFormat)
                              : null;
                          return (
                            <td
                              key={column}
                              title={formattedTime !== null ? String(value) : undefined}
                            >
                              {formattedTime ??
                                (typeof value === 'string'
                                  ? value
                                  : JSON.stringify(value, null, 0))}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tablePage && !tablePage.complete ? (
                  <div className="flex justify-center p-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={tableLoading}
                      onClick={() => void loadTablePage(tablePage.nextOffset)}
                    >
                      {t('jsonTool.pipeline.loadMore')}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
        {loading ? (
          <div className="json-pipeline-loading absolute inset-0 z-30 flex items-center justify-center bg-background/60">
            <Spinner />
          </div>
        ) : null}
        {!evaluation.previewComplete && !error ? (
          <span className="absolute right-2 bottom-1 z-20 text-[10px] text-muted-foreground">
            {t('jsonTool.pipeline.truncated', {
              bytes: evaluation.totalBytes,
              lines: evaluation.totalLines,
            })}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function PipelinePanel({
  rules,
  context,
  theme,
  onChange,
  onRemove,
  onMove,
  focusItemId,
  onFocusHandled,
}: {
  rules: PipelineItem[];
  context: PipelineCompletionContext;
  theme: Extension;
  onChange: (update: PipelineItem[] | ((rules: PipelineItem[]) => PipelineItem[])) => void;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
  focusItemId: string | null;
  onFocusHandled: () => void;
}) {
  const { t } = useTranslation();
  const completionRef = useRef<PipelineCompletionContext>(context);
  completionRef.current = context;
  const [listViewport, setListViewport] = useState<HTMLElement | null>(null);
  const editorViews = useRef(new Map<string, EditorView>());
  const focusItemIdRef = useRef(focusItemId);
  focusItemIdRef.current = focusItemId;
  const hasTemplate = rules.some((item) => item.type === 'template');
  const labels = {
    extract: t('jsonTool.pipeline.types.extract'),
    sort: t('jsonTool.pipeline.types.sort'),
    arraySort: t('jsonTool.pipeline.types.arraySort'),
    filter: t('jsonTool.pipeline.types.filter'),
    arrayDedupe: t('jsonTool.pipeline.types.arrayDedupe'),
    arrayTrim: t('jsonTool.pipeline.types.arrayTrim'),
    template: t('jsonTool.pipeline.types.template'),
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const update = (id: string, patch: Partial<PipelineItem>) =>
    onChange((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const updateType = (item: PipelineItem, type: PipelineItemType) => {
    if (type === 'template' && hasTemplate && item.type !== 'template') return;
    if (type !== 'template') {
      update(item.id, { type });
      return;
    }
    onChange((current) => {
      const next = current.map((currentItem) =>
        currentItem.id === item.id ? { ...currentItem, type } : currentItem,
      );
      const changed = next.find((currentItem) => currentItem.id === item.id);
      if (!changed) return current;
      return [...next.filter((currentItem) => currentItem.id !== item.id), changed];
    });
  };
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= rules.length) return;
    onMove(from, to);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = rules.findIndex((item) => item.id === String(active.id));
    const to = rules.findIndex((item) => item.id === String(over.id));
    move(from, to);
  };
  const focusAddedItem = (id: string, view: EditorView) => {
    editorViews.current.set(id, view);
    if (focusItemIdRef.current !== id) return;
    if (!listViewport) return;
    listViewport.scrollTop = listViewport.scrollHeight;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
    onFocusHandled();
  };
  useLayoutEffect(() => {
    if (!focusItemId) return;
    const view = editorViews.current.get(focusItemId);
    if (view) focusAddedItem(focusItemId, view);
  }, [focusItemId, listViewport]);
  return (
    <section className="json-pipeline-rules flex h-full min-h-0 min-w-0 flex-col gap-2 [container-name:pipeline-rules] [container-type:inline-size]">
      <span className="json-pane-label flex-none font-mono text-[10px] font-medium leading-none tracking-[.04em] text-muted-foreground uppercase">
        {t('jsonTool.pipeline.rules')}
      </span>
      {rules.length === 0 ? (
        <Empty className="json-pipeline-empty min-h-[74px] flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Queue weight="duotone" />
            </EmptyMedia>
            <EmptyTitle>{t('jsonTool.pipeline.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea
          className="json-pipeline-list min-h-0 flex-1 [padding-inline-end:var(--overlay-scrollbar-size)]"
          scrollFade="y"
          options={{ overflow: { x: 'hidden' } }}
          onViewport={setListViewport}
        >
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={rules.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-2">
                {rules.map((item, index) => (
                  <PipelineRuleRow
                    key={item.id}
                    item={item}
                    index={index}
                    labels={labels}
                    theme={theme}
                    completionRef={completionRef}
                    onUpdate={update}
                    onTypeChange={updateType}
                    onRemove={onRemove}
                    onFirstEditorCreate={focusAddedItem}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </ScrollArea>
      )}
    </section>
  );
}

export { newPipelineItem };
