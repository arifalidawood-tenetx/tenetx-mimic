import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { initializeApp, refreshToken } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { parseSamlMetadata, isAllowedMetadataHost } from './samlMetadata.js';
import { signStatus } from './statusToken.js';
import { encodeRelayState, decodeRelayState } from './relayState.js';
import { getMimicIdpConnection, MimicIdpConnection } from './mimicConnections.js';
import { logger, createHttpLogger } from './logger.js';

// Exported for tests (mounted on an ephemeral port); the app.listen() at the
// bottom is guarded to run only when this module is executed directly.
export const app = express();
const port = Number(process.env.PORT) || 3000;

// Anchors the .captured/ dir to the package root. src/ (tsx/vitest) and dist/
// (compiled) both sit one level below it, so '..' is correct in either case.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Mounted first so it wraps every request (incl. malformed-body/CORS-rejected).
app.use(createHttpLogger());

// Parse JSON bodies
app.use(express.json());

// Keycloak POSTs the SAMLResponse to /saml/acs as urlencoded form data, not JSON.
app.use(express.urlencoded({ extended: true }));

// CORS middleware - allowlist only the deployed mimic Hosting origin
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://tenetx-mimic.web.app';
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);

// Initialize Firebase Admin SDK with a refresh-token ("authorized_user")
// credential, NOT a service-account key.
//
// WHY: creating service-account keys on this GCP project is blocked by the org
// policy `constraints/iam.disableServiceAccountKeyCreation` (confirmed via a
// direct API test), so FIREBASE_SERVICE_ACCOUNT_JSON can never be populated
// here. Instead we reuse the same `firebase login:ci` refresh token used for
// this project's Firebase CLI deploys (Coolify env FIREBASE_REFRESH_TOKEN),
// whose owner is Owner on tenetx-qa-scores. getAuth().verifyIdToken works with
// this credential (unlike firebase-admin's Firestore wrapper) — confirmed
// against a real live ID token. Mirrors tenetx-mimic/scripts/seed-ten135-admin.ts.
//
// The client_id/client_secret below are firebase-tools' OWN PUBLIC OAuth client
// credentials, embedded verbatim in the open-source firebase-tools `lib/api.js`
// — documented-in-source PUBLIC values, NOT secrets.
const FIREBASE_TOOLS_CLIENT_ID =
  '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_TOOLS_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const firebaseRefreshToken = process.env.FIREBASE_REFRESH_TOKEN;
if (!firebaseRefreshToken) {
  console.warn(
    'FIREBASE_REFRESH_TOKEN not set. Auth middleware will reject all requests.'
  );
} else {
  try {
    initializeApp({
      credential: refreshToken({
        type: 'authorized_user',
        client_id: FIREBASE_TOOLS_CLIENT_ID,
        client_secret: FIREBASE_TOOLS_CLIENT_SECRET,
        refresh_token: firebaseRefreshToken,
      }),
      // Required: verifyIdToken() needs to know which project's tokens to
      // accept. A refresh-token credential (unlike a cert credential) has no
      // project baked in, so this must be set explicitly.
      projectId: 'tenetx-qa-scores',
    });
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error);
    process.exit(1);
  }
}

// Auth middleware: extract and verify Firebase ID token
interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    email_verified?: boolean;
  };
}

