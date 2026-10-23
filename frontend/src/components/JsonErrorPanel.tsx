import { WarningCircle } from '@phosphor-icons/react';

export function JsonErrorPanel({
  title,
  description,
  path,
  item,
}: {
  title: string;
  description: string;
  path?: { label: string; value: string };
  item?: string;
}) {
  return (
    <div
      className="json-pipeline-error flex min-h-0 flex-1 overflow-auto rounded-lg border border-[color-mix(in_oklch,var(--destructive)_24%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_3%,var(--card))] p-6 text-[11px] text-foreground"
      role="alert"
    >
      <div className="m-auto grid w-full max-w-[462px] grid-cols-[30px_minmax(0,1fr)] gap-3">
        <div
          className="json-pipeline-error-icon grid size-7 place-items-center rounded-full border border-[color-mix(in_oklch,var(--destructive)_58%,var(--border))] text-destructive"
          aria-hidden="true"
        >
          <WarningCircle size={18} weight="duotone" />
        </div>
        <div className="json-pipeline-error-content grid min-w-0 gap-2 pt-0.5">
          <div className="json-pipeline-error-heading flex min-w-0 flex-wrap items-center gap-[9px] leading-tight">
            <strong className="text-[13px] font-semibold tracking-[-.01em]">{title}</strong>
            {item && (
              <span className="json-pipeline-error-item rounded-[calc(var(--radius)-4px)] border border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_5%,var(--card))] px-1.5 py-1 font-mono text-[10px] font-medium leading-none tracking-[.04em] text-destructive">
                {item}
              </span>
            )}
          </div>
          <p className="json-pipeline-error-message m-0 text-xs leading-6 text-muted-foreground">
            {description}
          </p>
          {path && (
            <div className="json-pipeline-error-path-row grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 pt-0.5 font-mono text-[10px] font-medium leading-none text-muted-foreground">
              <span className="font-sans">{path.label}</span>
              <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-[calc(var(--radius)-4px)] bg-muted px-2 py-1.5 font-inherit text-foreground">
                {path.value}
              </code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
