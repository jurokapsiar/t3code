t3 factory that runs on top of t3 code serve backend and provides a way to have an overview of sessions across multiple serve instances defined by host and port. sessions can be groupped into projects. main view hs cards fornfavorite projects and a tree table of all projects. expanding shows sessions - there should be filters for state. provide ways to see files, diffs and open chat in an iframe on side (turms table into side pane) or full screen. use headles fluent ui react tenstack query and zuatand/zod. The t3 serve backend acts as the central control plane and single source of truth for the entire T3 Code environment.
Does t3 serve Provide Enough Session Information?
t3 serve captures and provides a complete view of the session state. Because clients (Desktop app, Web browser, iOS, and Android) are thin presentation layers that connect via RPC, the server maintains:
Thread & Turn State: Whether an agent is active, waiting for approval/input, finished, failed, or settled.
Granular Diff & File State: Exact file modifications, line changes, git worktree branches, and uncommitted edits made during the run.
Turn Checkpoints: Hidden Git snapshot refs created before and after every turn to enable turn-by-turn diffing and message-level reverts.
Execution & Output Streams: Tool invocations, command stdout/stderr logs, token usage, and live terminal buffers.
Permission Requests: Intercepted system requests (e.g., shell command execution or write permissions) ready to be prompted to the user.
Session Lifecycle (Threads & Turns)
In T3 Code, a session is represented as a Thread (a long-running workspace task) containing multiple Turns (a single user-agent message exchange).
[Thread Init] ──> [Turn Started] ──> [Agent Execution / Tool Use] ──> [Approval Intercept (If Supervised)] ──> [Turn Completion / Checkpoint]
Phase 1: Session & Workspace Initialization
Thread Creation: A thread is instantiated inside a Project directory or an isolated Git Worktree (T3CODE_WORKTREE_PATH).
Environment Setup: t3 serve triggers optional setup actions (e.g., npm install or environment variable injection) inside the workspace root.
Phase 2: Turn Start & Pre-Turn Snapshot
The user selects a provider CLI (e.g., Claude Code, Codex, OpenCode, Grok Build), permission mode (Supervised vs. Unsupervised), and sends a prompt.
Pre-Turn Checkpoint: t3 serve records a hidden Git ref (refs/t3/...) marking the workspace state prior to agent edits.
The turn state transitions to active.
Phase 3: Live Agent Run & Interactivity
Streaming Output: As the underlying CLI agent thinks and invokes tools, t3 serve streams normalized event data to connected clients.
Permission Interception (If Supervised): If the agent executes a restricted shell command or edits files, t3 serve pauses execution and sets state to waiting. An approval card is broadcast to the web/mobile clients.
Phase 4: Settlement & Checkpointing
The agent completes its prompt response or yields.
Post-Turn Checkpoint: t3 serve writes another hidden Git snapshot ref, calculates the exact diff produced by that turn, and transitions state to finished / settled.
Revert (Optional): If the user chooses to undo a turn, t3 serve rolls back both the Git workspace via checkpoint refs and the agent's internal conversation context.
How t3 serve Gathers Information
t3 serve gathers state by combining direct system control with an Adapter Pattern that wraps native CLI tools:
Provider Adapters & Stream Normalization:
Rather than reinventing AI agent logic, t3 serve spawns the user's local CLI tools (e.g., claude, codex, opencode). It reads raw stdout, stderr, and JSON RPC output streams from these processes and runs them through provider adapters. These adapters translate vendor-specific messages into a unified T3 Event stream.
Direct Workspace & Git Execution:
Because t3 serve runs locally on the host machine containing the repository, it executes Git commands directly. It manages Git worktrees, checks modified file statuses, creates hidden refs, and reads directory contents directly from the filesystem rather than depending on client-sent data.
Process & PTY Monitoring:
For embedded terminals and running scripts, t3 serve manages pseudo-terminal (PTY) instances directly. It maintains output buffers locally so reconnecting clients immediately re-sync without losing logs.
WebSocket / RPC State Subscriptions:
Client apps subscribe to specific thread IDs over WebSocket RPC endpoints. t3 serve pushes incremental state patches (deltas) directly to clients, guaranteeing that desktop and mobile apps display identical live state in real time.

---

# UI implementation guide (for agents)

Stack: React 19 + Vite+ + TypeScript, monorepo **pnpm/Vite+** toolchain. State: zustand (`src/store/useT3Store.ts`), zod, TanStack Query.
UI: **Fluent UI headless components** wrapped in a local design system, styled with **CSS Modules + CSS cascade layers**,
themed to the **CAP theme** look. Icons: `lucide-react`. **No Tailwind, no base-ui, no other component library.**

## Hard rules