const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const idToken = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);

    // Check email domain and verification status
    const email = decodedToken.email || '';
    const emailVerified = decodedToken.email_verified || false;

    if (!email.endsWith('@tenetx.ai') || !emailVerified) {
      res.status(401).json({
        error: 'Unauthorized: email must be @tenetx.ai and verified',
      });
      return;
    }

    req.user = {
      uid: decodedToken.uid,
      email,
      email_verified: emailVerified,
    };

    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Health check route (no auth required)
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// POST /verify-metadata: fetch + parse real IdP SAML metadata server-side
// (browsers can't do this themselves, no CORS on IdP metadata endpoints).
app.post(
  '/verify-metadata',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    const { metadataUrl } = req.body ?? {};
    if (typeof metadataUrl !== 'string' || !metadataUrl) {
      res.status(400).json({ error: 'metadataUrl is required' });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(metadataUrl);
    } catch {
      res.status(400).json({ error: 'metadataUrl is not a valid URL' });
      return;
    }

    // Host allowlist checked before any fetch happens (SSRF guard).
    if (!isAllowedMetadataHost(parsedUrl.hostname)) {
      res.status(403).json({ error: `host not allowlisted: ${parsedUrl.hostname}` });
      return;
    }

    let xml: string;
    try {
      const response = await fetch(parsedUrl.toString());
      if (!response.ok) {
        res.status(502).json({ error: `metadata fetch failed: ${response.status}` });
        return;
      }
      xml = await response.text();
    } catch (error) {
      console.error('Metadata fetch failed:', error);
      res.status(502).json({ error: 'failed to fetch metadata' });
      return;
    }

    const result = parseSamlMetadata(xml);
    if (!result) {
      res.status(422).json({ error: 'failed to parse SAML metadata' });
      return;
    }

    res.status(200).json(result);
  }
);

// The real python3-saml validation lives in the UNMODIFIED SAMLProvider under
// tenetx-source-code-dontpush/. We never reimplement it here: we shell out to
// tenetx-mimic/harness/keycloak_saml_harness.py --json, which read-only-imports
// that SAMLProvider. Node only (Defect A) chooses the request host and (Defect B)
// surfaces the specific reason the harness returns.
const harnessPath = join(packageRoot, '..', 'harness', 'keycloak_saml_harness.py');

const loginHarnessPath = join(packageRoot, '..', 'harness', 'saml_login_request_harness.py');

const logoutHarnessPath = join(packageRoot, '..', 'harness', 'saml_logout_harness.py');

function resolvePythonExecutable(): string {
  const productVenv = join(packageRoot, '..', '..', 'tenetx-source-code-dontpush', '.venv');
  const candidates = [
    process.env.MIMIC_PYTHON,
    join(productVenv, 'Scripts', 'python.exe'),
    join(productVenv, 'bin', 'python'),
  ].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' ? single.split(',')[0].trim() : '';
}

// Defect A: prefer X-Forwarded-Host, fall back to the raw Host header — the same
// precedence the fixed real product uses (middleware._get_request_host), so the
// SP ACS/Entity-ID the SAMLProvider validates against tracks the public host a
// reverse proxy forwards rather than an internal Host it rewrites.
function deriveRequestHost(req: Request): string {
  return firstHeaderValue(req.headers['x-forwarded-host']) || firstHeaderValue(req.headers['host']);
}

function deriveRequestScheme(req: Request): 'http' | 'https' {
  return firstHeaderValue(req.headers['x-forwarded-proto']).toLowerCase() === 'https'
    ? 'https'
    : 'http';
}

interface SamlVerdict {
  result: 'validated' | 'rejected' | 'config_error' | 'inconclusive';
  email?: string | null;
  name_id?: string | null;
  reason?: string;
  message?: string;
}

interface SamlLoginResult {
  result: 'redirect' | 'config_error';
  url?: string;
  message?: string;
}

// saml_logout_harness.py verdicts: `initiate` yields redirect|config_error;
// `process` yields logged_out|error|config_error.
interface SamlLogoutResult {
  result: 'redirect' | 'logged_out' | 'error' | 'config_error';
  url?: string;
  message?: string;
  slo_response_url?: string;
}

// Generic last-parseable-JSON-line scanner. Defaults to SamlVerdict so the
// existing /saml/acs caller below is unchanged; /saml/login passes
// <SamlLoginResult>. Both harnesses interleave "[...]"/"[SAML ERROR]" diagnostic
// lines with the JSON verdict, so scanning up for the last line that parses is
// what makes this reusable across both.
function parseLastJsonLine<T = SamlVerdict>(stdout: string): T | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // The real SAMLProvider prints a "[SAML ERROR] ..." line to stdout (saml.py:243),
  // so the JSON verdict is not always the whole of stdout — scan up for the last
  // line that actually parses.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as T;
    } catch {
      continue;
    }
  }
  return null;
}

