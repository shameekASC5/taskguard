'use strict';

/**
 * Unit tests for the ledger store.
 *
 * The ledger is the hook-owned source of truth for open questions/tasks.
 * These tests cover the pure logic: merge, dedupe, verdicts, rendering.
 */

const fs = require('node:fs');

const ledger = require('../hooks/lib/ledger.cjs');

describe('ledger store', () => {
  const sessionId = `test-${process.pid}-${Date.now()}`;

  afterAll(() => {
    try {
      fs.unlinkSync(ledger.ledgerPath(sessionId));
    } catch {
      // Already gone.
    }
  });

  test('load returns an empty ledger for an unknown session', () => {
    const led = ledger.load(`nonexistent-${Date.now()}`);
    expect(led.items).toEqual([]);
    expect(led.sessionId).toBeDefined();
  });

  test('mergeExtracted adds items with stable ids and open status', () => {
    const led = ledger.load(sessionId);
    ledger.mergeExtracted(led, [
      { kind: 'question', text: 'What is the deploy command?' },
      { kind: 'task', text: 'Fix the login bug' },
    ]);

    expect(led.items).toHaveLength(2);
    expect(led.items[0].status).toBe('open');
    expect(led.items[0].id).toMatch(/^q/);
    expect(led.items[1].id).toMatch(/^t/);
  });

  test('mergeExtracted dedupes by normalized text', () => {
    const led = { sessionId: 'dedupe-test', items: [] };

    ledger.mergeExtracted(led, [{ kind: 'task', text: 'Fix the login bug' }]);
    expect(led.items).toHaveLength(1);

    // Same ask, different punctuation/casing/whitespace.
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'FIX   the login bug!!' }]);
    expect(led.items).toHaveLength(1);
  });

  test('mergeExtracted dedupes paraphrases of the same ask', () => {
    // Regression: the same request extracted twice with different wording
    // produced duplicate items (t1/t5, t2/t6, ...). Exact-text dedupe is not
    // enough because the extractor is an LLM and paraphrases freely.
    const led = { sessionId: 'paraphrase-test', items: [] };

    ledger.mergeExtracted(led, [
      { kind: 'task', text: 'Create a Git repo for the project, ensuring no local machine paths are exposed' },
      { kind: 'task', text: 'Make the repo public and safe for others to use' },
    ]);
    expect(led.items).toHaveLength(2);

    ledger.mergeExtracted(led, [
      { kind: 'task', text: 'Create a git repository for the project with no local machine paths exposed' },
      { kind: 'task', text: 'Make the repository public and safe for others' },
    ]);

    expect(led.items).toHaveLength(2);
    expect(led.items.map((i) => i.id)).toEqual(['t1', 't2']);
  });

  test('mergeExtracted keeps genuinely distinct items', () => {
    // The paraphrase guard must not collapse two different asks.
    const led = { sessionId: 'distinct-test', items: [] };

    ledger.mergeExtracted(led, [
      { kind: 'task', text: 'Fix the login bug' },
      { kind: 'task', text: 'Fix the logout bug' },
      { kind: 'question', text: 'What is the deploy command?' },
      { kind: 'question', text: 'What is the rollback command?' },
    ]);

    expect(led.items).toHaveLength(4);
  });

  test('mergeExtracted ignores empty text', () => {
    const led = ledger.load(sessionId);
    const before = led.items.length;
    ledger.mergeExtracted(led, [
      { kind: 'task', text: '   ' },
      { kind: 'task', text: '' },
      { kind: 'task' },
    ]);
    expect(led.items).toHaveLength(before);
  });

  test('openItems filters out closed items', () => {
    const led = { sessionId: 'open-test', items: [] };
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'unique-open-item-xyz' }]);
    expect(ledger.openItems(led)).toHaveLength(1);

    ledger.applyVerdicts(led, [{ id: led.items[0].id, status: 'done', note: 'did it' }]);
    expect(ledger.openItems(led)).toHaveLength(0);
  });

  test('applyVerdicts records status, timestamp and note', () => {
    const led = { sessionId: 'verdict-test', items: [] };
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'verdict-target-abc' }]);
    const id = led.items[0].id;

    ledger.applyVerdicts(led, [{ id, status: 'done', note: 'evidence here' }]);

    expect(led.items[0].status).toBe('done');
    expect(led.items[0].closedAt).toBeTruthy();
    expect(led.items[0].note).toBe('evidence here');
  });

  test('applyVerdicts ignores unknown ids', () => {
    const led = { sessionId: 'unknown-test', items: [] };
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'stays-open-item' }]);

    ledger.applyVerdicts(led, [{ id: 'does-not-exist', status: 'done' }]);

    expect(led.items[0].status).toBe('open');
  });

  test('applyVerdicts can reopen an item', () => {
    const led = { sessionId: 'reopen-test', items: [] };
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'reopen-target-def' }]);
    const id = led.items[0].id;

    ledger.applyVerdicts(led, [{ id, status: 'done' }]);
    expect(led.items[0].status).toBe('done');

    ledger.applyVerdicts(led, [{ id, status: 'open' }]);
    expect(led.items[0].status).toBe('open');
    expect(led.items[0].closedAt).toBeNull();
  });

  test('isFullyResolved is false for an empty ledger', () => {
    // An empty ledger may be a session that has not had its first prompt
    // extracted yet, so it must not be pruned.
    expect(ledger.isFullyResolved({ items: [] })).toBe(false);
  });

  test('isFullyResolved is true only when every item is closed', () => {
    expect(ledger.isFullyResolved({
      items: [{ status: 'done' }, { status: 'dropped' }],
    })).toBe(true);

    expect(ledger.isFullyResolved({
      items: [{ status: 'done' }, { status: 'open' }],
    })).toBe(false);
  });

  test('renderNudge lists open items and omits closed ones', () => {
    const led = { sessionId: 'nudge-test', items: [] };
    ledger.mergeExtracted(led, [
      { kind: 'question', text: 'nudge-visible-question' },
      { kind: 'task', text: 'nudge-closed-task' },
    ]);
    ledger.applyVerdicts(led, [{ id: led.items[1].id, status: 'done' }]);

    const nudge = ledger.renderNudge(led);
    expect(nudge).toContain('nudge-visible-question');
    expect(nudge).not.toContain('nudge-closed-task');
  });

  test('renderNudge returns empty string when nothing is open', () => {
    expect(ledger.renderNudge({ items: [] })).toBe('');
  });

  test('ledgerPath sanitizes session ids against path traversal', () => {
    // A session id is attacker-influenced in principle (it comes from the
    // harness), so it must never escape the ledger directory.
    const p = ledger.ledgerPath('../../etc/passwd');
    expect(p).not.toContain('..');
    expect(p).not.toContain('/etc/');
  });
});
