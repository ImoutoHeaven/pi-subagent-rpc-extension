#!/usr/bin/env bash
# Runs the end-to-end test against the Pi on this machine, with a throwaway agent
# directory, so the user's settings, credentials, and sessions stay untouched.
# PI_CLI selects a Pi CLI entry (cli.js); otherwise `pi` from PATH.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
tmp="$(cd "$(mktemp -d)" && (pwd -W 2>/dev/null || pwd))"
# Run from inside a subagent, the inherited marker would keep the test's parent from registering the tool.
unset PI_SUBAGENT_CHILD
export PI_CODING_AGENT_DIR="$tmp/agent" WORK_DIR="$tmp/work" REQUESTS_LOG="$tmp/requests.jsonl" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1
mkdir -p "$PI_CODING_AGENT_DIR" "$WORK_DIR/project"
# Loaded from settings, as an installed package is, so children load it too and must stay inert.
printf '{ "extensions": ["%s"] }\n' "$root" > "$PI_CODING_AGENT_DIR/settings.json"
cat > "$PI_CODING_AGENT_DIR/models.json" <<'EOF'
{ "providers": { "fake": { "baseUrl": "http://127.0.0.1:8787/v1", "api": "openai-completions", "apiKey": "x", "models": [{ "id": "fake-model" }] } } }
EOF
node "$root/test/fake-llm.mjs" "$REQUESTS_LOG" 8787 &
fake=$!
trap 'kill $fake 2>/dev/null; rm -rf "$tmp"' EXIT
sleep 1
node "$root/test/e2e.mjs"
