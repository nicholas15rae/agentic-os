"""Resolve every path and endpoint once. Read-only: never writes `.env`, os.json or providers.json.

Precedence per key: CLI flag > process env > os.json (`memory.scrolls.*`, read-only) > default.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Mapping, Optional, Tuple

from . import fsutil, scrub
from .errors import ConfigError

NEVER_TOUCH = frozenset({"my-workspace", "booking"})

# Nic's decision: the live scrolls and knowledge graph live on D: (C:\ai-hub stays read-only).
# Nothing here creates D:\ai-hub-memory; only an explicit `offload --apply` / compaction run does.
DEFAULT_MEMORY_ROOT = r"D:\ai-hub-memory"
DEFAULT_SCROLLS_ROOT = DEFAULT_MEMORY_ROOT + r"\scrolls"
DEFAULT_KG_PATH = DEFAULT_MEMORY_ROOT + r"\knowledge-graph.json"
D_ARCHIVE = r"D:\ai-hub-archive"
D_MIN_FREE = 5 * 1024 ** 3
DEFAULT_LM_BASE = "http://127.0.0.1:1235/v1"
DEFAULT_GATEWAY = "http://127.0.0.1:8080"
DEFAULT_ALLM = "http://127.0.0.1:3001"
DEFAULT_THRESHOLD_KB = 50
DEFAULT_THRESHOLD_TURNS = 25

REPO_ROOT = Path(__file__).resolve().parent.parent


def app_config_dir(env: Mapping[str, str]) -> Path:
    return Path(env.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "os.agentic.commandcenter"


def read_json(path: Optional[Path]) -> dict:
    if not path:
        return {}
    try:
        v = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


@dataclass
class DriveProbes:
    """Injected so tests can fake D: (fixed / removable / small)."""

    drive_fixed: Callable[[str], bool]
    free_bytes: Callable[[str], int]


def _drive_fixed(root: str) -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes

        DRIVE_FIXED = 3
        return ctypes.windll.kernel32.GetDriveTypeW(ctypes.c_wchar_p(root)) == DRIVE_FIXED  # type: ignore[attr-defined]
    except Exception:
        return False


def _free_bytes(root: str) -> int:
    try:
        return shutil.disk_usage(root).free
    except OSError:
        return 0


REAL_PROBES = DriveProbes(_drive_fixed, _free_bytes)


def _check_root(p: str, what: str) -> Path:
    path = Path(p)
    if not path.is_absolute() or (os.name == "nt" and not path.drive):
        raise ConfigError(f"{what} must be an absolute path")
    for anc in [path, *path.parents]:
        if anc.exists():
            if fsutil.is_reparse(anc) and anc == path:
                raise ConfigError(f"{what} is a link or junction")
            break
    return path


HUB_OS_JSON_WARNING = "os.json memory.scrolls.{key} is under the read-only ai-hub tree; ignored, as the app does"


def os_json_dir(scfg: Mapping, key: str, warnings: Optional[list] = None) -> Optional[str]:
    """`memory.scrolls.<key>` from os.json, or None when unset or under the read-only hub.

    Mirrors os_core.rs `ScrollsConfig::sanitized()`: the app drops such a value and shows the
    default, so the CLI falls back to the default too (instead of refusing every run). A flag or env
    value under the hub is still refused outright (HubWriteRefused).
    """
    v = scfg.get(key) if isinstance(scfg, Mapping) else None
    if not isinstance(v, str) or not v.strip():
        return None
    if fsutil.protected_root(v.strip()) is not None:
        if warnings is not None:
            warnings.append(HUB_OS_JSON_WARNING.format(key=key))
        return None
    return v.strip()


def resolve_archive_root(env: Mapping[str, str], dotenv: Mapping[str, str], cfg: Mapping, probes: DriveProbes, repo_root: Path, warnings: Optional[list] = None) -> Tuple[Path, str]:
    """D3 chain (pure, probes injected): env > .env > os.json > D: fixed with >= 5 GB > repo fallback.

    An os.json archiveDir under the read-only hub is skipped (see `os_json_dir`).
    """
    scrolls_cfg = ((cfg.get("memory") or {}).get("scrolls") or {}) if isinstance(cfg.get("memory"), dict) else {}
    for value, source in ((env.get("MEMORY_ARCHIVE_DIR"), "env"), (dotenv.get("MEMORY_ARCHIVE_DIR"), ".env"), (os_json_dir(scrolls_cfg, "archiveDir", warnings), "os.json")):
        if isinstance(value, str) and value.strip():
            return _check_root(value.strip(), "MEMORY_ARCHIVE_DIR"), source
    if probes.drive_fixed("D:\\") and probes.free_bytes("D:\\") >= D_MIN_FREE:
        return Path(D_ARCHIVE), "D:"
    return Path(repo_root) / "archive" / "memory", "fallback"


@dataclass
class Paths:
    repo_root: Path
    scrolls_root: Path
    kg_path: Path
    archive_root: Path
    archive_root_source: str
    state_dir: Path
    tasks_db: Path
    threads_json: Path
    staging_root: Path
    notes_root: Path
    gateway_chat: Path
    training_logs: Path
    lm_base: str
    gateway_base: str
    allm_base: str
    allm_workspace: str
    allm_workspaces: dict = field(default_factory=dict)
    providers_json: Optional[Path] = None
    thresholds: Tuple[int, int] = (DEFAULT_THRESHOLD_KB, DEFAULT_THRESHOLD_TURNS)
    dotenv: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)

    @property
    def history_dir(self) -> Path:
        return self.state_dir / "scroll-history"


def _pick(flag, env: Mapping[str, str], env_key: str, cfg_value, default):
    for v in (flag, env.get(env_key), cfg_value):
        if isinstance(v, str) and v.strip():
            return v.strip()
    return default


def sanitize_workspace(slug: Optional[str]) -> str:
    import re

    s = (slug or "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", s) or s in NEVER_TOUCH:
        return "librarian"
    return s


def resolve(flags: Optional[Mapping] = None, env: Optional[Mapping[str, str]] = None, probes: DriveProbes = REAL_PROBES, pinned: Optional[str] = None) -> Paths:
    """Build `Paths`. `pinned` = the archive root recorded in state.json (if any)."""
    flags = dict(flags or {})
    env = dict(os.environ if env is None else env)
    repo_root = Path(_pick(flags.get("repo_root"), env, "AOS_REPO_ROOT", None, str(REPO_ROOT)))
    cfg_dir = app_config_dir(env)
    os_json = read_json(Path(env["AOS_OS_JSON"]) if env.get("AOS_OS_JSON") else cfg_dir / "os.json")
    providers_path = Path(env["AOS_PROVIDERS_JSON"]) if env.get("AOS_PROVIDERS_JSON") else cfg_dir / "providers.json"
    providers = read_json(providers_path)
    dotenv = scrub.read_dotenv(repo_root / ".env")
    mem = os_json.get("memory") if isinstance(os_json.get("memory"), dict) else {}
    scfg = mem.get("scrolls") if isinstance(mem.get("scrolls"), dict) else {}
    allm_cfg = os_json.get("anythingllm") if isinstance(os_json.get("anythingllm"), dict) else {}
    workspaces = allm_cfg.get("workspaces") if isinstance(allm_cfg.get("workspaces"), dict) else {}
    warnings = []

    def provider_base(pid: str) -> Optional[str]:
        for p in providers.get("providers") or []:
            if isinstance(p, dict) and p.get("id") == pid and isinstance(p.get("baseUrl"), str):
                return p["baseUrl"]
        return None

    gw = providers.get("gateway") if isinstance(providers.get("gateway"), dict) else {}
    lm_base = _pick(None, env, "AOS_LMSTUDIO_BASE", provider_base("lmstudio"), DEFAULT_LM_BASE)
    gateway_base = _pick(None, env, "AOS_GATEWAY_BASE", gw.get("url"), DEFAULT_GATEWAY)
    allm_base = _pick(None, env, "ANYTHINGLLM_BASE", allm_cfg.get("baseUrl"), DEFAULT_ALLM)
    raw_ws = _pick(None, env, "MEMORY_SCROLLS_WORKSPACE", scfg.get("workspace") or workspaces.get("librarian"), "librarian")
    ws = sanitize_workspace(raw_ws)
    if ws != raw_ws:
        warnings.append("scroll workspace refused (Booking or invalid); using librarian")

    if flags.get("archive_root"):
        archive_root, source = _check_root(str(flags["archive_root"]), "--archive-root"), "flag"
    elif pinned:
        archive_root, source = Path(pinned), "pinned"
        if not archive_root.is_dir():
            raise ConfigError("the pinned archive root is missing; refusing to start a second archive (restore it or edit state.json)")
        configured, _ = resolve_archive_root(env, dotenv, os_json, probes, repo_root, warnings)
        if os.path.normcase(str(configured)) != os.path.normcase(str(archive_root)) and configured.exists():
            warnings.append("configured archive root differs from the pinned one; using the pinned root")
    else:
        archive_root, source = resolve_archive_root(env, dotenv, os_json, probes, repo_root, warnings)

    def num(v, default, lo, hi):
        try:
            return max(lo, min(hi, int(v)))
        except (TypeError, ValueError):
            return default

    cc_data = Path(env["CC_DATA_DIR"]) if env.get("CC_DATA_DIR") else repo_root / "data" / "command-center"
    paths = Paths(
        repo_root=repo_root,
        scrolls_root=_check_root(_pick(flags.get("scrolls_root"), env, "MEMORY_SCROLLS_DIR", os_json_dir(scfg, "scrollsDir", warnings), DEFAULT_SCROLLS_ROOT), "scrolls root"),
        kg_path=_check_root(_pick(flags.get("kg_path"), env, "MEMORY_KG_PATH", None, DEFAULT_KG_PATH), "knowledge graph path"),
        archive_root=archive_root,
        archive_root_source=source,
        state_dir=_check_root(_pick(flags.get("state_dir"), env, "MEMORY_STATE_DIR", None, str(repo_root / "data" / "memory-scrolls")), "state dir"),
        tasks_db=Path(_pick(None, env, "AOS_TASKS_DB", None, str(cfg_dir / "tasks.db"))),
        threads_json=cc_data / "os-threads.json",
        staging_root=Path(_pick(None, env, "AOS_STAGING_DIR", None, str(repo_root / "staging"))),
        notes_root=Path(_pick(None, env, "AOS_NOTES_DIR", mem.get("notesDir"), str(repo_root / "memory" / "tony"))),
        gateway_chat=repo_root / "data" / "chat-history.json",
        training_logs=repo_root / "training_logs",
        lm_base=lm_base.rstrip("/"),
        gateway_base=gateway_base.rstrip("/"),
        allm_base=allm_base.rstrip("/"),
        allm_workspace=ws,
        allm_workspaces={k: v for k, v in workspaces.items() if isinstance(v, str)},
        providers_json=providers_path,
        thresholds=(num(scfg.get("thresholdKb"), DEFAULT_THRESHOLD_KB, 8, 1024), num(scfg.get("thresholdTurns"), DEFAULT_THRESHOLD_TURNS, 5, 500)),
        dotenv=dotenv,
        warnings=warnings,
    )
    refuse_write_targets(paths)
    return paths


def write_targets(paths: Paths) -> Dict[str, Path]:
    """Every location a Memory Scrolls run may write (scrolls, graph, archive, state, previews)."""
    return {
        "scrolls root": Path(paths.scrolls_root),
        "knowledge graph path": Path(paths.kg_path),
        "archive root": Path(paths.archive_root),
        "state dir": Path(paths.state_dir),
        "staging dir": Path(paths.staging_root),
    }


def refuse_write_targets(paths: Paths) -> None:
    """Hard guard: no write target may resolve under C:\\ai-hub (flag, env, .env, os.json, pinned or default)."""
    for what, p in write_targets(paths).items():
        fsutil.refuse_protected(p, what)


def offload_workspaces(paths: Paths) -> list:
    """AnythingLLM workspaces the offload may read: os.json map values minus NEVER_TOUCH (deduped)."""
    import re

    out = []
    for slug in paths.allm_workspaces.values():
        if slug in NEVER_TOUCH or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", slug or ""):
            continue
        if slug not in out:
            out.append(slug)
    return sorted(out)
