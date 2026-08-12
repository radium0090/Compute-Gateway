# ADR 0012: RAX Digital Product Identity and Tenant Separation

- Status: Accepted
- Date: 2026-08-12

## Context

The repository was initially implemented under the working name `Genchi`.
The commercial service is owned and operated by RAX Digital, while Genchi is a
customer of that service. Keeping a customer name in the platform namespace,
credentials, SDKs, telemetry, storage, and infrastructure would confuse product
ownership with tenant identity and make later multi-tenant operation unsafe.

The project has not published `v0.1.0` and has no external production API keys.
The existing AWS deployment is an internal staging rehearsal, so this is the
last practical point to make one clean, intentionally incompatible identity
migration.

## Decision

RAX Digital owns and operates the product **RAX Compute Gateway**. The stable
public endpoint is `https://api.rax-digital.com`. Genchi is represented only as
a tenant/customer record and never as a platform namespace.

The canonical technical identifiers are:

| Surface | Identifier |
| --- | --- |
| service, image, and Helm name | `rax-compute-gateway` |
| Node.js package scope | `@rax-digital/*` |
| TypeScript SDK | `@rax-digital/compute-gateway-sdk` |
| Python distribution | `rax-compute-gateway` |
| Python import package | `rax_compute_gateway` |
| operator CLI | `rax-compute-gateway` |
| environment variables | `RCG_*` |
| API key prefix | `rcg_<environment>_...` |
| public model aliases | `rax/*` |
| response extension | `rax` |
| metrics prefix | `rcg_` |
| Redis namespace | `rcg:` |
| PostgreSQL database/user | `compute_gateway` / `rcg` |
| AWS secret path | `rax/compute-gateway/<environment>/runtime` |
| production GitHub environment | `aws-production` |

Existing accepted ADRs remain authoritative for architecture and behavior.
This ADR supersedes only their former `Genchi` product-name examples and
brand-specific protocol identifiers.

No compatibility aliases for `GENCHI_*`, `gch_*`, `genchi/*`, `@genchi/*`, or
the `genchi` response extension will be shipped before `v0.1.0`. Supporting two
identities would create ambiguity without protecting a released client. The
OpenAPI document and generated SDKs change atomically with the implementation.

The existing staging deployment and its data remain untouched until the renamed
release passes the complete release gate. Production provisioning uses new
RAX-namespaced secrets and `rcg_prod_...` credentials. Old staging resources may
be retired only after production verification and backup evidence are recorded.

## Consequences

- Product ownership and customer tenancy are unambiguous.
- Future customers share one neutral platform namespace.
- Pre-release consumers must update environment variables, model aliases, SDK
  imports, and API response-extension access in one migration.
- Existing staging infrastructure remains a rollback target during migration.
- Documentation, generated contracts, operational assets, and release evidence
  must reject accidental reintroduction of the former platform name.

## Rejected alternatives

- **Keep Genchi as the platform brand:** incorrectly makes one customer the
  owner and namespace of a multi-tenant RAX Digital service.
- **Rename only user-facing text:** leaves credentials, telemetry, SDKs, and
  infrastructure with the wrong security and ownership boundary.
- **Maintain permanent compatibility aliases before v0.1.0:** adds dual-brand
  complexity without an installed production base to protect.
