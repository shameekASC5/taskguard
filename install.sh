#!/usr/bin/env bash
#
# install.sh — install the Copilot Ledger Hook.
#
# Safe to run repeatedly (idempotent). Backs up any existing config.
#
#   ./install.sh                 # interactive: prompts for API key
#   ./install.sh --key sk-or-... # non-interactive (for agents / CI)
#   ./install.sh --dry-run       # show what would happen, change nothing
#   ./install.sh --uninstall     # remove everything this script installed
#
# What it does:
#   1. Copies hook scripts to ~/.copilot/hooks/ledger/
#   2. Writes ~/.copilot/hooks/ledger.json (backs up any existing one)
#   3. Stores your OpenRouter key in ~/.copilot/hooks/ledger/.env (chmod 600)
#   4. Installs the agent instruction file
#   5. Runs a health check
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_ROOT="$HOME/.copilot/hooks"
DEST="$HOOKS_ROOT/ledger"
CONFIG="$HOOKS_ROOT/ledger.json"
ENV_FILE="$DEST/.env"
INSTRUCTIONS_DIR="$HOME/.copilot/instructions"
INSTRUCTIONS_FILE="$INSTRUCTIONS_DIR/ledger.instructions.md"

DRY_RUN=0
UNINSTALL=0
API_KEY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --key)       shift; API_KEY="${1:-}" ;;
    --key=*)     API_KEY="${1#--key=}" ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  step "Uninstalling"
  if [ -f "$CONFIG" ]; then
    run rm -f "$CONFIG"
    say "  removed $CONFIG"
  fi
  if [ -d "$DEST" ]; then
    run rm -rf "$DEST"
    say "  removed $DEST"
  fi
  if [ -f "$INSTRUCTIONS_FILE" ]; then
    run rm -f "$INSTRUCTIONS_FILE"
    say "  removed $INSTRUCTIONS_FILE"
  fi
  say ""
  say "Done. Start a NEW chat session for the change to take effect."
  exit 0
fi

# ---------------------------------------------------------------- preflight
step "Preflight"
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 18 or newer."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required (found $(node -v))."
say "  node $(node -v)"

for f in ledger-session.cjs ledger-extract.cjs ledger-inject.cjs \
         ledger-nudge.cjs ledger-stop.cjs caps-report.cjs inspect.sh; do
  [ -f "$REPO_DIR/hooks/$f" ] || die "missing $REPO_DIR/hooks/$f — run this from the repo root."
done
say "  hook scripts present"

# ---------------------------------------------------------------- api key
step "OpenRouter API key"
if [ -z "$API_KEY" ] && [ -f "$ENV_FILE" ]; then
  say "  existing key found in $ENV_FILE — keeping it"
  say "  (delete that file and re-run to change it)"
fi

if [ -z "$API_KEY" ] && [ ! -f "$ENV_FILE" ]; then
  if [ -t 0 ]; then
    say "  Get one at https://openrouter.ai/keys"
    printf '  Paste key (input hidden): '
    stty -echo 2>/dev/null || true
    read -r API_KEY
    stty echo 2>/dev/null || true
    printf '\n'
  else
    die "no key supplied and no TTY. Re-run with: ./install.sh --key sk-or-..."
  fi
fi

if [ -n "$API_KEY" ]; then
  case "$API_KEY" in
    sk-or-*) : ;;
    *) warn "key does not start with 'sk-or-' — continuing anyway" ;;
  esac
fi

# ---------------------------------------------------------------- install
step "Installing hook scripts"
run mkdir -p "$DEST/lib"
for f in ledger-session.cjs ledger-extract.cjs ledger-inject.cjs \
         ledger-nudge.cjs ledger-stop.cjs caps-report.cjs; do
  run cp "$REPO_DIR/hooks/$f" "$DEST/$f"
done
for f in "$REPO_DIR"/hooks/lib/*.cjs; do
  run cp "$f" "$DEST/lib/$(basename "$f")"
done
run cp "$REPO_DIR/hooks/inspect.sh" "$DEST/inspect.sh"
run chmod +x "$DEST/inspect.sh"
say "  installed to $DEST"

step "Writing hook config"
if [ -f "$CONFIG" ]; then
  BACKUP="$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  run cp "$CONFIG" "$BACKUP"
  say "  backed up existing config to $BACKUP"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  say "  [dry-run] would write $CONFIG"
else
  cat > "$CONFIG" <<'JSON'
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/ledger-session.cjs", "timeoutSec": 15 }
    ],
    "userPromptSubmitted": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/ledger-extract.cjs", "timeoutSec": 45 }
    ],
    "preToolUse": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/ledger-inject.cjs", "timeoutSec": 15 }
    ],
    "postToolUse": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/ledger-nudge.cjs", "timeoutSec": 15 }
    ],
    "agentStop": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/ledger-stop.cjs", "timeoutSec": 45 }
    ]
  }
}
JSON
  say "  wrote $CONFIG"
fi

step "Storing credentials"
if [ -n "$API_KEY" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  [dry-run] would write $ENV_FILE (chmod 600)"
  else
    umask 077
    {
      printf 'OPENROUTER_API_KEY=%s\n' "$API_KEY"
      printf 'LEDGER_MODEL=deepseek/deepseek-v4-flash\n'
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    say "  wrote $ENV_FILE (mode 600)"
  fi
fi

step "Installing agent instructions"
run mkdir -p "$INSTRUCTIONS_DIR"
run cp "$REPO_DIR/instructions/ledger.instructions.md" "$INSTRUCTIONS_FILE"
say "  installed $INSTRUCTIONS_FILE"

# ---------------------------------------------------------------- verify
step "Health check"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  [dry-run] would run: $DEST/inspect.sh doctor"
else
  if "$DEST/inspect.sh" doctor; then
    say ""
    say "  health check passed"
  else
    warn "health check reported a problem — see output above"
  fi
fi

step "Measuring your history against the input caps"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  [dry-run] would run: $DEST/inspect.sh caps"
else
  "$DEST/inspect.sh" caps || warn "caps report failed (not fatal)"
fi

cat <<'DONE'

------------------------------------------------------------------
Installed.

IMPORTANT: hook config is read once at session start.
Start a NEW chat session for the ledger to begin working.

Then ask a question and a task in one message, e.g.:

  "What is the deploy command? Also fix the typo in README."

You should see the ledger injected before the first tool call,
and a nudge if the turn ends with items still open.

Commands:
  ~/.copilot/hooks/ledger/inspect.sh          # open items
  ~/.copilot/hooks/ledger/inspect.sh doctor   # health check
  ~/.copilot/hooks/ledger/inspect.sh caps     # cap fit for your history
  ~/.copilot/hooks/ledger/inspect.sh trace    # what the hooks did
------------------------------------------------------------------
DONE
