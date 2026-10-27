// Every dynamic string the interview builds at runtime, as an English
// template. Static wording lives in phrases.js or ui.js; these are the ones
// that carry a value, a count, or a section name.
//
// A template may use {placeholders}. message() substitutes them in one pass,
// so a substituted value is never re-scanned for placeholders. For English the
// rendering is byte-identical to the string the code produced before this
// module existed; tests/i18n.js pins a representative set.

export const MESSAGES = {
  // -- sections and progress -------------------------------------------------
  section_of: 'Section {number} of {count}.',
  section_label_with_count: 'Section {number} of {count} — {title}',
  changing_answer: 'Changing an answer — {section}',
  adding_item: 'Adding a {item} — {section}',
  time_left: '{time} left.',
  item_number: '{item} {number}.',
  progress_line: '{percent}% done · {time} left',
  progress_only: '{percent}% done',

  // -- start-up notices -------------------------------------------------------
  no_pin_warning: 'You did not set a PIN, so nothing is being saved. '
    + 'If you close this page, your answers will be lost.',
  withheld_warning: 'For your security, your Social Security and bank numbers were not saved when you '
    + 'stopped last time. I will ask for them again before your forms are ready.',
  stt_unavailable: 'Voice answers in this language need a speech model that is not installed on this computer. You can type your answers.',

  // -- microphone status ------------------------------------------------------
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  you_said: 'You said: {text}',
  recorded: 'Recorded: {value}',

  // -- read-back --------------------------------------------------------------
  readback_heard: 'I heard {value}. Is that correct?',
  readback_typed: 'I have {value}. Is that correct? Type yes or no.',
  accept_hint: 'Press the space bar to keep it, or N to answer again. '
    + 'You can also say yes or no.',

  // -- where am I -------------------------------------------------------------
  where_section: 'You are in section {number} of {count}, {title}.',
  where_start: 'You are at the start, choosing which form to fill out.',
  where_done_left: '{where} About {percent} percent done, {time} left at the pace you have been going.',
  where_done: '{where} About {percent} percent done.',

  // -- saving -----------------------------------------------------------------
  saved_ok: 'Saved, encrypted with your PIN. Your place is kept on this device.',
  nothing_saved: 'Nothing is being saved, because no PIN was set when you started. '
    + 'If you close this page, your answers will be lost.',

  // -- correcting -------------------------------------------------------------
  change_answer_label: 'Changing an answer',
  which_answer: 'Which answer would you like to change?',
  which_answer_hint: 'Name a field, such as "my date of birth" or "the first job\'s employer". '
    + 'To put a new entry on a list, say "add another condition". '
    + 'To delete a whole entry, say "remove the second provider".',
  did_not_catch_options: 'I did not catch which one. {options}',
  did_you_mean: 'Did you mean: {list}. Say the number, or the name.',
  not_found_answer: 'I could not find an answer by that name. '
    + 'You can name it the way I asked it, for example, my date of birth, '
    + 'or say never mind to go back.',
  could_not_open_answer: 'I could not open that answer. Try naming a different one, or say never mind.',
  target_blank: '{what} is blank right now.',
  target_current: 'Right now {what} is {value}.',
  what_instead: '{heard} What should it be instead?',
  now_value: '{what} is now {value}.',
  change_failed: 'That answer could not be changed.',
  back_to_question: '{note} Back to your question.',
  no_changes: 'No changes made.',

  // -- review -----------------------------------------------------------------
  missing_tail_one: ' {count} required answer is still blank.',
  missing_tail_many: ' {count} required answers are still blank.',
  review_note: '{note}{tail} You can change another answer, or download your forms.',
  finish_missing_one: 'Your answers are ready. {count} required answer is still blank: {prompts} '
    + 'You can change an answer, or download your forms as they are.',
  finish_missing_many: 'Your answers are ready. {count} required answers are still blank: {prompts} '
    + 'You can change an answer, or download your forms as they are.',

  // -- withheld after a resume or the idle lock -------------------------------
  cleared_idle: 'I cleared this while the page was not in use.',
  not_saved_again: 'This was not saved when you stopped last time, for your security.',
  this_one_is: ' This one is for {item} {number}.',
  before_fill: 'Before I fill in your forms, I need a number again.',
  idle_cleared: 'For your security, I cleared your Social Security and bank numbers from this page '
    + 'after {minutes} minutes without activity. '
    + 'I will ask for them again before your forms are ready.',

  // -- adding a loop entry ----------------------------------------------------
  add_ambiguous: 'I can add to more than one list. Did you mean a {names}? Say which one, or say never mind to go back.',
  add_full: 'That is as many {item} entries as I can take. '
    + 'You can change one of them instead, or say never mind to go back.',
  add_open_failed: 'I could not open that list. Try naming a different one, or say never mind.',
  add_start_failed: 'I could not start a new {item}. '
    + 'Try naming a different one, or say never mind.',
  adding_new: 'Adding a new {item}.',
  added_one: 'I added {item} {number}.',
  added_many: 'I added {count} entries.',
  added_none: 'No {item} was added.',

  // -- deleting a loop entry --------------------------------------------------
  no_item_to_remove: 'There is no {item} recorded to remove. '
    + 'You can name something else, or say never mind to go back.',
  which_item_remove: 'Which {item} should I remove? {options}',
  could_not_tell_remove: 'I could not tell what to remove. You can say, for example, '
    + 'remove the second provider, or delete that last job. Say never mind to go back.',
  remove_confirm: 'Remove {what}? This erases every answer recorded for that '
    + '{item}, and I cannot bring it back. Say yes to remove it, or no to keep it.',
  remove_question: 'Remove {what}?',
  remove_hint: 'Say yes to remove it, or no to keep it.',
  keep_or_remove: 'Please say yes to remove it, or no to keep it.',
  kept_item: 'I kept {what}.',
  removed_item: 'I removed {what}.',
  remove_failed: 'That entry could not be removed.',
  say_number_or_name: '{list}. Say the number, or the name.',

  // -- finishing and downloads ------------------------------------------------
  erase_advice: 'When you have checked your forms, select Erase everything to remove your '
    + 'answers from this computer. The downloaded forms stay in your downloads folder.',
  downloaded: 'Downloaded {forms}. {erase}',
  forms_joiner: ' and ',
  pdf_failed: 'The PDF could not be created. Your answers are safe — try saving them as a file instead.',
  erased_everything: 'Everything has been erased from this device.',

  // -- keys and modes ---------------------------------------------------------
  cancelled: 'Cancelled.',
  handsfree_on: 'Hands free mode on',
  handsfree_off: 'Hands free mode off',

  // -- main.js ----------------------------------------------------------------
  filling_form: 'Filling in the {form}…',
  session_open_failed: 'Your saved answers could not be opened.',
  mic_blocked: 'Microphone access was blocked, so I switched to typing mode. You can allow the microphone in your browser settings and reload.',
  no_mic: 'No microphone is available, so I switched to typing mode.',
  loading_model: 'Loading the speech model…',
  loading_model_pct: 'Loading the speech model… {percent}%',
  loading_model_announce: 'Loading the speech model.',
  speech_model_failed: 'The speech model could not start, so I switched to typing mode.',
  saved_file_announce: 'Your answers were saved as a file.',
  discard_announce: 'Saved session erased. Ready to start fresh.',
  listening_release: 'Listening — release to send',
  microphone_unavailable: 'The microphone is not available. Switching to typing.',
  opening_saved: 'Opening your saved answers…',
  protecting_answers: 'Protecting your answers with your PIN…',
  pin_too_short: 'A PIN needs at least {count} characters. Longer is safer.',
  saved_protected: 'Your saved answers are protected. Enter your PIN, then select Resume.',
  import_reading: 'Reading your file…',
  import_loaded: 'Your answers were loaded{when}. {cursor}Choose how you want to answer, and a PIN if you want them saved, then select Resume my saved session.',
  import_loaded_when: ' from the file you saved on {when}',
  saved_on: ', saved on {when}',
  import_cursor: 'That file did not record where you left off, so I will start at the first question you have not answered. ',
  import_failed: 'That file could not be loaded. Choose the file you saved from this page.',
  loaded_from_file: 'Your answers are loaded from your file{when}.',
  saved_session_from: 'You have a saved session from {when}.',
  saved_locked: ' It is protected: enter your PIN above, then select Resume.',
  saved_legacy: ' An older version saved it without a PIN. Enter one above to protect it from now on.',
  saved_sensitive: ' Your Social Security and bank numbers are never saved, so you will be asked for them again.',
  saved_expiry: ' Saved sessions are deleted after {days} days.',
  error_saved: 'Something went wrong. Your answers are saved on this device.',
  error_plain: 'Something went wrong.',

  // -- summaries, tables and the worksheet -----------------------------------
  continued_from_form: 'Continued from the form',
  addendum_footer: 'Additional information — page {page} of {pages}',
  no_recorded: 'No {label} recorded.',
  table_caption: '{label} {number}',
  summary_row: '{label}: {value}.',
  summary_column: '{label}: {value}',
  not_answered: 'not answered',
  not_answered_cap: 'Not answered',
  worksheet_prepared: 'Prepared {date}',
  present: 'Present',
  yes: 'Yes',
  no: 'No',
  still_ongoing: 'still ongoing',

  // -- spoken time estimates -------------------------------------------------
  time_less_minute: 'less than a minute',
  time_two_minutes: 'about two minutes',
  time_minutes: 'about {count} minutes',
  time_hour: 'about an hour',
  time_hours: 'about {count} hours',
  time_hour_half: 'about an hour and a half',
  time_and_half_hours: 'about {count} and a half hours'
};
