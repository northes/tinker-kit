import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InspectDockerImage } from '../../bindings/changeme/imageservice';
import type { DockerImageDetail } from '../../bindings/changeme/models';
import { ImageManagerDetailView } from './ImageManagerTool';
import type { ToolId } from './shared';
import { formatBackendError as errorMessage } from '../lib/backend-error';

export default function ImageManagerDetailPage({
  active,
  imageId,
  onBack,
  record,
  sourceId,
}: {
  active: boolean;
  imageId: string;
  onBack: () => void;
  record: (tool: ToolId, action: string, detail: string, input: string, output?: string) => void;
  sourceId: string;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<DockerImageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const recordRef = useRef(record);
  recordRef.current = record;

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
    />
  );
}
