# Kubernetes

## Packaging

The supported package is `deploy/helm/genchi`. Plain manifests in
`deploy/kubernetes/examples` illustrate integration but are not a substitute
for environment-specific secret, ingress, and database configuration.

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
Network policy allows DNS, database, Redis, telemetry collector, and configured
provider endpoints. Operators account for provider IP/domain variability.

## Scaling and disruption

Start with two replicas. Set `maxUnavailable: 0`, `maxSurge: 1`, a disruption
budget, anti-affinity/topology spread, and sufficient termination grace to drain
streams. HPA stabilization windows prevent rapid oscillation. Load tests define
safe active-request and memory thresholds before production autoscaling.

## Helm quality gates

CI runs chart linting, schema validation, rendered-manifest policy checks, and a
kind-cluster smoke test. Chart and application versions are independently
versioned but a chart release pins a supported application image.

