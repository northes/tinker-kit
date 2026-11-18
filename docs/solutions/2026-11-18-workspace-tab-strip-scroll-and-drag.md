# 工作区标签条：换序后视口跳回与拖动落点错位

## 现象

1. **换序后视口被拉回**：标签条可横向滚动且激活项在末尾时，用户先滚到前面，再拖动前面的标签换序，松手后 `scrollLeft` 被拉回，视线跳回最后一个激活标签（瞬时跳，不是动画）。
2. **往右拖第一个标签落点不对**：从第一个标签一直往右拖，标签条发生滚动后松手，标签插入位置落后于光标，像是少挪了几格。

涉及文件：`frontend/src/app/WorkspaceTabBar.tsx`、`frontend/src/app/workspace-tabs.ts`。

## 根因

### 换序后跳回

`useLayoutEffect(..., [activeId, tabs])` 在 `tabs` 变化时无条件调用 `scrollTabIntoView`，直接写 `viewport.scrollLeft`。拖动换序只改 `tabs`、不改 `activeId`，也会触发，把用户手动滚过的位置覆盖掉。

### 拖动落点错位

1. **屏幕坐标**：`onDragStart` 把各标签中线记成 `getBoundingClientRect()` 的屏幕 `clientX`，碰撞时用指针的屏幕 `clientX` 比较。拖动过程中用户滚了标签条，`scrollLeft` 变了，中线在屏幕上的位置跟着变，但 ref 里仍是按下时的值，比较基准与眼前布局脱节。
2. **每次只越一格**：`nextDragOverId` 每帧最多相对当前 `over` 挪到相邻一格。指针在一帧内跨过多条中线时（快速往右拖），落点停在中途，松手索引小于光标所在格。

## 尝试与误区

- **给跳回加 `scroll-behavior: smooth`**：滚动时机仍绑在 `tabs` 上，只是改成滑过去；没有区分「用户手动滚过」与「必须露出激活标签」。
- **打开 dnd-kit `autoScroll`**：与 OverlayScrollbars 视口抢滚动，标签条上已有注释禁止开启；不能用来修落点。
- **只靠子代理改滚动、不改落点坐标**：换序不再跳回后，仍会因屏幕坐标 + 单步越线出现「松手位置不对」。
- **补滚动画 `writeProgramScroll` 先写 DOM 再记 ref**：`scrollLeft` 赋值同步派发 `scroll`，监听误当用户滚动，`cancelRevealAnimation` 把 rAF 补滚停在第一帧（已单独修了先记预期值再写入）。

## 最终方案

### 视口何时露出激活标签

手动滚过之后保持 `scrollLeft`，仅在三种情况露出激活标签：

| 情况 | 行为 |
|------|------|
| `activeId` 变化 | 瞬时最小位移 |
| 被拖的就是激活标签，松手/取消后落在视口外 | 200ms rAF 缓动（与 `--motion-slide-ease` 一致）；用户滚动、新拖拽、`activeId` 再变则取消并停在当前位置 |
| 首次挂视口，或 `ResizeObserver` 见视口/激活标签宽度变化且此前激活标签完全可见、现被裁切 | 瞬时补位；用户已滚出激活标签则不拉回 |

`tabs` 换序、增删不触发露出。程序写 `scrollLeft` 前写入 `programScrollValueRef`，忽略由此触发的 `scroll`。

主要提交：`f70ba88`（滚动保持）、拖拽落点修复在 `workspace-tabs.ts` + `WorkspaceTabBar.tsx` 的 `contentX` / `nextDragOverId` 循环越线。

### 拖动碰撞

- 中线与指针统一为**内容坐标**：`clientX - viewportRect.left + viewport.scrollLeft`（`WorkspaceTabBar` 内 `contentX`）。
- `nextDragOverId`：一次采样内 `while` 式沿已越过的中线连续前进/后退，保留相邻中线之间的回摆死区（原 hysteresis 测试仍适用）。
- `DndContext` 保持 `autoScroll={false}`。

### 测试

- `wails3 task test:workspace-tabs`：含多格越线的 `nextDragOverId` 用例。
- 人工：多标签横向滚到前部 → 拖非激活标签换序 → 视口不动；拖第一个标签快速右移并滚条 → 松手位置与光标一致。

## 预防与检索关键词

- `WorkspaceTabBar` `useLayoutEffect` `tabs` `scrollLeft` `scrollTabIntoView`
- `nextDragOverId` `DragSlot` `contentX` `grabOffsetRef` `pitchRef`
- 标签条滚动 拖动换序 dnd-kit OverlayScrollbars autoScroll false
- `pendingRevealRef` `programScrollValueRef` `tabRevealScrollLeft`

改标签条滚动或拖拽碰撞前，先读本篇与 `docs/workspace-tabs.md` 产品约定，勿再把 `tabs` 绑进无条件滚入视口。

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-11-18 | 初稿：换序跳回 + 拖动落点错位根因与最终方案 |
