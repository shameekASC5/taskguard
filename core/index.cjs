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
const review = require('./review.cjs');

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
 * How often to run an adversarial review, in turns.
 *
 * A review is an INVESTIGATOR, not a classifier: it extracts claims, plans
 * checks, then runs 5-15 tool calls with 20k-60k input tokens accumulating.
 * Measured at ~$0.02 per review, versus ~$0.0005 for a normal turn — 40x.
 *
 * Measured against real history (32-turn average session):
 *
 *   every 1   -> 33 reviews, $0.68/session   (review is 98% of cost)
 *   every 5   ->  7 reviews, $0.14/session   (review is 90% of cost)
 *   every 10  ->  4 reviews, $0.08/session   (review is 84% of cost)
 *   every 20  ->  2 reviews, $0.04/session   (review is 72% of cost)
 *   off       ->  1 review,  $0.02/session   (final turn only)
 *
 * 10 is the default: four reviews across a long session, and the review cost
 * stays under 85% of a total that is still cents. At 5 the review dominates
 * everything else the system does, which is hard to justify for a supervision
 * layer.
 *
 * The FINAL turn is always reviewed regardless of this setting, because that
 * is where the agent summarises and claims completion — the highest-value
 * review point.
 *
 * Set LEDGER_REVIEW_EVERY=0 for final-turn-only, or 1 for every turn.
 */
const REVIEW_EVERY_DEFAULT = 10;

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
 * Build the "where to look" hint shown in chat after a turn.
 *
 * The problem this solves: the journal and changelog are only useful if you
 * actually look at them, and remembering three commands per session is
 * friction that guarantees you will not.
 *
 * The session id is included in every command rather than using --latest,
 * because --latest is wrong the moment you have two sessions open — it would
 * show whichever wrote most recently, not the one you are reading.
 *
 * @param {string} sessionId
 * @param {object} stats  { turns, tools, kind, changelogPath }
 * @returns {string}
 */
function renderLookHint(sessionId, stats = {}) {
  const short = String(sessionId).slice(0, 8);
  const tools = '~/.copilot/hooks/ledger/tools';

  const lines = [
    `TASKGUARD — session ${short} · ${stats.turns || 0} turn(s) · ${stats.tools || 0} tool call(s)`,
  ];

  if (stats.kind) lines.push(`  activity: ${stats.kind}`);

  lines.push('');
  lines.push('  Replay this session (step through):');
  lines.push(`    node ${tools}/replay.cjs ${sessionId} --step`);
  lines.push('  Replay the last 3 turns only:');
  lines.push(`    node ${tools}/replay.cjs ${sessionId} --last 3`);
  lines.push('  Read the changelog (no writes):');
  lines.push(`    node ${tools}/changelog.cjs --show ${sessionId}`);
  if (stats.changelogPath) {
    lines.push(`    ${stats.changelogPath}`);
  }
  lines.push('  All sessions:');
  lines.push(`    node ${tools}/changelog.cjs --list`);

  return lines.join('\n');
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
    const stats = writeChangelog(sessionId, opts.workspace);
    trace('core', 'turn-end-allow', { sessionId, reason: 'no-open-items' });
    return {
      block: false,
      stillOpen: [],
      resolved: 0,
      blocks: led.blockCount || 0,
      hint: renderLookHint(sessionId, stats),
    };
  }

  const blocks = (led.blockCount || 0) + 1;
  led.blockCount = blocks;

  if (blocks > maxBlocks) {
    ledger.save(led);
    const stats = await recordTurnReport(sessionId, open, turnEvidence, {
      openCount: open.length, resolved: 0, blocked: false, workspace: opts.workspace,
    });
    trace('core', 'turn-end-allow', { sessionId, reason: 'max-blocks', blocks });
    return {
      block: false,
      stillOpen: open,
      resolved: 0,
      blocks,
      hint: renderLookHint(sessionId, stats),
    };
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
      const stats = await recordTurnReport(sessionId, open, turnEvidence, {
        openCount: 0, resolved: open.length, blocked: false, workspace: opts.workspace,
      });
      trace('core', 'turn-end-allow', { sessionId, reason: 'all-resolved' });

      // Final turn: the agent has nothing left open, so this is where it
      // claims completion. That is the highest-value review point, because
      // overclaiming happens exactly here.
      const turnNumber = journal.turnCount(sessionId);
      if (shouldReview(turnNumber, true)) {
        const nudge = await runReview(sessionId, turnEvidence, {
          workspace: opts.workspace,
          turnNumber,
        });
        if (nudge) {
          trace('core', 'turn-end-review-block', { sessionId, turnNumber });
          return {
            block: true,
            reason: nudge,
            systemMessage: `TASKGUARD REVIEW: independent reviewer found gaps`,
            hint: renderLookHint(sessionId, stats),
            stillOpen: [],
            resolved: open.length,
            blocks,
          };
        }
      }

      return {
        block: false,
        stillOpen: [],
        resolved: open.length,
        blocks,
        hint: renderLookHint(sessionId, stats),
      };
    }
  }

  const resolved = open.length - stillOpen.length;
  const stats = await recordTurnReport(sessionId, open, turnEvidence, {
    openCount: stillOpen.length, resolved, blocked: true, workspace: opts.workspace,
  });
  trace('core', 'turn-end-block', { sessionId, blocks, stillOpen: stillOpen.length, resolved });

  // Periodic review on a turn that still has open items. The nudge is
  // appended to the existing block reason rather than replacing it, so the
  // agent sees both the unresolved items and the reviewer's findings.
  const turnNumber = journal.turnCount(sessionId);
  let reviewNudge = '';
  if (shouldReview(turnNumber, false)) {
    reviewNudge = await runReview(sessionId, turnEvidence, {
      workspace: opts.workspace,
      turnNumber,
    });
  }

  return {
    block: true,
    reason: [
      'You ended your turn, but these requested items are still unresolved:',
      ...stillOpen.map((i) => `- [${i.id}] (${i.kind}) ${i.text}`),
      'Address each one now, or explicitly state why it is no longer needed.',
      reviewNudge ? `\n${reviewNudge}` : '',
    ].join('\n'),
    systemMessage: [
      `TASKGUARD NUDGE #${blocks}: turn blocked - ${stillOpen.length} item(s) still open`,
      ...stillOpen.map((i) => `  - [${i.id}] ${i.text}`),
      resolved > 0 ? `  (${resolved} resolved this turn)` : '',
    ].filter(Boolean).join('\n'),
    hint: renderLookHint(sessionId, stats),
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
    return writeChangelog(sessionId, outcome.workspace);
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

  return writeChangelog(sessionId, outcome.workspace);
}

