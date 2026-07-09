import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';

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

// Stub POST /verify-metadata route (requires auth)
// Logic will be filled in by todo 9
app.post(
  '/verify-metadata',
  authMiddleware,
  (req: AuthenticatedRequest, res: Response) => {
    res.status(501).json({ error: 'not implemented' });
  }
);

// Start server
app.listen(port, () => {
  console.log(`saml-proxy listening on port ${port}`);
});
