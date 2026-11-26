import { parsePolicyConfig } from '@rax-digital/config';
import type {
  ProviderAdapter,
  ProviderCapabilities,
} from '@rax-digital/domain';
import { GeminiAdapter } from '@rax-digital/provider-gemini';
import { OpenAiAdapter } from '@rax-digital/provider-openai';

import { buildEvaluationGateway } from './agent-failover.js';
import {
  decode,
  firstRecord,
  matchesPilotDecision,
  pilotAlias,
  pilotRequest,
  record,
} from './agent-pilot-contract.js';

export type PilotCase = 'gemini_primary' | 'openai_after_injected_429';

interface Credentials {
  readonly model: string;
  readonly apiKey: string;
}

interface PilotSettings {
  readonly gemini: Credentials;
  readonly openai: Credentials;
}

const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta';
const openaiUrl = 'https://api.openai.com/v1';

const capabilities: ProviderCapabilities = {
  chat: true,
  streaming: false,
  tools: false,
  jsonObject: false,
  jsonSchema: true,
  systemMessages: true,
};

function pilotPolicy(settings: PilotSettings) {
  return parsePolicyConfig(
    JSON.stringify({
      version: 1,
      providers: {
        'gemini-primary': {
          adapter: 'gemini',
          credential_env: 'GEMINI_API_KEY',
          base_url: geminiUrl,
          models: {
            [settings.gemini.model]: { capabilities: ['chat', 'json_schema'] },
          },
        },
        'openai-backup': {
          adapter: 'openai',
          credential_env: 'OPENAI_API_KEY',
          base_url: openaiUrl,
          models: {
            [settings.openai.model]: { capabilities: ['chat', 'json_schema'] },
          },
        },
      },
      aliases: {
        [pilotAlias]: {
          candidates: [
            {
              provider: 'gemini-primary',
              model: settings.gemini.model,
              weight: 100,
            },
            {
              provider: 'openai-backup',
              model: settings.openai.model,
              weight: 0,
            },
          ],
        },
      },
      routing: {
        max_attempts: 2,
        total_timeout_ms: 45_000,
        connect_timeout_ms: 25_000,
        same_route_retries: 0,
        minimum_attempt_budget_ms: 2_000,
        retry_base_delay_ms: 0,
      },
    }),
    'test',
  );
}

/** At most one paid request per case, only to that case's expected provider. */
export async function runAgentPilotProbe(
  scenario: PilotCase,
  settings: PilotSettings,
  transport: typeof fetch,
) {
  for (const provider of [settings.gemini, settings.openai]) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider.model) ||
      provider.apiKey.trim() === ''
    ) {
      throw new Error(
        'Provide a bare model ID and a non-empty key for each pilot provider.',
      );
    }
  }

  const expectedProvider = scenario === 'gemini_primary' ? 'gemini' : 'openai';
  const expectedModel = settings[expectedProvider].model;
  const expectedUrl =
    expectedProvider === 'gemini'
      ? `${geminiUrl}/models/${encodeURIComponent(expectedModel)}:generateContent`
      : `${openaiUrl}/chat/completions`;
  let paidAttempts = 0;
  let injected429s = 0;
  let blockedAttempts = 0;
  const guardedTransport: typeof fetch = async (input, init) => {
    if (
      input !== expectedUrl ||
      init?.method !== 'POST' ||
      paidAttempts !== 0
    ) {
      blockedAttempts += 1;
      return new Response(null, { status: 503 });
    }
    paidAttempts += 1;
    return transport(input, { ...init, redirect: 'error' });
  };
  const adapters = new Map<string, ProviderAdapter>([
    [
      'gemini-primary',
      new GeminiAdapter({
        id: 'gemini-primary',
        baseUrl: geminiUrl,
        apiKey: settings.gemini.apiKey,
        models: { [settings.gemini.model]: capabilities },
        fetchImplementation:
          expectedProvider === 'gemini'
            ? guardedTransport
            : () => {
                injected429s += 1;
                return Promise.resolve(new Response(null, { status: 429 }));
              },
      }),
    ],
    [
      'openai-backup',
      new OpenAiAdapter({
        id: 'openai-backup',
        baseUrl: openaiUrl,
        apiKey: settings.openai.apiKey,
        models: { [settings.openai.model]: capabilities },
        fetchImplementation: guardedTransport,
      }),
    ],
  ]);
  const { app, credential } = await buildEvaluationGateway(
    pilotPolicy(settings),
    adapters,
  );

  try {
    const result = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${credential}` },
      payload: pilotRequest,
    });
    const body = record(decode(result.body));
    const route = record(body.rax);
    const choice = firstRecord(body.choices);
    const usage = record(body.usage);
    const checks = {
      expected_route:
        body.model === pilotAlias &&
        route.provider === expectedProvider &&
        route.provider_model === expectedModel &&
        route.attempts === (expectedProvider === 'gemini' ? 1 : 2),
      matching_request_id:
        typeof result.headers['x-request-id'] === 'string' &&
        result.headers['x-request-id'] === route.request_id,
      expected_decision:
        choice.finish_reason === 'stop' &&
        matchesPilotDecision(record(choice.message).content),
      token_usage_reported: [
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.total_tokens,
      ].every(
        (count) =>
          typeof count === 'number' && Number.isSafeInteger(count) && count > 0,
      ),
      bounded_transport:
        paidAttempts === 1 &&
        blockedAttempts === 0 &&
        injected429s === (expectedProvider === 'gemini' ? 0 : 1),
    };
    // Case, status and booleans only. Never echo provider output or credentials.
    return {
      scenario,
      http_status: result.statusCode,
      passed: result.statusCode === 200 && Object.values(checks).every(Boolean),
      checks,
    };
  } finally {
    await app.close();
  }
}
