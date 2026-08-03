import type { FastifyInstance } from 'fastify';

import {
  ErrorResponseSchema,
  ModelListSchema,
  type ErrorResponse,
  type ModelList,
} from '@genchi/api-contract';
import type { ListModelsService } from '@genchi/application';

import { bearerCredential } from './authentication.js';

export interface ModelsRouteOptions {
  readonly service: Pick<ListModelsService, 'execute'>;
  readonly clock?: () => Date;
}

function authenticationError(requestId: string): ErrorResponse {
  return {
    error: {
      message: 'Invalid authentication credentials.',
      type: 'authentication_error',
      code: 'invalid_api_key',
      param: null,
    },
    genchi: { request_id: requestId, retryable: false },
  };
}

/** Registers the policy-filtered OpenAI-compatible model catalog. */
export function registerModelsRoute(
  app: FastifyInstance,
  options: ModelsRouteOptions,
): void {
  const clock = options.clock ?? (() => new Date());
  app.get(
    '/v1/models',
    {
      schema: {
        response: { 200: ModelListSchema, 401: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await options.service.execute(
        bearerCredential(request.headers.authorization),
      );
      if (!result.ok) {
        reply.code(401);
        return authenticationError(request.id);
      }
      const created = Math.floor(clock().getTime() / 1_000);
      const response: ModelList = {
        object: 'list',
        data: result.models.map((model) => ({
          id: model.id,
          object: 'model',
          created,
          owned_by: 'genchi',
        })),
      };
      return response;
    },
  );
}
