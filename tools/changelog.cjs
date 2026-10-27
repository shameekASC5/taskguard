#!/usr/bin/env node
'use strict';

/**
 * changelog — regenerate a session changelog, or query the central index.
 *
 *   node tools/changelog.cjs --latest              regenerate the newest session
 *   node tools/changelog.cjs <sessionId>           regenerate one session
 *   node tools/changelog.cjs --list                list indexed sessions
 *   node tools/changelog.cjs --list --kind code    filter by activity class
 *   node tools/changelog.cjs --list --since 7d     filter by age
 *   node tools/changelog.cjs --list --json         machine-readable
 *
 * The Stop hook writes changelogs automatically. This tool exists for the two
 * cases it cannot cover: regenerating after the fact, and asking questions
 * across sessions ("what did agents touch this week").
 */

const fs = require('node:fs');
const path = require('node:path');
const journal = require('../core/journal.cjs');
const changelog = require('../core/changelog.cjs');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const green = c('32');
const yellow = c('33');
const cyan = c('36');

/** Parse "7d", "24h", "30m" into milliseconds. */
function parseAge(spec) {
  const m = String(spec || '').match(/^(\d+)([dhm])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { d: 86400000, h: 3600000, m: 60000 }[m[2]];
  return n * unit;
}

function latestSession() {
  let names;
  try {
    names = fs.readdirSync(journal.LEDGER_DIR).filter((n) => n.endsWith('.progress.jsonl'));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const newest = names
    .map((n) => ({ n, m: fs.statSync(path.join(journal.LEDGER_DIR, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return newest.n.replace('.progress.jsonl', '');
}

function listIndex(opts) {
  let records = changelog.readIndex(5000);

  if (opts.kind) records = records.filter((r) => r.kind === opts.kind);

  if (opts.since) {
    const ms = parseAge(opts.since);
    if (ms === null) {
      console.error(`invalid --since value: ${opts.since} (use 7d, 24h, 30m)`);
      return 2;
    }
    const cutoff = Date.now() - ms;
    records = records.filter((r) => Date.parse(r.at) >= cutoff);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }

  if (!records.length) {
    console.log(dim('No indexed sessions match.'));
    return 0;
  }

  // Newest first for reading.
  records = [...records].reverse();

  console.log(bold('═══ session index ═══'));
  console.log('');

  for (const r of records) {
    const when = new Date(r.at).toISOString().replace('T', ' ').slice(0, 16);
    const kindColor = r.kind === 'code' ? green : r.kind === 'research' ? cyan : yellow;
    const ws = r.workspace ? path.basename(r.workspace) : '(none)';
    console.log(
      `${dim(when)} ${kindColor(r.kind.padEnd(10))} ${bold(ws)} `
      + `${dim(`${r.turns}t/${r.tools}c`)}`
    );
    for (const h of (r.headlines || []).slice(0, 3)) console.log(`    ${h}`);
    if ((r.headlines || []).length > 3) {
      console.log(dim(`    …and ${r.headlines.length - 3} more`));
    }
  }

  const byKind = records.reduce((acc, r) => {
    acc[r.kind] = (acc[r.kind] || 0) + 1;
    return acc;
  }, {});
  console.log('');
  console.log(dim(`${records.length} session(s): ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`));
  return 0;
}

function regenerate(sessionId) {
  const turns = journal.readProgress(sessionId);
  const tools = journal.readTelemetry(sessionId);

  if (!turns.length && !tools.length) {
    console.error(`No journal records for session "${sessionId}".`);
    return 1;
  }

  // The workspace is not stored in the journal, so take it from the index if
  // this session was written before, else fall back to cwd.
  const prior = changelog.readIndex(5000).filter((r) => r.sessionId === sessionId).pop();
  const workspace = prior?.workspace || process.cwd();

  const r = changelog.write({
    sessionId,
    workspace,
    gitRoot: changelog.gitRoot(workspace),
    turns,
    tools,
  });

  if (r.written) {
    console.log(`${green('✔')} wrote ${r.path}`);
    console.log(dim(`  activity: ${r.kind} · ${turns.length} turn(s) · ${tools.length} tool call(s)`));
    return 0;
  }

  console.error(`Could not write changelog: ${r.error || 'unknown reason'}`);
  return 1;
}

function main(argv) {
  const args = argv.slice(2);

  const opts = {
    list: args.includes('--list'),
    json: args.includes('--json'),
    kind: args.includes('--kind') ? args[args.indexOf('--kind') + 1] : null,
    since: args.includes('--since') ? args[args.indexOf('--since') + 1] : null,
  };

  if (opts.list) return listIndex(opts);

  let sessionId = args.find((a) => !a.startsWith('--')
    && a !== opts.kind && a !== opts.since);

  if (args.includes('--latest') || !sessionId) sessionId = latestSession();
  if (!sessionId) {
    console.error('No sessions found. Pass a session id, or run a turn first.');
    return 2;
  }

  return regenerate(sessionId);
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { listIndex, regenerate, parseAge, latestSession };
