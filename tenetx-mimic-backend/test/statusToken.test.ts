import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'crypto';

// statusToken.ts reads MIMIC_STATUS_SECRET once at module-load time (matching
// index.ts's module-level env pattern), so pin a known secret BEFORE importing
// it and load the module dynamically afterwards. Knowing the secret lets us
// forge a valid-signature / invalid-payload token to exercise the parse and
// iat guards deterministically, and keeps the suite independent of ambient env.
const TEST_SECRET = 'test-secret-for-statusToken-suite';
process.env.MIMIC_STATUS_SECRET = TEST_SECRET;
const { signStatus, verifyStatus } = await import('../src/statusToken');

// Build a token with a correct signature over an arbitrary raw payload string,
// so we can drive verifyStatus past the signature check into its later guards.
function forge(rawPayload: string): string {
  const base64 = Buffer.from(rawPayload).toString('base64url');
  const signature = createHmac('sha256', TEST_SECRET).update(base64).digest('hex');
  return `${base64}.${signature}`;
}

describe('signStatus / verifyStatus round-trip', () => {
  it('round-trips a signed payload back to the original object (plus iat)', () => {
    const token = signStatus({ status: 'validated', email: 'a@b.com' });
    const result = verifyStatus(token);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('validated');
    expect(result!.email).toBe('a@b.com');
    expect(typeof result!.iat).toBe('number');
  });

  it('embeds an iat automatically even when the caller omits it', () => {
    const before = Date.now();
    const token = signStatus({ status: 'logged_out' });
    const after = Date.now();
    const result = verifyStatus(token);
    expect(result).not.toBeNull();
    const iat = result!.iat as number;
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(iat).toBeLessThanOrEqual(after);
  });

  it('produces the documented "<base64url>.<hex>" token shape', () => {
    const token = signStatus({ status: 'validated' });
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
  });
});

describe('verifyStatus rejects invalid tokens', () => {
  it('returns null for a tampered signature (one flipped char)', () => {
    const token = signStatus({ status: 'validated', email: 'a@b.com' });
    const [base64, signature] = token.split('.');
    const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
    expect(verifyStatus(`${base64}.${flipped}`)).toBeNull();
  });

  it('returns null when the payload is tampered (signature no longer matches)', () => {
    const token = signStatus({ status: 'validated' });
    const [base64, signature] = token.split('.');
    expect(verifyStatus(`${base64}X.${signature}`)).toBeNull();
  });

  it('returns null when the "." separator is missing', () => {
    expect(verifyStatus('no-separator-here')).toBeNull();
  });

  it('returns null for malformed base64 / garbage input', () => {
    expect(verifyStatus('$$$.%%%')).toBeNull();
    expect(verifyStatus('....')).toBeNull();
  });

  it('returns null for a validly-signed token whose payload is not JSON', () => {
    expect(verifyStatus(forge('this is definitely not json'))).toBeNull();
  });

  it('returns null for a validly-signed non-object payload', () => {
    expect(verifyStatus(forge(JSON.stringify('just a string')))).toBeNull();
    expect(verifyStatus(forge(JSON.stringify([1, 2, 3])))).toBeNull();
  });

  it('returns null for a validly-signed payload missing a numeric iat', () => {
    expect(verifyStatus(forge(JSON.stringify({ status: 'validated' })))).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(verifyStatus('')).toBeNull();
    expect(verifyStatus(null as unknown as string)).toBeNull();
    expect(verifyStatus(undefined as unknown as string)).toBeNull();
  });
});

describe('verifyStatus expiry (5-minute window)', () => {
  it('accepts a token just within the 5-minute window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
      const token = signStatus({ status: 'validated' });
      vi.setSystemTime(new Date('2020-01-01T00:04:59.000Z')); // +299000ms
      expect(verifyStatus(token)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null for a token older than 5 minutes (300000ms)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
      const token = signStatus({ status: 'validated', email: 'a@b.com' });
      vi.setSystemTime(new Date('2020-01-01T00:05:00.001Z')); // +300001ms
      expect(verifyStatus(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
