import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import { parseSamlMetadata, isAllowedMetadataHost } from './samlMetadata';

const app = express();
const port = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// CORS middleware - allowlist only the deployed mimic Hosting origin
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://tenetx-mimic.web.app';
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);

// Initialize Firebase Admin SDK
// Service account JSON is passed via env var (base64 or raw JSON string)
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.warn(
    'FIREBASE_SERVICE_ACCOUNT_JSON not set. Auth middleware will reject all requests.'
  );
} else {
  try {
    let serviceAccount: Record<string, unknown>;
    // Try base64 decode first, fall back to raw JSON
    try {
      const decoded = Buffer.from(serviceAccountJson, 'base64').toString('utf-8');
      serviceAccount = JSON.parse(decoded);
    } catch {
      serviceAccount = JSON.parse(serviceAccountJson);
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
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
    const decodedToken = await admin.auth().verifyIdToken(idToken);

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

// Start server
app.listen(port, () => {
  console.log(`saml-proxy listening on port ${port}`);
});
