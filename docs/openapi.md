# OpenAPI Contract

## Source of truth

Runtime TypeBox/JSON Schemas in `packages/api-contract` are the editable source
of truth. The build produces `openapi/genchi.openapi.yaml`. The generated file
is committed so users can inspect and generate clients without building Genchi.

The generated document uses OpenAPI 3.1 and JSON Schema 2020-12.

## Required metadata

- title, description, Apache-2.0 license, and contact links;
- semantic API document version;
- server variables rather than hard-coded production hosts;
- bearer authentication scheme;
- operation IDs stable across non-breaking releases;
- examples for success, streaming description, and every error family;
- `x-genchi-stability` on experimental operations or fields.

## Generation workflow

```bash
pnpm openapi:generate
pnpm openapi:lint
pnpm openapi:breaking --base origin/main
pnpm sdk:generate
```

CI regenerates the contract and fails on a dirty working tree. A linter enforces
consistent operation IDs, descriptions, error responses, schema names, and
security declarations.

## Compatibility policy

Within `/v1`, these are breaking changes:

- removing or renaming a field, schema, operation, or enum value;
- making an optional field required;
- narrowing accepted input or documented response types;
- changing authentication or status semantics;
- changing the meaning of an existing error code.

Adding an optional response field, operation, model alias, or error code is
normally non-breaking, but clients must ignore unknown response fields. Enum
expansion is treated cautiously because some generated clients are exhaustive.

## Streaming representation

OpenAPI cannot completely describe SSE sequencing. The operation declares
`text/event-stream`, references the chunk schema, and links to the normative
[API streaming rules](api.md#streaming). Contract tests validate actual frames.

## Review requirements

Any contract change includes:

1. generated diff;
2. compatibility classification;
3. request/response examples;
4. server tests and SDK regeneration;
5. migration/release notes when behavior changes;
6. an ADR for a new public paradigm or breaking version.

## Initial contract outline

```yaml
openapi: 3.1.0
info:
  title: Genchi API
  version: 1.0.0
paths:
  /v1/chat/completions:
    post:
      operationId: createChatCompletion
  /v1/models:
    get:
      operationId: listModels
  /health/live:
    get:
      operationId: getLiveness
  /health/ready:
    get:
      operationId: getReadiness
```

This outline is illustrative; the generated, linted artifact is authoritative.

