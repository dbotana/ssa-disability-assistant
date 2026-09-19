// Answers -> fields of Maine DHHS's Developmental Services Intake Application
// (Office of Aging and Disability Services, revised 06/18/2025).
//
// Every blank on the form is a single-line text field, so list answers
// (diagnoses, medications, household, work history) are joined onto one line,
// and fill.js moves anything too long for its box to an addendum page.
//
// Where the Starter Kit is also being filled out, some DS answers are derived
// from its questions instead of asked twice: marital status from the marriage
// history, diagnoses from the conditions list, work history from the job list.
//
// Two traps in the PDF itself, both handled in RATING_FIELDS below:
//   - Section 10 (Community Access: Shopping, Transportation, Banking,
//     Recreation) is wired to fields named after section 11's rows —
//     LetterFamily, LetterFriends, LetterCoworkers, LetterSupport Staff.
//   - Section 11 (Maintain Relationships) therefore uses the `_2` names.
// "ME" is printed as the state in sections 2–4, which have no State field.

import { findQuestion, hasForm, RATING_GROUPS } from '../schema.js';
import { choiceLabel } from '../choice.js';
import { text, mdy, my, yesNo, phone, ssn, zip, join, items } from './common.js';

export const TEMPLATE = 'forms/maine-developmental-services-intake-2025-06-18.pdf';
export const FILE_PREFIX = 'maine-ds-intake';
export const TITLE = 'Developmental Services Intake Application — filled in';

export const ADDENDUM = {
  title: 'Developmental Services Intake Application: continued',
  intro: [
    'Some answers did not fit in the boxes on the application. They are written '
    + 'out in full here. Send this page along with the application.'
  ],
  footer: ['DS Intake Application, continued', 'Prepared on the applicant\'s own device.']
};

/** Activity key (see RATING_GROUPS in schema.js) -> the PDF's row suffix. */
export const RATING_FIELDS = {
  eating: 'Eating',
  dressing: 'Dressing',
  toileting: 'Toileting',
  bathing: 'Bathing',
  grooming: 'Grooming',
  mobility: 'Mobility',
  physical_danger: 'Avoidance of physical danger',
  emotional_jeopardy: 'Avoidance of emotional jeopardy',
  healthy_relationships: 'Engagement in healthy relationships',
  judgment: 'Judgment regarding personal conduct',
  cooking: 'Cooking',
  laundry: 'Laundry',
  // Section 10, on fields named after section 11's rows. Not a typo here.
  shopping: 'Family',
  transportation: 'Friends',
  banking: 'Coworkers',
  recreation: 'Support Staff',
  // Section 11.
  rel_family: 'Family_2',
  rel_friends: 'Friends_2',
  rel_coworkers: 'Coworkers_2',
  rel_support_staff: 'Support Staff_2',
  expressive: 'Expressive Communication',
  receptive: 'Receptive Communication',
  sign_language: 'Sign Language',
  visual_gestural: 'VisualGestural'
};

const CONFIRMED_DX = n => `Current Diagnoses Confirmed by Psychological evaluation with IQ and Adaptive Scores ${n}`;
const CONFIRMED_DX_ROWS = 3;

const MARITAL_OPTIONS = findQuestion('marital_status')?.options ?? [];

/** "Keeping up relationships: Family", for addendum labels. */
const ACTIVITY_LABELS = Object.fromEntries(RATING_GROUPS.flatMap(g =>
  g.activities.map(act => [act.key, `${g.title}: ${act.label}`])));

/**
 * Marital status, as the DS form wants it.
 *
 * Asked directly when the Starter Kit is not being filled out. With the Kit,
 * the marriage history already says it: an active marriage is "Married", a
 * last marriage that ended in the spouse's death is "Widowed", one that ended
 * otherwise is "Divorced", and no marriages at all is "Never married".
 * "Separated" cannot be told apart from married in that history, so an active
 * marriage always reads as married.
 */
export function maritalStatus(a) {
  if (!hasForm(a, 'ssa')) return choiceLabel(MARITAL_OPTIONS, a.marital_status);
  if (!Array.isArray(a.marriages)) return '';
  const list = a.marriages;
  if (!list.length) return 'Never married';
  if (list.some(m => m.still_active === true)) return 'Married';
  const last = list[list.length - 1];
  if (last.spouse_died === true) return 'Widowed';
  if (last.still_active === false) return 'Divorced';
  return '';
}

/**
 * Every current diagnosis, once each: the Starter Kit's conditions, the DS
 * list (which may hold answers from before the form choice changed), and —
 * because 5b asks that they also appear in 5a — the confirmed IDD or autism
 * diagnoses.
 */
