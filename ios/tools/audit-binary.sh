#!/usr/bin/env bash
# Binary network audit for iOS. Walks every Mach-O file in the given inputs and
# fails on networking frameworks, networking symbols/classes, and dynamic lookup
# (NSClassFromString/dlsym). Fails closed: any finding, or any inability to run
# the audit, is an error.
#
# Debug symbols (.dSYM) are not shipped code and are skipped.
#
# Usage: audit-binary.sh <Mach-O | .a | .o | .framework | .xcframework | .xctest | .app> ...
#   ALLOWLIST  allowlist file (default: audit-binary.allowlist beside this script)
# Exits 0 clean, 1 on a finding, 2 when the audit cannot run.

set -euo pipefail

die() { echo "BINARY AUDIT ERROR: $*" >&2; exit 2; }

if [ $# -lt 1 ]; then
  echo "Usage: audit-binary.sh <Mach-O | .a | .o | .framework | .xcframework | .xctest | .app> ..." >&2
  echo "  ALLOWLIST  allowlist file (default: audit-binary.allowlist beside this script)" >&2
  echo "Exits 0 clean, 1 on a finding, 2 when the audit cannot run." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ALLOWLIST="${ALLOWLIST:-$SCRIPT_DIR/audit-binary.allowlist}"

NM="$(xcrun --find nm 2>/dev/null)" || die "cannot find nm (xcrun --find nm failed)"
OTOOL="$(xcrun --find otool 2>/dev/null)" || die "cannot find otool (xcrun --find otool failed)"
[ -x "$NM" ] || die "nm not executable: $NM"
[ -x "$OTOOL" ] || die "otool not executable: $OTOOL"

if [ ! -f "$ALLOWLIST" ]; then
  die "allowlist file not found: $ALLOWLIST"
fi

# Collect Mach-O files. For directories, find regular files, skip .dSYM.
# Keep files whose first 4 bytes are a thin Mach-O, fat binary, or ar archive.
is_macho() {
  local magic
  magic="$(od -An -tx1 -N4 "$1" 2>/dev/null | tr -d ' \n')" || return 1
  case "$magic" in
    cffaedfe|cefaedfe|feedfacf|feedface|cafebabe|213c6172) return 0 ;;
    *) return 1 ;;
  esac
}

