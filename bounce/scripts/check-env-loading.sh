#!/usr/bin/env bash
# Verifies that a key placed in .env is actually loaded.
# Resolve the package root from this script's own location, so the script works
# wherever the checkout lives (it previously hardcoded a /home/... WSL path).
cd "$(dirname "$0")/.." || exit 1

# This script rewrites .env five times and then deletes it. A real .env holds
# the provider API key, so stash it up front and put it back on any exit --
# including Ctrl-C or a crash. An interrupted run must not cost you the key.
STASH=""
if [ -f .env ]; then
  STASH="$(mktemp "${TMPDIR:-/tmp}/bounce-env.XXXXXX")"
  cp .env "$STASH"
  echo "stashed the real .env -> $STASH"
fi

restore_env() {
  rm -f .env
  if [ -n "$STASH" ]; then
    cp "$STASH" .env && rm -f "$STASH"
    echo "restored the real .env"
  fi
}
trap restore_env EXIT INT TERM

run_case() {
  local port="$1" label="$2" expect="$3"
  PORT="$port" node --env-file-if-exists=.env server/index.js > "/tmp/opencode-env-$port.log" 2>&1 &
  local pid=$!
  sleep 2.5
  echo "--- $label ---"
  if kill -0 "$pid" 2>/dev/null; then
    curl -s -m 3 "http://127.0.0.1:$port/api/health" || echo "(no response)"
    echo
    grep -h "provider:" "/tmp/opencode-env-$port.log" || tail -2 "/tmp/opencode-env-$port.log"
  else
    echo "process exited (expected for the failure case):"
    tail -2 "/tmp/opencode-env-$port.log"
  fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  echo "  expected: $expect"
  echo
}

rm -f .env
run_case 8791 "no .env at all" "mock provider, no crash"

printf 'OPENROUTER_API_KEY=sk-or-test-DUMMY-1234567890\n' > .env
run_case 8792 ".env with a key, no LLM_PROVIDER" "openrouter (inferred)"

printf 'NIM_API_KEY=nvapi-test-DUMMY-1234567890\n' > .env
run_case 8793 ".env with a NIM key, no LLM_PROVIDER" "nim (inferred)"

printf 'LLM_PROVIDER=nim\n' > .env
run_case 8794 ".env asks for nim but gives no key" "loud failure, not a silent mock"

printf 'LLM_PROVIDER=wat\nOPENROUTER_API_KEY=x\n' > .env
run_case 8795 ".env with a typo in LLM_PROVIDER" "loud 'unknown provider' error"

# Cleanup is handled by the EXIT trap above, which also restores the real .env.
echo "done"
