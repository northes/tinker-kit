import { useEffect, useState } from 'react';
import { InspectJSON } from '../../bindings/changeme/jsonpipelineservice';

export type JsonInspectionState =
  | { status: 'idle' }
  | { status: 'empty' }
  | { status: 'pending' }
  | { status: 'invalid'; hasComment: boolean }
  | { status: 'ok'; text: string; isSchema: boolean; hasComment: boolean };

const DEBOUNCE_MS = 100;

export function useJsonInspection(enabled: boolean, input: string): JsonInspectionState {
  const [state, setState] = useState<JsonInspectionState>({ status: 'idle' });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }
    if (!input.trim()) {
      setState({ status: 'empty' });
      return;
    }

    let request: ReturnType<typeof InspectJSON> | null = null;
    let current = true;
    const timer = window.setTimeout(() => {
      request = InspectJSON(input);
      void request
        .then((response) => {
          if (!current) return;
          if (response.valid) {
            setState({
              status: 'ok',
              text: response.text ?? '',
              isSchema: response.isSchema,
              hasComment: response.hasComment,
            });
          } else {
            setState({ status: 'invalid', hasComment: response.hasComment });
          }
        })
        .catch(() => {
          if (current) setState({ status: 'invalid', hasComment: false });
        })
        .finally(() => {
          request = null;
        });
    }, DEBOUNCE_MS);

    setState({ status: 'pending' });
    return () => {
      window.clearTimeout(timer);
      current = false;
      if (request) void request.cancel();
    };
  }, [enabled, input]);

  return state;
}