# label_for <file> <arg>
# Label is path relative to the parent directory of the argument it came from.
# For archive members, the caller appends (<member>) to produce <path>(<member>).
label_for() {
  local f="$1" arg="$2" base parent
  parent="$(cd "$(dirname "$arg")" && pwd)"
  # Use python-free relative path: strip parent prefix.
  if [ "$f" = "$arg" ] && [ ! -d "$arg" ]; then
    basename "$f"
    return
  fi
  case "$f" in
    "$parent"/*) printf '%s\n' "${f#"$parent"/}" ;;
    *) basename "$f" ;;
  esac
}

declare -a FILES=()
declare -a FILE_ARGS=()
declare -a FILE_LABELS=()
declare -a INPUT_ARGS=("$@")

for arg in "$@"; do
  if [ ! -e "$arg" ]; then
    die "no such input: $arg"
  fi
  arg="${arg%/}"
  arg="$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"
  if [ -d "$arg" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if is_macho "$f"; then
        FILES+=("$f")
        FILE_ARGS+=("$arg")
        FILE_LABELS+=("$(label_for "$f" "$arg")")
      fi
    done < <(find "$arg" -type f -not -path '*.dSYM/*' | LC_ALL=C sort)
  else
    if is_macho "$arg"; then
      FILES+=("$arg")
      FILE_ARGS+=("$arg")
      FILE_LABELS+=("$(label_for "$arg" "$arg")")
    fi
  fi
done

if [ ${#FILES[@]} -eq 0 ]; then
  die "no Mach-O files found in: $*"
fi

# Read allowlist: skip # and blank lines. Each other line is
# <object-label> <symbol> <reason...> (>=3 fields). Exact string match only.
declare -a AL_OBJ=()
declare -a AL_SYM=()
declare -a AL_REASON=()
declare -a AL_USED=()

lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  # trim leading/trailing whitespace for blank/comment detection
  trimmed="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$trimmed" ] && continue
  case "$trimmed" in
    \#*) continue ;;
  esac
  # Parse fields: object, symbol, reason...
  al_obj="$(printf '%s' "$trimmed" | awk '{print $1}')"
  al_sym="$(printf '%s' "$trimmed" | awk '{print $2}')"
  al_reason="$(printf '%s' "$trimmed" | awk '{for(i=3;i<=NF;i++){printf "%s%s",$i,(i<NF?OFS:"")}}')"
  if [ -z "$al_obj" ] || [ -z "$al_sym" ] || [ -z "$al_reason" ]; then
    die "allowlist line $lineno has fewer than 3 fields: $ALLOWLIST"
  fi
  AL_OBJ+=("$al_obj")
  AL_SYM+=("$al_sym")
  AL_REASON+=("$al_reason")
  AL_USED+=(0)
done < "$ALLOWLIST"

declare -a FINDINGS=()
declare -a ALLOWED=()

allow_or_record() {
  local object="$1" symbol="$2" finding="$3"
  local i
  for i in "${!AL_OBJ[@]}"; do
    if [ "${AL_OBJ[$i]}" = "$object" ] && [ "${AL_SYM[$i]}" = "$symbol" ]; then
      AL_USED[$i]=1
      ALLOWED+=("allowed: ${object}: ${symbol} (${AL_REASON[$i]})")
      return 0
    fi
  done
  FINDINGS+=("$finding")
  return 0
}

# Check A: linked networking frameworks.
# 1) otool -L: any line matching /(CFNetwork|Network|WebKit).framework/ is a finding.
# 2) otool -l: LC_LINKER_OPTION -framework followed by CFNetwork/Network/WebKit.
# For fat files, run otool with -arch all. If otool exits non-zero, die.
for idx in "${!FILES[@]}"; do
  f="${FILES[$idx]}"
  label="${FILE_LABELS[$idx]}"

  otoL_out="$("$OTOOL" -arch all -L "$f" 2>&1)" || die "otool -L failed for $f: $otoL_out"
  while IFS= read -r line; do
    fw="$(printf '%s\n' "$line" | grep -oE '/(CFNetwork|Network|WebKit)\.framework/' | head -1 | sed -E 's|^/(.*)\.framework/$|\1|' || true)"
    if [ -n "$fw" ]; then
      allow_or_record "$label" "$fw.framework" "$label: links $fw.framework"
    fi
  done <<< "$otoL_out"

  otol_out="$("$OTOOL" -arch all -l "$f" 2>&1)" || die "otool -l failed for $f: $otol_out"
  # Parse LC_LINKER_OPTION blocks: "string #N -framework" followed by "string #M CFNetwork"
  in_linker=0
  saw_framework_flag=0
  while IFS= read -r line; do
    if printf '%s\n' "$line" | grep -q 'cmd LC_LINKER_OPTION'; then
      in_linker=1
      saw_framework_flag=0
      continue
    fi
    if [ "$in_linker" -eq 1 ]; then
      if printf '%s\n' "$line" | grep -qE '^[[:space:]]*cmd '; then
        in_linker=0
        saw_framework_flag=0
      fi
      # detect "string #N -framework"
      if printf '%s\n' "$line" | grep -qE 'string #[0-9]+ -framework[[:space:]]*$'; then
        saw_framework_flag=1
        continue
      fi
      if [ "$saw_framework_flag" -eq 1 ]; then
        fw2="$(printf '%s\n' "$line" | sed -nE 's/^[[:space:]]*string #[0-9]+ (CFNetwork|Network|WebKit)[[:space:]]*$/\1/p' | head -1)"
        if [ -n "$fw2" ]; then
          allow_or_record "$label" "$fw2.framework" "$label: autolinks $fw2.framework"
        fi
        saw_framework_flag=0
      fi
    fi
  done <<< "$otol_out"
done

# Check B: imported symbols.
# nm -u -A -arch all output format (observed):
#   /path/file.o: _symbol                  (object file)
#   /path/archive:SsaCore.framework.o: _sym (archive member)
#   /path/bundle/bin: _sym                  (Mach-O binary)
# The symbol is the last whitespace-separated field.
# The object is everything before the final ": ", with any
# " (for architecture ...)" removed and the path made relative as labels.
# For archive members the label is <path>(<member>).
#
# nm parsing comment: nm -u -A prints "<path>: <symbol>" or for archives
# "<archive>(<member>): <symbol>" depending on nm version; on macOS it prints
# "<archive>:<member>: <symbol>". We handle both by splitting on the last ": "
# occurrence and normalizing archive member form to <relpath>(<member>).

for idx in "${!FILES[@]}"; do
  f="${FILES[$idx]}"
  arg="${FILE_ARGS[$idx]}"
  label="${FILE_LABELS[$idx]}"

  nm_out="$("$NM" -u -A -arch all "$f" 2>&1)" || die "nm -u -A -arch all failed for $f: $nm_out"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # symbol is last whitespace-separated field
    symbol="$(printf '%s\n' "$line" | awk '{print $NF}')"
    [ -z "$symbol" ] && continue

    # object is everything before final ": "
    # Use sed to remove last ": <symbol>"
    obj_raw="$(printf '%s\n' "$line" | sed 's/: [^:]*$//')"
    # remove " (for architecture ...)"
    obj_raw="$(printf '%s\n' "$obj_raw" | sed -E 's/ \(for architecture [^)]+\)//g')"

    # Normalize to label form. obj_raw may be:
    #  - /abs/path/file.o
    #  - /abs/path/archive.a(member.o)  (nm style)
    #  - /abs/path/archive:member.o     (macOS nm -A style for archives)
    obj_label=""
    # Detect macOS archive style: "<archive-path>:<member>" where archive-path is the file
    case "$obj_raw" in
      "$f":*)
        member="${obj_raw#"$f":}"
        obj_label="${label}(${member})"
        ;;
      "$f"|"${f}"\(*)
        # already has member in parens or is the file itself
        if printf '%s' "$obj_raw" | grep -q '('; then
          member="$(printf '%s\n' "$obj_raw" | sed -nE 's/.*\(([^)]+)\)$/\1/p')"
          obj_label="${label}(${member})"
        else
          obj_label="$label"
        fi
        ;;
      *)
        # Fallback: make relative to parent of arg
        parent="$(cd "$(dirname "$arg")" && pwd)"
        case "$obj_raw" in
          "$parent"/*) obj_label="${obj_raw#"$parent"/}" ;;
          *) obj_label="$(basename "$obj_raw")" ;;
        esac
        ;;
    esac

    # Check patterns (ERE, Mach-O C symbols carry leading _)
    is_finding=0
    if printf '%s\n' "$symbol" | grep -qE '^_OBJC_(META)?CLASS_\$_(NSURLSession|NSURLConnection|WKWebView)'; then
      is_finding=1
    elif printf '%s\n' "$symbol" | grep -qE 'So12NSURLSessionC|So15NSURLConnectionC|So9WKWebViewC'; then
      is_finding=1
    elif printf '%s\n' "$symbol" | grep -qE '^_nw_'; then
      is_finding=1
    elif printf '%s\n' "$symbol" | grep -qE '^_CFSocket'; then
      is_finding=1
    elif printf '%s\n' "$symbol" | grep -qE '^_CFStream'; then
      is_finding=1
    elif printf '%s\n' "$symbol" | grep -qE '^_(socket|connect|getaddrinfo)$'; then
      is_finding=1
    elif printf '%s\n' "$symbol" | grep -qE '^_(NSClassFromString|dlsym)$'; then
      is_finding=1
    fi

    if [ "$is_finding" -eq 1 ]; then
      allow_or_record "$obj_label" "$symbol" "$obj_label: imports $symbol"
    fi
  done <<< "$nm_out"
done

# Unused allowlist entries: informational, stderr, do not fail.
for i in "${!AL_OBJ[@]}"; do
  if [ "${AL_USED[$i]}" -eq 0 ]; then
    echo "note: allowlist entry not used here: ${AL_OBJ[$i]} ${AL_SYM[$i]}" >&2
  fi
done

# Print allowed hits to stdout (never silent).
for a in ${ALLOWED[@]+"${ALLOWED[@]}"}; do
  echo "$a"
done

if [ ${#FINDINGS[@]} -gt 0 ]; then
  printf 'BINARY AUDIT FAILED:\n' >&2
  for fnd in "${FINDINGS[@]}"; do
    printf '  %s\n' "$fnd" >&2
  done
  exit 1
fi

echo "binary audit clean (${#FILES[@]} Mach-O files in ${#INPUT_ARGS[@]} inputs)"
exit 0
