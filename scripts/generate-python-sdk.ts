import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

type Schema = Readonly<{
  $ref?: string;
  anyOf?: readonly Schema[];
  const?: unknown;
  enum?: readonly unknown[];
  items?: Schema;
  properties?: Readonly<Record<string, Schema>>;
  type?: string;
}>;

type OpenApi = Readonly<{
  components?: Readonly<{
    schemas?: Readonly<Record<string, Schema>>;
  }>;
}>;

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'openapi', 'genchi.openapi.yaml');
const destination = path.join(
  root,
  'sdk',
  'python',
  'src',
  'genchi',
  '_generated',
  'models.py',
);

function pythonName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/gu, '_');
  return /^[0-9]/u.test(normalized) ? `field_${normalized}` : normalized;
}

function literal(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return JSON.stringify(value);
}

function pythonType(schema: Schema | undefined): string {
  if (schema === undefined) return 'object';
  if (schema.$ref !== undefined)
    return schema.$ref.split('/').at(-1) ?? 'object';
  if (schema.anyOf !== undefined) {
    return schema.anyOf.map((item) => pythonType(item)).join(' | ');
  }
  if (schema.const !== undefined) return `Literal[${literal(schema.const)}]`;
  if (schema.enum !== undefined) {
    return `Literal[${schema.enum.map((item) => literal(item)).join(', ')}]`;
  }
  if (schema.type === 'string') return 'str';
  if (schema.type === 'integer') return 'int';
  if (schema.type === 'number') return 'float';
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'array') return `list[${pythonType(schema.items)}]`;
  if (schema.type === 'object') return 'dict[str, object]';
  return 'object';
}

function render(schemas: Readonly<Record<string, Schema>>): string {
  const blocks = Object.entries(schemas).map(([name, schema]) => {
    if (schema.type !== 'object' || schema.properties === undefined) {
      return `${name}: TypeAlias = ${pythonType(schema)}`;
    }
    const fields = Object.entries(schema.properties).map(
      ([field, fieldSchema]) =>
        `    ${pythonName(field)}: ${pythonType(fieldSchema)}`,
    );
    return [
      `class ${name}(TypedDict, total=False):`,
      ...(fields.length === 0 ? ['    pass'] : fields),
    ].join('\n');
  });
  return `# Generated from openapi/genchi.openapi.yaml. Do not edit by hand.
from typing import Literal, TypeAlias, TypedDict


${blocks.join('\n\n\n')}
`;
}

const document = parse(await readFile(source, 'utf8')) as OpenApi;
const schemas = document.components?.schemas;
if (schemas === undefined || Object.keys(schemas).length === 0) {
  throw new Error('OpenAPI components.schemas must not be empty');
}
await writeFile(destination, render(schemas), 'utf8');
