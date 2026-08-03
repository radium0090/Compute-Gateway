import type { ErrorResponse } from '@genchi/api-contract';
import type {
  CreateChatCompletionResult,
  CreateChatCompletionStreamResult,
} from '@genchi/application';
import type { ProviderError } from '@genchi/domain';

export interface ErrorMapping {
  readonly statusCode: 400 | 401 | 403 | 404 | 408 | 429 | 502 | 503 | 504;
  readonly type: string;
  readonly code: string;
  readonly message: string;
  readonly param: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}

export function requestDeadlineMapping(): ErrorMapping {
  return {
    statusCode: 408,
    type: 'timeout_error',
    code: 'request_deadline_exceeded',
    message: 'The request deadline was exceeded.',
    param: null,
    retryable: true,
  };
}

export function providerErrorMapping(error: ProviderError): ErrorMapping {
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

export function resultErrorMapping(
  result: CreateChatCompletionResult | CreateChatCompletionStreamResult,
): ErrorMapping {
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
  if (result.failure.kind === 'admission') {
    switch (result.failure.reason) {
      case 'rate_limited':
      case 'concurrency_limited':
        return {
          statusCode: 429,
          type: 'rate_limit_error',
          code:
            result.failure.reason === 'rate_limited'
              ? 'rate_limit_exceeded'
              : 'concurrency_limit_exceeded',
          message: 'The API key request limit was exceeded.',
          param: null,
          retryable: true,
          ...(result.failure.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.failure.retryAfterSeconds }),
        };
      case 'coordination_unavailable':
        return {
          statusCode: 503,
          type: 'service_unavailable_error',
          code: 'coordination_unavailable',
          message: 'Request admission is temporarily unavailable.',
          param: null,
          retryable: true,
        };
    }
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
    case 'streaming_not_allowed':
      return {
        statusCode: 403,
        type: 'permission_error',
        code: 'streaming_not_allowed',
        message: 'The API key is not permitted to stream responses.',
        param: 'stream',
        retryable: false,
      };
  }
}

export function errorResponse(
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
