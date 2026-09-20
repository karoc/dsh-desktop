#!/usr/bin/env python3
"""Header-budget probe for a live `dsh web` server (read-only).

Measures the real request-header budget (Node's `http.maxHeaderSize`, default
16384 B, request line included) and fingerprints the `431 Request Header Fields
Too Large` response, so a "client plugins all fail to import" incident can be
traced back to an oversized Cookie header.

Background: docs/2026-09-20-webview2-cookie-431-fix-plan.md
            docs/2026-09-20-webview2-cookie-431-fix-audit.md
Symptom it explains: the client-plugin batch URL is the only >1 KB URL on the
dsh page (~2.8 KB with ~68 plugins), so it is the first request to cross the
budget; its 431 makes every client plugin fail to import.

Usage (the dsh web URL and token are printed by the manager / stored in
`<runtime>/manager.log` as `dsh web: http://127.0.0.1:<port>/?token=...`):

    python3 scripts/hdrprobe.py --port 63736 --token <token>
    python3 scripts/hdrprobe.py --port 63736 --cookie "dsh-auth-...=v1...."

Stdlib only. Sends raw HTTP/1.1 over a socket; never writes anything.
"""
from __future__ import annotations

import argparse
import json
import re
import socket
import sys
import urllib.request

HOST = "127.0.0.1"


def http_get(port: int, path: str, cookie: str | None) -> tuple[int, str]:
    """Plain GET (follows the 303 + Set-Cookie of the token URL)."""
    req = urllib.request.Request(f"http://{HOST}:{port}{path}")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read().decode("utf8", "replace")
    except urllib.error.HTTPError as err:  # 4xx/5xx
        return err.code, err.read().decode("utf8", "replace")


def resolve_cookie(port: int, token: str | None, cookie: str | None) -> str:
    """Return the auth cookie, exchanging `?token=` for one when needed."""
    if cookie:
        return cookie
    if not token:
        return ""
    # The token URL answers 303 + Set-Cookie; capture it without following.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):  # noqa: D102
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(f"http://{HOST}:{port}/?token={token}", timeout=20)
    except urllib.error.HTTPError as err:
        raw = err.headers.get("Set-Cookie", "")
        if raw:
            return raw.split(";", 1)[0]
    raise SystemExit("could not obtain a cookie: pass --cookie or a valid --token")


def send(path: str, port: int, cookie: str | None = None, pad_bytes: int = 0):
    """Send one raw request; return (status, header_block_bytes, raw_head)."""
    lines = [
        f"GET {path} HTTP/1.1",
        f"Host: {HOST}:{port}",
        "User-Agent: hdrprobe",
        "Accept: */*",
        "Accept-Encoding: gzip, deflate, br, zstd",
        "Connection: close",
    ]
    if cookie:
        value = cookie
        if pad_bytes:
            value += "; pad" + "A" * max(1, pad_bytes - 4) + "=1"
        lines.append("Cookie: " + value)
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode()

    sock = socket.create_connection((HOST, port), timeout=20)
    sock.sendall(raw)
    sock.settimeout(20)
    data = b""
    try:
        while len(data) < 4096:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    except OSError:
        pass
    sock.close()
    match = re.search(rb"HTTP/1\.1 (\d\d\d)", data)
    return (int(match.group(1)) if match else 0), len(raw), data


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, required=True, help="dsh web port (from manager.log)")
    ap.add_argument("--token", help="token from the dsh web URL (exchanged for a cookie)")
    ap.add_argument("--cookie", help="use this cookie directly instead of --token")
    args = ap.parse_args()

    cookie = resolve_cookie(args.port, args.token, args.cookie)
    print(f"# cookie header bytes = {len(cookie)}")

    status, page = http_get(args.port, "/", cookie)
    print(f"# GET / -> {status} (page bytes {len(page)})")
    urls = [u for u in re.findall(r'["\'](/plugins/\?\?[^"\']*)["\']', page)]
    urls = [u.replace("&amp;", "&") for u in urls]
    long_urls = sorted({u for u in urls if len(u) > 1000}, key=len)
    if not long_urls:
        print("# no >1KB /plugins/?? URL found — is this really the dsh web app?")
        return 1
    batch = long_urls[-1]
    print(f"# longest /plugins/?? URL = {len(batch)} chars")

    print("\n## A. no cookie, request line length sweep (budget fingerprint)")
    for n in (69, 8000, 14000, 15700, 16200, 16300, 16340, 16384, 16500, 20000):
        path = "/" + "a" * max(0, n - 2)
        code, hdr, _ = send(path, args.port)
        print(f"  url={len(path):6d}  header_block={hdr:6d}  -> {code}")

    print("\n## B. real cookie + real batch URL, padding sweep")
    for pad in (0, 4000, 8000, 12000, 13000, 13400, 14000, 15000, 20000):
        code, hdr, _ = send(batch, args.port, cookie, pad)
        print(f"  cookie_hdr={len(cookie) + (pad + 8 if pad else 0):6d}  header_block={hdr:6d}  -> {code}")

    print("\n## C. same padding, short URL (isolates 'long URL dies first')")
    short = "/plugins/??@deepseek-ai/dsh-client-modules/client.js"
    for pad in (12000, 13400, 14000, 15000, 20000):
        code, hdr, _ = send(short, args.port, cookie, pad)
        print(f"  cookie_hdr={len(cookie) + (pad + 8 if pad else 0):6d}  header_block={hdr:6d}  -> {code}")

    print("\n## D. 431 fingerprint (raw response head)")
    code, hdr, data = send(batch, args.port, cookie, 20000)
    print(f"  status={code} header_block={hdr}")
    print("  raw head:", json.dumps(data[:300].decode("latin1")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
