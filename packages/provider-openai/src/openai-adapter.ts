import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { ProviderStreamFailure } from '@rax-digital/domain';
import type {
  CanonicalChatChunk,
  CanonicalChatRequest,
  ProviderAdapter,
  ProviderCallContext,
  ProviderCallResult,
  ProviderCapabilities,
  ProviderError,
  ProviderStreamCallResult,
} from '@rax-digital/domain';

const OpenAiUsageSchema = Type.Object({
  prompt_tokens: Type.Integer({ minimum: 0 }),
  completion_tokens: Type.Integer({ minimum: 0 }),
  total_tokens: Type.Integer({ minimum: 0 }),
});

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
  usage: OpenAiUsageSchema,
});

const OpenAiStreamChunkSchema = Type.Object({
  choices: Type.Array(
    Type.Object({
      index: Type.Literal(0),
      delta: Type.Object({
        role: Type.Optional(Type.Literal('assistant')),
        content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      finish_reason: Type.Union([
        Type.Literal('stop'),
        Type.Literal('length'),
        Type.Literal('tool_calls'),
        Type.Literal('content_filter'),
        Type.Null(),
      ]),
    }),
    { maxItems: 1 },
  ),
  usage: Type.Optional(Type.Union([OpenAiUsageSchema, Type.Null()])),
});

export interface OpenAiAdapterOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: Readonly<Record<string, ProviderCapabilities>>;
  readonly fetchImplementation?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly maxStreamEventBytes?: number;
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

function connectionError(signal: AbortSignal): ProviderError {
  return signal.aborted
    ? {
        class: 'timeout',
        code: 'provider_timeout',
        retryable: true,
      }
    : {
        class: 'unavailable',
        code: 'provider_connection_failed',
        retryable: true,
      };
}

class ProviderConnectTimeoutError extends Error {}

function connectTimeoutError(): ProviderError {
  return {
    class: 'timeout',
    code: 'provider_connect_timeout',
    retryable: true,
  };
}

async function fetchWithConnectTimeout(
  implementation: typeof fetch,
  input: string,
  init: RequestInit,
  context: ProviderCallContext,
): Promise<Response> {
  if (context.connectTimeoutMs === undefined) {
    return implementation(input, { ...init, signal: context.signal });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new ProviderConnectTimeoutError());
  }, context.connectTimeoutMs);
  timer.unref();
  try {
    return await implementation(input, {
      ...init,
      signal: AbortSignal.any([context.signal, controller.signal]),
    });
  } catch (error: unknown) {
    if (controller.signal.reason instanceof ProviderConnectTimeoutError) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Status classification remains valid when upstream cleanup fails.
  }
}

