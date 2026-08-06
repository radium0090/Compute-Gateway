export interface GeminiProbeResult {
  readonly name: string;
  readonly status: number | 'network_error';
}

export interface GeminiProbeOptions {
  readonly apiKey: string;
  readonly configuredModel: string;
  readonly fetchImplementation?: typeof fetch;
}

const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const aliasModel = 'gemini-flash-latest';
const prompt = 'Reply with OK.';

async function probe(
  implementation: typeof fetch,
  name: string,
  input: string,
  init: RequestInit,
): Promise<GeminiProbeResult> {
  try {
    const response = await implementation(input, init);
    const status = response.status;
    try {
      await response.body?.cancel();
    } catch {
      // Probe cleanup is best-effort and never reads the upstream body.
    }
    return { name, status };
  } catch {
    return { name, status: 'network_error' };
  }
}

function modelUrl(model: string, method: 'get' | 'generateContent'): string {
  const path = `${baseUrl}/models/${encodeURIComponent(model)}`;
  return method === 'get' ? path : `${path}:generateContent`;
}

/**
 * Runs bounded, status-only probes after a protected live Gemini smoke fails.
 * It never reads an upstream response body and its result contains no key,
 * prompt, model output, headers, or provider message.
 */
export async function diagnoseGeminiRequest(
  options: GeminiProbeOptions,
): Promise<readonly GeminiProbeResult[]> {
  const implementation = options.fetchImplementation ?? fetch;
  const authHeaders = { 'x-goog-api-key': options.apiKey };
  const postHeaders = {
    ...authHeaders,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const results: GeminiProbeResult[] = [];
  results.push(
    await probe(
      implementation,
      'configured-model',
      modelUrl(options.configuredModel, 'get'),
      {
        method: 'GET',
        headers: { ...authHeaders, accept: 'application/json' },
      },
    ),
  );

  const contents = [{ parts: [{ text: prompt }] }];
  const contentsWithRole = [{ role: 'user', parts: [{ text: prompt }] }];
  const stages: readonly (readonly [string, unknown])[] = [
    ['minimal', { contents }],
    ['role', { contents: contentsWithRole }],
    [
      'candidate-count',
      {
        contents: contentsWithRole,
        generationConfig: { candidateCount: 1 },
      },
    ],
    [
      'max-output-tokens',
      {
        contents: contentsWithRole,
        generationConfig: { candidateCount: 1, maxOutputTokens: 8 },
      },
    ],
    [
      'thinking-budget',
      {
        contents: contentsWithRole,
        generationConfig: {
          candidateCount: 1,
          maxOutputTokens: 8,
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
    ],
  ];
  for (const [name, body] of stages) {
    const result = await probe(
      implementation,
      name,
      modelUrl(options.configuredModel, 'generateContent'),
      { method: 'POST', headers: postHeaders, body: JSON.stringify(body) },
    );
    results.push(result);
    if (result.status !== 200) break;
  }

  if (options.configuredModel !== aliasModel) {
    results.push(
      await probe(
        implementation,
        'latest-alias-minimal',
        modelUrl(aliasModel, 'generateContent'),
        {
          method: 'POST',
          headers: postHeaders,
          body: JSON.stringify({ contents }),
        },
      ),
    );
  }
  return results;
}
