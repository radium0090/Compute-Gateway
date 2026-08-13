#!/usr/bin/env bash
set -Eeuo pipefail

required_environment=(
  AWS_REGION
  RCG_BACKUP_BUCKET
  RCG_DEPLOY_PATH
  RCG_EC2_INSTANCE_ID
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required restore verification variable: ${name}" >&2
    exit 1
  fi
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'The restore verification must run as root.' >&2
  exit 1
fi

repository_root="${RCG_RELEASE_ROOT:-${RCG_DEPLOY_PATH}/current}"
runtime_environment="${RCG_DEPLOY_PATH}/shared/production.env"
verification_root="${RCG_DEPLOY_PATH}/restore-verification"
manifest_file="${verification_root}/latest.json"
dump_file="${verification_root}/latest.dump"
database_name="rcg_restore_verify_$(date -u +%Y%m%d%H%M%S)"

install -d -m 0700 "$verification_root"
umask 077

compose() {
  docker compose \
    --project-directory "$repository_root" \
    --env-file "$runtime_environment" \
    --file "${repository_root}/docker-compose.yml" \
    --file "${repository_root}/deploy/compose/production.yaml" \
    "$@"
}

cleanup() {
  compose exec -T postgres dropdb \
    --username rcg --if-exists --force "$database_name" \
    >/dev/null 2>&1 || true
  rm -f -- "$manifest_file" "$dump_file"
}
trap cleanup EXIT

aws s3api get-object \
  --region "$AWS_REGION" \
  --bucket "$RCG_BACKUP_BUCKET" \
  --key production/latest.json \
  "$manifest_file" \
  >/dev/null

if ! jq -e '
  .version == 1
    and .database == "compute_gateway"
    and (.key | type == "string" and startswith("production/"))
    and (.sha256 | test("^[a-f0-9]{64}$"))
    and (.bytes | type == "number" and . > 0)
' "$manifest_file" >/dev/null; then
  echo 'The latest backup manifest is invalid.' >&2
  exit 1
fi

object_key="$(jq -r '.key' "$manifest_file")"
expected_sha256="$(jq -r '.sha256' "$manifest_file")"
aws s3api get-object \
  --region "$AWS_REGION" \
  --bucket "$RCG_BACKUP_BUCKET" \
  --key "$object_key" \
  "$dump_file" \
  >/dev/null
actual_sha256="$(sha256sum "$dump_file" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo 'The downloaded backup checksum does not match its manifest.' >&2
  exit 1
fi

compose exec -T postgres createdb --username rcg "$database_name"
compose exec -T postgres pg_restore \
  --username rcg \
  --dbname "$database_name" \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  <"$dump_file" \
  >/dev/null

schema_check="$(
  compose exec -T postgres psql \
    --username rcg \
    --dbname "$database_name" \
    --tuples-only \
    --no-align \
    --command "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('tenants', 'api_keys', 'schema_migrations')"
)"
if [[ "$schema_check" != 3 ]]; then
  echo 'The restored database is missing required schema objects.' >&2
  exit 1
fi

aws cloudwatch put-metric-data \
  --region "$AWS_REGION" \
  --namespace RAX/ComputeGateway \
  --metric-name ProductionRestoreVerificationSuccess \
  --dimensions "InstanceId=${RCG_EC2_INSTANCE_ID}" \
  --value 1 \
  --unit Count

echo "verified_backup_key=${object_key}"
echo 'production_restore_verification=ok'