// Validate a captured SAMLResponse against a real or overridden IdP identity.
// When overrideIdp is provided (resolved from Firestore via RelayState's
// connectionDocId in /saml/acs), uses its entity_id/sso_url/certificate instead
// of the MIMIC_IDP_* env vars, enabling per-tester identity resolution (todos 1-4).
function validateCapturedResponse(
  fixturePath: string,
  host: string,
  scheme: 'http' | 'https',
  overrideIdp?: MimicIdpConnection | null
): Promise<SamlVerdict> {
  const args = [harnessPath, '--fixture', fixturePath, '--json', '--request-scheme', scheme];
  if (host) args.push('--request-host', host);
  // Per-tester override (todo 4): a resolved Firestore connection is already a
  // full PEM, so it rides as inline --idp-cert (NOT --idp-cert-file). No override
  // → today's MIMIC_IDP_* env-var identity, unchanged.
  if (overrideIdp) {
    args.push('--idp-entity-id', overrideIdp.entity_id);
    if (overrideIdp.sso_url) args.push('--idp-sso-url', overrideIdp.sso_url);
    if (overrideIdp.certificate) args.push('--idp-cert', overrideIdp.certificate);
  } else {
    if (process.env.MIMIC_IDP_ENTITY_ID) args.push('--idp-entity-id', process.env.MIMIC_IDP_ENTITY_ID);
    if (process.env.MIMIC_IDP_SSO_URL) args.push('--idp-sso-url', process.env.MIMIC_IDP_SSO_URL);
    if (process.env.MIMIC_IDP_CERT_FILE) args.push('--idp-cert-file', process.env.MIMIC_IDP_CERT_FILE);
  }

  return new Promise<SamlVerdict>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (verdict: SamlVerdict) => {
      if (!settled) {
        settled = true;
        resolvePromise(verdict);
      }
    };
    const child = spawn(resolvePythonExecutable(), args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      settle({ result: 'inconclusive', message: 'validation timed out' });
    }, 20000);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      settle({ result: 'inconclusive', message: `could not run validator: ${error.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const verdict = parseLastJsonLine(stdout);
      settle(
        verdict ?? {
          result: 'inconclusive',
          message: (stderr.trim().split(/\r?\n/).pop() || 'no verdict from validator').slice(0, 500),
        }
      );
    });
  });
}

// Shell out to the SP-initiated login harness (todo 4), mirroring
// validateCapturedResponse's subprocess shape: 20s timeout + child.kill(),
// stdout/stderr accumulation, and a last-JSON-line scan of stdout. It ALWAYS
// resolves to a SamlLoginResult — a timeout, spawn error, unparseable output,
// or nonzero exit all collapse into one clean config_error so the /saml/login
// route can never hang or throw an unhandled exception.
function requestSamlLogin(
  spBaseUrl: string,
  returnUrl: string,
  idpEntityId: string,
  idpSsoUrl: string,
  idpCert: string
): Promise<SamlLoginResult> {
  const args = [
    loginHarnessPath,
    '--sp-base-url', spBaseUrl,
    '--return-url', returnUrl,
    '--idp-entity-id', idpEntityId,
    '--idp-sso-url', idpSsoUrl,
    '--idp-cert', idpCert,
    '--json',
  ];

  return new Promise<SamlLoginResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: SamlLoginResult) => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };
    const child = spawn(resolvePythonExecutable(), args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      settle({ result: 'config_error', message: 'login request timed out' });
    }, 20000);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      settle({ result: 'config_error', message: `could not run login harness: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseLastJsonLine<SamlLoginResult>(stdout);
      if (parsed?.result === 'redirect' && parsed.url) {
        settle(parsed);
        return;
      }
      // config_error verdict, nonzero exit, or no parseable JSON — surface the
      // harness's own message (or the last stderr line) as a single config_error.
      const message =
        parsed?.message ||
        stderr.trim().split(/\r?\n/).pop() ||
        `login harness exited with code ${code ?? 'unknown'}`;
      settle({ result: 'config_error', message: message.slice(0, 500) });
    });
  });
}

