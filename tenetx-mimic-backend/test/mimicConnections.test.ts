import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// The module memoizes a SINGLE Firestore client across calls (built on the
// FIRST call only), so per-case constructor mocks would silently no-op from the
// second test onward. Instead, mock at the `.doc(...).get()` method level: a
// single hoisted `mockGet` is returned by the whole chain, and each test drives
// it with `mockResolvedValueOnce` / `mockRejectedValueOnce`.
//
// `vi.hoisted` is required because `vi.mock` factories are hoisted above the
// imports; a plain top-level `const mockGet` would not yet be initialized when
// the factory runs.
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('@google-cloud/firestore', () => ({
  Firestore: vi.fn(() => ({
    collection: () => ({
      doc: () => ({
        get: mockGet,
      }),
    }),
  })),
}));

vi.mock('google-auth-library', () => ({
  UserRefreshClient: vi.fn(() => ({})),
}));

import { getMimicIdpConnection } from '../src/mimicConnections.js';

const ORIGINAL_TOKEN = process.env.FIREBASE_REFRESH_TOKEN;

describe('getMimicIdpConnection', () => {
  beforeEach(() => {
    mockGet.mockReset();
    process.env.FIREBASE_REFRESH_TOKEN = 'fake-refresh-token';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.FIREBASE_REFRESH_TOKEN;
    else process.env.FIREBASE_REFRESH_TOKEN = ORIGINAL_TOKEN;
  });

  it('returns all four fields verbatim on a found doc (happy path)', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        entity_id: 'https://idp.example/entity',
        sso_url: 'https://idp.example/sso',
        slo_url: 'https://idp.example/slo',
        certificate: '-----BEGIN CERTIFICATE-----\nABC123\n-----END CERTIFICATE-----',
      }),
    });

    const result = await getMimicIdpConnection('doc123');

    expect(result).toEqual({
      entity_id: 'https://idp.example/entity',
      sso_url: 'https://idp.example/sso',
      slo_url: 'https://idp.example/slo',
      certificate: '-----BEGIN CERTIFICATE-----\nABC123\n-----END CERTIFICATE-----',
    });
  });

  it('returns null when the doc does not exist (exists: false)', async () => {
    mockGet.mockResolvedValueOnce({ exists: false, data: () => undefined });

    const result = await getMimicIdpConnection('missing-doc');

    expect(result).toBeNull();
  });

  it('returns null (never an unhandled rejection) when Firestore throws', async () => {
    mockGet.mockRejectedValueOnce(new Error('Firestore unavailable'));

    await expect(getMimicIdpConnection('boom')).resolves.toBeNull();
  });

  it('returns null when the doc is missing entity_id', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        sso_url: 'https://idp.example/sso',
        slo_url: 'https://idp.example/slo',
        certificate: 'SOME-CERT',
      }),
    });

    const result = await getMimicIdpConnection('no-entity-id');

    expect(result).toBeNull();
  });

  it('coerces missing / wrong-typed sso_url, slo_url, certificate to empty strings', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        entity_id: 'https://idp.example/entity',
        // sso_url absent
        slo_url: 12345, // wrong type
        // certificate absent
      }),
    });

    const result = await getMimicIdpConnection('partial-doc');

    expect(result).toEqual({
      entity_id: 'https://idp.example/entity',
      sso_url: '',
      slo_url: '',
      certificate: '',
    });
  });

  it('returns null without throwing when FIREBASE_REFRESH_TOKEN is unset', async () => {
    delete process.env.FIREBASE_REFRESH_TOKEN;

    await expect(getMimicIdpConnection('any-doc')).resolves.toBeNull();
    // Must short-circuit before ever touching Firestore.
    expect(mockGet).not.toHaveBeenCalled();
  });
});
