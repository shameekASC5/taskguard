'use strict';

/**
 * Tests for core/estimate.cjs — the ledger-history cost estimator.
 *
 * The load-bearing property is that the clean ratio comes from the DATA, not
 * from an assumption. The README claimed 85%; the ledger said 48%. Every test
 * here exists to keep that class of error from coming back: if the estimator
 * ever starts reporting a number it did not measure, one of these fails.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let estimate;
let tmpDir;

/** Write a progress.jsonl with the given per-turn openCounts. */
function writeSession(sessionId, openCounts, extra = {}) {
  const file = path.join(tmpDir, `${sessionId}.progress.jsonl`);
  const lines = openCounts.map((openCount, i) => JSON.stringify({
    at: new Date(Date.UTC(2026, 9, 27, 10, i)).toISOString(),
    kind: 'turn',
    turn: i + 1,
    openCount,
    resolved: 0,
    blocked: openCount > 0,
    toolCount: 5,
    ...extra,
  }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-estimate-'));
  process.env.LEDGER_DIR = tmpDir;
  jest.resetModules();
  estimate = require('../core/estimate.cjs');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LEDGER_DIR;
  delete process.env.LEDGER_REVIEW_EVERY;
  delete process.env.LEDGER_REVIEW_ON_CLEAN;
});

describe('estimate — reading history', () => {
  test('returns zeros when the ledger dir does not exist', () => {
    process.env.LEDGER_DIR = path.join(tmpDir, 'nope');
    jest.resetModules();
    const e = require('../core/estimate.cjs');
    const h = e.analyseHistory();
    expect(h.sessions).toBe(0);
    expect(h.totalTurns).toBe(0);
    expect(h.cleanRatio).toBe(0);
    expect(h.sufficient).toBe(false);
  });

  test('counts only kind=turn records', () => {
    // A review record has no openCount. Counting it as a non-clean turn would
    // silently deflate the ratio — the exact bug this guards.
    const file = path.join(tmpDir, 's1.progress.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ kind: 'turn', openCount: 0 }),
      JSON.stringify({ kind: 'review', headline: 'reviewer ran' }),
      JSON.stringify({ kind: 'turn', openCount: 2 }),
    ].join('\n'));

    const h = estimate.analyseHistory();
    expect(h.totalTurns).toBe(2);
    expect(h.cleanTurns).toBe(1);
    expect(h.cleanRatio).toBe(0.5);
  });

  test('skips a truncated final line rather than losing the file', () => {
    const file = path.join(tmpDir, 's1.progress.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ kind: 'turn', openCount: 0 }),
      '{"kind":"turn","openCount":1',
    ].join('\n'));

    const h = estimate.analyseHistory();
    expect(h.totalTurns).toBe(1);
    expect(h.cleanTurns).toBe(1);
  });

  test('ignores turn records with no openCount', () => {
    const file = path.join(tmpDir, 's1.progress.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ kind: 'turn', openCount: 0 }),
      JSON.stringify({ kind: 'turn' }),
    ].join('\n'));

    expect(estimate.analyseHistory().totalTurns).toBe(1);
  });
});

describe('estimate — the clean ratio', () => {
  test('computes the overall ratio across every turn', () => {
    writeSession('a', [0, 0, 1, 0]);   // 3/4
    writeSession('b', [1, 1, 0, 0]);   // 2/4
    const h = estimate.analyseHistory();
    expect(h.totalTurns).toBe(8);
    expect(h.cleanTurns).toBe(5);
    expect(h.cleanRatio).toBeCloseTo(5 / 8, 6);
  });

  test('reports the mean per-session ratio separately from the overall', () => {
    // One long messy session and one short clean one. The overall ratio is
    // dominated by the long session; the mean treats them equally. Both are
    // true, and the difference is the point of reporting both.
    writeSession('long', [1, 1, 1, 1, 1, 1, 1, 1, 1, 0]); // 1/10
    writeSession('short', [0, 0, 0]);                      // 3/3

    const h = estimate.analyseHistory();
    expect(h.cleanRatio).toBeCloseTo(4 / 13, 6);
    expect(h.meanSessionRatio).toBeCloseTo((0.1 + 1) / 2, 6);
    expect(h.meanSessionRatio).toBeGreaterThan(h.cleanRatio);
  });

  test('a single clean session is 100%', () => {
    writeSession('a', [0, 0, 0]);
    expect(estimate.analyseHistory().cleanRatio).toBe(1);
  });

  test('a single messy session is 0%', () => {
    writeSession('a', [1, 2, 3]);
    expect(estimate.analyseHistory().cleanRatio).toBe(0);
  });
});

