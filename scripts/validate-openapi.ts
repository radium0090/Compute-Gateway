import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown, location: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as RecordValue;
}

function nonEmpty(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function walkReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walkReferences(item, references);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref') {
      references.add(nonEmpty(child, '$ref'));
    } else {
      walkReferences(child, references);
    }
  }
}

function resolvePointer(document: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#/')) {
    throw new Error(`External reference is not allowed: ${pointer}`);
  }
  return pointer
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>(
      (current, part) => record(current, pointer)[part],
      document,
    );
}

const root = path.resolve(import.meta.dirname, '..');
const document = parse(
  await readFile(
    path.join(root, 'openapi', 'compute-gateway.openapi.yaml'),
    'utf8',
  ),
) as unknown;
const api = record(document, 'document');
if (api.openapi !== '3.1.0') throw new Error('OpenAPI version must be 3.1.0');
const info = record(api.info, 'info');
nonEmpty(info.title, 'info.title');
nonEmpty(info.version, 'info.version');

const paths = record(api.paths, 'paths');
const operationIds = new Set<string>();
const methods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
]);
let operationCount = 0;
for (const [route, rawPath] of Object.entries(paths)) {
  const pathItem = record(rawPath, `paths.${route}`);
  for (const [method, rawOperation] of Object.entries(pathItem)) {
    if (!methods.has(method)) continue;
    operationCount += 1;
    const location = `${method.toUpperCase()} ${route}`;
    const operation = record(rawOperation, location);
    const operationId = nonEmpty(
      operation.operationId,
      `${location}.operationId`,
    );
    if (operationIds.has(operationId)) {
      throw new Error(`Duplicate operationId: ${operationId}`);
    }
    operationIds.add(operationId);
    nonEmpty(operation.summary, `${location}.summary`);
    if (
      !Object.hasOwn(operation, 'security') ||
      !Array.isArray(operation.security)
    ) {
      throw new Error(`${location}.security must be explicit`);
    }
    const responses = record(operation.responses, `${location}.responses`);
    if (Object.keys(responses).length === 0) {
      throw new Error(`${location} must declare responses`);
    }
    for (const [status, rawResponse] of Object.entries(responses)) {
      const response = record(rawResponse, `${location}.responses.${status}`);
      nonEmpty(
        response.description,
        `${location}.responses.${status}.description`,
      );
    }
  }
}
if (operationCount === 0) throw new Error('OpenAPI must declare operations');

const components = record(api.components, 'components');
const schemas = record(components.schemas, 'components.schemas');
for (const required of [
  'ChatCompletionRequest',
  'ChatCompletionResponse',
  'ChatCompletionChunk',
  'ErrorResponse',
  'LivenessResponse',
  'ModelList',
  'ReadinessResponse',
]) {
  if (!Object.hasOwn(schemas, required)) {
    throw new Error(`Missing required schema: ${required}`);
  }
}

const references = new Set<string>();
walkReferences(document, references);
for (const reference of references) {
  if (resolvePointer(document, reference) === undefined) {
    throw new Error(`Unresolved reference: ${reference}`);
  }
}
process.stdout.write(
  `OpenAPI lint passed (${String(operationCount)} operations, ${String(references.size)} references)\n`,
);
