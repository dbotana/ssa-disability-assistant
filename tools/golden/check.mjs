// Golden freshness check.
//
// Regenerates every golden fixture and verifies nothing changed. CI runs this
// and fails on any diff: a golden that drifted means the Kotlin port is
// pinned to stale reference behavior, which is exactly the bug goldens exist
// to prevent.
//
// Two ways a golden can be stale, and both fail here: a tracked file whose
// content changed (git diff), and a file the generator writes that was never
// committed at all (git status). `git diff` alone is blind to the second.
//
// Usage: node tools/golden/check.mjs   (also regenerates tools/schema.json)

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PATHS = 'android/core/src/test/resources/golden android/core/src/main/resources/golden tools/schema.json';

// The generator forces UTC itself; this makes the schema export match too.
const env = { ...process.env, TZ: 'UTC' };
execSync('node tools/golden/index.mjs', { cwd: ROOT, stdio: 'inherit', env });
execSync('node tools/export-schema.mjs', { cwd: ROOT, stdio: 'inherit', env });

const problems = [];
try {
  execSync(`git diff --exit-code -- ${PATHS}`, { cwd: ROOT, stdio: 'pipe' });
} catch (err) {
  problems.push(err.stdout?.toString() ?? 'changed');
}
const status = execSync(`git status --porcelain --untracked-files=all -- ${PATHS}`, { cwd: ROOT }).toString().trim();
const untracked = status.split('\n').filter(l => l.startsWith('??'));
if (untracked.length) problems.push(`not committed:\n${untracked.join('\n')}`);

if (problems.length) {
  process.stderr.write(`${problems.join('\n')}\n`);
  console.error('goldens are stale: regenerate with `node tools/golden/index.mjs` and commit the result');
  process.exit(1);
}
console.log('goldens fresh');
