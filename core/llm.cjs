'use strict';

/**
 * Minimal, dependency-free LLM client for the ledger hooks.
 *
 * Deliberately uses global fetch (Node 18+) so the hook does not depend on the
 * project's node_modules being installed. Hooks must be fast and must not fail
 * because of a missing package.
 *
 * PROVIDER FLEXIBILITY
 * --------------------
 * OpenRouter is the default because it is one key for every model, but it is
 * not required. Any endpoint that speaks the OpenAI chat-completions shape
 * works: OpenAI, Groq, Together, Fireworks, DeepSeek direct, a local Ollama or
 * llama.cpp server, or an internal gateway.
 *
 *   LEDGER_BASE_URL   full chat-completions URL (overrides everything)
 *   LEDGER_PROVIDER   named preset: openrouter | openai | groq | deepseek |
 *                     together | fireworks | ollama | custom
 *   LEDGER_MODEL      model id, in that provider's own naming
 *   LEDGER_API_KEY    key for the chosen provider (falls back to
 *                     OPENROUTER_API_KEY for backwards compatibility)
 *
 * If a provider needs no key (local Ollama), set LEDGER_API_KEY=none.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Provider presets. `url` is the chat-completions endpoint; `keyEnv` is the
 * conventional environment variable for that provider, used only to give a
 * helpful error message when no key is configured.
 */
const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'deepseek/deepseek-v4.1-flash',
    jsonMode: true,
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    jsonMode: true,
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    jsonMode: true,
  },
  deepseek: {
    url: 'https://api.deepseek.com/v1/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    jsonMode: true,
  },
  together: {
    url: 'https://api.together.xyz/v1/chat/completions',
    keyEnv: 'TOGETHER_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    jsonMode: true,
  },
  fireworks: {
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    keyEnv: 'FIREWORKS_API_KEY',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    jsonMode: true,
  },
  ollama: {
    url: 'http://localhost:11434/v1/chat/completions',
    keyEnv: 'OLLAMA_API_KEY',
    defaultModel: 'llama3.2',
    jsonMode: false, // Ollama ignores response_format on some models
  },
  custom: {
    url: '',
    keyEnv: 'LEDGER_API_KEY',
    defaultModel: '',
    jsonMode: true,
  },
};

const DEFAULT_PROVIDER = 'openrouter';

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
  const explicit = readEnvFile().LEDGER_BASE_URL || process.env.LEDGER_BASE_URL;
  if (explicit) return explicit;
  return PROVIDERS[getProviderName()].url;
}

let cachedEnv = null;

/**
 * Read a key from process.env, falling back to a user-level env file.
 *
 * System-wide install: there is no repo .env to read, so we look at
 * ~/.copilot/hooks/ledger/.env (chmod 600).
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

/** Resolve a config value: .env file first, then process.env. */
function cfg(name) {
  return readEnvFile()[name] || process.env[name] || '';
}

function getProviderName() {
  const name = (cfg('LEDGER_PROVIDER') || DEFAULT_PROVIDER).toLowerCase();
  return PROVIDERS[name] ? name : DEFAULT_PROVIDER;
}

function getProvider() {
  return PROVIDERS[getProviderName()];
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
 *
 * LEDGER_API_KEY is provider-agnostic and wins over the provider-specific
 * variable, so switching providers does not require renaming anything.
 */
function getKey() {
  const generic = cfg('LEDGER_API_KEY');
  if (generic) return generic === 'none' ? '' : generic;

  const provider = getProvider();
  const fromFile = readEnvFile()[provider.keyEnv] || '';
  const fromEnv = process.env[provider.keyEnv] || '';
  // Backwards compatibility: an OPENROUTER_API_KEY works for any provider.
  const legacyFile = readEnvFile().OPENROUTER_API_KEY || '';
  const legacyEnv = process.env.OPENROUTER_API_KEY || '';

  if (process.env.LEDGER_PREFER_ENV_KEY === '1') {
    return fromEnv || fromFile || legacyEnv || legacyFile;
  }
  return fromFile || fromEnv || legacyFile || legacyEnv;
}

/**
 * Resolve the model id.
 *
 * LEDGER_MODEL always wins — that is the explicit override. But a model id is
 * provider-specific ("deepseek/deepseek-v4.1-flash" means nothing to OpenAI),
 * so if the configured model looks like it belongs to a different provider we
 * fall back to that provider's default rather than sending a request that is
 * guaranteed to 404.
 */
function getModel() {
  const configured = cfg('LEDGER_MODEL');
  const provider = getProvider();
  if (!configured) return provider.defaultModel;

  // OpenRouter ids are namespaced ("vendor/model"). Other providers use bare
  // ids. If the user switched provider but left an OpenRouter-style id, the
  // request would fail, so prefer the provider default.
  const looksNamespaced = configured.includes('/');
  const providerWantsNamespaced = provider.defaultModel.includes('/');
  if (looksNamespaced !== providerWantsNamespaced && getProviderName() !== 'custom') {
    process.stderr.write(
      `ledger: LEDGER_MODEL "${configured}" does not look like a `
      + `"${getProviderName()}" model id; using "${provider.defaultModel}". `
      + `Set LEDGER_MODEL to override.\n`,
    );
    return provider.defaultModel;
  }
  return configured;
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
  const provider = getProvider();
  const apiKey = getKey();
  if (!apiKey && provider.keyEnv !== 'OLLAMA_API_KEY') {
    process.stderr.write(
      `ledger: no API key for provider "${getProviderName()}". `
      + `Set LEDGER_API_KEY (or ${provider.keyEnv}) in ~/.copilot/hooks/ledger/.env\n`,
    );
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model: getModel(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    // Hard cap: these are tiny classification tasks. Without a cap the
    // model can ramble and bill for output tokens we never use.
    //
    // 512 was too low. Reasoning models spend the budget on hidden thinking
    // before emitting any content: measured on deepseek-v4.1-flash, a
    // 29-item prompt consumed all 512 tokens as reasoning_tokens and returned
    // content: null with finish_reason "length". The call then failed to
    // parse and the feature silently did nothing. 2048 leaves room for the
    // thinking plus the JSON.
    max_tokens: Number(process.env.LEDGER_MAX_OUTPUT_TOKENS) || 2048,
  };
  // Not every provider supports response_format; Ollama in particular can
  // reject it. The prompt already asks for JSON, and we strip fences below.
  if (provider.jsonMode) body.response_format = { type: 'json_object' };

  try {
    const res = await fetch(getUrl(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const hint = res.status === 401
        ? ` (check the key for provider "${getProviderName()}" in ~/.copilot/hooks/ledger/.env)`
        : res.status === 404
          ? ` (check LEDGER_BASE_URL / LEDGER_MODEL for provider "${getProviderName()}")`
          : '';
      process.stderr.write(`ledger: ${getProviderName()} ${res.status} ${res.statusText}${hint}\n`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    // Tolerate fenced JSON.
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    process.stderr.write(`ledger: LLM call failed (${getProviderName()}): ${err.message}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  callJson,
  getModel,
  getProviderName,
  getProvider,
  PROVIDERS,
};
