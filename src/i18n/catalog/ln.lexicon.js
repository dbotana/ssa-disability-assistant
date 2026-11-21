// Lingala recognition tables, stored folded (lowercase, no diacritics).
//
// The month names are the French ones, as commonly written in Kinshasa, plus
// the traditional "sánzá ya …" forms; both fold to the spellings below (D8).

export default {
  yes: ['ɛɛ', 'ɛ', 'ee', 'e', 'iyo', 'yes', 'ok', 'okay', 'ezali malamu', 'malamu', 'solo', 'ya solo'],
  // A bare vowel is also a hesitation ("E.", "e..."), and a transcriber hands
  // one back for almost any noise. A yes/no question may read it as yes, but a
  // read-back — "is that SSN right?" — may not: a hesitation must never
  // confirm a value. The longer forms (ɛɛ, ee, iyo) still do (plan 4.5).
  readBackHesitations: ['ɛ', 'e'],
  no: ['te', 'tɛ', 'non', 'no', 'ezali te', 'non te', 'liboso te', 'ata moko te'],
  yesPhrases: [],
  noPhrases: [],
  digits: {
    zero: '0', zelo: '0', oh: '0',
    un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5',
    six: '6', sept: '7', huit: '8', neuf: '9',
    moko: '1', mibale: '2', misato: '3', minei: '4', mitano: '5',
    motoba: '6', nsambo: '7', mwambe: '8', libwa: '9'
  },
  months: {
    janvier: 1, janv: 1, fevrier: 2, fevr: 2, mars: 3,
    avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
    aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10,
    novembre: 11, nov: 11, decembre: 12, dec: 12,
    'sanza ya yambo': 1, 'sanza ya mibale': 2, 'sanza ya misato': 3,
    'sanza ya minei': 4, 'sanza ya mitano': 5, 'sanza ya motoba': 6,
    'sanza ya nsambo': 7, 'sanza ya mwambe': 8, 'sanza ya libwa': 9,
    'sanza ya zomi': 10, 'sanza ya zomi na moko': 11,
    'sanza ya zomi na mibale': 12
  },
  present: ['\\b(toujours|encore|present|presentement|komi|tii|eleki|sikawa|ya sikawa)\\b'],
  negation: ['\\b(te|non|pas|sans|ata|moko te)\\b'],
  lead: ['^(eh|e|ee|bien|alors|donc|na kanisaka|na ndenge|oko|ok)\\b[\\s,]*'],
  filler: [
    '^(eh|e|ee|ok|okay|please|s il vous plait|ndenge nini|na lingi|na kosenga)\\b[\\s,]*',
    '[\\s,]*\\b(s il vous plait|merci|sikawa)\\b[\\s.!?]*$'
  ],
  commands: {
    repeat: ['loba lisusu', 'zongela', 'zongisa', 'lisusu', 'maloba lisusu', 'repeat'],
    back: ['zonga', 'kizunga', 'zonga na question', 'question ya liboso', 'back'],
    skip: ['leka', 'koleka', 'skip', 'tika', 'tikala', 'suivant', 'next'],
    where: ['wapi', 'ozali wapi', 'esika nini', 'progres', 'progression', 'eleki boni', 'where'],
    readback: ['tanga', 'tanga makambo', 'tanga biyano', 'tanga answers', 'lire', 'relire', 'review'],
    correct: ['bongola', 'kobongola', 'changer', 'corriger', 'modifier', 'change', 'correct'],
    save_quit: ['kobomba', 'bomba', 'enregistrer', 'sauvegarder', 'kobima', 'quitter', 'stop'],
    restart: ['banda lisusu', 'kobanda lisusu', 'recommencer', 'restart', 'start over'],
    help: ['lisalisi', 'aide', 'help', '\\?', 'nini nazali kokanisa', 'what can i say'],
    finish: ['silisa', 'kokokisa', 'fini', 'terminer', 'finish', 'done', 'ekoki', 'c est tout']
  },
  connector: 'to'
};
