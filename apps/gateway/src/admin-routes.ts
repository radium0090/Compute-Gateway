import { readFile } from 'node:fs/promises';

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  AdminApiKeyCreateRequestSchema,
  AdminApiKeyPathSchema,
  AdminApiKeyQuerySchema,
  AdminLoginRequestSchema,
  AdminPasswordChangeRequestSchema,
  AdminTenantCreateRequestSchema,
  type AdminApiKeyCreateRequest,
  type AdminApiKeyPath,
  type AdminApiKeyQuery,
  type AdminLoginRequest,
  type AdminPasswordChangeRequest,
  type AdminTenantCreateRequest,
} from '@rax-digital/api-contract';
import {
  AdminInputError,
  type AdminConsoleService,
  type AdminPrincipal,
} from '@rax-digital/application';

import type { ReadinessProbe } from './health.js';

const sessionCookieName = '__Host-rcg_admin_session';
const adminCsp = [
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
const adminApiRateLimit = {
  max: 300,
  timeWindow: '1 minute',
  groupId: 'admin-api',
} as const;
const adminLoginRateLimit = {
  max: 30,
  timeWindow: '1 minute',
  groupId: 'admin-login',
} as const;

export type AdminRouteService = Pick<
  AdminConsoleService,
  | 'authenticate'
  | 'authorizeMutation'
  | 'changePassword'
  | 'createApiKey'
  | 'createTenant'
  | 'dashboardSummary'
  | 'listApiKeys'
  | 'listTenants'
  | 'login'
  | 'logout'
  | 'revokeApiKey'
>;

export interface AdminRouteDependencies {
  readonly service: AdminRouteService;
  readonly readinessProbe: ReadinessProbe;
  readonly origin: string;
  readonly sessionTtlMs: number;
  readonly loginLimiter?: AdminLoginLimiter;
}

interface AttemptWindow {
  count: number;
  resetAt: number;
}

/** Small process-owned throttle that bounds expensive anonymous password work. */
export class AdminLoginLimiter {
  private window: AttemptWindow = { count: 0, resetAt: 0 };

  public constructor(
    private readonly maximumAttempts = 30,
    private readonly windowMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  public consume():
    | { readonly allowed: true }
    | {
        readonly allowed: false;
        readonly retryAfterSeconds: number;
      } {
    const now = this.clock();
    if (now >= this.window.resetAt) {
      this.window = { count: 0, resetAt: now + this.windowMs };
    }
    this.window.count += 1;
    if (this.window.count <= this.maximumAttempts) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((this.window.resetAt - now) / 1_000),
      ),
    };
  }
}

