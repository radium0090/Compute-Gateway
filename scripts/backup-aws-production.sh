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
    echo "Missing required backup variable: ${name}" >&2
    exit 1
  fi
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'The production backup must run as root.' >&2
  exit 1
fi
if [[ ! "$RCG_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo 'RCG_BACKUP_BUCKET is not a valid S3 bucket name.' >&2
  exit 1
fi

repository_root="${RCG_RELEASE_ROOT:-${RCG_DEPLOY_PATH}/current}"
runtime_environment="${RCG_DEPLOY_PATH}/shared/production.env"
backup_root="${RCG_DEPLOY_PATH}/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
date_prefix="$(date -u +%Y/%m/%d)"
object_key="production/${date_prefix}/compute_gateway-${timestamp}.dump"
manifest_key="production/manifests/compute_gateway-${timestamp}.json"
latest_key='production/latest.json'
dump_file="${backup_root}/compute_gateway-${timestamp}.dump"
manifest_file="${backup_root}/compute_gateway-${timestamp}.json"

install -d -m 0700 "$backup_root"
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
  rm -f -- "$dump_file" "$manifest_file"
}
trap cleanup EXIT

compose exec -T postgres pg_dump \
  --username rcg \
  --dbname compute_gateway \
  --format custom \
  --compress 9 \
  --no-owner \
  --no-privileges \
  >"$dump_file"

compose exec -T postgres pg_restore --list <"$dump_file" >/dev/null
dump_sha256="$(sha256sum "$dump_file" | awk '{print $1}')"
dump_bytes="$(stat --format='%s' "$dump_file")"

jq -n \
  --arg bucket "$RCG_BACKUP_BUCKET" \
  --arg key "$object_key" \
  --arg sha256 "$dump_sha256" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson bytes "$dump_bytes" \
  '{version: 1, database: "compute_gateway", bucket: $bucket, key: $key, sha256: $sha256, bytes: $bytes, created_at: $created_at, format: "pg_dump-custom"}' \
  >"$manifest_file"

aws s3api put-object \
  --region "$AWS_REGION" \
  --bucket "$RCG_BACKUP_BUCKET" \
  --key "$object_key" \
  --body "$dump_file" \
  --server-side-encryption AES256 \
  --checksum-algorithm SHA256 \
  >/dev/null
aws s3api put-object \
  --region "$AWS_REGION" \
  --bucket "$RCG_BACKUP_BUCKET" \
  --key "$manifest_key" \
  --body "$manifest_file" \
  --content-type application/json \
  --server-side-encryption AES256 \
  >/dev/null
aws s3api put-object \
  --region "$AWS_REGION" \
  --bucket "$RCG_BACKUP_BUCKET" \
  --key "$latest_key" \
  --body "$manifest_file" \
  --content-type application/json \
  --server-side-encryption AES256 \
  >/dev/null

aws cloudwatch put-metric-data \
  --region "$AWS_REGION" \
  --namespace RAX/ComputeGateway \
  --metric-name ProductionBackupSuccess \
  --dimensions "InstanceId=${RCG_EC2_INSTANCE_ID}" \
  --value 1 \
  --unit Count

echo "backup_key=${object_key}"
echo "backup_bytes=${dump_bytes}"
echo 'production_backup=ok'
