// Declarative question schema for the SSA disability prep interview.
//
// The entire interview lives here as data. engine.js walks this structure and
// has no per-question logic of its own. Encoded from questions-draft1.md.
//
// Question shape:
//   id        unique within its scope (top level, or within a loop's fields)
//   prompt    the spoken question
//   type      text | date | monthyear | yesno | number | money | ssn | phone | choice | loop
//   required  blocks completion if unanswered (soft — the review pass re-offers)
//   askIf     (scope) => boolean; scope is the answer set, or the loop item for loop fields
//   confirm   read the value back before committing (high-stakes fields)
//   warn      spoken before the question is asked
//   hint      spoken after a clarification miss
//
// Loop shape:
//   type: 'loop', entryPrompt, repeatPrompt, itemLabel, fields[]

export const SECTIONS = [
  {
    id: 'identity',
    title: 'Basic information about you',
    questions: [
      { id: 'first_name', prompt: 'What is your legal first name?', type: 'text', required: true },
      { id: 'last_name', prompt: 'What is your legal last name?', type: 'text', required: true },
      { id: 'date_of_birth', prompt: 'What is your date of birth?', type: 'date', required: true, confirm: true },
      { id: 'birth_city', prompt: 'What city were you born in?', type: 'text', required: true },
      { id: 'birth_state', prompt: 'What state or province were you born in?', type: 'text', required: true },
      { id: 'birth_country', prompt: 'What country were you born in?', type: 'text', required: true },
      {
        id: 'ssn',
        prompt: 'What is your Social Security number?',
        type: 'ssn',
        required: true,
        confirm: true,
        warn: 'Next I need your Social Security number. It stays on this device. You can say skip to leave it blank.',
        hint: 'You can say the nine digits one at a time.'
      }
    ]
  },

  {
    id: 'conditions',
    title: 'Your medical conditions',
    questions: [
      {
        id: 'conditions',
        type: 'loop',
        entryPrompt: 'What is the medical condition that limits your ability to work? If you have more than one, we will take them one at a time.',
        repeatPrompt: 'Do you have another medical condition to add?',
        itemLabel: 'condition',
        entryIsFirstField: true,
        fields: [
          { id: 'name', prompt: 'What is the name of this condition?', type: 'text', required: true, hint: 'If you have cancer, please include the stage and type.' }
        ]
      },
      {
        id: 'onset_date',
        prompt: 'What month and year did your condition begin to limit your ability to work?',
        type: 'monthyear',
        required: true,
        hint: 'An approximate month and year is fine. This is the date your condition started making it hard to work, not the date you stopped working.'
      }
    ]
  },

  {
    id: 'medical_providers',
    title: 'Your doctors, hospitals, and clinics',
    questions: [
      {
        id: 'providers',
        type: 'loop',
        entryPrompt: 'Do you have a doctor, hospital, or clinic to add?',
        repeatPrompt: 'Do you have another doctor, hospital, or clinic to add?',
        itemLabel: 'provider',
        fields: [
          { id: 'name', prompt: 'What is the name of this provider or facility?', type: 'text', required: true },
          { id: 'address', prompt: 'What is the address for this provider or facility?', type: 'text', hint: 'Street, city, and state is enough. You can say skip if you do not have it.' },
          { id: 'phone', prompt: 'What is the phone number for this provider or facility?', type: 'phone' },
          { id: 'first_seen', prompt: 'What date did you first see this provider? If this was a hospital stay, give me the admission date.', type: 'monthyear' },
          { id: 'last_seen', prompt: 'What date did you last see this provider? If this was a hospital stay, give me the discharge date. You can say still seeing them.', type: 'monthyear' }
        ]
      }
    ]
  },

  {
    id: 'medical_tests',
    title: 'Medical tests',
    questions: [
      {
        id: 'tests',
        type: 'loop',
        entryPrompt: 'Have you had, or do you have scheduled, any medical test related to your condition?',
        repeatPrompt: 'Do you have another medical test to add?',
        itemLabel: 'test',
        fields: [
          { id: 'name', prompt: 'What is the name of this test?', type: 'text', required: true },
          { id: 'date', prompt: 'What date was, or will, this test be performed?', type: 'date' },
          { id: 'ordered_by', prompt: 'Who ordered this test?', type: 'text' }
        ]
      }
    ]
  },

  {
    id: 'medications',
    title: 'Your medications',
    questions: [
      {
        id: 'medications',
        type: 'loop',
        entryPrompt: 'Are you currently taking any medication for this condition?',
        repeatPrompt: 'Do you have another medication to add?',
        itemLabel: 'medication',
        fields: [
          { id: 'name', prompt: 'What is the name of this medication?', type: 'text', required: true },
          { id: 'reason', prompt: 'Why do you take it?', type: 'text', hint: 'If you are not sure, you can say skip.' },
          { id: 'prescribed_by', prompt: 'Which provider prescribed it?', type: 'text' }
        ]
      }
    ]
  },

  {
    id: 'workers_comp',
    title: "Workers' compensation",
    questions: [
      { id: 'wc_receives', prompt: "Do you receive workers' compensation or another disability benefit?", type: 'yesno', required: true },
      { id: 'wc_injury_date', prompt: 'What is the date of injury?', type: 'date', askIf: a => a.wc_receives === true },
      { id: 'wc_claim_number', prompt: 'What is the claim number?', type: 'text', askIf: a => a.wc_receives === true },
      { id: 'wc_settlement', prompt: 'Is there a settlement agreement?', type: 'yesno', askIf: a => a.wc_receives === true },
      { id: 'wc_source', prompt: 'What is the source of the payment?', type: 'text', askIf: a => a.wc_receives === true },
      { id: 'wc_amount', prompt: 'What is the payment amount?', type: 'money', askIf: a => a.wc_receives === true }
    ]
  },

  {
    id: 'records_permission',
    title: 'Permission to request your medical records',
    questions: [
      {
        id: 'records_permission',
        prompt: 'Do you give permission for Social Security to request your medical records directly from your providers?',
        type: 'yesno',
        required: true
      }
    ]
  },

  {
    id: 'references',
    title: 'People who know about your condition',
    questions: [
      { id: 'ref1_name', prompt: 'Can you give me the name of one person, other than a medical provider, who knows about your condition?', type: 'text' },
      { id: 'ref1_phone', prompt: "What is that person's phone number?", type: 'phone', askIf: a => !!a.ref1_name },
      { id: 'ref2_name', prompt: 'Can you give me the name of a second such person? This one is optional.', type: 'text', askIf: a => !!a.ref1_name },
      { id: 'ref2_phone', prompt: "What is that person's phone number?", type: 'phone', askIf: a => !!a.ref2_name }
    ]
  },

  {
    id: 'earnings',
    title: 'Your earnings record',
    questions: [
      { id: 'earnings_reviewed', prompt: 'Have you reviewed your Social Security earnings record for accuracy?', type: 'yesno' }
    ]
  },

  {
    id: 'employment',
    title: 'Work in the last 5 years',
    questions: [
      {
        id: 'jobs',
        type: 'loop',
        entryPrompt: 'Did you work a job in the 5 years before your condition began to limit your work?',
        repeatPrompt: 'Did you work another job in that 5 year period?',
        itemLabel: 'job',
        fields: [
          { id: 'employer', prompt: "What was the employer's name?", type: 'text', required: true },
          { id: 'job_title', prompt: 'What was your job title?', type: 'text', hint: 'For example, cook.' },
          { id: 'business_type', prompt: 'What type of business was this?', type: 'text', hint: 'For example, restaurant.' },
          { id: 'start', prompt: 'What month and year did you start this job?', type: 'monthyear' },
          { id: 'end', prompt: 'What month and year did this job end? You can say still working.', type: 'monthyear' },
          { id: 'hours_per_week', prompt: 'On average, how many hours per week did you work this job?', type: 'number' },
          { id: 'pay_rate', prompt: 'What was your pay rate for this job?', type: 'text', hint: 'For example, twenty dollars an hour, or forty thousand a year.' }
        ]
      }
    ]
  },

  {
    id: 'education',
    title: 'Your education',
    questions: [
      { id: 'education_level', prompt: 'What is the highest level of education you completed?', type: 'text' },
      { id: 'education_year', prompt: 'What year did you complete it?', type: 'number' },
      { id: 'education_school', prompt: 'What school or institution did you complete it at?', type: 'text' },
      { id: 'special_ed', prompt: 'Did you receive special education services?', type: 'yesno' },
      { id: 'special_ed_where', prompt: 'Where did you receive special education services?', type: 'text', askIf: a => a.special_ed === true },
      { id: 'special_ed_year', prompt: 'What year did you complete special education services?', type: 'number', askIf: a => a.special_ed === true }
    ]
  },

  {
    id: 'vocational',
    title: 'Job, trade, or vocational training',
    questions: [
      {
        id: 'training',
        type: 'loop',
        entryPrompt: 'Have you completed any specialized job, trade, or vocational training?',
        repeatPrompt: 'Do you have another training program to add?',
        itemLabel: 'training program',
        fields: [
          { id: 'name', prompt: 'What was the name of this training program?', type: 'text', required: true },
          { id: 'completed', prompt: 'What date did you complete it?', type: 'monthyear' }
        ]
      }
    ]
  },

  {
    id: 'marriages',
    title: 'Current and past marriages',
    questions: [
      {
        id: 'marriages',
        type: 'loop',
        entryPrompt: 'Have you ever been married?',
        repeatPrompt: 'Do you have another marriage to add?',
        itemLabel: 'marriage',
        fields: [
          { id: 'spouse_name', prompt: "What is your spouse's or former spouse's full name?", type: 'text', required: true },
          { id: 'spouse_ssn', prompt: "What is your spouse's or former spouse's Social Security number?", type: 'ssn', confirm: true },
          { id: 'spouse_dob', prompt: "What is your spouse's or former spouse's date of birth?", type: 'date' },
          { id: 'marriage_city', prompt: 'What city did you get married in?', type: 'text' },
          { id: 'marriage_state', prompt: 'What state did you get married in?', type: 'text' },
          { id: 'marriage_country', prompt: 'What country did you get married in?', type: 'text' },
          { id: 'marriage_date', prompt: 'What date did you get married?', type: 'date', confirm: true },
          { id: 'still_active', prompt: 'Is this marriage still active?', type: 'yesno', required: true },
          { id: 'divorce_date', prompt: 'What date did you get divorced?', type: 'date', askIf: item => item.still_active === false },
          { id: 'spouse_died', prompt: 'Did this spouse pass away?', type: 'yesno', askIf: item => item.still_active === false },
          { id: 'spouse_death_date', prompt: 'What date did this spouse pass away?', type: 'date', askIf: item => item.spouse_died === true }
        ]
      }
    ]
  },

  {
    id: 'children',
    title: 'Your children',
    questions: [
      {
        id: 'children',
        type: 'loop',
        entryPrompt: 'Do you have a child age 17 or younger, a child age 18 to 19 who is in school full time, or a child of any age with a disability that began at or before age 21?',
        repeatPrompt: 'Do you have another child to add?',
        itemLabel: 'child',
        fields: [
          { id: 'first_name', prompt: "What is this child's first name?", type: 'text', required: true },
          { id: 'last_name', prompt: "What is this child's last name?", type: 'text' }
        ]
      }
    ]
  },

  {
    id: 'household',
    title: 'People who live with you',
    questions: [
      {
        id: 'household',
        type: 'loop',
        entryPrompt: 'Does anyone live with you?',
        repeatPrompt: 'Do you have another household member to add?',
        itemLabel: 'household member',
        fields: [
          { id: 'name', prompt: "What is this person's name?", type: 'text', required: true },
          { id: 'dob', prompt: "What is this person's date of birth?", type: 'date' }
        ]
      }
    ]
  },

  {
    id: 'housing',
    title: 'Your home',
    questions: [
      { id: 'rents', prompt: 'Do you rent your home?', type: 'yesno' },
      { id: 'landlord_name', prompt: "What is your landlord's name?", type: 'text', askIf: a => a.rents === true },
      { id: 'landlord_phone', prompt: "What is your landlord's phone number?", type: 'phone', askIf: a => a.rents === true },
      { id: 'has_rental_contract', prompt: 'Do you have a rental contract on file?', type: 'yesno', askIf: a => a.rents === true },
      { id: 'has_admission_agreement', prompt: 'Do you have an admission agreement on file?', type: 'yesno' },
      { id: 'recent_admission', prompt: 'Have you been admitted to, or discharged from, a hospital or institution recently?', type: 'yesno' },
      { id: 'has_admit_papers', prompt: 'Do you have the admit or discharge papers on file?', type: 'yesno', askIf: a => a.recent_admission === true }
    ]
  },

  {
    id: 'income',
    title: 'Your current income',
    questions: [
      {
        id: 'income_sources',
        type: 'loop',
        entryPrompt: 'Do you currently receive income from any source? That includes pay, self-employment, unemployment, dividends, stocks, a pension, an insurance payout, alimony, child support, gambling winnings, or a state disability payment.',
        repeatPrompt: 'Do you have another income source to add?',
        itemLabel: 'income source',
        fields: [
          { id: 'kind', prompt: 'What type of income is this?', type: 'text', required: true },
          { id: 'monthly_amount', prompt: 'What is the approximate monthly amount?', type: 'money' },
          { id: 'has_documentation', prompt: 'Do you have documentation for this income?', type: 'yesno' }
        ]
      }
    ]
  },

  {
    id: 'resources',
    title: 'Other financial resources',
    questions: [
      {
        id: 'resources',
        type: 'loop',
        entryPrompt: 'Do you have any other financial resource? That includes a bank account, a car title or loan, a burial contract, a trust fund, a life insurance policy, or stocks and bonds.',
        repeatPrompt: 'Do you have another resource to add?',
        itemLabel: 'resource',
        fields: [
          { id: 'kind', prompt: 'What type of resource is this?', type: 'text', required: true },
          { id: 'value', prompt: 'What is the approximate value?', type: 'money' }
        ]
      }
    ]
  },

  {
    id: 'direct_deposit',
    title: 'Direct deposit for benefit payments',
    questions: [
      {
        id: 'routing_number',
        prompt: "What is your bank's 9-digit routing number?",
        type: 'routing',
        confirm: true,
        warn: 'Last section. I need your bank routing and account numbers for direct deposit. They stay on this device. You can say skip to leave them blank.',
        hint: 'You can say the nine digits one at a time.'
      },
      { id: 'account_number', prompt: 'What is your bank account number?', type: 'account', confirm: true }
    ]
  }
];

