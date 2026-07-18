import type { ReactNode } from "react";
import { cn } from "@/utils/cn";
import type { DashboardFeatureSummary } from "@/lib/types";

export interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  children?: ReactNode;
  className?: string;
  accent?: boolean;
}

/**
 * Generic dashboard stat card. Ported from grokv1's `stat-card.tsx` — matches
 * its real prop shape exactly (`label`/`value`/`subtitle`/`children`/
 * `className`/`accent`). grokv1's source also has `delta`/`deltaPositive`
 * props for a trend indicator, but this app has no trend/delta data source
 * anywhere yet, so they're deliberately omitted here (not invented, not
 * stubbed) — add them back only when a real caller needs them.
 *
 * grokv1 has NO built-in progress bar — it composes one via `children`
 * (see grokv1's `src/app/page.tsx` lines 68-78). This port follows the same
 * pattern: pass a progress-bar element as `children`, don't bake progress-bar
 * rendering into the card itself.
 */
export function StatCard({
  label,
  value,
  subtitle,
  children,
  className,
  accent,
}: StatCardProps) {
  return (
    <article
      className={cn(
        "rounded-xl border border-line bg-card-2 p-5 shadow-sm transition-shadow duration-200 hover:shadow-md",
        accent && "ring-1 ring-accent/20",
        className
      )}
      role="article"
      aria-label={`${label}: ${value}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </p>
      <div className="mt-2 flex items-end gap-3">
        <p className="text-3xl font-semibold tabular-nums tracking-tight text-ink">
          {value}
        </p>
      </div>
      {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      {children && <div className="mt-4">{children}</div>}
    </article>
  );
}

/**
 * Computes the completion rate for a set of `DashboardFeatureSummary`s:
 * `(count of status === "done") / total * 100`, rounded to 1 decimal place.
 *
 * Returns `null` for an empty array (0 total features) instead of `NaN` or
 * `0` — callers must render an explicit "No data yet" state in that case
 * rather than a misleading `0%`. Use `formatCompletionRate` to turn the
 * result into a display string.
 *
 * This app's `FeatureStatus` ("planned" | "in-progress" | "done") is a
 * completion state, not a pass/fail test result — this is a "completion
 * rate", never a "pass rate".
 */
export function computeCompletionRate(features: DashboardFeatureSummary[]): number | null {
  if (features.length === 0) return null;
  const doneCount = features.filter((f) => f.status === "done").length;
  return Math.round((doneCount / features.length) * 1000) / 10;
}

/**
 * Formats a `computeCompletionRate` result for display in a `StatCard`'s
 * `value` slot: `null` (0 total features) becomes the explicit "No data yet"
 * string; otherwise the rate is suffixed with `%`.
 */
export function formatCompletionRate(rate: number | null): string {
  return rate === null ? "No data yet" : `${rate}%`;
}
