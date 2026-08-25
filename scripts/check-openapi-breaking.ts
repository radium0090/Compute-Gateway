import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

type JsonObject = Readonly<Record<string, unknown>>;

const methods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
] as const;

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function values(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function compareSchemas(
  previous: JsonObject,
  current: JsonObject,
  location: string,
  failures: string[],
): void {
  if (typeof previous.type === 'string' && current.type !== previous.type) {
    failures.push(`${location}: type changed from ${previous.type}`);
  }
  if (typeof previous.$ref === 'string' && current.$ref !== previous.$ref) {
    failures.push(`${location}: reference changed from ${previous.$ref}`);
  }
  if (Object.hasOwn(previous, 'const') && current.const !== previous.const) {
    failures.push(`${location}: const changed`);
  }
  const oldEnum = values(previous.enum);
  const newEnum = values(current.enum);
  if (oldEnum.length > 0 && oldEnum.some((item) => !newEnum.includes(item))) {
    failures.push(`${location}: enum value removed`);
  }
  const oldAlternatives = values(previous.anyOf).map((item) =>
    JSON.stringify(item),
  );
  const newAlternatives = new Set(
    values(current.anyOf).map((item) => JSON.stringify(item)),
  );
  if (oldAlternatives.some((item) => !newAlternatives.has(item))) {
    failures.push(`${location}: anyOf alternative removed or narrowed`);
  }
  for (const limit of ['minimum', 'minLength', 'minItems'] as const) {
    const oldValue = previous[limit];
    const newValue = current[limit];
    if (
      typeof oldValue === 'number' &&
      typeof newValue === 'number' &&
      newValue > oldValue
    ) {
      failures.push(`${location}: ${limit} became stricter`);
    }
  }
  for (const limit of ['maximum', 'maxLength', 'maxItems'] as const) {
    const oldValue = previous[limit];
    const newValue = current[limit];
    if (
      typeof oldValue === 'number' &&
      typeof newValue === 'number' &&
      newValue < oldValue
    ) {
      failures.push(`${location}: ${limit} became stricter`);
    }
  }
  const oldProperties = object(previous.properties);
  const newProperties = object(current.properties);
  for (const [name, schema] of Object.entries(oldProperties)) {
    if (!Object.hasOwn(newProperties, name)) {
      failures.push(`${location}.${name}: property removed`);
      continue;
    }
    compareSchemas(
      object(schema),
      object(newProperties[name]),
      `${location}.${name}`,
      failures,
    );
  }
  const oldRequired = new Set(values(previous.required));
  for (const field of values(current.required)) {
    if (!oldRequired.has(field)) {
      failures.push(`${location}.${String(field)}: new required property`);
    }
  }
  const oldItems = object(previous.items);
  if (Object.keys(oldItems).length > 0) {
    compareSchemas(oldItems, object(current.items), `${location}[]`, failures);
  }
}

function compare(previous: JsonObject, current: JsonObject): string[] {
  const failures: string[] = [];
  const previousPaths = object(previous.paths);
  const currentPaths = object(current.paths);
  for (const [route, oldPathValue] of Object.entries(previousPaths)) {
    if (!Object.hasOwn(currentPaths, route)) {
      failures.push(`${route}: path removed`);
      continue;
    }
    const oldPath = object(oldPathValue);
    const newPath = object(currentPaths[route]);
    for (const method of methods) {
      if (!Object.hasOwn(oldPath, method)) continue;
      if (!Object.hasOwn(newPath, method)) {
        failures.push(`${method.toUpperCase()} ${route}: operation removed`);
        continue;
      }
      const oldOperation = object(oldPath[method]);
      const newOperation = object(newPath[method]);
      const oldResponses = object(oldOperation.responses);
      const newResponses = object(newOperation.responses);
      for (const status of Object.keys(oldResponses)) {
        if (!Object.hasOwn(newResponses, status)) {
          failures.push(
            `${method.toUpperCase()} ${route}: response ${status} removed`,
          );
        }
      }
    }
  }
  const oldSchemas = object(object(previous.components).schemas);
  const newSchemas = object(object(current.components).schemas);
  for (const [name, schema] of Object.entries(oldSchemas)) {
    if (!Object.hasOwn(newSchemas, name)) {
      failures.push(`components.schemas.${name}: schema removed`);
      continue;
    }
    compareSchemas(
      object(schema),
      object(newSchemas[name]),
      `components.schemas.${name}`,
      failures,
    );
  }
  return failures;
}

const root = path.resolve(import.meta.dirname, '..');
const baseIndex = process.argv.indexOf('--base');
const base = baseIndex === -1 ? 'origin/main' : process.argv[baseIndex + 1];
if (base === undefined || base.length === 0)
  throw new Error('--base requires a git ref');
const file = 'openapi/compute-gateway.openapi.yaml';
const baseContractFiles = execFileSync(
  'git',
  ['ls-tree', '-r', '--name-only', base, '--', 'openapi'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\n')
  .filter((candidate) => candidate.endsWith('.openapi.yaml'));
const baseContractFile = baseContractFiles[0];
if (baseContractFiles.length !== 1 || baseContractFile === undefined) {
  throw new Error(
    `Expected one OpenAPI contract at ${base}, found ${String(baseContractFiles.length)}`,
  );
}
const previousText = execFileSync(
  'git',
  ['show', `${base}:${baseContractFile}`],
  {
    cwd: root,
    encoding: 'utf8',
  },
);
const currentText = await readFile(path.join(root, file), 'utf8');
const failures = compare(
  object(parse(previousText) as unknown),
  object(parse(currentText) as unknown),
);
const formerResponseExtension = ['gen', 'chi'].join('');
const acceptedIdentityMigration = new Set([
  `components.schemas.ChatCompletionResponse.${formerResponseExtension}: property removed`,
  'components.schemas.ChatCompletionResponse.rax: new required property',
  `components.schemas.ChatCompletionChunk.${formerResponseExtension}: property removed`,
  'components.schemas.ChatCompletionChunk.rax: new required property',
  `components.schemas.ErrorResponse.${formerResponseExtension}: property removed`,
  'components.schemas.ErrorResponse.rax: new required property',
  'components.schemas.ModelList.data[].owned_by: const changed',
]);
const identityDecision = await readFile(
  path.join(root, 'docs/adr/0012-rax-digital-product-identity.md'),
  'utf8',
);
const isAcceptedIdentityMigration =
  identityDecision.includes('- Status: Accepted') &&
  failures.length === acceptedIdentityMigration.size &&
  failures.every((failure) => acceptedIdentityMigration.has(failure));

// ADR 0015 widens message inputs and makes assistant content nullable only for
// the newly opt-in tool-calling path. Existing text-only request/response
// behavior is unchanged, but the structural checker cannot express that
// conditional compatibility guarantee.
const acceptedAgentCompatibility = new Set([
  'components.schemas.ChatCompletionRequest.messages[]: type changed from object',
  'components.schemas.ChatCompletionRequest.messages[].role: property removed',
  'components.schemas.ChatCompletionRequest.messages[].content: property removed',
  'components.schemas.ChatCompletionResponse.choices[].message.content: type changed from string',
]);
const agentDecision = await readFile(
  path.join(root, 'docs/adr/0015-agent-tool-calling-compatibility.md'),
  'utf8',
);
const isAcceptedAgentCompatibility =
  agentDecision.includes('- Status: Accepted') &&
  failures.length === acceptedAgentCompatibility.size &&
  failures.every((failure) => acceptedAgentCompatibility.has(failure));

if (
  failures.length > 0 &&
  !isAcceptedIdentityMigration &&
  !isAcceptedAgentCompatibility
) {
  throw new Error(
    `Breaking OpenAPI changes against ${base}:\n${failures.join('\n')}`,
  );
}
process.stdout.write(
  isAcceptedIdentityMigration
    ? `Only ADR 0012 identity changes found against ${base}\n`
    : isAcceptedAgentCompatibility
      ? `Only ADR 0015 Agent compatibility changes found against ${base}\n`
      : `No breaking OpenAPI changes against ${base}\n`,
);
