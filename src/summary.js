// Accessible summary rendering and JSON export.
//
// The summary is a semantic document — real headings, real definition lists —
// so a screen reader can read it straight through without the user hunting
// through a grid.

import { SECTIONS, FORM_IDS, RATING_GROUPS, nodeActive, sectionActive } from './schema.js';
import { speakableValue, formatDate, formatMonthYear } from './a11y.js';
import { choiceLabel } from './choice.js';

/**
 * Normalize the raw answer set into an ordered, presentable structure that
 * the HTML summary, the spoken read-back, and the PDF addendum build from.
 *
 * Only what the chosen forms actually asked is included: a Starter Kit report
 * has no guardian section, and a declined branch (no workers' comp) leaves no
 * row of blanks behind. Pass `form` to narrow it further to one form's
 * questions, as the Starter Kit's addendum does.
 */
export function buildReport(answers, { form = null } = {}) {
  const report = [];
  for (const section of SECTIONS) {
    if (!sectionActive(section, answers)) continue;
    if (form && (section.id === 'forms' || !(section.forms ?? FORM_IDS).includes(form))) continue;

    const blocks = [];
    for (const q of section.questions) {
      const node = { ...q, forms: q.forms ?? section.forms ?? null };
      if (!nodeActive(node, answers)) continue;
      if (form && node.forms && !node.forms.includes(form)) continue;

      if (q.type === 'loop') {
        const items = Array.isArray(answers[q.id]) ? answers[q.id] : [];
        blocks.push({
          kind: 'table',
          id: q.id,
          label: q.itemLabel,
          columns: q.fields.map(f => ({
            id: f.id, label: shortLabel(f.prompt, f.id), type: f.type, options: f.options
          })),
          rows: items.map(item =>
            q.fields.map(f => present(item[f.id], f.type, f.options))
          ),
          empty: items.length === 0
        });
        continue;
      }

      const value = answers[q.id];
      blocks.push({
        kind: 'field',
        id: q.id,
        label: shortLabel(q.prompt, q.id),
        type: q.type,
        options: q.options,
        value: present(value, q.type, q.options),
        answered: value != null && value !== ''
      });
    }

    if (blocks.length) report.push({ id: section.id, title: section.title, blocks });
  }
  return report;
}

/**
 * Turn a spoken question into a compact label for a form row.
 *
 * Explicit overrides first: mechanical prefix-stripping produces things like
 * "City were you born in", which is fine to hear but wrong to read on a
 * document someone hands to a caseworker.
 */
