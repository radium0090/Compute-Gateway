import { describe, expect, it } from 'vitest';

import { NodeCustomerSecurity } from './customer-security.js';

const testCost = { N: 1_024, r: 8, p: 1, maxmem: 16 * 1024 * 1024 };

describe('NodeCustomerSecurity', () => {
  it('delegates password and opaque-token operations with customer branding', async () => {
    let fill = 1;
    const security = new NodeCustomerSecurity({
      sessionPepper: 'customer-session-pepper-with-at-least-32-characters',
      cost: testCost,
      randomBytes: (size) => new Uint8Array(size).fill(fill++),
    });
    const passwordHash = await security.hashPassword('a customer password');
    const token = security.generateOpaqueToken();
    const tokenHash = security.hashOpaqueToken(token);

    expect(security.dummyPasswordHash).toMatch(/^scrypt\$/);
    await expect(
      security.verifyPassword('a customer password', passwordHash),
    ).resolves.toBe(true);
    await expect(
      security.verifyPassword('the wrong password', passwordHash),
    ).resolves.toBe(false);
    expect(token).toHaveLength(43);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(security.verifyOpaqueToken(token, tokenHash)).toBe(true);
    expect(
      security.verifyOpaqueToken(`${token.slice(0, -1)}A`, tokenHash),
    ).toBe(false);
  });
});
