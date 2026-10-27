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
 * IMPORTANT: the Stop hook fires while the agent is still generating, so the
 * LAST assistant.message in the transcript is often a short preamble ("Let me
 * check that.") while the real answer is the message before it. Taking only
 * the last message meant the audit saw ~118 chars of preamble instead of
 * ~4,000 chars of evidence, and could never mark anything done.
 *
 * So we collect EVERY assistant.message from the current turn, in order, and
 * join them. A turn is bounded by turn_start/turn_end; we walk backwards to
 * the previous turn_end and take everything after it.
 *
 * Older/simpler formats ({role, content}) are also handled as a fallback.
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
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }

  // Collect the assistant text for ONE turn: from `from` up to the next
  // turn_start (or end of file).
  //
  // Stopping at the next turn_start matters. Without it every "turn" would
  // include all the turns after it, so the lengths grow monotonically, the
  // dedupe collapses everything, and the audit ends up reading a few hundred
  // chars of preamble instead of the actual answer.
  const collectFrom = (from) => {
    const out = [];
    for (let i = from; i < entries.length; i += 1) {
      const entry = entries[i];
      if (i > from && entry.type === 'assistant.turn_start') break;

      if (entry.type === 'assistant.message') {
        const content = entry.data?.content;
        if (typeof content === 'string' && content.trim()) out.push(content);
        continue;
      }
      const role = entry.role || entry.message?.role;
      if (role === 'assistant') {
        const content = entry.content ?? entry.message?.content ?? entry.text;
        if (typeof content === 'string' && content.trim()) out.push(content);
        else if (Array.isArray(content)) {
          const joined = content
            .map((c) => (typeof c === 'string' ? c : c?.text || ''))
            .join('\n');
          if (joined.trim()) out.push(joined);
        }
      }
    }
    return out.join('\n\n');
  };

  // Find the turn boundaries, newest first.
  const turnStarts = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].type === 'assistant.turn_start') turnStarts.push(i);
  }

  // The Stop hook fires while the agent is still generating, so the newest
  // turns are often empty or short preambles ("Let me check that."). The
  // evidence for what was done lives in the turns just before it.
  //
  // Three things make this harder than it looks, all observed in real
  // transcripts:
  //   - The harness re-writes the same preamble across several turns, so
  //     accumulating turns blindly collects duplicates of one sentence.
  //   - A single agent turn can span many harness turns (one per tool call),
  //     so the substantive answer can be dozens of entries back.
  //   - During a long debugging exchange, the recent turns are ALL short, so
  //     "walk back N turns" is not a reliable bound.
  //
  // So: walk back over turns, skip text we have already seen, and stop once we
  // have enough DISTINCT text. The cap is generous because the cost of reading
  // too much is a slightly larger prompt, while the cost of reading too little
  // is an audit that cannot see completed work.
  const MIN_CHARS = 6000;
  const MAX_TURNS = 200;

  const seen = new Set();
  const collected = [];
  let total = 0;

  for (const start of turnStarts.slice(0, MAX_TURNS)) {
    const text = collectFrom(start).trim();
    if (!text) continue;
    // Skip a turn whose text we have already collected (harness re-writes).
    const key = text;
    if (seen.has(key)) continue;
    seen.add(key);
    collected.unshift(text);
    total += text.length;
    if (total >= MIN_CHARS) break;
  }

  if (collected.length > 0) return collected.join('\n\n');

  // No turn_start markers at all (older format): take the whole file.
  return collectFrom(0);
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
    // The transcript is the evidence source for the turn summary. Core parses
    // it to get this turn's tool calls, so the summariser can check what the
    // agent claims against what actually ran.
    transcriptPath,
    // Where to write the session changelog. VS Code does not put the workspace
    // in the Stop event, so fall back to the process cwd, which the harness
    // sets to the workspace root.
    workspace: event.workspace_folder || event.workspaceFolder || event.cwd || process.cwd(),
  });

  if (!result.block) {
    // The turn was allowed. Still surface two things:
    //
    //   1. The review summary, when a review ran this turn. This is the
    //      evidence that the supervision actually happened — without it a
    //      clean review is invisible and you cannot tell it ran at all.
    //   2. Where to look, because the journal and changelog are only useful
    //      if you open them, and remembering three commands is friction.
    //
    // systemMessage is top-level and renders to the user, so this is the one
    // channel available on a non-blocking turn.
    const parts = [];
    if (result.systemMessage) parts.push(result.systemMessage);
    if (result.hint && process.env.LEDGER_HINT !== '0') parts.push(result.hint);

    if (parts.length) {
      emit({ systemMessage: parts.join('\n\n') });
      return;
    }
    emit({});
    return;
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      decision: 'block',
      reason: result.reason,
    },
    // On a block, the nudge is the important message, so the hint is appended
    // rather than replacing it.
    systemMessage: result.hint && process.env.LEDGER_HINT !== '0'
      ? `${result.systemMessage}\n\n${result.hint}`
      : result.systemMessage,
  });
}

main().catch((err) => {
  process.stderr.write(`taskguard turn-end: ${err.message}\n`);
  emit({});
});
