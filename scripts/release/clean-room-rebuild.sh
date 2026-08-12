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
  find "$output" -maxdepth 1 -type f \( -name '*.zip' -o -name '*.tar.gz' \) -print -quit
}

first="$(build_once first)"
second="$(build_once second)"
first_hash="$(node -e 'const c=require("node:crypto"),f=require("node:fs"); console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$first")"
second_hash="$(node -e 'const c=require("node:crypto"),f=require("node:fs"); console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$second")"
if [[ "$first_hash" != "$second_hash" ]]; then
  echo "clean-room rebuild mismatch: $first_hash != $second_hash" >&2
  exit 1
fi
echo "$target reproducible SHA-256 $first_hash"
