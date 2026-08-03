# Docker

## Image requirements

The gateway uses a multi-stage Dockerfile:

1. pinned build image installs dependencies using the frozen lockfile;
2. build stage compiles TypeScript and prunes development dependencies;
3. minimal pinned runtime image receives only runtime files;
4. runtime uses a fixed non-root UID/GID and an explicit entrypoint.

The image declares port 8080, handles `SIGTERM`, writes logs to stdout/stderr,
and writes no persistent application state to its filesystem.

## Build

```bash
docker build --pull --tag genchi:dev .
docker run --rm genchi:dev --check-config
```

Build context excludes `.git`, test output, local environment files, and
provider fixtures containing non-public data. BuildKit secrets, not `ARG` or
`ENV`, are used if a private registry credential is required during build.

## Compose

The root `docker-compose.yml` is a development/evaluation experience. It starts:

- `gateway` on port 8080;
- PostgreSQL 16 with a named volume;
- Redis 7.4 (the reference Compose file pins 7.4.9);
- OpenTelemetry Collector;
- optional observability profiles, not required for a first request.

```bash
cp .env.example .env
docker compose up --build --wait
docker compose logs -f gateway
docker compose down
```

The Compose file uses health checks and dependency health conditions. It does
not contain real secrets. Database ports bind to loopback by default.

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