// initiate: build the SP-initiated LogoutRequest redirect to the IdP SLO
// endpoint. Mirrors requestSamlLogin's subprocess contract exactly (20s
// timeout, settled guard, last-JSON-line scan) so a timeout/spawn-error/
// unparseable/nonzero exit all collapse to one config_error the route turns
// into a 502 — the route can never hang or throw.
function requestSamlLogout(
  spBaseUrl: string,
  spSlsUrl: string,
  returnUrl: string,
  idpEntityId: string,
  idpSloUrl: string,
  idpCert: string,
  nameId: string
): Promise<SamlLogoutResult> {
  const args = [
    logoutHarnessPath,
    'initiate',
    '--idp-slo-url', idpSloUrl,
    '--idp-entity-id', idpEntityId,
    '--idp-cert', idpCert,
    '--sp-base-url', spBaseUrl,
    '--sp-sls-url', spSlsUrl,
    '--return-url', returnUrl,
    '--json',
  ];
  if (nameId) args.push('--name-id', nameId);

  return new Promise<SamlLogoutResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: SamlLogoutResult) => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };
    const child = spawn(resolvePythonExecutable(), args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      settle({ result: 'config_error', message: 'logout request timed out' });
    }, 20000);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      settle({ result: 'config_error', message: `could not run logout harness: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseLastJsonLine<SamlLogoutResult>(stdout);
      if (parsed?.result === 'redirect' && parsed.url) {
        settle(parsed);
        return;
      }
      const message =
        parsed?.message ||
        stderr.trim().split(/\r?\n/).pop() ||
        `logout harness exited with code ${code ?? 'unknown'}`;
      settle({ result: 'config_error', message: message.slice(0, 500) });
    });
  });
}

// process: validate the IdP's LogoutResponse (or a LogoutRequest for the
// IdP-initiated case). Same subprocess shape as requestSamlLogout, but here
// logged_out | error | config_error are ALL definitive harness verdicts the
// route branches on, so only a timeout/spawn-failure/unparseable output
// collapses to a synthetic error.
function processSamlLogout(
  spSlsUrl: string,
  idpEntityId: string,
  idpSloUrl: string,
  idpCert: string,
  samlResponse: string,
  samlRequest: string,
  relayState: string
): Promise<SamlLogoutResult> {
  const args = [logoutHarnessPath, 'process', '--sp-sls-url', spSlsUrl, '--json'];
  if (idpEntityId) args.push('--idp-entity-id', idpEntityId);
  if (idpSloUrl) args.push('--idp-slo-url', idpSloUrl);
  if (idpCert) args.push('--idp-cert', idpCert);
  if (samlResponse) args.push('--saml-response', samlResponse);
  if (samlRequest) args.push('--saml-request', samlRequest);
  if (relayState) args.push('--relay-state', relayState);

  return new Promise<SamlLogoutResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: SamlLogoutResult) => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };
    const child = spawn(resolvePythonExecutable(), args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      settle({ result: 'error', message: 'logout processing timed out' });
    }, 20000);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      settle({ result: 'error', message: `could not run logout harness: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseLastJsonLine<SamlLogoutResult>(stdout);
      if (parsed?.result) {
        settle(parsed);
        return;
      }
      const message =
        stderr.trim().split(/\r?\n/).pop() ||
        `logout harness exited with code ${code ?? 'unknown'}`;
      settle({ result: 'error', message: message.slice(0, 500) });
    });
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Open-redirect guard shared by /saml/acs (todo 7) and /saml/sls (todo 8): a
// RelayState is only a safe 302 target when it parses AND its origin matches the
// CORS allowlist. Returns the parsed URL when allowed, null (parse failure or
// foreign origin) when the caller must fall through to its raw-HTML branch
// instead of redirecting to an untrusted origin. SECURITY — do not weaken.
function isAllowedRelayState(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.origin === allowedOrigin ? parsed : null;
}

