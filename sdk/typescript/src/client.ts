import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ErrorResponse,
  LivenessResponse,
  ModelList,
  ReadinessResponse,
} from './types.js';

export interface RaxComputeGatewayOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchImplementation?: typeof globalThis.fetch;
}

interface RawResponse {
  readonly response: Response;
  cleanup(): void;
}

export class RaxComputeGatewayApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId: string | undefined,
    public readonly retryable: boolean,
    public readonly param: string | null,
  ) {
    super(message);
    this.name = 'RaxComputeGatewayApiError';
  }
}

export class RaxComputeGatewayConnectionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RaxComputeGatewayConnectionError';
  }
}

function environment(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env[name];
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable and will not be exposed to the caller.
  }
}

function safeError(value: unknown): ErrorResponse | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.error !== 'object' ||
    record.error === null ||
    typeof record.rax !== 'object' ||
    record.rax === null
  ) {
    return undefined;
  }
  const error = record.error as Readonly<Record<string, unknown>>;
  const rax = record.rax as Readonly<Record<string, unknown>>;
  if (
    typeof error.message !== 'string' ||
    typeof error.code !== 'string' ||
    typeof rax.retryable !== 'boolean'
  ) {
    return undefined;
  }
  return value as ErrorResponse;
}

async function apiError(
  response: Response,
): Promise<RaxComputeGatewayApiError> {
  const parsed = safeError(await response.json().catch(() => undefined));
  return new RaxComputeGatewayApiError(
    parsed?.error.message ?? 'RAX Compute Gateway rejected the request.',
    response.status,
    parsed?.error.code ?? 'gateway_request_failed',
    parsed?.rax.request_id ?? response.headers.get('x-request-id') ?? undefined,
    parsed?.rax.retryable ?? shouldRetry(response.status),
    parsed?.error.param ?? null,
  );
}

function sseEvents(buffer: string): {
  readonly events: string[];
  readonly rest: string;
} {
  const normalized = buffer.replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}

function eventData(event: string): string | undefined {
  const lines = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  return lines.length === 0 ? undefined : lines.join('\n');
}

export class RaxComputeGateway {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImplementation: typeof globalThis.fetch;

  public readonly chat = {
    completions: {
      create: (request: ChatCompletionRequest) =>
        this.createCompletion(request),
      stream: (request: ChatCompletionRequest) =>
        this.streamCompletion(request),
    },
  };

  public readonly models = {
    list: () => this.listModels(),
  };

  public readonly health = {
    live: () => this.getHealth<LivenessResponse>('/health/live'),
    ready: () => this.getHealth<ReadinessResponse>('/health/ready'),
  };

  public constructor(options: RaxComputeGatewayOptions = {}) {
    const apiKey = options.apiKey ?? environment('RCG_API_KEY');
    if (apiKey === undefined || apiKey.length === 0) {
      throw new TypeError('A RAX Compute Gateway API key is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = withoutTrailingSlashes(
      options.baseUrl ??
        environment('RCG_BASE_URL') ??
        'http://localhost:8080/v1',
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs ??
        Number(environment('RCG_TIMEOUT_SECONDS') ?? '60') * 1_000,
      'timeoutMs',
    );
    this.maxRetries = nonNegativeInteger(
      options.maxRetries ?? Number(environment('RCG_MAX_RETRIES') ?? '1'),
      'maxRetries',
    );
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }

  private async raw(
    target: string,
    init: Readonly<{
      method: 'GET' | 'POST';
      body?: string;
      authenticated: boolean;
    }>,
  ): Promise<RawResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      controller.abort();
    };
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const url = /^https?:\/\//u.test(target)
          ? target
          : `${this.baseUrl}${target}`;
        const response = await this.fetchImplementation(url, {
          method: init.method,
          headers: {
            accept: 'application/json, text/event-stream',
            ...(init.body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            ...(init.authenticated
              ? { authorization: `Bearer ${this.apiKey}` }
              : {}),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: controller.signal,
        });
        if (shouldRetry(response.status) && attempt < this.maxRetries) {
          await discard(response);
          continue;
        }
        return { response, cleanup };
      } catch (error: unknown) {
        lastError = error;
        if (controller.signal.aborted || attempt >= this.maxRetries) {
          cleanup();
          throw new RaxComputeGatewayConnectionError(
            controller.signal.aborted
              ? 'The RAX Compute Gateway request timed out.'
              : 'Unable to reach RAX Compute Gateway.',
            { cause: error },
          );
        }
      }
    }
    cleanup();
    throw new RaxComputeGatewayConnectionError(
      'Unable to reach RAX Compute Gateway.',
      {
        cause: lastError,
      },
    );
  }

  private async createCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const raw = await this.raw('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...request, stream: false }),
      authenticated: true,
    });
    try {
      if (!raw.response.ok) throw await apiError(raw.response);
      return (await raw.response.json()) as ChatCompletionResponse;
    } finally {
      raw.cleanup();
    }
  }

  private async streamCompletion(
    request: ChatCompletionRequest,
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const raw = await this.raw('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...request, stream: true }),
      authenticated: true,
    });
    if (!raw.response.ok) {
      try {
        throw await apiError(raw.response);
      } finally {
        raw.cleanup();
      }
    }
    if (raw.response.body === null) {
      raw.cleanup();
      throw new RaxComputeGatewayConnectionError(
        'The RAX Compute Gateway stream had no response body.',
      );
    }
    return this.decodeStream(raw.response.body, () => {
      raw.cleanup();
    });
  }

  private async *decodeStream(
    body: ReadableStream<Uint8Array>,
    cleanup: () => void,
  ): AsyncIterable<ChatCompletionChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done });
        const parsed = sseEvents(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          const data = eventData(event);
          if (data === undefined) continue;
          if (data === '[DONE]') return;
          yield JSON.parse(data) as ChatCompletionChunk;
        }
        if (next.done) {
          if (buffer.trim().length > 0) {
            const data = eventData(buffer);
            if (data !== undefined && data !== '[DONE]') {
              yield JSON.parse(data) as ChatCompletionChunk;
            }
          }
          throw new RaxComputeGatewayConnectionError(
            'The RAX Compute Gateway stream ended before the [DONE] marker.',
          );
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Cancelling an already-closed stream is harmless.
      }
      reader.releaseLock();
      cleanup();
    }
  }

  private async listModels(): Promise<ModelList> {
    return this.getJson<ModelList>('/models', true);
  }

  private async getHealth<Result>(path: string): Promise<Result> {
    const root = this.baseUrl.endsWith('/v1')
      ? this.baseUrl.slice(0, -3)
      : this.baseUrl;
    const raw = await this.raw(`${root}${path}`, {
      method: 'GET',
      authenticated: false,
    });
    try {
      if (!raw.response.ok) throw await apiError(raw.response);
      return (await raw.response.json()) as Result;
    } finally {
      raw.cleanup();
    }
  }

  private async getJson<Result>(
    path: string,
    authenticated: boolean,
  ): Promise<Result> {
    const raw = await this.raw(path, { method: 'GET', authenticated });
    try {
      if (!raw.response.ok) throw await apiError(raw.response);
      return (await raw.response.json()) as Result;
    } finally {
      raw.cleanup();
    }
  }
}
