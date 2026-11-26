import { describe, expect, it } from 'vitest';

import { runAgentPilotProbe, type PilotCase } from './agent-pilot-probe.js';

const live =
  process.env.RCG_AGENT_PILOT_LIVE === 'true' ? describe : describe.skip;
const scenarios: readonly PilotCase[] = [
  'gemini_primary',
  'openai_after_injected_429',
];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing pilot environment variable: ${name}`);
  }
  return value;
}

live('agent pilot (protected live providers)', () => {
  it.each(scenarios)(
    '%s satisfies the synthetic output contract',
    async (scenario) => {
      const evidence = await runAgentPilotProbe(
        scenario,
        {
          gemini: {
            model: required('RCG_LIVE_GEMINI_MODEL'),
            apiKey: required('GEMINI_API_KEY'),
          },
          openai: {
            model: required('RCG_LIVE_OPENAI_MODEL'),
            apiKey: required('OPENAI_API_KEY'),
          },
        },
        fetch,
      );
      expect(evidence.passed, JSON.stringify(evidence)).toBe(true);
    },
  );
});
