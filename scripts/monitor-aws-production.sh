#!/usr/bin/env bash
set -Eeuo pipefail

required_environment=(
  AWS_REGION
  RCG_DEPLOY_PATH
  RCG_EC2_INSTANCE_ID
  RCG_PUBLIC_HOST
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required monitoring variable: ${name}" >&2
    exit 1
  fi
done

disk_usage_percent="$(df --portability /var/lib/docker | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if [[ ! "$disk_usage_percent" =~ ^[0-9]+$ ]]; then
  echo 'Unable to determine Docker disk usage.' >&2
  exit 1
fi

service_ready=0
if curl --fail --silent --show-error --max-time 10 \
  --resolve "${RCG_PUBLIC_HOST}:443:127.0.0.1" \
  "https://${RCG_PUBLIC_HOST}/health/ready" \
  >/dev/null; then
  service_ready=1
fi

# The restore job runs weekly, while this monitor runs every five minutes. A
# continuously reported age metric avoids the delayed/false alarms produced by
# treating a sparse weekly success event as a daily heartbeat.
restore_success_marker="${RCG_DEPLOY_PATH}/shared/restore-verification-success.epoch"
restore_verification_age_seconds=999999999
if [[ -f "$restore_success_marker" ]]; then
  restore_success_epoch="$(<"$restore_success_marker")"
  current_epoch="$(date -u +%s)"
  if [[ "$restore_success_epoch" =~ ^[0-9]+$ ]] &&
    ((restore_success_epoch <= current_epoch)); then
    restore_verification_age_seconds=$((current_epoch - restore_success_epoch))
  fi
fi

metric_data="$(
  jq -cn \
    --arg instance "$RCG_EC2_INSTANCE_ID" \
    --argjson disk "$disk_usage_percent" \
    --argjson ready "$service_ready" \
    --argjson restoreAge "$restore_verification_age_seconds" \
    '[
      {MetricName:"ProductionDiskUsagePercent",Dimensions:[{Name:"InstanceId",Value:$instance}],Value:$disk,Unit:"Percent"},
      {MetricName:"ProductionServiceReady",Dimensions:[{Name:"InstanceId",Value:$instance}],Value:$ready,Unit:"Count"},
      {MetricName:"ProductionRestoreVerificationAgeSeconds",Dimensions:[{Name:"InstanceId",Value:$instance}],Value:$restoreAge,Unit:"Seconds"}
    ]'
)"
aws cloudwatch put-metric-data \
  --region "$AWS_REGION" \
  --namespace RAX/ComputeGateway \
  --metric-data "$metric_data"

echo "disk_usage_percent=${disk_usage_percent}"
echo "service_ready=${service_ready}"
echo "restore_verification_age_seconds=${restore_verification_age_seconds}"
echo 'production_monitoring=ok'
