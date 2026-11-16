// 工作区视图转场：标签切换、打开、关闭时给内容和标签做一次淡入淡出 + 轻微位移。
// 只服务用户驱动的标签变化；初始挂载、配置恢复和主题转场期间直接提交状态。
import { flushSync } from 'react-dom';

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => ViewTransition;
};

let activeTransition: ViewTransition | null = null;
let transitionGeneration = 0;

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cancelActiveWorkspaceTransition() {
  if (!activeTransition) return;
  activeTransition.skipTransition();
  activeTransition = null;
  delete document.documentElement.dataset.workspaceViewTransition;
}

// animate 为 false 时不建转场；转场进行中再次切换则跳过动画并立即提交最新状态。
export function runWorkspaceViewTransition(update: () => void, animate: boolean): void {
  const viewTransitionDocument = document as ViewTransitionDocument;
  const generation = ++transitionGeneration;
  const apply = () => {
    if (generation !== transitionGeneration) return;
    flushSync(update);
  };

  const canAnimate =
    animate &&
    !prefersReducedMotion() &&
    Boolean(viewTransitionDocument.startViewTransition);

  if (!canAnimate) {
    cancelActiveWorkspaceTransition();
    apply();
    return;
  }

  if (activeTransition) {
    cancelActiveWorkspaceTransition();
    apply();
    return;
  }

  const root = document.documentElement;
  let applied = false;
  root.dataset.workspaceViewTransition = '';
  let transition: ViewTransition;
  try {
    transition = viewTransitionDocument.startViewTransition!(() => {
      applied = true;
      apply();
    });
  } catch (error) {
    delete root.dataset.workspaceViewTransition;
    console.error('[workspace] view transition failed', error);
    apply();
    return;
  }
  activeTransition = transition;
  const finish = () => {
    if (activeTransition !== transition) return;
    if (!applied) apply();
    activeTransition = null;
    delete root.dataset.workspaceViewTransition;
  };
  void transition.finished.then(finish, finish);
}
