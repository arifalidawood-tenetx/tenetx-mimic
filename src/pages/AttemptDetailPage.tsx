import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebaseClient";
import { Badge, Button, Spinner, type Tone } from "@/components/ui";
import { SamlConfigPage } from "./SamlConfigPage";

/**
 * Shape of a `mimic_features` doc (schema defined by todo 15 — see
 * `.omo/notepads/tenetx-mimic-saml-tracker/learnings.md` for the full field
 * list). Kept local to this file rather than a shared `src/lib/types.ts`
 * since todo 15 (which owns that schema file) is still blocked on todo 7's
 * rules deploy — this type will need reconciling with todo 15's canonical
 * version once that lands, but the field names/shapes match exactly.
 */
interface MimicFeatureDoc {
  ticketId: string;
  relatedTickets?: string[];
  featureSlug: string;
  attemptNumber: number;
  title: string;
  description?: string;
  status: string;
  routePath?: string;
  jiraUrl?: string;
  sourceRefs?: string[];
  idpType?: string;
  notes?: string;
  rootCause?: string; // root-cause classification writeup
  diffSummary?: string; // short summary of the diff/fix applied
  solutionMarkdown?: string; // rendered raw (no markdown renderer), copy-to-clipboard
}

const STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  "in-progress": "warning",
  done: "success",
};

/**
 * Reads `:ticket/:feature/:attempt` route params and looks up the matching
 * `mimic_features` doc via an exact-match compound query. Renders the
 * doc's title/description/status/related-tickets/Jira link when found; a
 * clear not-found state (not a crash) when the query returns zero docs.
 *
 * SamlConfigPage (todo 13, previously unmounted/orphaned) is mounted here
 * when `feature === "saml-config"` — that attempt's whole "exclusive
 * route" IS the feature demo, so rendering the live config page as part of
 * this attempt's detail view is the natural place to make it reachable via
 * routing rather than adding a second dedicated route for one feature.
 */
export function AttemptDetailPage() {
  const { ticket, feature, attempt } = useParams();
  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState<MimicFeatureDoc | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;

    async function run() {
      setLoading(true);
      setNotFound(false);
      setDoc(null);
      try {
        const attemptNumber = Number(attempt);
        const q = query(
          collection(db, "mimic_features"),
          where("ticketId", "==", ticket),
          where("featureSlug", "==", feature),
          where("attemptNumber", "==", attemptNumber)
        );
       const snapshot = await getDocs(q);
         if (!active) return;
         if (snapshot.empty) {
           setNotFound(true);
         } else {
           setDoc(snapshot.docs[0].data() as MimicFeatureDoc);
         }
       } catch (err) {
         console.error("mimic_features query failed:", err);
         if (active) setNotFound(true);
       } finally {
         if (active) setLoading(false);
       }
    }

    void run();
    return () => {
      active = false;
    };
  }, [ticket, feature, attempt]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-ink-muted">
        <Spinner className="h-4 w-4" />
        Loading attempt…
      </div>
    );
  }

  if (notFound || !doc) {
    return (
      <div className="p-6">
        <h2 className="text-lg font-semibold text-ink">Attempt not found</h2>
        <p className="mt-2 text-sm text-ink-muted">
          No tracked attempt matches {ticket}/{feature}/{attempt}.
        </p>
      </div>
    );
  }

  const tone = STATUS_TONE[doc.status] ?? "neutral";

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">{doc.title}</h1>
          <Badge tone={tone}>{doc.status}</Badge>
        </div>
        {doc.description && <p className="text-sm text-ink-muted">{doc.description}</p>}
      </div>

      {doc.relatedTickets && doc.relatedTickets.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-ink">Related tickets</h2>
          <div className="flex flex-wrap gap-2">
            {doc.relatedTickets.map((t) => (
              <a
                key={t}
                href={`https://daxnai.atlassian.net/browse/${t}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent underline"
              >
                {t}
              </a>
            ))}
          </div>
        </div>
      )}

      {doc.jiraUrl && (
        <a
          href={doc.jiraUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-accent underline"
        >
          View {doc.ticketId} in Jira
        </a>
      )}

      {feature === "saml-config" && (
        <div className="border-t border-line pt-6">
          <SamlConfigPage />
        </div>
      )}

      {feature === "saml-login-fix" && (
        <div className="border-t border-line pt-6 space-y-4">
          {doc.rootCause && (
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-ink">Root cause</h2>
              <p className="text-sm text-ink-muted">{doc.rootCause}</p>
            </div>
          )}

          {doc.diffSummary && (
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-ink">Diff summary</h2>
              <p className="text-sm text-ink-muted">{doc.diffSummary}</p>
            </div>
          )}

          {doc.solutionMarkdown && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">Full solution</h2>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(doc.solutionMarkdown ?? "");
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied!" : "Copy"}
                </Button>
              </div>
              <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-card-2 p-3 text-xs text-ink ring-1 ring-line">
                {doc.solutionMarkdown}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
