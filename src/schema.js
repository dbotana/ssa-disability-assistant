// Declarative question schema for the disability forms interview.
//
// The entire interview lives here as data. engine.js walks this structure and
// has no per-question logic of its own.
//
// One interview serves two forms:
//   ssa  Social Security's Adult Disability Starter Kit (SSA-64-110)
//   ds   Maine DHHS's Developmental Services Intake Application
// The first question asks which one — or both — and every section and question
// is tagged with the forms it belongs to. Questions the two forms share are
// asked once. Where the forms want the same fact in different words, the SSA
// wording is asked and the DS form derives its value from it (marital status
// from the marriage history, employment history from the job list); the
// DS-only version is asked only when the Starter Kit was not chosen.
//
// Question shape:
//   id          unique across the whole schema (loop fields: within their loop)
//   prompt      the spoken question
//   type        text | date | monthyear | yesno | number | money | ssn | phone |
//               routing | account | zip | email | choice | loop
//   options     choice only: [{ value, label, letter?, aliases?, impliedBy? }]
//   required    blocks completion if unanswered (soft — the review pass re-offers)
//   forms       the forms this question belongs to; defaults to its section's
//   askIf       (scope) => boolean; scope is the answer set, or the loop item for
//               loop fields. On a loop node it is checked against the answer set
//               and skips the whole loop.
//   allowFuture a date that may lie ahead (a scheduled test, a graduation)
//   confirm     read the value back before committing (high-stakes fields)
//   warn        spoken before the question is asked
//   hint        spoken after a clarification miss
//
// Loop shape:
//   type: 'loop', entryPrompt, repeatPrompt, itemLabel, fields[]

export const SCHEMA_VERSION = 3;

// -- forms -------------------------------------------------------------------

export const FORM_IDS = ['ssa', 'ds'];

export const FORM_TITLES = {
  ssa: 'Adult Disability Starter Kit',
  ds: 'Developmental Services Intake Application'
};

const FORM_OPTIONS = [
  {
    value: 'ssa',
    label: 'Adult Disability Starter Kit',
    aliases: ['starter kit', 'the starter kit', 'disability starter kit', 'the kit', 'kit',
      'social security', 'social security form', 'ssa']
  },
  {
    value: 'ds',
    label: 'Developmental Services Intake Application',
    aliases: ['developmental services', 'developmental services application',
      'developmental services intake', 'developmental', 'ds', 'ds intake', 'intake application',
      'the maine application', 'maine application', 'maine form', 'maine', 'dhhs', 'oads']
  },
  {
    value: 'both',
    label: 'Both forms',
    aliases: ['both', 'both of them', 'both forms', 'all of them', 'the two of them'],
    impliedBy: ['ssa', 'ds']
  }
];

/**
 * The set of forms this answer set is filling out.
 *
 * A missing or unrecognized answer reads as the Starter Kit alone. Every
 * session saved before the form question existed was a Starter Kit session,
 * and treating them that way is what lets them resume unchanged.
 */
export function formsOf(answers) {
  switch (answers?.forms) {
    case 'ds': return new Set(['ds']);
    case 'both': return new Set(['ssa', 'ds']);
    default: return new Set(['ssa']);
  }
}

export const hasForm = (answers, form) => formsOf(answers).has(form);

/** Has the user actually answered the form question yet? */
export const formsChosen = answers =>
  ['ssa', 'ds', 'both'].includes(answers?.forms);

/** Does a `forms` tag (null meaning every form) overlap the chosen forms? */
export function formsMatch(forms, answers) {
  if (!forms) return true;
  const chosen = formsOf(answers);
  return forms.some(f => chosen.has(f));
}

const ssa = a => hasForm(a, 'ssa');
const ds = a => hasForm(a, 'ds');
const dsOnly = a => ds(a) && !ssa(a);

// -- shared option lists -------------------------------------------------------

