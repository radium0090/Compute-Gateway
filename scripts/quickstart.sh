#!/usr/bin/env sh
set -eu

tenant_id='123e4567-e89b-42d3-a456-426614174000'

fail() {
  echo "Quickstart: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'Docker is required.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose is required.'
command -v curl >/dev/null 2>&1 || fail 'curl is required.'

umask 077
if [ ! -f .env ]; then
  cp .env.example .env
  echo 'Created .env from the development template.'
fi

read_env() {
  awk -F= -v wanted="$1" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' .env
}

replace_env() {
  key=$1
  value=$2
  temporary="$(mktemp "${TMPDIR:-/tmp}/rcg-quickstart.XXXXXX")"
  found=false
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*)
        printf '%s=%s\n' "$key" "$value" >>"$temporary"
        found=true
        ;;
      *) printf '%s\n' "$line" >>"$temporary" ;;
    esac
  done <.env
  if [ "$found" = false ]; then
    printf '%s=%s\n' "$key" "$value" >>"$temporary"
  fi
  mv "$temporary" .env
}

random_secret() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_generated_secret() {
  key=$1
  current="$(read_env "$key")"
  case "$current" in
    '' | fake-*) replace_env "$key" "$(random_secret)" ;;
  esac
}

ensure_generated_secret RCG_MASTER_KEY
ensure_generated_secret RCG_KEY_HASH_PEPPER
ensure_generated_secret RCG_ADMIN_SESSION_PEPPER

provider_key="${OPENAI_API_KEY:-$(read_env OPENAI_API_KEY)}"
case "$provider_key" in
  '' | fake-*)
    if [ ! -r /dev/tty ]; then
      fail 'Set OPENAI_API_KEY or update .env before running non-interactively.'
    fi
    printf 'OpenAI API key (input hidden; stored only in local .env): ' >/dev/tty
    stty -echo </dev/tty
    trap 'stty echo </dev/tty 2>/dev/null || true' EXIT INT TERM
    IFS= read -r provider_key </dev/tty
    stty echo </dev/tty
    trap - EXIT INT TERM
    printf '\n' >/dev/tty
    ;;
esac
[ -n "$provider_key" ] || fail 'The OpenAI API key must not be empty.'
replace_env OPENAI_API_KEY "$provider_key"
unset provider_key

echo 'Building and starting PostgreSQL, Redis, telemetry, and the gateway...'
docker compose up --build --wait

docker compose exec -T postgres psql \
  --username rcg \
  --dbname compute_gateway \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO tenants (id, name, status) VALUES ('${tenant_id}', 'local-quickstart', 'active') ON CONFLICT DO NOTHING" \
  >/dev/null

api_key="$(docker compose run --rm --no-deps gateway keys create \
  --tenant-id "$tenant_id" \
  --name local-quickstart \
  --environment dev \
  --models rax/fast \
  --requests-per-minute 30 \
  --max-concurrent-requests 2 \
  --max-request-tokens 4096 \
  --max-output-tokens 256)"
case "$api_key" in
  rcg_dev_*) ;;
  *) fail 'The gateway did not return a development API key.' ;;
esac

http_port="$(read_env RCG_COMPOSE_HTTP_PORT)"
http_port="${http_port:-8080}"
echo 'Gateway is ready. Sending the first chat request...'
curl --fail-with-body --silent --show-error \
  "http://127.0.0.1:${http_port}/v1/chat/completions" \
  --header "Authorization: Bearer ${api_key}" \
  --header 'Content-Type: application/json' \
  --data '{"model":"rax/fast","messages":[{"role":"user","content":"Reply with one short hello from RAX Compute Gateway."}],"max_tokens":64}'
printf '\n\nQuickstart complete. Local API key (shown once):\n%s\n' "$api_key"
printf 'Stop the stack with: docker compose down\n'
