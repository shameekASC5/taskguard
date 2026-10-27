'use strict';

/**
 * Session changelog — persist what a session actually did, in a form other
 * systems can consume.
 *
 * WHY THIS IS NOT JUST `git diff`
 * -------------------------------
 * A changelog is repo-shaped: it assumes a codebase with a diff. Agent sessions
 * are broader. The same agent that refactors a module also searches your
 * filesystem, moves files around, and answers questions. A git-diff-only
 * changelog produces NOTHING for those sessions, so the work vanishes.
 *
 * So this writes a SESSION RECORD, classified by what actually happened:
 *
 *   code        file writes/edits          -> changelog + git diff if available
 *   filesystem  moves, deletes, renames    -> file-operations log
 *   research    reads, searches, fetches   -> findings log
 *   mixed       more than one of the above
 *   none        only exec tools, or nothing
 *
 * Classification comes from the tool timeline, which is derived from the
 * harness transcript — not from the agent's own claims. An agent that says it
 * edited files but only ran `ls` classifies as research.
 *
 * TWO OUTPUTS
 * -----------
 *   1. <workspace>/changelog/YYYY-MM-DD-HHmmss-<session>.md
 *      Human-readable, committable, same shape as the manual ChangelogAgent.
 *
 *   2. ~/.copilot/hooks/ledger/.ledger/changelog-index.jsonl
 *      Append-only, one record per session, for downstream systems. Survives
 *      across workspaces, so you can query "what did agents do this week"
 *      without knowing which repo they touched.
 *
 * WRITTEN EVERY TURN
 * ------------------
 * The Stop hook appends. The session file is rewritten in place (same path for
 * the whole session), so you get a live document rather than 40 fragments.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEDGER_DIR = process.env.LEDGER_DIR
  || path.join(os.homedir(), '.copilot', 'hooks', 'ledger', '.ledger');

const INDEX_FILE = path.join(LEDGER_DIR, 'changelog-index.jsonl');

/** Tools that write to the filesystem. */
const WRITE_TOOLS = new Set([
  'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
  'create_directory', 'writeFile', 'edit_file', 'apply_patch',
]);

/** Tools that move or delete. */
const MOVE_TOOLS = new Set(['move_file', 'delete_file', 'rename_file', 'rm', 'mv']);

/** Tools that only read. */
const READ_TOOLS = new Set([
  'read_file', 'readFile', 'list_dir', 'listDirectory', 'file_search',
  'grep_search', 'search', 'view_image', 'get_errors', 'get_vscode_api',
]);

/** Tools that reach the network. */
const NET_TOOLS = new Set(['fetch_webpage', 'fetch', 'web_fetch']);

/**
 * Classify a session from its tool timeline.
 *
 * @param {Array<{tool:string}>} tools
 * @returns {'code'|'filesystem'|'research'|'mixed'|'none'}
 */
function classify(tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (list.length === 0) return 'none';

  let writes = 0;
  let moves = 0;
  let reads = 0;
  let net = 0;

  for (const t of list) {
    const name = String(t?.tool || '');
    if (WRITE_TOOLS.has(name)) writes += 1;
    else if (MOVE_TOOLS.has(name)) moves += 1;
    else if (READ_TOOLS.has(name)) reads += 1;
    else if (NET_TOOLS.has(name)) net += 1;
  }

  const kinds = [];
  if (writes > 0) kinds.push('code');
  if (moves > 0) kinds.push('filesystem');
  if (reads > 0 || net > 0) kinds.push('research');

  if (kinds.length === 0) return 'none'; // only exec tools
  if (kinds.length === 1) return kinds[0];
  return 'mixed';
}

/**
 * Extract the set of files a session touched, split by how it touched them.
 *
 * @param {Array<{tool:string, intent:string}>} tools
 * @returns {{written:string[], read:string[], moved:string[]}}
 */
function filesTouched(tools) {
  const written = new Set();
  const read = new Set();
  const moved = new Set();

  for (const t of tools || []) {
    const name = String(t?.tool || '');
    const target = String(t?.intent || '').trim();
    if (!target) continue;
    // Only treat it as a path if it looks like one. A terminal command is not
    // a file, and listing it under "Files" would be misleading.
    if (!/[/\\]/.test(target) && !/\.[a-z0-9]{1,8}$/i.test(target)) continue;

    if (WRITE_TOOLS.has(name)) written.add(target);
    else if (MOVE_TOOLS.has(name)) moved.add(target);
    else if (READ_TOOLS.has(name)) read.add(target);
  }

  return {
    written: [...written],
    read: [...read],
    moved: [...moved],
  };
}

