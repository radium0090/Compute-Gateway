#!/usr/bin/env bash
set -Eeuo pipefail

required_environment=(
  RCG_COMMIT_SHA
  RCG_DEPLOY_PATH
  RCG_API_HOST
  RCG_SITE_HOST
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing XServer deployment variable: ${name}" >&2
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
for host in "$RCG_API_HOST" "$RCG_SITE_HOST"; do
  if [[ ! "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    echo 'XServer public hosts must be normalized DNS names.' >&2
    exit 1
  fi
done

for command in curl docker; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required XServer command is unavailable: ${command}" >&2
    exit 1
  fi
done

release_root="${RCG_DEPLOY_PATH}/releases/${RCG_COMMIT_SHA}"
shared_root="${RCG_DEPLOY_PATH}/shared"
runtime_environment="${shared_root}/production.env"
deployment_record="${shared_root}/production-deployment.env"
release_environment="${release_root}/.deployment.env"
if [[ ! -f "${release_root}/docker-compose.yml" ]]; then
  echo 'The uploaded release is incomplete.' >&2
  exit 1
fi
if [[ ! -f "$runtime_environment" ]]; then
  echo "Create ${runtime_environment} before the first deployment." >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$runtime_environment")" != 600 ]]; then
  echo 'The production environment file must have mode 0600.' >&2
  exit 1
fi

ln -sfn "$runtime_environment" "${release_root}/.env"
if [[ -n "${RCG_IMAGE_REF:-}" ]]; then
  if [[ ! "$RCG_IMAGE_REF" =~ ^ghcr\.io/radium0090/compute-gateway:v[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$ ]]; then
    echo 'RCG_IMAGE_REF must be an immutable RAX release reference.' >&2
    exit 1
  fi
  selected_image="$RCG_IMAGE_REF"
else
  selected_image="rax-compute-gateway:${RCG_COMMIT_SHA}"
fi
umask 077
printf 'RCG_IMAGE=%s\n' "$selected_image" >"$release_environment"

compose() {
  docker compose \
    --project-directory "$release_root" \
    --env-file "$runtime_environment" \
    --env-file "$release_environment" \
    --file "${release_root}/docker-compose.yml" \
    --file "${release_root}/deploy/xserver/compose.yaml" \
    "$@"
}

previous_release=''
if [[ -L "${RCG_DEPLOY_PATH}/current" ]]; then
  previous_release="$(readlink -f "${RCG_DEPLOY_PATH}/current")"
fi

rollback_on_error() {
  status=$?
  trap - ERR
  previous_release_environment="${previous_release}/.deployment.env"
  if [[ -n "$previous_release" && -f "${previous_release}/docker-compose.yml" && -f "$previous_release_environment" ]]; then
    docker compose \
      --project-directory "$previous_release" \
      --env-file "$runtime_environment" \
      --env-file "$previous_release_environment" \
      --file "${previous_release}/docker-compose.yml" \
      --file "${previous_release}/deploy/xserver/compose.yaml" \
      up --detach --wait --wait-timeout 240 || true
  fi
  compose logs --tail 120 gateway caddy >&2 || true
  exit "$status"
}
trap rollback_on_error ERR

compose config --quiet
if [[ -n "${RCG_IMAGE_REF:-}" ]]; then
  compose pull gateway
else
  compose build --pull gateway
fi

compose run --rm --no-deps gateway --check-config
compose up --detach --wait --wait-timeout 300

for host in "$RCG_API_HOST" "$RCG_SITE_HOST"; do
  ready=false
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 10 \
      --resolve "${host}:443:127.0.0.1" "https://${host}/" >/dev/null; then
      ready=true
      break
    fi
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    echo "HTTPS did not become ready for ${host}." >&2
    exit 1
  fi
done
curl --fail --silent --show-error --max-time 10 \
  --resolve "${RCG_API_HOST}:443:127.0.0.1" \
  "https://${RCG_API_HOST}/health/ready" >/dev/null

ln -sfn "$release_root" "${RCG_DEPLOY_PATH}/current"
umask 077
{
  echo "RCG_COMMIT_SHA=${RCG_COMMIT_SHA}"
  echo "RCG_API_HOST=${RCG_API_HOST}"
  echo "RCG_SITE_HOST=${RCG_SITE_HOST}"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$deployment_record"

trap - ERR
echo "deployed_commit=${RCG_COMMIT_SHA}"
echo "api_host=${RCG_API_HOST}"
echo "site_host=${RCG_SITE_HOST}"
echo 'health_ready=ok'
echo 'xserver_deployment=ok'
