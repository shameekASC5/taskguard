'use strict';

/**
 * Extraction + reconciliation prompts.
 *
 * Two jobs:
 *  1. extract(prompt)      — pull questions and tasks out of a user message.
 *  2. reconcile(ledger, transcript) — decide which open items are now resolved.
 */

const { callJson } = require('./llm.cjs');

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

const RECONCILE_SYSTEM = `You are a strict compliance auditor. Your job is to REJECT
insufficient work, not to give the agent credit.

You receive OPEN ITEMS and the agent's latest response text.
For each item, decide:
- "done"    — the response CONTAINS the actual deliverable.
- "dropped" — the user or agent EXPLICITLY said it is no longer needed.
- "open"    — everything else. This is the default.

Return JSON: {"verdicts":[{"id":"...","status":"done"|"dropped"|"open","note":"short evidence"}]}

STRICTNESS RULES — apply all of them:
1. DEFAULT TO "open". If you are unsure, it is "open".
2. A QUESTION is "done" only if the response states the actual answer.
   Naming the topic, restating the question, or saying "I'll explain" is NOT an answer.
3. A TASK is "done" only if the response shows the work was performed
   (the result, the output, the file changed, the command run).
   Describing what you are about to do is NOT completion.
4. PROMISES ARE NOT COMPLETION. "I will", "next I'll", "let me", "I'm going to",
   "I can do that" => "open".
5. PARTIAL IS NOT DONE. If the item asks for N things and the response gives
   fewer than N, it is "open".
6. MENTIONING AN ITEM IS NOT ADDRESSING IT. If the response only references the
   item (e.g. lists it, quotes it, says it is unfinished), that is "open".
7. Do not infer intent or give benefit of the doubt. Judge only what is written.
8. The "note" must cite the specific evidence, or say what is missing.
9. Include every item id exactly once.`;

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
  return out.verdicts.filter((v) => v && typeof v.id === 'string');
}

module.exports = { extract, reconcile };
