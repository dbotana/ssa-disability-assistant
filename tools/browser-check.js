// In-browser check of the pieces tests/ cannot reach from Node: the worker,
// the vendored WebAssembly runtime, the Content-Security-Policy, and cross-
// origin isolation. Maintainer-only; see tools/browser-check.html.
//
// It transcribes a fixture twice: once as the WAV on disk, and once after a
// round trip through this browser's own MediaRecorder, which is the format a
// real answer arrives in (webm/opus in Chrome, mp4 in Safari).

import * as localstt from '../src/localstt.js';

const out = document.getElementById('out');
const lines = [];
const results = {};
const report = (name, ok, detail = '') => {
  results[name] = { ok, detail };
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  out.textContent = lines.join('\n');
};

async function viaMediaRecorder(wavBlob) {
  const ctx = new AudioContext();
  const buffer = await ctx.decodeAudioData(await wavBlob.arrayBuffer());
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  const recorder = new MediaRecorder(dest.stream);
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise(r => { recorder.onstop = r; });
  recorder.start(250);
  src.start();
  await new Promise(r => { src.onended = r; });
  recorder.stop();
  await stopped;
  await ctx.close();
  return new Blob(chunks, { type: recorder.mimeType });
}

async function run() {
  report('cross-origin isolated (multithreaded WASM)', globalThis.crossOriginIsolated === true);

  let blocked = false;
  try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch { blocked = true; }
  report('remote fetch refused by CSP', blocked);

  const t0 = performance.now();
  try {
    await localstt.load();
    report('model loads', true, `${Math.round(performance.now() - t0)} ms`);
  } catch (err) {
    report('model loads', false, `${err.kind}: ${err.message}`);
    return;
  }

  const wav = await (await fetch('../tests/fixtures/speech/ssn-grouped.wav')).blob();
  let t = performance.now();
  const fromWav = await localstt.transcribe(wav);
  report('WAV transcribes', /987.?65.?4321/.test(fromWav),
    `${JSON.stringify(fromWav)} in ${Math.round(performance.now() - t)} ms`);

  try {
    const recorded = await viaMediaRecorder(wav);
    t = performance.now();
    const fromRecorder = await localstt.transcribe(recorded);
    report(`${recorded.type || 'recorder output'} transcribes`, /987.?65.?4321/.test(fromRecorder),
      `${JSON.stringify(fromRecorder)} in ${Math.round(performance.now() - t)} ms`);
  } catch (err) {
    report('recorder output transcribes', false, String(err?.message ?? err));
  }

  const silence = await (await fetch('../tests/fixtures/speech/silence.wav')).blob();
  try {
    const heard = await localstt.transcribe(silence);
    report('silence is filler or empty', /^(you|thank you)?\.?$/i.test(heard), JSON.stringify(heard));
  } catch (err) {
    report('silence is filler or empty', err.kind === 'empty', err.kind);
  }
}

run()
  .catch(err => report('check crashed', false, String(err?.stack ?? err)))
  .finally(() => { window.__browserCheck = results; document.body.dataset.done = 'true'; });
