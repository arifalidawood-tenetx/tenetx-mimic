/**
 * LIVE seed script for the TENQA-29 attempt-1 doc in Firestore `mimic_features`.
 *
 * Usage:
 *   npm run seed:tenqa29:admin
 *
 * Mirrors scripts/seed-ten141-admin.ts EXACTLY for auth (same refresh-token /
 * @google-cloud/firestore pattern — see that file's header comment for the
 * full WHY). Only the seeded document payload + evidence-file path differ.
 *
 * solutionMarkdown is read live from
 * .omo/evidence/task-5-tenqa-29-windows-installer-idempotent-reinstall-mimic-fix.txt (the
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
  const evidencePath = resolve("..", ".omo", "evidence", "task-5-tenqa-29-windows-installer-idempotent-reinstall-mimic-fix.txt");
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
const tenqa29Doc = {
  ticketId: "TENQA-29",
  relatedTickets: ["TEN-130", "TEN-131"],
  featureSlug: "windows-installer-idempotent-reinstall-fix",
  attemptNumber: 1,
  title: "Windows install.ps1 idempotent reinstall (proposed)",
  description:
    "Root-cause + proposed (unapplied, locally-verified) diff making the real served installer (tenetx/api/routes/cli_install.py::_powershell_installer, mirrored into cli-go/install/install.ps1) idempotent: in-place Copy-Item overwrite instead of delete-then-Expand-Archive, existing-install detection, warn-only elevation check, actionable Access-Denied remediation. Verified via extended pytest plus a live non-elevated ACL-deny repro; product-source repo intentionally left unmodified per QA-only workflow.",
  status: "done" as const,
  routePath: "/mimic/TENQA-29/windows-installer-idempotent-reinstall-fix/1",
  jiraUrl: "https://tenetx-qa.atlassian.net/browse/TENQA-29",
  sourceRefs: ["224aa627", "452b11e4"],
  rootCause:
    "cli-go/install/install.ps1:21 (and its served twin, tenetx/api/routes/cli_install.py::_powershell_installer) calls Expand-Archive -Force, which deletes then re-extracts tenetx.exe. If the first install ran elevated, the resulting binary is owned by BUILTIN\\Administrators; a later non-elevated reinstall's delete step is denied, crashing with a raw Access-Denied stack trace instead of a helpful message.",
  diffSummary:
    "Additive fix to _powershell_installer (mirrored into cli-go/install/install.ps1): (1) warn (not block) when the installer detects it is running elevated, since this is a per-user installer; (2) detect an existing tenetx.exe up front and print a message pointing at `tenetx update`; (3) extract to a staging directory and Copy-Item each file over the destination in place instead of Expand-Archive's delete-then-extract, since Copy-Item overwrites content without requiring delete permission; (4) on any remaining write failure, catch it and print actionable remediation steps instead of the raw Expand-Archive stack trace. Verified via an extended pytest suite (tests/unit/test_cli_install_routes.py) and a live non-elevated Windows repro proving Copy-Item succeeds where Remove-Item is denied.",
  notes:
    "LIVE VERIFICATION (2026-07-10): pytest tests/unit/test_cli_install_routes.py - 6 passed (5 existing + 1 new TENQA-29 test), confirmed failing without the diff and passing with it. Live non-elevated repro on a real Windows machine (DESKTOP-MKEF4UL): simulated an Administrators-owned-equivalent file via a precise self-deny ACL (Delete on the file + DeleteSubdirectoriesAndFiles on the parent, leaving Synchronize/Write intact); confirmed Remove-Item fails Access Denied (matching the reported failure) and the new Copy-Item-based logic succeeds in place. Elevation-hygiene is implemented as a WARNING, not a hard refuse - this was the one acceptance criterion the ticket left open ('detect and refuse/warn'); flagged for engineering to confirm or override. Proposed fix is NOT applied to tenetx-source-code-dontpush/ (protected module, read-only) - applied to the working tree for verification, then discarded via `git checkout --`.",
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
  // concurrently, so a plain .add() risks duplicate TENQA-29 docs (which the app's
  // snapshot.docs[0] would then pick nondeterministically). If a matching doc
  // already exists, update it in place instead of adding a second one.
  const existing = await db
    .collection(COLLECTION)
    .where("ticketId", "==", "TENQA-29")
    .where("featureSlug", "==", "windows-installer-idempotent-reinstall-fix")
    .where("attemptNumber", "==", 1)
    .get();

  let docId: string;
  if (!existing.empty) {
    docId = existing.docs[0].id;
    await db.collection(COLLECTION).doc(docId).set(tenqa29Doc);
    console.log(`UPDATE OK (existing doc). Document ID: ${docId}`);
    if (existing.size > 1) {
      console.warn(
        `WARNING: ${existing.size} pre-existing TENQA-29 docs; updated only the first (${docId}). Extra IDs: [${existing.docs
          .slice(1)
          .map((d) => d.id)
          .join(", ")}]`,
      );
    }
  } else {
    const docRef = await db.collection(COLLECTION).add(tenqa29Doc);
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
    .where("ticketId", "==", "TENQA-29")
    .where("featureSlug", "==", "windows-installer-idempotent-reinstall-fix")
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
