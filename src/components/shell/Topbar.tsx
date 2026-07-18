import { useState } from "react";
import { Bell, Search } from "lucide-react";
import { useAuthState } from "@/lib/authState";
import { getInitials } from "@/lib/avatarInitials";

interface TopbarProps {
  /**
   * Baseline page heading, always rendered as an `<h1>` (matches grokv1's
   * `topbar.tsx` "always renders an h1" pattern). The parent (`AppShell`,
   * built in a later todo) derives this from a `ROUTE_TITLES` map keyed off
   * `useLocation().pathname`.
   */
  title: string;
  /**
   * Opens the command palette. The actual Cmd+K global keyboard listener
   * and `<CommandPalette open={...} onClose={...} />` rendering both live
   * in `AppShell` (a later todo) — this component only exposes the trigger.
   */
  onOpenCommandPalette: () => void;
}

/**
 * Sticky app header ported from grokv1's `topbar.tsx` (83 lines): a
 * backdrop-blurred bar with a title slot, a Cmd+K search trigger, a
 * notification bell, and a small avatar chip.
 *
 * `<Breadcrumb />` no longer lives inside this header — it's rendered by
 * `AppShell` immediately below the Topbar (see `AppShell.tsx`) so it reads
 * as its own row rather than crowding this bar's fixed 14-unit height.
 *
 * Notification bell: no real notification source exists in this app yet,
 * so the dropdown always shows an explicit, honest empty state
 * ("No notifications yet") rather than fabricated entries.
 *
 * Avatar chip: reuses `getInitials()` (built in todo 2.2) against
 * `useAuthState().user?.email`. `getInitials(undefined)` already safely
 * returns `"?"` per its own documented contract, so the brief pre-AuthGate
 * window where `user` is `null`/`undefined` is handled by that existing
 * fallback directly — no separate placeholder icon was added, to avoid
 * duplicating a guard `getInitials()` already owns.
 */
export function Topbar({ title, onOpenCommandPalette }: TopbarProps) {
  const { user } = useAuthState();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const initials = getInitials(user?.email);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur-md md:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold text-ink md:text-lg">{title}</h1>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="hidden items-center gap-2 rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink-muted transition hover:border-accent/30 hover:text-ink sm:inline-flex"
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Search pages, actions…</span>
          <kbd className="ml-2 inline-flex items-center rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="inline-flex rounded-lg border border-line bg-card p-2 text-ink-muted sm:hidden"
          aria-label="Search"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setNotificationsOpen((open) => !open)}
            className="relative rounded-lg border border-line bg-card p-2 text-ink-muted transition hover:text-ink"
            aria-label="Notifications"
            aria-expanded={notificationsOpen}
          >
            <Bell className="h-4 w-4" aria-hidden="true" />
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          </button>

          {notificationsOpen && (
            <div
              data-testid="notifications-panel"
              className="absolute right-0 top-full z-40 mt-2 w-64 rounded-lg border border-line bg-card p-4 shadow-lg"
            >
              <p className="text-center text-sm text-ink-muted">No notifications yet</p>
            </div>
          )}
        </div>

        <div
          data-testid="topbar-avatar"
          aria-label="User"
          className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent/40 to-accent/90 text-xs font-semibold text-on-accent"
        >
          {initials}
        </div>
      </div>
    </header>
  );
}