/** The DS form's A–E scale, used by sections 7 through 12. */
export const RATING_OPTIONS = [
  { value: 'A', letter: 'A', label: 'Independent',
    aliases: ['independent', 'independently', 'on my own', 'on their own', 'by myself', 'by themselves', 'alone'] },
  { value: 'B', letter: 'B', label: 'Needs supervision',
    aliases: ['needs supervision', 'supervision', 'supervised', 'someone watching', 'reminders', 'prompting'] },
  { value: 'C', letter: 'C', label: 'Needs skills training',
    aliases: ['needs skills training', 'skills training', 'skill training', 'training', 'still learning', 'needs to learn'] },
  { value: 'D', letter: 'D', label: 'Needs physical assistance',
    aliases: ['needs physical assistance', 'physical assistance', 'physical help', 'hands on help', 'assistance'] },
  { value: 'E', letter: 'E', label: 'Total care',
    aliases: ['total care', 'full care', 'complete care', 'total assistance', 'does it for me', 'does it for them'] }
];

const PAY_FREQUENCY_OPTIONS = [
  { value: 'hour', label: 'Per hour', aliases: ['hour', 'hourly', 'an hour', 'per hour', 'by the hour'] },
  { value: 'day', label: 'Per day', aliases: ['day', 'daily', 'a day', 'per day'] },
  { value: 'week', label: 'Per week', aliases: ['week', 'weekly', 'a week', 'per week'] },
  { value: 'biweekly', label: 'Every two weeks',
    aliases: ['every two weeks', 'every 2 weeks', 'biweekly', 'bi weekly', 'every other week'] },
  { value: 'twice_month', label: 'Twice a month',
    aliases: ['twice a month', 'twice monthly', 'semimonthly', 'semi monthly'] },
  { value: 'month', label: 'Per month', aliases: ['month', 'monthly', 'a month', 'per month'] },
  { value: 'year', label: 'Per year', aliases: ['year', 'yearly', 'annually', 'annual', 'a year', 'per year', 'salary'] }
];

const MARITAL_OPTIONS = [
  { value: 'never_married', label: 'Never married', aliases: ['never married', 'never been married', 'single'] },
  { value: 'married', label: 'Married', aliases: ['married'] },
  { value: 'separated', label: 'Separated', aliases: ['separated'] },
  { value: 'divorced', label: 'Divorced', aliases: ['divorced'] },
  { value: 'widowed', label: 'Widowed', aliases: ['widowed', 'widow', 'widower'] }
];

const GENDER_OPTIONS = [
  { value: 'M', letter: 'M', label: 'Male', aliases: ['male', 'man', 'boy'] },
  { value: 'F', letter: 'F', label: 'Female', aliases: ['female', 'woman', 'girl'] }
];

// -- DS sections 7–12: the rated activities ------------------------------------
//
// Each activity becomes two questions: `<key>_level`, a rating on the A–E
// scale, and `<key>_explain`, asked only when the rating is not A. `label` is
// the form's own wording, `say` is how the question names it out loud, and
// `short` is what someone correcting it later would call it.

