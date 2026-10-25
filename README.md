# taskguard

**A VS Code Copilot hook that stops the agent from silently dropping your questions and tasks.**

You ask three things in one message. The agent answers two and moves on. You only notice later. `taskguard` tracks every question and task you submit, and refuses to let the turn end until each one is either answered or explicitly dismissed.

```
You:  What's the deploy command? Also fix the login bug. And is the cache warm?

Agent: The deploy command is `make deploy`.

⚠ Warning from Stop hook
TASKGUARD NUDGE #2: turn blocked — 2 item(s) still open
  - [q1] What's the deploy command?
  - [t2] Fix the login bug
  - [q3] Is the cache warm?

⛔ Blocked by Stop hook
Turn ended with 2 unresolved item(s). Address each one or state why it is
no longer needed.
```

![Stop hook warning](docs/images/warning.png)

![Turn blocked](docs/images/blocked.png)

## How it works

Five hooks, three of which never touch the network:

| Event | Script | What it does | Cost |
|---|---|---|---|
| `sessionStart` | `ledger-session.cjs` | Re-injects items carried over from a previous session | free |
| `userPromptSubmitted` | `ledger-extract.cjs` | Extracts questions and tasks from your prompt | 1 small call |
| `preToolUse` | `ledger-inject.cjs` | Injects the open-items list once per turn | free |
| `postToolUse` | `ledger-nudge.cjs` | Reminds the agent mid-turn | free |
| `agentStop` | `ledger-stop.cjs` | Audits the turn; blocks if items are unresolved | 1 small call |

