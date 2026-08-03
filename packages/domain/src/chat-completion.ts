import type { ApiKey } from './api-key.js';

export type CanonicalMessageRole = 'system' | 'user' | 'assistant';

export interface CanonicalChatMessage {
  readonly role: CanonicalMessageRole;
  readonly content: string;
}

export interface CanonicalChatRequest {
  readonly model: string;
  readonly messages: readonly CanonicalChatMessage[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly stop?: string | readonly string[];
  readonly user?: string;
}

export type CanonicalFinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface CanonicalUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CanonicalChatResponse {
  readonly content: string;
  readonly finishReason: CanonicalFinishReason;
  readonly usage: CanonicalUsage;
}

export interface CanonicalChatChunk {
  readonly choice?: {
    readonly delta: {
      readonly role?: 'assistant';
      readonly content?: string;
    };
    readonly finishReason: CanonicalFinishReason;
  };
  readonly usage?: CanonicalUsage;
}

export interface ProviderCapabilities {
  readonly chat: true;
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly jsonObject: boolean;
  readonly jsonSchema: boolean;
  readonly systemMessages: boolean;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export type ProviderErrorClass =
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'request'
  | 'policy'
  | 'protocol';

export interface ProviderError {
  readonly class: ProviderErrorClass;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}

/** Safe typed failure emitted after a provider stream has been established. */
export class ProviderStreamFailure extends Error {
  public constructor(public readonly providerError: ProviderError) {
    super(providerError.code);
    this.name = 'ProviderStreamFailure';
  }
}

export type ProviderCallResult =
  | { readonly ok: true; readonly response: CanonicalChatResponse }
  | { readonly ok: false; readonly error: ProviderError };

export type ProviderStreamCallResult =
  | {
      readonly ok: true;
      readonly stream: AsyncIterable<CanonicalChatChunk>;
    }
  | { readonly ok: false; readonly error: ProviderError };

export interface ProviderCallContext {
  readonly requestId: string;
  readonly providerModel: string;
  readonly signal: AbortSignal;
  readonly connectTimeoutMs?: number;
}

/** Provider-neutral port implemented independently by each provider package. */
export interface ProviderAdapter {
  readonly id: string;
  capabilities(model: string): ProviderCapabilities | null;
  createChatCompletion(
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): Promise<ProviderCallResult>;
  streamChatCompletion(
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): Promise<ProviderStreamCallResult>;
}

export interface ResolvedRoute {
  readonly providerRef: string;
  readonly provider: string;
  readonly providerModel: string;
}

export type RouteResolutionResult =
  | { readonly ok: true; readonly route: ResolvedRoute }
  | {
      readonly ok: false;
      readonly reason:
        'model_not_allowed' | 'model_not_found' | 'no_healthy_route';
    };

export interface ResolvedRoutePlan {
  readonly routes: readonly ResolvedRoute[];
  readonly candidateCount: number;
  readonly selectionReason:
    'stable_weighted_primary' | 'qualified_model' | 'legacy_single_route';
}

export type RoutePlanResolutionResult =
  | { readonly ok: true; readonly plan: ResolvedRoutePlan }
  | Exclude<RouteResolutionResult, { readonly ok: true }>;

export interface RouteResolver {
  resolve(input: {
    readonly requestedModel: string;
    readonly requestId: string;
    readonly apiKey: ApiKey;
    readonly requireStreaming?: boolean;
  }): RouteResolutionResult;
}

/** Builds an ordered, deterministic candidate plan for bounded fallback. */
export interface RoutePlanner {
  plan(input: {
    readonly requestedModel: string;
    readonly requestId: string;
    readonly apiKey: ApiKey;
    readonly requireStreaming?: boolean;
  }): RoutePlanResolutionResult;
}

export interface PublicModel {
  readonly id: string;
}

/** Policy-backed model catalog, independent of HTTP serialization. */
export interface ModelCatalog {
  listAllowed(apiKey: ApiKey): readonly PublicModel[];
}

export interface ClientAuthenticator {
  authenticate(
    credential: string,
  ): Promise<
    | { readonly authenticated: true; readonly apiKey: ApiKey }
    | { readonly authenticated: false }
  >;
}
