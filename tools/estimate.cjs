#!/usr/bin/env node
'use strict';

/**
 * estimate — what will this cost me, according to MY history?
 *
 *   node tools/estimate.cjs              analyse history and project cost
 *   node tools/estimate.cjs --json       machine-readable
 *   node tools/estimate.cjs --history    just the clean-turn analysis
 *   node tools/estimate.cjs --otel       read VS Code's OTel file instead
 *
 * This is the ledger-history counterpart to tools/cost-report.cjs. That tool
 * projects from TRANSCRIPTS (prompt sizes, reply sizes, turns per session).
 * This one projects from the LEDGER (how many turns actually ended clean),
 * which is the input the on-clean review trigger depends on.
 *
 * The difference matters. cost-report.cjs assumed 85% of turns end clean,
 * because that is what the README said. The ledger says 48%. Same arithmetic,
 * different answer — and the ledger is the one that watched the turns happen.
 *
 * Exit codes:
 *   0  projection printed
 *   1  insufficient history to project (prints what it has)
 *   2  usage error
 */

const estimate = require('../core/estimate.cjs');
const otel = require('../core/otel.cjs');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

const usd = (x) => {
  if (!Number.isFinite(x) || x === 0) return '$0';
  if (x < 0.0001) return `$${x.toFixed(6)}`;
  if (x < 0.01) return `$${x.toFixed(5)}`;
  if (x < 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(2)}`;
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** Prices, matching tools/cost-report.cjs so the two agree. */
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
  return { in: 0.50, out: 1.50, source: 'unknown model, assumed mid-range' };
}

/**
 * Per-turn and per-review cost, using the same model as cost-report.cjs.
 *
 * Three calls per turn (extract + audit + summary), 512 output tokens each.
 * A review is one investigator run: ~35k in, ~2k out.
 */
function costs() {
  const model = process.env.LEDGER_MODEL || 'deepseek/deepseek-v4.1-flash';
  const price = priceFor(model);
  const reviewModel = process.env.LEDGER_REVIEW_MODEL || '';
  const reviewPrice = reviewModel ? priceFor(reviewModel) : price;

  const PROMPT_CAP = Number(process.env.LEDGER_MAX_PROMPT_CHARS) || 16000;
  const RESPONSE_CAP = Number(process.env.LEDGER_MAX_RESPONSE_CHARS) || 12000;
  const CHARS_PER_TOKEN = 4;
  const OUT_TOKENS = 512;
  const CALLS_PER_TURN = 3;

  // Typical, not worst case: the caps are ceilings, and a projection built on
  // every input hitting its ceiling is a scare number, not an estimate.
  const inTok = (PROMPT_CAP + RESPONSE_CAP * 2) / CHARS_PER_TOKEN / 2;
  const perTurn = ((inTok * price.in) + (OUT_TOKENS * CALLS_PER_TURN * price.out)) / 1e6;

  const REVIEW_IN_TOK = 35000;
  const REVIEW_OUT_TOK = 2000;
  const perReview = ((REVIEW_IN_TOK * reviewPrice.in) + (REVIEW_OUT_TOK * reviewPrice.out)) / 1e6;

  return { model, price, reviewModel, reviewPrice, perTurn, perReview };
}

function showHistory(history) {
  console.log(bold('═══ clean-turn history ═══'));
  console.log('');
  console.log(`  ledger dir:      ${dim(history.ledgerDir)}`);
  console.log(`  sessions:        ${history.sessions}`);
  console.log(`  turns recorded:  ${history.totalTurns}`);
  console.log(`  clean turns:     ${history.cleanTurns}  ${dim(`(${pct(history.cleanRatio)})`)}`);
  console.log('');

  if (!history.totalTurns) {
    console.log(`${yellow('!')} No turn records found.`);
    console.log('  The ledger writes one record per turn. Use the tool for a');
    console.log('  while, then re-run this.');
    return;
  }

  console.log('  ratio, three ways:');
  console.log(`    overall (all turns):     ${pct(history.cleanRatio)}`);
  console.log(`    mean per session:        ${pct(history.meanSessionRatio)}`);
  console.log(`    median per session:      ${pct(history.medianSessionRatio)}`);
  console.log('');
  console.log(dim('  These differ when session lengths differ. A 15-turn session'));
  console.log(dim('  should not be drowned out by forty 1-turn sessions, which is'));
  console.log(dim('  why the mean is reported alongside the overall figure.'));
  console.log('');

  console.log(`  session length:  mean ${history.meanTurnsPerSession.toFixed(1)}`
    + `  median ${history.medianTurnsPerSession}`);
  if (history.meanTurnsPerLongSession) {
    console.log(`  long sessions:   mean ${history.meanTurnsPerLongSession.toFixed(1)}`
      + `  median ${history.medianTurnsPerLongSession}`
      + `  ${dim(`(${history.sessionsWithEnoughTurns} session(s) with 3+ turns)`)}`);
    console.log('');
    console.log(dim('  Projections use the long-session figure. A ledger collects'));
    console.log(dim('  one-turn sessions — a question asked and answered, a test'));
    console.log(dim('  run — and projecting a 2-turn session cost is correct but'));
    console.log(dim('  useless.'));
  }
  console.log('');

  if (history.trend) {
    const t = history.trend;
    const dir = t.meanDelta > 0.05 ? green('improving')
      : t.meanDelta < -0.05 ? red('degrading')
        : dim('flat');
    console.log(`  trend (${t.sessions} session(s) with 4+ turns):`);
    console.log(`    first half clean:   ${pct(t.meanFirstHalf)}`);
    console.log(`    second half clean:  ${pct(t.meanSecondHalf)}`);
    console.log(`    delta:              ${t.meanDelta >= 0 ? '+' : ''}${pct(t.meanDelta)}  ${dir}`);
    console.log('');
    console.log(dim('  A session that starts messy and ends clean is improving.'));
    console.log(dim('  If it is degrading, the recent ratio is the one to project'));
    console.log(dim('  from — not the lifetime average.'));
    console.log('');
  } else {
    console.log(dim('  trend: not enough long sessions (need 4+ turns in one)'));
    console.log('');
  }

  if (!history.sufficient) {
    console.log(`${yellow('!')} ${history.gate}`);
    console.log('');
  }
}

function showProjection(history, cost) {
  const every = process.env.LEDGER_REVIEW_EVERY === undefined
    ? 10
    : Number(process.env.LEDGER_REVIEW_EVERY);
  const onClean = process.env.LEDGER_REVIEW_ON_CLEAN === '1';

  const cmp = estimate.compareTriggers({
    history,
    perTurnCost: cost.perTurn,
    perReviewCost: cost.perReview,
    every,
    turns: Math.max(1, Math.round(
      history.meanTurnsPerLongSession || history.meanTurnsPerSession || 1,
    )),
  });

  if (!cmp.off) {
    console.log(`${yellow('!')} Not enough history to project a session cost.`);
    console.log(`  ${history.gate}`);
    console.log('');
    console.log('  Run more sessions, then re-run. A projection from two data');
    console.log('  points is a guess with a dollar sign in front of it.');
    return 1;
  }

  const turns = cmp.off.turns;
  console.log(bold('═══ projected session cost ═══'));
  console.log('');
  console.log(`  session length:  ${turns} turns  ${dim('(mean of long sessions)')}`);
  console.log(`  clean ratio:     ${pct(cmp.off.cleanRatio)}  ${dim('(measured)')}`);
  console.log(`  review every:    ${every === 0 ? 'off' : `${every} turns`}`);
  console.log(`  per turn:        ${usd(cost.perTurn)}`);
  console.log(`  per review:      ${usd(cost.perReview)}`);
  console.log('');

  const row = (label, p) => {
    console.log(`  ${label}`);
    console.log(`    reviews:  ${p.reviews.total}`
      + `  ${dim(`(${p.reviews.scheduled} scheduled + ${p.reviews.final} final`
        + `${p.reviews.onClean ? ` + ${p.reviews.onClean} on-clean` : ''})`)}`);
    console.log(`    turns:    ${usd(p.cost.turns)}`);
    console.log(`    reviews:  ${usd(p.cost.reviews)}`);
    console.log(`    total:    ${bold(usd(p.cost.total))}`);
    console.log('');
  };

  row(`${cyan('LEDGER_REVIEW_ON_CLEAN=0')}  ${onClean ? dim('(not your current setting)') : green('(your current setting)')}`, cmp.off);
  row(`${cyan('LEDGER_REVIEW_ON_CLEAN=1')}  ${onClean ? green('(your current setting)') : dim('(not your current setting)')}`, cmp.on);

  if (cmp.multiplier) {
    console.log(`  Turning on the on-clean trigger multiplies review cost by `
      + `${bold(`${cmp.multiplier.toFixed(2)}x`)}.`);
    console.log('');
  }

  console.log(dim(`  basis: ${cmp.off.basis}`));
  console.log(dim('  Prices are defaults. Override with LEDGER_PRICE_IN / LEDGER_PRICE_OUT.'));
  return 0;
}

async function showOtel() {
  const status = otel.status();
  console.log(bold('═══ VS Code OpenTelemetry ═══'));
  console.log('');
  console.log(`  outfile:   ${dim(status.outfile)}`);
  console.log(`  exists:    ${status.exists ? green('yes') : red('no')}`);
  if (status.exists) console.log(`  size:      ${status.sizeHuman}`);
  console.log('');

  if (!status.exists) {
    console.log('  VS Code is not writing OTel output. To enable it:');
    console.log('');
    console.log('    "github.copilot.chat.otel.enabled": true,');
    console.log('    "github.copilot.chat.otel.exporterType": "file",');
    console.log('    "github.copilot.chat.otel.outfile": "/tmp/copilot-otel.jsonl"');
    console.log('');
    console.log('  Then start a NEW chat session — settings are read at start.');
    return 2;
  }

  // Bounded scan. The file is append-only and never rotated by VS Code, so on
  // a real machine it reaches gigabytes. Reading all of it to answer "is this
  // working" would take minutes; the first N lines answer it in a second.
  const SCAN = Number(process.env.LEDGER_OTEL_SCAN_LINES) || 20000;
  const spans = await otel.toolSpans({ limit: 100000, maxLines: SCAN });
  const usage = await otel.tokenUsage({ limit: 100000, maxLines: SCAN });

  console.log(`  scanned:   ${SCAN.toLocaleString()} lines`);
  console.log(`  tool spans: ${spans.length}`);
  if (spans.length) {
    const byName = {};
    for (const t of spans) byName[t.tool] = (byName[t.tool] || 0) + 1;
    const top = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('');
    for (const [name, n] of top) console.log(`    ${String(n).padStart(6)}  ${name}`);
  }

  console.log('');
  console.log(`  chat spans: ${usage.spans}`);
  if (usage.withUsage) {
    console.log(`    with token usage: ${usage.withUsage}`);
    console.log(`    input tokens:     ${usage.inputTokens.toLocaleString()}`);
    console.log(`    output tokens:    ${usage.outputTokens.toLocaleString()}`);
  }

  console.log('');
  console.log(dim('  This is VS Code\'s own telemetry, written to its own file.'));
  console.log(dim('  taskguard\'s journal is a separate file — the ledger derives'));
  console.log(dim('  its tool timeline from the transcript, not from OTel, so it'));
  console.log(dim('  works whether or not OTel is enabled.'));
  console.log('');
  console.log(dim('  With captureContent: true this file holds full prompts,'));
  console.log(dim('  responses, and tool arguments. VS Code does not rotate it.'));
  return 0;
}

async function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`estimate — project cost from your ledger history.

  node tools/estimate.cjs              analyse history and project cost
  node tools/estimate.cjs --history    just the clean-turn analysis
  node tools/estimate.cjs --otel       inspect VS Code's OTel output
  node tools/estimate.cjs --json       machine-readable

The clean-turn ratio is measured from <LEDGER_DIR>/*.progress.jsonl, one
record per turn. It is the input the on-clean review trigger depends on,
so it is the number that decides what that trigger actually costs.`);
    return 0;
  }

  if (args.includes('--otel')) return showOtel();

  const history = estimate.analyseHistory();
  const cost = costs();

  if (args.includes('--json')) {
    const every = process.env.LEDGER_REVIEW_EVERY === undefined
      ? 10
      : Number(process.env.LEDGER_REVIEW_EVERY);
    const cmp = estimate.compareTriggers({
      history,
      perTurnCost: cost.perTurn,
      perReviewCost: cost.perReview,
      every,
      turns: Math.max(1, Math.round(
        history.meanTurnsPerLongSession || history.meanTurnsPerSession || 1,
      )),
    });
    process.stdout.write(`${JSON.stringify({
      history: {
        ledgerDir: history.ledgerDir,
        sessions: history.sessions,
        sessionsWithEnoughTurns: history.sessionsWithEnoughTurns,
        totalTurns: history.totalTurns,
        cleanTurns: history.cleanTurns,
        cleanRatio: history.cleanRatio,
        meanSessionRatio: history.meanSessionRatio,
        medianSessionRatio: history.medianSessionRatio,
        meanTurnsPerSession: history.meanTurnsPerSession,
        meanTurnsPerLongSession: history.meanTurnsPerLongSession,
        trend: history.trend,
        sufficient: history.sufficient,
        gate: history.gate,
      },
      prices: { model: cost.model, ...cost.price, reviewModel: cost.reviewModel },
      perTurnCost: cost.perTurn,
      perReviewCost: cost.perReview,
      projection: { off: cmp.off, on: cmp.on, multiplier: cmp.multiplier },
    }, null, 2)}\n`);
    return cmp.off ? 0 : 1;
  }

  if (args.includes('--history')) {
    showHistory(history);
    return history.sufficient ? 0 : 1;
  }

  showHistory(history);
  return showProjection(history, cost);
}

if (require.main === module) {
  Promise.resolve(main(process.argv))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`estimate: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { main, costs, showHistory, showProjection, showOtel };
