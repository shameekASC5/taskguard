#!/usr/bin/env node
'use strict';

/**
 * CAPS REPORT — are the input caps right for THIS user's history?
 *
 * Reads the local VS Code chat transcripts, measures real prompt and response
 * sizes, and reports what percentage the configured caps would truncate.
 *
 * This is the "discovery" step of self-service setup: run it once after
 * installing, and it tells you whether to raise LEDGER_MAX_PROMPT_CHARS.
 *
 * Usage: node caps-report.cjs [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROMPT_CAP = Number(process.env.LEDGER_MAX_PROMPT_CHARS) || 16000;
const RESPONSE_CAP = Number(process.env.LEDGER_MAX_RESPONSE_CHARS) || 12000;

function findTranscripts() {
  const roots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    path.join(os.homedir(), '.config', 'Code', 'User', 'workspaceStorage'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
  ];
  const out = [];
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
      else if (e.name.endsWith('.jsonl') && p.includes('transcripts')) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

function stats(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  const mean = a.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const pct = (p) => a[Math.min(n - 1, Math.floor(p * n))];
  return {
    n,
    mean: Math.round(mean),
    sd: Math.round(sd),
    p50: pct(0.5),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
    max: a[n - 1],
  };
}

function truncationRate(arr, cap) {
  if (!arr.length) return 0;
  return arr.filter((v) => v > cap).length / arr.length;
}

function main() {
  const files = findTranscripts();
  const prompts = [];
  const responses = [];

  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === 'user.message' && typeof e.data?.content === 'string') {
        prompts.push(e.data.content.length);
      }
      if (e.type === 'assistant.message' && typeof e.data?.content === 'string') {
        responses.push(e.data.content.length);
      }
    }
  }

  const pStats = stats(prompts);
  const rStats = stats(responses);
  const pTrunc = truncationRate(prompts, PROMPT_CAP);
  const rTrunc = truncationRate(responses, RESPONSE_CAP);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      transcripts: files.length,
      promptCap: PROMPT_CAP,
      responseCap: RESPONSE_CAP,
      prompts: pStats,
      responses: rStats,
      promptTruncationRate: pTrunc,
      responseTruncationRate: rTrunc,
    }, null, 2)}\n`);
    return;
  }

  const pct = (x) => `${(x * 100).toFixed(2)}%`;

  console.log('=== Ledger input caps vs YOUR history ===');
  console.log(`transcripts scanned: ${files.length}`);
  console.log('');

  if (!pStats) {
    console.log('No chat transcripts found. Nothing to measure yet.');
    return;
  }

  console.log(`USER PROMPTS (cap ${PROMPT_CAP} chars)`);
  console.log(`  samples ${pStats.n}  mean ${pStats.mean}  sd ${pStats.sd}`);
  console.log(`  p50 ${pStats.p50}  p90 ${pStats.p90}  p95 ${pStats.p95}  p99 ${pStats.p99}  max ${pStats.max}`);
  console.log(`  truncated: ${pct(pTrunc)} of prompts`);
  console.log('');

  console.log(`ASSISTANT RESPONSES (cap ${RESPONSE_CAP} chars)`);
  console.log(`  samples ${rStats.n}  mean ${rStats.mean}  sd ${rStats.sd}`);
  console.log(`  p50 ${rStats.p50}  p90 ${rStats.p90}  p95 ${rStats.p95}  p99 ${rStats.p99}  max ${rStats.max}`);
  console.log(`  truncated: ${pct(rTrunc)} of responses`);
  console.log('');

  console.log('=== Verdict ===');
  if (pTrunc > 0.02) {
    const suggested = Math.ceil(pStats.p99 / 1000) * 1000;
    console.log(`Prompts: ${pct(pTrunc)} truncated. Consider raising the cap:`);
    console.log(`  LEDGER_MAX_PROMPT_CHARS=${suggested}   (covers p99)`);
  } else {
    console.log(`Prompts: fine (${pct(pTrunc)} truncated).`);
  }
  if (rTrunc > 0.02) {
    const suggested = Math.ceil(rStats.p99 / 1000) * 1000;
    console.log(`Responses: ${pct(rTrunc)} truncated. Consider:`);
    console.log(`  LEDGER_MAX_RESPONSE_CHARS=${suggested}`);
  } else {
    console.log(`Responses: fine (${pct(rTrunc)} truncated).`);
  }
  console.log('');
  console.log('Truncation only affects the ledger\'s view of the text, never your');
  console.log('actual conversation. A truncated prompt may yield fewer extracted');
  console.log('items; a truncated response may leave an item marked open.');
}

main();
