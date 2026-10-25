# Writing an adapter

`taskguard` is split so that porting it to a new agent framework is a small,
mechanical job. The enforcement logic lives in `core/` and knows nothing about
any harness. An adapter is a thin translation layer.

**If you are an agent asked to port this:** read this file, then read
`adapters/vscode/` as the reference implementation. It is about 250 lines total
and most of it is comments.

---

## The contract

`core/index.cjs` exports five functions. Your adapter calls them; they never
call you.

| Function | When to call it | What it returns |
|---|---|---|
| `onSessionStart(sessionId)` | A session begins | `{ additionalContext }` or `null` |
| `onPromptSubmitted(sessionId, prompt)` | User submits a prompt | `Promise<{ items, total }>` |
| `onBeforeTool(sessionId)` | Agent is about to use a tool | `{ additionalContext, openCount }` or `null` |
| `onAfterTool(sessionId)` | A tool finished | `string` or `null` |
| `onTurnEnd(sessionId, responseText, opts)` | Agent is about to end its turn | `Promise<{ block, reason, systemMessage, ... }>` |

`null` / `block: false` means "say nothing, allow the turn". Always emit your
harness's empty response in that case.

### `sessionId` is mandatory

Every call needs a stable per-conversation id. Use `sessionIdFrom(event)` if
your harness puts it somewhere conventional, otherwise pass your own. Without
it, ledgers from different conversations collide.

### `onTurnEnd` is the only one that enforces

The other four are advisory. If your harness has no equivalent of a
"turn is ending, may I block it?" hook, you can still ship a useful adapter —
but say so in your README, because the guarantee is weaker.

---

## Step 1 — find your harness's hook points

You need to map five lifecycle moments onto whatever your framework exposes:

| Lifecycle | What you need from the harness |
|---|---|
| `SESSION_START` | A callback when a conversation begins |
| `PROMPT_SUBMITTED` | The raw user prompt text |
| `BEFORE_TOOL` | A callback before a tool runs, ideally able to inject context |
| `AFTER_TOOL` | A callback after a tool runs |
| `TURN_END` | A callback before the agent finishes, able to **block and re-prompt** |

`TURN_END` is the one that matters. It must be able to:
1. Read the agent's final message for the turn.
2. Return a decision that forces another turn, with a reason string.

If your framework cannot do #2, the tool degrades to a reminder system.

## Step 2 — copy the reference adapter

```bash
cp -r adapters/vscode adapters/<your-framework>
```

Then rewrite each file. They are small on purpose:

| File | Lines | What to change |
|---|---|---|
| `_io.cjs` | ~20 | How you read the event and write the response |
| `session.cjs` | ~30 | Event → `onSessionStart` → your output shape |
| `prompt-submitted.cjs` | ~30 | Event → `onPromptSubmitted` → your output shape |
| `before-tool.cjs` | ~40 | Event → `onBeforeTool` → your output shape |
| `after-tool.cjs` | ~30 | Event → `onAfterTool` → your output shape |
| `turn-end.cjs` | ~120 | Event → extract final message → `onTurnEnd` → block decision |

Most of `turn-end.cjs` is the transcript parser. If your harness hands you the
final message directly, delete that function and you are down to ~30 lines.

## Step 3 — get the final message

`onTurnEnd` needs the agent's final text for the turn. Three common shapes:

**A. The harness gives it to you** (best):
```js
const result = await onTurnEnd(sessionId, event.lastMessage, { maxBlocks: 3 });
```

**B. You read a transcript file** (VS Code):
See `lastAssistantText()` in `adapters/vscode/turn-end.cjs`. The subtlety is
that a turn spans several messages interleaved with tool calls, so you must
collect all assistant messages from the *last* turn — walking backwards and
stopping at the *second* turn boundary, not the first.

**C. You accumulate it yourself**: keep a per-session buffer, append each
assistant message, clear it on `onPromptSubmitted`.

## Step 4 — emit the block decision

This is where harnesses differ most, and where silent failures happen. The
decision must go in the exact field your harness reads. A wrong shape usually
does not error — it just does nothing.

VS Code, for example, requires the decision **nested**:

```js
// CORRECT for VS Code
emit({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    decision: 'block',
    reason: result.reason,
  },
  systemMessage: result.systemMessage,
});

// WRONG — silently ignored. The warning renders, but no turn is forced.
emit({ decision: 'block', reason: result.reason });
```

**Verify this empirically.** Trigger a block and confirm a new turn actually
starts. Do not trust the docs alone; several harnesses have shipped
inconsistent shapes.

## Step 5 — test it

Copy `test/hook-scripts.test.js` and point `ADAPTER_DIR` at your adapter. The
tests spawn your scripts as real child processes with a JSON event on stdin and
a stubbed model, so they validate the full contract without network access.

At minimum, assert:

- [ ] Every script emits valid JSON and exits 0 on malformed input
- [ ] `prompt-submitted` persists extracted items
- [ ] `before-tool` injects once per turn, not on every tool call
- [ ] `turn-end` blocks when items are open
- [ ] `turn-end` allows when nothing is open
- [ ] `turn-end` releases after `maxBlocks`
- [ ] `blockCount` resets on a new prompt

## Step 6 — document the gaps

Add a short section to your adapter's README stating:

- Which lifecycle moments your harness supports.
- Which are missing, and what that costs the user.
- Any harness-specific quirks (event names, output shapes, timing).

Honesty here is more useful than a green checkmark. A user who knows
`TURN_END` is unsupported can decide whether the reminder-only mode is still
worth installing.

---

## Reference: the VS Code adapter's quirks

Worth knowing because they are the kind of thing you will hit too.

| Quirk | Detail |
|---|---|
| Event name | `userPromptSubmitted`, **not** `userPromptSubmit`. An unknown event name is silently ignored. |
| No pre-model hook | `userPromptTransformed` does not fire in VS Code, so injection happens at `preToolUse` instead. |
| Dropped output | `userPromptSubmitted` output is discarded — that hook can only persist, never inject. |
| Nested decision | `Stop` requires `decision` inside `hookSpecificOutput`. |
| Config is read once | Hook config is loaded at session start; edits need a new chat session. |
| ASCII only | Emoji in `systemMessage` has been observed to break parsing. |
