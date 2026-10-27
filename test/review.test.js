'use strict';

/**
 * Tests for core/review.cjs and the reviewer configuration in core/llm.cjs.
 *
 * The load-bearing property is INDEPENDENCE: the reviewer must come from a
 * different model family than the agent, or it shares the same blind spots and
 * the review is theatre. Most of these tests pin that.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let review;
let llm;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-review-'));
  process.env.LEDGER_DIR = path.join(tmpDir, 'ledger');
  // Point the env file at a nonexistent path so the developer's real .env
  // cannot leak into these tests.
  process.env.LEDGER_ENV_FILE = path.join(tmpDir, 'nonexistent.env');
  jest.resetModules();
  review = require('../core/review.cjs');
  llm = require('../core/llm.cjs');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LEDGER_DIR;
  delete process.env.LEDGER_ENV_FILE;
  delete process.env.LEDGER_REVIEW_MODEL;
  delete process.env.LEDGER_REVIEW_PROVIDER;
  delete process.env.LEDGER_REVIEW_EFFORT;
  delete process.env.LEDGER_MODEL;
});

describe('review — model family detection', () => {
  test('extracts the vendor from a namespaced id', () => {
    expect(llm.familyOf('deepseek/deepseek-v4.1-flash')).toBe('deepseek');
    expect(llm.familyOf('qwen/qwen3.8-flash')).toBe('qwen');
    expect(llm.familyOf('anthropic/claude-sonnet-4')).toBe('anthropic');
  });

  test('falls back to the leading token for bare ids', () => {
    expect(llm.familyOf('gpt-4o-mini')).toBe('gpt');
    expect(llm.familyOf('llama-3.3-70b-versatile')).toBe('llama');
  });

  test('returns empty for an empty id', () => {
    expect(llm.familyOf('')).toBe('');
    expect(llm.familyOf(null)).toBe('');
  });
});

describe('review — independence enforcement', () => {
  test('refuses when no reviewer model is configured', () => {
    const s = llm.reviewerStatus();
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/LEDGER_REVIEW_MODEL is not set/);
  });

  test('refuses a reviewer from the same family as the main model', () => {
    // This is the whole point. A same-family reviewer agrees with itself.
    process.env.LEDGER_MODEL = 'deepseek/deepseek-v4.1-flash';
    process.env.LEDGER_REVIEW_MODEL = 'deepseek/deepseek-chat';
    const s = llm.reviewerStatus();
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/same model family/);
  });

  test('accepts a reviewer from a different family', () => {
    process.env.LEDGER_MODEL = 'deepseek/deepseek-v4.1-flash';
    process.env.LEDGER_REVIEW_MODEL = 'qwen/qwen3.8-flash';
    const s = llm.reviewerStatus();
    expect(s.ok).toBe(true);
    expect(s.model).toBe('qwen/qwen3.8-flash');
  });
});

describe('review — reasoning effort', () => {
  beforeEach(() => {
    process.env.LEDGER_REVIEW_MODEL = 'qwen/qwen3.8-flash';
  });

  test('defaults to medium', () => {
    // The reviewer must reason; the classifiers must not. Medium is the
    // balance: enough to catch a fabricated test result, not deep deliberation.
    expect(llm.reviewerReasoning()).toEqual({ reasoning: { effort: 'medium' } });
  });

  test('honours an explicit effort', () => {
    process.env.LEDGER_REVIEW_EFFORT = 'high';
    expect(llm.reviewerReasoning()).toEqual({ reasoning: { effort: 'high' } });
  });

  test('none disables reasoning entirely', () => {
    process.env.LEDGER_REVIEW_EFFORT = 'none';
    expect(llm.reviewerReasoning()).toBeNull();
  });

  test('an invalid effort falls back to medium rather than sending garbage', () => {
    process.env.LEDGER_REVIEW_EFFORT = 'bogus';
    expect(llm.reviewerReasoning()).toEqual({ reasoning: { effort: 'medium' } });
  });

  test('uses the OpenAI-style scalar for OpenAI-family providers', () => {
    process.env.LEDGER_REVIEW_PROVIDER = 'openai';
    expect(llm.reviewerReasoning()).toEqual({ reasoning_effort: 'medium' });
  });

  test('sends nothing for a provider with no known switch', () => {
    process.env.LEDGER_REVIEW_PROVIDER = 'ollama';
    expect(llm.reviewerReasoning()).toBeNull();
  });
});

describe('review — claim extraction shape', () => {
  test('returns empty when the model returns nothing', async () => {
    // No API key configured, so callJson returns null. Must degrade, not throw.
    const claims = await review.extractClaims({ assistantText: 'did stuff', tools: [] });
    expect(claims).toEqual([]);
  });
});

describe('review — findings filtering', () => {
  const findings = [
    { claim: 'c1', verdict: 'false', severity: 'high', evidence: 'ran npm test: 3 failures', fix: 'fix tests' },
    { claim: 'c2', verdict: 'partial', severity: 'high', evidence: 'claimed 33, got 30', fix: 'correct count' },
    { claim: 'c3', verdict: 'false', severity: 'low', evidence: 'minor', fix: '' },
    { claim: 'c4', verdict: 'confirmed', severity: 'high', evidence: 'verified', fix: '' },
    { claim: 'c5', verdict: 'unverified', severity: 'high', evidence: 'could not check', fix: '' },
    { claim: 'c6', verdict: 'partial', severity: 'medium', evidence: 'scope overstated', fix: '' },
  ];

  test('blocks only on high severity AND a real gap', () => {
    const blocking = review.blockingFindings(findings);
    expect(blocking.map((f) => f.claim)).toEqual(['c1', 'c2']);
  });

  test('a confirmed high-severity finding is not blocking', () => {
    const blocking = review.blockingFindings([findings[3]]);
    expect(blocking).toEqual([]);
  });

  test('an unverified high-severity finding is not blocking', () => {
    // "I could not check" is not evidence of a gap. Blocking on it would
    // punish the agent for the reviewer's limitations.
    const blocking = review.blockingFindings([findings[4]]);
    expect(blocking).toEqual([]);
  });

  test('a low-severity false finding is not blocking', () => {
    const blocking = review.blockingFindings([findings[2]]);
    expect(blocking).toEqual([]);
  });

  test('handles an empty list', () => {
    expect(review.blockingFindings([])).toEqual([]);
    expect(review.blockingFindings()).toEqual([]);
  });
});

describe('review — nudge rendering', () => {
  test('renders only blocking findings', () => {
    const nudge = review.renderNudge([
      { claim: 'c1', verdict: 'false', severity: 'high', evidence: 'tests fail', fix: 'fix them' },
      { claim: 'c2', verdict: 'confirmed', severity: 'high', evidence: 'fine', fix: '' },
    ]);
    expect(nudge).toContain('c1');
    expect(nudge).toContain('tests fail');
    expect(nudge).toContain('fix them');
    expect(nudge).not.toContain('c2');
  });

  test('returns empty when nothing is blocking', () => {
    expect(review.renderNudge([{ claim: 'c1', verdict: 'confirmed', severity: 'high' }])).toBe('');
    expect(review.renderNudge([])).toBe('');
  });

  test('tells the agent it may push back', () => {
    // The reviewer can be wrong. The agent should be able to say so rather
    // than being forced to comply with a bad finding.
    const nudge = review.renderNudge([
      { claim: 'c1', verdict: 'false', severity: 'high', evidence: 'x', fix: 'y' },
    ]);
    expect(nudge).toMatch(/explain why the reviewer is mistaken/i);
  });
});

describe('review — investigate guards', () => {
  test('refuses to run without a configured reviewer', async () => {
    const r = await review.investigate({ claims: [{ id: 'c1', text: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/LEDGER_REVIEW_MODEL/);
  });

  test('returns ok with no findings when there are no claims', async () => {
    process.env.LEDGER_REVIEW_MODEL = 'qwen/qwen3.8-flash';
    const r = await review.investigate({ claims: [] });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });
});

describe('review — full review guards', () => {
  test('refuses without a configured reviewer', async () => {
    const r = await review.review({ assistantText: 'x', tools: [] });
    expect(r.ok).toBe(false);
    expect(r.claims).toEqual([]);
  });
});
