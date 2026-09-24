import i18n from '../i18n';

// 后端用户可见错误统一以 {"key","params","detail"} 的 JSON 字符串返回；key 指向
// locale 资源，params 提供插值变量，detail 是原始外部错误文本（不翻译）。前端负责
// 按当前语言渲染。原始错误（系统、浏览器或第三方库）不带该结构，原样展示。

interface LocalizedErrorPayload {
  key: string;
  params?: Record<string, unknown>;
  detail?: string;
}

function parseLocalizedError(message: string): LocalizedErrorPayload | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const candidate = payload as { key?: unknown; params?: unknown; detail?: unknown };
  if (typeof candidate.key !== 'string' || !candidate.key) return null;

  const params =
    candidate.params && typeof candidate.params === 'object'
      ? (candidate.params as Record<string, unknown>)
      : undefined;
  const detail = typeof candidate.detail === 'string' ? candidate.detail : undefined;
  return { key: candidate.key, params, detail };
}

/** 从任意错误值中取出原始 message 文本，兼容 Wails RuntimeError、Error、字符串与携带 error 字段的模型。 */
export function rawErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.error === 'string' && value.error) return value.error;
  }
  if (error instanceof Error && error.message) return error.message;
  return error == null ? '' : String(error);
}

/** 返回后端错误的稳定 key；原始错误返回 null。用于需要按错误类型分支的场景。 */
export function backendErrorKey(error: unknown): string | null {
  const payload = parseLocalizedError(rawErrorMessage(error));
  return payload ? payload.key : null;
}

// detail 可能本身就是一个本地化错误（多层包裹），递归还原成当前语言。
function renderDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const nested = parseLocalizedError(detail);
  if (nested && i18n.exists(nested.key)) {
    return i18n.t(nested.key, { ...nested.params, detail: renderDetail(nested.detail) });
  }
  return detail;
}

/** 把后端错误渲染成当前语言；无法识别为多语言 key 的错误原样返回。 */
export function formatBackendError(error: unknown): string {
  const message = rawErrorMessage(error);
  if (!message) return '';

  const payload = parseLocalizedError(message);
  if (payload && i18n.exists(payload.key)) {
    return i18n.t(payload.key, { ...payload.params, detail: renderDetail(payload.detail) });
  }
  if (i18n.exists(message)) return i18n.t(message);
  return message;
}
