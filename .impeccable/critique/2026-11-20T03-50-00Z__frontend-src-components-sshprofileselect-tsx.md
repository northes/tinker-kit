---
target: SSH profile filterable combobox review
total_score: 33
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 1
target_identity: "file:/Users/northes/workspace/tinker-kit-ssh-combobox-check/frontend/src/components/SSHProfileSelect.tsx"
target_fingerprint: "sha256:b845caa173f947e301e5c2462c1229484b7f3dd060be6c5850e1ca90f944929c"
target_path: /Users/northes/workspace/tinker-kit-ssh-combobox-check/frontend/src/components/SSHProfileSelect.tsx
timestamp: 2026-11-20T03-50-00Z
slug: frontend-src-components-sshprofileselect-tsx
---
# SSH Profile Combobox Review

> ⚠️ DEGRADED: single-context (本检查子代理不能再派隔离评审代理；按任务要求单上下文完成)
>
> Target: `frontend/src/components/SSHProfileSelect.tsx` and its six call sites. Method: source review first, then detector/manual technical audit. The application was not running, so no screenshot or rendered-state judgment is claimed.

## Design Health Score

| # | Nielsen heuristic | Score | Evidence |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | Selected name, filtered options and no-match copy are represented; no-match live announcement remains unverified/absent. |
| 2 | Match with real world | 3 | Rows show the SSH profile name and `user@host:port`/local alias. |
| 3 | User control and freedom | 3 | Filter text restores on blur; Escape is explicitly handled; gear preserves access to management. |
| 4 | Consistency and standards | 3 | Uses the shared Base UI Combobox and InputGroup patterns. |
| 5 | Error prevention | 4 | Filter text is not a free value; only existing profile IDs can be selected. |
| 6 | Recognition rather than recall | 4 | Name, host, user, port, and local alias can locate a profile. |
| 7 | Flexibility and efficiency | 4 | Supports direct typing and keyboard selection. |
| 8 | Aesthetic and minimalist design | 3 | Compact two-line rows add useful identity details without extra controls. |
| 9 | Error recovery | 3 | Missing-profile state is represented; empty-config plus stale-ID edge still needs correction. |
| 10 | Help and documentation | 3 | The placeholder identifies the control; inline explanation of searchable fields is optional for this focused picker. |
| **Total** | | **33/40** | **Good foundation; remaining issues are edge-state and accessibility details.** |

## Design Specificity Verdict

The picker is grounded in TinkerKit's SSH workflow rather than a generic select: the row identity pairs a human name with a connection address, and filtering supports the host/user/port and local alias users already know. The shared component keeps all six call sites consistent. The implementation uses the existing neutral input, popover and focus-token language. The rendered appearance could not be confirmed because TinkerKit was not running; no screenshot was taken.

The deterministic `impeccable detect --json frontend/src/components/SSHProfileSelect.tsx` scan returned `[]` (zero findings). No ignore rules were needed. The installed CLI does not expose an `audit` subcommand (`impeccable audit ...` returns `Unknown command: "audit"`), so the technical audit below is a source-based manual audit, not a claimed CLI audit.

## What's Working

- Filtering is bound to the existing profile IDs; arbitrary text cannot become a connection value.
- Profile rows carry the name plus monospace address, and long row text is truncated instead of forcing the popup wider.
- Blur restores the selected profile name, and a missing profile remains represented as an unavailable profile instead of crashing.

## P0–P3 Findings

### P0

- None.

### P1

- **Resolved — combobox input had no dependable accessible name** (`SSHProfileSelect.tsx`, `ComboboxInput`). Most call-site labels are sibling text without `htmlFor`; `triggerLabel` only labels the dropdown button. Added `aria-label={placeholderText}` to the text input so the input remains named at all six uses. This was the only P1 and is fixed.

### P2 (left open as required)

- **Empty profiles plus stale ID do not show the disabled empty state** (`SSHProfileSelect.tsx:54–61, 70–77`). The synthetic missing-profile option makes `options` nonempty, so `empty` is false even with `profiles=[]`; that conflicts with the empty-config acceptance criterion.
- **No-match text is not explicitly announced as a status update** (`SSHProfileSelect.tsx:133`; `ui/combobox.tsx:149–160`). `ComboboxEmpty` renders ordinary content without `role="status"`/`aria-live`, so screen-reader users may not hear that the filter returned no results.
- **Very narrow viewport popup width can exceed available width** (`ui/combobox.tsx:64–69`). The popup has both an available-width maximum and a minimum width of anchor width plus spacing; CSS minimum sizing may win when the available viewport is narrower than that minimum. This is source-level risk only; no render was available to confirm it.

### P3

- None identified from source review. No P2-or-lower items were changed.

## Technical Audit Health Score

| Dimension | Score | Finding |
|---|---:|---|
| Accessibility | 3/4 | Input name fixed; dynamic no-match announcement remains. Keyboard semantics are delegated to Base UI. |
| Performance | 4/4 | Small in-memory list, memoized indexes, simple string matching; no layout work or expensive effects. |
| Theming | 4/4 | Uses the shared InputGroup/Combobox and semantic foreground/border tokens. |
| Responsive design | 3/4 | Flexible input and truncated option labels; narrow popup minimum-width edge remains. |
| Implementation integrity | 3/4 | Shared state/value path remains intact; empty+stale edge and missing live announcement remain. |
| **Total** | **17/20** | **Good; address remaining edge-state and announcement items in a follow-up.** |