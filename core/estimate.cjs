'use strict';

/**
 * Ledger-history cost estimator — "what will this actually cost me?"
 *
 * WHY THIS EXISTS
 * ---------------
 * tools/cost-report.cjs projects cost from TRANSCRIPTS: average prompt size,
 * average reply size, average turns per session. That answers "what does a
 * typical session cost?" It cannot answer "what does MY history say?", because
 * it never looks at what the ledger actually recorded.
 *
 * The ledger records something the transcripts do not: for every turn, how many
 * items were open at the end. That single field is the input to the one cost
 * question that matters most — how often does the on-clean review trigger fire?
 *
 * THE NUMBER THAT WAS WRONG
 * -------------------------
 * README claimed "85% of turns in a long session end with zero open items",
 * which drove the documented on-clean cost table. Measured against the real
 * ledger: 51 of 105 turns are clean — 48.6%. The documented figure was ~1.75x
 * too high, so the on-clean cost estimate was ~1.75x too high with it.
 *
 * That is the whole argument for this module: a cost estimate built on an
 * assumed ratio is a guess wearing a number's clothes. This one reads the ratio
 * from the data and refuses to print a projection when the data is too thin to
 * support one.
 *
 * WHAT IT READS
 * -------------
 *   <LEDGER_DIR>/*.progress.jsonl   one record per turn, with openCount
 *   <LEDGER_DIR>/*.telemetry.jsonl  one record per tool call (often absent)
 *
 * Both are append-only JSONL written by the Stop hook. See core/journal.cjs.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not call a model. It does not write anything. It reads files and does
 * arithmetic. Running it is free.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEDGER_DIR = process.env.LEDGER_DIR
  || path.join(os.homedir(), '.copilot', 'hooks', 'ledger', '.ledger');

/**
 * How much history is "enough" to project from.
 *
 * These are deliberately low bars, because the alternative — printing a
 * confident number from two data points — is worse than printing "not enough
 * history yet". A session with one turn tells you nothing about how often turns
 * end clean; a session with three starts to.
 *
 * Measured against real history when this was written: 68 sessions, but only 6
 * with 3+ turns. So the gate is real, not theoretical — most installs will see
 * "insufficient history" until they have used the tool for a while.
 */
const MIN_SESSIONS = 2;
const MIN_TURNS_PER_SESSION = 3;
const MIN_TOTAL_TURNS = 10;

/** Read a JSONL file, skipping malformed lines. Returns [] if unreadable. */
function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated final line from a crash. Skip it, keep the file.
    }
  }
  return out;
}

