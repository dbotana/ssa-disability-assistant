// The languages this app knows, and the four channels a language can be
// chosen for.
//
// Everything here is plain JSON-serialisable data: it is exported into
// tools/schema.json (key `i18n`) so the Kotlin port reads the same table. No
// functions, no RegExps, no dates.
//
// `stt.installed` is a data fact, not a guess. Two packs are committed:
// models/whisper-base.en (English only) and models/whisper-base
// (multilingual), which French and Lingala load with their own language
// code. tests/vendor-integrity.js fails if an installed pack is not on disk.
// Accuracy in French and Lingala has not been measured: there are no
// recordings in either language.
//
// `stt` also carries the input matrix Step 2 item 4 asks for, exported with
// the rest of this table in tools/schema.json:
//
//   engine          which recognizer the app runs: whisper, or mms for Lingala
//   lid             language ID runs on the capture first (MMS)
//   adapters        the recognizer adapters a session may use, in order
//   voiceTypes      'all', or the question types voice is offered for
//   alwaysReadBack  every voice answer is read back whatever the setting
//   lexicons        the recognition tables the parser may consult
//
// `model`, `language`, `multilingual` and `installed` describe the pack the
// web reference loads today, so the browser keeps transcribing while the
// apps move to the engine named here. MMS is the target for Lingala (D6) and
// the Lingala lexicon already carries the French digit words.
//
// `clips` is the same kind of fact for pre-recorded speech: only English clips
// exist, so `null` means "use an on-device voice instead". A clip pack would
// be added here as data.

export const CHANNELS = ['input', 'output', 'screen', 'fill'];

// Kinshasa Lingala is commonly written with the French month names, and the
// French calendar is what a Lingala speaker reads on a form.
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export const LANGUAGES = {
  en: {
    tag: 'en',
    name: 'English',
    autonym: 'English',
    htmlLang: 'en',
    months: ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'],
    voiceTags: ['en-US', 'en'],
    voiceFallback: [],
    clips: { manifest: 'audio/manifest.json' },
    stt: {
      engine: 'whisper', model: 'whisper-base.en', language: null, multilingual: false, installed: true,
      lid: false, adapters: ['eng'], voiceTypes: 'all', alwaysReadBack: false, lexicons: ['en']
    }
  },
  fr: {
    tag: 'fr',
    name: 'French',
    autonym: 'Français',
    htmlLang: 'fr',
    months: FR_MONTHS,
    voiceTags: ['fr-FR', 'fr'],
    voiceFallback: ['en'],
    clips: null,
    stt: {
      engine: 'whisper', model: 'whisper-base', language: 'fr', multilingual: true, installed: true,
      lid: false, adapters: ['fra'], voiceTypes: 'all', alwaysReadBack: false, lexicons: ['fr']
    }
  },
  ln: {
    tag: 'ln',
    name: 'Lingala',
    autonym: 'Lingála',
    htmlLang: 'ln',
    months: FR_MONTHS,
    voiceTags: ['ln'],
    voiceFallback: ['fr', 'en'],
    clips: null,
    stt: {
      // D6: MMS identifies the language, then transcribes with the adapter it
      // chose. Every type is offered voice until Step 4.4 measures it (D8),
      // and every voice answer is read back because that is the only check
      // on a language whose accuracy is unmeasured.
      engine: 'mms', model: 'whisper-base', language: 'ln', multilingual: true, installed: true,
      lid: true, adapters: ['lin', 'fra', 'eng'], voiceTypes: 'all', alwaysReadBack: true,
      lexicons: ['ln', 'fr']
    }
  }
};

export const LANGUAGE_ORDER = ['en', 'fr', 'ln'];

export const DEFAULT_SETTINGS = Object.freeze({
  input: 'en', output: 'en', screen: 'en', fill: 'en'
});
