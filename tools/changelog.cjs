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

/** Default cap for --list. Override with --all. */
const LIST_LIMIT = 5000;

function listIndex(opts) {
  // --all reads everything. The default caps the read so a very large index
  // does not blow up the terminal, but the cap is reported rather than silent.
  const limit = opts.all ? Infinity : LIST_LIMIT;
  let records = changelog.readIndex(limit);
  const total = records.total;
  const truncated = records.truncated;

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
    if (truncated) {
      console.log(dim(`(note: only the newest ${limit} of ${total} records were read — use --all)`));
    }
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

  // Say so when the view is partial. A list that looks complete but is missing
  // history is worse than one that admits it.
  if (truncated) {
    console.log('');
    console.log(yellow(`⚠ showing the newest ${limit} of ${total} records`));
    console.log(dim(`  ${total - limit} older record(s) not shown — use --all to see everything`));
  }

  return 0;
}

/**
 * Prune the index.
 *
 *   --prune --keep 500     keep the newest 500 records
 *   --prune --older-than 30d   drop records older than 30 days
 *   --prune --dry-run      report what would go, change nothing
 */
function prune(opts) {
  const keep = opts.keep === null || opts.keep === undefined ? null : Number(opts.keep);
  const olderThanMs = opts.olderThan ? parseAge(opts.olderThan) : null;

  if (opts.olderThan && olderThanMs === null) {
    console.error(`invalid --older-than value: ${opts.olderThan} (use 30d, 24h, 60m)`);
    return 2;
  }
  if (keep !== null && (!Number.isFinite(keep) || keep < 0)) {
    console.error(`invalid --keep value: ${opts.keep} (use a non-negative integer)`);
    return 2;
  }
  if (keep === null && olderThanMs === null) {
    console.error('nothing to prune by. Pass --keep N or --older-than 30d.');
    console.error('  --prune --keep 500          keep the newest 500 records');
    console.error('  --prune --older-than 30d    drop records older than 30 days');
    console.error('  --prune --dry-run           report what would go, change nothing');
    return 2;
  }

  const result = changelog.pruneIndex({
    keep: keep === null ? undefined : keep,
    olderThanMs: olderThanMs === null ? undefined : olderThanMs,
    dryRun: opts.dryRun,
  });

  if (result.removed === 0) {
    console.log(`${green('✔')} nothing to prune — ${result.before} record(s), all kept`);
    return 0;
  }

  const verb = result.dryRun ? 'would remove' : 'removed';
  console.log(`${green('✔')} ${verb} ${result.removed} of ${result.before} record(s)`);
  console.log(dim(`  ${result.after} remaining`));
  if (result.dryRun) {
    console.log('');
    console.log(dim('  dry run — nothing was changed. Re-run without --dry-run to apply.'));
  }
  return 0;
}

/** Load a session's journal records, or null if there are none. */
function loadSession(sessionId) {
  const turns = journal.readProgress(sessionId);
  const tools = journal.readTelemetry(sessionId);
  if (!turns.length && !tools.length) return null;
  return { turns, tools };
}

/** Where this session's changelog lives, from the index or by derivation. */
function changelogPathFor(sessionId) {
  const prior = changelog.readIndex(Infinity).filter((r) => r.sessionId === sessionId).pop();
  return prior?.changelogPath || '';
}

/**
 * Print the changelog to stdout. Writes nothing.
 *
 * This is the read path. It renders from the journal rather than reading the
 * file, so it works even when the file was never written (LEDGER_CHANGELOG=0,
 * or a session that predates the feature).
 */
function show(sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    console.error(`No journal records for session "${sessionId}".`);
    return 1;
  }

  const prior = changelog.readIndex(Infinity).filter((r) => r.sessionId === sessionId).pop();
  const workspace = prior?.workspace || process.cwd();

  process.stdout.write(changelog.renderMarkdown({
    sessionId,
    workspace,
    gitRoot: changelog.gitRoot(workspace),
    turns: session.turns,
    tools: session.tools,
  }));
  return 0;
}

