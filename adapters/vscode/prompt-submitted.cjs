#!/usr/bin/env node
'use strict';

/**
 * VS Code Copilot adapter — userPromptSubmitted
 *
 * IMPORTANT: command-hook output is DROPPED for userPromptSubmitted, so this
 * hook cannot inject anything. It only extracts and persists. Injection
 * happens later, in before-tool.cjs (preToolUse).
 *
 * Output: {} (ignored by the harness, emitted for consistency)
 */

const { onPromptSubmitted, sessionIdFrom } = require('../../core/index.cjs');
const { readStdin, emit } = require('./_io.cjs');

async function main() {
  let event = {};
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    emit({});
    return;
  }

  await onPromptSubmitted(sessionIdFrom(event), event.prompt || '');
  emit({});
}

main().catch((err) => {
  process.stderr.write(`taskguard prompt: ${err.message}\n`);
  emit({});
});
