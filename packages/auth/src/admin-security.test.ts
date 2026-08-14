import { describe, expect, it } from 'vitest';

import { NodeAdminSecurity } from './admin-security.js';

const testCost = { N: 1_024, r: 8, p: 1, maxmem: 16 * 1024 * 1024 };

describe('NodeAdminSecurity', () => {
  it('stores salted, versioned scrypt hashes and verifies in constant-shape APIs', async () => {
    let fill = 1;
    const security = new NodeAdminSecurity({
      sessionPepper: 'test-session-pepper-with-at-least-32-characters',
      cost: testCost,
      randomBytes: (size) => new Uint8Array(size).fill(fill++),
    });
    const first = await security.hashPassword('a sufficiently long password');
    const second = await security.hashPassword('a sufficiently long password');

    expect(first).toMatch(/^scrypt\$v=1\$N=1024\$r=8\$p=1\$/);
    expect(first).not.toContain('sufficiently');
    expect(second).not.toBe(first);
    await expect(
      security.verifyPassword('a sufficiently long password', first),
    ).resolves.toBe(true);
    await expect(
      security.verifyPassword('the wrong password', first),
    ).resolves.toBe(false);
    await expect(security.verifyPassword('anything', 'invalid')).resolves.toBe(
      false,
    );
  });

  it('generates opaque 256-bit tokens and stores only keyed hashes', () => {
    const security = new NodeAdminSecurity({
      sessionPepper: 'test-session-pepper-with-at-least-32-characters',
      cost: testCost,
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });
    const token = security.generateOpaqueToken();
    const hash = security.hashOpaqueToken(token);

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(security.verifyOpaqueToken(token, hash)).toBe(true);
    expect(security.verifyOpaqueToken(`${token.slice(0, -1)}A`, hash)).toBe(
      false,
    );
  });

  it('rejects a short session pepper', () => {
    expect(() => new NodeAdminSecurity({ sessionPepper: 'short' })).toThrow(
      /at least 32/,
    );
  });
});
