import { createContext, useContext, useEffect } from 'react';

// 工具只上报当前主机显示名，不拼工具名、方括号或文案。
// 没有 provider（工具在标签插槽外渲染）时为 null，上报必须是空操作。
export const WorkspaceTabTitleContext = createContext<((hostName: string | null) => void) | null>(
  null,
);

// 序号和自定义名不在这里处理。空字符串和纯空白视同没有主机名。
export function hostQualifiedName(toolName: string, hostName?: string | null) {
  const host = hostName?.trim() ?? '';
  if (!host) return toolName;
  return `[${host}]${toolName}`;
}

// 挂载和主机名变化时上报。卸载时清空，让标签回到纯工具名。没有 provider 不抛错。
export function useWorkspaceTabTitle(hostName: string | null): void {
  const report = useContext(WorkspaceTabTitleContext);

  useEffect(() => {
    report?.(hostName);
  }, [report, hostName]);

  useEffect(() => {
    if (!report) return;
    return () => {
      report(null);
    };
  }, [report]);
}
