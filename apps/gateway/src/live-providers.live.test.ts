import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import type {
  CreateChatCompletionInput,
  CreateChatCompletionResult,
  CreateChatCompletionStreamResult,
} from '@rax-digital/application';
import { loadConfig } from '@rax-digital/config';
import type {
  ProviderAdapter,
  ProviderCapabilities,
} from '@rax-digital/domain';
import { createLogger } from '@rax-digital/observability';
import { AnthropicAdapter } from '@rax-digital/provider-anthropic';
import { GeminiAdapter } from '@rax-digital/provider-gemini';
import { OpenAiAdapter } from '@rax-digital/provider-openai';

import { buildGateway } from './app.js';
import {
  diagnoseGeminiRequest,
  safeGatewayFailureSummary,
} from './live-provider-diagnostics.js';

const live = process.env.RCG_LIVE_ENABLED === 'true' ? describe : describe.skip;
const capabilities: ProviderCapabilities = {
  chat: true,
  streaming: true,
  tools: true,
  jsonObject: true,
  jsonSchema: true,
  systemMessages: true,
};
const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Required live-test environment variable is missing: ${name}`,
    );
  }
  return value;
}

function injectFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const url =
      input instanceof Request ? new URL(input.url) : new URL(String(input));
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        responseHeaders.set(
          name,
          Array.isArray(value) ? value.join(', ') : String(value),
        );
      }
    }
    return new Response(response.rawPayload, {
      status: response.statusCode,
      headers: responseHeaders,
    });
  };
}

function service(adapter: ProviderAdapter, provider: string, model: string) {
  const route = {
    providerRef: `${provider}-live`,
    provider,
    providerModel: model,
  };
  return {
    async execute(
      input: CreateChatCompletionInput,
    ): Promise<CreateChatCompletionResult> {
      const result = await adapter.createChatCompletion(input.request, {
        requestId: input.requestId,
        providerModel: model,
        signal: input.signal,
        connectTimeoutMs: 30_000,
      });
      return result.ok
        ? { ok: true, response: result.response, route, attempts: 1 }
        : { ok: false, failure: { kind: 'provider', error: result.error } };
    },
    async executeStream(
      input: CreateChatCompletionInput,
    ): Promise<CreateChatCompletionStreamResult> {
      const result = await adapter.streamChatCompletion(input.request, {
        requestId: input.requestId,
        providerModel: model,
        signal: input.signal,
        connectTimeoutMs: 30_000,
      });
      return result.ok
        ? { ok: true, stream: result.stream, route, attempts: 1 }
        : { ok: false, failure: { kind: 'provider', error: result.error } };
    },
  };
}

type ProviderCase = Readonly<{
  name: string;
  modelEnvironment: string;
  create(model: string): ProviderAdapter;
}>;

const providers: readonly ProviderCase[] = [
  {
    name: 'openai',
    modelEnvironment: 'RCG_LIVE_OPENAI_MODEL',
    create: (model) =>
      new OpenAiAdapter({
        id: 'openai-live',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: required('OPENAI_API_KEY'),
        models: { [model]: capabilities },
      }),
  },
  {
    name: 'anthropic',
    modelEnvironment: 'RCG_LIVE_ANTHROPIC_MODEL',
    create: (model) =>
      new AnthropicAdapter({
        id: 'anthropic-live',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: required('ANTHROPIC_API_KEY'),
        models: { [model]: capabilities },
      }),
  },
  {
    name: 'gemini',
    modelEnvironment: 'RCG_LIVE_GEMINI_MODEL',
    create: (model) =>
      new GeminiAdapter({
        id: 'gemini-live',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: required('GEMINI_API_KEY'),
        models: { [model]: capabilities },
      }),
  },
];

live('live provider compatibility through the OpenAI Node SDK', () => {
  it.each(providers)(
    '$name supports normalized completion and streaming',
    async (providerCase) => {
      const model = required(providerCase.modelEnvironment);
      const app = await buildGateway({
        config,
        logger: createLogger({ environment: 'test', level: 'error' }),
        readinessProbe: { check: () => Promise.resolve({ ready: true }) },
        chatCompletionService: service(
          providerCase.create(model),
          providerCase.name,
          model,
        ),
      });
      try {
        const client = new OpenAI({
          apiKey: 'live-test-client-placeholder',
          baseURL: 'http://rax-compute-gateway.test/v1',
          fetch: injectFetch(app),
          maxRetries: 0,
        });
        const request = {
          model: `${providerCase.name}/${model}`,
          messages: [{ role: 'user' as const, content: 'Reply with OK.' }],
          max_tokens: 8,
        };
        const completion = await client.chat.completions
          .create(request)
          .catch(async (error: unknown) => {
            if (providerCase.name !== 'gemini') throw error;
            const probes = await diagnoseGeminiRequest({
              apiKey: required('GEMINI_API_KEY'),
              configuredModel: model,
            });
            throw new Error(
              `Gemini gateway failure ${safeGatewayFailureSummary(error)}; safe probes: ${probes
                .map(
                  (probe) =>
                    `${probe.name}=${String(probe.status)}${
                      probe.shape === undefined ? '' : `[${probe.shape}]`
                    }`,
                )
                .join(', ')}`,
            );
          });
        expect(completion.choices[0]).toBeDefined();

        const toolCompletion = await client.chat.completions.create({
          model: `${providerCase.name}/${model}`,
          messages: [
            {
              role: 'user',
              content: 'Call return_status with status set to OK.',
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'return_status',
                description: 'Return a test status.',
                parameters: {
                  type: 'object',
                  properties: { status: { type: 'string' } },
                  required: ['status'],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: {
            type: 'function',
            function: { name: 'return_status' },
          },
          // Reasoning models count internal reasoning against this budget.
          // Keep the live probe bounded while leaving enough room for the
          // forced function call payload.
          max_tokens: 512,
        });
        const toolCall = toolCompletion.choices[0]?.message.tool_calls?.[0];
        if (toolCall?.type !== 'function') {
          throw new Error('provider did not return a function tool call');
        }
        expect(toolCall.function.name).toBe('return_status');
        expect(() => {
          void (JSON.parse(toolCall.function.arguments) as unknown);
        }).not.toThrow();

        const stream = await client.chat.completions.create({
          ...request,
          stream: true,
        });
        let chunks = 0;
        for await (const chunk of stream) {
          if (chunk.choices.length > 0) chunks += 1;
        }
        expect(chunks).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
  );
});
