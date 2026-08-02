# ADR 0010: Apache License 2.0 Intent

- Status: Accepted
- Date: 2026-08-03

## Context

Genchi aims for broad developer and enterprise adoption, outside contributions,
and clear patent terms. The open-source core should be usable independently of a
future hosted business.

## Decision

Release original Genchi source and documentation under Apache License 2.0,
subject to final repository license/notice files and legal review before public
release. Accept contributions with Developer Certificate of Origin sign-off.

## Consequences

- Commercial and internal use are permitted under clear conditions.
- Apache-2.0 includes an express patent license and notice obligations.
- Dependency licenses and notices require continuous review.
- A hosted service may remain commercially differentiated without making the
  core source-available-only.

## Alternatives rejected

- **MIT:** simple and permissive, but lacks Apache-2.0's explicit patent grant
  structure.
- **AGPL:** protects network copyleft but may reduce enterprise adoption and
  conflicts with the initial ecosystem strategy.
- **Source-available license:** would undermine the stated open-source promise.
- **Dual licensing initially:** adds contributor and governance complexity before
  a demonstrated need.

