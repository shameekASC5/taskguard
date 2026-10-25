---
applyTo: '**'
description: 'Open-items ledger: how to respond to hook-injected nudges about unanswered questions and incomplete tasks.'
---

# Open-Items Ledger

A hook system tracks every question and task you submit, and nudges the agent
about anything still unresolved. The agent does not maintain this state — the
hooks do. The agent's only job is to respond to the nudges.

## What you will see

Three kinds of injected text, all marked with `OPEN ITEMS (taskguard)`:

1. **At the start of a turn** — the ledger is appended to the user's prompt.
2. **After tool calls** — a reminder is appended to tool output.
3. **At the end of a turn** — if items are still open, the agent is told to continue.

Each item looks like:

```
- [q1] (question) What is the deploy command?
- [t2] (task) Fix the login bug
```

## What to do

- **Address every open item** in your response, or explicitly state why it is
  no longer needed.
- **Do not claim an item is done unless it actually is.** The end-of-turn hook
  checks the response against the ledger and will send the agent back if it
  declared completion prematurely.
- **If the user says an item is no longer needed**, say so plainly — the hook
  will mark it dropped.
- **Do not try to edit the ledger.** It is hook-owned state. Writing to
  `~/.copilot/hooks/ledger/.ledger/` will be overwritten and is not how items
  are closed.

## Why this exists

Users often submit many questions and tasks in one message. Without this
system, some get silently dropped. The ledger guarantees each one is either
answered or explicitly dismissed.
