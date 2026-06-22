#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_SOURCE="${SCRIPT_DIR}/codex-status-menu.swift"
BIN_DIR="${SCRIPT_DIR}/.build"
BIN_PATH="${BIN_DIR}/codex-status-menu"

APP_SUPPORT_DIR="${HOME}/Library/Application Support/weixue-codex-bridge"
STATE_DIR="${APP_SUPPORT_DIR}/state"
STATE_FILE="${STATE_DIR}/codex-status-menu-state.json"
CONFIG_DIR="${APP_SUPPORT_DIR}/config"
CONFIG_FILE="${CONFIG_DIR}/codex-status-menu-config.json"
LOG_DIR="${APP_SUPPORT_DIR}/logs"
LOG_OUT_PATH="${LOG_DIR}/bridge.out.log"
LOG_ERR_PATH="${LOG_DIR}/bridge.log"
MAX_LOG_BYTES="${CODEX_MAX_LOG_BYTES:-5242880}"
LOG_CLEANUP_INTERVAL_SECONDS="${CODEX_LOG_CLEANUP_INTERVAL_SECONDS:-300}"
CODEX_TRANSPORT="${CODEX_TRANSPORT:-}"
CODEX_BLE_DEVICE_ID="${CODEX_BLE_DEVICE_ID:-}"
CODEX_BLE_NAME="${CODEX_BLE_NAME:-CodexStatusDisplay}"
CODEX_BLE_SERVICE_UUID="${CODEX_BLE_SERVICE_UUID:-6e400001-b5a3-f393-e0a9-e50e24dcca9e}"
CODEX_BLE_WRITE_CHAR_UUID="${CODEX_BLE_WRITE_CHAR_UUID:-6e400002-b5a3-f393-e0a9-e50e24dcca9e}"

mkdir -p "${BIN_DIR}" "${STATE_DIR}" "${LOG_DIR}" "${CONFIG_DIR}"

normalize_interval_ms() {
  local interval_ms="${1:-15000}"
  if ! [[ "${interval_ms}" =~ ^[0-9]+$ ]]; then
    echo 15000
    return 0
  fi

  if (( interval_ms < 5000 )); then
    echo 5000
    return 0
  fi
  if (( interval_ms > 60000 )); then
    echo 60000
    return 0
  fi

  local remainder=$(( interval_ms % 5000 ))
  if (( remainder == 0 )); then
    echo "${interval_ms}"
    return 0
  fi

  local rounded=$(( (interval_ms + 2500) / 5000 * 5000 ))
  if (( rounded > 60000 )); then
    echo 60000
    return 0
  fi
  echo "${rounded}"
}

read_interval_from_config() {
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    return 1
  fi

  local interval
  interval="$(sed -n 's/.*"intervalMs"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${CONFIG_FILE}" | head -n 1 | tr -d '[:space:]')"
  if [[ -n "${interval}" && "${interval}" =~ ^[0-9]+$ ]]; then
    echo "${interval}"
    return 0
  fi
  return 1
}

base_interval="${CODEX_INTERVAL_MS:-15000}"
if config_interval="$(read_interval_from_config)"; then
  base_interval="${config_interval}"
fi
CODEX_INTERVAL_MS="$(normalize_interval_ms "${base_interval}")"

APP_BUNDLE_PATH="${SCRIPT_DIR}/../dist/CodexStatusMenu.app/Contents/MacOS/CodexStatusMenu"
if [[ -n "${CODEX_TRANSPORT}" ]]; then
  APP_TRANSPORT_ARGS=(--transport "${CODEX_TRANSPORT}")
else
  APP_TRANSPORT_ARGS=()
fi

if [[ -x "${APP_BUNDLE_PATH}" ]]; then
  APP_NODE_PATH="${CODEX_NODE_BIN:-${CODEX_NODE:-${CODEX_NODE_PATH:-}}}"
  if [[ -z "${APP_NODE_PATH}" ]]; then
    APP_NODE_PATH="$(command -v node || true)"
  fi
  APP_NODE_PATH="${APP_NODE_PATH:-/usr/bin/node}"

  exec "${APP_BUNDLE_PATH}" \
    --node "${APP_NODE_PATH}" \
    --bridge-script "${SCRIPT_DIR}/codex-usage-bridge.js" \
    --port "${CODEX_SERIAL_PORT:-${CODEX_PORT:-/dev/cu.usbmodem1401}}" \
    --baud "${CODEX_BAUD:-115200}" \
    "${APP_TRANSPORT_ARGS[@]}" \
    --ble-device-id "${CODEX_BLE_DEVICE_ID}" \
    --ble-name "${CODEX_BLE_NAME}" \
    --ble-service-uuid "${CODEX_BLE_SERVICE_UUID}" \
    --ble-write-char-uuid "${CODEX_BLE_WRITE_CHAR_UUID}" \
    --interval "${CODEX_INTERVAL_MS}" \
    --state-file "${STATE_FILE}" \
    --config-file "${CONFIG_FILE}" \
    "$@"
