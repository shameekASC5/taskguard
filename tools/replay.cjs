#!/usr/bin/env node
'use strict';

/**
 * replay — watch an agent session climb the hill.
 *
 *   node tools/replay.cjs <sessionId>          full timeline
 *   node tools/replay.cjs <sessionId> --turns  turn summaries only
 *   node tools/replay.cjs <sessionId> --follow live, like tail -f
 *   node tools/replay.cjs --latest             most recent session
 *   node tools/replay.cjs <sessionId> --otlp   export as OTLP/JSON
 *   node tools/replay.cjs <sessionId> --json   raw records
 *
 * This is meant to be read by a human, often. So it is dense, colour-coded,
 * and shows the shape of the work at a glance: how many tools per turn, where
 * the blockers were, how the open-item count fell.
 */

const fs = require('node:fs');
const path = require('node:path');
const journal = require('../core/journal.cjs');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const dim = c('2');
const bold = c('1');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');
const magenta = c('35');
const blue = c('34');

/** Tool name -> glyph. Makes the timeline scannable without reading names. */
const GLYPH = {
  run_in_terminal: '⌘',
  read_file: '👁',
  create_file: '✚',
  replace_string_in_file: '✎',
  multi_replace_string_in_file: '✎',
  grep_search: '🔍',
  file_search: '🔍',
  list_dir: '📁',
  create_directory: '📁',
  fetch_webpage: '🌐',
  view_image: '🖼',
  manage_todo_list: '☑',
  memory: '🧠',
  get_errors: '⚠',
  get_vscode_api: '📘',
};

function glyph(tool) {
  return GLYPH[tool] || '·';
}

