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
 * Instead we use containment: what fraction of the SHORTER item's meaningful
 * words appear in the longer one. A paraphrase is usually a subset of the
 * original, so containment is high; two different asks differ in their
 * distinguishing word, so containment stays low.
 */
const CONTAINMENT_THRESHOLD = 0.85;

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

/** Meaningful tokens of a text: lowercased, synonym-mapped, stemmed, stopwords removed. */
function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w))
      .map((w) => SYNONYMS.get(w) || w)
      .map(stem)
      .filter(Boolean),
  );
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

function mergeExtracted(ledger, extracted) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();

  const existing = new Set(ledger.items.map((i) => norm(i.text)));
  const existingTokens = ledger.items.map((i) => tokens(i.text));
  let counter = ledger.items.length;

  for (const item of extracted || []) {
    const text = String(item.text || '').trim();
    if (!text) continue;
    if (existing.has(norm(text))) continue;

    // Paraphrase guard: skip if this is close enough to something we already
    // track. Only compare against items that are still open — a resolved item
    // that the user asks about again is a genuinely new ask.
    const candidate = tokens(text);
    const isDuplicate = ledger.items.some((existingItem, idx) => {
      if (existingItem.status !== 'open') return false;
      return containment(candidate, existingTokens[idx]) >= CONTAINMENT_THRESHOLD;
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
    existing.add(norm(text));
    existingTokens.push(candidate);
  }
  return ledger;
}

/**
 * Apply reconciliation verdicts from the LLM.
 * @param {object} ledger
 * @param {Array<{id: string, status: string, note?: string}>} verdicts
 */
function applyVerdicts(ledger, verdicts) {
  const byId = new Map(ledger.items.map((i) => [i.id, i]));
  for (const v of verdicts || []) {
    const item = byId.get(v.id);
    if (!item) continue;
    if (v.status === 'done' || v.status === 'dropped' || v.status === 'open') {
      item.status = v.status;
      item.closedAt = v.status === 'open' ? null : new Date().toISOString();
      item.note = v.note ? String(v.note).slice(0, 300) : null;
    }
  }
  return ledger;
}

/** Human-readable nudge text for the model. */
function renderNudge(ledger) {
  const open = openItems(ledger);
  if (open.length === 0) return '';
  const lines = open.map((i) => `- [${i.id}] (${i.kind}) ${i.text}`);
  return [
    'OPEN ITEMS LEDGER — these were requested and are not yet resolved:',
    ...lines,
    'Address each one, or explicitly state why it is no longer needed.',
  ].join('\n');
}

module.exports = {
  LEDGER_DIR,
  ledgerPath,
  load,
  save,
  openItems,
  mergeExtracted,
  applyVerdicts,
  renderNudge,
  pruneResolvedLedgers,
  isFullyResolved,
};
