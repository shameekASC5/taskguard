'use strict';

/**
 * VS Code OpenTelemetry reader — the answer to "why is OTel not in my files?"
 *
 * THE SHORT ANSWER
 * ----------------
 * Because nothing ever read it. VS Code writes OTel to its OWN file
 * (`github.copilot.chat.otel.outfile`, default `/tmp/copilot-otel.jsonl`).
 * taskguard writes its journal to `<LEDGER_DIR>/*.progress.jsonl`. Those are two
 * different files written by two different processes, and no code in taskguard
 * has ever opened the OTel one.
 *
 * So "OTel is not in those files" is correct and expected. It is not a bug in
 * the OTel setup — it is a missing reader. This module is that reader.
 *
 * WHY THE LEDGER DOES NOT DEPEND ON IT
 * ------------------------------------
 * The journal derives its tool timeline from the VS Code TRANSCRIPT, not from
 * OTel. That was a deliberate choice (see core/journal.cjs): the transcript is
 * always present, needs no configuration, and is complete even for turns where
 * our hooks did not fire. OTel is off by default and requires four settings.
 *
 * Depending on OTel would mean the journal silently stops working for anyone
 * who has not enabled it. So OTel is treated as an OPTIONAL enrichment: if the
 * file is there, we can read it; if not, nothing breaks.
 *
 * WHAT OTel HAS THAT THE TRANSCRIPT DOES NOT
 * ------------------------------------------
 * Token counts and durations. The transcript records that a tool ran; OTel
 * records how long it took and, for chat spans, how many tokens it cost. That
 * is the missing input for a cost estimate that is measured rather than
 * modelled — which is exactly what tools/estimate.cjs wants.
 *
 * THE FILE IS BIG
 * ---------------
 * Measured on a real machine: 2.7 GB, 26,450 spans. It is append-only and
 * never rotated by VS Code. So this module NEVER reads the whole file into
 * memory — it streams line by line and stops when it has what it needs.
 *
 * PRIVACY
 * -------
 * With `captureContent: true`, OTel spans contain full prompts, responses, and
 * tool arguments. That is a second copy of the same sensitive data the ledger
 * already holds, in a file VS Code does not clean up. The README says so. This
 * module reads only span NAMES and numeric attributes — never content.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

/** Where VS Code writes OTel when exporterType is "file". */
const DEFAULT_OUTFILE = '/tmp/copilot-otel.jsonl';

function outfile() {
  return process.env.LEDGER_OTEL_FILE || DEFAULT_OUTFILE;
}

/** Human-readable byte size. */
function human(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Is VS Code writing OTel, and how much?
 *
 * Cheap: one stat call. Does not open the file.
 *
 * @returns {{exists:boolean, outfile:string, size:number, sizeHuman:string, spans:number|null}}
 */
function status() {
  const file = outfile();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { exists: false, outfile: file, size: 0, sizeHuman: '0 B', spans: null };
  }
  return {
    exists: true,
    outfile: file,
    size: stat.size,
    sizeHuman: human(stat.size),
    // Counting spans means reading the file, which is expensive on a 2.7 GB
    // log. Left null here; callers that want it call countSpans().
    spans: null,
  };
}

/**
 * Stream spans, calling `visit` for each, until `visit` returns false.
 *
 * Never loads the file into memory. A 2.7 GB log is read one line at a time.
 *
 * @param {Function} visit  (span) => boolean|void  — return false to stop.
 * @param {object} [opts]
 * @param {number} [opts.maxLines]  Hard stop, so a runaway file cannot hang.
 * @returns {Promise<number>} lines read
 */
async function streamSpans(visit, opts = {}) {
  const file = outfile();
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : Infinity;

  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return 0;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  let stopped = false;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      n += 1;
      if (n > maxLines) break;

      let span;
      try {
        span = JSON.parse(line);
      } catch {
        continue; // Truncated final line from a crash.
      }

      if (visit(span) === false) {
        stopped = true;
        break;
      }
    }
  } catch {
    // A read error mid-stream still returns what we got.
  } finally {
    rl.close();
    stream.destroy();
  }

  return stopped ? n : n;
}

