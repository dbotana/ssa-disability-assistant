#!/bin/sh
# Run the assistant on this computer.  ./start-linux.sh
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  exec python3 tools/serve.py
elif command -v node >/dev/null 2>&1; then
  exec node tools/serve.mjs
fi

cat <<'MSG'

  Python 3 and Node are both missing, so the assistant cannot start.

  Install Python 3 with your package manager and run this again.

  (This version runs only on your own computer, so that what you say
  never leaves it. There is no web address to use instead.)

MSG
exit 1
