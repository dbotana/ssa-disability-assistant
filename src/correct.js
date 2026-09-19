// Spoken field name -> question target, for the review-and-correct pass.
//
// "Change my phone number" has to land on a specific question id before
// engine.jumpTo() can do anything with it. That is this module's only job.
//
// It is deliberately local and deterministic. Correction is the one place a
// user goes when the interview already got something wrong, so sending the
// phrase back to the model — and risking a second wrong answer, this time
// about *which field to overwrite* — is exactly the wrong trade. Local
// matching also means correction still works in typing mode with no API key.
//
// A target is:
//   { id, loopId?, loopIndex?, label, prompt, ambiguous?, candidates? }

import { SECTIONS, RATING_GROUPS, flatten, nodeActive } from './schema.js';
import { shortLabel } from './summary.js';

/**
 * Extra spoken forms per question id, beyond the label and the prompt.
 *
 * These are the words people actually say out loud, which are rarely the
 * words on the form: nobody says "legal first name", they say "my name".
 * Multi-word aliases are matched as phrases, so "date of birth" outranks a
 * stray "date".
 */
const ALIASES = {
  first_name: ['first name', 'my name', 'given name'],
  last_name: ['last name', 'surname', 'family name'],
  date_of_birth: ['date of birth', 'birthday', 'birth date', 'dob', 'when i was born'],
  birth_city: ['city i was born', 'birth city', 'city of birth'],
  birth_state: ['state i was born', 'birth state', 'state of birth'],
  birth_country: ['country i was born', 'birth country', 'country of birth'],
  ssn: ['social security number', 'social security', 'social', 'ssn', 'my number'],
  onset_date: ['onset date', 'when my condition started', 'when it started', 'start of my condition'],
  wc_receives: ['workers comp', "workers' compensation", 'workmans comp', 'disability benefit'],
  wc_injury_date: ['date of injury', 'injury date', 'when i was injured'],
  wc_claim_number: ['workers comp claim number', "workers' compensation claim number", 'claim number'],
  wc_settlement: ['settlement', 'settlement agreement'],
  wc_source: ['source of payment', 'who pays'],
  wc_amount: ['payment amount', 'how much i get'],
  records_permission: ['permission', 'medical records permission', 'release'],
  ref1_name: ['first reference', 'reference one', 'first person', 'contact name'],
  ref1_phone: ['first reference phone number', 'first reference phone', 'reference one phone',
    'reference phone number', 'phone number', 'phone'],
  ref2_name: ['second reference', 'reference two', 'second person'],
  ref2_phone: ['second reference phone', 'reference two phone'],
  earnings_reviewed: ['earnings record', 'earnings'],
  education_level: ['education', 'education level', 'school level', 'highest grade'],
  education_year: ['year i finished school', 'education year', 'graduation year'],
  education_school: ['school', 'school name', 'institution'],
  special_ed: ['special education', 'special ed'],
  special_ed_where: ['where i had special education'],
  special_ed_year: ['special education year'],
  rents: ['rent', 'do i rent', 'renting'],
  landlord_name: ['landlord', 'landlord name'],
  landlord_phone: ['landlord phone number', 'landlord phone', 'landlord number', 'phone number', 'phone'],
  has_rental_contract: ['rental contract', 'lease'],
  has_admission_agreement: ['admission agreement'],
  recent_admission: ['recent admission', 'hospital stay'],
  has_admit_papers: ['admit papers', 'discharge papers'],
  routing_number: ['routing number', 'routing', 'bank routing'],
  account_number: ['account number', 'bank account', 'account'],
  forms: ['form', 'forms', 'which form', 'which forms', 'form choice'],
  // Developmental Services application
  for_self: ['for myself', 'filling it out for myself', 'who is filling this out'],
  helper_name: ['my agency', 'agency', 'agency name', 'helper name', 'person completing'],
  helper_address: ['my mailing address', 'agency address', 'helper address'],
  helper_phone: ['my phone', 'agency phone', 'helper phone'],
  helper_fax: ['fax', 'fax number'],
  helper_email: ['agency email', 'helper email'],
  home_street: ['street address', 'home address', 'address'],
  home_town: ['town', 'city', 'town i live in', 'home town'],
  home_state: ['state i live in', 'home state'],
  home_zip: ['zip code', 'zip', 'postal code'],
  mailing_address: ['mailing address'],
  applicant_phone: ['my phone number', 'my phone', 'phone number', 'phone'],
  applicant_email: ['my email', 'email address', 'email'],
  primary_language: ['language', 'primary language'],
  deaf_hoh: ['deaf', 'hard of hearing', 'hearing'],
  gender: ['gender', 'sex'],
  mainecare_number: ['mainecare', 'mainecare number', 'medicaid number'],
  marital_status: ['marital status', 'married'],
  has_guardian: ['guardian', 'power of attorney', 'do i have a guardian'],
  guardian_name: ["guardian's name", 'guardian name'],
  guardian_relationship: ["guardian's relationship", 'guardian relationship'],
  guardian_address: ["guardian's address", 'guardian address'],
  guardian_city: ["guardian's town", "guardian's city"],
  guardian_county: ["guardian's county"],
  guardian_zip: ["guardian's zip", "guardian's zip code"],
  guardian_phone: ["guardian's phone number", "guardian's phone", 'guardian phone'],
  guardian_email: ["guardian's email", 'guardian email'],
  ec_same_as_guardian: ['guardian as emergency contact'],
  ec_name: ['emergency contact', 'emergency contact name', 'emergency'],
  ec_relationship: ['emergency contact relationship'],
  ec_address: ['emergency contact address'],
  ec_city: ['emergency contact town', 'emergency contact city'],
  ec_county: ['emergency contact county'],
  ec_zip: ['emergency contact zip', 'emergency contact zip code'],
  ec_phone: ['emergency contact phone number', 'emergency contact phone', 'emergency phone'],
  ec_email: ['emergency contact email', 'emergency email'],
  medication_allergies: ['medication allergies', 'drug allergies', 'allergies'],
  food_allergies: ['food allergies'],
  environmental_allergies: ['environmental allergies', 'pollen', 'seasonal allergies'],
  dietary_restrictions: ['dietary restrictions', 'diet'],
  has_idd_dx: ['developmental diagnosis', 'autism diagnosis', 'intellectual disability'],
  idd_dx_date: ['date of diagnosis', 'diagnosis date', 'when i was diagnosed'],
  idd_age_at_dx: ['age at diagnosis', 'how old i was when diagnosed'],
  currently_employed: ['currently employed', 'working now', 'employed'],
  vr_involvement: ['vocational rehabilitation', 'vr', 'voc rehab'],
  volunteer_experience: ['volunteer', 'volunteering', 'volunteer work'],
  in_school: ['in school', 'attending school', 'going to school'],
  graduation_date: ['graduation', 'graduation date'],
  has_504_plan: ['504', '504 plan'],
  psychoed_eval: ['psychoeducational evaluation', 'psychoeducational'],
  living_arrangement: ['living arrangement', 'where i live'],
  has_comprehensive_eval: ['comprehensive evaluation'],
  has_adaptive_test: ['adaptive behavior test', 'adaptive test'],
  has_iq_test: ['iq test', 'intelligence test'],
  has_other_assessments: ['other assessments', 'iep', 'education plan'],
  ...ratingAliases(),
  // loop fields
  name: ['name'],
  employer: ['employer', 'employer name', 'company', 'where i worked'],
  job_title: ['job title', 'title', 'position'],
  business_type: ['type of business', 'business type'],
  start: ['start date', 'when i started'],
  end: ['end date', 'when i left', 'when it ended'],
  hours_per_day: ['hours', 'hours per day', 'hours a day'],
  days_per_week: ['days', 'days per week', 'days a week'],
  pay_amount: ['pay', 'pay rate', 'wage', 'salary', 'rate of pay'],
  pay_frequency: ['pay frequency', 'how often i was paid', 'pay period'],
  address: ['address'],
  phone: ['phone', 'phone number', 'number'],
  first_seen: ['first seen', 'first visit', 'admission date'],
  last_seen: ['last seen', 'last visit', 'discharge date'],
  ordered_by: ['ordered by', 'who ordered it'],
  reason: ['reason', 'why i take it'],
  prescribed_by: ['prescribed by', 'who prescribed it'],
  spouse_name: ['spouse name', 'spouse', 'husband', 'wife'],
  spouse_ssn: ["spouse's social security number", 'spouse social security'],
  spouse_dob: ["spouse's date of birth", 'spouse birthday'],
  marriage_city: ['city i got married', 'marriage city'],
  marriage_state: ['state i got married', 'marriage state'],
  marriage_country: ['country i got married', 'marriage country'],
  marriage_date: ['marriage date', 'date i got married', 'wedding date'],
  still_active: ['still married', 'marriage still active'],
  divorce_date: ['divorce date', 'when i got divorced'],
  spouse_died: ['spouse died', 'spouse passed away'],
  spouse_death_date: ['date of death', 'when my spouse died'],
  kind: ['type', 'kind'],
  monthly_amount: ['monthly amount', 'how much a month'],
  has_documentation: ['documentation'],
  value: ['value', 'worth'],
  completed: ['date completed', 'when i finished'],
  dob: ['date of birth', 'birthday']
};

