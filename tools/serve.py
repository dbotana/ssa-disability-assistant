#!/usr/bin/env python3
"""Serve the app on localhost so it can be used without internet hosting.

Opening index.html by double-clicking does not work: the app is built from ES
modules, which a browser refuses to load over file://, and it fetches the blank
PDF templates, which file:// also blocks. Both need a real HTTP origin, so this
serves one.

Bound to 127.0.0.1 on purpose. The default for http.server is every interface,
which would put a form holding someone's SSN on the local network.

Every response carries the same Content-Security-Policy as index.html. The
<meta> tag there covers the page; this header is what covers the speech
worker, which takes its policy from its own response. tools/serve.mjs sends
the identical set, and tests/no-network.js checks all three agree.

Before serving, the speech model, its runtime and the PDF library are checked
against their pinned SHA-256 hashes. Those files run with access to every
answer; a changed one means the server refuses to start rather than hand it
a microphone. This catches corruption and a swapped file. It cannot catch an
attacker who can also edit this script -- nothing on the same disk can.

The page opens in its own browser profile when Chrome, Edge, Chromium or
Brave is installed: no extensions, no account sync, no background requests,
no crash dumps. Pass --default-browser to use the ordinary browser instead.
"""

import functools
import hashlib
import http.server
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Not 8000. The browser keys saved answers to the origin, and the origin is
# http://localhost:<port>, so anything else ever served on the same port --
# another project's dev server, a quick `python -m http.server` -- can read
# them. 8000 is the default of half the dev tools there are. This one is
# registered to nothing, below every OS's ephemeral range, and identical in
# tools/serve.mjs so both launchers reach the same saved session.
FIRST_PORT = 27183
TRIES = 20

HEADERS = {
    # Nothing is fetched from anywhere but this server.
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    # Cross-origin isolation. It lets the speech model's WebAssembly run on
    # several threads (SharedArrayBuffer), which makes transcription a few
    # times faster, and it also shuts out cross-origin windows and embeds.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


# -- integrity -------------------------------------------------------------------

def integrity_lists(root=ROOT):
    """Every hash list: the vendored libraries and each committed model."""
    lists = [root / "vendor" / "SHA256SUMS", root / "vendor" / "transformers" / "VERSIONS.txt"]
    lists += sorted((root / "models").glob("*/SHA256SUMS"))
    return lists


def verify_files(root=ROOT):
    """Problems with the pinned files, as short strings; empty when all match."""
    problems = []
    lists = integrity_lists(root)
    if not any(p.parent.parent.name == "models" for p in lists):
        problems.append("no speech model found under models/")
    for listing in lists:
        name = listing.relative_to(root).as_posix()
        if not listing.exists():
            problems.append(f"missing {name}")
            continue
        for line in listing.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([0-9a-f]{64})\s+(\S+)$", line)
            if not m:
                continue
            want, rel = m.groups()
            path = listing.parent / rel
            shown = path.relative_to(root).as_posix()
            try:
                digest = hashlib.sha256()
                with open(path, "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        digest.update(chunk)
            except FileNotFoundError:
                problems.append(f"missing {shown}")
                continue
            if digest.hexdigest() != want:
                problems.append(f"changed {shown}")
    return problems


# -- a browser of its own --------------------------------------------------------

# Identical in tools/serve.mjs; tests/launcher.js checks they agree.
BROWSER_FLAGS = [
    "--no-first-run",
    "--no-default-browser-check",
    # Nothing installed in the user's everyday browser can read the page.
    "--disable-extensions",
    # This profile is never signed in, and nothing in it syncs anywhere.
    "--disable-sync",
    # No update checks, field trials or other requests made on the side.
    "--disable-background-networking",
    # Crash reports can carry page memory, which here holds the answers.
    "--disable-breakpad",
    # Page translation and autofill both talk to Google about the page.
    "--disable-features=Translate,AutofillServerCommunication,OptimizationHints,MediaRouter",
]


def profile_dir():
    """Where the dedicated profile lives: per-user app data, never a synced
    folder like Documents or Desktop, where the project itself may sit."""
    system = platform.system()
    if system == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    elif system == "Windows":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "SSA Disability Assistant" / "browser-profile"


def find_browser():
    """A Chromium-family browser, which takes the flags above; else None.
    SSA_BROWSER names one explicitly, for an install in an unusual place."""
    override = os.environ.get("SSA_BROWSER")
    if override:
        return override if Path(override).exists() else None
    system = platform.system()
    if system == "Darwin":
        for app in ("Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser"):
            for apps in (Path("/Applications"), Path.home() / "Applications"):
                exe = apps / f"{app}.app" / "Contents" / "MacOS" / app
                if exe.exists():
                    return str(exe)
    elif system == "Windows":
        rels = (r"Google\Chrome\Application\chrome.exe",
                r"Microsoft\Edge\Application\msedge.exe",
                r"Chromium\Application\chrome.exe",
                r"BraveSoftware\Brave-Browser\Application\brave.exe")
        for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            for rel in rels if base else ():
                exe = Path(base) / rel
                if exe.exists():
                    return str(exe)
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                     "microsoft-edge", "microsoft-edge-stable", "brave-browser"):
            exe = shutil.which(name)
            if exe:
                return exe
    return None


def open_browser(url, use_default=False):
    """Open the page; returns the name of what opened it, or None."""
    exe = None if use_default else find_browser()
    if exe:
        profile = profile_dir()
        try:
            profile.mkdir(parents=True, exist_ok=True)
            os.chmod(profile, 0o700)
            extra = {"start_new_session": True} if os.name == "posix" else {}
            subprocess.Popen([exe, f"--user-data-dir={profile}", *BROWSER_FLAGS, f"--app={url}"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, **extra)
            return Path(exe).stem
        except OSError:
            pass
    webbrowser.open(url)
    return None


class Server(http.server.ThreadingHTTPServer):
    # ThreadingHTTPServer, not a bare TCPServer, for two reasons. It sets
    # allow_reuse_address, without which stopping and restarting inside the
    # TIME_WAIT window is refused and the retry loop below silently moves the
    # app to a different port -- so the URL the user was told changes. And it
    # serves in parallel, which a browser opening six connections for the
    # modules and a 1.3 MB template needs.
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    # Not left to the mimetypes module: it has no .wasm before Python 3.12,
    # and on Windows it reads .js from the registry, which is sometimes
    # text/plain. A browser refuses a module or a streamed WebAssembly file
    # served as the wrong type.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".onnx": "application/octet-stream",
        ".json": "application/json",
    }

    def end_headers(self):
        # Without this a stale copy survives a `git pull`, and the user is
        # debugging a version they no longer have.
        self.send_header("Cache-Control", "no-store")
        for name, value in HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    def log_message(self, fmt, *args):
        # 404s matter (a missing template is worth seeing); 200s are noise.
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    use_default = "--default-browser" in argv

    print()
    print("  Checking the speech model and libraries...")
    problems = verify_files()
    if problems:
        print()
        print("  STOPPED. These files are not the ones this project was published with:")
        for problem in problems:
            print(f"      {problem}")
        print()
        print("  They run with access to everything you say. Download a fresh copy")
        print("  of the project rather than using this one.")
        print()
        return 1

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

                def launch():
                    opened = open_browser(url, use_default)
                    if opened:
                        print(f"  Opened in a separate {opened} window with its own profile:")
                        print("  no extensions, no account sync.")
                    elif not use_default:
                        print("  Chrome or Edge was not found, so this opened in your usual")
                        print("  browser. Its extensions can read what you type there.")
                    print()

                threading.Timer(0.5, launch).start()
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
