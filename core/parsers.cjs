'use strict';

/**
 * Transcript parsers — one per agent harness.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The journal needs three things from a harness: the user turns, the agent's
 * prose, and the tool calls with timestamps. Every harness has this data, but
 * every harness stores it differently.
 *
 * So the journal does not parse anything itself. It asks a parser for a
 * normalised turn list. Adding support for a new agent means writing one
 * object with one function — not touching core.
 *
 * THE NORMALISED SHAPE
 * --------------------
 * Every parser returns:
 *
 *   [{
 *     index: number,          // 1-based, in order
 *     startedAt: string,      // ISO 8601
 *     endedAt: string,        // ISO 8601
 *     userText: string,       // what the human asked
 *     assistantText: string,  // what the agent said
 *     tools: [{
 *       tool: string,         // tool name
 *       intent: string,       // short human-readable summary of the call
 *       at: string,           // ISO 8601
 *       ok: boolean,          // did it succeed
 *     }],
 *   }]
 *
 * A parser may return [] rather than throwing. A harness that cannot supply
 * evidence should degrade to "no timeline", not break the hook.
 */

const fs = require('node:fs');

/**
 * Derive a short, human-readable intent from a tool call's arguments.
 *
 * Shared by every parser because the *shape* of tool arguments is broadly
 * similar across harnesses (a command, a path, a query), even when the
 * envelope differs.
 */
function intentFrom(toolName, args) {
  if (!args || typeof args !== 'object') return '';

  const pick = (v, n = 90) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

  switch (toolName) {
    case 'run_in_terminal':
    case 'runCommand':
    case 'bash':
    case 'shell':
      return pick(args.command || args.cmd);
    case 'read_file':
    case 'readFile':
    case 'create_file':
    case 'writeFile':
    case 'replace_string_in_file':
    case 'edit_file':
    case 'multi_replace_string_in_file':
      return pick(args.filePath || args.path || args.file_path || args.filePaths);
    case 'grep_search':
    case 'file_search':
    case 'search':
    case 'get_vscode_api':
      return pick(args.query || args.pattern);
    case 'list_dir':
    case 'listDirectory':
    case 'create_directory':
      return pick(args.path || args.dirPath);
    case 'fetch_webpage':
    case 'fetch':
    case 'web_fetch':
      return pick(Array.isArray(args.urls) ? args.urls[0] : (args.urls || args.url));
    case 'view_image':
      return pick(args.filePath || args.path);
    case 'manage_todo_list':
    case 'todo_write':
      return Array.isArray(args.todoList || args.todos)
        ? `${(args.todoList || args.todos).length} item(s)`
        : '';
    case 'memory':
      return [pick(args.command, 20), pick(args.path, 60)].filter(Boolean).join(' ');
    default: {
      // Unknown tool: take the first string-valued field, which is usually
      // the most descriptive one.
      for (const value of Object.values(args)) {
        const s = pick(value);
        if (s) return s;
      }
      return '';
    }
  }
}

/** Read a JSONL file into entries, skipping malformed lines. */
function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Truncated or corrupt line; skip it.
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// VS Code Copilot Chat
// ---------------------------------------------------------------------------

/**
 * VS Code Copilot Chat transcript.
 *
 * Format verified 2026-10-27 against a live 48-turn transcript:
 *   { type: "session.start" }
 *   { type: "user.message",             data: { content } }
 *   { type: "assistant.turn_start" }
 *   { type: "assistant.message",        data: { content } }
 *   { type: "tool.execution_start",     data: { toolCallId, toolName, arguments } }
 *   { type: "tool.execution_complete",  data: { toolCallId, success } }
 *
 * A USER TURN is one user.message through to the next. An AGENT TURN is one
 * assistant.turn_start..turn_end pair; there are many per user turn.
 */
const vscode = {
  name: 'vscode',
  description: 'VS Code Copilot Chat transcript (JSONL)',

  parse(file) {
    const entries = readJsonl(file);
    const turns = [];
    let current = null;

    const flush = () => {
      if (current) turns.push(current);
      current = null;
    };

    for (const entry of entries) {
      const type = entry?.type;
      const at = entry?.timestamp || '';

      if (type === 'user.message') {
        flush();
        current = {
          index: turns.length + 1,
          startedAt: at,
          endedAt: at,
          userText: String(entry?.data?.content || ''),
          assistantText: '',
          tools: [],
        };
        continue;
      }

      if (!current) continue;

      if (type === 'assistant.message') {
        const content = entry?.data?.content;
        if (typeof content === 'string' && content.trim()) {
          current.assistantText += (current.assistantText ? '\n\n' : '') + content;
        }
        current.endedAt = at || current.endedAt;
        continue;
      }

      if (type === 'tool.execution_start') {
        const tool = String(entry?.data?.toolName || 'unknown');
        current.tools.push({
          tool,
          intent: intentFrom(tool, entry?.data?.arguments),
          at,
          ok: true,
          callId: entry?.data?.toolCallId || '',
        });
        current.endedAt = at || current.endedAt;
        continue;
      }

      if (type === 'tool.execution_complete') {
        const id = entry?.data?.toolCallId;
        const ok = entry?.data?.success !== false;
        const match = current.tools.find((t) => t.callId === id)
          || [...current.tools].reverse().find((t) => t.ok && !t.resolved);
        if (match) {
          match.ok = ok;
          match.resolved = true;
        }
        current.endedAt = at || current.endedAt;
      }
    }

    flush();
    return turns;
  },
};

