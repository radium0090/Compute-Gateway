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
    weight: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/** Versioned route policy shape. Foundation validates but does not execute it. */
export const PolicyConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    providers: Type.Record(Type.String({ minLength: 1 }), ProviderSchema),
    aliases: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object(
        {
          candidates: Type.Array(CandidateSchema, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    routing: Type.Object(
      {
        max_attempts: Type.Integer({ minimum: 1, maximum: 10 }),
        total_timeout_ms: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
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
      for (const route of alias.candidates) {
        if (candidate.providers[route.provider] === undefined) {
          issues.push(`alias ${aliasName} references an unknown provider`);
        }
      }
    }
  }

  if (issues.length > 0 || !Value.Check(PolicyConfigSchema, candidate)) {
    throw new PolicyConfigValidationError([...new Set(issues)]);
  }

  return candidate;
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