/**
 * Words that name a loop group out loud. Used both to scope a field match
 * ("my doctor's phone" -> providers.phone) and to resolve which item is meant.
 */
const LOOP_WORDS = {
  conditions: ['condition', 'conditions', 'diagnosis', 'illness'],
  diagnoses: ['diagnosis', 'diagnoses', 'condition', 'conditions'],
  idd_diagnoses: ['confirmed diagnosis', 'confirmed diagnoses', 'evaluation diagnosis'],
  ds_jobs: ['job', 'jobs', 'work', 'employer', 'employers', 'employment'],
  providers: ['provider', 'providers', 'doctor', 'doctors', 'hospital', 'clinic', 'facility'],
  tests: ['test', 'tests', 'lab', 'labs', 'scan'],
  medications: ['medication', 'medications', 'medicine', 'medicines', 'drug', 'drugs', 'prescription'],
  jobs: ['job', 'jobs', 'work', 'employer', 'employers', 'employment'],
  training: ['training', 'training program', 'vocational', 'trade school'],
  marriages: ['marriage', 'marriages', 'spouse', 'husband', 'wife', 'wedding'],
  children: ['child', 'children', 'kid', 'kids', 'son', 'daughter'],
  household: ['household', 'household member', 'roommate', 'who lives with me'],
  income_sources: ['income', 'income source', 'paycheck', 'pension'],
  resources: ['resource', 'resources', 'bank account', 'asset', 'assets']
};