const LABELS = {
  first_name: 'Legal first name',
  last_name: 'Legal last name',
  date_of_birth: 'Date of birth',
  birth_city: 'City of birth',
  birth_state: 'State or province of birth',
  birth_country: 'Country of birth',
  ssn: 'Social Security number',
  wc_receives: "Receives workers' compensation",
  wc_injury_date: 'Date of injury',
  wc_claim_number: 'Claim number',
  wc_settlement: 'Settlement agreement',
  wc_source: 'Source of payment',
  wc_amount: 'Payment amount',
  records_permission: 'Permission to request medical records',
  ref1_name: 'Reference 1 — name',
  ref1_phone: 'Reference 1 — phone',
  ref2_name: 'Reference 2 — name',
  ref2_phone: 'Reference 2 — phone',
  earnings_reviewed: 'Earnings record reviewed',
  onset_date: 'Date condition began limiting work',
  education_level: 'Highest level of education completed',
  education_year: 'Year completed',
  education_school: 'School or institution',
  special_ed: 'Received special education services',
  special_ed_where: 'Special education — where',
  special_ed_year: 'Special education — year completed',
  rents: 'Rents home',
  landlord_name: "Landlord's name",
  landlord_phone: "Landlord's phone number",
  has_rental_contract: 'Rental contract on file',
  has_admission_agreement: 'Admission agreement on file',
  recent_admission: 'Recent hospital or institution admission',
  has_admit_papers: 'Admit or discharge papers on file',
  routing_number: "Bank's 9-digit routing number",
  account_number: 'Bank account number',
  forms: 'Forms being filled out',
  // Developmental Services application
  for_self: 'Filling out the application for yourself',
  helper_name: 'Person or agency completing the application',
  helper_address: 'Their mailing address',
  helper_city: 'Their town or city',
  helper_county: 'Their county',
  helper_zip: 'Their zip code',
  helper_phone: 'Their phone number',
  helper_fax: 'Their fax number',
  helper_email: 'Their email address',
  home_street: 'Street address',
  home_town: 'Town or city',
  home_state: 'State',
  home_zip: 'Zip code',
  mailing_different: 'Mailing address is different',
  mailing_address: 'Mailing address',
  applicant_phone: 'Phone number',
  applicant_email: 'Email address',
  primary_language: 'Primary language',
  deaf_hoh: 'Deaf or hard of hearing',
  gender: 'Gender',
  mainecare_number: 'MaineCare number',
  marital_status: 'Marital status',
  has_guardian: 'Has a guardian or power of attorney',
  guardian_name: "Guardian's name",
  guardian_relationship: "Guardian's relationship",
  guardian_address: "Guardian's mailing address",
  guardian_city: "Guardian's town or city",
  guardian_county: "Guardian's county",
  guardian_zip: "Guardian's zip code",
  guardian_phone: "Guardian's phone number",
  guardian_email: "Guardian's email address",
  ec_same_as_guardian: 'Guardian is the emergency contact',
  ec_name: 'Emergency contact name',
  ec_relationship: 'Emergency contact relationship',
  ec_address: 'Emergency contact street address',
  ec_city: 'Emergency contact town or city',
  ec_county: 'Emergency contact county',
  ec_zip: 'Emergency contact zip code',
  ec_phone: 'Emergency contact phone number',
  ec_email: 'Emergency contact email address',
  medication_allergies: 'Medication allergies',
  food_allergies: 'Food allergies',
  environmental_allergies: 'Environmental allergies',
  dietary_restrictions: 'Dietary restrictions',
  has_idd_dx: 'Diagnosed with an intellectual or developmental disability, or autism',
  idd_dx_date: 'Date of diagnosis',
  idd_age_at_dx: 'Age at diagnosis',
  currently_employed: 'Currently employed',
  vr_involvement: 'Involvement with Vocational Rehabilitation',
  volunteer_experience: 'Volunteer experience',
  in_school: 'Currently attending school',
  graduation_date: 'Expected graduation',
  has_504_plan: 'Has had a 504 plan',
  psychoed_eval: 'Has had a psychoeducational evaluation',
  living_arrangement: 'Current living arrangement',
  has_comprehensive_eval: 'Has a comprehensive evaluation',
  has_adaptive_test: 'Has an adaptive behavior test',
  has_iq_test: 'Has an intelligence test',
  has_other_assessments: 'Has other assessments, such as an IEP',
  ...ratingLabels(),
  // loop fields
  employer: "Employer's name",
  job_title: 'Job title',
  business_type: 'Type of business',
  start: 'Start month and year',
  end: 'End month and year',
  hours_per_day: 'Average hours per day',
  days_per_week: 'Days per week',
  pay_amount: 'Rate of pay',
  pay_frequency: 'Paid',
  ordered_by: 'Ordered by',
  address: 'Address',
  first_seen: 'Date first seen or admission date',
  last_seen: 'Date last seen or discharge date',
  reason: 'Why you take it',
  prescribed_by: 'Prescribed by',
  spouse_name: "Spouse's full name",
  spouse_ssn: "Spouse's Social Security number",
  spouse_dob: "Spouse's date of birth",
  marriage_city: 'City of marriage',
  marriage_state: 'State of marriage',
  marriage_country: 'Country of marriage',
  marriage_date: 'Date of marriage',
  still_active: 'Marriage still active',
  divorce_date: 'Date of divorce',
  spouse_died: 'Spouse passed away',
  spouse_death_date: 'Date of death',
  kind: 'Type',
  monthly_amount: 'Approximate monthly amount',
  has_documentation: 'Documentation available',
  value: 'Approximate value',
  completed: 'Date completed',
  dob: 'Date of birth',
  name: 'Name',
  phone: 'Phone number',
  date: 'Date'
};

/** "Eating" and "Eating — explanation" for every rated DS activity. */
function ratingLabels() {
  const out = {};
  for (const group of RATING_GROUPS) {
    for (const act of group.activities) {
      out[`${act.key}_level`] = act.label;
      out[`${act.key}_explain`] = `${act.label} — explanation`;
    }
  }
  return out;
}

export function shortLabel(prompt, id) {
  if (id && LABELS[id]) return LABELS[id];
  return String(prompt)
    .replace(/^(What is|What was|What|Who|Where|When|Which|Do you have|Do you|Did you|Have you|Are you|Is this|Can you give me|Can you provide)\s+/i, '')
    .replace(/\?.*$/, '')
    .replace(/^the\s+/i, '')
    .replace(/^your\s+/i, '')
    .replace(/\s+You can say.*$/i, '')
    .replace(/^(.)/, (_, c) => c.toUpperCase())
    .trim();
}

