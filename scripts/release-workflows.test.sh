#!/usr/bin/env bash
# Executable contracts for the supported release formats and protected caller.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
for surface in cli desktop npm; do
  case "$surface" in cli) tag=v1.0.0;; desktop) tag=desktop-v1.0.0;; npm) tag=npm-v1.0.0;; esac
  GITHUB_OUTPUT="$scratch/$surface.output" IN_TAG="$tag" IN_BASE_VERSION=1.0.0 IN_CHANNEL=stable \
    bash "scripts/resolve-$surface-release.sh"
  if [ "$surface" = npm ]; then
    grep -Fxq 'arg=v1.0.0' "$scratch/$surface.output"
  else
    grep -Fxq "tag=$tag" "$scratch/$surface.output"
    grep -Fxq 'prerelease=false' "$scratch/$surface.output"
  fi
  for bad in "$tag-preview.1" "$tag-rc.1" invalid; do
    if IN_TAG="$bad" bash "scripts/resolve-$surface-release.sh" >/dev/null 2>&1; then
      echo "unsupported release accepted: $bad" >&2; exit 1
    fi
  done
done
ACTUAL_CALLER_WORKFLOW_REF='SivanCola/deepzora/.github/workflows/release-promote.yml@refs/heads/main' \
EXPECTED_CALLER_WORKFLOW_REF='SivanCola/deepzora/.github/workflows/release-promote.yml@refs/heads/main' \
CALLER_EVENT_NAME=workflow_dispatch CALLER_REF=refs/heads/main CALLER_REF_PROTECTED=true \
CALLER_WORKFLOW_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa CALLER_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
APPROVED_CLI_TAG=v1.0.0 APPROVED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
bash scripts/verify-release-authorization.sh
go run ./cmd/release-signing-contract validate
bash scripts/release-candidate-tags.test.sh
bash scripts/release-stable.test.sh
bash scripts/release-approve.test.sh
# Signed Windows bundles carry only versioned public names, so the acceptance
# steps must select the published Setup suffix, never the internal build name.
if grep -Fq "'*installer.exe'" .github/workflows/release-desktop.yml; then
  echo "Windows acceptance selects the internal installer build name" >&2; exit 1
fi
for arch in x64 arm64; do
  grep -Fq "\"suffix\": \"Windows-$arch-Setup.exe\"" internal/releaseassets/desktop.json
done
[ "$(grep -Fc -e "-Filter '*-Setup.exe' -File" .github/workflows/release-desktop.yml)" = 2 ]
# Parallel provenance checks must share one prefetched trusted root; separate
# TUF initializations race on hosted runners and fail random payload files.
for workflow in release-promote release-candidate-verify; do
  file=".github/workflows/$workflow.yml"
  grep -Fq 'gh attestation trusted-root > "$RUNNER_TEMP/trusted_root.jsonl"' "$file"
  grep -A5 -F 'xargs -0 -P 8' "$file" | grep -Fq -e '--custom-trusted-root "$RUNNER_TEMP/trusted_root.jsonl"'
done
echo 'current release workflow contracts: PASS'
