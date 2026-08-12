import { describe, expect, it } from 'vitest';

import { ProviderStreamFailure } from '@rax-digital/domain';
import type {
  CanonicalChatChunk,
  CanonicalChatRequest,
  CanonicalChatResponse,
  ProviderAdapter,
} from '@rax-digital/domain';

export interface CapturedProviderRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal | null;
}

export interface ProviderAdapterConformanceFixture {
  readonly name: string;
  readonly model: string;
  readonly request: CanonicalChatRequest;
  readonly createAdapter: (
    fetchImplementation: typeof fetch,
  ) => ProviderAdapter;
  readonly successResponse: () => Response;
  readonly expectedResponse: CanonicalChatResponse;
  readonly streamResponse: () => Response;
  readonly streamPrefix: string;
  readonly expectedChunks: readonly CanonicalChatChunk[];
  readonly assertRequest: (
    request: CapturedProviderRequest,
    streaming: boolean,
  ) => void;
}

const requestContext = (model: string, signal: AbortSignal) => ({
  requestId: 'req_conformance_test',
  providerModel: model,
  signal,
});

function captureRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): CapturedProviderRequest {
  const url =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  let body: unknown = null;
  if (typeof init?.body === 'string') {
    body = JSON.parse(init.body) as unknown;
  }
  return {
    url,
    headers: new Headers(init?.headers),
    body,
    signal: init?.signal ?? null,
  };
}

async function collect(
  stream: AsyncIterable<CanonicalChatChunk>,
): Promise<CanonicalChatChunk[]> {
  const chunks: CanonicalChatChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Defines the common behavioral contract every provider adapter must pass. */
export function defineProviderAdapterConformance(
  fixture: ProviderAdapterConformanceFixture,
): void {
  describe(`${fixture.name} provider conformance`, () => {
    it('translates canonical input and normalizes a response', async () => {
      const signal = new AbortController().signal;
      let captured: CapturedProviderRequest | undefined;
      const adapter = fixture.createAdapter((input, init) => {
        captured = captureRequest(input, init);
        return Promise.resolve(fixture.successResponse());
      });

      await expect(
        adapter.createChatCompletion(
          fixture.request,
          requestContext(fixture.model, signal),
        ),
      ).resolves.toEqual({ ok: true, response: fixture.expectedResponse });
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('request was not captured');
      fixture.assertRequest(captured, false);
      expect(captured.signal).toBe(signal);
    });

    it.each([
      [401, 'authentication', false],
      [429, 'rate_limit', true],
      [500, 'unavailable', true],
      [400, 'request', false],
    ] as const)(
      'classifies HTTP %s without exposing the upstream body',
      async (status, errorClass, retryable) => {
        const adapter = fixture.createAdapter(() =>
          Promise.resolve(
            new Response('raw secret-bearing upstream body', {
              status,
              headers: status === 429 ? { 'retry-after': '4' } : {},
            }),
          ),
        );
        const result = await adapter.createChatCompletion(
          fixture.request,
          requestContext(fixture.model, new AbortController().signal),
        );

        expect(result).toMatchObject({
          ok: false,
          error: { class: errorClass, retryable },
        });
        expect(JSON.stringify(result)).not.toContain('raw secret-bearing');
      },
    );

    it('rejects malformed success payloads with a safe protocol error', async () => {
      const adapter = fixture.createAdapter(() =>
        Promise.resolve(new Response('{"unexpected":true}', { status: 200 })),
      );

      await expect(
        adapter.createChatCompletion(
          fixture.request,
          requestContext(fixture.model, new AbortController().signal),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { class: 'protocol', code: 'provider_invalid_response' },
      });
    });

    it('propagates cancellation as a typed timeout', async () => {
      const controller = new AbortController();
      controller.abort();
      const adapter = fixture.createAdapter((_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        return Promise.reject(new Error('aborted'));
      });

      await expect(
        adapter.createChatCompletion(
          fixture.request,
          requestContext(fixture.model, controller.signal),
        ),
      ).resolves.toEqual({
        ok: false,
        error: {
          class: 'timeout',
          code: 'provider_timeout',
          retryable: true,
        },
      });
    });

    it('bounds connection establishment with a typed connect timeout', async () => {
      const adapter = fixture.createAdapter(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal == null) {
              reject(new Error('missing signal'));
              return;
            }
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('connect aborted'));
              },
              { once: true },
            );
          }),
      );

      await expect(
        adapter.createChatCompletion(fixture.request, {
          ...requestContext(fixture.model, new AbortController().signal),
          connectTimeoutMs: 1,
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          class: 'timeout',
          code: 'provider_connect_timeout',
          retryable: true,
        },
      });
    });

    it('preserves stream order, usage, and provider request semantics', async () => {
      let captured: CapturedProviderRequest | undefined;
      const adapter = fixture.createAdapter((input, init) => {
        captured = captureRequest(input, init);
        return Promise.resolve(fixture.streamResponse());
      });
      const result = await adapter.streamChatCompletion(
        fixture.request,
        requestContext(fixture.model, new AbortController().signal),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await expect(collect(result.stream)).resolves.toEqual(
        fixture.expectedChunks,
      );
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('request was not captured');
      fixture.assertRequest(captured, true);
    });

    it('cancels the upstream body when the stream consumer disconnects', async () => {
      let cancelled = false;
      const prefix = new TextEncoder().encode(fixture.streamPrefix);
      const adapter = fixture.createAdapter(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(prefix);
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
      );
      const result = await adapter.streamChatCompletion(
        fixture.request,
        requestContext(fixture.model, new AbortController().signal),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const iterator = result.stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      await iterator.return?.();
      expect(cancelled).toBe(true);
    });

    it('surfaces malformed established streams as typed failures', async () => {
      const adapter = fixture.createAdapter(() =>
        Promise.resolve(
          new Response('data: {not-json}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      );
      const result = await adapter.streamChatCompletion(
        fixture.request,
        requestContext(fixture.model, new AbortController().signal),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await expect(collect(result.stream)).rejects.toBeInstanceOf(
        ProviderStreamFailure,
      );
    });

    it('rejects unconfigured models without contacting the provider', async () => {
      let called = false;
      const adapter = fixture.createAdapter(() => {
        called = true;
        return Promise.reject(new Error('must not be called'));
      });

      await expect(
        adapter.createChatCompletion(fixture.request, {
          ...requestContext('not-configured', new AbortController().signal),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { class: 'request', retryable: false },
      });
      expect(called).toBe(false);
    });
  });
}
