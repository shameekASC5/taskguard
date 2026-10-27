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
 * How to say "do not think about this" to each provider.
 *
 * There is no standard field. OpenRouter and DeepSeek accept a `reasoning`
 * object; OpenAI and Groq accept `reasoning_effort`; Together and Fireworks
 * take the OpenRouter-style object; Ollama has no switch at all.
 *
 * Sending the wrong shape is not harmless — a strict gateway can reject the
 * whole request with a 400, which would break the hook entirely. So unknown
 * providers get nothing, and the prompt does the work instead.
 *
 * @param {string} providerName
 * @returns {object|null} fields to merge into the request body
 */
function reasoningOff(providerName) {
  switch (providerName) {
    case 'openrouter':
    case 'deepseek':
    case 'together':
    case 'fireworks':
      return { reasoning: { enabled: false } };
    case 'openai':
    case 'groq':
      return { reasoning_effort: 'none' };
    case 'ollama':
      // No reasoning switch. Local models that think will think.
      return null;
    default:
      // Unknown gateway: send nothing rather than risk a 400.
      return null;
  }
}

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

// ---------------------------------------------------------------------------
// Reviewer model — a SEPARATE, deliberately different model
// ---------------------------------------------------------------------------

/**
 * Resolve the reviewer's provider.
 *
 * The adversarial reviewer must come from a DIFFERENT MODEL FAMILY than the
 * agent it is reviewing. A reviewer from the same family shares the same blind
 * spots and the same failure modes, so it will agree with itself — which
 * defeats the entire point of an independent check.
 *
 * Falls back to the main provider when unset, but warns, because that silently
 * removes the property you are paying for.
 */
function getReviewerProviderName() {
  const name = (cfg('LEDGER_REVIEW_PROVIDER') || '').toLowerCase();
  if (name && PROVIDERS[name]) return name;
  return getProviderName();
}

function getReviewerProvider() {
  return PROVIDERS[getReviewerProviderName()];
}

/**
 * Resolve the reviewer's model id.
 *
 * No default. The cross-family choice is a deliberate decision, so we require
 * it to be made explicitly rather than shipping a default that might happen to
 * match the main model.
 */
function getReviewerModel() {
  const configured = cfg('LEDGER_REVIEW_MODEL');
  if (configured) return configured;
  return '';
}

/**
 * The model family, for the same-family check.
 *
 * OpenRouter ids are namespaced ("vendor/model"), so the vendor is the family.
 * Bare ids fall back to the leading token before a dash or dot.
 */
function familyOf(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return '';
  if (id.includes('/')) return id.split('/')[0];
  return id.split(/[-.]/)[0];
}

/**
 * Whether the reviewer is configured and genuinely independent.
 *
 * @returns {{ok:boolean, reason?:string, model:string, provider:string}}
 */
function reviewerStatus() {
  const model = getReviewerModel();
  const provider = getReviewerProviderName();

  if (!model) {
    return { ok: false, reason: 'LEDGER_REVIEW_MODEL is not set', model: '', provider };
  }

  const mainFamily = familyOf(getModel());
  const reviewFamily = familyOf(model);
  if (mainFamily && reviewFamily && mainFamily === reviewFamily) {
    return {
      ok: false,
      reason: `reviewer "${model}" is the same model family as the main model `
        + `("${mainFamily}"). An independent reviewer must come from a different `
        + `family, or it shares the same blind spots.`,
      model,
      provider,
    };
  }

  return { ok: true, model, provider };
}

/**
 * Reasoning effort for the reviewer.
 *
 * The main hooks run with reasoning OFF: they are classifiers, and thinking
 * only burns the output budget. The reviewer is the opposite — it has to
 * reason about whether a claim is actually true, which is exactly the kind of
 * task reasoning helps with.
 *
 * Default "medium": enough to catch a fabricated test result or a claim that
 * does not match the diff, without paying for deep deliberation on every
 * review. Raise to "high" if you want it to work harder.
 *
 * NOTE: reasoning tokens count against max_tokens. A reviewer with a small
 * max_tokens will spend the whole budget thinking and return empty content —
 * the exact failure that broke the audit. So the reviewer gets a much larger
 * budget than the classifiers.
 */
