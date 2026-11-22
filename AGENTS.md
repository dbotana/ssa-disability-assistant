# AGENTS.md

Rules for coding agents working in this repository (opencode, Claude Code, agent-loop stages).
Read this before running any command.

## What this repository is

A voice assistant that helps a blind user fill out disability forms (SSA-64-110 and Maine DHHS
Developmental Services Intake) without anything they say leaving the device. The web app in
`src/` is the reference implementation. `android/` and `ios/` port it, and the port must match
the reference exactly where `ios-android-mirror-plan.md` says so (its "Parity contract").

```
src/                     web app, the JS reference implementation
tests/                   node tests for the web app (node tests/<file>.js)
tools/                   schema export, golden generation and checks, turn scenarios, eval tools
tools/golden/            goldens are generated from the JS reference; check.mjs checks they're fresh
android/                 Gradle project: core (Kotlin multiplatform), pdf, core-device, app, ...
ios/CoreCrypto/          Swift package: the iOS Crypto, linked against the core XCFramework
forms/                   blank official PDF templates
models/, vendor/         pinned model and library files, checked by tests/vendor-integrity.js
ios-android-mirror-plan.md   the plan for the iOS and Android apps, with a Progress log
TODO.md                  open work and decisions later readers need
agent-loop-runs/         agent-loop run records (git-ignored, not recoverable if lost)
plans/                   working plans (git-ignored)
```

## Git: never run these

Untracked and git-ignored files are not recoverable, and this repo has many of them:
`agent-loop-runs/`, `plans/`, `assignment-info/`, `.claude/settings.local.json`, build outputs
and in-progress work. One command can delete all of them.

**Never run:**

- `git stash` in any form (`push`, `-u`, `-a`, `--all`, `--include-untracked`, `--keep-index`),
  or `git stash pop`/`apply`/`drop`/`clear`;
- `git clean`, with any flags;
- `git checkout -- <path>`, `git checkout .`, or `git restore` on a working-tree path;
- `git reset`, in any mode (`--hard`, `--mixed`, `--soft`, or with paths);
- `git rebase`, `git commit --amend`, `git push --force`, `git branch -D`, `git worktree remove`;
- `rm -rf` on any folder you did not create in this session.

**Allowed:** `git status`, `git diff`, `git log`, `git show`, `git ls-files`, `git blame`, and
`git show <rev>:<path>` to read an old version of a file.

**To undo your own change,** edit the file back by hand, or read the old version with
`git show HEAD:<path>` and write it out. Never use git to throw away work. If you think a file
has been lost or changed by mistake, stop and report it. Don't try to recover it.

**Don't commit or push** unless the task asks for it. The owner commits between runs.

## Files

- Don't move files out of the repo (for example to `/tmp`) to make a build pass. If a file
  doesn't compile, fix it, or leave it and report the error.
- Ask before deleting, moving or overwriting a file you did not create in this session.
- Never edit anything in `agent-loop-runs/` or the plans agent-loop saves. They are records.
- Never commit a filled form, an exported session, or anything else that could hold a real SSN
  (see `.gitignore`). Use the synthetic fixtures in `tests/fixtures/`.

## Goldens and the port

- The JS in `src/` is the reference. When behaviour changes, change the JS first, regenerate the
  goldens from it, then update the Kotlin port.
- Fix the port, never the goldens. A golden may change only when the JS reference produces the
  change. Never edit a golden by hand.
- Goldens are generated in UTC. Run Gradle tests with `TZ=UTC`.

## Running commands

The Claude stages run in a command sandbox. Gradle, adb, the emulator, simctl and xcodebuild
work only when the command matches an allowed pattern. So:

- Run each Gradle, adb, emulator, xcrun, xcodebuild and swift command on its own, never chained
  with `;`, `&&` or `|`, from the directory the plan gives (usually `android/` or
  `ios/CoreCrypto/`).
- If a command is refused, record the exact refusal word for word and carry on. Don't work
  around it with another tool.
- Don't change Kotlin, Gradle, AGP or library versions unless the task says to. If an upgrade is
  needed, upgrade only that and what depends on it.
- Don't create an iOS app target or `.xcodeproj` until the plan reaches X6.

Common checks:

```sh
for f in tests/*.js; do node "$f"; done          # web tests
node tools/smoke.mjs                             # turn-loop smoke test
DEVELOPER_DIR=/Library/Developer/CommandLineTools node tools/golden/check.mjs   # goldens fresh
# from android/
TZ=UTC ./gradlew :core:jvmTest
TZ=UTC ./gradlew :core:compileCommonMainKotlinMetadata
SIMCTL_CHILD_GOLDEN_DIR=$PWD/core/build/ios-test-resources ./gradlew :core:iosSimulatorArm64Test
TZ=UTC ./gradlew :core-device:connectedDebugAndroidTest    # needs the ssa35 emulator booted
./tools/run-pdf-spike.sh ssa35
# from ios/CoreCrypto/
xcodebuild test -scheme CoreCrypto -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
```

## Privacy

- Nothing the user says or types may leave the device. Don't add network calls, analytics,
  crash reporting, cloud speech or translation services, or dependencies that bring them in.
  `tests/no-network.js`, the Android permission audit and the iOS binary audit enforce this.
- Models run locally. New model or library files must be pinned and listed in the checksums.
- Don't add dependencies unless the plan calls for them.

## Reporting

- Record what you ran and what happened, with exact commands and results, in the plan's
  Progress section and in `TODO.md` when the task asks.
- Say plainly what you could not run or verify. Don't claim a check passed unless you ran it and
  saw it pass.
- Never invent dates, numbers, test counts or results.
