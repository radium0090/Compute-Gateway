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

verification_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
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
memory_probe_pids=()
cleanup_smoke_key() {
  compose exec -T postgres psql \
    --username rcg \
    --dbname compute_gateway \
    --set ON_ERROR_STOP=1 \
    --command "DELETE FROM api_keys WHERE tenant_id = '${smoke_tenant_id}' AND name = 'staging-provider-smoke'" \
    >/dev/null 2>&1 || true
}
cleanup() {
  if [[ "${#memory_probe_pids[@]}" -gt 0 ]]; then
    kill "${memory_probe_pids[@]}" >/dev/null 2>&1 || true
    wait "${memory_probe_pids[@]}" >/dev/null 2>&1 || true
  fi
  cleanup_smoke_key
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

assert_ready() {
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:8080/health/ready \
    >/dev/null
}

provider_success_total() {
  awk '/^rcg_provider_attempts_total\{.*outcome="success"/ { total += $NF } END { printf "%.0f", total + 0 }' \
    "$1"
}

provider_failure_total() {
  awk '/^rcg_provider_attempts_total\{/ && $0 !~ /outcome="success"/ { total += $NF } END { printf "%.0f", total + 0 }' \
    "$1"
}

http_5xx_total() {
  awk '/^rcg_http_requests_total\{.*status_class="5xx"/ { total += $NF } END { printf "%.0f", total + 0 }' \
    "$1"
}

completion_latency_sample_total() {
  awk '/^rcg_http_request_duration_seconds_count\{route="\/v1\/chat\/completions"/ { total += $NF } END { printf "%.0f", total + 0 }' \
    "$1"
}

assert_ready
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:8080/metrics \
  --output "${temporary_root}/metrics"
grep -q '^rcg_build_info' "${temporary_root}/metrics"
provider_successes_before="$(provider_success_total "${temporary_root}/metrics")"
provider_failures_before="$(provider_failure_total "${temporary_root}/metrics")"
http_5xx_before="$(http_5xx_total "${temporary_root}/metrics")"
completion_latency_samples_before="$(
  completion_latency_sample_total "${temporary_root}/metrics"
)"

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
  # Keep the cross-provider probe to the common request subset. In particular,
  # reasoning-oriented OpenAI models can reject an explicit temperature.
  request_body="$(
    jq -cn \
      --arg model "$alias" \
      '{model: $model, messages: [{role: "user", content: "Reply with OK."}], max_tokens: 8}'
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
      '{model: $model, messages: [{role: "user", content: "Reply with OK."}], max_tokens: 8, stream: true}'
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

provider_metrics="${temporary_root}/provider-metrics"
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:8080/metrics \
  --output "$provider_metrics"
provider_successes=$((
  $(provider_success_total "$provider_metrics") - provider_successes_before
))
provider_failures=$((
  $(provider_failure_total "$provider_metrics") - provider_failures_before
))
http_5xx=$(($(http_5xx_total "$provider_metrics") - http_5xx_before))
completion_latency_samples=$((
  $(completion_latency_sample_total "$provider_metrics") - completion_latency_samples_before
))
inactive_requests="$(
  awk '/^rcg_active_requests\{/ && $0 !~ /route="\/metrics"/ { total += $NF } END { printf "%.0f", total + 0 }' \
    "$provider_metrics"
)"
if [[ "$provider_successes" -lt 6 || "$provider_failures" -ne 0 ]]; then
  echo 'Provider outcome metrics do not match the successful smoke calls.' >&2
  exit 1
fi
if [[ "$http_5xx" -ne 0 || "$completion_latency_samples" -lt 6 ]]; then
  echo 'HTTP error-rate or latency metrics do not match the provider smoke.' >&2
  exit 1
fi
if [[ "$inactive_requests" -ne 0 ]]; then
  echo 'Active requests did not return to zero after provider smoke.' >&2
  exit 1
