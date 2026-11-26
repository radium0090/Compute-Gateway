import {
  formatAgentFailoverReport,
  runAgentFailoverReport,
} from './agent-failover.js';

const args = process.argv.slice(2);
const format = args.length === 0 ? 'markdown' : args[1];
if (
  (args.length !== 0 && (args.length !== 2 || args[0] !== '--format')) ||
  (format !== 'json' && format !== 'markdown')
) {
  process.stderr.write(
    'Usage: pnpm --silent agent:failover-report [--format markdown|json]\n',
  );
  process.exitCode = 2;
} else {
  try {
    const report = await runAgentFailoverReport();
    process.stdout.write(
      format === 'json'
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatAgentFailoverReport(report),
    );
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    process.stderr.write(
      'Agent failover report could not be generated. Run the offline fixture tests for diagnosis.\n',
    );
    process.exitCode = 1;
  }
}