export const RATING_GROUPS = [
  {
    id: 'adl', title: 'Daily living activities',
    activities: [
      { key: 'eating', label: 'Eating', say: 'Eating', short: 'eating' },
      { key: 'dressing', label: 'Dressing', say: 'Dressing', short: 'dressing' },
      { key: 'toileting', label: 'Toileting', say: 'Using the toilet', short: 'toileting' },
      { key: 'bathing', label: 'Bathing', say: 'Bathing', short: 'bathing' },
      { key: 'grooming', label: 'Grooming', say: 'Grooming, such as brushing teeth and hair', short: 'grooming' },
      { key: 'mobility', label: 'Mobility', say: 'Mobility, meaning getting around', short: 'mobility' }
    ]
  },
  {
    id: 'safety', title: 'Safety',
    activities: [
      { key: 'physical_danger', label: 'Avoidance of physical danger', say: 'Avoiding physical danger', short: 'physical danger' },
      { key: 'emotional_jeopardy', label: 'Avoidance of emotional jeopardy', say: 'Avoiding emotional harm', short: 'emotional harm' },
      { key: 'healthy_relationships', label: 'Engagement in healthy relationships', say: 'Keeping relationships healthy', short: 'healthy relationships' },
      { key: 'judgment', label: 'Judgment regarding personal conduct', say: 'Judgment about personal conduct', short: 'judgment' }
    ]
  },
  {
    id: 'household_activities', title: 'Household activities',
    activities: [
      { key: 'cooking', label: 'Cooking', say: 'Cooking', short: 'cooking' },
      { key: 'laundry', label: 'Laundry', say: 'Laundry', short: 'laundry' }
    ]
  },
  {
    id: 'community', title: 'Getting around the community',
    activities: [
      { key: 'shopping', label: 'Shopping', say: 'Shopping', short: 'shopping' },
      { key: 'transportation', label: 'Transportation', say: 'Transportation', short: 'transportation' },
      { key: 'banking', label: 'Banking', say: 'Banking and handling money', short: 'banking' },
      { key: 'recreation', label: 'Recreation', say: 'Recreation', short: 'recreation' }
    ]
  },
  {
    id: 'relationships', title: 'Keeping up relationships',
    activities: [
      { key: 'rel_family', label: 'Family', say: 'Relationships with family', short: 'family relationships' },
      { key: 'rel_friends', label: 'Friends', say: 'Relationships with friends', short: 'friends' },
      { key: 'rel_coworkers', label: 'Coworkers', say: 'Relationships with coworkers', short: 'coworkers' },
      { key: 'rel_support_staff', label: 'Support staff', say: 'Relationships with support staff', short: 'support staff' }
    ]
  },
  {
    id: 'communication', title: 'Communication',
    activities: [
      { key: 'expressive', label: 'Expressive communication', say: 'Expressing yourself, called expressive communication', short: 'expressive communication' },
      { key: 'receptive', label: 'Receptive communication', say: 'Understanding others, called receptive communication', short: 'receptive communication' },
      { key: 'sign_language', label: 'Sign language', say: 'Sign language', short: 'sign language', optional: true },
      { key: 'visual_gestural', label: 'Visual or gestural', say: 'Visual or gestural communication, such as pointing or pictures', short: 'visual communication', optional: true }
    ]
  }
];

const SCALE_HINT = 'Say independent, needs supervision, needs skills training, '
  + 'needs physical assistance, or total care. Or say the letter, A through E.';

const SCALE_WARN = 'For each of the next activities, tell me which fits best: '
  + 'A, independent. B, needs supervision. C, needs skills training. '
  + 'D, needs physical assistance. Or E, total care. '
  + 'If it is anything but independent, I will ask you to explain briefly.';

function ratingSection(group) {
  const questions = [];
  group.activities.forEach((act, i) => {
    const level = `${act.key}_level`;
    questions.push({
      id: level,
      prompt: `${act.say}. Which fits best?`,
      type: 'choice',
      options: RATING_OPTIONS,
      warn: i === 0 ? SCALE_WARN : undefined,
      hint: act.optional ? `${SCALE_HINT} If this does not apply, say skip.` : SCALE_HINT
    });
    questions.push({
      id: `${act.key}_explain`,
      prompt: `Briefly, what help is needed with ${act.short}?`,
      type: 'text',
      askIf: a => a[level] != null && a[level] !== '' && a[level] !== 'A',
      hint: 'For example, who helps, and how often. You can say skip.'
    });
  });
  return { id: group.id, title: group.title, forms: ['ds'], questions };
}

// -- the interview -------------------------------------------------------------

