'use strict';

/**
 * Tests for the reviewer's write mode and the OTel reader.
 *
 * The load-bearing property here is that the DEFAULT is unchanged. The
 * read-only surface is what shipped, what the README documents, and what the
 * existing tests pin. Adding a write mode must not quietly widen it for anyone
 * who did not ask — so most of these tests assert that nothing changed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tools;
let review;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-write-'));
  delete process.env.LEDGER_REVIEW_WRITE;
  jest.resetModules();
  tools = require('../core/tools.cjs');
  review = require('../core/review.cjs');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LEDGER_REVIEW_WRITE;
});

describe('tools — write mode is off by default', () => {
  test('writeMode() is false with no env var', () => {
    expect(tools.writeMode()).toBe(false);
  });

  test('the default tool surface is still exactly four tools', () => {
    // This is the contract the existing tests pin. It must not change.
    const names = tools.TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toEqual(['run_command', 'read_file', 'list_dir', 'search']);
  });

  test('toolDefinitions() matches TOOL_DEFINITIONS when writes are off', () => {
    expect(tools.toolDefinitions().map((t) => t.function.name))
      .toEqual(tools.TOOL_DEFINITIONS.map((t) => t.function.name));
  });

  test('write_file is refused', () => {
    const r = tools.writeFile('x.txt', 'hello', tmpDir);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/read-only/);
    expect(fs.existsSync(path.join(tmpDir, 'x.txt'))).toBe(false);
  });

  test('edit_file is refused', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const x = 1;\n');
    const r = tools.editFile('a.js', 'const x = 1;', 'const x = 2;', tmpDir);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/read-only/);
    expect(fs.readFileSync(path.join(tmpDir, 'a.js'), 'utf8')).toContain('const x = 1;');
  });

  test('the denylist still refuses destructive commands', () => {
    expect(tools.checkCommand('rm -rf /').allowed).toBe(false);
    expect(tools.checkCommand('git commit -m x').allowed).toBe(false);
    expect(tools.checkCommand('npm install').allowed).toBe(false);
    expect(tools.checkCommand('sudo rm x').allowed).toBe(false);
  });

  test('the reviewer prompt says READ-ONLY', () => {
    expect(review.reviewSystem(false)).toMatch(/READ-ONLY/);
    expect(review.reviewSystem(false)).toMatch(/CANNOT write/);
  });
});

describe('tools — write mode when enabled', () => {
  beforeEach(() => {
    process.env.LEDGER_REVIEW_WRITE = '1';
  });

  test('writeMode() is true', () => {
    expect(tools.writeMode()).toBe(true);
  });

  test('the surface grows to six tools', () => {
    const names = tools.toolDefinitions().map((t) => t.function.name);
    expect(names).toEqual([
      'run_command', 'read_file', 'list_dir', 'search', 'write_file', 'edit_file',
    ]);
  });

  test('TOOL_DEFINITIONS stays read-only even in write mode', () => {
    // The back-compat alias must not follow the mode, or a caller that
    // imported it at load time would silently get a wider surface.
    expect(tools.TOOL_DEFINITIONS.map((t) => t.function.name))
      .toEqual(['run_command', 'read_file', 'list_dir', 'search']);
  });

  test('the denylist is bypassed', () => {
    expect(tools.checkCommand('rm -rf /').allowed).toBe(true);
    expect(tools.checkCommand('git commit -m x').allowed).toBe(true);
  });

  test('an empty command is still refused', () => {
    // A caller bug in either mode.
    expect(tools.checkCommand('').allowed).toBe(false);
    expect(tools.checkCommand('   ').allowed).toBe(false);
  });

  test('write_file creates a file', () => {
    const r = tools.writeFile('sub/x.txt', 'hello', tmpDir);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'sub/x.txt'), 'utf8')).toBe('hello');
  });

  test('write_file creates parent directories', () => {
    const r = tools.writeFile('a/b/c/x.txt', 'deep', tmpDir);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'a/b/c/x.txt'))).toBe(true);
  });

  test('write_file still refuses to escape the workspace', () => {
    // The confinement is not part of the mode switch. A reviewer that can
    // write to ~/.ssh is a different problem from one that can write to the
    // repo, and only the second is a trade-off worth offering.
    for (const bad of ['../outside.txt', '/tmp/outside.txt', '../../etc/x']) {
      const r = tools.writeFile(bad, 'nope', tmpDir);
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/outside the workspace/);
    }
  });

  test('edit_file replaces an exact match', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const x = 1;\nconst y = 2;\n');
    const r = tools.editFile('a.js', 'const x = 1;', 'const x = 99;', tmpDir);
    expect(r.ok).toBe(true);
    const after = fs.readFileSync(path.join(tmpDir, 'a.js'), 'utf8');
    expect(after).toContain('const x = 99;');
    expect(after).toContain('const y = 2;');
  });

  test('edit_file refuses an ambiguous match', () => {
    // Two occurrences means the edit is not well-defined. Failing loudly is
    // the right behaviour for a tool editing code it did not write.
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'x\nx\n');
    const r = tools.editFile('a.js', 'x', 'y', tmpDir);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/more than once/);
    expect(fs.readFileSync(path.join(tmpDir, 'a.js'), 'utf8')).toBe('x\nx\n');
  });

  test('edit_file refuses a missing match', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const x = 1;\n');
    const r = tools.editFile('a.js', 'not there', 'y', tmpDir);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not found/);
  });

  test('edit_file still refuses to escape the workspace', () => {
    const r = tools.editFile('../outside.js', 'a', 'b', tmpDir);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/outside the workspace/);
  });

  test('executeTool dispatches the write tools', () => {
    expect(tools.executeTool('write_file', { path: 'a.txt', content: 'hi' }, tmpDir).ok)
      .toBe(true);
    expect(tools.executeTool('edit_file', {
      path: 'a.txt', old_string: 'hi', new_string: 'bye',
    }, tmpDir).ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'a.txt'), 'utf8')).toBe('bye');
  });

  test('the reviewer prompt describes the full surface', () => {
    const p = review.reviewSystem(true);
    expect(p).toMatch(/FULL tools/);
    expect(p).toMatch(/write_file/);
    expect(p).toMatch(/edit_file/);
  });

  test('the reviewer prompt still says it is a reviewer, not a fixer', () => {
    // The whole risk of write mode: the reviewer fixes the bug and reports
    // "confirmed", destroying the evidence it was sent to gather.
    const p = review.reviewSystem(true);
    expect(p).toMatch(/not a fixer/i);
    expect(p).toMatch(/BEFORE/);
  });
});

describe('otel — reading VS Code telemetry', () => {
  let otel;
  let otelFile;

  beforeEach(() => {
    otelFile = path.join(tmpDir, 'otel.jsonl');
    process.env.LEDGER_OTEL_FILE = otelFile;
    jest.resetModules();
    otel = require('../core/otel.cjs');
  });

  afterEach(() => {
    delete process.env.LEDGER_OTEL_FILE;
  });

  const span = (name, attrs = {}, duration = 1000000) => JSON.stringify({
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name,
    kind: 1,
    duration,
    attributes: attrs,
  });

  test('status reports a missing file without throwing', () => {
    const s = otel.status();
    expect(s.exists).toBe(false);
    expect(s.outfile).toBe(otelFile);
  });

  test('status reports size when the file exists', () => {
    fs.writeFileSync(otelFile, `${span('execute_tool read_file')}\n`);
    const s = otel.status();
    expect(s.exists).toBe(true);
    expect(s.size).toBeGreaterThan(0);
    expect(s.sizeHuman).toMatch(/B|KB|MB|GB/);
  });

  test('reads tool spans with the GenAI attribute shape', () => {
    fs.writeFileSync(otelFile, [
      span('execute_tool run_in_terminal', {
        'gen_ai.tool.name': { stringValue: 'run_in_terminal' },
        'gen_ai.conversation.id': { stringValue: 'sess-1' },
      }),
      span('chat deepseek/deepseek-v4.1-flash'),
    ].join('\n'));

    return otel.toolSpans().then((spans) => {
      expect(spans).toHaveLength(1);
      expect(spans[0].tool).toBe('run_in_terminal');
      expect(spans[0].sessionId).toBe('sess-1');
      expect(spans[0].durationMs).toBeCloseTo(1, 6);
    });
  });

  test('reads tool spans with the plain-object attribute shape', () => {
    // VS Code has emitted both shapes. Normalising is the point of
    // attributesOf().
    fs.writeFileSync(otelFile, span('execute_tool read_file', {
      'gen_ai.tool.name': 'read_file',
    }));

    return otel.toolSpans().then((spans) => {
      expect(spans[0].tool).toBe('read_file');
    });
  });

  test('falls back to the span name when the attribute is absent', () => {
    fs.writeFileSync(otelFile, span('execute_tool manage_todo_list'));
    return otel.toolSpans().then((spans) => {
      expect(spans[0].tool).toBe('manage_todo_list');
    });
  });

  test('reads token usage from chat spans', () => {
    fs.writeFileSync(otelFile, [
      span('chat model-a', {
        'gen_ai.usage.input_tokens': { intValue: '1000' },
        'gen_ai.usage.output_tokens': { intValue: '200' },
      }),
      span('chat model-a', {
        'gen_ai.usage.input_tokens': { intValue: '500' },
        'gen_ai.usage.output_tokens': { intValue: '100' },
      }),
    ].join('\n'));

    return otel.tokenUsage().then((u) => {
      expect(u.spans).toBe(2);
      expect(u.withUsage).toBe(2);
      expect(u.inputTokens).toBe(1500);
      expect(u.outputTokens).toBe(300);
    });
  });

  test('counts chat spans with no usage separately', () => {
    fs.writeFileSync(otelFile, span('chat model-a'));
    return otel.tokenUsage().then((u) => {
      expect(u.spans).toBe(1);
      expect(u.withUsage).toBe(0);
      expect(u.inputTokens).toBe(0);
    });
  });

  test('skips malformed lines', () => {
    fs.writeFileSync(otelFile, [
      span('execute_tool read_file'),
      '{"name":"execute_tool trunc',
      span('execute_tool list_dir'),
    ].join('\n'));

    return otel.toolSpans().then((spans) => {
      expect(spans).toHaveLength(2);
    });
  });

  test('respects the limit', () => {
    const lines = [];
    for (let i = 0; i < 50; i += 1) lines.push(span(`execute_tool t${i}`));
    fs.writeFileSync(otelFile, lines.join('\n'));

    return otel.toolSpans({ limit: 5 }).then((spans) => {
      expect(spans).toHaveLength(5);
    });
  });

  test('respects maxLines so a huge file cannot hang', () => {
    const lines = [];
    for (let i = 0; i < 100; i += 1) lines.push(span(`execute_tool t${i}`));
    fs.writeFileSync(otelFile, lines.join('\n'));

    return otel.toolSpans({ maxLines: 10 }).then((spans) => {
      expect(spans.length).toBeLessThanOrEqual(10);
    });
  });

  test('never returns tool arguments or results', () => {
    // With captureContent: true those fields hold file contents and command
    // output. The reader must not surface them.
    fs.writeFileSync(otelFile, span('execute_tool read_file', {
      'gen_ai.tool.name': { stringValue: 'read_file' },
      'gen_ai.tool.call.arguments': { stringValue: '{"path":"/etc/passwd"}' },
      'gen_ai.tool.call.result': { stringValue: 'root:x:0:0' },
    }));

    return otel.toolSpans().then((spans) => {
      const json = JSON.stringify(spans);
      expect(json).not.toContain('/etc/passwd');
      expect(json).not.toContain('root:x:0:0');
    });
  });

  test('an empty file yields nothing rather than throwing', () => {
    fs.writeFileSync(otelFile, '');
    return otel.toolSpans().then((spans) => {
      expect(spans).toEqual([]);
    });
  });
});
