import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "@/utils/cn";
import { ToastProvider } from "./Toast";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";
import { CommandPalette } from "./CommandPalette";
import { Breadcrumb } from "../Breadcrumb";

/**
 * Route → page-title lookup for `Topbar`'s `title` prop. `Topbar.tsx`
 * (todo 2.3) deliberately does NOT do its own route lookup — that's this
 * component's job, per the plan.
 *
 * Only the 3 "top-level" routes get an explicit entry. Everything else —
 * the ticket-detail routes (`/mimic/:ticket/try-it-out`,
 * `/mimic/:ticket/:feature/:attempt`) — falls back to `DEFAULT_TITLE`
 * below. Those routes already get richer context from `<Breadcrumb />`
 * (rendered below `Topbar`, see this component's return statement), so a
 * generic fallback heading here is enough; there's no need to
 * reverse-engineer a per-ticket title from route params just for this
 * `<h1>`.
 */
const ROUTE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/mcp": "MCP",
  "/mimic/try-it-out": "Try it out",
};

const DEFAULT_TITLE = "TenetX Mimic";

function resolveTitle(pathname: string): string {
  return ROUTE_TITLES[pathname] ?? DEFAULT_TITLE;
}

/**
 * Top-level shell orchestrator composing the 5 independently-built/tested
 * chrome pieces (Toast, Sidebar, Topbar, CommandPalette, MobileNav) and
 * replacing the old monolithic `TopBar.tsx`.
 *
 * Owns 3 pieces of cross-cutting state/behavior that no single child
 * component should own itself (since more than one of them needs to react
 * to it):
 * - `commandOpen` — `Topbar`'s search trigger AND the global Cmd+K listener
 *   both need to open the same `<CommandPalette>` instance.
 * - `sidebarCollapsed` — toggled by Ctrl+B or Cmd+B (same
 *   `metaKey || ctrlKey` pattern as the Cmd+K listener below). `Sidebar`
 *   now owns its own icon-only collapsed visual (see its docblock), so
 *   `collapsed` is passed straight through as a prop rather than
 *   conditionally rendering `<Sidebar>` at all — the content column's
 *   `lg:pl-*` offset is switched to match the rail's collapsed width.
 * - `title` — derived per-render from `useLocation().pathname` via
 *   `ROUTE_TITLES`, passed straight through to `Topbar`.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [commandOpen, setCommandOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const title = resolveTitle(location.pathname);

  // Cmd+K / Ctrl+K opens the command palette. Matches TopBar.tsx's
  // established convention for global keybindings: a window-level listener
  // registered/cleaned up in a useEffect with an empty dependency array.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Ctrl+B / Cmd+B toggles the desktop sidebar between its full width and
  // its icon-only collapsed rail (same metaKey-or-ctrlKey pattern as the
  // Cmd+K/Ctrl+K listener above).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-bg">
        <Sidebar collapsed={sidebarCollapsed} />
        <div
          className={cn(
            "flex flex-1 flex-col lg:min-w-0 lg:transition-[padding] lg:duration-200",
            sidebarCollapsed ? "lg:pl-[72px]" : "lg:pl-64"
          )}
        >
          <Topbar title={title} onOpenCommandPalette={() => setCommandOpen(true)} />
          <Breadcrumb />
          <main className="flex-1">{children}</main>
        </div>
        <MobileNav />
        <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      </div>
    </ToastProvider>
  );
}
