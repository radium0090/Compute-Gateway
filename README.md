# RAX Compute Gateway

> One API. Every AI model.

RAX Compute Gateway is an open-source AI Compute Gateway. It gives applications one stable,
OpenAI-compatible API for multiple model providers while centralizing routing,
authentication, retries, limits, and telemetry.

```text
Application -> RAX Compute Gateway -> OpenAI | Anthropic | Gemini | future providers
```

## Status

[RAX Compute Gateway v0.1.0](https://github.com/radium0090/Compute-Gateway/releases/tag/v0.1.0)
is released. The signed multi-architecture image, Helm chart, OpenAPI contract,
checksums, SBOM, and provenance are public. The exact image digest passed the
protected three-provider, streaming, lifecycle, observability, and concurrent-
stream memory gates on staging. The documents in this repository remain
normative unless an accepted Architecture Decision Record (ADR) supersedes
them.

## MVP capabilities

- `POST /v1/chat/completions`, including streaming
- OpenAI, Anthropic, and Gemini adapters
- Stable public model aliases and explicit provider models
- Deterministic routing, fallback, timeout, and retry policies
- RAX Compute Gateway API keys and bring-your-own-provider-key (BYOK) operation
- PostgreSQL metadata, optional Redis coordination, and stateless gateway nodes
- OpenTelemetry traces and metrics plus structured, redacted logs
- Docker Compose for local use and Kubernetes manifests/Helm for production
- TypeScript and Python SDKs generated from the public contract

Non-goals for the MVP include tool calling and structured outputs, a hosted
billing system, a marketplace, GPU scheduling, multimodal generation, an admin
dashboard, and autonomous quality-based model selection.

## Five-minute local start

Prerequisites: Docker 26+ with Docker Compose, `curl`, and an OpenAI API key for
the exact request below. To use a different provider, update its key and select
its documented alias in the request.

```bash
cp .env.example .env
# Replace RCG_MASTER_KEY, RCG_KEY_HASH_PEPPER, and OPENAI_API_KEY in .env
docker compose up --build --wait
curl http://localhost:8080/health/ready
```

Bootstrap a development tenant and create a client key after migrations finish:

```bash
docker compose exec postgres psql -U rcg -d compute_gateway -c \
  "INSERT INTO tenants (id, name, status) VALUES ('123e4567-e89b-42d3-a456-426614174000', 'local', 'active') ON CONFLICT DO NOTHING"
RCG_API_KEY="$(docker compose run --rm gateway keys create \
  --tenant-id 123e4567-e89b-42d3-a456-426614174000 \
  --name local-app --environment dev --models 'rax/*' --allow-streaming)"
export RCG_API_KEY
test -n "$RCG_API_KEY"
```

The key command emits the new credential once; command substitution keeps it
out of the terminal and stores it in the current shell. Keep it out of shell
history, source control, logs, and URLs.

Compose supplies PostgreSQL and Redis. Outside production, running the gateway
without `RCG_REDIS_URL` uses process-local limits and circuit state; every
production replica requires Redis coordination and fails startup if it is not
configured.

Send a request:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $RCG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "rax/fast",
    "messages": [{"role": "user", "content": "Hello from RAX Compute Gateway"}]
  }'
```

RAX Compute Gateway accepts the OpenAI client by changing its base URL:

```python
import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["RCG_API_KEY"],
    base_url="http://localhost:8080/v1",
)

response = client.chat.completions.create(
    model="rax/fast",
    messages=[{"role": "user", "content": "Hello"}],
)
```

## Operator console (`v0.2`)

Set `RCG_ADMIN_ENABLED=true`, configure the exact `RCG_ADMIN_ORIGIN`, and use a
dedicated `RCG_ADMIN_SESSION_PEPPER`. After migrations, create the first
administrator with a temporary password supplied on standard input:

```bash
printf '%s\n' "$RCG_ADMIN_TEMPORARY_PASSWORD" | docker compose run --rm -T gateway \
  admins create --email owner@example.com --display-name 'Gateway Owner'
```

Open `http://localhost:8080/admin/`. The temporary password must be replaced at
first login. The console manages tenants and one-time-display API keys and
shows bounded service/activity metadata. It never exposes provider credentials,
password/session hashes, API-key hashes, prompts, or completions.

## Documentation

Runnable [curl, Node.js, and Python examples](examples/README.md) are included
for a locally running gateway.

### Product and implementation

- [Vision](docs/vision.md)
- [MVP specification](docs/mvp.md)
- [Architecture](docs/architecture.md)
- [Repository layout](docs/folder.md)
- [Roadmap](docs/roadmap.md)
- [Implementation status and known gaps](docs/implementation-status.md)

### API and runtime behavior

- [API contract](docs/api.md)
- [OpenAPI workflow](docs/openapi.md)
- [Routing](docs/router.md)
- [Provider adapters](docs/providers.md)
- [Authentication](docs/auth.md)
- [SDKs](docs/sdk.md)
- [Configuration](docs/config.md)

### Operations

- [Deployment](docs/deployment.md)
- [Docker](docs/docker.md)
- [Kubernetes](docs/kubernetes.md)
- [Database](docs/database.md)
- [Security](docs/security.md)
- [Observability](docs/observability.md)
- [CI/CD](docs/ci-cd.md)
- [GitHub Actions](docs/github-actions.md)
- [Release-candidate runbook](docs/runbooks/release-candidate.md)
- [v0.1.0 RC evidence template](docs/releases/0.1.0-rc.md)
- [Rollback runbook](docs/runbooks/rollback.md)
- [Incident response](docs/runbooks/incident-response.md)
- [Security reporting](SECURITY.md)

### Project governance

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](docs/contributing.md)
- [Coding standards](docs/coding-standards.md)
- [Licensing](docs/licensing.md)
- [FAQ](docs/FAQ.md)
- [Architecture decisions](docs/adr/README.md)
- [Changelog](CHANGELOG.md)

## Development contract

The keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as defined
by RFC 2119. Implementation work should follow this precedence order:

1. Accepted ADRs
2. API and security contracts
3. MVP acceptance criteria
4. Architecture and operational guidance
5. Roadmap ideas

If documents conflict, open an issue and resolve it with an ADR before merging
behavior that changes the public contract.

## Community

Use GitHub Issues for bugs and scoped features, Discussions for questions and
design exploration, and pull requests for reviewed changes. Please read
[CONTRIBUTING](docs/contributing.md) before submitting code.

## License

The project is licensed under Apache License 2.0. See
[licensing.md](docs/licensing.md) for dependency and contribution rules.
