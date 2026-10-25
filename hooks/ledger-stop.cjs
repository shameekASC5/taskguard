#!/usr/bin/env node
'use strict';

/**
 * POST-HOOK — agentStop
 *
 * Fires when the agent is about to finish its turn. This is the safety net:
 * it catches the case where the agent declared itself done while items were
 * still open.
 *
 * Job:
 *   1. Read the agent's latest response from the transcript.
 *   2. Ask the LLM to reconcile each open item against that response.
 *   3. Persist verdicts (hook owns state).
 *   4. If items remain open, return decision:"block" with a reason listing
 *      them — the agent runs another turn using that reason as its prompt.
 *
 * Guards:
 *   - stop_hook_active: if the turn was already forced to continue, do not
 *     block again (prevents runaway loops; runtime caps at 8 anyway).
 *   - MAX_BLOCKS: self-limit well below the runtime cap.
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
const ledger = require('./lib/ledger.cjs');
const { reconcile } = require('./lib/extract.cjs');
const { trace } = require('./lib/trace.cjs');

const MAX_BLOCKS = 3;

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

/**
 * Pull the assistant's text out of a transcript file.
 *
 * VS Code transcript format (verified 2026-10-25):
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
    trace('ledger-stop', 'skipped-stop-hook-active', { sessionId: event.session_id || event.sessionId });
    emit({});
    return;
  }

  const sessionId = event.session_id || event.sessionId || 'default';
  const transcriptPath = event.transcript_path || event.transcriptPath;

  const led = ledger.load(sessionId);
  const open = ledger.openItems(led);
  trace('ledger-stop', 'invoked', { sessionId, openCount: open.length });
  if (open.length === 0) {
    trace('ledger-stop', 'decision-allow', { sessionId, reason: 'no-open-items' });
    emit({});
    return;
  }

  // Self-limit: count how many times we have already blocked this session.
  const blocks = (led.blockCount || 0) + 1;
  led.blockCount = blocks;
  if (blocks > MAX_BLOCKS) {
    ledger.save(led);
    trace('ledger-stop', 'decision-allow', { sessionId, reason: 'max-blocks-reached', blocks });
    emit({});
    return;
  }

  // TEST MODE: skip the LLM reconcile and always block, so the nudge and the
  // forced continuation turn can be observed deterministically.
  // Enable with `inspect.sh testmode on` (writes .force-block) or
  // LEDGER_FORCE_BLOCK=1.
  const flagPath = path.join(__dirname, '.force-block');
  const forceBlock = process.env.LEDGER_FORCE_BLOCK === '1' || fs.existsSync(flagPath);

  let stillOpen;
  if (forceBlock) {
    stillOpen = open;
    trace('ledger-stop', 'forced-block', { sessionId, openCount: open.length });
  } else {
    // Reconcile against the agent's latest response.
    const responseText = lastAssistantText(transcriptPath);
    const verdicts = await reconcile(open, responseText);
    ledger.applyVerdicts(led, verdicts);
    ledger.save(led);

    stillOpen = ledger.openItems(led);
    if (stillOpen.length === 0) {
      trace('ledger-stop', 'decision-allow', { sessionId, reason: 'all-resolved-by-reconcile' });
      emit({});
      return;
    }
  }

  const reason = [
    'You ended your turn, but these requested items are still unresolved:',
    ...stillOpen.map((i) => `- [${i.id}] (${i.kind}) ${i.text}`),
    'Address each one now, or explicitly state why it is no longer needed.',
  ].join('\n');

  const resolved = open.length - stillOpen.length;

  trace('ledger-stop', 'decision-block', {
    sessionId,
    blocks,
    stillOpen: stillOpen.length,
    resolved,
  });

  // systemMessage is surfaced to the USER in the chat, so the block is visible
  // mid-conversation instead of being invisible.
  // Plain ASCII only: emoji and bullet glyphs are multi-byte and have been
  // observed to break harness parsing.
  const systemMessage = [
    `TASKGUARD NUDGE #${blocks}: turn blocked - ${stillOpen.length} item(s) still open`,
    ...stillOpen.map((i) => `  - [${i.id}] ${i.text}`),
    resolved > 0 ? `  (${resolved} resolved this turn)` : '',
  ].filter(Boolean).join('\n');

  // The Stop hook requires decision/reason NESTED inside hookSpecificOutput.
  // A top-level decision is ignored by the harness (the systemMessage still
  // renders, which is why the warning appeared but no turn followed).
  emit({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      decision: 'block',
      reason,
    },
    systemMessage,
  });
}

main().catch((err) => {
  process.stderr.write(`ledger-stop: ${err.message}\n`);
  emit({});
});
