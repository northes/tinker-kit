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
import { Button } from './ui/button';
import { createJsonTableExpansion, jsonTableChildPath } from '../lib/json-table-expansion';
import { formatJsonTimeValue, type JsonTimeFormat } from '../lib/json-time-format';

type Props = { value: unknown; t: (key: string) => string };
type ValueProps = Props & { path: string };
const ExpansionContext = createContext<ReturnType<typeof createJsonTableExpansion> | null>(null);
const TimeFormatContext = createContext<JsonTimeFormat>('none');
const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null && typeof value === 'object';

const isObjectArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item));

function scalar(value: unknown, t: Props['t']) {
  if (value === null) return <span className="json-table-null">null</span>;
  if (typeof value === 'string')
    return <span className="json-table-string">&quot;{value}&quot;</span>;
  if (typeof value === 'boolean')
    return <span className="json-table-boolean">{String(value)}</span>;
  if (typeof value === 'number') return <span className="json-table-number">{String(value)}</span>;
  return <span className="text-muted-foreground">{t('jsonTool.tablePreviewUnsupported')}</span>;
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
    return (
      <TableCell
        className={numeric && formattedTime === null ? 'is-numeric' : undefined}
        title={formattedTime !== null ? String(value) : undefined}
      >
        {formattedTime ?? scalar(value, t)}
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
        {expanded ? <CaretDown weight="duotone" /> : <CaretRight />}
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
        {entries.map(([key, item]) => (
          <TableRow key={key}>
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
  const keys = useMemo(() => [...new Set(value.flatMap((row) => Object.keys(row)))], [value]);
  const numericKeys = useMemo(() => {
    const numeric = new Set<string>();
    for (const key of keys) {
      let seenNumber = false;
      let allNumeric = true;
      for (const row of value) {
        const item = row[key];
        if (item === undefined || item === null) continue;
        if (typeof item === 'number') seenNumber = true;
        else {
          allNumeric = false;
          break;
        }
      }
      if (seenNumber && allNumeric) numeric.add(key);
    }
    return numeric;
  }, [keys, value]);
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
      ...keys.map((key) => ({
        accessorKey: key,
        header: key,
        cell: ({ row }) => (
          <ValueCell
            value={row.original[key]}
            t={t}
            path={jsonTableChildPath(jsonTableChildPath(path, row.index), key)}
            numeric={numericKeys.has(key)}
            fieldKey={key}
          />
        ),
      })),
    ],
    [keys, numericKeys, path, t],
  );
  const table = useReactTable({ data: value, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <div className="json-table-scroll">
      <Table containerClassName="overflow-x-visible" className="json-table-data">
        <TableHeader className={stickyHeader ? 'sticky top-0 z-10 bg-card' : 'bg-card'}>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={numericKeys.has(header.column.id) ? 'is-numeric' : undefined}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row
                .getVisibleCells()
                .map((cell) =>
                  cell.column.id === '__rowIndex' ? (
                    <TableCell key={cell.id}>
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
    </div>
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
      <div className="json-table-preview">
        <KeyValue value={value} t={t} path="" />
      </div>
    );
  }
  if (Object.keys(value).length === 0)
    return (
      <div className="json-table-preview json-table-empty">
        {t('jsonTool.tablePreviewEmptyObject')}
      </div>
    );
  return (
    <div className="json-table-preview">
      <KeyValue value={value} t={t} path="" />
    </div>
  );
}

export function JsonTablePreview({
  value,
  t,
  active,
  timeFormat,
}: Props & { active: boolean; timeFormat: JsonTimeFormat }) {
  const [expansion] = useState(createJsonTableExpansion);
  // 只保留轻量展开记录，隐藏和等待检测时不构建表格及其行模型。
  if (!active) return null;
  return (
    <ExpansionContext.Provider value={expansion}>
      <TimeFormatContext.Provider value={timeFormat}>
        <TableValue value={value} t={t} />
      </TimeFormatContext.Provider>
    </ExpansionContext.Provider>
  );
}
