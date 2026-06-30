#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$CODEX_HOME" /app/runtime

bridge_pid=""
app_pid=""

shutdown() {
  trap - TERM INT
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "$bridge_pid" ]] && kill -0 "$bridge_pid" 2>/dev/null; then
    kill -TERM "$bridge_pid" 2>/dev/null || true
  fi
  if [[ -n "$app_pid" ]]; then
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "$bridge_pid" ]]; then
    wait "$bridge_pid" 2>/dev/null || true
  fi
}

trap 'shutdown; exit 143' TERM INT

if [[ ! -r "$CODEX_HOME/config.toml" ]]; then
  echo "[entrypoint] Codex config is not readable: $CODEX_HOME/config.toml" >&2
  exit 1
fi

if [[ ! -r "$CODEX_HOME/auth.json" ]]; then
  echo "[entrypoint] Codex auth is not readable: $CODEX_HOME/auth.json" >&2
  exit 1
fi

if [[ -z "${AGENT_INSPECT_SKILL:-}" ]]; then
  echo "[entrypoint] AGENT_INSPECT_SKILL is required" >&2
  exit 1
fi

if [[ -z "${CODEX_SKILL_ROOT:-}" ]]; then
  echo "[entrypoint] CODEX_SKILL_ROOT is required" >&2
  exit 1
fi

if [[ ! -r "$CODEX_SKILL_ROOT/SKILL.md" ]]; then
  echo "[entrypoint] Codex skill is not readable: $CODEX_SKILL_ROOT/SKILL.md" >&2
  exit 1
fi

if [[ "${AIPROXY_BRIDGE_ENABLED:-true}" == "true" ]]; then
  if [[ ! -r "${AIPROXY_BRIDGE_BIN:-}" ]]; then
    echo "[entrypoint] bridge script is not readable: ${AIPROXY_BRIDGE_BIN:-}" >&2
    exit 1
  fi

  node "$AIPROXY_BRIDGE_BIN" &
  bridge_pid="$!"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://${AIPROXY_BRIDGE_HOST:-127.0.0.1}:${AIPROXY_BRIDGE_PORT:-18087}/health" >/dev/null; then
      break
    fi
    sleep 0.5
  done

  if ! curl -fsS "http://${AIPROXY_BRIDGE_HOST:-127.0.0.1}:${AIPROXY_BRIDGE_PORT:-18087}/health" >/dev/null; then
    echo "[entrypoint] bridge did not become healthy" >&2
    shutdown
    exit 1
  fi
fi

"$@" &
app_pid="$!"

if [[ -n "$bridge_pid" ]]; then
  wait -n "$app_pid" "$bridge_pid"
  exit_code="$?"
  if ! kill -0 "$bridge_pid" 2>/dev/null; then
    echo "[entrypoint] bridge exited; stopping app so Kubernetes restarts the container" >&2
  fi
  shutdown
  exit "$exit_code"
fi

wait "$app_pid"
