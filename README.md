# Genchi

> One API. Every AI model.

Genchi is an open-source AI Compute Gateway. It gives applications one stable,
OpenAI-compatible API for multiple model providers while centralizing routing,
authentication, retries, limits, and telemetry.

```text
Application -> Genchi Gateway -> OpenAI | Anthropic | Gemini | future providers
```

## Status

Genchi is in the specification and MVP implementation stage. The documents in
this repository are normative for the first release unless an accepted
Architecture Decision Record (ADR) supersedes them.

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

Prerequisites: Node.js 22+, pnpm 9+, Docker 26+, and at least one provider API
key.

```bash
cp .env.example .env
# Set GENCHI_MASTER_KEY and one provider key in .env
docker compose up --build
curl http://localhost:8080/health/ready
```

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

### Project governance

- [Contributing](docs/contributing.md)
- [Coding standards](docs/coding-standards.md)
- [Licensing](docs/licensing.md)
- [FAQ](docs/FAQ.md)
- [Architecture decisions](docs/adr/README.md)

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

