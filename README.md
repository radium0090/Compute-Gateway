# Genchi

> One API. Every AI model.

Genchi is an open-source AI Compute Gateway. It gives applications one stable,
OpenAI-compatible API for multiple model providers while centralizing routing,
authentication, retries, limits, and telemetry.

```text
Application -> Genchi Gateway -> OpenAI | Anthropic | Gemini | future providers
```

## Status

Genchi is in release-candidate validation for the MVP. The gateway,
provider/routing core, operations baseline, SDK previews, contract gates, and
repeatable performance checks are implemented. Real-provider smoke and final
release approval remain protected operator-run gates. The documents in this repository are
normative for the first release unless an accepted Architecture Decision Record
(ADR) supersedes them.

## MVP capabilities

- `POST /v1/chat/completions`, including streaming
- OpenAI, Anthropic, and Gemini adapters
- Stable public model aliases and explicit provider models
- Deterministic routing, fallback, timeout, and retry policies
- Genchi API keys and bring-your-own-provider-key (BYOK) operation
- PostgreSQL metadata, optional Redis coordination, and stateless gateway nodes
- OpenTelemetry traces and metrics plus structured, redacted logs
- Docker Compose for local use and Kubernetes manifests/Helm for production
- TypeScript and Python SDKs generated from the public contract

Non-goals for the MVP include a hosted billing system, a marketplace, GPU
scheduling, multimodal generation, an admin dashboard, and autonomous
quality-based model selection.

## Five-minute local start

Prerequisites: Node.js 24, pnpm 9+, Docker 26+, and at least one provider API
key.

```bash
cp .env.example .env
# Set GENCHI_MASTER_KEY and one provider key in .env
docker compose up --build
curl http://localhost:8080/health/ready
```

Bootstrap a development tenant and create a client key after migrations finish:

```bash
docker compose exec postgres psql -U genchi -d genchi -c \
  "INSERT INTO tenants (id, name, status) VALUES ('123e4567-e89b-42d3-a456-426614174000', 'local', 'active') ON CONFLICT DO NOTHING"
docker compose run --rm gateway keys create \
  --tenant-id 123e4567-e89b-42d3-a456-426614174000 \
  --name local-app --environment dev --models 'genchi/*' --allow-streaming
```

The second command displays the new `GENCHI_API_KEY` once. Keep it out of shell
history, source control, logs, and URLs.

Compose supplies PostgreSQL and Redis. Outside production, running the gateway
without `GENCHI_REDIS_URL` uses process-local limits and circuit state; every
production replica requires Redis coordination and fails startup if it is not
configured.

Send a request:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $GENCHI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "genchi/fast",
    "messages": [{"role": "user", "content": "Hello from Genchi"}]
  }'
```

Genchi accepts the OpenAI client by changing its base URL:

```python
from openai import OpenAI

client = OpenAI(
    api_key="genchi_local_key",
    base_url="http://localhost:8080/v1",
)

response = client.chat.completions.create(
    model="genchi/fast",
    messages=[{"role": "user", "content": "Hello"}],
)
```

## Documentation

Runnable [curl, Node.js, and Python examples](examples/README.md) are included
for a locally running gateway.

### Product and implementation

- [Vision](docs/vision.md)
- [MVP specification](docs/mvp.md)
- [Architecture](docs/architecture.md)
- [Repository layout](docs/folder.md)
- [Roadmap](docs/roadmap.md)

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

The intended project license is Apache License 2.0. See
[licensing.md](docs/licensing.md) for release requirements and dependency rules.
