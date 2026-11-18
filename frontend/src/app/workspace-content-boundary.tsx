import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

const WorkspaceContentBoundaryContext = createContext<HTMLElement | null>(null);

export function WorkspaceContentBoundaryProvider({
  boundaryRef,
  children,
}: {
  boundaryRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setBoundary(boundaryRef.current);
  });
  return (
    <WorkspaceContentBoundaryContext.Provider value={boundary}>
      {children}
    </WorkspaceContentBoundaryContext.Provider>
  );
}

/** 工具页浮层（Select 等）应限制在 workspace 主内容区内，避免延伸到标题栏。 */
export function useWorkspaceContentBoundary(): HTMLElement | null {
  return useContext(WorkspaceContentBoundaryContext);
}
