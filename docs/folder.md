# Repository Layout

## Target structure

```text
genchi/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── workflows/
│   ├── CODEOWNERS
│   └── dependabot.yml
├── apps/
│   └── gateway/                 # Fastify composition root and process entry
├── packages/
│   ├── api-contract/            # TypeBox schemas and generated OpenAPI source
│   ├── domain/                  # provider ports, canonical types, routing rules
│   ├── config/                  # typed configuration loading and validation
│   ├── auth/                    # API key verification and permission policy
│   ├── router/                  # candidate resolution and resilience policy
│   ├── provider-openai/
│   ├── provider-anthropic/
│   ├── provider-gemini/
│   ├── persistence-postgres/
│   ├── coordination-redis/
│   ├── observability/
│   └── testkit/                 # adapter conformance and mock providers
├── sdk/
│   ├── typescript/
│   └── python/
├── db/
│   └── migrations/
├── deploy/
│   ├── compose/
│   ├── helm/genchi/
│   └── kubernetes/             # examples and disposable CI fixtures
├── benchmarks/                 # repeatable scenarios and checked thresholds
├── examples/
│   ├── curl/
│   ├── node/
│   └── python/
├── docs/
│   ├── adr/
│   └── runbooks/
├── scripts/                     # deterministic repository automation only
├── openapi/
│   └── genchi.openapi.yaml      # generated and release-pinned contract
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── LICENSE
├── NOTICE
├── README.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Ownership rules

- `apps/gateway` wires dependencies; it MUST contain minimal business logic.
- `packages/domain` has no infrastructure dependencies.
- Provider packages MUST NOT import one another.
- `api-contract` is the single source for runtime validation and OpenAPI.
- Database access occurs only through `persistence-postgres` repositories.
- Cross-package imports use public entry points; deep imports are prohibited.
- SDK generated code is separated from handwritten convenience wrappers.
- Deployment examples MUST use released image tags, never `latest`.

## Naming

Packages use `@genchi/<name>`. Files use `kebab-case.ts`; exported types and
classes use `PascalCase`; functions and variables use `camelCase`; environment
variables use `GENCHI_UPPER_SNAKE_CASE`. Test files live next to source as
`*.test.ts`; integration tests use `*.integration.test.ts`.

## Build graph

Packages declare explicit workspace dependencies. CI and release validation
build and test the complete graph. Circular workspace dependencies are
forbidden; TypeScript project-reference builds fail when the graph is invalid.
