// The saved-session format as pure functions (src/store.js), the part the
// Android and iOS apps port: the payload, the envelope, the 7-day expiry,
// the withheld repair after a deleted loop item (TODO.md, Known quirks), and
// a WebCrypto round trip with the parameters the `store` golden's test
// vector uses.
//
// Makes no network requests. Uses Node's WebCrypto.

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const {
  KDF_ITERATIONS, STORE_VERSION, MAX_AGE_MS, sessionPayload, sessionEnvelope, isExpired, openedSession,
  repairWithheldList, mergeWithheld, deriveSessionKey, toB64, fromB64
} = await import('../src/store.js');

// -- repair ----------------------------------------------------------------------
const list = [
  { id: 'ssn' },
  { id: 'spouse_ssn', loopId: 'marriages', loopIndex: 0 },
  { id: 'spouse_ssn', loopId: 'marriages', loopIndex: 1 },
  { id: 'spouse_ssn', loopId: 'marriages', loopIndex: 2 }
];
{
  const out = repairWithheldList(list, 'marriages', 1);
  check('deleting the middle marriage drops its entry and moves the last one down',
    JSON.stringify(out) === JSON.stringify([
      { id: 'ssn' },
      { id: 'spouse_ssn', loopId: 'marriages', loopIndex: 0 },
      { id: 'spouse_ssn', loopId: 'marriages', loopIndex: 1 }
    ]), JSON.stringify(out));
  check('the input list is not changed', list[3].loopIndex === 2);
  check('another loop is left alone', JSON.stringify(repairWithheldList(list, 'income', 0)) === JSON.stringify(list));
  check('merge keeps each field once, in order',
    JSON.stringify(mergeWithheld(list.slice(0, 2), [{ id: 'ssn' }, list[3]])) === JSON.stringify([list[0], list[1], list[3]]));
}

// -- payload, envelope, expiry ---------------------------------------------------
{
  const state = { answers: { ssn: '987654321', first_name: 'Ada', marriages: [{ spouse_name: 'Ann', spouse_ssn: '987654320' }] } };
  const p = sessionPayload(state, { savedAt: 5, carried: [{ id: 'routing_number' }], translations: [{ id: 'x', text: 'y' }], inputLangs: [] });
  check('the payload never holds a sensitive number', !JSON.stringify(p).includes('98765432'), JSON.stringify(p));
  check('the payload lists the state\'s withheld fields, then the carried ones',
    JSON.stringify(p.withheld) === JSON.stringify([{ id: 'ssn' }, { id: 'spouse_ssn', loopId: 'marriages', loopIndex: 0 }, { id: 'routing_number' }]),
    JSON.stringify(p.withheld));
  check('translations are saved with the session', p.translations?.length === 1);
  check('empty input languages are left out', !('inputLangs' in p));
  check('the caller\'s state is not changed', state.answers.ssn === '987654321');

  const e = sessionEnvelope({ savedAt: 5, salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==' });
  check('the envelope is v3, PBKDF2-SHA256 at 600,000 iterations',
    e.v === STORE_VERSION && STORE_VERSION === 3 && e.kdf.name === 'PBKDF2-SHA256' && e.kdf.iterations === KDF_ITERATIONS && KDF_ITERATIONS === 600000);
  check('7 days exactly is not expired', !isExpired(0, MAX_AGE_MS));
  check('a moment after 7 days is expired', isExpired(0, MAX_AGE_MS + 1));

  const o = openedSession({ savedAt: null, state: { answers: { ssn: '1', first_name: 'Ada' } }, withheld: [{ id: 'account_number' }] }, 9);
  check('an opened session takes the envelope\'s time when the payload has none', o.savedAt === 9);
  check('a number that reached a file does not come back', o.state.answers.ssn === undefined);
  check('it is withheld instead, after the file\'s list',
    JSON.stringify(o.withheld) === JSON.stringify([{ id: 'account_number' }, { id: 'ssn' }]), JSON.stringify(o.withheld));
}

// -- WebCrypto: the vector's parameters ---------------------------------------------
{
  const salt = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
  const iv = Uint8Array.from({ length: 12 }, (_, i) => (i * 53 + 7) & 0xff);
  const typed = 'Café-2468'.normalize('NFD');
  const key = await deriveSessionKey(typed, salt);
  const text = '{"savedAt":1}';
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  const again = await deriveSessionKey('Café-2468'.normalize('NFC'), fromB64(toB64(salt)));
  const back = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, again, data));
  check('the NFC and NFD spellings of a PIN derive the same key', back === text);
  let refused = false;
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await deriveSessionKey('Cafe-2468', salt), data);
  } catch { refused = true; }
  check('a wrong PIN opens nothing', refused);
}

// -- unlock → save → unlock at a count other than KDF_ITERATIONS ---------------------
// A session written at another iteration count must be re-saved at that count:
// the key unlock() derived is the one every later save uses.
{
  const disk = new Map();
  globalThis.localStorage = {
    getItem: k => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => { disk.set(k, String(v)); },
    removeItem: k => { disk.delete(k); }
  };
  const store = await import('../src/store.js');
  const LOW = 1000;
  const pin = '2468';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSessionKey(pin, salt, { iterations: LOW });
  const payload = sessionPayload({ cursor: { section: 0 }, answers: { first_name: 'Ada' } }, { savedAt: 1 });
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  disk.set('ssa-prep.state.v3', JSON.stringify(sessionEnvelope({
    savedAt: Date.now(), salt: toB64(salt), iv: toB64(iv), data: toB64(data), iterations: LOW
  })));

  const first = await store.unlock(pin);
  check('a session written at 1,000 iterations opens', first.state?.answers?.first_name === 'Ada');
  check('saving after unlock is persisted', store.saveState({ cursor: { section: 1 }, answers: { first_name: 'Grace' } }) === true);
  await store.flush();
  const saved = JSON.parse(disk.get('ssa-prep.state.v3'));
  check('the re-saved envelope records the count its key was derived at',
    saved.kdf.iterations === LOW, JSON.stringify(saved.kdf));
  store.forgetKey();
  let reopened = null;
  try { reopened = await store.unlock(pin); } catch (err) { check('the re-saved session opens', false, String(err)); }
  check('the re-saved session opens with the same PIN', reopened?.state?.answers?.first_name === 'Grace',
    JSON.stringify(reopened?.state));
  store.forgetKey();
  delete globalThis.localStorage;
}

console.log(failures === 0 ? 'store-format: all checks passed' : `store-format: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
