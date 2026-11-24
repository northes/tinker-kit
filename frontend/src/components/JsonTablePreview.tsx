import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { createJsonTableExpansion, jsonTableChildPath } from '../lib/json-table-expansion';
import {
  getJsonTableCellValue,
  jsonTableNumericColumnKeys,
  planJsonTableColumns,
  type JsonTableColumnPlan,
} from '../lib/json-table-pivot';
import { formatJsonTimeValue, type JsonTimeFormat } from '../lib/json-time-format';

type Props = { value: unknown; t: (key: string) => string };
type ValueProps = Props & { path: string };
const ExpansionContext = createContext<ReturnType<typeof createJsonTableExpansion> | null>(null);
const TimeFormatContext = createContext<JsonTimeFormat>('none');
const FlattenKeyValueContext = createContext(false);

function columnPlanId(column: JsonTableColumnPlan): string {
  return column.kind === 'field' ? column.field : column.header;
}
const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null && typeof value === 'object';

const isObjectArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item));

function scalar(value: unknown, t: Props['t']) {
  if (value === null) return <span className="json-table-null">—</span>;
  if (typeof value === 'string')
    return <span className="json-table-string json-table-leaf-text">{value}</span>;
  if (typeof value === 'boolean')
    return <span className="json-table-boolean json-table-leaf-text">{String(value)}</span>;
  if (typeof value === 'number')
    return <span className="json-table-number json-table-leaf-text">{String(value)}</span>;
  return (
    <span className="json-table-leaf-text text-muted-foreground">
      {t('jsonTool.tablePreviewUnsupported')}
    </span>
  );
}

