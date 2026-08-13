#!/usr/bin/env bash
set -Eeuo pipefail

required_environment=(
  AWS_REGION
  RCG_COMMIT_SHA
  RCG_DEPLOY_PATH
  RCG_PUBLIC_HOST
  RCG_SECRET_ARN
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required production deployment variable: ${name}" >&2
    exit 1
  fi
done

if [[ ! "$RCG_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'RCG_COMMIT_SHA must be a full lowercase Git SHA.' >&2
  exit 1
fi
if [[ ! "$RCG_DEPLOY_PATH" =~ ^/opt/[a-z0-9][a-z0-9._/-]*$ ]]; then
  echo 'RCG_DEPLOY_PATH must be a normalized path below /opt.' >&2
  exit 1
fi
if [[ ! "$RCG_PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo 'RCG_PUBLIC_HOST must be a normalized DNS hostname.' >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo 'The production deployment script must run as root through SSM.' >&2
  exit 1
fi

for command in aws curl docker git jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required production command is unavailable: ${command}" >&2
    exit 1
  fi
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_root="${RCG_DEPLOY_PATH}/releases/${RCG_COMMIT_SHA}"
if [[ "$repository_root" != "$expected_root" ]]; then
  echo 'The deployment checkout is outside the expected release directory.' >&2
  exit 1
fi
if [[ "$(git -C "$repository_root" rev-parse HEAD)" != "$RCG_COMMIT_SHA" ]]; then
  echo 'The deployment checkout does not match RCG_COMMIT_SHA.' >&2
  exit 1
fi

shared_root="${RCG_DEPLOY_PATH}/shared"
runtime_environment="${shared_root}/production.env"
deployment_record="${shared_root}/production-deployment.json"
deployment_log="/var/log/rax-compute-gateway-production-${RCG_COMMIT_SHA}.log"
previous_release=''
if [[ -L "${RCG_DEPLOY_PATH}/current" ]]; then
  previous_release="$(readlink -f "${RCG_DEPLOY_PATH}/current")"
fi

install -d -m 0750 "$shared_root"
umask 077
secret_json="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$RCG_SECRET_ARN" \
    --query SecretString \
    --output text
)"

if ! jq -e '
  . as $secret
  | [
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "RCG_KEY_HASH_PEPPER",
      "RCG_MASTER_KEY",
      "OPENAI_API_KEY",
      "POSTGRES_PASSWORD"
    ] as $required
  | type == "object"
    and all(
      $required[];
      ($secret[.] | type == "string" and length > 0 and (contains("\n") | not) and (contains("\r") | not))
    )
    and ($secret.RCG_KEY_HASH_PEPPER | length >= 32)
    and ($secret.RCG_MASTER_KEY | length >= 32)
' >/dev/null <<<"$secret_json"; then
  echo 'The production secret is missing a required field or contains an invalid value.' >&2
  exit 1
fi

temporary_environment="$(mktemp "${shared_root}/production.env.XXXXXX")"
cleanup_temporary_environment() {
  if [[ -f "$temporary_environment" ]]; then
    rm -f -- "$temporary_environment"
  fi
}
trap cleanup_temporary_environment EXIT

jq -r \
  --arg commit "$RCG_COMMIT_SHA" \
  --arg host "$RCG_PUBLIC_HOST" \
  --arg image "rax-compute-gateway:${RCG_COMMIT_SHA}" \
  '
    def env_quote:
      "\u0027" + (gsub("\u0027"; "\\\u0027")) + "\u0027";
    [
      "POSTGRES_PASSWORD=" + (.POSTGRES_PASSWORD | env_quote),
      "RCG_ENVIRONMENT=production",
      "RCG_DATABASE_URL=" + ("postgresql://rcg:" + (.POSTGRES_PASSWORD | @uri) + "@postgres:5432/compute_gateway" | env_quote),
      "RCG_MASTER_KEY=" + (.RCG_MASTER_KEY | env_quote),
      "RCG_KEY_HASH_PEPPER=" + (.RCG_KEY_HASH_PEPPER | env_quote),
      "RCG_CONFIG_FILE=/etc/rax-compute-gateway/config.yaml",
      "RCG_HOST=0.0.0.0",
      "RCG_PORT=8080",
      "RCG_LOG_LEVEL=info",
      "RCG_REQUEST_BODY_LIMIT_BYTES=2097152",
      "RCG_TOTAL_TIMEOUT_MS=60000",
      "RCG_CONNECT_TIMEOUT_MS=30000",
      "RCG_SHUTDOWN_GRACE_MS=30000",
      "RCG_TRUST_PROXY=false",
      "RCG_METRICS_ENABLED=true",
      "RCG_SERVICE_VERSION=0.1.0-production",
      "RCG_COMMIT_SHA=" + $commit,
      "RCG_REDIS_URL=redis://redis:6379",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318",
      "RCG_IMAGE=" + $image,
      "RCG_PUBLIC_HOST=" + ($host | env_quote),
      "OPENAI_API_KEY=" + (.OPENAI_API_KEY | env_quote),
      "ANTHROPIC_API_KEY=" + (.ANTHROPIC_API_KEY | env_quote),
      "GEMINI_API_KEY=" + (.GEMINI_API_KEY | env_quote)
    ]
    | .[]
  ' <<<"$secret_json" >"$temporary_environment"
unset secret_json
chmod 0600 "$temporary_environment"
mv -f -- "$temporary_environment" "$runtime_environment"
ln -sfn "$runtime_environment" "${repository_root}/.env"

compose() {
  docker compose \
    --project-directory "$repository_root" \
    --env-file "$runtime_environment" \
    --file "${repository_root}/docker-compose.yml" \
    --file "${repository_root}/deploy/compose/production.yaml" \
    "$@"
}

rollback_on_error() {
  status=$?
  trap - ERR
  if [[ -n "$previous_release" && -f "${previous_release}/docker-compose.yml" ]]; then
    echo 'Production deployment failed; attempting the previous release.' >&2
    docker compose \
      --project-directory "$previous_release" \
      --env-file "$runtime_environment" \
      --file "${previous_release}/docker-compose.yml" \
      --file "${previous_release}/deploy/compose/production.yaml" \
      up --detach --wait --wait-timeout 240 \
      >>"$deployment_log" 2>&1 || true
  fi
  tail -n 120 "$deployment_log" >&2 || true
  exit "$status"
}
trap rollback_on_error ERR

echo 'Validating the production Compose model.'
compose config --quiet >>"$deployment_log" 2>&1

echo 'Building the gateway image from the approved commit.'
compose build --pull gateway >>"$deployment_log" 2>&1
image_id="$(docker image inspect "rax-compute-gateway:${RCG_COMMIT_SHA}" --format '{{.Id}}')"

echo 'Validating runtime configuration without starting the gateway.'
compose run --rm --no-deps gateway --check-config >>"$deployment_log" 2>&1

echo 'Starting production services and HTTPS edge.'
compose up --detach --wait --wait-timeout 300 >>"$deployment_log" 2>&1

# Caddy obtains the first certificate asynchronously after it starts. Keep TLS
# verification enabled and resolve the public hostname to loopback so this
# probe validates both certificate issuance and the local edge path.
tls_ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 10 \
    --resolve "${RCG_PUBLIC_HOST}:443:127.0.0.1" \
    "https://${RCG_PUBLIC_HOST}/health/live" \
    >/dev/null; then
    tls_ready=true
    break
  fi
  sleep 2
done
if [[ "$tls_ready" != true ]]; then
  echo 'The public HTTPS edge did not become healthy.' >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 10 \
  --resolve "${RCG_PUBLIC_HOST}:443:127.0.0.1" \
  "https://${RCG_PUBLIC_HOST}/health/ready" \
  >/dev/null

ln -sfn "$repository_root" "${RCG_DEPLOY_PATH}/current"
jq -n \
  --arg commit "$RCG_COMMIT_SHA" \
  --arg host "$RCG_PUBLIC_HOST" \
  --arg image_id "$image_id" \
  --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{commit: $commit, host: $host, image_id: $image_id, deployed_at: $deployed_at}' \
  >"$deployment_record"
chmod 0640 "$deployment_record"

trap - ERR
trap - EXIT
echo "deployed_commit=${RCG_COMMIT_SHA}"
echo "public_host=${RCG_PUBLIC_HOST}"
echo "image_id=${image_id}"
echo 'health_live=ok'
echo 'health_ready=ok'
echo 'production_deployment=ok'
