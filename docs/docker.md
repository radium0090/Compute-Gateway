# Docker

## Image requirements

The gateway uses a multi-stage Dockerfile:

1. pinned build image installs dependencies using the frozen lockfile;
2. build stage compiles TypeScript and prunes development dependencies;
3. a digest-pinned, shellless Distroless Node.js 24 runtime receives only
   runtime files;
4. runtime uses a fixed non-root UID/GID and an explicit entrypoint.

The image declares port 8080, handles `SIGTERM`, writes logs to stdout/stderr,
and writes no persistent application state to its filesystem.

## Build

```bash
docker build --pull --build-arg VERSION=0.0.0-dev \
  --build-arg REVISION=unknown --tag genchi:dev .
docker run --rm --read-only --tmpfs /tmp --env-file .env \
  --mount type=bind,src="$PWD/deploy/compose/genchi.yaml",dst=/etc/genchi/config.yaml,readonly \
  genchi:dev --check-config
```

Build context excludes `.git`, test output, local environment files, and
provider fixtures containing non-public data. BuildKit secrets, not `ARG` or
`ENV`, are used if a private registry credential is required during build.

## Compose

The root `docker-compose.yml` is a development/evaluation experience. It starts:

- `gateway` on port 8080;
- PostgreSQL 16 with a named volume;
- Redis 7.4 (the reference Compose file pins 7.4.9);
- OpenTelemetry Collector.

```bash
cp .env.example .env
docker compose up --build --wait
docker compose logs -f gateway
docker compose down
```

Run the isolated fresh-clone smoke after copying `.env`:

```bash
sh scripts/smoke-compose.sh
```

It starts a dedicated Compose project, applies migrations, creates a disposable
tenant and client key, authenticates a model-list request, and then removes only
that project's containers and volume. Dedicated high ports let it coexist with
the normal stack. It does not call a real model provider.

The Compose file uses health checks and dependency health conditions. Its
Collector validates the mounted pipeline before becoming healthy. Compose does
not contain real secrets, and all published development ports bind to loopback
by default.

## Runtime hardening

Production orchestrators set:

- read-only root filesystem;
- `no-new-privileges`;
- dropped Linux capabilities;
- tmpfs for `/tmp` if required;
- bounded process/file descriptors appropriate to streaming;
- explicit memory and CPU limits;
- seccomp/AppArmor defaults;
- immutable image digest.

Do not mount the Docker socket. The gateway never needs privileged mode.

## Image verification

CI produces an SBOM, scans OS and language dependencies, and signs release
images using keyless provenance when available. Release notes publish digest,
SBOM/provenance links, and known accepted findings. Critical exploitable
findings block release.

## Development persistence

`docker compose down` preserves named database volumes. Removing volumes is a
destructive, explicit operator action and is not part of normal setup or test
instructions.
