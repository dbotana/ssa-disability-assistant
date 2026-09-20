#!/usr/bin/env python3
"""Serve the app on localhost so it can be used without internet hosting.

Opening index.html by double-clicking does not work: the app is built from ES
modules, which a browser refuses to load over file://, and it fetches the blank
PDF templates, which file:// also blocks. Both need a real HTTP origin, so this
serves one.

Bound to 127.0.0.1 on purpose. The default for http.server is every interface,
which would put a form holding someone's SSN on the local network.
"""

import functools
import http.server
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIRST_PORT = 8000
TRIES = 20


class Server(http.server.ThreadingHTTPServer):
    # ThreadingHTTPServer, not a bare TCPServer, for two reasons. It sets
    # allow_reuse_address, without which stopping and restarting inside the
    # TIME_WAIT window is refused and the retry loop below silently moves the
    # app to a different port -- so the URL the user was told changes. And it
    # serves in parallel, which a browser opening six connections for the
    # modules and a 1.3 MB template needs.
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Without this a stale copy survives a `git pull`, and the user is
        # debugging a version they no longer have.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 404s matter (a missing template is worth seeing); 200s are noise.
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main():
    handler = functools.partial(Handler, directory=str(ROOT))

    for port in range(FIRST_PORT, FIRST_PORT + TRIES):
        try:
            with Server(("127.0.0.1", port), handler) as httpd:
                url = f"http://localhost:{port}/"
                print()
                print("  The assistant is running at:")
                print(f"      {url}")
                print()
                print("  Leave this window open while you use it.")
                print("  Press Control-C here when you are finished.")
                print()
                threading.Timer(0.5, webbrowser.open, args=[url]).start()
                try:
                    httpd.serve_forever()
                except KeyboardInterrupt:
                    print("\n  Stopped. You can close this window.")
                return 0
        except OSError:
            continue  # port taken, try the next one

    print(f"Could not find a free port between {FIRST_PORT} and "
          f"{FIRST_PORT + TRIES - 1}.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