function requestBody(
  request: CanonicalChatRequest,
  providerModel: string,
  stream: boolean,
): string {
  return JSON.stringify({
    model: providerModel,
    messages: request.messages,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.maxTokens === undefined
      ? {}
      : { max_completion_tokens: request.maxTokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...(request.user === undefined ? {} : { user: request.user }),
    n: 1,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
}

type ParsedStreamEvent =
  | { readonly kind: 'chunk'; readonly chunk: CanonicalChatChunk }
  | { readonly kind: 'done' }
  | { readonly kind: 'ignored' };

function streamProtocolFailure(): ProviderStreamFailure {
  return new ProviderStreamFailure({
    class: 'protocol',
    code: 'provider_invalid_stream',
    retryable: true,
  });
}

function parseStreamEvent(event: string): ParsedStreamEvent {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  if (data.length === 0) {
    return { kind: 'ignored' };
  }
  if (data.trim() === '[DONE]') {
    return { kind: 'done' };
  }

  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw streamProtocolFailure();
  }
  if (!Value.Check(OpenAiStreamChunkSchema, value)) {
    throw streamProtocolFailure();
  }
  const choice = value.choices[0];
  const usage = value.usage;
  if (choice === undefined && (usage === undefined || usage === null)) {
    throw streamProtocolFailure();
  }
  return {
    kind: 'chunk',
    chunk: {
      ...(choice === undefined
        ? {}
        : {
            choice: {
              delta: {
                ...(choice.delta.role === undefined
                  ? {}
                  : { role: choice.delta.role }),
                ...(typeof choice.delta.content === 'string'
                  ? { content: choice.delta.content }
                  : {}),
              },
              finishReason: choice.finish_reason,
            },
          }),
      ...(usage === undefined || usage === null
        ? {}
        : {
            usage: {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            },
          }),
    },
  };
}

/** Direct-HTTP OpenAI adapter with bounded JSON and SSE parsing. */
export class OpenAiAdapter implements ProviderAdapter {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: Readonly<Record<string, ProviderCapabilities>>;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxStreamEventBytes: number;

  public constructor(options: OpenAiAdapterOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.models = options.models;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_097_152;
    this.maxStreamEventBytes = options.maxStreamEventBytes ?? 1_048_576;
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
      response = await fetchWithConnectTimeout(
        this.fetchImplementation,
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            'x-request-id': context.requestId,
          },
          body: requestBody(request, context.providerModel, false),
        },
        context,
      );
    } catch (error: unknown) {
      return {
        ok: false,
        error:
          error instanceof ProviderConnectTimeoutError
            ? connectTimeoutError()
            : connectionError(context.signal),
      };
    }

    if (!response.ok) {
      await cancelResponse(response);
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

  public async streamChatCompletion(
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): Promise<ProviderStreamCallResult> {
    const capabilities = this.capabilities(context.providerModel);
    if (capabilities?.streaming !== true) {
      return {
        ok: false,
        error: {
          class: 'request',
          code: 'provider_streaming_not_configured',
          retryable: false,
        },
      };
    }

    let response: Response;
    try {
      response = await fetchWithConnectTimeout(
        this.fetchImplementation,
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: 'text/event-stream',
            'content-type': 'application/json',
            'x-request-id': context.requestId,
          },
          body: requestBody(request, context.providerModel, true),
        },
        context,
      );
    } catch (error: unknown) {
      return {
        ok: false,
        error:
          error instanceof ProviderConnectTimeoutError
            ? connectTimeoutError()
            : connectionError(context.signal),
      };
    }
    if (!response.ok) {
      await cancelResponse(response);
      return { ok: false, error: statusError(response) };
    }
    if (
      response.body === null ||
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
    ) {
      await cancelResponse(response);
      return this.streamProtocolError();
    }
    return {
      ok: true,
      stream: this.parseEventStream(response.body, context.signal),
    };
  }

  private async *parseEventStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalChatChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let sourceEnded = false;
    try {
      for (;;) {
        const read = await reader.read().catch(() => {
          throw new ProviderStreamFailure(connectionError(signal));
        });
        if (read.done) {
          sourceEnded = true;
          try {
            buffer += decoder.decode();
          } catch {
            throw streamProtocolFailure();
          }
          break;
        }
        try {
          buffer += decoder.decode(read.value, { stream: true });
        } catch {
          throw streamProtocolFailure();
        }
        for (;;) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (separator?.index === undefined) {
            break;
          }
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          if (Buffer.byteLength(event, 'utf8') > this.maxStreamEventBytes) {
            throw streamProtocolFailure();
          }
          const parsed = parseStreamEvent(event);
          if (parsed.kind === 'done') {
            return;
          }
          if (parsed.kind === 'chunk') {
            yield parsed.chunk;
          }
        }
        if (Buffer.byteLength(buffer, 'utf8') > this.maxStreamEventBytes) {
          throw streamProtocolFailure();
        }
      }

      if (buffer.trim().length > 0) {
        if (Buffer.byteLength(buffer, 'utf8') > this.maxStreamEventBytes) {
          throw streamProtocolFailure();
        }
        const parsed = parseStreamEvent(buffer);
        if (parsed.kind === 'done') {
          return;
        }
        if (parsed.kind === 'chunk') {
          yield parsed.chunk;
        }
      }
      throw streamProtocolFailure();
    } finally {
      if (!sourceEnded) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best-effort after the typed stream failure.
        }
      }
      reader.releaseLock();
    }
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

  private streamProtocolError(): ProviderStreamCallResult {
    return {
      ok: false,
      error: {
        class: 'protocol',
        code: 'provider_invalid_stream',
        retryable: true,
      },
    };
  }
}
