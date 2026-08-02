# ADR 0007: OpenTelemetry-First Observability

- Status: Accepted
- Date: 2026-08-03

## Context

Genchi needs correlated metrics and traces without tying self-hosted users to an
observability vendor. Provider routing adds spans and dimensions that generic
HTTP access logs cannot explain.

## Decision

Instrument metrics and traces with OpenTelemetry and export OTLP to a Collector.
Emit structured JSON logs through a vendor-neutral logger with shared request
and trace IDs. Define a content-free telemetry schema and bounded label set.

## Consequences

- Operators can choose compatible backends.
- The Collector becomes the recommended export/control boundary.
- Semantic conventions and stable Genchi fields require governance.
- Redaction and cardinality tests become part of CI.

## Alternatives rejected

- **Vendor-specific agent/API:** easier for one platform but harms portability.
- **Logs only:** insufficient for attempt latency, fallback, and distributed
  correlation.
- **Prompt logging for debugging:** creates unacceptable privacy and security
  exposure as a default.

