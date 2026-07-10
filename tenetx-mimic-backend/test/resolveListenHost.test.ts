import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveListenHost } from '../src/index.js';

describe('resolveListenHost', () => {
  let originalHost: string | undefined;

  beforeEach(() => {
    // Save the original HOST env var
    originalHost = process.env.HOST;
  });

  afterEach(() => {
    // Restore the original HOST env var
    if (originalHost === undefined) {
      delete process.env.HOST;
    } else {
      process.env.HOST = originalHost;
    }
  });

  it('returns 0.0.0.0 when process.env.HOST is unset', () => {
    delete process.env.HOST;
    const result = resolveListenHost();
    expect(result).toBe('0.0.0.0');
  });

  it('returns the literal value when process.env.HOST is set to 127.0.0.1', () => {
    process.env.HOST = '127.0.0.1';
    const result = resolveListenHost();
    expect(result).toBe('127.0.0.1');
  });

  it('returns the literal value when process.env.HOST is set to an arbitrary host', () => {
    process.env.HOST = '192.168.1.100';
    const result = resolveListenHost();
    expect(result).toBe('192.168.1.100');
  });
});
