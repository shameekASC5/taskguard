'use strict';

/**
 * Tests for core/parsers.cjs — the portability seam.
 *
 * The point of this module is that core/ does not know what VS Code is. These
 * tests pin that: a second harness format must produce the same normalised
 * turn shape, and auto-detection must pick the right parser without being told.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parsers = require('../core/parsers.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parsers-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

/** The normalised shape every parser must produce. */
function assertNormalised(turns) {
  expect(Array.isArray(turns)).toBe(true);
  for (const t of turns) {
    expect(typeof t.index).toBe('number');
    expect(typeof t.userText).toBe('string');
    expect(typeof t.assistantText).toBe('string');
    expect(Array.isArray(t.tools)).toBe(true);
    for (const tool of t.tools) {
      expect(typeof tool.tool).toBe('string');
      expect(typeof tool.intent).toBe('string');
      expect(typeof tool.ok).toBe('boolean');
    }
  }
}

describe('parsers — VS Code', () => {
  test('parses the real transcript shape', () => {
    const p = write('vs.jsonl', [
      JSON.stringify({ type: 'user.message', data: { content: 'do it' }, timestamp: '2026-10-27T10:00:00Z' }),
      JSON.stringify({ type: 'assistant.message', data: { content: 'done' }, timestamp: '2026-10-27T10:00:01Z' }),
      JSON.stringify({
        type: 'tool.execution_start',
        data: { toolCallId: 'c1', toolName: 'run_in_terminal', arguments: { command: 'npm test' } },
        timestamp: '2026-10-27T10:00:02Z',
      }),
      JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true }, timestamp: '2026-10-27T10:00:03Z' }),
    ].join('\n'));

    const turns = parsers.vscode.parse(p);
    assertNormalised(turns);
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe('do it');
    expect(turns[0].tools[0].intent).toBe('npm test');
  });
});

describe('parsers — OpenAI-style messages', () => {
  test('parses a JSON array of messages', () => {
    const p = write('msgs.json', [
      { role: 'user', content: 'fix it', timestamp: '2026-10-27T10:00:00Z' },
      {
        role: 'assistant',
        content: 'working',
        timestamp: '2026-10-27T10:00:01Z',
        tool_calls: [{ function: { name: 'read_file', arguments: '{"filePath":"a.js"}' } }],
      },
    ]);

    const turns = parsers.openaiMessages.parse(p);
    assertNormalised(turns);
    expect(turns[0].userText).toBe('fix it');
    expect(turns[0].tools[0].tool).toBe('read_file');
    expect(turns[0].tools[0].intent).toBe('a.js');
  });

  test('parses JSONL of messages too', () => {
    const p = write('msgs.jsonl', [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: 'hello' }),
    ].join('\n'));

    const turns = parsers.openaiMessages.parse(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantText).toBe('hello');
  });

  test('marks a tool call failed when the result looks like an error', () => {
    const p = write('err.json', [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_in_terminal', arguments: '{"command":"false"}' } }] },
      { role: 'tool', content: 'Error: command failed' },
    ]);

    const turns = parsers.openaiMessages.parse(p);
    expect(turns[0].tools[0].ok).toBe(false);
  });

  test('handles toolCalls camelCase variant', () => {
    const p = write('camel.json', [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'grep_search', arguments: { query: 'foo' } }] },
    ]);

    const turns = parsers.openaiMessages.parse(p);
    expect(turns[0].tools[0].tool).toBe('grep_search');
    expect(turns[0].tools[0].intent).toBe('foo');
  });

  test('returns empty for unparseable input rather than throwing', () => {
    const p = write('bad.json', 'not json at all');
    expect(parsers.openaiMessages.parse(p)).toEqual([]);
  });
});

describe('parsers — auto-detection', () => {
  test('detects a VS Code transcript', () => {
    const p = write('a.jsonl', JSON.stringify({ type: 'user.message', data: { content: 'x' } }));
    expect(parsers.resolve(undefined, p).name).toBe('vscode');
  });

  test('detects an OpenAI-style log', () => {
    const p = write('b.json', JSON.stringify([{ role: 'user', content: 'x' }]));
    expect(parsers.resolve(undefined, p).name).toBe('openai-messages');
  });

  test('an explicit name wins over detection', () => {
    const p = write('c.json', JSON.stringify([{ role: 'user', content: 'x' }]));
    expect(parsers.resolve('vscode', p).name).toBe('vscode');
  });

  test('falls back to vscode for an unreadable file', () => {
    expect(parsers.resolve(undefined, '/nonexistent/x.jsonl').name).toBe('vscode');
  });
});

describe('parsers — intent derivation across harnesses', () => {
  test('handles both snake_case and camelCase tool names', () => {
    expect(parsers.intentFrom('run_in_terminal', { command: 'npm test' })).toBe('npm test');
    expect(parsers.intentFrom('runCommand', { command: 'npm test' })).toBe('npm test');
    expect(parsers.intentFrom('read_file', { filePath: 'a.js' })).toBe('a.js');
    expect(parsers.intentFrom('readFile', { path: 'a.js' })).toBe('a.js');
  });

  test('handles alternate argument key names', () => {
    expect(parsers.intentFrom('bash', { cmd: 'ls' })).toBe('ls');
    expect(parsers.intentFrom('search', { pattern: 'foo' })).toBe('foo');
    expect(parsers.intentFrom('fetch', { url: 'https://x.dev' })).toBe('https://x.dev');
  });
});