/** Printable rendering of a stored value. `options` is for choice answers. */
export function present(value, type, options = null) {
  if (value == null || value === '') return '';
  if (type === 'yesno') return value === true ? 'Yes' : 'No';
  if (type === 'choice') return choiceLabel(options, value);
  if (type === 'zip') {
    const digits = String(value).replace(/\D/g, '');
    return digits.length === 9 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits || String(value);
  }
  if (type === 'money') return `$${Number(value).toLocaleString()}`;
  if (type === 'ssn') return groupDigits(value, [3, 2, 4], '-');
  if (type === 'phone') return groupDigits(value, [3, 3, 4], '-');
  if (type === 'routing' || type === 'account') return String(value).replace(/\D/g, '');
  // Dates are stored ISO for sorting and re-import; a worksheet someone reads
  // at an SSA appointment should show them the way a person writes them.
  if (type === 'date') return formatDate(value);
  if (type === 'monthyear') {
    return String(value).toLowerCase() === 'present' ? 'Present' : formatMonthYear(value);
  }
  return String(value);
}

function groupDigits(value, groups, sep) {
  const digits = String(value).replace(/\D/g, '');
  const total = groups.reduce((a, b) => a + b, 0);
  if (digits.length !== total) return digits || String(value);
  const out = [];
  let i = 0;
  for (const n of groups) { out.push(digits.slice(i, i + n)); i += n; }
  return out.join(sep);
}

/** Render the report into an element as semantic HTML. */
export function renderSummary(container, answers) {
  const report = buildReport(answers);
  container.innerHTML = '';

  for (const section of report) {
    const h = document.createElement('h3');
    h.textContent = section.title;
    container.append(h);

    for (const block of section.blocks) {
      if (block.kind === 'table') {
        if (block.empty) {
          const p = document.createElement('p');
          p.className = 'empty';
          p.textContent = `No ${block.label} recorded.`;
          container.append(p);
          continue;
        }
        block.rows.forEach((row, idx) => {
          const dl = document.createElement('dl');
          const caption = document.createElement('dt');
          caption.textContent = `${titleCase(block.label)} ${idx + 1}`;
          dl.append(caption);
          block.columns.forEach((col, i) => {
            const dd = document.createElement('dd');
            dd.textContent = `${col.label}: ${row[i] || 'not answered'}`;
            dl.append(dd);
          });
          container.append(dl);
        });
        continue;
      }

      const dl = document.createElement('dl');
      const dt = document.createElement('dt');
      dt.textContent = block.label;
      const dd = document.createElement('dd');
      dd.textContent = block.value || 'Not answered';
      if (!block.answered) dd.className = 'empty';
      dl.append(dt, dd);
      container.append(dl);
    }
  }
}

function titleCase(s) {
  return String(s).replace(/^(.)/, (_, c) => c.toUpperCase());
}

/** Plain-text rendering, used for the spoken read-back. */
export function summaryText(answers) {
  const lines = [];
  for (const section of buildReport(answers)) {
    lines.push(section.title + '.');
    for (const block of section.blocks) {
      if (block.kind === 'table') {
        if (block.empty) { lines.push(`No ${block.label} recorded.`); continue; }
        block.rows.forEach((row, idx) => {
          const parts = block.columns
            .map((col, i) => row[i] ? `${col.label}, ${speakableValue(row[i], col.type)}` : null)
            .filter(Boolean);
          lines.push(`${titleCase(block.label)} ${idx + 1}: ${parts.join('. ')}.`);
        });
        continue;
      }
      lines.push(`${block.label}: ${block.value || 'not answered'}.`);
    }
  }
  return lines.join('\n');
}

/**
 * Download the session as JSON, for re-import or a backup copy.
 *
 * `answers` stays at the top level so the file is readable on its own and so
 * files written by version 1 (answers only) still import. `state` carries the
 * cursor as well, which is what lets an unfinished interview resume on another
 * device at the exact question it was left on. Version 3 added the form
 * choice; `state.schema` records which question layout the cursor indexes.
 */
export function downloadJson(answers, state = null, filename = 'disability-forms-prep.json') {
  const payload = { version: 3, savedAt: new Date().toISOString(), answers };
  if (state) payload.state = state;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
