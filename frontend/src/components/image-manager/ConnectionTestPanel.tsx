import { CheckCircle, Copy, MinusCircle, WarningCircle, XCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { ConnectionTestStep } from '../../../bindings/tinkerkit/models';
import { formatBackendError } from '../../lib/backend-error';
import { Spinner } from '../ui/spinner';
import { toast } from '../ui/toast';
import type { SourceDraft } from './model';

// sourceDraftSignature 覆盖草稿的全部字段：任一字段变化都会让上一次测试结果失效。
export function sourceDraftSignature(draft: SourceDraft) {
  return JSON.stringify(
    Object.entries(draft)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function stepLabel(key: string, t: (key: string) => string) {
  if (key === 'daemon') return t('imageManagerTool.connectionStepDaemon');
  if (key === 'connect') return t('imageManagerTool.connectionStepConnect');
  return key;
}

/** 「测试连接」的分步结果面板：失败行单行截断，点击整行复制完整原因（含远端 stderr）。 */
export function ImageConnectionTestPanel({
  steps,
  running,
  canceled,
}: {
  steps: ConnectionTestStep[];
  running: boolean;
  canceled: boolean;
}) {
  const { t } = useTranslation();

  const copyFailure = async (message: string) => {
    try {
      await navigator.clipboard.writeText(message);
      toast.add({
        title: t('toast.copied', { value: t('imageManagerTool.connectionTestErrorDetail') }),
      });
    } catch {
      toast.add({ title: t('toast.copyFailed'), type: 'error' });
    }
  };

  return (
    <div aria-live="polite" className="rounded-md border border-border bg-muted/30 px-3 py-2">
      {running ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5 shrink-0" />
          <span className="truncate">{t('imageManagerTool.connectionTestRunning')}</span>
        </div>
      ) : (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {steps.map((step) => {            const label = stepLabel(step.key, t);
            const failure = step.error ? formatBackendError(step.error) : '';
            return (
              <li key={step.key} className="flex min-w-0 items-center gap-2 text-xs">
                {step.skipped ? (
                  <MinusCircle
                    weight="regular"
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                ) : failure ? (
                  <WarningCircle
                    weight="regular"
                    aria-hidden="true"
                    className="size-4 shrink-0 text-destructive"
                  />
                ) : (
                  <CheckCircle
                    weight="regular"
                    aria-hidden="true"
                    className="size-4 shrink-0 text-success"
                  />
                )}
                <span className="shrink-0 text-muted-foreground">{label}</span>
                {step.skipped ? (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {t('imageManagerTool.connectionTestSkipped')}
                  </span>
                ) : failure ? (
                  <button
                    type="button"
                    aria-label={t('imageManagerTool.copyConnectionError', { step: label })}
                    onClick={() => void copyFailure(failure)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left text-destructive outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="min-w-0 flex-1 truncate">{failure}</span>
                    <Copy
                      weight="regular"
                      aria-hidden="true"
                      className="size-3.5 shrink-0 opacity-70"
                    />
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-success">
                    {t('imageManagerTool.connectionTestPassed')}
                  </span>
                )}
              </li>
            );
          })}
          {canceled ? (
            <li className="flex min-w-0 items-center gap-2 text-xs">
              <XCircle
                weight="regular"
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t('imageManagerTool.connectionTestCanceled')}
              </span>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
