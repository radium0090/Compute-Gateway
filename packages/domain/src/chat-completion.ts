import type { ApiKey } from './api-key.js';

export type CanonicalMessageRole =
  'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface CanonicalToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    /** JSON-encoded arguments are kept opaque until the agent executes them. */
    readonly arguments: string;
  };
}

export type CanonicalChatMessage =
  | {
      readonly role: 'system' | 'developer' | 'user';
      readonly content: string;
    }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls?: readonly CanonicalToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly content: string;
      readonly toolCallId: string;
    };

export interface CanonicalFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Readonly<Record<string, unknown>>;
    readonly strict?: boolean;
  };
}

export type CanonicalToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
      readonly type: 'function';
      readonly function: { readonly name: string };
    };

export type CanonicalResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly jsonSchema: {
        readonly name: string;
        readonly description?: string;
        readonly schema: Readonly<Record<string, unknown>>;
        readonly strict?: boolean;
      };
    };

export interface CanonicalChatRequest {
  readonly model: string;
  readonly messages: readonly CanonicalChatMessage[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly stop?: string | readonly string[];
  readonly user?: string;
  readonly tools?: readonly CanonicalFunctionTool[];
  readonly toolChoice?: CanonicalToolChoice;
  readonly parallelToolCalls?: boolean;
  readonly responseFormat?: CanonicalResponseFormat;
}

export type CanonicalFinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface CanonicalUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CanonicalChatResponse {
  readonly content: string | null;
  readonly toolCalls?: readonly CanonicalToolCall[];
  readonly finishReason: CanonicalFinishReason;
  readonly usage: CanonicalUsage;
}

export interface CanonicalChatChunk {
  readonly choice?: {
    readonly delta: {
      readonly role?: 'assistant';
      readonly content?: string;
      readonly toolCalls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly type?: 'function';
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }[];
    };
    readonly finishReason: CanonicalFinishReason;
  };
  readonly usage?: CanonicalUsage;
}

export interface ProviderCapabilities {
  readonly chat: true;
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly strictTools?: boolean;
  readonly parallelToolControl?: boolean;
  readonly jsonObject: boolean;
  readonly jsonSchema: boolean;
  readonly systemMessages: boolean;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export type ProviderCapability =
  | 'chat'
  | 'streaming'
  | 'tools'
  | 'strict_tools'
  | 'parallel_tool_control'
  | 'json_object'
  | 'json_schema';

/** Derives the provider features that must survive routing and translation. */
export function requiredProviderCapabilities(
  request: CanonicalChatRequest,
  streaming: boolean,
): readonly ProviderCapability[] {
  const required: ProviderCapability[] = ['chat'];
  if (streaming) required.push('streaming');
  if (
    request.tools !== undefined ||
    request.messages.some(
      (message) =>
        message.role === 'tool' ||
        (message.role === 'assistant' && message.toolCalls !== undefined),
    )
  ) {
    required.push('tools');
  }
  if (request.tools?.some((tool) => tool.function.strict === true) === true) {
    required.push('strict_tools');
  }
  if (request.parallelToolCalls === false) {
    required.push('parallel_tool_control');
  }
  if (request.responseFormat?.type === 'json_object') {
    required.push('json_object');
  }
  if (request.responseFormat?.type === 'json_schema') {
    required.push('json_schema');
  }
  return required;
}

/** Checks declared model capabilities without importing provider code. */
export function providerSupportsChatRequest(
  capabilities: ProviderCapabilities,
  request: CanonicalChatRequest,
  streaming: boolean,
): boolean {
  return requiredProviderCapabilities(request, streaming).every(
    (capability) => {
      switch (capability) {
        case 'chat':
          return capabilities.chat;
        case 'streaming':
          return capabilities.streaming;
        case 'tools':
          return capabilities.tools;
        case 'strict_tools':
          return capabilities.strictTools === true;
        case 'parallel_tool_control':
          return capabilities.parallelToolControl === true;
        case 'json_object':
          return capabilities.jsonObject;
        case 'json_schema':
          return capabilities.jsonSchema;
      }
    },
  );
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
    readonly requiredCapabilities?: readonly ProviderCapability[];
  }): RouteResolutionResult;
}

/** Builds an ordered, deterministic candidate plan for bounded fallback. */
export interface RoutePlanner {
  plan(input: {
    readonly requestedModel: string;
    readonly requestId: string;
    readonly apiKey: ApiKey;
    readonly requireStreaming?: boolean;
    readonly requiredCapabilities?: readonly ProviderCapability[];
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
