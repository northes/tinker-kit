import { useTranslation } from 'react-i18next';
import { GearSix } from '@phosphor-icons/react';
import type { SSHProfile } from '../../bindings/changeme/models';
import { cn } from '@/lib/utils';
import { emptyProfile, useSSHProfiles } from './SSHProfileManagerDialog';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

type SSHProfileSelectProps = {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

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
  const options: SSHProfile[] = missing
    ? [
        ...profiles,
        {
          ...emptyProfile,
          id: value,
          name: t('sshProfiles.missingProfile'),
        },
      ]
    : profiles;
  const empty = options.length === 0;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Select
        items={options.map((profile) => ({ value: profile.id, label: profile.name }))}
        value={value || null}
        onValueChange={(next) => onValueChange(next || '')}
        disabled={disabled || empty}
      >
        <SelectTrigger id={id} className="min-w-0 flex-1">
          <SelectValue
            placeholder={empty ? t('sshProfiles.empty') : (placeholder ?? t('sshProfiles.title'))}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="flex-none"
        disabled={disabled}
        aria-label={t('sshProfiles.title')}
        onClick={openManager}
      >
        <GearSix weight="duotone" />
      </Button>
    </div>
  );
}
