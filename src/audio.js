// Microphone capture, silence detection, and earcons.
//
// Earcons matter more than they look: a blind user needs to know the recorder
// opened *before* they start talking, and speech confirmation is too slow for
// that. A short tone is instant.

let stream = null;
let recorder = null;
let chunks = [];
let audioCtx = null;
let analyser = null;
let silenceTimer = null;
let hardStopTimer = null;

/** Recorder mime types in preference order. Safari and Chrome disagree. */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg'
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

export function isSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
}

/** Request microphone access once; the stream is reused for the whole session. */
export async function initMic() {
  if (stream) return stream;
  if (!isSupported()) {
    const err = new Error('This browser cannot record audio.');
    err.kind = 'unsupported';
    throw err;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    const err = new Error('Microphone access was not granted.');
    err.kind = e?.name === 'NotAllowedError' ? 'denied' : 'unavailable';
    throw err;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  return stream;
}

/** Some browsers suspend the context until a user gesture. */
export async function resumeContext() {
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
}

/** Current input level, 0..1 — drives the level meter and silence detection. */
export function inputLevel() {
  if (!analyser) return 0;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
  return Math.sqrt(sum / buf.length);
}

export function isRecording() {
  return recorder?.state === 'recording';
}

// What the last capture actually contained.
//
// The level meter runs for every capture, not only the hands-free ones. Push
// to talk used to assume speech, which meant tapping the space bar without
// saying anything sent a second of room tone to be transcribed — and a
// transcriber handed silence invents a short filler phrase rather than
// returning nothing. That filler was then recorded as the answer and the form
// moved on. Measuring the microphone is the only way to tell the two apart.
let heardSpeech = false;
let capturePeak = 0;
let captureStartedAt = 0;
let captureMs = 0;

/**
 * Did the capture that just ended actually contain speech?
 *
 * Used to skip paying to transcribe a turn that caught a cough, a door, or a
 * hot mic in a quiet room — and, on the push-to-talk path, a button press
 * with nothing said into it.
 */
export function lastCaptureHadSpeech() {
  return heardSpeech;
}

/** Loudest RMS level seen during the last capture, 0..1. */
export function lastCapturePeak() {
  return capturePeak;
}

/** How long the last capture ran, in milliseconds. */
export function lastCaptureDurationMs() {
  return captureMs;
}

/**
 * Start recording.
 * @param {object} opts
 * @param {boolean} opts.autoStop   end the turn on sustained silence
 * @param {number}  opts.silenceMs  how long silence must last
 * @param {number}  opts.maxMs      hard cap so a stuck mic cannot run forever
 * @param {Function} opts.onAutoStop called when silence ends the turn
 */
export async function startRecording({
  autoStop = false, silenceMs = 1200, maxMs = 30000, onAutoStop = null
} = {}) {
  await initMic();
  await resumeContext();
  if (isRecording()) return;

  chunks = [];
  heardSpeech = false;
  capturePeak = 0;
  captureMs = 0;
  captureStartedAt = performance.now();
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  recorder.start(250);

  earcon('start');

  clearTimeout(hardStopTimer);
  hardStopTimer = setTimeout(() => { if (isRecording()) onAutoStop?.(); }, maxMs);

  watchLevels({ autoStop, silenceMs, onAutoStop });
}

function watchLevels({ autoStop, silenceMs, onAutoStop }) {
  const SPEECH = 0.045;   // RMS above this ends the turn when it goes quiet
  // Deliberately lower than SPEECH. This one only decides whether to spend
  // money transcribing, and the cost of the two mistakes is not symmetric:
  // a wasted API call is pennies, while telling a soft-spoken user "I did not
  // hear anything" when they did speak is a loop they cannot escape. Bias
  // hard toward believing there was speech — with noise suppression on, a
  // silent room sits an order of magnitude below this.
  const AUDIBLE = 0.02;
  let endedOnSilence = false;
  let quietSince = null;

  const tick = () => {
    if (!isRecording()) return;
    const level = inputLevel();

    if (level > capturePeak) capturePeak = level;
    if (level > AUDIBLE) heardSpeech = true;

    if (autoStop) {
      if (level > SPEECH) {
        endedOnSilence = true;
        quietSince = null;
      } else if (endedOnSilence) {
        quietSince ??= performance.now();
        if (performance.now() - quietSince > silenceMs) { onAutoStop?.(); return; }
      }
    }
    silenceTimer = requestAnimationFrame(tick);
  };
  silenceTimer = requestAnimationFrame(tick);
}

/** Stop recording and resolve with the captured Blob. */
export function stopRecording() {
  return new Promise(resolve => {
    clearTimeout(hardStopTimer);
    if (silenceTimer) cancelAnimationFrame(silenceTimer);
    captureMs = captureStartedAt ? performance.now() - captureStartedAt : 0;
    if (!recorder || recorder.state === 'inactive') { resolve(null); return; }

    recorder.onstop = () => {
      const type = recorder.mimeType || 'audio/webm';
      const blob = chunks.length ? new Blob(chunks, { type }) : null;
      chunks = [];
      earcon('stop');
      resolve(blob);
    };
    recorder.stop();
  });
}

/** Abandon the current recording without producing a blob. */
export function cancelRecording() {
  clearTimeout(hardStopTimer);
  if (silenceTimer) cancelAnimationFrame(silenceTimer);
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
  }
  chunks = [];
  earcon('cancel');
}

export function releaseMic() {
  cancelRecording();
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  analyser = null;
  audioCtx?.close();
  audioCtx = null;
}

// -- earcons ---------------------------------------------------------------

const TONES = {
  start:  [{ f: 880, d: 0.09 }],
  stop:   [{ f: 620, d: 0.09 }],
  cancel: [{ f: 400, d: 0.13 }],
  think:  [{ f: 520, d: 0.06 }, { f: 660, d: 0.06 }],
  error:  [{ f: 300, d: 0.16 }, { f: 240, d: 0.20 }],
  done:   [{ f: 660, d: 0.09 }, { f: 880, d: 0.09 }, { f: 1100, d: 0.14 }]
};

/** Short non-speech cue. Never throws — audio feedback is never load-bearing. */
export function earcon(name) {
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (!audioCtx) audioCtx = ctx;
    let at = ctx.currentTime;
    for (const { f, d } of TONES[name] ?? TONES.start) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = f;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.14, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + d + 0.02);
      at += d;
    }
  } catch { /* audio cues are a courtesy, never a dependency */ }
}
