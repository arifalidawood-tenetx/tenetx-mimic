import { describe, it, expect } from 'vitest';
import { encodeRelayState, decodeRelayState } from '../src/relayState.js';

const RETURN_URL = 'https://x/y';
const LEGACY_URL = 'https://tenetx-mimic.web.app/mimic/TEN-1/try-it-out';

describe('encodeRelayState', () => {
  it('returns the bare returnUrl verbatim when connectionDocId is absent', () => {
    expect(encodeRelayState({ returnUrl: RETURN_URL })).toBe(RETURN_URL);
  });

  it('returns the bare returnUrl verbatim when connectionDocId is empty', () => {
    expect(encodeRelayState({ returnUrl: RETURN_URL, connectionDocId: '' })).toBe(
      RETURN_URL
    );
  });

  it('emits a "mimicrs:"-prefixed composite when connectionDocId is present', () => {
    const encoded = encodeRelayState({ returnUrl: RETURN_URL, connectionDocId: 'abc123' });
    expect(encoded.startsWith('mimicrs:')).toBe(true);
    expect(encoded).not.toBe(RETURN_URL);
  });
});

describe('decodeRelayState', () => {
  it('round-trips a composite with connectionDocId', () => {
    const encoded = encodeRelayState({ returnUrl: RETURN_URL, connectionDocId: 'abc123' });
    expect(decodeRelayState(encoded)).toEqual({
      returnUrl: RETURN_URL,
      connectionDocId: 'abc123',
    });
  });

  it('round-trips a composite without connectionDocId (connectionDocId undefined)', () => {
    const encoded = encodeRelayState({ returnUrl: RETURN_URL });
    const decoded = decodeRelayState(encoded);
    expect(decoded).toEqual({ returnUrl: RETURN_URL });
    expect(decoded?.connectionDocId).toBeUndefined();
  });

  it('passes a bare legacy RelayState URL through unchanged', () => {
    const decoded = decodeRelayState(LEGACY_URL);
    expect(decoded).toEqual({ returnUrl: LEGACY_URL });
    expect(decoded?.connectionDocId).toBeUndefined();
  });

  it('falls through malformed "mimicrs:" garbage to bare-URL treatment (never throws, never null)', () => {
    const raw = 'mimicrs:garbage-not-base64!!!';
    let decoded: ReturnType<typeof decodeRelayState>;
    expect(() => {
      decoded = decodeRelayState(raw);
    }).not.toThrow();
    expect(decoded!).toEqual({ returnUrl: raw });
  });

  it('falls through a "mimicrs:" composite whose JSON lacks a returnUrl', () => {
    // Valid base64url + valid JSON, but no usable returnUrl → bare-URL fallback.
    const encoded = `mimicrs:${Buffer.from(JSON.stringify({ connectionDocId: 'abc123' })).toString('base64url')}`;
    expect(decodeRelayState(encoded)).toEqual({ returnUrl: encoded });
  });

  it('returns null for empty-string input', () => {
    expect(decodeRelayState('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(decodeRelayState(null as unknown as string)).toBeNull();
    expect(decodeRelayState(undefined as unknown as string)).toBeNull();
    expect(decodeRelayState(123 as unknown as string)).toBeNull();
  });
});
