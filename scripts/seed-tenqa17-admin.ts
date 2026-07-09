/**
 * LIVE seed script for the TENQA-17 attempt-1 doc in Firestore `mimic_features`.
 *
 * Usage:
 *   npm run seed:tenqa17:admin
 *
 * Mirrors scripts/seed-ten141-admin.ts EXACTLY for auth (same refresh-token /
 * @google-cloud/firestore pattern — see that file's header comment for the
 * full WHY). Only the seeded document payload + evidence-file path differ.
 *
 * solutionMarkdown is read live from
 * .omo/evidence/task-3-tenqa-17-windows-server-managed-hook-mimic-fix.txt (the
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
  const evidencePath = resolve("..", ".omo", "evidence", "task-3-tenqa-17-windows-server-managed-hook-mimic-fix.txt");
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
// (used by SAML tickets like TEN-141) and does not apply to this Claude Code
// hook ticket. The `MimicFeatureDoc` interface treats it as optional.
const tenqa17Doc = {
  ticketId: "TENQA-17",
  relatedTickets: ["TEN-111", "TEN-123"],
  featureSlug: "windows-server-managed-hook-fix",
  attemptNumber: 1,
  title: "Server-managed Claude Code hook: Windows-native command (proposed)",
  description:
    "Root-cause + proposed (unapplied, locally-verified) diff adding a Windows-native server_hook_command_by_platform variant; live pytest verification captured before/after on a Windows host; product-source repo intentionally left unmodified per QA-only workflow.",
  status: "done" as const,
  routePath: "/mimic/TENQA-17/windows-server-managed-hook-fix/1",
  jiraUrl: "https://tenetx-qa.atlassian.net/browse/TENQA-17",
  // sourceRefs are the two tenetx-source-code-dontpush commits the bug was
  // VERIFIED AGAINST — NOT "fix applied at" commits. Nothing was committed to
  // the product source (QA-only workflow); these cite the exact upstream state
  // the proposed diff was proven against.
  sourceRefs: ["1934f5a4", "224aa627"],
  rootCause:
    "The `_claude_artifact` function in `tenetx/agent_onboarding/artifacts.py` builds the `server_hook_command` field via `_python_hook_command`, which hardcodes POSIX shell syntax (sh -c with TENETX_-prefixed environment variables). This field is then returned unchanged for all platforms, including Windows.",
  diffSummary:
    "The proposed fix is purely additive: (1) new `_safe_windows_hook_command` function that mirrors `_safe_missing_hook_command`'s no-op-until-installed pattern but uses PowerShell syntax (Test-Path guard, & invocation operator, single-quoted literals); (2) new `_windows_single_quote` helper to escape values for PowerShell single-quoted strings (same convention already used in `mdm_guard._windows_guard_script`); (3) in `_claude_artifact`, compute `server_hook_command_by_platform` dict with Windows variant, and wire it into a new `settings_json_by_platform` dict; (4) three new dedicated pytest tests proving the Windows variant no-ops correctly when missing, dispatches correctly when installed, and carries deployment binding. Zero change to the flat `server_hook_command` field, zero change to existing tests (except the pre-existing POSIX-only test, which is intentionally left unchanged and continues to fail on Windows — documented as expected).",
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
  // concurrently, so a plain .add() risks duplicate TENQA-17 docs (which the app's
  // snapshot.docs[0] would then pick nondeterministically). If a matching doc
  // already exists, update it in place instead of adding a second one.
  const existing = await db
    .collection(COLLECTION)
    .where("ticketId", "==", "TENQA-17")
    .where("featureSlug", "==", "windows-server-managed-hook-fix")
    .where("attemptNumber", "==", 1)
    .get();

  let docId: string;
  if (!existing.empty) {
    docId = existing.docs[0].id;
    await db.collection(COLLECTION).doc(docId).set(tenqa17Doc);
    console.log(`UPDATE OK (existing doc). Document ID: ${docId}`);
    if (existing.size > 1) {
      console.warn(
        `WARNING: ${existing.size} pre-existing TENQA-17 docs; updated only the first (${docId}). Extra IDs: [${existing.docs
          .slice(1)
          .map((d) => d.id)
          .join(", ")}]`,
      );
    }
  } else {
    const docRef = await db.collection(COLLECTION).add(tenqa17Doc);
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
  console.log(`  idpType        = ${data.idpType}`);
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
    .where("ticketId", "==", "TENQA-17")
    .where("featureSlug", "==", "windows-server-managed-hook-fix")
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
