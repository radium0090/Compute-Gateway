#!/usr/bin/env sh
set -eu

: "${GENCHI_API_KEY:?Set GENCHI_API_KEY to a Genchi client key}"
GENCHI_BASE_URL="${GENCHI_BASE_URL:-http://localhost:8080/v1}"

curl --fail-with-body --silent --show-error \
  "${GENCHI_BASE_URL%/}/chat/completions" \
  --header "Authorization: Bearer ${GENCHI_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "genchi/fast",
    "messages": [{"role": "user", "content": "Hello from curl"}]
  }'
printf '\n'
