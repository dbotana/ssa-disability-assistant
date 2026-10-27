// Static interface text, keyed. Every `data-i18n` attribute in index.html
// names one of these keys; tests/i18n.js checks both directions (no key
// missing from the page, no key the page never uses).
//
// Paragraphs that hold inline markup are keyed as a whole: the English value
// is the paragraph's text as a reader sees it, and applyUi() leaves English
// untouched, so the markup survives. Other languages replace the paragraph
// with its translation, which is plain text by design.

export const UI = {
  'page.title': 'Voice Assistant for Disability Forms',
  'page.skip': 'Skip to the interview',
  'header.title': 'Disability Forms by Voice',
  'header.tagline': 'Answer by voice. Get Social Security\'s Adult Disability Starter Kit, '
    + 'Maine\'s Developmental Services Intake Application, or both, filled in and ready to use.',

  'setup.heading': 'Before we start',
  'setup.note_heading': 'Please read this first',
  'setup.note_p1': 'Everything happens on this computer. When you speak, your words are '
    + 'turned into text here, by a speech model stored with this program — the '
    + 'recording is never sent anywhere. Your answers are saved in this browser '
    + 'only, and nothing is sent to any company or server.',
  'setup.note_p2': 'If you choose a PIN below, your answers are saved in this browser, '
    + 'encrypted with it, so you can stop and come back. Your Social Security '
    + 'number and bank numbers are never saved: if you stop partway, you will '
    + 'be asked for them again. Use this on a device you trust and do not use it on a shared or '
    + 'public computer. You can say skip at any sensitive '
    + 'question and fill it in by hand later.',
  'setup.note_p3': 'The first question asks which form you are filling out. This tool fills '
    + 'in the forms for you to review, sign, and send yourself. It does not '
    + 'send anything to the Social Security Administration or to Maine\'s '
    + 'Department of Health and Human Services.',

  'language.legend': 'Language',
  'language.input': 'What language will you speak or type?',
  'language.output': 'What language should I read aloud?',
  'language.screen': 'What language should the screen use?',
  'language.fill': 'What language should the filled-in form use?',

  'mode.legend': 'How do you want to answer?',
  'mode.voice': 'Voice — hold the space bar to talk',
  'mode.handsfree': 'Hands free — I start listening after each question',
  'mode.text': 'Typing — start with the keyboard',
  'mode.help': 'This only sets how the interview starts. Speaking and typing are both '
    + 'available on every question, and you can move between them whenever you '
    + 'like.',

  'confirm.label': 'Read each answer back and wait for me to confirm it',
  'confirm.help': 'With this on I repeat what I heard after every answer, and you press the '
    + 'space bar (or say yes) to keep it. Turn it off to move faster if you can '
    + 'read the screen — your Social Security number, bank numbers and dates are '
    + 'always read back either way, because a wrong digit there is costly.',

  'pin.label': 'PIN to protect your saved answers',
  'pin.help': 'At least 4 characters; longer is safer. Your answers are saved on this '
    + 'computer, encrypted with this PIN, so you can finish later — you will '
    + 'need it to continue. Leave it blank to save nothing: your answers will '
    + 'be lost when you close this page. Saved answers are deleted after 7 '
    + 'days.',

  'sensitive.label': 'Show my Social Security and bank numbers on screen',
  'sensitive.help': 'Off, they show only their last four digits, so they cannot be read '
    + 'over your shoulder or in a screen recording. They are always read '
    + 'aloud in full, so you can check every digit.',

  'import.label': 'Continue from a file you saved',
  'import.help': 'If you saved your answers as a file on another device, choose it here to '
    + 'pick up where you left off. This replaces any answers saved on this '
    + 'device.',

  'resume.button': 'Resume my saved session',
  'discard.button': 'Start over instead',
  'start.button': 'Start the interview',

  'interview.talk': 'Hold to talk',
  'interview.answer_label': 'Or type your answer',
  'interview.submit': 'Submit',
  'interview.lane_help': 'Hold the space bar (or the button) to speak, or press T to '
    + 'type. Press Escape to leave the text box and use the space '
    + 'bar again. When I read an answer back, tap Space to keep it '
    + 'or press N to answer again — you only have to speak if I got '
    + 'it wrong.',

  'readback.accept': 'Yes, that\'s right (Space)',
  'readback.reject': 'No, answer again (N)',

  'commands.repeat': 'Repeat (Enter)',
  'commands.back': 'Go back (B)',
  'commands.skip': 'Skip (S)',
  'commands.where': 'Where am I (W)',
  'commands.correct': 'Change an answer (C)',
  'commands.finish': 'Finish early',

  'details.summary': 'Things you can say at any time',
  'details.keep': 'Space or Yes — after I read back what I heard, to keep it',
  'details.again': 'N or No — answer again, without hearing the question repeated',
  'details.repeat': 'Repeat that — hear the question again',
  'details.back': 'Go back — return to the previous question',
  'details.skip': 'Skip this — leave it blank and move on',
  'details.where': 'Where am I — hear your progress',
  'details.readback': 'Read back my answers — hear what you have given so far',
  'details.save': 'Save and quit — stop and keep your place',
  'details.add': 'Add another condition — from the review screen, to put a new entry on a list',
  'details.restart': 'Start over — erase everything and begin again',

  'review.heading': 'Your forms are ready',
  'review.download_all': 'Download both forms (2 PDFs)',
  'review.download_ssa': 'Download the Adult Disability Starter Kit (PDF)',
  'review.download_ds': 'Download the Developmental Services Intake Application (PDF)',
  'review.download_json': 'Save my answers as a file',
  'review.read_back': 'Read my answers aloud',
  'review.fix': 'Change an answer',
  'review.clear': 'Erase everything from this device'
};
