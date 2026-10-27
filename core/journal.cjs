'use strict';

/**
 * Progress journal — the durable, per-turn record of what the agent did.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ledger answers "what is still open?". It does not answer "what happened
 * in the last 30 minutes?". For long-horizon runs the second question is the
 * one a human needs, and chat is the wrong medium for it: reconstructing a
 * narrative from 10,000 lines of tool output is exactly the work we are trying
 * to avoid.
 *
 * WHERE THE DATA COMES FROM
 * -------------------------
 * The VS Code transcript, not our own instrumentation. Verified 2026-10-27,
 * the transcript already contains everything needed:
 *
 *   session.start            once
 *   user.message             one per user turn
 *   assistant.turn_start     one per agent turn (many per user turn)
 *   assistant.message        the agent's prose
 *   tool.execution_start     { toolName, arguments }  <- the telemetry
 *   tool.execution_complete  { toolCallId, success }
 *
 * So there is no need for a PreToolUse hook to record tool calls: the harness
 * already did it, with real timestamps and structured arguments. Deriving from
 * the transcript also means the timeline is complete even for turns where our
 * hooks did not run.
 *
 * WHAT WE DO NOT HAVE
 * -------------------
 * VS Code DOES emit OpenTelemetry for Copilot agent activity — traces, metrics,
 * and events, with invoke_agent / chat / execute_tool / execute_hook spans
 * following the GenAI semantic conventions. See:
 *   https://code.visualstudio.com/docs/agents/guides/monitoring-agents
 *
 * It is off by default, and it answers a different question. OTel gives you
 * spans, durations, and token counts. It does not tell you what a turn
 * ACHIEVED. That is the gap this journal fills: the narrative layer.
 *
 * The two are complementary. If you have an OTel collector running, point
 * VS Code at it for the span-level view, and use this journal for the
 * "what did it actually accomplish" view. toOtlpSpan() below emits in the same
 * shape so both can land in one backend.
 *
 * STORAGE
 * -------
 *   <ledgerDir>/<sessionId>.progress.jsonl   one record per user turn
 *   <ledgerDir>/<sessionId>.telemetry.jsonl  one record per tool call
 *
 * Append-only JSONL: a crash mid-write loses at most one line, and history is
 * never rewritten, so a replay is faithful.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const parsers = require('./parsers.cjs');

const LEDGER_DIR = process.env.LEDGER_DIR
  || path.join(os.homedir(), '.copilot', 'hooks', 'ledger', '.ledger');

const MAX_RECORDS = Number(process.env.LEDGER_MAX_JOURNAL_RECORDS) || 2000;

function safeId(sessionId) {
  return String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

const progressPath = (s) => path.join(LEDGER_DIR, `${safeId(s)}.progress.jsonl`);
const telemetryPath = (s) => path.join(LEDGER_DIR, `${safeId(s)}.telemetry.jsonl`);

function appendLine(file, record) {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false; // A journal failure must never break a hook.
  }
}

function readLines(file, limit = MAX_RECORDS) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Truncated final line from a crash; skip it rather than losing the file.
    }
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Read a transcript into normalised turns.
 *
 * The actual parsing lives in core/parsers.cjs, one parser per harness. This
 * function is the seam: it resolves the right parser (explicitly, or by
 * sniffing the file) and returns the normalised shape. Nothing here knows what
 * VS Code is.
 *
 * @param {string} transcriptPath
 * @param {string} [parserName]  Force a parser; omit to auto-detect.
 * @returns {Array<object>} normalised turns
 */
function parseTurns(transcriptPath, parserName) {
  if (!transcriptPath) return [];
  // Explicit argument wins, then the env override, then auto-detection.
  const name = parserName || process.env.LEDGER_TRANSCRIPT_PARSER || undefined;
  const parser = parsers.resolve(name, transcriptPath);
  try {
    return parser.parse(transcriptPath) || [];
  } catch {
    // A parser failure must not break the hook.
    return [];
  }
}

/** Back-compat alias: older callers used readTranscript + parseTurns. */
function readTranscript(transcriptPath) {
  return parsers.readJsonl(transcriptPath);
}

/** Derive a short intent string from a tool call's arguments. */
const intentFrom = parsers.intentFrom;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** One record per tool call. */
function recordTool(sessionId, info = {}) {
  const record = {
    // `at` is when the tool ran, which for transcript-derived records is the
    // transcript timestamp, not the moment we wrote the line. Using "now"
    // would collapse a whole turn onto one clock time and destroy the
    // timeline the replay depends on.
    at: info.at || new Date().toISOString(),
    kind: 'tool',
    tool: String(info.tool || 'unknown').slice(0, 80),
    intent: String(info.intent || '').slice(0, 200),
    turn: Number.isFinite(info.turn) ? info.turn : null,
    ok: info.ok !== false,
  };
  appendLine(telemetryPath(sessionId), record);
  return record;
}