/** Run a git command, returning '' on any failure. */
function git(cwd, args) {
  try {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

/** Find the git root for a directory, or '' if it is not a repo. */
function gitRoot(dir) {
  if (!dir) return '';
  return git(dir, ['rev-parse', '--show-toplevel']);
}

/**
 * Build the markdown for one session.
 *
 * Deliberately mirrors the format of the manual ChangelogAgent so downstream
 * tooling does not care which produced the file.
 *
 * @param {object} session
 * @param {string} session.sessionId
 * @param {string} session.workspace
 * @param {Array}  session.turns      Journal turn records.
 * @param {Array}  session.tools      Journal tool records.
 * @param {string} [session.gitRoot]
 * @returns {string}
 */
function renderMarkdown(session) {
  const { sessionId, workspace, turns = [], tools = [], gitRoot: root = '' } = session;
  const kind = classify(tools);
  const touched = filesTouched(tools);

  const first = turns[0]?.at || new Date().toISOString();
  const last = turns[turns.length - 1]?.at || first;
  const stamp = new Date(first).toISOString().replace('T', ' ').slice(0, 19);

  const lines = [];
  lines.push(`# Changelog — ${stamp}`);
  lines.push('');
  lines.push(`**Session**: \`${sessionId}\``);
  lines.push(`**Workspace**: \`${workspace || '(unknown)'}\``);
  lines.push(`**Activity**: ${kind}`);
  lines.push(`**Turns**: ${turns.length} · **Tool calls**: ${tools.length}`);
  if (root) lines.push(`**Git root**: \`${root}\``);
  lines.push('');

  // --- narrative -----------------------------------------------------------
  lines.push('## Summary');
  lines.push('');
  const headlines = turns.map((t) => t.headline).filter(Boolean);
  if (headlines.length) {
    for (const h of headlines) lines.push(`- ${h}`);
  } else {
    lines.push('_No turn summaries recorded._');
  }
  lines.push('');

  // --- per-turn detail -----------------------------------------------------
  if (turns.length) {
    lines.push('## Turns');
    lines.push('');
    for (const t of turns) {
      const flag = t.blocked ? ' ⛔' : '';
      lines.push(`### Turn ${t.turn ?? '?'}${flag}`);
      if (t.headline) lines.push(`**${t.headline}**`);
      if (t.summary) lines.push('', t.summary);
      for (const c of t.completed || []) lines.push(`- ✔ ${c}`);
      for (const b of t.blockers || []) lines.push(`- ▲ ${b}`);
      for (const n of t.next || []) lines.push(`- → ${n}`);
      lines.push('');
    }
  }

  // --- files ---------------------------------------------------------------
  const hasFiles = touched.written.length || touched.moved.length || touched.read.length;
  if (hasFiles) {
    lines.push('## Files');
    lines.push('');
    if (touched.written.length) {
      lines.push('**Written**');
      for (const f of touched.written) lines.push(`- \`${f}\``);
      lines.push('');
    }
    if (touched.moved.length) {
      lines.push('**Moved / deleted**');
      for (const f of touched.moved) lines.push(`- \`${f}\``);
      lines.push('');
    }
    if (touched.read.length) {
      lines.push('**Read**');
      for (const f of touched.read.slice(0, 40)) lines.push(`- \`${f}\``);
      if (touched.read.length > 40) lines.push(`- _…and ${touched.read.length - 40} more_`);
      lines.push('');
    }
  }

  // --- git diff, only when there is a repo ---------------------------------
  if (root) {
    const stat = git(root, ['diff', '--stat']);
    const staged = git(root, ['diff', '--cached', '--stat']);
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = git(root, ['rev-parse', '--short', 'HEAD']);

    lines.push('## Git');
    lines.push('');
    if (branch) lines.push(`**Branch**: \`${branch}\`${head ? ` @ \`${head}\`` : ''}`);
    lines.push('');

    if (staged) {
      lines.push('**Staged**');
      lines.push('```');
      lines.push(staged);
      lines.push('```');
      lines.push('');
    }
    if (stat) {
      lines.push('**Unstaged**');
      lines.push('```');
      lines.push(stat);
      lines.push('```');
      lines.push('');
    }
    if (!staged && !stat) {
      lines.push('_No uncommitted changes._');
      lines.push('');
    }
  } else if (kind !== 'none') {
    lines.push('## Git');
    lines.push('');
    lines.push('_Not a git repository — this session is recorded by activity only._');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`_Generated by taskguard from the session journal. Last updated ${new Date(last).toISOString()}._`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Write the session changelog to the workspace and append to the index.
 *
 * Never throws: a changelog failure must not break the Stop hook.
 *
 * @param {object} session  See renderMarkdown.
 * @returns {{written:boolean, path?:string, kind:string, error?:string}}
 */
function write(session) {
  const kind = classify(session.tools);
  const workspace = session.workspace || '';

  // Nothing happened and there is no workspace: do not litter.
  if (kind === 'none' && !workspace) {
    return { written: false, kind };
  }

  // A session with no tool activity and no turns is not worth recording. This
  // is what test fixtures look like, and without this guard the test suite
  // writes its synthetic sessions into the real index.
  const hasTurns = Array.isArray(session.turns) && session.turns.length > 0;
  const hasTools = Array.isArray(session.tools) && session.tools.length > 0;
  if (!hasTurns && !hasTools) {
    return { written: false, kind };
  }

  let filePath = '';
  try {
    if (workspace && fs.existsSync(workspace)) {
      const dir = path.join(workspace, 'changelog');
      fs.mkdirSync(dir, { recursive: true });

      // One file per session, rewritten each turn so it stays current.
      const stamp = new Date(session.turns?.[0]?.at || Date.now())
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const safe = String(session.sessionId || 'session')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 40);
      filePath = path.join(dir, `${stamp}-${safe}.md`);

      fs.writeFileSync(filePath, renderMarkdown(session), { mode: 0o644 });
    }
  } catch (err) {
    return { written: false, kind, error: err.message };
  }

  // Append to the central index. This is the downstream feed.
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const record = {
      at: new Date().toISOString(),
      sessionId: session.sessionId,
      workspace,
      gitRoot: session.gitRoot || '',
      kind,
      turns: session.turns?.length || 0,
      tools: session.tools?.length || 0,
      headlines: (session.turns || []).map((t) => t.headline).filter(Boolean),
      files: filesTouched(session.tools),
      changelogPath: filePath,
    };
    fs.appendFileSync(INDEX_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Index failure is not fatal; the workspace file still exists.
  }

  return { written: Boolean(filePath), path: filePath, kind };
}

/**
 * Read the central index, newest last.
 *
 * Returns an array for backwards compatibility, but the array carries two
 * non-enumerable properties describing what happened:
 *
 *   .total      how many records exist in the file
 *   .truncated  whether `limit` cut the result short
 *
 * The caller needs to know when it is seeing a partial view. Silently
 * returning the newest N of a larger set is the same class of bug as the
 * silent failures this project exists to prevent — the user sees a complete
 * looking list that is missing history.
 *
 * @param {number} limit  Max records to return. Use Infinity for all.
 * @returns {Array<object> & {total:number, truncated:boolean}}
 */
function readIndex(limit = 500) {
  let raw;
  try {
    raw = fs.readFileSync(INDEX_FILE, 'utf8');
  } catch {
    const empty = [];
    Object.defineProperties(empty, {
      total: { value: 0, enumerable: false },
      truncated: { value: false, enumerable: false },
    });
    return empty;
  }

  const all = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      // Skip a truncated line.
    }
  }

  const truncated = Number.isFinite(limit) && all.length > limit;
  const out = truncated ? all.slice(all.length - limit) : all;

  Object.defineProperties(out, {
    total: { value: all.length, enumerable: false },
    truncated: { value: truncated, enumerable: false },
  });
  return out;
}

