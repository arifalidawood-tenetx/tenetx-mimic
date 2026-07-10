import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { app } from '../src/index.js';
import { verifyStatus } from '../src/statusToken.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');
const repoRoot = join(packageRoot, '..', '..');
const logoutHarness = join(packageRoot, '..', 'harness', 'saml_logout_harness.py');
const makeLogoutFixture = join(packageRoot, '..', 'harness', 'make_logout_fixture.py');

function resolveVenvPython(): string | null {
  const venv = join(repoRoot, 'tenetx-source-code-dontpush', '.venv');
  const candidates = [
    process.env.MIMIC_PYTHON,
    join(venv, 'Scripts', 'python.exe'),
    join(venv, 'bin', 'python'),
  ].filter((candidate): candidate is string => !!candidate);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// Both routes shell to python3-saml (initiate builds a real LogoutRequest,
// process validates a real LogoutResponse), and the SLS happy path needs a
// synthetic LogoutResponse from make_logout_fixture.py. Skip cleanly where the
// product venv is absent so the wider suite still passes; the 400-input test
// below stays ungated (pure Node validation, no subprocess).
const venvPython = resolveVenvPython();
const canRunLiveSlo = !!venvPython && existsSync(logoutHarness) && existsSync(makeLogoutFixture);

const IDP_ENTITY_ID = 'https://mimic-saml-test-idp.invalid/realms/tenetx-mimic';
const IDP_SLO_URL = 'https://mimic-saml-test-idp.invalid/realms/tenetx-mimic/protocol/saml';
const IDP_CERT = 'DUMMYCERT';
const SP_HOST = 'mimic-sp.invalid';
const SP_SLS_URL = `https://${SP_HOST}/saml/sls`;
const RELAY_ORIGIN = 'https://tenetx-mimic.web.app';
const RELAY_URL = `${RELAY_ORIGIN}/mimic/TEN-1/try-it-out`;

// The SLS route derives its --sp-sls-url from the forwarded host/proto; sending
// these makes it equal SP_SLS_URL, which the fixture's Destination must match
// for python3-saml's process_slo to accept the LogoutResponse under strict mode.
const FORWARDED = { 'X-Forwarded-Host': SP_HOST, 'X-Forwarded-Proto': 'https' };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolvePromise) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolvePromise();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe('GET /saml/logout', () => {
  it('returns 400 JSON when a required query param is missing', async () => {
    // idpCert omitted; the other three present.
    const query = new URLSearchParams({
      idpSloUrl: IDP_SLO_URL,
      idpEntityId: IDP_ENTITY_ID,
      returnUrl: RELAY_URL,
    });

    const res = await fetch(`${baseUrl}/saml/logout?${query.toString()}`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    expect(body.error).toContain('idpCert');
  });

  it.skipIf(!canRunLiveSlo)(
    'redirects (302) to the IdP SLO URL carrying a SAMLRequest + RelayState on a valid request',
    async () => {
      const query = new URLSearchParams({
        idpSloUrl: IDP_SLO_URL,
        idpEntityId: IDP_ENTITY_ID,
        idpCert: IDP_CERT,
        returnUrl: RELAY_URL,
        nameId: 'qa-saml-tester@mimic-sp.invalid',
      });

      const res = await fetch(`${baseUrl}/saml/logout?${query.toString()}`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);

      const location = res.headers.get('location') || '';
      expect(location.startsWith(`${IDP_SLO_URL}?`)).toBe(true);

      const redirectUrl = new URL(location);
      expect(redirectUrl.searchParams.get('SAMLRequest')).toBeTruthy();
      // RelayState round-trips to the exact returnUrl (URL() auto-decodes it).
      expect(redirectUrl.searchParams.get('RelayState')).toBe(RELAY_URL);
    },
    30000
  );
});

describe.skipIf(!canRunLiveSlo)('GET /saml/sls (real SLO via python3-saml)', () => {
  let logoutResponseB64: string;

  beforeAll(() => {
    // Synthetic unsigned LogoutResponse whose Issuer == IDP_ENTITY_ID and
    // Destination == SP_SLS_URL, so the harness validates it to logged_out.
    const generated = execFileSync(
      venvPython!,
      [makeLogoutFixture, '--idp-entity-id', IDP_ENTITY_ID, '--sp-sls-url', SP_SLS_URL],
      { encoding: 'utf-8' }
    );
    const fixture = JSON.parse(generated.trim().split(/\r?\n/).pop()!) as {
      saml_response: string;
    };
    logoutResponseB64 = fixture.saml_response;
  });

  const getSls = (params: Record<string, string>) =>
    fetch(`${baseUrl}/saml/sls?${new URLSearchParams(params).toString()}`, {
      headers: FORWARDED,
      redirect: 'manual',
    });

  it(
    'happy path: valid LogoutResponse + allowlisted RelayState → 302 with a samlLogoutStatus token = logged_out',
    async () => {
      const res = await getSls({
        SAMLResponse: logoutResponseB64,
        RelayState: RELAY_URL,
        idpEntityId: IDP_ENTITY_ID,
        idpSloUrl: IDP_SLO_URL,
      });

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toBeTruthy();

      const url = new URL(location!);
      expect(url.origin).toBe(RELAY_ORIGIN);
      expect(url.pathname).toBe('/mimic/TEN-1/try-it-out');

      const payload = verifyStatus(url.searchParams.get('samlLogoutStatus')!);
      expect(payload).toBeTruthy();
      expect(payload!.status).toBe('logged_out');
    },
    30000
  );

  it(
    'open-redirect guard: a non-allowlisted RelayState falls through to the plain-HTML branch (no 302)',
    async () => {
      const res = await getSls({
        SAMLResponse: logoutResponseB64,
        RelayState: 'https://evil.example.com/callback',
        idpEntityId: IDP_ENTITY_ID,
        idpSloUrl: IDP_SLO_URL,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      const html = await res.text();
      expect(html).toContain('Logged out');
    },
    30000
  );

  it(
    'malformed SAMLResponse → clean fallback HTML branch, never a raw traceback',
    async () => {
      const res = await getSls({
        SAMLResponse: 'GARBAGE!!!not-valid-base64',
        idpEntityId: IDP_ENTITY_ID,
        idpSloUrl: IDP_SLO_URL,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      const html = await res.text();
      expect(html).toContain('Logout not completed');
      expect(html).not.toContain('Traceback');
    },
    30000
  );
});
