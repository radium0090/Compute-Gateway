import { describe, expect, it, vi } from 'vitest';

import { runAgentPilotProbe } from './agent-pilot-probe.js';

const settings = {
  gemini: { model: 'gemini-test', apiKey: 'fake-gemini' },
  openai: { model: 'gpt-test', apiKey: 'fake-openai' },
};

describe('pilot probe safety and contract', () => {
  it('uses one Gemini call for the primary and one OpenAI call for the simulated failover', async () => {
    const transport = vi.fn<typeof fetch>(async (input) => {
      await Promise.resolve();
      return typeof input === 'string' &&
        input.startsWith('https://generativelanguage.googleapis.com/')
        ? Response.json({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: '{"outcome":"review"}' }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 5,
              totalTokenCount: 25,
            },
          })
        : Response.json({
            choices: [
              {
                message: { role: 'assistant', content: '{"outcome":"review"}' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          });
    });
    const primary = await runAgentPilotProbe(
      'gemini_primary',
      settings,
      transport,
    );
    const fallback = await runAgentPilotProbe(
      'openai_after_injected_429',
      settings,
      transport,
    );
    expect(primary, JSON.stringify(primary)).toMatchObject({
      passed: true,
      http_status: 200,
    });
    expect(fallback, JSON.stringify(fallback)).toMatchObject({
      passed: true,
      http_status: 200,
    });
    expect(transport.mock.calls.map(([request]) => request)).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
      'https://api.openai.com/v1/chat/completions',
    ]);
    for (const [, init] of transport.mock.calls)
      expect(init?.redirect).toBe('error');
  });

  it('does not spend on OpenAI if the Gemini health case fails', async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 429 })),
    );
    const result = await runAgentPilotProbe(
      'gemini_primary',
      settings,
      transport,
    );
    expect(result.passed).toBe(false);
    expect(result.checks.bounded_transport).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects malformed provider settings without opening a connection', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      runAgentPilotProbe(
        'gemini_primary',
        {
          ...settings,
          gemini: { ...settings.gemini, model: 'models/invalid' },
        },
        transport,
      ),
    ).rejects.toThrow('Provide a bare model ID');
    expect(transport).not.toHaveBeenCalled();
  });
});