function reviewerReasoning() {
  const effort = (cfg('LEDGER_REVIEW_EFFORT') || 'medium').toLowerCase();
  const allowed = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
  const chosen = allowed.includes(effort) ? effort : 'medium';

  if (chosen === 'none') return null;

  const provider = getReviewerProviderName();
  // Providers that take the OpenRouter-style object.
  if (['openrouter', 'deepseek', 'together', 'fireworks'].includes(provider)) {
    return { reasoning: { effort: chosen } };
  }
  // Providers that take the OpenAI-style scalar.
  if (['openai', 'groq'].includes(provider)) {
    return { reasoning_effort: chosen };
  }
  // Ollama and unknown gateways: no known switch.
  return null;
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
    max_tokens: Number(process.env.LEDGER_MAX_OUTPUT_TOKENS) || 2048,
  };

  // Reasoning OFF by default, for every provider.
  //
  // These are classification tasks: "is this item done, yes or no". They do
  // not benefit from chain-of-thought, and on a reasoning model the thinking
  // consumes the entire output budget before any content is emitted.
  //
  // Measured on deepseek-v4.1-flash with a 29-item audit prompt:
  //   reasoning on  -> finish_reason "length", content null, 2048 reasoning
  //                    tokens, 0 useful output, call fails to parse
  //   reasoning off -> finish_reason "stop", 248 tokens, correct verdicts
  //
  // So this is both cheaper AND the only way the feature works at all.
  //
  // The switch is spelled differently per provider, and a provider that does
  // not recognise a field may reject the whole request. So we send the shape
  // that provider understands, and nothing at all where there is no known
  // switch. Set LEDGER_REASONING=1 to opt back in.
  if (process.env.LEDGER_REASONING !== '1') {
    const off = reasoningOff(getProviderName());
    if (off) Object.assign(body, off);
  }
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

/**
 * Call the REVIEWER model.
 *
 * Deliberately separate from callJson because almost every parameter differs:
 *
 *   model      a different family, so the review is genuinely independent
 *   reasoning  ON at medium effort, because judging a claim is a reasoning
 *              task — the opposite of the classifiers, which run with it off
 *   max_tokens much larger, because reasoning tokens count against the budget
 *              and a small cap means the model thinks and returns nothing
 *   key        may be a different provider's key
 *
 * Returns null on any failure, like callJson. A reviewer that cannot run must
 * never break the turn.
 *
 * @param {string} system
 * @param {string} user
 * @param {number} timeoutMs
 * @returns {Promise<any|null>}
 */
async function callReviewer(system, user, timeoutMs = 120000) {
  const status = reviewerStatus();
  if (!status.ok) {
    process.stderr.write(`ledger: reviewer unavailable — ${status.reason}\n`);
    return null;
  }

  const providerName = status.provider;
  const provider = PROVIDERS[providerName];

  // The reviewer may live on a different provider, so resolve its key
  // separately. LEDGER_REVIEW_API_KEY wins; otherwise fall back to the shared
  // key, which is correct when both models are on OpenRouter.
  const apiKey = cfg('LEDGER_REVIEW_API_KEY') || getKey();
  if (!apiKey && provider.keyEnv !== 'OLLAMA_API_KEY') {
    process.stderr.write(
      `ledger: no API key for reviewer provider "${providerName}". `
      + `Set LEDGER_REVIEW_API_KEY (or LEDGER_API_KEY) in ~/.copilot/hooks/ledger/.env\n`,
    );
    return null;
  }

  const url = cfg('LEDGER_REVIEW_BASE_URL') || provider.url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model: status.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Not 0. A reviewer at temperature 0 tends to produce the same verdict
    // every time; a little variation makes it more likely to notice something
    // the first pass missed. Still low enough to stay factual.
    temperature: 0.2,
    // Reasoning tokens count against this budget, so it must be generous.
    // 8192 leaves room for medium-effort thinking plus the findings JSON.
    max_tokens: Number(cfg('LEDGER_REVIEW_MAX_OUTPUT_TOKENS')) || 8192,
  };

  const reasoning = reviewerReasoning();
  if (reasoning) Object.assign(body, reasoning);
  if (provider.jsonMode) body.response_format = { type: 'json_object' };

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      process.stderr.write(
        `ledger: reviewer ${providerName} ${res.status} ${res.statusText} `
        + `(model "${status.model}")\n`,
      );
      return null;
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content;

    // A reasoning model that spent its whole budget thinking returns empty
    // content with finish_reason "length". Say so explicitly rather than
    // returning a bare null, because the cause is not obvious.
    if (!text) {
      const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
      if (choice?.finish_reason === 'length') {
        process.stderr.write(
          `ledger: reviewer hit the output cap while reasoning `
          + `(${reasoningTokens ?? '?'} reasoning tokens). `
          + `Raise LEDGER_REVIEW_MAX_OUTPUT_TOKENS or lower LEDGER_REVIEW_EFFORT.\n`,
        );
      }
      return null;
    }

    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    process.stderr.write(`ledger: reviewer call failed (${providerName}): ${err.message}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  callJson,
  callReviewer,
  getModel,
  getProviderName,
  getProvider,
  getReviewerModel,
  getReviewerProviderName,
  reviewerStatus,
  reviewerReasoning,
  familyOf,
  reasoningOff,
  PROVIDERS,
};
