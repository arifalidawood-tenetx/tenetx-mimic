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

## Todo 7 (2026-07-10) — `App.tsx` flex shell restructure + sidebar pin fix (real bugs found + fixed, not just literal plan text)

**What I changed:**
- `src/App.tsx`: `Main()`'s outer wrapper is now `<div className="flex min-h-screen flex-col bg-bg">` (see "why NOT lg:flex-row" below — this deviates from the plan's literal acceptance-criteria string after live-browser verification proved it actively breaks the header). `<TopBar />` renders first, followed by a new `<div className="flex flex-1 flex-col lg:min-w-0 lg:pl-64">` containing `<Breadcrumb />` (imported fresh — `import { Breadcrumb } from "@/components/Breadcrumb"` — and mounted exactly once) then the existing `<main className="flex-1"><Routes>...</Routes></main>`.
- `src/components/TopBar.tsx`: the `<aside>`'s positioning classes changed from `lg:sticky lg:top-0 lg:h-screen` to `lg:fixed lg:top-[49px] lg:bottom-0 lg:left-0` (kept `lg:w-64`/`lg:border-r`/`lg:border-line`/`lg:bg-bg`/the `sidebarCollapsed` `cn()` toggle from the parallel Ctrl+B todo untouched). This is the ONLY change made to that file for this todo — did not touch the Ctrl+B logic, the footer padding, or anything else the parallel subagent was working on (re-read the file fresh before editing to avoid clobbering their concurrent work, per the dependency note).

**Why fixed, not sticky-in-flex-row — verified empirically against the REAL running dev server (localhost:5173, already-authenticated tab), not assumed from CSS theory alone:**

1. Applied the plan's literal spec first (outer wrapper `lg:flex-row`, aside still `lg:sticky lg:top-0 lg:h-screen`) and screenshotted the live app at 1344px width. Result: the sidebar rendered full-height on the left as expected, but the header ("TenetX Mimic") was reduced to a narrow ~150px-wide box squeezed between the aside and the content column, with the Dashboard content pushed hundreds of px to the right — i.e. exactly the "compressed into a narrow column" anti-pattern the todo explicitly said to avoid, still present after literally following the acceptance criteria. Root cause (confirmed via `getComputedStyle`/`getBoundingClientRect` in the live page): with 3 flex-row siblings (`aside`, `header`, content-wrapper) and `content-wrapper` given `flex-1`, `header` has no `flex-grow`/width utility of its own, so it just shrinks to fit its text content instead of spanning the page.
2. Switched the aside to `lg:fixed lg:inset-y-0 lg:left-0 ...` (removing it from flex flow) while keeping the outer wrapper's `lg:flex-row`. Re-tested live: this made the header genuinely full-width (confirmed via `getBoundingClientRect`: `left:0, width:1334`) — BUT its `height` became `7466px` (matching the full scrollable document height!) because, with the aside now out-of-flow, the row's only two remaining flex items (`header`, content-wrapper) still default to `align-items:stretch` on the row's cross-axis (vertical), so header stretched to match the tallest sibling (the long page content). This is a second, more subtle instance of the exact same anti-pattern.
3. Removed `lg:flex-row` from the outer wrapper entirely (back to plain `flex-col` at all breakpoints), keeping the aside `fixed` (out-of-flow) and adding `lg:pl-64` to the content wrapper to reserve the 256px the fixed sidebar occupies. Re-tested live: header now correctly measures `top:0, left:0, width:1334, height:49` at both `scrollY:0` and `scrollY:4000` (i.e. a normal, compact, full-width top strip, immune to content height) — this is what actually satisfies the acceptance criteria; `lg:flex-row` was not needed once the sidebar is taken out of flow via `fixed`, and empirically was actively harmful when present.
4. Found and fixed a follow-on regression from step 3: with the aside using `lg:inset-y-0` (`top:0` to `bottom:0`), its topmost nav item ("Dashboard") physically overlapped the header's z-30 hit-box. Confirmed via `document.elementFromPoint()` at the Dashboard link's center — the element actually receiving clicks there was the header's inner `<div>`, not the link, i.e. the Dashboard nav item was genuinely unclickable, not just visually adjacent. Fixed by changing the aside's vertical extent from `lg:inset-y-0` to `lg:top-[49px] lg:bottom-0` (49px = the header's live measured height, and the header itself is out of this todo's scope so that value is stable) — re-verified via the same `elementFromPoint` check that "Dashboard" is now the top element at its own center, and both nav items ("Dashboard", "Try it out") are fully visible in the screenshot with zero overlap.
5. Verified scroll-pinning on a real long page (`/mimic/TEN-141/saml-login-fix/1`, `scrollHeight` ≈ 7467px): scrolled to `scrollY: 4000` and re-measured both elements — `aside` rect stayed `top:49 (relative to its own inset)/left:0/width:256`(effectively pinned across the visible viewport height), `header` rect stayed `top:0/left:0/width:1334/height:49` — both fully static in viewport-space across the scroll, i.e. genuinely "stationary and fixed to the left side" per the user's original complaint. Screenshotted for visual confirmation at both scroll positions.
6. Verified mobile (resized live window to 679px width, below the `lg` 1024px breakpoint): sidebar correctly hidden, hamburger + drawer unaffected, drawer opens/closes correctly (confirmed via `browserOS_act` click + accessibility-tree diff showing the `menu` role appearing with Dashboard/Try it out/Sign out) — the `lg:` breakpoint gating on both the aside and the outer wrapper change means mobile layout is byte-for-byte the same flow as before this todo.

