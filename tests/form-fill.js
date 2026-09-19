// Filling the real official PDFs. Runs with plain `node tests/form-fill.js`.
// Zero API calls — pdf-lib from vendor/, templates from forms/.
//
// The mappings name PDF fields by string, and a PDF's field names are not
// something anyone reads until a fill silently skips one. So every name either
// mapping can emit is exercised here against the actual template, and the
// values are read back out of the saved file.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fillTemplate } from '../src/fill.js';
import * as ssaKit from '../src/forms/ssa-starter-kit.js';
import * as dsIntake from '../src/forms/ds-intake.js';
import { toWinAnsi } from '../src/forms/common.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PDFLib = createRequire(import.meta.url)('../vendor/pdf-lib.min.js');

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) return;
  failures++;
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const template = async spec => readFile(join(ROOT, spec.TEMPLATE));
const reopen = async bytes => (await PDFLib.PDFDocument.load(bytes)).getForm();
const textOf = (form, name) => { try { return form.getTextField(name).getText() ?? ''; } catch { return null; } };

const n = count => Array.from({ length: count }, (_, i) => i + 1);

// -- a full answer set, both forms --------------------------------------------

const BOTH = {
  forms: 'both',
  for_self: false,
  helper_name: 'Casco Bay Case Management', helper_address: '10 Front St', helper_city: 'Portland',
  helper_county: 'Cumberland', helper_zip: '04101', helper_phone: '2075550100', helper_fax: '2075550101',
  helper_email: 'intake@example.org',
  first_name: 'Ada', last_name: 'Lovelace', date_of_birth: '1995-12-10',
  birth_city: 'Bangor', birth_state: 'Maine', birth_country: 'United States', ssn: '123456789',
  home_street: '5 Elm St', home_town: 'Portland', home_state: 'ME', home_zip: '041011234',
  mailing_different: true, mailing_address: 'PO Box 9, Portland, ME 04101',
  applicant_phone: '2075550199', applicant_email: 'ada@example.com', primary_language: 'English',
  deaf_hoh: false, gender: 'F', mainecare_number: 'ME1234567',
  has_guardian: true, guardian_name: 'Anne Byron', guardian_relationship: 'Mother',
  guardian_address: '12 Oak St', guardian_city: 'Augusta', guardian_county: 'Kennebec',
  guardian_zip: '04330', guardian_phone: '2075550122', guardian_email: 'anne@example.com',
  ec_same_as_guardian: false, ec_name: 'Mary Somerville', ec_relationship: 'Aunt', ec_address: '3 Pine St',
  ec_city: 'Bath', ec_county: 'Sagadahoc', ec_zip: '04530', ec_phone: '2075550133', ec_email: 'mary@example.com',
  conditions: n(6).map(i => ({ name: `Condition number ${i}` })),
  onset_date: '2021-03',
  medication_allergies: 'Penicillin', food_allergies: 'Peanuts', environmental_allergies: 'Pollen',
  dietary_restrictions: 'Gluten free',
  has_idd_dx: true, idd_dx_date: '2001-04', idd_age_at_dx: 5,
  idd_diagnoses: [{ name: 'Autism spectrum disorder' }, { name: 'Mild intellectual disability' }, { name: 'ADHD' }],
  providers: n(5).map(i => ({ name: `Dr. ${i}`, address: `${i} Main St`, phone: `20755500${i}0`,
    first_seen: '2020-01', last_seen: i === 5 ? 'present' : '2023-06' })),
  tests: n(5).map(i => ({ name: `Test ${i}`, date: '2023-02-14', ordered_by: `Dr. ${i}` })),
  medications: n(6).map(i => ({ name: `Med ${i}`, reason: `Reason ${i}`, prescribed_by: `Dr. ${i}` })),
  wc_receives: false, records_permission: true, ref1_name: 'Charles Babbage', ref1_phone: '2075550144',
  jobs: n(5).map(i => ({ employer: `Employer ${i}`, job_title: `Title ${i}`, business_type: 'Restaurant',
    start: '2018-01', end: i === 1 ? 'present' : '2019-06', hours_per_day: 8, days_per_week: 5,
    pay_amount: 15, pay_frequency: 'hour' })),
  currently_employed: true, vr_involvement: 'Job coaching', volunteer_experience: 'Food bank',
  in_school: true, graduation_date: '2027-06', education_level: '12th grade', education_school: 'Deering High',
  special_ed: true, has_504_plan: false, psychoed_eval: true,
  training: [], marriages: [], children: [],
  living_arrangement: 'Lives with family', household: [{ name: 'Anne Byron' }, { name: 'Tom Byron' }],
  has_comprehensive_eval: true, has_adaptive_test: false, has_iq_test: true, has_other_assessments: true,
  routing_number: '021000021', account_number: '5544332211'
};
// Every rated activity, with an explanation for the ones that need one.
for (const key of Object.keys(dsIntake.RATING_FIELDS)) {
  BOTH[`${key}_level`] = key === 'eating' ? 'A' : 'C';
  BOTH[`${key}_explain`] = `Needs practice with ${key}`;
}
BOTH.shopping_level = 'B';
BOTH.rel_family_level = 'D';

