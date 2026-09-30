// Speech to text, on this device, in a worker.
//
// Whisper runs through transformers.js on the onnxruntime WebAssembly
// backend. Both the runtime (vendor/transformers/) and the model weights
// (models/) are files in this project, served from the same localhost origin
// as the page. Nothing here may reach the network, and three things make sure
// of it:
//
//   - allowRemoteModels is off, so a model missing from models/ is an error,
//     not a silent download from huggingface.co;
//   - wasmPaths is set, because the library's default for it is a CDN;
//   - the page's Content-Security-Policy (connect-src 'self') refuses any
//     request that slipped past the first two. tests/no-network.js checks all
//     three.
//
// It runs in a worker because decoding takes a few hundred milliseconds of
// solid CPU, and on the main thread that would stall the earcons, the level
// meter, and the live-region announcements a blind user is waiting on.
//
// Why WASM and not WebGPU: the committed weights are the q8 ("_quantized")
// export — the only variant small enough to commit without Git LFS — and
// onnxruntime's WebGPU backend runs those int8 matmuls on the CPU anyway.
// WebGPU would only pay off with a second, ~200 MB fp32/q4 copy of the model.

import { pipeline, env } from '../vendor/transformers/transformers.min.js';

const MODEL = 'whisper-base.en';
const DTYPE = 'q8';

// Absolute URLs, not relative strings. onnxruntime resolves wasmPaths from
// inside vendor/transformers/, so '../vendor/…' would point somewhere else.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('../models/', import.meta.url).href;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
env.backends.onnx.wasm.proxy = false;

let asr = null;

function load() {
  asr ??= pipeline('automatic-speech-recognition', MODEL, {
    device: 'wasm',
    dtype: DTYPE,
    progress_callback: p => {
      if (p?.status === 'progress') {
        postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      }
    }
  }).catch(err => { asr = null; throw err; });
  return asr;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data ?? {};
  if (type === 'load') {
    try {
      await load();
      postMessage({ id, type: 'ready' });
    } catch (err) {
      postMessage({ id, type: 'error', kind: 'model', message: String(err?.message ?? err) });
    }
    return;
  }

  if (type === 'transcribe') {
    let run;
    try {
      run = await load();
    } catch (err) {
      postMessage({ id, type: 'error', kind: 'model', message: String(err?.message ?? err) });
      return;
    }
    try {
      // No language or task option: English-only (.en) checkpoints reject
      // both. chunk_length_s lets a 60-second digit capture through whole.
      const out = await run(data.audio, { chunk_length_s: 30 });
      postMessage({ id, type: 'result', text: out?.text ?? '' });
    } catch (err) {
      postMessage({ id, type: 'error', kind: 'unknown', message: String(err?.message ?? err) });
    }
  }
};
