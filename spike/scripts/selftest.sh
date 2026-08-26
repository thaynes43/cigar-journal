#!/usr/bin/env bash
# Authless connectivity selftest for the Phase 0 MCP spike.
# Exercises: initialize -> tools/list -> get_test_value -> set_test_value ->
# get_test_value (verifies the write landed). Streamable HTTP JSON-RPC over
# POST /mcp with the required Accept header. Prints PASS/FAIL per step.
#
# Usage: BASE_URL=http://localhost:8080 scripts/selftest.sh
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
MCP="$BASE_URL/mcp"
ACCEPT="application/json, text/event-stream"
MARKER="selftest-$(date +%s)-$RANDOM"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# Pull the JSON payload out of a Streamable-HTTP reply (SSE frames or plain JSON).
extract_json() {
  if grep -q '^data: ' "$1"; then
    grep '^data: ' "$1" | sed 's/^data: //' | tail -1
  else
    cat "$1"
  fi
}

echo "== spike selftest against $MCP =="

# 1. health
code="$(curl -sS -o "$TMP/h.b" -w '%{http_code}' "$BASE_URL/healthz")"
if [ "$code" = "200" ] && grep -q '"status":"ok"' "$TMP/h.b"; then ok "healthz 200"; else bad "healthz (got $code)"; fi

# 2. initialize
curl -sS -D "$TMP/init.h" -o "$TMP/init.b" \
  -H "Content-Type: application/json" -H "Accept: $ACCEPT" \
  -X POST "$MCP" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"selftest","version":"0.0.0"}}}'
SID="$(grep -i '^mcp-session-id:' "$TMP/init.h" | tr -d '\r' | awk '{print $2}')"
INIT="$(extract_json "$TMP/init.b")"
PROTO="$(printf '%s' "$INIT" | grep -o '"protocolVersion":"[^"]*"' | head -1 | sed 's/.*:"//;s/"$//')"
[ -z "$PROTO" ] && PROTO="2025-06-18"
if [ -n "$SID" ] && printf '%s' "$INIT" | grep -q '"serverInfo"' && printf '%s' "$INIT" | grep -q 'cigar-journal-spike'; then
  ok "initialize (session=$SID proto=$PROTO)"
else
  bad "initialize"; echo "  response: $INIT"
fi
if printf '%s' "$INIT" | grep -q '"instructions"'; then ok "server instructions present"; else bad "server instructions missing"; fi

H=(-H "Content-Type: application/json" -H "Accept: $ACCEPT" -H "mcp-session-id: $SID" -H "MCP-Protocol-Version: $PROTO")

# 3. initialized notification (expect 202)
code="$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -X POST "$MCP" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')"
if [ "$code" = "202" ]; then ok "notifications/initialized (202)"; else bad "notifications/initialized (got $code)"; fi

rpc() { curl -sS "${H[@]}" -X POST "$MCP" -d "$1" -o "$TMP/r.b"; extract_json "$TMP/r.b"; }

# 4. tools/list
LIST="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
if printf '%s' "$LIST" | grep -q 'get_test_value' && printf '%s' "$LIST" | grep -q 'set_test_value'; then ok "tools/list has both tools"; else bad "tools/list"; echo "  $LIST"; fi
if printf '%s' "$LIST" | grep -q '"readOnlyHint":true'; then ok "get_test_value readOnlyHint:true advertised"; else bad "readOnlyHint annotation missing"; fi

# 5. read tool
R1="$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_test_value","arguments":{}}}')"
if printf '%s' "$R1" | grep -q 'readCount' && printf '%s' "$R1" | grep -q 'serverTime'; then ok "get_test_value returns value/serverTime/readCount"; else bad "get_test_value"; echo "  $R1"; fi

# 6. write tool
W="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"set_test_value\",\"arguments\":{\"value\":\"$MARKER\"}}}")"
if printf '%s' "$W" | grep -q 'previous' && printf '%s' "$W" | grep -q "$MARKER"; then ok "set_test_value stores value (returns previous+current)"; else bad "set_test_value"; echo "  $W"; fi

# 7. read again — write must be visible
R2="$(rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_test_value","arguments":{}}}')"
if printf '%s' "$R2" | grep -q "$MARKER"; then ok "write is visible on subsequent read"; else bad "write not visible on read"; echo "  $R2"; fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
