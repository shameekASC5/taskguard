'use strict';

/**
 * taskguard core — framework-agnostic enforcement logic.
 *
 * NOTHING in this directory knows what VS Code, Claude Code, Cursor, or any
 * other harness is. It deals only in plain data:
 *
 *   extract(prompt)                  -> [{ kind, text }]
 *   mergeExtracted(ledger, items)    -> ledger
 *   reconcile(openItems, response)   -> [{ id, status, note }]
 *   renderNudge(ledger)              -> string
 *
 * An adapter is responsible for three things and nothing else:
 *   1. Reading the harness event (stdin JSON, SDK callback, whatever).
 *   2. Calling the functions above.
 *   3. Emitting the harness's own output shape.
 *
 * See docs/ADAPTERS.md for how to write one.
 */

const ledger = require('./ledger.cjs');
const { extract, reconcile, collapseDuplicates, summariseTurn } = require('./extract.cjs');
const { trace } = require('./trace.cjs');
const llm = require('./llm.cjs');
const journal = require('./journal.cjs');
const changelog = require('./changelog.cjs');

/**
 * Collapse semantic duplicates once the ledger has this many open items.
 *
 * Below this, the lexical rules in ledger.cjs handle the common cases for
 * free. Above it, the ledger is big enough that a wrong duplicate is costly
 * (noisy nudges, and an audit that cannot resolve anything), so it is worth
 * one extra small model call.
 */
const COLLAPSE_MIN_OPEN = 12;

/**
 * The five lifecycle moments an adapter must map onto its harness.
 *
 * These names are the contract. An adapter that cannot express one of them
 * should say so in its README rather than silently skipping it — the
 * enforcement guarantee depends on all five.
 */
const LIFECYCLE = {
  /** A session began. Inject carried-over items. */
  SESSION_START: 'sessionStart',
  /** The user submitted a prompt. Extract asks from it. */
  PROMPT_SUBMITTED: 'promptSubmitted',
  /** The agent is about to use a tool. Inject the ledger once per turn. */
  BEFORE_TOOL: 'beforeTool',
  /** A tool finished. Optionally remind the agent. */
  AFTER_TOOL: 'afterTool',
  /** The agent is about to end its turn. Audit and possibly block. */
  TURN_END: 'turnEnd',
};

/**
 * Normalise whatever the harness calls a session into a stable id.
 *
 * Every adapter must supply one. Without it, ledgers from different sessions
 * would collide and the tool would be worse than useless.
 */
function sessionIdFrom(event, fallback = 'default') {
  const raw = event?.session_id
    ?? event?.sessionId
    ?? event?.session?.id
    ?? event?.conversation_id
    ?? event?.thread_id
    ?? fallback;
  return String(raw || fallback);
}

/**
 * SESSION_START — inject items carried over from a previous session.
 *
 * @returns {{ additionalContext: string } | null} null means "say nothing".
 */
function onSessionStart(sessionId) {
  const led = ledger.load(sessionId);
  const nudge = ledger.renderNudge(led);
  trace('core', 'session-start', { sessionId, hasNudge: !!nudge });
  if (!nudge) return null;

  // Mark injected so the first tool call does not repeat it.
  led.injectedForTurn = true;
  ledger.save(led);
  return { additionalContext: nudge };
}

/**
 * PROMPT_SUBMITTED — extract questions and tasks from the user's prompt.
 *
 * Also re-arms the turn: clears `injectedForTurn` so the ledger can be
 * injected again, and resets `blockCount` so the Stop hook's budget is per
 * turn rather than per session.
 *
 * @returns {Promise<{ items: Array, total: number }>}
 */
async function onPromptSubmitted(sessionId, prompt) {
  const text = String(prompt || '');

  // Skip system/notification noise — only real user prompts carry asks.
  if (!text || text.startsWith('[Terminal ') || text.startsWith('[Notification')) {
    trace('core', 'prompt-skipped-noise', { sessionId });
    return { items: [], total: ledger.load(sessionId).items.length };
  }

  const items = await extract(text);
  const led = ledger.load(sessionId);
  ledger.mergeExtracted(led, items);
  led.injectedForTurn = false;
  led.blockCount = 0;

  // Semantic dedupe, only when the ledger is big enough to justify a call.
  // Lexical matching cannot catch rewordings that share little vocabulary,
  // and a bloated ledger makes every nudge noisy and the audit ineffective.
  const open = ledger.openItems(led);
  if (open.length >= COLLAPSE_MIN_OPEN) {
    const groups = await collapseDuplicates(open);
    const merged = ledger.applyCollapseGroups(led, groups);
    if (merged > 0) {
      trace('core', 'prompt-collapsed', { sessionId, merged, openBefore: open.length });
    }
  }

  ledger.save(led);

  trace('core', 'prompt-extracted', { sessionId, count: items.length, total: led.items.length });
  return { items, total: led.items.length };
}

