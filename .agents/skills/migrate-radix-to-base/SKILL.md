---
name: migrate-radix-to-base
description: Migrates React projects and components from Radix UI to Base UI. Use when asked to migrate from radix, move to base-ui, convert radix primitives, or switch a shadcn project's base library. Handles single components ("migrate accordion") and whole projects.
---

# Radix UI -> Base UI migration

You migrate shadcn wrappers, hand-rolled radix compositions, and their
consumers to `@base-ui/react`, keeping the project buildable at every step.
Be precise; never guess a mapping. When a prop or part is not in these
reference files, check `node_modules/@base-ui/react/**/*.d.ts` before
transforming, and record gaps in the report.

## 范围判定与单组件快速路径

- 全量迁移执行完整依赖/API 调查和全量验证；干净工作区、创建分支和提交仅在用户要求时执行，保留已有无关修改。
- 单组件迁移默认只检查目标组件、直接消费者和实际变更边界；不主动要求干净工作区、创建分支、独立 commit 或全量基线构建/安装依赖。沿用现有工作区和依赖，按需要执行针对性检查。
- 只有发现依赖/API 变化、共享 wrapper 或其他跨组件证据时，才扩展检查范围并升级到相应的完整清单。不得因快速路径跳过映射核对、行为差异记录或非 Radix 库隔离。

## Preflight（按范围执行）

