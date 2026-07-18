# TenetX Mimic Design System

This document describes the design tokens, components, and layout principles that define the visual language of TenetX Mimic. Every value is sourced from the currently-implemented system as of the UI-polish wave (Todos 1-10 completed).

## Atmosphere & Identity

TenetX Mimic is a direct style copy of the `tenetx-mimic-simulation-dashboard-grokv1` reference: bold KPI-dashboard energy, cyan accent (`#22d3ee`), dark surfaces with tonal stepping, `rounded-xl` card lift via shadow. The app adds a persistent left-navigation sidebar (256px wide on desktop, collapsing into a hamburger drawer on mobile) with Ctrl+B toggle, extending the reference's single-page layout into a multi-page shell.

The design prioritizes clarity and hierarchy: large, bold type for page titles; semantic color for status and interaction; elevation via shadow rather than borders; and a responsive grid that adapts from mobile single-column to desktop multi-column layouts.

## Color

All colors are expressed as CSS custom properties. The palette is dark-only (no light mode), ported directly from the grokv1 reference.

### Token table

| Token | Value | Purpose |
|-------|-------|---------|
| `--surface-0` | `#09090b` | App canvas background |
| `--surface-1` | `#18181b` | Card surfaces (primary elevation) |
| `--surface-2` | `#18181b` | Nested/table-head surfaces |
| `--surface-3` | `#27272a` | Inset panels, further-elevated tertiary layer |
| `--surface-overlay` | `#27272a` | Drawer/popover backgrounds |
| `--ink` | `#fafafa` | Primary text |
| `--ink-muted` | `#a1a1aa` | Secondary text, icons |
| `--ink-faint` | `#71717a` | Tertiary/meta text |
| `--line` | `#27272a` | Hairline borders |
| `--line-strong` | `#1f1f23` | Stronger borders, scrollbar thumb |
| `--success` | `#34d399` | Success/done status |
| `--warning` | `#fbbf24` | Warning/in-progress status |
| `--danger` | `#f87171` | Danger/error status |
| `--info` | `#60a5fa` | Informational status |
| `--accent` | `#22d3ee` | Interactive accent (cyan) |
| `--on-accent` | `#09090b` | Text/icon color on accent backgrounds |

### Soft tints (derived)

All soft tints are computed via `color-mix(in srgb, var(--status-color) [14-16]%, transparent)`:
- `--success-soft`: 14% success on transparent
- `--warning-soft`: 16% warning on transparent
- `--danger-soft`: 14% danger on transparent
- `--accent-soft`: 15% accent on transparent

### Shadows

Elevation is expressed via three shadow levels, tuned for dark mode:

- `--shadow-sm`: `0 1px 0 rgb(0 0 0 / 0.4)` — subtle lift, used on buttons and small cards
- `--shadow-md`: `0 10px 30px rgb(0 0 0 / 0.4)` — medium elevation, used on hovered cards and modals
- `--shadow-lg`: `0 24px 70px rgb(0 0 0 / 0.55)` — strong elevation (reserved for future use)

Shadows are wired into Tailwind's utility namespace via `@theme inline` in `index.css`, enabling `.shadow-sm`, `.shadow-md`, `.shadow-lg` utilities that resolve to the custom properties at use time.

## Typography

The type system uses self-hosted fonts via `@fontsource`:

- **Font family (sans):** Inter (self-hosted via `@fontsource/inter`), with fallback to `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- **Font family (mono):** JetBrains Mono (self-hosted via `@fontsource/jetbrains-mono`), with fallback to `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

### Scale and weights

| Role | Class | Size | Weight | Tracking | Example |
|------|-------|------|--------|----------|---------|
| Page title | `text-2xl sm:text-3xl font-bold tracking-tight` | 24px / 30px | 700 (bold) | tight | "Dashboard", "Attempt Detail" |
| Section header | `text-lg font-semibold` | 18px | 600 (semibold) | normal | "Attempts by status", "Root cause" |
| Body/default | `text-sm` | 14px | 400 (normal) | normal | Feature list, description text |
| Code/mono | `text-sm font-mono` | 14px | 400 (normal) | normal | Diff blocks, code snippets |
| Stat/KPI | `text-4xl font-black` | 36px | 900 (black) | normal | Feature count, attempt numbers |
| Badge/chip | `text-[11px] font-semibold` | 11px | 600 (semibold) | normal | Status badges, "Super Admin" |
| Input/button | `text-sm` | 14px | 500 (medium) | normal | Button labels, form inputs |

