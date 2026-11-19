#!/usr/bin/env bash
set -Eeuo pipefail

required_environment=(RCG_API_HOST RCG_SITE_HOST)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing XServer verification variable: ${name}" >&2
    exit 1
  fi
done

for host in "$RCG_API_HOST" "$RCG_SITE_HOST"; do
  if [[ ! "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    echo 'XServer verification hosts must be normalized DNS names.' >&2
    exit 1
  fi
done
if ! command -v curl >/dev/null 2>&1; then
  echo 'curl is required for XServer production verification.' >&2
  exit 1
fi

verification_directory="$(mktemp -d)"
cleanup_verification() {
  rm -r -- "$verification_directory"
}
trap cleanup_verification EXIT

response_headers=''
response_body=''
fetch() {
  local label="$1"
  local url="$2"
  local expected_status="$3"
  local safe_label="${label//[^a-zA-Z0-9_-]/_}"
  response_headers="${verification_directory}/${safe_label}.headers"
  response_body="${verification_directory}/${safe_label}.body"
  local actual_status
  actual_status="$(
    curl --silent --show-error \
      --max-time 20 \
      --retry 2 \
      --retry-delay 1 \
      --dump-header "$response_headers" \
      --output "$response_body" \
      --write-out '%{http_code}' \
      "$url"
  )"
  if [[ "$actual_status" != "$expected_status" ]]; then
    echo "${label} returned HTTP ${actual_status}; expected ${expected_status}." >&2
    exit 1
  fi
}

require_body_text() {
  local label="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$response_body"; then
    echo "${label} response did not contain the expected marker." >&2
    exit 1
  fi
}

require_header() {
  local label="$1"
  local header_pattern="$2"
  if ! grep -Eiq -- "$header_pattern" "$response_headers"; then
    echo "${label} response is missing a required security header." >&2
    exit 1
  fi
}

site_origin="https://${RCG_SITE_HOST}"
api_origin="https://${RCG_API_HOST}"

fetch product_site "${site_origin}/" 200
require_body_text product_site 'One stable API.'
require_header product_site '^strict-transport-security:[[:space:]]*max-age=31536000'
require_header product_site '^x-content-type-options:[[:space:]]*nosniff'
require_header product_site '^content-security-policy:'

fetch customer_console "${site_origin}/console/login" 200
require_body_text customer_console 'Customer Console'
require_header customer_console '^cache-control:[[:space:]]*no-store'
require_header customer_console '^content-security-policy:'

fetch privacy_notice "${site_origin}/legal/privacy" 200
require_body_text privacy_notice 'Privacy notice'
fetch service_notice "${site_origin}/legal/service" 200
require_body_text service_notice 'Service notice'

fetch liveness "${api_origin}/health/live" 200
require_body_text liveness '"status":"ok"'
fetch readiness "${api_origin}/health/ready" 200
require_body_text readiness '"status":"ready"'

fetch hidden_metrics "${api_origin}/metrics" 404
fetch unknown_site_path "${site_origin}/this-path-must-not-exist" 404

echo "api_host=${RCG_API_HOST}"
echo "site_host=${RCG_SITE_HOST}"
echo 'xserver_public_verification=ok'
