// The English recognition tables, by reference.
//
// These are the exact lists and regex sources parse.js, commands.js and
// choice.js have always used. They live here so every language has the same
// shape; the English path keeps its original behaviour and the English parse
// golden cannot move.

export default {
  yes: ['y', 'yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'right', 'true',
    'affirmative', 'ok', 'okay', 'that is right', 'thats right', "that's right", 'uh huh'],
  no: ['n', 'no', 'nope', 'nah', 'negative', 'false', 'incorrect', 'wrong',
    'that is wrong', 'thats wrong', "that's wrong", 'uh uh'],
  yesPhrases: [
    '^(yes|yeah|yep|yup)\\b[ ,]+(i|you|he|she|we|they|it)\\s+(do|does|did|am|are|is|was|were|have|has|had|would|will|can|could|should)$'
  ],
  noPhrases: [
    '^(no|nope|nah)\\b[ ,]+(i|you|he|she|we|they|it)\\s+(do not|don\'?t|does not|doesn\'?t|did not|didn\'?t|am not|are not|aren\'?t|is not|isn\'?t|was not|wasn\'?t|were not|weren\'?t|have not|haven\'?t|has not|hasn\'?t|had not|hadn\'?t|would not|wouldn\'?t|will not|won\'?t|can not|cannot|can\'?t|could not|couldn\'?t|should not|shouldn\'?t)$'
  ],
  digits: {
    zero: '0', oh: '0', o: '0', naught: '0', nought: '0',
    one: '1', two: '2', three: '3', four: '4', for: '4', five: '5',
    six: '6', seven: '7', eight: '8', ate: '8', nine: '9', niner: '9'
  },
  months: {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sept: 9, sep: 9, october: 10, oct: 10,
    november: 11, nov: 11, december: 12, dec: 12
  },
  present: ['\\b(still|ongoing|present|current(ly)?|to this day|up to now|continu\\w*)\\b'],
  negation: ['\\b(not|no|nor|neither|without|cannot|(?:do|does|did|is|was|are|were|ca|wo|could|would|should)n\'?t)\\b'],
  lead: ['^(um|uh|er|well|so|okay|ok|i think|i would say|i\'d say|probably|maybe|it is|it\'s|its|that is|that\'s|thats|i guess)\\b[\\s,]*'],
  filler: ['^(um|uh|er|ok|okay|well|hey|please|can you|could you|would you|i want to|i would like to|let us|lets)\\b[\\s,]*',
    '[\\s,]*\\b(please|now|thanks|thank you)\\b[\\s.!?]*$'],
  commands: {
    repeat: ['repeat', 'repeat that', 'say (that )?again', 'again', 'one more time'],
    back: ['back', 'go back', 'previous', 'last question', 'go back a question'],
    skip: ['skip', 'skip (this|it|that)', 'pass', 'leave (it |this )?blank', 'next'],
    where: ['where', 'where am i', 'progress', 'how far', 'how much (is )?(left|to go)'],
    readback: ['read back', 'read back my answers', 'read my answers', 'review'],
    correct: ['change', 'change an answer', 'correct', 'correct an answer', 'fix', 'fix an answer', 'edit'],
    save_quit: ['save', 'save and quit', 'quit', 'stop for now'],
    restart: ['start over', 'restart', 'start again'],
    help: ['help', '\\?', 'what can i say'],
    finish: ['finish', 'done', 'finish early', 'that is all', 'thats all', 'i am done', 'im done']
  },
  connector: 'or',
  // Date-shape words. Kept here for consumers that want the same tables the
  // English parser has always used; parse.js keeps its own copy for the
  // English path so its regex dialect does not change.
  dateWords: {
    small: { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 },
    tens: { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 },
    ordinals: { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 }
  }
};
