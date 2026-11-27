"""Command Center liveness without touching the app: watch `command-center.exe` from outside.

The overseer keeps an open process handle (SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION) on
the Command Center. That gives three things with no app-side heartbeat, no rebuild and no CSP change:

  * exit code once it ends: 0 → clean close (HIBERNATE / DETACHED), anything else → crash
    (panic, access violation, `taskkill /F` = 1);
  * freeze: `IsHungAppWindow` on its visible top-level windows (Windows marks a window hung after
    ~5 s without pumping messages);
  * presence: absent at start = DETACHED (not a crash).

States: RUNNING, HUNG, EXITED_CLEAN, EXITED_CRASH, ABSENT, UNKNOWN (non-Windows / API failure).
"""

from __future__ import annotations

import os
import sys
from typing import Any

EXE_NAME = "command-center.exe"
STILL_ACTIVE = 259


class CcProbe:
    def __init__(self, exe_name: str = EXE_NAME) -> None:
        self.exe = exe_name.lower()
        self._h: Any = None
        self._pid: int | None = None
        self._k32 = self._u32 = None
        if sys.platform == "win32":
            try:
                import ctypes
                from ctypes import wintypes

                self._ct, self._wt = ctypes, wintypes
                self._k32 = ctypes.WinDLL("kernel32", use_last_error=True)
                self._u32 = ctypes.WinDLL("user32", use_last_error=True)
                self._k32.OpenProcess.restype = wintypes.HANDLE
                self._k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
            except Exception:  # noqa: BLE001
                self._k32 = None

    # ── win32 helpers ────────────────────────────────────────────────
    def _find_pid(self) -> int | None:
        ct, wt = self._ct, self._wt

        class PE(ct.Structure):
            _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                        ("th32DefaultHeapID", ct.c_void_p), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                        ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ct.c_long), ("dwFlags", wt.DWORD),
                        ("szExeFile", ct.c_wchar * 260)]

        snap = self._k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
        if not snap or snap == wt.HANDLE(-1).value:
            return None
        try:
            pe = PE()
            pe.dwSize = ct.sizeof(PE)
            ok = self._k32.Process32FirstW(snap, ct.byref(pe))
            while ok:
                if pe.szExeFile.lower() == self.exe:
                    return int(pe.th32ProcessID)
                ok = self._k32.Process32NextW(snap, ct.byref(pe))
        finally:
            self._k32.CloseHandle(snap)
        return None

    def _hung(self, pid: int) -> bool:
        ct, wt = self._ct, self._wt
        hung = []
        proto = ct.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

        def cb(hwnd, _lp):
            p = wt.DWORD()
            self._u32.GetWindowThreadProcessId(hwnd, ct.byref(p))
            if p.value == pid and self._u32.IsWindowVisible(hwnd):
                hung.append(bool(self._u32.IsHungAppWindow(hwnd)))
            return True

        self._u32.EnumWindows(proto(cb), 0)
        return bool(hung) and all(hung)

    def _close(self) -> None:
        if self._h:
            try:
                self._k32.CloseHandle(self._h)
            except Exception:  # noqa: BLE001
                pass
        self._h, self._pid = None, None

    # ── public ───────────────────────────────────────────────────────
    def poll(self) -> dict[str, Any]:
        if self._k32 is None:
            return {"state": "UNKNOWN", "pid": None, "exitCode": None, "detail": "process watch needs Windows"}
        ct, wt = self._ct, self._wt
        try:
            if self._h:
                code = wt.DWORD()
                if self._k32.GetExitCodeProcess(self._h, ct.byref(code)) and code.value != STILL_ACTIVE:
                    pid, c = self._pid, int(code.value)
                    self._close()
                    return {"state": "EXITED_CLEAN" if c == 0 else "EXITED_CRASH", "pid": pid, "exitCode": c,
                            "detail": f"exit code {c:#x}" if c else "clean exit"}
                if self._hung(self._pid):
                    return {"state": "HUNG", "pid": self._pid, "exitCode": None, "detail": "window not responding"}
                return {"state": "RUNNING", "pid": self._pid, "exitCode": None, "detail": ""}
            pid = self._find_pid()
            if pid is None:
                return {"state": "ABSENT", "pid": None, "exitCode": None, "detail": f"{self.exe} not running"}
            h = self._k32.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
            if not h:
                return {"state": "UNKNOWN", "pid": pid, "exitCode": None, "detail": f"OpenProcess failed ({ct.get_last_error()})"}
            self._h, self._pid = h, pid
            return {"state": "RUNNING", "pid": pid, "exitCode": None, "detail": "attached"}
        except Exception as e:  # noqa: BLE001
            return {"state": "UNKNOWN", "pid": self._pid, "exitCode": None, "detail": f"{type(e).__name__}: {e}"}


def pid_alive(pid: int) -> bool:
    """Best-effort: is a process with this pid running (used for the overseer's own pid file)."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        k32 = ctypes.WinDLL("kernel32")
        k32.OpenProcess.restype = ctypes.c_void_p
        h = k32.OpenProcess(0x1000, False, pid)
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(k32.GetExitCodeProcess(ctypes.c_void_p(h), ctypes.byref(code))) and code.value == STILL_ACTIVE
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
