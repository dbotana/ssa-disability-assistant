// The two versions of a form in a Lingala session (plan 4.7, Step 2 item 5).
//
//   A, as given:            every answer exactly as the applicant gave it.
//   B, English translation: the same form, with each Lingala free-text answer
//                           on a `translate: true` question replaced by its
//                           English translation and marked [MT]. Its own
//                           words follow in an appendix.
//
// Both versions go through the same form mapping and the same planFill(), so
// B differs from A only where a translation changed a value. B exists only
// when at least one translated field changes the plan; otherwise the session
// exports one version per form, as today.
//
// Pure. The translations come from outside (NLLB on the phone, or a fixed
// fixture in the tests), as an overlay:
//
//   {
//     inputLangs:   [{ id, loopId?, loopIndex?, lang }]   the language each
//                   answer was given in (4.4); absent means English
//     translations: [{ id, loopId?, loopIndex?, source, text, by }]
//                   `source` is the answer the text translates. A translation
//                   whose source no longer matches the answer is stale and
//                   is not used. `by` is 'mt', or 'person' once a helper
//                   edited it (4.8); only 'mt' text carries the [MT] mark.
//   }
//
// Kotlin port: FormVersions in android/core (pdf/FormVersions.kt), pinned by
// the `versions` cases of the fillplans golden.

import { SECTIONS } from './schema.js';

export const MT_MARK = '[MT]';

/** The addendum's opening line for each version (4.7). */
export const VERSION_NOTES = {
  a: 'Some answers were given in Lingala and are written as spoken. The applicant\'s preferred language is Lingala. Please provide an interpreter.',
  b: 'Answers marked [MT] were translated from Lingala by software on the applicant\'s phone and have not been checked by a translator. The applicant\'s own words follow in the appendix.'
};

export const APPENDIX_TITLE = 'Answers in the applicant\'s own words (Lingala)';

/** Every question marked `translate: true`, as { id, loopId, prompt, itemLabel }. */
export function translatableFields(sections = SECTIONS) {
  const out = [];
  for (const section of sections) {
    for (const q of section.questions) {
      if (q.type === 'loop') {
        for (const f of q.fields) {
          if (f.translate) out.push({ id: f.id, loopId: q.id, prompt: f.prompt, itemLabel: q.itemLabel ?? q.id });
        }
      } else if (q.translate) {
        out.push({ id: q.id, loopId: null, prompt: q.prompt, itemLabel: null });
      }
    }
  }
  return out;
}

const sameField = (a, b) =>
  a.id === b.id && (a.loopId ?? null) === (b.loopId ?? null) &&
  ((a.loopId ?? null) === null || (a.loopIndex ?? 0) === (b.loopIndex ?? 0));

/**
 * The free-text answers given in Lingala on a translatable question, in
 * schema order: [{ id, loopId, loopIndex, question, original }].
 */
export function lingalaFreeText(answers, overlay = {}) {
  const langs = overlay.inputLangs ?? [];
  const out = [];
  const lingala = ref => langs.some(l => l.lang === 'ln' && sameField(l, ref));
  for (const f of translatableFields()) {
    if (!f.loopId) {
      const v = answers?.[f.id];
      const ref = { id: f.id, loopId: null, loopIndex: null };
      if (typeof v === 'string' && v.trim() && lingala(ref)) out.push({ ...ref, question: f.prompt, original: v });
      continue;
    }
    const items = Array.isArray(answers?.[f.loopId]) ? answers[f.loopId] : [];
    items.forEach((item, loopIndex) => {
      const v = item?.[f.id];
      const ref = { id: f.id, loopId: f.loopId, loopIndex };
      if (typeof v === 'string' && v.trim() && lingala(ref)) {
        out.push({ ...ref, question: `${f.itemLabel} ${loopIndex + 1}: ${f.prompt}`, original: v });
      }
    });
  }
  return out;
}

/**
 * The answers version B is planned from: each Lingala free-text answer with a
 * current, non-empty translation that differs from it is replaced by that
 * translation, marked [MT] unless a person wrote it.
 * Returns { answers, translated: [{ id, loopId, loopIndex, question, original, english }] }.
 */
export function overlayAnswers(answers, overlay = {}) {
  const out = structuredClone(answers ?? {});
  const translated = [];
  for (const entry of lingalaFreeText(answers, overlay)) {
    const t = (overlay.translations ?? []).find(x => sameField(x, entry));
    const text = typeof t?.text === 'string' ? t.text.trim() : '';
    if (!t || t.source !== entry.original || !text || text === entry.original) continue;
    const english = t.by === 'person' ? text : `${MT_MARK} ${text}`;
    if (entry.loopId) out[entry.loopId][entry.loopIndex][entry.id] = english;
    else out[entry.id] = english;
    translated.push({ ...entry, english });
  }
  return { answers: out, translated };
}

/**
 * Plan both versions of one form.
 *
 * @param {object} answers
 * @param {object} overlay   { inputLangs, translations }, as above
 * @param {(answers) => object} planOne  the answers -> planFill() result for
 *        this form, exactly as a single-version export plans it
 * @returns {{ a: Version, b: Version|null }} where Version is
 *          { version, answers, plan, notes: string[], appendix: [{label, value}] }
 */
export function planVersions(answers, overlay, planOne) {
  const lingala = lingalaFreeText(answers, overlay);
  const a = {
    version: 'a', answers, plan: planOne(answers),
    notes: lingala.length ? [VERSION_NOTES.a] : [], appendix: []
  };
  if (!lingala.length) return { a, b: null };
  const { answers: bAnswers, translated } = overlayAnswers(answers, overlay);
  if (!translated.length) return { a, b: null };
  const plan = planOne(bAnswers);
  if (JSON.stringify(plan) === JSON.stringify(a.plan)) return { a, b: null };
  return {
    a,
    b: {
      version: 'b', answers: bAnswers, plan,
      notes: [VERSION_NOTES.b],
      appendix: translated.map(t => ({ label: t.question, value: t.original }))
    }
  };
}

/**
 * The addendum content for one version: the form's own wording with the
 * version's note after its intro, and the appendix as a last section, in the
 * shape layoutAddendum() takes. `addendum` is the form spec's ADDENDUM, and
 * `tr` translates fixed wording into the fill language.
 */
export function versionAddendum(addendum, version, { tr = s => s } = {}) {
  const sections = [...(version.plan.sections ?? [])];
  if (version.appendix.length) {
    sections.push({
      id: 'appendix',
      title: tr(APPENDIX_TITLE),
      blocks: version.appendix.map(({ label, value }) => ({ label, value }))
    });
  }
  return {
    title: tr(addendum.title),
    intro: [...(addendum.intro ?? []).map(tr), ...version.notes.map(tr)],
    overflowText: version.plan.overflowText,
    tables: version.plan.tables,
    sections,
    footer: (addendum.footer ?? []).map(tr)
  };
}
