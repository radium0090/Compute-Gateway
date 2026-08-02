# Authentication and Authorization

## Two credential layers

1. **Genchi API keys** authenticate applications to the gateway.
2. **Provider credentials** authenticate the gateway to model providers.

They are never interchangeable. Clients never receive provider credentials.

## Genchi API keys

Keys use this form:

```text
gch_<environment>_<public-id>_<secret>
```

Only the public ID is searchable. The secret contains at least 256 bits of
cryptographically random entropy. The full key is shown once at creation.

Database storage includes:

- public ID and human-readable name;
- keyed hash of the full credential using a server-side pepper;
- tenant ID, environment, status, creation and expiration times;
- allowed model patterns and rate/concurrency policy;
- last-used timestamp updated asynchronously at coarse resolution.

The key hash uses HMAC-SHA-256 with `GENCHI_KEY_HASH_PEPPER`. Verification is
constant-time. The pepper comes from a secret manager and is not stored in the
database. Key values MUST NOT be logged, traced, or placed in URLs.

## Request authentication

```http
Authorization: Bearer gch_prod_...
```

Missing or invalid credentials return the same 401 shape to prevent key
enumeration. Disabled, revoked, expired, or wrong-environment keys are invalid.
Successful verification may be cached for at most 30 seconds. Cache keys are
hashes, not raw credentials.

## Authorization

Authorization is deny-by-default. A key policy can allow:

- public aliases or qualified models;
- streaming and tool use;
- requests per minute and concurrent requests;
- maximum request/output tokens where enforceable;
- allowed network origin metadata for trusted edge deployments.

Authentication success does not imply access to every configured model.
`GET /v1/models` returns only authorized models.

## Provider credentials

MVP provider credentials are referenced by environment variable or mounted
secret file. Configuration stores only a logical credential reference.

- Different environments use different provider credentials.
- A credential can be bound to specific provider/model routes.
- Rotation supports an overlap window with two references when the provider
  permits it.
- Provider keys MUST NOT be accepted in public request headers or bodies.

Future encrypted database storage requires a separate ADR and external KMS.

## Bootstrap and rotation

The release includes an operator CLI:

```bash
genchi keys create --name local-app --environment dev --models 'genchi/*'
genchi keys revoke --id key_01J...
```

The CLI prints a new key exactly once. Rotation means create, deploy to client,
verify traffic, then revoke the old key. Emergency revocation may flush the
authentication cache through an authenticated operator mechanism or restart.

## Network controls

Production deployments SHOULD terminate TLS at a trusted ingress and use TLS to
the gateway where the network is not trusted. `/metrics` and future operator
endpoints MUST be private or separately authenticated. Forwarded headers are
trusted only from configured proxies.

## Audit events

Create, revoke, expire, policy change, repeated authentication failure, and
provider credential configuration change produce metadata-only audit events.
Events include actor, action, target public ID, timestamp, result, and request
ID. They do not include secrets or prompt content.

