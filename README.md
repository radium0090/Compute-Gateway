# RAX Compute Gateway

> One API. Every AI model.

RAX Compute Gateway is an open-source AI Compute Gateway. It gives applications one stable,
OpenAI-compatible API for multiple model providers while centralizing routing,
authentication, retries, limits, and telemetry.

```text
Application -> RAX Compute Gateway -> OpenAI | Anthropic | Gemini | future providers
```

## Status

[RAX Compute Gateway v0.2.0](https://github.com/radium0090/Compute-Gateway/releases/tag/v0.2.0)
adds the operator console, one-command self-hosted quickstart, and the public,
abuse-resistant hosted evaluation described below. Release artifacts include a
signed multi-architecture image, Helm chart, OpenAPI contract, checksums, SBOM,
and provenance. The documents in this repository remain normative unless an
accepted Architecture Decision Record (ADR) supersedes them.

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

Non-goals for the original MVP include tool calling and structured outputs, a
hosted billing system, a marketplace, GPU scheduling, multimodal generation,
and autonomous quality-based model selection. The operator console and hosted
evaluation are narrowly scoped post-MVP additions governed by accepted ADRs.

## Choose your first run

### 60-second hosted trial

Open [api.rax-digital.com/demo](https://api.rax-digital.com/demo/), verify with
GitHub, and copy the generated `curl`. The complete public path has been
verified against the production gateway: claim a key, run the command, and
receive a normalized model response.

The service issues a unique API key that expires after five minutes; there is
no shared public key in this repository. The trial is intentionally limited to
one low-cost model, non-streaming calls, small input/output budgets, one
concurrent request, per-account cooldown, and a global daily budget. See
[hosted demo design and operation](docs/demo.md).

The hosted service is for evaluation only. Applications should self-host or
obtain a normal customer key rather than depend on trial availability.

### 5–10 minute self-hosted start

Prerequisites: Docker 26+ with Docker Compose, `curl`, and an OpenAI API key for
the first request. A fork is needed only when contributing code; to try the
gateway, clone the upstream repository and run one command:

```bash
git clone https://github.com/radium0090/Compute-Gateway.git
cd Compute-Gateway
sh scripts/quickstart.sh
```

The script creates a private `.env`, generates local gateway secrets, prompts
for the provider key without echoing it, starts PostgreSQL, Redis, telemetry,
and the gateway, provisions a local client key, and prints the first model
response. It never sends the OpenAI key anywhere except the configured OpenAI
endpoint. Stop the stack with `docker compose down`.

A successful run ends with a normalized JSON chat response and a local
`rcg_dev_...` credential shown once. If the provider rejects the final request,
the local stack remains running for diagnosis; check provider billing/model
access, update `.env`, and rerun the script.

To understand or run each operation manually instead:

```bash
cp .env.example .env
# Replace the fake RCG secrets and OPENAI_API_KEY in .env.
docker compose up --build --wait
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

You do not need to fork merely to run the gateway. To contribute, first
[fork the repository](https://github.com/radium0090/Compute-Gateway/fork), clone
your fork, create a feature branch, and open a pull request as described in the
contribution guide.

## License

The project is licensed under Apache License 2.0. See
[licensing.md](docs/licensing.md) for dependency and contribution rules.
