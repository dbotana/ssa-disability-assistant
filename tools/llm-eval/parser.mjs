// The parser backends for tools/llm-eval/.
//
// Maintainer-only. No network access. Run through tools/llm-eval/index.mjs.
//
// One backend is parser v2, the deterministic "certain or nothing" parser in
// src/parse.js. The other is the optional on-device LLM backend, which does
// not exist here: v0 reports it unavailable.

import { parseLocal } from '../../src/parse.js';
import { findQuestion } from '../../src/schema.js';

// The golden's fixed "now" (tools/golden/index.mjs), so date checks match it.
export const NOW = () => new Date(Date.UTC(2026, 8, 19, 12, 0, 0));

// Exactly tools/golden/index.mjs caseQuestion(): a real question for
// questionKey, else a bare one of the type with optionsKey's options.
export function caseQuestion({ type, optionsKey, questionKey }) {
  if (questionKey) {
    const real = findQuestion(questionKey);
    if (!real || real.type !== type) throw new Error(`llm-eval: ${questionKey} is not a ${type} question`);
    return real;
  }
  const options = optionsKey ? findQuestion(optionsKey)?.options : undefined;
  return { type, ...(options ? { options } : {}) };
}

/** Parser v2, the deterministic backend: { value, confidence } or null (defer). */
export function deterministicParse(c) {
  const r = parseLocal(caseQuestion(c), c.transcript, { now: NOW });
  return r === null ? null : { value: r.value, confidence: r.confidence };
}

// The LLM backend (llama-server + Qwen3 GGUF, stage 2 Step 4.2). Not built
// in v0: no llama.cpp build or model exists here, so it reports unavailable.
export const LLM_UNAVAILABLE = 'no llama-server build or Qwen3 GGUF (needs M1b); JVM :llm-core/:llm-eval not built';
export function llmAvailable() { return false; }
export async function llmParse(_c) { return { available: false, reason: LLM_UNAVAILABLE }; }
