// 工作区视图转场：标签切换、打开、关闭时给内容和标签做一次淡入淡出 + 轻微位移。
// 只服务用户驱动的标签变化；初始挂载、配置恢复和主题转场期间直接提交状态。
import { flushSync } from 'react-dom';

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => ViewTransition;
};

// 同一时刻只允许一段工作区转场：重叠调用会让前一段被跳过，回调可能不执行。
let activeTransition: ViewTransition | null = null;

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// animate 为 false 时不建转场，直接提交；转场不可用或降级动画时同样直接提交。
export function runWorkspaceViewTransition(update: () => void, animate: boolean): void {
  const viewTransitionDocument = document as ViewTransitionDocument;
  if (
    !animate ||
    activeTransition ||
    !viewTransitionDocument.startViewTransition ||
    prefersReducedMotion()
  ) {
    update();
    return;
  }
  const root = document.documentElement;
  let applied = false;
  // view-transition-name 只在工作区转场期间挂上（见 foundation.css），
  // 主题切换的 root 遮罩转场才不会把标签和内容拆成独立快照。
  root.dataset.workspaceViewTransition = '';
  let transition: ViewTransition;
  try {
    transition = viewTransitionDocument.startViewTransition(() => {
      applied = true;
      flushSync(update);
    });
  } catch (error) {
    delete root.dataset.workspaceViewTransition;
    console.error('[workspace] view transition failed', error);
    update();
    return;
  }
  activeTransition = transition;
  const finish = () => {
    // 转场被外部抢占时回调可能没执行，这里补一次，避免这次操作白白丢掉。
    if (!applied) flushSync(update);
    if (activeTransition === transition) activeTransition = null;
    delete root.dataset.workspaceViewTransition;
  };
  void transition.finished.then(finish, finish);
}
