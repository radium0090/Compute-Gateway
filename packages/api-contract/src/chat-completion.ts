import { Type, type Static } from '@sinclair/typebox';

const FunctionCallSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    arguments: Type.String({ maxLength: 1_000_000 }),
  },
  { additionalProperties: false },
);

const ToolCallSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    type: Type.Literal('function'),
    function: FunctionCallSchema,
  },
  { additionalProperties: false },
);

export const ChatMessageSchema = Type.Union([
  Type.Object(
    {
      role: Type.Union([
        Type.Literal('system'),
        Type.Literal('developer'),
        Type.Literal('user'),
      ]),
      content: Type.String({ maxLength: 1_000_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      role: Type.Literal('assistant'),
      content: Type.Optional(
        Type.Union([Type.String({ maxLength: 1_000_000 }), Type.Null()]),
      ),
      tool_calls: Type.Optional(
        Type.Array(ToolCallSchema, { minItems: 1, maxItems: 128 }),
      ),
    },
    { additionalProperties: false, minProperties: 2 },
  ),
  Type.Object(
    {
      role: Type.Literal('tool'),
      content: Type.String({ maxLength: 1_000_000 }),
      tool_call_id: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
]);

const FunctionToolSchema = Type.Object(
  {
    type: Type.Literal('function'),
    function: Type.Object(
      {
        name: Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: '^[A-Za-z0-9_-]+$',
        }),
        description: Type.Optional(Type.String({ maxLength: 8_192 })),
        parameters: Type.Optional(
          Type.Object({}, { additionalProperties: true }),
        ),
        strict: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolChoiceSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('auto'),
  Type.Literal('required'),
  Type.Object(
    {
      type: Type.Literal('function'),
      function: Type.Object(
        { name: Type.String({ minLength: 1, maxLength: 64 }) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

const ResponseFormatSchema = Type.Union([
  Type.Object({ type: Type.Literal('text') }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal('json_object') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('json_schema'),
      json_schema: Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 64 }),
          description: Type.Optional(Type.String({ maxLength: 8_192 })),
          schema: Type.Object({}, { additionalProperties: true }),
          strict: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

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
    tools: Type.Optional(
      Type.Array(FunctionToolSchema, { minItems: 1, maxItems: 128 }),
    ),
    tool_choice: Type.Optional(ToolChoiceSchema),
    parallel_tool_calls: Type.Optional(Type.Boolean()),
    response_format: Type.Optional(ResponseFormatSchema),
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
              content: Type.Union([Type.String(), Type.Null()]),
              tool_calls: Type.Optional(
                Type.Array(ToolCallSchema, { minItems: 1, maxItems: 128 }),
              ),
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
              tool_calls: Type.Optional(
                Type.Array(
                  Type.Object(
                    {
                      index: Type.Integer({ minimum: 0 }),
                      id: Type.Optional(Type.String()),
                      type: Type.Optional(Type.Literal('function')),
                      function: Type.Optional(
                        Type.Object(
                          {
                            name: Type.Optional(Type.String()),
                            arguments: Type.Optional(Type.String()),
                          },
                          { additionalProperties: false },
                        ),
                      ),
                    },
                    { additionalProperties: false },
                  ),
                  { minItems: 1, maxItems: 128 },
                ),
              ),
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
