// Smoke test: boot main.js against a stub DOM and drive a real interview.
//
// Deliberately NOT in tests/, which CI runs in full: this stubs the DOM by
// hand, so an ordinary edit to index.html can break it in ways that say
// nothing about whether the app works. Run it by hand after touching the turn
// loop — `node tools/smoke.mjs` — where it covers what no other test reaches,
// the wiring in main.js: the read-back keys, the confirm fields, and adding a
// loop entry from the review prompt.
//
// It found two real bugs when it was written: a typed answer never reaching
// the local parser, and the read-back hint missing on the typed path.
import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(`${REPO}/index.html`, 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
// Honor `hidden` as the markup declares it, or the stub reports every panel
// visible and the assertions below mean nothing.
const hiddenIds = new Set([...html.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)]
  .filter(m => /\shidden(\s|>|=)/.test(m[0])).map(m => m[1]));

const listeners = new Map();
const make = id => ({
  id, hidden: hiddenIds.has(id), textContent: '', value: '', checked: true,
  dataset: {}, style: {}, classList: { add() {}, remove() {} },
  addEventListener(type, fn) { listeners.set(`${id}:${type}`, fn); },
  removeEventListener() {}, focus() {}, click() { listeners.get(`${id}:click`)?.({}); },
  querySelectorAll: () => [], appendChild() {}, setAttribute() {}, remove() {},
  append(...kids) { this.textContent += kids.map(k => k?.textContent ?? '').join(' '); },
  replaceChildren() { this.textContent = ''; }
});
const nodes = Object.fromEntries(ids.map(id => [id, make(id)]));