function adminError(
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
  return `${sessionCookieName}=${token}; Path=/; Max-Age=${String(maxAgeSeconds)}; Secure; HttpOnly; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

async function requirePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  service: AdminRouteService,
  options: {
    readonly mutation: boolean;
    readonly allowPasswordChange?: boolean;
  },
): Promise<AdminPrincipal | null> {
  const session = cookieValue(request.headers.cookie);
  if (session === null) {
    adminError(reply, 401, 'authentication_required', 'Please sign in.');
    return null;
  }
  const csrf = request.headers['x-rcg-csrf-token'];
  const actor = options.mutation
    ? await service.authorizeMutation(
        session,
        typeof csrf === 'string' ? csrf : '',
      )
    : await service.authenticate(session);
  if (actor === null) {
    adminError(reply, 401, 'authentication_required', 'Please sign in.');
    return null;
  }
  if (actor.mustChangePassword && options.allowPasswordChange !== true) {
    adminError(
      reply,
      403,
      'password_change_required',
      'Change the temporary password before continuing.',
    );
    return null;
  }
  return actor;
}

function checkOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedOrigin: string,
): boolean {
  if (request.headers.origin === expectedOrigin) return true;
  adminError(
    reply,
    403,
    'origin_rejected',
    'The request origin is not allowed.',
  );
  return false;
}

function serializePrincipal(value: AdminPrincipal) {
  return {
    id: value.id,
    email: value.email,
    display_name: value.displayName,
    must_change_password: value.mustChangePassword,
  };
}

/** Registers the versioned administrative API and framework-free console assets. */
export async function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies,
): Promise<void> {
  const [html, css, javascript] = await Promise.all([
    readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin/app.js', import.meta.url), 'utf8'),
  ]);
  const loginLimiter = dependencies.loginLimiter ?? new AdminLoginLimiter();

  // Keep control-plane throttling independent from customer inference traffic.
  // The plugin provides per-client limits; AdminLoginLimiter additionally caps
  // total password hashing work across all clients in this process.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'The administrative request limit was exceeded.',
    }),
  });

  app.addHook('onSend', async (request, reply) => {
    if (!request.raw.url?.startsWith('/admin')) return;
    reply.headers({
      'cache-control': 'no-store',
      'content-security-policy': adminCsp,
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), geolocation=(), microphone=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
  });

  app.get('/admin', async (_request, reply) => reply.redirect('/admin/', 308));
  app.get('/admin/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(html),
  );
  app.get('/admin/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(css),
  );
  app.get('/admin/app.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(javascript),
  );

  app.post<{ Body: AdminLoginRequest }>(
    '/admin/api/login',
    {
      schema: { body: AdminLoginRequestSchema },
      config: { rateLimit: adminLoginRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const admission = loginLimiter.consume();
      if (!admission.allowed) {
        reply.header('retry-after', admission.retryAfterSeconds);
        return adminError(
          reply,
          429,
          'login_rate_limited',
          'Too many login attempts. Try again later.',
        );
      }
      const result = await dependencies.service.login({
        email: request.body.email,
        password: request.body.password,
        requestId: request.id,
      });
      if (!result.ok) {
        return adminError(
          reply,
          401,
          'invalid_credentials',
          'The email or password is invalid.',
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
    '/admin/api/session',
    { config: { rateLimit: adminApiRateLimit } },
    async (request, reply) => {
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: false,
          allowPasswordChange: true,
        },
      );
      if (actor === null) return reply;
      return { user: serializePrincipal(actor) };
    },
  );

  app.post(
    '/admin/api/logout',
    { config: { rateLimit: adminApiRateLimit } },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: true,
          allowPasswordChange: true,
        },
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

  app.post<{ Body: AdminPasswordChangeRequest }>(
    '/admin/api/password',
    {
      schema: { body: AdminPasswordChangeRequestSchema },
      config: { rateLimit: adminApiRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: true,
          allowPasswordChange: true,
        },
      );
      if (actor === null) return reply;
      const changed = await dependencies.service.changePassword({
        actor,
        currentPassword: request.body.current_password,
        newPassword: request.body.new_password,
        requestId: request.id,
      });
      if (!changed) {
        return adminError(
          reply,
          400,
          'current_password_invalid',
          'The current password is invalid.',
        );
      }
      reply.header('set-cookie', clearSessionCookie());
      return { changed: true, reauthentication_required: true };
    },
  );

  app.get(
    '/admin/api/dashboard',
    { config: { rateLimit: adminApiRateLimit } },
    async (request, reply) => {
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: false,
        },
      );
      if (actor === null) return reply;
      const [summary, readiness] = await Promise.all([
        dependencies.service.dashboardSummary(),
        dependencies.readinessProbe.check().catch(() => ({
          ready: false,
          checks: { postgres: 'error' as const },
        })),
      ]);
      return {
        health: {
          ready: readiness.ready,
          checks: readiness.checks ?? { postgres: 'error' },
        },
        summary: {
          tenant_count: summary.tenantCount,
          active_tenant_count: summary.activeTenantCount,
          api_key_count: summary.apiKeyCount,
          active_api_key_count: summary.activeApiKeyCount,
          api_keys_used_24h: summary.apiKeysUsedSince,
        },
      };
    },
  );

  app.get(
    '/admin/api/tenants',
    { config: { rateLimit: adminApiRateLimit } },
    async (request, reply) => {
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: false,
        },
      );
      if (actor === null) return reply;
      const tenants = await dependencies.service.listTenants();
      return {
        data: tenants.map((tenant) => ({
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          created_at: tenant.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post<{ Body: AdminTenantCreateRequest }>(
    '/admin/api/tenants',
    {
      schema: { body: AdminTenantCreateRequestSchema },
      config: { rateLimit: adminApiRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: true,
        },
      );
      if (actor === null) return reply;
      const tenant = await dependencies.service.createTenant({
        actor,
        name: request.body.name,
        requestId: request.id,
      });
      return reply.code(201).send({
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        created_at: tenant.createdAt.toISOString(),
      });
    },
  );

  app.get<{ Querystring: AdminApiKeyQuery }>(
    '/admin/api/api-keys',
    {
      schema: { querystring: AdminApiKeyQuerySchema },
      config: { rateLimit: adminApiRateLimit },
    },
    async (request, reply) => {
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: false,
        },
      );
      if (actor === null) return reply;
      const keys = await dependencies.service.listApiKeys(
        request.query.tenant_id,
      );
      return {
        data: keys.map((key) => ({
          id: key.id,
          public_id: key.publicId,
          tenant_id: key.tenantId,
          tenant_name: key.tenantName,
          name: key.name,
          environment: key.environment,
          status: key.status,
          policy: {
            allowed_model_patterns: key.policy.allowedModelPatterns,
            allow_streaming: key.policy.allowStreaming,
            requests_per_minute: key.policy.requestsPerMinute,
            max_concurrent_requests: key.policy.maxConcurrentRequests,
          },
          created_at: key.createdAt.toISOString(),
          expires_at: key.expiresAt?.toISOString() ?? null,
          last_used_at: key.lastUsedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.post<{ Body: AdminApiKeyCreateRequest }>(
    '/admin/api/api-keys',
    {
      schema: { body: AdminApiKeyCreateRequestSchema },
      config: { rateLimit: adminApiRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: true,
        },
      );
      if (actor === null) return reply;
      let provisioned: Awaited<ReturnType<AdminRouteService['createApiKey']>>;
      try {
        provisioned = await dependencies.service.createApiKey({
          actor,
          value: {
            tenantId: request.body.tenant_id,
            name: request.body.name,
            environment: request.body.environment,
            allowedModelPatterns: request.body.allowed_model_patterns,
            allowStreaming: request.body.allow_streaming,
            requestsPerMinute: request.body.requests_per_minute,
            maxConcurrentRequests: request.body.max_concurrent_requests,
            expiresAt:
              request.body.expires_at === null
                ? null
                : new Date(request.body.expires_at),
          },
          requestId: request.id,
        });
      } catch (error: unknown) {
        if (error instanceof AdminInputError) {
          return adminError(reply, 400, error.code, error.message);
        }
        throw error;
      }
      return reply.code(201).send({
        id: provisioned.apiKey.id,
        public_id: provisioned.apiKey.publicId,
        credential: provisioned.credential,
        warning: 'Copy this credential now. It cannot be shown again.',
      });
    },
  );

  app.post<{ Params: AdminApiKeyPath }>(
    '/admin/api/api-keys/:id/revoke',
    {
      schema: { params: AdminApiKeyPathSchema },
      config: { rateLimit: adminApiRateLimit },
    },
    async (request, reply) => {
      if (!checkOrigin(request, reply, dependencies.origin)) return reply;
      const actor = await requirePrincipal(
        request,
        reply,
        dependencies.service,
        {
          mutation: true,
        },
      );
      if (actor === null) return reply;
      const revoked = await dependencies.service.revokeApiKey({
        actor,
        id: request.params.id,
        requestId: request.id,
      });
      if (!revoked) {
        return adminError(
          reply,
          404,
          'api_key_not_found',
          'The API key was not found or was already revoked.',
        );
      }
      return { revoked: true };
    },
  );
}
