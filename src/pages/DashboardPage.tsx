import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { collection, getDocs } from "firebase/firestore";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { db } from "@/lib/firebaseClient";
import { Badge, SectionHeader, type Tone } from "@/components/ui";
import { PageContainer } from "@/components/PageContainer";

/**
 * Mirrors the `mimic_features` schema defined by todo 15
 * (`tenetx-mimic/src/lib/types.ts` is not yet created — todo 15 is itself
 * `[~]` partial — so the shape is declared locally here rather than
 * importing a file that doesn't exist yet).
 */
type FeatureStatus = "planned" | "in-progress" | "done";

interface MimicFeature {
  id: string;
  ticketId: string;
  featureSlug: string;
  attemptNumber: number;
  title: string;
  status: FeatureStatus;
  routePath: string;
}

const STATUS_TONE: Record<FeatureStatus, Tone> = {
  planned: "neutral",
  "in-progress": "warning",
  done: "success",
};

const STATUS_LABEL: Record<FeatureStatus, string> = {
  planned: "Planned",
  "in-progress": "In progress",
  done: "Done",
};

const JIRA_BASE_URL = "https://daxnai.atlassian.net/browse/";

/** The one other real top-level route in the app besides the dashboard/detail routes. */
const TRY_IT_OUT_ROUTE = "/mimic/try-it-out";

/** Reverse of `STATUS_LABEL`, for mapping a clicked chart bar back to a `FeatureStatus`. */
const STATUS_KEY_BY_LABEL: Record<string, FeatureStatus> = {
  Planned: "planned",
  "In progress": "in-progress",
  Done: "done",
};

function isFeatureStatus(value: unknown): value is FeatureStatus {
  return value === "planned" || value === "in-progress" || value === "done";
}

/**
 * Firestore docs have no compile-time shape guarantee, so this narrows and
 * defaults any field that's missing/malformed rather than crashing the page.
 */
function toMimicFeature(id: string, data: Record<string, unknown>): MimicFeature {
  return {
    id,
    ticketId: typeof data.ticketId === "string" ? data.ticketId : "UNKNOWN",
    featureSlug: typeof data.featureSlug === "string" ? data.featureSlug : "",
    attemptNumber: typeof data.attemptNumber === "number" ? data.attemptNumber : 0,
    title: typeof data.title === "string" ? data.title : "Untitled feature",
    status: isFeatureStatus(data.status) ? data.status : "planned",
    routePath: typeof data.routePath === "string" ? data.routePath : "/",
  };
}

function countByStatus(features: MimicFeature[]) {
  const counts: Record<FeatureStatus, number> = { planned: 0, "in-progress": 0, done: 0 };
  for (const feature of features) {
    counts[feature.status] += 1;
  }
  return (Object.keys(counts) as FeatureStatus[]).map((status) => ({
    status: STATUS_LABEL[status],
    count: counts[status],
  }));
}

/**
 * Pure click-target resolver for the "Attempts by status" bar chart, kept
 * separate from the component body so it can be unit-tested directly without
 * touching Recharts/`ResponsiveContainer` (which render at 0x0 in jsdom and
 * don't reliably dispatch click events there).
 *
 * - "Done": navigates to the first `status === "done"` feature's own
 *   `routePath` (the exact field each feature row's "View attempt" link
 *   already uses) — no-op (`null`) when no such feature exists yet.
 * - "Planned" / "In progress": prefers a matching feature's `routePath` when
 *   one exists (showing a real attempt beats a generic landing page), else
 *   falls back to `/mimic/try-it-out` — the app's other real top-level route,
 *   and a sensible "start here" destination when nothing at that status
 *   exists yet.
 */
export function resolveChartClickTarget(
  status: string,
  features: MimicFeature[]
): string | null {
  const statusKey = STATUS_KEY_BY_LABEL[status];
  if (!statusKey) return null;

  const match = features.find((feature) => feature.status === statusKey);
  if (match) return match.routePath;

  return statusKey === "done" ? null : TRY_IT_OUT_ROUTE;
}

export function DashboardPage() {
  const [features, setFeatures] = useState<MimicFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const snapshot = await getDocs(collection(db, "mimic_features"));
        if (cancelled) return;
        setFeatures(snapshot.docs.map((doc) => toMimicFeature(doc.id, doc.data())));
      } catch (err) {
        console.error("mimic_features load failed:", err);
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(`Could not load mimic_features from Firestore: ${message}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <PageContainer size="wide">
        <p className="text-sm text-ink-muted">Loading dashboard…</p>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer size="wide">
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </PageContainer>
    );
  }

  const chartData = countByStatus(features);

  function handleBarClick(status: string) {
    const target = resolveChartClickTarget(status, features);
    if (target) navigate(target);
  }

  return (
    <PageContainer size="wide" className="space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          All replicated features tracked in <code className="rounded bg-card-2 px-1">mimic_features</code>.
        </p>
      </div>

      <div className="bg-accent-soft border border-accent/20 px-6 py-3 rounded-lg flex items-center gap-4">
        <p className="text-4xl font-black text-ink tnum">{features.length}</p>
        <p className="text-sm font-medium text-accent uppercase tracking-wider">
          {features.length === 1 ? "feature replicated" : "features replicated"}
        </p>
      </div>

      {features.length === 0 ? (
        <div className="rounded-xl bg-card-2 p-6 text-center ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
          <p className="text-sm font-medium text-ink">No features tracked yet.</p>
          <p className="mt-1 text-xs text-ink-muted">
            Seed a doc in <code className="rounded bg-card-3 px-1">mimic_features</code> to see it here.
          </p>
        </div>
      ) : (
        <>
          <div
            className={
              features.length > 1 ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" : "space-y-2"
            }
          >
            {features.map((feature) => (
              <div
                key={feature.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow"
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
                  <Link to={feature.routePath} className="focus-ring text-xs text-accent hover:underline">
                    View attempt
                  </Link>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
            <SectionHeader icon="gauge" className="mb-3">
              Attempts by status
            </SectionHeader>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                  <XAxis dataKey="status" stroke="var(--color-ink-muted)" fontSize={12} />
                  <YAxis allowDecimals={false} stroke="var(--color-ink-muted)" fontSize={12} />
                  <RechartsTooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-line)",
                      borderRadius: 8,
                      color: "var(--color-ink)",
                    }}
                  />
                  <Bar
                    dataKey="count"
                    fill="var(--color-accent)"
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                    onClick={(data) => handleBarClick(data.payload.status)}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </PageContainer>
  );
}
