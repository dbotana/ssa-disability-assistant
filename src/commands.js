// Navigation commands, matched locally on both the typed and the spoken path.
//
// Anchored, so a command word appearing inside a real answer is not mistaken
// for a command: "I skip meals" is an answer, "skip" is a command. What sits
// outside the anchors is only politeness and hesitation — the words people
// actually put around a spoken instruction — never anything that could carry
// meaning of its own.

const LOCAL_COMMANDS = [
  [/^(repeat|repeat that|say (that )?again|again|one more time)$/, 'repeat'],
  [/^(back|go back|previous|last question|go back a question)$/, 'back'],
  [/^(skip|skip (this|it|that)|pass|leave (it |this )?blank|next)$/, 'skip'],
  [/^(where|where am i|progress|how far|how much (is )?(left|to go))$/, 'where'],
  [/^(read back|read back my answers|read my answers|review)$/, 'readback'],
  [/^(change|change an answer|correct|correct an answer|fix|fix an answer|edit)$/, 'correct'],
  [/^(save|save and quit|quit|stop for now)$/, 'save_quit'],
  [/^(start over|restart|start again)$/, 'restart'],
  [/^(help|\?|what can i say)$/, 'help'],
  [/^(finish|done|finish early|that is all|thats all|i am done|im done)$/, 'finish']
];

/** Politeness and hesitation around a spoken command; carries no meaning. */
const COMMAND_FILLER = {
  lead: /^(um|uh|er|ok|okay|well|hey|please|can you|could you|would you|i want to|i would like to|let us|lets)\b[\s,]*/,
  tail: /[\s,]*\b(please|now|thanks|thank you)\b[\s.!?]*$/
};

export function localCommand(text) {
  let s = String(text ?? '').toLowerCase().trim().replace(/[.!?]+$/, '');
  // Strip filler repeatedly: "ok, can you please repeat that" stacks three.
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(COMMAND_FILLER.lead, '').replace(COMMAND_FILLER.tail, '').trim();
    if (s === before) break;
  }
  if (!s) return null;
  for (const [re, cmd] of LOCAL_COMMANDS) if (re.test(s)) return cmd;
  return null;
}

/** The command a key press means, in both the interview and review panels. */
export const KEY_COMMANDS = {
  Enter: 'repeat', KeyB: 'back', KeyS: 'skip', KeyW: 'where', KeyR: 'readback', KeyC: 'correct'
};
