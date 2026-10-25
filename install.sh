#!/usr/bin/env bash
#
# install.sh — install taskguard.
#
# Safe to run repeatedly (idempotent). Backs up any existing config.
#
#   ./install.sh                 # interactive: prompts for API key
#   ./install.sh --key sk-or-... # non-interactive (for agents / CI)
#   ./install.sh --dry-run       # show what would happen, change nothing
#   ./install.sh --uninstall     # remove everything this script installed
#
# Paths (all optional; a leading ~ is expanded):
#   --hooks-dir DIR         where the scripts live   [~/.copilot/hooks/ledger]
#   --config FILE           the hook config json     [~/.copilot/hooks/ledger.json]
#   --instructions-dir DIR  where the instruction file goes
#                                                    [~/.copilot/instructions]
#
# If you already have an instructions directory registered in
# chat.instructionsFilesLocations, the installer uses that one instead of
# creating a second. Pass --instructions-dir to override.
#
# The same paths can be set with TASKGUARD_HOOKS_DIR, TASKGUARD_CONFIG and
# TASKGUARD_INSTRUCTIONS_DIR.
#
# What it does:
#   1. Copies the core, the adapter, and the tools to the hooks directory
#   2. Writes the hook config (backs up any existing one)
#   3. Stores your API key in <hooks-dir>/.env (chmod 600)
#   4. Installs the agent instruction file and registers its directory
#   5. Runs a health check, a cap check, and a cost estimate
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Paths -----------------------------------------------------------------
# Every path is overridable, by flag or by environment variable. The defaults
# match a stock VS Code install; override them if you keep your Copilot config
# somewhere else, or if you already have an instructions directory registered
# and would rather taskguard install into that one.
#
#   --hooks-dir DIR        where the scripts live      (TASKGUARD_HOOKS_DIR)
#   --config FILE          the hook config json        (TASKGUARD_CONFIG)
#   --instructions-dir DIR where the instruction file goes
#                                                      (TASKGUARD_INSTRUCTIONS_DIR)
#
# A leading ~ is expanded, so "~/my/instructions" works.
expand_tilde() {
  case "$1" in
    "~")   printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

HOOKS_ROOT="$(expand_tilde "${TASKGUARD_HOOKS_ROOT:-$HOME/.copilot/hooks}")"
DEST="$(expand_tilde "${TASKGUARD_HOOKS_DIR:-$HOOKS_ROOT/ledger}")"
CONFIG="$(expand_tilde "${TASKGUARD_CONFIG:-$HOOKS_ROOT/ledger.json}")"
ENV_FILE="$DEST/.env"
INSTRUCTIONS_DIR="$(expand_tilde "${TASKGUARD_INSTRUCTIONS_DIR:-$HOME/.copilot/instructions}")"
INSTRUCTIONS_FILE="$INSTRUCTIONS_DIR/ledger.instructions.md"

DRY_RUN=0
UNINSTALL=0
API_KEY=""
PROVIDER=""
MODEL=""
INSTRUCTIONS_DIR_SET=0
[ -n "${TASKGUARD_INSTRUCTIONS_DIR:-}" ] && INSTRUCTIONS_DIR_SET=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --key)       shift; API_KEY="${1:-}" ;;
    --key=*)     API_KEY="${1#--key=}" ;;
    --hooks-dir) shift; DEST="$(expand_tilde "${1:-}")"; ENV_FILE="$DEST/.env" ;;
    --hooks-dir=*) DEST="$(expand_tilde "${1#--hooks-dir=}")"; ENV_FILE="$DEST/.env" ;;
    --config)    shift; CONFIG="$(expand_tilde "${1:-}")" ;;
    --config=*)  CONFIG="$(expand_tilde "${1#--config=}")" ;;
    --instructions-dir) shift; INSTRUCTIONS_DIR="$(expand_tilde "${1:-}")"; INSTRUCTIONS_DIR_SET=1 ;;
    --instructions-dir=*) INSTRUCTIONS_DIR="$(expand_tilde "${1#--instructions-dir=}")"; INSTRUCTIONS_DIR_SET=1 ;;
    --provider)  shift; PROVIDER="${1:-}" ;;
    --provider=*) PROVIDER="${1#--provider=}" ;;
    --model)     shift; MODEL="${1:-}" ;;
    --model=*)   MODEL="${1#--model=}" ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# Derived paths must be recomputed AFTER flag parsing, otherwise
