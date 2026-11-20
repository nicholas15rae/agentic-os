"""Tiny stdlib JSON-over-HTTP transport: GET, or a JSON body send.

Tests point the base URLs at local stub servers; nothing here knows any real host.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Optional


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status} {message}".strip())
        self.status = status


def _open(req: urllib.request.Request, timeout: float) -> Any:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            body = ""
        msg = body
        try:
            j = json.loads(body)
            if isinstance(j, dict):
                msg = str(j.get("error") or j.get("message") or "")
        except ValueError:
            pass
        raise HttpError(e.code, msg[:160]) from None
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        return None


def get_json(url: str, timeout: float = 10.0, headers: Optional[dict] = None) -> Any:
    req = urllib.request.Request(url, headers={"Accept": "application/json", **(headers or {})}, method="GET")
    return _open(req, timeout)


def send_json(url: str, body: Any, timeout: float = 30.0, headers: Optional[dict] = None) -> Any:
    """Send a JSON body (urllib sends a request that carries data as a POST)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", "Accept": "application/json", **(headers or {})})
    return _open(req, timeout)


def short_error(e: BaseException) -> str:
    """Error text without URLs (keeps internal addresses out of output)."""
    if isinstance(e, HttpError):
        return str(e)
    if isinstance(e, urllib.error.URLError):
        reason = getattr(e, "reason", None)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason):
            return "timed out"
        return "unreachable"
    if isinstance(e, TimeoutError):
        return "timed out"
    if isinstance(e, ConnectionError):
        return "unreachable"
    return type(e).__name__
