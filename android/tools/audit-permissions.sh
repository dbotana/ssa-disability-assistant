#!/usr/bin/env bash
# Permission audit: the app ships with no INTERNET and no ACCESS_NETWORK_STATE.
#
# Layers, from the plan's privacy section:
#   1. The app manifest removes both with tools:node="remove", and a Gradle
#      check (verify<Variant>NoNetworkPermissions in :app) fails the build if
#      either survives into a merged manifest.
#   2. This script checks the *built artifacts*: every APK through
#      `aapt2 dump permissions`, every module of every AAB through
#      `bundletool dump manifest` (AAB manifests are protobuf, not XML), and
#      raw merged manifests as text.
#   3. CI runs it on every artifact, and a canary job builds a real APK and
#      AAB that request INTERNET (:canary) and proves each branch fires.
#
# It fails closed: a missing tool, or a tool that errors, is a failure, not a
# clean result. An audit that cannot look has not passed.
#
# Usage: audit-permissions.sh <artifact.apk|artifact.aab|AndroidManifest.xml ...>
#   AAPT2       path to aapt2 (default: newest build-tools under $ANDROID_HOME)
#   BUNDLETOOL  path to a bundletool jar (required for .aab)
# Exits 1 when a forbidden permission is found, 2 when the audit cannot run.

set -euo pipefail

FORBIDDEN_RE='android\.permission\.(INTERNET|ACCESS_NETWORK_STATE)'

die() { echo "PERMISSION AUDIT ERROR: $*" >&2; exit 2; }

[ $# -gt 0 ] || { echo "usage: $0 <artifact...>" >&2; exit 2; }

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "${AAPT2:-}" ] && [ -n "$sdk" ] && [ -d "$sdk/build-tools" ]; then
  AAPT2="$(ls -d "$sdk"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)"
fi

found=""
checked=0
for artifact in "$@"; do
  [ -f "$artifact" ] || die "no such artifact: $artifact"
  case "$artifact" in
    *.apk)
      [ -n "${AAPT2:-}" ] && [ -x "$AAPT2" ] || die "aapt2 not found (set AAPT2 or ANDROID_HOME)"
      # Captured first, so a failing aapt2 stops the audit instead of reading
      # as "no permissions".
      out="$("$AAPT2" dump permissions "$artifact")" || die "aapt2 failed on $artifact"
      # aapt2 prints `uses-permission: name='android.permission.INTERNET'`,
      # and uses-permission-sdk-23 the same way.
      if grep -qE "^uses-permission(-sdk-23)?: name='$FORBIDDEN_RE'" <<<"$out"; then
        found="$found $artifact"
      fi
      ;;
    *.aab)
      [ -n "${BUNDLETOOL:-}" ] && [ -f "$BUNDLETOOL" ] || die "bundletool jar not found (set BUNDLETOOL)"
      modules="$(unzip -Z1 "$artifact" | sed -n 's#^\([^/]*\)/manifest/AndroidManifest.xml$#\1#p')" \
        || die "could not list $artifact"
      [ -n "$modules" ] || die "no module manifests in $artifact"
      for m in $modules; do
        out="$(java -jar "$BUNDLETOOL" dump manifest --bundle "$artifact" --module "$m")" \
          || die "bundletool failed on $artifact module $m"
        if grep -qE "<uses-permission(-sdk-23)? [^>]*android:name=\"$FORBIDDEN_RE\"" <<<"$out"; then
          found="$found $artifact($m)"
        fi
      done
      ;;
    *.xml)
      # A raw merged manifest, as the Gradle check and the canary use.
      if grep -qE "<uses-permission(-sdk-23)?[^>]*android:name=\"$FORBIDDEN_RE\"" "$artifact"; then
        found="$found $artifact"
      fi
      ;;
    *)
      die "unknown artifact type: $artifact"
      ;;
  esac
  checked=$((checked + 1))
done

if [ -n "$found" ]; then
  echo "PERMISSION AUDIT FAILED: forbidden permission in:$found" >&2
  echo "Forbidden: INTERNET, ACCESS_NETWORK_STATE" >&2
  exit 1
fi

echo "permission audit clean ($checked artifacts)"
