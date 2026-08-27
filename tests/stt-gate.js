// Browser speech recognition stays off until the user turns it on, and always
// resolves.
//
// The consent gate is the load-bearing part. Recognition sends the recording
// to the browser's maker, which is a third party the user did not choose by
// pasting an OpenAI key, and this form collects Social Security and bank
// account numbers. A default-on bug here would ship those before the user was
// ever told there was a choice.
//
// The other property is that listen() never rejects and never hangs: a blind
// user left waiting on a pending promise has no prompt, no error, and no way
// to know the turn died.
//
// Makes no API calls.

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

// -- a browser with no recognition at all ---------------------------------

globalThis.window = {};
let stt = await import('../src/stt.js');

check('unsupported browser reports unsupported', stt.isSupported() === false);
check('unsupported browser is never permitted', stt.isPermitted() === false);
stt.setPermitted(true);
check('permission cannot be granted where unsupported', stt.isPermitted() === false);
check('listen() resolves null where unsupported', (await stt.listen()) === null);

// -- a browser that has it -------------------------------------------------
//
// Fresh module instance: the permitted flag is module state, and the point is
// to observe its default.

class FakeRecognition {
  constructor() { FakeRecognition.instances.push(this); }
  start() { FakeRecognition.started++; this.onScript?.(this); }
  stop() { this.stopped = true; }
}
FakeRecognition.instances = [];
FakeRecognition.started = 0;

globalThis.window = { SpeechRecognition: FakeRecognition };
stt = await import(`../src/stt.js?fresh=${Date.now()}`);

check('supported browser reports supported', stt.isSupported() === true);

// The default that matters.
check('recognition is OFF by default', stt.isPermitted() === false);
check('listen() resolves null before consent', (await stt.listen()) === null);
check('no recognizer is constructed before consent', FakeRecognition.started === 0);

// -- with consent ----------------------------------------------------------

stt.setPermitted(true);
check('consent enables it', stt.isPermitted() === true);

// A normal result.
FakeRecognition.prototype.onScript = r => {
  setTimeout(() => r.onresult({ results: [[{ transcript: '  March 14th 1979  ' }]] }), 0);
};
check('a result is returned, trimmed',
  (await stt.listen()) === 'March 14th 1979');

// Every terminal event must resolve rather than strand the turn.
FakeRecognition.prototype.onScript = r => setTimeout(() => r.onerror({ error: 'network' }), 0);
check('an error resolves null', (await stt.listen()) === null);

FakeRecognition.prototype.onScript = r => setTimeout(() => r.onnomatch({}), 0);
check('no-match resolves null', (await stt.listen()) === null);

FakeRecognition.prototype.onScript = r => setTimeout(() => r.onend({}), 0);
check('a silent end resolves null', (await stt.listen()) === null);

// An empty transcript is not an answer.
FakeRecognition.prototype.onScript = r => {
  setTimeout(() => r.onresult({ results: [[{ transcript: '   ' }]] }), 0);
};
check('an empty transcript resolves null', (await stt.listen()) === null);

// A recognizer that never fires anything must still let the turn continue.
FakeRecognition.prototype.onScript = () => {};
check('a silent recognizer times out to null',
  (await stt.listen({ timeoutMs: 20 })) === null);

// A constructor that throws is a fallback, not a crash.
globalThis.window = { SpeechRecognition: function () { throw new Error('blocked'); } };
const stt2 = await import(`../src/stt.js?throw=${Date.now()}`);
stt2.setPermitted(true);
check('a throwing recognizer resolves null', (await stt2.listen()) === null);

// -- abort -----------------------------------------------------------------

globalThis.window = { SpeechRecognition: FakeRecognition };
const stt3 = await import(`../src/stt.js?abort=${Date.now()}`);
stt3.setPermitted(true);
FakeRecognition.prototype.onScript = () => {};
{
  const controller = new AbortController();
  const p = stt3.listen({ timeoutMs: 50, signal: controller.signal });
  controller.abort();
  check('aborting resolves rather than hanging', (await p) === null);
}

console.log(failures === 0 ? 'stt-gate: all checks passed' : `stt-gate: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
