import React from 'react';
import { ArrowsClockwise, Bug, Check, Copy, GithubLogo } from '@phosphor-icons/react';
import { Browser, Window } from '@wailsio/runtime';
import { useTranslation } from 'react-i18next';
import type { SystemInfo } from '../../bindings/changeme/models';
import { GetSystemInfo } from '../../bindings/changeme/systeminfoservice';
import { GetCurrentVersion } from '../../bindings/changeme/updateservice';
import { GITHUB_REPO_URL } from '../repositoryUrl';
import { Button } from './ui/button';

type FatalErrorBoundaryProps = { children: React.ReactNode };
type FatalErrorBoundaryState = { error: Error | null };

const AUTO_RELOAD_KEY = 'tinkerkit.fatal-auto-reload';

function isChunkLoadError(error: Error) {
  return /chunk|dynamically imported module|failed to fetch/i.test(error.message);
}

function reload(force: boolean) {
  const request = force ? Window.ForceReload() : Window.Reload();
  void request.catch(() => window.location.reload());
}

function formatSystemInfo(systemInfo: SystemInfo | null, unknownLabel: string): string {
  if (!systemInfo) return unknownLabel;
  const os = systemInfo.os.trim();
  const version = systemInfo.version.trim();
  const arch = systemInfo.arch.trim();
  if (!os || !arch) return unknownLabel;
  return [os, version, arch].filter(Boolean).join(' ');
}

function formatErrorDetails(error: Error): string {
  const stack = error.stack?.trim();
  if (stack) return stack;
  const message = error.message?.trim();
  return message || String(error);
}

function CrashScreen({ error, onReload }: { error: Error; onReload: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const [version, setVersion] = React.useState<string | null>(null);
  const [systemInfo, setSystemInfo] = React.useState<SystemInfo | null>(null);
  const unknownLabel = t('crash.unknown');
  const versionLabel = version ? `v${version}` : version === null ? '' : unknownLabel;
  const systemLabel = React.useMemo(
    () => formatSystemInfo(systemInfo, unknownLabel),
    [systemInfo, unknownLabel],
  );
  const errorText = formatErrorDetails(error);

  React.useEffect(() => {
    let cancelled = false;
    void GetSystemInfo()
      .then((value) => {
        if (!cancelled) setSystemInfo(value);
      })
      .catch(() => {
        if (!cancelled) setSystemInfo(null);
      });
    void GetCurrentVersion()
      .then((value) => {
        if (!cancelled) setVersion(typeof value === 'string' ? value.trim() : '');
      })
      .catch(() => {
        if (!cancelled) setVersion('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copyErrorDetails = async () => {
    if (!navigator.clipboard) return;
    try {
      const report = [
        `${t('crash.version')}: ${versionLabel}`,
        `${t('crash.system')}: ${systemLabel}`,
        `${t('crash.error')}:`,
        errorText,
      ].join('\n');
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // WebView 出错时可能无法访问剪贴板。
    }
  };

  return (
    <main className="flex h-dvh items-center justify-center bg-background px-6 text-foreground">
      <section className="flex w-full max-w-[420px] flex-col items-center text-center">
        <Bug size={34} weight="duotone" className="mb-4 text-destructive" />
        <h1 className="text-base font-semibold">{t('crash.title')}</h1>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('crash.description')}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={onReload}>
            <ArrowsClockwise data-icon="inline-start" size={15} weight="duotone" />
            {t('crash.reload')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void Browser.OpenURL(GITHUB_REPO_URL)}
          >
            <GithubLogo data-icon="inline-start" size={15} weight="duotone" />
            {t('crash.openRepository')}
          </Button>
        </div>
        <details className="mt-6 w-full text-left text-[10px] text-muted-foreground">
          <summary className="cursor-pointer text-center">{t('crash.details')}</summary>
          <dl className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <div>
              <dt className="font-medium text-foreground">{t('crash.version')}</dt>
              <dd className="mt-1 break-all">{versionLabel}</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">{t('crash.system')}</dt>
              <dd className="mt-1 break-all">{systemLabel}</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">{t('crash.error')}</dt>
              <dd className="mt-1 flex items-start gap-2">
                <pre className="min-w-0 flex-1 max-h-32 overflow-auto whitespace-pre-wrap">
                  {errorText}
                </pre>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(copied ? 'crash.copied' : 'crash.copy')}
                  title={t(copied ? 'crash.copied' : 'crash.copy')}
                  onClick={() => void copyErrorDetails()}
                >
                  {copied ? (
                    <Check size={14} weight="duotone" />
                  ) : (
                    <Copy size={14} weight="duotone" />
                  )}
                </Button>
              </dd>
            </div>
          </dl>
        </details>
      </section>
    </main>
  );
}

export class FatalErrorBoundary extends React.Component<
  FatalErrorBoundaryProps,
  FatalErrorBoundaryState
> {
  state: FatalErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): FatalErrorBoundaryState {
    return { error };
  }

  componentDidMount() {
    window.addEventListener('error', this.handleGlobalError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  componentWillUnmount() {
    window.removeEventListener('error', this.handleGlobalError);
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  componentDidCatch(error: Error) {
    if (!isChunkLoadError(error) || sessionStorage.getItem(AUTO_RELOAD_KEY)) return;
    sessionStorage.setItem(AUTO_RELOAD_KEY, '1');
    reload(true);
  }

  handleGlobalError = (event: ErrorEvent) => {
    if (event.error instanceof Error) this.setState({ error: event.error });
  };

  handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    this.setState({ error });
  };

  render() {
    if (this.state.error) {
      return <CrashScreen error={this.state.error} onReload={() => reload(false)} />;
    }
    return this.props.children;
  }
}

export function FatalErrorBoundaryRoot({ children }: FatalErrorBoundaryProps) {
  return <FatalErrorBoundary>{children}</FatalErrorBoundary>;
}
