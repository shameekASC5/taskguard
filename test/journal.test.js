'use strict';

/**
 * Tests for core/journal.cjs and tools/replay.cjs.
 *
 * The journal is derived from the VS Code transcript, so most of these tests
 * build a synthetic transcript in the real format and assert on what we
 * extract from it. The format was verified against a live transcript on
 * 2026-10-27; if VS Code changes it, these tests are where it should break.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let journal;
let replay;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-journal-'));
  process.env.LEDGER_DIR = tmpDir;
  // Re-require so LEDGER_DIR is picked up.
  jest.resetModules();
  journal = require('../core/journal.cjs');
  replay = require('../tools/replay.cjs');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LEDGER_DIR;
});

/** Build a transcript line in the real VS Code shape. */
function line(type, data, timestamp) {
  return JSON.stringify({ type, data, id: 'x', timestamp });
}

function writeTranscript(entries) {
  const p = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(p, entries.join('\n'));
  return p;
}

describe('journal — transcript parsing', () => {
  test('splits into user turns at user.message', () => {
    const p = writeTranscript([
      line('session.start', {}, '2026-10-27T10:00:00.000Z'),
      line('user.message', { content: 'first ask' }, '2026-10-27T10:00:01.000Z'),
      line('assistant.message', { content: 'working' }, '2026-10-27T10:00:02.000Z'),
      line('user.message', { content: 'second ask' }, '2026-10-27T10:01:00.000Z'),
      line('assistant.message', { content: 'done' }, '2026-10-27T10:01:01.000Z'),
    ]);

    const turns = journal.parseTurns(journal.readTranscript(p));
    expect(turns).toHaveLength(2);
    expect(turns[0].userText).toBe('first ask');
    expect(turns[0].assistantText).toBe('working');
    expect(turns[1].userText).toBe('second ask');
  });

  test('collects tool calls with name and derived intent', () => {
    const p = writeTranscript([
      line('user.message', { content: 'go' }, '2026-10-27T10:00:00.000Z'),
      line('tool.execution_start', {
        toolCallId: 'c1',
        toolName: 'run_in_terminal',
        arguments: { command: 'npm test' },
      }, '2026-10-27T10:00:01.000Z'),
      line('tool.execution_complete', { toolCallId: 'c1', success: true }, '2026-10-27T10:00:02.000Z'),
    ]);

    const [turn] = journal.parseTurns(journal.readTranscript(p));
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0].tool).toBe('run_in_terminal');
    expect(turn.tools[0].intent).toBe('npm test');
    expect(turn.tools[0].ok).toBe(true);
  });

  test('marks a failed tool call', () => {
    const p = writeTranscript([
      line('user.message', { content: 'go' }, '2026-10-27T10:00:00.000Z'),
      line('tool.execution_start', {
        toolCallId: 'c1', toolName: 'run_in_terminal', arguments: { command: 'false' },
      }, '2026-10-27T10:00:01.000Z'),
      line('tool.execution_complete', { toolCallId: 'c1', success: false }, '2026-10-27T10:00:02.000Z'),
    ]);

    const [turn] = journal.parseTurns(journal.readTranscript(p));
    expect(turn.tools[0].ok).toBe(false);
  });

  test('tolerates malformed lines', () => {
    const p = writeTranscript([
      line('user.message', { content: 'go' }, '2026-10-27T10:00:00.000Z'),
      '{not json',
      line('assistant.message', { content: 'ok' }, '2026-10-27T10:00:01.000Z'),
    ]);

    const turns = journal.parseTurns(journal.readTranscript(p));
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantText).toBe('ok');
  });

  test('returns empty for a missing transcript', () => {
    expect(journal.readTranscript('/nonexistent/x.jsonl')).toEqual([]);
  });
});

describe('journal — intent derivation', () => {
  test('picks the informative field per tool', () => {
    expect(journal.intentFrom('run_in_terminal', { command: 'npm test' })).toBe('npm test');
    expect(journal.intentFrom('read_file', { filePath: '/a/b.js' })).toBe('/a/b.js');
    expect(journal.intentFrom('grep_search', { query: 'foo' })).toBe('foo');
    expect(journal.intentFrom('fetch_webpage', { urls: ['https://x.dev'] })).toBe('https://x.dev');
  });

  test('collapses whitespace so a multi-line command stays one line', () => {
    expect(journal.intentFrom('run_in_terminal', { command: 'a\n\n  b\tc' })).toBe('a b c');
  });

  test('falls back to the first string field for unknown tools', () => {
    expect(journal.intentFrom('some_new_tool', { whatever: 'hello' })).toBe('hello');
  });

  test('returns empty for missing arguments', () => {
    expect(journal.intentFrom('run_in_terminal', null)).toBe('');
    expect(journal.intentFrom('run_in_terminal', {})).toBe('');
  });
});

