'use strict';

/**
 * Tests for core/changelog.cjs.
 *
 * The central claim this module makes is that a session record is NOT the same
 * thing as a git diff — a session that only searched your filesystem still did
 * work, and must still be recorded. Most of these tests pin that.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let changelog;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-changelog-'));
  process.env.LEDGER_DIR = path.join(tmpDir, 'ledger');
  jest.resetModules();
  changelog = require('../core/changelog.cjs');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LEDGER_DIR;
});

const tool = (name, intent = '') => ({ tool: name, intent });

describe('changelog — classification', () => {
  test('file writes classify as code', () => {
    expect(changelog.classify([tool('create_file', '/a.js')])).toBe('code');
    expect(changelog.classify([tool('replace_string_in_file', '/a.js')])).toBe('code');
  });

  test('moves and deletes classify as filesystem', () => {
    expect(changelog.classify([tool('move_file', '/a.js')])).toBe('filesystem');
    expect(changelog.classify([tool('delete_file', '/a.js')])).toBe('filesystem');
  });

  test('reads and searches classify as research', () => {
    expect(changelog.classify([tool('read_file', '/a.js')])).toBe('research');
    expect(changelog.classify([tool('grep_search', 'foo')])).toBe('research');
    expect(changelog.classify([tool('fetch_webpage', 'https://x.dev')])).toBe('research');
  });

  test('more than one kind classifies as mixed', () => {
    expect(changelog.classify([tool('read_file', '/a.js'), tool('create_file', '/b.js')])).toBe('mixed');
    expect(changelog.classify([tool('move_file', '/a.js'), tool('create_file', '/b.js')])).toBe('mixed');
  });

  test('exec-only sessions classify as none', () => {
    // A session that only ran commands leaves no evidence of what it touched.
    // Calling it "code" would be a guess.
    expect(changelog.classify([tool('run_in_terminal', 'ls')])).toBe('none');
  });

  test('an empty session classifies as none', () => {
    expect(changelog.classify([])).toBe('none');
    expect(changelog.classify(null)).toBe('none');
    expect(changelog.classify(undefined)).toBe('none');
  });

  test('tolerates malformed tool records', () => {
    expect(changelog.classify([null, {}, { tool: 42 }])).toBe('none');
  });
});

describe('changelog — files touched', () => {
  test('splits files by how they were touched', () => {
    const r = changelog.filesTouched([
      tool('read_file', '/src/a.js'),
      tool('replace_string_in_file', '/src/a.js'),
      tool('create_file', '/src/b.js'),
      tool('move_file', '/src/c.js'),
    ]);
    expect(r.written).toEqual(['/src/a.js', '/src/b.js']);
    expect(r.read).toEqual(['/src/a.js']);
    expect(r.moved).toEqual(['/src/c.js']);
  });

  test('ignores intents that are not paths', () => {
    // A terminal command is not a file; listing it under "Files" misleads.
    const r = changelog.filesTouched([tool('run_in_terminal', 'npm test')]);
    expect(r.written).toEqual([]);
    expect(r.read).toEqual([]);
  });

  test('deduplicates repeated touches', () => {
    const r = changelog.filesTouched([
      tool('read_file', '/a.js'),
      tool('read_file', '/a.js'),
    ]);
    expect(r.read).toEqual(['/a.js']);
  });
});

describe('changelog — markdown', () => {
  const baseSession = {
    sessionId: 'sess-1',
    workspace: '/ws',
    gitRoot: '',
    turns: [
      {
        turn: 1,
        at: '2026-10-27T10:00:00Z',
        headline: 'Fixed the null check',
        summary: 'Added a guard.',
        completed: ['guard added'],
        blockers: [],
        next: ['run tests'],
      },
    ],
    tools: [tool('replace_string_in_file', '/ws/a.js')],
  };

  test('includes the headline, summary, and activity class', () => {
    const md = changelog.renderMarkdown(baseSession);
    expect(md).toContain('Fixed the null check');
    expect(md).toContain('Added a guard.');
    expect(md).toContain('**Activity**: code');
    expect(md).toContain('guard added');
    expect(md).toContain('run tests');
  });

  test('marks a blocked turn', () => {
    const md = changelog.renderMarkdown({
      ...baseSession,
      turns: [{ ...baseSession.turns[0], blocked: true }],
    });
    expect(md).toContain('⛔');
  });

  test('says so when there is no git repo', () => {
    const md = changelog.renderMarkdown(baseSession);
    expect(md).toContain('Not a git repository');
  });

  test('omits the git section entirely for an empty session', () => {
    const md = changelog.renderMarkdown({ sessionId: 'x', workspace: '/ws', turns: [], tools: [] });
    expect(md).not.toContain('## Git');
  });

  test('handles a session with no summaries', () => {
    const md = changelog.renderMarkdown({ sessionId: 'x', workspace: '/ws', turns: [], tools: [] });
    expect(md).toContain('No turn summaries recorded');
  });
});

describe('changelog — writing', () => {
  test('writes a file into the workspace changelog dir', () => {
    const ws = path.join(tmpDir, 'ws');
    fs.mkdirSync(ws);

    const r = changelog.write({
      sessionId: 'sess-1',
      workspace: ws,
      turns: [{ turn: 1, at: '2026-10-27T10:00:00Z', headline: 'Did a thing' }],
      tools: [tool('create_file', '/ws/a.js')],
    });

    expect(r.written).toBe(true);
    expect(r.kind).toBe('code');
    expect(fs.existsSync(r.path)).toBe(true);
    expect(fs.readFileSync(r.path, 'utf8')).toContain('Did a thing');
  });

  test('rewrites the same file on a second call (one file per session)', () => {
    const ws = path.join(tmpDir, 'ws');
    fs.mkdirSync(ws);

    const session = {
      sessionId: 'sess-1',
      workspace: ws,
      turns: [{ turn: 1, at: '2026-10-27T10:00:00Z', headline: 'First' }],
      tools: [tool('create_file', '/ws/a.js')],
    };
    const first = changelog.write(session);

    session.turns.push({ turn: 2, at: '2026-10-27T10:05:00Z', headline: 'Second' });
    const second = changelog.write(session);

    expect(second.path).toBe(first.path);
    const files = fs.readdirSync(path.join(ws, 'changelog'));
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(second.path, 'utf8')).toContain('Second');
  });

  test('appends to the central index', () => {
    const ws = path.join(tmpDir, 'ws');
    fs.mkdirSync(ws);

    changelog.write({
      sessionId: 'sess-1',
      workspace: ws,
      turns: [{ turn: 1, at: '2026-10-27T10:00:00Z', headline: 'Did a thing' }],
      tools: [tool('create_file', '/ws/a.js')],
    });

    const index = changelog.readIndex();
    expect(index).toHaveLength(1);
    expect(index[0].sessionId).toBe('sess-1');
    expect(index[0].kind).toBe('code');
    expect(index[0].headlines).toEqual(['Did a thing']);
  });

  test('records a research session even with no code changes', () => {
    // This is the whole point: a non-coding session must not vanish.
    const ws = path.join(tmpDir, 'ws');
    fs.mkdirSync(ws);

    const r = changelog.write({
      sessionId: 'sess-2',
      workspace: ws,
      turns: [{ turn: 1, at: '2026-10-27T10:00:00Z', headline: 'Searched for config files' }],
      tools: [tool('grep_search', 'config')],
    });

    expect(r.written).toBe(true);
    expect(r.kind).toBe('research');
    expect(fs.readFileSync(r.path, 'utf8')).toContain('Searched for config files');
  });

  test('does not throw when the workspace does not exist', () => {
    const r = changelog.write({
      sessionId: 'sess-3',
      workspace: '/nonexistent/place',
      turns: [{ turn: 1, at: '2026-10-27T10:00:00Z', headline: 'x' }],
      tools: [tool('create_file', '/a.js')],
    });
    expect(r.written).toBe(false);
    expect(r.error).toBeUndefined();
  });

  test('sanitises the session id in the filename', () => {
    const ws = path.join(tmpDir, 'ws');
    fs.mkdirSync(ws);

    const r = changelog.write({
      sessionId: '../../evil',
      workspace: ws,
      turns: [{ turn: 1, at: '2026-10-27T10:00:00Z', headline: 'x' }],
      tools: [tool('create_file', '/a.js')],
    });

    expect(path.dirname(r.path)).toBe(path.join(ws, 'changelog'));
    expect(path.basename(r.path)).not.toContain('..');
  });
});

describe('changelog — index reading and truncation', () => {
  /** Seed N index records, oldest first. */
  function seed(n) {
    fs.mkdirSync(path.dirname(changelog.INDEX_FILE), { recursive: true });
    const lines = [];
    for (let i = 1; i <= n; i += 1) {
      lines.push(JSON.stringify({
        at: new Date(Date.now() - (n - i) * 86400000).toISOString(),
        sessionId: `s${i}`,
        workspace: '/ws',
        kind: 'code',
        turns: i,
        tools: i * 3,
        headlines: [`did thing ${i}`],
        files: { written: [], read: [], moved: [] },
        changelogPath: '',
      }));
    }
    fs.writeFileSync(changelog.INDEX_FILE, `${lines.join('\n')}\n`);
  }

  test('reports the true total even when the read is capped', () => {
    // The cap must not hide the fact that it truncated. A list that looks
    // complete but is missing history is the bug this guards against.
    seed(12);
    const r = changelog.readIndex(5);
    expect(r).toHaveLength(5);
    expect(r.total).toBe(12);
    expect(r.truncated).toBe(true);
  });

  test('returns everything when the limit is Infinity', () => {
    seed(12);
    const r = changelog.readIndex(Infinity);
    expect(r).toHaveLength(12);
    expect(r.truncated).toBe(false);
  });

  test('does not report truncation when the limit exceeds the total', () => {
    seed(3);
    const r = changelog.readIndex(500);
    expect(r).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  test('a capped read returns the NEWEST records', () => {
    seed(12);
    const r = changelog.readIndex(3);
    expect(r.map((x) => x.sessionId)).toEqual(['s10', 's11', 's12']);
  });

  test('an empty index reports zero, not truncation', () => {
    const r = changelog.readIndex(5);
    expect(r).toHaveLength(0);
    expect(r.total).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test('total and truncated are not enumerable, so JSON output is unchanged', () => {
    seed(3);
    const r = changelog.readIndex(2);
    expect(JSON.parse(JSON.stringify(r))).toHaveLength(2);
  });
});

describe('changelog — pruning', () => {
  function seed(n) {
    fs.mkdirSync(path.dirname(changelog.INDEX_FILE), { recursive: true });
    const lines = [];
    for (let i = 1; i <= n; i += 1) {
      lines.push(JSON.stringify({
        at: new Date(Date.now() - (n - i) * 86400000).toISOString(),
        sessionId: `s${i}`,
        workspace: '/ws',
        kind: 'code',
        turns: 1,
        tools: 1,
        headlines: [],
        files: { written: [], read: [], moved: [] },
        changelogPath: '',
      }));
    }
    fs.writeFileSync(changelog.INDEX_FILE, `${lines.join('\n')}\n`);
  }

  test('--keep retains the newest N', () => {
    seed(12);
    const r = changelog.pruneIndex({ keep: 5 });
    expect(r).toMatchObject({ before: 12, after: 5, removed: 7 });
    expect(changelog.readIndex(Infinity).map((x) => x.sessionId))
      .toEqual(['s8', 's9', 's10', 's11', 's12']);
  });

  test('--older-than drops records past the cutoff', () => {
    seed(12); // one per day, oldest first
    const r = changelog.pruneIndex({ olderThanMs: 5 * 86400000 });
    expect(r.removed).toBeGreaterThan(0);
    expect(r.after).toBeLessThan(12);
  });

  test('dry run reports but changes nothing', () => {
    seed(12);
    const r = changelog.pruneIndex({ keep: 5, dryRun: true });
    expect(r).toMatchObject({ before: 12, after: 5, removed: 7, dryRun: true });
    expect(changelog.readIndex(Infinity)).toHaveLength(12);
  });

  test('pruning to more than exists removes nothing', () => {
    seed(3);
    const r = changelog.pruneIndex({ keep: 100 });
    expect(r.removed).toBe(0);
    expect(changelog.readIndex(Infinity)).toHaveLength(3);
  });

  test('pruning an empty index is a no-op', () => {
    const r = changelog.pruneIndex({ keep: 5 });
    expect(r).toMatchObject({ before: 0, after: 0, removed: 0 });
  });

  test('keeps records with an unparseable timestamp rather than guessing', () => {
    fs.mkdirSync(path.dirname(changelog.INDEX_FILE), { recursive: true });
    fs.writeFileSync(changelog.INDEX_FILE, [
      JSON.stringify({ at: 'not-a-date', sessionId: 'weird', kind: 'code' }),
      JSON.stringify({ at: new Date().toISOString(), sessionId: 'normal', kind: 'code' }),
    ].join('\n') + '\n');

    changelog.pruneIndex({ olderThanMs: 1000 });
    const ids = changelog.readIndex(Infinity).map((x) => x.sessionId);
    expect(ids).toContain('weird');
  });

  test('the pruned file is valid JSONL', () => {
    seed(12);
    changelog.pruneIndex({ keep: 5 });
    const raw = fs.readFileSync(changelog.INDEX_FILE, 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('changelog — git integration', () => {
  test('includes branch and diff when the workspace is a repo', () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

    run('init');
    run('config', 'user.email', 't@t.t');
    run('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
    run('add', 'a.js');
    run('commit', '-m', 'init');
    fs.appendFileSync(path.join(repo, 'a.js'), 'y\n');

    const root = changelog.gitRoot(repo);
    expect(root).toBeTruthy();

    const r = changelog.write({
      sessionId: 'git-sess',
      workspace: repo,
      gitRoot: root,
      turns: [{ turn: 1, at: '2026-10-27T10:00:00Z', headline: 'Edited a.js' }],
      tools: [tool('replace_string_in_file', path.join(repo, 'a.js'))],
    });

    const md = fs.readFileSync(r.path, 'utf8');
    expect(md).toContain('## Git');
    expect(md).toContain('a.js');
    expect(md).not.toContain('Not a git repository');
  });

  test('gitRoot returns empty for a non-repo', () => {
    const plain = path.join(tmpDir, 'plain');
    fs.mkdirSync(plain);
    expect(changelog.gitRoot(plain)).toBe('');
  });

  test('gitRoot returns empty for a missing directory', () => {
    expect(changelog.gitRoot('/nonexistent/x')).toBe('');
    expect(changelog.gitRoot('')).toBe('');
  });
});
