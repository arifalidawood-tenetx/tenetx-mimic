import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/utils/cn";
import { Icon, type IconName } from "../icons";

/**
 * Self-contained toast type union — distinct from `ui.tsx`'s `Tone` (which
 * has no `info`/`error`). Ported from
 * tenetx-mimic-dashboard-development-sonnet5's `Toast` interface
 * (src/app/page.tsx:115-119).
 */
export type ToastType = "success" | "info" | "warning" | "error";

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  addToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_ICON: Record<ToastType, IconName> = {
  success: "check",
  error: "x",
  warning: "alert",
  info: "info",
};

/* Border + text tone per type. `info` and `error` map onto the `--info`/
   `--danger` tokens added in todo 1.2; `success`/`warning` reuse the
   existing tokens already wired for `ui.tsx`. */
const TOAST_TONE: Record<ToastType, string> = {
  success: "border-success/30 text-success",
  error: "border-danger/30 text-danger",
  warning: "border-warning/30 text-warning",
  info: "border-info/30 text-info",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((message: string, type: ToastType = "success") => {
    const id = Math.random().toString(36).substring(7);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const contextValue = useMemo<ToastContextValue>(() => ({ addToast }), [addToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex w-full max-w-md flex-col gap-2.5 px-4 md:px-0">
        {toasts.map((t) => {
          const tone = TOAST_TONE[t.type] ?? TOAST_TONE.info;
          const iconName = TOAST_ICON[t.type] ?? "info";
          return (
            <div
              key={t.id}
              role="status"
              className={cn(
                "animate-slide-up flex items-center justify-between gap-3 rounded-xl border bg-card/95 p-4 shadow-lg backdrop-blur-md",
                tone
              )}
            >
              <div className="flex items-center gap-3">
                <Icon name={iconName} className="h-5 w-5 shrink-0" />
                <span className="text-sm font-medium text-ink">{t.message}</span>
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
                className="focus-ring rounded pl-2 text-ink-faint transition-colors hover:text-ink-muted"
              >
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