// -- Starter Kit ---------------------------------------------------------------

{
  const mapping = ssaKit.map(BOTH);
  const { bytes, missing } = await fillTemplate(PDFLib, await template(ssaKit), mapping, {
    title: ssaKit.TITLE, addendum: ssaKit.ADDENDUM
  });
  eq('every Starter Kit field the mapping names exists', missing, []);

  const form = await reopen(bytes);
  // Every worksheet cell on the kit is reachable: a full answer set fills all 104.
  const allText = form.getFields().filter(f => f instanceof PDFLib.PDFTextField).map(f => f.getName());
  const filled = allText.filter(name => textOf(form, name));
  eq('a full answer set fills every worksheet cell', filled.length, allText.length);

  eq('row 1 uses the instruction-text field name',
    textOf(form, 'List each physical or mental condition (including emotional or learning difficulties) that limits yo'),
    'Condition number 1');
  eq('row 6 of conditions', textOf(form, 'Condition 6'), 'Condition number 6');
  eq('provider phone is formatted', textOf(form, 'Phone number 2'), '(207) 555-0020');
  eq('still seeing a provider reads Present', textOf(form, 'Date Last Seen by Provider or Discharge Date 5'), 'Present');
  eq('test date is written mm/dd/yyyy', textOf(form, 'Date 3'), '02/14/2023');
  eq('job dates are mm/yyyy', textOf(form, 'Date worked from month/year 2'), '01/2018');
  eq('pay amount', textOf(form, 'Rate of pay amount 1'), '$15');
  eq('pay frequency uses its label', textOf(form, 'Rate of pay frequency 1'), 'Per hour');
  eq('hours per day', textOf(form, 'Hours per day 3'), '8');

  const checked = form.getFields().filter(f => f instanceof PDFLib.PDFCheckBox && f.isChecked()).map(f => f.getName());
  eq('eleven checklist items are ticked', checked.length, 11);
  check('records in your possession is left for the applicant',
    !checked.some(name => name.startsWith('Records already in your possession')));

  const doc = await PDFLib.PDFDocument.load(bytes);
  check('the addendum carries the rest of the checklist', doc.getPageCount() > 5,
    `${doc.getPageCount()} pages`);
  check('the form stays editable, not flattened', form.getFields().length === 116);
}

// A ninth provider does not vanish: five on the worksheet, the rest continued.
{
  const answers = {
    ...BOTH,
    providers: n(8).map(i => ({ name: `Clinic ${i}`, phone: '2075550000' }))
  };
  const mapping = ssaKit.map(answers);
  eq('five providers go on the worksheet', mapping.text['Name of Healthcare provider 5'], 'Clinic 5');
  check('a sixth provider has no field', !Object.values(mapping.text).includes('Clinic 6'));
  const continued = mapping.tables.find(t => t.title.startsWith('B.'));
  eq('three providers continue on the addendum', continued?.rows.map(r => r[0]), ['Clinic 6', 'Clinic 7', 'Clinic 8']);
  eq('continued rows are numbered from 6', continued?.startAt, 6);
}