function clock(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function elapsed(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  // Sessions routinely span midnight, so hours matter. Without this a
  // 35-minute session that crosses 00:00 renders as "2143m44s".
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** A tiny bar showing how many tools a turn used, relative to the busiest. */
function toolBar(count, max) {
  if (!count) return '';
  const width = Math.max(1, Math.round((count / Math.max(max, 1)) * 12));
  return dim('▏' + '█'.repeat(width));
}

function renderTurn(e, maxTools) {
  const out = [];
  const blocked = e.blocked === true;
  const flag = blocked ? red('⛔') : green('✓');
  const dur = e.startedAt && e.endedAt ? dim(` ${elapsed(e.startedAt, e.endedAt)}`) : '';

  // The headline sits on the turn line itself, so scanning the left column
  // tells the story of the session without reading any detail. This is the
  // whole point of the replay: "at this step it did that".
  //
  // Fallback: when there is no headline, use the first sentence of the
  // summary. Keep its terminating period — stripping it made the line read
  // like a truncated fragment.
  const firstSentence = (() => {
    const s = String(e.summary || '').trim();
    if (!s) return '';
    const m = s.match(/^[^.!?]*[.!?]/);
    return (m ? m[0] : s).slice(0, 80);
  })();

  const headline = e.headline
    ? ` ${bold(e.headline)}`
    : firstSentence
      ? ` ${dim(firstSentence)}`
      : ` ${dim('(no summary)')}`;

  out.push(
    `${dim(clock(e.at))} ${flag} ${dim(`t${e.turn ?? '?'}`)}${headline}`
    + `${dur} ${toolBar(e.toolCount, maxTools)}`
  );

  // Detail below, only when it adds something the headline did not say.
  for (const item of e.completed || []) out.push(`      ${green('✔')} ${item}`);
  for (const item of e.blockers || []) out.push(`      ${yellow('▲')} ${item}`);
  for (const item of e.next || []) out.push(`      ${cyan('→')} ${item}`);

  if (e.files?.length) {
    const shown = e.files.slice(0, 4).map((f) => path.basename(f));
    const more = e.files.length > 4 ? ` +${e.files.length - 4}` : '';
    out.push(`      ${dim('files: ' + shown.join(', ') + more)}`);
  }

  if (e.openCount != null) {
    const resolved = e.resolved ? green(` ↓${e.resolved}`) : '';
    out.push(`      ${dim(`open: ${e.openCount}`)}${resolved}`);
  }

  return out.join('\n');
}

function renderTool(e) {
  const ok = e.ok === false ? red(' ✗') : '';
  const intent = e.intent ? ` ${dim(e.intent)}` : '';
  return `${dim(clock(e.at))}   ${glyph(e.tool)} ${e.tool}${intent}${ok}`;
}

function render(events, opts = {}) {
  const turns = events.filter((e) => e.kind === 'turn');
  const tools = events.filter((e) => e.kind === 'tool');
  const maxTools = turns.reduce((m, t) => Math.max(m, t.toolCount || 0), 0);

  if (!events.length) {
    console.log(dim('No journal records for this session yet.'));
    console.log(dim('The journal is written by the Stop hook, so it fills in as turns complete.'));
    return;
  }

  // Header: the shape of the session at a glance.
  const first = events[0]?.at;
  const last = events[events.length - 1]?.at;
  const blockedCount = turns.filter((t) => t.blocked).length;
  const resolvedTotal = turns.reduce((n, t) => n + (t.resolved || 0), 0);

  console.log(bold('═══ session replay ═══'));
  console.log(
    `${dim('span')} ${clock(first)} → ${clock(last)} ${dim(`(${elapsed(first, last)})`)}  `
    + `${dim('turns')} ${bold(turns.length)}  `
    + `${dim('tools')} ${bold(tools.length)}  `
    + `${dim('resolved')} ${green(String(resolvedTotal))}  `
    + `${dim('blocked')} ${blockedCount ? red(String(blockedCount)) : '0'}`
  );
  console.log('');

  if (opts.turnsOnly) {
    for (const t of turns) console.log(renderTurn(t, maxTools) + '\n');
    return;
  }

  // Group tool calls under the turn they belong to.
  //
  // Sorting by timestamp alone is not enough: a turn's tools can share the
  // same second as the turn record, and clock skew between the transcript and
  // our own writes would interleave them wrongly. The `turn` field is the
  // reliable link, so we bucket by it and fall back to "most recent turn" for
  // records written before that field existed.
  const byTurn = new Map();
  const orphans = [];
  for (const e of tools) {
    if (Number.isFinite(e.turn)) {
      if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
      byTurn.get(e.turn).push(e);
    } else {
      orphans.push(e);
    }
  }

  for (const t of turns) {
    console.log(renderTurn(t, maxTools));
    const own = byTurn.get(t.turn) || [];
    for (const tool of own) console.log(renderTool(tool));
    console.log('');
  }

  // Tools with no turn number (older records) go at the end rather than being
  // silently dropped.
  if (orphans.length) {
    console.log(dim(`${orphans.length} tool call(s) with no turn number:`));
    for (const tool of orphans) console.log(renderTool(tool));
    console.log('');
  }
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

/**
 * Step through turns one at a time, waiting for Enter between each.
 *
 * Reading a 40-turn session as one wall of text is useless — you scroll past
 * the part you cared about. Stepping lets you actually read each turn and stop
 * when you have seen enough.
 *
 * Falls back to printing everything when stdin is not a TTY (piped output,
 * CI), because waiting for a keypress that can never arrive would hang.
 *
 * @param {Array} events   Full timeline.
 * @param {object} opts    { turnsOnly, maxTools }
 * @returns {Promise<number>} exit code
 */
function stepThrough(events, opts = {}) {
  const turns = events.filter((e) => e.kind === 'turn');
  const maxTools = turns.reduce((m, t) => Math.max(m, t.toolCount || 0), 0);

  if (!turns.length) {
    console.log(dim('No turns recorded for this session yet.'));
    return Promise.resolve(0);
  }

  // Group tools under their turn, same as the full render.
  const byTurn = new Map();
  for (const e of events.filter((x) => x.kind === 'tool')) {
    if (!Number.isFinite(e.turn)) continue;
    if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
    byTurn.get(e.turn).push(e);
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive) {
    // Not a terminal: print everything rather than block forever.
    render(events, opts);
    return Promise.resolve(0);
  }

  return new Promise((resolve) => {
    let i = 0;

    const show = () => {
      const t = turns[i];
      console.log('');
      console.log(renderTurn(t, maxTools));
      for (const tool of byTurn.get(t.turn) || []) console.log(renderTool(tool));
      console.log('');
      console.log(dim(`  turn ${i + 1} of ${turns.length}  ·  [enter] next  ·  [a] all  ·  [q] quit`));
    };

    const onData = (buf) => {
      const key = buf.toString().trim().toLowerCase();

      if (key === 'q' || key === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        console.log(dim('\nstopped.'));
        resolve(0);
        return;
      }

      if (key === 'a') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        console.log('');
        render(events, opts);
        resolve(0);
        return;
      }

      // Enter (or anything else) advances.
      i += 1;
      if (i >= turns.length) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        console.log(dim('end of session.'));
        resolve(0);
        return;
      }
      show();
    };

    // Raw mode so a single keypress advances, without needing Enter to be
    // echoed or the terminal to buffer a whole line.
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);

    console.log(bold(`═══ stepping through ${turns.length} turn(s) ═══`));
    show();
  });
}

