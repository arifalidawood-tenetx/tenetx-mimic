/**
 * Seed script for TEN-135 attempt-1 in Firestore mimic_features collection.
 * 
 * Usage:
 *   npm run seed:ten135
 * 
 * This script reads Firebase config from .env.local (same as the Vite app)
 * and creates the TEN-135 SAML configuration attempt document.
 * 
 * NOTE: This script REQUIRES valid Firestore write access and a deployed
 * firestore.rules that allows authenticated writes to mimic_features.
 * As of this writing, rules deployment is pending GCP IAM access (see todo 7).
 */

import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, Timestamp } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import * as fs from "fs";
import * as path from "path";

// Load .env.local manually (Node doesn't have Vite's import.meta.env)
const envPath = path.resolve(".", ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
const env: Record<string, string> = {};
envContent.split("\n").forEach((line) => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const [key, ...valueParts] = trimmed.split("=");
    env[key] = valueParts.join("=");
  }
});

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

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
  idpType: "both",
  status: "done",
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
  ],
  createdAt: now,
  updatedAt: now,
};

async function seedTEN135() {
  try {
    console.log("📝 Seeding TEN-135 attempt-1 to Firestore...");
    console.log(
      `Project: ${firebaseConfig.projectId}, User: ${auth.currentUser?.email || "unauthenticated"}`
    );

    const docRef = await addDoc(collection(db, "mimic_features"), ten135Doc);
    console.log("✅ Successfully seeded TEN-135 document:");
    console.log(`   Document ID: ${docRef.id}`);
    console.log(`   Ticket: ${ten135Doc.ticketId}`);
    console.log(`   Feature: ${ten135Doc.featureSlug}`);
    console.log(`   Attempt: ${ten135Doc.attemptNumber}`);
    console.log(`   Status: ${ten135Doc.status}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to seed document:", error);
    process.exit(1);
  }
}

seedTEN135();