/**
 * "Eating", "my eating answer", "the eating explanation" for each rated DS
 * activity. The rating and its explanation are separate answers, so only the
 * explanation takes the words that name it.
 */
function ratingAliases() {
  const out = {};
  for (const group of RATING_GROUPS) {
    for (const act of group.activities) {
      out[`${act.key}_level`] = [act.short, `${act.short} rating`, `${act.short} answer`, act.label.toLowerCase()];
      out[`${act.key}_explain`] = [`${act.short} explanation`, `explanation for ${act.short}`,
        `help with ${act.short}`];
    }
  }
  return out;
}

/** Spoken ordinals, for "the second provider". */
const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
  '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

/** Phrases that introduce a correction, stripped before matching. */
const LEAD_INS = [
  /^(i want to |i need to |can you |could you |please )/i,
  /^(change|correct|fix|update|edit|redo|re-?do|amend)\s+/i,
  /^(my|the|our)\s+/i,
  /^(answer|response|entry|field)\s+(for|to|about)\s+/i,
  /\s+(is wrong|was wrong|is incorrect|needs? fixing|needs? to change)$/i,
  /^(go to|jump to|take me to)\s+/i
];

const normalizeText = s => String(s ?? '')
  .toLowerCase()
  .replace(/[’']/g, "'")
  .replace(/[^a-z0-9'\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Strip lead-in verbs so "change my phone number" matches "phone number". */
export function stripLeadIn(phrase) {
  let out = String(phrase ?? '').trim();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (const re of LEAD_INS) {
      const next = out.replace(re, '');
      if (next !== out) { out = next.trim(); changed = true; }
    }
  }
  return out;
}

/**
 * Every correctable target in the schema, in interview order.
 *
 * Loop fields appear once per existing item, so "the second provider's phone"
 * has something concrete to resolve to. Loops with no items yet contribute
 * nothing — there is no answer there to correct.
 */
export function buildTargets(answers = {}) {
  const targets = [];
  // Only what the chosen forms ask. "Change my phone number" on a Starter Kit
  // interview must not offer a guardian's phone that was never asked for.
  for (const q of flatten(SECTIONS)) {
    if (!nodeActive(q, answers)) continue;
    if (q.type === 'loop') {
      const items = Array.isArray(answers[q.id]) ? answers[q.id] : [];
      items.forEach((item, index) => {
        for (const f of q.fields) {
          targets.push({
            id: f.id,
            loopId: q.id,
            loopIndex: index,
            itemLabel: q.itemLabel,
            itemNumber: index + 1,
            type: f.type,
            options: f.options,
            prompt: f.prompt,
            label: shortLabel(f.prompt, f.id),
            section: q.section,
            sectionTitle: q.sectionTitle,
            value: item?.[f.id] ?? null
          });
        }
      });
      continue;
    }
    targets.push({
      id: q.id,
      type: q.type,
      options: q.options,
      prompt: q.prompt,
      label: shortLabel(q.prompt, q.id),
      section: q.section,
      sectionTitle: q.sectionTitle,
      value: answers[q.id] ?? null
    });
  }
  return targets;
}

/** Human description of a target, for spoken disambiguation. */
export function describeTarget(t) {
  if (!t.loopId) return t.label;
  return `${t.label} for ${t.itemLabel} ${t.itemNumber}`;
}

/**
 * Score how well a phrase names one target. Higher is better; 0 is no match.
 *
 * Longer alias phrases score above shorter ones so that "date of birth" beats
 * a bare "date", and an exact phrase beats a substring.
 */
function scoreTarget(phrase, target) {
  const names = [
    target.label,
    ...(ALIASES[target.id] ?? []),
    target.prompt
  ].map(normalizeText).filter(Boolean);

  let best = 0;
  for (const name of names) {
    if (!name) continue;
    const words = name.split(' ').length;
    if (phrase === name) best = Math.max(best, 1000 + words * 10);
    else if (words > 1 && phrase.includes(name)) best = Math.max(best, 500 + words * 10);
    else if (words > 1 && name.includes(phrase) && phrase.split(' ').length > 1) {
      best = Math.max(best, 300 + phrase.split(' ').length * 10);
    } else if (words === 1 && new RegExp(`\\b${escapeRe(name)}\\b`).test(phrase)) {
      best = Math.max(best, 200);
    }
  }

  // A prompt-only match is weak evidence; keep it below any label/alias hit.
  if (!best) {
    const overlap = contentWords(phrase).filter(w =>
      normalizeText(target.label).includes(w) || normalizeText(target.prompt).includes(w));
    if (overlap.length) best = 50 + overlap.length * 10;
  }
  return best;
}

const LOOP_NODES = new Map(flatten(SECTIONS).filter(n => n.type === 'loop').map(n => [n.id, n]));

const STOP = new Set(['the', 'my', 'a', 'an', 'of', 'for', 'to', 'is', 'was', 'and', 'i', 'me', 'that', 'this', 'it']);
const contentWords = phrase => normalizeText(phrase).split(' ').filter(w => w && !STOP.has(w) && w.length > 2);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which loop group, if any, the phrase names. Returns a loop id or null.
 *
 * Two loops can answer to the same words — "job" is both the Starter Kit's
 * job list and the DS-only one — but the form choice makes only one of them
 * part of the interview, and only that one is considered.
 */
function loopHintFor(phrase, answers = {}) {
  let hit = null;
  let hitLen = 0;
  for (const [loopId, words] of Object.entries(LOOP_WORDS)) {
    if (!nodeActive(LOOP_NODES.get(loopId), answers)) continue;
    for (const w of words) {
      const n = normalizeText(w);
      if (new RegExp(`\\b${escapeRe(n)}\\b`).test(phrase) && n.length > hitLen) {
        hit = loopId;
        hitLen = n.length;
      }
    }
  }
  return hit;
}

/**
 * Ordinals that are part of a field name rather than an item selector.
 * "First name" and "last name" are the whole point of this guard: without it
 * "change my first name" reads as "item 1 of something".
 */
const ORDINAL_FALSE_FRIENDS = [
  /\bfirst\s+name\b/, /\blast\s+name\b/, /\bfirst\s+seen\b/, /\blast\s+seen\b/,
  /\bfirst\s+visit\b/, /\blast\s+visit\b/, /\bfirst\s+reference\b/, /\bsecond\s+reference\b/,
  /\bfirst\s+person\b/, /\bsecond\s+person\b/
];

/**
 * Which item number, if any, the phrase names ("the second provider").
 *
 * @param {boolean} bare  allow a lone numeral ("1"), as in a reply to a
 *                        disambiguation question. Off during field matching,
 *                        where a stray number is far more likely to be part
 *                        of an answer than an item selector.
 */
function itemNumberFor(phrase, { bare = false } = {}) {
  if (ORDINAL_FALSE_FRIENDS.some(re => re.test(phrase))) return null;

  for (const [word, n] of Object.entries(ORDINALS)) {
    // Bare digits and number-words are only selectors in a choice reply.
    if (!bare && !/^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))$/.test(word)) {
      continue;
    }
    if (new RegExp(`\\b${escapeRe(word)}\\b`).test(phrase)) return n;
  }
  const m = /\b(?:number|item)\s+(\d{1,2})\b/.exec(phrase);
  if (m) return Number(m[1]);
  if (bare) {
    const only = /^(\d{1,2})$/.exec(phrase.trim());
    if (only) return Number(only[1]);
  }
  if (/\blast\b/.test(phrase)) return -1;   // resolved against item count
  return null;
}

/**
 * Resolve a spoken phrase to a correction target.
 *
 * @returns {{ok:true, target:object}}
 *        | {ok:false, reason:'none'}
 *        | {ok:false, reason:'ambiguous', candidates:object[]}
 */
export function resolveTarget(phrase, answers = {}) {
  const cleaned = normalizeText(stripLeadIn(phrase));
  if (!cleaned) return { ok: false, reason: 'none' };

  const targets = buildTargets(answers);
  if (!targets.length) return { ok: false, reason: 'none' };

  const loopHint = loopHintFor(cleaned, answers);
  const wanted = itemNumberFor(cleaned);

  let scored = targets.map(t => {
    let score = scoreTarget(cleaned, t);
    if (!score) return { t, score: 0 };
    if (loopHint) {
      // Naming the group is strong evidence when field ids repeat across loops.
      score += t.loopId === loopHint ? 400 : t.loopId ? -200 : -150;
    } else if (t.loopId && wanted == null) {
      // No group named and no item number: the question is about the
      // applicant. "My date of birth" is the one in the identity section, not
      // a household member's, and "my first name" is not a child's, even
      // though those fields carry identical labels. The penalty is larger
      // than the ambiguity window below, so an unqualified phrase that has a
      // top-level match resolves to it outright instead of asking.
      score -= 150;
    }
    return { t, score };
  }).filter(s => s.score > 0);

  if (!scored.length) return { ok: false, reason: 'none' };

  // An explicit item number narrows a loop match to that one item.
  //
  // If nothing matches that number the item does not exist — "the second
  // provider" when only one was recorded. Falling back to the unfiltered
  // list would quietly correct provider 1 instead, which is the single worst
  // outcome available here: silently overwriting an answer the user did not
  // name. Report it as a miss and let the caller ask again.
  if (wanted != null && scored.some(s => s.t.loopId)) {
    const byNumber = scored.filter(s => {
      if (!s.t.loopId) return false;
      const count = (answers[s.t.loopId] ?? []).length;
      const target = wanted === -1 ? count : wanted;
      return s.t.itemNumber === target;
    });
    if (!byNumber.length) return { ok: false, reason: 'none' };
    scored = byNumber;
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];

  // How close a rival has to be before it counts as a real alternative.
  //
  // When the phrase named a group ("my doctor's phone") or an item number,
  // the user has already been specific and the top match should win outright.
  // An unqualified name like "phone number" has not: this form has a phone
  // field on providers, references, and the landlord, and picking one of them
  // silently would overwrite a record the user never mentioned. There the
  // window is wide enough that all of them get offered as a choice.
  const window = loopHint || wanted != null ? 1 : 120;
  const near = scored.filter(s => s.score >= top.score - window);

  // The same field across several items of one loop is not a real ambiguity
  // about *which question* is meant — only about which item. With no ordinal
  // spoken, item 1 is the useful default, and the read-back of the current
  // value tells the user immediately if they meant a different one.
  const sameField = near.every(s =>
    s.t.id === top.t.id && s.t.loopId === top.t.loopId);
  if (sameField) {
    const firstItem = near.reduce((a, b) =>
      (a.t.loopIndex ?? 0) <= (b.t.loopIndex ?? 0) ? a : b);
    return { ok: true, target: firstItem.t };
  }

  // Distinct fields within one point of each other are a genuine coin flip;
  // guessing here overwrites the wrong answer, so ask instead.
  if (near.length > 1) {
    // Once we have decided to ask, widen the net past the top-level
    // preference above: a loop field demoted only by that penalty is still a
    // plausible thing the user meant, and it belongs on the list they hear.
    const offered = scored.filter(s => s.score >= top.score - (window + 150));
    const candidates = [];
    for (const s of offered) {
      // One entry per distinct question — the first item stands in for a
      // field that repeats across loop items, so the list stays short.
      if (candidates.some(c => c.id === s.t.id && c.loopId === s.t.loopId)) continue;
      candidates.push(s.t);
      if (candidates.length === 5) break;
    }
    return { ok: false, reason: 'ambiguous', candidates };
  }

  return { ok: true, target: top.t };
}

/**
 * Pick a target from a spoken reply to a disambiguation question — either an
 * ordinal ("the second one") or a repeat of one candidate's name.
 */
export function resolveChoice(phrase, candidates) {
  const cleaned = normalizeText(stripLeadIn(phrase));
  if (!cleaned || !candidates?.length) return null;

  const n = itemNumberFor(cleaned, { bare: true });
  if (n === -1) return candidates[candidates.length - 1];
  if (n != null && n >= 1 && n <= candidates.length) return candidates[n - 1];

  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = scoreTarget(cleaned, c);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore > 0 ? best : null;
}

// -- deletion --------------------------------------------------------------

/**
 * Phrases that mean "delete a loop item" rather than "correct a value".
 *
 * Deletion is destructive and irreversible from the user's point of view, so
 * the trigger is deliberately narrow: an explicit removal verb. A vague
 * "that provider is wrong" is a correction, not a deletion.
 */
const DELETE_VERBS = /\b(delete|remove|drop|erase|get rid of|take (?:it |that )?off|scratch)\b/i;

/** Does this phrase ask to delete something? */
export function isDeletionPhrase(phrase) {
  return DELETE_VERBS.test(String(phrase ?? ''));
}

/**
 * Resolve a deletion phrase to one loop item.
 *
 * @returns {{ok:true, loopId, loopIndex, itemLabel, number, title}}
 *        | {ok:false, reason:'none'}                       nothing named
 *        | {ok:false, reason:'empty', loopId, itemLabel}   that loop is empty
 *        | {ok:false, reason:'ambiguous', loopId, itemLabel, candidates}
 *
 * "Remove that last provider" and "delete the second job" resolve outright.
 * Naming a group that holds several items without saying which ("delete a
 * provider") asks, because deleting the wrong record loses real answers.
 */
export function resolveDeletion(phrase, answers = {}) {
  const cleaned = normalizeText(stripLeadIn(String(phrase ?? '').replace(DELETE_VERBS, ' ')));

  const loopId = loopHintFor(cleaned, answers);
  if (!loopId) return { ok: false, reason: 'none' };

  const node = LOOP_NODES.get(loopId);
  const itemLabel = node?.itemLabel ?? 'item';
  const items = Array.isArray(answers[loopId]) ? answers[loopId] : [];
  const describe = (item, index) => ({
    index,
    number: index + 1,
    itemLabel,
    title: node ? item?.[node.fields[0].id] ?? null : null
  });

  if (!items.length) return { ok: false, reason: 'empty', loopId, itemLabel };

  const wanted = itemNumberFor(cleaned);
  if (wanted != null) {
    const index = wanted === -1 ? items.length - 1 : wanted - 1;
    // A number past the end names an item that was never recorded. Saying
    // "there is no provider 5" beats deleting provider 1.
    if (index < 0 || index >= items.length) {
      return { ok: false, reason: 'ambiguous', loopId, itemLabel,
        candidates: items.map(describe) };
    }
    return { ok: true, loopId, loopIndex: index, ...describe(items[index], index) };
  }

  // "the only provider" is unambiguous when there is exactly one.
  if (items.length === 1) {
    return { ok: true, loopId, loopIndex: 0, ...describe(items[0], 0) };
  }

  // A named item wins over an ordinal: "delete City Clinic".
  const byTitle = items
    .map(describe)
    .filter(c => c.title && cleaned.includes(normalizeText(c.title)));
  if (byTitle.length === 1) {
    return { ok: true, loopId, loopIndex: byTitle[0].index, ...byTitle[0] };
  }

  return { ok: false, reason: 'ambiguous', loopId, itemLabel,
    candidates: items.map(describe) };
}

/** Spoken description of a loop item: "provider 2, City Clinic". */
export function describeItem(item) {
  const base = `${item.itemLabel} ${item.number}`;
  return item.title ? `${base}, ${item.title}` : base;
}