describe('estimate — the sufficiency gate', () => {
  test('refuses to project from one short session', () => {
    writeSession('a', [0, 1]);
    const h = estimate.analyseHistory();
    expect(h.sufficient).toBe(false);
    expect(h.gate).toMatch(/need/);
    expect(estimate.projectSession({ history: h })).toBeNull();
  });

  test('refuses when sessions are long enough but too few', () => {
    writeSession('a', [0, 1, 0, 1, 0]);
    const h = estimate.analyseHistory();
    expect(h.sessionsWithEnoughTurns).toBe(1);
    expect(h.sufficient).toBe(false);
  });

  test('refuses when there are many sessions but too few turns', () => {
    for (let i = 0; i < 10; i += 1) writeSession(`s${i}`, [0]);
    const h = estimate.analyseHistory();
    expect(h.sessions).toBe(10);
    expect(h.totalTurns).toBe(10);
    expect(h.sessionsWithEnoughTurns).toBe(0);
    expect(h.sufficient).toBe(false);
  });

  test('allows a projection once the gate is met', () => {
    writeSession('a', [0, 1, 0, 1, 0]);
    writeSession('b', [1, 0, 1, 0, 1]);
    const h = estimate.analyseHistory();
    expect(h.sufficient).toBe(true);
    expect(h.gate).toBeNull();
    expect(estimate.projectSession({ history: h })).not.toBeNull();
  });

  test('an explicit ratio bypasses the gate', () => {
    // The caller may know the ratio from elsewhere. Passing it is an explicit
    // statement that they do, so the gate does not apply.
    const h = estimate.analyseHistory();
    expect(h.sufficient).toBe(false);
    const p = estimate.projectSession({ history: h, cleanRatio: 0.5, turns: 20 });
    expect(p).not.toBeNull();
    expect(p.basis).toBe('caller-supplied ratio');
  });
});

describe('estimate — trend', () => {
  test('detects an improving session', () => {
    const turns = [1, 1, 1, 1, 0, 0, 0, 0].map((openCount) => ({ openCount }));
    const t = estimate.trendOf(turns);
    expect(t.firstHalf).toBe(0);
    expect(t.secondHalf).toBe(1);
    expect(t.delta).toBe(1);
  });

  test('detects a degrading session', () => {
    const turns = [0, 0, 0, 0, 1, 1, 1, 1].map((openCount) => ({ openCount }));
    const t = estimate.trendOf(turns);
    expect(t.delta).toBe(-1);
  });

  test('returns null for a session too short to split', () => {
    // Splitting 3 turns into 1.5 and 1.5 is really "was turn 2 clean".
    expect(estimate.trendOf([{ openCount: 0 }, { openCount: 1 }, { openCount: 0 }]))
      .toBeNull();
  });

  test('aggregates trend across sessions', () => {
    writeSession('a', [1, 1, 0, 0]);
    writeSession('b', [1, 1, 0, 0]);
    const h = estimate.analyseHistory();
    expect(h.trend.sessions).toBe(2);
    expect(h.trend.meanDelta).toBeCloseTo(1, 6);
  });
});

