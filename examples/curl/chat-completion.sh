#!/usr/bin/env sh
set -eu

: "${RCG_API_KEY:?Set RCG_API_KEY to a RAX Compute Gateway client key}"
RCG_BASE_URL="${RCG_BASE_URL:-http://localhost:8080/v1}"

curl --fail-with-body --silent --show-error \
  "${RCG_BASE_URL%/}/chat/completions" \
  --header "Authorization: Bearer ${RCG_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "rax/fast",
    "messages": [{"role": "user", "content": "Hello from curl"}]
  }'
printf '\n'