# --instructions-dir / --hooks-dir would be silently ignored.
INSTRUCTIONS_FILE="$INSTRUCTIONS_DIR/ledger.instructions.md"
ENV_FILE="$DEST/.env"

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Interactive only when stdin is a real terminal AND the caller did not ask
# for a non-interactive run. Agents and CI must never block on a prompt.
INTERACTIVE=0
if [ -t 0 ] && [ "${LEDGER_NONINTERACTIVE:-0}" != "1" ]; then
  INTERACTIVE=1
fi
ask() { [ "$INTERACTIVE" -eq 1 ]; }

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

for f in core/index.cjs core/ledger.cjs core/extract.cjs core/llm.cjs core/trace.cjs \
         adapters/vscode/session.cjs adapters/vscode/prompt-submitted.cjs \
         adapters/vscode/before-tool.cjs adapters/vscode/after-tool.cjs \
         adapters/vscode/turn-end.cjs adapters/vscode/_io.cjs \
         tools/caps-report.cjs tools/cost-report.cjs tools/inspect.sh; do
  [ -f "$REPO_DIR/$f" ] || die "missing $REPO_DIR/$f — run this from the repo root."
done
say "  hook scripts present"

# ---------------------------------------------------------------- provider
step "Model provider"
if [ -z "$PROVIDER" ]; then
  if ask; then
    say "  Which provider will drive the two small calls per turn?"
    say ""
    say "    1) openrouter  (default — one key for every model)"
    say "    2) openai"
    say "    3) groq        (fast and cheap)"
    say "    4) deepseek    (direct)"
    say "    5) together"
    say "    6) fireworks"
    say "    7) ollama      (local, no key, no cost)"
    say "    8) custom      (any OpenAI-compatible endpoint)"
    say ""
    printf '  Choice [1]: '
    read -r CHOICE
    case "${CHOICE:-1}" in
      1) PROVIDER=openrouter ;;
      2) PROVIDER=openai ;;
      3) PROVIDER=groq ;;
      4) PROVIDER=deepseek ;;
      5) PROVIDER=together ;;
      6) PROVIDER=fireworks ;;
      7) PROVIDER=ollama ;;
      8) PROVIDER=custom ;;
      *) warn "unrecognised choice, using openrouter"; PROVIDER=openrouter ;;
    esac
  else
    PROVIDER=openrouter
  fi
fi
say "  provider: $PROVIDER"

if [ "$PROVIDER" = "custom" ] && [ -z "${LEDGER_BASE_URL:-}" ]; then
  if ask; then
    printf '  Base URL (full chat-completions URL): '
    read -r LEDGER_BASE_URL
  fi
  [ -n "${LEDGER_BASE_URL:-}" ] || die "custom provider needs LEDGER_BASE_URL"
fi

if [ -z "$MODEL" ]; then
  # Only prompt when a human is actually there. Without this guard a
  # non-interactive run (agent, CI, piped stdin) blocks forever on read.
  if ask; then
    printf '  Model id (blank = provider default): '
    read -r MODEL || MODEL=""
  fi
fi
[ -n "$MODEL" ] && say "  model: $MODEL"

# ---------------------------------------------------------------- api key
step "API key"
if [ "$PROVIDER" = "ollama" ]; then
  say "  local provider — no key needed"
  API_KEY="none"
fi

if [ -z "$API_KEY" ] && [ -f "$ENV_FILE" ]; then
  say "  existing key found in $ENV_FILE — keeping it"
  say "  (delete that file and re-run to change it)"
fi

if [ -z "$API_KEY" ] && [ ! -f "$ENV_FILE" ]; then
  if ask; then
    case "$PROVIDER" in
      openrouter) say "  Get one at https://openrouter.ai/keys" ;;
      openai)     say "  Get one at https://platform.openai.com/api-keys" ;;
      groq)       say "  Get one at https://console.groq.com/keys" ;;
      deepseek)   say "  Get one at https://platform.deepseek.com/api_keys" ;;
      together)   say "  Get one at https://api.together.xyz/settings/api-keys" ;;
      fireworks)  say "  Get one at https://fireworks.ai/account/api-keys" ;;
      *)          say "  Enter the key for your endpoint" ;;
    esac
    printf '  Paste key (input hidden): '
    stty -echo 2>/dev/null || true
    read -r API_KEY
    stty echo 2>/dev/null || true
    printf '\n'
  else
    die "no key supplied and no TTY. Re-run with: ./install.sh --key <key> --provider $PROVIDER"
  fi
