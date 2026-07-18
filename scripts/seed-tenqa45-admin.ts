/**
 * LIVE seed script for the TENQA-45 attempt-1 doc in Firestore `mimic_features`.
 *
 * Usage:
 *   npm run seed:tenqa45:admin
 *
 * Mirrors scripts/seed-ten141-admin.ts EXACTLY for auth (same refresh-token /
 * @google-cloud/firestore pattern — see that file's header comment for the
 * full WHY). Only the seeded document payload + evidence-file path differ.
 *
 * solutionMarkdown is read live from
 * .omo/evidence/task-1-tenqa-45-mobile-nav-header-fix.txt (the
 * "== BEGIN MARKDOWN ==" .. "== END MARKDOWN ==" block) rather than
 * hand-copied, so the seeded content can never drift from the verified
 * evidence file.
 *
 * SECRET HANDLING: FIREBASE_TOKEN is read from .env at runtime and never
 * printed or logged. Only the resulting Firestore doc ID (not a secret) is
 * printed.
 */

import { Firestore } from "@google-cloud/firestore";
import { UserRefreshClient } from "google-auth-library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// firebase-tools' PUBLIC OAuth client credentials (from firebase-tools
// lib/api.js: `clientId`/`clientSecret` — embedded in the open-source CLI,
// documented-in-source public values, not secrets).
const FIREBASE_TOOLS_CLIENT_ID =
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_TOOLS_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

const PROJECT_ID = "tenetx-qa-scores";
const COLLECTION = "mimic_features";

function readFirebaseToken(): string {
  const envPath = resolve(".", ".env");
  const raw = readFileSync(envPath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "FIREBASE_TOKEN") {
      return trimmed.slice(eq + 1).trim();
    }
  }
  throw new Error("FIREBASE_TOKEN not found in tenetx-mimic/.env");
}

function readSolutionMarkdown(): string {
  const evidencePath = resolve("..", ".omo", "evidence", "task-1-tenqa-45-mobile-nav-header-fix.txt");
  const raw = readFileSync(evidencePath, "utf-8");
  // Match the markers ONLY as standalone lines: the file's prose also mentions
  // the literal string "== BEGIN MARKDOWN ==", so a bare indexOf grabs that
  // prose occurrence and prepends garbage. Line-exact matching avoids it.
  const lines = raw.split(/\r?\n/);
  const beginIdx = lines.findIndex((l) => l.trim() === "== BEGIN MARKDOWN ==");
  const endIdx = lines.findIndex((l) => l.trim() === "== END MARKDOWN ==");
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error(
      `Could not extract markdown block from ${evidencePath} (standalone markers not found in expected order)`,
    );
  }
  return lines.slice(beginIdx + 1, endIdx).join("\n").trim();
}

const now = new Date().toISOString();

const solutionMarkdown = readSolutionMarkdown();

// NOTE: `idpType` is intentionally OMITTED — it is SAML/IdP-specific metadata
// (used by SAML tickets like TEN-141) and does not apply to this UI/CSS
// responsive-nav ticket. The `MimicFeatureDoc` interface treats it as optional.
const tenqa45Doc = {
  ticketId: "TENQA-45",
  relatedTickets: [] as string[],
  featureSlug: "mobile-nav-header-fix",
  attemptNumber: 1,
  title: "Homepage header: mobile hamburger nav (proposed, P0 slice of TENQA-45)",
  description:
    "TENQA-45 is a large cross-surface mobile-responsive ticket; this attempt addresses only its P0 App-shell bullet for the marketing HomePage header (top nav hidden at 768px with no hamburger replacement). Proposed, locally type-checked (tsc --noEmit, 0 errors), unapplied diff; product-source repo intentionally left unmodified per QA-only workflow. The ticket's other bullets (internal dashboard sidebar, data-table scroll, filter bars, modals, grid breakpoints, global CSS resets, small-phone polish) are NOT covered by this attempt.",
  status: "done" as const,
  routePath: "/mimic/TENQA-45/mobile-nav-header-fix/1",
  jiraUrl: "https://tenetx-qa.atlassian.net/browse/TENQA-45",
  // sourceRefs is the tenetx-source-code-dontpush commit the bug was VERIFIED
  // AGAINST — NOT a "fix applied at" commit. Nothing was committed to the
  // product source (QA-only workflow); this cites the exact upstream state
  // the proposed diff was type-checked against.
  sourceRefs: ["224aa627"],
  rootCause:
    "webui/src/pages/HomePage.css already hides the desktop `<nav>` (`.hp-header-nav`, implicit) and the CTA button row at `@media (max-width: 768px)` (the exact lines TENQA-45 cites), but webui/src/components/homepage/Header.tsx never mounted any replacement — below 768px the header loses all navigation and both CTAs with no hamburger, drawer, or fallback.",
  diffSummary:
    "Additive-only diff across Header.tsx + HomePage.css: (1) Header.tsx gains a `mobileMenuOpen` useState, tags the existing desktop nav/actions with `.hp-header-nav`/`.hp-header-actions` classNames (no style change above 768px), adds a `.hp-header-hamburger` toggle button (SVG open/close icon swap, aria-expanded/aria-label), and an `AnimatePresence`-wrapped `.hp-mobile-nav-panel` reusing the same `navLinks` array and the same book-a-demo/sign-in click handlers as desktop, just also closing the menu first; (2) HomePage.css hides the hamburger/panel by default and, inside the existing 768px media query, force-hides desktop nav/actions, force-shows the hamburger, and styles the panel as an absolutely-positioned blurred dropdown anchored under the header. Zero new dependencies (AnimatePresence ships in the already-imported framer-motion package); zero changes to any >768px rendering.",
  solutionMarkdown,
  createdAt: now,
  updatedAt: now,
};

