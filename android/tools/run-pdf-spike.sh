#!/usr/bin/env bash
# M1a's one-command spike: boot an AVD headless if needed, run the :pdf
# instrumented tests, re-read the published PDFs with pdf-lib, and print the
# measurement table. Read-only with respect to the repository; the only files
# it writes are build outputs.
#
#   android/tools/run-pdf-spike.sh [avd]      (default: ssa35)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO/android"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(ls -d "$HOME"/Library/Java/JavaVirtualMachines/*/Contents/Home 2>/dev/null | tail -1 || true)"
  export JAVA_HOME
fi
export PATH="$ANDROID_HOME/platform-tools:$PATH"
export TZ=UTC

ADB="$ANDROID_HOME/platform-tools/adb"
AVD="${1:-ssa35}"
STARTED_EMULATOR=0

cleanup() {
  if [ "$STARTED_EMULATOR" = "1" ]; then
    echo "stopping the emulator this script started"
    "$ADB" emu kill >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! "$ADB" devices | awk 'NR > 1 && $2 == "device" { found = 1 } END { exit !found }'; then
  echo "no device attached; booting $AVD headless"
  "$ANDROID_HOME/emulator/emulator" -avd "$AVD" \
    -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
    >/dev/null 2>&1 &
  STARTED_EMULATOR=1
  "$ADB" wait-for-device
  deadline=$((SECONDS + 300))
  until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "pdf spike: $AVD did not finish booting in 300 s" >&2
      exit 1
    fi
    sleep 2
  done
fi

./gradlew :pdf:connectedDebugAndroidTest --stacktrace

OUT="pdf/build/outputs/connected_android_test_additional_output/debugAndroidTest/connected"
if [ -z "$(find "$OUT" -type f -print -quit 2>/dev/null)" ]; then
  echo "pdf spike: $OUT is empty; no PDFs were published" >&2
  exit 1
fi

node "$REPO/tools/golden/crosscheck.mjs" "$OUT"
node tools/pdf-spike-report.mjs "$OUT"

echo "PDFs: $REPO/android/$OUT"
