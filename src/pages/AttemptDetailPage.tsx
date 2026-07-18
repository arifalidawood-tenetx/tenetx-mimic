import { useEffect, useState, type ReactNode } from "react";
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

/** Matches inline file/line references like "auth.py:42,824" or
 * "middleware.py:194-214" inside a technical writeup (`rootCause` /
 * `diffSummary`), so they can be rendered as monospace chips instead of
 * blending into the surrounding prose. */
const CODE_REF_RE = /\b[\w/-]+\.\w{1,5}(?::[\d,-]+)?\b/g;

/** Splits `text` at each `CODE_REF_RE` match, returning plain strings
 * interleaved with `<code>` chips for the matched refs. */
function renderCodeRefs(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  CODE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_REF_RE.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <code
        key={`${match.index}-${match[0]}`}
        className="rounded bg-card-3 px-1 py-0.5 font-mono text-xs text-ink"
      >
        {match[0]}
      </code>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

/** Matches a lettered clause marker like "(A) " or "(B) " — a single
 * uppercase letter in parens, distinct from parenthetical asides like
 * "(fixes ...)" which won't match a single-letter capture group. */
const LETTERED_CLAUSE_RE = /\(([A-Z])\)\s/g;

interface LetteredClause {
  marker: string;
  text: string;
}

/** Splits a multi-part summary like "One combined diff … — (A) …; (B) …"
 * into a lead-in sentence plus one entry per lettered clause, so a dense
 * writeup reads as a scannable list instead of one run-on paragraph.
 * Returns null when fewer than 2 markers are found, so single-clause text
 * (e.g. most `rootCause` values) falls back to a plain paragraph. */
function splitLetteredClauses(
  text: string
): { lead: string; clauses: LetteredClause[] } | null {
  const markers = [...text.matchAll(LETTERED_CLAUSE_RE)];
  if (markers.length < 2) return null;

  const lead = text.slice(0, markers[0].index).replace(/[\s—-]+$/, "");
  const clauses: LetteredClause[] = markers.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    return {
      marker: m[1],
      text: text.slice(start, end).replace(/;\s*$/, "").trim(),
    };
  });

  return { lead, clauses };
}

/** Renders a technical writeup (`rootCause` / `diffSummary`) readably:
 * inline file/line refs become monospace chips, and text with 2+ lettered
 * clauses ("(A) …; (B) …") becomes a lead-in sentence plus a bullet list
 * instead of one dense paragraph. */
function TechnicalCopy({ text }: { text: string }) {
  const split = splitLetteredClauses(text);

  if (split) {
    return (
      <div className="space-y-2 text-sm leading-relaxed text-ink-muted">
        {split.lead && <p>{renderCodeRefs(split.lead)}</p>}
        <ul className="space-y-1.5">
          {split.clauses.map((clause) => (
            <li key={clause.marker} className="flex gap-2">
              <span className="shrink-0 font-semibold text-ink-faint">({clause.marker})</span>
              <span>{renderCodeRefs(clause.text)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return <p className="text-sm leading-relaxed text-ink-muted">{renderCodeRefs(text)}</p>;
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

      {(doc.jiraUrl || feature === "saml-login-fix") && (
        <div className="flex flex-wrap items-center gap-3 px-1 py-1">
          {doc.jiraUrl && (
            <a
              href={doc.jiraUrl}
              target="_blank"
              rel="noreferrer"
              className="focus-ring inline-flex h-10 items-center rounded-lg px-3.5 text-sm text-accent underline transition-colors hover:bg-card-2"
            >
              View {doc.ticketId} in Jira
            </a>
          )}

          {feature === "saml-login-fix" && (
            <Link
              to={`/mimic/${ticket}/try-it-out`}
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium text-on-accent shadow-sm transition hover:brightness-110 active:scale-[0.98]"
            >
              <Icon name="zap" className="h-4 w-4 shrink-0" />
              Try it out
            </Link>
          )}
        </div>
      )}

      {feature === "saml-config" && (
        <div className="mx-auto max-w-3xl">
          <SamlConfigPage />
        </div>
      )}

      {feature === "saml-login-fix" && doc.notes && (
        <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
          <SectionHeader icon="check">Live verification</SectionHeader>
          <p className="text-sm text-ink-muted whitespace-pre-wrap">{doc.notes}</p>
        </div>
      )}

      {(feature === "saml-login-fix" || feature === "windows-server-managed-hook-fix" || feature === "windows-installer-idempotent-reinstall-fix") && (
        <div className="space-y-4">
          {doc.rootCause && (
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
              <SectionHeader icon="alert">Root cause</SectionHeader>
              <TechnicalCopy text={doc.rootCause} />
            </div>
          )}

          {doc.diffSummary && (
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow space-y-2">
              <SectionHeader icon="layers">Diff summary</SectionHeader>
              <TechnicalCopy text={doc.diffSummary} />
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
