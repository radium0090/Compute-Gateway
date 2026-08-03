# Security policy

## Supported versions

Genchi is pre-1.0. Security fixes are applied to the latest release only.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting feature for this repository. Include the affected
version, impact, reproduction steps, and any suggested mitigation.

The maintainers will acknowledge a complete report within five business days,
coordinate validation and remediation privately, and publish an advisory after
a fix is available. Please do not include credentials, customer data, or other
sensitive information in a report.

## Operational expectations

- Never commit provider keys, database credentials, peppers, or encryption
  keys. Deployments reference an externally managed secret.
- Use immutable image digests in production and verify release signatures and
  provenance before promotion.
- Keep GitHub Actions pinned to full commit SHAs and review automated dependency
  updates before merging.
