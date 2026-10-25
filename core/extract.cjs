'use strict';

/**
 * Extraction + reconciliation prompts.
 *
 * Two jobs:
 *  1. extract(prompt)      — pull questions and tasks out of a user message.
 *  2. reconcile(ledger, transcript) — decide which open items are now resolved.
 */

const { callJson } = require('./llm.cjs');
const verdictCheck = require('../tools/verdict-check.cjs');

const EXTRACT_SYSTEM = `You extract actionable items from a user's message to a coding agent.

Return JSON: {"items":[{"kind":"question"|"task","text":"..."}]}

Rules:
- "question" = the user is asking for information or an answer.
- "task" = the user is asking for work to be performed.
- One item per distinct ask. Split compound requests into separate items.
- Keep each "text" short and self-contained (max ~140 chars).
- Ignore pleasantries, acknowledgements, and rhetorical questions.
- Ignore anything the user explicitly says is no longer needed.
- If there is nothing actionable, return {"items":[]}.`;

const RECONCILE_SYSTEM = `You are a compliance auditor. Your job is to decide, for each
open item, whether the agent's response shows it was handled.

You receive OPEN ITEMS and the agent's recent response text.

For each item, decide:
- "done"    — the response reports the work as completed, with a concrete result.
- "dropped" — the user or agent explicitly said it is no longer needed.
- "open"    — everything else.

Return JSON: {"verdicts":[{"id":"...","status":"done"|"dropped"|"open","note":"short evidence"}]}

WHAT COUNTS AS DONE
1. A stated result counts. The response is the agent's own report; you do not
   need to see raw tool output, file contents, or command transcripts. If it
   says "tests pass", "committed as abc123", "installed to /path", or
   "verified: grep found none", that is a result.
2. A summary table or checklist that marks the item complete, with a specific
   detail attached (a commit hash, a count, a path, a test result), is done.
3. A QUESTION is done when the response states the answer, even briefly.
4. A TASK is done when the response reports the outcome of doing it.

WHAT DOES NOT COUNT
5. Promises and intentions: "I will", "next I'll", "let me", "I'm going to".
6. Describing the plan without reporting a result.
7. Partial work: if the item asks for N things and fewer than N are reported,
   it is "open".
8. Merely mentioning or listing the item is not addressing it.
9. If the response says the item is still pending, blocked, or failed, it is
   "open".

JUDGEMENT
10. Judge the substance, not the formatting. A terse "done, 33 tests pass" is
    as complete as a long report.
11. Do not demand evidence the agent could not have produced in a chat reply.
12. When genuinely ambiguous, prefer "open" — but do not invent doubt when the
    response plainly reports a completed result.
13. The "note" must cite the specific phrase that decided it.
14. Include every item id exactly once.`;

/**
 * @param {string} prompt
 * @returns {Promise<Array<{kind:string,text:string}>>}
 */
// Caps that bound the worst-case cost of a single call.
// A pasted log or a huge prompt would otherwise be sent whole.
//
// Configurable via env (or the .env file) so users can tune for their own
// workload. Run `inspect.sh caps` to see whether these fit your history.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Defaults chosen from measured history (2,229 prompts / 30,281 responses):
//   prompts   p50=184  p90=3,506  p95=12,087  p99=52,848  max=685,035
//   responses p50=80   p90=337    p95=672     p99=2,671   max=59,223
// 16k covers ~96% of prompts; 12k covers ~99.9% of responses. Both are still
// small in token terms (~4k / ~3k), so the cost stays bounded.
const MAX_PROMPT_CHARS = envInt('LEDGER_MAX_PROMPT_CHARS', 16000);   // ~4k tokens
const MAX_RESPONSE_CHARS = envInt('LEDGER_MAX_RESPONSE_CHARS', 12000); // ~3k tokens

async function extract(prompt) {
  const clipped = String(prompt || '').slice(0, MAX_PROMPT_CHARS);
  const out = await callJson(EXTRACT_SYSTEM, `USER MESSAGE:\n${clipped}`, 30000);
  if (!out || !Array.isArray(out.items)) return [];
  return out.items
    .filter((i) => i && typeof i.text === 'string' && i.text.trim())
    .map((i) => ({ kind: i.kind === 'question' ? 'question' : 'task', text: i.text.trim() }));
}

/**
 * @param {Array<{id:string,kind:string,text:string}>} open
 * @param {string} responseText
 * @returns {Promise<Array<{id:string,status:string,note?:string}>>}
 */