export const SECTIONS = [
  {
    id: 'forms',
    title: 'Choosing your form',
    questions: [
      {
        id: 'forms',
        prompt: "Which form are we filling out today: Social Security's Adult Disability Starter Kit, Maine's Developmental Services Intake Application, or both?",
        type: 'choice',
        options: FORM_OPTIONS,
        required: true,
        hint: 'The Starter Kit helps you get ready to apply for Social Security disability benefits. '
          + 'The Developmental Services application is how adults with an intellectual disability or autism apply to Maine for services. '
          + 'Say starter kit, developmental services, or both.'
      }
    ]
  },

  {
    id: 'ds_helper',
    title: 'Who is filling out this application',
    forms: ['ds'],
    questions: [
      { id: 'for_self', prompt: 'Are you filling out this application for yourself?', type: 'yesno', required: true,
        hint: 'Say no if you are a parent, guardian, caseworker, or anyone else helping the person applying.' },
      {
        id: 'helper_name',
        prompt: 'What is your name, or the name of your agency?',
        type: 'text',
        askIf: a => a.for_self === false,
        warn: 'Thank you for helping. From here on, every question is about the person applying, even when I say you. First, a few details about you.'
      },
      { id: 'helper_address', prompt: 'What is your mailing address? Just the street or post office box for now.', type: 'text', askIf: a => a.for_self === false },
      { id: 'helper_city', prompt: 'What town or city is that in?', type: 'text', askIf: a => a.for_self === false, hint: 'If it is outside Maine, include the state too.' },
      { id: 'helper_county', prompt: 'What county is that in?', type: 'text', askIf: a => a.for_self === false },
      { id: 'helper_zip', prompt: 'What is the zip code?', type: 'zip', askIf: a => a.for_self === false },
      { id: 'helper_phone', prompt: 'What is your phone number?', type: 'phone', askIf: a => a.for_self === false },
      { id: 'helper_fax', prompt: 'What is your fax number? Say skip if you do not have one.', type: 'phone', askIf: a => a.for_self === false },
      { id: 'helper_email', prompt: 'What is your email address?', type: 'email', askIf: a => a.for_self === false,
        hint: 'You can say it like john dot smith at gmail dot com, or say skip.' }
    ]
  },

  {
    id: 'identity',
    title: 'Basic information about you',
    forms: ['ssa', 'ds'],
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
        warn: 'Next I need your Social Security number. It is saved only on this device, and it is never sent to Social Security. You can say skip to leave it blank, or type it instead of saying it.',
        hint: 'You can say the nine digits one at a time.'
      }
    ]
  },

  {
    id: 'ds_contact',
    title: 'Your address and background',
    forms: ['ds'],
    questions: [
      { id: 'home_street', prompt: 'What is your street address?', type: 'text', hint: 'Just the number and street. I will ask for the town next.' },
      { id: 'home_town', prompt: 'What town or city do you live in?', type: 'text' },
      { id: 'home_state', prompt: 'What state do you live in?', type: 'text' },
      { id: 'home_zip', prompt: 'What is your zip code?', type: 'zip' },
      { id: 'mailing_different', prompt: 'Is your mailing address different from your street address?', type: 'yesno' },
      { id: 'mailing_address', prompt: 'What is your full mailing address, including the town, state, and zip code?', type: 'text', askIf: a => a.mailing_different === true },
      { id: 'applicant_phone', prompt: 'What is your phone number?', type: 'phone' },
      { id: 'applicant_email', prompt: 'What is your email address? Say skip if you do not have one.', type: 'email',
        hint: 'You can say it like john dot smith at gmail dot com.' },
      { id: 'primary_language', prompt: 'What is your primary language?', type: 'text' },
      { id: 'deaf_hoh', prompt: 'Are you deaf or hard of hearing?', type: 'yesno' },
      {
        id: 'gender',
        prompt: 'The form asks for gender, and it only offers male or female. Which should I put?',
        type: 'choice',
        options: GENDER_OPTIONS,
        hint: 'Say male or female, or say skip to leave it blank.'
      },
      { id: 'mainecare_number', prompt: 'What is your MaineCare number? Say skip if you do not have one.', type: 'text' },
      {
        id: 'marital_status',
        prompt: 'What is your marital status: never married, married, separated, divorced, or widowed?',
        type: 'choice',
        options: MARITAL_OPTIONS,
        // With the Starter Kit, the marriage history answers this.
        askIf: dsOnly
      }
    ]
  },

  {
    id: 'guardian',
    title: 'Guardian or power of attorney',
    forms: ['ds'],
    questions: [
      { id: 'has_guardian', prompt: 'Do you have a legal guardian, or someone with power of attorney for you?', type: 'yesno' },
      {
        id: 'guardian_name',
        prompt: 'What is their full name?',
        type: 'text',
        askIf: a => a.has_guardian === true,
        warn: 'Maine asks for a copy of the guardianship or power of attorney paperwork to be sent with this application.'
      },
      { id: 'guardian_relationship', prompt: 'How are they related to you?', type: 'text', askIf: a => a.has_guardian === true,
        hint: 'For example, parent, sister, or professional guardian.' },
      { id: 'guardian_address', prompt: 'What is their mailing address? Just the street or post office box for now.', type: 'text', askIf: a => a.has_guardian === true },
      { id: 'guardian_city', prompt: 'What town or city is that in?', type: 'text', askIf: a => a.has_guardian === true, hint: 'If it is outside Maine, include the state too.' },
      { id: 'guardian_county', prompt: 'What county is that in?', type: 'text', askIf: a => a.has_guardian === true },
      { id: 'guardian_zip', prompt: 'What is the zip code?', type: 'zip', askIf: a => a.has_guardian === true },
      { id: 'guardian_phone', prompt: 'What is their phone number?', type: 'phone', askIf: a => a.has_guardian === true },
      { id: 'guardian_email', prompt: 'What is their email address? Say skip if you do not know it.', type: 'email', askIf: a => a.has_guardian === true }
    ]
  },

  {
    id: 'emergency',
    title: 'Emergency contact',
    forms: ['ds'],
    questions: [
      { id: 'ec_same_as_guardian', prompt: 'Should your guardian also be listed as your emergency contact?', type: 'yesno', askIf: a => a.has_guardian === true },
      {
        id: 'ec_name',
        prompt: 'Who should be contacted in an emergency? Tell me their full name.',
        type: 'text',
        askIf: needsEmergencyContact,
        hint: 'Usually a guardian or your closest family member. Say skip to leave this blank.'
      },
      { id: 'ec_relationship', prompt: 'How are they related to you?', type: 'text', askIf: hasEmergencyContact },
      { id: 'ec_address', prompt: 'What is their street address?', type: 'text', askIf: hasEmergencyContact },
      { id: 'ec_city', prompt: 'What town or city is that in?', type: 'text', askIf: hasEmergencyContact, hint: 'If it is outside Maine, include the state too.' },
      { id: 'ec_county', prompt: 'What county is that in?', type: 'text', askIf: hasEmergencyContact },
      { id: 'ec_zip', prompt: 'What is the zip code?', type: 'zip', askIf: hasEmergencyContact },
      { id: 'ec_phone', prompt: 'What is their phone number?', type: 'phone', askIf: hasEmergencyContact },
      { id: 'ec_email', prompt: 'What is their email address? Say skip if you do not know it.', type: 'email', askIf: hasEmergencyContact }
    ]
  },

  {
    id: 'conditions',
    title: 'Your medical conditions',
    forms: ['ssa', 'ds'],
    questions: [
      {
        id: 'conditions',
        type: 'loop',
        askIf: ssa,
        entryPrompt: 'What is the medical condition that limits your ability to work? If you have more than one, we will take them one at a time.',
        repeatPrompt: 'Do you have another medical condition to add?',
        itemLabel: 'condition',
        entryIsFirstField: true,
        fields: [
          { id: 'name', prompt: 'What is the name of this condition?', type: 'text', required: true, hint: 'If you have cancer, please include the stage and type.' }
        ]
      },
      {
        // The Starter Kit asks only for conditions that limit work. Without it,
        // the DS form wants every current diagnosis.
        id: 'diagnoses',
        type: 'loop',
        askIf: dsOnly,
        entryPrompt: 'Do you have a current diagnosis to list? It can be any physical, mental, or developmental condition.',
        repeatPrompt: 'Do you have another diagnosis to list?',
        itemLabel: 'diagnosis',
        fields: [
          { id: 'name', prompt: 'What is the diagnosis?', type: 'text', required: true }
        ]
      },
      {
        id: 'onset_date',
        prompt: 'What month and year did your condition begin to limit your ability to work?',
        type: 'monthyear',
        required: true,
        forms: ['ssa'],
        hint: 'An approximate month and year is fine. This is the date your condition started making it hard to work, not the date you stopped working.'
      }
    ]
  },

  {
    id: 'ds_health',
    title: 'Allergies, diet, and developmental diagnosis',
    forms: ['ds'],
    questions: [
      { id: 'medication_allergies', prompt: 'Do you have any medication allergies? Tell me what they are, or say none.', type: 'text' },
      { id: 'food_allergies', prompt: 'Any food allergies? Tell me what they are, or say none.', type: 'text' },
      { id: 'environmental_allergies', prompt: 'Any environmental allergies, such as pollen, dust, or animals? Tell me what they are, or say none.', type: 'text' },
      { id: 'dietary_restrictions', prompt: 'Do you have any dietary restrictions? Tell me what they are, or say none.', type: 'text' },
      { id: 'has_idd_dx', prompt: 'Have you been diagnosed with an intellectual disability, a developmental disability, or autism?', type: 'yesno' },
      { id: 'idd_dx_date', prompt: 'About when were you diagnosed? A month and year is fine.', type: 'monthyear', askIf: a => a.has_idd_dx === true,
        hint: 'If you do not know, say skip.' },
      { id: 'idd_age_at_dx', prompt: 'How old were you when you were diagnosed?', type: 'number', askIf: a => a.has_idd_dx === true },
      {
        id: 'idd_diagnoses',
        type: 'loop',
        askIf: a => a.has_idd_dx === true,
        entryPrompt: 'Has a psychological evaluation with IQ and adaptive scores confirmed a diagnosis?',
        repeatPrompt: 'Did the evaluation confirm another diagnosis?',
        itemLabel: 'confirmed diagnosis',
        fields: [
          { id: 'name', prompt: 'What is the confirmed diagnosis?', type: 'text', required: true }
        ]
      }
    ]
  },

  {
    id: 'medical_providers',
    title: 'Your doctors, hospitals, and clinics',
    forms: ['ssa'],
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
    forms: ['ssa'],
    questions: [
      {
        id: 'tests',
        type: 'loop',
        entryPrompt: 'Have you had, or do you have scheduled, any medical test related to your condition?',
        repeatPrompt: 'Do you have another medical test to add?',
        itemLabel: 'test',
        fields: [
          { id: 'name', prompt: 'What is the name of this test?', type: 'text', required: true },
          { id: 'date', prompt: 'What date was, or will, this test be performed?', type: 'date', allowFuture: true },
          { id: 'ordered_by', prompt: 'Who ordered this test?', type: 'text' }
        ]
      }
    ]
  },

  {
    id: 'medications',
    title: 'Your medications',
    forms: ['ssa', 'ds'],
    questions: [
      {
        id: 'medications',
        type: 'loop',
        entryPrompt: 'Are you currently taking any medicine, prescribed or over the counter?',
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
    forms: ['ssa'],
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
    forms: ['ssa'],
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
    forms: ['ssa'],
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
    forms: ['ssa'],
    questions: [
      { id: 'earnings_reviewed', prompt: 'Have you reviewed your Social Security earnings record for accuracy?', type: 'yesno' }
    ]
  },

  {
    id: 'employment',
    title: 'Your work history',
    forms: ['ssa', 'ds'],
    questions: [
      {
        id: 'jobs',
        type: 'loop',
        askIf: ssa,
        entryPrompt: 'Did you work a job in the 5 years before your condition began to limit your work?',
        repeatPrompt: 'Did you work another job in that 5 year period?',
        itemLabel: 'job',
        fields: [
          { id: 'employer', prompt: "What was the employer's name?", type: 'text', required: true },
          { id: 'job_title', prompt: 'What was your job title?', type: 'text', hint: 'For example, cook.' },
          { id: 'business_type', prompt: 'What type of business was this?', type: 'text', hint: 'For example, restaurant.' },
          { id: 'start', prompt: 'What month and year did you start this job?', type: 'monthyear' },
          { id: 'end', prompt: 'What month and year did this job end? You can say still working.', type: 'monthyear' },
          { id: 'hours_per_day', prompt: 'On average, how many hours a day did you work at this job?', type: 'number' },
          { id: 'days_per_week', prompt: 'And how many days a week?', type: 'number' },
          {
            id: 'pay_amount',
            prompt: 'How much were you paid? Just the amount for now.',
            type: 'money',
            hint: 'For example, twenty dollars. I will ask next whether that was per hour, per week, or some other period.'
          },
          {
            id: 'pay_frequency',
            prompt: 'Was that per hour, per day, per week, every two weeks, twice a month, per month, or per year?',
            type: 'choice',
            options: PAY_FREQUENCY_OPTIONS,
            askIf: item => item.pay_amount != null && item.pay_amount !== ''
          }
        ]
      },
      { id: 'currently_employed', prompt: 'Are you working right now?', type: 'yesno', forms: ['ds'] },
      {
        // The DS form wants an employment history of any length, not the
        // Starter Kit's five-year window. Asked only when the Kit is not.
        id: 'ds_jobs',
        type: 'loop',
        askIf: dsOnly,
        entryPrompt: 'Have you ever had a job? It can be paid, part time, or supported employment.',
        repeatPrompt: 'Have you had another job?',
        itemLabel: 'job',
        fields: [
          { id: 'employer', prompt: 'Where did you work?', type: 'text', required: true },
          { id: 'job_title', prompt: 'What was your job there?', type: 'text', hint: 'For example, stocking shelves.' },
          { id: 'start', prompt: 'What month and year did you start?', type: 'monthyear' },
          { id: 'end', prompt: 'What month and year did it end? You can say still working.', type: 'monthyear' }
        ]
      },
      { id: 'vr_involvement', prompt: 'Have you worked with Vocational Rehabilitation? If so, tell me briefly what they helped with. If not, say no.', type: 'text', forms: ['ds'] },
      { id: 'volunteer_experience', prompt: 'Have you done any volunteer work? If so, tell me about it, or say none.', type: 'text', forms: ['ds'] }
    ]
  },

  {
    id: 'education',
    title: 'Your education',
    forms: ['ssa', 'ds'],
    questions: [
      { id: 'in_school', prompt: 'Are you going to school right now?', type: 'yesno', forms: ['ds'] },
      { id: 'graduation_date', prompt: 'When do you expect to graduate? A month and year is fine.', type: 'monthyear', allowFuture: true,
        forms: ['ds'], askIf: a => a.in_school === true },
      { id: 'education_level', prompt: 'What is the highest level of education you completed?', type: 'text' },
      { id: 'education_year', prompt: 'What year did you complete it?', type: 'number', forms: ['ssa'] },
      { id: 'education_school', prompt: 'What school or institution did you complete it at?', type: 'text' },
      { id: 'special_ed', prompt: 'Did you receive special education services?', type: 'yesno' },
      { id: 'special_ed_where', prompt: 'Where did you receive special education services?', type: 'text', forms: ['ssa'], askIf: a => a.special_ed === true },
      { id: 'special_ed_year', prompt: 'What year did you complete special education services?', type: 'number', forms: ['ssa'], askIf: a => a.special_ed === true },
      { id: 'has_504_plan', prompt: 'Have you ever had a 504 plan at school?', type: 'yesno', forms: ['ds'] },
      { id: 'psychoed_eval', prompt: 'Have you had a psychoeducational evaluation?', type: 'yesno', forms: ['ds'],
        hint: 'That is an evaluation of learning and thinking skills, often done through school.' }
    ]
  },

  {
    id: 'vocational',
    title: 'Job, trade, or vocational training',
    forms: ['ssa'],
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
    forms: ['ssa'],
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
    forms: ['ssa'],
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
    forms: ['ssa', 'ds'],
    questions: [
      {
        id: 'living_arrangement',
        prompt: 'What is your current living arrangement? For example, living with family, in your own apartment, or in a group home.',
        type: 'text',
        forms: ['ds']
      },
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
    forms: ['ssa'],
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
    forms: ['ssa'],
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
    forms: ['ssa'],
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

  ...RATING_GROUPS.map(ratingSection),

  {
    id: 'ds_documents',
    title: 'Documents to send with the application',
    forms: ['ds'],
    questions: [
      {
        id: 'has_comprehensive_eval',
        prompt: 'Do you have a comprehensive evaluation, done by a licensed physician or psychologist?',
        type: 'yesno',
        warn: 'Maine asks for some evaluations to be sent with this application. I will ask which ones you already have. If you do not have them, the intake coordinator can arrange them.'
      },
      { id: 'has_adaptive_test', prompt: 'Do you have a completed adaptive behavior test?', type: 'yesno' },
      { id: 'has_iq_test', prompt: 'Do you have a completed intelligence test, sometimes called an IQ test?', type: 'yesno' },
      { id: 'has_other_assessments', prompt: 'Do you have any other assessments, such as a psychosocial evaluation or an education plan, called an IEP?', type: 'yesno' }
    ]
  },

  {
    id: 'direct_deposit',
    title: 'Direct deposit for benefit payments',
    forms: ['ssa'],
    questions: [
      {
        id: 'routing_number',
        prompt: "What is your bank's 9-digit routing number?",
        type: 'routing',
        confirm: true,
        warn: 'Last section. I need your bank routing and account numbers for direct deposit. They are saved only on this device, and they are never sent to Social Security. You can say skip to leave them blank, or type them instead of saying them.',
        hint: 'You can say the nine digits one at a time.'
      },
      { id: 'account_number', prompt: 'What is your bank account number?', type: 'account', confirm: true }
    ]
  }
];

function needsEmergencyContact(a) {
  return !(a.has_guardian === true && a.ec_same_as_guardian === true);
}

function hasEmergencyContact(a) {
  return needsEmergencyContact(a) && !!a.ec_name;
}

// ---------------------------------------------------------------------------

/** Field types whose values are read back digit-by-digit for confirmation. */
export const DIGIT_TYPES = new Set(['ssn', 'phone', 'routing', 'account', 'zip']);

/** Field types that hold personally sensitive values. */
export const SENSITIVE_TYPES = new Set(['ssn', 'routing', 'account']);

/** Section id -> title, for progress announcements. */
export const SECTION_TITLES = Object.fromEntries(SECTIONS.map(s => [s.id, s.title]));

/**
 * Flatten SECTIONS into an ordered list of nodes the engine steps through.
 * Loops stay intact as single nodes; the engine expands them at runtime. Each
 * node carries its effective `forms`: its own tag, else its section's.
 */
export function flatten(sections = SECTIONS) {
  const nodes = [];
  for (const section of sections) {
    for (const q of section.questions) {
      nodes.push({
        ...q,
        forms: q.forms ?? section.forms ?? null,
        section: section.id,
        sectionTitle: section.title
      });
    }
  }
  return nodes;
}

/**
 * Is this top-level node part of the interview for these answers?
 *
 * It must belong to a chosen form, and its askIf (checked against the answer
 * set — for a loop node too) must hold. A throwing askIf counts as true: a bad
 * predicate must never strand the interview.
 */
export function nodeActive(node, answers) {
  if (!node) return false;
  if (!formsMatch(node.forms, answers)) return false;
  if (typeof node.askIf !== 'function') return true;
  try {
    return !!node.askIf(answers ?? {});
  } catch {
    return true;
  }
}

/** Does this section belong to one of the chosen forms? */
export function sectionActive(section, answers) {
  return formsMatch(section.forms ?? null, answers);
}

/**
 * How many sections each possible form choice produces, for pre-synthesizing
 * every "Section 3 of N." the interview can say.
 */
export function sectionCountsByForm(sections = SECTIONS) {
  const counts = new Set();
  for (const forms of ['ssa', 'ds', 'both']) {
    counts.add(sections.filter(s => sectionActive(s, { forms })).length);
  }
  return [...counts];
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