/**
 * Whether this turn should get an adversarial review.
 *
 * Two triggers:
 *   1. Every Nth turn (LEDGER_REVIEW_EVERY, default 5).
 *   2. The final turn — when the agent stops with nothing left open. This is
 *      the most valuable review point, because the last turn is where the
 *      agent summarises and claims completion, which is exactly where
 *      overclaiming happens.
 *
 * @param {number} turnNumber  1-based turn index.
 * @param {boolean} isFinal    True when no items remain open.
 * @returns {boolean}
 */
function shouldReview(turnNumber, isFinal) {
  if (process.env.LEDGER_REVIEW === '0') return false;

  const every = process.env.LEDGER_REVIEW_EVERY === undefined
    ? REVIEW_EVERY_DEFAULT
    : Number(process.env.LEDGER_REVIEW_EVERY);

  // 0 disables scheduled reviews; manual only.
  if (every === 0) return false;

  if (isFinal) return true;
  if (!Number.isFinite(every) || every < 1) return false;
  return turnNumber > 0 && turnNumber % every === 0;
}

/**
 * Run an adversarial review and record it.
 *
 * Never throws and never blocks the turn on its own failure: a reviewer that
 * cannot run must not break enforcement. Returns the nudge text when the
 * reviewer found high-severity gaps, else ''.
 *
 * @param {string} sessionId
 * @param {object} evidence  { tools, assistantText }
 * @param {object} opts      { workspace, turnNumber }
 * @returns {Promise<string>} nudge text, or '' if nothing to report
 */
async function runReview(sessionId, evidence, opts = {}) {
  const status = llm.reviewerStatus();
  if (!status.ok) {
    // Say so once per session rather than silently doing nothing — a review
    // that never runs is worse than one that is not configured, because you
    // would believe you were covered.
    trace('core', 'review-skipped', { sessionId, reason: status.reason });
    return '';
  }

  let result;
  try {
    result = await review.review({
      assistantText: evidence.assistantText,
      tools: evidence.tools,
      workspace: opts.workspace || '',
    });
  } catch (err) {
    trace('core', 'review-failed', { sessionId, error: err.message });
    return '';
  }

  if (!result.ok) {
    trace('core', 'review-failed', { sessionId, reason: result.reason });
    return '';
  }

  const blocking = review.blockingFindings(result.findings);
  trace('core', 'review-complete', {
    sessionId,
    turn: opts.turnNumber,
    claims: result.claims.length,
    findings: result.findings.length,
    blocking: blocking.length,
  });

  // Record the review in the journal so it is visible in the replay.
  journal.recordTurn(sessionId, {
    turn: journal.turnCount(sessionId) + 1,
    kind: 'review',
    headline: blocking.length
      ? `Reviewer found ${blocking.length} high-severity gap(s)`
      : `Reviewer confirmed ${result.findings.length} claim(s)`,
    summary: result.findings
      .map((f) => `[${f.claim}] ${f.verdict}: ${f.evidence}`)
      .join('\n')
      .slice(0, 2000),
    completed: result.findings.filter((f) => f.verdict === 'confirmed').map((f) => f.evidence),
    blockers: blocking.map((f) => f.evidence),
    toolCount: 0,
    blocked: false,
  });

  return review.renderNudge(result.findings);
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
 *
 * @returns {{turns:number, tools:number, kind:string, changelogPath:string}}
 *          Stats for the in-chat hint. Empty object on failure.
 */
function writeChangelog(sessionId, workspace) {
  if (process.env.LEDGER_CHANGELOG === '0') return {};
  try {
    const cwd = workspace || process.cwd();
    const turns = journal.readProgress(sessionId);
    const tools = journal.readTelemetry(sessionId);
    const result = changelog.write({
      sessionId,
      workspace: cwd,
      gitRoot: changelog.gitRoot(cwd),
      turns,
      tools,
    });
    return {
      turns: turns.length,
      tools: tools.length,
      kind: result.kind || '',
      changelogPath: result.path || '',
    };
  } catch {
    // Never let a changelog failure break enforcement.
    return {};
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