// Resolve the listen host from process.env.HOST or default to 0.0.0.0.
// Exported for testing; can be imported directly without starting the server.
export function resolveListenHost(): string {
  return process.env.HOST || '0.0.0.0';
}

// POST /saml/acs: UNAUTHENTICATED SAML ACS endpoint. During a real SAML login
// Keycloak POSTs a signed SAMLResponse here and cannot send a Firebase ID token,
// so this route intentionally has NO authMiddleware. It (1) still persists the
// raw base64 response to .captured/ exactly as before, then (2) LIVE-VALIDATES it
// through the real SAMLProvider (via the harness), mirroring TEN-141's fixes.
// (Todos 7/8 of the prior tenetx-mimic-tryout-custom-realm plan.)
//
// Per-tester identity resolution (mimic-saml-per-tester-idp-identity todos 1-4):
// RelayState is decoded to extract an optional connectionDocId. When present, the
// tester's own IdP identity (entity_id, sso_url, certificate) is resolved from
// the Firestore mimic_idp_connections doc; when absent or lookup fails, the route
// falls back to the MIMIC_IDP_* env-var identity (today's behavior, unchanged).
// The decoded returnUrl is then used for the redirect-back-into-SPA 302, with the
// same open-redirect guard (isAllowedRelayState) applied to the decoded returnUrl
// as before — the guard now operates on a decoded field rather than raw RelayState,
// but the origin allowlist check remains identical.
app.post('/saml/acs', async (req: Request, res: Response) => {
  const samlResponse = req.body?.SAMLResponse;
  if (typeof samlResponse !== 'string' || !samlResponse) {
    res.status(400).json({ error: 'SAMLResponse is required' });
    return;
  }

  const capturedAt = new Date().toISOString();
  // Capture dir is configurable (MIMIC_CAPTURED_DIR) so parallel test files each
  // own an isolated dir instead of contending on one shared .captured/; defaults
  // to the package-root .captured/ for real runs.
  const capturedDir = process.env.MIMIC_CAPTURED_DIR || join(packageRoot, '.captured');
  const filePath = join(
    capturedDir,
    `saml-response-${capturedAt.replace(/[:.]/g, '-')}.txt`
  );

  try {
    mkdirSync(capturedDir, { recursive: true });
    writeFileSync(filePath, `# captured ${capturedAt} (UTC)\n${samlResponse}\n`, 'utf-8');
  } catch (error) {
    console.error('Failed to persist captured SAMLResponse:', error);
    res.status(500).json({ error: 'failed to persist SAMLResponse' });
    return;
  }

  // Decode + print the XML so a human can watch the capture live during the
  // manual login. Buffer is built-in; the /></g split puts one element per line
  // for readability. Best-effort — a decode failure must not fail a capture that
  // already succeeded on disk above.
  try {
    const xml = Buffer.from(samlResponse, 'base64').toString('utf-8');
    console.log(`\n=== SAMLResponse captured -> ${filePath} ===`);
    console.log(xml.replace(/></g, '>\n<'));
    console.log('=== end SAMLResponse ===\n');
  } catch (error) {
    console.warn('Could not base64-decode SAMLResponse for console preview:', error);
  }

  const capturedNote = '<p>SAMLResponse captured to <code>.captured/</code></p>';
  try {
    const host = deriveRequestHost(req);
    const scheme = deriveRequestScheme(req);

    const rawRelayState = req.body?.RelayState;
    const decoded =
      typeof rawRelayState === 'string' && rawRelayState
        ? decodeRelayState(rawRelayState)
        : null;

    // A connectionDocId resolves this tester's own IdP identity from Firestore;
    // null (doc missing / lookup failed) falls back to the MIMIC_IDP_* env vars.
    const overrideIdp = decoded?.connectionDocId
      ? await getMimicIdpConnection(decoded.connectionDocId)
      : null;

    const verdict = await validateCapturedResponse(filePath, host, scheme, overrideIdp);

    // OPEN-REDIRECT GUARD: 302 to the SPA only when RelayState decoded non-null
    // AND its returnUrl origin is on the CORS allowlist. The `decoded &&` is
    // load-bearing — no-RelayState callbacks decode to null and MUST fall through
    // to the raw-HTML responses below (not throw on decoded.returnUrl).
    if (decoded && isAllowedRelayState(decoded.returnUrl)) {
      const token = signStatus({
        status: verdict.result,
        email: verdict.email ?? null,
        reason: verdict.reason ?? null,
      });
      res.redirect(302, `${decoded.returnUrl}?samlStatus=${token}`);
      return;
    }

    if (verdict.result === 'validated') {
      const who = escapeHtml(verdict.email || verdict.name_id || '(no email in assertion)');
      res
        .status(200)
        .type('html')
        .send(
          '<!doctype html><html><body><h1>Login succeeded</h1>' +
            `<p>Validated by the real SAMLProvider. Signed-in user: <strong>${who}</strong></p>` +
            capturedNote +
            '</body></html>'
        );
      return;
    }

    if (verdict.result === 'rejected') {
      res
        .status(401)
        .type('html')
        .send(
          '<!doctype html><html><body><h1>Login rejected</h1>' +
            '<p>The real SAMLProvider rejected this response. Specific reason:</p>' +
            `<pre>${escapeHtml(verdict.reason || '(no reason reported)')}</pre>` +
            capturedNote +
            '</body></html>'
        );
      return;
    }

    res
      .status(200)
      .type('html')
      .send(
        '<!doctype html><html><body><h1>SAMLResponse captured</h1>' +
          `<p>Live validation did not reach a verdict: ${escapeHtml(verdict.message || verdict.reason || 'unknown')}</p>` +
          capturedNote +
          '</body></html>'
      );
  } catch (error) {
    console.error('Live SAML validation errored:', error);
    res
      .status(200)
      .type('html')
      .send(
        '<!doctype html><html><body><h1>SAMLResponse captured</h1>' +
          '<p>Live validation could not run; the capture on disk is unaffected.</p>' +
          capturedNote +
          '</body></html>'
      );
  }
});

