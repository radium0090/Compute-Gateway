import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { ProviderStreamFailure } from '@genchi/domain';
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
} from '@genchi/domain';

const UsageSchema = Type.Object({
  promptTokenCount: Type.Integer({ minimum: 0 }),
  candidatesTokenCount: Type.Optional(Type.Integer({ minimum: 0 })),
  totalTokenCount: Type.Integer({ minimum: 0 }),
});

const ContentSchema = Type.Object({
  role: Type.Literal('model'),
  parts: Type.Array(Type.Object({ text: Type.String() })),
});

const CandidateSchema = Type.Object({
  content: Type.Optional(ContentSchema),
  finishReason: Type.Optional(Type.String()),
});

const ResponseSchema = Type.Object({
  candidates: Type.Optional(Type.Array(CandidateSchema, { maxItems: 1 })),
  usageMetadata: UsageSchema,
  promptFeedback: Type.Optional(
    Type.Object({ blockReason: Type.Optional(Type.String()) }),
  ),
});

const StreamResponseSchema = Type.Object({
  candidates: Type.Optional(Type.Array(CandidateSchema, { maxItems: 1 })),
  usageMetadata: Type.Optional(UsageSchema),
  promptFeedback: Type.Optional(
    Type.Object({ blockReason: Type.Optional(Type.String()) }),
  ),
});

const apiKeyFailureReasons = new Set([
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_INVALID',
  'API_KEY_IOS_APP_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_SERVICE_BLOCKED',
]);

const apiKeyFailureMessages = new Set([
  'API key not valid. Please pass a valid API key.',
  'Your API key was reported as leaked. Please use another API key.',
]);

const maxErrorResponseBytes = 16_384;

