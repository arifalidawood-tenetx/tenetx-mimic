import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebaseClient";
import { Badge, Button, SectionHeader, Spinner, type Tone } from "@/components/ui";
import { Icon } from "@/components/icons";
import { DiffView } from "@/components/DiffView";
import { cn } from "@/utils/cn";
import { PageContainer } from "@/components/PageContainer";
import { SamlConfigPage } from "./SamlConfigPage";

/** General fallback route for the guided live-login wizard (TryItOutPage, todo 3).
 * Kept as a named constant for potential fallback use and test imports, but the
 * "Try it out" CTA for saml-login-fix now uses a computed ticket-nested route
 * instead: `/mimic/${ticket}/try-it-out`. This constant remains exported in case
 * other code or tests reference it. */
export const TRY_IT_OUT_ROUTE = "/mimic/try-it-out";

/** Shared visual treatment for the solution block, whether rendered as a
 * plain `<pre>` (non-diff / prose segments) or as `DiffView` (the detected
 * diff segment) — kept in one place so both stay in sync. Deliberately
 * excludes a `whitespace-*` class: `<pre>` needs `whitespace-pre-wrap`
 * (long prose lines wrap) while `DiffView` needs `whitespace-pre` (diff
 * lines must not wrap), so each call site adds its own. */
const SOLUTION_BLOCK_CLASSES =
  "overflow-auto rounded-xl bg-card-2 p-4 text-sm font-mono leading-relaxed text-ink ring-1 ring-line shadow-sm";

const DIFF_FENCE_RE = /```diff\n([\s\S]*?)```/;
const DIFF_MARKER_RE = /(^|\n)(--- a\/|\+\+\+ b\/|@@ )/;

interface SolutionSplit {
  before: string;
  diff: string;
  after: string;
}

/**
 * Detects a unified-diff block inside `solutionMarkdown` and splits it into
 * a prose "before" segment, the diff body (rendered via `DiffView`), and a
 * prose "after" segment (still rendered via the existing `<pre>`). Prefers
 * an explicit ```diff fenced block when present (the shape the task-9
 * evidence markdown deliverable uses); otherwise falls back to treating
 * everything from the first raw diff marker (`--- a/`, `+++ b/`, `@@ `)
 * onward as the diff body. Returns null when no diff markers are found at
 * all, so callers fall back to rendering the whole string as before —
 * zero regression for non-diff `solutionMarkdown` content.
 */
function splitSolutionMarkdown(markdown: string): SolutionSplit | null {
  const fenceMatch = markdown.match(DIFF_FENCE_RE);
  if (fenceMatch) {
    const [full, diffBody] = fenceMatch;
    const idx = markdown.indexOf(full);
    return {
      before: markdown.slice(0, idx),
      diff: diffBody.replace(/\n$/, ""),
      after: markdown.slice(idx + full.length),
    };
  }

  const markerMatch = markdown.match(DIFF_MARKER_RE);
  if (!markerMatch || markerMatch.index === undefined) return null;

  let start = markerMatch.index;
  if (markdown[start] === "\n") start += 1;

  return { before: markdown.slice(0, start), diff: markdown.slice(start), after: "" };
}

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
      <PageContainer size="wide" className="space-y-8">
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="h-4 w-4" />
          Loading attempt…
        </div>
      </PageContainer>
    );
  }

  if (notFound || !doc) {
    return (
      <PageContainer size="wide" className="space-y-8">
        <h2 className="text-lg font-semibold text-ink">Attempt not found</h2>
        <p className="mt-2 text-sm text-ink-muted">
          No tracked attempt matches {ticket}/{feature}/{attempt}.
        </p>
      </PageContainer>
    );
  }

  const tone = STATUS_TONE[doc.status] ?? "neutral";

  return (
    <PageContainer size="wide" className="space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">{doc.title}</h1>
          <Badge tone={tone}>{doc.status}</Badge>
        </div>
        {doc.description && <p className="text-sm text-ink-muted max-w-prose">{doc.description}</p>}
      </div>

      {doc.relatedTickets && doc.relatedTickets.length > 0 && (
        <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
          <SectionHeader icon="branch">Related tickets</SectionHeader>
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
        <div className="mx-auto max-w-3xl">
          <SamlConfigPage />
        </div>
      )}

       {feature === "saml-login-fix" && (
         <div className="space-y-4">
           <Link
             to={`/mimic/${ticket}/try-it-out`}
             className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium text-on-accent shadow-sm transition hover:brightness-110 active:scale-[0.98]"
           >
             <Icon name="zap" className="h-4 w-4 shrink-0" />
             Try it out
           </Link>

          {doc.notes && (
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
              <SectionHeader icon="check">Live verification</SectionHeader>
              <p className="text-sm text-ink-muted whitespace-pre-wrap">{doc.notes}</p>
            </div>
          )}
        </div>
      )}

      {(feature === "saml-login-fix" || feature === "windows-server-managed-hook-fix" || feature === "windows-installer-idempotent-reinstall-fix") && (
        <div className="space-y-4">
          {doc.rootCause && (
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
              <SectionHeader icon="alert">Root cause</SectionHeader>
              <p className="text-sm text-ink-muted max-w-prose">{doc.rootCause}</p>
            </div>
          )}

          {doc.diffSummary && (
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
              <SectionHeader icon="layers">Diff summary</SectionHeader>
              <p className="text-sm text-ink-muted max-w-prose">{doc.diffSummary}</p>
            </div>
          )}

          {doc.solutionMarkdown && (
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
              <div className="flex items-center justify-between">
                <SectionHeader icon="code">Full solution</SectionHeader>
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
              {(() => {
                const split = splitSolutionMarkdown(doc.solutionMarkdown);
                if (!split) {
                  return (
                    <pre className={cn(SOLUTION_BLOCK_CLASSES, "whitespace-pre-wrap")}>
                      {doc.solutionMarkdown}
                    </pre>
                  );
                }
                return (
                  <div className="space-y-2">
                    {split.before.trim() && (
                      <pre className={cn(SOLUTION_BLOCK_CLASSES, "whitespace-pre-wrap")}>
                        {split.before.trim()}
                      </pre>
                    )}
                    <DiffView diff={split.diff} className={SOLUTION_BLOCK_CLASSES} />
                    {split.after.trim() && (
                      <pre className={cn(SOLUTION_BLOCK_CLASSES, "whitespace-pre-wrap")}>
                        {split.after.trim()}
                      </pre>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </PageContainer>
  );
}
