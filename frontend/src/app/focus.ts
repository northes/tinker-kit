function isHiddenFocusTarget(el: HTMLElement) {
  return Boolean(el.closest('.is-hidden, [hidden], [inert], [aria-hidden="true"]'));
}

function canRestoreFocus(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (el instanceof HTMLButtonElement && el.disabled) return false;
  if (
    (el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement) &&
    el.disabled
  )
    return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (isHiddenFocusTarget(el)) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function firstFocusable(root: ParentNode | null): HTMLElement | null {
  if (!root) return null;
  const nodes = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  for (const node of nodes) {
    if (canRestoreFocus(node)) return node;
  }
  return null;
}

export function restoreFocusAfterManage(previous: HTMLElement | null) {
  const targets = [
    canRestoreFocus(previous) ? previous : null,
    firstFocusable(document.querySelector('.workspace .tool-slot:not(.is-hidden)')),
    document.querySelector<HTMLElement>('.sidebar [aria-current="page"]'),
    document.querySelector<HTMLElement>('.sidebar-palette'),
    document.querySelector<HTMLElement>('.sidebar-toggle'),
  ];
  for (const target of targets) {
    if (!canRestoreFocus(target)) continue;
    target.focus();
    if (document.activeElement === target) return;
  }
}
