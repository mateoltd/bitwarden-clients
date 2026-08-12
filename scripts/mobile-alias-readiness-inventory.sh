#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_BRANCH="docs/mobile-alias-integration"
readonly EXPECTED_BASE="1f881babc15eb7d3a88cad41730ce167d8e49a41"

print_inventory() {
  printf 'kind\tname\tcommit\n'
  printf 'base\tclients-origin-main\t%s\n' "$EXPECTED_BASE"
  printf 'local-ref\torigin/docs/alias-product-contract\t%s\n' "6b58f7b8c4678dce5c5a3f92f7d028ef17c47f6e"
  printf 'local-ref\torigin/feat/alias-core-binding\t%s\n' "0ece533db83deaa22c2f07bfdf757195cc59326b"
  printf 'local-ref\torigin/feat/alias-browser\t%s\n' "686e9b1288e0b26791d46749fc47baf1e70b3819"
  printf 'local-ref\torigin/feat/alias-cross-device\t%s\n' "113a59638afbe4379e259a2cec8fa38597445eb6"
  printf 'local-ref\torigin/feat/alias-desktop\t%s\n' "4e1a0a1635cf8bfa370bbb2762ff9184d05e3914"
  printf 'local-ref\torigin/feat/alias-migration-cli\t%s\n' "383096e69b028013a88741045bc940f9d4a5fd37"
  printf 'local-ref\torigin/feat/alias-web\t%s\n' "a78437c68572c427d5e95ebb4f179efa918d1911"
  printf 'local-ref\torigin/fix/alias-hardening\t%s\n' "7fcfbfbafbb7eb395a861fd322dc7568f5449ca6"
  printf 'local-ref\torigin/integration/alias-clients-stage-one\t%s\n' "dc0a6261a45e131783386f9e1c9e855c4cdbca03"
  printf 'local-ref\torigin/integration/canonical-alias-sdk\t%s\n' "79a59a7945cb1490104185e48f901348bcda2576"
  printf 'local-ref\torigin/integration/first-class-aliases\t%s\n' "24ddd096d5f5fdd7b1939c1407755258ff953fe1"
  printf 'local-ref\torigin/refactor/remove-legacy-alias-migration\t%s\n' "de5a4c6be71cdcb71038f1fab432bc484ffbc364"
  printf 'local-ref\torigin/test/alias-e2e\t%s\n' "29c19fbb4f6733ba45fd5bc9fad2f42cddf3624a"
  printf 'local-ref\torigin/build/alias-client-release\t%s\n' "95c5655065172c7505d7f82428b8bf7b46792b82"
  printf 'public-repo\tbitwarden/ios\t%s\n' "7d9c4a779e0985fb01db4652d744c0728724b8ba"
  printf 'public-repo\tbitwarden/android\t%s\n' "5c0764e72ba821d9277a3fdd23c09131fba19c57"
  printf 'public-repo\tbitwarden/sdk-internal-main\t%s\n' "99ffb6ef5f07c1b344f0e8ceb4da37f27482e9f6"
  printf 'public-repo\tbitwarden/sdk-internal-alias\t%s\n' "8e7a52bcb4ca52eba28f0cc7ec574d784abc0fc7"
}

fail() {
  printf 'FAIL\t%s\n' "$1" >&2
  return 1
}

verify_local() {
  local root branch origin_main merge_base failures=0
  root="$(git rev-parse --show-toplevel)" || return 1
  cd "$root"

  branch="$(git branch --show-current)"
  [[ "$branch" == "$EXPECTED_BRANCH" ]] || {
    fail "branch expected=$EXPECTED_BRANCH actual=$branch" || true
    failures=$((failures + 1))
  }

  origin_main="$(git rev-parse 'origin/main^{commit}')"
  [[ "$origin_main" == "$EXPECTED_BASE" ]] || {
    fail "origin/main expected=$EXPECTED_BASE actual=$origin_main" || true
    failures=$((failures + 1))
  }

  merge_base="$(git merge-base "$EXPECTED_BASE" HEAD)"
  [[ "$merge_base" == "$EXPECTED_BASE" ]] || {
    fail "merge-base expected=$EXPECTED_BASE actual=$merge_base" || true
    failures=$((failures + 1))
  }

  while IFS=$'\t' read -r kind name expected; do
    [[ "$kind" == "local-ref" ]] || continue
    local actual ref_merge_base
    actual="$(git rev-parse "$name^{commit}" 2>/dev/null || true)"
    if [[ "$actual" != "$expected" ]]; then
      fail "$name expected=$expected actual=${actual:-missing}" || true
      failures=$((failures + 1))
      continue
    fi
    ref_merge_base="$(git merge-base "$EXPECTED_BASE" "$name")"
    if [[ "$ref_merge_base" != "$EXPECTED_BASE" ]]; then
      fail "$name merge-base expected=$EXPECTED_BASE actual=$ref_merge_base" || true
      failures=$((failures + 1))
    fi
  done < <(print_inventory)

  if ((failures > 0)); then
    return 1
  fi
  printf 'OK\tlocal inventory matches pinned snapshot\n'
}

verify_remote() {
  local failures=0
  while IFS=$'\t' read -r kind name commit; do
    [[ "$kind" == "public-repo" ]] || continue
    local repo="${name%-main}"
    repo="${repo%-alias}"
    if ! curl --fail --silent --show-error --location \
      --output /dev/null \
      "https://api.github.com/repos/$repo/commits/$commit"; then
      fail "$name commit did not resolve: $commit" || true
      failures=$((failures + 1))
    fi
  done < <(print_inventory)

  if ((failures > 0)); then
    return 1
  fi
  printf 'OK\timmutable public commits resolve\n'
}

case "${1:-}" in
  "")
    print_inventory
    ;;
  --verify-local)
    verify_local
    ;;
  --verify-remote)
    verify_remote
    ;;
  *)
    printf 'usage: %s [--verify-local|--verify-remote]\n' "$0" >&2
    exit 2
    ;;
esac
