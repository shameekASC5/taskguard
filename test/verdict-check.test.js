'use strict';

/**
 * Tests for tools/verdict-check.cjs.
 *
 * These cover the model failure modes we have actually observed, not
 * hypothetical ones. Each case below corresponds to a real bug or a real
 * malformed response seen during development.
 */

const { check, normaliseStatus, unwrap } = require('../tools/verdict-check.cjs');

describe('verdict-check — status normalisation', () => {
  test('maps the aliases models actually emit', () => {
    expect(normaliseStatus('done')).toBe('done');
    expect(normaliseStatus('completed')).toBe('done');
    expect(normaliseStatus('resolved')).toBe('done');
    expect(normaliseStatus('dropped')).toBe('dropped');
    expect(normaliseStatus('not_needed')).toBe('dropped');
    expect(normaliseStatus('open')).toBe('open');
    expect(normaliseStatus('not_done')).toBe('open');
    expect(normaliseStatus('pending')).toBe('open');
  });

  test('is case and whitespace insensitive', () => {
    expect(normaliseStatus('  DONE  ')).toBe('done');
    expect(normaliseStatus('Completed')).toBe('done');
  });

  test('returns null for unknown or non-string statuses', () => {
    expect(normaliseStatus('probably')).toBeNull();
    expect(normaliseStatus('')).toBeNull();
    expect(normaliseStatus(null)).toBeNull();
    expect(normaliseStatus(42)).toBeNull();
  });
});

describe('verdict-check — payload unwrapping', () => {
  test('accepts the documented object shape', () => {
    const r = unwrap({ verdicts: [{ id: 't1', status: 'done' }] });
    expect(r.verdicts).toHaveLength(1);
  });

  test('accepts a bare array', () => {
    const r = unwrap([{ id: 't1', status: 'done' }]);
    expect(r.verdicts).toHaveLength(1);
  });

  test('accepts a JSON string', () => {
    const r = unwrap('{"verdicts":[{"id":"t1","status":"done"}]}');
    expect(r.verdicts).toHaveLength(1);
  });

  test('accepts alternate array keys', () => {
    expect(unwrap({ results: [{ id: 't1', status: 'done' }] }).verdicts).toHaveLength(1);
    expect(unwrap({ items: [{ id: 't1', status: 'done' }] }).verdicts).toHaveLength(1);
  });

  test('reports an error for prose', () => {
    const r = unwrap('All done, nothing to report.');
    expect(r.error).toMatch(/not valid JSON/);
  });

  test('reports an error for null', () => {
    expect(unwrap(null).error).toMatch(/null/);
  });

  test('reports an error for an object with no verdict array', () => {
    expect(unwrap({ foo: 'bar' }).error).toMatch(/no verdict array/);
  });
});

describe('verdict-check — validation', () => {
  test('a clean payload is valid', () => {
    const r = check({ verdicts: [{ id: 't1', status: 'done', note: 'committed abc123' }] });
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(0);
    expect(r.verdicts[0]).toMatchObject({ id: 't1', status: 'done', note: 'committed abc123' });
  });

  test('normalises aliased statuses and records the original', () => {
    const r = check({ verdicts: [{ id: 't1', status: 'completed' }] });
    expect(r.ok).toBe(true);
    expect(r.verdicts[0].status).toBe('done');
    expect(r.verdicts[0].rawStatus).toBe('completed');
    expect(r.stats.normalised).toBe(1);
  });

  test('rejects an unknown status', () => {
    const r = check({ verdicts: [{ id: 't1', status: 'probably' }] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/unrecognised status/);
  });

  test('rejects a missing id', () => {
    const r = check({ verdicts: [{ status: 'done' }] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/missing or non-string "id"/);
  });

  test('rejects a duplicate id', () => {
    const r = check({ verdicts: [{ id: 't1', status: 'done' }, { id: 't1', status: 'open' }] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/duplicate id/);
  });

  test('rejects an empty verdict array', () => {
    const r = check({ verdicts: [] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/empty/);
  });

  test('rejects a non-object entry', () => {
    const r = check({ verdicts: ['done'] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/expected an object/);
  });

  test('warns but does not fail on a non-string note', () => {
    const r = check({ verdicts: [{ id: 't1', status: 'done', note: 42 }] });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/"note" is number/);
  });

  test('counts statuses correctly', () => {
    const r = check({
      verdicts: [
        { id: 'a', status: 'done' },
        { id: 'b', status: 'done' },
        { id: 'c', status: 'open' },
        { id: 'd', status: 'dropped' },
      ],
    });
    expect(r.stats).toMatchObject({ total: 4, done: 2, dropped: 1, open: 1 });
  });
});

describe('verdict-check — coverage against expected items', () => {
  test('fails when an expected id has no verdict', () => {
    const r = check({ verdicts: [{ id: 't1', status: 'done' }] }, ['t1', 't2']);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/missing verdicts for 1 item\(s\): t2/);
  });

  test('passes when every expected id is covered', () => {
    const r = check(
      { verdicts: [{ id: 't1', status: 'done' }, { id: 't2', status: 'open' }] },
      ['t1', 't2']
    );
    expect(r.ok).toBe(true);
  });

  test('an unknown extra id is a warning, not a failure', () => {
    const r = check(
      { verdicts: [{ id: 't1', status: 'done' }, { id: 'zz', status: 'done' }] },
      ['t1']
    );
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/unknown id/);
  });
});