1. `npx shadcn@latest info --json` (or the project's runner): gives the
   current base, STYLE (e.g. `radix-lyra`), tailwind version, aliases,
   installed components, and package manager. Trust it over inference.
2. Detect the package manager (packageManager field / lockfile:
   pnpm-lock.yaml, bun.lock, yarn.lock, package-lock.json) and use IT for
   every install. Never leave a stale lockfile.
3. 读取工作区状态并保留无关修改；仅在用户明确要求时创建分支或提交，不将 clean git tree 作为默认前置条件。
4. 全量迁移或用户明确要求时，在触碰依赖前运行项目的 typecheck/build，避免把已有失败归因于本次修改；单组件默认按实际变更边界做针对性检查。
5. 全量迁移或用户明确要求时，将 `@base-ui/react` 与 radix 并存安装；单组件仅在当前变更实际缺少该依赖时，使用项目包管理器安装必要依赖。Radix 包仅在 LAST component 迁移完成后移除（两者可以共存）。

## Strategy: golden pair first, transformation engine second

- **Golden pair via the CLI (preferred).** If the project is shadcn with a
  known style (`radix-<style>`), the shadcn CLI itself is the golden-pair
  executor:
  1. Classify each ui wrapper FIRST: diff the user's file against its stock
     origin, using the components.json style VERBATIM in the URL
     (`https://ui.shadcn.com/r/styles/<style>/<component>.json`,
     files[0].content). This works for prefixed styles (radix-nova) AND
     legacy unprefixed ones (new-york, new-york-v4, default), which are all
     still served.
  2. WHOLE-PROJECT mode: flip `components.json` style `radix-<style>` ->
     `base-<style>` now. PROGRESSIVE mode: do NOT flip yet (the project is
     still mostly radix; the flip happens once, after the last component);
     fetch base variants directly by URL instead
     (`https://ui.shadcn.com/r/styles/base-<style>/<component>.json`).
  3. PRISTINE wrappers, whole-project mode: `shadcn add <component>
     --overwrite` delivers the base variant with the project's exact
     icon/font/preset resolution. Never bulk `--all --overwrite`; go
     component by component, or you drown in unrelated registry version
     drift. PROGRESSIVE mode: never use `--overwrite` (it destroys the
     original that consumers still import); write the fetched base variant
     content to `<component>-base.tsx` instead.
  4. CUSTOMIZED wrappers: fetch the base variant and replay the user's diff
     onto it (their customizations must SURVIVE; `--overwrite` would destroy
     them). Mechanical implementation that works at scale:
     `git merge-file user.tsx radix-golden.tsx base-golden.tsx` (three-way
     merge, radix golden as ancestor) auto-resolves most files; hand-resolve
     conflicts with the reference tables.
   5. 合并结果为 clean 也不是文件干净的证明；leftover sweep 的执行范围和频率遵循 Verify and report，registry 重排函数时尤其要实际检查文件是否仍有过时的 radix hunk。
  This is more reliable than reconstructing transforms; use it whenever the
  pair exists. Consumer/app code has no CLI mechanism: always hand-migrate it
  against `consumer-props.md`.
- **Legacy styles (new-york, new-york-v4, default): classification only, no
  replay.** These have no base counterpart (there is no base-new-york), and
  retargeting onto a base-<style> variant would restyle the user's app. Use
  the radix golden ONLY to detect customizations, then run the transformation
  engine on the user's OWN file: rewire primitives, keep their exact classes,
  apply class-mapping renames. Their look stays theirs. At the end of a
  legacy whole-project migration, FLAG (do not fix): the style name still
  reads as radix to the CLI, so future `shadcn add` will deliver radix
  variants; the user decides whether to switch style or add manually.
- **Transformation engine (fallback).** Hand-rolled radix code, non-shadcn
  projects, unknown styles: transform using `universal-patterns.md` (imports
  in BOTH forms: `radix-ui` and `@radix-ui/react-*`; asChild->render with the
  worked example; Portal>Positioner>Popup; the positioner FORWARD rule; part
  renames), the per-family props tables (`overlays.md`, `menus.md`,
  `form-controls.md`, `disclosure.md`, `display-misc.md`), `class-mapping.md`
  for data-attribute/CSS-var rewrites, and `wrapper-shapes.md` for exact
  target shapes (tooltip arrow, SubContent defaults, select anatomy).

## Modes

**Progressive (default).** "Migrate accordion" = one component, strangler-fig:
1. Detect in-progress state first: an existing `<component>-base.tsx`,
   consumers split between old/new imports. The files ARE the state; resume,
   never restart.
2. If the component imports other ui wrappers still on radix (select ->
   button), STOP and recommend migrating those first, bottom-up.
3. Write the migrated version to `<component>-base.tsx` (original untouched;
   golden-pair content fetched by URL, or transformed by hand, per the
   strategy above). Repoint consumers ONE AT A TIME (imports + the call-site
   props in `consumer-props.md`), then follow the single-component or batch
   typecheck rule in Verify and report; do not repeat an expensive typecheck
   for every consumer. When no consumer imports the original: delete it,
   rename `-base` -> original, and flip imports back. When the LAST radix
   wrapper in the project is finalized, flip `components.json` to `base-<style>`
   and remove radix deps.

**Whole project** (only when explicitly asked): same per-component work in
dependency order (leaf/shared wrappers like button and label first). After
wrappers, sweep ALL app code against `consumer-props.md` — the call-site
break surface is much larger than asChild. Then remove radix deps, install,
full build.

## Hard rules

- NEVER touch non-radix libraries or their wrappers: cmdk (command), vaul
  (drawer), sonner, input-otp, react-day-picker (calendar), recharts (chart).
  Report them as intentionally untouched.
- No Base UI counterpart: AspectRatio -> CSS aspect-ratio div; Label ->
  native `<label>`; VisuallyHidden -> `sr-only`; Direction -> Direction
  Provider (`direction` prop, not `dir`). Popover Anchor and NavigationMenu
  Indicator have no equivalent: inert passthrough + flag.
- `button.tsx` migrates to the REAL `@base-ui/react/button` primitive, never
  a hand-rolled useRender wrapper.
- Behavior deltas are FLAGGED, never silently patched (tabs manual
  activation, menu items not closing on click, nav-menu 50ms delay). The
  target is idiomatic Base UI matching the shadcn base registry.
- Honest reporting: skipped/reverted files are listed as flagged, never as
  migrated. Pre-existing failures are named as pre-existing.

## 验证与报告

- 单组件或迁移批次只扫描目标 wrapper、直接消费者和实际变更边界的残留 Radix 引用；发现跨组件依赖后再扩展范围。全量迁移才扫描全项目。
- 实现完成后的命令验证统一由 `project-validation` 按 diff 执行；不按消费者或组件重复构建。全量迁移或依赖变化需要区分基线失败时，可先运行必要的基线验证。
- 最终回复说明实际迁移范围、行为差异、跳过项、验证结果和具体人工验收步骤。不能把未验证的行为当作已通过。
- 只有用户要求落盘报告时，才写 `.migration/<component>.md`；全量迁移可增加 `.migration/project.md`。报告用中文，包含变更、行为差异、验证和待人工验收项，不强制固定模板。
- 仅在全量迁移或用户询问剩余进度时统计剩余 Radix wrappers，不为单组件迁移附加全仓扫描。
