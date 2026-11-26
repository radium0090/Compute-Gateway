import { createHash } from 'node:crypto';

import type { ChatCompletionRequest } from '@rax-digital/api-contract';
import { CreateChatCompletionService } from '@rax-digital/application';
import { ApiKeyAuthenticator, provisionApiKey } from '@rax-digital/auth';
import {
  loadConfig,
  parsePolicyConfig,
  type PolicyConfig,
} from '@rax-digital/config';
import {
  apiKeyId,
  tenantId,
  type ProviderAdapter,
  type ProviderCapabilities,
} from '@rax-digital/domain';
import { createLogger } from '@rax-digital/observability';
import { GeminiAdapter } from '@rax-digital/provider-gemini';
import { OpenAiAdapter } from '@rax-digital/provider-openai';
import {
  InMemoryCircuitBreaker,
  InMemoryCoordination,
  StaticPolicyRouter,
} from '@rax-digital/router';

import { buildGateway } from '../app.js';

const alias = 'rax/agent';
const policySource = `
version: 1
providers:
  gemini-primary:
    adapter: gemini
    credential_env: GEMINI_API_KEY
    base_url: https://gemini.invalid/v1beta
    models:
      gemini-fixture: { capabilities: [chat, tools, streaming, json_schema] }
      chat-only-fixture: { capabilities: [chat] }
  openai-backup:
    adapter: openai
    credential_env: OPENAI_API_KEY
    base_url: https://openai.invalid/v1
    models:
      openai-fixture: { capabilities: [chat, tools, streaming, json_schema] }
aliases:
  rax/agent:
    candidates:
      - { provider: gemini-primary, model: gemini-fixture, weight: 100 }
      - { provider: gemini-primary, model: chat-only-fixture, weight: 0 }
      - { provider: openai-backup, model: openai-fixture, weight: 0 }
routing:
  max_attempts: 2
  same_route_retries: 0
  total_timeout_ms: 5000
  connect_timeout_ms: 1000
  minimum_attempt_budget_ms: 100
  retry_base_delay_ms: 0
`;
const defaultPolicy = parsePolicyConfig(policySource, 'test');

function casePolicy(ineligible: boolean): PolicyConfig {
  if (!ineligible) return defaultPolicy;
  // Use a valid alias that cannot fulfill this particular request.
  return {
    ...defaultPolicy,
    aliases: {
      [alias]: {
        candidates: [
          {
            provider: 'gemini-primary',
            model: 'chat-only-fixture',
            weight: 100,
          },
        ],
      },
    },
  };
}

const fixturePepper = 'fixture-only-local-key-hash-pepper';
const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://fixture:unused@database.invalid/gateway',
  RCG_KEY_HASH_PEPPER: fixturePepper,
});

const decisionSchema = {
  type: 'object',
  properties: { outcome: { type: 'string', enum: ['review'] } },
  required: ['outcome'],
  additionalProperties: false,
} as const;
const testTool = 'record_decision';
const syntheticDecision = { outcome: 'review' };

const toolRequest: ChatCompletionRequest = {
  model: alias,
  messages: [{ role: 'user', content: 'Classify the synthetic pilot case.' }],
  tools: [
    {
      type: 'function',
      function: { name: testTool, parameters: decisionSchema },
    },
  ],
  tool_choice: 'required',
};
const schemaRequest: ChatCompletionRequest = {
  model: alias,
  messages: toolRequest.messages,
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'decision', strict: true, schema: decisionSchema },
  },
};

type FixtureProvider = 'gemini' | 'openai';
type CaseId =
  | 'healthy_primary'
  | 'rate_limited_tool_fallback'
  | 'structured_output_fallback'
  | 'no_eligible_route'
  | 'interrupted_stream';

interface ReportCase {
  readonly id: CaseId;
  readonly passed: boolean;
  readonly gateway_status: number;
  readonly upstream_calls: readonly FixtureProvider[];
  readonly fixture_policy_sha256: string;
  readonly route: RouteEvidence | null;
  readonly token_usage: TokenUsage | null;
  readonly stream_completed: boolean | null;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
  }[];
}

