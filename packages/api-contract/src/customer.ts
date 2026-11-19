import { Type, type Static } from '@sinclair/typebox';

const EmailSchema = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
});
const PasswordSchema = Type.String({ minLength: 12, maxLength: 128 });
const OpaqueTokenSchema = Type.String({
  minLength: 43,
  maxLength: 43,
  pattern: '^[A-Za-z0-9_-]+$',
});

export const CustomerRegistrationRequestSchema = Type.Object(
  {
    email: EmailSchema,
    display_name: Type.String({ minLength: 1, maxLength: 100 }),
    organization_name: Type.String({ minLength: 1, maxLength: 160 }),
    password: PasswordSchema,
    accepted_terms: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const CustomerLoginRequestSchema = Type.Object(
  {
    email: EmailSchema,
    password: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const CustomerEmailRequestSchema = Type.Object(
  { email: EmailSchema },
  { additionalProperties: false },
);

export const CustomerTokenRequestSchema = Type.Object(
  { token: OpaqueTokenSchema },
  { additionalProperties: false },
);

export const CustomerPasswordResetRequestSchema = Type.Object(
  { token: OpaqueTokenSchema, password: PasswordSchema },
  { additionalProperties: false },
);

export const CustomerApiKeyCreateRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const CustomerApiKeyPathSchema = Type.Object(
  {
    id: Type.String({
      pattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

export const BusinessInquiryRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    email: EmailSchema,
    company: Type.Optional(Type.String({ maxLength: 160 })),
    message: Type.String({ minLength: 10, maxLength: 4_000 }),
    accepted_privacy: Type.Literal(true),
    website: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

export type CustomerRegistrationRequest = Static<
  typeof CustomerRegistrationRequestSchema
>;
export type CustomerLoginRequest = Static<typeof CustomerLoginRequestSchema>;
export type CustomerEmailRequest = Static<typeof CustomerEmailRequestSchema>;
export type CustomerTokenRequest = Static<typeof CustomerTokenRequestSchema>;
export type CustomerPasswordResetRequest = Static<
  typeof CustomerPasswordResetRequestSchema
>;
export type CustomerApiKeyCreateRequest = Static<
  typeof CustomerApiKeyCreateRequestSchema
>;
export type CustomerApiKeyPath = Static<typeof CustomerApiKeyPathSchema>;
export type BusinessInquiryRequest = Static<
  typeof BusinessInquiryRequestSchema
>;
