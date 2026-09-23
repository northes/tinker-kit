import { Fragment, useMemo, useState, type MouseEvent } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Button } from './ui/button';

type Props = { value: unknown; t: (key: string) => string };
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
  depth = 0,
  numeric = false,
}: Props & { depth?: number; numeric?: boolean }) {
  const collapsible = isContainer(value);
  const [expanded, setExpanded] = useState(false);
  const toggle = (event: MouseEvent) => {
    stopToggle(event);
    setExpanded((current) => !current);
  };
  return (
    <TableCell
      className={collapsible ? 'json-table-collapsible' : numeric ? 'is-numeric' : undefined}
      onClick={collapsible ? toggle : undefined}
    >
      {collapsible ? (
        <NestedValue value={value} t={t} depth={depth} expanded={expanded} onToggle={toggle} />
      ) : (
        scalar(value, t)
      )}
    </TableCell>
  );
}

function NestedValue({
  value,
  t,
  depth = 0,
  expanded,
  onToggle,
}: Props & { depth?: number; expanded: boolean; onToggle: (event: MouseEvent) => void }) {
  const isArray = Array.isArray(value);
  const entries = isArray
    ? value.map((item, i) => [String(i), item] as const)
    : Object.entries(value as Record<string, unknown>);
  const label = isArray
    ? `[${(value as unknown[]).length} ${t('jsonTool.tablePreviewItems')}]`
    : `{${Object.keys(value as Record<string, unknown>).length} ${t('jsonTool.tablePreviewKeys')}}`;
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
        {expanded ? <CaretDown /> : <CaretRight />}
      </Button>
      <span className="json-table-container-label">{label}</span>
      {expanded && entries.length > 0 && (
        <div className="json-table-child" onClick={stopToggle}>
          {isArray && isObjectArray(value) ? (
            <ObjectArray value={value as Record<string, unknown>[]} t={t} stickyHeader={false} />
          ) : (
            <KeyValue value={value} t={t} depth={depth + 1} />
          )}
        </div>
      )}
    </div>
  );
}

function KeyValue({ value, t, depth = 0 }: Props & { depth?: number }) {
  const entries = Array.isArray(value)
    ? value.map((item, i) => [String(i), item] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <Table containerClassName="overflow-x-visible" className="json-table-key-value">
      <TableBody>
        {entries.map(([key, item]) => (
          <TableRow key={key}>
            <TableHead className="json-table-key">{key}</TableHead>
            <ValueCell value={item} t={t} depth={depth} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ObjectArray({
  value,
  t,
  stickyHeader = true,
}: Props & { value: Record<string, unknown>[]; stickyHeader?: boolean }) {
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
          <ValueCell value={row.original[key]} t={t} numeric={numericKeys.has(key)} />
        ),
      })),
    ],
    [keys, numericKeys, t],
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

export function JsonTablePreview({ value, t }: Props) {
  if (value === null || typeof value !== 'object')
    return <div className="json-table-preview json-table-scalar">{scalar(value, t)}</div>;
  if (Array.isArray(value)) {
    if (value.length === 0)
      return (
        <div className="json-table-preview json-table-empty">
          {t('jsonTool.tablePreviewEmptyArray')}
        </div>
      );
    if (isObjectArray(value)) return <ObjectArray value={value} t={t} />;
    return (
      <div className="json-table-preview">
        <KeyValue value={value} t={t} />
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
      <KeyValue value={value} t={t} />
    </div>
  );
}
