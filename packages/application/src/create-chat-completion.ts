import type {
  ApiKey,
  CanonicalChatRequest,
  CanonicalChatResponse,
  ClientAuthenticator,
  ProviderAdapter,
  ProviderError,
  ProviderStreamCallResult,
  ResolvedRoute,
  RouteResolver,
} from '@genchi/domain';

export type ChatCompletionFailure =
  | { readonly kind: 'authentication' }
  | {
      readonly kind: 'routing';
      readonly reason:
        | 'model_not_allowed'
        | 'model_not_found'
        | 'no_healthy_route'
        | 'streaming_not_allowed';
    }
  | { readonly kind: 'provider'; readonly error: ProviderError };

export type CreateChatCompletionResult =
  | {
      readonly ok: true;
      readonly response: CanonicalChatResponse;
      readonly route: ResolvedRoute;
      readonly attempts: 1;
    }
  | { readonly ok: false; readonly failure: ChatCompletionFailure };

export type CreateChatCompletionStreamResult =
  | {
      readonly ok: true;
      readonly stream: Extract<
        ProviderStreamCallResult,
        { ok: true }
      >['stream'];
      readonly route: ResolvedRoute;
      readonly attempts: 1;
    }
  | { readonly ok: false; readonly failure: ChatCompletionFailure };

export interface CreateChatCompletionInput {
  readonly credential: string;
  readonly requestId: string;
  readonly request: CanonicalChatRequest;
  readonly signal: AbortSignal;
}

/** Orchestrates one authenticated, non-streaming, single-attempt completion. */
export class CreateChatCompletionService {
  public constructor(
    private readonly authenticator: ClientAuthenticator,
    private readonly router: RouteResolver,
    private readonly providers: ReadonlyMap<string, ProviderAdapter>,
  ) {}

  public async execute(
    input: CreateChatCompletionInput,
  ): Promise<CreateChatCompletionResult> {
    const authentication = await this.authenticator.authenticate(
      input.credential,
    );
    if (!authentication.authenticated) {
      return { ok: false, failure: { kind: 'authentication' } };
    }

    return this.executeAuthenticated(input, authentication.apiKey);
  }

  public async executeStream(
    input: CreateChatCompletionInput,
  ): Promise<CreateChatCompletionStreamResult> {
    const authentication = await this.authenticator.authenticate(
      input.credential,
    );
    if (!authentication.authenticated) {
      return { ok: false, failure: { kind: 'authentication' } };
    }
    if (!authentication.apiKey.policy.allowStreaming) {
      return {
        ok: false,
        failure: {
          kind: 'routing',
          reason: 'streaming_not_allowed',
        },
      };
    }

    const resolution = this.router.resolve({
      requestedModel: input.request.model,
      requestId: input.requestId,
      apiKey: authentication.apiKey,
      requireStreaming: true,
    });
    if (!resolution.ok) {
      return {
        ok: false,
        failure: { kind: 'routing', reason: resolution.reason },
      };
    }

    const adapter = this.providers.get(resolution.route.providerRef);
    const capabilities = adapter?.capabilities(resolution.route.providerModel);
    if (adapter === undefined || capabilities?.streaming !== true) {
      return {
        ok: false,
        failure: { kind: 'routing', reason: 'no_healthy_route' },
      };
    }

    const result = await adapter.streamChatCompletion(input.request, {
      requestId: input.requestId,
      providerModel: resolution.route.providerModel,
      signal: input.signal,
    });
    if (!result.ok) {
      return { ok: false, failure: { kind: 'provider', error: result.error } };
    }
    return {
      ok: true,
      stream: result.stream,
      route: resolution.route,
      attempts: 1,
    };
  }

  private async executeAuthenticated(
    input: CreateChatCompletionInput,
    apiKey: ApiKey,
  ): Promise<CreateChatCompletionResult> {
    const resolution = this.router.resolve({
      requestedModel: input.request.model,
      requestId: input.requestId,
      apiKey,
    });
    if (!resolution.ok) {
      return {
        ok: false,
        failure: { kind: 'routing', reason: resolution.reason },
      };
    }

    const adapter = this.providers.get(resolution.route.providerRef);
    if (adapter?.capabilities(resolution.route.providerModel) == null) {
      return {
        ok: false,
        failure: { kind: 'routing', reason: 'no_healthy_route' },
      };
    }

    const result = await adapter.createChatCompletion(input.request, {
      requestId: input.requestId,
      providerModel: resolution.route.providerModel,
      signal: input.signal,
    });
    if (!result.ok) {
      return { ok: false, failure: { kind: 'provider', error: result.error } };
    }

    return {
      ok: true,
      response: result.response,
      route: resolution.route,
      attempts: 1,
    };
  }
}
