import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  type ChatCompletionChunk,
  ErrorResponseSchema,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ErrorResponse,
} from '@rax-digital/api-contract';
import type { CreateChatCompletionService } from '@rax-digital/application';
import {
  ProviderStreamFailure,
  type CanonicalChatChunk,
  type CanonicalChatRequest,
  type ProviderError,
} from '@rax-digital/domain';

import { bearerCredential } from './authentication.js';
import {
  errorResponse,
  providerErrorMapping,
  requestDeadlineMapping,
  resultErrorMapping,
} from './chat-errors.js';

/** Dependencies and deterministic seams owned by the chat HTTP boundary. */
export interface ChatCompletionRouteOptions {
  readonly service: Pick<
    CreateChatCompletionService,
    'execute' | 'executeStream'
  >;
  readonly totalTimeoutMs: number;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly timeoutSignalFactory?: (timeoutMs: number) => AbortSignal;
}

interface CompletionMetadata {
  readonly id: string;
  readonly created: number;
  readonly requestedModel: string;
  readonly requestId: string;
  readonly provider: string;
  readonly providerModel: string;
  readonly attempts: number;
}

const deadlineExceeded = Symbol('request-deadline-exceeded');

async function withinDeadline<Value>(
  operation: () => Promise<Value>,
  timeoutSignal: AbortSignal,
): Promise<Value | typeof deadlineExceeded> {
  // The service receives the combined cancellation signal. This race is the
  // HTTP boundary's final guard against a dependency that ignores cancellation.
  if (timeoutSignal.aborted) {
    return deadlineExceeded;
  }
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<typeof deadlineExceeded>((resolve) => {
    onAbort = () => {
      resolve(deadlineExceeded);
    };
    timeoutSignal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (onAbort !== undefined) {
      timeoutSignal.removeEventListener('abort', onAbort);
    }
  }
}

function toCanonical(request: ChatCompletionRequest): CanonicalChatRequest {
  return {
    model: request.model,
    messages: request.messages,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
    ...(request.max_tokens === undefined
      ? {}
      : { maxTokens: request.max_tokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...(request.user === undefined ? {} : { user: request.user }),
  };
}

function streamProviderError(error: unknown): ProviderError {
  return error instanceof ProviderStreamFailure
    ? error.providerError
    : {
        class: 'protocol',
        code: 'provider_invalid_stream',
        retryable: true,
      };
}

function toPublicChunk(
  chunk: CanonicalChatChunk,
  metadata: CompletionMetadata,
  includeRole: boolean,
): ChatCompletionChunk {
  return {
    id: metadata.id,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.requestedModel,
    choices:
      chunk.choice === undefined
        ? []
        : [
            {
              index: 0,
              delta: {
                ...(includeRole ? { role: 'assistant' as const } : {}),
                ...chunk.choice.delta,
              },
              finish_reason: chunk.choice.finishReason,
            },
          ],
    ...(chunk.usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: chunk.usage.promptTokens,
            completion_tokens: chunk.usage.completionTokens,
            total_tokens: chunk.usage.totalTokens,
          },
        }),
    rax: {
      request_id: metadata.requestId,
      provider: metadata.provider,
      provider_model: metadata.providerModel,
      attempts: metadata.attempts,
    },
  };
}

async function closeIterator(
  iterator: AsyncIterator<CanonicalChatChunk>,
): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // The stream error was already classified and logged without content.
  }
}

async function* streamBody(
  first: CanonicalChatChunk,
  iterator: AsyncIterator<CanonicalChatChunk>,
  request: FastifyRequest<{ Body: ChatCompletionRequest }>,
  signal: AbortSignal,
  metadata: CompletionMetadata,
): AsyncIterable<string> {
  let roleSent = false;
  const serialize = (chunk: CanonicalChatChunk): string => {
    const includeRole = chunk.choice !== undefined && !roleSent;
    if (includeRole) {
      roleSent = true;
    }
    return `data: ${JSON.stringify(
      toPublicChunk(chunk, metadata, includeRole),
    )}\n\n`;
  };
  try {
    yield serialize(first);
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      yield serialize(next.value);
    }
    if (!signal.aborted) {
      yield 'data: [DONE]\n\n';
    }
  } catch (error: unknown) {
    const providerError = streamProviderError(error);
    request.log.warn(
      {
        event: 'stream.failed',
        provider_error_code: providerError.code,
      },
      'provider stream failed',
    );
  } finally {
    await closeIterator(iterator);
  }
}

async function sendStreamingCompletion(
  request: FastifyRequest<{ Body: ChatCompletionRequest }>,
  reply: FastifyReply,
  options: ChatCompletionRouteOptions,
  credential: string,
  canonicalRequest: CanonicalChatRequest,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  clock: () => Date,
  idGenerator: () => string,
  cleanup: () => void,
): Promise<
  | { readonly streaming: false; readonly response: ErrorResponse }
  | { readonly streaming: true; readonly response: FastifyReply }
