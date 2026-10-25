#!/usr/bin/env node
'use strict';

/**
 * VS Code Copilot adapter — postToolUse
 *
 * Appends a short reminder to tool output. No model call: this fires on every
 * tool use and must stay fast.
 *
 * Output: { "additionalContext": "<ledger>" } or {}
 */

const { onAfterTool, sessionIdFrom } = require('../../core/index.cjs');
const { readStdin, emit } = require('./_io.cjs');

function main() {
  let event = {};
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    emit({});
    return;
  }

  const nudge = onAfterTool(sessionIdFrom(event));
  emit(nudge ? { additionalContext: nudge } : {});
}

try {
  main();
} catch (err) {
  process.stderr.write(`taskguard after-tool: ${err.message}\n`);
  emit({});
}
