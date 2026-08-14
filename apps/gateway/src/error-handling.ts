import type { FastifyInstance } from 'fastify';

import type { ErrorResponse } from '@rax-digital/api-contract';

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

function validationParam(error: unknown): {
  readonly validation: boolean;
  readonly param: string | null;
} {
  if (typeof error !== 'object' || error === null || !('validation' in error)) {
    return { validation: false, param: null };
  }
  if (!Array.isArray(error.validation)) {
    return { validation: false, param: null };
  }
  const first: unknown = error.validation[0];
  if (
    typeof first !== 'object' ||
    first === null ||
    !('instancePath' in first) ||
    typeof first.instancePath !== 'string'
  ) {
    return { validation: true, param: null };
  }
  const path = first.instancePath.replace(/^\//, '');
  return { validation: true, param: path.length === 0 ? null : path };
}

function response(
  requestId: string,
  input: {
    readonly message: string;
    readonly type: string;
    readonly code: string;
    readonly param: string | null;
    readonly retryable: boolean;
  },
): ErrorResponse {
  return {
    error: {
      message: input.message,
      type: input.type,
      code: input.code,
      param: input.param,
    },
    rax: { request_id: requestId, retryable: input.retryable },
  };
}

/** Normalizes framework failures without exposing raw exception messages. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(
      response(request.id, {
        message: 'The requested resource was not found.',
        type: 'not_found_error',
        code: 'route_not_found',
        param: null,
        retryable: false,
      }),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const code = errorCode(error);
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413).send(
        response(request.id, {
          message: 'The request body is too large.',
          type: 'invalid_request_error',
          code: 'request_too_large',
          param: null,
          retryable: false,
        }),
      );
      return;
    }
    if (errorStatus(error) === 429) {
      reply.code(429).send(
        response(request.id, {
          message: 'The request rate limit was exceeded.',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          param: null,
          retryable: true,
        }),
      );
      return;
    }
    const validation = validationParam(error);
    if (validation.validation) {
      reply.code(400).send(
        response(request.id, {
          message: 'The request is invalid.',
          type: 'invalid_request_error',
          code: 'invalid_request',
          param: validation.param,
          retryable: false,
        }),
      );
      return;
    }

    request.log.error(
      { event: 'request.failed', error_code: code ?? 'internal_error' },
      'request failed',
    );
    reply.code(500).send(
      response(request.id, {
        message: 'An internal error occurred.',
        type: 'internal_error',
        code: 'internal_error',
        param: null,
        retryable: false,
      }),
    );
  });
}
