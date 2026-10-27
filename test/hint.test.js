'use strict';

/**
 * Tests for the in-chat "where to look" hint.
 *
 * The hint exists because the journal and changelog are only useful if you
 * actually open them, and remembering three commands per session is friction
 * that guarantees you will not.
 *
 * The critical property is that every command carries the SESSION ID rather
 * than using --latest. With two sessions open, --latest shows whichever wrote
 * most recently, not the one you are reading.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ADAPTER_DIR = path.join(__dirname, '..', 'adapters', 'vscode');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hint-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the Stop hook with a synthetic transcript and return the parsed output. */
function runTurnEnd({ sessionId, transcript, env = {} }) {
  const result = spawnSync('node', [path.join(ADAPTER_DIR, 'turn-end.cjs')], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
      stop_hook_active: false,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      LEDGER_DIR: path.join(tmpDir, 'ledger'),
      LEDGER_JOURNAL: '0', // no model call
      LEDGER_TRACE: '0',
      ...env,
    },
  });
  return JSON.parse(result.stdout || '{}');
}

function writeTranscript() {
  const p = path.join(tmpDir, 't.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'user.message', data: { content: 'read it' }, timestamp: '2026-10-27T10:00:00Z' }),
    JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'read_file', arguments: { filePath: '/ws/README.md' } }, timestamp: '2026-10-27T10:00:02Z' }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'Done.' }, timestamp: '2026-10-27T10:00:05Z' }),
  ].join('\n'));
  return p;
}

describe('hint — content', () => {
  test('is emitted on an allowed turn', () => {
    const out = runTurnEnd({ sessionId: 'sess-abc-123', transcript: writeTranscript() });
    expect(out.systemMessage).toBeTruthy();
    expect(out.systemMessage).toContain('TASKGUARD');
  });

  test('every command carries the session id, not --latest', () => {
    // The whole point: with two sessions open, --latest is ambiguous.
    const sessionId = 'sess-abc-123';
    const out = runTurnEnd({ sessionId, transcript: writeTranscript() });

    expect(out.systemMessage).toContain(`replay.cjs ${sessionId}`);
    expect(out.systemMessage).toContain(`changelog.cjs ${sessionId}`);
    expect(out.systemMessage).not.toContain('--latest');
  });

  test('shows a short session prefix so concurrent sessions are distinguishable', () => {
    const out = runTurnEnd({ sessionId: 'abcdefgh-1234-5678', transcript: writeTranscript() });
    expect(out.systemMessage).toContain('abcdefgh');
  });

  test('includes the turn and tool counts', () => {
    const out = runTurnEnd({ sessionId: 'sess-1', transcript: writeTranscript() });
    expect(out.systemMessage).toMatch(/\d+ turn\(s\)/);
    expect(out.systemMessage).toMatch(/\d+ tool call\(s\)/);
  });

  test('points at the changelog file when one was written', () => {
    const out = runTurnEnd({
      sessionId: 'sess-1',
      transcript: writeTranscript(),
      env: { LEDGER_CHANGELOG: '1' },
    });
    expect(out.systemMessage).toContain('changelog');
  });

  test('mentions how to list all sessions', () => {
    const out = runTurnEnd({ sessionId: 'sess-1', transcript: writeTranscript() });
    expect(out.systemMessage).toContain('--list');
  });
});

describe('hint — opt out', () => {
  test('LEDGER_HINT=0 suppresses it', () => {
    const out = runTurnEnd({
      sessionId: 'sess-1',
      transcript: writeTranscript(),
      env: { LEDGER_HINT: '0' },
    });
    expect(out.systemMessage).toBeUndefined();
  });
});

describe('hint — does not break the block path', () => {
  test('a blocked turn still carries the nudge and the hint', () => {
    // Seed an open item so the turn blocks.
    const sessionId = 'block-sess';
    const ledgerDir = path.join(tmpDir, 'ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, `${sessionId}.json`), JSON.stringify({
      sessionId,
      items: [{ id: 't1', kind: 'task', text: 'do the thing', status: 'open', addedAt: '2026-10-27T10:00:00Z' }],
      updatedAt: '2026-10-27T10:00:00Z',
    }));

    const out = runTurnEnd({
      sessionId,
      transcript: writeTranscript(),
      env: { LEDGER_FORCE_BLOCK: '1' },
    });

    expect(out.hookSpecificOutput?.decision).toBe('block');
    // The nudge is the important message; the hint is appended, not replacing.
    expect(out.systemMessage).toContain('NUDGE');
    expect(out.systemMessage).toContain(`replay.cjs ${sessionId}`);
  });
});
