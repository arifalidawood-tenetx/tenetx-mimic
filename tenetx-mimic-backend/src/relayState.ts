// RelayState codec for the SAML round trip. RelayState is the one value a SAML
// IdP echoes back verbatim to the stateless /saml/acs (login) and /saml/sls
// (logout) callbacks, so it is the only channel that can carry which tester's
// IdP identity this callback belongs to. Two modes:
//   - Bare URL (legacy): the RelayState string IS the returnUrl, unchanged. This
//     is exactly what every existing caller produces and consumes today.
//   - Composite: "mimicrs:" + base64url(JSON.stringify({returnUrl,
//     connectionDocId})), where connectionDocId references the tester's own
//     already-persisted `mimic_idp_connections` Firestore doc so the callback can
//     resolve that tester's verified IdP identity.
//
// The "mimicrs:" prefix is a deliberate unambiguous marker: a bare returnUrl
// (always a real absolute URL) can never start with it, so the two decode paths
// can never collide.
//
// This codec mirrors statusToken.ts's base64url + JSON style but is
// INTENTIONALLY UNSIGNED — no HMAC (see decisions.md #4). Rationale:
//   * connectionDocId is only a REFERENCE to an already-existing Firestore doc,
//     not a capability grant — resolving it just reads a doc a legitimate
//     verify-realm flow already had to create.
//   * returnUrl's origin is independently re-checked by the unchanged
//     isAllowedRelayState (index.ts) on every consumer, so a tampered returnUrl
//     still cannot redirect anywhere off the CORS allowlist.
//   * An attacker who rewrites connectionDocId to point at a DIFFERENT connection
//     still needs a validly-signed SAMLResponse matching THAT connection's real
//     IdP cert to gain anything — no worse than the pre-existing /saml/login
//     contract, which already accepts arbitrary caller-supplied
//     idpEntityId/idpSsoUrl/idpCert query params with zero ownership check.
// Signing would add cost and a shared-secret dependency without closing any real
// gap, so it is deliberately omitted here (unlike statusToken.ts, whose verdict
// payload genuinely must be unforgeable).

// Unambiguous composite marker. A bare returnUrl can never begin with this.
const COMPOSITE_PREFIX = 'mimicrs:';

// Build a RelayState string. With no connectionDocId, returns returnUrl verbatim
// (byte-identical to today's behavior). With one, returns the "mimicrs:"-prefixed
// composite carrying both fields. See the module header for why this is unsigned.
export function encodeRelayState(payload: {
  returnUrl: string;
  connectionDocId?: string;
}): string {
  const { returnUrl, connectionDocId } = payload;
  if (!connectionDocId) {
    // Legacy path: no doc-ID reference, emit the bare returnUrl unchanged.
    return returnUrl;
  }
  const json = JSON.stringify({ returnUrl, connectionDocId });
  return `${COMPOSITE_PREFIX}${Buffer.from(json).toString('base64url')}`;
}

// Parse a RelayState string. Returns null only for empty/non-string input.
// A "mimicrs:"-prefixed value is decoded as a composite; on ANY failure in that
// branch (bad base64, bad JSON, missing/wrong-typed returnUrl) it falls THROUGH
// to bare-URL treatment rather than returning null, so a malformed prefixed value
// degrades to a plain returnUrl instead of dropping the redirect entirely. Any
// value without the prefix is treated as a bare legacy returnUrl. See the module
// header for why this is unsigned. NOTE: consumers must null-check the result
// before dereferencing (some callbacks send no RelayState at all).
export function decodeRelayState(
  raw: string
): { returnUrl: string; connectionDocId?: string } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  if (raw.startsWith(COMPOSITE_PREFIX)) {
    try {
      const json = Buffer.from(
        raw.slice(COMPOSITE_PREFIX.length),
        'base64url'
      ).toString('utf8');
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const returnUrl = obj.returnUrl;
        if (typeof returnUrl === 'string' && returnUrl.length > 0) {
          const connectionDocId = obj.connectionDocId;
          return typeof connectionDocId === 'string' && connectionDocId.length > 0
            ? { returnUrl, connectionDocId }
            : { returnUrl };
        }
      }
    } catch {
      // Malformed composite — fall through to bare-URL treatment below.
    }
  }

  // Bare legacy returnUrl (or fall-through from a failed composite decode).
  return { returnUrl: raw };
}
