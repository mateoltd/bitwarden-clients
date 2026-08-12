#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: $0 TARGET_ID}"
repository_root="$(git rev-parse --show-toplevel)"
temporary_root="$(mktemp -d "/tmp/alias-clean-room.XXXXXX")"
trap 'rm -rf -- "$temporary_root"' EXIT

build_once() {
  local label="$1"
  local source="$temporary_root/$label/source"
  local output="$temporary_root/$label/output"
  local log="$temporary_root/$label/build.log"
  mkdir -p "$temporary_root/$label"
  "$repository_root/scripts/release/export-oss-source.sh" "$source" >"$log" 2>&1 || {
    tail -n 200 "$log" >&2
    return 1
  }
  (
    cd "$source"
    HUSKY=0 npm ci
    OSS_CLEAN_ROOM=1 npm run release:verify
    OSS_CLEAN_ROOM=1 npm run release:build -- "$target" --output "$output"
  ) >>"$log" 2>&1 || {
    tail -n 200 "$log" >&2
    return 1
  }
  local artifact
  artifact="$(find "$output" -maxdepth 1 -type f \( -name '*.zip' -o -name '*.tar.gz' \) -print -quit)"
  rm -rf -- "$source"
  printf '%s\n' "$artifact"
}

first="$(build_once first)"
second="$(build_once second)"
node "$repository_root/scripts/release/compare-rebuilds.mjs" "$target" "$first" "$second"
