// What reaches localStorage, and in what form.
//
// localStorage is a plain file in the browser profile: readable by anything
// running as this user and copied into every backup. So:
//
//   - Social Security and bank numbers are never written, under any key, in
//     any form; a resumed session asks for them again (`withheld`).
//   - Everything else is written only encrypted, and only when the user set
//     a PIN. No PIN, nothing written at all.
//   - A wrong PIN opens nothing, and a session left untouched expires.
//   - A session an older version saved in plain text loses its numbers the
//     first time the page loads, and is taken off disk when it is resumed.
//   - "Erase everything" cannot be undone by a save still being encrypted.
//
// Also checks the engine side of re-asking: a correction must put the walk
// back where it found it, or a session saved afterwards resumes mid-form.
//
// Makes no network requests. Uses Node's WebCrypto, the same API the browser
// has.

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const disk = new Map();
globalThis.localStorage = {
  getItem: k => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: k => disk.delete(k)
};

const store = await import('../src/store.js');
const { SECTIONS } = await import('../src/schema.js');
const { startEngine, filler } = await import('./lib/walk.js');

const KEY = 'ssa-prep.state.v3';
const PIN = '2468-open';
const SSN = '987654321';
const SPOUSE = '987654322';
const ROUTING = '123456789';
const ACCOUNT = '000111222333';
const SECRETS = [SSN, SPOUSE, ROUTING, ACCOUNT];
const onDisk = () => [...disk.values()].join('\n');
const leaked = () => SECRETS.filter(s => onDisk().includes(s));
const rejects = async (p, kind) => { try { await p; return false; } catch (e) { return e?.kind === kind; } };

// -- every sensitive field in the schema is covered ------------------------

{
  const inSchema = [];
  for (const section of SECTIONS) {
    for (const q of section.questions) {
      const fields = q.type === 'loop' ? q.fields : [q];
      for (const f of fields) if (store.SENSITIVE_TYPES.has(f.type)) inSchema.push(f.id);
    }
  }
  check('the schema has the sensitive fields this test expects',
    ['ssn', 'spouse_ssn', 'routing_number', 'account_number'].every(id => inSchema.includes(id)),
    inSchema.join(', '));
}

// -- a finished interview, with every sensitive answer filled -------------

// filler() says no to every loop; say yes to one marriage so a sensitive
// field inside a loop item exists to be withheld.
let married = false;
const answer = q => {
  if (q.loopId === 'marriages' && q.loopPhase === 'entry' && !married) { married = true; return true; }
  return filler(q, 'ssa');
};
const engine = startEngine('ssa');
for (let n = 0, q; (q = engine.current()) && n < 3000; n++) engine.submit(answer(q));
check('the walk finishes', engine.current() === null);
engine.setAnswer('ssn', SSN);
engine.setAnswer('routing_number', ROUTING);
engine.setAnswer('account_number', ACCOUNT);
check('the walk recorded a marriage', (engine.answers().marriages ?? []).length > 0);
engine.setAnswer('spouse_ssn', SPOUSE, { loopId: 'marriages', loopIndex: 0 });
const full = engine.getState();
const NAME = full.answers.first_name;

// -- no PIN, no saving ------------------------------------------------------

{
  check('this runtime can encrypt', store.canEncrypt());
  check('without a PIN nothing persists', store.isPersisting() === false);
  check('without a PIN saveState says so', store.saveState(full) === false);
  await store.flush();
  check('without a PIN nothing is written', disk.size === 0, [...disk.keys()].join());
  check('a PIN shorter than the minimum is refused', await rejects(store.usePin('12'), 'pin'));
}

// -- saving, encrypted --------------------------------------------------------

{
  await store.usePin(PIN);
  check('with a PIN saveState saves', store.saveState(full) === true);
  await store.flush();
  const blob = JSON.parse(disk.get(KEY) ?? 'null');
  check('an encrypted session is written', blob?.v === 3 && !!blob.data && !!blob.iv && !!blob.kdf?.salt);
  check('no sensitive number reaches storage', leaked().length === 0, `found ${leaked().join(', ')}`);
  check('the other answers are not readable on disk either', !onDisk().includes(NAME), NAME);
  check('the in-memory state is untouched by saving', full.answers.ssn === SSN);
  check('the saved session shows as locked', store.savedSessionInfo()?.locked === true);

  const first = JSON.parse(disk.get(KEY));
  store.saveState(full);
  await store.flush();
  check('each save uses a fresh IV', JSON.parse(disk.get(KEY)).iv !== first.iv);
}