async function main(): Promise<void> {
  const refreshTokenValue = readFirebaseToken();

  const authClient = new UserRefreshClient(
    FIREBASE_TOOLS_CLIENT_ID,
    FIREBASE_TOOLS_CLIENT_SECRET,
    refreshTokenValue,
  );

  const db = new Firestore({ projectId: PROJECT_ID, authClient });

  console.log(`Seeding ${COLLECTION} in project ${PROJECT_ID} via Admin (refresh-token) auth...`);
  console.log(`solutionMarkdown length: ${solutionMarkdown.length} chars`);

  // Idempotent upsert: multiple agent sessions are documented to run this plan
  // concurrently, so a plain .add() risks duplicate TENQA-45 docs (which the app's
  // snapshot.docs[0] would then pick nondeterministically). If a matching doc
  // already exists, update it in place instead of adding a second one.
  const existing = await db
    .collection(COLLECTION)
    .where("ticketId", "==", "TENQA-45")
    .where("featureSlug", "==", "mobile-nav-header-fix")
    .where("attemptNumber", "==", 1)
    .get();

  let docId: string;
  if (!existing.empty) {
    docId = existing.docs[0].id;
    await db.collection(COLLECTION).doc(docId).set(tenqa45Doc);
    console.log(`UPDATE OK (existing doc). Document ID: ${docId}`);
    if (existing.size > 1) {
      console.warn(
        `WARNING: ${existing.size} pre-existing TENQA-45 docs; updated only the first (${docId}). Extra IDs: [${existing.docs
          .slice(1)
          .map((d) => d.id)
          .join(", ")}]`,
      );
    }
  } else {
    const docRef = await db.collection(COLLECTION).add(tenqa45Doc);
    docId = docRef.id;
    console.log(`WRITE OK (new doc). Document ID: ${docId}`);
  }

  // Read-back #1: definitive get by the doc ID we just wrote.
  const snap = await db.collection(COLLECTION).doc(docId).get();
  if (!snap.exists) {
    throw new Error(`Read-back FAILED: doc ${docId} does not exist`);
  }
  const data = snap.data() ?? {};
  console.log("READ-BACK by doc ID OK. Confirmed fields:");
  console.log(`  ticketId       = ${data.ticketId}`);
  console.log(`  relatedTickets = [${(data.relatedTickets ?? []).join(", ")}]`);
  console.log(`  featureSlug    = ${data.featureSlug}`);
  console.log(`  attemptNumber  = ${data.attemptNumber}`);
  console.log(`  title          = ${data.title}`);
  console.log(`  description    = ${data.description}`);
  console.log(`  status         = ${data.status}`);
  console.log(`  routePath      = ${data.routePath}`);
  console.log(`  jiraUrl        = ${data.jiraUrl}`);
  console.log(`  sourceRefs     = [${(data.sourceRefs ?? []).join(", ")}]`);
  console.log(`  rootCause      = ${(data.rootCause ?? "").slice(0, 80)}...`);
  console.log(`  diffSummary    = ${(data.diffSummary ?? "").slice(0, 80)}...`);
  console.log(`  solutionMarkdown length = ${(data.solutionMarkdown ?? "").length}`);
  console.log(`  createdAt      = ${data.createdAt}`);
  console.log(`  updatedAt      = ${data.updatedAt}`);

  // Read-back #2: the same query the app (AttemptDetailPage) uses, proving the
  // doc is discoverable by (ticketId, featureSlug, attemptNumber).
  const q = await db
    .collection(COLLECTION)
    .where("ticketId", "==", "TENQA-45")
    .where("featureSlug", "==", "mobile-nav-header-fix")
    .where("attemptNumber", "==", 1)
    .get();
  console.log(
    `READ-BACK by query (ticketId+featureSlug+attemptNumber) OK. Matched ${q.size} doc(s): [${q.docs
      .map((d) => d.id)
      .join(", ")}]`,
  );

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("SEED FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
