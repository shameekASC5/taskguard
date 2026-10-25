#!/usr/bin/env node
'use strict';

/**
 * VS Code Copilot adapter — preToolUse
 *
 * The VS Code Copilot harness does NOT fire userPromptTransformed (verified by
 * the event probe), so there is no pre-model injection point. preToolUse is the
 * earliest point whose output is honored, and it supports additionalContext.
 *
 * Output: { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *           "additionalContext": "<ledger>" } } or {}
 */

const { onBeforeTool, sessionIdFrom } = require('../../core/index.cjs');
const { readStdin, emit } = require('./_io.cjs');

function main() {
  let event = {};
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    emit({});
    return;
  }

  const result = onBeforeTool(sessionIdFrom(event));
  if (!result) {
    emit({});
    return;
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: result.additionalContext,
    },
    // Visible in chat so the user can see the ledger being injected.
    // Plain ASCII only: emoji glyphs are multi-byte and can break parsing.
    systemMessage: `TASKGUARD: ${result.openCount} open item(s) this turn`,
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`taskguard before-tool: ${err.message}\n`);
  emit({});
}