/**
 * Drop index records, keeping the newest `keep` (or everything newer than
 * `olderThanMs`).
 *
 * Rewrites the file atomically: a crash mid-write must not leave a half
 * written index, because that is the only cross-workspace record of what
 * happened.
 *
 * @param {object} opts
 * @param {number} [opts.keep]         Keep only the newest N records.
 * @param {number} [opts.olderThanMs]  Drop records older than this age.
 * @param {boolean} [opts.dryRun]      Report what would go, change nothing.
 * @returns {{before:number, after:number, removed:number, dryRun:boolean}}
 */
function pruneIndex(opts = {}) {
  const all = readIndex(Infinity);
  const before = all.length;

  let kept = all;
  if (Number.isFinite(opts.keep) && opts.keep >= 0) {
    kept = all.slice(Math.max(0, all.length - opts.keep));
  }
  if (Number.isFinite(opts.olderThanMs)) {
    const cutoff = Date.now() - opts.olderThanMs;
    kept = kept.filter((r) => {
      const t = Date.parse(r.at);
      // Keep anything with an unparseable timestamp rather than silently
      // discarding a record we do not understand.
      return !Number.isFinite(t) || t >= cutoff;
    });
  }

  const removed = before - kept.length;

  if (!opts.dryRun && removed > 0) {
    const tmp = `${INDEX_FILE}.tmp`;
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.writeFileSync(tmp, kept.length ? `${kept.map((r) => JSON.stringify(r)).join('\n')}\n` : '', { mode: 0o600 });
    fs.renameSync(tmp, INDEX_FILE);
  }

  return { before, after: kept.length, removed, dryRun: Boolean(opts.dryRun) };
}

module.exports = {
  INDEX_FILE,
  classify,
  filesTouched,
  renderMarkdown,
  write,
  readIndex,
  pruneIndex,
  gitRoot,
  WRITE_TOOLS,
  MOVE_TOOLS,
  READ_TOOLS,
};
