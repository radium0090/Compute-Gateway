import { readFile } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  DemoOAuthCallbackQuerySchema,
  type DemoOAuthCallbackQuery,
} from '@rax-digital/api-contract';
import {
  DemoClaimError,
  type DemoClaimService,
  type DemoClaimSuccess,
} from '@rax-digital/application';

const stateCookieName = '__Host-rcg_demo_state';
const verifierCookieName = '__Host-rcg_demo_verifier';
const demoCsp = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export type DemoRouteService = Pick<DemoClaimService, 'begin' | 'complete'>;

export interface DemoRouteDependencies {
  readonly service: DemoRouteService;
  readonly origin: string;
  readonly startLimiter?: DemoStartLimiter;
}

interface AttemptWindow {
  count: number;
  resetAt: number;
}

/** Process-level flood guard; PostgreSQL separately enforces claim budgets. */
export class DemoStartLimiter {
  private window: AttemptWindow = { count: 0, resetAt: 0 };

  public constructor(
    private readonly maximumStarts = 60,
    private readonly windowMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  public consume(): boolean {
    const now = this.clock();
    if (now >= this.window.resetAt) {
      this.window = { count: 0, resetAt: now + this.windowMs };
    }
    this.window.count += 1;
    return this.window.count <= this.maximumStarts;
  }
}

function cookieValue(
  header: string | undefined,
  wanted: string,
): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === wanted) return rest.join('=') || null;
  }
  return null;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${String(maxAge)}; Secure; HttpOnly; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/demo/app.css"></head>
<body><main><p class="eyebrow">RAX Compute Gateway</p>${body}</main></body></html>`;
}

function resultPage(origin: string, result: DemoClaimSuccess): string {
  const payload = JSON.stringify({
    model: result.model,
    messages: [{ role: 'user', content: 'Reply with one short hello.' }],
    max_tokens: result.maxOutputTokens,
  });
  const curl = `curl ${origin}/v1/chat/completions \\
  -H 'Authorization: Bearer ${result.credential}' \\
  -H 'Content-Type: application/json' \\
  -d '${payload}'`;
  return page(
    'Your five-minute RAX key',
    `<h1>Your trial key is ready.</h1><p class="lede">It expires at <strong>${escapeHtml(result.expiresAt.toISOString())}</strong>. This page is the only time the credential is displayed.</p><p class="notice">Copy and run this command now. Do not share the credential.</p><textarea readonly aria-label="Ready-to-run curl command">${escapeHtml(curl)}</textarea><p><a href="/demo">Back to trial information</a></p>`,
  );
}

function errorPage(code: DemoClaimError['code'] | 'oauth_cancelled'): string {
  const messages = {
    account_not_eligible:
      'This GitHub account is too new for the public trial.',
    already_claimed:
      'This GitHub account has already claimed a recent trial key.',
    claim_limit_reached:
      'The public trial has reached its daily budget. Please try again tomorrow.',
    identity_unavailable:
      'GitHub identity verification is temporarily unavailable.',
    invalid_oauth_state:
      'The authorization request expired or could not be verified.',
    tenant_unavailable: 'The public trial is temporarily unavailable.',
    oauth_cancelled: 'GitHub authorization was cancelled.',
  } as const;
  return page(
    'RAX trial unavailable',
    `<h1>We could not issue a key.</h1><p class="lede">${escapeHtml(messages[code])}</p><p><a class="button" href="/demo">Try again</a></p>`,
  );
}

function errorStatus(code: DemoClaimError['code']): number {
  switch (code) {
    case 'account_not_eligible':
    case 'invalid_oauth_state':
      return 400;
    case 'already_claimed':
      return 409;
    case 'claim_limit_reached':
      return 429;
    case 'identity_unavailable':
    case 'tenant_unavailable':
      return 503;
  }
}

function html(reply: FastifyReply, statusCode: number, contents: string) {
  return reply.code(statusCode).type('text/html; charset=utf-8').send(contents);
}

/** Registers the optional hosted evaluation page and one-time OAuth callback. */
export async function registerDemoRoutes(
  app: FastifyInstance,
  dependencies: DemoRouteDependencies,
): Promise<void> {
  const [index, css] = await Promise.all([
    readFile(new URL('../public/demo/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/demo/app.css', import.meta.url), 'utf8'),
  ]);
  const limiter = dependencies.startLimiter ?? new DemoStartLimiter();

  app.addHook('onSend', async (request, reply) => {
    if (!request.raw.url?.startsWith('/demo')) return;
    reply.headers({
      'cache-control': 'no-store',
      'content-security-policy': demoCsp,
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), geolocation=(), microphone=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
  });

  app.get('/demo', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(index),
  );
  app.get('/demo/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(index),
  );
  app.get('/demo/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(css),
  );
  app.get('/demo/github', async (_request, reply) => {
    if (!limiter.consume()) {
      return html(reply, 429, errorPage('claim_limit_reached'));
    }
    const started = await dependencies.service.begin();
    const maxAge = Math.max(
      1,
      Math.ceil((started.expiresAt.getTime() - Date.now()) / 1_000),
    );
    reply.header('set-cookie', [
      secureCookie(stateCookieName, started.state, maxAge),
      secureCookie(verifierCookieName, started.codeVerifier, maxAge),
    ]);
    return reply.redirect(started.authorizationUrl);
  });
  app.get<{ Querystring: DemoOAuthCallbackQuery }>(
    '/demo/callback',
    { schema: { querystring: DemoOAuthCallbackQuerySchema } },
    async (request, reply) => {
      reply.header('set-cookie', [
        clearCookie(stateCookieName),
        clearCookie(verifierCookieName),
      ]);
      if (
        request.query.error !== undefined ||
        request.query.code === undefined ||
        request.query.state === undefined
      ) {
        return html(reply, 400, errorPage('oauth_cancelled'));
      }
      const cookieState = cookieValue(request.headers.cookie, stateCookieName);
      const verifier = cookieValue(request.headers.cookie, verifierCookieName);
      if (cookieState === null || verifier === null) {
        return html(reply, 400, errorPage('invalid_oauth_state'));
      }
      try {
        const result = await dependencies.service.complete({
          code: request.query.code,
          returnedState: request.query.state,
          cookieState,
          codeVerifier: verifier,
        });
        return await html(reply, 200, resultPage(dependencies.origin, result));
      } catch (error: unknown) {
        if (error instanceof DemoClaimError) {
          return html(reply, errorStatus(error.code), errorPage(error.code));
        }
        throw error;
      }
    },
  );
}
