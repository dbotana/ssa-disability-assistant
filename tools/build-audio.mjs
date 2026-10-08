// Pre-synthesize every fixed spoken string to audio/. MAINTAINER-ONLY.
//
// This is the one place this project calls a cloud API, and it never sees a
// user's data: its input is the fixed interview script from schema.js and
// phrases.js, the same text anyone can read in this repository. It runs on a
// maintainer's machine, its output is committed, and the app only ever plays
// the resulting files. Anything that contains an answer is spoken at runtime
// by an on-device voice instead (see speech.js).
//
// The interview script never changes at runtime, so this walks the schema
// plus the fixed phrase list, synthesizes each clip once, and writes
// content-hashed mp3s that speech.js plays from disk. A string with no clip
// is read by the system voice, so skipping this costs polish, not function.
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

import { canonical, VOICE, TTS_INSTRUCTIONS } from '../src/ttshash.js';
import { collectCorpus } from './tts-corpus.mjs';

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

// -- synthesis -------------------------------------------------------------// -- synthesis -------------------------------------------------------------

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
