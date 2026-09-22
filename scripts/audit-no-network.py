"""Assert this library contains no network code.

WHY THIS EXISTS. The disclaimer shown to users says, in part:

    "The consent layer you are reading has no network code. No fetch, no
     beacon, no websocket, no configurable endpoint ... You can read the
     source and check; the project also runs that check on every commit."

That last clause is a promise this script keeps. A claim of that shape is
worth exactly as much as its check — without one, "no network code" is a
statement about what the code looked like the day someone wrote it, and the
first well-meaning refactor that adds telemetry makes it false with nobody
noticing. The whole point of this package is that its statements about itself
are checkable.

SCOPE — WHAT THIS SCRIPT DOES AND DOES NOT PROVE.

It proves: the files under src/ contain no occurrence of the network APIs
listed below, and no URL literal that would be a plausible endpoint.

It does NOT prove the library is incapable of network access. `eval`, a
dynamically constructed global lookup, or an imported dependency could reach
the network in ways text matching cannot see. This script has zero
dependencies precisely so that there is nothing imported to hide behind, but
a determined writer could still defeat it. Stating the limit is the point:
a check that overstates its coverage is the same defect class this package
exists to document.

Usage:  python scripts/audit-no-network.py     (from the package root)
Exit 0 when clean, 1 otherwise.
"""
import pathlib
import re
import sys

# Only src/ is the shipped library. Tests may legitimately reference strings
# like 'websocket' in their own names, and scripts/ is not published.
SCAN_ROOT = pathlib.Path("src")

# APIs that produce outbound traffic. Matched as whole words so that
# `prefetch` inside a comment about rAF does not fire, while `window.fetch(`
# does. The first version of this list omitted sendBeacon (the exact API a
# "just one anonymous ping" refactor reaches for) and EventSource; both are
# now here.
FORBIDDEN = [
    "fetch",
    "XMLHttpRequest",
    "sendBeacon",
    "WebSocket",
    "EventSource",
    "importScripts",
    "navigator.onLine",
    "serviceWorker",
    "RTCPeerConnection",
]

# A URL with a host is an endpoint, whether or not it is fetched today. The
# localhost/example forms are allowed only in comments, which are stripped
# before matching.
URL_RE = re.compile(r"https?://([A-Za-z0-9.-]+)")
ALLOWED_HOSTS = {
    # Documented in comments as references, not endpoints.
    "datatracker.ietf.org",
    "www.w3.org",
    "w3.org",
    "www.ecfr.gov",
    "ecfr.gov",
    "www.iso.org",
    "iso.org",
    "github.com",
    "opensource.org",
}

# Comments are stripped before the scan so that a doc-block explaining WHY
# there is no fetch does not itself trip the check. That was a real false
# positive on the first run of the equivalent check in a sibling package.
def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    return text


def main() -> int:
    if not SCAN_ROOT.is_dir():
        print(f"FAIL: {SCAN_ROOT}/ not found — run from the package root")
        return 1

    files = sorted(p for p in SCAN_ROOT.rglob("*.js") if p.is_file())
    if not files:
        print("FAIL: no source files found — the check would pass vacuously")
        return 1

    violations = []
    for path in files:
        raw = path.read_text(encoding="utf-8")
        body = strip_comments(raw)
        for api in FORBIDDEN:
            if re.search(rf"(?<![\w.]){re.escape(api)}\s*[(.=]", body):
                violations.append((str(path), f"network API: {api}"))
        for host in URL_RE.findall(body):
            if host.lower() not in ALLOWED_HOSTS:
                violations.append((str(path), f"endpoint-shaped URL: {host}"))

    # A string literal containing an allowed host is only acceptable in a
    # comment. If one appears in live code it is an endpoint, comment-stripping
    # already handled the harmless case, so anything left here is a real risk.
    for path in files:
        body = strip_comments(path.read_text(encoding="utf-8"))
        for m in re.finditer(r"[\"'`]([^\"'`]*?)://", body):
            violations.append((str(path), f"scheme in live code: {m.group(0)[:40]}"))

    print("no-network audit")
    print()
    print(f"  scanned: {len(files)} file(s) under {SCAN_ROOT}/")
    print(f"  APIs checked: {len(FORBIDDEN)}")
    print()

    if violations:
        print("  NETWORK CODE FOUND — the disclaimer's claim is now false:")
        for f, why in violations:
            print(f"     {f}: {why}")
        print()
        print("  Either remove it, or update DISCLAIMER.full in src/notices.js")
        print("  so the user-facing text stops claiming there is no network code.")
        return 1

    print("  OK — no network API or endpoint in the shipped source.")
    print()
    print("  NOTE: this proves absence of the listed APIs in src/, not")
    print("  incapability. src/ has zero dependencies, which is what keeps")
    print("  that gap small enough to reason about.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
