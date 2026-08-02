import { Type, type Static } from '@sinclair/typebox';

/** Public response returned by the liveness endpoint. */
export const LivenessResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
  },
  { additionalProperties: false },
);

export type LivenessResponse = Static<typeof LivenessResponseSchema>;

/** Public response returned by the readiness endpoint. */
export const ReadinessResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
    checks: Type.Object(
      {
        postgres: Type.Union([Type.Literal('ok'), Type.Literal('error')]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ReadinessResponse = Static<typeof ReadinessResponseSchema>;
