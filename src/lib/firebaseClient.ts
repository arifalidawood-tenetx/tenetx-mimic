import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

/**
 * Minimal Firebase client bootstrap. Config is sourced from Vite env vars so
 * no secrets are hardcoded — see `.env.example` (or your deployment's env
 * config) for `VITE_FIREBASE_*` values.
 *
 * NOTE: this file may be superseded/reconciled with an equivalent created by
 * a parallel todo (firestore rules + adapter work) — same exported shape
 * (`auth`, `db`) is expected either way.
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
