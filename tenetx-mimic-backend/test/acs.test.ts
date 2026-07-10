import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { app } from '../src/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const capturedDir = join(packageRoot, '.captured');

const listCaptured = () => (existsSync(capturedDir) ? readdirSync(capturedDir) : []);

let server: Server;
let baseUrl: string;
let preexisting: Set<string>;

beforeAll(async () => {
  preexisting = new Set(listCaptured());
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
  // Remove only files this run created; leave any real captures untouched.
  for (const name of listCaptured()) {
    if (!preexisting.has(name)) {
      rmSync(join(capturedDir, name), { force: true });
    }
  }
});

describe('POST /saml/acs', () => {
  it('captures a valid SAMLResponse: 200 + writes one file', async () => {
    const before = listCaptured().length;

    const res = await fetch(`${baseUrl}/saml/acs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SAMLResponse: 'PHNhbWxwOlJlc3BvbnNlLz4=',
      }).toString(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('captured');

    expect(listCaptured().length).toBe(before + 1);
  });

  it('rejects a POST with no SAMLResponse field: 400 JSON + no file written', async () => {
    const before = listCaptured().length;

    const res = await fetch(`${baseUrl}/saml/acs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();

    expect(listCaptured().length).toBe(before);
  });

  it('sets an X-Request-Id response header (UUID shape) on every response', async () => {
    // createHttpLogger() sets X-Request-Id on EVERY response; the 400 path is
    // used deliberately so no capture file is written as a side effect.
    const res = await fetch(`${baseUrl}/saml/acs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });

    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
