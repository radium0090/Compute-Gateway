import { readFile } from 'node:fs/promises';

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parseDocument } from 'yaml';

import type { RuntimeConfig } from './config.js';

const CapabilitySchema = Type.Union([
  Type.Literal('chat'),
  Type.Literal('streaming'),
  Type.Literal('tools'),
  Type.Literal('json_schema'),
]);

const ProviderSchema = Type.Object(
  {
    adapter: Type.Union([
      Type.Literal('openai'),
      Type.Literal('anthropic'),
      Type.Literal('gemini'),
    ]),
    credential_env: Type.String({ pattern: '^[A-Z][A-Z0-9_]*$' }),
    base_url: Type.String({ minLength: 1 }),
    models: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object(
        {
          capabilities: Type.Array(CapabilitySchema, { uniqueItems: true }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const CandidateSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    weight: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);

/** Versioned provider and routing policy shape. */
export const PolicyConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    providers: Type.Record(Type.String({ minLength: 1 }), ProviderSchema),
    aliases: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object(
        {
          candidates: Type.Array(CandidateSchema, {
            minItems: 1,
            maxItems: 64,
          }),
          required_capabilities: Type.Optional(
            Type.Array(CapabilitySchema, { uniqueItems: true }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    routing: Type.Object(
      {
        max_attempts: Type.Integer({ minimum: 1, maximum: 10 }),
        total_timeout_ms: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
        connect_timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
        same_route_retries: Type.Optional(Type.Integer({ minimum: 0 })),
        minimum_attempt_budget_ms: Type.Optional(Type.Integer({ minimum: 1 })),
        retry_base_delay_ms: Type.Optional(Type.Integer({ minimum: 0 })),
        global_max_concurrent_calls: Type.Optional(
          Type.Integer({ minimum: 1 }),
        ),
        provider_max_concurrent_calls: Type.Optional(
          Type.Integer({ minimum: 1 }),
        ),
        circuit: Type.Optional(
          Type.Object(
            {
              failure_threshold: Type.Integer({ minimum: 1 }),
              rolling_window_ms: Type.Integer({ minimum: 1_000 }),
              open_duration_ms: Type.Integer({ minimum: 1_000 }),
              half_open_max_calls: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type PolicyConfig = Static<typeof PolicyConfigSchema>;

export class PolicyConfigValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Policy configuration validation failed: ${issues.join('; ')}`);
    this.name = 'PolicyConfigValidationError';
  }
}

function validUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Parses a policy without including source values in validation errors. */
export function parsePolicyConfig(
  contents: string,
  environment: RuntimeConfig['environment'],
): PolicyConfig {
  const document = parseDocument(contents, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PolicyConfigValidationError(['YAML syntax is invalid']);
  }

  const candidate: unknown = document.toJS();
  const issues = [...Value.Errors(PolicyConfigSchema, candidate)].map(
    (error) => `setting at ${error.path || '/'} is invalid`,
  );

  if (Value.Check(PolicyConfigSchema, candidate)) {
    if (
      candidate.routing.connect_timeout_ms !== undefined &&
      candidate.routing.connect_timeout_ms >= candidate.routing.total_timeout_ms
    ) {
      issues.push('routing connect timeout must be less than total timeout');
    }
    if (
      candidate.routing.minimum_attempt_budget_ms !== undefined &&
      candidate.routing.minimum_attempt_budget_ms >
        candidate.routing.total_timeout_ms
    ) {
      issues.push('routing minimum attempt budget exceeds total timeout');
    }
    if (
      (candidate.routing.same_route_retries ?? 0) >=
      candidate.routing.max_attempts
    ) {
      issues.push('routing same-route retries must be less than max attempts');
    }
    for (const [providerName, provider] of Object.entries(
      candidate.providers,
    )) {
      const url = validUrl(provider.base_url);
      if (url === null || !['http:', 'https:'].includes(url.protocol)) {
        issues.push(`provider ${providerName} base_url is invalid`);
      } else if (environment === 'production' && url.protocol !== 'https:') {
        issues.push(
          `provider ${providerName} base_url must use HTTPS in production`,
        );
      }
    }

    for (const [aliasName, alias] of Object.entries(candidate.aliases)) {
      const seenRoutes = new Set<string>();
      for (const route of alias.candidates) {
        if (candidate.providers[route.provider] === undefined) {
          issues.push(`alias ${aliasName} references an unknown provider`);
          continue;
        }
        if (
          candidate.providers[route.provider]?.models[route.model] === undefined
        ) {
          issues.push(
            `alias ${aliasName} references an unknown provider model`,
          );
        }
        const routeKey = `${route.provider}\u0000${route.model}`;
        if (seenRoutes.has(routeKey)) {
          issues.push(`alias ${aliasName} contains a duplicate route`);
        }
        seenRoutes.add(routeKey);
      }
      if (!alias.candidates.some((route) => route.weight > 0)) {
        issues.push(`alias ${aliasName} has no primary candidate`);
      }
      const requiredCapabilities = alias.required_capabilities ?? [];
      const hasCapableCandidate = alias.candidates.some((route) => {
        const capabilities =
          candidate.providers[route.provider]?.models[route.model]
            ?.capabilities;
        return requiredCapabilities.every(
          (capability) => capabilities?.includes(capability) === true,
        );
      });
      if (!hasCapableCandidate) {
        issues.push(
          `alias ${aliasName} has no candidate for all required capabilities`,
        );
      }
    }
  }

  if (issues.length > 0 || !Value.Check(PolicyConfigSchema, candidate)) {
    throw new PolicyConfigValidationError([...new Set(issues)]);
  }

  return candidate;
}

/** Resolves logical credential references without exposing values in errors. */
export function loadProviderCredentials(
  policy: PolicyConfig,
  source: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string> {
  const credentials = new Map<string, string>();
  const issues: string[] = [];
  for (const [providerName, provider] of Object.entries(policy.providers)) {
    const value = source[provider.credential_env];
    if (value === undefined || value.length === 0) {
      issues.push(`provider ${providerName} credential is not set`);
    } else {
      credentials.set(providerName, value);
    }
  }
  if (issues.length > 0) {
    throw new PolicyConfigValidationError(issues);
  }
  return credentials;
}

/** Loads and validates the versioned policy before the listener is opened. */
export async function loadPolicyConfig(
  path: string,
  environment: RuntimeConfig['environment'],
): Promise<PolicyConfig> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new PolicyConfigValidationError(['policy file cannot be read']);
  }
  return parsePolicyConfig(contents, environment);
}
