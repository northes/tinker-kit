# 弹窗滚动区左右留白不对称

## 现象

SSH 配置表单、主机指纹编辑、目标主机表单里，输入框离弹窗左缘明显比右缘远。指纹编辑页在表单上方还会多出一个搜索框。

## 根因

`ScrollArea` 同时写了 `px-6` 和 `[padding-inline-end:var(--overlay-scrollbar-size)]`。`px-6` 把左右都设成 24px，后一条把行末内边距改成 `--overlay-scrollbar-size`（8px）。滚动条是悬浮的，并不占这 24px，于是内容左边 24px、右边 8px。

指纹编辑页的搜索框是另一处：搜索是否显示只看「有记录」，没有排除正在编辑。搜索在滚动区外用对称的 `px-6`，表单在滚动区内用 24/8，两条边对不齐。

## 尝试与误区

- 在滚动内容里用 `sticky` 吸顶搜索和分段标题。`OverlayScrollbars` 视口里 `sticky` 会从内容的上内边距跳到视口顶，列表还会从吸顶块上方的缝里穿出来。
- 只把 `py-5` 从 `ScrollArea` 挪到内容上，吸顶块仍会在开滚时上跳。
- 用 `--scroll-edge-top-inset` 去让边缘渐隐，解决不了吸顶块本身移位。

## 最终方案

- 需要左右对称的弹窗正文只留 `px-6`（或 `px-6 py-5`），不要再把行末内边距收成滚动条宽度。悬浮滚动条画在这 24px 里，不会压住文字。
- 只在没有对称内边距、内容贴边的列表上单独使用 `[padding-inline-end:var(--overlay-scrollbar-size)]`。
- 搜索框放在滚动区外面。指纹弹窗只在列表态显示搜索，编辑态不显示。

## 预防与检索关键词

检索：`padding-inline-end`、`--overlay-scrollbar-size`、`px-6`、`ScrollArea`、左右留白、sticky、OverlayScrollbars。

不要把 `px-*` 和 `padding-inline-end: var(--overlay-scrollbar-size)` 写在同一个滚动容器上。不要在 OverlayScrollbars 的 viewport 里用 `sticky` 做会随滚动跳动的工具条。

## 变更记录

- 2026-11-18：去掉三处弹窗滚动区的行末 8px 覆盖；指纹编辑态不再显示搜索框。