interface RouteEvidence {
  readonly provider: FixtureProvider;
  readonly model: 'gemini-fixture' | 'openai-fixture';
  readonly attempts: number;
}

interface TokenUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface AgentFailoverReport {
  readonly schema_version: 1;
  readonly mode: 'offline_fixture';
  readonly profile: 'gemini-primary-openai-backup';
  readonly model_alias: typeof alias;
  readonly passed: boolean;
  readonly cases: readonly ReportCase[];
}

type JsonRecord = Readonly<Record<string, unknown>>;
type Check = (name: string, passed: boolean) => void;

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function firstRecord(value: unknown): JsonRecord {
  return record(Array.isArray(value) ? value[0] : undefined);
}

function carriesDecisionSchema(value: unknown): boolean {
  const schema = record(value);
  const outcome = record(record(schema.properties).outcome);
  return (
    schema.type === 'object' &&
    schema.additionalProperties === false &&
    Array.isArray(schema.required) &&
    schema.required.length === 1 &&
    schema.required[0] === 'outcome' &&
    Object.keys(record(schema.properties)).length === 1 &&
    outcome.type === 'string' &&
    Array.isArray(outcome.enum) &&
    outcome.enum.length === 1 &&
    outcome.enum[0] === 'review'
  );
}

/** Verify the exact one-field contract; do not include the value in evidence. */
export function matchesDecision(value: unknown): boolean {
  const result = record(decode(value));
  return Object.keys(result).length === 1 && result.outcome === 'review';
}

function matchingTool(choice: JsonRecord): boolean {
  const calls = record(choice.message).tool_calls;
  const tool = firstRecord(calls);
  const fn = record(tool.function);
  return (
    choice.finish_reason === 'tool_calls' &&
    Array.isArray(calls) &&
    calls.length === 1 &&
    tool.type === 'function' &&
    typeof tool.id === 'string' &&
    tool.id.length > 0 &&
    fn.name === testTool &&
    matchesDecision(fn.arguments)
  );
}

function matchingRoute(
  response: JsonRecord,
  provider: FixtureProvider,
  attempts: number,
  requestId: unknown,
): boolean {
  const route = record(response.rax);
  return (
    response.model === alias &&
    route.provider === provider &&
    route.provider_model === `${provider}-fixture` &&
    route.attempts === attempts &&
    typeof requestId === 'string' &&
    route.request_id === requestId
  );
}

function routeEvidence(response: JsonRecord): RouteEvidence | null {
  const { provider, provider_model: model, attempts } = record(response.rax);
  if (
    (provider !== 'gemini' && provider !== 'openai') ||
    (model !== 'gemini-fixture' && model !== 'openai-fixture') ||
    typeof attempts !== 'number' ||
    !Number.isSafeInteger(attempts)
  )
    return null;
  return { provider, model, attempts };
}

function tokenEvidence(response: JsonRecord): TokenUsage | null {
  const { prompt_tokens, completion_tokens, total_tokens } = record(
    response.usage,
  );
  if (
    typeof prompt_tokens !== 'number' ||
    typeof completion_tokens !== 'number' ||
    typeof total_tokens !== 'number' ||
    ![prompt_tokens, completion_tokens, total_tokens].every(
      Number.isSafeInteger,
    )
  )
    return null;
  return { prompt_tokens, completion_tokens, total_tokens };
}

const geminiTool = {
  functionCall: { id: 'fixture_call', name: testTool, args: syntheticDecision },
};
const geminiCandidate = {
  content: { role: 'model', parts: [geminiTool] },
};
const fixtureUsage = {
  prompt_tokens: 8,
  completion_tokens: 3,
  total_tokens: 11,
};

