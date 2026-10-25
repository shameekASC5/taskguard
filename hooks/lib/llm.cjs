'use strict';

/**
 * Minimal OpenRouter client for the ledger hooks.
 *
 * Deliberately dependency-free (uses global fetch, Node 18+) so the hook does
 * not depend on the project's node_modules being installed. Hooks must be fast
 * and must not fail because of a missing package.
 *
 * Model + key come from env, falling back to the project's .env values.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Allow tests to point the client at a stub server.
 *
 * Guarded by LEDGER_ALLOW_TEST_URL so a stray LEDGER_TEST_URL in the
 * environment can never silently redirect production hooks to a stub.
 */
function getUrl() {
  if (process.env.LEDGER_ALLOW_TEST_URL === '1' && process.env.LEDGER_TEST_URL) {
    return process.env.LEDGER_TEST_URL;
  }
  return DEFAULT_URL;
}

let cachedEnv = null;

/**
 * Read a key from process.env, falling back to a user-level env file.
 *
 * System-wide install: there is no repo .env to read, so we look at
 * ~/.copilot/hooks/ledger/.env (chmod 600). Env vars always win.
 */
function readEnvFile() {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {};
  const candidates = [
    process.env.LEDGER_ENV_FILE,
    path.join(os.homedir(), '.copilot', 'hooks', 'ledger', '.env'),
  ].filter(Boolean);
  for (const envPath of candidates) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) cachedEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      break;
    } catch {
      // Try the next candidate.
    }
    // .env is optional; env vars may be set directly.
  }
  return cachedEnv;
}

/**
 * Resolve the API key.
 *
 * Precedence: the dedicated .env file WINS over process.env.
 *
 * Rationale: this is a system-wide install with its own authoritative key
 * file. A stray OPENROUTER_API_KEY in the shell environment (e.g. a leftover
 * `export OPENROUTER_API_KEY=test` from a test run) must not silently shadow
 * it and cause 401s. Set LEDGER_PREFER_ENV_KEY=1 to invert this.
 */
function getKey() {
  const fromFile = readEnvFile().OPENROUTER_API_KEY || '';
  const fromEnv = process.env.OPENROUTER_API_KEY || '';
  if (process.env.LEDGER_PREFER_ENV_KEY === '1') return fromEnv || fromFile;
  return fromFile || fromEnv;
}

function getModel() {
  return readEnvFile().LEDGER_MODEL || process.env.LEDGER_MODEL || DEFAULT_MODEL;
}

/**
 * Call the model and parse a JSON response.
 * Returns null on any failure — hooks must degrade gracefully, never throw.
 * @param {string} system
 * @param {string} user
 * @param {number} timeoutMs
 * @returns {Promise<any|null>}
 */
async function callJson(system, user, timeoutMs = 30000) {
  const apiKey = getKey();
  if (!apiKey) {
    process.stderr.write('ledger: no OPENROUTER_API_KEY; skipping LLM call\n');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(getUrl(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getModel(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        // Hard cap: these are tiny classification tasks. Without a cap the
        // model can ramble and bill for output tokens we never use.
        max_tokens: 512,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const hint = res.status === 401
        ? ' (check the key in ~/.copilot/hooks/ledger/.env)'
        : '';
      process.stderr.write(`ledger: OpenRouter ${res.status} ${res.statusText}${hint}\n`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    // Tolerate fenced JSON.
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    process.stderr.write(`ledger: LLM call failed: ${err.message}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callJson, getModel };
