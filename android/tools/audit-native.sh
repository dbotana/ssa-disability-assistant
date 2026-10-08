#!/usr/bin/env bash
# Native library audit, on the built APKs.
#
# Three checks on every lib/<abi>/*.so in every APK given:
#   1. ELF: every PT_LOAD segment is aligned to at least 16 KB (0x4000), or
#      Android 15+ devices with 16 KB pages refuse to load the library.
#   2. Zip: the APK passes `zipalign -c -P 16`, so an uncompressed .so also
#      sits on a 16 KB boundary inside the file, where the loader maps it.
#   3. Exports: our own libraries (OWN_LIBS) export nothing but the JNI
#      surface (Java_*, JNI_OnLoad, JNI_OnUnload), as their version scripts
#      promise. ggml linked into them must not leak its symbols.
#
# It fails closed: no APK, no library to check, or a missing tool is a
# failure. An audit that found nothing to look at has not passed.
#
# Usage: audit-native.sh <app.apk ...>
#   READELF / LLVM_NM / ZIPALIGN  tool paths (default: found under $ANDROID_HOME)
#   OWN_LIBS  space-separated library names to export-check (default below)
# Exits 1 on a failed check, 2 when the audit cannot run.

set -euo pipefail

OWN_LIBS="${OWN_LIBS:-libwhisper_jni.so libllama_jni.so}"

die() { echo "NATIVE AUDIT ERROR: $*" >&2; exit 2; }
[ $# -gt 0 ] || { echo "usage: $0 <app.apk ...>" >&2; exit 2; }

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
find_ndk_tool() {
  [ -n "$sdk" ] && [ -d "$sdk/ndk" ] || return 0
  # llvm-readelf is a symlink to llvm-readobj, so links count too.
  find "$sdk"/ndk/*/toolchains/llvm/prebuilt -name "$1" \( -type f -o -type l \) 2>/dev/null | sort | tail -1
}
READELF="${READELF:-$(find_ndk_tool llvm-readelf)}"
LLVM_NM="${LLVM_NM:-$(find_ndk_tool llvm-nm)}"
if [ -z "${ZIPALIGN:-}" ] && [ -n "$sdk" ] && [ -d "$sdk/build-tools" ]; then
  ZIPALIGN="$(ls -d "$sdk"/build-tools/*/zipalign 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$READELF" ] && [ -x "$READELF" ] || die "llvm-readelf not found (set READELF or ANDROID_HOME)"
[ -n "$LLVM_NM" ] && [ -x "$LLVM_NM" ] || die "llvm-nm not found (set LLVM_NM or ANDROID_HOME)"
[ -n "${ZIPALIGN:-}" ] && [ -x "$ZIPALIGN" ] || die "zipalign not found (set ZIPALIGN or ANDROID_HOME)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

bad=""
libs=0
for apk in "$@"; do
  [ -f "$apk" ] || die "no such APK: $apk"
  case "$apk" in *.apk) ;; *) die "not an APK: $apk" ;; esac

  if ! "$ZIPALIGN" -c -P 16 4 "$apk" >/dev/null 2>&1; then
    bad="$bad\n  $apk: not zip-aligned for 16 KB pages (zipalign -c -P 16)"
  fi

  dest="$work/$(basename "$apk" .apk)"
  mkdir -p "$dest"
  unzip -qo "$apk" 'lib/*.so' -d "$dest" 2>/dev/null || true

  while IFS= read -r so; do
    libs=$((libs + 1))
    rel="${so#"$dest"/}"
    headers="$("$READELF" -lW "$so")" || die "readelf failed on $apk!$rel"
    # The last field of a LOAD line is its alignment, as hex.
    small="$(awk '$1 == "LOAD" { a = $NF; sub(/^0x/, "", a); if (length(a) == 0) next;
      v = 0; for (i = 1; i <= length(a); i++) v = v * 16 + index("0123456789abcdef", tolower(substr(a, i, 1))) - 1;
      if (v < 16384) print $NF }' <<<"$headers")"
    if [ -n "$small" ]; then
      bad="$bad\n  $apk!$rel: LOAD segment aligned to $(echo "$small" | head -1), not 0x4000"
    fi

    name="$(basename "$so")"
    case " $OWN_LIBS " in
      *" $name "*)
        exports="$("$LLVM_NM" -D --defined-only --format=just-symbols "$so")" || die "llvm-nm failed on $apk!$rel"
        # A named version node in the script would add an @@VERSION suffix.
        leaked="$(grep -vE '^(Java_[A-Za-z0-9_]+|JNI_OnLoad|JNI_OnUnload)(@@?[A-Za-z0-9_.]+)?$' <<<"$exports" || true)"
        if [ -n "$leaked" ]; then
          bad="$bad\n  $apk!$rel exports more than JNI: $(echo "$leaked" | head -5 | tr '\n' ' ')"
        fi
        ;;
    esac
  done < <(find "$dest" -name '*.so' -type f)
done

[ "$libs" -gt 0 ] || die "no native libraries found in: $*"

if [ -n "$bad" ]; then
  printf 'NATIVE AUDIT FAILED:%b\n' "$bad" >&2
  exit 1
fi
echo "native audit clean ($libs libraries in $# APKs)"
