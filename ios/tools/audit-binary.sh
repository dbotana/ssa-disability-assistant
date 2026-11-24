#!/usr/bin/env bash
#
# audit-binary.sh: the iOS binary network audit (mirror plan, spike 3c), the
# iOS mirror of android/tools/audit-native.sh. On iOS the promise that nothing
# leaves the device is a property of the binary, and this is the check for it.
#
# Usage: audit-binary.sh <Mach-O | .a | .o | .framework | .xcframework | .xctest | .app> ...
#   ALLOWLIST  allowlist file (default: audit-binary.allowlist beside this script)
# Exits 0 clean, 1 on a finding, 2 when the audit cannot run.
#
# It walks every Mach-O file (thin, fat, or an ar archive of objects) in what
# it is given and fails, naming the object and the symbol, on:
#
#   A1. a linked networking framework: an `otool -L` entry (LC_LOAD_DYLIB, weak
#       or re-export) for CFNetwork, Network or WebKit. Checked in every file.
#   A2. an autolinked networking framework: an LC_LINKER_OPTION
#       `-framework CFNetwork|Network|WebKit` entry. Checked ONLY in linked
#       images (executables, dylibs, bundles), never in .o files or .a
#       archives. Owner decision, Run 7: Swift's `import Foundation` alone
#       writes `-framework CFNetwork` into every object file it compiles, so
#       CoreCrypto.o and SsaPdf.o would always fail. An LC_LINKER_OPTION only
#       acts at link time: a linked image that really uses CFNetwork carries
#       an LC_LOAD_DYLIB for it, which A1 catches, and B still checks every
#       symbol a .o or .a imports.
#   B.  an imported (undefined) symbol matching PATTERNS below: the
#       NSURLSession, NSURLConnection and WKWebView classes, nw_*, CFSocket*,
#       CFStream*, socket, connect, getaddrinfo, and dynamic lookup
#       (NSClassFromString, dlsym). Every input counts as our code for the
#       dynamic-lookup rule: nothing system-provided is passed in.
#
# It fails closed: a missing input, no Mach-O file at all, an unreadable file,
# a missing or malformed allowlist, or a failing nm, otool or find is exit 2,
# never a pass. Any other unexpected failure is exit 2 as well (the ERR trap).
# Debug symbols (anything under a .dSYM) are skipped: they are not shipped code.
#
# Labels: a finding names a file by its path relative to the parent directory
# of the argument it came from, for example
#   SsaCore.xcframework/ios-arm64-simulator/SsaCore.framework/SsaCore
#   CoreCrypto.o
#   SsaPdfTests.xctest/SsaPdfTests
# and an archive member as <path>(<member>), nm's own archive notation.
#
# Allowlist: one exception per line, `<object-label> <symbol> <reason...>`,
# separated by whitespace; `#` comments and blank lines are skipped, and a line
# with fewer than 3 fields is exit 2. For A1/A2 findings the symbol is
# `<Name>.framework`. A finding is suppressed only when its label and its
# symbol both equal an entry exactly: entries are never patterns or prefixes.
# Allowed hits print to stdout as `allowed: <object>: <symbol> (<reason>)`, so
# they are never silent. Entries that match nothing in this run print
# `note: allowlist entry not used here: <object> <symbol>` to stderr; that is
# informational, because different runs cover different inputs.
#
# Uses only xcrun, nm and otool, plus bash, find, od, awk and sort. It makes
# no network requests.

set -Eeuo pipefail

die() { echo "BINARY AUDIT ERROR: $*" >&2; exit 2; }
trap 'echo "BINARY AUDIT ERROR: unexpected failure at line $LINENO" >&2; exit 2' ERR

usage() {
  echo "Usage: audit-binary.sh <Mach-O | .a | .o | .framework | .xcframework | .xctest | .app> ..." >&2
  echo "  ALLOWLIST  allowlist file (default: audit-binary.allowlist beside this script)" >&2
  echo "Exits 0 clean, 1 on a finding, 2 when the audit cannot run." >&2
}

if [ $# -lt 1 ]; then
  usage
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)" || die "cannot resolve the script directory"
ALLOWLIST="${ALLOWLIST:-$SCRIPT_DIR/audit-binary.allowlist}"

NM="$(xcrun --find nm 2>/dev/null)" || die "xcrun --find nm failed"
OTOOL="$(xcrun --find otool 2>/dev/null)" || die "xcrun --find otool failed"
[ -x "$NM" ] || die "nm is not executable: $NM"
[ -x "$OTOOL" ] || die "otool is not executable: $OTOOL"
[ -f "$ALLOWLIST" ] || die "allowlist not found: $ALLOWLIST"

