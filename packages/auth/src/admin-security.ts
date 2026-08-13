import {
  createHmac,
  randomBytes as platformRandomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

import { adminTokenHash, type AdminTokenHash } from '@rax-digital/domain';

const defaultCost = {
  N: 32_768,
  r: 8,
  p: 3,
  maxmem: 64 * 1024 * 1024,
} as const;
const passwordHashLength = 32;
const saltLength = 16;
const opaqueTokenLength = 32;

// This public, deterministic hash is used only to equalize unknown-user login
// work. It is not an account credential and cannot authenticate any user.
const dummyPasswordHash =
  'scrypt$v=1$N=32768$r=8$p=3$AAAAAAAAAAAAAAAAAAAAAA$bSiBtLmp2p10SfHCPaF2JTc6SdKodsv8cpvatDq-dok';

export interface ScryptCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem: number;
}

export interface AdminSecurityOptions {
  readonly sessionPepper: string;
  readonly cost?: ScryptCost;
  readonly randomBytes?: (size: number) => Uint8Array;
}

interface ParsedPasswordHash {
  readonly cost: ScryptCost;
  readonly salt: Buffer;
  readonly expected: Buffer;
}

function derive(
  password: string,
  salt: Buffer,
  cost: ScryptCost,
  length = passwordHashLength,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, cost, (error, result) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(Buffer.from(result));
    });
  });
}

function parsePasswordHash(value: string): ParsedPasswordHash | null {
  const match =
    /^scrypt\$v=1\$N=(\d+)\$r=(\d+)\$p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
      value,
    );
  if (match === null) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const salt = Buffer.from(match[4] ?? '', 'base64url');
  const expected = Buffer.from(match[5] ?? '', 'base64url');
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    N < 1_024 ||
    N > 1_048_576 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16 ||
    salt.byteLength < saltLength ||
    expected.byteLength !== passwordHashLength
  ) {
    return null;
  }
  return {
    cost: { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) },
    salt,
    expected,
  };
}

/** Node.js platform cryptography for administrator passwords and opaque tokens. */
export class NodeAdminSecurity {
  public readonly dummyPasswordHash = dummyPasswordHash;
  private readonly cost: ScryptCost;
  private readonly randomBytes: (size: number) => Uint8Array;

  public constructor(private readonly options: AdminSecurityOptions) {
    if (options.sessionPepper.length < 32) {
      throw new TypeError(
        'Administrator session pepper must be at least 32 characters',
      );
    }
    this.cost = options.cost ?? defaultCost;
    if (
      this.cost.N < 1_024 ||
      this.cost.N > 1_048_576 ||
      (this.cost.N & (this.cost.N - 1)) !== 0 ||
      this.cost.r < 1 ||
      this.cost.r > 32 ||
      this.cost.p < 1 ||
      this.cost.p > 16
    ) {
      throw new TypeError('Administrator scrypt cost is outside safe bounds');
    }
    this.randomBytes = options.randomBytes ?? platformRandomBytes;
  }

  public async hashPassword(password: string): Promise<string> {
    const salt = Buffer.from(this.randomBytes(saltLength));
    const derived = await derive(password, salt, this.cost);
    return [
      'scrypt',
      'v=1',
      `N=${String(this.cost.N)}`,
      `r=${String(this.cost.r)}`,
      `p=${String(this.cost.p)}`,
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  public async verifyPassword(
    password: string,
    encoded: string,
  ): Promise<boolean> {
    const parsed = parsePasswordHash(encoded);
    if (parsed === null) return false;
    const actual = await derive(
      password,
      parsed.salt,
      parsed.cost,
      parsed.expected.byteLength,
    );
    return timingSafeEqual(parsed.expected, actual);
  }

  public generateOpaqueToken(): string {
    return Buffer.from(this.randomBytes(opaqueTokenLength)).toString(
      'base64url',
    );
  }

  public hashOpaqueToken(token: string): AdminTokenHash {
    return adminTokenHash(
      createHmac('sha256', this.options.sessionPepper)
        .update(token, 'utf8')
        .digest('hex'),
    );
  }

  public verifyOpaqueToken(token: string, expected: AdminTokenHash): boolean {
    const actualBuffer = Buffer.from(this.hashOpaqueToken(token), 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return (
      actualBuffer.byteLength === expectedBuffer.byteLength &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }
}