fi

# ---------------------------------------------------------------- install
step "Installing hook scripts"
run mkdir -p "$DEST/core" "$DEST/adapters/vscode" "$DEST/tools"

# Portable core: no framework knowledge, shared by every adapter.
for f in "$REPO_DIR"/core/*.cjs; do
  run cp "$f" "$DEST/core/$(basename "$f")"
done

# VS Code adapter: thin event translation only.
for f in "$REPO_DIR"/adapters/vscode/*.cjs; do
  run cp "$f" "$DEST/adapters/vscode/$(basename "$f")"
done

# Operator tools.
for f in caps-report.cjs cost-report.cjs; do
  run cp "$REPO_DIR/tools/$f" "$DEST/tools/$f"
done
run cp "$REPO_DIR/tools/inspect.sh" "$DEST/inspect.sh"
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
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/adapters/vscode/session.cjs", "timeoutSec": 15 }
    ],
    "userPromptSubmitted": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/adapters/vscode/prompt-submitted.cjs", "timeoutSec": 45 }
    ],
    "preToolUse": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/adapters/vscode/before-tool.cjs", "timeoutSec": 15 }
    ],
    "postToolUse": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/adapters/vscode/after-tool.cjs", "timeoutSec": 15 }
    ],
    "agentStop": [
      { "type": "command", "command": "node ~/.copilot/hooks/ledger/adapters/vscode/turn-end.cjs", "timeoutSec": 45 }
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
      printf 'LEDGER_PROVIDER=%s\n' "$PROVIDER"
      [ -n "$MODEL" ] && printf 'LEDGER_MODEL=%s\n' "$MODEL"
      [ -n "${LEDGER_BASE_URL:-}" ] && printf 'LEDGER_BASE_URL=%s\n' "$LEDGER_BASE_URL"
      printf 'LEDGER_API_KEY=%s\n' "$API_KEY"
      # Keep the OpenRouter variable populated too, so an existing setup that
      # reads it keeps working after an upgrade.
      [ "$PROVIDER" = "openrouter" ] && printf 'OPENROUTER_API_KEY=%s\n' "$API_KEY"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    say "  wrote $ENV_FILE (mode 600)"
  fi
fi

step "Installing agent instructions"

# If the user already has an instructions directory registered with VS Code,
# install there instead of creating a second one. Two registered directories
# work, but it is confusing to have the file in a place the user does not
# think of as "their" instructions folder.
find_settings_file() {
  for s in \
    "$HOME/Library/Application Support/Code/User/settings.json" \
    "$HOME/.config/Code/User/settings.json" \
    "$HOME/AppData/Roaming/Code/User/settings.json"; do
    [ -f "$s" ] && { printf '%s' "$s"; return 0; }
  done
  return 1
}

# Print the first registered instructions directory, if any.
first_registered_instructions_dir() {
  local settings="$1"
  [ -f "$settings" ] || return 1
  python3 - "$settings" <<'PY' 2>/dev/null
import json, re, sys
raw = open(sys.argv[1], encoding='utf-8').read()
s = re.sub(r'^\s*//.*$', '', raw, flags=re.M)
s = re.sub(r',(\s*[}\]])', r'\1', s)
try:
    data = json.loads(s) if s.strip() else {}
except Exception:
    sys.exit(1)
locs = data.get('chat.instructionsFilesLocations') or {}
for k in locs:
    if locs[k]:
        print(k)
        break
PY
}

