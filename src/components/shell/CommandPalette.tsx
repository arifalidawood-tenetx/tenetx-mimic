import { useEffect, useMemo, useState, type ComponentType, type SVGProps } from "react";
import { useNavigate } from "react-router-dom";
import { Search, LayoutGrid, Zap, Key } from "lucide-react";
import { cn } from "@/utils/cn";

type CommandGroup = "Navigate" | "Actions";

interface CommandItem {
  id: string;
  label: string;
  path: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  group: CommandGroup;
}

const COMMANDS: CommandItem[] = [
  { id: "dashboard", label: "Dashboard", path: "/", icon: LayoutGrid, group: "Navigate" },
  { id: "try-it-out", label: "Try it out", path: "/mimic/try-it-out", icon: Zap, group: "Navigate" },
  { id: "mcp", label: "MCP", path: "/mcp", icon: Key, group: "Navigate" },
  {
    id: "generate-token",
    label: "Generate MCP Token",
    path: "/mcp?action=generate",
    icon: Key,
    group: "Actions",
  },
];

const GROUPS: CommandGroup[] = ["Navigate", "Actions"];

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const item = results[active];
        if (item) {
          e.preventDefault();
          navigate(item.path);
          onClose();
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, results, active, navigate]);

  if (!open) return null;

  function activate(item: CommandItem) {
    navigate(item.path);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]">
      <div
        data-testid="command-palette-backdrop"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="animate-scale-in relative w-full max-w-lg overflow-hidden rounded-xl border border-line bg-card shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, actions…"
            className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-faint">No results</p>
          ) : (
            GROUPS.map((group) => {
              const items = results.filter((c) => c.group === group);
              if (items.length === 0) return null;

              return (
                <div key={group}>
                  <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                    {group}
                  </p>
                  <ul>
                    {items.map((item) => {
                      const index = results.indexOf(item);
                      const Icon = item.icon;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => activate(item)}
                            onMouseEnter={() => setActive(index)}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition",
                              index === active
                                ? "bg-accent-soft text-accent"
                                : "text-ink-muted hover:bg-card-2"
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
                            <span className="flex-1">{item.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
