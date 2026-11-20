"""The AnythingLLM API key (D7). Read-only; never printed, logged or stored.

Order: env `ANYTHINGLLM_API_KEY` (the desktop host passes it from the keychain), else the Windows
Credential Manager entry the desktop app writes (keyring 3 format `{user}.{service}`, user
`anythingllm@<host:port>`, service `agentic-os-command-center`; blob UTF-16LE).
`AOS_NO_KEYCHAIN=1` disables the Credential Manager lookup (tests).
"""

from __future__ import annotations

import json
import os
import urllib.parse
from pathlib import Path
from typing import Callable, Mapping, Optional

SERVICE = "agentic-os-command-center"
DEFAULT_HOST = "127.0.0.1:3001"


def decode_blob(blob: bytes) -> Optional[str]:
    if not blob:
        return None
    if len(blob) % 2 == 0:
        try:
            s = blob.decode("utf-16-le")
            if "\x00" not in s and s.isprintable():
                return s
        except UnicodeDecodeError:
            pass
    try:
        s = blob.decode("utf-8")
        return s if s.isprintable() else None
    except UnicodeDecodeError:
        return None


def host_of(base_url: str) -> str:
    try:
        u = urllib.parse.urlsplit(base_url)
    except ValueError:
        return DEFAULT_HOST
    if not u.hostname:
        return DEFAULT_HOST
    return f"{u.hostname.lower()}:{u.port}" if u.port else u.hostname.lower()


def provider_host(providers_json: Optional[Path]) -> str:
    try:
        data = json.loads(Path(providers_json).read_text(encoding="utf-8-sig")) if providers_json else {}
    except (OSError, ValueError, TypeError):
        data = {}
    for p in (data.get("providers") or []) if isinstance(data, dict) else []:
        if isinstance(p, dict) and p.get("id") == "anythingllm" and isinstance(p.get("baseUrl"), str):
            return host_of(p["baseUrl"])
    return DEFAULT_HOST


def target_name(host: str) -> str:
    return f"anythingllm@{host}.{SERVICE}"


def cred_read(target: str) -> Optional[bytes]:
    """Windows `CredReadW` (generic credential). None elsewhere or when absent."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class CREDENTIAL(ctypes.Structure):
            _fields_ = [
                ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
                ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
                ("UserName", wintypes.LPWSTR),
            ]

        advapi = ctypes.WinDLL("advapi32", use_last_error=True)  # type: ignore[attr-defined]
        pcred = ctypes.POINTER(CREDENTIAL)()
        CRED_TYPE_GENERIC = 1
        if not advapi.CredReadW(ctypes.c_wchar_p(target), CRED_TYPE_GENERIC, 0, ctypes.byref(pcred)):
            return None
        try:
            c = pcred.contents
            return bytes(bytearray(c.CredentialBlob[i] for i in range(c.CredentialBlobSize)))
        finally:
            advapi.CredFree(pcred)
    except Exception:
        return None


def allm_key(env: Mapping[str, str], providers_json: Optional[Path] = None, reader: Callable[[str], Optional[bytes]] = cred_read) -> Optional[str]:
    v = (env.get("ANYTHINGLLM_API_KEY") or "").strip()
    if v:
        return v
    if (env.get("AOS_NO_KEYCHAIN") or "") == "1":
        return None
    blob = reader(target_name(provider_host(providers_json)))
    s = decode_blob(blob) if blob else None
    return s.strip() if s and s.strip() else None
