#!/usr/bin/env node
'use strict';

/**
 * review — run an adversarial review of a session, on demand.
 *
 *   node tools/review.cjs <sessionId>          review the whole session
 *   node tools/review.cjs <sessionId> --last 3 review only the newest 3 turns
 *   node tools/review.cjs --latest             review the newest session
 *   node tools/review.cjs --status             show reviewer configuration
 *   node tools/review.cjs <sessionId> --json   machine-readable findings
 *
 * The Stop hook runs reviews on a schedule (every N turns, plus the final
 * turn). This tool is for the case the schedule cannot cover: you want a
 * verdict right now.
 *
 * Exit codes:
 *   0  review ran, no high-severity gaps
 *   1  review ran, high-severity gaps found
 *   2  usage error, or the reviewer is not configured
 */

const journal = require('../core/journal.cjs');
const review = require('../core/review.cjs');
const llm = require('../core/llm.cjs');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

const VERDICT_COLOR = {
  confirmed: green,
  partial: yellow,
  unverified: dim,
  false: red,
};

function latestSession() {
  const fs = require('node:fs');
  const path = require('node:path');
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

function showStatus() {
  const status = llm.reviewerStatus();
  const mainModel = llm.getModel();
  const mainFamily = llm.familyOf(mainModel);

  console.log(bold('═══ reviewer configuration ═══'));
  console.log('');
  console.log(`  main model:     ${mainModel}  ${dim(`(${mainFamily})`)}`);
  console.log(`  reviewer model: ${status.model || dim('(not set)')}`
    + `${status.model ? `  ${dim(`(${llm.familyOf(status.model)})`)}` : ''}`);
  console.log(`  reviewer provider: ${status.provider}`);
  console.log(`  reasoning effort:  ${JSON.stringify(llm.reviewerReasoning())}`);
  console.log('');

  if (status.ok) {
    console.log(`${green('✔')} reviewer is configured and independent`);
    return 0;
  }

  console.log(`${red('✖')} reviewer is NOT usable: ${status.reason}`);
  console.log('');
  console.log('Set these in ~/.copilot/hooks/ledger/.env:');
  console.log('  LEDGER_REVIEW_MODEL=qwen/qwen3.8-flash     # a DIFFERENT family');
  console.log('  LEDGER_REVIEW_PROVIDER=openrouter');
  console.log('  LEDGER_REVIEW_EFFORT=medium                # default');
  console.log('  LEDGER_REVIEW_API_KEY=...                  # optional');
  return 2;
}

async function runReview(sessionId, opts) {
  const status = llm.reviewerStatus();
  if (!status.ok) {
    console.error(`${red('✖')} ${status.reason}`);
    console.error(dim('  Run with --status for the full configuration.'));
    return 2;
  }

  let turns = journal.readProgress(sessionId).filter((t) => t.kind !== 'review');
  if (!turns.length) {
    console.error(`No journal records for session "${sessionId}".`);
    return 2;
  }
  if (Number.isFinite(opts.last)) turns = turns.slice(-opts.last);

  // Reconstruct the evidence the reviewer needs: the prose and the tool calls.
  const tools = journal.readTelemetry(sessionId);
  const assistantText = turns.map((t) => t.summary || '').filter(Boolean).join('\n\n');

  const prior = require('../core/changelog.cjs').readIndex(Infinity)
    .filter((r) => r.sessionId === sessionId).pop();
  const workspace = prior?.workspace || process.cwd();

  console.log(bold(`═══ adversarial review ═══`));
  console.log(dim(`  session ${sessionId.slice(0, 8)} · ${turns.length} turn(s) · `
    + `${tools.length} tool call(s)`));
  console.log(dim(`  reviewer: ${status.model} (${llm.familyOf(status.model)})`));
  console.log('');

  console.log(dim('  extracting claims...'));
  const claims = await review.extractClaims({ assistantText, tools });
  if (!claims.length) {
    console.log(`${green('✔')} no checkable claims in this session — nothing to review`);
    return 0;
  }
  console.log(`  ${claims.length} claim(s):`);
  for (const cl of claims) console.log(`    ${dim(`[${cl.id}]`)} ${cl.text}`);

  console.log('');
  console.log(dim('  planning checks...'));
  const checks = await review.planChecks(claims);
  console.log(`  ${checks.length} check(s) planned`);

  console.log('');
  console.log(dim('  investigating (this is the slow part)...'));
  const result = await review.investigate({ claims, checks, workspace });

  if (!result.ok) {
    console.error(`${red('✖')} review failed: ${result.reason}`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ claims, checks, findings: result.findings }, null, 2)}\n`);
    return review.blockingFindings(result.findings).length ? 1 : 0;
  }

  console.log('');
  console.log(bold('═══ findings ═══'));
  console.log('');

  for (const f of result.findings) {
    const color = VERDICT_COLOR[f.verdict] || dim;
    const sev = f.severity === 'high' ? red('HIGH') : f.severity === 'medium' ? yellow('MED') : dim('LOW');
    console.log(`  ${color(f.verdict.toUpperCase().padEnd(10))} ${sev.padEnd(14)} ${dim(`[${f.claim}]`)}`);
    if (f.evidence) console.log(`      ${f.evidence}`);
    if (f.fix) console.log(`      ${cyan('fix:')} ${f.fix}`);
    console.log('');
  }

  const blocking = review.blockingFindings(result.findings);
  const confirmed = result.findings.filter((f) => f.verdict === 'confirmed').length;

  if (blocking.length) {
    console.log(`${red('✖')} ${blocking.length} high-severity gap(s) — the agent would be nudged`);
    return 1;
  }

  console.log(`${green('✔')} ${confirmed}/${result.findings.length} claim(s) confirmed, no blocking gaps`);
  return 0;
}

function usage() {
  console.log(`review — adversarial review of a session.

  node tools/review.cjs --status             show reviewer configuration
  node tools/review.cjs <sessionId>          review the whole session
  node tools/review.cjs <sessionId> --last 3 review only the newest 3 turns
  node tools/review.cjs --latest             review the newest session
  node tools/review.cjs <sessionId> --json   machine-readable findings

The reviewer must be a DIFFERENT MODEL FAMILY from the agent, or it shares the
same blind spots. Configure it in ~/.copilot/hooks/ledger/.env:

  LEDGER_REVIEW_MODEL=qwen/qwen3.8-flash
  LEDGER_REVIEW_PROVIDER=openrouter
  LEDGER_REVIEW_EFFORT=medium

The Stop hook also runs reviews automatically: every LEDGER_REVIEW_EVERY turns
(default 5) and always on the final turn.`);
}

async function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return 0;
  }
  if (args.includes('--status')) return showStatus();

  const lastIdx = args.indexOf('--last');
  const last = lastIdx !== -1 ? Number(args[lastIdx + 1]) : null;
  if (lastIdx !== -1 && (!Number.isFinite(last) || last <= 0)) {
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

  return runReview(sessionId, { last, json: args.includes('--json') });
}

if (require.main === module) {
  Promise.resolve(main(process.argv))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { showStatus, runReview, latestSession };
