// The on-device transcriber's contract, with the worker and the audio APIs
// stubbed out.
//
// What matters here is not Whisper's accuracy (tools/stt-eval.mjs measures
// that) but the plumbing a blind user depends on: audio reaches the worker as
// mono 16 kHz, silence becomes "I did not hear anything" rather than an
// answer, and every promise settles — a turn that hangs leaves the user with
// no prompt and no way to know it died.
//
// Makes no network requests.

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const fresh = async tag => import(`../src/localstt.js?${tag}=${Date.now()}`);

// -- a browser that cannot run it ------------------------------------------

{
  const stt = await fresh('unsupported');
  check('no Worker means unsupported', stt.isSupported() === false);
  const err = await stt.load().catch(e => e);
  check('load() rejects as unsupported', err?.kind === 'unsupported', String(err?.kind));
}

// -- stubs ------------------------------------------------------------------

const workers = [];
let reply = () => ({ type: 'result', text: 'hello' });

class FakeWorker {
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.posted = [];
    workers.push(this);
  }
  postMessage(msg, transfer = []) {
    this.posted.push({ msg, transfer });
    const response = reply(msg, this);
    if (response === 'crash') { queueMicrotask(() => this.onerror?.({ preventDefault() {} })); return; }
    if (response === 'hang') return;
    const data = msg.type === 'load' ? { type: 'ready' } : response;
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ...data } }));
  }
  terminate() { this.terminated = true; }
}

const contexts = [];
class FakeOfflineAudioContext {
  constructor(channels, length, rate) {
    this.args = [channels, length, rate];
    contexts.push(this);
  }
  async decodeAudioData(buf) {
    // Two channels, so the downmix is exercised: L = 1, R = 0 -> 0.5.
    const n = buf.byteLength;
    return {
      length: n,
      numberOfChannels: 2,
      getChannelData: c => new Float32Array(n).fill(c === 0 ? 1 : 0)
    };
  }
}

globalThis.Worker = FakeWorker;
globalThis.OfflineAudioContext = FakeOfflineAudioContext;
// WebAssembly is real in Node.

const blob = (bytes = 8) => new Blob([new Uint8Array(bytes)], { type: 'audio/webm;codecs=opus' });

// -- loading ------------------------------------------------------------------

{
  const stt = await fresh('load');
  check('stubs make it supported', stt.isSupported() === true);
  const before = workers.length;
  await Promise.all([stt.load(), stt.load()]);
  await stt.load();
  const w = workers.at(-1);
  check('one worker for many load() calls', workers.length === before + 1);
  check('one load message for many load() calls', w.posted.filter(p => p.msg.type === 'load').length === 1);
  check('the worker is a module worker', w.opts?.type === 'module');
  check('the worker is whisper-worker.js next to the module', /\/src\/whisper-worker\.js$/.test(w.url), w.url);
}

// -- transcribing ------------------------------------------------------------

{
  const stt = await fresh('transcribe');
  reply = () => ({ type: 'result', text: ' 987-65-4321 ' });
  const text = await stt.transcribe(blob(8));
  const w = workers.at(-1);
  const sent = w.posted.find(p => p.msg.type === 'transcribe');
  check('the transcript comes back trimmed', text === '987-65-4321', JSON.stringify(text));
  check('decoding happens at 16 kHz, mono', contexts.at(-1)?.args.join() === '1,16000,16000',
    contexts.at(-1)?.args.join());
  check('audio reaches the worker as a Float32Array', sent?.msg.audio instanceof Float32Array);
  check('stereo is averaged to mono', sent?.msg.audio?.[0] === 0.5, String(sent?.msg.audio?.[0]));
  check('the audio buffer is transferred, not copied', sent?.transfer?.[0] === sent?.msg.audio?.buffer);
}

// -- silence and failure -----------------------------------------------------

{
  const stt = await fresh('empty');

  for (const said of ['', '   ', '[BLANK_AUDIO]', ' (silence) ', '[Music] [BLANK_AUDIO]']) {
    reply = () => ({ type: 'result', text: said });
    const err = await stt.transcribe(blob()).then(() => null, e => e);
    check(`${JSON.stringify(said)} is "nothing heard"`, err?.kind === 'empty', String(err?.kind));
  }

  const none = await stt.transcribe(new Blob([])).then(() => null, e => e);
  check('an empty recording is "nothing heard"', none?.kind === 'empty');
  const missing = await stt.transcribe(null).then(() => null, e => e);
  check('no recording at all is "nothing heard"', missing?.kind === 'empty');

  reply = () => ({ type: 'error', kind: 'unknown', message: 'inference failed' });
  const failed = await stt.transcribe(blob()).then(() => null, e => e);
  check('a worker error rejects with its kind', failed?.kind === 'unknown', String(failed?.kind));
}

{
  const stt = await fresh('crash');
  await stt.load();
  const first = workers.at(-1);
  reply = () => 'crash';
  const err = await stt.transcribe(blob()).then(() => null, e => e);
  check('a crashed worker rejects the turn instead of hanging', err?.kind === 'model', String(err?.kind));
  check('a crashed worker is terminated', first.terminated === true);

  reply = () => ({ type: 'result', text: 'yes' });
  const again = await stt.transcribe(blob()).catch(e => e);
  check('the next turn starts a new worker', workers.at(-1) !== first && again === 'yes', String(again));
}

{
  const stt = await fresh('undecodable');
  const saved = FakeOfflineAudioContext.prototype.decodeAudioData;
  FakeOfflineAudioContext.prototype.decodeAudioData = async () => { throw new Error('EncodingError'); };
  reply = () => ({ type: 'result', text: 'unused' });
  const err = await stt.transcribe(blob()).then(() => null, e => e);
  check('an undecodable recording rejects, not hangs', err?.kind === 'unknown', String(err?.kind));
  FakeOfflineAudioContext.prototype.decodeAudioData = saved;
}

// -- cleanTranscript ---------------------------------------------------------

{
  const { cleanTranscript } = await fresh('clean');
  const cases = [
    ['[BLANK_AUDIO]', ''],
    ['Yes. [BLANK_AUDIO]', 'Yes.'],
    ['(coughs) 987-65-4321', '987-65-4321'],
    ['  Maine   Medical Center ', 'Maine Medical Center'],
    // A parenthetical holding digits is a spoken number, not an annotation.
    ['(207) 555-0142', '(207) 555-0142'],
    ['call (888) 555-0100 please', 'call (888) 555-0100 please'],
    [null, '']
  ];
  for (const [input, want] of cases) {
    const got = cleanTranscript(input);
    check(`cleanTranscript(${JSON.stringify(input)})`, got === want, `got ${JSON.stringify(got)}`);
  }
}

console.log(failures === 0 ? 'local-stt: all checks passed' : `local-stt: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