function diagnoses(a) {
  const listed = [];
  for (const it of [...items(a, 'conditions'), ...items(a, 'diagnoses'), ...items(a, 'idd_diagnoses')]) {
    const name = text(it.name);
    if (name && !listed.some(d => d.toLowerCase() === name.toLowerCase())) listed.push(name);
  }
  return listed.join('; ');
}

function medications(a) {
  return items(a, 'medications')
    .map(it => {
      const name = text(it.name);
      const reason = text(it.reason);
      return name && reason ? `${name} (${reason})` : name;
    })
    .filter(Boolean)
    .join('; ');
}

function employmentHistory(a) {
  const list = hasForm(a, 'ssa') ? items(a, 'jobs') : items(a, 'ds_jobs');
  return list
    .map(it => {
      const where = join([it.job_title, it.employer], ', ');
      const from = my(it.start);
      const to = my(it.end);
      const when = from || to ? ` (${from || '?'} to ${to || '?'})` : '';
      return where ? `${where}${when}` : '';
    })
    .filter(Boolean)
    .join('; ');
}

function specialEducation(a) {
  const parts = [];
  if (typeof a.special_ed === 'boolean') parts.push(`Special education: ${yesNo(a.special_ed)}`);
  if (typeof a.has_504_plan === 'boolean') parts.push(`504 plan: ${yesNo(a.has_504_plan)}`);
  return parts.join('; ');
}

/**
 * Map an answer set onto the DS Intake Application.
 * @param {object} answers
 * @param {{ today?: Date }} opts  the date written at the top of page 1
 * @returns {{ text, labels, radios, checks, tables }}
 */
