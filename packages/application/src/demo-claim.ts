import {
  tenantId,
  type ApiKey,
  type ApiKeyEnvironment,
  type TenantId,
} from '@rax-digital/domain';

import type { ApiKeyProvisionerPort } from './admin-console.js';

export interface DemoStateRecord {
  readonly stateHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type DemoClaimCreateResult =
  | { readonly created: true }
  | {
      readonly created: false;
      readonly reason:
        'account_cooldown' | 'daily_limit' | 'tenant_unavailable';
    };

export interface DemoClaimRepository {
  createState(state: DemoStateRecord): Promise<void>;
  consumeState(stateHash: string, consumedAt: Date): Promise<boolean>;
  createClaim(input: {
    readonly identityHash: string;
    readonly apiKey: ApiKey;
    readonly claimedAt: Date;
    readonly cooldownThreshold: Date;
    readonly dailyWindowStart: Date;
    readonly maximumDailyClaims: number;
  }): Promise<DemoClaimCreateResult>;
}

export interface DemoSecurityPort {
  generateOpaqueToken(): string;
  hashState(token: string): string;
  hashIdentity(subject: string): string;
  verifyState(token: string, expectedHash: string): boolean;
  pkceChallenge(verifier: string): string;
}

export interface DemoIdentityProviderPort {
  authorizationUrl(state: string, codeChallenge: string): string;
  exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<{
    readonly subject: string;
    readonly accountCreatedAt: Date;
  }>;
}

export interface DemoClaimServiceOptions {
  readonly tenantId: string;
  readonly environment: ApiKeyEnvironment;
  readonly model: string;
  readonly keyTtlMs: number;
  readonly stateTtlMs: number;
  readonly accountMinimumAgeDays: number;
  readonly accountCooldownMs: number;
  readonly maximumDailyClaims: number;
  readonly requestsPerMinute: number;
  readonly maxRequestTokens: number;
  readonly maxOutputTokens: number;
  readonly clock?: () => Date;
  readonly idGenerator: () => string;
}

export interface DemoClaimStart {
  readonly state: string;
  readonly codeVerifier: string;
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
}

export interface DemoClaimSuccess {
  readonly credential: string;
  readonly expiresAt: Date;
  readonly model: string;
  readonly maxOutputTokens: number;
}

export type DemoClaimErrorCode =
  | 'account_not_eligible'
  | 'already_claimed'
  | 'claim_limit_reached'
  | 'identity_unavailable'
  | 'invalid_oauth_state'
  | 'tenant_unavailable';

export class DemoClaimError extends Error {
  public constructor(public readonly code: DemoClaimErrorCode) {
    super(code);
    this.name = 'DemoClaimError';
  }
}

function utcDayStart(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/** Issues tightly scoped, five-minute evaluation keys after GitHub identity proof. */
export class DemoClaimService {
  private readonly clock: () => Date;
  private readonly tenant: TenantId;

  public constructor(
    private readonly repository: DemoClaimRepository,
    private readonly security: DemoSecurityPort,
    private readonly identityProvider: DemoIdentityProviderPort,
    private readonly apiKeyProvisioner: ApiKeyProvisionerPort,
    private readonly options: DemoClaimServiceOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.tenant = tenantId(options.tenantId);
    if (options.keyTtlMs < 60_000 || options.keyTtlMs > 300_000) {
      throw new TypeError(
        'Demo key lifetime must be between one and five minutes',
      );
    }
  }

  public async begin(): Promise<DemoClaimStart> {
    const now = this.clock();
    const state = this.security.generateOpaqueToken();
    const codeVerifier = this.security.generateOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.options.stateTtlMs);
    await this.repository.createState({
      stateHash: this.security.hashState(state),
      createdAt: now,
      expiresAt,
    });
    return {
      state,
      codeVerifier,
      expiresAt,
      authorizationUrl: this.identityProvider.authorizationUrl(
        state,
        this.security.pkceChallenge(codeVerifier),
      ),
    };
  }

  public async complete(input: {
    readonly code: string;
    readonly returnedState: string;
    readonly cookieState: string;
    readonly codeVerifier: string;
  }): Promise<DemoClaimSuccess> {
    const now = this.clock();
    const cookieHash = this.security.hashState(input.cookieState);
    if (!this.security.verifyState(input.returnedState, cookieHash)) {
      throw new DemoClaimError('invalid_oauth_state');
    }
    if (
      !(await this.repository.consumeState(
        this.security.hashState(input.returnedState),
        now,
      ))
    ) {
      throw new DemoClaimError('invalid_oauth_state');
    }

    let identity: Awaited<ReturnType<DemoIdentityProviderPort['exchangeCode']>>;
    try {
      identity = await this.identityProvider.exchangeCode(
        input.code,
        input.codeVerifier,
      );
    } catch {
      throw new DemoClaimError('identity_unavailable');
    }
    const minimumCreatedAt = new Date(
      now.getTime() - this.options.accountMinimumAgeDays * 86_400_000,
    );
    if (identity.accountCreatedAt > minimumCreatedAt) {
      throw new DemoClaimError('account_not_eligible');
    }

    const expiresAt = new Date(now.getTime() + this.options.keyTtlMs);
    const provisioned = this.apiKeyProvisioner.provision({
      id: this.options.idGenerator(),
      tenantId: this.tenant,
      name: `hosted-demo-${now.toISOString().slice(0, 10)}`,
      environment: this.options.environment,
      policy: {
        allowedModelPatterns: [this.options.model],
        allowStreaming: false,
        allowTools: false,
        requestsPerMinute: this.options.requestsPerMinute,
        maxConcurrentRequests: 1,
        maxRequestTokens: this.options.maxRequestTokens,
        maxOutputTokens: this.options.maxOutputTokens,
      },
      expiresAt,
      now,
    });
    const result = await this.repository.createClaim({
      identityHash: this.security.hashIdentity(identity.subject),
      apiKey: provisioned.apiKey,
      claimedAt: now,
      cooldownThreshold: new Date(
        now.getTime() - this.options.accountCooldownMs,
      ),
      dailyWindowStart: utcDayStart(now),
      maximumDailyClaims: this.options.maximumDailyClaims,
    });
    if (!result.created) {
      const code = {
        account_cooldown: 'already_claimed',
        daily_limit: 'claim_limit_reached',
        tenant_unavailable: 'tenant_unavailable',
      } as const;
      throw new DemoClaimError(code[result.reason]);
    }
    return {
      credential: provisioned.credential,
      expiresAt,
      model: this.options.model,
      maxOutputTokens: this.options.maxOutputTokens,
    };
  }
}