/**
 * BEFORE_TOOL — inject the open-items list, once per turn.
 *
 * @returns {{ additionalContext: string, openCount: number } | null}
 */
function onBeforeTool(sessionId) {
  const led = ledger.load(sessionId);
  if (led.injectedForTurn) {
    trace('core', 'before-tool-skipped', { sessionId });
    return null;
  }

  const nudge = ledger.renderNudge(led);
  if (!nudge) return null;

  led.injectedForTurn = true;
  ledger.save(led);
  const openCount = ledger.openItems(led).length;
  trace('core', 'before-tool-injected', { sessionId, openCount });
  return { additionalContext: nudge, openCount };
}

/**
 * AFTER_TOOL — a short reminder appended to tool output.
 *
 * @returns {string | null}
 */
function onAfterTool(sessionId) {
  const led = ledger.load(sessionId);
  const nudge = ledger.renderNudge(led);
  trace('core', 'after-tool', { sessionId, hasNudge: !!nudge });
  return nudge || null;
}

/**
 * TURN_END — audit the agent's final message and decide whether to block.
 *
 * This is the enforcement point. Everything else is advisory.
 *
 * @param {string} sessionId
 * @param {string} responseText  The agent's final message for this turn.
 * @param {object} [opts]
 * @param {number} [opts.maxBlocks=3]  Give up after this many blocks.
 * @param {boolean} [opts.forceBlock]  Skip the audit and always block (tests).
 * @returns {Promise<{ block: boolean, reason?: string, systemMessage?: string,
 *                     stillOpen: Array, resolved: number, blocks: number }>}
 */
async function onTurnEnd(sessionId, responseText, opts = {}) {
  const maxBlocks = Number.isFinite(opts.maxBlocks) ? opts.maxBlocks : 3;
  const led = ledger.load(sessionId);
  const open = ledger.openItems(led);

  // Derive this turn's tool timeline from the transcript, if we have one.
  //
  // The transcript is the source of truth for what actually ran. We use it
  // rather than our own PreToolUse records because the harness already logs
  // every call with a real timestamp and structured arguments, and because it
  // is complete even for turns where our hooks did not fire.
  const turnEvidence = opts.transcriptPath
    ? lastTurnEvidence(opts.transcriptPath)
    : { tools: [], assistantText: String(responseText || '') };

  if (open.length === 0) {
    // Record quiet turns too, otherwise the timeline has gaps and a replay
    // cannot distinguish "nothing happened" from "we did not look".
    journal.recordTurn(sessionId, {
      turn: journal.turnCount(sessionId) + 1,
      summary: 'No open items at turn start.',
      toolCount: turnEvidence.tools.length,
      openCount: 0,
      resolved: 0,
      blocked: false,
    });
    writeChangelog(sessionId, opts.workspace);
    trace('core', 'turn-end-allow', { sessionId, reason: 'no-open-items' });
    return { block: false, stillOpen: [], resolved: 0, blocks: led.blockCount || 0 };
  }

  const blocks = (led.blockCount || 0) + 1;
  led.blockCount = blocks;

  if (blocks > maxBlocks) {
    ledger.save(led);
    await recordTurnReport(sessionId, open, turnEvidence, {
      openCount: open.length, resolved: 0, blocked: false, workspace: opts.workspace,
    });
    trace('core', 'turn-end-allow', { sessionId, reason: 'max-blocks', blocks });
    return { block: false, stillOpen: open, resolved: 0, blocks };
  }

  let stillOpen;
  if (opts.forceBlock) {
    stillOpen = open;
    trace('core', 'turn-end-forced', { sessionId, openCount: open.length });
  } else {
    const verdicts = await reconcile(open, String(responseText || ''));
    ledger.applyVerdicts(led, verdicts);
    ledger.save(led);
    stillOpen = ledger.openItems(led);
    if (stillOpen.length === 0) {
      await recordTurnReport(sessionId, open, turnEvidence, {
        openCount: 0, resolved: open.length, blocked: false, workspace: opts.workspace,
      });
      trace('core', 'turn-end-allow', { sessionId, reason: 'all-resolved' });
      return { block: false, stillOpen: [], resolved: open.length, blocks };
    }
  }

  const resolved = open.length - stillOpen.length;
  await recordTurnReport(sessionId, open, turnEvidence, {
    openCount: stillOpen.length, resolved, blocked: true, workspace: opts.workspace,
  });
  trace('core', 'turn-end-block', { sessionId, blocks, stillOpen: stillOpen.length, resolved });

  return {
    block: true,
    reason: [
      'You ended your turn, but these requested items are still unresolved:',
      ...stillOpen.map((i) => `- [${i.id}] (${i.kind}) ${i.text}`),
      'Address each one now, or explicitly state why it is no longer needed.',
    ].join('\n'),
    systemMessage: [
      `TASKGUARD NUDGE #${blocks}: turn blocked - ${stillOpen.length} item(s) still open`,
      ...stillOpen.map((i) => `  - [${i.id}] ${i.text}`),
      resolved > 0 ? `  (${resolved} resolved this turn)` : '',
    ].filter(Boolean).join('\n'),
    stillOpen,
    resolved,
    blocks,
  };
}

