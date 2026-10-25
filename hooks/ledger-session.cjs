#!/usr/bin/env node
'use strict';

/**
 * SESSION HOOK — sessionStart
 *
 * Fires once when a session begins. Injects any open items from a prior
 * session so the agent starts with the ledger in view.
 *
 * This is the only injection point that does not depend on a tool call, so it
 * covers the "agent answers with no tools" case for the first turn.
 *
 * Output: { "additionalContext": "<ledger>" } or {}
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
  const nudge = ledger.renderNudge(led);
  trace('ledger-session', 'invoked', { sessionId, hasNudge: !!nudge });

  if (!nudge) {
    emit({});
    return;
  }

  // Mark as injected so preToolUse does not duplicate it on the first call.
  led.injectedForTurn = true;
  ledger.save(led);

  emit({ additionalContext: nudge });
}

try {
  main();
} catch (err) {
  process.stderr.write(`ledger-session: ${err.message}\n`);
  emit({});
}
