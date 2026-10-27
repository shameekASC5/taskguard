'use strict';

/**
 * End-to-end tests for the hook scripts.
 *
 * Each script is executed as a real child process with a JSON event on stdin,
 * exactly as the VS Code harness invokes it. The LLM is stubbed by pointing
 * the client at a local HTTP server that returns canned JSON.
 *
 * This validates the full contract: stdin parsing, ledger persistence,
 * stdout JSON shape, and the block/nudge decisions.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const ADAPTER_DIR = path.join(__dirname, '..', 'adapters', 'vscode');

/**
 * A throwaway ledger dir for the whole suite.
 *
 * The hooks under test write real files. Pointing them at the developer's
 * home directory means a test run pollutes real state — which is exactly what
 * happened: eight synthetic sessions ("stop-clean", "stub-*") ended up in the
 * production changelog index before this was isolated.
 *
 * This must be set BEFORE requiring core/ledger.cjs, because that module reads
 * LEDGER_DIR once at load time. The in-process `ledger` below and the spawned
 * hooks must agree on the directory, or the assertions read an empty ledger.
 */
const testLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-ledger-'));
process.env.LEDGER_DIR = testLedgerDir;

const ledger = require('../core/ledger.cjs');

/**
 * Start the stub LLM server as a SEPARATE process.
 *
 * It must not live in this process: the hook scripts are invoked with
 * spawnSync, which blocks this event loop, so an in-process server could
 * never answer the hook's HTTP request and the hook would hang.
 */
function startStubServer(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'stub-server.cjs')], {
      env: { ...process.env, STUB_PAYLOAD: JSON.stringify(payload) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n')[0].trim();
      if (line) {
        resolve({ child, url: `http://127.0.0.1:${line}` });
      }
    });
    child.on('error', reject);
  });
}

