#!/usr/bin/env bash
#
# Chaos / edge-case tests (TRD §10.4). Run from the repo root with the full
# stack already up:   ./tests/chaos/run-chaos.sh
#
# Scenario 1 — Redis outage:
#   kill Redis mid-traffic → fail-OPEN clients keep flowing via the bounded
#   local fallback; the fail-CLOSED client (bank-strict) is denied; after
#   Redis returns, instances recover to normal atomic mode.
#
# Scenario 2 — Log worker crash:
#   send a known number of requests, kill the worker mid-consumption, restart
#   it, and assert Postgres ends up with every entry exactly once (consumer
#   group replay + idempotent sink ⇒ no loss, no duplicates).

set -euo pipefail
cd "$(dirname "$0")/../.."

BASE_URL=${BASE_URL:-http://localhost:8080}
PASS=0
FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  [PASS] %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL+1)); }

check() { # check <clientId> -> echoes "allowed mode" e.g. "true normal"
  curl -s -X POST "$BASE_URL/check" \
    -H 'Content-Type: application/json' \
    -d "{\"clientId\":\"$1\"}" |
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(`${j.allowed} ${j.mode}`)})'
}

wait_for_mode() { # wait_for_mode <expected-mode> <timeout-s>
  local deadline=$((SECONDS + $2))
  while [ $SECONDS -lt $deadline ]; do
    mode=$(check client-a | awk '{print $2}')
    [ "$mode" = "$1" ] && return 0
    sleep 1
  done
  return 1
}

say "═══ Scenario 1: Redis outage → fail-safe behavior ═══"

say "Baseline: normal mode decisions"
result=$(check client-a)
if [ "$result" = "true normal" ]; then ok "client-a allowed in normal mode"; else bad "expected 'true normal', got '$result'"; fi

say "Stopping Redis…"
docker compose stop redis >/dev/null

say "Traffic during the outage (breaker needs a few failures to open)"
if wait_for_mode fallback 15; then
  ok "instances switched to fallback mode — traffic still flowing"
else
  bad "instances never entered fallback mode"
fi

result=$(check client-a)
if [ "$(echo "$result" | awk '{print $2}')" = "fallback" ]; then
  ok "fail-open client (client-a) served from local fallback: $result"
else
  bad "client-a not in fallback mode: $result"
fi

result=$(check bank-strict)
if [ "$result" = "false fallback" ]; then
  ok "fail-CLOSED client (bank-strict) correctly denied during outage"
else
  bad "bank-strict should be 'false fallback', got '$result'"
fi

say "Restarting Redis…"
docker compose start redis >/dev/null

if wait_for_mode normal 20; then
  ok "instances recovered to normal atomic mode"
else
  bad "instances did not recover to normal mode"
fi

say "═══ Scenario 2: Log worker crash → no loss, no duplicates ═══"

MARKER_CLIENT=client-a
N=40

say "Flushing pipeline to a steady state…"
sleep 3
before=$(docker compose exec -T postgres psql -U ratelimiter -d ratelimiter -tAc \
  "SELECT count(*) FROM request_logs WHERE client_id='$MARKER_CLIENT'")

say "Sending $N requests, killing the worker mid-consumption…"
for _ in $(seq 1 $((N / 2))); do
  curl -s -o /dev/null -X POST "$BASE_URL/check" -H 'Content-Type: application/json' \
    -d "{\"clientId\":\"$MARKER_CLIENT\"}"
done
docker compose kill logworker >/dev/null
for _ in $(seq 1 $((N / 2))); do
  curl -s -o /dev/null -X POST "$BASE_URL/check" -H 'Content-Type: application/json' \
    -d "{\"clientId\":\"$MARKER_CLIENT\"}"
done

say "Restarting the worker (consumer-group replay)…"
docker compose start logworker >/dev/null
sleep 8 # worker drains its PEL + the backlog

after=$(docker compose exec -T postgres psql -U ratelimiter -d ratelimiter -tAc \
  "SELECT count(*) FROM request_logs WHERE client_id='$MARKER_CLIENT'")
dupes=$(docker compose exec -T postgres psql -U ratelimiter -d ratelimiter -tAc \
  "SELECT count(*) - count(DISTINCT stream_id) FROM request_logs")

delta=$((after - before))
if [ "$delta" -eq "$N" ]; then
  ok "all $N requests logged across the crash (got exactly $delta new rows)"
else
  bad "expected $N new log rows across the crash, got $delta"
fi
if [ "$dupes" -eq 0 ]; then
  ok "zero duplicate stream entries in Postgres (idempotent sink)"
else
  bad "$dupes duplicate rows found"
fi

say "═══ Results: $PASS passed, $FAIL failed ═══"
[ "$FAIL" -eq 0 ] || exit 1
