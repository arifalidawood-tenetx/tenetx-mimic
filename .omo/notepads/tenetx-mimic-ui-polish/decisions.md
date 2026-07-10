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
