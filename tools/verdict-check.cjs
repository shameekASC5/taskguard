#!/usr/bin/env node
/**
 * verdict-check — validate a verdict payload before it touches the ledger.
 *
 * The reconcile step asks a model to return JSON. Models are unreliable:
 * they omit ids, invent ids, use statuses we do not recognise, return a bare
 * array instead of an object, or wrap the whole thing in prose. Every one of
 * those failure modes has been observed in this project.
 *
 * `applyVerdicts` is defensive, but "defensive" means "silently ignores the
 * bad parts" — which is how a turn ends up blocked with no explanation. This
 * tool makes the failure loud and inspectable instead.
 *
 * Usage:
 *   node tools/verdict-check.cjs <file.json>          # validate a payload
 *   node tools/verdict-check.cjs --stdin              # read from stdin
 *   node tools/verdict-check.cjs <file> --items a,b,c # also check coverage
 *   node tools/verdict-check.cjs --self-test          # run built-in cases
 *
 * Exit codes:
 *   0  payload is valid (and covers every expected item, if --items given)
 *   1  payload is invalid
 *   2  usage error
 */

'use strict';

const fs = require('fs');

const VALID_STATUSES = new Set(['done', 'dropped', 'open']);

// Statuses models actually emit, mapped to what we store. Kept in sync with
// STATUS_ALIASES in core/ledger.cjs — if you add one there, add it here.
const STATUS_ALIASES = {
  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  resolved: 'done',
  addressed: 'done',
  dropped: 'dropped',
  cancelled: 'dropped',
  canceled: 'dropped',
  removed: 'dropped',
  obsolete: 'dropped',
  not_needed: 'dropped',
  open: 'open',
  pending: 'open',
  not_done: 'open',
  incomplete: 'open',
  blocked: 'open',
  todo: 'open',
};

function normaliseStatus(raw) {
  if (typeof raw !== 'string') return null;
  return STATUS_ALIASES[raw.trim().toLowerCase()] || null;
}

/**
 * Pull a verdict array out of whatever the model actually returned.
 * Accepts: {verdicts:[...]}, a bare array, or a JSON string of either.
 */
function unwrap(payload) {
  let value = payload;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (err) {
      return { error: `payload is not valid JSON: ${err.message}` };
    }
  }

  if (Array.isArray(value)) return { verdicts: value };

  if (value && typeof value === 'object') {
    for (const key of ['verdicts', 'results', 'items', 'data']) {
      if (Array.isArray(value[key])) return { verdicts: value[key] };
    }
    return { error: `object has no verdict array (keys: ${Object.keys(value).join(', ') || 'none'})` };
  }

  return { error: `payload is ${value === null ? 'null' : typeof value}, expected object or array` };
}

/**
 * Validate a payload. Returns a report; never throws.
 *
 * @param {*} payload  parsed JSON, raw JSON string, or array
 * @param {string[]} [expectedIds]  ids that must all be present
 */