// The addendum holds what the kit has no fields for, and nothing DS-only.
{
  const { sections } = ssaKit.map(BOTH);
  const ids = sections.map(s => s.id);
  check('identity is in the addendum', ids.includes('identity'));
  check('direct deposit is in the addendum', ids.includes('direct_deposit'));
  check('providers are not repeated in the addendum', !ids.includes('medical_providers'));
  check('no DS-only section leaks into the Starter Kit', !ids.some(id => ['guardian', 'adl', 'ds_contact'].includes(id)),
    ids.join(', '));
  const employment = sections.find(s => s.id === 'employment');
  check('DS-only questions are not in the kit addendum',
    !employment?.blocks.some(b => b.id === 'currently_employed'));
}

// -- DS Intake Application -------------------------------------------------------

{
  const mapping = dsIntake.map(BOTH, { today: new Date(2026, 8, 19) });
  const { bytes, missing } = await fillTemplate(PDFLib, await template(dsIntake), mapping, {
    title: dsIntake.TITLE, addendum: dsIntake.ADDENDUM
  });
  eq('every DS field the mapping names exists', missing, []);

  const form = await reopen(bytes);
  const allText = form.getFields().filter(f => f instanceof PDFLib.PDFTextField).map(f => f.getName());
  // Signature dates are left for the day someone signs in ink.
  const leftBlank = new Set(['Applicant Date', 'Guardian Date', 'Other Date']);
  // Eating is rated independent in this fixture, which asks no explanation.
  const unfilled = allText.filter(name => !leftBlank.has(name) && name !== 'ExplanationEating' && !textOf(form, name));
  eq('a full answer set fills every DS text field', unfilled, []);
  for (const name of leftBlank) eq(`${name} stays blank`, textOf(form, name), '');

  eq('date at the top', textOf(form, 'Date'), '09/19/2026');
  eq('applicant name', textOf(form, 'Applicant Name'), 'Ada Lovelace');
  eq('SSN is formatted', textOf(form, 'SSN'), '123-45-6789');
  eq('place of birth is one line', textOf(form, 'Place of Birth'), 'Bangor, Maine, United States');
  eq('nine-digit zip', textOf(form, 'Zip 1'), '04101-1234');
  eq('marital status derives from the marriage history', textOf(form, 'Marital Status'), 'Never married');
  eq('helper goes in section 2', textOf(form, 'Name of PersonAgency 2'), 'Casco Bay Case Management');
  eq('emergency contact is not the guardian here', textOf(form, 'Name 4'), 'Mary Somerville');
  eq('gender radio', form.getRadioGroup('Gender').getSelected(), 'F');

  // Section 10 sits on fields named after section 11's rows.
  eq('shopping rating lands on the community-access row', textOf(form, 'LetterFamily'), 'B');
  eq('family relationships land on the _2 row', textOf(form, 'LetterFamily_2'), 'D');
  eq('an independent rating has no explanation', textOf(form, 'ExplanationEating'), '');
  eq('other ratings carry their explanation', textOf(form, 'ExplanationCooking'), 'Needs practice with cooking');

  eq('confirmed diagnoses fill all three rows',
    textOf(form, 'Current Diagnoses Confirmed by Psychological evaluation with IQ and Adaptive Scores 3'), 'ADHD');
  eq('special education and 504 plan share one box',
    textOf(form, 'Have you ever received Special Education andor 504 Plan'), 'Special education: Yes; 504 plan: No');
  eq('work history comes from the Starter Kit job list',
    textOf(form, 'Employment History')?.startsWith('Title 1, Employer 1 (01/2018 to Present)'), true);

  const checked = ['Check Box26', 'Check Box27', 'Check Box28', 'Check Box29', 'Check Box30']
    .filter(name => form.getCheckBox(name).isChecked());
  eq('document checkboxes', checked, ['Check Box26', 'Check Box27', 'Check Box29', 'Check Box30']);
}

