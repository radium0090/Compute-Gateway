import { describe, expect, it } from 'vitest';

import type { ApiKey } from '@genchi/domain';

import { ListModelsService } from './list-models.js';

const apiKey = { policy: {} } as ApiKey;

describe('ListModelsService', () => {
  it('does not query the catalog when authentication fails', async () => {
    let listed = false;
    const service = new ListModelsService(
      { authenticate: () => Promise.resolve({ authenticated: false }) },
      {
        listAllowed: () => {
          listed = true;
          return [];
        },
      },
    );

    await expect(service.execute('invalid')).resolves.toEqual({
      ok: false,
      failure: 'authentication',
    });
    expect(listed).toBe(false);
  });

  it('returns the policy-filtered catalog result', async () => {
    const service = new ListModelsService(
      {
        authenticate: () => Promise.resolve({ authenticated: true, apiKey }),
      },
      { listAllowed: () => [{ id: 'genchi/fast' }] },
    );

    await expect(service.execute('valid')).resolves.toEqual({
      ok: true,
      models: [{ id: 'genchi/fast' }],
    });
  });
});