> {
  const result = await withinDeadline(
    () =>
      options.service.executeStream({
        credential,
        requestId: request.id,
        request: canonicalRequest,
        signal,
      }),
    timeoutSignal,
  );
  if (result === deadlineExceeded) {
    const mapping = requestDeadlineMapping();
    reply.code(mapping.statusCode);
    return {
      streaming: false,
      response: errorResponse(mapping, request.id),
    };
  }
  if (!result.ok) {
    const mapping = resultErrorMapping(result);
    if (mapping.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(mapping.retryAfterSeconds));
    }
    reply.code(mapping.statusCode);
    return {
      streaming: false,
      response: errorResponse(mapping, request.id),
    };
  }

  const iterator = result.stream[Symbol.asyncIterator]();
  try {
    // Establish the upstream stream before committing downstream headers. A
    // failure here can still be returned as the normal RAX Compute Gateway error envelope.
    const first = await iterator.next();
    if (first.done) {
      const mapping = providerErrorMapping({
        class: 'protocol',
        code: 'provider_invalid_stream',
        retryable: true,
      });
      reply.code(mapping.statusCode);
      await closeIterator(iterator);
      return {
        streaming: false,
        response: errorResponse(mapping, request.id),
      };
    }

    const metadata = {
      id: `chatcmpl_rcg_${idGenerator()}`,
      created: Math.floor(clock().getTime() / 1_000),
      requestedModel: request.body.model,
      requestId: request.id,
      provider: result.route.provider,
      providerModel: result.route.providerModel,
      attempts: result.attempts,
    };
    request.log.info(
      {
        event: 'routing.completed',
        request_id: request.id,
        model_alias: request.body.model,
        provider: result.route.provider,
        provider_model: result.route.providerModel,
        attempts: result.attempts,
        streaming: true,
      },
      'routing completed',
    );
    const body = Readable.from(
      streamBody(first.value, iterator, request, signal, metadata),
    );
    // Once the reply owns the stream, cleanup must follow the body lifecycle;
    // the route handler itself returns before the final chunk is consumed.
    body.once('close', cleanup);
    reply
      .header('cache-control', 'no-cache, no-transform')
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('x-accel-buffering', 'no');
    reply.send(body);
    return { streaming: true, response: reply };
  } catch (error: unknown) {
    const providerError = streamProviderError(error);
    const mapping = providerErrorMapping(providerError);
    reply.code(mapping.statusCode);
    await closeIterator(iterator);
    return {
      streaming: false,
      response: errorResponse(mapping, request.id),
    };
  }
}

/** Registers authenticated streaming and non-streaming chat completions. */
export function registerChatCompletionRoute(
  app: FastifyInstance,
  options: ChatCompletionRouteOptions,
): void {
  const clock = options.clock ?? (() => new Date());
  const idGenerator =
    options.idGenerator ?? (() => randomUUID().replaceAll('-', ''));
  const timeoutSignalFactory =
    options.timeoutSignalFactory ??
    ((timeoutMs) => AbortSignal.timeout(timeoutMs));

  app.post<{ Body: ChatCompletionRequest }>(
    '/v1/chat/completions',
    {
      schema: {
        body: ChatCompletionRequestSchema,
        response: {
          200: ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          408: ErrorResponseSchema,
          429: ErrorResponseSchema,
          502: ErrorResponseSchema,
          503: ErrorResponseSchema,
          504: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const credential = bearerCredential(request.headers.authorization);
      const clientAbort = new AbortController();
      const abort = (): void => {
        clientAbort.abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      const timeoutSignal = timeoutSignalFactory(options.totalTimeoutMs);
      const signal = AbortSignal.any([clientAbort.signal, timeoutSignal]);
      const cleanup = (): void => {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      };
      let streamOwnsCleanup = false;

      try {
        const canonicalRequest = toCanonical(request.body);
        if (request.body.stream === true) {
          const streamResult = await sendStreamingCompletion(
            request,
            reply,
            options,
            credential,
            canonicalRequest,
            signal,
            timeoutSignal,
            clock,
            idGenerator,
            cleanup,
          );
          streamOwnsCleanup = streamResult.streaming;
          return await streamResult.response;
        }
        const result = await withinDeadline(
          () =>
            options.service.execute({
              credential,
              requestId: request.id,
              request: canonicalRequest,
              signal,
            }),
          timeoutSignal,
        );
        if (result === deadlineExceeded) {
          const mapping = requestDeadlineMapping();
          reply.code(mapping.statusCode);
          return errorResponse(mapping, request.id);
        }
        if (!result.ok) {
          const mapping = resultErrorMapping(result);
          if (mapping.retryAfterSeconds !== undefined) {
            reply.header('retry-after', String(mapping.retryAfterSeconds));
          }
          reply.code(mapping.statusCode);
          return errorResponse(mapping, request.id);
        }

        request.log.info(
          {
            event: 'routing.completed',
            request_id: request.id,
            model_alias: request.body.model,
            provider: result.route.provider,
            provider_model: result.route.providerModel,
            attempts: result.attempts,
            streaming: false,
          },
          'routing completed',
        );

        const response: ChatCompletionResponse = {
          id: `chatcmpl_rcg_${idGenerator()}`,
          object: 'chat.completion',
          created: Math.floor(clock().getTime() / 1_000),
          model: request.body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: result.response.content },
              finish_reason: result.response.finishReason,
            },
          ],
          usage: {
            prompt_tokens: result.response.usage.promptTokens,
            completion_tokens: result.response.usage.completionTokens,
            total_tokens: result.response.usage.totalTokens,
          },
          rax: {
            request_id: request.id,
            provider: result.route.provider,
            provider_model: result.route.providerModel,
            attempts: result.attempts,
          },
        };
        return response;
      } finally {
        if (!streamOwnsCleanup) {
          cleanup();
        }
      }
    },
  );
}
