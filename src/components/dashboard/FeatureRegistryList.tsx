import { Link } from "react-router-dom";
import { Badge } from "@/components/ui";
import { STATUS_TONE, STATUS_LABEL, type DashboardFeatureSummary } from "@/lib/types";

/**
 * Kept in sync with `DashboardPage.tsx`'s own `JIRA_BASE_URL` constant — this
 * component's Jira ticket links must resolve to the same base URL the page
 * currently builds inline. If that constant ever moves to a shared module,
 * update this literal to match (or import it from there instead).
 */
const JIRA_BASE_URL = "https://daxnai.atlassian.net/browse/";

/**
 * Row-based replacement for `DashboardPage.tsx`'s card-grid + Recharts bar
 * chart. Each row surfaces a feature's title, its Jira ticket link, a status
 * badge (via the shared `STATUS_TONE`/`STATUS_LABEL` maps), and a "View
 * attempt" link to its own route. No relative-time column — `MimicFeature`
 * has no timestamp field suited for that, so none is fabricated here.
 */
export function FeatureRegistryList({ features }: { features: DashboardFeatureSummary[] }) {
  if (features.length === 0) {
    return (
      <div className="rounded-xl bg-card-2 p-6 text-center ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
        <p className="text-sm font-medium text-ink">No features tracked yet.</p>
        <p className="mt-1 text-xs text-ink-muted">
          Seed a doc in <code className="rounded bg-card-3 px-1">mimic_features</code> to see it
          here.
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl bg-card-2 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow"
      aria-label="Feature registry"
    >
      <ul className="divide-y divide-line" role="list">
        {features.map((feature) => (
          <li
            key={feature.id}
            className="flex flex-wrap items-center justify-between gap-3 p-4"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{feature.title}</p>
              <a
                href={`${JIRA_BASE_URL}${feature.ticketId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent hover:underline"
              >
                {feature.ticketId}
              </a>
            </div>
            <div className="flex items-center gap-3">
              <Badge tone={STATUS_TONE[feature.status]}>{STATUS_LABEL[feature.status]}</Badge>
              {/*
                Fall back to "/" for a missing/malformed routePath (mirrors
                `DashboardPage.tsx`'s `toMimicFeature` sanitizer default) so a
                bad Firestore doc can't crash this row's render.
              */}
              <Link
                to={feature.routePath || "/"}
                className="focus-ring text-xs text-accent hover:underline"
              >
                View attempt
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
