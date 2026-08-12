import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { ProviderStreamFailure } from '@rax-digital/domain';
import type {
  CanonicalChatChunk,
  CanonicalChatRequest,
  CanonicalFinishReason,
  ProviderAdapter,
  ProviderCallContext,
  ProviderCallResult,
  ProviderCapabilities,
  ProviderError,
  ProviderStreamCallResult,
} from '@rax-digital/domain';

const UsageSchema = Type.Object({
  input_tokens: Type.Integer({ minimum: 0 }),
  output_tokens: Type.Integer({ minimum: 0 }),
  cache_creation_input_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cache_read_input_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
});

const ResponseSchema = Type.Object({
  role: Type.Literal('assistant'),
  content: Type.Array(
    Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  ),
  stop_reason: Type.String(),
  usage: UsageSchema,
});

export interface AnthropicAdapterOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: Readonly<Record<string, ProviderCapabilities>>;
  readonly fetchImplementation?: typeof fetch;
  readonly defaultMaxTokens?: number;
  readonly maxResponseBytes?: number;
  readonly maxStreamEventBytes?: number;
}

const invalidBody = Symbol('invalid-provider-body');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBounded(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (response.body === null) return invalidBody;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      const value: unknown = read.value;
      if (!(value instanceof Uint8Array)) return invalidBody;
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
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function statusError(response: Response): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return {
      class: 'authentication',
      code: 'provider_authentication_failed',
      retryable: false,
    };
  }
  if (response.status === 408 || response.status === 504) {
    return { class: 'timeout', code: 'provider_timeout', retryable: true };
  }
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
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
    ? { class: 'timeout', code: 'provider_timeout', retryable: true }
    : {
        class: 'unavailable',
        code: 'provider_connection_failed',
        retryable: true,
      };
}

class ProviderConnectTimeoutError extends Error {}

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

function connectTimeoutError(): ProviderError {
  return {
    class: 'timeout',
    code: 'provider_connect_timeout',
    retryable: true,
  };
}

function requestError(code: string): ProviderError {
  return { class: 'request', code, retryable: false };
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup is best-effort and must not replace the classified error.
  }
}

function finishReason(value: string | null): CanonicalFinishReason {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case null:
      return null;
    default:
      return null;
  }
}

function promptTokens(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function buildRequestBody(
  request: CanonicalChatRequest,
  providerModel: string,
  stream: boolean,
  defaultMaxTokens: number,
): { readonly ok: true; readonly body: string } | { readonly ok: false } {
  if (request.temperature !== undefined && request.temperature > 1) {
    return { ok: false };
  }
  const system: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  let conversationStarted = false;
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (conversationStarted) return { ok: false };
      system.push(message.content);
    } else {
      conversationStarted = true;
      messages.push({ role: message.role, content: message.content });
    }
  }
  if (messages.length === 0) return { ok: false };

  return {
    ok: true,
    body: JSON.stringify({
      model: providerModel,
      max_tokens: request.maxTokens ?? defaultMaxTokens,
      messages,
      ...(system.length === 0 ? {} : { system: system.join('\n\n') }),
      ...(request.temperature === undefined
        ? {}
        : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.stop === undefined
        ? {}
        : {
            stop_sequences:
              typeof request.stop === 'string' ? [request.stop] : request.stop,
          }),
      ...(request.user === undefined
        ? {}
        : { metadata: { user_id: request.user } }),
      stream,
    }),
  };
}

function streamFailure(
  error: ProviderError = {
    class: 'protocol',
    code: 'provider_invalid_stream',
    retryable: true,
  },
): ProviderStreamFailure {
  return new ProviderStreamFailure(error);
}

interface ParsedSseEvent {
  readonly name: string | undefined;
  readonly data: Record<string, unknown>;
}

function parseSseEvent(event: string): ParsedSseEvent | null {
  let name: string | undefined;
  const dataLines: string[] = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n')) as unknown;
  } catch {
    throw streamFailure();
  }
  if (!isRecord(data) || typeof data.type !== 'string') {
    throw streamFailure();
  }
  if (name !== undefined && name !== data.type) throw streamFailure();
  return { name, data };
}

interface StreamState {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  sawStart: boolean;
  sawFinish: boolean;
}

