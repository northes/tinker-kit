import DateCalculator from './DateCalculator';
import { Reveal, ToolLayout, ToolLayoutContent } from './shared';
import { ScrollArea } from './ui/scroll-area';

export default function DateCalculatorTool({ active }: { active: boolean }) {
  return (
    <Reveal index={0} fill active={active}>
      <ToolLayout>
        <ToolLayoutContent>
          <ScrollArea
            className="h-full [padding-inline-end:var(--overlay-scrollbar-size)]"
            options={{ overflow: { x: 'hidden' } }}
          >
            <DateCalculator />
          </ScrollArea>
        </ToolLayoutContent>
      </ToolLayout>
    </Reveal>
  );
}
