import { describe, expect, it } from 'vitest';

import {
  formatAgentFailoverReport,
  matchesDecision,
  runAgentFailoverReport,
} from './agent-failover.js';

describe('Gemini-primary OpenAI-backup acceptance report', () => {
  it('checks capability, route metadata, usage and stream commitment through the gateway', async () => {
    const report = await runAgentFailoverReport();
    // Include failed check names on errors; never print request or response bodies.
    expect(report, JSON.stringify(report.cases, null, 2)).toMatchObject({
      schema_version: 1,
      mode: 'offline_fixture',
      passed: true,
      cases: [
        {
          id: 'healthy_primary',
          gateway_status: 200,
          upstream_calls: ['gemini'],
          passed: true,
        },
        {
          id: 'rate_limited_tool_fallback',
          gateway_status: 200,
          upstream_calls: ['gemini', 'openai'],
          passed: true,
        },
        {
          id: 'structured_output_fallback',
          gateway_status: 200,
          upstream_calls: ['gemini', 'openai'],
          passed: true,
        },
        {
          id: 'no_eligible_route',
          gateway_status: 503,
          upstream_calls: [],
          passed: true,
        },
        {
          id: 'interrupted_stream',
          gateway_status: 200,
          upstream_calls: ['gemini'],
          passed: true,
        },
      ],
    });
    expect(
      report.cases
        .map((entry) => entry.fixture_policy_sha256)
        .every((hash) => /^[a-f0-9]{64}$/u.test(hash)),
    ).toBe(true);
    expect(report.cases[1]).toMatchObject({
      route: { provider: 'openai', model: 'openai-fixture', attempts: 2 },
      token_usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    });
    expect(report.cases[3]).toMatchObject({ route: null, token_usage: null });
    expect(report.cases[4]).toMatchObject({
      route: { provider: 'gemini', model: 'gemini-fixture', attempts: 1 },
      stream_completed: false,
    });
    const markdown = formatAgentFailoverReport(report);
    expect(markdown).toContain('Result: PASS');
    expect(markdown).toContain(
      'Not a live-provider or customer acceptance result',
    );
    expect(formatAgentFailoverReport({ ...report, passed: false })).toContain(
      'Result: FAIL',
    );
    for (const content of [
      'Classify the synthetic pilot case.',
      'record_decision',
      'fixture_call',
      'offline-openai-fixture',
      'rcg_test_',
    ]) {
      expect(JSON.stringify(report)).not.toContain(content);
      expect(markdown).not.toContain(content);
    }
  });

  it('does not accept text, malformed JSON, wrong values or extra fields as a valid contract', () => {
    expect(matchesDecision('{"outcome":"review"}')).toBe(true);
    for (const value of [
      undefined,
      'review',
      '{"outcome":',
      '[]',
      '{"outcome":"approve"}',
      '{"outcome":"review","extra":true}',
      '{"outcome":4}',
    ]) {
      expect(matchesDecision(value)).toBe(false);
    }
  });
});
