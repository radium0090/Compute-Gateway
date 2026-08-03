# ADR 0011: Node.js 24 Gateway Runtime Baseline

- Status: Accepted
- Date: 2026-08-03
- Supersedes: [ADR 0001](0001-typescript-node-runtime.md) for the Node.js version only

## Context

ADR 0001 selected TypeScript, Fastify, pnpm, and Node.js 22 for the gateway.
The project is still pre-release, and its active development and verification
environment has moved to Node.js 24 LTS. Keeping a Node.js 22 compatibility
promise would add a second runtime matrix before any released consumer depends
on it.

## Decision

Use Node.js 24 LTS as the only supported gateway runtime baseline. Pin local and
container toolchains to a Node.js 24 patch release, declare `>=24 <25` in the
root package engine, use Node.js 24 type definitions, and target ES2024 in
TypeScript. Retain the other decisions in ADR 0001: TypeScript strict mode,
Fastify, pnpm workspaces, framework-independent domain packages, and no
synchronous CPU-heavy work on the event loop.

## Consequences

- Development, tests, containers, and future CI use one runtime major.
- The project can use Node.js 24 platform behavior without Node.js 22 fallbacks.
- Node.js 22 is no longer a supported or tested runtime.
- A future runtime-major change requires another superseding ADR and coordinated
  updates to engines, types, containers, automation, and documentation.

## Alternatives rejected

- **Keep Node.js 22 as the baseline:** preserves an unused compatibility target
  while development and verification run on Node.js 24.
- **Support both Node.js 22 and 24:** adds a test and dependency matrix before a
  released compatibility obligation exists.
- **Use an unbounded `>=24` engine:** could silently accept a future runtime major
  before dependencies and behavior have been verified.
