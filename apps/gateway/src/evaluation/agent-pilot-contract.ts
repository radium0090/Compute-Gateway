import type { ChatCompletionRequest } from '@rax-digital/api-contract';

export const pilotAlias = 'rax/agent';
export const pilotExpected = { outcome: 'review' } as const;
export const pilotSchema = {
  type: 'object',
  properties: { outcome: { type: 'string', enum: ['review', 'routine'] } },
  required: ['outcome'],
  additionalProperties: false,
} as const;

export const pilotRequest: ChatCompletionRequest = {
  model: pilotAlias,
  messages: [
    {
      role: 'user',
      content:
        'Order DEMO-1042 was charged twice. Label billing disputes as review and other cases as routine. Return only the JSON object.',
    },
  ],
  max_tokens: 512,
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'decision', strict: true, schema: pilotSchema },
  },
};

export type JsonRecord = Readonly<Record<string, unknown>>;

export function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function decode(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function firstRecord(value: unknown): JsonRecord {
  return record(Array.isArray(value) ? value[0] : undefined);
}

/** Verify the expected decision, not just that the model emitted valid JSON. */
export function matchesPilotDecision(value: unknown): boolean {
  const result = record(decode(value));
  return (
    Object.keys(result).length === 1 && result.outcome === pilotExpected.outcome
  );
}
