#!/usr/bin/env node
'use strict';

/**
 * INJECT HOOK — preToolUse
 *
 * The VS Code Copilot harness does NOT fire userPromptTransformed (verified by
 * the event probe), so there is no pre-model injection point. preToolUse is the
 * earliest point whose output is honored, and it supports additionalContext.
 *
 * This hook injects the open-items ledger before the first tool call of a turn,
 * then stays quiet for the rest of the turn (postToolUse handles the rest).
 *
 * Output: { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *           "additionalContext": "<ledger>" } } or {}
 */

const fs = require('node:fs');
const ledger = require('./lib/ledger.cjs');
const { trace } = require('./lib/trace.cjs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit(obj) {
  // Trailing newline: some harnesses require a terminated line to parse stdout.
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function main() {
  let event = {};
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    emit({});
    return;
  }

  const sessionId = event.session_id || event.sessionId || 'default';
  const led = ledger.load(sessionId);
  trace('ledger-inject', 'invoked', { sessionId, injectedForTurn: !!led.injectedForTurn });

  // Inject once per turn: only on the first tool call after a prompt.
  // `injectedForTurn` is reset by ledger-extract.cjs on each new prompt.
  if (led.injectedForTurn) {
    trace('ledger-inject', 'skipped-already-injected', { sessionId });
    emit({});
    return;
  }

  const nudge = ledger.renderNudge(led);
  if (!nudge) {
    trace('ledger-inject', 'skipped-no-open-items', { sessionId });
    emit({});
    return;
  }

  led.injectedForTurn = true;
  ledger.save(led);
  const openCount = ledger.openItems(led).length;
  trace('ledger-inject', 'injected', { sessionId, openCount });

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: nudge,
    },
    // Visible in chat so the user can see the ledger being injected.
    // Plain ASCII only: emoji glyphs are multi-byte and can break parsing.
    systemMessage: `TASKGUARD: ${openCount} open item(s) this turn`,
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`ledger-inject: ${err.message}\n`);
  emit({});
}
