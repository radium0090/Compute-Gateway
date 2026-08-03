# Rollback

## Decision triggers

Stop promotion when readiness falls, canonical 5xx/timeout rates exceed the
approved threshold, p95 gateway overhead regresses, stream cancellation leaks
connections, authorization behavior changes, or telemetry suggests secret or
content exposure. Prefer a traffic stop over rushed mutation.

## Application and configuration rollback

1. Freeze further rollout and record the current image digest, configuration
   revision, migration versions, time, and symptoms.
2. Remove the canary from traffic. Keep evidence but never capture request
   content, provider credentials, or plaintext Genchi API keys.
3. Restore the last verified image by immutable digest and its compatible
   configuration revision using the deployment system's normal rollout path.
4. Wait for every prior-version replica to become ready. Verify live, ready,
   model list, non-streaming, streaming, and client disconnect behavior.
5. Confirm error, latency, saturation, and provider-outcome metrics recover.
6. Open a scoped incident or release-blocker record and preserve safe logs,
   trace IDs, checksums, and artifact identities.

Do not overwrite a release tag or image. Release a new patch after correction.
Provider alias/configuration rollback is separately reviewed and audited.

## Database boundary

Rollback is allowed only when the migrated schema is backward-compatible with
the prior application. The migration runner is forward-only and migrations are
immutable. Never edit an applied migration or automatically reverse a
destructive change. If compatibility is uncertain, stop traffic, preserve the
database, and escalate to the database owner before changing application or
schema state. Restore from backup only under an approved data-recovery plan.

## Credential exposure

If rollback was triggered by possible secret exposure, restoring code is not
sufficient. Follow [incident response](incident-response.md), revoke/rotate the
affected Genchi and provider credentials, invalidate caches, and verify no
secret appears in retained logs or artifacts.