async function reconcile(open, responseText) {
  if (!open || open.length === 0) return [];
  const itemsBlock = open.map((i) => `- id=${i.id} (${i.kind}) ${i.text}`).join('\n');
  // Clip the response: a long turn can be tens of thousands of chars, and the
  // verdict only needs the substance, not the whole transcript.
  const clipped = String(responseText || '').slice(0, MAX_RESPONSE_CHARS);
  const user = `OPEN ITEMS:\n${itemsBlock}\n\nAGENT RESPONSE:\n${clipped}`;
  const out = await callJson(RECONCILE_SYSTEM, user, 30000);
  if (!out || !Array.isArray(out.verdicts)) return [];

  // Validate before returning. A malformed payload used to be filtered down to
  // "whatever had a string id", which silently turned a broken model response
  // into "nothing is done" — the exact symptom of a turn being blocked with no
  // explanation. Now the bad parts are reported and the good parts survive.
  const report = verdictCheck.check(out, open.map((i) => i.id));
  if (report.problems.length) {
    console.error(`⚠️  reconcile: ${report.problems.length} problem(s) in model output`);
    report.problems.slice(0, 5).forEach((p) => console.error(`   - ${p}`));
  }
  if (report.warnings.length) {
    report.warnings.slice(0, 5).forEach((w) => console.error(`   ⚠️  ${w}`));
  }

  return report.verdicts.map((v) => ({ id: v.id, status: v.status, note: v.note }));
}

/**
 * Collapse semantically duplicate items.
 *
 * Lexical similarity cannot do this. Two phrasings of one question can share
 * almost no vocabulary ("omit the actual task details" vs "not tell what the
 * tasks are" — only "task" overlaps), and they score LOWER than two genuinely
 * different asks ("Add tests for ai.js" vs "Add tests for db.js" — 0.60).
 * No threshold separates those cases, so this needs the model.
 *
 * Only runs when the ledger is large enough to be worth a call. Below the
 * threshold the lexical rules in ledger.cjs are sufficient.
 *
 * @param {Array} items  Open items.
 * @returns {Promise<Array<{keep: string, merge: string[]}>>} Groups to merge.
 */
const COLLAPSE_SYSTEM = `You group duplicate requests. You receive a numbered list of
open questions and tasks from one conversation.

Some entries are the SAME request asked more than once, in different words.
Your job is to find those groups.

Rules:
1. Two entries are duplicates if answering one would answer the other.
   Wording, length, and specificity may differ.
2. A narrower and a broader version of the same ask ARE duplicates.
   Keep the broader one.
3. Different subjects are NOT duplicates, even if the wording is similar.
   "Add tests for ai.js" and "Add tests for db.js" are different.
   "Fix the login bug" and "Fix the logout bug" are different.
4. A question and a task are never duplicates of each other.
5. When unsure, treat them as DIFFERENT. A missed merge is harmless; a wrong
   merge loses a request.
6. Only report groups with 2 or more members. Do not report singletons.

Return JSON: {"groups":[{"keep":"<id>","merge":["<id>","<id>"]}]}
"keep" is the id whose wording is clearest or broadest. "merge" lists the
other ids in that group. Every id appears at most once across all groups.`;

async function collapseDuplicates(items) {
  if (!Array.isArray(items) || items.length < 2) return [];

  const list = items.map((i) => `- id=${i.id} (${i.kind}) ${i.text}`).join('\n');
  const out = await callJson(COLLAPSE_SYSTEM, `OPEN ITEMS:\n${list}`, 30000);
  if (!out || !Array.isArray(out.groups)) return [];

  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set();
  const groups = [];

  for (const g of out.groups) {
    if (!g || typeof g.keep !== 'string' || !Array.isArray(g.merge)) continue;
    if (!byId.has(g.keep)) continue;
    // Guard against a model that repeats an id across groups.
    if (seen.has(g.keep)) continue;

    const merge = g.merge.filter((id) => (
      typeof id === 'string'
      && id !== g.keep
      && byId.has(id)
      && !seen.has(id)
      // Never merge across kinds: a question is not a task.
      && byId.get(id).kind === byId.get(g.keep).kind
    ));
    if (merge.length === 0) continue;

    seen.add(g.keep);
    for (const id of merge) seen.add(id);
    groups.push({ keep: g.keep, merge });
  }

  return groups;
}

module.exports = { extract, reconcile, collapseDuplicates };
