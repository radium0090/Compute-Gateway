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

  const awsBootstrapSource = await read(
    '.github/workflows/aws-staging-bootstrap.yml',
  );
  const awsBootstrap = parse(awsBootstrapSource) as Workflow | null;
  const bootstrap = awsBootstrap?.jobs?.bootstrap;
  assert(
    bootstrap?.environment === 'aws-staging',
    'AWS staging bootstrap must use the protected aws-staging environment',
  );
  assert(
    bootstrap.permissions?.contents === 'read' &&
      bootstrap.permissions['id-token'] === 'write',
    'AWS staging bootstrap must grant only contents:read and id-token:write',
  );
  assert(
    awsBootstrapSource.includes('vars.RCG_SECRET_ARN') &&
      awsBootstrapSource.includes('aws secretsmanager get-secret-value') &&
      awsBootstrapSource.includes('keys | sort | join(",")'),
    'AWS staging bootstrap must inspect only the configured secret schema',
  );
  assert(
    !/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|EC2_SSH_PRIVATE_KEY)/u.test(
      awsBootstrapSource,
    ),
    'AWS staging bootstrap must not use long-lived cloud or SSH credentials',
  );

  const awsDeploySource = await read(
    '.github/workflows/aws-staging-deploy.yml',
  );
  const awsDeploy = parse(awsDeploySource) as Workflow | null;
  const deploy = awsDeploy?.jobs?.deploy;
  assert(
    deploy?.environment === 'aws-staging',
    'AWS staging deploy must use the protected aws-staging environment',
  );
  assert(
    deploy.permissions?.contents === 'read' &&
      deploy.permissions['id-token'] === 'write',
    'AWS staging deploy must grant only contents:read and id-token:write',
  );
  assert(
    awsDeploySource.includes('[[ "$GITHUB_REF" == refs/heads/main ]]') &&
      awsDeploySource.includes('scripts/deploy-aws-staging.sh') &&
      awsDeploySource.includes('^sha256:[0-9a-f]{64}$') &&
      awsDeploySource.includes('RCG_RELEASE_IMAGE'),
    'AWS staging deploy must execute the exact protected main deployment script and accept only immutable release digests',
  );
  assert(
    !/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|EC2_SSH_PRIVATE_KEY)/u.test(
      awsDeploySource,
    ),
    'AWS staging deploy must not use long-lived cloud or SSH credentials',
  );

  const awsVerifySource = await read(
    '.github/workflows/aws-staging-verify.yml',
  );
  const awsVerify = parse(awsVerifySource) as Workflow | null;
  const verify = awsVerify?.jobs?.verify;
  assert(
    verify?.environment === 'aws-staging',
    'AWS staging verification must use the protected aws-staging environment',
  );
  assert(
    verify.permissions?.contents === 'read' &&
      verify.permissions['id-token'] === 'write',
    'AWS staging verification must grant only contents:read and id-token:write',
  );
  assert(
    awsVerifySource.includes('[[ "$GITHUB_REF" == refs/heads/main ]]') &&
      awsVerifySource.includes('scripts/verify-aws-staging.sh'),
    'AWS staging verification must execute the exact protected main verification script',
  );
  assert(
    !/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|EC2_SSH_PRIVATE_KEY)/u.test(
      awsVerifySource,
    ),
    'AWS staging verification must not use long-lived cloud or SSH credentials',
  );

  const awsProductionSource = await read(
    '.github/workflows/aws-production-deploy.yml',
  );
  const awsProduction = parse(awsProductionSource) as Workflow | null;
  const productionDeploy = awsProduction?.jobs?.deploy;
  assert(
    productionDeploy?.environment === 'aws-production',
    'AWS production deploy must use the protected aws-production environment',
  );
  assert(
    productionDeploy.permissions?.contents === 'read' &&
      productionDeploy.permissions['id-token'] === 'write',
    'AWS production deploy must grant only contents:read and id-token:write',
  );
  assert(
    awsProductionSource.includes('[[ "$GITHUB_REF" == refs/heads/main ]]') &&
      awsProductionSource.includes('scripts/deploy-aws-production.sh') &&
      awsProductionSource.includes('vars.RCG_PUBLIC_HOST') &&
      awsProductionSource.includes('vars.RCG_BACKUP_BUCKET'),
    'AWS production deploy must execute the protected main deployment for the configured host',
  );
  assert(
    !/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|EC2_SSH_PRIVATE_KEY)/u.test(
      awsProductionSource,
    ),
    'AWS production workflow must not use long-lived cloud or SSH credentials',
  );
}

async function validateProductionRecovery(): Promise<void> {
  const [backup, restore, monitor, deploy] = await Promise.all([
    read('scripts/backup-aws-production.sh'),
    read('scripts/verify-aws-production-backup.sh'),
    read('scripts/monitor-aws-production.sh'),
    read('scripts/deploy-aws-production.sh'),
  ]);
  assert(
    backup.includes('pg_dump') &&
      backup.includes('--server-side-encryption AES256') &&
      backup.includes('sha256sum') &&
      backup.includes('production/latest.json'),
    'production backup must create, checksum, encrypt, and publish a latest manifest',
  );
  assert(
    restore.includes('pg_restore') &&
      restore.includes('--exit-on-error') &&
      restore.includes('dropdb') &&
      restore.includes('schema_migrations') &&
      restore.includes('restore-verification-success.epoch'),
    'production restore verification must use a disposable database, verify the schema, and persist success evidence',
  );
  assert(
    monitor.includes('/health/ready') &&
      monitor.includes('ProductionDiskUsagePercent') &&
      monitor.includes('ProductionServiceReady') &&
      monitor.includes('ProductionRestoreVerificationAgeSeconds'),
    'production monitoring must report disk usage, service readiness, and restore evidence age',
  );
  assert(
    deploy.includes('rax-compute-gateway-backup.timer') &&
      deploy.includes('rax-compute-gateway-restore-verify.timer') &&
      deploy.includes('rax-compute-gateway-monitor.timer'),
    'production deployment must enable backup, restore, and monitoring timers',
  );

  const unitDirectory = new URL('deploy/systemd/', root);
  const units = (await readdir(unitDirectory)).sort();
  assert(units.length === 6, 'expected six production systemd unit files');
  const unitSources = await Promise.all(
    units.map((unit) => read(join('deploy/systemd', unit))),
  );
  assert(
    unitSources.every(
      (source) =>
        source.includes('[Unit]') &&
        (source.includes('[Service]') || source.includes('[Timer]')),
    ),
    'every production systemd unit must declare its unit type',
  );
}

async function validateHelm(): Promise<void> {
  const chartRoot = 'deploy/helm/rax-compute-gateway/';
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
    read('deploy/compose/production.yaml'),
    read('deploy/helm/rax-compute-gateway/values.yaml'),
    read('deploy/kubernetes/examples/rax-compute-gateway.yaml'),
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
  assert(
    /image:\s*caddy:2\.11\.4-alpine@sha256:[a-f0-9]{64}/.test(sources[2]),
    'production edge must use the pinned Caddy image digest',
  );
}

await validateWorkflows();
await validateProductionRecovery();
await validateHelm();
await validateContainerReferences();
process.stdout.write('operations assets valid\n');