# Rule B. Mach-O C symbols carry a leading underscore. Matched against the
# symbol (the last field of an nm line) only, as one ERE.
PATTERNS=(
  '^_OBJC_(META)?CLASS_\$_(NSURLSession|NSURLConnection|WKWebView)'   # ObjC class refs (prefix: also *Configuration, *Task ...)
  'So12NSURLSessionC|So15NSURLConnectionC|So9WKWebViewC'              # Swift-mangled references to those classes
  '^_nw_'
  '^_CFSocket'
  '^_CFStream'
  '^_(socket|connect|getaddrinfo)$'
  '^_(NSClassFromString|dlsym)$'                                      # dynamic lookup
)
SYMBOL_RE=""
for p in "${PATTERNS[@]}"; do
  SYMBOL_RE="${SYMBOL_RE:+$SYMBOL_RE|}($p)"
done

# ---- collect the Mach-O files ----------------------------------------------

# Thin Mach-O (both byte orders, 32 and 64 bit), fat, or an ar archive (!<ar).
is_macho() {
  local magic
  magic="$(od -An -tx1 -N4 "$1" | tr -d ' \n')" || die "cannot read: $1"
  case "$magic" in
    cffaedfe|cefaedfe|feedfacf|feedface|cafebabe|213c6172) return 0 ;;
    *) return 1 ;;
  esac
}

FILES=()
LABELS=()

add_file() { # <file> <label>
  if is_macho "$1"; then
    FILES+=("$1")
    LABELS+=("$2")
  fi
}

for arg in "$@"; do
  [ -e "$arg" ] || die "no such input: $arg"
  # Absolute, with no trailing slash, so that labels do not depend on the
  # directory the script is run from.
  case "$arg" in
    /) ;;
    */) arg="${arg%/}" ;;
  esac
  arg_dir="$(cd "$(dirname "$arg")" && pwd)" || die "cannot resolve: $arg"
  arg="$arg_dir/$(basename "$arg")"
  if [ -d "$arg" ]; then
    found="$(find -H "$arg" -type f -not -path '*.dSYM/*' | LC_ALL=C sort)" || die "find failed in: $arg"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      add_file "$f" "${f#"$arg_dir"/}"
    done <<< "$found"
  else
    add_file "$arg" "$(basename "$arg")"
  fi
done

