#!/usr/bin/env sh
set -eu

project="${GENCHI_SMOKE_PROJECT:-genchi-fresh-clone-smoke}"
case "$project" in
  '' | *[!a-z0-9_.-]* | [!a-z0-9]*)
    echo 'GENCHI_SMOKE_PROJECT must be a valid lowercase Compose project name' >&2
    exit 1
    ;;
esac

export GENCHI_COMPOSE_HTTP_PORT="${GENCHI_SMOKE_HTTP_PORT:-18080}"
export GENCHI_COMPOSE_POSTGRES_PORT="${GENCHI_SMOKE_POSTGRES_PORT:-15432}"
export GENCHI_COMPOSE_REDIS_PORT="${GENCHI_SMOKE_REDIS_PORT:-16379}"

compose() {
  docker compose -p "$project" "$@"
}

remove_stack() {
  # The dedicated project name keeps cleanup away from a developer's normal
  # Genchi stack and volumes.
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}

on_exit() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    compose ps >&2 || true
    compose logs --no-color >&2 || true
  fi
  remove_stack
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -f .env ]; then
  echo 'Compose smoke requires .env; run: cp .env.example .env' >&2
  exit 1
fi

remove_stack
if [ "${GENCHI_SMOKE_NO_BUILD:-false}" = 'true' ]; then
  compose up --no-build --wait
else
  compose up --build --wait
fi

compose exec -T postgres psql \
  --username genchi \
  --dbname genchi \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO tenants (id, name, status) VALUES ('123e4567-e89b-42d3-a456-426614174000', 'compose-smoke', 'active') ON CONFLICT DO NOTHING" \
  >/dev/null

api_key="$(compose run --rm --no-deps gateway keys create \
  --tenant-id 123e4567-e89b-42d3-a456-426614174000 \
  --name compose-smoke \
  --environment dev \
  --models 'genchi/*' \
  --allow-streaming)"

case "$api_key" in
  gch_dev_*) ;;
  *)
    echo 'Compose smoke did not receive a development client key' >&2
    exit 1
    ;;
esac

models="$(curl --fail-with-body --silent --show-error \
  "http://127.0.0.1:${GENCHI_COMPOSE_HTTP_PORT}/v1/models" \
  --header "Authorization: Bearer ${api_key}")"

case "$models" in
  *'"object":"list"'*'"genchi/fast"'*) ;;
  *)
    echo 'Compose smoke received an invalid model catalog' >&2
    exit 1
    ;;
esac

echo 'Compose fresh-clone smoke passed'
