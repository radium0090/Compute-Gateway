import { Type, type Static } from '@sinclair/typebox';

export const ModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    object: Type.Literal('model'),
    created: Type.Integer({ minimum: 0 }),
    owned_by: Type.Literal('rax-digital'),
  },
  { additionalProperties: false },
);

export const ModelListSchema = Type.Object(
  {
    object: Type.Literal('list'),
    data: Type.Array(ModelSchema),
  },
  { additionalProperties: false },
);

export type Model = Static<typeof ModelSchema>;
export type ModelList = Static<typeof ModelListSchema>;
