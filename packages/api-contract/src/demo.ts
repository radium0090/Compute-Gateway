import { Type, type Static } from '@sinclair/typebox';

export const DemoOAuthCallbackQuerySchema = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    state: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    error: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    error_description: Type.Optional(
      Type.String({ minLength: 1, maxLength: 500 }),
    ),
    error_uri: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
  },
  { additionalProperties: false },
);

export type DemoOAuthCallbackQuery = Static<
  typeof DemoOAuthCallbackQuerySchema
>;
