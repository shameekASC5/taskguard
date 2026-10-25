#!/usr/bin/env node
'use strict';

/**
 * VS Code Copilot adapter — agentStop
 *
 * The enforcement point. Reads the agent's final message from the transcript,
 * asks core to audit it, and blocks the turn if items remain open.
 *
 * Output: { "hookSpecificOutput": { "hookEventName": "Stop",
 *           "decision": "block", "reason": "..." }, "systemMessage": "..." }
 * or {}.
 *
 * NOTE: decision/reason MUST be nested in hookSpecificOutput. A top-level
 * decision is silently ignored — the systemMessage still renders, so the
 * warning appears but no continuation turn is forced.
 */

const fs = require('node:fs');
const path = require('node:path');
const { onTurnEnd, sessionIdFrom } = require('../../core/index.cjs');
const { readStdin, emit } = require('./_io.cjs');

const MAX_BLOCKS = 3;

/**
 * Pull the assistant's text out of a VS Code transcript file.
 *
 * Format (verified 2026-10-25):
 *   { type: "assistant.message", data: { content, messageId, toolRequests } }
 *   { type: "assistant.turn_start" | "assistant.turn_end" | "tool.execution_*" }
 *
 * We collect ALL assistant.message content from the LAST turn, because a turn
 * can span several messages interleaved with tool calls. Older/simpler formats
 * ({role, content}) are also handled as a fallback.
 */
function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }

  const lines = raw.split('\n').filter(Boolean);
  const parts = [];

  // Walk backwards. The last turn looks like:
  //   assistant.turn_start
  //   tool.execution_start / tool.execution_complete
  //   assistant.message          <- the text we want
  //   assistant.turn_end
  // So we must NOT stop at turn_start; we stop at the PREVIOUS turn_end.
  let seenTurnEnd = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (entry.type === 'assistant.turn_end') {
      if (seenTurnEnd) break; // reached the end of the previous turn
      seenTurnEnd = true;
      continue;
    }

    if (entry.type === 'assistant.message') {
      const content = entry.data?.content;
      if (typeof content === 'string' && content.trim()) parts.unshift(content);
      continue;
    }

    // Fallback: simple {role, content} format.
    const role = entry.role || entry.message?.role;
    if (role === 'assistant') {
      const content = entry.content ?? entry.message?.content ?? entry.text;
      if (typeof content === 'string' && content.trim()) parts.unshift(content);
      else if (Array.isArray(content)) {
        const joined = content
          .map((c) => (typeof c === 'string' ? c : c?.text || ''))
          .join('\n');
        if (joined.trim()) parts.unshift(joined);
      }
    }
  }

  return parts.join('\n\n');
}

async function main() {
  let event = {};
  try {
    event = JSON.parse(readStdin() || '{}');
  } catch {
    emit({});
    return;
  }

  // Guard: never block twice in a row for the same forced continuation.
  if (event.stop_hook_active === true) {
    emit({});
    return;
  }

  const sessionId = sessionIdFrom(event);
  const transcriptPath = event.transcript_path || event.transcriptPath;

  // TEST MODE: skip the audit and always block, so the nudge and the forced
  // continuation turn can be observed deterministically.
  // Enable with `inspect.sh testmode on` (writes .force-block) or
  // LEDGER_FORCE_BLOCK=1.
  const flagPath = path.join(__dirname, '.force-block');
  const forceBlock = process.env.LEDGER_FORCE_BLOCK === '1' || fs.existsSync(flagPath);

  const result = await onTurnEnd(sessionId, lastAssistantText(transcriptPath), {
    maxBlocks: MAX_BLOCKS,
    forceBlock,
  });

  if (!result.block) {
    emit({});
    return;
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      decision: 'block',
      reason: result.reason,
    },
    systemMessage: result.systemMessage,
  });
}

main().catch((err) => {
  process.stderr.write(`taskguard turn-end: ${err.message}\n`);
  emit({});
});