**Net effect vs. the plan's literal acceptance-criteria text:** kept the spirit (flex shell, `Breadcrumb` remounted once in the content column, fixed/pinned sidebar) but deviated from the literal `lg:flex-row` outer-wrapper string and the literal `lg:inset-y-0` aside string, because live-browser verification — which this todo explicitly mandated over assumption — proved both would reintroduce the exact bugs (cramped header, sidebar/header overlap) the todo was created to fix. No changes made to `TopBar.tsx` outside the aside's own positioning classes (Ctrl+B toggle, footer padding — all parallel subagent's work — untouched).

**Verification method:** dev-server + real browser, observed directly (not CSS-semantics reasoning alone) — used the already-authenticated `localhost:5173` tab already open in the environment (no seed/login step needed), `browserOS_evaluate`/`getBoundingClientRect`/`document.elementFromPoint` for precise numeric verification, `browserOS_screenshot` for visual confirmation, at both desktop (1344px, 1086px) and mobile (679px) widths, at scroll positions 0 and 4000 on a ~7467px-tall real page.

**Tests:** `npx vitest run src/App.test.tsx src/components/Breadcrumb.test.tsx` → 7/7 passed (App.test.tsx now has 3 tests including 2 added by a concurrent routing-fix subagent for a new `/mimic/:ticket/try-it-out` route — unrelated to this todo, left as-is). `npx vitest run src/components/TopBar.test.tsx` → 16/16 passed (15 original + the parallel subagent's new Ctrl+B test). Full `npx vitest run` → 19 files / 115 tests, all green. `npx tsc --noEmit -p tsconfig.json` → exits 0.

**Commit:** `refactor(app): flex shell layout for sidebar+content; remount Breadcrumb in content column; fix sidebar scroll-pinning`

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

## Todo 12 (2026-07-10) — Breadcrumb padding scale alignment

Single-class update: `src/components/Breadcrumb.tsx`'s `<nav>` className changed from `"px-4 pb-2 sm:px-6"` to `"px-4 pb-2 sm:px-6 lg:px-8"` (adds the `lg` breakpoint horizontal padding step to match `PageContainer`'s responsive scale, aligning the breadcrumb horizontally with the page container at desktop widths).

### Verification

- `npx vitest run src/components/Breadcrumb.test.tsx` → **4/4 passed** (all existing cases unmodified). Neither of the file's 2 class-level assertions target the `<nav>`'s padding (they check `<ol>` and `<li>` classes respectively), so this update is safe.
- `npx tsc --noEmit -p tsconfig.json` → exits 0.

Only `src/components/Breadcrumb.tsx` modified (no test file edits needed).

## Todo 2 (2026-07-10) — Create DESIGN.md documenting the reference-aligned token/component system

Created `DESIGN.md` at project root with all 7 mandatory sections populated with real, cited values from the currently-implemented system (post-Todo-1 recolor, post-Todos 3-10 component/layout work):

### Section 1: Atmosphere & Identity
Explicitly names the signature: "direct style copy of the `modern-qa-scoring-dashboard` reference: bold KPI-dashboard energy, blue accent (`#2563eb` light / `#3b82f6` dark, documented WCAG-AA split rationale), tonal-shift dark surfaces, `rounded-xl` card lift via shadow — PLUS a persistent left-nav sidebar shell (Ctrl+B togglable) this reference didn't have."

### Section 2: Color
Full token table (light | dark columns) matching `index.css` exactly:
- Surfaces: `--surface-0` through `--surface-3` (canvas, cards, tertiary, overlay)
- Text: `--ink`, `--ink-muted`, `--ink-faint`
- Borders: `--line`, `--line-strong`
- Status: `--success`, `--warning`, `--danger`
- Accent: `#2563eb` (light) / `#3b82f6` (dark) with explicit WCAG-AA contrast rationale
- Soft tints: derived via `color-mix()` (14-16% saturation)
- Shadows: `--shadow-sm`, `--shadow-md`, `--shadow-lg` with light/dark tuning

### Section 3: Typography
System-font stack (no external dependencies), scale with weights:
- Page titles: `text-2xl sm:text-3xl font-bold tracking-tight`
- Section headers: `text-lg font-semibold`
- Body: `text-sm`
- Code/mono: `text-sm font-mono`
- Stat/KPI: `text-4xl font-black`
- Badge: `text-[11px] font-semibold`

### Section 4: Spacing & Layout
Container widths (`PageContainer` primitives):
- Wide: `max-w-6xl` (1152px)
- Narrow: `max-w-3xl` (768px)
- Responsive padding: `px-4 py-6 / sm:px-6 sm:py-8 / lg:px-8 lg:py-10`
Sidebar: `w-64` fixed at `lg:top-[49px] lg:bottom-0 lg:left-0`, Ctrl+B toggle, collapses to drawer below `lg`

### Section 5: Components
All 8 `ui.tsx` primitives documented (Button, IconButton, Badge, SectionHeader, Segmented, Tooltip, Skeleton, Spinner, SeverityDot), plus:
- PageContainer (layout primitive)
- TopBar (shell with sidebar/drawer)
- DiffView (diff renderer)

### Section 6: Motion & Interaction
Animations (`rise`, `fade`), transitions, focus-ring, reduced-motion support, hover/card-lift patterns

### Section 7: Depth & Surface
Elevation model (3 layers), shape consistency lock:
- Cards: `rounded-xl` + `shadow-sm→shadow-md` + `ring-1 ring-line`
- Buttons/inputs: `rounded-lg`
- Stat pill exception: `rounded-lg` (intentional, matches reference)
- Pills/badges: `rounded-full`

### Verification
- Grep `DESIGN.md` for `[specify]`/`TODO` placeholder brackets → **zero matches** ✓
- Every hex, token, class, and component name traces to actual source files (read and cited) ✓
- All 7 section headers verbatim per the design-system-architecture template ✓

**Commit:** `docs(design): create DESIGN.md documenting the reference-aligned token/component system`

## Plan-Todo 8 + Plan-Todo 9 (2026-07-10) — AttemptDetailPage: PageContainer/title shell + card-panel sections

(NB: numbering here is the CURRENT `.omo/plans/tenetx-mimic-ui-polish.md` TODOs list — items 8 and 9, "Rebuild AttemptDetailPage: container, title, metadata row" / "...: section cards, icons, font-mono fix, rounded-xl/shadow". Not to be confused with the differently-numbered "Todo 8" entry above from an earlier session, which was actually Ctrl+B sidebar work — that plan's numbering has since been renumbered/finalized.)

Read the plan's Todo 8 + Todo 9 sections in full (lines 203-238) before editing. Re-read `AttemptDetailPage.tsx` fresh immediately before each edit pass since this file is shared with the concurrent `tenqa-29-idempotent-install-fix` boulder session — confirmed no unexpected drift between the two edit passes (file matched exactly what Todo 8's commit had produced).

### Plan-Todo 8 — container/title/metadata (commit `af1c20b`)

- Outer wrapper: `mx-auto max-w-2xl space-y-6 p-6` → `<PageContainer size="wide" className="space-y-8">` (import added from `@/components/PageContainer`).
- `<h1>`: `text-lg font-semibold text-ink` → `text-2xl sm:text-3xl font-bold tracking-tight text-ink`.
- Status `Badge` unchanged (already inline next to title via `flex flex-wrap items-center gap-2`).
- `doc.description` paragraph gains `max-w-prose`.
- Loading (`"Loading attempt…"`) and not-found (`"Attempt not found"`) early returns both moved onto `<PageContainer size="wide" className="space-y-8">` (dropped their old `p-6` div wrappers — `PageContainer` supplies its own responsive padding).
- Zero changes to Firestore query logic, `useEffect`, `useParams`, or state — confirmed via diff, only JSX/classNames touched.
- Final closing `</div>` → `</PageContainer>` to match the new outer element.

### Plan-Todo 9 — section cards/icons/font-mono fix (commit `e28518d`)

- `SOLUTION_BLOCK_CLASSES`: `"overflow-auto rounded-lg bg-card-2 p-4 text-sm leading-relaxed text-ink ring-1 ring-line"` → `"overflow-auto rounded-xl bg-card-2 p-4 text-sm font-mono leading-relaxed text-ink ring-1 ring-line shadow-sm"` — appends the missing `font-mono` (real bug fix, code/diff blocks were rendering in the body sans-serif font), `rounded-lg`→`rounded-xl`, adds `shadow-sm`.
- `SectionHeader` imported from `@/components/ui` (alongside existing `Badge, Button, Spinner, type Tone`).
- All 5 named sections converted to card panels — `rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2` wrapper + `<h2>`→`<SectionHeader icon="...">`:
  - Related tickets → `icon="branch"`
  - Root cause → `icon="alert"`, paragraph gains `max-w-prose`
  - Diff summary → `icon="layers"`, paragraph gains `max-w-prose`
  - Full solution → `icon="code"` (the inner `SOLUTION_BLOCK_CLASSES` code/diff block deliberately has NO `max-w-prose` — spans the full card width per the plan's explicit "no prose cap on code" instruction; this does produce a card-within-a-card look for the code block specifically, which is what the pinned acceptance criteria literally specifies)
  - Live verification (inside the `saml-login-fix` block, `doc.notes`) → `icon="check"` — paragraph text left WITHOUT `max-w-prose` since the plan's `max-w-prose` instruction names only "Root cause / Diff summary paragraph text," not Live verification.
- All 3 `border-t border-line pt-6` dividers removed:
  - `feature === "saml-config"` mount block: dropped the wrapper `<div>` entirely — now `{feature === "saml-config" && <SamlConfigPage />}` (Todo 11, not this todo, owns adding the `mx-auto max-w-3xl` width-fix wrapper back in later — left it as a bare conditional for now, per scope).
  - `feature === "saml-login-fix"` block (Try-it-out link + Live verification): `border-t border-line pt-6 space-y-4` → `space-y-4`.
  - Root-cause/diff-summary/full-solution block: `border-t border-line pt-6 space-y-4` → `space-y-4`.
- Grepped final file: `font-mono` present exactly once (in `SOLUTION_BLOCK_CLASSES`); zero remaining `border-t border-line` matches.
- Every visible string `AttemptDetailPage.test.tsx` asserts on preserved verbatim — confirmed by full test-suite pass, unmodified test file.

### Test verification (both sub-parts)

`npx vitest run src/pages/AttemptDetailPage.test.tsx` → **12/12 passed** after both Todo 8 and Todo 9 edits (same 12/12 baseline as before any edits this session — zero regressions). Of these 12, **11 belong to this plan** (per the plan's own "corrected count from an earlier miscount" note); the 12th (`"renders root cause, diff summary, and the full solution when feature is windows-installer-idempotent-reinstall-fix"`, asserting on `TENQA-29`/`windows-installer-idempotent-reinstall-fix` fixture data) belongs to the concurrent, unrelated `tenqa-29-idempotent-install-fix` boulder session — untouched by either commit here, and it was already passing before my changes and still passes after (i.e. not made worse). `npx tsc --noEmit -p tsconfig.json` → exits 0 after both commits.

Only `src/pages/AttemptDetailPage.tsx` staged/committed for both commits (2 separate commits as specified: `af1c20b` for Todo 8, `e28518d` for Todo 9). Did not touch `TryItOutPage.tsx` or `SamlConfigPage.tsx` (Todo 11's scope) or `DiffView.tsx` internals (only referenced its `className` prop, unchanged usage).

## Todo 11 (2026-07-10) — TryItOutPage + SamlConfigPage: container, SectionHeader, card treatment; width contradiction + duplicate-title fixes

Read the plan's Todo 11 section (lines 263-286) in full first, plus fresh reads of `TryItOutPage.tsx`, `SamlConfigPage.tsx`, and the CURRENT `AttemptDetailPage.tsx` (already rebuilt by Todos 8-9) to find the exact live `feature === "saml-config"` mount line.

### `TryItOutPage.tsx`

- Outer wrapper: `mx-auto max-w-2xl space-y-6 p-6` → `<PageContainer size="narrow" className="space-y-6">` (768px, up from 672px). Import added: `import { PageContainer } from "@/components/PageContainer"`.
- `<h1>`: `text-lg font-semibold text-ink` → `text-2xl sm:text-3xl font-bold tracking-tight text-ink`.
- `<h2>{guidance.label} — field values</h2>` → `<SectionHeader icon="sliders">{guidance.label} — field values</SectionHeader>`.
- `"Launch login"` `<h2>` → `<SectionHeader icon="zap">Launch login</SectionHeader>` (same glyph as the sidebar's "Try it out" nav item).
- All 3 card surfaces converted to `rounded-xl ... shadow-sm hover:shadow-md transition-shadow` (field-values panel, launch-login panel, AND the warning/"gotcha" panel — gap-review fix F5, previously missed by the "2 panels" framing). The gotcha panel's own `<h2>{guidance.gotcha.title}</h2>` intentionally stays a plain heading (NOT converted to `SectionHeader`) per the plan's explicit instruction — only its card wrapper's radius/shadow changed.
- `SectionHeader` added to the existing `import { Badge, Button, Segmented } from "@/components/ui"` line.

### `SamlConfigPage.tsx`

- Outer wrapper: `mx-auto max-w-2xl space-y-6 p-6` → plain `<div className="space-y-6">`, with a one-line comment directly above it: `// no PageContainer here — always rendered nested inside AttemptDetailPage's own PageContainer` (comment is explicitly required by the plan's own acceptance criteria text — not an AI-slop addition).
- **F2 fix (duplicate title):** `<h1 className="text-lg ...">Configure SSO</h1>` demoted to `<SectionHeader icon="building">Configure SSO</SectionHeader>` — NOT bumped to page-title scale, since this page never renders standalone (confirmed via `App.tsx`'s registered routes — no standalone `/saml-config` route exists) and would otherwise compete with `AttemptDetailPage`'s own `<h1>{doc.title}</h1>`.
- Because `building` is now used for "Configure SSO", **"Service Provider values"** uses `<SectionHeader icon="sliders">` instead (same icon family as `TryItOutPage`'s field-values section, per the plan's explicit visual-consistency note).
- `"Setup guidance"` → `<SectionHeader icon="info">`.
- All 5 remaining `rounded-lg bg-card-2 ring-1 ring-line` panels (Metadata-URL tab, Upload-XML tab, Verified-result card, Service-Provider-values card, Setup-guidance card) → `rounded-xl ... shadow-sm hover:shadow-md transition-shadow`.

### `AttemptDetailPage.tsx` — F1 fix (width contradiction), single-line mount wrapper ONLY

Changed exactly one line (line 220 pre-edit):
```diff
-      {feature === "saml-config" && <SamlConfigPage />}
+      {feature === "saml-config" && (
+        <div className="mx-auto max-w-3xl">
+          <SamlConfigPage />
+        </div>
+      )}
```
No other line in this file touched — confirmed via reviewing the diff before committing. `AttemptDetailPage` still uses its own `PageContainer size="wide"` (1152px) at the top level; the nested `SamlConfigPage` now renders at 768px inside it, matching `TryItOutPage`'s width, per the plan's explicit rationale for both setup-flow pages.

### New test: programmatic `max-w-3xl` assertion (per plan's explicit "do not rely on eyeballing" instruction)

Added to `AttemptDetailPage.test.tsx`, a new case `"wraps the nested SamlConfigPage in a max-w-3xl container and renders exactly one page-title <h1>"`:
- `screen.getByText("Configure SSO").closest(".max-w-3xl")` → not null, `toHaveClass("mx-auto", "max-w-3xl")` — confirms the F1 wrapper actually applied.
- `document.querySelectorAll("h1.text-2xl.sm\\:text-3xl.font-bold")` → `toHaveLength(1)`, and that single `<h1>` contains `doc.title` ("Generic SAML/OIDC Config Page") — confirms F2: exactly one page-title-scale heading renders on the `saml-config` route (i.e. `SamlConfigPage`'s own heading did NOT get bumped to page-title scale).
- Confirms `"Configure SSO"` resolves to an `<h2>` (via `.closest("h2")`), i.e. it's a `SectionHeader`, not a competing `<h1>`.

### Test run

`npx vitest run src/pages/TryItOutPage.test.tsx src/pages/SamlConfigPage.test.tsx src/pages/AttemptDetailPage.test.tsx` → **25/25 passed** (4 + 8 + 13, the 13th being the new max-w-3xl/single-h1 test added this todo; `AttemptDetailPage.test.tsx`'s pre-existing `screen.getByText("Configure SSO")` assertion, line 75, still passes unmodified — text preserved, only the element's tag/scale changed from `<h1 className="text-lg...">` to `<h2>` via `SectionHeader`). `npx tsc --noEmit -p tsconfig.json` → exits 0.

Only `src/pages/TryItOutPage.tsx`, `src/pages/SamlConfigPage.tsx`, `src/pages/AttemptDetailPage.tsx` (single mount-line only), and `src/pages/AttemptDetailPage.test.tsx` (one new test added, zero existing tests modified) touched for this todo.
