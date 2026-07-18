import type { SVGProps } from "react";
import { cn } from "@/utils/cn";

export type ProfileUser = {
  name: string;
  email: string;
  role: string;
  initials: string;
  online?: boolean;
};

function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        d="M6.5 3H4.2A1.2 1.2 0 0 0 3 4.2v7.6c0 .66.54 1.2 1.2 1.2h2.3M10 11.5 13 8l-3-3.5M13 8H6.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MoreIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <circle cx="4" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

const AVATAR_SIZE_CLASSES = { sm: "h-7 w-7 text-[10px]", md: "h-9 w-9 text-xs" } as const;
const STATUS_SIZE_CLASSES = { sm: "h-2 w-2", md: "h-2.5 w-2.5" } as const;

function Avatar({ user, size }: { user: ProfileUser; size: keyof typeof AVATAR_SIZE_CLASSES }) {
  return (
    <span className="relative shrink-0">
      <span
        className={cn(
          "flex items-center justify-center rounded-full bg-card-3 font-semibold text-ink ring-1 ring-line",
          AVATAR_SIZE_CLASSES[size]
        )}
      >
        {user.initials}
      </span>
      {user.online && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 rounded-full bg-accent ring-2 ring-card",
            STATUS_SIZE_CLASSES[size]
          )}
          aria-label="Online"
        />
      )}
    </span>
  );
}

interface SidebarProfileProps {
  user: ProfileUser;
  /** Renders the icon-only "Collapsed Rail" variant instead of the full
   * "Badge Strip" variant. Driven by `Sidebar`'s own `collapsed` prop. */
  collapsed?: boolean;
  onSignOut?: () => void;
}

/**
 * Sidebar bottom profile widget, ported from the provided design spec.
 * Two variants share one component so `Sidebar` doesn't need two separate
 * footer implementations: "Badge Strip" (avatar, name, email, role, Sign
 * out) when expanded, "Collapsed Rail" (bare avatar + icon-only Sign out)
 * when the sidebar is narrowed to its ~72px collapsed rail.
 */
export function SidebarProfile({ user, collapsed = false, onSignOut }: SidebarProfileProps) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-line px-2 py-3">
        <button type="button" className="rounded-full focus-ring" aria-label={`${user.name} menu`}>
          <Avatar user={user} size="md" />
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-card-3 hover:text-ink focus-ring"
          aria-label="Sign out"
        >
          <LogoutIcon className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-line p-2.5">
      <div className="overflow-hidden rounded-lg ring-1 ring-line">
        <div className="flex items-center gap-2.5 bg-card px-3 py-2.5">
          <Avatar user={user} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="truncate text-[11px] text-ink-faint">{user.email}</p>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-ink-faint hover:bg-card-3 hover:text-ink focus-ring"
            aria-label="More"
          >
            <MoreIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 bg-accent-soft px-3 py-1.5">
          <span className="text-[11px] font-semibold text-accent">{user.role}</span>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-sm text-[11px] font-medium text-accent/80 transition-colors hover:text-accent focus-ring"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
