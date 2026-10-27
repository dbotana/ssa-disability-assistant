// The languages this app knows, and the four channels a language can be
// chosen for.
//
// Everything here is plain JSON-serialisable data: it is exported into
// tools/schema.json (key `i18n`) so the Kotlin port reads the same table. No
// functions, no RegExps, no dates.
//
// `stt.installed` is a data fact, not a guess. The only weights committed to
// this repository are models/whisper-base.en, which is English-only, so French
// and Lingala name the multilingual checkpoint they would need and say
// `installed: false`. Committing models/whisper-base/ with its SHA256SUMS and
// flipping the flag is all it takes to turn voice input on for them.
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
    stt: { model: 'whisper-base.en', language: null, multilingual: false, installed: true }
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
    stt: { model: 'whisper-base', language: 'fr', multilingual: true, installed: false }
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
    stt: { model: 'whisper-base', language: 'ln', multilingual: true, installed: false }
  }
};

export const LANGUAGE_ORDER = ['en', 'fr', 'ln'];

export const DEFAULT_SETTINGS = Object.freeze({
  input: 'en', output: 'en', screen: 'en', fill: 'en'
});
