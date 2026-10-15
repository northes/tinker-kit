import type { SSHProfile } from '../../bindings/tinkerkit/models';
import { SSHProfileSelect } from './SSHProfileSelect';
import { useSSHProfiles } from './SSHProfileManagerDialog';

/** SSH 配置表单字段：选择后将完整配置交给调用方处理。 */
export function SSHProfileFormField({
  id,
  value,
  onSelect,
  placeholder,
}: {
  id?: string;
  value: string;
  onSelect: (profile: SSHProfile | null) => void;
  placeholder?: string;
}) {
  const { profiles } = useSSHProfiles();
  return (
    <SSHProfileSelect
      id={id}
      value={value}
      placeholder={placeholder}
      onValueChange={(nextID) =>
        onSelect(profiles.find((profile) => profile.id === nextID) ?? null)
      }
    />
  );
}
