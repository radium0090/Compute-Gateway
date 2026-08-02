import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type {
  CanonicalChatChunk,
  CanonicalChatRequest,
  ProviderAdapter,
  ProviderCallContext,
  ProviderCallResult,
  ProviderCapabilities,
  ProviderError,
} from '@genchi/domain';

const OpenAiResponseSchema = Type.Object({
  choices: Type.Array(
    Type.Object({
      message: Type.Object({
        role: Type.Literal('assistant'),
        content: Type.String(),
      }),
      finish_reason: Type.Union([
        Type.Literal('stop'),
        Type.Literal('length'),
        Type.Literal('tool_calls'),
        Type.Literal('content_filter'),
        Type.Null(),
      ]),
    }),
    { minItems: 1 },
  ),
  usage: Type.Object({
    prompt_tokens: Type.Integer({ minimum: 0 }),
    completion_tokens: Type.Integer({ minimum: 0 }),
    total_tokens: Type.Integer({ minimum: 0 }),
  }),
});

export interface OpenAiAdapterOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: Readonly<Record<string, ProviderCapabilities>>;
  readonly fetchImplementation?: typeof fetch;
  readonly maxResponseBytes?: number;
}

const invalidBody = Symbol('invalid-provider-body');

async function readJsonBounded(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (response.body === null) {
    return invalidBody;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) {
        return invalidBody;
      }
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return invalidBody;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return invalidBody;
  } finally {
    reader.releaseLock();
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function statusError(response: Response): ProviderError {
  const retryAfter = retryAfterSeconds(response);
  if (response.status === 401 || response.status === 403) {
    return {
      class: 'authentication',
      code: 'provider_authentication_failed',
      retryable: false,
    };
  }
  if (response.status === 429) {
    return {
      class: 'rate_limit',
      code: 'provider_rate_limited',
      retryable: true,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    };
  }
  if (response.status >= 500) {
    return {
      class: 'unavailable',
      code: 'provider_unavailable',
      retryable: true,
    };
  }
  return {
    class: 'request',
    code: 'provider_rejected_request',
    retryable: false,
  };
}

/** Direct-HTTP OpenAI adapter for the non-streaming vertical slice. */
export class OpenAiAdapter implements ProviderAdapter {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: Readonly<Record<string, ProviderCapabilities>>;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxResponseBytes: number;

  public constructor(options: OpenAiAdapterOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.models = options.models;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_097_152;
  }

  public capabilities(model: string): ProviderCapabilities | null {
    return this.models[model] ?? null;
  }

  public async createChatCompletion(
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): Promise<ProviderCallResult> {
    if (this.capabilities(context.providerModel) === null) {
      return {
        ok: false,
        error: {
          class: 'request',
          code: 'provider_model_not_configured',
          retryable: false,
        },
      };
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            'x-request-id': context.requestId,
          },
          body: JSON.stringify({
            model: context.providerModel,
            messages: request.messages,
            ...(request.temperature === undefined
              ? {}
              : { temperature: request.temperature }),
            ...(request.topP === undefined ? {} : { top_p: request.topP }),
            ...(request.maxTokens === undefined
              ? {}
              : { max_tokens: request.maxTokens }),
            ...(request.stop === undefined ? {} : { stop: request.stop }),
            ...(request.user === undefined ? {} : { user: request.user }),
            n: 1,
            stream: false,
          }),
          signal: context.signal,
        },
      );
    } catch {
      return {
        ok: false,
        error: context.signal.aborted
          ? {
              class: 'timeout',
              code: 'provider_timeout',
              retryable: true,
            }
          : {
              class: 'unavailable',
              code: 'provider_connection_failed',
              retryable: true,
            },
      };
    }

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The typed status classification remains valid if cancellation fails.
      }
      return { ok: false, error: statusError(response) };
    }

    const body = await readJsonBounded(response, this.maxResponseBytes);
    if (body === invalidBody) {
      return this.protocolError();
    }
    if (!Value.Check(OpenAiResponseSchema, body)) {
      return this.protocolError();
    }

    const firstChoice = body.choices[0];
    if (firstChoice === undefined) {
      return this.protocolError();
    }
    return {
      ok: true,
      response: {
        content: firstChoice.message.content,
        finishReason: firstChoice.finish_reason,
        usage: {
          promptTokens: body.usage.prompt_tokens,
          completionTokens: body.usage.completion_tokens,
          totalTokens: body.usage.total_tokens,
        },
      },
    };
  }

  public streamChatCompletion(
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): AsyncIterable<CanonicalChatChunk> {
    void request;
    void context;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject(
            new Error('Streaming is not implemented in the vertical slice'),
          ),
      }),
    };
  }

  private protocolError(): ProviderCallResult {
    return {
      ok: false,
      error: {
        class: 'protocol',
        code: 'provider_invalid_response',
        retryable: true,
      },
    };
  }
}