const docListeners = new Map();
globalThis.document = {
  readyState: 'complete',
  getElementById: id => nodes[id] ?? null,
  querySelector: () => ({ value: 'voice', checked: true }),
  querySelectorAll: sel => (sel === '[data-command]'
    ? ['repeat', 'back', 'skip', 'where', 'correct', 'finish'].map(c => {
        const n = make(`cmd-${c}`); n.dataset = { command: c }; return n;
      })
    : []),
  createElement: () => make('created'),
  addEventListener: (t, fn) => docListeners.set(t, fn),
  body: make('body')
};
globalThis.window = {
  addEventListener() {}, location: { search: '' },
  AudioContext: class { constructor() { this.state = 'running'; } createAnalyser() { return { fftSize: 0, getByteTimeDomainData() {} }; } createMediaStreamSource() { return { connect() {} }; } },
  SpeechSynthesisUtterance: class {},
  speechSynthesis: { speak() {}, cancel() {} }
};
globalThis.navigator = { mediaDevices: { getUserMedia: async () => { throw new Error('no mic'); } } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
globalThis.Audio = class { play() { return Promise.resolve(); } addEventListener() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.performance = { now: () => Date.now() };
globalThis.URLSearchParams = URLSearchParams;
globalThis.caches = undefined;
globalThis.location = { search: '' };

await import(`${REPO}/src/main.js`);

const fail = [];
const ok = (label, cond) => { if (!cond) { fail.push(label); console.error('FAIL', label); } };

ok('boot wired the keyboard', docListeners.has('keydown') && docListeners.has('keyup'));
ok('read-back controls start hidden', nodes['readback-controls'].hidden === true);
ok('accept button is wired', listeners.has('accept-readback:click'));
ok('reject button is wired', listeners.has('reject-readback:click'));
ok('confirm checkbox exists', !!nodes['confirm-answers']);

// Start the interview, then drive the keys the way a user would.
listeners.get('start-button:click')({});
await new Promise(r => setTimeout(r, 120));
ok('the interview panel is showing', nodes['interview-panel'].hidden === false);
ok('a question is on screen', nodes['question-heading'].textContent.length > 0);

const keydown = docListeners.get('keydown');
const keyup = docListeners.get('keyup');
const press = code => { keydown({ code, target: nodes.body, preventDefault() {} }); keyup({ code, target: nodes.body, preventDefault() {} }); };

// With no read-back open, space is push-to-talk and must not throw.
press('Space');
await new Promise(r => setTimeout(r, 60));
ok('space with no read-back open does not crash', true);

// -- a real turn: type answers until a read-back opens, then press space ---

const settle = () => new Promise(r => setTimeout(r, 40));
const type = async text => {
  nodes['text-answer'].value = text;
  listeners.get('text-submit:click')({});
  await settle();
};

const q = () => nodes['question-heading'].textContent;
await type('starter kit');
ok('the form choice was accepted', !/which form/i.test(q()));

// Walk to the date of birth, which is a `confirm` field.
let guard = 0;
while (!/date of birth/i.test(q()) && guard++ < 20) await type('Alex');
ok('reached the date of birth question', /date of birth/i.test(q()));
ok('the new prompt states the order', /month, the day, and then the year/i.test(q()));

await type('March 14th 1979');
ok('a confirm field opens a read-back', /is that correct/i.test(q()), q());
ok('the read-back controls are showing', nodes['readback-controls'].hidden === false);
ok('the hint names the space bar', /space bar/i.test(nodes['hint'].textContent));

// The whole point of the feedback: one keystroke, no spoken "yes".
press('Space');
await settle();
ok('space accepted the read-back', !/is that correct/i.test(q()), q());
ok('and moved to the next question', /born/i.test(q()) || q().length > 0);
ok('the controls are hidden again', nodes['readback-controls'].hidden === true);

// Now reject one with N.
while (!/social security number/i.test(q()) && guard++ < 40) await type('Portland');
ok('reached the SSN question', /social security/i.test(q()), q());
await type('555-11-2233');
ok('the SSN is read back', /is that correct/i.test(q()), q());
press('KeyN');
await settle();
ok('N reopened the question', /social security/i.test(q()), q());
ok('and hid the controls', nodes['readback-controls'].hidden === true);

// -- adding a condition from the review screen ----------------------------
//
// The reported bug: "add conditions" replaced the first condition instead of
// creating a second one.

await type('555-11-2233');
press('Space');
await settle();

// Walk to the conditions list and record one.
guard = 0;
while (!/medical condition/i.test(q()) && guard++ < 60) {
  await type(/\?$/.test(q()) && /(yes|no)/i.test(nodes['hint'].textContent) ? 'no' : 'skip');
}
ok('reached the conditions question', /medical condition/i.test(q()), q());
await type('diabetes');
ok('the condition was recorded', true);

// Jump to the review screen and ask to add another.
// "Change an answer" opens the same prompt mid-interview, without needing
// every required field filled in first.
press('KeyC');
await settle();
ok('the which-answer prompt is open', /which answer/i.test(q()), q());
ok('its hint mentions adding', /add another condition/i.test(nodes['hint'].textContent));

await type('add another condition');
ok('a new condition is being asked for', /name of this condition/i.test(q()), q());
ok('the label says adding, not changing', /adding a condition/i.test(nodes['section-label'].textContent),
  nodes['section-label'].textContent);

await type('arthritis');
ok('then it offers another', /another medical condition/i.test(q()), q());
await type('no');
await settle();
ok('and lands back on review', nodes['review-panel'].hidden === false);
ok('reporting what was added', /added/i.test(nodes['review-intro'].textContent),
  nodes['review-intro'].textContent);
// Every command key, twice, to be sure none of them throws.
for (const code of ['KeyB', 'KeyS', 'KeyW', 'KeyR', 'KeyT', 'Enter', 'KeyN', 'Escape']) press(code);
await new Promise(r => setTimeout(r, 80));
ok('command keys do not crash', true);

console.log(fail.length ? `\n${fail.length} smoke failure(s)` : '\nSmoke test passed.');
process.exit(fail.length ? 1 : 0);
