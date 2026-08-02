import type {
  ApiKey,
  CanonicalChatRequest,
  CanonicalChatResponse,
  ClientAuthenticator,
  ProviderAdapter,
  ProviderError,
  ResolvedRoute,
  RouteResolver,
} from '@genchi/domain';

export type ChatCompletionFailure =
  | { readonly kind: 'authentication' }
  | {
      readonly kind: 'routing';
      readonly reason:
        'model_not_allowed' | 'model_not_found' | 'no_healthy_route';
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
