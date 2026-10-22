#!/usr/bin/env bash
# Runs test/run.sh in a throwaway container with the repository mounted read-only.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
docker info >/dev/null
for version in ${PI_VERSION:-1.3.0 1.4.0}; do
	echo "=== Pi $version ==="
	MSYS_NO_PATHCONV=1 docker run --rm \
		--mount "type=bind,src=$root,dst=/ext,readonly" \
		-e "PI_VERSION=$version" \
		node:24-bookworm bash /ext/test/run.sh
done
