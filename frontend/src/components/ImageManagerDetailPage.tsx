import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InspectDockerImage } from '../../bindings/changeme/imageservice';
import type { Config as Settings, DockerImageDetail } from '../../bindings/changeme/models';
import { ImageManagerDetailView } from './ImageManagerTool';
import type { ToolId } from './shared';

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.error === 'string' && value.error) return value.error;
  }
  return '';
}

function sourceLabel(settings: Settings, sourceId: string, localSourceLabel: string) {
  const source = (settings.imageSources ?? []).find((item) => item.id === sourceId);
  if (!source || source.id === 'local' || source.kind === 'local') {
    return sourceId === 'local' ? localSourceLabel : sourceId;
  }
  return source.name || source.registryURL || source.sshProfileID || sourceId;
}

export default function ImageManagerDetailPage({
  active,
  imageId,
  onBack,
  record,
  settings,
  sourceId,
}: {
  active: boolean;
  imageId: string;
  onBack: () => void;
  record: (tool: ToolId, action: string, detail: string, input: string, output?: string) => void;
  settings: Settings;
  sourceId: string;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<DockerImageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const recordRef = useRef(record);
  recordRef.current = record;

  const label = sourceLabel(settings, sourceId, t('imageManagerTool.localSource'));

  useEffect(() => {
    let mounted = true;
    setDetail(null);
    setError('');
    setLoading(true);
    void InspectDockerImage(sourceId, imageId)
      .then((next) => {
        if (!mounted) return;
        setDetail(next);
        recordRef.current(
          'image-manager',
          t('imageManagerTool.inspected'),
          next.name || imageId,
          imageId,
        );
      })
      .catch((reason) => {
        if (!mounted) return;
        setError(errorMessage(reason) || t('imageManagerTool.loadFailed'));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [imageId, sourceId, t]);

  return (
    <ImageManagerDetailView
      active={active}
      detail={detail}
      error={error}
      loading={loading}
      onBack={onBack}
      sourceLabel={label}
    />
  );
}
