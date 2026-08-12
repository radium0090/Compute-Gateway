#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -z "${RCG_DEPLOY_PATH:-}" ]]; then
  echo 'RCG_DEPLOY_PATH is required.' >&2
  exit 1
fi
if [[ ! "$RCG_DEPLOY_PATH" =~ ^/opt/[a-z0-9][a-z0-9._/-]*$ ]]; then
  echo 'RCG_DEPLOY_PATH must be a normalized path below /opt.' >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo 'The staging verification script must run as root through SSM.' >&2
  exit 1
fi

runtime_root="$(readlink -f "${RCG_DEPLOY_PATH}/current")"
runtime_environment="${RCG_DEPLOY_PATH}/shared/staging.env"
if [[ ! -f "${runtime_root}/docker-compose.yml" ]]; then
  echo 'No validated staging release is active.' >&2
  exit 1
fi
if [[ ! -f "$runtime_environment" ]]; then
  echo 'The staging runtime environment is unavailable.' >&2
  exit 1
fi

compose() {
  docker compose \
    --project-directory "$runtime_root" \
    --env-file "$runtime_environment" \
    --file "${runtime_root}/docker-compose.yml" \
    "$@"
}

temporary_root="$(mktemp -d)"
smoke_tenant_id='123e4567-e89b-42d3-a456-426614174002'
cleanup_smoke_key() {
  compose exec -T postgres psql \
    --username rcg \
    --dbname compute_gateway \
    --set ON_ERROR_STOP=1 \
    --command "DELETE FROM api_keys WHERE tenant_id = '${smoke_tenant_id}' AND name = 'staging-provider-smoke'" \
    >/dev/null 2>&1 || true
}
cleanup() {
  cleanup_smoke_key
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

assert_ready() {
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:8080/health/ready \
    >/dev/null
}

assert_ready
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:8080/metrics \
  --output "${temporary_root}/metrics"
grep -q '^rcg_build_info' "${temporary_root}/metrics"

cleanup_smoke_key
compose exec -T postgres psql \
  --username rcg \
  --dbname compute_gateway \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO tenants (id, name, status) VALUES ('${smoke_tenant_id}', 'staging-provider-smoke', 'active') ON CONFLICT DO NOTHING" \
  >/dev/null
api_key="$(
  compose run --rm --no-deps gateway keys create \
    --tenant-id "$smoke_tenant_id" \
    --name staging-provider-smoke \
    --environment staging \
    --models 'rax/*' \
    --requests-per-minute 30 \
    --max-concurrent-requests 4 \
    --max-output-tokens 1024 \
    --allow-streaming \
    2>/dev/null
)"
if [[ "$api_key" != rcg_stg_* ]]; then
  echo 'The provider verification key has an invalid format.' >&2
  exit 1
fi
auth_header_file="${temporary_root}/authorization-header"
printf 'Authorization: Bearer %s\n' "$api_key" >"$auth_header_file"
chmod 0600 "$auth_header_file"

aliases=(rax/fast rax/anthropic rax/gemini)
for alias in "${aliases[@]}"; do
  safe_name="${alias#rax/}"
  response_file="${temporary_root}/${safe_name}.json"
  request_body="$(
    jq -cn \
      --arg model "$alias" \
      '{model: $model, messages: [{role: "user", content: "Reply with OK."}], max_tokens: 8, temperature: 0}'
  )"
  if ! http_code="$(
    curl --silent --show-error --max-time 90 \
      http://127.0.0.1:8080/v1/chat/completions \
      --header "@${auth_header_file}" \
      --header 'Content-Type: application/json' \
      --data "$request_body" \
      --output "$response_file" \
      --write-out '%{http_code}'
  )"; then
    echo "Provider transport failed for ${alias}." >&2
    exit 1
  fi
  if [[ "$http_code" != 200 ]]; then
    echo "Provider returned HTTP ${http_code} for ${alias}." >&2
    exit 1
  fi
  if ! jq -e '
    .object == "chat.completion"
      and (.choices | length > 0)
      and (.choices[0].message.content | type == "string")
  ' >/dev/null <"$response_file"; then
    echo "Provider returned an invalid completion envelope for ${alias}." >&2
    exit 1
  fi
  echo "provider_non_streaming_${safe_name}=ok"

  stream_file="${temporary_root}/${safe_name}.sse"
  stream_body="$(
    jq -cn \
      --arg model "$alias" \
      '{model: $model, messages: [{role: "user", content: "Reply with OK."}], max_tokens: 8, temperature: 0, stream: true}'
  )"
  if ! stream_code="$(
    curl --silent --show-error --no-buffer --max-time 90 \
      http://127.0.0.1:8080/v1/chat/completions \
      --header "@${auth_header_file}" \
      --header 'Content-Type: application/json' \
      --data "$stream_body" \
      --output "$stream_file" \
      --write-out '%{http_code}'
  )"; then
    echo "Provider streaming transport failed for ${alias}." >&2
    exit 1
  fi
  if [[ "$stream_code" != 200 ]] || ! grep -q '^data: \[DONE\]' "$stream_file"; then
    echo "Provider returned an invalid streaming response for ${alias}." >&2
    exit 1
  fi
  echo "provider_streaming_${safe_name}=ok"
done

disconnect_body="$(
  jq -cn \
    '{model: "rax/fast", messages: [{role: "user", content: "Reply with several words."}], max_tokens: 32, stream: true}'
)"
set +e
curl --silent --show-error --no-buffer --limit-rate 1 --max-time 2 \
  http://127.0.0.1:8080/v1/chat/completions \
  --header "@${auth_header_file}" \
  --header 'Content-Type: application/json' \
  --data "$disconnect_body" \
  --output "${temporary_root}/disconnect.sse"
disconnect_status=$?
set -e
if [[ "$disconnect_status" -ne 28 ]]; then
  echo "The client-disconnect probe did not time out as expected (status=${disconnect_status})." >&2
  exit 1
fi
sleep 2
assert_ready
echo 'client_disconnect_recovery=ok'

gateway_container="$(compose ps --quiet gateway)"
if [[ -z "$gateway_container" ]]; then
  echo 'The running gateway container could not be identified.' >&2
  exit 1
fi
docker kill --signal TERM "$gateway_container" >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$gateway_container")" == false ]]; then
    break
  fi
  sleep 1
done
if [[ "$(docker inspect --format '{{.State.Running}}' "$gateway_container")" != false ]]; then
  echo 'The gateway did not stop within the shutdown grace period.' >&2
  exit 1
fi
compose up --detach --wait --wait-timeout 180 gateway >/dev/null
assert_ready
echo 'graceful_shutdown_recovery=ok'

curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:8080/v1/models \
  --header "@${auth_header_file}" \
  --output "${temporary_root}/models-after-restart.json"
if ! jq -e '.object == "list" and any(.data[]; .id == "rax/fast")' \
  >/dev/null <"${temporary_root}/models-after-restart.json"; then
  echo 'API Key authentication failed after gateway restart.' >&2
  exit 1
fi
unset api_key
cleanup_smoke_key

echo 'post_restart_authentication=ok'
echo 'staging_verification=ok'