describe('estimate — projection arithmetic', () => {
  const history = {
    sufficient: true,
    cleanRatio: 0.5,
    meanTurnsPerSession: 32,
    sessionsWithEnoughTurns: 5,
    totalTurns: 100,
  };

  test('counts scheduled, final, and on-clean reviews separately', () => {
    const p = estimate.projectSession({
      history, perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10, onClean: true,
    });
    expect(p.reviews.scheduled).toBe(3);   // floor(32/10)
    expect(p.reviews.final).toBe(1);
    expect(p.reviews.onClean).toBe(16);    // round(32 * 0.5)
    expect(p.reviews.total).toBe(20);
  });

  test('on-clean adds nothing when the flag is off', () => {
    const p = estimate.projectSession({
      history, perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10, onClean: false,
    });
    expect(p.reviews.onClean).toBe(0);
    expect(p.reviews.total).toBe(4);
  });

  test('every=0 leaves only the final review', () => {
    const p = estimate.projectSession({
      history, perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 0, onClean: false,
    });
    expect(p.reviews.scheduled).toBe(0);
    expect(p.reviews.total).toBe(1);
  });

  test('total is turn cost plus review cost', () => {
    const p = estimate.projectSession({
      history, perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10, onClean: false,
    });
    expect(p.cost.turns).toBeCloseTo(0.032, 6);
    expect(p.cost.reviews).toBeCloseTo(0.08, 6);
    expect(p.cost.total).toBeCloseTo(0.112, 6);
  });

  test('reviewShare is the fraction of cost that is review', () => {
    const p = estimate.projectSession({
      history, perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10, onClean: false,
    });
    expect(p.cost.reviewShare).toBeCloseTo(0.08 / 0.112, 4);
  });

  test('a higher clean ratio means more on-clean reviews', () => {
    const low = estimate.projectSession({
      history: { ...history, cleanRatio: 0.2 },
      perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10, onClean: true,
    });
    const high = estimate.projectSession({
      history: { ...history, cleanRatio: 0.9 },
      perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10, onClean: true,
    });
    expect(high.reviews.onClean).toBeGreaterThan(low.reviews.onClean);
    expect(high.cost.total).toBeGreaterThan(low.cost.total);
  });

  test('falls back to the measured session length', () => {
    const p = estimate.projectSession({ history, perTurnCost: 0.001, perReviewCost: 0.02 });
    expect(p.turns).toBe(32);
  });

  test('never projects a zero-turn session', () => {
    const p = estimate.projectSession({
      history: { ...history, meanTurnsPerSession: 0 },
      perTurnCost: 0.001, perReviewCost: 0.02,
    });
    expect(p.turns).toBe(1);
  });

  test('prefers the long-session mean over the all-session mean', () => {
    // A real ledger collects one-turn sessions. Projecting from them gives a
    // 2-turn session cost, which is correct and useless.
    const p = estimate.projectSession({
      history: { ...history, meanTurnsPerSession: 1.7, meanTurnsPerLongSession: 8 },
      perTurnCost: 0.001, perReviewCost: 0.02,
    });
    expect(p.turns).toBe(8);
  });

  test('falls back to the all-session mean when there are no long sessions', () => {
    const p = estimate.projectSession({
      history: { ...history, meanTurnsPerSession: 5, meanTurnsPerLongSession: 0 },
      perTurnCost: 0.001, perReviewCost: 0.02,
    });
    expect(p.turns).toBe(5);
  });
});

describe('estimate — session length for projection', () => {
  test('reports both the all-session and long-session means', () => {
    // Sixty-two one-turn sessions and one long one. The all-session mean is
    // dragged down to ~1.7; the long-session mean is the real answer.
    for (let i = 0; i < 62; i += 1) writeSession(`stub${i}`, [0]);
    writeSession('real', [0, 1, 0, 1, 0, 1, 0, 1]);

    const h = estimate.analyseHistory();
    expect(h.sessions).toBe(63);
    expect(h.meanTurnsPerSession).toBeLessThan(2);
    expect(h.meanTurnsPerLongSession).toBe(8);
    expect(h.sessionsWithEnoughTurns).toBe(1);
  });

  test('the long-session mean is zero when no session qualifies', () => {
    writeSession('a', [0]);
    writeSession('b', [1]);
    const h = estimate.analyseHistory();
    expect(h.meanTurnsPerLongSession).toBe(0);
  });
});

describe('estimate — trigger comparison', () => {
  const history = {
    sufficient: true,
    cleanRatio: 0.5,
    meanTurnsPerSession: 32,
    sessionsWithEnoughTurns: 5,
    totalTurns: 100,
  };

  test('reports the multiplier between the two settings', () => {
    const c = estimate.compareTriggers({
      history, perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10,
    });
    expect(c.off.reviews.total).toBe(4);
    expect(c.on.reviews.total).toBe(20);
    expect(c.multiplier).toBeCloseTo(c.on.cost.total / c.off.cost.total, 6);
    expect(c.multiplier).toBeGreaterThan(1);
  });

  test('the multiplier is null when there is nothing to compare', () => {
    const c = estimate.compareTriggers({
      history: { ...history, sufficient: false },
      perTurnCost: 0.001, perReviewCost: 0.02,
    });
    expect(c.off).toBeNull();
    expect(c.on).toBeNull();
    expect(c.multiplier).toBeNull();
  });

  test('a 48% clean ratio gives a smaller multiplier than 85% would', () => {
    // This is the correction the module exists for. The README assumed 85%;
    // the ledger says 48%. Same arithmetic, very different answer.
    const at48 = estimate.compareTriggers({
      history: { ...history, cleanRatio: 0.48 },
      perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10,
    });
    const at85 = estimate.compareTriggers({
      history: { ...history, cleanRatio: 0.85 },
      perTurnCost: 0.001, perReviewCost: 0.02, turns: 32, every: 10,
    });
    expect(at85.multiplier).toBeGreaterThan(at48.multiplier);
  });
});