[ ${#FILES[@]} -gt 0 ] || die "no Mach-O files found in: $*"

# ---- the allowlist ----------------------------------------------------------

AL_OBJ=()
AL_SYM=()
AL_REASON=()
AL_USED=()
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  a_obj="" a_sym="" a_reason=""
  read -r a_obj a_sym a_reason <<< "$line" || true
  [ -n "$a_obj" ] || continue
  case "$a_obj" in \#*) continue ;; esac
  [ -n "$a_reason" ] || die "allowlist line $lineno has fewer than 3 fields: $ALLOWLIST"
  AL_OBJ+=("$a_obj")
  AL_SYM+=("$a_sym")
  AL_REASON+=("$a_reason")
  AL_USED+=(0)
done < "$ALLOWLIST"

FINDINGS=()
ALLOWED=()

# finding <object-label> <symbol> <message>
finding() {
  local i=0
  while [ $i -lt ${#AL_OBJ[@]} ]; do
    if [ "${AL_OBJ[$i]}" = "$1" ] && [ "${AL_SYM[$i]}" = "$2" ]; then
      AL_USED[$i]=1
      ALLOWED+=("allowed: $1: $2 (${AL_REASON[$i]})")
      return 0
    fi
    i=$((i + 1))
  done
  FINDINGS+=("$3")
}

# ---- the checks -------------------------------------------------------------

idx=0
while [ $idx -lt ${#FILES[@]} ]; do
  f="${FILES[$idx]}"
  label="${LABELS[$idx]}"
  idx=$((idx + 1))

  # A1. Dependency lines of `otool -L` are indented; the file and member
  # header lines are not, so the input's own path is never matched.
  out="$("$OTOOL" -arch all -L "$f" 2>/dev/null)" || die "otool -L failed for: $f"
  names="$(printf '%s\n' "$out" | awk '/^[ \t]/ && match($0, /\/(CFNetwork|Network|WebKit)\.framework\//) {
      print substr($0, RSTART + 1, RLENGTH - 12) }' | LC_ALL=C sort -u)"
  for n in $names; do
    finding "$label" "$n.framework" "$label: links $n.framework"
  done

  # A2, for linked images only (see the header). A file is a linked image
  # unless every Mach-O header otool finds in it is MH_OBJECT; .a members are
  # objects. A file with no readable header is an error.
  out="$("$OTOOL" -arch all -hv "$f" 2>/dev/null)" || die "otool -hv failed for: $f"
  types="$(printf '%s\n' "$out" | awk '$1 == "magic" && /filetype/ {
      for (i = 1; i <= NF; i++) if ($i == "filetype") c = i
      if (getline > 0) print $c }' | LC_ALL=C sort -u)"
  [ -n "$types" ] || die "otool -hv found no Mach-O header in: $f"
  linked=0
  for t in $types; do
    [ "$t" = "OBJECT" ] || linked=1
  done
  if [ "$linked" -eq 1 ]; then
    out="$("$OTOOL" -arch all -l "$f" 2>/dev/null)" || die "otool -l failed for: $f"
    # otool prints each option on its own line:
    #       cmd LC_LINKER_OPTION
    #    ...
    #   string #1 -framework
    #   string #2 CFNetwork
    names="$(printf '%s\n' "$out" | awk '
        $1 == "cmd" { lo = ($2 == "LC_LINKER_OPTION"); prev = ""; next }
        lo && $1 == "string" && $2 ~ /^#[0-9]+$/ {
          s = $0; sub(/^[ \t]*string #[0-9]+ /, "", s)
          if (prev == "-framework" && (s == "CFNetwork" || s == "Network" || s == "WebKit")) print s
          prev = s
        }' | LC_ALL=C sort -u)"
    for n in $names; do
      finding "$label" "$n.framework" "$label: autolinks $n.framework"
    done
  fi

  # B. `nm -u -A -arch all` output, as observed with Xcode 27.2's nm:
  #   object file:     <path>: <symbol>
  #   archive member:  <archive>:<member>: <symbol>
  #   fat file:        <path> (for architecture arm64): <symbol>
  #   fat archive:     (for architecture arm64):<archive>:<member>: <symbol>
  # Member names can hold a colon (liborg.jetbrains.kotlinx:atomicfu-cache.a.o)
  # and so can symbols (_objc_msgSend$dataTaskWithURL:completionHandler:), so
  # the object is the line minus ": <symbol>", read against the file's own path,
  # never split on colons. The symbol is the last whitespace-separated field.
  out="$("$NM" -u -A -arch all "$f" 2>/dev/null)" || die "nm -u -A -arch all failed for: $f"
  hits="$(printf '%s\n' "$out" | SYMBOL_RE="$SYMBOL_RE" awk 'NF && $NF ~ ENVIRON["SYMBOL_RE"]')"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sym="${line##* }"
    obj="${line%": $sym"}"
    obj="${obj%" (for architecture "*")"}"
    case "$obj" in "(for architecture "*"):"*) obj="${obj#"(for architecture "*"):"}" ;; esac
    case "$obj" in
      "$f") obj_label="$label" ;;
      "$f:"*) obj_label="$label(${obj#"$f:"})" ;;
      "$f("*")") obj_label="$label(${obj#"$f("}" ;;
      # Unknown format: still a finding, under a label no allowlist entry can
      # match, so the audit fails rather than passing on a misread line.
      *) obj_label="$label[unparsed nm object: $obj]" ;;
    esac
    finding "$obj_label" "$sym" "$obj_label: imports $sym"
  done <<< "$hits"
done

# ---- the result -------------------------------------------------------------

i=0
while [ $i -lt ${#AL_OBJ[@]} ]; do
  if [ "${AL_USED[$i]}" -eq 0 ]; then
    echo "note: allowlist entry not used here: ${AL_OBJ[$i]} ${AL_SYM[$i]}" >&2
  fi
  i=$((i + 1))
done

# A fat file reports each finding once per architecture: print each line once.
if [ ${#ALLOWED[@]} -gt 0 ]; then
  printf '%s\n' "${ALLOWED[@]}" | awk '!seen[$0]++'
fi

if [ ${#FINDINGS[@]} -gt 0 ]; then
  printf 'BINARY AUDIT FAILED:\n' >&2
  printf '  %s\n' "${FINDINGS[@]}" | awk '!seen[$0]++' >&2
  exit 1
fi

echo "binary audit clean (${#FILES[@]} Mach-O files in $# inputs)"
exit 0
