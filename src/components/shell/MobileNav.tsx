import type { ComponentType, SVGProps } from "react";
import { Link, useLocation } from "react-router-dom";
import { LayoutGrid, Zap, Key, Settings } from "lucide-react";
import { cn } from "@/utils/cn";
import { useToast } from "./Toast";

type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

interface NavTab {
  id: string;
  label: string;
  path: string;
  icon: NavIcon;
}

/** The 3 real routes — parity with TopBar's `NavLinks` + the MCP route from the plan. */
const TABS: NavTab[] = [
  { id: "dashboard", label: "Dashboard", path: "/", icon: LayoutGrid },
  { id: "try-it-out", label: "Try it out", path: "/mimic/try-it-out", icon: Zap },
  { id: "mcp", label: "MCP", path: "/mcp", icon: Key },
];

const TAB_BASE =
  "focus-ring flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors";
const TAB_ACTIVE = "text-accent";
const TAB_INACTIVE = "text-ink-muted hover:text-ink";

/**
 * Fixed bottom nav bar for mobile (below `lg`), ported from grokv1's
 * `mobile-nav.tsx`. 4 items for parity with the desktop Sidebar's full
 * nav+footer-stub set: 3 real routes + a toast-only Preferences stub.
 */
export function MobileNav() {
  const location = useLocation();
  const { addToast } = useToast();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-card/95 backdrop-blur-md lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Mobile"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = location.pathname === tab.path;
        return (
          <Link
            key={tab.id}
            to={tab.path}
            className={cn(TAB_BASE, active ? TAB_ACTIVE : TAB_INACTIVE)}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => addToast("Settings coming soon", "info")}
        className={cn(TAB_BASE, TAB_INACTIVE)}
      >
        <Settings className="h-5 w-5" aria-hidden="true" />
        Preferences
      </button>
    </nav>
  );
}
