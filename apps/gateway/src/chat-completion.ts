import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ErrorResponseSchema,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ErrorResponse,
} from '@genchi/api-contract';
import type {
  CreateChatCompletionResult,
  CreateChatCompletionService,
} from '@genchi/application';
import type { CanonicalChatRequest, ProviderError } from '@genchi/domain';

export interface ChatCompletionRouteOptions {
  readonly service: Pick<CreateChatCompletionService, 'execute'>;
  readonly totalTimeoutMs: number;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

interface ErrorMapping {
  readonly statusCode: 400 | 401 | 403 | 404 | 429 | 502 | 503 | 504;
  readonly type: string;
  readonly code: string;
  readonly message: string;
  readonly param: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}

function providerErrorMapping(error: ProviderError): ErrorMapping {
  switch (error.class) {
    case 'rate_limit':
      return {
        statusCode: 429,
        type: 'rate_limit_error',
        code: error.code,
        message: 'The model provider is rate limited.',
        param: null,
        retryable: error.retryable,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
      };
    case 'timeout':
      return {
        statusCode: 504,
        type: 'timeout_error',
        code: error.code,
        message: 'The model provider timed out.',
        param: null,
        retryable: error.retryable,
      };
    case 'request':
    case 'policy':
      return {
        statusCode: 400,
        type: 'invalid_request_error',
        code: error.code,
        message: 'The model provider rejected the request.',
        param: null,
        retryable: false,
      };
    case 'authentication':
    case 'unavailable':
      return {
        statusCode: 503,
        type: 'model_unavailable_error',
        code: error.code,
        message: 'The requested model is temporarily unavailable.',
        param: 'model',
        retryable: error.retryable,
      };
    case 'protocol':
      return {
        statusCode: 502,
        type: 'provider_error',
        code: error.code,
        message: 'The model provider returned an invalid response.',
        param: null,
        retryable: error.retryable,
      };
  }
}

function resultErrorMapping(result: CreateChatCompletionResult): ErrorMapping {
  if (result.ok) {
    throw new TypeError('A successful result has no error mapping');
  }
  if (result.failure.kind === 'authentication') {
    return {
      statusCode: 401,
      type: 'authentication_error',
      code: 'invalid_api_key',
      message: 'Invalid authentication credentials.',
      param: null,
      retryable: false,
    };
  }
  if (result.failure.kind === 'provider') {
    return providerErrorMapping(result.failure.error);
  }
  switch (result.failure.reason) {
    case 'model_not_allowed':
      return {
        statusCode: 403,
        type: 'permission_error',
        code: 'model_not_allowed',
        message: 'The API key is not permitted to use this model.',
        param: 'model',
        retryable: false,
      };
    case 'model_not_found':
      return {
        statusCode: 404,
        type: 'not_found_error',
        code: 'model_not_found',
        message: 'The requested model was not found.',
        param: 'model',
        retryable: false,
      };
    case 'no_healthy_route':
      return {
        statusCode: 503,
        type: 'model_unavailable_error',
        code: 'no_healthy_route',
        message: 'The requested model is not available.',
        param: 'model',
        retryable: true,
      };
  }
}

function errorResponse(
  mapping: ErrorMapping,
  requestId: string,
): ErrorResponse {
  return {
    error: {
      message: mapping.message,
      type: mapping.type,
      code: mapping.code,
      param: mapping.param,
    },
    genchi: { request_id: requestId, retryable: mapping.retryable },
  };
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

/** Registers the authenticated non-streaming chat completion operation. */
export function registerChatCompletionRoute(
  app: FastifyInstance,
  options: ChatCompletionRouteOptions,
): void {
  const clock = options.clock ?? (() => new Date());
  const idGenerator =
    options.idGenerator ?? (() => randomUUID().replaceAll('-', ''));

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
          429: ErrorResponseSchema,
          502: ErrorResponseSchema,
          503: ErrorResponseSchema,
          504: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const authorization = request.headers.authorization;
      const credential =
        typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : '';
      const clientAbort = new AbortController();
      const abort = (): void => {
        clientAbort.abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      const signal = AbortSignal.any([
        clientAbort.signal,
        AbortSignal.timeout(options.totalTimeoutMs),
      ]);

      try {
        const result = await options.service.execute({
          credential,
          requestId: request.id,
          request: toCanonical(request.body),
          signal,
        });
        if (!result.ok) {
          const mapping = resultErrorMapping(result);
          if (mapping.retryAfterSeconds !== undefined) {
            reply.header('retry-after', String(mapping.retryAfterSeconds));
          }
          reply.code(mapping.statusCode);
          return errorResponse(mapping, request.id);
        }

        const response: ChatCompletionResponse = {
          id: `chatcmpl_gch_${idGenerator()}`,
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
          genchi: {
            request_id: request.id,
            provider: result.route.provider,
            provider_model: result.route.providerModel,
            attempts: result.attempts,
          },
        };
        return response;
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
    },
  );
}
