import {
  createHmac,
  randomBytes as platformRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  apiKeyHash,
  apiKeyPublicId,
  validateApiKey,
  type ApiKey,
  type ApiKeyEnvironment,
  type ApiKeyId,
  type ApiKeyPolicy,
  type ApiKeyRepository,
  type TenantId,
} from '@genchi/domain';

const environmentCodes = {
  development: 'dev',
  test: 'test',
  staging: 'stg',
  production: 'prod',
} as const satisfies Readonly<Record<ApiKeyEnvironment, string>>;

const codeEnvironments: Readonly<
  Record<string, ApiKeyEnvironment | undefined>
> = Object.fromEntries(
  Object.entries(environmentCodes).map(([environment, code]) => [
    code,
    environment as ApiKeyEnvironment,
  ]),
);

export interface ParsedApiKeyCredential {
  readonly environment: ApiKeyEnvironment;
  readonly publicId: string;
}

export interface ProvisionApiKeyInput {
  readonly id: ApiKeyId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly policy: ApiKeyPolicy;
  readonly pepper: string;
  readonly expiresAt?: Date | null;
}

export interface ProvisionedApiKey {
  /** The full credential. Callers must display it once and then discard it. */
  readonly credential: string;
  /** Safe-to-persist metadata containing only an HMAC of the credential. */
  readonly apiKey: ApiKey;
}

export type AuthenticationResult =
  | { readonly authenticated: true; readonly apiKey: ApiKey }
  | { readonly authenticated: false };

type RandomBytes = (size: number) => Uint8Array;

/** Computes the accepted HMAC-SHA-256 representation of a Genchi key. */
export function hashApiKeyCredential(
  credential: string,
  pepper: string,
): string {
  return createHmac('sha256', pepper).update(credential, 'utf8').digest('hex');
}

/** Parses only the searchable, non-secret portions of a credential. */
export function parseApiKeyCredential(
  credential: string,
): ParsedApiKeyCredential | null {
  const match =
    /^gch_(dev|test|stg|prod)_([A-Za-z0-9-]{8,64})_([A-Za-z0-9_-]{43,})$/.exec(
      credential,
    );
  if (match === null) {
    return null;
  }

  const code = match[1];
  const publicId = match[2];
  const secret = match[3];
  if (code === undefined || publicId === undefined || secret === undefined) {
    return null;
  }

  const environment = codeEnvironments[code];
  if (
    environment === undefined ||
    !/^[A-Za-z0-9-]{8,64}$/.test(publicId) ||
    !/^[A-Za-z0-9_-]{43,}$/.test(secret)
  ) {
    return null;
  }

  return { environment, publicId };
}

/** Creates a high-entropy API key and its persistable domain record. */
export function provisionApiKey(
  input: ProvisionApiKeyInput,
  now: Date,
  randomBytes: RandomBytes = platformRandomBytes,
): ProvisionedApiKey {
  const publicId = Buffer.from(randomBytes(12)).toString('hex');
  const secret = Buffer.from(randomBytes(32)).toString('base64url');
  const credential = `gch_${environmentCodes[input.environment]}_${publicId}_${secret}`;
  const apiKey: ApiKey = {
    id: input.id,
    tenantId: input.tenantId,
    name: input.name,
    environment: input.environment,
    publicId: apiKeyPublicId(publicId),
    keyHash: apiKeyHash(hashApiKeyCredential(credential, input.pepper)),
    status: 'active',
    policy: input.policy,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
  };

  const validation = validateApiKey(apiKey);
  if (!validation.ok) {
    throw new TypeError(validation.reason);
  }

  return { credential, apiKey: validation.value };
}

/** Verifies Genchi credentials while exposing one uniform invalid result. */
export class ApiKeyAuthenticator {
  public constructor(
    private readonly repository: ApiKeyRepository,
    private readonly pepper: string,
    private readonly environment: ApiKeyEnvironment,
    private readonly clock: () => Date,
  ) {}

  public async authenticate(credential: string): Promise<AuthenticationResult> {
    const parsed = parseApiKeyCredential(credential);
    const record =
      parsed === null
        ? null
        : await this.repository.findByPublicId(apiKeyPublicId(parsed.publicId));
    const presentedHash = Buffer.from(
      hashApiKeyCredential(credential, this.pepper),
      'hex',
    );
    const storedHash = Buffer.from(
      record?.keyHash ?? '0'.repeat(presentedHash.byteLength * 2),
      'hex',
    );
    const hashMatches =
      storedHash.byteLength === presentedHash.byteLength &&
      timingSafeEqual(storedHash, presentedHash);

    if (
      parsed === null ||
      record === null ||
      !hashMatches ||
      parsed.environment !== this.environment ||
      record.environment !== this.environment ||
      record.status !== 'active' ||
      (record.expiresAt !== null && record.expiresAt <= this.clock())
    ) {
      return { authenticated: false };
    }

    return { authenticated: true, apiKey: record };
  }
}
