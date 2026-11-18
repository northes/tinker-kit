import { Fragment, useRef, type ReactNode } from 'react';
import { CaretDown, CaretUp, CaretUpDown, Funnel } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { ToolSearchField, toolHeaderControlClassName } from './shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { TableHead } from './ui/table';

export const MIN_COLUMN_WIDTH = 56;
export const MAX_COLUMN_WIDTH = 800;

export const clampColumnWidth = (width: number) =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));

// 后端只保存宽度数组；列含义由前端列定义决定，越界或缺失时回退默认宽度。
export function resolveColumnWidths<Key extends string>(
  columns: readonly Key[],
  defaults: Record<Key, number>,
  stored?: number[] | null,
) {
  return columns.map((column, index) => clampColumnWidth(stored?.[index] ?? defaults[column]));
}

export type SortDirection = 'asc' | 'desc';

// 表头同时承载列排序与列宽拖动：右侧把手用指针捕获拖动，也支持左右方向键微调，
// 松手或按键抬起时由父组件把列宽写回配置。
export function SortableHead({
  label,
  active,
  direction,
  onSort,
  width,
  onResize,
  onResizeEnd,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  width: number;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
}) {
  const { t } = useTranslation();
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  return (
    <TableHead
      className="relative"
      style={{ width }}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 px-2 text-xs font-medium"
        aria-label={t('portTool.sortBy', {
          column: label,
          direction: active
            ? t(direction === 'asc' ? 'portTool.sortAscending' : 'portTool.sortDescending')
            : t('portTool.sortNotActive'),
        })}
        onClick={onSort}
      >
        {label}
        {active ? (
          direction === 'asc' ? (
            <CaretUp aria-hidden="true" />
          ) : (
            <CaretDown aria-hidden="true" />
          )
        ) : (
          <CaretUpDown aria-hidden="true" />
        )}
      </Button>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={t('portTool.resizeColumn', { column: label })}
        aria-valuenow={width}
        aria-valuemin={MIN_COLUMN_WIDTH}
        aria-valuemax={MAX_COLUMN_WIDTH}
        aria-keyshortcuts="ArrowLeft ArrowRight"
        tabIndex={0}
        className="absolute inset-y-1 right-0 z-10 w-2 cursor-col-resize touch-none select-none rounded-full bg-transparent hover:bg-border focus-visible:bg-primary focus-visible:outline-none active:bg-primary"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStart.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          const start = dragStart.current;
          if (!start) return;
          onResize(clampColumnWidth(start.width + event.clientX - start.x));
        }}
        onPointerUp={(event) => {
          if (!dragStart.current) return;
          dragStart.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          onResizeEnd();
        }}
        onPointerCancel={() => {
          dragStart.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          onResize(clampColumnWidth(width + (event.key === 'ArrowRight' ? 16 : -16)));
        }}
        onKeyUp={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') onResizeEnd();
        }}
      />
    </TableHead>
  );
}

export type FilterGroup = {
  key: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
};

// 次要筛选集中到一个下拉菜单，头部只保留来源、搜索、刷新等高频控件。
export function FilterMenu({ label, groups }: { label: string; groups: FilterGroup[] }) {
  const { t } = useTranslation();
  // 每个分组的第一项是默认值（全部），其余取值计为已启用筛选。
  const activeCount = groups.filter(
    (group) => group.value !== (group.options[0]?.value ?? ''),
  ).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="flex-none"
            aria-label={activeCount ? t('portTool.filtersActive', { total: activeCount }) : label}
          />
        }
      >
        <Funnel data-icon="inline-start" weight="regular" />
        {label}
        {activeCount ? <Badge variant="secondary">{activeCount}</Badge> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {groups.map((group, index) => (
          <Fragment key={group.key}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={group.value} onValueChange={group.onChange}>
                {group.options.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SearchField({
  id,
  label,
  placeholder,
  draft,
  onDraftChange,
  onSearch,
}: {
  id: string;
  label: string;
  placeholder: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSearch: (value: string) => void;
}) {
  return (
    <ToolSearchField
      id={id}
      label={label}
      placeholder={placeholder}
      value={draft}
      onValueChange={onDraftChange}
      onSubmit={onSearch}
      className={toolHeaderControlClassName}
    />
  );
}

export function PortListFrame({ children }: { children: ReactNode }) {
  // 去掉工具内标签后，这一层自己接上原来 Tabs + TabsContent 的高度链。
  return <div className="flex h-full min-h-0 flex-col gap-2 p-1 text-sm">{children}</div>;
}
