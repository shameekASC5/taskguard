#!/usr/bin/env node
'use strict';

/**
 * VS Code Copilot adapter — sessionStart
 *
 * Maps the VS Code event onto core.onSessionStart() and emits VS Code's
 * output shape. All logic lives in core/; this file is plumbing only.
 *
 * Output: { "additionalContext": "<ledger>" } or {}
 */

const { onSessionStart, sessionIdFrom } = require('../../core/index.cjs');
const { readStdin, emit } = require('./_io.cjs');

function main() {
  let event = {};
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    emit({});
    return;
  }

  const result = onSessionStart(sessionIdFrom(event));
  emit(result ? { additionalContext: result.additionalContext } : {});
}

try {
  main();
} catch (err) {
  process.stderr.write(`taskguard session: ${err.message}\n`);
  emit({});
}
