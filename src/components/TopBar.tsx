import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuthState } from "@/lib/authState";
import { SUPER_ADMIN_EMAIL } from "@/lib/auth";
import { cn } from "@/utils/cn";
import { Badge, Button, IconButton } from "./ui";
import { Icon } from "./icons";

const NAV_LINK_BASE =
  "focus-ring flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition";
const NAV_LINK_INACTIVE = "text-ink-muted hover:bg-card-2 hover:text-ink";
const NAV_LINK_ACTIVE = "bg-accent-soft text-accent";

/** Shared 2-item nav list (Dashboard / Try it out) — used by both the desktop sidebar and the mobile drawer. */
function NavLinks() {
  return (
    <div className="px-3 py-4 space-y-1">
      <NavLink
        to="/"
        end
        className={({ isActive }) => cn(NAV_LINK_BASE, isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE)}
      >
        <Icon name="grid" className="h-4 w-4 shrink-0" aria-hidden="true" />
        Dashboard
      </NavLink>
      <NavLink
        to="/mimic/try-it-out"
        className={({ isActive }) => cn(NAV_LINK_BASE, isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE)}
      >
        <Icon name="zap" className="h-4 w-4 shrink-0" aria-hidden="true" />
        Try it out
      </NavLink>
    </div>
  );
}

/**
 * Unified app-level header with:
 * - Home link (always visible)
 * - Mobile top bar: brand + hamburger (below `lg`)
 * - Desktop sidebar: persistent nav + identity footer (at `lg`+)
 * - Mobile drawer: nav + identity content (below `lg`, toggled by hamburger)
 */
export function TopBar() {
  const { status, user, signOut } = useAuthState();
  const email = user?.email ?? "";
  const isSuperAdmin = email === SUPER_ADMIN_EMAIL;
  const authorized = status === "authorized";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();

  // Close drawer when route changes
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Close drawer on Escape key (only while drawer is open)
  useEffect(() => {
    if (!drawerOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [drawerOpen]);

  // Toggle desktop sidebar on Ctrl+B (application-wide)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <>
      {authorized && (
        <aside
          className={cn(
            "hidden lg:fixed lg:bottom-0 lg:left-0 lg:top-[49px] lg:w-64 lg:flex-col lg:border-r lg:border-line lg:bg-bg",
            sidebarCollapsed ? "lg:hidden" : "lg:flex"
          )}
        >
          <nav aria-label="Primary">
            <NavLinks />
          </nav>
          <div className="mt-auto flex flex-col gap-3 border-t border-line px-4 py-4">
            {isSuperAdmin && <Badge tone="accent">Super Admin</Badge>}
            <span className="block truncate text-xs text-ink-muted">{email}</span>
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </aside>
      )}
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur">
        <div className="flex items-center gap-x-3 px-4 py-3 sm:px-6">
          <Link to="/" aria-label="TenetX Mimic home" className="focus-ring rounded-lg">
            <h1 className="truncate text-base font-semibold text-ink">TenetX Mimic</h1>
          </Link>
          {authorized && (
            <div className="ml-auto flex items-center gap-2">
              <IconButton
                label={drawerOpen ? "Close menu" : "Open menu"}
                aria-expanded={drawerOpen}
                className="lg:hidden"
                onClick={() => setDrawerOpen((v) => !v)}
              >
                <Icon name={drawerOpen ? "x" : "menu"} className="h-5 w-5" />
              </IconButton>
            </div>
          )}
        </div>
        {authorized && drawerOpen && (
          <div role="menu" className="lg:hidden border-t border-line bg-card px-4 py-3">
            <NavLinks />
            <span className="h-px w-full bg-line" />
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {isSuperAdmin && <Badge tone="accent">Super Admin</Badge>}
                <span className="text-xs text-ink-muted">{email}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDrawerOpen(false);
                  void signOut();
                }}
              >
                Sign out
              </Button>
            </div>
          </div>
        )}
      </header>
    </>
  );
}
