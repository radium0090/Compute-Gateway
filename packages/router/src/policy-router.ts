import { createHash } from 'node:crypto';

import type { PolicyConfig } from '@genchi/config';
import type {
  ApiKey,
  ModelCatalog,
  PublicModel,
  ResolvedRoute,
  RouteResolutionResult,
  RouteResolver,
} from '@genchi/domain';

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

/** Resolves only the first deterministic provider attempt; fallback is later scope. */
export class StaticPolicyRouter implements RouteResolver {
  public constructor(private readonly policy: PolicyConfig) {}

  public resolve(input: {
    readonly requestedModel: string;
    readonly requestId: string;
    readonly apiKey: ApiKey;
    readonly requireStreaming?: boolean;
  }): RouteResolutionResult {
    if (
      !input.apiKey.policy.allowedModelPatterns.some((pattern) =>
        patternAllows(pattern, input.requestedModel),
      )
    ) {
      return { ok: false, reason: 'model_not_allowed' };
    }

    if (input.requestedModel.startsWith('genchi/')) {
      return this.resolveAlias(
        input.requestedModel,
        input.requestId,
        input.requireStreaming === true,
      );
    }
    return this.resolveQualifiedModel(
      input.requestedModel,
      input.requireStreaming === true,
    );
  }

  private resolveAlias(
    aliasName: string,
    requestId: string,
    requireStreaming: boolean,
  ): RouteResolutionResult {
    const alias = this.policy.aliases[aliasName];
    if (alias === undefined) {
      return { ok: false, reason: 'model_not_found' };
    }
    const required = new Set([
      'chat',
      ...(requireStreaming ? ['streaming'] : []),
      ...(alias.required_capabilities ?? []),
    ]);
    const candidates = alias.candidates.filter((candidate) => {
      if (candidate.weight <= 0) {
        return false;
      }
      const model =
        this.policy.providers[candidate.provider]?.models[candidate.model];
      return (
        model !== undefined &&
        [...required].every((capability) =>
          model.capabilities.includes(
            capability as (typeof model.capabilities)[number],
          ),
        )
      );
    });
    const selected = selectStableWeighted(
      candidates,
      `${requestId}\u0000${aliasName}`,
    );
    return selected === null
      ? { ok: false, reason: 'no_healthy_route' }
      : this.toResolvedRoute(selected.provider, selected.model);
  }

  private resolveQualifiedModel(
    requestedModel: string,
    requireStreaming: boolean,
  ): RouteResolutionResult {
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
      : this.toResolvedRoute(providerRef, modelName);
  }

  private toResolvedRoute(
    providerRef: string,
    providerModel: string,
  ): { readonly ok: true; readonly route: ResolvedRoute } {
    const provider = this.policy.providers[providerRef];
    if (provider === undefined) {
      throw new TypeError('Validated policy contains an unknown provider');
    }
    return {
      ok: true,
      route: {
        providerRef,
        provider: provider.adapter,
        providerModel,
      },
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
