import { Type, type Static } from '@sinclair/typebox';

export const ChatMessageSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal('system'),
      Type.Literal('user'),
      Type.Literal('assistant'),
    ]),
    content: Type.String({ maxLength: 1_000_000 }),
  },
  { additionalProperties: false },
);

export const ChatCompletionRequestSchema = Type.Object(
  {
    model: Type.String({ minLength: 1, maxLength: 256 }),
    messages: Type.Array(ChatMessageSchema, { minItems: 1, maxItems: 1_024 }),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    top_p: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    stop: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1 }),
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: 4,
        }),
      ]),
    ),
    stream: Type.Optional(Type.Boolean({ default: false })),
    n: Type.Optional(Type.Literal(1, { default: 1 })),
    user: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export type ChatCompletionRequest = Static<typeof ChatCompletionRequestSchema>;

export const ChatCompletionResponseSchema = Type.Object(
  {
    id: Type.String(),
    object: Type.Literal('chat.completion'),
    created: Type.Integer({ minimum: 0 }),
    model: Type.String(),
    choices: Type.Array(
      Type.Object(
        {
          index: Type.Literal(0),
          message: Type.Object(
            {
              role: Type.Literal('assistant'),
              content: Type.String(),
            },
            { additionalProperties: false },
          ),
          finish_reason: Type.Union([
            Type.Literal('stop'),
            Type.Literal('length'),
            Type.Literal('tool_calls'),
            Type.Literal('content_filter'),
            Type.Null(),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 1 },
    ),
    usage: Type.Object(
      {
        prompt_tokens: Type.Integer({ minimum: 0 }),
        completion_tokens: Type.Integer({ minimum: 0 }),
        total_tokens: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    rax: Type.Object(
      {
        request_id: Type.String(),
        provider: Type.String(),
        provider_model: Type.String(),
        attempts: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ChatCompletionResponse = Static<
  typeof ChatCompletionResponseSchema
>;

const UsageSchema = Type.Object(
  {
    prompt_tokens: Type.Integer({ minimum: 0 }),
    completion_tokens: Type.Integer({ minimum: 0 }),
    total_tokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ChatCompletionChunkSchema = Type.Object(
  {
    id: Type.String(),
    object: Type.Literal('chat.completion.chunk'),
    created: Type.Integer({ minimum: 0 }),
    model: Type.String(),
    choices: Type.Array(
      Type.Object(
        {
          index: Type.Literal(0),
          delta: Type.Object(
            {
              role: Type.Optional(Type.Literal('assistant')),
              content: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
          finish_reason: Type.Union([
            Type.Literal('stop'),
            Type.Literal('length'),
            Type.Literal('tool_calls'),
            Type.Literal('content_filter'),
            Type.Null(),
          ]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1 },
    ),
    usage: Type.Optional(UsageSchema),
    rax: Type.Object(
      {
        request_id: Type.String(),
        provider: Type.String(),
        provider_model: Type.String(),
        attempts: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ChatCompletionChunk = Static<typeof ChatCompletionChunkSchema>;

export const ErrorResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        message: Type.String(),
        type: Type.String(),
        code: Type.String(),
        param: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    rax: Type.Object(
      {
        request_id: Type.String(),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ErrorResponse = Static<typeof ErrorResponseSchema>;
