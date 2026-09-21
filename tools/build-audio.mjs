// Pre-synthesize every fixed spoken string to audio/.
//
// The interview script never changes at runtime, so paying to synthesize it on
// every session — and again on every "repeat" — is pure waste. This walks the
// schema plus the fixed phrase list, synthesizes each clip once, and writes
// content-hashed mp3s that speech.js serves for free.
//
// Usage:
//   node tools/build-audio.mjs            synthesize anything missing
//   node tools/build-audio.mjs --prune    also delete clips nothing references
//   node tools/build-audio.mjs --dry-run  list what would be synthesized
//
// Needs OPENAI_API_KEY in the environment. Only synthesizes hashes that are
// missing from audio/, so re-running after a wording tweak costs one clip.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SECTIONS, sectionCountsByForm } from '../src/schema.js';
import { allPhrases } from '../src/phrases.js';
import { canonical, normalizeText, VOICE, TTS_INSTRUCTIONS } from '../src/ttshash.js';
import { formatTimeRemaining } from '../src/a11y.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = join(ROOT, 'audio');
const MANIFEST = join(AUDIO_DIR, 'manifest.json');

const MODEL = 'gpt-4o-mini-tts';
const BASE = 'https://api.openai.com/v1';

const args = new Set(process.argv.slice(2));
const PRUNE = args.has('--prune');
const DRY_RUN = args.has('--dry-run');

/** Node-side digest. Must match hashText() in src/ttshash.js exactly. */
function hash(text) {
  return createHash('sha256').update(canonical(text), 'utf8').digest('hex').slice(0, 16);
}

// -- the corpus ------------------------------------------------------------

/**
 * Every string the app can speak without a user's answer in it.
 *
 * Section preambles and item labels are emitted as their own clips rather than
 * baked into the question text. main.js speaks them as separate utterances so
 * each is an independent cache hit — otherwise "Section 3 of 19. <question>"
 * would be a distinct string from "<question>" and neither would ever be
 * reused.
 */
function collectCorpus() {
  const out = new Set();
  const add = t => { const s = normalizeText(t); if (s) out.add(s); };

  allPhrases().forEach(add);

  // Sections are numbered among those the chosen forms use, so each form
  // choice has its own count: "Section 3 of 20." for the Starter Kit alone,
  // "of 19" for the DS application, "of 32" for both.
  for (const count of sectionCountsByForm()) {
    for (let i = 1; i <= count; i++) add(`Section ${i} of ${count}.`);
  }

  SECTIONS.forEach(section => {
    add(`${section.title}.`);

    for (const q of section.questions) {
      add(q.prompt);
      add(q.warn);
      add(q.hint);
      add(q.entryPrompt);
      add(q.repeatPrompt);

      for (const f of q.fields ?? []) {
        add(f.prompt);
        add(f.warn);
        add(f.hint);
      }

      // "Provider 2." — spoken at the top of each loop item after the first.
      if (q.itemLabel) {
        for (let n = 2; n <= MAX_LOOP_ITEMS; n++) {
          add(`${titleCase(q.itemLabel)} ${n}.`);
        }
        // Opening the first item of an empty list from the review screen has
        // no "Provider 2." to announce it, so it says this instead.
        add(`Adding a new ${q.itemLabel}.`);
      }
    }
  });

  // formatTimeRemaining() buckets hard, so its whole range is a few dozen
  // strings. Enumerating them costs pennies once and makes every section
  // break free.
  for (const seconds of TIME_SAMPLES) {
    const left = formatTimeRemaining(seconds);
    if (left) add(`${left} left.`);
  }

  return [...out];
}

// Must match MAX_LOOP_ITEMS in src/correct.js, which refuses to add past it
// for exactly this reason: item 13 would have no clip to announce it.
const MAX_LOOP_ITEMS = 12;

/** Enough sample points to hit every bucket formatTimeRemaining can return. */
const TIME_SAMPLES = (() => {
  const s = [30];
  for (let m = 1; m <= 60; m += 1) s.push(m * 60);
  for (let m = 60; m <= 300; m += 15) s.push(m * 60);
  return s;
})();

/** Must match titleCase() in src/main.js, or multi-word labels never hit. */
function titleCase(s) {
  return String(s).replace(/^(.)/, (_, c) => c.toUpperCase());
}

// -- synthesis -------------------------------------------------------------

async function synthesize(text, key) {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: text,
      response_format: 'mp3',
      instructions: TTS_INSTRUCTIONS
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`TTS ${res.status} for ${JSON.stringify(text.slice(0, 60))}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// -- main ------------------------------------------------------------------

async function main() {
  const corpus = collectCorpus();
  const wanted = new Map(corpus.map(text => [hash(text), text]));

  await mkdir(AUDIO_DIR, { recursive: true });
  const existing = new Set(
    (await readdir(AUDIO_DIR).catch(() => []))
      .filter(f => f.endsWith('.mp3'))
      .map(f => f.replace(/\.mp3$/, ''))
  );

  const missing = [...wanted].filter(([h]) => !existing.has(h));
  const chars = missing.reduce((n, [, t]) => n + t.length, 0);

  console.log(`${corpus.length} strings in corpus, ${existing.size} already synthesized.`);
  console.log(`${missing.length} to synthesize (${chars} characters).`);

  if (DRY_RUN) {
    missing.forEach(([h, t]) => console.log(`  ${h}  ${JSON.stringify(t.slice(0, 70))}`));
  } else if (missing.length) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.error('OPENAI_API_KEY is not set. Nothing was synthesized.');
      process.exit(1);
    }
    let done = 0;
    for (const [h, text] of missing) {
      const mp3 = await synthesize(text, key);
      await writeFile(join(AUDIO_DIR, `${h}.mp3`), mp3);
      done++;
      process.stdout.write(`\r  synthesized ${done}/${missing.length}`);
    }
    process.stdout.write('\n');
  }

  // The manifest carries hashes only. The plaintext is already in schema.js
  // and phrases.js, and duplicating it here would double the text the browser
  // downloads to answer a question it can compute itself.
  const manifest = {
    version: 1,
    voice: VOICE,
    hashes: [...wanted.keys()].sort()
  };
  if (!DRY_RUN) {
    await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const orphans = [...existing].filter(h => !wanted.has(h));
  if (orphans.length) {
    if (PRUNE && !DRY_RUN) {
      for (const h of orphans) await unlink(join(AUDIO_DIR, `${h}.mp3`));
      console.log(`Pruned ${orphans.length} clip(s) nothing references.`);
    } else {
      console.log(`${orphans.length} clip(s) nothing references. Re-run with --prune to delete.`);
    }
  }

  console.log(`Manifest: ${manifest.hashes.length} entries.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