// ---------------------------------------------------------------------------
// Generic OpenAI-style message log
// ---------------------------------------------------------------------------

/**
 * A plain JSON array of chat messages, the shape most agent frameworks log:
 *
 *   [{ role: "user"|"assistant"|"tool", content, tool_calls?, name?, timestamp? }]
 *
 * This covers anything that records a message list — LangChain, LlamaIndex,
 * the OpenAI SDK, most homegrown loops. Tool calls are read from either
 * `tool_calls` (OpenAI) or `toolCalls` (common variants).
 */
const openaiMessages = {
  name: 'openai-messages',
  description: 'JSON array of {role, content, tool_calls} messages',

  parse(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }

    let messages;
    try {
      messages = JSON.parse(raw);
    } catch {
      // Maybe it is JSONL of messages.
      messages = readJsonl(file);
    }
    if (!Array.isArray(messages)) return [];

    const turns = [];
    let current = null;

    const flush = () => {
      if (current) turns.push(current);
      current = null;
    };

    for (const msg of messages) {
      const role = msg?.role;
      const at = msg?.timestamp || msg?.created_at || '';

      if (role === 'user') {
        flush();
        current = {
          index: turns.length + 1,
          startedAt: at,
          endedAt: at,
          userText: String(msg?.content || ''),
          assistantText: '',
          tools: [],
        };
        continue;
      }

      if (!current) continue;

      if (role === 'assistant') {
        if (typeof msg?.content === 'string' && msg.content.trim()) {
          current.assistantText += (current.assistantText ? '\n\n' : '') + msg.content;
        }
        const calls = msg?.tool_calls || msg?.toolCalls || [];
        for (const call of calls) {
          const fn = call?.function || call || {};
          const tool = String(fn.name || call?.name || 'unknown');
          let args = fn.arguments ?? call?.arguments ?? call?.input ?? {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          current.tools.push({
            tool,
            intent: intentFrom(tool, args),
            at: at || current.startedAt,
            ok: true,
          });
        }
        current.endedAt = at || current.endedAt;
        continue;
      }

      if (role === 'tool') {
        // A tool result. Mark the most recent unmatched call as failed if the
        // content looks like an error.
        const last = [...current.tools].reverse().find((t) => !t.resolved);
        if (last) {
          last.resolved = true;
          const text = String(msg?.content || '');
          if (/^\s*(error|exception|failed)/i.test(text)) last.ok = false;
        }
        current.endedAt = at || current.endedAt;
      }
    }

    flush();
    return turns;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PARSERS = {
  [vscode.name]: vscode,
  [openaiMessages.name]: openaiMessages,
};

/**
 * Resolve a parser by name, or guess from the file's contents.
 *
 * Guessing matters because a user porting this should not have to know our
 * internal names. We sniff the first few lines and pick the shape that fits.
 *
 * @param {string} [name]  Explicit parser name, or undefined to auto-detect.
 * @param {string} file    Path to the transcript.
 * @returns {{name: string, parse: Function}}
 */
function resolve(name, file) {
  if (name && PARSERS[name]) return PARSERS[name];

  // Sniff: VS Code transcripts are JSONL with a `type` field; OpenAI-style
  // logs are a JSON array or JSONL with a `role` field.
  let head = '';
  try {
    head = fs.readFileSync(file, 'utf8').slice(0, 4000);
  } catch {
    return vscode;
  }

  if (/"type"\s*:\s*"(user\.message|assistant\.message|tool\.execution_start)"/.test(head)) {
    return vscode;
  }
  if (/"role"\s*:\s*"(user|assistant|tool)"/.test(head)) {
    return openaiMessages;
  }

  // Default to VS Code: it is the harness this ships with.
  return vscode;
}

module.exports = {
  PARSERS,
  resolve,
  intentFrom,
  readJsonl,
  vscode,
  openaiMessages,
};