/** List files in the ledger dir matching a suffix. */
function listLedgerFiles(suffix) {
  let names;
  try {
    names = fs.readdirSync(LEDGER_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(suffix))
    .map((n) => path.join(LEDGER_DIR, n));
}

/**
 * Load per-session turn records.
 *
 * Only `kind === 'turn'` records count. Review records are written with
 * `kind: 'review'` and have no openCount — including them would silently
 * deflate the clean ratio by counting reviews as non-clean turns.
 *
 * @returns {Array<{sessionId:string, turns:Array<object>}>}
 */
function loadSessions() {
  const sessions = [];
  for (const file of listLedgerFiles('.progress.jsonl')) {
    const sessionId = path.basename(file).replace('.progress.jsonl', '');
    const turns = readJsonl(file).filter(
      (r) => r && r.kind === 'turn' && Number.isFinite(r.openCount),
    );
    if (turns.length) sessions.push({ sessionId, turns });
  }
  return sessions;
}

/** Mean of an array; 0 for empty. */
function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Median of an array; 0 for empty. */
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Split a session's turns in half and compare clean ratios.
 *
 * This is the trend signal. A session that starts messy and ends clean is
 * improving; one that starts clean and ends messy is degrading. Either way the
 * ratio you should project from is the RECENT one, not the lifetime average —
 * an agent that has learned your codebase behaves differently at turn 40 than
 * at turn 4.
 *
 * Sessions shorter than 4 turns are skipped: splitting 3 turns into 1.5 and 1.5
 * produces a ratio that is really just "was turn 2 clean", which is noise.
 *
 * @param {Array<object>} turns
 * @returns {{firstHalf:number, secondHalf:number, delta:number}|null}
 */
function trendOf(turns) {
  if (turns.length < 4) return null;
  const mid = Math.floor(turns.length / 2);
  const ratio = (slice) => {
    if (!slice.length) return 0;
    return slice.filter((t) => t.openCount === 0).length / slice.length;
  };
  const firstHalf = ratio(turns.slice(0, mid));
  const secondHalf = ratio(turns.slice(mid));
  return { firstHalf, secondHalf, delta: secondHalf - firstHalf };
}

/**
 * Analyse ledger history.
 *
 * @returns {object} A summary with the clean ratio, trend, and sufficiency gate.
 */
function analyseHistory() {
  const sessions = loadSessions();

  const allTurns = sessions.flatMap((s) => s.turns);
  const cleanTurns = allTurns.filter((t) => t.openCount === 0).length;

  const perSession = sessions.map((s) => ({
    sessionId: s.sessionId,
    turns: s.turns.length,
    clean: s.turns.filter((t) => t.openCount === 0).length,
    ratio: s.turns.filter((t) => t.openCount === 0).length / s.turns.length,
    trend: trendOf(s.turns),
  }));

  // "Sufficient" means: enough sessions that are long enough to have a shape,
  // and enough total turns that the ratio is not one lucky session.
  const longEnough = perSession.filter((s) => s.turns >= MIN_TURNS_PER_SESSION);
  const sufficient = longEnough.length >= MIN_SESSIONS
    && allTurns.length >= MIN_TOTAL_TURNS;

  const trends = perSession.map((s) => s.trend).filter(Boolean);

  // Session length for PROJECTION purposes comes from the long sessions only.
  //
  // This matters more than it looks. A real ledger accumulates one-turn
  // sessions — a question asked and answered, a test run, a stub from the test
  // suite. Measured on a real machine: 69 sessions, mean 1.7 turns. Projecting
  // a 2-turn session cost is arithmetically correct and completely useless,
  // because nobody installs a supervision hook for two-turn sessions.
  //
  // The long sessions are the ones the projection is about, so they are the
  // ones it measures. The all-session mean is still reported, because hiding
  // it would make the two figures impossible to reconcile.
  const longTurns = longEnough.map((s) => s.turns);

  return {
    ledgerDir: LEDGER_DIR,
    sessions: sessions.length,
    sessionsWithEnoughTurns: longEnough.length,
    totalTurns: allTurns.length,
    cleanTurns,
    // Overall ratio across every turn we have. This is the honest headline.
    cleanRatio: allTurns.length ? cleanTurns / allTurns.length : 0,
    // Mean of per-session ratios. Differs from the above when sessions have
    // very different lengths — a 15-turn session should not be drowned out by
    // forty 1-turn sessions. Reported so the difference is visible.
    meanSessionRatio: mean(perSession.map((s) => s.ratio)),
    medianSessionRatio: median(perSession.map((s) => s.ratio)),
    // Every session, including the one-turn ones.
    meanTurnsPerSession: mean(perSession.map((s) => s.turns)),
    medianTurnsPerSession: median(perSession.map((s) => s.turns)),
    // Only sessions long enough to have a shape. This is what a projection
    // should use.
    meanTurnsPerLongSession: longTurns.length ? mean(longTurns) : 0,
    medianTurnsPerLongSession: longTurns.length ? median(longTurns) : 0,
    trend: trends.length
      ? {
        sessions: trends.length,
        meanFirstHalf: mean(trends.map((t) => t.firstHalf)),
        meanSecondHalf: mean(trends.map((t) => t.secondHalf)),
        meanDelta: mean(trends.map((t) => t.delta)),
      }
      : null,
    sufficient,
    gate: sufficient
      ? null
      : `need ${MIN_SESSIONS} sessions with ${MIN_TURNS_PER_SESSION}+ turns and `
        + `${MIN_TOTAL_TURNS} total turns; have ${longEnough.length} and ${allTurns.length}`,
    perSession,
  };
}

/**
 * Project a session's cost from ledger history.
 *
 * The arithmetic is the same as tools/cost-report.cjs — per-turn cost times
 * turns, plus reviews times per-review cost — but the REVIEW COUNT comes from
 * the measured clean ratio instead of an assumed one.
 *
 * Reviews per session:
 *   scheduled  = floor(turns / every)      one every N turns
 *   final      = 1                          always on the last turn
 *   onClean    = cleanTurns                 only when LEDGER_REVIEW_ON_CLEAN=1
 *
 * The final-turn review is not additive with a scheduled one when the last turn
 * happens to land on the schedule — but over-counting by at most one review is
 * the conservative direction for a cost estimate, so it is left in.
 *
 * @param {object} opts
 * @param {number} opts.perTurnCost     USD per ordinary turn.
 * @param {number} opts.perReviewCost   USD per adversarial review.
 * @param {number} [opts.turns]         Session length; defaults to measured mean.
 * @param {number} [opts.every]         Review every N turns; defaults to 10.
 * @param {boolean} [opts.onClean]      Whether the on-clean trigger is enabled.
 * @param {number} [opts.cleanRatio]    Override the measured ratio.
 * @returns {object|null} null when history is insufficient and no ratio given.
 */
function projectSession(opts = {}) {
  const history = opts.history || analyseHistory();
  const ratio = Number.isFinite(opts.cleanRatio)
    ? opts.cleanRatio
    : history.cleanRatio;

  if (!Number.isFinite(opts.cleanRatio) && !history.sufficient) {
    return null;
  }

  // Prefer the long-session mean. Falling back to the all-session mean would
  // project a 2-turn session, which is not what anyone is asking about.
  const measuredTurns = history.meanTurnsPerLongSession
    || history.meanTurnsPerSession
    || 1;
  const turns = Number.isFinite(opts.turns)
    ? opts.turns
    : Math.max(1, Math.round(measuredTurns));
  const every = Number.isFinite(opts.every) ? opts.every : 10;
  const onClean = opts.onClean === true;
  const perTurnCost = Number(opts.perTurnCost) || 0;
  const perReviewCost = Number(opts.perReviewCost) || 0;

  const scheduled = every > 0 ? Math.floor(turns / every) : 0;
  const final = 1;
  const cleanTurns = Math.round(turns * ratio);
  const onCleanReviews = onClean ? cleanTurns : 0;
  const reviews = scheduled + final + onCleanReviews;

  const turnCost = perTurnCost * turns;
  const reviewCost = perReviewCost * reviews;

  return {
    turns,
    every,
    onClean,
    cleanRatio: ratio,
    cleanTurns,
    reviews: {
      scheduled,
      final,
      onClean: onCleanReviews,
      total: reviews,
    },
    cost: {
      turns: turnCost,
      reviews: reviewCost,
      total: turnCost + reviewCost,
      reviewShare: turnCost + reviewCost > 0
        ? reviewCost / (turnCost + reviewCost)
        : 0,
    },
    basis: Number.isFinite(opts.cleanRatio)
      ? 'caller-supplied ratio'
      : `measured from ${history.sessionsWithEnoughTurns} session(s), `
        + `${history.totalTurns} turn(s)`,
  };
}

/**
 * Compare the two trigger configurations side by side.
 *
 * This is the decision the estimator exists to support: "should I turn on
 * LEDGER_REVIEW_ON_CLEAN?" The answer is a ratio between two numbers, and both
 * numbers should come from your history.
 *
 * @param {object} opts  Same as projectSession, minus onClean.
 * @returns {{off:object|null, on:object|null, multiplier:number|null}}
 */
function compareTriggers(opts = {}) {
  const history = opts.history || analyseHistory();
  const base = { ...opts, history };
  const off = projectSession({ ...base, onClean: false });
  const on = projectSession({ ...base, onClean: true });
  const multiplier = off && on && off.cost.total > 0
    ? on.cost.total / off.cost.total
    : null;
  return { off, on, multiplier };
}

module.exports = {
  LEDGER_DIR,
  MIN_SESSIONS,
  MIN_TURNS_PER_SESSION,
  MIN_TOTAL_TURNS,
  readJsonl,
  listLedgerFiles,
  loadSessions,
  trendOf,
  analyseHistory,
  projectSession,
  compareTriggers,
};
