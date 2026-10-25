#!/usr/bin/env node
'use strict';

/**
 * COST REPORT — what will this hook cost me?
 *
 * Answers the question a new user actually has before installing: "how much
 * more will I pay per turn, and per session?"
 *
 * Method:
 *   1. Measure the user's own history (prompt and response sizes).
 *   2. Apply the configured caps to get worst-case and typical token counts.
 *   3. Multiply by the model's published price.
 *   4. Multiply by the user's average session length.
 *
 * Prices are per million tokens and are only defaults — override them with
 * LEDGER_PRICE_IN / LEDGER_PRICE_OUT if your provider charges differently.
 *
 * Usage: node cost-report.cjs [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROMPT_CAP = Number(process.env.LEDGER_MAX_PROMPT_CHARS) || 16000;
const RESPONSE_CAP = Number(process.env.LEDGER_MAX_RESPONSE_CHARS) || 12000;

/** Rough chars-per-token. Good enough for an estimate; not a tokenizer. */
const CHARS_PER_TOKEN = 4;

/**
 * Published prices, USD per 1M tokens, as of 2026-10.
 * These move; treat them as a starting point and override if needed.
 */
const PRICES = {
  'deepseek/deepseek-v4.1-flash': { in: 0.07, out: 0.28 },
  'deepseek/deepseek-v4-flash': { in: 0.07, out: 0.28 },
  'deepseek/deepseek-chat': { in: 0.27, out: 1.10 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
  'llama3.2': { in: 0, out: 0 },
};

function priceFor(model) {
  const overrideIn = Number(process.env.LEDGER_PRICE_IN);
  const overrideOut = Number(process.env.LEDGER_PRICE_OUT);
  if (Number.isFinite(overrideIn) && Number.isFinite(overrideOut)) {
    return { in: overrideIn, out: overrideOut, source: 'env override' };
  }
  const known = PRICES[model];
  if (known) return { ...known, source: 'built-in table' };
  // Unknown model: assume a mid-range price so the estimate is not falsely low.
  return { in: 0.50, out: 1.50, source: 'unknown model, assumed mid-range' };
}

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

/**
 * Read transcripts and return per-session turn counts plus text sizes.
 * A "turn" is one user prompt; the assistant response that follows it is the
 * text the audit hook sees.
 */
function measure() {
  const files = findTranscripts();
  const prompts = [];
  const responses = [];
  const turnsPerSession = [];

  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let turns = 0;
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
        turns += 1;
      }
      if (e.type === 'assistant.message' && typeof e.data?.content === 'string') {
        responses.push(e.data.content.length);
      }
    }
    if (turns > 0) turnsPerSession.push(turns);
  }

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };

  return {
    transcripts: files.length,
    prompts,
    responses,
    turnsPerSession,
    avgTurns: mean(turnsPerSession),
    medianTurns: median(turnsPerSession),
    avgPromptChars: mean(prompts),
    avgResponseChars: mean(responses),
  };
}

function main() {
  const m = measure();
  const model = process.env.LEDGER_MODEL || 'deepseek/deepseek-v4.1-flash';
  const price = priceFor(model);

  // Two calls per turn:
  //   extract: prompt text in, small JSON out
  //   audit:   response text in, small JSON out
  const OUT_TOKENS = 512; // max_tokens cap on both calls

  const typicalPromptTok = Math.min(m.avgPromptChars, PROMPT_CAP) / CHARS_PER_TOKEN;
  const typicalResponseTok = Math.min(m.avgResponseChars, RESPONSE_CAP) / CHARS_PER_TOKEN;
  const worstPromptTok = PROMPT_CAP / CHARS_PER_TOKEN;
  const worstResponseTok = RESPONSE_CAP / CHARS_PER_TOKEN;

  const perTurn = (inTok, outTok) => ((inTok * price.in) + (outTok * price.out)) / 1e6;

  const typicalPerTurn = perTurn(typicalPromptTok + typicalResponseTok, OUT_TOKENS * 2);
  const worstPerTurn = perTurn(worstPromptTok + worstResponseTok, OUT_TOKENS * 2);

  const avgTurns = m.avgTurns || 10;
  const typicalPerSession = typicalPerTurn * avgTurns;
  const worstPerSession = worstPerTurn * avgTurns;

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      model,
      price,
      caps: { prompt: PROMPT_CAP, response: RESPONSE_CAP },
      history: {
        transcripts: m.transcripts,
        avgTurnsPerSession: Number(avgTurns.toFixed(1)),
        avgPromptChars: Math.round(m.avgPromptChars),
        avgResponseChars: Math.round(m.avgResponseChars),
      },
      perTurn: { typical: typicalPerTurn, worst: worstPerTurn },
      perSession: { typical: typicalPerSession, worst: worstPerSession },
    }, null, 2)}\n`);
    return;
  }

  const usd = (x) => {
    if (x === 0) return '$0';
    if (x < 0.0001) return `$${x.toFixed(6)}`;
    if (x < 0.01) return `$${x.toFixed(5)}`;
    if (x < 1) return `$${x.toFixed(4)}`;
    return `$${x.toFixed(2)}`;
  };

  console.log('=== Ledger cost estimate ===');
  console.log(`model:  ${model}`);
  console.log(`price:  $${price.in}/M in, $${price.out}/M out  (${price.source})`);
  console.log(`caps:   ${PROMPT_CAP} chars in, ${RESPONSE_CAP} chars in`);
  console.log('');

  if (m.transcripts === 0) {
    console.log('No chat history found, so this uses generic assumptions.');
    console.log('Install, use Copilot for a while, then re-run for real numbers.');
    console.log('');
  } else {
    console.log(`measured from ${m.transcripts} transcripts:`);
    console.log(`  average session: ${avgTurns.toFixed(1)} turns`);
    console.log(`  average prompt:  ${Math.round(m.avgPromptChars)} chars`);
    console.log(`  average reply:   ${Math.round(m.avgResponseChars)} chars`);
    console.log('');
  }

  console.log('Two extra model calls per turn (extract + audit):');
  console.log(`  typical turn:  ${usd(typicalPerTurn)}`);
  console.log(`  worst case:    ${usd(worstPerTurn)}   (both inputs at the cap)`);
  console.log('');
  console.log(`Across an average session of ${avgTurns.toFixed(1)} turns:`);
  console.log(`  typical:       ${usd(typicalPerSession)}`);
  console.log(`  worst case:    ${usd(worstPerSession)}`);
  console.log('');
  console.log('For scale, a single Copilot turn on a frontier model typically');
  console.log('costs more than an entire session of ledger overhead.');
  console.log('');
  console.log('Override prices if your provider differs:');
  console.log('  LEDGER_PRICE_IN=0.07 LEDGER_PRICE_OUT=0.28');
}

main();
