# XServer Production Bootstrap

This runbook prepares the low-cost single-host deployment accepted in ADR 0017.
Run it only on a new Ubuntu 24.04 XServer VPS. The commands assume a dedicated
non-root deployment user named `raxdeploy` and the default deployment root
`/opt/rax-compute-gateway`.

## 1. Provision and network

- Choose Ubuntu 24.04 LTS with at least 4 GiB memory.
- Attach a stable public IPv4 address.
- Permit inbound TCP 22 temporarily from the administrator's fixed IP.
- Permit inbound TCP 80 and TCP/UDP 443 from the Internet.
- Do not expose PostgreSQL 5432, Redis 6379, gateway 8080, or metrics.
- Create DNS `A` records for the API and product-site hostnames after the public
  address is stable.

If Cloudflare proxies the records, start with DNS-only mode until Caddy has
obtained certificates and both hostnames pass the acceptance checks.

## 2. Patch the host and install Docker

Run as the initial sudo-capable Ubuntu user:

```bash
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg unattended-upgrades
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$(dpkg --print-architecture)" "$VERSION_CODENAME" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Keep unattended security upgrades enabled. Schedule reboots explicitly so a
kernel update does not surprise an evaluation window.

## 3. Create the deployment identity

```bash
sudo adduser --disabled-password --gecos '' raxdeploy
sudo usermod -aG docker raxdeploy
sudo install -d -o raxdeploy -g raxdeploy -m 0750 \
  /opt/rax-compute-gateway/releases \
  /opt/rax-compute-gateway/shared \
  /home/raxdeploy/.ssh
sudo chmod 0700 /home/raxdeploy/.ssh
```

Generate the GitHub deployment key on an administrator machine, not on the
server. Store the private key only in the protected GitHub environment secret
`XSERVER_SSH_PRIVATE_KEY`. Append the public key to
`/home/raxdeploy/.ssh/authorized_keys`, set ownership to `raxdeploy`, and mode
`0600`.

After GitHub deployment works, restrict SSH by source IP where practical. The
deployment key is a production credential and must be rotated if copied or
exposed.

## 4. Create the runtime environment

Copy `deploy/xserver/runtime.env.example` to:

```text
/opt/rax-compute-gateway/shared/production.env
```

Replace every placeholder on the server and set:

```bash
sudo chown raxdeploy:raxdeploy /opt/rax-compute-gateway/shared/production.env
sudo chmod 0600 /opt/rax-compute-gateway/shared/production.env
```

Generate each password or pepper independently with a cryptographically secure
generator. URL-encode the PostgreSQL password inside `RCG_DATABASE_URL`.
Provider keys and the Resend key belong only in this host file. Never paste
them into a GitHub variable, workflow input, issue, or log.

Keep `RCG_CONSOLE_REGISTRATION_ENABLED=false` for the first deployment. Use a
verified sending domain and exact HTTPS Console origin before enabling it.

## 5. Configure GitHub

Create a protected environment named `xserver-production`, restrict it to
`main`, and require a reviewer.

Environment secrets:

- `XSERVER_HOST`: public IP or deployment hostname;
- `XSERVER_SSH_USER`: `raxdeploy`;
- `XSERVER_SSH_PRIVATE_KEY`: the dedicated private key.

Environment variables:

- `XSERVER_DEPLOY_PATH`: `/opt/rax-compute-gateway`;
- `XSERVER_SSH_HOST_KEY`: the complete, independently verified `known_hosts`
  line from `ssh-keyscan`;
- `RCG_API_HOST`: for example `api.rax-digital.com`;
- `RCG_SITE_HOST`: for example `gateway.rax-digital.com`.

Verify the SSH host-key fingerprint through the XServer console before saving
it. Do not trust an unverified network scan by itself. The workflow enforces
strict host-key checking, uses only the dedicated deployment identity, and
rejects non-normalized paths below `/opt`.

## 6. First deployment

Merge a fully green pull request to `main`, copy its full 40-character commit
SHA, and dispatch `XServer production deploy`. Leave `image_ref` empty for the
first rehearsal; use a signed immutable release digest for a public release.

The workflow validates main ancestry, uploads an archive, validates the runtime
configuration, builds or pulls the image, runs migrations, starts the stack,
and verifies both HTTPS hosts plus readiness. Each release records its exact
image reference in a non-secret `.deployment.env` file so an automatic rollback
restores the previous application image instead of reusing the failed one. A
second verification runs from the GitHub-hosted runner and proves that public
DNS, TLS, the product site, Console, legal pages, security headers, and health
routes work from outside the VPS while `/metrics` remains unavailable.

## 7. Bootstrap the operator

Open an SSH session to the host and pass a temporary password over standard
input. Do not include it in the command line:

```bash
cd /opt/rax-compute-gateway/current
read -rsp 'Temporary admin password: ' RCG_ADMIN_TEMPORARY_PASSWORD
printf '\n'
printf '%s\n' "$RCG_ADMIN_TEMPORARY_PASSWORD" |
  docker compose --env-file /opt/rax-compute-gateway/shared/production.env \
    -f docker-compose.yml -f deploy/xserver/compose.yaml run --rm -T gateway \
    admins create --email owner@example.com --display-name 'RAX Operator'
unset RCG_ADMIN_TEMPORARY_PASSWORD
```

Sign in through the API host `/admin/` and replace the temporary password
immediately.

## 8. Acceptance and opening registration

Confirm:

- product site, `/health/live`, and `/health/ready` return over HTTPS;
- `/metrics` and datastore ports are not public;
- operator login, password change, customer approval, and inquiry workflow;
- customer registration, email verification, reset, key creation, API call,
  key revocation, and suspension using `docs/customer-console.md`;
- normal and streaming calls for every enabled provider alias;
- container restart preserves PostgreSQL state and invalidates no valid keys.

Only then change `RCG_CONSOLE_REGISTRATION_ENABLED=true` and redeploy.

## 9. Recovery baseline

Before accepting paid customer data, add encrypted off-host PostgreSQL backups
and prove a disposable restore. Until then, take a manual pre-deployment dump
and keep it outside the Docker volume. Record the deployed commit and runtime
configuration version; never store secret values in the record.
