import { Firestore } from "@google-cloud/firestore";
import { UserRefreshClient } from "google-auth-library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIREBASE_TOOLS_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_TOOLS_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

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
  throw new Error("FIREBASE_TOKEN not found");
}

async function main() {
  const refreshTokenValue = readFirebaseToken();
  const authClient = new UserRefreshClient(FIREBASE_TOOLS_CLIENT_ID, FIREBASE_TOOLS_CLIENT_SECRET, refreshTokenValue);
  const db = new Firestore({ projectId: "tenetx-qa-scores", authClient });
  
  const q = await db.collection("mimic_features")
    .where("ticketId", "==", "TEN-141")
    .where("featureSlug", "==", "saml-login-fix")
    .where("attemptNumber", "==", 1)
    .get();

  if (q.empty) {
    console.log("Document NOT found!");
    process.exit(1);
  }

  const doc = q.docs[0].data();
  console.log("✓ Document found in Firestore:");
  console.log(`  - Title: ${doc.title}`);
  console.log(`  - Status: ${doc.status}`);
  console.log(`  - RoutePathL: ${doc.routePath}`);
  console.log(`  - Root cause length: ${(doc.rootCause || "").length} chars`);
  console.log(`  - Diff summary length: ${(doc.diffSummary || "").length} chars`);
  console.log(`  - Solution markdown length: ${(doc.solutionMarkdown || "").length} chars`);
  console.log(`  - All required fields present: ${['title', 'status', 'rootCause', 'diffSummary', 'solutionMarkdown'].every(f => f in doc) ? 'YES' : 'NO'}`);
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