fi

cleanup_log_file() {
  local file="$1"
  local max_bytes="$2"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi

  local size
  size="$(wc -c < "${file}")"
  if [[ "${size}" -lt "${max_bytes}" ]]; then
    return 0
  fi

  # Keep the latest half window and drop the old part.
  local keep_bytes
  keep_bytes="$((max_bytes / 2))"
  if [[ "${keep_bytes}" -le 0 ]]; then
    : > "${file}"
    return 0
  fi

  local temp_file="${file}.cleanup.tmp"
  if tail -c "${keep_bytes}" "${file}" > "${temp_file}"; then
    mv "${temp_file}" "${file}"
  else
    : > "${file}"
  fi
}

cleanup_all_logs() {
  cleanup_log_file "${LOG_OUT_PATH}" "${MAX_LOG_BYTES}"
  cleanup_log_file "${LOG_ERR_PATH}" "${MAX_LOG_BYTES}"
}

cleanup_all_logs

NODE_PATH="${CODEX_NODE_BIN:-${CODEX_NODE:-}}"
if [[ -z "${NODE_PATH}" ]]; then
  NODE_PATH="$(command -v node || true)"
fi
NODE_PATH="${NODE_PATH:-/usr/bin/node}"

if [[ ! -x "${NODE_PATH}" ]]; then
  echo "[error] Node executable not found: ${NODE_PATH}" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[error] swiftc not found in PATH" >&2
  exit 1
fi

if [[ ! -x "${BIN_PATH}" || "${SWIFT_SOURCE}" -nt "${BIN_PATH}" ]]; then
  swiftc -O -framework AppKit -framework Foundation "${SWIFT_SOURCE}" -o "${BIN_PATH}"
fi

export CODEX_BRIDGE_SCRIPT="${SCRIPT_DIR}/codex-usage-bridge.js"
export CODEX_SERIAL_PORT="${CODEX_SERIAL_PORT:-${CODEX_PORT:-/dev/cu.usbmodem1401}}"
export CODEX_BAUD="${CODEX_BAUD:-115200}"
export CODEX_INTERVAL_MS="${CODEX_INTERVAL_MS:-15000}"
APP_TRANSPORT_ARGS=(--transport "${CODEX_TRANSPORT}")
if [[ -z "${CODEX_TRANSPORT}" ]]; then
  APP_TRANSPORT_ARGS=()
fi

  "${BIN_PATH}" \
    --node "${NODE_PATH}" \
    --bridge-script "${CODEX_BRIDGE_SCRIPT}" \
    "${APP_TRANSPORT_ARGS[@]}" \
    --port "${CODEX_SERIAL_PORT}" \
    --baud "${CODEX_BAUD}" \
    --ble-device-id "${CODEX_BLE_DEVICE_ID}" \
    --ble-name "${CODEX_BLE_NAME}" \
    --ble-service-uuid "${CODEX_BLE_SERVICE_UUID}" \
    --ble-write-char-uuid "${CODEX_BLE_WRITE_CHAR_UUID}" \
    --interval "${CODEX_INTERVAL_MS}" \
    --state-file "${STATE_FILE}" \
    --config-file "${CONFIG_FILE}" \
  "$@" &
APP_PID=$!

cleanup_loop() {
  while true; do
    if ! kill -0 "${APP_PID}" 2>/dev/null; then
      break
    fi
    cleanup_all_logs
    sleep "${LOG_CLEANUP_INTERVAL_SECONDS}"
  done
}

cleanup_loop &
CLEANUP_PID=$!

cleanup_exit() {
  if [[ -n "${CLEANUP_PID:-}" ]] && kill -0 "${CLEANUP_PID}" 2>/dev/null; then
    kill "${CLEANUP_PID}" 2>/dev/null || true
    wait "${CLEANUP_PID}" 2>/dev/null || true
  fi
}

on_exit() {
  cleanup_exit
  kill "${APP_PID}" 2>/dev/null || true
}
trap 'on_exit; exit 0' TERM INT

wait "${APP_PID}"
EXIT_CODE=$?
cleanup_exit
exit "${EXIT_CODE}"
