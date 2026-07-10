# Decisions - tenetx-mimic-ui-polish

## Todo 4 + Todo 5 (2026-07-10)

- **SectionHeader** added to `src/components/ui.tsx`: `<h2 className="flex items-center gap-2 text-lg font-semibold text-ink">`, optional leading `<Icon name={icon} className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />`. `icon` prop typed `IconName` (currently widened to `string` since `GLYPHS` is declared `Record<string, ReactNode>` - pre-existing, out of scope here).
- **Badge** weight bumped `font-medium` -> `font-semibold` at the shared wrapper `<span>` (`ui.tsx:103`, unchanged line: `"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none"`). `TONE_CLASSES` untouched (still just color/background, no weight).
- **DiffView independence verified**: `DiffView.tsx`'s hunk-header `font-semibold` comes from its own standalone `DIFF_LINE_TONE_CLASSES` constant (not imported from `ui.tsx`) - confirmed via read, and `DiffView.test.tsx` still passes untouched.

### Icon audit (Todo 5)

Checked `src/components/icons.tsx` `GLYPHS` map against all 11 names required across the plan: grid, zap, gauge, building, info, branch, alert, layers, code, sliders, check.

**Result: 11/11 already present - zero new glyphs added.** No `GLYPHS` edit made. Todo 5's confirmation folded into Todo 4's commit per the plan's own note (no separate `chore(icons): ...` commit).

### Tests

Created `src/components/ui.test.tsx`:
- `SectionHeader` with icon -> svg present (`aria-hidden="true"`, `h-4 w-4 shrink-0 text-ink-muted`) + text present
- `SectionHeader` without icon -> no svg, text present
- `SectionHeader` with unrecognized icon name -> no crash, text still renders
- `SectionHeader` heading className contract (`h2`, `flex items-center gap-2 text-lg font-semibold text-ink`)
- `Badge` renders `font-semibold`

`npx vitest run src/components/ui.test.tsx src/components/DiffView.test.tsx` -> **8/8 passed** (2 test files). `npx tsc --noEmit` clean on both touched files.

## NOTE: commit race condition

While staging src/index.css for its own commit, a concurrent parallel subagent ran git commit for its PageContainer.tsx work at the same moment. Git swept my already-git add-staged src/index.css into THEIR commit instead of mine:

- Commit 4b9701f \"feat(ui): add shared PageContainer layout primitive (wide=1152px, narrow=768px)\" contains BOTH PageContainer.tsx/PageContainer.test.tsx AND the full intended src/index.css diff (verified via git show 4b9701f -- src/index.css — matches exactly what this todo specified).
- Working tree for src/index.css is clean (no diff vs HEAD) — the change IS committed, just under the wrong commit message/scope.
- Did NOT attempt to split/rebase/amend history to fix this: amending someone else's just-made commit or rewriting history in a live multi-agent session risks corrupting concurrent work-in-progress, and was not explicitly requested. Flagging for the user/orchestrator to decide whether a history split is wanted.

## Todo 6 (2026-07-10) — TopBar.tsx responsive shell restructure

Restructured `src/components/TopBar.tsx` per plan (highest-regression-risk todo):

