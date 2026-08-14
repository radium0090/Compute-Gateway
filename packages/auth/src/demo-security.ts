import {
  createHash,
  createHmac,
  randomBytes as platformRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

type RandomBytes = (size: number) => Uint8Array;

/** Cryptographic helpers for the isolated hosted-demo OAuth flow. */
export class NodeDemoSecurity {
  public constructor(
    private readonly pepper: string,
    private readonly randomBytes: RandomBytes = platformRandomBytes,
  ) {
    if (pepper.length < 32) {
      throw new TypeError(
        'Demo hash pepper must contain at least 32 characters',
      );
    }
  }

  public generateOpaqueToken(): string {
    return Buffer.from(this.randomBytes(32)).toString('base64url');
  }

  public hashState(token: string): string {
    return this.hash('oauth-state', token);
  }

  public hashIdentity(subject: string): string {
    return this.hash('github-identity', subject);
  }

  public verifyState(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashState(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return (
      actual.byteLength === expected.byteLength &&
      timingSafeEqual(actual, expected)
    );
  }

  public pkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier, 'utf8').digest('base64url');
  }

  private hash(purpose: string, value: string): string {
    return createHmac('sha256', this.pepper)
      .update(`${purpose}\u0000${value}`, 'utf8')
      .digest('hex');
  }
}

export interface GitHubIdentity {
  readonly subject: string;
  readonly accountCreatedAt: Date;
}

export interface GitHubOAuthClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** Minimal no-scope GitHub OAuth client that immediately discards access tokens. */
export class GitHubOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: GitHubOAuthClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  public authorizationUrl(state: string, codeChallenge: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  }

  public async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<GitHubIdentity> {
    const tokenResponse = await this.fetchImpl(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          code,
          redirect_uri: this.options.redirectUri,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    const tokenBody = object(await tokenResponse.json().catch(() => null));
    const accessToken = tokenBody?.access_token;
    if (!tokenResponse.ok || typeof accessToken !== 'string') {
      throw new Error('GitHub OAuth token exchange failed');
    }

    const userResponse = await this.fetchImpl('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'RAX-Compute-Gateway-Demo',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const user = object(await userResponse.json().catch(() => null));
    const id = user?.id;
    const createdAt = user?.created_at;
    if (
      !userResponse.ok ||
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      typeof createdAt !== 'string'
    ) {
      throw new Error('GitHub identity verification failed');
    }
    const accountCreatedAt = new Date(createdAt);
    if (Number.isNaN(accountCreatedAt.getTime())) {
      throw new Error('GitHub identity verification failed');
    }
    return { subject: `github:${String(id)}`, accountCreatedAt };
  }
}
