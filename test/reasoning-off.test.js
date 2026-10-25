'use strict';

/**
 * Tests for the reasoning-off switch in core/llm.cjs.
 *
 * The point of these tests is that a user can bring their own reasoning model
 * and still get working behaviour. There is no standard field for "do not
 * think", so each provider gets the shape it understands — and providers we
 * do not know get nothing, because a strict gateway would 400 on an unknown
 * field and break the hook entirely.
 */

const { reasoningOff, PROVIDERS } = require('../core/llm.cjs');

describe('reasoningOff — provider shapes', () => {
  test('OpenRouter-style providers get a reasoning object', () => {
    for (const p of ['openrouter', 'deepseek', 'together', 'fireworks']) {
      expect(reasoningOff(p)).toEqual({ reasoning: { enabled: false } });
    }
  });

  test('OpenAI-style providers get reasoning_effort none', () => {
    for (const p of ['openai', 'groq']) {
      expect(reasoningOff(p)).toEqual({ reasoning_effort: 'none' });
    }
  });

  test('Ollama gets nothing — it has no switch', () => {
    expect(reasoningOff('ollama')).toBeNull();
  });

  test('an unknown provider gets nothing rather than risking a 400', () => {
    expect(reasoningOff('custom')).toBeNull();
    expect(reasoningOff('some-internal-gateway')).toBeNull();
    expect(reasoningOff('')).toBeNull();
    expect(reasoningOff(undefined)).toBeNull();
  });

  test('every known provider is handled explicitly', () => {
    // Guards against adding a provider to PROVIDERS and forgetting this map.
    for (const name of Object.keys(PROVIDERS)) {
      const result = reasoningOff(name);
      const handled = result !== null || name === 'ollama' || name === 'custom';
      expect(handled).toBe(true);
    }
  });

  test('never returns a field that would collide with the request body', () => {
    for (const name of Object.keys(PROVIDERS)) {
      const result = reasoningOff(name);
      if (!result) continue;
      for (const key of Object.keys(result)) {
        expect(['model', 'messages', 'temperature', 'max_tokens', 'response_format'])
          .not.toContain(key);
      }
    }
  });
});
