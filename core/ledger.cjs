'use strict';

/**
 * Ledger store — the single source of truth for open questions and tasks.
 *
 * The HOOK owns this state. The agent never writes to it. The agent only ever
 * receives nudges derived from it.
 *
 * Storage: one JSON file per session, under .github/hooks/.ledger/.
 * The directory is gitignored; ledgers are local working state.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// System-wide install: state lives under the user's Copilot home so it is
// shared across every workspace. Override with LEDGER_DIR if needed.
const LEDGER_DIR = process.env.LEDGER_DIR
  || path.join(os.homedir(), '.copilot', 'hooks', 'ledger', '.ledger');

function ledgerPath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LEDGER_DIR, `${safe}.json`);
}

function ensureDir() {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

// Ledgers are per-session working state. Without pruning they accumulate
// forever (one file per chat session, some with 50+ items).
//
// The trigger is RESOLUTION, not age. A session can legitimately run for days,
// so "older than 24h" would delete live state. What actually makes a ledger
// disposable is that every item in it is closed: the conversation history is
// the durable record of what was done, so the enforcer no longer needs it.
//
// We only delete a ledger when:
//   - it is not the current session, AND
//   - it has at least one item, AND
//   - every item is "done" or "dropped" (nothing open).
//
// A ledger with zero items is kept: it may be a session that has not had its
// first prompt extracted yet.
const PRUNE_THRESHOLD = 20; // only scan when this many files exist

function isFullyResolved(ledger) {
  if (!Array.isArray(ledger.items) || ledger.items.length === 0) return false;
  return ledger.items.every((i) => i.status === 'done' || i.status === 'dropped');
}

function pruneResolvedLedgers(keepSessionId) {
  let names;
  try {
    names = fs.readdirSync(LEDGER_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  if (names.length <= PRUNE_THRESHOLD) return;

  const keepFile = `${String(keepSessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;

  for (const name of names) {
    if (name === keepFile) continue;
    const full = path.join(LEDGER_DIR, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (isFullyResolved(parsed)) fs.unlinkSync(full);
    } catch {
      // Unreadable or raced with another process; leave it alone.
    }
  }
}

/**
 * @typedef {Object} LedgerItem
 * @property {string} id          Stable id, e.g. "q1", "t3"
 * @property {'question'|'task'} kind
 * @property {string} text        The question or task, verbatim-ish
 * @property {'open'|'done'|'dropped'} status
 * @property {string} addedAt     ISO timestamp
 * @property {string|null} closedAt
 * @property {string|null} note   Why it was closed (evidence or reason)
 */

/** @returns {{sessionId: string, items: LedgerItem[], updatedAt: string}} */
function load(sessionId) {
  const p = ledgerPath(sessionId);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items)) parsed.items = [];
    return parsed;
  } catch {
    return { sessionId: String(sessionId || 'default'), items: [], updatedAt: new Date().toISOString() };
  }
}

function save(ledger) {
  ensureDir();
  ledger.updatedAt = new Date().toISOString();
  const p = ledgerPath(ledger.sessionId);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, p);
  // Opportunistic cleanup of other sessions' fully-resolved ledgers.
  pruneResolvedLedgers(ledger.sessionId);
  return ledger;
}

/** Items still needing attention. */
function openItems(ledger) {
  return ledger.items.filter((i) => i.status === 'open');
}

/**
 * Merge newly-extracted items into the ledger.
 * Dedupe by normalized text so re-extraction does not duplicate.
 * @param {object} ledger
 * @param {Array<{kind: string, text: string}>} extracted
 */
