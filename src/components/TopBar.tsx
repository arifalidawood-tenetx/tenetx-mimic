/**
 * Minimal app-level top bar. Styling adapted from
 * tenetx-qa-scoring/web-ui/src/components/TopBar.tsx (sticky, blurred,
 * bottom-hairline header) but stripped of all dashboard-specific state
 * (date range, commit picker, fault toggle, theme toggle) — those hooks
 * don't exist in this app. Content grows as todos 16/17 land.
 */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-x-3 border-b border-line bg-bg/80 px-4 py-3 backdrop-blur sm:px-6">
      <h1 className="truncate text-base font-semibold text-ink">TenetX Mimic</h1>
    </header>
  );
}