// GET /saml/login: UNAUTHENTICATED SP-initiated login kickoff. The browser hits
// this directly at the start of a login and has no Firebase ID token to send,
// so — exactly like /saml/acs — this route intentionally has NO authMiddleware.
// It shells out to the login harness (todo 4) to build the real AuthnRequest
// redirect via the unmodified SAMLProvider, then 302s the browser to the IdP.
// --sp-base-url is derived from the request host/scheme the same way the ACS
// path derives them (deriveRequestScheme/deriveRequestHost).
function firstQueryValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

app.get('/saml/login', async (req: Request, res: Response) => {
  const idpEntityId = firstQueryValue(req.query.idpEntityId);
  const idpSsoUrl = firstQueryValue(req.query.idpSsoUrl);
  const idpCert = firstQueryValue(req.query.idpCert);
  const returnUrl = firstQueryValue(req.query.returnUrl);
  const connectionDocId = firstQueryValue(req.query.connectionDocId);

  const required: Array<[string, string]> = [
    ['idpEntityId', idpEntityId],
    ['idpSsoUrl', idpSsoUrl],
    ['idpCert', idpCert],
    ['returnUrl', returnUrl],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    res.status(400).json({ error: `missing required query param(s): ${missing.join(', ')}` });
    return;
  }

  // sp-base-url = "<scheme>://<host>", derived exactly as the ACS path does.
  const spBaseUrl = `${deriveRequestScheme(req)}://${deriveRequestHost(req)}`;

  try {
    const result = await requestSamlLogin(
      spBaseUrl,
      encodeRelayState({ returnUrl, connectionDocId: connectionDocId || undefined }),
      idpEntityId,
      idpSsoUrl,
      idpCert
    );
    if (result.result === 'redirect' && result.url) {
      res.redirect(302, result.url);
      return;
    }
    // config_error / timeout / subprocess failure → clean 502 JSON (never a
    // raw traceback, never a hung request).
    res.status(502).json({ error: result.message || 'login request failed' });
  } catch (error) {
    console.error('SAML login request errored:', error);
    res.status(502).json({ error: 'login request could not run' });
  }
});

