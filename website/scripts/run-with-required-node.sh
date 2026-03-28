#!/usr/bin/env bash
set -euo pipefail

MIN_NODE_VERSION="22.12.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ASTRO_CLI="${WEBSITE_DIR}/node_modules/astro/bin/astro.mjs"

version_gte() {
  local current="$1"
  local required="$2"
  local c1 c2 c3 r1 r2 r3

  IFS=. read -r c1 c2 c3 <<<"$current"
  IFS=. read -r r1 r2 r3 <<<"$required"

  c1="${c1:-0}"
  c2="${c2:-0}"
  c3="${c3:-0}"
  r1="${r1:-0}"
  r2="${r2:-0}"
  r3="${r3:-0}"

  if (( c1 != r1 )); then
    (( c1 > r1 ))
    return
  fi

  if (( c2 != r2 )); then
    (( c2 > r2 ))
    return
  fi

  (( c3 >= r3 ))
}

current_node_version() {
  node -p 'process.versions.node' 2>/dev/null || true
}

resolve_node_binary() {
  local current_version
  current_version="$(current_node_version)"

  if [[ -n "$current_version" ]] && version_gte "$current_version" "$MIN_NODE_VERSION"; then
    command -v node
    return 0
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    local nvm_node
    nvm_node="$(nvm which "$MIN_NODE_VERSION" 2>/dev/null || true)"
    if [[ -n "$nvm_node" && -x "$nvm_node" ]]; then
      "$nvm_node" -p 'process.versions.node' >/dev/null 2>&1
      echo "$nvm_node"
      return 0
    fi
  fi

  echo "Website scripts require Node.js >= ${MIN_NODE_VERSION} (Astro 6)." >&2
  echo "Run: cd website && nvm install && nvm use" >&2
  exit 1
}

if [[ ! -f "$ASTRO_CLI" ]]; then
  echo "Astro CLI not found at ${ASTRO_CLI}. Run pnpm install first." >&2
  exit 1
fi

NODE_BIN="$(resolve_node_binary)"
exec "$NODE_BIN" "$ASTRO_CLI" "$@"