function handleStreamEvent(
  event: string,
  state: StreamState,
): { readonly chunks: readonly CanonicalChatChunk[]; readonly done: boolean } {
  const parsed = parseSseEvent(event);
  if (parsed === null) return { chunks: [], done: false };
  const data = parsed.data;
  switch (data.type) {
    case 'ping':
      return { chunks: [], done: false };
    case 'error': {
      const error = data.error;
      const type = isRecord(error) ? error.type : undefined;
      if (type === 'overloaded_error' || type === 'api_error') {
        throw streamFailure({
          class: 'unavailable',
          code: 'provider_unavailable',
          retryable: true,
        });
      }
      throw streamFailure();
    }
    case 'message_start': {
      const message = data.message;
      if (!isRecord(message) || message.role !== 'assistant') {
        throw streamFailure();
      }
      const usage = message.usage;
      if (!Value.Check(UsageSchema, usage)) throw streamFailure();
      state.promptTokens = promptTokens(usage);
      state.completionTokens = usage.output_tokens;
      state.sawStart = true;
      return {
        chunks: [
          { choice: { delta: { role: 'assistant' }, finishReason: null } },
        ],
        done: false,
      };
    }
    case 'content_block_start': {
      const block = data.content_block;
      if (!isRecord(block) || block.type !== 'text') throw streamFailure();
      if (typeof block.text !== 'string') throw streamFailure();
      return {
        chunks:
          block.text.length === 0
            ? []
            : [
                {
                  choice: {
                    delta: { content: block.text },
                    finishReason: null,
                  },
                },
              ],
        done: false,
      };
    }
    case 'content_block_delta': {
      const delta = data.delta;
      if (
        !isRecord(delta) ||
        delta.type !== 'text_delta' ||
        typeof delta.text !== 'string'
      ) {
        throw streamFailure();
      }
      return {
        chunks: [
          {
            choice: { delta: { content: delta.text }, finishReason: null },
          },
        ],
        done: false,
      };
    }
    case 'content_block_stop':
      return { chunks: [], done: false };
    case 'message_delta': {
      const delta = data.delta;
      const usage = data.usage;
      if (
        !isRecord(delta) ||
        typeof delta.stop_reason !== 'string' ||
        !isRecord(usage) ||
        !Number.isInteger(usage.output_tokens) ||
        (usage.output_tokens as number) < 0
      ) {
        throw streamFailure();
      }
      state.completionTokens = usage.output_tokens as number;
      state.sawFinish = true;
      return {
        chunks: [
          {
            choice: {
              delta: {},
              finishReason: finishReason(delta.stop_reason),
            },
          },
        ],
        done: false,
      };
    }
    case 'message_stop': {
      if (
        !state.sawStart ||
        !state.sawFinish ||
        state.promptTokens === undefined ||
        state.completionTokens === undefined
      ) {
        throw streamFailure();
      }
      return {
        chunks: [
          {
            usage: {
              promptTokens: state.promptTokens,
              completionTokens: state.completionTokens,
              totalTokens: state.promptTokens + state.completionTokens,
            },
          },
        ],
        done: true,
      };
    }
    default:
      return { chunks: [], done: false };
  }
}

/** Direct HTTP adapter for Anthropic's versioned Messages API. */
export class AnthropicAdapter implements ProviderAdapter {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: Readonly<Record<string, ProviderCapabilities>>;
  private readonly fetchImplementation: typeof fetch;
  private readonly defaultMaxTokens: number;
  private readonly maxResponseBytes: number;
  private readonly maxStreamEventBytes: number;

  public constructor(options: AnthropicAdapterOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.models = options.models;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 1024;
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
        error: requestError('provider_model_not_configured'),
      };
    }
    const translated = buildRequestBody(
      request,
      context.providerModel,
      false,
      this.defaultMaxTokens,
    );
    if (!translated.ok) {
      return {
        ok: false,
        error: requestError('provider_parameter_unsupported'),
      };
    }
    let response: Response;
    try {
      response = await fetchWithConnectTimeout(
        this.fetchImplementation,
        `${this.baseUrl}/messages`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'x-request-id': context.requestId,
          },
          body: translated.body,
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
    if (body === invalidBody || !Value.Check(ResponseSchema, body)) {
      return this.protocolError();
    }
    const input = promptTokens(body.usage);
    return {
      ok: true,
      response: {
        content: body.content.map((block) => block.text).join(''),
        finishReason: finishReason(body.stop_reason),
        usage: {
          promptTokens: input,
          completionTokens: body.usage.output_tokens,
          totalTokens: input + body.usage.output_tokens,
        },
      },
    };
  }

  public async streamChatCompletion(
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): Promise<ProviderStreamCallResult> {
    if (this.capabilities(context.providerModel)?.streaming !== true) {
      return {
        ok: false,
        error: requestError('provider_streaming_not_configured'),
      };
    }
    const translated = buildRequestBody(
      request,
      context.providerModel,
      true,
      this.defaultMaxTokens,
    );
    if (!translated.ok) {
      return {
        ok: false,
        error: requestError('provider_parameter_unsupported'),
      };
    }
    let response: Response;
    try {
      response = await fetchWithConnectTimeout(
        this.fetchImplementation,
        `${this.baseUrl}/messages`,
        {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'x-request-id': context.requestId,
          },
          body: translated.body,
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
    const state: StreamState = {
      promptTokens: undefined,
      completionTokens: undefined,
      sawStart: false,
      sawFinish: false,
    };
    let buffer = '';
    let sourceEnded = false;
    try {
      for (;;) {
        const read = await reader.read().catch(() => {
          throw streamFailure(connectionError(signal));
        });
        if (read.done) {
          sourceEnded = true;
          try {
            buffer += decoder.decode();
          } catch {
            throw streamFailure();
          }
          break;
        }
        try {
          buffer += decoder.decode(read.value, { stream: true });
        } catch {
          throw streamFailure();
        }
        for (;;) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (separator?.index === undefined) break;
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          if (Buffer.byteLength(event, 'utf8') > this.maxStreamEventBytes) {
            throw streamFailure();
          }
          const handled = handleStreamEvent(event, state);
          for (const chunk of handled.chunks) yield chunk;
          if (handled.done) return;
        }
        if (Buffer.byteLength(buffer, 'utf8') > this.maxStreamEventBytes) {
          throw streamFailure();
        }
      }
      if (buffer.trim().length > 0) {
        const handled = handleStreamEvent(buffer, state);
        for (const chunk of handled.chunks) yield chunk;
        if (handled.done) return;
      }
      throw streamFailure();
    } finally {
      if (!sourceEnded) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best-effort after completion or typed failure.
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
