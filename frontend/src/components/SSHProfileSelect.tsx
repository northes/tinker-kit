import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GearSix } from '@phosphor-icons/react';
import type { SSHProfile } from '../../bindings/tinkerkit/models';
import { cn } from '@/lib/utils';
import { emptyProfile, useSSHProfiles } from './SSHProfileManagerDialog';
import { Button } from './ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './ui/combobox';

type SSHProfileSelectProps = {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

// 与管理面板的 profileAddress 保持一致：host 为空时回退本机别名，两者都为空时不显示地址。
// 就地实现，避免共享组件依赖管理面板的私有函数。
function profileAddress(profile: SSHProfile) {
  const host = profile.host || profile.originAlias;
  if (!host) return '';
  return `${profile.username ? `${profile.username}@` : ''}${host}:${profile.port || 22}`;
}

// 过滤条件：配置名称、user@host:port、本机别名，忽略大小写。
function matchesProfile(profile: SSHProfile, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [profile.name, profileAddress(profile), profile.originAlias].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

export function SSHProfileSelect({
  id,
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
}: SSHProfileSelectProps) {
  const { t } = useTranslation();
  const { profiles, openManager } = useSSHProfiles();
  const missing = Boolean(value) && !profiles.some((profile) => profile.id === value);
  const options = useMemo<SSHProfile[]>(
    () =>
      missing
        ? [...profiles, { ...emptyProfile, id: value, name: t('sshProfiles.missingProfile') }]
        : profiles,
    [missing, profiles, t, value],
  );
  const items = useMemo(() => options.map((profile) => profile.id), [options]);
  const profilesByID = useMemo(
    () => new Map(options.map((profile) => [profile.id, profile])),
    [options],
  );
  const empty = options.length === 0;
  const selectedLabel = value ? (profilesByID.get(value)?.name ?? '') : '';
  // 输入框内容只是过滤文本：选中项变化时同步为配置名称，没有选中则为空。
  const [inputValue, setInputValue] = useState(selectedLabel);
  useEffect(() => {
    setInputValue(selectedLabel);
  }, [selectedLabel]);
  const disabledState = disabled || empty;
  const placeholderText = empty ? t('sshProfiles.empty') : (placeholder ?? t('sshProfiles.title'));

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Combobox<string>
        items={items}
        value={value || null}
        onValueChange={(next, details) => {
          // 被取消的变更（例如浮层关闭时按 Esc 触发的清空）不写回调用方。
          if (details.isCanceled) return;
          onValueChange(next ?? '');
        }}
        inputValue={inputValue}
        onInputValueChange={(next, details) => {
          // 浮层关闭时 Base UI 把 Esc 当“清空选中值”，这里只当取消过滤：保留已选配置，
          // 并让 Esc 继续传给外层弹窗（关闭列表后再按 Esc 可退出弹窗）。
          if (details.reason === 'escape-key') {
            details.cancel();
            details.allowPropagation();
            return;
          }
          setInputValue(next);
        }}
        itemToStringLabel={(profileID) => profilesByID.get(profileID)?.name ?? ''}
        filter={(profileID, query) => {
          const profile = profilesByID.get(profileID);
          return profile ? matchesProfile(profile, query) : false;
        }}
        disabled={disabledState}
      >
        <ComboboxInput
          id={id}
          className="min-w-0 flex-1"
          disabled={disabledState}
          placeholder={placeholderText}
          aria-label={placeholderText}
          triggerLabel={placeholderText}
          onBlur={() => setInputValue(selectedLabel)}
        />
        <ComboboxContent>
          <ComboboxList>
            {(profileID: string) => {
              const profile = profilesByID.get(profileID);
              if (!profile) return null;
              const address = profileAddress(profile);
              return (
                <ComboboxItem key={profile.id} value={profile.id} className="py-1.5">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">{profile.name}</span>
                    {address ? (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {address}
                      </span>
                    ) : null}
                  </span>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
          <ComboboxEmpty>{t('sshProfiles.searchEmpty')}</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="flex-none"
        disabled={disabled}
        aria-label={t('sshProfiles.title')}
        onClick={() => openManager(value)}
      >
        <GearSix weight="regular" />
      </Button>
    </div>
  );
}
