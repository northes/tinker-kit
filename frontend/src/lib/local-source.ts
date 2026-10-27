// 本地来源的统一判定与命名。
//
// Go 端会把 local 来源的 name 统一规范化成「本机」再持久化（见 configservice.go
// 的来源规范化分支），所以展示层不能读 name：否则英文界面会露出中文，用户改名后
// 也会和其它来源选择器不一致。判定只看 id/kind，展示名一律走 i18n。
export const LOCAL_SOURCE_ID = 'local';

export type LocalSourceRef = { id: string; kind?: string };

export function isLocalSource(item: LocalSourceRef): boolean {
  return item.id === LOCAL_SOURCE_ID || item.kind === 'local';
}

// 来源展示名：本地来源用调用方传入的 i18n 文案，其余用用户填写的名称。
export function sourceLabel(item: LocalSourceRef & { name?: string }, localLabel: string): string {
  return isLocalSource(item) ? localLabel : (item.name ?? '');
}
