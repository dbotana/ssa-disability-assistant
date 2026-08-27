// Browser speech recognition, tried before the paid transcription API.
//
// Where this runs, it is free and it is fast — no upload, no round trip to
// OpenAI. Where it does not run, or does not produce anything, the caller
// falls back to llm.transcribe() and nothing is lost but a moment.
//
// PRIVACY, AND WHY IT IS NOT PURELY A WIN:
//
// SpeechRecognition is not local. Chrome and Edge stream the audio to Google's
// servers; Safari streams to Apple's. That is a third party the user never
// chose — they consented to OpenAI by pasting an OpenAI key, and nothing about
// this app told them about anyone else. On a form that collects Social
// Security and bank account numbers that distinction is not academic, which is
// why schema.js no longer promises those answers stay on the device and why
// setPermitted() exists: the user's choice gates this entire module, and the
// default is off until they have been told.
//
// Accuracy is the second cost. The paid API accepts a `prompt` hint that
// primes it for digit strings and proper nouns (see hintFor() in llm.js);
// there is no equivalent here, and digit accuracy is measurably worse as a
// result. Sensitive fields are read back for confirmation before they commit,
// which is the backstop — see the note in main.js where that gate lives.

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null)
  : null;

// Off until the user is asked. A default of "on" would ship their SSN to a
// third party before they were ever told there was one.
let permitted = false;

/** Does this browser have speech recognition at all? Firefox does not. */
export function isSupported() {
  return Recognition !== null;
}

/** Whether the user has agreed to use it. Gates every call to listen(). */
export function setPermitted(on) { permitted = !!on; }
export function isPermitted() { return permitted && isSupported(); }

/**
 * Listen for one utterance.
 *
 * Resolves with the transcript, or null when recognition is unavailable,
 * declined, silent, or failed — every one of which means "use the paid API".
 * Never rejects: a failure here is a fallback, not an error the caller has to
 * handle.
 *
 * @param {object} opts
 * @param {number} opts.timeoutMs give up and let the paid path take over
 * @param {AbortSignal} opts.signal stop listening (the user released the key)
 */
export function listen({ timeoutMs = 12000, signal = null } = {}) {
  if (!isPermitted()) return Promise.resolve(null);

  return new Promise(resolve => {
    let done = false;
    let recognition;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { recognition?.stop(); } catch { /* already stopped */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    const onAbort = () => { try { recognition?.stop(); } catch { /* ignore */ } };

    try {
      recognition = new Recognition();
    } catch {
      finish(null);
      return;
    }

    recognition.lang = 'en-US';
    recognition.continuous = false;
    // Only the final result is used. Interim results would let the UI show
    // partial text, but acting on one would mean committing an answer the
    // user is still in the middle of saying.
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = e => {
      const text = e.results?.[0]?.[0]?.transcript?.trim();
      finish(text || null);
    };
    // Every terminal event resolves. Leaving this promise pending would strand
    // the turn and leave a blind user waiting with no prompt and no recourse.
    recognition.onerror = () => finish(null);
    recognition.onnomatch = () => finish(null);
    recognition.onend = () => finish(null);

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      recognition.start();
    } catch {
      finish(null);
    }
  });
}
