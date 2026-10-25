#!/usr/bin/env node
'use strict';

/**
 * EXTRACT HOOK — userPromptSubmit
 *
 * Fires when the user submits a prompt. This is the earliest point, and the
 * only one that carries the raw `prompt` text.
 *
 * IMPORTANT: command-hook output is DROPPED for userPromptSubmit, so this hook
 * cannot inject anything. It only EXTRACTS questions/tasks and writes them to
 * the ledger. Injection happens later, in ledger-inject.cjs (preToolUse).
 *
 * Output: {} (ignored by the harness, but emitted for consistency)
 */

const fs = require('node:fs');
const ledger = require('./lib/ledger.cjs');
const { extract } = require('./lib/extract.cjs');
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

async function main() {
  let event = {};
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    emit({});
    return;
  }

  const sessionId = event.session_id || event.sessionId || 'default';
  const prompt = event.prompt || '';
  trace('ledger-extract', 'invoked', { sessionId, promptLen: prompt.length });

  // Skip system/notification noise — only real user prompts carry asks.
  if (!prompt || prompt.startsWith('[Terminal ') || prompt.startsWith('[Notification')) {
    trace('ledger-extract', 'skipped-noise', { sessionId });
    emit({});
    return;
  }

  const extracted = await extract(prompt);
  trace('ledger-extract', 'extracted', { sessionId, count: extracted.length });
  const led = ledger.load(sessionId);
  ledger.mergeExtracted(led, extracted);
  // New turn: allow the inject hook to fire once more.
  led.injectedForTurn = false;
  ledger.save(led);
  trace('ledger-extract', 'saved', { sessionId, total: led.items.length });

  emit({});
}

main().catch((err) => {
  process.stderr.write(`ledger-extract: ${err.message}\n`);
  emit({});
});
