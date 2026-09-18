import { Events } from '@wailsio/runtime';
import { useEffect, useRef, useState } from 'react';
import {
  ClosePipelineSession,
  OpenPipelineSession,
  UpdatePipelineState,
} from '../../bindings/changeme/jsonpipelineservice';
import type { PipelineItem } from '../../bindings/changeme/models';

// PipelineError / PipelineResultPayload 只作为事件负载，Wails 不会为纯事件结构生成
// 模型，因此在前端按后端字段定义。
export type PipelineError = {
  code: string;
  item?: number;
  path?: string;
  index?: number;
};

export type PipelineResultPayload = {
  sessionID: string;
  mutationID: number;
  resultID: string;
  docID: number;
  pipelineID: number;
  status: 'ok' | 'error' | 'cancelled';
  error?: PipelineError | null;
  format: 'json' | 'text' | string;
  previewText: string;
  previewComplete: boolean;
  totalBytes: number;
  totalLines: number;
};

export type PipelinePair = { docID: number; pipelineID: number };

export type PipelineCompletionContext = {
  sessionID: string;
  docID: number;
  pipelineID: number;
} | null;

export type PipelineEvaluation = {
  status: 'off' | 'idle' | 'loading' | 'ok' | 'error';
  resultID: string;
  docID: number;
  pipelineID: number;
  format: 'json' | 'text';
  previewText: string;
  previewComplete: boolean;
  totalBytes: number;
  totalLines: number;
  error: PipelineError | null;
};

const emptyEvaluation = (status: PipelineEvaluation['status'] = 'idle'): PipelineEvaluation => ({
  status,
  resultID: '',
  docID: 0,
  pipelineID: 0,
  format: 'json',
  previewText: '',
  previewComplete: true,
  totalBytes: 0,
  totalLines: 0,
  error: null,
});

const rulesSignature = (rules: PipelineItem[]) =>
  JSON.stringify(
    rules.map((rule) => [
      rule.id,
      rule.enabled,
      rule.type,
      rule.path,
      rule.sortMode,
      rule.direction,
      rule.arrayPath,
      rule.itemPath,
      rule.filterValue,
      rule.template,
    ]),
  );

/**
 * useBackendPipelineEvaluation 是流水线评估的唯一入口：单飞更新、精确匹配
 * (session, mutation, pair) 的结果事件，并保证旧结果永远不覆盖新状态。
 */
export function useBackendPipelineEvaluation(
  enabled: boolean,
  source: string,
  rules: PipelineItem[],
  delay = 120,
) {
  const [evaluation, setEvaluation] = useState<PipelineEvaluation>(() => emptyEvaluation('off'));
  const [context, setContext] = useState<PipelineCompletionContext>(null);

  const sessionRef = useRef<string | null>(null);
  const basePairRef = useRef<PipelinePair>({ docID: 0, pipelineID: 0 });
  const sentSourceRef = useRef<string | null>(null);
  const sentRulesRef = useRef<string | null>(null);
  const desiredRef = useRef({ source, rules });
  const inflightRef = useRef(false);
  const mutationRef = useRef(0);
  const expectedMutationRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const dispatchRef = useRef<() => void>(() => {});

  desiredRef.current = { source, rules };

  const schedule = () => {
    dispatchRef.current();
  };

  const openSession = async (force: boolean) => {
    const previous = sessionRef.current;
    if (previous) void ClosePipelineSession(previous).catch(() => {});
    sessionRef.current = null;
    setContext(null);
    try {
      const info = await OpenPipelineSession();
      sessionRef.current = info.sessionID;
      basePairRef.current = { docID: info.docID, pipelineID: info.pipelineID };
      if (force) {
        sentSourceRef.current = null;
        sentRulesRef.current = null;
      }
    } catch {
      sessionRef.current = null;
    }
  };

  useEffect(() => {
    const off = Events.On('json-pipeline:result', (event) => {
      const payload = event.data as PipelineResultPayload;
      if (!payload || payload.sessionID !== sessionRef.current) return;
      if (payload.mutationID !== expectedMutationRef.current) return;
      if (payload.status === 'cancelled') return;
      basePairRef.current = { docID: payload.docID, pipelineID: payload.pipelineID };
      setEvaluation({
        status: payload.status === 'error' ? 'error' : 'ok',
        resultID: payload.resultID,
        docID: payload.docID,
        pipelineID: payload.pipelineID,
        format: payload.format === 'text' ? 'text' : 'json',
        previewText: payload.previewText ?? '',
        previewComplete: payload.previewComplete,
        totalBytes: payload.totalBytes,
        totalLines: payload.totalLines,
        error: payload.error ?? null,
      });
      setContext({
        sessionID: payload.sessionID,
        docID: payload.docID,
        pipelineID: payload.pipelineID,
      });
    });
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    dispatchRef.current = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void dispatch();
      }, delay);
    };

    const dispatch = async () => {
      if (!enabled || !sessionRef.current) return;
      if (inflightRef.current) return;
      const desired = desiredRef.current;
      const nextSignature = rulesSignature(desired.rules);
      const sourceChanged = desired.source !== sentSourceRef.current;
      const pipelineChanged = nextSignature !== sentRulesRef.current;
      if (!sourceChanged && !pipelineChanged) return;
      inflightRef.current = true;
      const mutationID = ++mutationRef.current;
      expectedMutationRef.current = mutationID;
      setEvaluation((current) =>
        current.status === 'off' ? emptyEvaluation('loading') : { ...current, status: 'loading' },
      );
      try {
        const ack = await UpdatePipelineState({
          sessionID: sessionRef.current,
          mutationID,
          baseDocID: basePairRef.current.docID,
          basePipelineID: basePairRef.current.pipelineID,
          source: sourceChanged ? desired.source : null,
          pipeline: pipelineChanged ? desired.rules : null,
        });
        if (ack.missingSession) {
          await openSession(true);
          return;
        }
        if (ack.conflict) {
          basePairRef.current = { docID: ack.docID, pipelineID: ack.pipelineID };
          sentSourceRef.current = null;
          sentRulesRef.current = null;
          return;
        }
        if (ack.accepted) {
          basePairRef.current = { docID: ack.docID, pipelineID: ack.pipelineID };
          if (sourceChanged) sentSourceRef.current = desired.source;
          if (pipelineChanged) sentRulesRef.current = nextSignature;
        }
      } catch {
        sentSourceRef.current = null;
        sentRulesRef.current = null;
        setEvaluation((current) =>
          current.resultID ? { ...current, status: current.error ? 'error' : 'ok' } : current,
        );
      } finally {
        inflightRef.current = false;
        const latest = desiredRef.current;
        const latestSignature = rulesSignature(latest.rules);
        if (latest.source !== sentSourceRef.current || latestSignature !== sentRulesRef.current) {
          schedule();
        }
      }
    };
    dispatchRef.current();
  }, [enabled, source, rules, delay]);

  useEffect(() => {
    if (!enabled) {
      const previous = sessionRef.current;
      sessionRef.current = null;
      if (previous) void ClosePipelineSession(previous).catch(() => {});
      sentSourceRef.current = null;
      sentRulesRef.current = null;
      basePairRef.current = { docID: 0, pipelineID: 0 };
      setContext(null);
      setEvaluation(emptyEvaluation('off'));
      return;
    }
    void openSession(true).then(() => schedule());
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(
    () => () => {
      const previous = sessionRef.current;
      sessionRef.current = null;
      if (previous) void ClosePipelineSession(previous).catch(() => {});
    },
    [],
  );

  return { evaluation, context };
}
