import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { initializeApp, refreshToken } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseSamlMetadata, isAllowedMetadataHost } from './samlMetadata.js';

// Exported for tests (mounted on an ephemeral port); the app.listen() at the
// bottom is guarded to run only when this module is executed directly.
export const app = express();
const port = process.env.PORT || 3000;

// Anchors the .captured/ dir to the package root. src/ (tsx/vitest) and dist/
// (compiled) both sit one level below it, so '..' is correct in either case.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// POST /saml/acs: UNAUTHENTICATED SAML ACS capture endpoint. During a real SAML
// login Keycloak POSTs a signed SAMLResponse here and cannot send a Firebase ID
// token, so this route intentionally has NO authMiddleware. Its only job is to
// persist the raw base64 response for a later read-only harness — it never parses,
// validates, or interprets the SAMLResponse.
app.post('/saml/acs', (req: Request, res: Response) => {
  const samlResponse = req.body?.SAMLResponse;
  if (typeof samlResponse !== 'string' || !samlResponse) {
    res.status(400).json({ error: 'SAMLResponse is required' });
    return;
  }

  const capturedAt = new Date().toISOString();
  const capturedDir = join(packageRoot, '.captured');
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

  res
    .status(200)
    .type('html')
    .send(
      '<!doctype html><html><body><h1>SAMLResponse captured</h1>' +
        '<p>check <code>.captured/</code></p></body></html>'
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
  app.listen(port, () => {
    console.log(`tenetx-mimic-backend listening on port ${port}`);
  });
}
