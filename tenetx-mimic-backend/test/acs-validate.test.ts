import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { app } from '../src/index.js';
import { verifyStatus } from '../src/statusToken.js';
import { encodeRelayState } from '../src/relayState.js';
import { getMimicIdpConnection } from '../src/mimicConnections.js';

vi.mock('../src/mimicConnections.js', () => ({
  getMimicIdpConnection: vi.fn(),
}));

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');
const repoRoot = join(packageRoot, '..', '..');
const harness = join(packageRoot, '..', 'harness', 'keycloak_saml_harness.py');
const signFixture = join(packageRoot, '..', 'harness', 'sign_fixture.py');

function resolveVenvPython(): string | null {
  const venv = join(repoRoot, 'tenetx-source-code-dontpush', '.venv');
  const candidates = [
    process.env.MIMIC_PYTHON,
    join(venv, 'Scripts', 'python.exe'),
    join(venv, 'bin', 'python'),
  ].filter((candidate): candidate is string => !!candidate);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// The live-validation suite needs the product venv (python3-saml) to both SIGN
// the fixture and run the real SAMLProvider. Skip cleanly where it is absent so
// the wider suite still passes; the run that proves TEN-141 uses the venv.
const venvPython = resolveVenvPython();
const canRunLiveValidation = !!venvPython && existsSync(harness) && existsSync(signFixture);

interface FixtureMeta {
  signed_xml: string;
  unsigned_xml: string;
  cert_pem: string;
  idp_entity_id: string;
  idp_sso_url: string;
  email: string;
}

const SP_HOST = 'mimic-sp.invalid';

describe.skipIf(!canRunLiveValidation)(
  'POST /saml/acs live validation via the real SAMLProvider',
  () => {
    let server: Server;
    let baseUrl: string;
    let tmpDir: string;
    let meta: FixtureMeta;
    let signedB64: string;
    let unsignedB64: string;

    beforeAll(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saml-acs-'));
      const generated = execFileSync(
        venvPython!,
        [signFixture, '--out', tmpDir, '--sp-base', `https://${SP_HOST}`],
        { encoding: 'utf-8' }
      );
      meta = JSON.parse(generated.trim().split(/\r?\n/).pop()!) as FixtureMeta;

      // Own temp capture dir: acs.test.ts runs in parallel and cleans + counts
      // the shared .captured/, which would otherwise delete this file's in-flight
      // capture and pollute that file's count.
      process.env.MIMIC_CAPTURED_DIR = join(tmpDir, 'captured');
      process.env.MIMIC_PYTHON = venvPython!;
      process.env.MIMIC_IDP_ENTITY_ID = meta.idp_entity_id;
      process.env.MIMIC_IDP_SSO_URL = meta.idp_sso_url;
      process.env.MIMIC_IDP_CERT_FILE = meta.cert_pem;

      signedB64 = readFileSync(meta.signed_xml).toString('base64');
      unsignedB64 = readFileSync(meta.unsigned_xml).toString('base64');

      await new Promise<void>((resolvePromise) => {
        server = app.listen(0, () => {
          baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolvePromise();
        });
      });
    });

    afterAll(() => {
      server?.close();
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.MIMIC_CAPTURED_DIR;
      delete process.env.MIMIC_PYTHON;
      delete process.env.MIMIC_IDP_ENTITY_ID;
      delete process.env.MIMIC_IDP_SSO_URL;
      delete process.env.MIMIC_IDP_CERT_FILE;
    });

    const postAcs = (
      samlResponse: string,
      headers: Record<string, string>,
      relayState?: string
    ) =>
      fetch(`${baseUrl}/saml/acs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(
          relayState !== undefined
            ? { SAMLResponse: samlResponse, RelayState: relayState }
            : { SAMLResponse: samlResponse }
        ).toString(),
        redirect: 'manual',
      });

    it('happy path: valid signed response + matching forwarded-host succeeds with the extracted email', async () => {
      const res = await postAcs(signedB64, {
        'X-Forwarded-Host': SP_HOST,
        'X-Forwarded-Proto': 'https',
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Login succeeded');
      expect(html).toContain(meta.email);
    });

    it('failure 1: a divergent X-Forwarded-Host is rejected with the specific host/Destination mismatch reason (Defect A + B)', async () => {
      const res = await postAcs(signedB64, {
        'X-Forwarded-Host': 'evil-divergent.invalid',
        'X-Forwarded-Proto': 'https',
      });
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain('Login rejected');
      expect(html.toLowerCase()).toContain('instead of');
      expect(html).toContain('evil-divergent.invalid');
      expect(html).not.toContain('saml_validation_failed');
    });

    it('failure 2: an unsigned response is rejected with the specific "not signed" reason (Defect B)', async () => {
      const res = await postAcs(unsignedB64, {
        'X-Forwarded-Host': SP_HOST,
        'X-Forwarded-Proto': 'https',
      });
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain('Login rejected');
      expect(html.toLowerCase()).toContain('not signed');
    });

    const RELAY_ORIGIN = 'https://tenetx-mimic.web.app';
    const RELAY_URL = `${RELAY_ORIGIN}/mimic/TEN-1/try-it-out`;

    it('RelayState redirect (validated): 302 to the SPA with a signed samlStatus token carrying status=validated + email', async () => {
      const res = await postAcs(
        signedB64,
        { 'X-Forwarded-Host': SP_HOST, 'X-Forwarded-Proto': 'https' },
        RELAY_URL
      );
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toBeTruthy();
      const url = new URL(location!);
      expect(url.origin).toBe(RELAY_ORIGIN);
      expect(url.pathname).toBe('/mimic/TEN-1/try-it-out');
      const payload = verifyStatus(url.searchParams.get('samlStatus')!);
      expect(payload).toBeTruthy();
      expect(payload!.status).toBe('validated');
      expect(payload!.email).toBe(meta.email);
      expect(payload!.reason).toBeNull();
    });

    it('RelayState redirect (rejected): 302 with a signed samlStatus token carrying status=rejected + the "not signed" reason', async () => {
      const res = await postAcs(
        unsignedB64,
        { 'X-Forwarded-Host': SP_HOST, 'X-Forwarded-Proto': 'https' },
        RELAY_URL
      );
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(url.origin).toBe(RELAY_ORIGIN);
      const payload = verifyStatus(url.searchParams.get('samlStatus')!);
      expect(payload).toBeTruthy();
      expect(payload!.status).toBe('rejected');
      expect(String(payload!.reason).toLowerCase()).toContain('not signed');
    });

    it('RelayState with a disallowed origin is NOT redirected to (open-redirect guard): falls through to the raw-HTML branch', async () => {
      const res = await postAcs(
        signedB64,
        { 'X-Forwarded-Host': SP_HOST, 'X-Forwarded-Proto': 'https' },
        'https://evil.example.com/callback'
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      const html = await res.text();
      expect(html).toContain('Login succeeded');
    });

    it('Firestore override: a composite RelayState connectionDocId resolving to a real connection validates via that inline --idp-cert identity (env-var block skipped)', async () => {
      vi.mocked(getMimicIdpConnection).mockReset();
      vi.mocked(getMimicIdpConnection).mockResolvedValueOnce({
        entity_id: meta.idp_entity_id,
        sso_url: meta.idp_sso_url,
        slo_url: '',
        certificate: readFileSync(meta.cert_pem, 'utf-8'),
      });
      const relayState = encodeRelayState({
        returnUrl: RELAY_URL,
        connectionDocId: 'conn-override-doc',
      });
      const res = await postAcs(
        signedB64,
        { 'X-Forwarded-Host': SP_HOST, 'X-Forwarded-Proto': 'https' },
        relayState
      );
      expect(getMimicIdpConnection).toHaveBeenCalledWith('conn-override-doc', expect.anything());
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(url.origin).toBe(RELAY_ORIGIN);
      const payload = verifyStatus(url.searchParams.get('samlStatus')!);
      expect(payload).toBeTruthy();
      expect(payload!.status).toBe('validated');
      expect(payload!.email).toBe(meta.email);
    });

    it('Firestore miss: a composite RelayState connectionDocId resolving to null falls back to the MIMIC_IDP_* env-var identity', async () => {
      vi.mocked(getMimicIdpConnection).mockReset();
      vi.mocked(getMimicIdpConnection).mockResolvedValueOnce(null);
      const relayState = encodeRelayState({
        returnUrl: RELAY_URL,
        connectionDocId: 'conn-missing-doc',
      });
      const res = await postAcs(
        signedB64,
        { 'X-Forwarded-Host': SP_HOST, 'X-Forwarded-Proto': 'https' },
        relayState
      );
      expect(getMimicIdpConnection).toHaveBeenCalledWith('conn-missing-doc', expect.anything());
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(url.origin).toBe(RELAY_ORIGIN);
      const payload = verifyStatus(url.searchParams.get('samlStatus')!);
      expect(payload).toBeTruthy();
      expect(payload!.status).toBe('validated');
      expect(payload!.email).toBe(meta.email);
    });
  }
);
