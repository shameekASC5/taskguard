#!/usr/bin/env node
'use strict';

/**
 * Show exactly what the audit will see for a session.
 *
 * This exists because the audit's behaviour is otherwise invisible: when the
 * Stop hook blocks a turn that is obviously complete, the question is always
 * "what text did it actually read?". This prints that text.
 *
 * Usage:
 *   node tools/audit-preview.cjs <sessionId> [--transcript PATH] [--json]
 *   node tools/audit-preview.cjs --latest
 *
 * It does NOT call the model. It shows the inputs, so you can judge whether
 * the audit had enough to work with.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ledger = require('../core/ledger.cjs');

/** Locate the newest VS Code transcript, or the one for a session id. */
function findTranscript(sessionId) {
  const roots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    path.join(os.homedir(), '.config', 'Code', 'User', 'workspaceStorage'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
  ];
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') && p.includes('transcripts')) found.push(p);
    }
  };
  for (const r of roots) walk(r);

  if (sessionId) {
    const match = found.find((f) => f.includes(sessionId));
    if (match) return match;
  }
  // Newest by mtime.
  return found
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.f || null;
}

/**
 * Mirror of the adapter's parser. Kept in sync deliberately: this tool exists
 * to show what the adapter sees, so it must use the same logic.
 */
function extractTurnText(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }

  const collectFrom = (from) => {
    const out = [];
    for (let i = from; i < entries.length; i += 1) {
      const entry = entries[i];
      if (i > from && entry.type === 'assistant.turn_start') break;
      if (entry.type === 'assistant.message') {
        const content = entry.data?.content;
        if (typeof content === 'string' && content.trim()) out.push(content);
        continue;
      }
      const role = entry.role || entry.message?.role;
      if (role === 'assistant') {
        const content = entry.content ?? entry.message?.content ?? entry.text;
        if (typeof content === 'string' && content.trim()) out.push(content);
      }
    }
    return out.join('\n\n');
  };

  const turnStarts = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].type === 'assistant.turn_start') turnStarts.push(i);
  }

  const MIN_CHARS = 6000;
  const MAX_TURNS = 200;

  const seen = new Set();
  const collected = [];
  let total = 0;
  for (const start of turnStarts.slice(0, MAX_TURNS)) {
    const text = collectFrom(start).trim();
    if (!text) continue;
    const key = text;
    if (seen.has(key)) continue;
    seen.add(key);
    collected.unshift(text);
    total += text.length;
    if (total >= MIN_CHARS) break;
  }

  const text = collected.length > 0 ? collected.join('\n\n') : collectFrom(0);
  return { text, entries: entries.length, turns: turnStarts.length };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const latest = args.includes('--latest');
  const tIdx = args.indexOf('--transcript');
  const explicit = tIdx >= 0 ? args[tIdx + 1] : null;
  const sessionId = args.find((a) => !a.startsWith('--') && a !== explicit) || null;

  const transcript = explicit || findTranscript(latest ? null : sessionId);
  if (!transcript) {
    process.stderr.write('No transcript found. Pass --transcript PATH.\n');
    process.exit(1);
  }

  const { text, entries, turns } = extractTurnText(transcript);
  const sid = sessionId || path.basename(transcript, '.jsonl');
  const led = ledger.load(sid);
  const open = ledger.openItems(led);

  if (json) {
    process.stdout.write(`${JSON.stringify({
      transcript,
      sessionId: sid,
      transcriptEntries: entries,
      turns,
      auditInputChars: text.length,
      openItems: open.map((i) => ({ id: i.id, kind: i.kind, text: i.text })),
      auditInput: text,
    }, null, 2)}\n`);
    return;
  }

  console.log('=== audit preview ===');
  console.log(`transcript:   ${transcript}`);
  console.log(`session:      ${sid}`);
  console.log(`entries:      ${entries}  (${turns} turns)`);
  console.log(`open items:   ${open.length}`);
  console.log('');
  console.log(`AUDIT INPUT:  ${text.length} chars`);
  if (text.length < 400) {
    console.log('  WARNING: very short. The audit may not have enough to judge.');
    console.log('  This usually means the turn had no substantive assistant text.');
  }
  console.log('');
  console.log('--- open items the audit is asked about ---');
  if (open.length === 0) console.log('  (none)');
  for (const i of open) console.log(`  [${i.id}] (${i.kind}) ${i.text}`);
  console.log('');
  console.log('--- text the audit reads (first 1200 chars) ---');
  console.log(text.slice(0, 1200) || '(empty)');
  if (text.length > 1200) console.log(`\n... ${text.length - 1200} more chars`);
}

main();