**Feature-specific notes:**
- Page titles use `tracking-tight` (tighter letter-spacing) for visual impact.
- Section headers (`SectionHeader` component) pair with optional leading icons at `h-4 w-4`.
- Stat numbers use `tnum` (tabular numerals) for alignment in tables and KPI displays.
- All text respects `prefers-reduced-motion: reduce` (animations disabled for those users).

## Spacing & Layout

### Container widths

Two fixed-width containers handle different content types:

- **Wide (`max-w-6xl`):** 1152px — used for dashboards, multi-column layouts, and pages with rich content. Implemented via `<PageContainer size="wide">`.
- **Narrow (`max-w-3xl`):** 768px — used for forms, wizards, and single-column flows (Try it out, nested SAML config). Implemented via `<PageContainer size="narrow">`.

Both containers apply responsive padding:
- Mobile: `px-4 py-6` (16px horizontal, 24px vertical)
- Tablet: `sm:px-6 sm:py-8` (24px horizontal, 32px vertical)
- Desktop: `lg:px-8 lg:py-10` (32px horizontal, 40px vertical)

Containers are centered via `mx-auto w-full`, ensuring they never exceed their max-width while filling available space on smaller screens.

### Sidebar and shell layout

- **Desktop sidebar** (at `lg` / 1024px+): fixed-position, 256px wide (`w-64`), pinned to the left edge below the 49px header (`lg:top-[49px] lg:bottom-0 lg:left-0`), with `lg:border-r` and `lg:border-line` for visual separation. Contains a navigation list (Dashboard, Try it out) and a pinned footer (Super Admin badge, email, Sign out) behind the `authorized` guard. Toggleable via Ctrl+B.
- **Mobile/tablet sidebar** (below `lg`): collapses into a hamburger-triggered drawer (`role="menu"`) containing the same nav items and footer, with an Escape-key close handler.
- **Header** (all breakpoints): sticky, 49px tall, full-width, containing the brand link and mobile hamburger button. At `lg`+, the sidebar takes over navigation; the header remains a top bar.
- **Content column** (at `lg`+): gains `lg:pl-64` to reserve space for the fixed sidebar, preventing content overlap.

### Spacing rhythm

Vertical spacing between major sections uses `space-y-8` (32px) on wide containers and `space-y-6` (24px) on narrow containers. Within cards and components, `gap-2`/`gap-3` (8px/12px) provides breathing room between elements.

## Components

### Primitives from `src/components/ui.tsx`

#### Button
- **Variants:** `primary` (blue accent bg, white text, shadow-sm), `subtle` (card-2 bg, ink text, ring), `ghost` (transparent, hover bg-card-2), `danger` (red bg, white text, shadow-sm)
- **Sizes:** `sm` (h-9, px-3, text-xs), `md` (h-10, px-3.5, text-sm)
- **Classes:** `rounded-lg`, `focus-ring`, `active:scale-[0.98]`, `transition`
- **Props:** `variant`, `size`, `icon` (optional leading icon), `className` (merged via `cn()`)

#### IconButton
- **Purpose:** 44px touch target for icon-only buttons (hamburger, theme toggle, etc.)
- **Classes:** `h-11 w-11`, `rounded-lg`, `focus-ring`, `transition`
- **Props:** `label` (aria-label + title), `active` (optional, applies accent-soft bg/text), `className`

#### Badge
- **Purpose:** Inline status indicators (feature status, "Super Admin", etc.)
- **Tones:** `neutral` (card-3 bg, muted text, ring), `success` (success-soft bg, success text), `warning`, `danger`, `accent`
- **Classes:** `rounded-full`, `px-2 py-0.5`, `text-[11px] font-semibold`, `inline-flex items-center gap-1`
- **Props:** `tone`, `className`, `children`

#### SectionHeader
- **Purpose:** Semantic section headings with optional leading icons
- **Classes:** `text-lg font-semibold`, `flex items-center gap-2`, `text-ink`
- **Icon:** `h-4 w-4 shrink-0 text-ink-muted aria-hidden="true"` (optional)
- **Props:** `icon` (IconName, optional), `className`, `children`

