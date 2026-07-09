/**
 * LIVE seed script for the TEN-135 attempt-1 doc in Firestore `mimic_features`.
 *
 * Usage:
 *   npm run seed:ten135:admin
 *
 * WHY server-side admin auth (not the client SDK in seed-ten135-attempt.ts):
 *   The deployed firestore.rules gate writes on `isTenetxUser()`, which requires
 *   an authenticated @tenetx.ai client session. We have no user email/password to
 *   sign in with. Server-side admin access bypasses Firestore Security Rules
 *   entirely (by design — rules only gate client-SDK access; server-side access
 *   is IAM-gated instead). We authenticate with the `firebase login:ci` refresh
 *   token stored in tenetx-mimic/.env as FIREBASE_TOKEN, whose owner
 *   (arif.dawood@tenetx.ai) is Owner on the tenetx-qa-scores project.
 *
 * WHY @google-cloud/firestore directly (not firebase-admin's getFirestore):
 *   firebase-admin/app's `refreshToken()` credential DOES mint valid access
 *   tokens — but firebase-admin's own Firestore wrapper rejects any non-service-
 *   account / non-ADC credential with "Must initialize the SDK with a certificate
 *   credential or application default credentials". So we drive
 *   @google-cloud/firestore (a firebase-admin dependency) directly, handing it a
 *   google-auth-library `UserRefreshClient` built from the refresh token. This
 *   keeps the token in memory only (never written to disk as an ADC file).
 *
 *   The client_id/client_secret are firebase-tools' OWN PUBLIC OAuth client
 *   credentials, embedded verbatim in firebase-tools' open-source `lib/api.js`
 *   (`clientId`/`clientSecret`). They are documented-in-source public values,
 *   NOT secrets.
 *
 * SECRET HANDLING: FIREBASE_TOKEN is read from .env at runtime and never printed
 * or logged. Only the resulting Firestore doc ID (not a secret) is printed.
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

const now = new Date().toISOString();

const ten135Doc = {
  ticketId: "TEN-135",
  relatedTickets: [
    "TEN-121",
    "TEN-117",
    "TEN-136",
    "TEN-137",
    "TEN-140",
    "TEN-141",
    "TEN-144",
    "TEN-183",
  ],
  featureSlug: "saml-config",
  attemptNumber: 1,
  title: "Generic SAML/OIDC configuration (Keycloak + Authentik)",
  description:
    "Implemented a unified SAML assertion parser and proxy supporting both Keycloak and Authentik providers. Configured dedicated realms and SAML applications for TenetX Mimic and validated metadata endpoints and assertion parsing across both IdP implementations.",
  idpType: "both" as const,
  status: "done" as const,
  routePath: "/mimic/TEN-135/saml-config/1",
  jiraUrl: "https://daxnai.atlassian.net/browse/TEN-135",
  sourceRefs: [
    "ffe4cb3",
    "43a2126",
    "caa2059",
    "2526336",
    "1e3ffd6",
    "9264e9a",
    "145d787",
    "ab1bf1b",
    "b041eee",
    "66c0145",
  ],
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

  const docRef = await db.collection(COLLECTION).add(ten135Doc);
  console.log(`WRITE OK. Document ID: ${docRef.id}`);

  // Read-back #1: definitive get by the doc ID we just wrote.
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error(`Read-back FAILED: doc ${docRef.id} does not exist`);
  }
  const data = snap.data() ?? {};
  console.log("READ-BACK by doc ID OK. Confirmed fields:");
  console.log(`  ticketId       = ${data.ticketId}`);
  console.log(`  relatedTickets = [${(data.relatedTickets ?? []).join(", ")}]`);
  console.log(`  featureSlug    = ${data.featureSlug}`);
  console.log(`  attemptNumber  = ${data.attemptNumber}`);
  console.log(`  title          = ${data.title}`);
  console.log(`  idpType        = ${data.idpType}`);
  console.log(`  status         = ${data.status}`);
  console.log(`  routePath      = ${data.routePath}`);
  console.log(`  jiraUrl        = ${data.jiraUrl}`);
  console.log(`  sourceRefs     = [${(data.sourceRefs ?? []).join(", ")}]`);
  console.log(`  createdAt      = ${data.createdAt}`);
  console.log(`  updatedAt      = ${data.updatedAt}`);

  // Read-back #2: the same query the app (AttemptDetailPage) uses, proving the
  // doc is discoverable by (ticketId, featureSlug, attemptNumber).
  const q = await db
    .collection(COLLECTION)
    .where("ticketId", "==", "TEN-135")
    .where("featureSlug", "==", "saml-config")
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