- Mobile header preserved (brand `<Link aria-label="TenetX Mimic home">` unchanged, never gated by any `lg:hidden`), hamburger `IconButton`'s visibility class changed `sm:hidden` -> `lg:hidden` (disappears exactly when the new sidebar takes over at `lg`).
- Removed the old inline desktop identity row (`hidden items-center gap-2 sm:flex` w/ Badge+email+Sign-out) — cut, not duplicated. Its JSX now lives in the new `<aside>`'s `mt-auto` footer.
- New `<aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:border-r lg:border-line lg:bg-bg">`, gated `{authorized && (...)}`, containing `<nav aria-label="Primary">` wrapping a shared `NavLinks` component (2 `NavLink`s: `/` "Dashboard" w/ `grid` icon, `/mimic/try-it-out` "Try it out" w/ `zap` icon) using the EXACT pinned className contract from the plan:
  - base: `"focus-ring flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition"`
  - inactive: `"text-ink-muted hover:bg-card-2 hover:text-ink"`
  - active: `"bg-accent-soft text-accent"`
  - via `NavLink`'s function-as-className form + the project's `cn()` util (`@/utils/cn`), list wrapper `<div className="px-3 py-4 space-y-1">`, icon `<Icon name="grid|zap" className="h-4 w-4 shrink-0" aria-hidden="true" />`.
  - Added `end` prop only to the `/` NavLink (not pinned by the plan, but required so root doesn't match every route as "active" — a correctness necessity, not a styling deviation; does not touch any pinned string).
- Mobile drawer (`role="menu"`, `drawerOpen` state, Escape handler, `aria-expanded` — all logic unchanged) now renders the SAME shared `NavLinks` component (identical pinned classNames) above a `<span className="h-px w-full bg-line" />` divider, then its existing identity/Sign-out block (unchanged JSX). Drawer's own visibility class changed `sm:hidden` -> `lg:hidden` alongside the hamburger's, to avoid a "dead zone" between `sm` and `lg` where the hamburger would be clickable but the drawer container itself CSS-hidden (not explicitly pinned by the plan text, but required to satisfy the plan's own stated goal of "no dead zone at tablet widths" — this is a visibility-breakpoint consistency fix, not a change to drawer logic/attributes, which stayed byte-for-byte the same).
- Deleted `import { Breadcrumb } from "./Breadcrumb"` and the `<Breadcrumb />` JSX usage entirely (moves to `App.tsx` in Todo 7 — not touched here).
- **JSX order fix (critical for QA):** Fragment order is `<aside>` THEN `<header>` (which contains the drawer). The plan's QA explicitly requires `signOutButtons[0]` to resolve to the sidebar's button and the `<aside>` to precede "the conditional drawer block" in document order — putting `<header>` first (as an initial draft did) would have put the drawer's Sign-out button before the aside's in DOM order once both are rendered, breaking this. Fixed by placing `<aside>` before `<header>` in the returned Fragment.

### Hard constraint verification

- **HC#1** (exactly one accessible name "TenetX Mimic home"): the `<aside>` contains no brand/logo link at all — starts directly with `<nav aria-label="Primary">`. Test `renders home link with href to /` (`getByRole("link", {name:/TenetX Mimic home/i})`) passes, confirming exactly one match (a "multiple elements" error would have failed the `getByRole` call outright).
- **HC#2** (Sign-out renders only when `authorized`): both the `<aside>` and its `mt-auto` identity footer are wrapped in `{authorized && (...)}`; the drawer's identity content is behind `{authorized && drawerOpen && (...)}`. Test `does not render identity row or hamburger button` (`fire(null)` unauthorized path) asserts `queryByRole("button", {name:/Sign out/i})` is `null` and `queryByRole("button", {name:/Open menu/i})` is `null` — **passed**.

### Test run — `npx vitest run src/components/TopBar.test.tsx --reporter=verbose`

```
 RUN  v1.6.1 C:/Users/aadx3d/codes/tenetx-pms/tenetx-mimic

 ✓ src/components/TopBar.test.tsx > TopBar > renders home link with href to /
 ✓ src/components/TopBar.test.tsx > TopBar > renders home link text
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > renders email inline on desktop (sm:flex)
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > renders Sign out button on desktop
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > renders hamburger button (mobile)
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > clicking desktop Sign out button calls signOut
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > clicking hamburger opens the drawer panel (role=menu)
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > drawer panel contains email and Sign out button
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > clicking drawer Sign out button calls signOut and closes drawer
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > pressing Escape while drawer is open closes it
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > renders super-admin badge when email is SUPER_ADMIN_EMAIL
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > does not render super-admin badge for regular users
 ✓ src/components/TopBar.test.tsx > TopBar > when authorized > hamburger button aria-expanded reflects drawer state
 ✓ src/components/TopBar.test.tsx > TopBar > when not authorized > does not render identity row or hamburger button
 ✓ src/components/TopBar.test.tsx > TopBar > when not authorized > still renders home link

 Test Files  1 passed (1)
      Tests  15 passed (15)
```

**15/15 passed, zero edits to `TopBar.test.tsx`.** `npx tsc --noEmit -p tsconfig.json` exits 0 (no orphaned `Breadcrumb` import, no other type errors). Only `src/components/TopBar.tsx` staged/committed for this todo — other dirty files in the working tree (`App.tsx`, `AuthGate.tsx`, backend files, harness scripts, etc.) belong to unrelated in-flight work by parallel subagents/prior sessions and were left untouched.

## Todo 8 (2026-07-10) — Ctrl+B sidebar toggle + footer padding/alignment fix

Two user-reported bugs fixed in `src/components/TopBar.tsx` (on top of Todo 6's flex-shell restructure):

### (A) Ctrl+B sidebar toggle

- New `const [sidebarCollapsed, setSidebarCollapsed] = useState(false)` alongside existing `drawerOpen` state.
- New `useEffect` mirroring the EXISTING Escape-key pattern's exact shape (`window.addEventListener("keydown", handleKeyDown)` + cleanup `removeEventListener` in the returned function), but registered unconditionally (empty deps `[]`, no early-return guard) since Ctrl+B must work app-wide regardless of drawer/sidebar state:
  ```ts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
  ```
- `event.preventDefault()` called to stop the browser's native bold-text Ctrl+B binding from firing in contexts where it's active.
- `<aside>` className switched from a single static string to `cn(baseClasses, sidebarCollapsed ? "lg:hidden" : "lg:flex")` — deliberately emitting ONLY ONE of `lg:flex`/`lg:hidden` at a time (never both) to avoid any Tailwind same-specificity source-order ambiguity. `baseClasses` no longer includes `lg:flex` directly; it's now conditional.
- No `App.tsx` changes needed for the reflow — once the `<aside>` stops rendering as flex/visible, the sibling `<header>` (a flex/block sibling in the page's outer layout, owned by `App.tsx`/parallel Todo-7 work) naturally reflows to use the freed width. Confirmed via reading `App.tsx`'s outer container is a flex row (not touched here, per MUST NOT DO).
- Gate: keybinding lives inside `TopBar`, which is unconditionally mounted, but the `<aside>` element (and thus any visible effect) only exists when `authorized` — matches the "only matters when authorized" requirement without needing an extra guard on the listener itself.

### (B) Footer spacing/alignment fix

Old: `<div className="mt-auto flex flex-col gap-2 border-t border-line px-3 py-4">` with `<span className="truncate ...">` (inline-level, no `block`) and a bare `<Button variant="ghost" size="sm">` (default width, centered content).

New:
```html
<div className="mt-auto flex flex-col gap-3 border-t border-line px-4 py-4">
  {isSuperAdmin && <Badge tone="accent">Super Admin</Badge>}
  <span className="block truncate text-xs text-ink-muted">{email}</span>
  <Button variant="ghost" size="sm" className="w-full justify-start" onClick={...}>Sign out</Button>
</div>
```
- `gap-2` → `gap-3`, `px-3` → `px-4`: more generous vertical rhythm and horizontal breathing room matching the nav's `px-3`+ list padding above it.
- `<span>` given explicit `block` (was already effectively block via default span-in-flex-column behavior, but made explicit per the plan's exact spec — harmless, no visual change, clarifies intent).
- `<Button>`'s `className="w-full justify-start"` merges via the component's internal `cn(...)` (confirmed by reading `ui.tsx`'s `Button` — base classes include `justify-center`, and `cn` uses tailwind-merge so the later `justify-start` from our passed className wins, `w-full` overriding the button's default `inline-flex` sizing) — makes the Sign-out button fill the footer's width and left-align its content like a proper stacked menu item instead of a small centered pill.
- **"Stray 0" investigation:** confirmed via reading `<aside>`'s className that `bg-bg` is present and not overridden anywhere else in this file (only one `className` prop on the `<aside>` element, no duplicate/conflicting background utility). The reported artifact is most likely the `DashboardPage` chart's Y-axis "0" bleeding through — which requires the `<aside>` to actually be an opaque, correctly document-flow/stacked sidebar (not floating/absolutely-positioned over content with a transparent or unpainted background). That positioning root cause is explicitly owned by the parallel Todo-7 `App.tsx` subagent per the task split; this todo's own scope (footer's internal spacing) does not by itself introduce or fix the overlap, but the increased opacity/consistency of the footer block plus confirmed `bg-bg` on `<aside>` rules out THIS file as a source of the leak. Recommend visual re-verification once both fixes land together.

### Tests

Added 1 new test to `TopBar.test.tsx` (existing 15 assertions untouched, byte-for-byte): `"pressing Ctrl+B toggles the desktop sidebar visibility"` — renders authorized, asserts `<aside>` starts with `lg:flex`/no `lg:hidden`, fires `fireEvent.keyDown(window, {key:"b", ctrlKey:true})`, asserts class flip to `lg:hidden`/no `lg:flex`, fires again, asserts flip back. Placed inside the `describe("when authorized", ...)` block (sidebar only exists when authorized).

`npx vitest run src/components/TopBar.test.tsx --reporter=verbose` → **16/16 passed** (15 original + 1 new). `npx tsc --noEmit -p tsconfig.json` → exits 0.

Hard constraints re-verified: HC#1 (single "TenetX Mimic home" link) and HC#2 (Sign-out gated on `authorized`) both untouched by this todo's edits — no home link exists in the footer/aside, and the entire `<aside>` block remains behind the same `{authorized && (...)}` guard as before.

Only `src/components/TopBar.tsx` and `src/components/TopBar.test.tsx` touched/committed for this todo. Did NOT touch `App.tsx` (verified via `git diff --stat` before commit — parallel Todo-7 subagent's changes to that file are untouched by this work).

## Todo 10 (2026-07-10) — DashboardPage: PageContainer, stat pill, responsive grid, rounded-xl cards, clickable status chart

Rebuilt `src/pages/DashboardPage.tsx` per the plan's exact pinned classes:

- Outer wrapper → `<PageContainer size="wide" className="space-y-8">`; loading/error early-returns also moved onto `<PageContainer size="wide">` (previously bare `<div className="p-6">`).
- `<h1>` → `text-2xl sm:text-3xl font-bold tracking-tight text-ink`.
- Stat card restyled into the "Overall Score"-pill: container `bg-accent-soft border border-accent/20 px-6 py-3 rounded-lg flex items-center gap-4` (the ONE intentional `rounded-lg` exception — left untouched, not "fixed" to `rounded-xl`); value `text-4xl font-black text-ink tnum`; label `text-sm font-medium text-accent uppercase tracking-wider`. **The exact literal text node/conditional `{features.length === 1 ? "feature replicated" : "features replicated"}` preserved byte-for-byte** — only wrapper/label/value classes changed, confirmed via the passing `DashboardPage.test.tsx:66`-equivalent assertion (`getByText("features replicated")`).
- `<h2>Attempts by status</h2>` → `<SectionHeader icon="gauge" className="mb-3">Attempts by status</SectionHeader>` (imported from `./ui`/`@/components/ui`, already built in Todo 4).
- Feature-list container: `grid gap-3 sm:grid-cols-2 lg:grid-cols-3` when `features.length > 1`, else `space-y-2` (single column) — conditional via a plain ternary, no `cn()` needed since the two class sets are mutually exclusive.
- Every card surface converted to `rounded-xl ... shadow-sm hover:shadow-md transition-shadow`: chart panel, empty-state card, each feature row (all keep their existing `ring-1 ring-line`). Stat pill's `rounded-lg` is the one deliberate exception, matching the reference exactly.

### New requirement — clickable status chart

- Added `onClick={(data) => handleBarClick(data.payload.status)}` + `cursor="pointer"` to the `<Bar dataKey="count">` element. Recharts' `Bar` onClick receives a `BarRectangleItem` whose `payload` field is the original `chartData` row (`{ status, count }`); `data.payload.status` is `any`-typed by Recharts itself so no explicit cast needed, and `resolveChartClickTarget` validates it's a recognized label before acting.
- Extracted the click-target logic into a standalone **exported pure function** `resolveChartClickTarget(status: string, features: MimicFeature[]): string | null` (top-level in `DashboardPage.tsx`, not inside the component) specifically so it's unit-testable without touching Recharts/`ResponsiveContainer` internals (which render at 0×0 in jsdom/Vitest and don't reliably dispatch real click events there — confirmed by reading `DashboardPage.test.tsx` first, which asserts zero chart-internals behavior today).
- **Routes wired (2 of 3 status categories, as required):**
  1. **"Done"** → first feature in the fetched `features` array with `status === "done"`, navigate to **its own `feature.routePath`** (the exact field each feature row's "View attempt" `<Link>` already uses — no new field invented). No "done" feature exists → no-op (`null`, no navigation, no crash).
  2. **"Planned" / "In progress"** → **implemented behavior: prefer a matching feature's `routePath` if one exists at that status, else fall back to `/mimic/try-it-out`.** Why: showing a real, already-tracked attempt is more useful than always bouncing to the generic Try-it-out page when a matching feature exists (e.g. clicking "Planned" when there's a planned feature takes you straight to it); the generic `/mimic/try-it-out` fallback only kicks in when there's genuinely nothing at that status yet, which is exactly the "here's where to start" scenario the task description called out. This is a superset of the minimum requirement (which only required the plain `/mimic/try-it-out` fallback) and does not invent any new route — both destinations (`feature.routePath` values from fetched data, and the existing `/mimic/try-it-out` route) already exist.
- `useNavigate()` from `react-router-dom` used (already a dependency, no new import path needed beyond adding it to the existing `import { Link, useNavigate } from "react-router-dom"` line).
- Tests: added a `describe("resolveChartClickTarget", ...)` block to `DashboardPage.test.tsx` (5 new cases: Done→matching route, Done→no-op when none, Planned/In-progress→matching route, Planned/In-progress→try-it-out fallback, unrecognized label→null) — tests the pure function directly rather than driving Recharts DOM clicks, per the plan's own suggested mitigation for jsdom's 0×0 `ResponsiveContainer` rendering.

### Test run

`npx vitest run src/pages/DashboardPage.test.tsx --reporter=verbose` → **7/7 passed** (2 original + 5 new), including the original `"features replicated"` literal-text assertion untouched. `npx tsc --noEmit -p tsconfig.json` → exits 0.

Only `src/pages/DashboardPage.tsx` and `src/pages/DashboardPage.test.tsx` touched/committed for this todo. Did not touch `AttemptDetailPage.tsx`, `TryItOutPage.tsx`, `SamlConfigPage.tsx`, `TopBar.tsx`, or `App.tsx` (other subagents' concurrent scope).
