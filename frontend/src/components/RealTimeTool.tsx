import RealTimePanel from './RealTimePanel';
import { Reveal, ToolLayout, ToolLayoutContent } from './shared';

export default function RealTimeTool({
  active,
  ntpServers,
  onNtpServersChange,
}: {
  active: boolean;
  ntpServers: string[];
  onNtpServersChange: (ntpServers: string[]) => void;
}) {
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutContent>
          <RealTimePanel ntpServers={ntpServers} onNtpServersChange={onNtpServersChange} />
        </ToolLayoutContent>
      </ToolLayout>
    </Reveal>
  );
}
