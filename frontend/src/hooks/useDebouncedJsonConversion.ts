import { useEffect, useRef, useState } from 'react';
import { ConvertJSON } from '../../bindings/changeme/jsonpipelineservice';
import type { JsonConvertErrorCode, JsonConvertFormat } from '../lib/json-converter';

export type JsonConversionError = {
  code: JsonConvertErrorCode | 'backendError';
  params: Record<string, string>;
};

export type JsonConversionState =
  | { status: 'idle'; revision: number }
  | { status: 'pending'; revision: number; input: string; format: JsonConvertFormat }
  | { status: 'empty'; revision: number; input: string; format: JsonConvertFormat }
  | {
      status: 'ok';
      revision: number;
      input: string;
      format: JsonConvertFormat;
      output: string;
    }
  | {
      status: 'error';
      revision: number;
      input: string;
      format: JsonConvertFormat;
      error: JsonConversionError;
    };

const DEBOUNCE_MS = 150;

function idleState(revision: number): JsonConversionState {
  return { status: 'idle', revision };
}

function pendingState(
  revision: number,
  input: string,
  format: JsonConvertFormat,
): JsonConversionState {
  return { status: 'pending', revision, input, format };
}

export function useDebouncedJsonConversion(
  enabled: boolean,
  input: string,
  format: JsonConvertFormat,
): JsonConversionState {
  const [state, setState] = useState<JsonConversionState>(() => idleState(0));
  const revision = useRef(0);
  const timer = useRef<number | null>(null);
  const request = useRef<ReturnType<typeof ConvertJSON> | null>(null);

  useEffect(() => {
    const currentRevision = ++revision.current;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (request.current) void request.current.cancel();
    request.current = null;

    if (!enabled) {
      setState(idleState(currentRevision));
      return;
    }
    if (!input.trim()) {
      setState({ status: 'empty', revision: currentRevision, input, format });
      return;
    }

    setState(pendingState(currentRevision, input, format));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (currentRevision !== revision.current) return;
      const currentRequest = ConvertJSON({ source: input, format });
      request.current = currentRequest;
      void currentRequest
        .then((response) => {
          if (currentRevision !== revision.current || request.current !== currentRequest) return;
          if (!response.error) {
            setState({
              status: 'ok',
              revision: currentRevision,
              input,
              format,
              output: response.text,
            });
          } else {
            setState({
              status: 'error',
              revision: currentRevision,
              input,
              format,
              error: {
                code: response.error.code as JsonConvertErrorCode,
                params: Object.fromEntries(
                  Object.entries(response.error.params ?? {}).filter(
                    (entry): entry is [string, string] => entry[1] !== undefined,
                  ),
                ),
              },
            });
          }
        })
        .catch(() => {
          if (currentRevision !== revision.current || request.current !== currentRequest) return;
          setState({
            status: 'error',
            revision: currentRevision,
            input,
            format,
            error: { code: 'backendError', params: {} },
          });
        })
        .finally(() => {
          if (request.current === currentRequest) request.current = null;
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (request.current) void request.current.cancel();
      request.current = null;
    };
  }, [enabled, input, format]);

  if (!enabled) return idleState(revision.current);
  if (!input.trim()) {
    if (state.status === 'empty' && state.input === input && state.format === format) return state;
    return { status: 'empty', revision: revision.current + 1, input, format };
  }
  if (state.status !== 'idle' && state.input === input && state.format === format) return state;
  return pendingState(revision.current + 1, input, format);
}
