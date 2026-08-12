import { createHash } from 'node:crypto';

import type { PolicyConfig } from '@rax-digital/config';
import type {
  ApiKey,
  ModelCatalog,
  PublicModel,
  ResolvedRoute,
  RoutePlanResolutionResult,
  RoutePlanner,
  RouteResolutionResult,
  RouteResolver,
} from '@rax-digital/domain';

type ConfiguredCapability =
  PolicyConfig['providers'][string]['models'][string]['capabilities'][number];

function patternAllows(pattern: string, requestedModel: string): boolean {
  if (pattern.endsWith('*')) {
    return requestedModel.startsWith(pattern.slice(0, -1));
  }
  return pattern === requestedModel;
}

function selectStableWeighted<T extends { readonly weight: number }>(
  candidates: readonly T[],
  key: string,
): T | null {
  const total = candidates.reduce(
    (sum, candidate) => sum + candidate.weight,
    0,
  );
  if (total <= 0) {
    return null;
  }
  const digest = createHash('sha256').update(key, 'utf8').digest();
  const target = Number(digest.readBigUInt64BE(0) % BigInt(total));
  let cursor = 0;
  for (const candidate of candidates) {
    cursor += candidate.weight;
    if (target < cursor) {
      return candidate;
    }
  }
  return null;
}

function supportsEveryCapability(
  capabilities: readonly ConfiguredCapability[],
  required: readonly ConfiguredCapability[],
): boolean {
  return required.every((capability) => capabilities.includes(capability));
}

/** Resolves deterministic primary routes and ordered fallback plans. */
export class StaticPolicyRouter implements RouteResolver, RoutePlanner {
  public constructor(private readonly policy: PolicyConfig) {}

  public resolve(input: {
    readonly requestedModel: string;
    readonly requestId: string;
    readonly apiKey: ApiKey;
    readonly requireStreaming?: boolean;
  }): RouteResolutionResult {
    const result = this.plan(input);
    if (!result.ok) return result;
    const route = result.plan.routes[0];
    return route === undefined
      ? { ok: false, reason: 'no_healthy_route' }
      : { ok: true, route };
  }

  public plan(input: {
    readonly requestedModel: string;
    readonly requestId: string;
    readonly apiKey: ApiKey;
    readonly requireStreaming?: boolean;
  }): RoutePlanResolutionResult {
    if (
      !input.apiKey.policy.allowedModelPatterns.some((pattern) =>
        patternAllows(pattern, input.requestedModel),
      )
    ) {
      return { ok: false, reason: 'model_not_allowed' };
    }

    if (input.requestedModel.startsWith('rax/')) {
      return this.planAlias(
        input.requestedModel,
        input.requestId,
        input.requireStreaming === true,
      );
    }
    return this.planQualifiedModel(
      input.requestedModel,
      input.requireStreaming === true,
    );
  }

  private planAlias(
    aliasName: string,
    requestId: string,
    requireStreaming: boolean,
  ): RoutePlanResolutionResult {
    const alias = this.policy.aliases[aliasName];
    if (alias === undefined) {
      return { ok: false, reason: 'model_not_found' };
    }
    const required: readonly ConfiguredCapability[] = [
      'chat',
      ...(requireStreaming ? (['streaming'] as const) : []),
      ...(alias.required_capabilities ?? []),
    ];
    const candidates = alias.candidates.filter((candidate) => {
      const model =
        this.policy.providers[candidate.provider]?.models[candidate.model];
      return (
        model !== undefined &&
        supportsEveryCapability(model.capabilities, required)
      );
    });
    const primaries = candidates.filter((candidate) => candidate.weight > 0);
    const selected = selectStableWeighted(
      primaries,
      `${requestId}\u0000${aliasName}`,
    );
    if (selected === null) return { ok: false, reason: 'no_healthy_route' };
    const ordered = [
      selected,
      ...primaries.filter((candidate) => candidate !== selected),
      ...candidates.filter((candidate) => candidate.weight === 0),
    ];
    return {
      ok: true,
      plan: {
        routes: ordered.map((candidate) =>
          this.toResolvedRoute(candidate.provider, candidate.model),
        ),
        candidateCount: alias.candidates.length,
        selectionReason: 'stable_weighted_primary',
      },
    };
  }

  private planQualifiedModel(
    requestedModel: string,
    requireStreaming: boolean,
  ): RoutePlanResolutionResult {
    const separator = requestedModel.indexOf('/');
    if (separator <= 0 || separator === requestedModel.length - 1) {
      return { ok: false, reason: 'model_not_found' };
    }
    const adapter = requestedModel.slice(0, separator);
    const modelName = requestedModel.slice(separator + 1);
    const matches = Object.entries(this.policy.providers).filter(
      ([, provider]) => {
        const model = provider.models[modelName];
        return (
          provider.adapter === adapter &&
          model !== undefined &&
          model.capabilities.includes('chat') &&
          (!requireStreaming || model.capabilities.includes('streaming'))
        );
      },
    );
    if (matches.length !== 1) {
      return { ok: false, reason: 'model_not_found' };
    }
    const providerRef = matches[0]?.[0];
    return providerRef === undefined
      ? { ok: false, reason: 'model_not_found' }
      : {
          ok: true,
          plan: {
            routes: [this.toResolvedRoute(providerRef, modelName)],
            candidateCount: 1,
            selectionReason: 'qualified_model',
          },
        };
  }

  private toResolvedRoute(
    providerRef: string,
    providerModel: string,
  ): ResolvedRoute {
    const provider = this.policy.providers[providerRef];
    if (provider === undefined) {
      throw new TypeError('Validated policy contains an unknown provider');
    }
    return {
      providerRef,
      provider: provider.adapter,
      providerModel,
    };
  }
}

/** Enumerates configured, unambiguous public models allowed by one key. */
export class StaticModelCatalog implements ModelCatalog {
  public constructor(private readonly policy: PolicyConfig) {}

  public listAllowed(apiKey: ApiKey): readonly PublicModel[] {
    const ids = new Set<string>();
    for (const [aliasName, alias] of Object.entries(this.policy.aliases)) {
      const exposesChat = alias.candidates.some(
        (candidate) =>
          this.policy.providers[candidate.provider]?.models[
            candidate.model
          ]?.capabilities.includes('chat') === true,
      );
      if (exposesChat && this.keyAllows(apiKey, aliasName)) {
        ids.add(aliasName);
      }
    }

    const qualifiedCounts = new Map<string, number>();
    for (const provider of Object.values(this.policy.providers)) {
      for (const [modelName, model] of Object.entries(provider.models)) {
        if (!model.capabilities.includes('chat')) {
          continue;
        }
        const id = `${provider.adapter}/${modelName}`;
        qualifiedCounts.set(id, (qualifiedCounts.get(id) ?? 0) + 1);
      }
    }
    for (const [id, count] of qualifiedCounts) {
      if (count === 1 && this.keyAllows(apiKey, id)) {
        ids.add(id);
      }
    }
    return [...ids].sort().map((id) => ({ id }));
  }

  private keyAllows(apiKey: ApiKey, model: string): boolean {
    return apiKey.policy.allowedModelPatterns.some((pattern) =>
      patternAllows(pattern, model),
    );
  }
}
