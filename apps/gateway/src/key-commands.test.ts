import { describe, expect, it, vi } from 'vitest';

import type { ApiKey, ApiKeyId, ApiKeyRepository } from '@rax-digital/domain';

import { executeKeyCommand } from './key-commands.js';

class MemoryRepository implements ApiKeyRepository {
  public created: ApiKey | undefined;
  public revoked: ApiKeyId | undefined;

  public findByPublicId(): Promise<ApiKey | null> {
    return Promise.resolve(null);
  }

  public create(apiKey: ApiKey): Promise<void> {
    this.created = apiKey;
    return Promise.resolve();
  }

  public revoke(id: ApiKeyId): Promise<boolean> {
    this.revoked = id;
    return Promise.resolve(true);
  }

  public markLastUsed(): Promise<void> {
    return Promise.resolve();
  }
}

const tenant = '123e4567-e89b-42d3-a456-426614174000';
const keyId = '223e4567-e89b-42d3-a456-426614174000';

describe('API key operator commands', () => {
  it('creates a one-way record and emits the credential exactly once', async () => {
    const repository = new MemoryRepository();
    const output = vi.fn<(value: string) => void>();
    await executeKeyCommand(
      [
        'create',
        '--tenant-id',
        tenant,
        '--name',
        'local app',
        '--environment',
        'dev',
        '--models',
        'rax/*,openai/gpt-test',
        '--allow-streaming',
      ],
      {
        repository,
        pepper: 'test-pepper-with-at-least-32-characters',
        clock: () => new Date('2026-08-04T00:00:00.000Z'),
        idGenerator: () => keyId,
        output,
      },
    );
    const credential = output.mock.calls[0]?.[0].trim();
    expect(output).toHaveBeenCalledTimes(1);
    expect(credential).toMatch(/^rcg_dev_/u);
    expect(repository.created).toMatchObject({
      id: keyId,
      tenantId: tenant,
      name: 'local app',
      environment: 'development',
      status: 'active',
      policy: {
        allowedModelPatterns: ['rax/*', 'openai/gpt-test'],
        allowStreaming: true,
        allowTools: false,
      },
    });
    expect(repository.created?.keyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(repository.created)).not.toContain(credential);
  });

  it('revokes by internal ID without accepting unknown flags', async () => {
    const repository = new MemoryRepository();
    const output = vi.fn<(value: string) => void>();
    const dependencies = {
      repository,
      pepper: 'test-pepper-with-at-least-32-characters',
      clock: () => new Date(),
      idGenerator: () => keyId,
      output,
    };
    await executeKeyCommand(['revoke', '--id', keyId], dependencies);
    expect(repository.revoked).toBe(keyId);
    expect(output).toHaveBeenCalledWith(`revoked ${keyId}\n`);
    await expect(
      executeKeyCommand(['revoke', '--id', keyId, '--force'], dependencies),
    ).rejects.toThrow('flag');
  });
});
