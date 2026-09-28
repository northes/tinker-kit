import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GetServiceMetricsTrend,
  StartServiceMetrics,
  StopServiceMetrics,
} from '../../bindings/changeme/servicemanagerservice';
import type {
  ServiceMetricSnapshot,
  ServiceMetricTrendPoint,
} from '../../bindings/changeme/models';

// 与 Go 端 serviceMetricInterval / serviceMetricRetention 对应。
export const SERVICE_METRIC_INTERVAL = 5000;
export const SERVICE_METRIC_RETENTION_MS = 24 * 60 * 60 * 1000;

export type ServiceMetricPoint = ServiceMetricTrendPoint;

// 采样由 Go 服务常驻进行；多个消费者按引用计数共享同一次采样，全部注销后才停止，
// 避免各视图切换时相互覆盖目标集合、反复中止采样。
const samplingSubscriptions = new Map<symbol, string[]>();
let appliedTargetKey = '';

function syncSampling() {
  const union: string[] = [];
  const seen = new Set<string>();
  for (const targetIDs of samplingSubscriptions.values()) {
    for (const id of targetIDs) {
      if (seen.has(id)) continue;
      seen.add(id);
      union.push(id);
    }
  }
  const key = union.join(',');
  if (key === appliedTargetKey) return;
  appliedTargetKey = key;
  if (union.length) void StartServiceMetrics(union).catch(() => undefined);
  else void StopServiceMetrics().catch(() => undefined);
}

function retainSampling(targetIDs: string[]) {
  const token = Symbol('service-metric-sampling');
  samplingSubscriptions.set(token, targetIDs);
  syncSampling();
  return () => {
    samplingSubscriptions.delete(token);
    syncSampling();
  };
}

export function trimServiceMetricHistory(history: Map<string, ServiceMetricPoint[]>) {
  const cutoff = Date.now() - SERVICE_METRIC_RETENTION_MS;
  for (const [key, points] of history) {
    if (!points.length || points[0].timestamp >= cutoff) continue;
    const start = points.findIndex((point) => point.timestamp >= cutoff);
    history.set(key, start < 0 ? [] : points.slice(start));
  }
}

// useServiceMetricTrend 负责订阅采样与拉取增量趋势点。enabled 为 false 时停止轮询；
// 每次拉取后通过 version 通知消费者重新读取 history。
export function useServiceMetricTrend({
  enabled,
  targetIDs,
}: {
  enabled: boolean;
  targetIDs: string[];
}) {
  const [snapshots, setSnapshots] = useState<ServiceMetricSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const historyRef = useRef(new Map<string, ServiceMetricPoint[]>());
  const cursorRef = useRef(0);
  const requestVersion = useRef(0);
  const targetKey = targetIDs.join(',');

  useEffect(() => {
    if (!enabled || !targetKey) return;
    return retainSampling(targetKey.split(','));
  }, [enabled, targetKey]);

  const refresh = useCallback(async () => {
    const request = ++requestVersion.current;
    setLoading(true);
    try {
      const trend = await GetServiceMetricsTrend(cursorRef.current);
      if (request !== requestVersion.current) return;
      setError('');
      for (const point of trend.points ?? []) {
        const history = historyRef.current.get(point.key) ?? [];
        history.push(point);
        historyRef.current.set(point.key, history);
      }
      cursorRef.current = trend.sequence ?? cursorRef.current;
      trimServiceMetricHistory(historyRef.current);
      setSnapshots(trend.snapshots ?? []);
      setVersion((value) => value + 1);
    } catch (reason) {
      if (request === requestVersion.current) setError(String(reason));
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !targetKey) return;
    let disposed = false;
    let timer = 0;
    const tick = async () => {
      await refresh();
      if (!disposed) timer = window.setTimeout(tick, SERVICE_METRIC_INTERVAL);
    };
    void tick();
    return () => {
      disposed = true;
      requestVersion.current += 1;
      window.clearTimeout(timer);
    };
  }, [enabled, refresh, targetKey]);

  return { snapshots, history: historyRef.current, loading, error, version };
}
