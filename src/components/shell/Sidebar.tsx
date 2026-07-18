import type { ComponentType, SVGProps } from "react";
import { NavLink } from "react-router-dom";
import { LayoutGrid, Zap, Key, Settings, Shield } from "lucide-react";
import { cn } from "@/utils/cn";
import { useAuthState } from "@/lib/authState";
import { SUPER_ADMIN_EMAIL } from "@/lib/auth";
import { getInitials } from "@/lib/avatarInitials";
import { useToast } from "./Toast";
import { SidebarProfile } from "./SidebarProfile";

interface NavItem {
  path: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** Flat nav list — only 3 real items, no group headers (per plan scope). */
const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Dashboard", icon: LayoutGrid },
  { path: "/mimic/try-it-out", label: "Try it out", icon: Zap },
  { path: "/mcp", label: "MCP", icon: Key },
];

const NAV_ITEM_BASE =
  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors";
const NAV_ITEM_INACTIVE = "text-ink-muted hover:bg-card-2 hover:text-ink";
/** Active-state classes ported verbatim from grokv1's `sidebar.tsx`. */
const NAV_ITEM_ACTIVE = "bg-accent/10 text-accent";
/** Collapsed rail: fixed square icon buttons instead of full-width rows. */
const NAV_ITEM_COLLAPSED = "w-11 justify-center px-0";

interface SidebarProps {
  /** Narrows the desktop rail to an icon-only ~72px strip when true —
   * labels hide, the bottom profile switches to its "Collapsed Rail"
   * variant (see `SidebarProfile`). Owned by `AppShell` via its Ctrl/Cmd+B
   * keybinding; this component only renders what it's told. */
  collapsed?: boolean;
}

/**
 * Standalone desktop sidebar ported from grokv1's `sidebar.tsx` (146
 * lines): logo header (Shield icon), flat 3-item nav with active-state
 * `bg-accent/10 text-accent` + left accent bar, a "Preferences" stub that
 * fires a toast instead of navigating (no `/settings` route exists yet),
 * and a bottom profile widget (`SidebarProfile`) wired to this app's real
 * auth state (avatar initials, name/email, Super Admin vs Member role,
 * real Sign-out).
 *
 * `collapsed` (owned by `AppShell`) switches the whole rail between its
 * full `w-64` layout and an icon-only `w-[72px]` strip: nav labels and the
 * brand wordmark hide, each nav item becomes a square icon button with its
 * label as a native `title` tooltip, and the footer swaps to
 * `SidebarProfile`'s "Collapsed Rail" variant.
 *
 * Gated behind `status === "authorized"` — renders `null` otherwise.
 */
export function Sidebar({ collapsed = false }: SidebarProps) {
  const { status, user, signOut } = useAuthState();
  const { addToast } = useToast();
  const authorized = status === "authorized";

  if (!authorized) return null;

  const email = user?.email ?? "";
  const isSuperAdmin = email === SUPER_ADMIN_EMAIL;
  const displayName = user?.displayName || email.split("@")[0] || "User";

  return (
    <aside
      className={cn(
        "glass-surface hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:flex-col lg:border-r lg:border-line lg:transition-all lg:duration-200",
        collapsed ? "lg:w-[72px]" : "lg:w-64"
      )}
      aria-label="Sidebar"
      data-collapsed={collapsed}
    >
      {/* Logo / brand header */}
      <div
        className={cn(
          "flex h-14 items-center gap-2.5 border-b border-line",
          collapsed ? "justify-center px-2" : "px-4"
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Shield className="h-4 w-4" aria-hidden="true" />
        </div>
        {!collapsed && <p className="truncate text-sm font-semibold text-ink">TenetX Mimic</p>}
      </div>

      {/* Flat nav + Preferences stub */}
      <nav
        className={cn("flex-1 space-y-0.5 overflow-y-auto p-2", collapsed && "flex flex-col items-center")}
        aria-label="Primary"
      >
        {NAV_ITEMS.map((item) => {
          const ItemIcon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  NAV_ITEM_BASE,
                  isActive ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE,
                  collapsed && NAV_ITEM_COLLAPSED
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      className="absolute left-0 h-5 w-0.5 rounded-r bg-accent"
                      aria-hidden="true"
                    />
                  )}
                  <ItemIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </>
              )}
            </NavLink>
          );
        })}

        <div className="my-3 border-t border-line" />

        <button
          type="button"
          onClick={() => addToast("Settings coming soon", "info")}
          title={collapsed ? "Preferences" : undefined}
          className={cn(NAV_ITEM_BASE, NAV_ITEM_INACTIVE, collapsed ? NAV_ITEM_COLLAPSED : "w-full")}
        >
          <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">Preferences</span>}
        </button>
      </nav>

      <SidebarProfile
        user={{
          name: displayName,
          email,
          role: isSuperAdmin ? "Super Admin" : "Member",
          initials: getInitials(email),
          online: true,
        }}
        collapsed={collapsed}
        onSignOut={() => void signOut()}
      />
    </aside>
  );
}
