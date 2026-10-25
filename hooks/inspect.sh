#!/usr/bin/env bash
# Inspect the ledger hook state and the event probe log.
#
# Usage:
#   ./inspect.sh ledger    # current open items (default)
#   ./inspect.sh doctor    # health check: key, model, extraction smoke test
#   ./inspect.sh caps      # are the input caps right for YOUR history?
#   ./inspect.sh events    # which hook events have fired (needs probe enabled)
#   ./inspect.sh log       # raw probe log
#   ./inspect.sh clear     # wipe probe log + ledgers

set -euo pipefail

DIR="$HOME/.copilot/hooks/ledger"
PROBE="$DIR/event-probe.log.jsonl"
LEDGERS="$DIR/.ledger"
ENV_FILE="$DIR/.env"

case "${1:-ledger}" in
  ledger)
    if [ ! -d "$LEDGERS" ] || [ -z "$(ls -A "$LEDGERS" 2>/dev/null)" ]; then
      echo "No ledgers yet."
      echo ""
      echo "If you just ran a chat session, extraction may have failed."
      echo "Run: $0 doctor"
      exit 0
    fi
    for f in "$LEDGERS"/*.json; do
      count=$(jq '.items | length' "$f")
      echo "=== $(basename "$f") ==="
      if [ "$count" -eq 0 ]; then
        echo "  (EMPTY — no items extracted. Extraction likely failed.)"
        echo "  Run: $0 doctor"
      else
        jq '{sessionId, blockCount, items: [.items[] | {id, kind, status, text}]}' "$f"
      fi
      echo ""
    done
    ;;
  doctor)
    echo "=== ledger hook health check ==="
    echo ""
    echo "--- config ---"
    [ -f "$DIR/../ledger.json" ] && echo "hook config: present" || echo "hook config: MISSING"
    echo "scripts: $(ls "$DIR"/*.cjs 2>/dev/null | wc -l | tr -d ' ') found"
    echo ""
    echo "--- key ---"
    if [ -f "$ENV_FILE" ]; then
      KEY=$(grep '^OPENROUTER_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
      echo ".env: present (key length ${#KEY})"
      if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "$OPENROUTER_API_KEY" != "$KEY" ]; then
        echo "WARNING: shell OPENROUTER_API_KEY differs from .env."
        echo "         The .env file wins, so this is informational only."
      fi
    else
      echo ".env: MISSING — create $ENV_FILE with OPENROUTER_API_KEY=..."
    fi
    echo ""
    echo "--- extraction smoke test ---"
    SID="doctor-$$"
    OUT=$(echo "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$SID\",\"prompt\":\"Say hello and explain what a closure is.\"}" \
      | node "$DIR/ledger-extract.cjs" 2>&1)
    if [ -f "$LEDGERS/$SID.json" ]; then
      n=$(jq '.items | length' "$LEDGERS/$SID.json")
      if [ "$n" -gt 0 ]; then
        echo "PASS: extracted $n item(s)"
        jq -r '.items[] | "  [\(.id)] (\(.kind)) \(.text)"' "$LEDGERS/$SID.json"
      else
        echo "FAIL: ledger created but 0 items extracted."
        echo "      stderr: ${OUT:-<none>}"
      fi
      rm -f "$LEDGERS/$SID.json"
    else
      echo "FAIL: no ledger written."
      echo "      stderr: ${OUT:-<none>}"
    fi
    ;;
  caps)
    node "$DIR/caps-report.cjs" "${@:2}"
    ;;
  events)
    if [ ! -f "$PROBE" ]; then
      echo "No probe log yet."
      echo "Enable the probe: mv $DIR/../ledger-probe.json.disabled $DIR/../ledger-probe.json"
      exit 0
    fi
    echo "=== events fired (count) ==="
    jq -r '.event' "$PROBE" | sort | uniq -c | sort -rn
    echo ""
    echo "=== timeline ==="
    jq -r '"\(.at)  \(.event)  session=\(.sessionId)"' "$PROBE"
    ;;
  trace)
    TRACE="$DIR/hook-trace.log.jsonl"
    if [ ! -f "$TRACE" ]; then
      echo "No hook trace yet."
      echo "This log is written by OUR scripts. If it is empty, our code never ran."
      exit 0
    fi
    echo "=== our scripts invoked (count by script/phase) ==="
    jq -r '"\(.script)  \(.phase)"' "$TRACE" | sort | uniq -c | sort -rn
    echo ""
    echo "=== timeline ==="
    jq -r '"\(.at)  \(.script)  \(.phase)  \(.sessionId // "-")"' "$TRACE"
    ;;
  decisions)
    TRACE="$DIR/hook-trace.log.jsonl"
    if [ ! -f "$TRACE" ]; then
      echo "No hook trace yet."
      exit 0
    fi
    echo "=== stop-hook decisions (did it nudge?) ==="
    jq -r 'select(.script=="ledger-stop" and (.phase|startswith("decision"))) |
      "\(.at)  \(.phase)  session=\(.sessionId)  stillOpen=\(.stillOpen // "-")  resolved=\(.resolved // "-")  reason=\(.reason // "-")"' "$TRACE"
    echo ""
    echo "=== block counts per session (each block = one forced extra turn) ==="
    for f in "$LEDGERS"/*.json; do
      [ -f "$f" ] || continue
      bc=$(jq -r '.blockCount // 0' "$f")
      [ "$bc" != "0" ] && [ "$bc" != "null" ] && echo "  $(basename "$f" .json): blocked $bc time(s)"
    done
    ;;
  watch)
    TRACE="$DIR/hook-trace.log.jsonl"
    echo "Watching the ledger loop live. Ctrl-C to stop."
    echo "Format: time  script  phase  detail"
    echo ""
    touch "$TRACE"
    tail -f "$TRACE" | jq -r --unbuffered '
      "\(.at[11:19])  \(.script | sub("ledger-";""))  \(.phase)" +
      (if .openCount != null then "  open=\(.openCount)" else "" end) +
      (if .stillOpen != null then "  stillOpen=\(.stillOpen) resolved=\(.resolved)" else "" end) +
      (if .reason != null then "  (\(.reason))" else "" end)'
    ;;
  testmode)
    # Toggle deterministic blocking so the nudge + forced turn can be observed.
    # Writes a flag file the stop hook reads via LEDGER_FORCE_BLOCK.
    FLAG="$DIR/.force-block"
    case "${2:-status}" in
      on)
        touch "$FLAG"
        echo "TEST MODE ON: the stop hook will ALWAYS block while items are open."
        echo "The LLM reconcile is skipped, so the nudge and the follow-up turn"
        echo "are deterministic. Turn it off with: $0 testmode off"
        ;;
      off)
        rm -f "$FLAG"
        echo "TEST MODE OFF: normal LLM reconcile restored."
        ;;
      *)
        if [ -f "$FLAG" ]; then echo "test mode: ON"; else echo "test mode: OFF"; fi
        ;;
    esac
    ;;
  prune)
    # Delete ledgers whose items are ALL resolved (done/dropped).
    # Age is deliberately NOT the trigger: a session can run for days, and the
    # conversation history is the durable record once work is complete.
    echo "Pruning fully-resolved ledgers (all items done/dropped)..."
    removed=0
    for f in "$LEDGERS"/*.json; do
      [ -f "$f" ] || continue
      total=$(jq '.items | length' "$f" 2>/dev/null || echo 0)
      open=$(jq '[.items[] | select(.status=="open")] | length' "$f" 2>/dev/null || echo 1)
      if [ "$total" -gt 0 ] && [ "$open" -eq 0 ]; then
        echo "  removed: $(basename "$f") ($total items, all resolved)"
        rm -f "$f"
        removed=$((removed + 1))
      fi
    done
    echo "Removed $removed. Remaining: $(ls -1 "$LEDGERS"/*.json 2>/dev/null | wc -l | tr -d ' ')"
    ;;
  log)
    cat "$PROBE" 2>/dev/null | jq . || echo "No probe log."
    ;;
  clear)
    rm -f "$PROBE" "$DIR/hook-trace.log.jsonl"
    rm -rf "$LEDGERS"
    echo "Cleared probe log, hook trace, and ledgers."
    ;;
  *)
    echo "Usage: $0 {ledger|doctor|caps|events|trace|log|clear}"
    exit 1
    ;;
esac