function geminiStreamWithoutTerminator(): Response {
  // The provider sends its first event and disconnects without a finish reason.
  const data = JSON.stringify({ candidates: [geminiCandidate] });
  return new Response(`data: ${data}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fixtureAdapters(
  id: CaseId,
  calls: FixtureProvider[],
  check: Check,
): ReadonlyMap<string, ProviderAdapter> {
  const structured = id === 'structured_output_fallback';
  const interrupted = id === 'interrupted_stream';
  const capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    tools: true,
    jsonObject: false,
    jsonSchema: true,
    systemMessages: true,
  };
  return new Map<string, ProviderAdapter>([
    [
      'gemini-primary',
      new GeminiAdapter({
        id: 'gemini-primary',
        baseUrl: 'https://gemini.invalid/v1beta',
        apiKey: 'offline-gemini-fixture',
        models: {
          'gemini-fixture': capabilities,
          'chat-only-fixture': {
            ...capabilities,
            tools: false,
            streaming: false,
            jsonSchema: false,
          },
        },
        fetchImplementation: (url, init) => {
          calls.push('gemini');
          const body = record(decode(init?.body));
          const endpoint = interrupted
            ? 'streamGenerateContent?alt=sse'
            : 'generateContent';
          check(
            'Gemini request uses the intended model and endpoint',
            url ===
              `https://gemini.invalid/v1beta/models/gemini-fixture:${endpoint}`,
          );
          const generation = record(body.generationConfig);
          const fn = firstRecord(firstRecord(body.tools).functionDeclarations);
          const functionCalling = record(
            record(body.toolConfig).functionCallingConfig,
          );
          check(
            'Gemini receives the requested capability',
            structured
              ? generation.responseMimeType === 'application/json' &&
                  carriesDecisionSchema(generation.responseJsonSchema)
              : fn.name === testTool &&
                  carriesDecisionSchema(fn.parametersJsonSchema) &&
                  functionCalling.mode === 'ANY',
          );
          if (interrupted)
            return Promise.resolve(geminiStreamWithoutTerminator());
          if (id !== 'healthy_primary') {
            return Promise.resolve(new Response(null, { status: 429 }));
          }
          return Promise.resolve(
            Response.json({
              candidates: [{ ...geminiCandidate, finishReason: 'STOP' }],
              usageMetadata: {
                promptTokenCount: 8,
                candidatesTokenCount: 3,
                totalTokenCount: 11,
              },
            }),
          );
        },
      }),
    ],
    [
      'openai-backup',
      new OpenAiAdapter({
        id: 'openai-backup',
        baseUrl: 'https://openai.invalid/v1',
        apiKey: 'offline-openai-fixture',
        models: { 'openai-fixture': capabilities },
        fetchImplementation: (url, init) => {
          calls.push('openai');
          const body = record(decode(init?.body));
          check(
            'OpenAI request uses the intended model and endpoint',
            url === 'https://openai.invalid/v1/chat/completions' &&
              body.model === 'openai-fixture',
          );
          const format = record(body.response_format);
          const schema = record(format.json_schema);
          const fn = record(firstRecord(body.tools).function);
          check(
            'OpenAI receives the requested capability',
            structured
              ? format.type === 'json_schema' &&
                  schema.name === 'decision' &&
                  schema.strict === true &&
                  carriesDecisionSchema(schema.schema)
              : fn.name === testTool &&
                  carriesDecisionSchema(fn.parameters) &&
                  body.tool_choice === 'required',
          );
          return Promise.resolve(
            Response.json({
              choices: [
                {
                  message: structured
                    ? {
                        role: 'assistant',
                        content: JSON.stringify(syntheticDecision),
                      }
                    : {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                          {
                            id: 'fixture_call',
                            type: 'function',
                            function: {
                              name: testTool,
                              arguments: JSON.stringify(syntheticDecision),
                            },
                          },
                        ],
                      },
                  finish_reason: structured ? 'stop' : 'tool_calls',
                },
              ],
              usage: fixtureUsage,
            }),
          );
        },
      }),
    ],
  ]);
}

