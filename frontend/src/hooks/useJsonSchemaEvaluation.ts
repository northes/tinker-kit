import { useEffect, useRef, useState } from 'react';
import { EvaluateJSONPath } from '../../bindings/tinkerkit/jsonpipelineservice';

export type JsonPathErrorCode =
  | 'unclosedComment'
  | 'unclosedString'
  | 'invalidObjectKey'
  | 'missingColon'
  | 'unclosedNode'
  | 'pathMissingBracket'
  | 'pathInvalidSegment'
  | 'pathInvalidChar'
  | 'notArray'
  | 'indexOutOfRange'
  | 'noKeyAt'
  | 'keyNotFound'
  | 'pathNotFound';

export type JsonSchemaEvaluation =
  | { status: 'idle'; revision: number }
  | { status: 'empty'; revision: number }
  | { status: 'pending'; revision: number }
  | { status: 'ok'; revision: number; text: string }
  | {
      status: 'error';
      revision: number;
      code: JsonPathErrorCode | 'backendError';
      params?: Record<string, string | undefined>;
    };

const DEBOUNCE_MS = 100;

export function useJsonSchemaEvaluation(
  enabled: boolean,
  input: string,
  path: string,
): JsonSchemaEvaluation {
  const [state, setState] = useState<JsonSchemaEvaluation>({ status: 'idle', revision: 0 });
  const revisionRef = useRef(0);

  useEffect(() => {
    const revision = ++revisionRef.current;
    if (!enabled) {
      setState({ status: 'idle', revision });
      return;
    }
    if (!input.trim()) {
      setState({ status: 'empty', revision });
      return;
    }

    setState({ status: 'pending', revision });
    let request: ReturnType<typeof EvaluateJSONPath> | null = null;
    const timer = window.setTimeout(() => {
      request = EvaluateJSONPath(input, path);
      void request
        .then((response) => {
          if (revision !== revisionRef.current) return;
          if (!response.error) {
            setState({ status: 'ok', revision, text: response.text });
          } else {
            setState({
              status: 'error',
              revision,
              code: response.error.code as JsonPathErrorCode,
              params: response.error.params ?? undefined,
            });
          }
        })
        .catch(() => {
          if (revision === revisionRef.current)
            setState({ status: 'error', revision, code: 'backendError' });
        })
        .finally(() => {
          request = null;
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (request) void request.cancel();
    };
  }, [enabled, input, path]);

  return state;
}
