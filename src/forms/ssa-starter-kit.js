// Answers -> fields of Social Security's Adult Disability Starter Kit
// (Publication No. 64-110, June 2024).
//
// The kit's fillable fields are its checklist (page 1) and worksheet sections
// A–E: conditions, healthcare providers, medicines, tests, and jobs. The
// worksheet tables have a fixed number of rows; rows past that go to the
// addendum, as does everything the checklist asks you to have ready but the
// kit has nowhere to write (identity, marriages, bank details, and so on).
//
// Field names are the PDF's own. The first row of each worksheet table is
// named after the instruction text above it, cut at 100 characters, so those
// names are copied here exactly rather than generated.

import { buildReport } from '../summary.js';
import { findQuestion } from '../schema.js';
import { choiceLabel } from '../choice.js';
import { text, mdy, my, money, items } from './common.js';

export const TEMPLATE = 'forms/ssa-adult-disability-starter-kit-64-110.pdf';
export const FILE_PREFIX = 'ssa-starter-kit';
export const TITLE = 'Adult Disability Starter Kit — filled in';

export const ADDENDUM = {
  title: 'Additional information for your Adult Disability Starter Kit',
  intro: [
    'These pages were added to the Starter Kit worksheet. They hold the rest of '
    + 'the information the checklist asks you to have ready, and any rows that '
    + 'did not fit on the worksheet. Have them with you when you apply online at '
    + 'www.ssa.gov/apply or at your appointment. Do not mail them to Social Security.',
    'HANDLE WITH CARE: these pages may contain your Social Security number and '
    + 'bank account numbers. Store them somewhere safe.'
  ],
  footer: ['Starter Kit additional information', 'Not an application. Prepared on the applicant\'s own device.']
};

// -- field names ---------------------------------------------------------------

const CHECKLIST = {
  identity: 'Your date of birth, place of birth, and Social Security Number',
  spouses: 'The name, Social Security Number, and date of birth or age of your current spouse and any former spo',
  references: 'If available, the name, address, and phone number of two people (other than your healthcare provider',
  bank: 'Checking or savings account number, including the bank’s 9-digit routing number, for electronic depo',
  workersComp: 'If applicable, workers’ compensation or other disability benefit information including the date of i',
  records: 'Records already in your possession related to your medical condition(s). You do not need to ask for ',
  providers: 'Names, addresses, and phone numbers of healthcare providers (e.g., doctors, psychiatrists, therapist',
  medicines: 'List of medicine(s) you take and why you take them, if known. For prescription medicines, include th',
  tests: 'Names and dates of medical tests you have had or are scheduled to have related to your medical condi',
  jobs: 'A list of the jobs you had in the 5 years before you became unable to work due to your medical condi',
  education: 'Information about your highest level of education completed, and when and where you completed it. If',
  training: 'A list of specialized job, trade, or vocational training and dates completed'
};

const FIRST_ROW = {
  condition: 'List each physical or mental condition (including emotional or learning difficulties) that limits yo',
  provider: 'Please list healthcare providers (e.g., doctors, psychiatrists, therapists, nurse practitioners, hos',
  medicine: 'Please list any medicine(s) you take (prescribed and over-the counter) and why you take them (if kn',
  test: 'Please list any medical tests you had or are going to have in the future. Examples include biopsies,',
  job: 'List the jobs you had in the 5 years before you became unable to work due to your medical condition('
};

const firstOr = (first, rest) => n => (n === 1 ? first : `${rest} ${n}`);
const numbered = name => n => `${name} ${n}`;

const PAY_OPTIONS = findQuestion('pay_frequency')?.options ?? [];

/**
 * The worksheet's five tables. `value` pulls one cell out of a loop item;
 * `field` names the PDF field for row n.
 */
