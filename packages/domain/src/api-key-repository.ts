import type { ApiKey, ApiKeyId, ApiKeyPublicId } from './api-key.js';

/** Task-oriented storage port implemented by persistence adapters. */
export interface ApiKeyRepository {
  findByPublicId(publicId: ApiKeyPublicId): Promise<ApiKey | null>;
  create(apiKey: ApiKey): Promise<void>;
  revoke(id: ApiKeyId): Promise<boolean>;
  markLastUsed(id: ApiKeyId, usedAt: Date): Promise<void>;
}