function main(argv) {
  const args = argv.slice(2);
  const turnsOnly = args.includes('--turns');
  const follow = args.includes('--follow');
  const asOtlp = args.includes('--otlp');
  const asJson = args.includes('--json');
  const step = args.includes('--step') || args.includes('-i');
  const all = args.includes('--all');

  // --last N: show only the newest N turns. The common case when you are
  // watching a session live and do not want to re-read the whole history.
  const lastIdx = args.indexOf('--last');
  const lastN = lastIdx !== -1 ? Number(args[lastIdx + 1]) : null;
  if (lastIdx !== -1 && (!Number.isFinite(lastN) || lastN <= 0)) {
    console.error(`invalid --last value: ${args[lastIdx + 1]} (use a positive integer)`);
    return 2;
  }

  const consumed = new Set();
  if (lastIdx !== -1) consumed.add(args[lastIdx + 1]);
  let sessionId = args.find((a) => !a.startsWith('--') && !consumed.has(a));

  if (args.includes('--latest') || !sessionId) sessionId = latestSession();
  if (!sessionId) {
    console.error('No sessions found. Pass a session id, or run a turn first.');
    return 2;
  }

  if (asOtlp) {
    process.stdout.write(`${JSON.stringify(journal.toOtlp(sessionId), null, 2)}\n`);
    return 0;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(journal.timeline(sessionId), null, 2)}\n`);
    return 0;
  }

  let events = journal.timeline(sessionId);

  // Trim to the newest N turns, keeping each turn's tool calls with it.
  if (Number.isFinite(lastN)) {
    const turnRecords = events.filter((e) => e.kind === 'turn');
    const keep = new Set(turnRecords.slice(-lastN).map((t) => t.turn));
    events = events.filter((e) => e.kind !== 'turn' || keep.has(e.turn));
    events = events.filter((e) => e.kind !== 'tool' || keep.has(e.turn));
  }

  if (step && !all) {
    return stepThrough(events, { turnsOnly });
  }

  render(events, { turnsOnly });

  if (follow) {
    // Poll rather than fs.watch: the journal is append-only and polling is
    // portable. 1s is right for a 30-minute horizon; it would be wrong for
    // sub-second needs.
    let seen = journal.timeline(sessionId).length;
    console.log(dim(`following ${sessionId} — ctrl-c to stop`));
    setInterval(() => {
      const allEvents = journal.timeline(sessionId);
      if (allEvents.length > seen) {
        for (const e of allEvents.slice(seen)) {
          console.log(e.kind === 'turn' ? renderTurn(e, 0) : renderTool(e));
        }
        seen = allEvents.length;
      }
    }, 1000);
  }

  return 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { render, renderTurn, renderTool, latestSession, glyph, elapsed };
