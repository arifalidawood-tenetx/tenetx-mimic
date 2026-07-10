import type { IncomingMessage, ServerResponse } from 'http';
import pino from 'pino';
// Named (not default) import: pino-http v11 has no `export =`, so under NodeNext
// a default import binds to the non-callable module namespace. See TS2349.
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'crypto';

// Structured logging for the SAML proxy. Two redaction layers work together:
//
//   1. `REDACT_CONFIG` scrubs secret-bearing object KEYS (certificates, SAML
//      assertions, auth headers, refresh tokens) out of any logged payload.
//   2. `serializeRequest` (wired into pino-http via `serializers.req`) strips
//      the query string off `req.url` BEFORE it is logged.
//
// Layer 2 is not optional: pino's `redact` only matches known object keys, so a
// secret sitting inside a URL string (e.g. `/saml/login?idpCert=<PEM>`) is
// invisible to it. `/saml/login`, `/saml/logout`, and `/saml/sls` all accept a
// certificate / SAMLResponse as a query param, so without the custom serializer
// pino-http's default would log those secrets in plaintext at the `info` level.

// Pure so tests can pass a fabricated env object instead of mutating the real
// `process.env`. Precedence: explicit LOG_LEVEL > env-derived default.
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.LOG_LEVEL ||
    (env.NODE_ENV === 'test'
      ? 'silent'
      : env.NODE_ENV === 'production'
        ? 'info'
        : 'debug')
  );
}

// Explicit mutable-array type (NOT `as const`): pino's `RedactOptions.paths` is
// a mutable `string[]`; `as const` yields a `readonly string[]` that fails
// `tsc --noEmit` under this repo's `strict: true`. Exported so the test suite
// can build its own pino instance from the SAME config object.
export const REDACT_CONFIG: { paths: string[]; censor: string } = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'certificate',
    '*.certificate',
    'idpCert',
    '*.idpCert',
    'samlResponse',
    'refreshToken',
  ],
  censor: '[REDACTED]',
};

// Pure predicate: pino-http skips auto-logging for requests this returns true
// for, keeping the `/health` poll noise out of the logs.
export function shouldIgnoreHealthCheck(req: { url?: string }): boolean {
  return req.url === '/health';
}

// Pure security fix: drop everything from the first `?` onward so query-string
// secrets never reach the log sink. Directly unit-testable without an HTTP req.
export function stripQueryString(url?: string): string {
  return url ? url.split('?')[0] : '';
}

// Custom pino-http request serializer built on `stripQueryString`. Replaces the
// default serializer that would otherwise log the full, query-string-intact URL.
export function serializeRequest(req: {
  id?: unknown;
  method?: string;
  url?: string;
}): { id: unknown; method: string | undefined; url: string } {
  return { id: req.id, method: req.method, url: stripQueryString(req.url) };
}

// Pretty transport is a dev-only convenience. Never in production (structured
// JSON is required for log ingestion) and never in test (the worker-thread
// transport races the process exit and garbles synchronous output).
function shouldUsePrettyTransport(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.NODE_ENV !== 'test' &&
    process.env.LOG_PRETTY !== 'false'
  );
}

export const logger = pino({
  level: resolveLogLevel(),
  redact: REDACT_CONFIG,
  ...(shouldUsePrettyTransport()
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

// HTTP request logger. Reuses an inbound `X-Request-Id` when present (falling
// back to a fresh UUID), echoes it back on the response, skips `/health`, and
// swaps in the query-string-stripping request serializer.
export function createHttpLogger() {
  // Generics pinned so `genReqId`'s `req`/`res` keep their http types; otherwise
  // `shouldIgnoreHealthCheck`'s `{ url?: string }` param narrows `IM` (TS2339).
  return pinoHttp<IncomingMessage, ServerResponse>({
    logger,
    genReqId: (req, res) => {
      const existing = Array.isArray(req.headers['x-request-id'])
        ? req.headers['x-request-id'][0]
        : req.headers['x-request-id'];
      const id = existing || randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: shouldIgnoreHealthCheck },
    serializers: { req: serializeRequest },
  });
}
