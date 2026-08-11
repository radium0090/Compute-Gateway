import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

interface Workflow {
  readonly on?: unknown;
  readonly permissions?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly ['timeout-minutes']?: unknown;
        readonly environment?: unknown;
        readonly permissions?: Readonly<Record<string, unknown>>;
        readonly steps?: readonly { readonly uses?: unknown }[];
      }
    >
  >;
}

interface HelmValues {
  readonly existingSecret?: unknown;
  readonly image?: { readonly tag?: unknown };
  readonly runtime?: {
    readonly totalTimeoutMs?: unknown;
    readonly shutdownGraceMs?: unknown;
  };
  readonly preStopDelaySeconds?: unknown;
  readonly terminationGracePeriodSeconds?: unknown;
}

const root = new URL('../', import.meta.url);
const pinnedActionPattern = new RegExp(
  '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)*@[a-f0-9]{40}$',
  'u',
);

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, root), 'utf8');
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Operations validation failed: ${message}`);
}

async function validateWorkflows(): Promise<void> {
  const directory = new URL('.github/workflows/', root);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  assert(files.length >= 5, 'expected the documented workflow baseline');
  for (const file of files) {
    const workflow = parse(
      await read(join('.github/workflows', file)),
    ) as Workflow | null;
    assert(workflow !== null, `${file} is empty`);
    assert(
      workflow.permissions?.contents === 'read',
      `${file} must default to contents: read`,
    );
    const triggers = workflow.on;
    assert(
      !(
        typeof triggers === 'object' &&
        triggers !== null &&
        'pull_request_target' in triggers
      ),
      `${file} must not use pull_request_target`,
    );
    const jobs = Object.entries(workflow.jobs ?? {});
    assert(jobs.length > 0, `${file} has no jobs`);
    for (const [jobName, job] of jobs) {
      assert(
        typeof job['timeout-minutes'] === 'number' &&
          job['timeout-minutes'] > 0,
        `${file}:${jobName} must set a timeout`,
      );
      for (const step of job.steps ?? []) {
        if (step.uses === undefined) continue;
        assert(
          typeof step.uses === 'string' && pinnedActionPattern.test(step.uses),
          `${file} action ${
            typeof step.uses === 'string' ? step.uses : '<non-string>'
          } is not pinned to a full SHA`,
        );
      }
    }
  }

  const awsStagingSource = await read('.github/workflows/aws-staging.yml');
  const awsStaging = parse(awsStagingSource) as Workflow | null;
  const connectivity = awsStaging?.jobs?.connectivity;
  assert(
    connectivity?.environment === 'aws-staging',
    'AWS staging connectivity must use the protected aws-staging environment',
  );
  assert(
    connectivity.permissions?.contents === 'read' &&
      connectivity.permissions['id-token'] === 'write',
    'AWS staging connectivity must grant only contents:read and id-token:write',
  );
  assert(
    awsStagingSource.includes('vars.AWS_ROLE_ARN') &&
      awsStagingSource.includes('vars.EC2_INSTANCE_ID'),
    'AWS staging workflow must receive resource identifiers from environment variables',
  );
  assert(
    !/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|EC2_SSH_PRIVATE_KEY)/u.test(
      awsStagingSource,
    ),
    'AWS staging workflow must not use long-lived cloud or SSH credentials',
  );
}

async function validateHelm(): Promise<void> {
  const chartRoot = 'deploy/helm/genchi/';
  const required = [
    'Chart.yaml',
    'values.yaml',
    'values.schema.json',
    'templates/deployment.yaml',
    'templates/migration-job.yaml',
    'templates/service.yaml',
    'templates/serviceaccount.yaml',
    'templates/pdb.yaml',
  ];
  await Promise.all(required.map((file) => read(`${chartRoot}${file}`)));
  const values = parse(await read(`${chartRoot}values.yaml`)) as HelmValues;
  assert(
    typeof values.existingSecret === 'string' &&
      values.existingSecret.length > 0,
    'Helm must reference an existing Secret',
  );
  assert(values.image?.tag !== 'latest', 'Helm must not use latest image tags');
  const total = values.runtime?.totalTimeoutMs;
  const shutdown = values.runtime?.shutdownGraceMs;
  const preStop = values.preStopDelaySeconds;
  const termination = values.terminationGracePeriodSeconds;
  assert(
    typeof total === 'number' &&
      typeof shutdown === 'number' &&
      typeof preStop === 'number' &&
      typeof termination === 'number' &&
      termination >=
        Math.ceil(total / 1_000) + Math.ceil(shutdown / 1_000) + preStop,
    'termination grace must cover deadline, shutdown, and preStop delay',
  );
}

async function validateContainerReferences(): Promise<void> {
  const sources = await Promise.all([
    read('Dockerfile'),
    read('docker-compose.yml'),
    read('deploy/helm/genchi/values.yaml'),
    read('deploy/kubernetes/examples/genchi.yaml'),
  ]);
  assert(
    !sources.some((source) => /image:\s*[^\s]+:latest(?:\s|$)/m.test(source)),
    'deployment assets must not use latest image tags',
  );
  assert(
    /FROM node:24\.18\.0-bookworm-slim@sha256:[a-f0-9]{64}/.test(sources[0]),
    'build image must use the pinned Node.js image digest',
  );
  assert(
    /FROM gcr\.io\/distroless\/nodejs24-debian13:nonroot@sha256:[a-f0-9]{64}/.test(
      sources[0],
    ),
    'runtime image must use the pinned nonroot distroless image',
  );
}

await validateWorkflows();
await validateHelm();
await validateContainerReferences();
process.stdout.write('operations assets valid\n');
