#!/usr/bin/env bash
# Runs test/run.sh in a throwaway container with the repository mounted read-only.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
MSYS_NO_PATHCONV=1 docker run --rm \
	--mount "type=bind,src=$root,dst=/ext,readonly" \
	-e "PI_VERSION=${PI_VERSION:-1.1.0}" \
	node:24-bookworm bash /ext/test/run.sh
