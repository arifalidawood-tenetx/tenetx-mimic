/**
 * LIVE seed script for the TEN-141 attempt-1 doc in Firestore `mimic_features`.
 *
 * Usage:
 *   npm run seed:ten141:admin
 *
 * Mirrors scripts/seed-ten135-admin.ts EXACTLY for auth (same refresh-token /
 * @google-cloud/firestore pattern — see that file's header comment for the
 * full WHY). Only the seeded document payload differs.
 *
 * solutionMarkdown is read live from
 * .omo/evidence/task-9-keycloak-saml-login-diff-fix.txt (the "== BEGIN
 * MARKDOWN ==" .. "== END MARKDOWN ==" block) rather than hand-copied, so the
 * seeded content can never drift from the verified evidence file.
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
  const evidencePath = resolve("..", ".omo", "evidence", "task-9-keycloak-saml-login-diff-fix.txt");
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

const ten141Doc = {
  ticketId: "TEN-141",
  relatedTickets: ["TEN-144"],
  featureSlug: "saml-login-fix",
  attemptNumber: 1,
  title: "Keycloak SAML ACS validation root-cause + fix",
  description:
    "Static-code-review root cause (SP host-derivation bypasses X-Forwarded-Host, and the real validation reason is swallowed before reaching the user) + proposed unapplied diff; live Destination/Audience repro not achievable within the SAML response's ~60s replay window in this environment.",
  idpType: "both" as const,
  status: "done" as const,
  routePath: "/mimic/TEN-141/saml-login-fix/1",
  jiraUrl: "https://daxnai.atlassian.net/browse/TEN-141",
  sourceRefs: ["098eeb1", "117fc15", "333b436", "91d160c", "c3dbb48"],
  rootCause:
    "Strict SAML validation (saml.py:121) rejects a correctly-signed Keycloak Response because the SP ACS/Entity-ID is derived from the raw Host header (auth.py:42,824) instead of the forwarded-aware host used to route the org (middleware.py:194-214); the true reason is then swallowed (saml.py:46-51 + auth.py:1038) and never surfaced to the browser (TEN-141 acceptance criterion 3).",
  diffSummary:
    "One combined diff on tenetx/api/routes/auth.py — (A) route SAML ACS host derivation through middleware._get_request_host so SP ACS/Entity-ID honors X-Forwarded-Host like the org routing and the 9 sibling sites (fixes Destination/Audience divergence behind a Host-rewriting proxy; backward-compatible when the trust flag is off); (B) thread the specific python3-saml reason through _saml_acs_error_redirect as a URL-encoded reason param so the setup wizard shows an actionable detail instead of the opaque saml_validation_failed.",
   notes:
     "LIVE VERIFICATION (2026-07-09): Proposed fix verified end-to-end via the Try-It-Out wizard against both Keycloak and Authentik.\n\n✓ Keycloak: Real login validated by the real SAMLProvider (qa-saml-tester@tenetx-mimic.test). Defect A (X-Forwarded-Host derivation) live-exercised via a genuine reverse-proxy header divergence — success with matching host, HTTP 401 with divergent host naming the injected X-Forwarded-Host (not raw Host), proving the SP identity was derived from X-Forwarded-Host. Defect B (specific reason surfacing) proven simultaneously.\n\n✓ Authentik: Real login validated by the real SAMLProvider (aad.connected@gmail.com). Defect A live-exercised identically — success with matching host, HTTP 401 with divergent host naming the injected X-Forwarded-Host, corroborated by deterministic harness replay. Four Authentik-specific gotchas documented (Sign Response vs Sign Assertion, host-derived Audience, SP binding=post, no duplicate-attribute quirk).\n\nConclusion: The proposed fix is proven correct via a faithful mimic under real IdP conditions. The fix is NOT applied to tenetx-source-code-dontpush/ (protected module, read-only). The real product's separate organization_not_found and provider-filter bugs remain unfixed there.\n\nREPLICATION LEARNINGS (2026-07-10, mimic-saml-per-tester-idp-identity plan): When running the Try-It-Out wizard without the MIMIC_IDP_ENTITY_ID, MIMIC_IDP_SSO_URL, and MIMIC_IDP_CERT_FILE environment variables set, the /saml/acs endpoint falls back to a synthetic-default-issuer identity (https://synthetic-keycloak-idp.invalid/...) instead of validating against the real IdP. A tester who verifies a real Keycloak realm and launches a login will hit an \"Invalid issuer\" rejection because the backend's SAML validation expects the synthetic placeholder, not the real realm's entity ID. This env-var configuration was necessary during early development when the mimic could only support one preconfigured IdP identity at a time.\n\nKeycloak's \"Role list\" mapper (the default role-mapping configuration in Keycloak's Client scopes) outputs multiple <Attribute Name=\"Role\"> elements, one per role value. This triggers python3-saml's duplicate-Attribute-Name rejection in tenetx-source-code-dontpush/tenetx/auth/providers/saml.py:46-51 (saml_validation_error_code), which is the same root cause as Defect B documented above — a third live-confirmed instance of the generic-error-code collapse. The fix: in the Keycloak admin console, navigate to Clients → [your client] → Client scopes → [dedicated scope] → \"role list\" mapper → toggle \"Single Role Attribute\" ON. This consolidates all role values into a single <Attribute Name=\"Role\"> element with multiple <AttributeValue> children, satisfying the duplicate-Name check.\n\nThe mimic-saml-per-tester-idp-identity plan (todos 1-14 of this session) removes the single-global-IdP-identity limitation by resolving each tester's verified Firestore connection automatically via a RelayState-carried doc-ID reference. Future testers no longer need MIMIC_IDP_* environment variables for arbitrary realms; the tester's own verified connection is now resolved at /saml/acs and /saml/sls callback time, enabling true per-tester and per-realm SAML validation without server restarts or env-var edits.",
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
  // concurrently, so a plain .add() risks duplicate TEN-141 docs (which the app's
  // snapshot.docs[0] would then pick nondeterministically). If a matching doc
  // already exists, update it in place instead of adding a second one.
  const existing = await db
    .collection(COLLECTION)
    .where("ticketId", "==", "TEN-141")
    .where("featureSlug", "==", "saml-login-fix")
    .where("attemptNumber", "==", 1)
    .get();

  let docId: string;
  if (!existing.empty) {
    docId = existing.docs[0].id;
    await db.collection(COLLECTION).doc(docId).set(ten141Doc);
    console.log(`UPDATE OK (existing doc). Document ID: ${docId}`);
    if (existing.size > 1) {
      console.warn(
        `WARNING: ${existing.size} pre-existing TEN-141 docs; updated only the first (${docId}). Extra IDs: [${existing.docs
          .slice(1)
          .map((d) => d.id)
          .join(", ")}]`,
      );
    }
  } else {
    const docRef = await db.collection(COLLECTION).add(ten141Doc);
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
    .where("ticketId", "==", "TEN-141")
    .where("featureSlug", "==", "saml-login-fix")
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