// -- opening it ---------------------------------------------------------------

{
  store.forgetKey();
  check('a wrong PIN opens nothing', await rejects(store.unlock('1357-nope'), 'pin'));
  check('and leaves nothing unlocked', store.isPersisting() === false);

  const good = disk.get(KEY);
  const blob = JSON.parse(good);
  const bytes = Uint8Array.from(atob(blob.data), c => c.charCodeAt(0));
  bytes[0] ^= 1;
  disk.set(KEY, JSON.stringify({ ...blob, data: btoa(String.fromCharCode(...bytes)) }));
  check('a tampered session is refused, not decrypted to garbage', await rejects(store.unlock(PIN), 'pin'));
  disk.set(KEY, good);

  const saved = await store.unlock(PIN);
  check('the right PIN opens it', saved.state.answers.first_name === NAME);
  check('with no sensitive answers in it', store.sensitiveAnswers(saved.state).length === 0);
  const ids = saved.withheld.map(w => w.id).sort();
  check('and a list of what to ask again',
    JSON.stringify(ids) === JSON.stringify(['account_number', 'routing_number', 'spouse_ssn', 'ssn']), ids.join());
  check('a loop field is withheld with its place',
    saved.withheld.some(w => w.id === 'spouse_ssn' && w.loopId === 'marriages' && w.loopIndex === 0));
  check('unlocking keeps protecting later saves', store.isPersisting() === true);

  // Resumed and saved again before the numbers were given again: they must
  // still be on the list next time.
  store.saveState(saved.state);
  await store.flush();
  store.forgetKey();
  const twice = await store.unlock(PIN);
  check('withheld answers survive a second save', twice.withheld.length === 4, String(twice.withheld.length));

  // Given the SSN again: still never stored.
  const given = structuredClone(twice.state);
  given.answers.ssn = SSN;
  store.saveState(given);
  await store.flush();
  check('an SSN given again is still not stored', leaked().length === 0);

  // An import is a new session, not a continuation of the saved one.
  store.saveState(given, { replace: true });
  await store.flush();
  store.forgetKey();
  const fresh = await store.unlock(PIN);
  check('replace starts the withheld list over',
    fresh.withheld.length === 1 && fresh.withheld[0].id === 'ssn', JSON.stringify(fresh.withheld));
}

// -- expiry -------------------------------------------------------------------

{
  const savedAt = JSON.parse(disk.get(KEY)).savedAt;
  check('a recent session is kept', store.savedSessionInfo(savedAt + 1000) !== null);
  check('an old one is deleted', store.savedSessionInfo(savedAt + store.MAX_AGE_MS + 1) === null);
  check('from disk', !disk.has(KEY));
}

// -- erase while a save is in flight -----------------------------------------

{
  store.saveState(full);
  store.clearState();       // before the queued encryption has finished
  await store.flush();
  check('a save queued before an erase does not bring it back', !disk.has(KEY));
}

// -- a session saved in plain text by an older version ------------------------

{
  store.forgetKey();
  disk.clear();
  disk.set('ssa-prep.state.v1', JSON.stringify({ savedAt: Date.now(), state: full }));
  check('the legacy blob holds the numbers (setup)', leaked().length === 4);
  store.scrubLegacy();
  check('page load scrubs its numbers from disk', leaked().length === 0, `found ${leaked().join(', ')}`);
  check('and it can still be resumed', store.savedSessionInfo()?.locked === false);
  const taken = store.takeLegacy();
  check('resuming it hands back the rest', taken?.state?.answers?.first_name === NAME);
  check('and what to ask again', taken?.withheld?.length === 4);
  check('and takes it off disk', disk.size === 0, [...disk.keys()].join());
}

// -- a correction puts the walk back ----------------------------------------

{
  const e = startEngine('ssa');
  for (let n = 0, q; (q = e.current()) && n < 3000; n++) e.submit(filler(q, 'ssa'));
  const depth = e.getState().history.length;
  const before = e.cursorSnapshot();
  e.jumpTo('ssn');
  check('jumpTo moves the walk (setup)', e.current()?.id === 'ssn');
  e.setAnswer('ssn', SSN);
  e.restoreCursor(before);
  check('after a correction the interview is still finished', e.current() === null, e.current()?.id);
  check('and the undo stack is as it was', e.getState().history.length === depth);
}

console.log(failures === 0 ? 'store-redact: all checks passed' : `store-redact: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
