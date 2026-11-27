import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GearSix } from '@phosphor-icons/react';
import type { SSHProfile } from '../../bindings/tinkerkit/models';
import { selectAllOnFocus } from '@/lib/select-all-on-focus';
import { bestSourceSearchRank, orderBySourceSearch } from '@/lib/source-search';
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

// 过滤字段：配置名称、user@host:port、本机别名。
function profileSearchFields(profile: SSHProfile) {
  return [profile.name, profileAddress(profile), profile.originAlias];
}

function matchesProfile(profile: SSHProfile, query: string) {
  return bestSourceSearchRank(profileSearchFields(profile), query) !== null;
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
  const [open, setOpen] = useState(false);
  // 打开时输入框里是已选名称，不算筛选；用户改过文字后才按查询排序。
  const [queryEdited, setQueryEdited] = useState(false);
  useEffect(() => {
    setInputValue(selectedLabel);
  }, [selectedLabel]);
  const rankedItems = useMemo(
    () =>
      orderBySourceSearch(
        items,
        queryEdited ? inputValue : '',
        (profileID) => {
          const profile = profilesByID.get(profileID);
          return profile ? profileSearchFields(profile) : [];
        },
        // 「配置已失效」仍参与匹配，命中时留在列表末尾，不跟普通结果抢位置。
        missing ? (profileID) => profileID === value : undefined,
      ),
    [items, queryEdited, inputValue, profilesByID, missing, value],
  );
  const rankedWhileOpenRef = useRef(rankedItems);
  if (open) rankedWhileOpenRef.current = rankedItems;
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
        onOpenChange={(next, details) => {
          setOpen(next);
          // 输入文字把列表打开时，同一次事件已经开始筛选，不能把这次输入清掉。
          if (next && details.reason !== 'input-change') setQueryEdited(false);
        }}
        onInputValueChange={(next, details) => {
          // 浮层关闭时 Base UI 把 Esc 当“清空选中值”，这里只当取消过滤：保留已选配置，
          // 并让 Esc 继续传给外层弹窗（关闭列表后再按 Esc 可退出弹窗）。
          if (details.reason === 'escape-key') {
            details.cancel();
            details.allowPropagation();
            return;
          }
          setInputValue(next);
          if (details.reason === 'input-change') setQueryEdited(true);
        }}
        itemToStringLabel={(profileID) => profilesByID.get(profileID)?.name ?? ''}
        filter={(profileID, query) => {
          const profile = profilesByID.get(profileID);
          return profile ? matchesProfile(profile, query) : false;
        }}
        filteredItems={open ? rankedItems : rankedWhileOpenRef.current}
        disabled={disabledState}
      >
        <ComboboxInput
          id={id}
          className="min-w-0 flex-1"
          disabled={disabledState}
          placeholder={placeholderText}
          aria-label={placeholderText}
          triggerLabel={placeholderText}
          onFocus={selectAllOnFocus}
          onMouseDown={selectAllOnFocus}
          onMouseUp={selectAllOnFocus}
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
        onClick={() =>
          openManager(value, {
            onManualCreateSaved: (profileID) => onValueChange(profileID),
          })
        }
      >
        <GearSix weight="regular" />
      </Button>
    </div>
  );
}
