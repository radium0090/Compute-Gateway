# Database

## Role of PostgreSQL

PostgreSQL stores durable control-plane metadata. Prompt messages, completion
content, provider raw responses, and full API keys are not stored in the MVP.

## Core schema

| Table | Purpose | Important columns |
| --- | --- | --- |
| `tenants` | security and policy boundary | `id`, `name`, `status`, timestamps |
| `api_keys` | client credentials | `id`, `public_id`, `key_hash`, `tenant_id`, policy, status, expiry |
| `schema_migrations` | migration history | version, checksum, applied time |

Database identifiers use UUIDs; the current operator command generates random
UUIDv4 API-key IDs and accepts an operator-supplied tenant UUID. Timestamps use
`timestamptz` in UTC. User-visible credentials include typed prefixes, while
database primary keys remain UUID values.

Provider aliases and routes are held in the versioned YAML policy for `0.1`.
Durable usage and audit-event tables are not part of the initial migration;
their addition requires a later migration with explicit retention rules.

## Migrations

- Migrations are immutable, ordered SQL files with checksums.
- Every schema change is backward-compatible for at least one rolling-deploy
  window: expand, deploy, migrate data, switch reads, then contract later.
- Application startup does not automatically run migrations in production.
- A dedicated migration job uses an advisory lock and fails on checksum drift.
- Each release tests empty install, previous-release upgrade, and rollback of
  application code against the expanded schema.
- Destructive migrations require an ADR, backup verification, and recovery plan.

## Transactions and access

Repositories expose task-oriented operations, and HTTP handlers do not execute
SQL. API key creation and revocation use parameterized statements. Successful
authentication updates `last_used_at` no more than once per minute per key.

## Connections

The connection pool is bounded per replica so total deployment connections stay
below the database limit. Statements use parameters. Connections use TLS in
production and a least-privilege application role without schema-owner rights.
The migration role is separate.

## Indexing baseline

- unique index on `api_keys.public_id`;
- partial index for active keys by tenant and expiration.

Indexes are justified with measured query plans; low-cardinality standalone
indexes are avoided.

## Backups and recovery

Production operators enable encrypted automated backups and point-in-time
recovery. Restore tests occur at least quarterly. The initial targets are RPO
15 minutes and RTO 60 minutes for managed deployments; self-hosted operators
set their own targets. Backup data follows the same retention and access rules.
