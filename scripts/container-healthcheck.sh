#!/usr/bin/env bash
set -euo pipefail

curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null

if [[ "${AIPROXY_BRIDGE_ENABLED:-true}" == "true" ]]; then
  curl -fsS "http://${AIPROXY_BRIDGE_HOST:-127.0.0.1}:${AIPROXY_BRIDGE_PORT:-18087}/health" >/dev/null
fi