#### Segmented
- **Purpose:** Radio-button group for mutually exclusive options (e.g., view mode toggles)
- **Classes:** `rounded-lg`, `bg-card-3`, `ring-1 ring-line`, active button gets `bg-card shadow-sm`
- **Props:** `options` (array of `{value, label, icon?}`), `value`, `onChange`, `label`, `size` (sm/md)

#### Tooltip
- **Purpose:** Hover/focus-triggered labels for icon buttons
- **Classes:** `rounded-md`, `bg-overlay`, `shadow-md`, `ring-1 ring-line`, `text-[11px] font-medium`
- **Positioning:** `side` prop (top/bottom), positioned via `absolute` with `pointer-events-none`
- **Props:** `label`, `side`, `children`

#### Skeleton & Spinner
- **Skeleton:** `rounded-md bg-card-3 animate-pulse` — placeholder for loading content
- **Spinner:** SVG circle with rotating stroke, inherits `currentColor`

#### SeverityDot
- **Purpose:** Tiny status indicator (2x2 px, rounded-full)
- **Tones:** same as Badge (neutral, success, warning, danger, accent)

### Layout primitives

#### PageContainer
- **Purpose:** Centered, responsive content wrapper
- **Props:** `size` ("wide" → max-w-6xl / 1152px, "narrow" → max-w-3xl / 768px), `className`, `children`
- **Classes:** `mx-auto w-full`, responsive padding (px-4 py-6 / sm:px-6 sm:py-8 / lg:px-8 lg:py-10)
- **Usage:** Wraps the entire page content on every route; early-return loading/error states also use `PageContainer` for consistency

### Shell and navigation

