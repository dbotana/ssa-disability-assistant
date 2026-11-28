#!/bin/sh
# Copy the repository files the CoreCrypto package's tests read into
# ios/CoreCrypto/Sources/RepoFixtures/repo/, keeping the repository layout, so
# they ship inside the test bundles and the tests can run on a phone. Run it
# from anywhere, before every phone build: the copies are a snapshot, and the
# simulator and host runs never read them.
#
#   ios/tools/stage-device-fixtures.sh
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEST="$ROOT/ios/CoreCrypto/Sources/RepoFixtures/repo"

FILES="
forms/ssa-adult-disability-starter-kit-64-110.pdf
forms/maine-developmental-services-intake-2025-06-18.pdf
vendor/pdf-lib.min.js
vendor/ssa-pdf-writer.js
vendor/SHA256SUMS
tools/schema.json
android/core/src/commonMain/resources/golden/metrics.json
android/core/src/commonMain/resources/golden/templateManifest.json
android/core/src/commonTest/resources/golden/store.json
android/core/src/commonTest/resources/golden/fillplans.json
"

# Clear the previous snapshot. Only these generated subfolders, never DEST
# itself, which holds the tracked README.md.
for top in forms vendor tools android; do
  rm -rf "${DEST:?}/$top"
done

for f in $FILES; do
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$ROOT/$f" "$DEST/$f"
done

echo "staged $(echo "$FILES" | grep -c .) files into $DEST"