async function fixtureGateway(
  policy: PolicyConfig,
  adapters: ReadonlyMap<string, ProviderAdapter>,
) {
  const { credential, apiKey } = provisionApiKey(
    {
      id: apiKeyId('00000000-0000-4000-8000-000000000001'),
      tenantId: tenantId('00000000-0000-4000-8000-000000000002'),
      name: 'Offline fixture',
      environment: 'test',
      policy: {
        allowedModelPatterns: [alias],
        allowStreaming: true,
        allowTools: true,
        requestsPerMinute: 10,
        maxConcurrentRequests: 1,
      },
      pepper: fixturePepper,
    },
    new Date(),
  );
  const authenticator = new ApiKeyAuthenticator(
    {
      create: () =>
        Promise.reject(new Error('fixture repository is read-only')),
      findByPublicId: (id) =>
        Promise.resolve(id === apiKey.publicId ? apiKey : null),
      markLastUsed: () => Promise.resolve(),
      revoke: () =>
        Promise.reject(new Error('fixture repository is read-only')),
    },
    fixturePepper,
    'test',
    () => new Date(),
  );

  const coordination = new InMemoryCoordination();
  const app = await buildGateway({
    config,
    // Even if a route logs an internal error, stdout is reserved for the report.
    logger: createLogger({
      environment: 'test',
      level: 'error',
      destination: { write: () => undefined },
    }),
    readinessProbe: { check: () => Promise.resolve({ ready: true }) },
    chatCompletionService: new CreateChatCompletionService(
      authenticator,
      new StaticPolicyRouter(policy),
      adapters,
      {
        requestAdmission: coordination,
        providerConcurrency: coordination,
        circuitBreaker: new InMemoryCircuitBreaker({
          failureThreshold: 5,
          rollingWindowMs: 30_000,
          openDurationMs: 30_000,
          halfOpenMaxCalls: 1,
        }),
        policy: {
          maxAttempts: policy.routing.max_attempts,
          sameRouteRetries: policy.routing.same_route_retries ?? 0,
          connectTimeoutMs: policy.routing.connect_timeout_ms ?? 1000,
          totalTimeoutMs: policy.routing.total_timeout_ms,
          minimumAttemptBudgetMs:
            policy.routing.minimum_attempt_budget_ms ?? 100,
          retryBaseDelayMs: 0,
          globalMaxConcurrentCalls: 2,
          providerMaxConcurrentCalls: 1,
        },
      },
    ),
  });
  return { app, credential };
}

