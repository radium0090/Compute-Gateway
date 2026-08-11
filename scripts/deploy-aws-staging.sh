#!/usr/bin/env bash
set -Eeuo pipefail

required_environment=(
  AWS_REGION
  GENCHI_COMMIT_SHA
  GENCHI_DEPLOY_PATH
  GENCHI_SECRET_ARN
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required deployment variable: ${name}" >&2
    exit 1
  fi
done

if [[ ! "$GENCHI_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'GENCHI_COMMIT_SHA must be a full lowercase Git SHA.' >&2
  exit 1
fi
if [[ ! "$GENCHI_DEPLOY_PATH" =~ ^/opt/[a-z0-9][a-z0-9._/-]*$ ]]; then
  echo 'GENCHI_DEPLOY_PATH must be a normalized path below /opt.' >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo 'The staging deployment script must run as root through SSM.' >&2
  exit 1
fi

for command in aws curl docker git jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required staging command is unavailable: ${command}" >&2
    exit 1
  fi
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_root="${GENCHI_DEPLOY_PATH}/releases/${GENCHI_COMMIT_SHA}"
if [[ "$repository_root" != "$expected_root" ]]; then
  echo 'The deployment checkout is outside the expected release directory.' >&2
  exit 1
fi
if [[ "$(git -C "$repository_root" rev-parse HEAD)" != "$GENCHI_COMMIT_SHA" ]]; then
  echo 'The deployment checkout does not match GENCHI_COMMIT_SHA.' >&2
  exit 1
fi

shared_root="${GENCHI_DEPLOY_PATH}/shared"
runtime_environment="${shared_root}/staging.env"
deployment_record="${shared_root}/deployment.json"
deployment_log="/var/log/genchi-deploy-${GENCHI_COMMIT_SHA}.log"
previous_release=''
if [[ -L "${GENCHI_DEPLOY_PATH}/current" ]]; then
  previous_release="$(readlink -f "${GENCHI_DEPLOY_PATH}/current")"
fi

install -d -m 0750 "$shared_root"
umask 077
secret_json="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$GENCHI_SECRET_ARN" \
    --query SecretString \
    --output text
)"

if ! jq -e '
  . as $secret
  | [
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GENCHI_KEY_HASH_PEPPER",
      "GENCHI_MASTER_KEY",
      "OPENAI_API_KEY",
      "POSTGRES_PASSWORD"
    ] as $required
  | type == "object"
    and all(
      $required[];
      ($secret[.] | type == "string" and length > 0 and (contains("\n") | not) and (contains("\r") | not))
    )
    and ($secret.GENCHI_KEY_HASH_PEPPER | length >= 32)
    and ($secret.GENCHI_MASTER_KEY | length >= 32)
' >/dev/null <<<"$secret_json"; then
  echo 'The staging secret is missing a required field or contains an invalid value.' >&2
  exit 1
fi

temporary_environment="$(mktemp "${shared_root}/staging.env.XXXXXX")"
cleanup_temporary_environment() {
  if [[ -f "$temporary_environment" ]]; then
    rm -f -- "$temporary_environment"
  fi
}
trap cleanup_temporary_environment EXIT

jq -r \
  --arg commit "$GENCHI_COMMIT_SHA" \
  --arg image "genchi:${GENCHI_COMMIT_SHA}" \
  '
    def env_quote:
      "\u0027" + (gsub("\u0027"; "\\\u0027")) + "\u0027";
    [
      "POSTGRES_PASSWORD=" + (.POSTGRES_PASSWORD | env_quote),
      "GENCHI_ENVIRONMENT=staging",
      "GENCHI_DATABASE_URL=" + ("postgresql://genchi:" + (.POSTGRES_PASSWORD | @uri) + "@postgres:5432/genchi" | env_quote),
      "GENCHI_MASTER_KEY=" + (.GENCHI_MASTER_KEY | env_quote),
      "GENCHI_KEY_HASH_PEPPER=" + (.GENCHI_KEY_HASH_PEPPER | env_quote),
      "GENCHI_CONFIG_FILE=/etc/genchi/config.yaml",
      "GENCHI_HOST=0.0.0.0",
      "GENCHI_PORT=8080",
      "GENCHI_LOG_LEVEL=info",
      "GENCHI_REQUEST_BODY_LIMIT_BYTES=2097152",
      "GENCHI_TOTAL_TIMEOUT_MS=60000",
      "GENCHI_CONNECT_TIMEOUT_MS=30000",
      "GENCHI_SHUTDOWN_GRACE_MS=30000",
      "GENCHI_TRUST_PROXY=false",
      "GENCHI_METRICS_ENABLED=true",
      "GENCHI_SERVICE_VERSION=0.1.0-staging",
      "GENCHI_COMMIT_SHA=" + $commit,
      "GENCHI_REDIS_URL=redis://redis:6379",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318",
      "GENCHI_IMAGE=" + $image,
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
    "$@"
}

smoke_tenant_id='123e4567-e89b-42d3-a456-426614174001'
cleanup_smoke_key() {
  compose exec -T postgres psql \
    --username genchi \
    --dbname genchi \
    --set ON_ERROR_STOP=1 \
    --command "DELETE FROM api_keys WHERE tenant_id = '${smoke_tenant_id}' AND name = 'staging-deploy-smoke'" \
    >>"$deployment_log" 2>&1 || true
}

rollback_on_error() {
  status=$?
  trap - ERR
  cleanup_smoke_key
  if [[ -n "$previous_release" && -f "${previous_release}/docker-compose.yml" ]]; then
    echo 'Deployment failed; attempting the previous release.' >&2
    docker compose \
      --project-directory "$previous_release" \
      --env-file "$runtime_environment" \
      --file "${previous_release}/docker-compose.yml" \
      up --detach --wait --wait-timeout 240 \
      >>"$deployment_log" 2>&1 || true
  fi
  tail -n 120 "$deployment_log" >&2 || true
  exit "$status"
}
trap rollback_on_error ERR

echo 'Validating the staging Compose model.'
compose config --quiet >>"$deployment_log" 2>&1

echo 'Building the gateway image from the approved commit.'
compose build --pull gateway >>"$deployment_log" 2>&1
image_id="$(docker image inspect "genchi:${GENCHI_COMMIT_SHA}" --format '{{.Id}}')"

echo 'Validating runtime configuration without starting the gateway.'
compose run --rm --no-deps gateway --check-config >>"$deployment_log" 2>&1

echo 'Starting PostgreSQL, Redis, OpenTelemetry Collector, migrations, and gateway.'
compose up --detach --wait --wait-timeout 240 >>"$deployment_log" 2>&1

curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:8080/health/live \
  >/dev/null
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:8080/health/ready \
  >/dev/null

echo 'Running a temporary staging API key authentication smoke test.'
cleanup_smoke_key
compose exec -T postgres psql \
  --username genchi \
  --dbname genchi \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO tenants (id, name, status) VALUES ('${smoke_tenant_id}', 'staging-deploy-smoke', 'active') ON CONFLICT DO NOTHING" \
  >>"$deployment_log" 2>&1
api_key="$(
  compose run --rm --no-deps gateway keys create \
    --tenant-id "$smoke_tenant_id" \
    --name staging-deploy-smoke \
    --environment staging \
    --models 'genchi/*' \
    --allow-streaming \
    2>>"$deployment_log"
)"
if [[ "$api_key" != gch_stg_* ]]; then
  echo 'The staging API key command returned an invalid credential.' >&2
  exit 1
fi
models_response="$(
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:8080/v1/models \
    --header "Authorization: Bearer ${api_key}"
)"
unset api_key
if ! jq -e '.object == "list" and any(.data[]; .id == "genchi/fast")' \
  >/dev/null <<<"$models_response"; then
  echo 'The authenticated staging model catalog response is invalid.' >&2
  exit 1
fi
unset models_response
cleanup_smoke_key

ln -sfn "$repository_root" "${GENCHI_DEPLOY_PATH}/current"
jq -n \
  --arg commit "$GENCHI_COMMIT_SHA" \
  --arg image_id "$image_id" \
  --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{commit: $commit, image_id: $image_id, deployed_at: $deployed_at}' \
  >"$deployment_record"
chmod 0640 "$deployment_record"

trap - ERR
trap - EXIT
echo "deployed_commit=${GENCHI_COMMIT_SHA}"
echo "image_id=${image_id}"
echo 'migration=ok'
echo 'health_live=ok'
echo 'health_ready=ok'
echo 'api_key_authentication=ok'
echo 'deployment=ok'
