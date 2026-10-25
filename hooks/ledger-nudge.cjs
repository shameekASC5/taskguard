#!/usr/bin/env node
'use strict';

/**
 * DURING-TURN HOOK — postToolUse
 *
 * Fires after every successful tool call. Injects a lightweight reminder of
 * open items so the agent keeps them in view while it works.
 *
 * Deliberately does NOT call the LLM — this fires on every tool call and must
 * stay fast. It only reads the ledger and renders it.
 *
 * Output: { "additionalContext": "<ledger>" }
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
  trace('ledger-nudge', 'invoked', { sessionId, hasNudge: !!nudge });

  if (!nudge) {
    emit({});
    return;
  }

  emit({ additionalContext: nudge });
}

try {
  main();
} catch (err) {
  process.stderr.write(`ledger-nudge: ${err.message}\n`);
  emit({});
}
