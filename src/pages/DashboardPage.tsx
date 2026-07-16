import { useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseClient";
import { PageContainer } from "@/components/PageContainer";
import { FeatureStatus, isFeatureStatus } from "@/lib/types";
import { StatCard, computeCompletionRate, formatCompletionRate } from "@/components/dashboard/StatCard";
import { McpStatusCard } from "@/components/dashboard/McpStatusCard";
import { FeatureRegistryList } from "@/components/dashboard/FeatureRegistryList";
import { getMcpCounts } from "@/lib/mcpTokens";
import { checkMcpHealth } from "@/lib/mcpHealth";

const SAML_PROXY_URL = import.meta.env.VITE_SAML_PROXY_URL ?? "";

interface MimicFeature {
  id: string;
  ticketId: string;
  featureSlug: string;
  attemptNumber: number;
  title: string;
  status: FeatureStatus;
  routePath: string;
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

export function DashboardPage() {
  const [features, setFeatures] = useState<MimicFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mcpCounts, setMcpCounts] = useState<{
    tokenCount: number;
    toolCallCount: number;
  } | null>(null);
  const [mcpDeployed, setMcpDeployed] = useState(false);

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

  /**
   * Fetch MCP counts (tokens + tool calls) in parallel with mimic_features.
   * Uses the same cancelled-flag pattern to avoid set-state-after-unmount.
   * On failure, falls back to null and renders 0/0 in McpStatusCard.
   */
  useEffect(() => {
    let cancelled = false;

    async function loadMcpCounts() {
      try {
        const counts = await getMcpCounts();
        if (!cancelled) {
          setMcpCounts(counts);
        }
      } catch (err) {
        console.error("getMcpCounts failed:", err);
        if (!cancelled) {
          // Render McpStatusCard with fallback 0/0, don't break the page
          setMcpCounts({ tokenCount: 0, toolCallCount: 0 });
        }
      }
    }

    void loadMcpCounts();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Derives the MCP "deployed" badge from a real `GET {base}/health` probe
   * (see `mcpHealth.ts`) rather than a hardcoded `false` — the backend now
   * actually mounts a live `/mcp` + `/health` FastAPI app (Task 6), so this
   * card can report truthfully instead of always claiming "not deployed".
   * Falls back to `false` (never fabricated `true`) on any failure/timeout.
   */
  useEffect(() => {
    let cancelled = false;

    checkMcpHealth(SAML_PROXY_URL).then((healthy) => {
      if (!cancelled) setMcpDeployed(healthy);
    });

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

  const completionRate = computeCompletionRate(features);
  const doneCount = features.filter((feature) => feature.status === "done").length;

  return (
    <PageContainer size="wide" className="space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          All replicated features tracked in <code className="rounded bg-card-2 px-1">mimic_features</code>.
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
         <StatCard
           label="Completion rate"
           value={formatCompletionRate(completionRate)}
           subtitle={`${doneCount} of ${features.length} features done`}
         />
         <McpStatusCard
           tokenCount={mcpCounts?.tokenCount ?? 0}
           toolCallCount={mcpCounts?.toolCallCount ?? 0}
           deployed={mcpDeployed}
         />
       </div>

      <FeatureRegistryList features={features} />
    </PageContainer>
  );
}