export const TABLES = [
  {
    loop: 'conditions', title: 'A. Medical conditions', itemLabel: 'condition', capacity: 6,
    columns: [
      { label: 'Condition', field: firstOr(FIRST_ROW.condition, 'Condition'), value: it => text(it.name) }
    ]
  },
  {
    loop: 'providers', title: 'B. Medical sources', itemLabel: 'provider', capacity: 5,
    columns: [
      { label: 'Name of healthcare provider', field: firstOr(FIRST_ROW.provider, 'Name of Healthcare provider'), value: it => text(it.name) },
      { label: 'Address', field: numbered('Address'), value: it => text(it.address) },
      { label: 'Phone number', field: numbered('Phone number'), value: it => phoneCell(it.phone) },
      { label: 'Date first seen or admission date', field: numbered('Date First Seen by Provider or Admission Date'), value: it => my(it.first_seen) },
      { label: 'Date last seen or discharge date', field: numbered('Date Last Seen by Provider or Discharge Date'), value: it => my(it.last_seen) }
    ]
  },
  {
    loop: 'medications', title: 'C. Medicines', itemLabel: 'medicine', capacity: 6,
    columns: [
      { label: 'Name of medicine', field: firstOr(FIRST_ROW.medicine, 'Name of medicine'), value: it => text(it.name) },
      { label: 'Why you take it', field: numbered('Why you take it'), value: it => text(it.reason) },
      { label: 'Prescribed by', field: numbered('Prescribed by'), value: it => text(it.prescribed_by) }
    ]
  },
  {
    loop: 'tests', title: 'D. Medical tests', itemLabel: 'test', capacity: 5,
    columns: [
      { label: 'Name of test', field: firstOr(FIRST_ROW.test, 'Name of test'), value: it => text(it.name) },
      { label: 'Provider who sent you', field: numbered('Provider who sent you'), value: it => text(it.ordered_by) },
      { label: 'Date', field: numbered('Date'), value: it => mdy(it.date) }
    ]
  },
  {
    loop: 'jobs', title: 'E. Job history', itemLabel: 'job', capacity: 5,
    columns: [
      { label: 'Job title', field: firstOr(FIRST_ROW.job, 'Job title'), value: it => text(it.job_title) },
      { label: 'Type of business', field: numbered('Type of business'), value: it => text(it.business_type) },
      { label: 'From (month/year)', field: numbered('Date worked from month/year'), value: it => my(it.start) },
      { label: 'To (month/year)', field: numbered('Date worked to month/year'), value: it => my(it.end) },
      { label: 'Hours per day', field: numbered('Hours per day'), value: it => text(it.hours_per_day) },
      { label: 'Days per week', field: numbered('Days per week'), value: it => text(it.days_per_week) },
      { label: 'Rate of pay', field: numbered('Rate of pay amount'), value: it => money(it.pay_amount) },
      { label: 'Frequency', field: numbered('Rate of pay frequency'), value: it => choiceLabel(PAY_OPTIONS, it.pay_frequency) }
    ]
  }
];

function phoneCell(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : text(value);
}

// -- the checklist ---------------------------------------------------------------
//
// A box is ticked when the interview collected that item — including a
// considered "none" (never married, no tests): the point of the checklist is
// being ready, and someone with no tests to list is ready. "Records already in
// your possession" is a stack of paper the interview cannot see, so it is
// left for the applicant to tick.

const answered = v => v !== undefined && v !== null && v !== '';
const answeredList = (a, id) => Array.isArray(a[id]);

const CHECK_RULES = [
  [CHECKLIST.identity, a => answered(a.date_of_birth) && answered(a.birth_city) && answered(a.ssn)],
  [CHECKLIST.spouses, a => answeredList(a, 'marriages')],
  [CHECKLIST.references, a => answered(a.ref1_name)],
  [CHECKLIST.bank, a => answered(a.routing_number) && answered(a.account_number)],
  [CHECKLIST.workersComp, a => typeof a.wc_receives === 'boolean'],
  [CHECKLIST.providers, a => items(a, 'providers').length > 0],
  [CHECKLIST.medicines, a => answeredList(a, 'medications')],
  [CHECKLIST.tests, a => answeredList(a, 'tests')],
  [CHECKLIST.jobs, a => answeredList(a, 'jobs')],
  [CHECKLIST.education, a => answered(a.education_level)],
  [CHECKLIST.training, a => answeredList(a, 'training')]
];

/** Loops the worksheet itself lists; the addendum shows only their overflow. */
const ON_WORKSHEET = new Set(['conditions', 'providers', 'medications', 'tests']);

/**
 * Map an answer set onto the Starter Kit.
 * @returns {{ text, checks, tables, sections, labels }}
 */
export function map(answers) {
  const textFields = {};
  const labels = {};
  const tables = [];

  for (const t of TABLES) {
    const rows = items(answers, t.loop);
    rows.slice(0, t.capacity).forEach((item, i) => {
      for (const col of t.columns) {
        const value = col.value(item);
        if (!value) continue;
        const name = col.field(i + 1);
        textFields[name] = value;
        labels[name] = `${t.title} — row ${i + 1}, ${col.label.toLowerCase()}`;
      }
    });
    // Jobs are listed in full in the addendum (the worksheet has no employer
    // column), so their overflow does not need a table of its own.
    if (rows.length > t.capacity && t.loop !== 'jobs') {
      tables.push({
        title: `${t.title}, continued`,
        itemLabel: t.itemLabel,
        startAt: t.capacity + 1,
        columns: t.columns.map(c => ({ label: c.label })),
        rows: rows.slice(t.capacity).map(item => t.columns.map(c => c.value(item)))
      });
    }
  }

  const checks = CHECK_RULES.filter(([, rule]) => rule(answers)).map(([name]) => name);

  const sections = buildReport(answers, { form: 'ssa' })
    .map(section => ({
      ...section,
      blocks: section.blocks.filter(b => !(b.kind === 'table' && ON_WORKSHEET.has(b.id)))
    }))
    .filter(section => section.blocks.length > 0);

  return { text: textFields, labels, checks, tables, sections };
}