export interface GeminiAdapterOptions {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type GoogleErrorKind = 'authentication' | 'precondition' | null;

function googleErrorKind(value: unknown): GoogleErrorKind {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const message = value.error.message;
  if (
    typeof message === 'string' &&
    apiKeyFailureMessages.has(message.trim())
  ) {
    return 'authentication';
  }
  const details = value.error.details;
  if (
    Array.isArray(details) &&
    details.some((detail: unknown) => {
      if (!isRecord(detail)) return false;
      const reason = detail.reason;
      return (
        detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        typeof reason === 'string' &&
        apiKeyFailureReasons.has(reason)
      );
    })
  ) {
    return 'authentication';
  }
  return value.error.status === 'FAILED_PRECONDITION' ? 'precondition' : null;
}

async function statusError(response: Response): Promise<ProviderError> {
  const googleError =
    response.status === 400
      ? googleErrorKind(await readJsonBounded(response, maxErrorResponseBytes))
      : null;
  if (response.status !== 400) await cancelResponse(response);
  if (
    response.status === 401 ||
    response.status === 403 ||
    googleError === 'authentication'
  ) {
    return {
      class: 'authentication',
      code: 'provider_authentication_failed',
      retryable: false,
    };
  }
  if (googleError === 'precondition') {
    return {
      class: 'authentication',
      code: 'provider_configuration_failed',
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

function finishReason(value: string | undefined): CanonicalFinishReason {
  switch (value) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
    case 'RECITATION':
    case 'LANGUAGE':
    case 'ESCALATION':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
    case 'TOO_MANY_TOOL_CALLS':
      return 'tool_calls';
    case undefined:
      return null;
    default:
      return null;
  }
}

function contentText(candidate: typeof CandidateSchema.static): string | null {
  if (candidate.content === undefined) {
    return finishReason(candidate.finishReason) === 'content_filter'
      ? ''
      : null;
  }
  return candidate.content.parts.map((part) => part.text).join('');
}

function normalizedUsage(usage: typeof UsageSchema.static) {
  return {
    promptTokens: usage.promptTokenCount,
    completionTokens: usage.candidatesTokenCount ?? 0,
    totalTokens: usage.totalTokenCount,
  };
}

function buildRequestBody(
  request: CanonicalChatRequest,
  providerModel: string,
): { readonly ok: true; readonly body: string } | { readonly ok: false } {
  const system: string[] = [];
  const contents: {
    role: 'user' | 'model';
    parts: readonly { readonly text: string }[];
  }[] = [];
  let conversationStarted = false;
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (conversationStarted) return { ok: false };
      system.push(message.content);
    } else {
      conversationStarted = true;
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      });
    }
  }
  if (contents.length === 0) return { ok: false };
  // Gemini 2.5 Flash counts its default dynamic thinking against
  // maxOutputTokens. Disable thinking when the caller supplies a strict cap so
  // the canonical completion budget remains available for visible output.
  const disableThinkingForBoundedFlash =
    request.maxTokens !== undefined &&
    /^gemini-2\.5-flash(?:$|-)/.test(providerModel);
  const generationConfig = {
    candidateCount: 1,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.maxTokens === undefined
      ? {}
      : { maxOutputTokens: request.maxTokens }),
    ...(disableThinkingForBoundedFlash
      ? { thinkingConfig: { thinkingBudget: 0 } }
      : {}),
    ...(request.stop === undefined
      ? {}
      : {
          stopSequences:
            typeof request.stop === 'string' ? [request.stop] : request.stop,
        }),
  };
  return {
    ok: true,
    body: JSON.stringify({
      contents,
      ...(system.length === 0
        ? {}
        : { systemInstruction: { parts: [{ text: system.join('\n\n') }] } }),
      generationConfig,
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

function parseSseData(
  event: string,
): typeof StreamResponseSchema.static | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw streamFailure();
  }
  if (!Value.Check(StreamResponseSchema, value)) throw streamFailure();
  return value;
}

interface StreamState {
  roleSent: boolean;
  terminalSeen: boolean;
}

function handleStreamEvent(
  event: string,
  state: StreamState,
): readonly CanonicalChatChunk[] {
  const value = parseSseData(event);
  if (value === null) return [];
  if (
    value.promptFeedback?.blockReason !== undefined &&
    (value.candidates === undefined || value.candidates.length === 0)
  ) {
    throw streamFailure({
      class: 'policy',
      code: 'provider_content_blocked',
      retryable: false,
    });
  }
  const candidate = value.candidates?.[0];
  const chunks: CanonicalChatChunk[] = [];
  if (candidate !== undefined) {
    const text = contentText(candidate);
    if (text === null) throw streamFailure();
    const normalizedFinish = finishReason(candidate.finishReason);
    const delta = {
      ...(!state.roleSent ? { role: 'assistant' as const } : {}),
      ...(text.length === 0 ? {} : { content: text }),
    };
    state.roleSent = true;
    if (candidate.finishReason !== undefined) state.terminalSeen = true;
    chunks.push({
      choice: { delta, finishReason: normalizedFinish },
      ...(value.usageMetadata === undefined
        ? {}
        : {
            usage: {
              ...normalizedUsage(value.usageMetadata),
            },
          }),
    });
  } else if (value.usageMetadata !== undefined) {
    chunks.push({
      usage: {
        ...normalizedUsage(value.usageMetadata),
      },
    });
  } else {
    throw streamFailure();
  }
  return chunks;
}

/** Direct HTTP adapter for Gemini's GenerateContent API. */
export class GeminiAdapter implements ProviderAdapter {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: Readonly<Record<string, ProviderCapabilities>>;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxStreamEventBytes: number;

  public constructor(options: GeminiAdapterOptions) {
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
        error: requestError('provider_model_not_configured'),
      };
    }
    const translated = buildRequestBody(request, context.providerModel);
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
        `${this.baseUrl}/models/${encodeURIComponent(context.providerModel)}:generateContent`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-goog-api-key': this.apiKey,
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
      return { ok: false, error: await statusError(response) };
    }
    const body = await readJsonBounded(response, this.maxResponseBytes);
    if (body === invalidBody || !Value.Check(ResponseSchema, body)) {
      return this.protocolError();
    }
    const candidate = body.candidates?.[0];
    if (
      candidate === undefined &&
      body.promptFeedback?.blockReason !== undefined
    ) {
      return {
        ok: true,
        response: {
          content: '',
          finishReason: 'content_filter',
          usage: {
            ...normalizedUsage(body.usageMetadata),
          },
        },
      };
    }
    if (candidate === undefined) return this.protocolError();
    const text = contentText(candidate);
    if (text === null) return this.protocolError();
    return {
      ok: true,
      response: {
        content: text,
        finishReason: finishReason(candidate.finishReason),
        usage: {
          ...normalizedUsage(body.usageMetadata),
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
    const translated = buildRequestBody(request, context.providerModel);
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
        `${this.baseUrl}/models/${encodeURIComponent(context.providerModel)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
            'x-goog-api-key': this.apiKey,
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
      return { ok: false, error: await statusError(response) };
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
    const state: StreamState = { roleSent: false, terminalSeen: false };
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
          for (const chunk of handleStreamEvent(event, state)) yield chunk;
          if (state.terminalSeen) return;
        }
        if (Buffer.byteLength(buffer, 'utf8') > this.maxStreamEventBytes) {
          throw streamFailure();
        }
      }
      if (buffer.trim().length > 0) {
        for (const chunk of handleStreamEvent(buffer, state)) yield chunk;
      }
      if (!state.terminalSeen) throw streamFailure();
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
