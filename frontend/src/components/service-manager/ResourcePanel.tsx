import { Asterisk, Eraser, GearSix, TextAa, TextB, WarningCircle } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DockerContainer,
  DockerContainerDetail,
  LogMonitor,
  PM2ProcessDetail,
  ServiceLogLine,
  ServiceTarget,
  SystemdUnitDetail,
} from '../../../bindings/tinkerkit/models';
import { formatBackendError } from '../../lib/backend-error';
import { ConfirmDialog } from '../ConfirmDialog';
import { ServicePickedPerformance } from '../ServicePickedPerformance';
import { ServiceResourcePerformance } from '../ServiceResourcePerformance';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { LogList, logPattern } from './LogList';
import { targetLabel, VISIBLE_LOG_LIMIT, type Selection } from './model';
import { ResourceInfoTab, ScopeInfoTab } from './ResourceInfo';

export function RuntimeError({ name, error }: { name: string; error?: string }) {
  return (
    <div className="border-b px-3 py-3 text-xs text-muted-foreground">
      <WarningCircle className="mr-1 inline size-3.5" />
      {name}: {error ? formatBackendError(error) : '—'}
    </div>
  );
}

export function ResourcePanel({
  selection,
  targetID,
  metricsActive,
  groupContainers,
  refreshToken,
  tab,
  onTabChange,
  monitorIDs,
  lines,
  truncated,
  logDraft,
  setLogDraft,
  applyFilter,
  query,
  regex,
  setRegex,
  wholeWord,
  setWholeWord,
  highlightLevels,
  setHighlightLevels,
  caseSensitive,
  setCaseSensitive,
  onClear,
  monitors,
  targets,
  onSelectResource,
  t,
}: {
  selection: Selection;
  targetID: string;
  metricsActive: boolean;
  groupContainers: DockerContainer[];
  refreshToken: number;
  tab: string;
  onTabChange: (value: string) => void;
  monitorIDs: string[];
  lines: ServiceLogLine[];
  truncated: boolean;
  logDraft: string;
  setLogDraft: (value: string) => void;
  applyFilter: () => void;
  query: string;
  regex: boolean;
  setRegex: (value: boolean) => void;
  wholeWord: boolean;
  setWholeWord: (value: boolean) => void;
  highlightLevels: boolean;
  setHighlightLevels: (value: boolean) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  onClear: () => void;
  monitors: LogMonitor[];
  targets: ServiceTarget[];
  onSelectResource: (monitor: LogMonitor) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const resource = selection.resource;
  const scope = selection.kind === 'picked' || selection.kind === 'host';
  const sourceLabels = useMemo(() => {
    if (!scope) return undefined;
    const targetNames = new Map(targets.map((item) => [item.id, targetLabel(item, t)]));
    return new Map(
      monitors.map((item) => [
        item.id,
        [
          selection.kind === 'picked'
            ? (targetNames.get(item.targetID) ?? t('serviceManagerTool.targetUnavailable'))
            : '',
          item.resource.group,
          item.resource.name || item.resource.id,
        ]
          .filter(Boolean)
          .join(' / '),
      ]),
    );
  }, [scope, monitors, targets, selection.kind, t]);
  const visibleLines = useMemo(
    () => lines.filter((line) => monitorIDs.includes(line.monitorID)),
    [lines, monitorIDs],
  );
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value)}
        className="h-full min-h-0 gap-0"
      >
        <div className="flex items-center border-b px-4 py-2">
          <TabsList>
            <TabsTrigger value="info">{t('serviceManagerTool.detailTabs.info')}</TabsTrigger>
            <TabsTrigger value="performance">
              {t('serviceManagerTool.detailTabs.metrics')}
            </TabsTrigger>
            <TabsTrigger value="logs">{t('serviceManagerTool.detailTabs.logs')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="info" className="flex min-h-0 flex-col overflow-hidden">
          {scope ? (
            <ScopeInfoTab selection={selection} monitors={monitors} targets={targets} t={t} />
          ) : (
            <ResourceInfoTab
              targetID={targetID}
              resource={resource}
              groupContainers={groupContainers}
              refreshToken={refreshToken}
            />
          )}
        </TabsContent>
        <TabsContent value="performance" className="flex min-h-0 flex-col overflow-hidden">
          {selection.kind === 'picked' ? (
            <ServicePickedPerformance
              enabled={metricsActive}
              monitors={monitors}
              targets={targets}
              onSelectResource={onSelectResource}
            />
          ) : (
            <ServiceResourcePerformance
              enabled={metricsActive}
              targetID={targetID}
              resource={resource}
              sampleKind={selection.kind === 'host' ? 'source' : 'resource'}
            />
          )}
        </TabsContent>
        <TabsContent value="logs" className="flex min-h-0 flex-col overflow-hidden">
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="border-b px-4 py-2">
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Input
                    className="h-8 pr-28"
                    value={logDraft}
                    onChange={(event) => setLogDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) applyFilter();
                    }}
                    placeholder={t('serviceManagerTool.logFilter')}
                  />
                  <ToggleGroup
                    multiple
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    size="sm"
                    value={[
                      wholeWord ? 'word' : '',
                      regex ? 'regex' : '',
                      caseSensitive ? 'case' : '',
                    ].filter(Boolean)}
                    onValueChange={(value) => {
                      setWholeWord(value.includes('word'));
                      setRegex(value.includes('regex'));
                      setCaseSensitive(value.includes('case'));
                    }}
                  >
                    <ToggleGroupItem
                      value="word"
                      title={t('serviceManagerTool.wholeWord')}
                      aria-label={t('serviceManagerTool.wholeWord')}
                    >
                      <TextB weight="duotone" />
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="regex"
                      title={t('serviceManagerTool.regex')}
                      aria-label={t('serviceManagerTool.regex')}
                    >
                      <Asterisk weight="duotone" />
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="case"
                      title={t('serviceManagerTool.caseSensitive')}
                      aria-label={t('serviceManagerTool.caseSensitive')}
                    >
                      <TextAa weight="duotone" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="flex-none"
                  title={t('serviceManagerTool.advancedSettings')}
                  aria-label={t('serviceManagerTool.advancedSettings')}
                  onClick={() => setAdvancedOpen(true)}
                >
                  <GearSix weight="duotone" />
                </Button>
                {!scope ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto flex-none text-muted-foreground hover:text-destructive"
                    disabled={!monitorIDs.length}
                    title={t('serviceManagerTool.clearLogs')}
                    aria-label={t('serviceManagerTool.clearLogs')}
                    onClick={() => setConfirmingClear(true)}
                  >
                    <Eraser weight="duotone" />
                  </Button>
                ) : null}
              </div>
              {truncated ? (
                <p className="mt-2 text-xs text-amber-600">
                  {t('serviceManagerTool.logsTruncated')}
                </p>
              ) : null}
              {lines.length >= VISIBLE_LOG_LIMIT ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('serviceManagerTool.visibleLogLimit')}
                </p>
              ) : null}
            </div>
            <LogList
              lines={visibleLines}
              query={logPattern(query, regex, wholeWord)}
              regex={regex || wholeWord}
              highlightLevels={highlightLevels}
              caseSensitive={caseSensitive}
              sourceLabels={sourceLabels}
            />
          </div>
        </TabsContent>
      </Tabs>
      <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('serviceManagerTool.advancedSettings')}</DialogTitle>
          </DialogHeader>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={highlightLevels}
              onCheckedChange={(checked) => setHighlightLevels(checked === true)}
            />
            {t('serviceManagerTool.highlightLevels')}
          </Label>
          <DialogDescription>
            {t('serviceManagerTool.highlightLevelsDescription')}
          </DialogDescription>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmingClear}
        onOpenChange={setConfirmingClear}
        title={t('serviceManagerTool.clearLogsTitle')}
        description={t('serviceManagerTool.clearLogsConfirm')}
        confirmLabel={t('serviceManagerTool.clearLogs')}
        destructive
        onConfirm={() => {
          if (monitorIDs.length) void onClear();
          setConfirmingClear(false);
        }}
      />
    </>
  );
}

export type ContainerInfo =
  | { runtime: 'docker'; detail: DockerContainerDetail }
  | { runtime: 'pm2'; detail: PM2ProcessDetail }
  | { runtime: 'systemd'; detail: SystemdUnitDetail };
