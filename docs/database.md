# Database

## Role of PostgreSQL

PostgreSQL stores durable control-plane metadata. Prompt messages, completion
content, provider raw responses, and full API keys are not stored in the MVP.

## Core schema

| Table | Purpose | Important columns |
| --- | --- | --- |
| `tenants` | security and policy boundary | `id`, `name`, `status`, timestamps |
| `api_keys` | client credentials | `id`, `public_id`, `key_hash`, `tenant_id`, policy, status, expiry |
| `model_aliases` | public alias versions | `id`, `name`, `config_version`, `enabled` |
| `routes` | ordered physical candidates | alias, provider ref, model, weight, capabilities |
| `usage_events` | metadata-only request accounting | request, tenant/key IDs, tokens, route, latency, status |
| `audit_events` | security/control changes | actor, action, target, result, metadata |
| `schema_migrations` | migration history | version, checksum, applied time |

Identifiers use UUIDv7 or an equivalent time-sortable 128-bit identifier.
Timestamps use `timestamptz` in UTC. User-visible IDs include typed prefixes but
database primary keys remain typed values, not overloaded strings.

## Usage event policy

Usage events contain:

- request ID and timestamps;
- tenant and API key IDs;
- requested alias, selected provider/model, attempt count;
- normalized token counts and whether counts are estimated;
- status/error class and latency buckets;
- no prompt, response, tool arguments, headers, raw user ID, or credentials.

Default retention is 30 days and is configurable. Aggregates may outlive raw
events if they cannot be tied to content or an end user.

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

Repositories expose task-oriented operations. Handlers do not execute SQL.
Key creation, route version publication, and audit-event creation are
transactional. Usage events are buffered and inserted asynchronously in bounded
batches; overload drops accounting events with an alert rather than retaining
request content or exhausting gateway memory.

## Connections

The connection pool is bounded per replica so total deployment connections stay
below the database limit. Statements use parameters. Connections use TLS in
production and a least-privilege application role without schema-owner rights.
The migration role is separate.

## Indexing baseline

- unique index on `api_keys.public_id`;
- indexes for active keys by tenant and expiration;
- unique alias name plus configuration version;
- usage event indexes on timestamp and tenant, with time partitioning when
  volume justifies it;
- audit event index on timestamp and target public ID.

Indexes are justified with measured query plans; low-cardinality standalone
indexes are avoided.

## Backups and recovery

Production operators enable encrypted automated backups and point-in-time
recovery. Restore tests occur at least quarterly. The initial targets are RPO
15 minutes and RTO 60 minutes for managed deployments; self-hosted operators
set their own targets. Backup data follows the same retention and access rules.