/** Run a hook script with an event on stdin. */
function runHook(script, event, env = {}) {
  const res = spawnSync('node', [path.join(ADAPTER_DIR, script)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

function cleanup(sessionId) {
  try {
    fs.unlinkSync(ledger.ledgerPath(sessionId));
  } catch {
    // Already gone.
  }
}

describe('hook scripts (end-to-end)', () => {
  let stub;
  let baseUrl;

  beforeAll(async () => {
    stub = await startStubServer({
      items: [
        { kind: 'question', text: 'What is the deploy command?' },
        { kind: 'task', text: 'Fix the login bug' },
      ],
      verdicts: [],
    });
    baseUrl = stub.url;
  });

  afterAll(() => {
    if (stub && stub.child) stub.child.kill();
    // Remove the throwaway ledger dir so a test run leaves nothing behind.
    try {
      fs.rmSync(testLedgerDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  });

  const stubEnv = () => ({
    LEDGER_API_KEY: 'test',
    LEDGER_TEST_URL: baseUrl,
    LEDGER_ALLOW_TEST_URL: '1',
    LEDGER_TRACE: '0',
    // Isolate all state. Without this the hooks write into the developer's
    // real ~/.copilot/hooks/ledger/.ledger/, which pollutes the changelog
    // index with synthetic sessions named "stop-clean", "stub-*", and so on.
    LEDGER_DIR: testLedgerDir,
    LEDGER_CHANGELOG: '0',
  });

  test('ledger-extract pulls items from the prompt and writes the ledger', () => {
    const sessionId = `extract-${Date.now()}`;
    const { stdout } = runHook('prompt-submitted.cjs', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: 'What is the deploy command? Also fix the login bug.',
    }, stubEnv());

    // userPromptSubmit output is dropped by the harness; we emit {}.
    expect(JSON.parse(stdout)).toEqual({});

    const led = ledger.load(sessionId);
    expect(led.items.length).toBeGreaterThanOrEqual(2);
    expect(led.injectedForTurn).toBe(false);
    cleanup(sessionId);
  });

  test('ledger-extract ignores system/notification noise', () => {
    const sessionId = `extract-noise-${Date.now()}`;
    runHook('prompt-submitted.cjs', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: '[Terminal abc notification: command completed.]',
    }, stubEnv());

    const led = ledger.load(sessionId);
    expect(led.items).toHaveLength(0);
    cleanup(sessionId);
  });

  test('ledger-extract resets blockCount on a new prompt', () => {
    // Regression: blockCount was never reset, so after MAX_BLOCKS blocks in a
    // session the enforcer stayed off for the rest of that session.
    const sessionId = `blockreset-${Date.now()}`;
    const led = ledger.load(sessionId);
    led.blockCount = 3;
    ledger.save(led);

    runHook('prompt-submitted.cjs', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: 'A brand new request that should re-arm the enforcer.',
    }, stubEnv());

    const after = ledger.load(sessionId);
    expect(after.blockCount).toBe(0);
    cleanup(sessionId);
  });

  test('ledger-session injects carried-over items at session start', () => {
    const sessionId = `session-${Date.now()}`;
    const led = ledger.load(sessionId);
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'carried-over session task' }]);
    ledger.save(led);

    const { stdout } = runHook('session.cjs', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
    }, stubEnv());

    const out = JSON.parse(stdout);
    expect(out.additionalContext).toContain('carried-over session task');
    cleanup(sessionId);
  });

  test('ledger-inject emits the ledger once per turn', () => {
    const sessionId = `inject-${Date.now()}`;
    const led = ledger.load(sessionId);
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'inject-visible-task' }]);
    ledger.save(led);

    const first = JSON.parse(runHook('before-tool.cjs', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
    }, stubEnv()).stdout);

    expect(first.hookSpecificOutput.additionalContext).toContain('inject-visible-task');

    // Second call in the same turn must not inject again.
    const second = JSON.parse(runHook('before-tool.cjs', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
    }, stubEnv()).stdout);

    expect(second.hookSpecificOutput).toBeUndefined();
    cleanup(sessionId);
  });

  test('ledger-inject stays silent when nothing is open', () => {
    const sessionId = `inject-empty-${Date.now()}`;
    const { stdout } = runHook('before-tool.cjs', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
    }, stubEnv());

    expect(JSON.parse(stdout)).toEqual({});
    cleanup(sessionId);
  });

  test('ledger-stop allows the turn when nothing is open', () => {
    const sessionId = `stop-clean-${Date.now()}`;
    const { stdout } = runHook('turn-end.cjs', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    }, stubEnv());

    expect(JSON.parse(stdout)).toEqual({});
    cleanup(sessionId);
  });

  test('ledger-stop blocks with decision nested in hookSpecificOutput', () => {
    // Regression: a top-level decision is silently ignored by the harness.
    // The systemMessage still renders, so the warning appears but no
    // continuation turn is forced.
    const sessionId = `stop-block-${Date.now()}`;
    const led = ledger.load(sessionId);
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'stop-block-unresolved-task' }]);
    ledger.save(led);

    const { stdout } = runHook('turn-end.cjs', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      stop_hook_active: false,
    }, { ...stubEnv(), LEDGER_FORCE_BLOCK: '1' });

    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput).toBeDefined();
    expect(out.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(out.hookSpecificOutput.decision).toBe('block');
    expect(out.hookSpecificOutput.reason).toContain('stop-block-unresolved-task');
    expect(out.systemMessage).toContain('stop-block-unresolved-task');
    cleanup(sessionId);
  });

  test('ledger-stop never blocks twice in a row for the same continuation', () => {
    const sessionId = `stop-active-${Date.now()}`;
    const led = ledger.load(sessionId);
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'stop-active-task' }]);
    ledger.save(led);

    const { stdout } = runHook('turn-end.cjs', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      stop_hook_active: true,
    }, { ...stubEnv(), LEDGER_FORCE_BLOCK: '1' });

    expect(JSON.parse(stdout)).toEqual({});
    cleanup(sessionId);
  });

  test('ledger-stop releases the turn after MAX_BLOCKS', () => {
    const sessionId = `stop-limit-${Date.now()}`;
    const led = ledger.load(sessionId);
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'stop-limit-task' }]);
    led.blockCount = 3; // already at the cap
    ledger.save(led);

    const { stdout } = runHook('turn-end.cjs', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      stop_hook_active: false,
    }, { ...stubEnv(), LEDGER_FORCE_BLOCK: '1' });

    expect(JSON.parse(stdout)).toEqual({});
    cleanup(sessionId);
  });

  test('turn-end reads the substantive message, not a trailing stub', async () => {
    // Regression: the Stop hook fires while the agent is still writing, so the
    // transcript's last assistant.message can be a short preamble ("Let me
    // check...") while the real answer is the message before it. The old
    // parser took only the last message, so the audit saw 118 chars of
    // preamble instead of 4,000 chars of evidence, and could never mark
    // anything done.
    const sessionId = `stub-${Date.now()}`;
    const led = ledger.load(sessionId);
    ledger.mergeExtracted(led, [{ kind: 'task', text: 'stub-detection-task' }]);
    ledger.save(led);

    const transcript = path.join(os.tmpdir(), `tg-stub-${Date.now()}.jsonl`);
    const lines = [
      { type: 'assistant.turn_start' },
      { type: 'assistant.message', data: { content: 'Let me check that.' } },
      { type: 'assistant.turn_end' },
      { type: 'user.message', data: { content: 'go on' } },
      { type: 'assistant.turn_start' },
      { type: 'assistant.message', data: { content: 'Let me look at the files.' } },
      { type: 'tool.execution_start' },
      { type: 'tool.execution_complete' },
      {
        type: 'assistant.message',
        data: {
          content: 'Done. stub-detection-task is complete: the file was changed and 33 tests pass.',
        },
      },
      { type: 'assistant.turn_end' },
      { type: 'assistant.turn_start' },
      // The stub the harness writes while the agent is still generating.
      { type: 'assistant.message', data: { content: 'Let me verify.' } },
    ];
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n'));

    // A stub that echoes back a "done" verdict for whatever it is asked about,
    // so this test isolates the transcript parser rather than the model.
    const echoStub = await startStubServer({
      verdicts: [{ id: 't1', status: 'done', note: 'file changed, tests pass' }],
    });

    try {
      const { stdout } = runHook('turn-end.cjs', {
        hook_event_name: 'Stop',
        session_id: sessionId,
        transcript_path: transcript,
        stop_hook_active: false,
      }, {
        LEDGER_API_KEY: 'test',
        LEDGER_TEST_URL: echoStub.url,
        LEDGER_ALLOW_TEST_URL: '1',
        LEDGER_TRACE: '0',
        // Isolation. This test builds its own env object rather than using
        // stubEnv(), so it must repeat these or the hook writes a changelog
        // into the real workspace.
        LEDGER_DIR: testLedgerDir,
        LEDGER_CHANGELOG: '0',
      });

      // The audit was given the substantive text, so the item resolved and the
      // turn was allowed.
      expect(JSON.parse(stdout)).toEqual({});
      expect(ledger.openItems(ledger.load(sessionId))).toHaveLength(0);
    } finally {
      echoStub.child.kill();
      fs.unlinkSync(transcript);
      cleanup(sessionId);
    }
  });

  test('every hook emits valid JSON and exits 0 on malformed input', () => {
    // A hook that throws or prints garbage can wedge the editor, so this is
    // the most important contract of all.
    const scripts = [
      'session.cjs',
      'prompt-submitted.cjs',
      'before-tool.cjs',
      'after-tool.cjs',
      'turn-end.cjs',
    ];

    for (const script of scripts) {
      const res = spawnSync('node', [path.join(ADAPTER_DIR, script)], {
        input: 'not json at all',
        encoding: 'utf8',
        env: { ...process.env, ...stubEnv() },
        timeout: 20000,
      });
      expect(res.status).toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
    }
  });
});
