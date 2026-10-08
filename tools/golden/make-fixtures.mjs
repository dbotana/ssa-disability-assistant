// Generates the answer fixtures tests/fixtures/answers/*.json from the
// schema, so they stay in lockstep with the rating fields and loop ids.
//
// Usage: node tools/golden/make-fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as dsIntake from '../../src/forms/ds-intake.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST = join(REPO, 'tests', 'fixtures', 'answers');
mkdirSync(DEST, { recursive: true });

const n = count => Array.from({ length: count }, (_, i) => i + 1);

// -- both forms, a full answer set ---------------------------------------------

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

// -- the others -----------------------------------------------------------------

const SSA_ONLY = {
  forms: 'ssa',
  first_name: 'Grace', last_name: 'Hopper', date_of_birth: '1906-12-09',
  birth_city: 'New York', birth_state: 'New York', birth_country: 'United States',
  ssn: '987654321', conditions: [{ name: 'Fibromyalgia' }, { name: 'Migraine' }],
  onset_date: '2019-11', providers: [{ name: 'City Clinic', address: '1 Main St', phone: '2075550001',
    first_seen: '2019-12', last_seen: 'present' }],
  medications: [{ name: 'Gabapentin', reason: 'Nerve pain' }],
  tests: [{ name: 'MRI', date: '2020-02-02', ordered_by: 'Dr. Chen' }],
  records_permission: true, wc_receives: true, wc_injury_date: '2018-09-03',
  wc_claim_number: 'WC-123', wc_settlement: false, wc_source: 'Insurer', wc_amount: 24000,
  ref1_name: 'Katherine Johnson', ref1_phone: '2075550187',
  jobs: [{ employer: 'US Navy', job_title: 'Mathematician', business_type: 'Government',
    start: '1943-01', end: '1986-08', hours_per_day: 8, days_per_week: 5, pay_amount: 90000, pay_frequency: 'year' }],
  marriages: [{ spouse_name: 'Vincent Hopper', spouse_dob: '1902-01-01', marriage_city: 'New York',
    marriage_state: 'NY', marriage_country: 'United States', marriage_date: '1930-06-15',
    still_active: false, spouse_died: true, spouse_death_date: '1985-01-01' }],
  children: [{ first_name: 'Mark', last_name: 'Hopper' }],
  training: [{ name: 'Naval Reserve Officer Training', completed: '1944-06' }],
  household: [{ name: 'Grace Hopper', dob: '1906-12-09' }],
  rents: true, landlord_name: 'Harbor Properties', landlord_phone: '2075550111',
  has_rental_contract: true, has_admission_agreement: false, recent_admission: false,
  income_sources: [{ kind: 'Pension', monthly_amount: 1800, has_documentation: true }],
  resources: [{ kind: 'Bank account', value: 5000 }],
  education_level: 'Ph.D.', education_year: 1934, education_school: 'Yale University',
  special_ed: false, earnings_reviewed: true
};

const DS_ONLY = {
  forms: 'ds',
  for_self: true,
  first_name: 'Helen', last_name: 'Keller', date_of_birth: '1880-06-27',
  birth_city: 'Tuscumbia', birth_state: 'Alabama', birth_country: 'United States',
  home_street: '3 Ivy Green', home_town: 'Tuscumbia', home_state: 'AL', home_zip: '35674',
  applicant_phone: '2075550162', primary_language: 'English', deaf_hoh: true,
  gender: 'F', marital_status: 'never_married',
  has_guardian: false, diagnoses: [{ name: 'Deafblindness' }],
  medication_allergies: 'None', food_allergies: 'None', environmental_allergies: 'None',
  dietary_restrictions: 'None', has_idd_dx: false,
  currently_employed: false, ds_jobs: [{ employer: 'American Foundation for the Blind', job_title: 'Speaker', start: '1924-01', end: '1968-06' }],
  in_school: false, education_level: 'Bachelor of Arts', education_school: 'Radcliffe College',
  has_504_plan: false, psychoed_eval: false,
  living_arrangement: 'Lives alone with assistance', household: [{ name: 'Anne Sullivan', dob: '1866-04-14' }],
  has_comprehensive_eval: false, has_adaptive_test: false, has_iq_test: false, has_other_assessments: false
};
// Rated activities for the DS-only fixture: every key answered.
for (const key of Object.keys(dsIntake.RATING_FIELDS)) {
  DS_ONLY[`${key}_level`] = key === 'expressive' || key === 'receptive' ? 'E' : 'B';
  DS_ONLY[`${key}_explain`] = `Help needed with ${key}`;
}
DS_ONLY.expressive_explain = 'Communicates through a teacher';
DS_ONLY.receptive_explain = 'Needs everything signed into her hand';

const MINIMAL = {
  forms: 'ssa',
  first_name: 'Test', last_name: 'Applicant'
};

writeFileSync(join(DEST, 'both.json'), JSON.stringify(BOTH, null, 2) + '\n');
writeFileSync(join(DEST, 'starter-kit.json'), JSON.stringify(SSA_ONLY, null, 2) + '\n');
writeFileSync(join(DEST, 'ds-only.json'), JSON.stringify(DS_ONLY, null, 2) + '\n');
writeFileSync(join(DEST, 'minimal.json'), JSON.stringify(MINIMAL, null, 2) + '\n');
console.log('fixtures written to', DEST);
