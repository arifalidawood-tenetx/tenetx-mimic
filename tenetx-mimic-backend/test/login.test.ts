import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { app } from '../src/index.js';
import { decodeRelayState } from '../src/relayState.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolvePromise) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolvePromise();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe('GET /saml/login', () => {
  const idpEntityId = 'https://idp.example/entity';
  const idpSsoUrl = 'https://idp.example/sso';
  const idpCert = 'DUMMYCERT';
  const returnUrl = 'https://tenetx-mimic.web.app/mimic/TEN-1/try-it-out';

  it(
    'redirects (302) to the IdP SSO URL carrying SAMLRequest + RelayState on a valid request',
    async () => {
      const query = new URLSearchParams({ idpEntityId, idpSsoUrl, idpCert, returnUrl });

      const res = await fetch(`${baseUrl}/saml/login?${query.toString()}`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);

      const location = res.headers.get('location') || '';
      expect(location.startsWith(`${idpSsoUrl}?`)).toBe(true);

      const redirectUrl = new URL(location);
      expect(redirectUrl.searchParams.get('SAMLRequest')).toBeTruthy();
      // RelayState round-trips to the exact returnUrl (URL() auto-decodes it).
      expect(redirectUrl.searchParams.get('RelayState')).toBe(returnUrl);
    },
    30000
  );

  it(
    'builds a composite RelayState (mimicrs:) decoding to {returnUrl, connectionDocId} when the optional connectionDocId is present',
    async () => {
      const connectionDocId = 'doc123';
      const query = new URLSearchParams({
        idpEntityId,
        idpSsoUrl,
        idpCert,
        returnUrl,
        connectionDocId,
      });

      const res = await fetch(`${baseUrl}/saml/login?${query.toString()}`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);

      const location = res.headers.get('location') || '';
      expect(location.startsWith(`${idpSsoUrl}?`)).toBe(true);

      const redirectUrl = new URL(location);
      expect(redirectUrl.searchParams.get('SAMLRequest')).toBeTruthy();

      const relayState = redirectUrl.searchParams.get('RelayState') || '';
      expect(relayState.startsWith('mimicrs:')).toBe(true);
      expect(decodeRelayState(relayState)).toEqual({ returnUrl, connectionDocId });
    },
    30000
  );

  it('returns 400 JSON when a required query param is missing', async () => {
    // idpCert omitted; the other three present.
    const query = new URLSearchParams({ idpEntityId, idpSsoUrl, returnUrl });

    const res = await fetch(`${baseUrl}/saml/login?${query.toString()}`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    expect(body.error).toContain('idpCert');
  });
});