/** One record per user turn. */
function recordTurn(sessionId, entry = {}) {
  const record = {
    at: entry.at || entry.startedAt || new Date().toISOString(),
    kind: 'turn',
    turn: Number.isFinite(entry.turn) ? entry.turn : null,
    startedAt: entry.startedAt || null,
    endedAt: entry.endedAt || null,
    // The headline is the one-line material effect shown in the replay
    // timeline. It is what makes a 40-turn session scannable.
    headline: String(entry.headline || '').slice(0, 160),
    summary: String(entry.summary || '').slice(0, 2000),
    completed: asStringArray(entry.completed),
    blockers: asStringArray(entry.blockers),
    next: asStringArray(entry.next),
    files: asStringArray(entry.files).slice(0, 40),
    toolCount: Number.isFinite(entry.toolCount) ? entry.toolCount : null,
    openCount: Number.isFinite(entry.openCount) ? entry.openCount : null,
    resolved: Number.isFinite(entry.resolved) ? entry.resolved : null,
    blocked: entry.blocked === true,
    source: entry.source || 'transcript',
  };
  appendLine(progressPath(sessionId), record);
  return record;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().slice(0, 300))
    .slice(0, 30);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const readProgress = (s, limit) => readLines(progressPath(s), limit);
const readTelemetry = (s, limit) => readLines(telemetryPath(s), limit);

/** Merge both streams chronologically — what the replay tool renders. */
function timeline(sessionId, limit) {
  const events = [
    ...readProgress(sessionId, limit),
    ...readTelemetry(sessionId, limit),
  ];
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return events;
}

const turnCount = (s) => readProgress(s).length;

function clear(sessionId) {
  for (const file of [progressPath(sessionId), telemetryPath(sessionId)]) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// OTLP export
// ---------------------------------------------------------------------------

/**
 * Convert a journal record to an OTLP span.
 *
 * VS Code emits its own OTel spans (invoke_agent, chat, execute_tool,
 * execute_hook). This emits the journal's narrative records in the same shape
 * and under the same GenAI semantic conventions, so a collector can hold both:
 * the spans tell you what ran and how long it took, these tell you what it
 * achieved.
 *
 * Attributes follow the OpenTelemetry GenAI conventions where they apply:
 *   gen_ai.operation.name, gen_ai.tool.name, gen_ai.agent.name
 *
 * @param {object} record  A journal record.
 * @param {string} sessionId
 * @returns {object} An OTLP/JSON span.
 */
function toOtlpSpan(record, sessionId) {
  const isTool = record.kind === 'tool';
  const startNs = String(Date.parse(record.at || Date.now()) * 1e6);

  const attributes = [
    { key: 'gen_ai.operation.name', value: { stringValue: isTool ? 'execute_tool' : 'invoke_agent' } },
    { key: 'gen_ai.agent.name', value: { stringValue: 'taskguard' } },
    { key: 'session.id', value: { stringValue: String(sessionId) } },
  ];

  if (isTool) {
    attributes.push({ key: 'gen_ai.tool.name', value: { stringValue: record.tool || 'unknown' } });
    if (record.intent) {
      attributes.push({ key: 'gen_ai.tool.call.intent', value: { stringValue: record.intent } });
    }
    attributes.push({ key: 'tool.success', value: { boolValue: record.ok !== false } });
  } else {
    if (record.summary) {
      attributes.push({ key: 'taskguard.turn.summary', value: { stringValue: record.summary } });
    }
    if (Number.isFinite(record.openCount)) {
      attributes.push({ key: 'taskguard.items.open', value: { intValue: String(record.openCount) } });
    }
    if (Number.isFinite(record.resolved)) {
      attributes.push({ key: 'taskguard.items.resolved', value: { intValue: String(record.resolved) } });
    }
    attributes.push({ key: 'taskguard.turn.blocked', value: { boolValue: record.blocked === true } });
  }

  return {
    traceId: String(sessionId).replace(/[^a-f0-9]/gi, '').padEnd(32, '0').slice(0, 32),
    spanId: String(record.at || '').replace(/[^a-f0-9]/gi, '').padEnd(16, '0').slice(0, 16),
    name: isTool ? `tool.${record.tool || 'unknown'}` : `turn.${record.turn ?? '?'}`,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: startNs,
    endTimeUnixNano: startNs,
    attributes,
    status: { code: record.ok === false ? 2 : 1 },
  };
}

/** Export a session's journal as an OTLP/JSON resourceSpans document. */
function toOtlp(sessionId) {
  const spans = timeline(sessionId).map((r) => toOtlpSpan(r, sessionId));
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'taskguard' } },
          { key: 'session.id', value: { stringValue: String(sessionId) } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'taskguard.journal', version: '1.0.0' },
        spans,
      }],
    }],
  };
}

module.exports = {
  LEDGER_DIR,
  progressPath,
  telemetryPath,
  readTranscript,
  parseTurns,
  intentFrom,
  recordTool,
  recordTurn,
  readProgress,
  readTelemetry,
  timeline,
  turnCount,
  clear,
  toOtlpSpan,
  toOtlp,
};
