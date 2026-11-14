#!/usr/bin/env python3
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ID_RE = re.compile(r"(?:x|twitter)\.com/(?:i/web/)?[^/]+/status/(\d+)")
DIGITS_RE = re.compile(r"^\d{6,}$")


def extract_status_id(value: str) -> str:
    value = value.strip()
    if DIGITS_RE.match(value):
        return value
    m = ID_RE.search(value)
    if m:
        return m.group(1)
    raise ValueError("status id を抽出できませんでした")


def fetch_status(status_id: str) -> dict:
    url = f"https://api.fxtwitter.com/status/{urllib.parse.quote(status_id)}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "luna-x-status-fetch/1.0"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read().decode("utf-8", "replace")
    return json.loads(data)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: fetch_x_status.py <x_url_or_status_id>", file=sys.stderr)
        return 2

    raw = sys.argv[1]
    try:
        status_id = extract_status_id(raw)
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1

    try:
        payload = fetch_status(status_id)
    except urllib.error.HTTPError as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "http_error",
                    "status": e.code,
                    "status_id": status_id,
                },
                ensure_ascii=False,
            )
        )
        return 1
    except Exception as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "fetch_failed",
                    "message": str(e),
                    "status_id": status_id,
                },
                ensure_ascii=False,
            )
        )
        return 1

    print(
        json.dumps(
            {
                "ok": payload.get("code") == 200 and bool(payload.get("tweet")),
                "status_id": status_id,
                "response": payload,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
