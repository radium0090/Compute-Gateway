import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  BusinessInquiryRequestSchema,
  CustomerApiKeyCreateRequestSchema,
  CustomerApiKeyPathSchema,
  CustomerEmailRequestSchema,
  CustomerLoginRequestSchema,
  CustomerPasswordResetRequestSchema,
  CustomerRegistrationRequestSchema,
  CustomerTokenRequestSchema,
  type BusinessInquiryRequest,
  type CustomerApiKeyCreateRequest,
  type CustomerApiKeyPath,
  type CustomerEmailRequest,
  type CustomerLoginRequest,
  type CustomerPasswordResetRequest,
  type CustomerRegistrationRequest,
  type CustomerTokenRequest,
} from '@rax-digital/api-contract';
import {
  CustomerInputError,
  type CustomerConsoleService,
  type CustomerPrincipal,
} from '@rax-digital/application';

const sessionCookieName = '__Host-rcg_customer_session';
const consoleCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');
const siteCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const consoleApiRateLimit = {
  max: 180,
  timeWindow: '1 minute',
  groupId: 'customer-console-api',
} as const;
const loginRateLimit = {
  max: 20,
  timeWindow: '1 minute',
  groupId: 'customer-login',
  hook: 'preValidation',
  keyGenerator: anonymousIdentityKey,
} as const;
const publicMutationRateLimit = {
  max: 5,
  timeWindow: '1 hour',
  groupId: 'customer-public-mutation',
  hook: 'preValidation',
  keyGenerator: anonymousIdentityKey,
} as const;

function anonymousIdentityKey(request: FastifyRequest): string {
  const body = request.body;
  if (typeof body === 'object' && body !== null) {
    const record = body as Readonly<Record<string, unknown>>;
    const identity =
      typeof record.email === 'string'
        ? record.email.trim().toLowerCase()
        : typeof record.token === 'string'
          ? record.token
          : undefined;
    if (identity !== undefined && identity !== '') {
      return createHash('sha256').update(identity, 'utf8').digest('hex');
    }
  }
  return request.ip;
}

export type CustomerRouteService = Pick<
  CustomerConsoleService,
  | 'authenticate'
  | 'authorizeMutation'
  | 'createApiKey'
  | 'createBusinessInquiry'
  | 'dashboard'
  | 'login'
  | 'logout'
  | 'register'
  | 'requestPasswordReset'
  | 'resendVerification'
  | 'resetPassword'
  | 'revokeApiKey'
  | 'verifyEmail'
>;

export interface CustomerRouteDependencies {
  readonly service: CustomerRouteService;
  readonly origin: string;
  readonly sessionTtlMs: number;
  readonly registrationEnabled: boolean;
}

function apiError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message } });
}

function cookieValue(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === sessionCookieName) return rest.join('=') || null;
  }
  return null;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${sessionCookieName}=${token}; Path=/; Max-Age=${String(maxAgeSeconds)}; Secure; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function checkOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedOrigin: string,
): boolean {
  if (request.headers.origin === expectedOrigin) return true;
  apiError(reply, 403, 'origin_rejected', 'The request origin is not allowed.');
  return false;
}

async function requirePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  service: CustomerRouteService,
  mutation: boolean,
): Promise<CustomerPrincipal | null> {
  const session = cookieValue(request.headers.cookie);
  if (session === null) {
    apiError(reply, 401, 'authentication_required', 'Please sign in.');
    return null;
  }
  const csrf = request.headers['x-rcg-csrf-token'];
  const actor = mutation
    ? await service.authorizeMutation(
        session,
        typeof csrf === 'string' ? csrf : '',
      )
    : await service.authenticate(session);
  if (actor === null) {
    apiError(reply, 401, 'authentication_required', 'Please sign in.');
    return null;
  }
  return actor;
}

function serializePrincipal(value: CustomerPrincipal) {
  return {
    id: value.id,
    tenant_id: value.tenantId,
    email: value.email,
    display_name: value.displayName,
  };
}

function customerInputError(error: CustomerInputError, reply: FastifyReply) {
  switch (error.code) {
    case 'account_exists':
      return apiError(reply, 409, error.code, error.message);
    case 'email_delivery_failed':
      return apiError(reply, 503, error.code, error.message);
    case 'entitlement_unavailable':
      return apiError(reply, 403, error.code, error.message);
    case 'key_limit_reached':
      return apiError(reply, 409, error.code, error.message);
    case 'account_unavailable':
    case 'token_invalid':
      return apiError(reply, 400, error.code, error.message);
  }
}

