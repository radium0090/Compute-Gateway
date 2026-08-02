import { describe, expect, it } from 'vitest';

import type {
  ApiKey,
  ClientAuthenticator,
  ProviderAdapter,
  RouteResolver,
} from '@genchi/domain';

import { CreateChatCompletionService } from './create-chat-completion.js';

const apiKey = { policy: {} } as ApiKey;
const request = {
  model: 'genchi/fast',
  messages: [{ role: 'user' as const, content: 'content stays in memory' }],
};

function provider(): ProviderAdapter {
  return {
    id: 'openai-primary',
    capabilities: () => ({
      chat: true,
      streaming: false,
      tools: false,
      jsonObject: false,
      jsonSchema: false,
      systemMessages: true,
    }),
    createChatCompletion: () =>
      Promise.resolve({
        ok: true,
        response: {
          content: 'normalized response',
          finishReason: 'stop',
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        },
      }),
    streamChatCompletion: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('not used')),
      }),
    }),
  };
}

const router: RouteResolver = {
  resolve: () => ({
    ok: true,
    route: {
      providerRef: 'openai-primary',
      provider: 'openai',
      providerModel: 'model-a',
    },
  }),
};

describe('CreateChatCompletionService', () => {
  it('stops before routing when authentication fails', async () => {
    let routed = false;
    const authenticator: ClientAuthenticator = {
      authenticate: () => Promise.resolve({ authenticated: false }),
    };
    const service = new CreateChatCompletionService(
      authenticator,
      {
        resolve: () => (
          (routed = true),
          { ok: false, reason: 'model_not_found' }
        ),
      },
      new Map(),
    );

    await expect(
      service.execute({
        credential: 'invalid',
        requestId: 'req_test',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'authentication' },
    });
    expect(routed).toBe(false);
  });

  it('returns one normalized provider attempt', async () => {
    const authenticator: ClientAuthenticator = {
      authenticate: () => Promise.resolve({ authenticated: true, apiKey }),
    };
    const service = new CreateChatCompletionService(
      authenticator,
      router,
      new Map([['openai-primary', provider()]]),
    );

    const result = await service.execute({
      credential: 'opaque credential',
      requestId: 'req_test',
      request,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      response: { content: 'normalized response' },
      route: { provider: 'openai', providerModel: 'model-a' },
    });
  });
});