/** Print just the file path. Writes nothing. */
function showPath(sessionId) {
  const p = changelogPathFor(sessionId);
  if (!p) {
    console.error(`No changelog file recorded for session "${sessionId}".`);
    console.error(dim('  Run --write to generate one.'));
    return 1;
  }
  console.log(p);
  return 0;
}

/**
 * Regenerate the changelog file on disk.
 *
 * The only command that writes. Says so, so it is never mistaken for a read.
 */
function regenerate(sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    console.error(`No journal records for session "${sessionId}".`);
    return 1;
  }

  // The workspace is not stored in the journal, so take it from the index if
  // this session was written before, else fall back to cwd.
  const prior = changelog.readIndex(Infinity).filter((r) => r.sessionId === sessionId).pop();
  const workspace = prior?.workspace || process.cwd();

  const r = changelog.write({
    sessionId,
    workspace,
    gitRoot: changelog.gitRoot(workspace),
    turns: session.turns,
    tools: session.tools,
  });

  if (r.written) {
    console.log(`${green('✔')} wrote ${r.path}`);
    console.log(dim(`  activity: ${r.kind} · ${session.turns.length} turn(s) · ${session.tools.length} tool call(s)`));
    return 0;
  }

  console.error(`Could not write changelog: ${r.error || 'unknown reason'}`);
  return 1;
}

/** Read the value after a flag, or null. */
function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
}

function usage() {
  console.log(`changelog — read a session changelog, or manage the index.

READING (no side effects)
  node tools/changelog.cjs --list                list indexed sessions
  node tools/changelog.cjs --list --kind code    filter by activity class
  node tools/changelog.cjs --list --since 7d     filter by age
  node tools/changelog.cjs --list --all          ignore the ${LIST_LIMIT}-record cap
  node tools/changelog.cjs --list --json         machine-readable

  node tools/changelog.cjs --show <sessionId>    print the changelog to stdout
  node tools/changelog.cjs --show --latest       print the newest one
  node tools/changelog.cjs --path <sessionId>    print just the file path

WRITING (regenerates the file on disk)
  node tools/changelog.cjs --write <sessionId>   regenerate one session
  node tools/changelog.cjs --write --latest      regenerate the newest

MAINTENANCE
  node tools/changelog.cjs --prune --keep 500        keep the newest 500
  node tools/changelog.cjs --prune --older-than 30d  drop records older than 30d
  node tools/changelog.cjs --prune --dry-run         report, change nothing

--show and --path never write anything. --write is the only command that
regenerates a file, and it says so when it does.

The index is append-only and never pruned automatically. --list reads the
newest ${LIST_LIMIT} records by default and says so when it truncates.`);
}

function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return 0;
  }

  const opts = {
    list: args.includes('--list'),
    json: args.includes('--json'),
    all: args.includes('--all'),
    dryRun: args.includes('--dry-run'),
    kind: flagValue(args, '--kind'),
    since: flagValue(args, '--since'),
    keep: flagValue(args, '--keep'),
    olderThan: flagValue(args, '--older-than'),
  };

  if (args.includes('--prune')) return prune(opts);
  if (opts.list) return listIndex(opts);

  // A bare positional that is not a flag value is the session id.
  const consumed = new Set([opts.kind, opts.since, opts.keep, opts.olderThan].filter(Boolean));
  let sessionId = args.find((a) => !a.startsWith('--') && !consumed.has(a));

  if (args.includes('--latest') || !sessionId) sessionId = latestSession();
  if (!sessionId) {
    console.error('No sessions found. Pass a session id, or run a turn first.');
    return 2;
  }

  // Explicit verbs. A bare session id used to regenerate silently, which made
  // it impossible to tell a read from a write.
  if (args.includes('--show')) return show(sessionId);
  if (args.includes('--path')) return showPath(sessionId);
  if (args.includes('--write')) return regenerate(sessionId);

  // No verb: default to the read path, and say how to write.
  const rc = show(sessionId);
  if (rc === 0) {
    console.error('');
    console.error(dim(`(read-only. To regenerate the file: --write ${sessionId})`));
  }
  return rc;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { listIndex, regenerate, parseAge, latestSession };
