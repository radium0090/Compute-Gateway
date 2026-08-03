# Kubernetes

## Packaging

The supported package is `deploy/helm/genchi`. Plain manifests in
`deploy/kubernetes/examples` illustrate integration but are not a substitute
for environment-specific secret, ingress, and database configuration.

Create the secret through the cluster's secret-management path, then install by
immutable image digest:

```bash
helm lint --strict deploy/helm/genchi
helm upgrade --install genchi deploy/helm/genchi \
  --namespace genchi --create-namespace \
  --set existingSecret=genchi-production-secrets \
  --set image.tag=v0.1.0 \
  --set image.digest=sha256:<digest>
```

The referenced secret uses the default keys `database-url`, `redis-url`,
`key-hash-pepper`, `openai-api-key`, `anthropic-api-key`, and `gemini-api-key`.
Key names are configurable under `secretKeys`; secret values are never accepted
by chart values. An unused provider should be removed from `policy.providers`
and alias candidates, with its corresponding `secretKeys` entry set to an empty
string instead of receiving a credential.

## Workloads

- `Deployment` for stateless gateway replicas;
- `Service` with a private ClusterIP;
- optional `Ingress` configured by the operator;
- `ServiceAccount` with no permissions unless a secret integration needs them;
- pre-deploy `Job` for database migrations;
- `PodDisruptionBudget` and topology spread constraints;
- optional `HorizontalPodAutoscaler`;
- `NetworkPolicy` for ingress and provider/database/telemetry egress.

PostgreSQL and Redis are not installed by the production chart. Use managed
services or separately operated clusters. Development dependencies may be
enabled only through an explicitly non-production values profile.

## Pod security baseline

```yaml
securityContext:
  runAsNonRoot: true
  seccompProfile:
    type: RuntimeDefault
containers:
  - name: gateway
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
```

The chart sets resource requests/limits, graceful termination, and a
`preStop`/shutdown grace compatible with the longest accepted request deadline.
Schema and operations checks reject a `latest` tag and a termination window
shorter than total request deadline + shutdown grace + pre-stop delay.

## Probes

```yaml
livenessProbe:
  httpGet: {path: /health/live, port: http}
readinessProbe:
  httpGet: {path: /health/ready, port: http}
startupProbe:
  httpGet: {path: /health/live, port: http}
```

Probe timeouts are short and failure thresholds avoid restart loops during a
brief database incident. Liveness never calls PostgreSQL, Redis, or providers.

## Secrets

The chart references existing Kubernetes Secrets; it does not accept raw secret
values in committed `values.yaml`. External Secrets or CSI secret stores are
recommended. Environment variables created from secrets are never rendered in
Helm NOTES or diagnostic output.

## Networking

Ingress enforces TLS and request body limits at least as strict as the gateway.
Streaming routes disable response buffering and use timeouts longer than the
gateway total deadline. Only trusted proxy CIDRs can set forwarding headers.
An enabled network policy must allow DNS, database, Redis, telemetry collector,
and configured provider endpoints. Operators account for provider IP/domain
variability.
Because Kubernetes NetworkPolicy does not resolve provider domain names, the
chart keeps the policy disabled by default. Enabling it permits DNS only until
the operator supplies the required database, Redis, Collector, ingress, and
provider CIDR/selector rules through `networkPolicy.extraEgress` and the ingress
namespace selector.

## Scaling and disruption

Start with two replicas. Set `maxUnavailable: 0`, `maxSurge: 1`, a disruption
budget, anti-affinity/topology spread, and sufficient termination grace to drain
streams. HPA stabilization windows prevent rapid oscillation. Load tests define
safe active-request and memory thresholds before production autoscaling.

## Helm quality gates

CI runs chart linting, schema validation, rendered-manifest policy checks, and a
kind-cluster smoke test. The kind job builds the candidate image, starts
disposable PostgreSQL/Redis fixtures, runs the migration hook, waits for two
ready replicas, exercises `/health/ready`, and performs a rolling Helm upgrade.
The fixtures under `deploy/kubernetes/ci` are test-only and are not supported
production databases. Chart and application versions are independently
versioned but a chart release pins a supported application image.