Two model calls per turn, both small and bounded. See [Cost](#cost).

### The audit is strict on purpose

The `agentStop` hook sends the turn's final message to a model with a deliberately harsh prompt. It defaults to `open` when uncertain, and it rejects:

- promises ("I'll do that next") — a promise is not a completion
- partial work — half a task is not a task
- mentions — describing a problem is not addressing it

It must cite evidence from the response to mark something done. If it cannot, the item stays open and the turn is blocked.

### It gives up eventually

`MAX_BLOCKS = 3`. After three blocked turns the hook stops blocking and lets the turn through, so a stubborn disagreement cannot trap you in a loop.

### Duplicates are collapsed

The extractor is a model, so the same request re-extracted in a later turn comes back paraphrased ("Create a Git repo…" vs "Create a git repository…"). `taskguard` compares the meaningful words of each item and treats a near-subset as the same ask, so you do not get `t1`/`t5` pairs for one task. Genuinely different asks ("Fix the login bug" vs "Fix the logout bug") stay separate.

## Install

Requires **Node.js 18+** and an API key for your chosen provider.

```bash
git clone https://github.com/shameekASC5/taskguard.git
cd taskguard
./install.sh
```

The installer asks which provider and model you want, prompts for the key (input hidden), writes it to `~/.copilot/hooks/ledger/.env` with mode `600`, then runs a health check, a cap check, and a cost estimate.

**Then start a new chat session.** Hook config is read once at session start, so it will not work in the session you installed from.

### Non-interactive (for agents and CI)

```bash
./install.sh --key sk-or-v1-... --provider openrouter --model deepseek/deepseek-v4.1-flash
```

Set `LEDGER_NONINTERACTIVE=1` to guarantee no prompt ever blocks, even if stdin looks like a terminal.

### Other flags

```bash
./install.sh --dry-run     # show every action, change nothing
./install.sh --uninstall   # remove everything this script installed
```

Re-running `install.sh` is safe. It backs up any existing `ledger.json` first.

### Letting an agent install it

Paste this into a Copilot chat:

> Clone https://github.com/shameekASC5/taskguard, read the README, and install
> it. Ask me which provider and model I want and for the API key — do not invent
> one. Run `./install.sh --key <key> --provider <p> --model <m>`, then
> `~/.copilot/hooks/ledger/inspect.sh doctor`, and report the result.

The installer is non-interactive with `--key`, prints a clear pass/fail health check, and exits non-zero on failure, so an agent can verify its own work.

## Choosing a model and provider

**OpenRouter is the default, not a requirement.** Any endpoint that speaks the OpenAI chat-completions shape works.

| Provider | `--provider` | Notes |
|---|---|---|
| OpenRouter | `openrouter` | One key for every model. Default. |
| OpenAI | `openai` | |
| Groq | `groq` | Very fast, cheap |
| DeepSeek | `deepseek` | Direct, cheapest for DeepSeek models |
| Together | `together` | |
| Fireworks | `fireworks` | |
| Ollama | `ollama` | Local, no key, no cost |
| Custom | `custom` | Any OpenAI-compatible URL |

The default model is **`deepseek/deepseek-v4.1-flash`** — cheap, fast, and reliable at JSON output, which is all these two calls need.

If you switch provider but leave an OpenRouter-style model id configured, `taskguard` warns and falls back to that provider's default rather than sending a request that is guaranteed to 404.

### Configuration

All optional, all in `~/.copilot/hooks/ledger/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `LEDGER_PROVIDER` | `openrouter` | Provider preset |
| `LEDGER_MODEL` | provider default | Model id |
| `LEDGER_API_KEY` | — | Key for the chosen provider |
| `LEDGER_BASE_URL` | — | Full chat-completions URL (overrides provider) |
| `LEDGER_MAX_PROMPT_CHARS` | `16000` | Extract input cap |
| `LEDGER_MAX_RESPONSE_CHARS` | `12000` | Audit input cap |
| `LEDGER_PRICE_IN` | from table | USD per 1M input tokens |
| `LEDGER_PRICE_OUT` | from table | USD per 1M output tokens |
| `LEDGER_TRACE` | `1` | Set `0` to disable the trace log |
| `LEDGER_FORCE_BLOCK` | `0` | Set `1` to force a block (testing) |

The `.env` file wins over shell environment variables, so a stale exported key cannot silently shadow the real one.

## Cost

Two model calls per turn, both capped:

| Call | Input cap | Output cap |
|---|---|---|
| Extract | 16,000 chars (~4k tokens) | 512 tokens |
| Audit | 12,000 chars (~3k tokens) | 512 tokens |

Worst case is roughly **7k input + 1k output tokens per turn**. The other three hooks are local file reads and cost nothing.

The extract call sends **only your prompt text** — not the conversation, not file contents, not tool output.

### What that means in dollars

Run `inspect.sh cost` and it measures your own history, applies the caps, multiplies by the model's price, and multiplies by your average session length:

```
=== taskguard cost estimate ===
model:  deepseek/deepseek-v4.1-flash
price:  $0.07/M in, $0.28/M out

measured from 68 transcripts:
  average session: 33.9 turns
  average prompt:  2845 chars
  average reply:   196 chars

Two extra model calls per turn (extract + audit):
  typical turn:  $0.00034
  worst case:    $0.00078   (both inputs at the cap)

Across an average session of 33.9 turns:
  typical:       $0.0115
  worst case:    $0.0263
```

About **a cent per session**. A single Copilot turn on a frontier model typically costs more than an entire session of this overhead.

Override the prices if your provider differs:

```bash
LEDGER_PRICE_IN=0.07 LEDGER_PRICE_OUT=0.28
```

### Are the caps right for you?

Defaults were measured against 2,229 real prompts and 30,281 real responses:

| | p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|
| Prompts | 184 | 3,506 | 12,087 | 52,848 | 685,035 |
| Responses | 80 | 337 | 672 | 2,671 | 59,223 |

Prompt length has a very long tail (mean 2,829, sd 16,953). At a 16,000-char cap about **4% of prompts are truncated**; at 8,000 it was closer to 10%.

Run `inspect.sh caps` to measure your own history. It reports the truncation rate and suggests a cap if yours is too low. Truncation only affects the ledger's view of the text — never your actual conversation — but a truncated prompt can yield fewer extracted items.

## Verify it works

Ask one message containing both a question and a task:

> What is the deploy command? Also fix the typo in README.

You should see the ledger injected before the first tool call. If the agent answers only the question, the Stop hook blocks the turn.

### Commands

```bash
~/.copilot/hooks/ledger/inspect.sh           # open items right now
~/.copilot/hooks/ledger/inspect.sh doctor    # health check + live extraction test
~/.copilot/hooks/ledger/inspect.sh caps      # are the input caps right for you?
~/.copilot/hooks/ledger/inspect.sh cost      # what will this cost per turn/session?
~/.copilot/hooks/ledger/inspect.sh trace     # what each hook actually did
~/.copilot/hooks/ledger/inspect.sh decisions # every block/allow decision
~/.copilot/hooks/ledger/inspect.sh watch     # follow the trace live
~/.copilot/hooks/ledger/inspect.sh clear     # wipe ledgers and logs
```

If something looks wrong, `doctor` is the first thing to run. It checks the key, the model, and performs a real extraction against a known input.

## Development

```bash
npm install
npm test
```

26 tests, no network access required. The hook scripts are executed as real
child processes with a JSON event on stdin — exactly how VS Code invokes them —
and the model is stubbed by a local HTTP server. That covers the full contract:
stdin parsing, ledger persistence, stdout JSON shape, and the block/nudge
decisions.

CI runs the suite on Node 18/20/22 across Linux and macOS, plus a hygiene job
that fails the build if a credential or a local machine path is ever committed.

## How state is stored

One JSON file per session in `~/.copilot/hooks/ledger/.ledger/`, named by the session UUID. Sessions are independent — two windows never share a ledger.

Ledgers are pruned when **every** item in them is resolved (done or dropped). Age is not used, because sessions can legitimately run for days. An unresolved item is never deleted by pruning.

## Troubleshooting

**Nothing happens.**
Hook config is read at session start. Start a new chat. Then run `inspect.sh trace` — if it is empty, the hooks are not firing at all.

**Ledger is always empty.**
Run `inspect.sh doctor`. A 401 means a bad key. A 404 means the model id does not exist at that provider.

**The agent is blocked but the item really is done.**
The audit is strict by design. Have the agent state the evidence explicitly ("Done: changed X in file Y, tests pass"). Vague claims get rejected.

**Turn blocked three times in a row.**
That is the cap. The turn is released. If this happens often, the audit prompt may be too strict for your workflow — open an issue with the trace output.

**I see the same task twice.**
Fixed in the current version. If you still see it, the two items are probably worded differently enough to look distinct — send the trace output in an issue.

## Uninstall

```bash
./install.sh --uninstall
```

Removes the hook config, the scripts, and the instruction file. Your `.env` and ledgers go with the directory.

## License

MIT
