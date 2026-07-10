import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
// Import the REAL shared config + pure helpers (never a local copy): the
// redaction test below drives a dedicated pino instance off the SAME
// REDACT_CONFIG object, so breaking that config in src/logger.ts breaks this
// test too. `.js` extension mirrors the repo's other test imports (NodeNext).
import {
  resolveLogLevel,
  REDACT_CONFIG,
  shouldIgnoreHealthCheck,
  stripQueryString,
  serializeRequest,
} from '../src/logger.js';

describe('resolveLogLevel precedence', () => {
  it('maps NODE_ENV=test to the silent level', () => {
    expect(resolveLogLevel({ NODE_ENV: 'test' })).toBe('silent');
  });

  it('maps NODE_ENV=production to the info level', () => {
    expect(resolveLogLevel({ NODE_ENV: 'production' })).toBe('info');
  });

  it('defaults to debug when neither LOG_LEVEL nor a known NODE_ENV is set', () => {
    expect(resolveLogLevel({})).toBe('debug');
  });

  it('lets an explicit LOG_LEVEL win over NODE_ENV', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'trace', NODE_ENV: 'production' })).toBe('trace');
  });
});

describe('REDACT_CONFIG redaction (dedicated in-memory pino instance)', () => {
  it('censors a secret-bearing key and never leaks its raw value', () => {
    // The shared `logger` export is silenced under NODE_ENV=test (vitest sets
    // that), so build a throwaway pino instance wired to an in-memory Writable
    // and force `level: 'info'` to actually emit. It consumes the REAL
    // REDACT_CONFIG, so this is a live test of the shipped config.
    const captured: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        captured.push(chunk.toString());
        callback();
      },
    });
    const log = pino({ level: 'info', redact: REDACT_CONFIG }, sink);

    log.info({ certificate: 'FAKE-PEM-VALUE' }, 'redaction smoke test');
    const output = captured.join('');

    expect(output).toContain('"certificate":"[REDACTED]"');
    expect(output).not.toContain('FAKE-PEM-VALUE');
  });
});

describe('shouldIgnoreHealthCheck', () => {
  it('ignores the bare /health probe path', () => {
    expect(shouldIgnoreHealthCheck({ url: '/health' })).toBe(true);
  });

  it('does not ignore a real SAML route', () => {
    expect(shouldIgnoreHealthCheck({ url: '/saml/acs' })).toBe(false);
  });

  it('does not ignore /health with a query string (known exact-match limitation)', () => {
    // Documented limitation: matching is exact-string, so a query-suffixed
    // health check is NOT ignored. Acceptable because real probes hit the bare
    // `/health` path; asserted here as `false` rather than silently expecting
    // `true` so any future loosening of the predicate is a visible change.
    expect(shouldIgnoreHealthCheck({ url: '/health?x=1' })).toBe(false);
  });
});

describe('stripQueryString', () => {
  it('drops everything from the first "?" onward', () => {
    expect(stripQueryString('/saml/login?idpCert=SECRET')).toBe('/saml/login');
  });

  it('is a no-op when there is no query string', () => {
    expect(stripQueryString('/health')).toBe('/health');
  });

  it('returns an empty string for undefined input', () => {
    expect(stripQueryString(undefined)).toBe('');
  });
});

describe('serializeRequest (query-string redaction bypass fix)', () => {
  it('strips the query string off req.url without dropping id/method', () => {
    const result = serializeRequest({
      id: 'abc123',
      method: 'GET',
      url: '/saml/sls?SAMLResponse=RAWBODY&idpCert=SECRETPEM',
    });

    expect(result.id).toBe('abc123');
    expect(result.method).toBe('GET');
    expect(result.url).toBe('/saml/sls');
    // No query-string secret survives anywhere in the serialized shape.
    expect(result.url).not.toContain('RAWBODY');
    expect(result.url).not.toContain('SECRETPEM');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('RAWBODY');
    expect(serialized).not.toContain('SECRETPEM');
  });
});