// ---------------------------------------------------------------------------

/** Field types whose values are read back digit-by-digit for confirmation. */
export const DIGIT_TYPES = new Set(['ssn', 'phone', 'routing', 'account']);

/** Field types that hold personally sensitive values. */
export const SENSITIVE_TYPES = new Set(['ssn', 'routing', 'account']);

/** Section id -> title, for progress announcements. */
export const SECTION_TITLES = Object.fromEntries(SECTIONS.map(s => [s.id, s.title]));

/**
 * Flatten SECTIONS into an ordered list of nodes the engine steps through.
 * Loops stay intact as single nodes; the engine expands them at runtime.
 */
export function flatten(sections = SECTIONS) {
  const nodes = [];
  for (const section of sections) {
    for (const q of section.questions) {
      nodes.push({ ...q, section: section.id, sectionTitle: section.title });
    }
  }
  return nodes;
}

/** Look up a question node (or a loop field) by id, anywhere in the schema. */
export function findQuestion(id, sections = SECTIONS) {
  for (const section of sections) {
    for (const q of section.questions) {
      if (q.id === id) return { ...q, section: section.id, sectionTitle: section.title };
      if (q.type === 'loop') {
        for (const f of q.fields) {
          if (f.id === id) {
            return { ...f, section: section.id, sectionTitle: section.title, loopId: q.id };
          }
        }
      }
    }
  }
  return null;
}