export function map(answers, { today = new Date() } = {}) {
  const a = answers ?? {};
  const out = {};
  const labels = {};
  const put = (field, value, label) => {
    const v = text(value);
    if (!v) return;
    out[field] = v;
    labels[field] = label;
  };

  const name = join([a.first_name, a.last_name], ' ');
  // Local date, not toISOString(): in a US evening the UTC date is tomorrow.
  const pad = n => String(n).padStart(2, '0');
  const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  // Page 1: applicant.
  put('Date', mdy(iso), 'Date');
  put('Applicant Name', name, 'Applicant name');
  put('DOB', mdy(a.date_of_birth), 'Date of birth');
  put('MaineCare', a.mainecare_number, 'MaineCare number');
  put('SSN', ssn(a.ssn), 'Social Security number');
  put('Street Address', a.home_street, 'Street address');
  if (a.mailing_different === true) put('Mailing Address if different', a.mailing_address, 'Mailing address');
  put('Town 1', a.home_town, 'Town');
  put('State 1', a.home_state, 'State');
  put('Zip 1', zip(a.home_zip), 'Zip');
  put('Phone 1', phone(a.applicant_phone), 'Phone number');
  put('Marital Status', maritalStatus(a), 'Marital status');
  put('Email 1', a.applicant_email, 'Email');
  put('Place of Birth', join([a.birth_city, a.birth_state, a.birth_country]), 'Place of birth');
  put('Primary Language 1', a.primary_language, 'Primary language');
  put('Deaf or hard of hearing 1', yesNo(a.deaf_hoh), 'Deaf or hard of hearing');

  // Section 2: someone completing it for the applicant.
  if (a.for_self === false) {
    put('Name of PersonAgency 2', a.helper_name, 'Person or agency completing the application');
    put('Mailing Address 2', a.helper_address, 'Their mailing address');
    put('City 2', a.helper_city, 'Their city');
    put('County 2', a.helper_county, 'Their county');
    put('Zip 2', zip(a.helper_zip), 'Their zip');
    put('Phone 2', phone(a.helper_phone), 'Their phone');
    put('Fax 2', phone(a.helper_fax), 'Their fax');
    put('Email 2', a.helper_email, 'Their email');
  }

  // Section 3: guardian or power of attorney.
  if (a.has_guardian === true) {
    put('Name 3', a.guardian_name, "Guardian's name");
    put('Mailing Address 3', a.guardian_address, "Guardian's mailing address");
    put('City 3', a.guardian_city, "Guardian's city");
    put('County 3', a.guardian_county, "Guardian's county");
    put('Zip 3', zip(a.guardian_zip), "Guardian's zip");
    put('Phone 3', phone(a.guardian_phone), "Guardian's phone");
    put('Email 3', a.guardian_email, "Guardian's email");
    put('Relationship 3', a.guardian_relationship, "Guardian's relationship");
  }

  // Section 4: emergency contact — the guardian's details if they said so.
  const ec = a.has_guardian === true && a.ec_same_as_guardian === true
    ? { name: a.guardian_name, address: a.guardian_address, city: a.guardian_city, county: a.guardian_county,
        zip: a.guardian_zip, phone: a.guardian_phone, email: a.guardian_email, relationship: a.guardian_relationship }
    : { name: a.ec_name, address: a.ec_address, city: a.ec_city, county: a.ec_county,
        zip: a.ec_zip, phone: a.ec_phone, email: a.ec_email, relationship: a.ec_relationship };
  put('Name 4', ec.name, 'Emergency contact name');
  put('Street Address 4', ec.address, 'Emergency contact address');
  put('City 4', ec.city, 'Emergency contact city');
  put('County 4', ec.county, 'Emergency contact county');
  put('Zip 4', zip(ec.zip), 'Emergency contact zip');
  put('Phone 4', phone(ec.phone), 'Emergency contact phone');
  put('Email 4', ec.email, 'Emergency contact email');
  put('Relationship 4', ec.relationship, 'Emergency contact relationship');

  // 5a: health.
  put('Current Diagnoses', diagnoses(a), 'Current diagnoses');
  put('Current Medications', medications(a), 'Current medications');
  put('Medication Allergies', a.medication_allergies, 'Medication allergies');
  put('Food Allergies', a.food_allergies, 'Food allergies');
  put('Environmental Allergies', a.environmental_allergies, 'Environmental allergies');
  put('Dietary Restrictions', a.dietary_restrictions, 'Dietary restrictions');

  // 5b: intellectual or developmental disability, or autism.
  const tables = [];
  if (a.has_idd_dx === true) {
    put('Date of Diagnosis', my(a.idd_dx_date), 'Date of diagnosis');
    put('Age at Diagnosis', a.idd_age_at_dx, 'Age at diagnosis');
    const confirmed = items(a, 'idd_diagnoses').map(it => text(it.name)).filter(Boolean);
    confirmed.slice(0, CONFIRMED_DX_ROWS).forEach((dx, i) =>
      put(CONFIRMED_DX(i + 1), dx, `Confirmed diagnosis ${i + 1}`));
    if (confirmed.length > CONFIRMED_DX_ROWS) {
      tables.push({
        title: '5b. Diagnoses confirmed by psychological evaluation, continued',
        itemLabel: 'diagnosis',
        startAt: CONFIRMED_DX_ROWS + 1,
        columns: [{ label: 'Confirmed diagnosis' }],
        rows: confirmed.slice(CONFIRMED_DX_ROWS).map(dx => [dx])
      });
    }
  }

  // 6: home.
  put('What is your current living arrangement', a.living_arrangement, 'Current living arrangement');
  put('Who is in the household', items(a, 'household').map(it => text(it.name)).filter(Boolean).join(', '),
    'Who is in the household');

  // 7–12: rated activities.
  for (const [key, suffix] of Object.entries(RATING_FIELDS)) {
    const level = a[`${key}_level`];
    if (!level) continue;
    const label = ACTIVITY_LABELS[key] ?? key;
    put(`Letter${suffix}`, level, `${label} — rating`);
    if (level !== 'A') put(`Explanation${suffix}`, a[`${key}_explain`], `${label} — explanation`);
  }

  // 13: education.
  put('Are you currently attending school', yesNo(a.in_school), 'Currently attending school');
  if (a.in_school === true) put('Anticipated graduation date', my(a.graduation_date), 'Anticipated graduation date');
  put('Highest grade completed', a.education_level, 'Highest grade completed');
  put('Name of school', a.education_school, 'Name of school');
  put('Have you ever received Special Education andor 504 Plan', specialEducation(a), 'Special education or 504 plan');
  put('Have you had a Psychoeducational Evaluation', yesNo(a.psychoed_eval), 'Psychoeducational evaluation');

  // 14: employment.
  put('Are you currently employed', yesNo(a.currently_employed), 'Currently employed');
  put('Employment History', employmentHistory(a), 'Employment history');
  put('Involvement with VR', a.vr_involvement, 'Involvement with Vocational Rehabilitation');
  put('Volunteer experiences', a.volunteer_experience, 'Volunteer experiences');

  // Page 4: printed names. Signatures and signature dates stay blank for ink.
  put('Applicant Name print', name, 'Applicant name');
  if (a.has_guardian === true) put('Guardian Name print', a.guardian_name, 'Guardian name');
  if (a.for_self === false) put('Other Name print', a.helper_name, 'Other name');

  // Required documents. The application itself is always enclosed.
  const checks = ['Check Box26'];
  if (a.has_comprehensive_eval === true) checks.push('Check Box27');
  if (a.has_adaptive_test === true) checks.push('Check Box28');
  if (a.has_iq_test === true) checks.push('Check Box29');
  if (a.has_other_assessments === true) checks.push('Check Box30');

  const radios = {};
  if (a.gender === 'M' || a.gender === 'F') radios.Gender = a.gender;

  return { text: out, labels, radios, checks, tables };
}