if [ "$INSTRUCTIONS_DIR_SET" -eq 0 ]; then
  if SETTINGS="$(find_settings_file)"; then
    EXISTING="$(first_registered_instructions_dir "$SETTINGS" || true)"
    if [ -n "$EXISTING" ]; then
      EXISTING_EXPANDED="$(expand_tilde "$EXISTING")"
      if [ -d "$EXISTING_EXPANDED" ]; then
        INSTRUCTIONS_DIR="$EXISTING_EXPANDED"
        INSTRUCTIONS_FILE="$INSTRUCTIONS_DIR/ledger.instructions.md"
        say "  using your existing instructions directory: $EXISTING"
        say "  (override with --instructions-dir)"
      fi
    fi
  fi
fi

run mkdir -p "$INSTRUCTIONS_DIR"
run cp "$REPO_DIR/instructions/ledger.instructions.md" "$INSTRUCTIONS_FILE"
say "  installed $INSTRUCTIONS_FILE"

# Copying the file is not enough: VS Code only loads instruction files from
# directories listed in chat.instructionsFilesLocations. Without this the
# agent receives ledger nudges but never learns how to respond to them, and
# the install looks successful while being functionally half-broken.
register_instructions_dir() {
  local settings="$1"
  [ -f "$settings" ] || return 1

  # The directory we actually installed into, expressed the way a user would
  # write it in settings.json. Checking the hardcoded default here was a bug:
  # it warned even when the real target directory was already registered.
  local target_tilde
  case "$INSTRUCTIONS_DIR" in
    "$HOME"/*) target_tilde="~/${INSTRUCTIONS_DIR#"$HOME"/}" ;;
    *)         target_tilde="$INSTRUCTIONS_DIR" ;;
  esac

  if grep -q 'chat.instructionsFilesLocations' "$settings" 2>/dev/null; then
    if grep -qF "\"$target_tilde\"" "$settings" 2>/dev/null \
       || grep -qF "\"$INSTRUCTIONS_DIR\"" "$settings" 2>/dev/null; then
      say "  already registered in $(basename "$(dirname "$settings")")/settings.json"
      return 0
    fi
    warn "chat.instructionsFilesLocations exists but does not include $target_tilde"
    warn "  add this entry manually:  \"$target_tilde\": true"
    return 1
  fi

  # No existing key: append one. JSONC tolerates a trailing comma before the
  # closing brace, which is the safest way to insert without a JSON parser.
  local backup="$settings.bak.$(date +%Y%m%d%H%M%S)"
  cp "$settings" "$backup"
  python3 - "$settings" <<'PY'
import json, re, sys
path = sys.argv[1]
raw = open(path, encoding='utf-8').read()
# Strip // comments and trailing commas so json can parse JSONC.
stripped = re.sub(r'^\s*//.*$', '', raw, flags=re.M)
stripped = re.sub(r',(\s*[}\]])', r'\1', stripped)
try:
    data = json.loads(stripped) if stripped.strip() else {}
except Exception:
    sys.exit(1)
data.setdefault('chat.instructionsFilesLocations', {})['~/.copilot/instructions'] = True
open(path, 'w', encoding='utf-8').write(json.dumps(data, indent=4) + '\n')
PY
  if [ $? -eq 0 ]; then
    say "  registered ~/.copilot/instructions in settings.json"
    say "  (backup: $backup)"
    return 0
  fi
  warn "  could not parse settings.json; add this manually:"
  warn '    "chat.instructionsFilesLocations": { "~/.copilot/instructions": true }'
  return 1
}

SETTINGS_CANDIDATES=(
  "$HOME/Library/Application Support/Code/User/settings.json"
  "$HOME/.config/Code/User/settings.json"
  "$HOME/AppData/Roaming/Code/User/settings.json"
)

REGISTERED=0
for s in "${SETTINGS_CANDIDATES[@]}"; do
  if [ -f "$s" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      say "  [dry-run] would register ~/.copilot/instructions in $s"
      REGISTERED=1
    elif register_instructions_dir "$s"; then
      REGISTERED=1
    fi
    break
  fi
done

if [ "$REGISTERED" -eq 0 ]; then
  warn "no VS Code settings.json found."
  warn "Add this to your user settings so the agent can read the instructions:"
  warn '  "chat.instructionsFilesLocations": { "~/.copilot/instructions": true }'
fi

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

step "What this will cost you"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  [dry-run] would run: $DEST/inspect.sh cost"
else
  "$DEST/inspect.sh" cost || warn "cost report failed (not fatal)"
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
