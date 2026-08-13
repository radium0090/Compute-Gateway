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

metric_data="$(
  jq -cn \
    --arg instance "$RCG_EC2_INSTANCE_ID" \
    --argjson disk "$disk_usage_percent" \
    --argjson ready "$service_ready" \
    '[
      {MetricName:"ProductionDiskUsagePercent",Dimensions:[{Name:"InstanceId",Value:$instance}],Value:$disk,Unit:"Percent"},
      {MetricName:"ProductionServiceReady",Dimensions:[{Name:"InstanceId",Value:$instance}],Value:$ready,Unit:"Count"}
    ]'
)"
aws cloudwatch put-metric-data \
  --region "$AWS_REGION" \
  --namespace RAX/ComputeGateway \
  --metric-data "$metric_data"

echo "disk_usage_percent=${disk_usage_percent}"
echo "service_ready=${service_ready}"
echo 'production_monitoring=ok'
