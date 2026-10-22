import { CancelError } from '@wailsio/runtime';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InspectDockerImage } from '../../bindings/tinkerkit/imageservice';
import type { DockerImageDetail } from '../../bindings/tinkerkit/models';
import { ImageManagerDetailView } from './image-manager/ImageManagerDetailView';
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
  const [canceled, setCanceled] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const requestRef = useRef<ReturnType<typeof InspectDockerImage> | null>(null);
  const requestVersion = useRef(0);
  const recordRef = useRef(record);
  recordRef.current = record;
  const retry = () => setReloadToken((value) => value + 1);

  useEffect(() => {
    const version = ++requestVersion.current;
    let mounted = true;
    setDetail(null);
    setError('');
    setCanceled(false);
    setLoading(true);
    const request = InspectDockerImage(sourceId, imageId);
    requestRef.current = request;
    void request
      .then((next) => {
        if (!mounted || version !== requestVersion.current) return;
        setDetail(next);
        recordRef.current(
          'image-manager',
          t('imageManagerTool.inspected'),
          next.name || imageId,
          imageId,
        );
      })
      .catch((reason) => {
        if (!mounted || version !== requestVersion.current || reason instanceof CancelError) return;
        setError(errorMessage(reason) || t('imageManagerTool.loadFailed'));
      })
      .finally(() => {
        if (requestRef.current === request) requestRef.current = null;
        if (mounted && version === requestVersion.current) setLoading(false);
      });
    return () => {
      mounted = false;
      requestVersion.current++;
      if (requestRef.current === request) {
        requestRef.current = null;
        void request.cancel();
      }
    };
  }, [imageId, sourceId, t, reloadToken]);

  const cancel = () => {
    const request = requestRef.current;
    if (!request) return;
    requestRef.current = null;
    requestVersion.current++;
    void request.cancel();
    setLoading(false);
    setCanceled(true);
    setError('');
  };

  return (
    <ImageManagerDetailView
      active={active}
      detail={detail}
      error={error}
      loading={loading}
      canceled={canceled}
      onCancel={cancel}
      onRetry={retry}
      onBack={onBack}
    />
  );
}
