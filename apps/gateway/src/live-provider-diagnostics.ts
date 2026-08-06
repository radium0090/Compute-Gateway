export interface GeminiProbeResult {
  readonly name: string;
  readonly status: number | 'network_error';
  readonly shape?: string;
}

export interface GeminiProbeOptions {
  readonly apiKey: string;
  readonly configuredModel: string;
  readonly fetchImplementation?: typeof fetch;
}

const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const aliasModel = 'gemini-flash-latest';
const prompt = 'Reply with OK.';
const maxShapeResponseBytes = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBounded(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      const value: unknown = read.value;
      if (!(value instanceof Uint8Array)) return null;
      length += value.byteLength;
      if (length > maxShapeResponseBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function responseShape(value: unknown): string {
  if (!isRecord(value)) return 'object=false';
  const candidates: readonly unknown[] = Array.isArray(value.candidates)
    ? (value.candidates as unknown[])
    : [];
  const candidate = candidates[0];
  const content =
    isRecord(candidate) && isRecord(candidate.content)
      ? candidate.content
      : null;
  const parts =
    content !== null && Array.isArray(content.parts) ? content.parts : [];
  const textParts = parts.filter(
    (part: unknown) => isRecord(part) && typeof part.text === 'string',
  ).length;
  const role =
    content?.role === undefined
      ? 'missing'
      : content.role === 'model'
        ? 'model'
        : 'other';
  return [
    `candidates=${String(candidates.length)}`,
    `content=${String(content !== null)}`,
    `role=${role}`,
    `parts=${String(parts.length)}`,
    `textParts=${String(textParts)}`,
    `usage=${String(isRecord(value.usageMetadata))}`,
  ].join(';');
}

async function probe(
  implementation: typeof fetch,
  name: string,
  input: string,
  init: RequestInit,
  inspectShape = false,
): Promise<GeminiProbeResult> {
  try {
    const response = await implementation(input, init);
    const status = response.status;
    if (inspectShape && status === 200) {
      return {
        name,
        status,
        shape: responseShape(await readJsonBounded(response)),
      };
    } else {
      try {
        await response.body?.cancel();
      } catch {
        // Probe cleanup is best-effort.
      }
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
      name === 'max-output-tokens',
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

/** Returns only allowlisted gateway status metadata from an unknown failure. */
export function safeGatewayFailureSummary(error: unknown): string {
  if (!isRecord(error)) return 'status=unknown;code=unknown';
  const status =
    typeof error.status === 'number' && Number.isInteger(error.status)
      ? String(error.status)
      : 'unknown';
  const code =
    typeof error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : 'unknown';
  return `status=${status};code=${code}`;
}
