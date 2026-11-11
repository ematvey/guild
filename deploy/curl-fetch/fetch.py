"""The web_fetch fallback transport: one HTTP GET replayed as a browser.

The server calls this service only when firecrawl cannot return a page —
JSON and plain-text endpoints, and pages whose text is too thin for
firecrawl's content heuristics. curl_cffi replays Chrome's TLS and HTTP/2
fingerprint, so a site that rejects a plain client still answers.

POST /fetch  {"url": "...", "max_bytes": 2000000, "timeout_ms": 20000}
  200 {"url": "<final>", "status": 200, "content_type": "text/html",
       "text": "..."}
  200 {"url": "<final>", "status": 200, "content_type": "application/pdf",
       "binary": true, "bytes": 4096}
  502 {"error": "..."}
GET /healthz
  200 {"ok": true}

The caller validates the URL against the public-fetch guard before it
sends a request here; this service does not repeat that check.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from curl_cffi import requests as curl_requests

PORT = 8080
DEFAULT_MAX_BYTES = 2_000_000
DEFAULT_TIMEOUT_MS = 20_000
IMPERSONATE = "chrome"

# Content types the caller receives as text. Everything else is reported as
# a binary blob, which web_fetch cannot render.
TEXT_TYPES = {
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/javascript",
    "application/x-ndjson",
    "application/xhtml+xml",
    "application/x-yaml",
}


def is_text(content_type: str) -> bool:
    base = content_type.split(";")[0].strip().lower()
    if base.startswith("text/"):
        return True
    return base in TEXT_TYPES or base.endswith("+json") or base.endswith("+xml")


def charset_of(content_type: str) -> str:
    for part in content_type.split(";")[1:]:
        key, _, value = part.strip().partition("=")
        if key.lower() == "charset" and value:
            return value.strip().strip('"')
    return "utf-8"


def fetch(url: str, max_bytes: int, timeout_ms: int) -> dict:
    resp = curl_requests.get(
        url,
        impersonate=IMPERSONATE,
        timeout=timeout_ms / 1000,
        allow_redirects=True,
    )
    content_type = resp.headers.get("content-type", "") or ""
    body = resp.content[:max_bytes]
    out = {
        "url": str(resp.url) or url,
        "status": resp.status_code,
        "content_type": content_type,
        "bytes": len(resp.content),
    }
    if is_text(content_type):
        out["text"] = body.decode(charset_of(content_type), errors="replace")
    else:
        out["binary"] = True
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib hook
        sys.stderr.write("curl-fetch %s\n" % (fmt % args))

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/healthz":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/fetch":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
            url = request.get("url")
            if not isinstance(url, str) or url == "":
                self.send_json(400, {"error": "fetch requires url"})
                return
            result = fetch(
                url,
                int(request.get("max_bytes") or DEFAULT_MAX_BYTES),
                int(request.get("timeout_ms") or DEFAULT_TIMEOUT_MS),
            )
        except Exception as error:  # every failure is a 502 the caller reports
            self.send_json(502, {"error": f"{type(error).__name__}: {error}"})
            return
        self.send_json(200, result)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    sys.stderr.write(f"curl-fetch listening on :{PORT}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
