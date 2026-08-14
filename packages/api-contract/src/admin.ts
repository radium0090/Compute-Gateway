import { Type, type Static } from '@sinclair/typebox';

const UuidSchema = Type.String({ format: 'uuid' });
const PasswordSchema = Type.String({ minLength: 1, maxLength: 128 });

export const AdminLoginRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 254 }),
    password: PasswordSchema,
  },
  { additionalProperties: false },
);

export const AdminPasswordChangeRequestSchema = Type.Object(
  {
    current_password: PasswordSchema,
    new_password: Type.String({ minLength: 15, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const AdminTenantCreateRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const AdminApiKeyCreateRequestSchema = Type.Object(
  {
    tenant_id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    environment: Type.Union([
      Type.Literal('development'),
      Type.Literal('test'),
      Type.Literal('staging'),
      Type.Literal('production'),
    ]),
    allowed_model_patterns: Type.Array(
      Type.String({ minLength: 1, maxLength: 200 }),
      { minItems: 1, maxItems: 50 },
    ),
    allow_streaming: Type.Boolean(),
    requests_per_minute: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    max_concurrent_requests: Type.Integer({ minimum: 1, maximum: 10_000 }),
    expires_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const AdminApiKeyPathSchema = Type.Object(
  { id: UuidSchema },
  { additionalProperties: false },
);

export const AdminApiKeyQuerySchema = Type.Object(
  { tenant_id: Type.Optional(UuidSchema) },
  { additionalProperties: false },
);

export type AdminLoginRequest = Static<typeof AdminLoginRequestSchema>;
export type AdminPasswordChangeRequest = Static<
  typeof AdminPasswordChangeRequestSchema
>;
export type AdminTenantCreateRequest = Static<
  typeof AdminTenantCreateRequestSchema
>;
export type AdminApiKeyCreateRequest = Static<
  typeof AdminApiKeyCreateRequestSchema
>;
export type AdminApiKeyPath = Static<typeof AdminApiKeyPathSchema>;
export type AdminApiKeyQuery = Static<typeof AdminApiKeyQuerySchema>;
