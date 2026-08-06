# Configuration

## Principles

Configuration is validated at startup, secrets are referenced rather than
embedded, and unsafe production defaults fail fast. Environment variables
configure process-level settings; a versioned YAML file configures aliases and
route policy. Environment variables override file values only where documented.

## Required environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GENCHI_ENVIRONMENT` | yes | `development`, `test`, `staging`, or `production` |
| `GENCHI_DATABASE_URL` | yes | PostgreSQL connection URL |
| `GENCHI_MASTER_KEY` | bootstrap | initial operator secret; disable after bootstrap |
| `GENCHI_KEY_HASH_PEPPER` | yes | HMAC pepper for API key verification |
| `GENCHI_CONFIG_FILE` | no | route policy path; default `/etc/genchi/config.yaml` |
| `GENCHI_REDIS_URL` | conditional | required in production for distributed limits/circuit state |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | OpenTelemetry Collector endpoint |

Provider credentials follow explicit names such as `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`. A route references the configured
credential name; the value is never included in route YAML.

## Runtime settings

| Variable | Default | Constraint |
| --- | --- | --- |
| `GENCHI_HOST` | `0.0.0.0` | valid bind address |
| `GENCHI_PORT` | `8080` | 1..65535 |
| `GENCHI_LOG_LEVEL` | `info` | `debug/info/warn/error` |
| `GENCHI_REQUEST_BODY_LIMIT_BYTES` | `2097152` | positive integer |
| `GENCHI_TOTAL_TIMEOUT_MS` | `60000` | 1000..300000 |
| `GENCHI_CONNECT_TIMEOUT_MS` | `5000` | less than total timeout |
| `GENCHI_SHUTDOWN_GRACE_MS` | `30000` | positive integer |
| `GENCHI_TRUST_PROXY` | `false` | development only; must remain false in production for `0.1` |
| `GENCHI_METRICS_ENABLED` | `true` | boolean |
| `GENCHI_SERVICE_VERSION` | `0.0.0` | build/release identifier, maximum 64 characters |
| `GENCHI_COMMIT_SHA` | `unknown` | `unknown` or a 7..64 character lowercase Git SHA |

Release images set the last two values from immutable build metadata. Operators
normally leave them unchanged so traces and `genchi_build_info` match the image
provenance.

## Route policy example

```yaml
version: 1
providers:
  openai-primary:
    adapter: openai
    credential_env: OPENAI_API_KEY
    base_url: https://api.openai.com/v1
    models:
      gpt-5-mini:
        capabilities: [chat, streaming]

aliases:
  genchi/fast:
    candidates:
      - provider: openai-primary
        model: gpt-5-mini
        weight: 100

routing:
  max_attempts: 2
  total_timeout_ms: 60000
  connect_timeout_ms: 5000
  same_route_retries: 0
  minimum_attempt_budget_ms: 2000
  retry_base_delay_ms: 100
  global_max_concurrent_calls: 1000
  provider_max_concurrent_calls: 100
  circuit:
    failure_threshold: 5
    rolling_window_ms: 30000
    open_duration_ms: 30000
    half_open_max_calls: 1
```

`max_attempts` includes the first provider call. `same_route_retries` must be
less than `max_attempts`; the connect timeout must be less than the total
timeout; and the minimum attempt budget cannot exceed the total timeout.
Zero-weight alias candidates are fallback-only.

When `GENCHI_REDIS_URL` is unset outside production, limits and circuit state
are process-local and suitable only for development or a single replica. In
production Redis is mandatory. Admission, provider concurrency, and circuit
operations fail closed when configured Redis coordination is unavailable, and
Redis readiness is included in `/health/ready`.

Custom provider base URLs are allowed only by operator configuration. In
production they MUST use HTTPS unless an explicit private-network exception is
documented. Host allowlists and egress policy mitigate SSRF.

## Loading and reload

The process validates environment and YAML before opening the listener. Errors
name the setting but redact values. The MVP supports reload by controlled
process restart; live reload is optional. Deployments perform a readiness-gated
rolling restart so configuration changes apply atomically per replica.

## Precedence

1. command-line flags limited to configuration checks, migrations, and local
   operator key commands;
2. documented environment overrides;
3. YAML policy;
4. safe development defaults.

Production mode has no default database URL, key pepper, or provider
credential, and rejects forwarded-header trust. Unknown environment variables
are ignored, but unknown YAML keys fail validation to catch spelling errors.

## Secret handling

- `.env` is development-only and gitignored.
- `.env.example` contains names and fake values only.
- Secrets are mounted/injected by the runtime secret system.
- Diagnostic configuration output reports `<set>` or `<unset>`, never values.
- Child processes are not used in the gateway data plane.
- Secret rotation instructions are tested in release rehearsals.