/** Count spans without keeping them. */
async function countSpans(opts = {}) {
  let n = 0;
  await streamSpans(() => { n += 1; }, opts);
  return n;
}

/**
 * Pull the attribute map off a span.
 *
 * OTel/JSON allows attributes as either an array of {key, value} or a plain
 * object, and VS Code has emitted both shapes. Normalise to a flat object of
 * primitives so callers do not have to care.
 *
 * @param {object} span
 * @returns {object}
 */
function attributesOf(span) {
  const raw = span?.attributes;
  const out = {};
  if (!raw) return out;

  const put = (key, value) => {
    if (typeof value === 'object' && value !== null) {
      // {stringValue: "x"} | {intValue: "3"} | {boolValue: true}
      const inner = Object.values(value)[0];
      out[key] = inner;
    } else {
      out[key] = value;
    }
  };

  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && typeof a.key === 'string') put(a.key, a.value);
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) put(k, v);
  }
  return out;
}

/**
 * Collect tool-execution spans.
 *
 * VS Code emits `execute_tool <name>` spans with GenAI semantic conventions:
 *   gen_ai.tool.name, gen_ai.tool.call.arguments, gen_ai.tool.call.result
 *
 * We keep the name, duration, and session id — never the arguments or result,
 * which contain file contents and command output.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]     Max spans to return.
 * @param {number} [opts.maxLines]  Max lines to scan.
 * @returns {Promise<Array<{tool:string, durationMs:number|null, sessionId:string|null}>>}
 */
async function toolSpans(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 5000;
  const out = [];

  await streamSpans((span) => {
    const name = String(span?.name || '');
    if (!name.startsWith('execute_tool')) return true;

    const attrs = attributesOf(span);
    out.push({
      tool: attrs['gen_ai.tool.name'] || name.replace(/^execute_tool\s*/, '') || 'unknown',
      durationMs: Number.isFinite(span?.duration) ? span.duration / 1e6 : null,
      sessionId: attrs['gen_ai.conversation.id'] || attrs['copilot_chat.session_id'] || null,
    });

    return out.length < limit;
  }, opts);

  return out;
}

/**
 * Collect chat spans, which carry token usage.
 *
 * This is the input a measured cost estimate needs. VS Code emits
 * `chat <model>` spans; token counts live in gen_ai.usage.* attributes when
 * the provider reports them.
 *
 * @param {object} [opts]
 * @returns {Promise<Array<{model:string, inputTokens:number|null, outputTokens:number|null}>>}
 */
async function chatSpans(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 5000;
  const out = [];

  await streamSpans((span) => {
    const name = String(span?.name || '');
    if (!name.startsWith('chat')) return true;

    const attrs = attributesOf(span);
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    out.push({
      model: attrs['gen_ai.request.model']
        || attrs['gen_ai.response.model']
        || name.replace(/^chat\s*/, '')
        || 'unknown',
      inputTokens: num(attrs['gen_ai.usage.input_tokens']),
      outputTokens: num(attrs['gen_ai.usage.output_tokens']),
    });

    return out.length < limit;
  }, opts);

  return out;
}

/**
 * Aggregate token usage across chat spans.
 *
 * @returns {Promise<{spans:number, inputTokens:number, outputTokens:number, withUsage:number}>}
 */
async function tokenUsage(opts = {}) {
  const spans = await chatSpans(opts);
  let inputTokens = 0;
  let outputTokens = 0;
  let withUsage = 0;

  for (const s of spans) {
    if (s.inputTokens === null && s.outputTokens === null) continue;
    withUsage += 1;
    inputTokens += s.inputTokens || 0;
    outputTokens += s.outputTokens || 0;
  }

  return { spans: spans.length, inputTokens, outputTokens, withUsage };
}

module.exports = {
  DEFAULT_OUTFILE,
  outfile,
  human,
  status,
  streamSpans,
  countSpans,
  attributesOf,
  toolSpans,
  chatSpans,
  tokenUsage,
};
