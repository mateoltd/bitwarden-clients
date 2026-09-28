#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 ABSOLUTE_DESTINATION" >&2
  exit 2
fi

destination="$1"
if [[ "$destination" != /* || "$destination" == "/" ]]; then
  echo "destination must be an absolute, non-root path" >&2
  exit 2
fi
if [[ -e "$destination" ]] && [[ -n "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "destination must be absent or empty: $destination" >&2
  exit 2
fi

repository_root="$(git rev-parse --show-toplevel)"
node "$repository_root/scripts/release/verify-release.mjs"
mkdir -p "$destination"
git -C "$repository_root" archive --format=tar HEAD -- . ':(exclude)bitwarden_license' | tar -xf - -C "$destination"

git -C "$repository_root" rev-parse HEAD > "$destination/.release-source-commit"
if [[ -e "$destination/bitwarden_license" ]]; then
  echo "commercial source remained in OSS export" >&2
  exit 1
fi
node "$destination/scripts/release/prepare-clean-room.mjs"
OSS_CLEAN_ROOM=1 node "$destination/scripts/release/verify-release.mjs"