#### AppShell
- **Purpose:** Top-level shell orchestrator composing the 5 independently-built/tested chrome pieces (Toast, Sidebar, Topbar, CommandPalette, MobileNav) and replacing the old monolithic `TopBar.tsx`
- **State ownership:** Owns `commandOpen` (toggled by Cmd+K/Ctrl+K listener and Topbar search trigger), `sidebarCollapsed` (toggled by Ctrl+B, hides Sidebar and drops content column's `lg:pl-64` offset), and derives `title` per-render from `useLocation().pathname` via `ROUTE_TITLES` map
- **ROUTE_TITLES map:** `"/" → "Dashboard"`, `"/mcp" → "MCP"`, `"/mimic/try-it-out" → "Try it out"`. Unmapped routes (ticket-detail paths like `/mimic/:ticket/:feature/:attempt`) fall back to `"TenetX Mimic"` (those routes already get richer context from `<Breadcrumb />` inside Topbar)
- **Keybindings:** Cmd+K or Ctrl+K opens/closes the command palette; Ctrl+B toggles sidebar visibility (replicates the old `TopBar.tsx`'s exact keybinding)
- **Composition:** `<ToastProvider>` wraps the entire shell → `<Sidebar />` (conditionally, if not collapsed) + content column (with optional `lg:pl-64` offset) → `<Topbar title={...} />` + `<main>{children}</main>` → `<MobileNav />` → `<CommandPalette open={...} onClose={...} />`
- **Classes:** Root is `flex min-h-screen flex-col bg-bg`; content column is `flex flex-1 flex-col lg:min-w-0` with conditional `lg:pl-64`

#### Sidebar
- **Purpose:** Fixed-position desktop navigation sidebar (hidden below `lg` breakpoint) with app logo, flat 3-item nav list, Preferences stub, and identity footer
- **Classes:** `hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-line` + `glass-surface` (backdrop-blur utility)
- **Logo header:** Shield icon + "TenetX Mimic" text in a 56px tall bar with bottom border
- **Nav items:** 3 real routes (Dashboard `/`, Try it out `/mimic/try-it-out`, MCP `/mcp`) via `NavLink` with active state `bg-accent/10 text-accent` + left accent bar; inactive state `text-ink-muted hover:bg-card-2 hover:text-ink`
- **Preferences stub:** Button (not a link) that fires `addToast("Settings coming soon", "info")` — no `/settings` route exists yet
- **Footer:** Circular avatar chip showing `getInitials(user?.email)` with decorative status dot, name/email block, optional "Super Admin" badge (gated on `email === SUPER_ADMIN_EMAIL`), and "Sign out" button wired to real auth
- **Auth gating:** Renders `null` if `status !== "authorized"` (same pattern as the old `TopBar.tsx`)
- **Icon system:** Uses `lucide-react` (`LayoutGrid`, `Zap`, `Key`, `Settings`, `Shield`) — new shell chrome uses lucide, not the hand-rolled `icons.tsx` set

#### Topbar
- **Purpose:** Sticky app header with title/breadcrumb slot, Cmd+K search trigger, notification bell, and avatar chip
- **Classes:** `sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur-md md:px-6`
- **Title/breadcrumb slot:** `<Breadcrumb />` (existing component, rendered unconditionally but self-gates to `null` on all routes except `/mimic/:ticket/:feature/:attempt`) coexists with an unconditional `<h1>{title}</h1>` — the two are not mutually exclusive, both render together
- **Search trigger:** Two buttons — desktop version (hidden below `sm`) shows placeholder text "Search pages, actions…" + `⌘K` kbd badge; mobile version (hidden above `sm`) is icon-only. Both call `onOpenCommandPalette()` (the actual Cmd+K listener lives in AppShell)
- **Notification bell:** Icon button with a small accent dot, toggles a dropdown showing "No notifications yet" (honest empty state, no fabricated entries)
- **Avatar chip:** Circular gradient (`bg-gradient-to-br from-accent/40 to-accent/90`) showing `getInitials(user?.email)` — reuses the `--on-accent` token for text contrast
- **Props:** `title` (string, derived by AppShell), `onOpenCommandPalette` (callback, wired by AppShell)
- **Icon system:** Uses `lucide-react` (`Bell`, `Search`) — new shell chrome

#### MobileNav
- **Purpose:** Fixed bottom navigation bar for mobile/tablet (below `lg` breakpoint), with 4 items: 3 real routes + Preferences stub
- **Classes:** `fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-card/95 backdrop-blur-md lg:hidden` with `padding-bottom: env(safe-area-inset-bottom)` for notch/safe-area support
- **Items:** Dashboard `/`, Try it out `/mimic/try-it-out`, MCP `/mcp` (via `<Link>`), Preferences (button, fires toast). Active route gets `text-accent`; inactive gets `text-ink-muted hover:text-ink`
- **Active detection:** Exact-match on `location.pathname === tab.path` (not prefix-match, so ticket-detail routes don't false-match `/mimic/try-it-out`)
- **Icon system:** Uses `lucide-react` (`LayoutGrid`, `Zap`, `Key`, `Settings`) — new shell chrome

#### CommandPalette
- **Purpose:** Modal command/search palette triggered by Cmd+K, with two groups (Navigate, Actions) and substring filtering
- **Classes:** `fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]` backdrop + `animate-scale-in` modal panel
- **Items:** 3 Navigate routes (Dashboard, Try it out, MCP) + 1 Actions item (Generate MCP Token → `/mcp?action=generate`)
- **Filtering:** Case-insensitive substring match on item labels; "No results" message when no matches
- **Keyboard:** Escape closes; ArrowUp/ArrowDown navigate; Enter activates the highlighted item and closes
- **Mouse:** Click to activate; backdrop click closes without navigating
- **Props:** `open` (boolean), `onClose` (callback) — the Cmd+K global listener lives in AppShell, not here
- **Icon system:** Uses `lucide-react` (`Search`, `LayoutGrid`, `Zap`, `Key`) — new shell chrome

#### Toast
- **Purpose:** Non-blocking notification system with auto-dismiss (4s timeout) and manual dismiss button
- **Provider:** `ToastProvider({ children })` wraps the app (wired in AppShell), holds toast state, renders fixed bottom-right stack
- **Hook:** `useToast(): { addToast: (message: string, type?: ToastType) => void }` — throws if called outside provider
- **Types:** `"success" | "info" | "warning" | "error"` (self-contained union, distinct from `ui.tsx`'s `Tone`)
- **Classes:** `fixed bottom-5 right-5 z-50 flex w-full max-w-md flex-col gap-2.5` stack; each toast is `animate-slide-up flex items-center justify-between gap-3 rounded-xl border bg-card/95 p-4 shadow-lg backdrop-blur-md` with tone-specific border/text color
- **Tone mapping:** `success → border-success/30 text-success`, `error → border-danger/30 text-danger`, `warning → border-warning/30 text-warning`, `info → border-info/30 text-info`
- **Icon system:** Uses the hand-rolled `src/components/icons.tsx` set (`check`, `x`, `alert`, `info`) — **deliberate exception to the shell-chrome-uses-lucide rule** (documented in todo 2.1 learnings). Toast is a new component but was intentionally built with the legacy icon set to keep `ui.tsx`'s established convention consistent; this is not an inconsistency but a documented design choice
- **Independent timers:** Each toast has its own 4s `setTimeout`, so multiple toasts expire independently

### Icon system decision (two systems by design)

This app now has **two icon systems by deliberate architectural choice**, not an oversight:

- **`lucide-react`** (installed in Wave 1, todo 1.1): Used for all new shell-chrome components built in Waves 2-4 (Sidebar, Topbar, MobileNav, CommandPalette, McpPage). These are the modern, actively-maintained shell UI that users interact with on every page.
- **Hand-rolled `src/components/icons.tsx`** (existing, pre-Wave 1): Continues serving the untouched legacy pages (TryItOutPage, AttemptDetailPage, SamlConfigPage) and the DashboardPage's existing card grid. These pages were not rebuilt by this plan and retain their original icon sources.
- **Toast exception:** `Toast.tsx` (a new component, built in Wave 2 todo 2.1) uses the legacy `icons.tsx` set despite being part of the new shell chrome. This was a deliberate choice documented in the todo's learnings entry — keeping Toast consistent with `ui.tsx`'s established icon convention rather than introducing lucide-react into the primitives layer. Not a bug, a documented design decision.

The two systems coexist cleanly: shell chrome is modern and unified; legacy pages are untouched; Toast bridges both worlds intentionally. If a future plan unifies the icon system, it would start by replacing the legacy `icons.tsx` set with lucide-react across the untouched pages, then removing the `icons.tsx` import from Toast.

### Page-specific components

#### DiffView
- **Purpose:** Colored unified-diff renderer (no external dependency)
- **Classes:** `overflow-auto whitespace-pre font-mono leading-relaxed`
- **Line coloring:** `+` lines get `bg-success-soft text-success`, `-` lines get `bg-danger-soft text-danger`, `@@` hunk headers get `bg-card-3 text-ink-muted font-semibold`, context lines get `text-ink`
- **Props:** `diff` (raw unified-diff text), `className`

### Dashboard components

#### StatCard
- **Purpose:** Generic KPI display card for dashboard summaries (feature completion rate, feature count, etc.)
- **Props:** `label` (uppercase stat name), `value` (string or number), `subtitle?` (optional secondary text), `children?` (optional nested content, e.g. a progress bar), `className?` (merged via `cn()`), `accent?` (boolean, adds `ring-1 ring-accent/20` for visual emphasis)
- **Classes:** `rounded-xl bg-card-2 p-5 shadow-sm hover:shadow-md transition-shadow`, with optional accent ring
- **Exports:** `computeCompletionRate(features: DashboardFeatureSummary[]): number | null` (calculates `(done count / total) * 100`, returns `null` for empty arrays), `formatCompletionRate(rate: number | null): string` (formats rate as `"X%"` or `"No data yet"` for null)

#### FeatureRegistryList
- **Purpose:** Row-based list of features (replaces the card-grid layout), each showing title, Jira ticket link, status badge, and "View attempt" action
- **Props:** `features` (array of `DashboardFeatureSummary` objects)
- **Classes:** `rounded-xl bg-card-2 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow`, with `divide-y divide-line` list rows
- **Empty state:** Renders a centered card with "No features tracked yet." + "Seed a doc in `mimic_features` to see it here."
- **Row structure:** Title (truncated), Jira ticket link (external, `target="_blank"`), status badge (via `STATUS_TONE`/`STATUS_LABEL` from `@/lib/types`), "View attempt" link to the feature's route
- **Defensive:** Falls back to `"/"` for missing/malformed `routePath` to prevent crashes from bad Firestore data

#### McpStatusCard
- **Purpose:** Dashboard summary of the MCP (Model Context Protocol) integration — token count, tool-call count, deployment status, and optional uptime/latency metrics
- **Props:** `tokenCount` (number), `toolCallCount` (number), `deployed` (boolean), `uptimePct?` (optional, forward-compatible), `latencyMs?` (optional, forward-compatible)
- **Classes:** `rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow`
- **Honest-state design:** When `deployed: false` (the only state this app currently passes), renders "Not yet deployed" badge + real token/call counts, with uptime/latency cells entirely absent from the DOM (never fabricated). When `deployed: true` AND both `uptimePct` and `latencyMs` are defined, renders those metrics in a 2x2 grid; otherwise they remain hidden.
- **Metrics grid:** 2x2 layout showing "X tokens issued", "Y calls logged", and conditionally "Z% uptime" and "Wms latency"
- **Footer:** "Manage tokens" link to `/mcp`

## Motion & Interaction

### Animations

Five keyframe animations are defined in `index.css`:

- **`rise`** (0.4s, spring easing): opacity 0→1, translateY 6px→0. Used for modal/drawer entrance.
- **`fade`** (0.3s, ease): opacity 0→1. Used for content fade-in.
- **`shimmer`** (2s, infinite): translateX −100%→100%. Used for skeleton loading placeholders (`.animate-shimmer`).
- **`slide-up`** (0.3s, cubic-bezier(0.16, 1, 0.3, 1)): translateY 8px→0, opacity 0→1. Used for toast entrance (`Toast.tsx`) and mobile menu reveal.
- **`scale-in`** (0.2s, cubic-bezier(0.16, 1, 0.3, 1)): scale 0.95→1, opacity 0→1. Used for the command palette modal entrance (`CommandPalette.tsx`).

Easing: `--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)` — a spring curve that overshoots slightly for a lively feel.

### Transitions

- **`transition`** (default 150ms): applied to interactive elements (buttons, nav links, cards on hover)
- **`transition-shadow`** (150ms): applied to card hover states for shadow lift
- **`active:scale-[0.98]`**: button press feedback (98% scale, no animation, instant)

### Focus and accessibility

- **`.focus-ring`**: `outline: none` + `box-shadow: 0 0 0 2px var(--surface-0), 0 0 0 4px var(--accent)` on `:focus-visible`. Applied to all interactive elements (buttons, links, inputs).
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` sets `animation-duration: 0.001ms` and `transition-duration: 0.001ms` globally, effectively disabling all motion for users who prefer it.

### Hover and card lift

- **Cards:** `hover:shadow-md transition-shadow` — shadow lifts from `shadow-sm` to `shadow-md` on hover, creating a subtle elevation effect
- **Nav links:** `hover:bg-card-2 hover:text-ink` — background and text color shift on hover
- **Buttons:** `hover:brightness-110` (primary/danger variants) — slight brightness boost for primary actions

## Depth & Surface

### Elevation model

Depth is expressed via three layers:

1. **Base layer** (`--surface-0` `#09090b`): The app canvas, never interactive
2. **Card layer** (`--surface-1`/`--surface-2` `#18181b`): Primary interactive surfaces (cards, panels, form containers)
3. **Tertiary layer** (`--surface-3` `#27272a`): Inset panels, hunk headers in diffs, further-elevated content within cards

### Shape consistency lock

Radius and shadow treatment are strictly paired by role:

- **Cards** (all genuine card surfaces: `AttemptDetailPage` sections, `DashboardPage` feature grid, `TryItOutPage` panels, etc.): `rounded-xl` + `shadow-sm hover:shadow-md transition-shadow` + `ring-1 ring-line`. This is the primary, consistent treatment across every page.
- **Buttons and inputs:** `rounded-lg` — slightly less rounded than cards, maintaining visual hierarchy
- **Stat pill exception:** The "Overall Score" / feature-count stat card on `DashboardPage` uses `rounded-lg` (not `rounded-xl`) to match the reference's own "Overall Score" pill exactly. This is the ONE deliberate exception to the `rounded-xl` rule, not an oversight.
- **Pills and badges:** `rounded-full` — maximum roundness for inline status indicators and chips

All cards use `ring-1 ring-line` for a subtle border, replacing heavy strokes. Shadows provide the primary elevation cue; borders are secondary.

### Tonal shift strategy

Dark mode uses a tonal shift (surfaces are darker, text is lighter) to preserve readability and visual hierarchy:

- Surfaces step from `#09090b` (canvas) through `#18181b` (cards) to `#27272a` (tertiary)
- Text is light (`#fafafa` primary, `#a1a1aa` muted) for contrast
- Accent is bright cyan (`#22d3ee`) for interactive affordance
- Shadows are strong (0 10px 30px black @ 0.4 opacity) to cut through dark backgrounds

## Future placement — ticket-wise list, detail, and nested try-it-out

**This section documents a recommended future architecture. None of it is built by the current plan — it is planning input for a future work pass, not a description of shipped work.**

### Today's architecture (unchanged)

The app currently uses a route-based flow for ticket-wise attempts:

- `/` renders `DashboardPage`, which displays a feature registry list.
- Clicking "View attempt" on a feature navigates to `/mimic/:ticket/:feature/:attempt`, rendering `AttemptDetailPage`.
- Inside `AttemptDetailPage`, a "Try it out" CTA conditionally renders `SamlConfigPage` (nested inline, not a separate route) depending on the feature slug.

This structure is not rebuilt by this plan and remains unchanged.

### Recommended future target: master/detail split view

The reference UI (`tenetx-mimic-simulation-dashboard-grokv1`) uses a master/detail split layout for simulations: a left sidebar with a searchable, filterable list of items; a right panel showing the selected item's full details; and action buttons (Re-run, Open in JIRA) in the detail pane's header. This layout is more compact and navigable than the current route-based card-grid approach, especially for large feature lists.

A future plan could adopt this pattern in one of two ways (both are open questions, not decided here):

1. **In-page replacement**: Replace the current `DashboardPage` feature-card grid with an in-page master/detail split, keeping the same `/` route but changing the internal layout from a grid to a side-by-side list+detail view.
2. **New nav item**: Add a new "Simulations" or "Attempts" nav item (alongside Dashboard and MCP) that hosts the master/detail view, leaving the Dashboard tab to serve a different purpose (e.g., KPI summary).

Either approach would require:
- Reworking the feature list into a left-sidebar search+filter+scroll pane (similar to grokv1's `simulations-client.tsx` lines 93–167).
- Moving the attempt detail view into the right pane, replacing the current route-based `AttemptDetailPage` with an in-pane render.
- Optionally nesting the try-it-out CTA inside the detail pane's header or a dedicated action button, rather than as a separate route.

### DiffView enhancement

The current `DiffView.tsx` component (55 lines) renders unified diffs as plain text with colored lines (`+` green, `-` red, `@@` muted) but no line numbers or gutter. The reference's `diff-viewer.tsx` (98 lines) adds:

- Line numbers in a left gutter (10px wide, right-aligned, muted text).
- A "Copy Fix" button (copies the `after` content to clipboard, with visual feedback).
- A "Expand" button (toggles fullscreen modal overlay).

A future plan could adopt grokv1's `diff-viewer.tsx` as the basis for an enhanced `DiffView` replacement, improving readability for larger diffs. The current implementation is sufficient for the ticket-detail view's typical diff sizes; this is a polish enhancement, not a blocker.

### What is not built

This section documents **planning input only**. The current plan does not:
- Build a master/detail split view for tickets.
- Modify the route-based `/mimic/:ticket/:feature/:attempt` flow.
- Enhance `DiffView.tsx` with line numbers or expand/copy buttons.
- Add a new "Simulations" or "Attempts" nav item.

Any of these changes would require a separate future plan, starting with an explicit architecture decision (in-page vs. new nav item) and a scope definition for the diff-viewer enhancement.

---

**Document status:** Final, all 7 sections populated with real, cited values from the currently-implemented system (Todos 1-10 completed). Every token, component, and rule traces back to actual code in `src/index.css`, `src/components/ui.tsx`, `src/components/PageContainer.tsx`, `src/components/TopBar.tsx`, `src/components/icons.tsx`, and `src/components/DiffView.tsx`. No placeholders or invented values. Future placement section added in Wave 5 (todo 5.1) as planning documentation, not shipped work.
