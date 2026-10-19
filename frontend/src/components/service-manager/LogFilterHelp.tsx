import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';

const examples = ['text', 'or', 'exclude', 'group', 'scope', 'mixedScope', 'quotedName'] as const;

export function LogFilterHelp() {
  const { t } = useTranslation();
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="link" size="sm" />}>
        {t('serviceManagerTool.filterHelp.title')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('serviceManagerTool.filterHelp.title')}</DialogTitle>
          <DialogDescription>{t('serviceManagerTool.filterHelp.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="max-h-[60vh] min-h-0"
          scrollFade="y"
          options={{ overflow: { x: 'hidden' } }}
        >
          <div className="space-y-4">
            <dl className="space-y-4">
              {examples.map((example) => (
                <div key={example} className="space-y-1">
                  <dt className="text-sm font-medium">
                    {t(`serviceManagerTool.filterHelp.examples.${example}.title`)}
                  </dt>
                  <dd className="space-y-1">
                    <code className="block rounded-md bg-muted px-3 py-2 text-sm break-all whitespace-pre-wrap">
                      {t(`serviceManagerTool.filterHelp.examples.${example}.query`)}
                    </code>
                    <p className="text-xs text-muted-foreground">
                      {t(`serviceManagerTool.filterHelp.examples.${example}.description`)}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {t('serviceManagerTool.filterHelp.rules')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('serviceManagerTool.filterHelp.shortcuts')}
            </p>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