/**
 * Duplicate detection for extracted items.
 *
 * The extractor is an LLM, so the same request re-extracted in a later turn
 * comes back paraphrased ("Create a Git repo..." vs "Create a git repository
 * ..."). Exact-text dedupe misses that and the ledger grows duplicates.
 *
 * Jaccard similarity was tried and rejected: it scores a real paraphrase
 * ("Make the repo public and safe for others to use" vs "...for others") at
 * 0.50, the same as two genuinely different asks ("Fix the login bug" vs
 * "Fix the logout bug"). It cannot separate the two cases.
 *
 * Two rules, applied in order:
 *
 *   1. CONTAINMENT (>= 0.85) — one item's meaningful words are almost a
 *      subset of the other's. Catches "repo" vs "repository" style rewording.
 *
 *   2. OVERLAP (>= 0.60, only for texts of 6+ meaningful words) — a looser
 *      Jaccard, but gated on length. Short asks like "Fix the login bug" vs
 *      "Fix the logout bug" differ by one word out of three, so a loose
 *      threshold would merge them. Long asks differ by one word out of ten,
 *      so the same threshold is safe and catches rewordings containment
 *      misses ("omit the actual task details" vs "not tell what the tasks
 *      are").
 *
 * The length gate is what makes the looser rule safe. Without it the ledger
 * accumulated 29 open items for ~20 real asks, which made every nudge noisy
 * and made the audit unable to resolve anything.
 */
const CONTAINMENT_THRESHOLD = 0.85;
const OVERLAP_THRESHOLD = 0.60;
const OVERLAP_MIN_TOKENS = 6;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'for', 'in', 'on', 'at',
  'by', 'with', 'from', 'as', 'is', 'are', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'we', 'you', 'me', 'my', 'our', 'your',
  'please', 'also', 'then', 'so', 'if', 'can', 'could', 'would', 'should',
  'make', 'sure', 'ensure', 'need', 'want', 'like', 'just', 'some', 'any',
  'use', 'using', 'do', 'does', 'get', 'got',
]);

/** Common abbreviations the extractor flips between. */
const SYNONYMS = new Map([
  ['repo', 'repository'],
  ['repos', 'repository'],
  ['dir', 'directory'],
  ['dirs', 'directory'],
  ['config', 'configuration'],
  ['env', 'environment'],
  ['doc', 'documentation'],
  ['docs', 'documentation'],
  ['db', 'database'],
  ['auth', 'authentication'],
  ['info', 'information'],
  ['msg', 'message'],
  ['msgs', 'message'],
  ['fn', 'function'],
  ['func', 'function'],
  ['param', 'parameter'],
  ['params', 'parameter'],
  ['arg', 'argument'],
  ['args', 'argument'],
  ['impl', 'implementation'],
  ['test', 'test'],
  ['tests', 'test'],
]);

/** Crude but effective singularisation: paths -> path, repositories -> repository. */
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Meaningful tokens of a text: lowercased, synonym-mapped, stemmed, stopwords
 * removed.
 *
 * Dotted identifiers (ai.js, db.js, config.json) are kept WHOLE as well as
 * split. This matters: "Add tests for ai.js" and "Add tests for db.js" share
 * every word except the filename, so word-level similarity scores them at 0.75
 * — higher than a genuine duplicate. Keeping the identifier as its own token
 * makes the difference visible and drops that pair to 0.60.
 */
function tokens(text) {
  const raw = String(text || '').toLowerCase();
  const identifiers = raw.match(/[a-z0-9_-]+\.[a-z0-9]+/g) || [];
  const words = raw
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => SYNONYMS.get(w) || w)
    .map(stem)
    .filter(Boolean);
  return new Set([...identifiers, ...words]);
}

/**
 * Containment: fraction of the smaller token set found in the larger.
 * Returns 0..1. Symmetric, so argument order does not matter.
 */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared += 1;
  return shared / small.size;
}

/** Jaccard overlap of two token sets, 0..1. */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Are these two items the same ask?
 *
 * Only applied to OPEN items: a resolved item that the user asks about again
 * is a genuinely new ask, not a duplicate.
 */
function isSameAsk(a, b) {
  if (containment(a, b) >= CONTAINMENT_THRESHOLD) return true;
  // The looser rule is only safe when both texts are long enough that a
  // single differing word is not the whole distinguishing signal.
  if (a.size >= OVERLAP_MIN_TOKENS && b.size >= OVERLAP_MIN_TOKENS) {
    return overlap(a, b) >= OVERLAP_THRESHOLD;
  }
  return false;
}