function leafValueTitle(value: unknown, formattedTime: string | null): string | undefined {
  if (formattedTime !== null) return String(value);
  if (value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function stopToggle(event: MouseEvent) {
  event.stopPropagation();
}

function ValueCell({
  value,
  t,
  path,
  depth = 0,
  numeric = false,
  fieldKey,
}: ValueProps & { depth?: number; numeric?: boolean; fieldKey?: string }) {
  const timeFormat = useContext(TimeFormatContext);
  if (!isContainer(value)) {
    const formattedTime = formatJsonTimeValue(fieldKey, value, timeFormat);
    const display =
      formattedTime !== null ? (
        <span className="json-table-leaf-text">{formattedTime}</span>
      ) : (
        scalar(value, t)
      );
    return (
      <TableCell
        className={numeric && formattedTime === null ? 'is-numeric' : undefined}
        title={leafValueTitle(value, formattedTime)}
      >
        {display}
      </TableCell>
    );
  }
  return <ContainerCell value={value} t={t} path={path} depth={depth} />;
}

function ContainerCell({ value, t, path, depth }: ValueProps & { depth: number }) {
  const expansion = useContext(ExpansionContext);
  if (!expansion) throw new Error('JSON 表格缺少展开状态上下文');
  const subscribe = useCallback(
    (listener: () => void) => expansion.subscribe(path, listener),
    [expansion, path],
  );
  const getSnapshot = () => expansion.isExpanded(path);
  const expanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const toggle = (event: MouseEvent) => {
    stopToggle(event);
    expansion.toggle(path);
  };
  return (
    <TableCell className="json-table-collapsible" onClick={toggle}>
      <NestedValue
        value={value}
        t={t}
        path={path}
        depth={depth}
        expanded={expanded}
        onToggle={toggle}
      />
    </TableCell>
  );
}

function NestedValue({
  value,
  t,
  path,
  depth = 0,
  expanded,
  onToggle,
}: ValueProps & { depth?: number; expanded: boolean; onToggle: (event: MouseEvent) => void }) {
  const isArray = Array.isArray(value);
  const size = isArray ? value.length : Object.keys(value as Record<string, unknown>).length;
  const label = isArray
    ? `[${size} ${t('jsonTool.tablePreviewItems')}]`
    : `{${size} ${t('jsonTool.tablePreviewKeys')}}`;
  return (
    <div className="json-table-nested">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="mr-1 align-middle"
        aria-label={
          expanded ? t('jsonTool.tablePreviewCollapse') : t('jsonTool.tablePreviewExpand')
        }
        title={expanded ? t('jsonTool.tablePreviewCollapse') : t('jsonTool.tablePreviewExpand')}
        onClick={onToggle}
      >
        {expanded ? <CaretDown weight="regular" /> : <CaretRight />}
      </Button>
      <span className="json-table-container-label">{label}</span>
      {expanded && size > 0 && (
        <div className="json-table-child" onClick={stopToggle}>
          {isArray && isObjectArray(value) ? (
            <ObjectArray
              value={value as Record<string, unknown>[]}
              t={t}
              path={path}
              stickyHeader={false}
            />
          ) : (
            <KeyValue value={value} t={t} path={path} depth={depth + 1} />
          )}
        </div>
      )}
    </div>
  );
}

function KeyValue({ value, t, path, depth = 0 }: ValueProps & { depth?: number }) {
  const entries = Array.isArray(value)
    ? value.map((item, i) => [String(i), item] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <Table containerClassName="overflow-x-visible" className="json-table-key-value">
      <TableBody>
        {/* 行间线与 hover 由 json.css 处理；斑马纹限定 :not(:hover) 以免压过 hover 单元格底色 */}
        {entries.map(([key, item], index) => (
          <TableRow
            key={key}
            className={
              index % 2 === 1
                ? '[&:not(:hover)>:is(td,th)]:bg-muted/30 [&:not(:hover)>:first-child]:rounded-l-md [&:not(:hover)>:last-child]:rounded-r-md'
                : undefined
            }
          >
            <TableHead className="json-table-key">{key}</TableHead>
            <ValueCell
              value={item}
              t={t}
              path={jsonTableChildPath(path, key)}
              depth={depth}
              fieldKey={Array.isArray(value) ? undefined : key}
            />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ObjectArray({
  value,
  t,
  path,
  stickyHeader = true,
}: ValueProps & { value: Record<string, unknown>[]; stickyHeader?: boolean }) {
  const flattenKeyValueColumns = useContext(FlattenKeyValueContext);
  const columnPlan = useMemo(
    () => planJsonTableColumns(value, flattenKeyValueColumns),
    [value, flattenKeyValueColumns],
  );
  const numericKeys = useMemo(
    () => jsonTableNumericColumnKeys(value, columnPlan),
    [value, columnPlan],
  );
  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () => [
      {
        id: '__rowIndex',
        header: '',
        cell: ({ row }) => <span className="json-table-row-index">{row.index}</span>,
        size: 32,
        enableSorting: false,
        enableHiding: false,
      },
      ...columnPlan.map((plan) => {
        const columnId = columnPlanId(plan);
        const fieldKey = plan.kind === 'field' ? plan.field : plan.fieldKey;
        const cellPathKey = plan.kind === 'field' ? plan.field : plan.arrayField;
        return {
          id: columnId,
          accessorKey: plan.kind === 'field' ? plan.field : columnId,
          header: plan.kind === 'field' ? plan.field : plan.header,
          cell: ({ row }) => (
            <ValueCell
              value={getJsonTableCellValue(row.original, plan)}
              t={t}
              path={jsonTableChildPath(jsonTableChildPath(path, row.index), cellPathKey)}
              numeric={numericKeys.has(columnId)}
              fieldKey={fieldKey}
            />
          ),
        };
      }),
    ],
    [columnPlan, numericKeys, path, t],
  );
  const table = useReactTable({ data: value, columns, getCoreRowModel: getCoreRowModel() });
  const tableView = (
    <Table containerClassName="overflow-x-visible" className="json-table-data">
      <TableHeader className={stickyHeader ? 'sticky top-0 z-10 bg-card' : 'bg-card'}>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead
                key={header.id}
                className={
                  header.column.id !== '__rowIndex' && numericKeys.has(header.column.id)
                    ? 'is-numeric'
                    : undefined
                }
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {/* 与 KeyValue 相同：不写 border-b-0，斑马纹与 json.css hover 共存 */}
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className={
              row.index % 2 === 1
                ? '[&:not(:hover)>:is(td,th)]:bg-muted/30 [&:not(:hover)>:first-child]:rounded-l-md [&:not(:hover)>:last-child]:rounded-r-md'
                : undefined
            }
          >
            {row.getVisibleCells().map((cell) =>
              cell.column.id === '__rowIndex' ? (
                <TableCell key={cell.id} className="json-table-row-index-cell">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ) : (
                <Fragment key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </Fragment>
              ),
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  // 嵌套子表在 .json-table-child 里展开，不接管滚动，也不要边缘渐变。
  if (!stickyHeader) return <div className="json-table-scroll">{tableView}</div>;
  return (
    <ScrollArea className="json-table-scroll" edgeOverlay edgeOverlayTopClass="top-10">
      {tableView}
    </ScrollArea>
  );
}

function TableValue({ value, t }: Props) {
  if (value === null || typeof value !== 'object')
    return <div className="json-table-preview json-table-scalar">{scalar(value, t)}</div>;
  if (Array.isArray(value)) {
    if (value.length === 0)
      return (
        <div className="json-table-preview json-table-empty">
          {t('jsonTool.tablePreviewEmptyArray')}
        </div>
      );
    if (isObjectArray(value)) return <ObjectArray value={value} t={t} path="" />;
    return (
      <ScrollArea className="json-table-preview" edgeOverlay>
        <KeyValue value={value} t={t} path="" />
      </ScrollArea>
    );
  }
  if (Object.keys(value).length === 0)
    return (
      <div className="json-table-preview json-table-empty">
        {t('jsonTool.tablePreviewEmptyObject')}
      </div>
    );
  return (
    <ScrollArea className="json-table-preview" edgeOverlay>
      <KeyValue value={value} t={t} path="" />
    </ScrollArea>
  );
}

export function JsonTablePreview({
  value,
  t,
  active,
  timeFormat,
  flattenKeyValueColumns = false,
}: Props & {
  active: boolean;
  timeFormat: JsonTimeFormat;
  flattenKeyValueColumns?: boolean;
}) {
  const [expansion] = useState(createJsonTableExpansion);
  // 只保留轻量展开记录，隐藏和等待检测时不构建表格及其行模型。
  if (!active) return null;
  return (
    <ExpansionContext.Provider value={expansion}>
      <TimeFormatContext.Provider value={timeFormat}>
        <FlattenKeyValueContext.Provider value={flattenKeyValueColumns}>
          <TableValue value={value} t={t} />
        </FlattenKeyValueContext.Provider>
      </TimeFormatContext.Provider>
    </ExpansionContext.Provider>
  );
}