async function runCase(id: CaseId): Promise<ReportCase> {
  const ineligible = id === 'no_eligible_route';
  const structured = id === 'structured_output_fallback';
  const interrupted = id === 'interrupted_stream';
  const policy = casePolicy(ineligible);
  const calls: FixtureProvider[] = [];
  const checks: { name: string; passed: boolean }[] = [];
  const check: Check = (name, passed) => {
    checks.push({ name, passed });
  };
  const { app, credential } = await fixtureGateway(
    policy,
    fixtureAdapters(id, calls, check),
  );

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${credential}` },
      payload: structured
        ? schemaRequest
        : interrupted
          ? { ...toolRequest, stream: true }
          : toolRequest,
    });
    const result = record(decode(response.body));
    let route = routeEvidence(result);
    const usage = tokenEvidence(result);
    let streamCompleted: boolean | null = null;
    const fallback = id === 'rate_limited_tool_fallback' || structured;
    const expectedCalls = ineligible
      ? []
      : fallback
        ? ['gemini', 'openai']
        : ['gemini'];
    check(
      'Only expected upstream calls were made, in order',
      calls.length === expectedCalls.length &&
        calls.every((call, index) => call === expectedCalls[index]),
    );
    check(
      'Gateway returned the expected HTTP status',
      response.statusCode === (ineligible ? 503 : 200),
    );

    if (ineligible) {
      check(
        'Missing capability failed closed',
        record(result.error).code === 'no_healthy_route',
      );
    } else if (interrupted) {
      const events = response.body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data: '))
        .map((line) => record(decode(line.slice(6))));
      route = routeEvidence(record(events[0]));
      streamCompleted = response.body.includes('data: [DONE]');
      check(
        'Stream emitted a Gemini tool delta before disconnect',
        events.some((event) => {
          const delta = record(firstRecord(event.choices).delta);
          return (
            record(firstRecord(delta.tool_calls).function).name === testTool
          );
        }),
      );
      check(
        'Every emitted event stayed on the committed Gemini route',
        events.length > 0 &&
          events.every((event) =>
            matchingRoute(event, 'gemini', 1, response.headers['x-request-id']),
          ),
      );
      check(
        'Interrupted stream did not signal normal completion',
        !streamCompleted,
      );
    } else {
      const choice = firstRecord(result.choices);
      check(
        'Response identifies the winning model and attempt count',
        matchingRoute(
          result,
          fallback ? 'openai' : 'gemini',
          fallback ? 2 : 1,
          response.headers['x-request-id'],
        ),
      );
      check(
        structured
          ? 'Returned JSON matches the fixture schema'
          : 'Returned tool name and arguments match the fixture contract',
        structured
          ? choice.finish_reason === 'stop' &&
              matchesDecision(record(choice.message).content)
          : matchingTool(choice),
      );
      check(
        'Input, output and total token counts are normalized',
        usage?.prompt_tokens === fixtureUsage.prompt_tokens &&
          usage.completion_tokens === fixtureUsage.completion_tokens &&
          usage.total_tokens === fixtureUsage.total_tokens,
      );
    }
    return {
      id,
      passed: checks.every((entry) => entry.passed),
      gateway_status: response.statusCode,
      upstream_calls: calls,
      fixture_policy_sha256: createHash('sha256')
        .update(JSON.stringify(policy))
        .digest('hex'),
      route,
      token_usage: usage,
      stream_completed: streamCompleted,
      checks,
    };
  } finally {
    await app.close();
  }
}

/** Generate a safe, deterministic report without network or credential access. */
export async function runAgentFailoverReport(): Promise<AgentFailoverReport> {
  const cases = await Promise.all(
    (
      [
        'healthy_primary',
        'rate_limited_tool_fallback',
        'structured_output_fallback',
        'no_eligible_route',
        'interrupted_stream',
      ] as const
    ).map(runCase),
  );
  return {
    schema_version: 1,
    mode: 'offline_fixture',
    profile: 'gemini-primary-openai-backup',
    model_alias: alias,
    passed: cases.every((entry) => entry.passed),
    cases,
  };
}

export function formatAgentFailoverReport(report: AgentFailoverReport): string {
  function row(entry: ReportCase): string {
    const model =
      entry.route === null
        ? '—'
        : `${entry.route.model} / ${String(entry.route.attempts)}`;
    const columns = [
      `\`${entry.id}\``,
      entry.passed ? 'PASS' : 'FAIL',
      String(entry.gateway_status),
      entry.upstream_calls.join(' → ') || 'None',
      model,
    ];
    return `| ${columns.join(' | ')} |`;
  }

  return [
    '# Agent failover acceptance report',
    '',
    `**Result: ${report.passed ? 'PASS' : 'FAIL'}** · \`${report.profile}\` · \`${report.model_alias}\``,
    '',
    'Mode: offline fixtures. No provider network calls. Not a live-provider or customer acceptance result.',
    '',
    '| Scenario | Result | Gateway HTTP | Stub call order | Reported model / attempts |',
    '| --- | --- | --- | --- | --- |',
    ...report.cases.map(row),
    ...report.cases.flatMap((entry) => [
      '',
      `## ${entry.id}`,
      '',
      `Fixture policy SHA-256: \`${entry.fixture_policy_sha256}\``,
      ...(entry.token_usage === null
        ? []
        : [
            `Fixture tokens (input / output / total): ${String(entry.token_usage.prompt_tokens)} / ${String(entry.token_usage.completion_tokens)} / ${String(entry.token_usage.total_tokens)}`,
          ]),
      ...(entry.stream_completed === null
        ? []
        : [
            `Normal stream terminator present: ${entry.stream_completed ? 'yes' : 'no'}`,
          ]),
      '',
      ...entry.checks.map(
        (check) => `- [${check.passed ? 'x' : ' '}] ${check.name}`,
      ),
    ]),
    '',
  ].join('\n');
}
