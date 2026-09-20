#!/bin/sh
# Double-click this file to run the assistant on this Mac.
#
# Finder runs a .command from the user's home folder, not from the folder the
# file lives in, so the first job is to get back to the project.
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  exec python3 tools/serve.py
elif command -v node >/dev/null 2>&1; then
  exec node tools/serve.mjs
fi

cat <<'MSG'

  This Mac does not have Python or Node installed, so the assistant
  cannot run locally.

  You can use it in your browser instead, with nothing to install:

      https://dbotana.github.io/ssa-disability-assistant/

  Or install Python from https://www.python.org/downloads/ and
  double-click this file again.

MSG
# Without this the window closes before the message can be read.
printf "  Press Return to close this window. "
read -r _
