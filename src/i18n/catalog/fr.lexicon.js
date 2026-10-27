// French recognition tables. Every entry is stored folded (lowercase, no
// diacritics), because parser.js and commands.js fold the transcript before
// looking anything up (D5).

export default {
  yes: ['oui', 'ouais', 'y', 'yes', 'correct', 'exact', 'exacte', 'd accord', 'daccord',
    'bien sur', 'absolument', 'tout a fait', 'ok', 'okay', 'c est vrai', 'vrai'],
  no: ['non', 'n', 'no', 'pas', 'incorrect', 'faux', 'fausse', 'pas du tout',
    'ce n est pas correct', 'errone', 'erreur'],
  yesPhrases: [],
  noPhrases: [],
  digits: {
    zero: '0', zelo: '0', oh: '0',
    un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5',
    six: '6', sept: '7', huit: '8', neuf: '9'
  },
  months: {
    janvier: 1, janv: 1, fevrier: 2, fevr: 2, mars: 3,
    avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
    aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10,
    novembre: 11, nov: 11, decembre: 12, dec: 12
  },
  present: ['\\b(encore|toujours|present|presentement|actuel|actuelle|actuellement|en cours|a ce jour|jusqu a maintenant|continue)\\b'],
  negation: ['\\b(pas|non|ni|sans|jamais|aucun|aucune|ne)\\b'],
  lead: ['^(euh|heu|ben|bah|alors|donc|voila|je pense|je dirais|peut etre|en fait|c est|ca fait)\\b[\\s,]*'],
  filler: [
    '^(euh|heu|ben|bah|alors|donc|ok|okay|s il vous plait|s il te plait|pouvez vous|pourriez vous|je veux|je voudrais)\\b[\\s,]*',
    '[\\s,]*\\b(s il vous plait|s il te plait|merci|maintenant)\\b[\\s.!?]*$'
  ],
  commands: {
    repeat: ['repeter', 'repete', 'repetez', 'redis', 'redire', 'une autre fois', 'dis encore'],
    back: ['retour', 'revenir', 'en arriere', 'question precedente', 'precedent', 'retourner'],
    skip: ['passer', 'passe', 'saute', 'sauter', 'suivant', 'laisse vide', 'laisser vide', 'ignore', 'ignorer'],
    where: ['ou', 'ou suis je', 'ou en suis je', 'progression', 'combien il reste', 'combien reste', 'avancement'],
    readback: ['relire', 'relis', 'lire mes reponses', 'relire mes reponses', 'relire les reponses', 'revoir', 'resume'],
    correct: ['changer', 'change', 'corriger', 'corrige', 'modifier', 'modifie', 'editer',
      'changer une reponse', 'corriger une reponse'],
    save_quit: ['sauvegarder', 'enregistrer', 'sauvegarder et quitter', 'quitter', 'arreter', 'pause'],
    restart: ['recommencer', 'redemarrer', 'reinitialiser', 'recommence', 'tout recommencer'],
    help: ['aide', 'aider', '\\?', 'que puis je dire', 'au secours'],
    finish: ['terminer', 'fini', 'finir', 'termine', 'j ai fini', 'c est tout', 'assez']
  },
  connector: 'ou'
};