fi
echo "provider_success_outcomes=${provider_successes}"
echo "provider_failure_outcomes=${provider_failures}"
echo "http_5xx_responses=${http_5xx}"
echo "completion_latency_samples=${completion_latency_samples}"
echo 'active_requests_after_provider_smoke=0'

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
memory_reference="${verification_root}/benchmarks/reference.json"
stream_memory_concurrency="$(jq -er '.stream_memory_concurrency' "$memory_reference")"
memory_per_stream_threshold_bytes="$(
  jq -er '.memory_per_stream_threshold_bytes' "$memory_reference"
)"
if [[ ! "$stream_memory_concurrency" =~ ^[1-9][0-9]*$ ]] ||
  [[ ! "$memory_per_stream_threshold_bytes" =~ ^[1-9][0-9]*$ ]]; then
  echo 'The stream-memory reference is invalid.' >&2
  exit 1
fi
gateway_pid="$(docker inspect --format '{{.State.Pid}}' "$gateway_container")"
gateway_memory_file="/proc/${gateway_pid}/root/sys/fs/cgroup/memory.current"
if [[ ! -r "$gateway_memory_file" ]]; then
  echo 'The gateway cgroup memory counter is unavailable.' >&2
  exit 1
fi
baseline_memory_bytes="$(<"$gateway_memory_file")"
memory_stream_body="$(
  jq -cn \
    '{model: "rax/fast", messages: [{role: "user", content: "Return a numbered list of two hundred short words."}], max_tokens: 256, stream: true}'
)"
for _ in $(seq 1 "$stream_memory_concurrency"); do
  curl --silent --show-error --no-buffer --limit-rate 1 --max-time 20 \
    http://127.0.0.1:8080/v1/chat/completions \
    --header "@${auth_header_file}" \
    --header 'Content-Type: application/json' \
    --data "$memory_stream_body" \
    --output /dev/null \
    >/dev/null 2>&1 &
  memory_probe_pids+=("$!")
done

observed_active_streams=0
for _ in $(seq 1 20); do
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:8080/metrics \
    --output "${temporary_root}/memory-metrics"
  observed_active_streams="$(
    awk '/^rcg_active_requests\{route="\/v1\/chat\/completions"/ { total += $NF } END { printf "%.0f", total + 0 }' \
      "${temporary_root}/memory-metrics"
  )"
  if [[ "$observed_active_streams" -ge "$stream_memory_concurrency" ]]; then
    break
  fi
  sleep 0.25
done
if [[ "$observed_active_streams" -lt "$stream_memory_concurrency" ]]; then
  echo 'The memory probe could not establish the reference stream concurrency.' >&2
  exit 1
fi

peak_memory_bytes="$baseline_memory_bytes"
for _ in $(seq 1 8); do
  current_memory_bytes="$(<"$gateway_memory_file")"
  if [[ "$current_memory_bytes" -gt "$peak_memory_bytes" ]]; then
    peak_memory_bytes="$current_memory_bytes"
  fi
  sleep 0.25
done
kill "${memory_probe_pids[@]}" >/dev/null 2>&1 || true
wait "${memory_probe_pids[@]}" >/dev/null 2>&1 || true
memory_probe_pids=()
memory_delta_bytes=$((peak_memory_bytes - baseline_memory_bytes))
if [[ "$memory_delta_bytes" -lt 0 ]]; then
  memory_delta_bytes=0
fi
memory_per_stream_bytes=$((
  (memory_delta_bytes + stream_memory_concurrency - 1) / stream_memory_concurrency
))
if [[ "$memory_per_stream_bytes" -gt "$memory_per_stream_threshold_bytes" ]]; then
  echo 'Memory per stream exceeds the accepted staging reference.' >&2
  exit 1
fi

active_after_memory_probe=-1
for _ in $(seq 1 20); do
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:8080/metrics \
    --output "${temporary_root}/memory-cleanup-metrics"
  active_after_memory_probe="$(
    awk '/^rcg_active_requests\{route="\/v1\/chat\/completions"/ { total += $NF } END { printf "%.0f", total + 0 }' \
      "${temporary_root}/memory-cleanup-metrics"
  )"
  if [[ "$active_after_memory_probe" -eq 0 ]]; then
    break
  fi
  sleep 0.25
done
if [[ "$active_after_memory_probe" -ne 0 ]]; then
  echo 'Active requests did not recover after the stream-memory probe.' >&2
  exit 1
fi
echo "stream_memory_concurrency=${stream_memory_concurrency}"
echo "memory_per_stream_bytes=${memory_per_stream_bytes}"
echo "memory_per_stream_threshold_bytes=${memory_per_stream_threshold_bytes}"
echo 'active_requests_after_memory_probe=0'

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
