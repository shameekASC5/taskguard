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
const { extract, reconcile, collapseDuplicates } = require('./extract.cjs');
const { trace } = require('./trace.cjs');
const llm = require('./llm.cjs');

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

  if (open.length === 0) {
    trace('core', 'turn-end-allow', { sessionId, reason: 'no-open-items' });
    return { block: false, stillOpen: [], resolved: 0, blocks: led.blockCount || 0 };
  }

  const blocks = (led.blockCount || 0) + 1;
  led.blockCount = blocks;

  if (blocks > maxBlocks) {
    ledger.save(led);
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
      trace('core', 'turn-end-allow', { sessionId, reason: 'all-resolved' });
      return { block: false, stillOpen: [], resolved: open.length, blocks };
    }
  }

  const resolved = open.length - stillOpen.length;
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
  extract,
  reconcile,
  trace,
  llm,
};
