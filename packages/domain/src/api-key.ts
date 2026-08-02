declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export type ApiKeyPublicId = Brand<string, 'ApiKeyPublicId'>;
export type ApiKeyHash = Brand<string, 'ApiKeyHash'>;
export type TenantId = Brand<string, 'TenantId'>;

export type ApiKeyEnvironment =
  'development' | 'test' | 'staging' | 'production';

export type ApiKeyStatus = 'active' | 'disabled' | 'revoked';

/** Deny-by-default capabilities and resource limits attached to one API key. */
export interface ApiKeyPolicy {
  readonly allowedModelPatterns: readonly string[];
  readonly allowStreaming: boolean;
  readonly allowTools: boolean;
  readonly requestsPerMinute: number;
  readonly maxConcurrentRequests: number;
  readonly maxRequestTokens?: number;
  readonly maxOutputTokens?: number;
}

/** Persisted API key metadata. The plaintext credential is never represented. */
export interface ApiKey {
  readonly id: ApiKeyId;
  readonly publicId: ApiKeyPublicId;
  readonly keyHash: ApiKeyHash;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly status: ApiKeyStatus;
  readonly policy: ApiKeyPolicy;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

export type ApiKeyValidationResult =
  | { readonly ok: true; readonly value: ApiKey }
  | { readonly ok: false; readonly reason: string };

/** Validates API key metadata at construction and persistence boundaries. */
export function validateApiKey(apiKey: ApiKey): ApiKeyValidationResult {
  if (
    !['development', 'test', 'staging', 'production'].includes(
      apiKey.environment,
    ) ||
    !['active', 'disabled', 'revoked'].includes(apiKey.status)
  ) {
    return { ok: false, reason: 'API key state is invalid' };
  }

  if (apiKey.name.trim().length === 0) {
    return { ok: false, reason: 'API key name must not be empty' };
  }

  if (!/^[A-Za-z0-9-]{8,64}$/.test(apiKey.publicId)) {
    return { ok: false, reason: 'API key public ID has an invalid format' };
  }

  if (!/^[a-f0-9]{64}$/.test(apiKey.keyHash)) {
    return { ok: false, reason: 'API key hash has an invalid format' };
  }

  if (
    apiKey.policy.requestsPerMinute <= 0 ||
    apiKey.policy.maxConcurrentRequests <= 0
  ) {
    return { ok: false, reason: 'API key limits must be positive' };
  }

  if (
    apiKey.expiresAt !== null &&
    apiKey.expiresAt.getTime() <= apiKey.createdAt.getTime()
  ) {
    return { ok: false, reason: 'API key expiry must follow creation time' };
  }

  return { ok: true, value: apiKey };
}

export function apiKeyId(value: string): ApiKeyId {
  return value as ApiKeyId;
}

export function apiKeyPublicId(value: string): ApiKeyPublicId {
  return value as ApiKeyPublicId;
}

export function apiKeyHash(value: string): ApiKeyHash {
  return value as ApiKeyHash;
}

export function tenantId(value: string): TenantId {
  return value as TenantId;
}