// A long list is shrunk, then cut and continued — never silently dropped.
{
  const answers = {
    ...BOTH,
    conditions: n(14).map(i => ({ name: `A fairly long diagnosis name number ${i}` }))
  };
  const mapping = dsIntake.map(answers);
  const { bytes, overflowText } = await fillTemplate(PDFLib, await template(dsIntake), mapping, {
    addendum: dsIntake.ADDENDUM
  });
  const form = await reopen(bytes);
  const box = textOf(form, 'Current Diagnoses');
  check('the box says to see the attached page', box.endsWith('(see attached)'), box);
  const spilled = overflowText.find(o => o.label === 'Current diagnoses');
  check('the full list goes to the addendum', spilled?.value.includes('number 14'), JSON.stringify(spilled));
  check('the addendum page was added', (await PDFLib.PDFDocument.load(bytes)).getPageCount() > 4);
}

// DS without the Starter Kit uses its own questions for the shared facts.
{
  const answers = {
    forms: 'ds', marital_status: 'divorced',
    diagnoses: [{ name: 'Down syndrome' }],
    ds_jobs: [{ employer: 'Hannaford', job_title: 'Bagger', start: '2022-05', end: 'present' }],
    // Starter Kit answers that should be ignored now.
    marriages: [{ spouse_name: 'X', still_active: true }],
    jobs: [{ employer: 'Ignored' }]
  };
  const mapping = dsIntake.map(answers);
  eq('marital status is asked directly', mapping.text['Marital Status'], 'Divorced');
  eq('diagnoses come from the DS list', mapping.text['Current Diagnoses'], 'Down syndrome');
  eq('work history comes from the DS list', mapping.text['Employment History'], 'Bagger, Hannaford (05/2022 to Present)');
  check('no guardian, no guardian name printed', !('Guardian Name print' in mapping.text));
  eq('emergency contact left blank when not given', mapping.text['Name 4'], undefined);
}

// The guardian doubles as emergency contact when they say so.
{
  const mapping = dsIntake.map({ ...BOTH, ec_same_as_guardian: true, ec_name: undefined });
  eq('guardian copied into section 4', mapping.text['Name 4'], 'Anne Byron');
  eq('with their relationship', mapping.text['Relationship 4'], 'Mother');
}

// Marital status derived from a marriage history.
{
  const both = extra => dsIntake.maritalStatus({ forms: 'both', ...extra });
  eq('active marriage', both({ marriages: [{ still_active: false }, { still_active: true }] }), 'Married');
  eq('last spouse died', both({ marriages: [{ still_active: false, spouse_died: true }] }), 'Widowed');
  eq('ended otherwise', both({ marriages: [{ still_active: false, spouse_died: false }] }), 'Divorced');
  eq('never asked', both({}), '');
}

// A name the standard fonts cannot draw does not break the download.
{
  eq('Latin-1 survives', toWinAnsi('José Ñúñez'), 'José Ñúñez');
  eq('letters outside Latin-1 fall back to their base letter', toWinAnsi('Łukasz Wałęsa'), 'Lukasz Walesa');
  eq('scripts with no Latin form become ?', toWinAnsi('李'), '?');
  const answers = { ...BOTH, first_name: 'Łukasz', last_name: '李' };
  const { bytes, missing } = await fillTemplate(PDFLib, await template(dsIntake), dsIntake.map(answers), {});
  eq('a non-Latin name still fills', missing, []);
  check('and produces a PDF', bytes.length > 1000);
}

console.log(failures ? `\n${failures} failure(s)` : 'form-fill: all checks passed');
process.exit(failures ? 1 : 0);