describe('journal — records', () => {
  test('recordTurn preserves the transcript timestamp, not now()', () => {
    // Regression: using new Date() collapsed a whole turn onto one clock time
    // and destroyed the replay timeline.
    const at = '2026-10-27T09:15:00.000Z';
    const rec = journal.recordTurn('s1', { turn: 1, at, summary: 'x' });
    expect(rec.at).toBe(at);
  });

  test('recordTool preserves the transcript timestamp', () => {
    const at = '2026-10-27T09:15:01.000Z';
    const rec = journal.recordTool('s1', { at, tool: 'read_file', intent: 'a.js' });
    expect(rec.at).toBe(at);
  });

  test('round-trips through the file', () => {
    journal.recordTurn('s1', { turn: 1, summary: 'did a thing', openCount: 3, resolved: 1 });
    const back = journal.readProgress('s1');
    expect(back).toHaveLength(1);
    expect(back[0].summary).toBe('did a thing');
    expect(back[0].openCount).toBe(3);
  });

  test('skips a truncated final line', () => {
    journal.recordTurn('s1', { turn: 1, summary: 'ok' });
    fs.appendFileSync(journal.progressPath('s1'), '{"kind":"turn","summ');
    const back = journal.readProgress('s1');
    expect(back).toHaveLength(1);
    expect(back[0].summary).toBe('ok');
  });

  test('timeline merges both streams in time order', () => {
    journal.recordTurn('s1', { turn: 1, at: '2026-10-27T10:00:00.000Z', summary: 'a' });
    journal.recordTool('s1', { at: '2026-10-27T10:00:05.000Z', tool: 'read_file' });
    journal.recordTurn('s1', { turn: 2, at: '2026-10-27T10:00:10.000Z', summary: 'b' });

    const tl = journal.timeline('s1');
    expect(tl.map((e) => e.kind)).toEqual(['turn', 'tool', 'turn']);
  });

  test('sanitises the session id in the filename', () => {
    journal.recordTurn('../../evil', { turn: 1, summary: 'x' });
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.includes('..'))).toBe(false);
  });

  test('clear removes both files', () => {
    journal.recordTurn('s1', { turn: 1, summary: 'x' });
    journal.recordTool('s1', { tool: 'read_file' });
    journal.clear('s1');
    expect(journal.readProgress('s1')).toEqual([]);
    expect(journal.readTelemetry('s1')).toEqual([]);
  });
});

describe('journal — OTLP export', () => {
  test('emits a span with GenAI semantic-convention attributes', () => {
    const span = journal.toOtlpSpan(
      { kind: 'tool', at: '2026-10-27T10:00:00.000Z', tool: 'read_file', intent: 'a.js', ok: true },
      's1'
    );
    const keys = span.attributes.map((a) => a.key);
    expect(keys).toContain('gen_ai.operation.name');
    expect(keys).toContain('gen_ai.tool.name');
    expect(keys).toContain('session.id');
    expect(span.name).toBe('tool.read_file');
  });

  test('marks a failed tool span with an error status', () => {
    const span = journal.toOtlpSpan(
      { kind: 'tool', at: '2026-10-27T10:00:00.000Z', tool: 'x', ok: false },
      's1'
    );
    expect(span.status.code).toBe(2);
  });

  test('produces a valid resourceSpans envelope', () => {
    journal.recordTurn('s1', { turn: 1, summary: 'x' });
    const doc = journal.toOtlp('s1');
    expect(doc.resourceSpans).toHaveLength(1);
    expect(doc.resourceSpans[0].scopeSpans[0].spans.length).toBe(1);
    expect(doc.resourceSpans[0].resource.attributes[0].key).toBe('service.name');
  });

  test('trace and span ids are hex and correctly sized', () => {
    const span = journal.toOtlpSpan({ kind: 'turn', at: '2026-10-27T10:00:00.000Z', turn: 1 }, 'abc123');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('replay — rendering', () => {
  test('elapsed handles sub-minute, minutes, and hours', () => {
    expect(replay.elapsed('2026-10-27T10:00:00Z', '2026-10-27T10:00:30Z')).toBe('30s');
    expect(replay.elapsed('2026-10-27T10:00:00Z', '2026-10-27T10:05:00Z')).toBe('5m00s');
    // A session crossing midnight must still read as 35 minutes, not 2143.
    expect(replay.elapsed('2026-10-27T23:50:00Z', '2026-10-28T00:25:00Z')).toBe('35m00s');
    // Past an hour, switch to h/m so a long run stays readable.
    expect(replay.elapsed('2026-10-27T23:00:00Z', '2026-10-28T00:35:00Z')).toBe('1h35m');
  });

  test('elapsed returns empty for bad input', () => {
    expect(replay.elapsed('', '')).toBe('');
    expect(replay.elapsed('2026-10-27T10:00:00Z', '2026-10-27T09:00:00Z')).toBe('');
  });

  test('glyph maps known tools and falls back', () => {
    expect(replay.glyph('run_in_terminal')).toBe('⌘');
    expect(replay.glyph('read_file')).toBe('👁');
    expect(replay.glyph('totally_unknown')).toBe('·');
  });

  test('renderTurn includes summary, completed, blockers, and next', () => {
    const out = replay.renderTurn({
      turn: 3,
      at: '2026-10-27T10:00:00.000Z',
      summary: 'Did the thing.',
      completed: ['wrote a.js'],
      blockers: ['tests failed'],
      next: ['retry'],
      toolCount: 5,
      openCount: 2,
      resolved: 1,
      blocked: true,
    }, 10);

    expect(out).toContain('turn 3');
    expect(out).toContain('Did the thing.');
    expect(out).toContain('wrote a.js');
    expect(out).toContain('tests failed');
    expect(out).toContain('retry');
    expect(out).toContain('BLOCKED');
  });

  test('renderTool shows a failure marker', () => {
    const out = replay.renderTool({ at: '2026-10-27T10:00:00.000Z', tool: 'run_in_terminal', intent: 'npm test', ok: false });
    expect(out).toContain('run_in_terminal');
    expect(out).toContain('npm test');
    expect(out).toContain('✗');
  });
});