// GET /saml/logout: UNAUTHENTICATED SP-initiated logout kickoff. Same rationale
// as /saml/login — the browser hits it mid-flow with no Firebase token — so it
// intentionally has NO authMiddleware. Shells to the logout harness `initiate`
// (todo 5) to build the real LogoutRequest via python3-saml, then 302s to the
// IdP SLO endpoint. --sp-sls-url is the SP callback the IdP posts back to.
app.get('/saml/logout', async (req: Request, res: Response) => {
  const idpSloUrl = firstQueryValue(req.query.idpSloUrl);
  const idpEntityId = firstQueryValue(req.query.idpEntityId);
  const idpCert = firstQueryValue(req.query.idpCert);
  const returnUrl = firstQueryValue(req.query.returnUrl);
  const nameId = firstQueryValue(req.query.nameId);
  const connectionDocId = firstQueryValue(req.query.connectionDocId);

  const required: Array<[string, string]> = [
    ['idpSloUrl', idpSloUrl],
    ['idpEntityId', idpEntityId],
    ['idpCert', idpCert],
    ['returnUrl', returnUrl],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    res.status(400).json({ error: `missing required query param(s): ${missing.join(', ')}` });
    return;
  }

  const spBaseUrl = `${deriveRequestScheme(req)}://${deriveRequestHost(req)}`;
  const spSlsUrl = `${spBaseUrl}/saml/sls`;

  try {
    const result = await requestSamlLogout(
      spBaseUrl,
      spSlsUrl,
      encodeRelayState({ returnUrl, connectionDocId: connectionDocId || undefined }),
      idpEntityId,
      idpSloUrl,
      idpCert,
      nameId
    );
    if (result.result === 'redirect' && result.url) {
      res.redirect(302, result.url);
      return;
    }
    res.status(502).json({ error: result.message || 'logout request failed' });
  } catch (error) {
    console.error('SAML logout request errored:', error);
    res.status(502).json({ error: 'logout request could not run' });
  }
});

