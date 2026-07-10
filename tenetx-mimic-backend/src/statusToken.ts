import { createHmac, timingSafeEqual } from 'crypto';

// Signed, short-lived status token used to hand a SAML verdict back to the SPA
// through a redirect query param (consumed by /saml/acs and /saml/sls). This is
// NOT a session credential: it carries no Firebase UID / session identifier and
// is only trusted for the 5-minute window after it is minted.
//
// Token shape: base64url(JSON.stringify(payload)) + "." + hmacSha256Hex(secret, base64urlPart)

// Dev-only fallback secret. Local/test runs and ephemeral preview deploys don't
// always have MIMIC_STATUS_SECRET wired up, so we fall back to a fixed constant
// to keep the flow exercisable — but warn loudly, since tokens signed with this
// value are forgeable by anyone reading this source. Mirrors the
// FIREBASE_REFRESH_TOKEN-unset warning in index.ts:55-58.
const DEV_ONLY_SECRET = 'tenetx-mimic-dev-only-insecure-secret';

const statusSecret = process.env.MIMIC_STATUS_SECRET;
if (!statusSecret) {
  console.warn(
    'MIMIC_STATUS_SECRET not set. Falling back to an insecure dev-only secret; status tokens are forgeable.'
  );
}
const SECRET = statusSecret || DEV_ONLY_SECRET;

// Reject any token whose embedded iat is older than this (5 minutes).
const MAX_AGE_MS = 5 * 60 * 1000;

// Embeds an `iat` (epoch ms) into the payload, then signs it. The caller's own
// fields are preserved; `iat` is always (re)stamped to the current time.
export function signStatus(payload: Record<string, unknown>): string {
  const withIat = { ...payload, iat: Date.now() };
  const base64 = Buffer.from(JSON.stringify(withIat)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(base64).digest('hex');
  return `${base64}.${signature}`;
}

// Returns the decoded payload (including `iat`) for a well-formed, correctly
// signed, non-expired token; returns null on any malformed input, signature
// mismatch, or expiry.
export function verifyStatus(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [base64, signature] = parts;
  if (!base64 || !signature) return null;

  // Constant-time signature check. Compare lengths first: timingSafeEqual throws
  // on unequal-length buffers, and Buffer.from(<bad hex>, 'hex') yields a
  // short/empty buffer for attacker-supplied garbage.
  const expectedSig = createHmac('sha256', SECRET).update(base64).digest();
  const providedSig = Buffer.from(signature, 'hex');
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  // Signature verified above, so the payload bytes are trusted to be ours; a
  // parse failure here means genuinely corrupt input rather than tampering.
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(base64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const iat = (parsed as Record<string, unknown>).iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (Date.now() - iat > MAX_AGE_MS) return null;

  return parsed as Record<string, unknown>;
}