function check(payload, expectedIds) {
  const problems = [];
  const warnings = [];

  const unwrapped = unwrap(payload);
  if (unwrapped.error) {
    return { ok: false, problems: [unwrapped.error], warnings, verdicts: [], stats: {} };
  }

  const raw = unwrapped.verdicts;
  if (raw.length === 0) {
    problems.push('verdict array is empty — the model returned nothing usable');
  }

  const verdicts = [];
  const seen = new Map();

  raw.forEach((entry, index) => {
    const where = `verdict[${index}]`;

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where}: expected an object, got ${Array.isArray(entry) ? 'array' : typeof entry}`);
      return;
    }

    const id = entry.id;
    if (typeof id !== 'string' || id.trim() === '') {
      problems.push(`${where}: missing or non-string "id"`);
      return;
    }

    const status = normaliseStatus(entry.status);
    if (!status) {
      problems.push(`${where} (${id}): unrecognised status ${JSON.stringify(entry.status)}`);
      return;
    }

    if (seen.has(id)) {
      // Duplicate ids are a real model failure mode. Last one wins in
      // applyVerdicts, which is arbitrary — flag it.
      problems.push(`${where}: duplicate id "${id}" (first seen at verdict[${seen.get(id)}])`);
      return;
    }
    seen.set(id, index);

    if (entry.note !== undefined && typeof entry.note !== 'string') {
      warnings.push(`${where} (${id}): "note" is ${typeof entry.note}, expected string — will be ignored`);
    }

    verdicts.push({
      id,
      status,
      note: typeof entry.note === 'string' ? entry.note : '',
      rawStatus: entry.status,
    });
  });

  if (expectedIds && expectedIds.length) {
    const expected = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !seen.has(id));
    const extra = [...seen.keys()].filter((id) => !expected.has(id));

    if (missing.length) {
      problems.push(`missing verdicts for ${missing.length} item(s): ${missing.join(', ')}`);
    }
    if (extra.length) {
      warnings.push(`verdicts for ${extra.length} unknown id(s): ${extra.join(', ')}`);
    }
  }

  const stats = {
    total: verdicts.length,
    done: verdicts.filter((v) => v.status === 'done').length,
    dropped: verdicts.filter((v) => v.status === 'dropped').length,
    open: verdicts.filter((v) => v.status === 'open').length,
    normalised: verdicts.filter((v) => v.rawStatus !== v.status).length,
  };

  return { ok: problems.length === 0, problems, warnings, verdicts, stats };
}

// ---------------------------------------------------------------------------
// Self-test: the failure modes we have actually hit, as fixtures.
// ---------------------------------------------------------------------------

const SELF_TESTS = [
  {
    name: 'well-formed payload',
    payload: { verdicts: [{ id: 't1', status: 'done', note: 'committed abc123' }] },
    expect: 'ok',
  },
  {
    name: 'bare array instead of object',
    payload: [{ id: 't1', status: 'done' }],
    expect: 'ok',
  },
  {
    name: 'JSON string payload',
    payload: '{"verdicts":[{"id":"t1","status":"done"}]}',
    expect: 'ok',
  },
  {
    name: 'status aliases normalise',
    payload: { verdicts: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'not_done' }] },
    expect: 'ok',
    check: (r) => r.verdicts[0].status === 'done' && r.verdicts[1].status === 'open',
  },
  {
    name: 'unknown status rejected',
    payload: { verdicts: [{ id: 't1', status: 'probably' }] },
    expect: 'fail',
  },
  {
    name: 'missing id rejected',
    payload: { verdicts: [{ status: 'done' }] },
    expect: 'fail',
  },
  {
    name: 'duplicate id rejected',
    payload: { verdicts: [{ id: 't1', status: 'done' }, { id: 't1', status: 'open' }] },
    expect: 'fail',
  },
  {
    name: 'empty array rejected',
    payload: { verdicts: [] },
    expect: 'fail',
  },
  {
    name: 'null rejected',
    payload: null,
    expect: 'fail',
  },
  {
    name: 'prose instead of JSON rejected',
    payload: 'Here are the verdicts you asked for: all done!',
    expect: 'fail',
  },
  {
    name: 'missing expected id rejected',
    payload: { verdicts: [{ id: 't1', status: 'done' }] },
    expectedIds: ['t1', 't2'],
    expect: 'fail',
  },
  {
    name: 'extra unknown id is only a warning',
    payload: { verdicts: [{ id: 't1', status: 'done' }, { id: 'zz', status: 'done' }] },
    expectedIds: ['t1'],
    expect: 'ok',
  },
];

function selfTest() {
  let failed = 0;

  for (const test of SELF_TESTS) {
    const report = check(test.payload, test.expectedIds);
    const wantOk = test.expect === 'ok';
    let pass = report.ok === wantOk;

    if (pass && test.check) pass = test.check(report);

    if (pass) {
      console.log(`  PASS  ${test.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${test.name}`);
      console.log(`        expected ${test.expect}, got ${report.ok ? 'ok' : 'fail'}`);
      report.problems.forEach((p) => console.log(`        - ${p}`));
    }
  }

  console.log('');
  console.log(`${SELF_TESTS.length - failed}/${SELF_TESTS.length} self-tests passed`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--self-test')) return selfTest();

  const itemsFlag = args.indexOf('--items');
  const expectedIds = itemsFlag !== -1 && args[itemsFlag + 1]
    ? args[itemsFlag + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  let source;
  if (args.includes('--stdin')) {
    source = fs.readFileSync(0, 'utf8');
  } else {
    const file = args.find((a) => !a.startsWith('--') && a !== args[itemsFlag + 1]);
    if (!file) {
      console.error('usage: verdict-check <file.json> [--items a,b,c] | --stdin | --self-test');
      return 2;
    }
    source = fs.readFileSync(file, 'utf8');
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    console.error(`invalid JSON: ${err.message}`);
    return 1;
  }

  const report = check(parsed, expectedIds);

  console.log(`verdicts: ${report.stats.total || 0}`);
  if (report.stats.total) {
    console.log(`  done:    ${report.stats.done}`);
    console.log(`  dropped: ${report.stats.dropped}`);
    console.log(`  open:    ${report.stats.open}`);
    if (report.stats.normalised) {
      console.log(`  (${report.stats.normalised} status value(s) normalised from aliases)`);
    }
  }

  if (report.warnings.length) {
    console.log('');
    report.warnings.forEach((w) => console.log(`WARN  ${w}`));
  }

  if (report.problems.length) {
    console.log('');
    report.problems.forEach((p) => console.log(`ERROR ${p}`));
    console.log('');
    console.log('INVALID');
    return 1;
  }

  console.log('');
  console.log('VALID');
  return 0;
}

module.exports = { check, normaliseStatus, unwrap, STATUS_ALIASES, VALID_STATUSES };

if (require.main === module) {
  process.exit(main(process.argv));
}
