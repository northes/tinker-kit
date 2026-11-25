# 差异对比来源选择器关闭后，顶部标签被画了一圈焦点框

## 现象

在差异对比空侧点「已打开的tab」，用选择器挑中某个 tab 后，顶部标签栏里那个被选中的标签出现一圈焦点框。选择器本身已关闭，焦点却落在标签上。

## 根因

1. 选择器用的是受控 `CommandDialog`，没有触发元素。Base UI 关闭弹窗时会把焦点还给「打开前聚焦的元素」，这个元素由打开瞬间的 `document.activeElement` 决定，与本弹窗的语义无关。
2. 空侧提示里的下划线是 `<button>`。Safari/WKWebView 点击按钮不会让它获得焦点，所以打开前的 `activeElement` 仍然是之前碰巧聚焦的标签，而不是提示链接。
3. 关闭时焦点被还到那个标签；因为用户是用键盘（方向键 + Enter）在列表里选中的，浏览器判定为键盘交互，`:focus-visible` 命中标签的 `focus-visible:ring-3`，于是出现焦点框。

## 尝试与误区

- 一开始怀疑是标签栏自己的 `focus()` 调用：全仓搜索 `frontend/src/app` 与 `App.tsx` 的 `.focus()`，只有空白页搜索框和全局命令面板的焦点恢复，都不是来源。
- 也怀疑过选择器的候选列表或下拉状态触发重新激活标签，核对 `fillActiveDiffFromTab` 只做 `deliver`，不碰焦点和激活状态。
- 真正证据在 `@base-ui/react/floating-ui-react/FloatingFocusManager.mjs`：关闭时 `returnFocus` 默认取打开前的元素，键盘关闭还会显式传 `focusVisible: true`。

## 最终方案

- `CommandDialog` 增加可选的 `finalFocus`，透传给 `DialogContent`（Base UI `Dialog.Popup` 原生支持）。
- 差异对比把 `finalFocus` 指向该侧编辑器：`MergeView` 的视图通过 `viewsRef` 暴露给外层，关闭选择器后焦点回到刚填入的一侧，与工具激活时聚焦编辑器的约定一致。
- 差异对比标签已切走时返回 `false`，不抢焦点，让新标签自己的聚焦生效。
- 没有给标签的焦点环加例外样式：环本身是正确反馈，问题只是焦点不该跑到那里。

## 预防与检索关键词

- 受控弹窗（无触发元素）一定要显式指定关闭后的焦点落点，不要依赖 Base UI 的默认「还回打开前的元素」。
- 排查焦点异常先看 `FloatingFocusManager` 的 `returnFocus` / `finalFocus` / `focusVisible`，再看应用自己的 `.focus()`。
- 关键词：`finalFocus`、`returnFocus`、`focusVisible`、`:focus-visible`、标签焦点框、CommandDialog、WKWebView 按钮不聚焦。

## 变更记录

- 2026-11-25：定位并修复，提交 `fix(diff): return source picker focus to editor`。
