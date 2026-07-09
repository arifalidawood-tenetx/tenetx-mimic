import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
import { Badge, type Tone } from "@/components/ui";

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

export function DashboardPage() {
  const [features, setFeatures] = useState<MimicFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const snapshot = await getDocs(collection(db, "mimic_features"));
        if (cancelled) return;
        setFeatures(snapshot.docs.map((doc) => toMimicFeature(doc.id, doc.data())));
      } catch {
        if (!cancelled) setError("Could not load mimic_features from Firestore.");
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
      <div className="p-6">
        <p className="text-sm text-ink-muted">Loading dashboard…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </div>
    );
  }

  const chartData = countByStatus(features);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          All replicated features tracked in <code className="rounded bg-card-2 px-1">mimic_features</code>.
        </p>
      </div>

      <div className="rounded-lg bg-card-2 p-4 ring-1 ring-line">
        <p className="text-2xl font-semibold text-ink tnum">{features.length}</p>
        <p className="text-sm text-ink-muted">
          {features.length === 1 ? "feature replicated" : "features replicated"}
        </p>
      </div>

      {features.length === 0 ? (
        <div className="rounded-lg bg-card-2 p-6 text-center ring-1 ring-line">
          <p className="text-sm font-medium text-ink">No features tracked yet.</p>
          <p className="mt-1 text-xs text-ink-muted">
            Seed a doc in <code className="rounded bg-card-3 px-1">mimic_features</code> to see it here.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {features.map((feature) => (
              <div
                key={feature.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card-2 p-4 ring-1 ring-line"
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

          <div className="rounded-lg bg-card-2 p-4 ring-1 ring-line">
            <h2 className="mb-3 text-sm font-semibold text-ink">Attempts by status</h2>
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
                  <Bar dataKey="count" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
