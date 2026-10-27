import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from '@phosphor-icons/react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { DEFAULT_NTP_SERVERS } from '../utils/time';

const defaultNtpPort = 123;

// normalizeNtpServer 与 Go 端 normalizeNtpServer 行为一致：补齐默认端口并校验主机/端口，
// 非法输入返回 null。保存时以 Go 端规范化为准，这里只用于尽早反馈。
export function normalizeNtpServer(input: string): string | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;
  let host = value;
  let port = String(defaultNtpPort);
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = bracketed[2];
  } else if (value.includes(':')) {
    // 未加方括号的 IPv6 视为非法；host:port 按最后一个冒号切分。
    const index = value.lastIndexOf(':');
    host = value.slice(0, index);
    port = value.slice(index + 1);
    if (host.includes(':')) return null;
  }
  if (host === '' || host.length > 253 || !/^[A-Za-z0-9._:%-]+$/.test(host)) return null;
  const portNumber = Number(port);
  if (!/^\d+$/.test(port) || portNumber < 1 || portNumber > 65535) return null;
  return host.includes(':') ? `[${host}]:${portNumber}` : `${host}:${portNumber}`;
}

type NtpRow = { id: string; value: string };

function rowsFromServers(servers: string[]): NtpRow[] {
  const values = servers.length > 0 ? servers : [''];
  return values.map((value) => ({ id: crypto.randomUUID(), value }));
}

export function NtpServerDialog({
  open,
  onOpenChange,
  servers,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  servers: string[];
  onSave: (servers: string[]) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<NtpRow[]>(() => rowsFromServers(servers));
  const serversRef = useRef(servers);
  serversRef.current = servers;

  useEffect(() => {
    if (open) setRows(rowsFromServers(serversRef.current));
  }, [open]);

  const normalized = rows.map((row) =>
    row.value.trim() === '' ? null : normalizeNtpServer(row.value),
  );
  const isInvalid = (row: NtpRow, index: number) =>
    row.value.trim() !== '' && normalized[index] === null;
  const hasValue = rows.some((row) => row.value.trim() !== '');
  const canSave = hasValue && !rows.some(isInvalid);

  const save = () => {
    const result: string[] = [];
    for (const value of normalized) {
      if (value !== null && !result.includes(value)) result.push(value);
    }
    if (result.length === 0) return;
    onSave(result);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[min(680px,calc(100vh-4rem))] min-h-0 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('timeTool.realTime.ntpTitle')}</DialogTitle>
          <DialogDescription>{t('timeTool.realTime.ntpDescription')}</DialogDescription>
        </DialogHeader>
        <form
          id="ntp-servers-form"
          className="-m-1 grid min-h-0 gap-3 overflow-y-auto p-1"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {rows.map((row, index) => {
            const invalid = isInvalid(row, index);
            return (
              <div key={row.id} className="grid gap-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus={index === 0}
                    value={row.value}
                    spellCheck={false}
                    aria-invalid={invalid}
                    aria-label={t('timeTool.realTime.ntpServerLabel', { index: index + 1 })}
                    placeholder={t('timeTool.realTime.ntpPlaceholder')}
                    className="font-mono"
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, value: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="flex-none text-muted-foreground"
                    aria-label={t('timeTool.realTime.ntpRemove', { index: index + 1 })}
                    disabled={rows.length <= 1}
                    onClick={() =>
                      setRows((current) => current.filter((item) => item.id !== row.id))
                    }
                  >
                    <X size={16} />
                  </Button>
                </div>
                {invalid ? (
                  <span role="alert" className="text-xs text-destructive">
                    {t('timeTool.realTime.ntpInvalid', { server: row.value.trim() })}
                  </span>
                ) : null}
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            onClick={() =>
              setRows((current) => [...current, { id: crypto.randomUUID(), value: '' }])
            }
          >
            <Plus size={14} />
            {t('timeTool.realTime.ntpAdd')}
          </Button>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRows(rowsFromServers(DEFAULT_NTP_SERVERS))}
          >
            {t('timeTool.realTime.ntpReset')}
          </Button>
          <Button type="submit" form="ntp-servers-form" disabled={!canSave}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