/**
 * Pull the most recent user turn's evidence out of a transcript.
 *
 * Returns the tool calls and the agent's prose for that turn only. This is
 * what makes the summary turn-scoped: we hand the summariser one turn, never
 * the accumulated session.
 */
function lastTurnEvidence(transcriptPath, parserName) {
  const turns = journal.parseTurns(transcriptPath, parserName);
  const last = turns[turns.length - 1];
  if (!last) return { tools: [], assistantText: '' };
  return { tools: last.tools, assistantText: last.assistantText };
}

/**
 * Summarise the turn and append it to the journal.
 *
 * Runs as a separate model call with a fresh context — see SUMMARY_SYSTEM in
 * extract.cjs for why the agent is not asked to report on itself.
 *
 * Never throws: a failed summary must not break enforcement.
 */
async function recordTurnReport(sessionId, openAtStart, evidence, outcome) {
  // LEDGER_JOURNAL=0 keeps the ledger and the audit but skips the progress
  // summary, which is the only part of the journal that costs a model call.
  // The tool timeline still comes from the transcript for free.
  if (process.env.LEDGER_JOURNAL === '0') {
    journal.recordTurn(sessionId, {
      turn: journal.turnCount(sessionId) + 1,
      summary: '(journal disabled)',
      toolCount: evidence.tools.length,
      openCount: outcome.openCount,
      resolved: outcome.resolved,
      blocked: outcome.blocked,
    });
    return;
  }

  let report = null;
  try {
    report = await summariseTurn({
      openAtStart,
      tools: evidence.tools,
      assistantText: evidence.assistantText,
    });
  } catch {
    // Fall through with a null report; the turn is still recorded.
  }

  journal.recordTurn(sessionId, {
    turn: journal.turnCount(sessionId) + 1,
    headline: report?.headline || '',
    summary: report?.summary || '(summary unavailable)',
    completed: report?.completed || [],
    blockers: report?.blockers || [],
    next: report?.next || [],
    files: report?.files || [],
    toolCount: evidence.tools.length,
    openCount: outcome.openCount,
    resolved: outcome.resolved,
    blocked: outcome.blocked,
  });

  writeChangelog(sessionId, outcome.workspace);
}

/**
 * Persist the session as a changelog.
 *
 * Runs every turn; the file is rewritten in place so it stays current rather
 * than fragmenting into one file per turn.
 *
 * Deliberately NOT gated on "did the agent change code". A session that only
 * searched your filesystem still did work, and a git-diff-only changelog would
 * record nothing for it. The record is classified by activity instead.
 *
 * Never throws: a changelog failure must not break enforcement.
 */
function writeChangelog(sessionId, workspace) {
  if (process.env.LEDGER_CHANGELOG === '0') return;
  try {
    const cwd = workspace || process.cwd();
    changelog.write({
      sessionId,
      workspace: cwd,
      gitRoot: changelog.gitRoot(cwd),
      turns: journal.readProgress(sessionId),
      tools: journal.readTelemetry(sessionId),
    });
  } catch {
    // Never let a changelog failure break enforcement.
  }
}

module.exports = {
  LIFECYCLE,
  sessionIdFrom,
  onSessionStart,
  onPromptSubmitted,
  onBeforeTool,
  onAfterTool,
  onTurnEnd,
  // Re-exported so adapters need only one require.
  ledger,
  journal,
  extract,
  reconcile,
  summariseTurn,
  trace,
  llm,
};