1. Never use Tailwind/utility class strings or inline style objects for visual styling. Every component gets a sibling `Foo.module.css`.
2. Never render raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>`, or hand-rolled pills/chips/cards/tabs/menus/tooltips.
   Use the design-system wrappers (see mapping below). Plain elements are only for layout or semantics
   (`header`, `main`, `nav`, `section`, `h1-h6`, `p`, `code`, `pre`, `ul/li`, `table`, `iframe`).
3. App code imports UI **only from the design-system barrels** (relative paths):
   - `src/design-system/actions.ts`: Button, ToggleButton, MenuButton, Badge, CounterBadge, Card*, Divider, Link, Spinner,
     ProgressBar, Skeleton*, Tooltip, Toolbar*, TabList/Tab, Tag/TagGroup, Table* + TreeToggle
   - `src/design-system/forms.ts`: Dialog*, Drawer*/OverlayDrawer/InlineDrawer, Field, Label, Input, Textarea, Select, SearchBox,
     Checkbox, Switch, RadioGroup/Radio, Menu*, Popover*, MessageBar*
     Do not import `@fluentui/react-headless-components-preview` directly from app code. Only design-system components do that.
4. Colors, radii, spacing, typography, shadows and motion come **only from tokens** (`var(--…)` in `src/design-system/tokens.css`).
   Never use hard-coded hex values (except data-viz/diff colors, which already exist as tokens: `--diff-*`, `--terminal-*`).
5. Never override design-system internals from app CSS (no `!important`, no reaching into `[data-…]` of DS parts). If a DS
   component lacks a variant, add a visual prop to the DS component instead.

## Factory data layer

Use one connection owner outside React for factory socket lifetime, retries,
and readiness. The one-attempt Effect transport in `src/factory/transport.ts`
checks cookie authentication and server capabilities first. Reference-count
stream leases; the last consumer cancels its stream. Keep server data in Query
with composite keys that include factory identity and the full target. Use
`targetKey({ environmentId, threadId })` for row and React IDs. Migrate the
existing mock/store API in stages; remove a legacy field only after its last
screen and action reader is migrated. The final rule is: **no domain data in Zustand.**

## Component API docs (read before using)

- Local API reference for our wrappers, including visual props, defaults and examples:
  - [docs/design-system/api-actions.md](docs/design-system/api-actions.md)
  - [docs/design-system/api-forms.md](docs/design-system/api-forms.md)
- Fluent headless docs (index): https://storybooks.fluentui.dev/headless/llms.txt
  Per component: `https://storybooks.fluentui.dev/headless//llms/components-<name>.txt`, for example
  [button](https://storybooks.fluentui.dev/headless//llms/components-button.txt),
  [dialog](https://storybooks.fluentui.dev/headless//llms/components-dialog.txt),
  [menu](https://storybooks.fluentui.dev/headless//llms/components-menu.txt),
  [tablist](https://storybooks.fluentui.dev/headless//llms/components-tablist.txt),
  [drawer](https://storybooks.fluentui.dev/headless//llms/components-drawer.txt).
  Overview and architecture: https://storybooks.fluentui.dev/headless//llms/overview-architecture.txt
- Installed types are the source of truth for props: `node_modules/@fluentui/react-headless-components-preview/dist/<name>.d.ts`
  (package version pinned to `0.3.1`. It is a preview package, so the docs can be ahead of the installed version).
- Fluent demo styles that our CSS is adapted from:
  `https://raw.githubusercontent.com/microsoft/fluentui/master/packages/react-components/react-headless-components-preview/stories/src/<Component>/<component>.module.css`
  (tokens: `…/stories/.storybook/tokens.css`). `gh api` calls to microsoft/* may fail with SAML 403; use unauthenticated `curl` against raw.githubusercontent instead.
- CAP theme reference: `@fluentui-contrib/react-cap-theme` (npm). **Do not add it as a dependency.** It is Griffel/Fluent-v9 based;
  install it temporarily outside the repo (for example `/tmp`) only to read token/style values, then translate them to tokens/CSS.

## Which component to use

| Need                        | Use                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Action / icon button        | `Button` (`appearance` secondary·primary·subtle·outline·transparent, `size`, `icon`). Icon-only buttons need `aria-label` (and usually a `Tooltip`)                                                                                                                                                                                                          |
| Toggle / segmented control  | `TabList appearance="pill"` or `ToggleButton`                                                                                                                                                                                                                                                                                                                |
| View / section navigation   | `TabList` + `Tab` (underline)                                                                                                                                                                                                                                                                                                                                |
| Row/overflow actions        | `Menu` + `MenuTrigger` + `MenuButton`/`Button` + `MenuPopover` + `MenuList` + `MenuItem`                                                                                                                                                                                                                                                                     |
| Button groups / action bars | `Toolbar`, `ToolbarButton`, `ToolbarDivider`                                                                                                                                                                                                                                                                                                                 |
| Status, labels, counts      | `Badge` (`color`, `appearance`, `dot`, `pulse`, `mono`), `CounterBadge`, `Tag`                                                                                                                                                                                                                                                                               |
| Containers                  | `Card`, `CardHeader`, `CardFooter` (`tone`, `interactive`)                                                                                                                                                                                                                                                                                                   |
| Modal                       | `Dialog` > `DialogSurface` > `DialogHeader`/`DialogTitle`, `DialogBody` (scrolls), `DialogActions` (pinned). `DialogContent` does **not** exist in 0.3.1. Close button: `<DialogTrigger action="close"><Button appearance="subtle" icon={<X/>} aria-label="Close dialog"/></DialogTrigger>`                                                                  |
| Side panel / mobile menu    | `OverlayDrawer` / `InlineDrawer` + `DrawerHeader`/`DrawerBody`/`DrawerFooter`                                                                                                                                                                                                                                                                                |
| Forms                       | `Field` (label/hint/validation) wrapping `Input`, `Textarea`, `Select`, `SearchBox`, `Checkbox`, `Switch`, `RadioGroup` (`layout="cards"` for tiles)                                                                                                                                                                                                         |
| Alerts / approval banners   | `MessageBar`                                                                                                                                                                                                                                                                                                                                                 |
| Loading / progress          | `Spinner`, `Skeleton`, `ProgressBar`                                                                                                                                                                                                                                                                                                                         |
| Hints                       | `Tooltip` (`relationship="label"` for icon-only buttons, `"description"` otherwise)                                                                                                                                                                                                                                                                          |
| Tables / tree grids         | **No Fluent headless table exists.** Use TanStack Table **v9** (`@tanstack/react-table`) and render with DS `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHeaderCell`, `TableCell`, `TreeToggle`. Tree rows use `role="treegrid"` semantics with `data-level={depth}` (drives indentation), `data-kind="group"` for parent rows and `data-selected` |

TanStack Table v9 differs from v8 (`useTable`, `tableFeatures({...})`, `createColumnHelper<typeof features, Row>()`).
Do not write v8 code from memory. Read `node_modules/@tanstack/react-table/skills/` (especially `getting-started`, `migrate-v8-to-v9`)
and `node_modules/@tanstack/table-core/skills/`. The reference implementation is `src/components/dashboard/ProjectTreeTable.tsx`.

Icons: `lucide-react`, size 16 (14 small, 20 large), `aria-hidden` when decorative, passed via the `icon` prop or slot.

Domain status → Badge mapping. Always use the shared helper `getSessionStatePresentation` in `src/components/dashboard/sessionState.ts`:
active=success+pulse, waiting=warning, settled=neutral, finished=brand/info, failed=danger (all with `dot`).
Instance status: online=success, checking=warning, unreachable=danger.

## Styling architecture

- Layer order is declared once in `src/index.css`: `@layer reset, tokens, base, components, app, utilities;`
  Later layers win regardless of specificity, so app styles never need specificity hacks.
- `src/design-system/tokens.css` (`@layer tokens`) holds light tokens in `:root` and dark tokens in `[data-theme='dark']`. Token names follow the Fluent
  demo (`--bg`, `--bg-elev`, `--surface-muted`, `--surface-hover`, `--border`, `--text`, `--text-soft`, `--accent`, `--accent-soft`,
  `--success|warning|danger|info(-soft|-border)`, `--radius-control` 12px, `--radius-control-sm` 8px, `--radius-surface` 24px,
  `--radius-popover` 12px, `--control-sm|md|lg` 28/36/44px, `--space-*`, `--font-size-100…700`, `--shadow-1…6`, `--shadow-menu`,
  `--focus-ring`, `--duration-*`, `--ease-*`). Add new tokens there (both themes) instead of inventing values.
- `src/design-system/base.css` contains the reset, base and utilities layers (`.visually-hidden`).
- Theme: `data-theme="light|dark"` on `<html>`, set via the store's `setTheme`/`toggleTheme`. Never use `prefers-color-scheme` for app theming.
- **Design-system CSS** (`src/design-system/components/**.module.css`): wrap all rules in `@layer components { … }`.
- **App CSS** (`src/components/**.module.css`, `src/App.module.css`): wrap all rules in `@layer app { … }`.
- Style state through headless `data-*`/ARIA attributes (`[data-checked]`, `[data-selected]`, `[data-disabled]`, `[data-icon-only]`,
  `[aria-expanded]`, and so on), not JS-toggled classes. DS visual props are emitted as `data-appearance`, `data-size`, `data-color`, ….
- CAP look: calm neutral surfaces, 1px `--border` (stroke4) strokes, 12px control radius, 24px card/dialog radius,
  12px menu radius with 8px items, 3px tab indicator, semibold 14/20 button text, 8px spacing grid.
- Responsive: mobile < 768px, desktop ≥ 768px, wide ≥ 1024px. For components that live in panes of varying width (for example the
  tree table in the split-view navigator), use **container queries** (`container-type: inline-size` + `@container`), not
  viewport media queries. In narrow containers, collapse row actions into a single "…" overflow `Menu`, and let filter `TabList`s scroll horizontally.
- Long text: `min-width: 0` on flex/grid children + ellipsis; put the full value in a `Tooltip`.
- Mobile header (< 768px): the brand is replaced by icon-only pill tabs (Pinned / All / Nodes), and status badges move, compacted,
  into the menu drawer. Project-tree controls use the same two-row layout at every width: scrolling status-colored tabs, then
  session count and an icon-only toolbar with a group-filter menu. Search replaces that toolbar with a focused `SearchBox`;
  Escape/Close clears it and returns focus to the search button (see `ProjectTreeTable` `searchActions`).
- The header is not a separate coloured bar: it is a paper gradient (`--bg-elev` → `--bg`, ≤ 100px) with no border.
- Respect `prefers-reduced-motion` and keep visible focus (`--focus-ring`).

## Adding a new design-system component

1. Read the Fluent headless doc for it (llms link above), its `.d.ts`, and the Fluent demo `.module.css`.
2. Create `src/design-system/components/<Name>/{<Name>.tsx,<Name>.module.css,index.ts}`.
3. Import from the per-component subpath (`@fluentui/react-headless-components-preview/<kebab-name>`, for example `/tab-list`).
4. Wrapper pattern (see `components/Button/Button.tsx`): keep the headless name, `forwardRef`, forward all props, merge `className`
   with `cx()` (`utils/cx.ts`). Add only **visual** props (`appearance`, `size`, `tone`…), exposed as `data-*` attributes.
   Use `DistributiveOmit` (`utils/types.ts`) when overriding union prop types. Offer `icon?: ReactNode` convenience for icon slots. Export prop types.
5. Adapt the Fluent demo CSS inside `@layer components`, replacing values with tokens and CAP values.
6. Export from `actions.ts` (display/actions) or `forms.ts` (inputs/overlays), and document it in `docs/design-system/api-*.md`.

## Gotchas

- **Cascade layer order is fixed by whichever stylesheet loads first.** The order is pinned by an inline
  `<style>@layer reset, tokens, base, components, app, utilities;</style>` in `index.html`, and `src/main.tsx` imports `./index.css`
  before `App`. Keep both. Otherwise CSS modules declare `components`/`app` first and the `reset` layer silently overrides
  design-system styles (for example primary button text colour).
- Native modal `<dialog>` (Dialog, OverlayDrawer) defaults to `height: fit-content`, so side drawers set `height: 100dvh` explicitly.
- Don't reuse a class that sets `flex-basis` (for example a fixed-width select in a row) inside a column flex container such as `Field`,
  because the basis becomes a height. Scope such rules to their row container.

- `DialogSurface` and overlay drawers render a native `<dialog>`. Style the overlay with `::backdrop`. Body scroll and pinned actions
  are handled by `DialogBody`/`DialogActions` layout, so don't add extra wrappers.
- `App.tsx` shares one dashboard project tree across mobile and desktop, preserving local search state across breakpoint changes.
  Mobile Pinned/All sections control visibility rather than mounting duplicate tables. In Playwright, use `:visible` selectors.
- Session detail navigation follows viewport size, not pane width: desktop (≥768px) retains scrollable header tabs even in split view.
  Mobile replaces the heading with a view menu labeled `<active view> - <session title>`; tab state survives resizing.
- Dependencies use the repository lockfile; contracts use `workspace:*` and Effect uses the shared catalog.

## Validate UI changes

```sh
vp run --filter @t3tools/factory typecheck
vp run --filter @t3tools/factory build
grep -rnE '<(button|select|input|textarea|dialog)[ >]' src --include=*.tsx   # must be empty
for f in $(find src -name '*.module.css'); do grep -q '@layer' "$f" || echo "missing @layer: $f"; done
```

When browser verification is authorized, use `vp run dev:factory` (port 3000) in **both light and dark** themes, at 1440px, at a ~480px pane width
(split view navigator), and at 390px mobile. Playwright screenshots work well. Fix overflow, clipping and wrapping before finishing.