// GET /saml/sls: UNAUTHENTICATED SLS callback. The IdP redirects the browser
// here with the LogoutResponse and cannot send a Firebase token, so — like
// /saml/acs — this route has NO authMiddleware. It processes the message via
// the logout harness, then either 302s a signed samlLogoutStatus token back
// into the SPA (allowlisted RelayState) or renders a plain HTML fallback.
// (Todos 5/8 of the prior tenetx-mimic-tryout-custom-realm plan.)
//
// Per-tester identity resolution (mimic-saml-per-tester-idp-identity todos 1-5):
// RelayState is decoded to extract an optional connectionDocId. Query params take
// precedence: if idpEntityId/idpSloUrl/idpCert are all absent AND a connectionDocId
// is present in RelayState, the tester's own IdP identity is resolved from the
// Firestore mimic_idp_connections doc. If the lookup fails or no connectionDocId
// is present, the route falls back to today's behavior (synthetic defaults or
// direct query params if provided). The decoded returnUrl is used for the
// redirect-back-into-SPA 302, with the same open-redirect guard (isAllowedRelayState)
// applied as before.
app.get('/saml/sls', async (req: Request, res: Response) => {
  const samlResponse = firstQueryValue(req.query.SAMLResponse);
  const samlRequest = firstQueryValue(req.query.SAMLRequest);
  const relayState = firstQueryValue(req.query.RelayState);
  const decoded = relayState ? decodeRelayState(relayState) : null;
  // `process` needs the same IdP identity `initiate` used, but the SLS callback
  // is a fresh stateless request (no session store here), so those ride as query
  // params alongside SAMLResponse/RelayState. Absent → the harness falls back to
  // its synthetic defaults (keeps the demo/self-test path working). `let` (not
  // `const`) because the Firestore fallback below may reassign them.
  let idpEntityId = firstQueryValue(req.query.idpEntityId);
  let idpSloUrl = firstQueryValue(req.query.idpSloUrl);
  let idpCert = firstQueryValue(req.query.idpCert);

  // Precedence: direct query params (above, highest) > RelayState connectionDocId
  // → Firestore. The lookup fires ONLY when all three direct params are absent
  // AND a connectionDocId rode in on RelayState, so the existing query-param
  // tests keep taking the direct path unchanged.
  if (!idpEntityId && !idpSloUrl && !idpCert && decoded?.connectionDocId) {
    const resolved = await getMimicIdpConnection(decoded.connectionDocId);
    if (resolved) {
      idpEntityId = resolved.entity_id;
      idpSloUrl = resolved.slo_url;
      idpCert = resolved.certificate;
    }
  }

  const spSlsUrl = `${deriveRequestScheme(req)}://${deriveRequestHost(req)}/saml/sls`;

  let result: SamlLogoutResult;
  try {
    result = await processSamlLogout(
      spSlsUrl,
      idpEntityId,
      idpSloUrl,
      idpCert,
      samlResponse,
      samlRequest,
      relayState
    );
  } catch (error) {
    console.error('SAML logout processing errored:', error);
    result = { result: 'error', message: 'logout processing could not run' };
  }

  // OPEN-REDIRECT GUARD: the `decoded &&` is load-bearing — a no-RelayState
  // callback decodes to null and MUST fall through to the raw-HTML branch below,
  // not throw on decoded.returnUrl (mirrors /saml/acs's guard exactly).
  if (decoded && isAllowedRelayState(decoded.returnUrl)) {
    const token =
      result.result === 'logged_out'
        ? signStatus({ status: 'logged_out' })
        : signStatus({ status: 'error', message: result.message ?? 'logout failed' });
    res.redirect(302, `${decoded.returnUrl}?samlLogoutStatus=${token}`);
    return;
  }

  // No usable RelayState → plain HTML confirmation (mirrors /saml/acs's fallback).
  if (result.result === 'logged_out') {
    res
      .status(200)
      .type('html')
      .send(
        '<!doctype html><html><body><h1>Logged out</h1>' +
          '<p>The real python3-saml toolkit processed the SAML Single Logout response.</p>' +
          '</body></html>'
      );
    return;
  }

  res
    .status(200)
    .type('html')
    .send(
      '<!doctype html><html><body><h1>Logout not completed</h1>' +
        `<p>The SAML logout could not be confirmed: ${escapeHtml(result.message || 'unknown error')}</p>` +
        '</body></html>'
    );
});

// Start the server only when run directly (node dist/index.js or tsx src/index.ts),
// never when imported by tests. Paths are resolved + normalized so a relative
// argv[1] still matches this module's absolute path on both Windows and POSIX.
const normalizePath = (p: string) => resolve(p).replace(/\\/g, '/').toLowerCase();
const isMain =
  !!process.argv[1] &&
  normalizePath(process.argv[1]) === normalizePath(fileURLToPath(import.meta.url));
if (isMain) {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException - exiting');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandledRejection - exiting');
    process.exit(1);
  });
  // Bind to the host resolved from process.env.HOST, defaulting to 0.0.0.0 so the
  // server is reachable from Traefik/Docker-network peers. For pure local-machine-only
  // runs (no Docker reverse proxy), set HOST=127.0.0.1 to avoid Windows Firewall prompts
  // (the browser-mediated SAML ACS POST would still originate locally).
  const listenHost = resolveListenHost();
  app.listen(port, listenHost, () => {
    logger.info({ host: listenHost, port }, 'tenetx-mimic-backend listening');
  });
}