function mergeExtracted(ledger, extracted) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();

  const existingTokens = ledger.items.map((i) => tokens(i.text));
  let counter = ledger.items.length;

  for (const item of extracted || []) {
    const text = String(item.text || '').trim();
    if (!text) continue;

    const candidate = tokens(text);
    const isDuplicate = ledger.items.some((existingItem, idx) => {
      // Only OPEN items can absorb a new ask. A resolved item that the user
      // asks about again is a genuinely new ask, so it must not be swallowed
      // by the exact-text check either.
      if (existingItem.status !== 'open') return false;
      if (norm(existingItem.text) === norm(text)) return true;
      return isSameAsk(candidate, existingTokens[idx]);
    });
    if (isDuplicate) continue;

    counter += 1;
    const kind = item.kind === 'question' ? 'question' : 'task';
    ledger.items.push({
      id: `${kind === 'question' ? 'q' : 't'}${counter}`,
      kind,
      text,
      status: 'open',
      addedAt: new Date().toISOString(),
      closedAt: null,
      note: null,
    });
    existingTokens.push(candidate);
  }
  return ledger;
}

/**
 * Apply reconciliation verdicts from the LLM.
 *
 * The model does not always use our exact vocabulary. Observed in practice:
 * "not_done", "completed", "resolved", "pending". An unrecognised status used
 * to be silently ignored, which left the item open forever and made the audit
 * look broken. Normalise the common variants instead.
 *
 * @param {object} ledger
 * @param {Array<{id: string, status: string, note?: string}>} verdicts
 */
const STATUS_ALIASES = new Map([
  ['done', 'done'],
  ['completed', 'done'],
  ['complete', 'done'],
  ['resolved', 'done'],
  ['answered', 'done'],
  ['finished', 'done'],
  ['dropped', 'dropped'],
  ['drop', 'dropped'],
  ['not_needed', 'dropped'],
  ['notneeded', 'dropped'],
  ['obsolete', 'dropped'],
  ['cancelled', 'dropped'],
  ['canceled', 'dropped'],
  ['open', 'open'],
  ['not_done', 'open'],
  ['notdone', 'open'],
  ['pending', 'open'],
  ['unresolved', 'open'],
  ['incomplete', 'open'],
  ['partial', 'open'],
]);

function normaliseStatus(raw) {
  const key = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_ALIASES.get(key) || null;
}

function applyVerdicts(ledger, verdicts) {
  const byId = new Map(ledger.items.map((i) => [i.id, i]));
  for (const v of verdicts || []) {
    const item = byId.get(v.id);
    if (!item) continue;
    const status = normaliseStatus(v.status);
    if (!status) continue;
    item.status = status;
    item.closedAt = status === 'open' ? null : new Date().toISOString();
    item.note = v.note ? String(v.note).slice(0, 300) : null;
  }
  return ledger;
}

/** Human-readable nudge text for the model. */
function renderNudge(ledger) {
  const open = openItems(ledger);
  if (open.length === 0) return '';
  const lines = open.map((i) => `- [${i.id}] (${i.kind}) ${i.text}`);
  return [
    'OPEN ITEMS (taskguard) — these were requested and are not yet resolved:',
    ...lines,
    'Address each one, or explicitly state why it is no longer needed.',
  ].join('\n');
}

/**
 * Apply duplicate-collapse groups from the model.
 *
 * The kept item absorbs the merged ones: they are marked "dropped" with a note
 * pointing at the survivor, so the history stays auditable rather than the
 * entries vanishing.
 *
 * @param {object} ledger
 * @param {Array<{keep: string, merge: string[]}>} groups
 * @returns {number} How many items were merged away.
 */
function applyCollapseGroups(ledger, groups) {
  const byId = new Map(ledger.items.map((i) => [i.id, i]));
  let merged = 0;

  for (const g of groups || []) {
    const keep = byId.get(g.keep);
    if (!keep || keep.status !== 'open') continue;

    for (const id of g.merge || []) {
      const item = byId.get(id);
      if (!item || item.status !== 'open') continue;
      item.status = 'dropped';
      item.closedAt = new Date().toISOString();
      item.note = `duplicate of ${keep.id}`;
      merged += 1;
    }
  }
  return merged;
}

module.exports = {
  LEDGER_DIR,
  ledgerPath,
  load,
  save,
  openItems,
  mergeExtracted,
  applyVerdicts,
  applyCollapseGroups,
  renderNudge,
  pruneResolvedLedgers,
  isFullyResolved,
};