/** Registers the public product site and customer-only console surface. */
export async function registerCustomerRoutes(
  app: FastifyInstance,
  dependencies: CustomerRouteDependencies,
): Promise<void> {
  const [
    siteHtml,
    siteCss,
    siteJs,
    privacyHtml,
    serviceHtml,
    consoleHtml,
    consoleCss,
    consoleJs,
  ] = await Promise.all([
    readFile(new URL('../public/site/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/site/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/site/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/site/privacy.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/site/service.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/console/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/console/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/console/app.js', import.meta.url), 'utf8'),
  ]);

  app.addHook('onSend', async (request, reply) => {
    const url = request.raw.url ?? '';
    if (url === '/' || url.startsWith('/site/') || url.startsWith('/legal/')) {
      reply.headers({
        'content-security-policy': siteCsp,
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'permissions-policy': 'camera=(), geolocation=(), microphone=()',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
    }
    if (url.startsWith('/console')) {
      reply.headers({
        'cache-control': 'no-store',
        'content-security-policy': consoleCsp,
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'permissions-policy': 'camera=(), geolocation=(), microphone=()',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
    }
  });

  app.get('/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(siteHtml),
  );
  app.get('/site/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(siteCss),
  );
  app.get('/site/app.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(siteJs),
  );
  app.get('/legal/privacy', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(privacyHtml),
  );
  app.get('/legal/service', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(serviceHtml),
  );

  app.get('/console', async (_request, reply) =>
    reply.redirect('/console/', 308),
  );
  for (const path of [
    '/console/',
    '/console/login',
    '/console/register',
    '/console/verify',
    '/console/reset-password',
  ]) {
    app.get(path, async (_request, reply) =>
      reply.type('text/html; charset=utf-8').send(consoleHtml),
    );
  }
  app.get('/console/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(consoleCss),
  );
  app.get('/console/app.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(consoleJs),
  );

  app.post<{ Body: BusinessInquiryRequest }>(
    '/api/inquiries',
    {
      schema: { body: BusinessInquiryRequestSchema },
      config: { rateLimit: publicMutationRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      if (request.body.website !== undefined) return reply.code(204).send();
      await dependencies.service.createBusinessInquiry({
        name: request.body.name,
        email: request.body.email,
        ...(request.body.company === undefined
          ? {}
          : { company: request.body.company }),
        message: request.body.message,
        requestId: request.id,
      });
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Body: CustomerRegistrationRequest }>(
    '/console/api/register',
    {
      schema: { body: CustomerRegistrationRequestSchema },
      config: { rateLimit: publicMutationRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      if (!dependencies.registrationEnabled) {
        return apiError(
          reply,
          503,
          'registration_closed',
          'Public registration is temporarily closed.',
        );
      }
      try {
        await dependencies.service.register({
          email: request.body.email,
          displayName: request.body.display_name,
          organizationName: request.body.organization_name,
          password: request.body.password,
          requestId: request.id,
        });
        reply.code(202);
        return { verification_required: true };
      } catch (error) {
        if (error instanceof CustomerInputError) {
          if (error.code === 'account_exists') {
            reply.code(202);
            return { verification_required: true };
          }
          return customerInputError(error, reply);
        }
        throw error;
      }
    },
  );

  app.post<{ Body: CustomerEmailRequest }>(
    '/console/api/verification/resend',
    {
      schema: { body: CustomerEmailRequestSchema },
      config: { rateLimit: publicMutationRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      await dependencies.service.resendVerification(request.body.email);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Body: CustomerTokenRequest }>(
    '/console/api/verification/confirm',
    {
      schema: { body: CustomerTokenRequestSchema },
      config: { rateLimit: publicMutationRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const verified = await dependencies.service.verifyEmail(
        request.body.token,
        request.id,
      );
      return verified
        ? { verified: true }
        : apiError(
            reply,
            400,
            'token_invalid',
            'The verification link is invalid or expired.',
          );
    },
  );

  app.post<{ Body: CustomerLoginRequest }>(
    '/console/api/login',
    {
      schema: { body: CustomerLoginRequestSchema },
      config: { rateLimit: loginRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const result = await dependencies.service.login({
        email: request.body.email,
        password: request.body.password,
        requestId: request.id,
      });
      if (!result.ok) {
        return apiError(
          reply,
          401,
          'invalid_credentials',
          'The email or password is invalid, or the account is not verified.',
        );
      }
      reply.header(
        'set-cookie',
        sessionCookie(
          result.sessionToken,
          Math.floor(dependencies.sessionTtlMs / 1_000),
        ),
      );
      return {
        user: serializePrincipal(result.principal),
        csrf_token: result.csrfToken,
        expires_at: result.expiresAt.toISOString(),
      };
    },
  );

  app.get(
    '/console/api/session',
    { config: { rateLimit: consoleApiRateLimit } },
    async (request, reply) => {
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        false,
      );
      return actor === null ? reply : { user: serializePrincipal(actor) };
    },
  );

  app.post(
    '/console/api/logout',
    { config: { rateLimit: consoleApiRateLimit } },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        true,
      );
      if (actor === null) return reply;
      const session = cookieValue(request.headers.cookie);
      if (session !== null) {
        await dependencies.service.logout(session, actor, request.id);
      }
      reply.header('set-cookie', clearSessionCookie());
      return reply.code(204).send();
    },
  );

  app.post<{ Body: CustomerEmailRequest }>(
    '/console/api/password-reset/request',
    {
      schema: { body: CustomerEmailRequestSchema },
      config: { rateLimit: publicMutationRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      await dependencies.service.requestPasswordReset(request.body.email);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Body: CustomerPasswordResetRequest }>(
    '/console/api/password-reset/confirm',
    {
      schema: { body: CustomerPasswordResetRequestSchema },
      config: { rateLimit: publicMutationRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const reset = await dependencies.service.resetPassword({
        token: request.body.token,
        password: request.body.password,
        requestId: request.id,
      });
      return reset
        ? { reset: true }
        : apiError(
            reply,
            400,
            'token_invalid',
            'The password reset link is invalid or expired.',
          );
    },
  );

  app.get(
    '/console/api/dashboard',
    { config: { rateLimit: consoleApiRateLimit } },
    async (request, reply) => {
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        false,
      );
      if (actor === null) return reply;
      const dashboard = await dependencies.service.dashboard(actor);
      return {
        user: serializePrincipal(actor),
        entitlements:
          dashboard.entitlements === null
            ? null
            : {
                status: dashboard.entitlements.status,
                plan_code: dashboard.entitlements.planCode,
                allowed_model_patterns:
                  dashboard.entitlements.policy.allowedModelPatterns,
                allow_streaming: dashboard.entitlements.policy.allowStreaming,
                allow_tools: dashboard.entitlements.policy.allowTools,
                requests_per_minute:
                  dashboard.entitlements.policy.requestsPerMinute,
                max_concurrent_requests:
                  dashboard.entitlements.policy.maxConcurrentRequests,
                max_active_api_keys: dashboard.entitlements.maxActiveApiKeys,
              },
        api_keys: dashboard.keys.map((key) => ({
          id: key.id,
          public_id: key.publicId,
          name: key.name,
          environment: key.environment,
          status: key.status,
          created_at: key.createdAt.toISOString(),
          expires_at: key.expiresAt?.toISOString() ?? null,
          last_used_at: key.lastUsedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.post<{ Body: CustomerApiKeyCreateRequest }>(
    '/console/api/api-keys',
    {
      schema: { body: CustomerApiKeyCreateRequestSchema },
      config: { rateLimit: consoleApiRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        true,
      );
      if (actor === null) return reply;
      try {
        const provisioned = await dependencies.service.createApiKey({
          actor,
          name: request.body.name,
          requestId: request.id,
        });
        reply.code(201);
        return {
          credential: provisioned.credential,
          api_key: {
            id: provisioned.apiKey.id,
            public_id: provisioned.apiKey.publicId,
            name: provisioned.apiKey.name,
            expires_at: provisioned.apiKey.expiresAt?.toISOString() ?? null,
          },
        };
      } catch (error) {
        if (error instanceof CustomerInputError) {
          return customerInputError(error, reply);
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: CustomerApiKeyPath }>(
    '/console/api/api-keys/:id',
    {
      schema: { params: CustomerApiKeyPathSchema },
      config: { rateLimit: consoleApiRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        true,
      );
      if (actor === null) return reply;
      const revoked = await dependencies.service.revokeApiKey({
        actor,
        id: request.params.id,
        requestId: request.id,
      });
      return revoked
        ? reply.code(204).send()
        : apiError(reply, 404, 'api_key_not_found', 'API key not found.');
    },
  );
}
