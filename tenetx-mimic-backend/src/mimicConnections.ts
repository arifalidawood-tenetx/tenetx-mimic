import { Firestore } from '@google-cloud/firestore';
import { UserRefreshClient } from 'google-auth-library';
import { logger } from './logger.js';

/**
 * Per-connection IdP identity read from the `mimic_idp_connections` Firestore
 * collection — the same doc the Try-It-Out wizard writes on realm verification
 * (see `src/pages/TryItOutPage.tsx`, which persists exactly these four fields).
 * All four are strings; an absent value is the empty string, never `undefined`
 * (mirrors `samlMetadata.ts`'s existing empty-string-not-undefined convention).
 */
export interface MimicIdpConnection {
  entity_id: string;
  sso_url: string;
  slo_url: string;
  certificate: string;
}

// firebase-tools' PUBLIC OAuth client credentials (from firebase-tools
// lib/api.js: `clientId`/`clientSecret` — embedded verbatim in the open-source
// CLI, documented-in-source PUBLIC values, NOT secrets). Deliberately
// duplicated here (they also live in `index.ts:51-53` and
// `scripts/seed-ten141-admin.ts:29-31`): this repo's established convention for
// these specific documented-public constants, per both existing files' own
// comments explaining why the duplication is fine and not a code smell.
const FIREBASE_TOOLS_CLIENT_ID =
  '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_TOOLS_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const PROJECT_ID = 'tenetx-qa-scores';
const COLLECTION = 'mimic_idp_connections';

// Memoized module-level singleton, built on the FIRST successful call only.
//
// WHY `@google-cloud/firestore` + `google-auth-library`'s `UserRefreshClient`
// (and NOT `firebase-admin`'s Firestore wrapper): the firebase-admin Firestore
// wrapper is documented non-functional with this project's refresh-token
// ("authorized_user") credential — see the comment block at `index.ts:36-78`.
// This mirrors the ONLY proven-working Firestore-read pattern in this repo,
// `scripts/seed-ten141-admin.ts:97-106`. Do not reinvent it.
let dbSingleton: Firestore | null = null;

function getFirestore(refreshToken: string): Firestore {
  if (dbSingleton) return dbSingleton;
  const authClient = new UserRefreshClient(
    FIREBASE_TOOLS_CLIENT_ID,
    FIREBASE_TOOLS_CLIENT_SECRET,
    refreshToken,
  );
  dbSingleton = new Firestore({ projectId: PROJECT_ID, authClient });
  return dbSingleton;
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Look up a single `mimic_idp_connections` doc by ID and return its IdP
 * identity, or `null` when unavailable.
 *
 * NEVER throws. A missing doc, an unset `FIREBASE_REFRESH_TOKEN`, or ANY
 * Firestore error all resolve to `null` (after logging a warning). Callers treat
 * `null` as "no per-tester override available" and fall back safely to their
 * existing behavior (env-var identity for `/saml/acs`, direct query params for
 * `/saml/sls`).
 */
export async function getMimicIdpConnection(
  connectionDocId: string,
): Promise<MimicIdpConnection | null> {
  // Re-checked on EVERY call, independent of the memoized client, so an unset
  // token always degrades to `null` — even after the singleton was already
  // built by an earlier call with the token present.
  const refreshToken = process.env.FIREBASE_REFRESH_TOKEN;
  if (!refreshToken) {
    logger.warn(
      'getMimicIdpConnection: FIREBASE_REFRESH_TOKEN not set; returning null (no per-tester IdP override).',
    );
    return null;
  }

  try {
    const db = getFirestore(refreshToken);
    const snap = await db.collection(COLLECTION).doc(connectionDocId).get();

    if (!snap.exists) {
      logger.warn(
        { connectionDocId },
        'getMimicIdpConnection: no mimic_idp_connections doc found; returning null.',
      );
      return null;
    }

    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const entity_id = coerceString(data.entity_id);

    // An entity_id-less "connection" is unusable as a SAML IdP identity.
    if (!entity_id) {
      logger.warn(
        { connectionDocId },
        'getMimicIdpConnection: doc has no entity_id; returning null.',
      );
      return null;
    }

    return {
      entity_id,
      sso_url: coerceString(data.sso_url),
      slo_url: coerceString(data.slo_url),
      certificate: coerceString(data.certificate),
    };
  } catch (err) {
    logger.warn(
      { connectionDocId, err },
      'getMimicIdpConnection: Firestore lookup failed; returning null.',
    );
    return null;
  }
}
