#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: $0 TARGET_ID}"
repository_root="$(git rev-parse --show-toplevel)"
first_root="$(mktemp -d "/tmp/alias-clean-room-first.XXXXXX")"
second_root="$(mktemp -d "/tmp/alias-clean-room-second.XXXXXX")"
safe_target="${target//[^a-zA-Z0-9_.-]/-}"
workspace_root="/tmp/alias-clean-room-${safe_target}-workspace"
if [[ -e "$workspace_root" ]]; then
  rm -rf -- "$first_root" "$second_root"
  echo "clean-room workspace is already in use: $workspace_root" >&2
  exit 1
fi
mkdir -p "$workspace_root"

cleanup() {
  rm -rf -- "$first_root" "$second_root" "$workspace_root"
}
trap cleanup EXIT

build_once() {
  local label="$1"
  local clean_root="$2"
  local source="$workspace_root/source"
  local output="$clean_root/output"
  local log="$clean_root/build.log"
  local rust_source="$source"
  if command -v cygpath >/dev/null 2>&1; then
    rust_source="$(cygpath -w "$source")"
  fi
  rm -rf -- "$source"
  "$repository_root/scripts/release/export-oss-source.sh" "$source" >"$log" 2>&1 || {
    tail -n 200 "$log" >&2
    return 1
  }
  (
    cd "$source"
    export CARGO_INCREMENTAL=0
    export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=${rust_source}=/workspace/bitwarden-clients"
    HUSKY=0 npm ci
    OSS_CLEAN_ROOM=1 npm run release:verify
    OSS_CLEAN_ROOM=1 npm run release:build -- "$target" --output "$output"
  ) >>"$log" 2>&1 || {
    tail -n 200 "$log" >&2
    return 1
  }
  find "$output" -maxdepth 1 -type f \( -name '*.zip' -o -name '*.tar.gz' \) -print -quit
}

first="$(build_once first "$first_root")"
second="$(build_once second "$second_root")"

python_command="${PYTHON:-python3}"
if ! command -v "$python_command" >/dev/null 2>&1; then
  python_command="python"
fi
content_hash="$("$python_command" "$repository_root/scripts/release/compare-archive-contents.py" "$first" "$second")"

first_hash="$(node -e 'const c=require("node:crypto"),f=require("node:fs"); console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$first")"
second_hash="$(node -e 'const c=require("node:crypto"),f=require("node:fs"); console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$second")"
if [[ "$first_hash" != "$second_hash" ]]; then
  echo "clean-room rebuild mismatch: $first_hash != $second_hash" >&2
  exit 1
fi
echo "$target reproducible content SHA-256 $content_hash"
echo "$target reproducible SHA-256 $first_hash"
