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
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const ledger = require('../hooks/lib/ledger.cjs');

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
  const res = spawnSync('node', [path.join(HOOKS_DIR, script)], {
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
  });

  const stubEnv = () => ({
    LEDGER_API_KEY: 'test',
    LEDGER_TEST_URL: baseUrl,
    LEDGER_ALLOW_TEST_URL: '1',
    LEDGER_TRACE: '0',
  });

  test('ledger-extract pulls items from the prompt and writes the ledger', () => {
    const sessionId = `extract-${Date.now()}`;
    const { stdout } = runHook('ledger-extract.cjs', {
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
    runHook('ledger-extract.cjs', {
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

    runHook('ledger-extract.cjs', {
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

    const { stdout } = runHook('ledger-session.cjs', {
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

    const first = JSON.parse(runHook('ledger-inject.cjs', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
    }, stubEnv()).stdout);

    expect(first.hookSpecificOutput.additionalContext).toContain('inject-visible-task');

    // Second call in the same turn must not inject again.
    const second = JSON.parse(runHook('ledger-inject.cjs', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
    }, stubEnv()).stdout);

    expect(second.hookSpecificOutput).toBeUndefined();
    cleanup(sessionId);
  });

  test('ledger-inject stays silent when nothing is open', () => {
    const sessionId = `inject-empty-${Date.now()}`;
    const { stdout } = runHook('ledger-inject.cjs', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
    }, stubEnv());

    expect(JSON.parse(stdout)).toEqual({});
    cleanup(sessionId);
  });

  test('ledger-stop allows the turn when nothing is open', () => {
    const sessionId = `stop-clean-${Date.now()}`;
    const { stdout } = runHook('ledger-stop.cjs', {
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

    const { stdout } = runHook('ledger-stop.cjs', {
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

    const { stdout } = runHook('ledger-stop.cjs', {
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

    const { stdout } = runHook('ledger-stop.cjs', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      stop_hook_active: false,
    }, { ...stubEnv(), LEDGER_FORCE_BLOCK: '1' });

    expect(JSON.parse(stdout)).toEqual({});
    cleanup(sessionId);
  });

  test('every hook emits valid JSON and exits 0 on malformed input', () => {
    // A hook that throws or prints garbage can wedge the editor, so this is
    // the most important contract of all.
    const scripts = [
      'ledger-session.cjs',
      'ledger-extract.cjs',
      'ledger-inject.cjs',
      'ledger-nudge.cjs',
      'ledger-stop.cjs',
    ];

    for (const script of scripts) {
      const res = spawnSync('node', [path.join(HOOKS_DIR, script)], {
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
