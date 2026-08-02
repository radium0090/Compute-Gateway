import { readFile, writeFile } from 'node:fs/promises';

import { stringify } from 'yaml';

import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ErrorResponseSchema,
  LivenessResponseSchema,
  ReadinessResponseSchema,
} from '@genchi/api-contract';

const outputPath = new URL('../openapi/genchi.openapi.yaml', import.meta.url);

const errorResponses = Object.fromEntries(
  [400, 401, 403, 404, 413, 429, 502, 503, 504].map((status) => [
    status,
    {
      description: 'Canonical Genchi error',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    },
  ]),
);

const document = {
  openapi: '3.1.0',
  info: {
    title: 'Genchi API',
    description: 'OpenAI-compatible API for the Genchi compute gateway.',
    version: '0.1.0',
    license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
  },
  servers: [
    {
      url: '{scheme}://{host}',
      variables: {
        scheme: { default: 'http', enum: ['http', 'https'] },
        host: { default: 'localhost:8080' },
      },
    },
  ],
  paths: {
    '/v1/chat/completions': {
      post: {
        operationId: 'createChatCompletion',
        summary: 'Create a non-streaming chat completion',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Normalized chat completion',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionResponse' },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    '/health/live': {
      get: {
        operationId: 'getLiveness',
        summary: 'Get process liveness',
        security: [],
        responses: {
          200: {
            description: 'Process is alive',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LivenessResponse' },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        operationId: 'getReadiness',
        summary: 'Get dependency readiness',
        security: [],
        responses: {
          200: {
            description: 'Gateway is ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReadinessResponse' },
              },
            },
          },
          503: {
            description: 'Gateway is not ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReadinessResponse' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Genchi API key',
      },
    },
    schemas: {
      ChatCompletionRequest: ChatCompletionRequestSchema,
      ChatCompletionResponse: ChatCompletionResponseSchema,
      ErrorResponse: ErrorResponseSchema,
      LivenessResponse: LivenessResponseSchema,
      ReadinessResponse: ReadinessResponseSchema,
    },
  },
};

const generated = stringify(document, { lineWidth: 100 });
if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8').catch(() => '');
  if (existing !== generated) {
    process.stderr.write('OpenAPI artifact is out of date\n');
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated, 'utf8');
  process.stdout.write('Generated openapi/genchi.openapi.yaml\n');
}
