"""`python -m memory_scrolls {compact,status,offload}`.

Exit codes: 0 ok, 75 deferred (busy / no loaded model / another run), 2 config or validation
error, 1 unexpected. With `--json`, stdout is NDJSON: `{"event":"phase",...}` lines then one
`{"event":"result",...}` line. Nothing secret is ever printed. Output is ASCII JSON (non-ASCII
characters as \\u escapes), so a console that is not UTF-8 never shows double-encoded text.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Mapping, Optional, TextIO

from . import compact, config, offload, privacy, scrub, stale_claims, state
from .errors import EXIT_CONFIG, EXIT_DEFERRED, EXIT_OK, EXIT_UNEXPECTED, ArchiveError, BookingRefused, ConfigError, Deferred


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--json", action="store_true", help="NDJSON events + result on stdout")
    p.add_argument("--scrolls-root", help="scrolls root (default env MEMORY_SCROLLS_DIR, os.json, or D:\\ai-hub-memory\\scrolls; never under C:\\ai-hub)")
    p.add_argument("--kg-path", help="knowledge graph file (default env MEMORY_KG_PATH or D:\\ai-hub-memory\\knowledge-graph.json; never under C:\\ai-hub)")
    p.add_argument("--archive-root", help="cold archive root (default: pinned root, env/.env MEMORY_ARCHIVE_DIR, D:\\ai-hub-archive, ./archive/memory)")
    p.add_argument("--state-dir", help="state dir (default env MEMORY_STATE_DIR or ./data/memory-scrolls)")
    p.add_argument("--show-privacy-policy", action="store_true", help="print the effective Tier-2 privacy policy (defaults + <state-dir>/privacy-policy.json) and exit")
    p.add_argument("--show-stale-claims", action="store_true", help="print the effective stale-claims policy (defaults + <state-dir>/stale-claims.json) and exit")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="memory_scrolls", description="Agentic OS tiered memory: compact, status, offload.")
    sub = p.add_subparsers(dest="cmd", required=True, metavar="{compact,status,offload}")
    c = sub.add_parser("compact", help="archive Tier-1 history, distill it into Memory Scrolls, sync changed scrolls")
    _common(c)
    c.add_argument("--dry-run", action="store_true", help="collect and report only; writes nothing")
    c.add_argument("--max-batches", type=int, default=4, help="max LM calls this run (default 4)")
    c.add_argument("--assume-idle", action="store_true", help="treat an unreachable gateway as idle")
    c.add_argument("--replay-llm", help="JSON list of canned model replies (tests / smoke); never contacts LM Studio")
    c.add_argument("--include-training-logs", action="store_true")
    c.add_argument("--include-gateway-chat", action="store_true")
    s = sub.add_parser("status", help="read-only summary (pending bytes/turns, scrolls, archive root)")
    _common(s)
    o = sub.add_parser("offload", help="migrate the existing RAG store into scrolls (--dry-run default)")
    _common(o)
    o.add_argument("--dry-run", action="store_true", help="(default) preview only")
    o.add_argument("--apply", action="store_true", help="live cutover; needs --confirm TOKEN from the dry-run")
    o.add_argument("--confirm", help="token printed by the dry-run")
    o.add_argument("--preview-dir", help="preview root (default ./staging/memory-scrolls-preview) or one preview folder")
    o.add_argument("--no-llm", action="store_true", help="extractive preview without the model")
    o.add_argument("--trace-requests", action="store_true", help="include the AnythingLLM (method, path) trace")
    o.add_argument("--assume-idle", action="store_true")
    o.add_argument("--replay-llm")
    o.add_argument("--max-llm-calls", type=int, default=None, help="LM call budget (default auto: one per chunk + one retry per target, max 32)")
    o.add_argument("--sources", choices=list(offload.SOURCE_MODES), default=None,
                   help="what the seed distills: curated (default; the read-only hub + the repo-doc allow-list; brain/ and every chat "
                        "source are archive-only: archived by --apply and their watermarks advanced) or all (everything distilled). "
                        "--apply uses the preview's own mode")
    return p


def load_paths(args, env: Mapping[str, str]) -> config.Paths:
    flags = {"scrolls_root": args.scrolls_root, "kg_path": args.kg_path, "archive_root": args.archive_root, "state_dir": args.state_dir}
    paths = config.resolve(flags, env)
    pinned = None if args.archive_root else state.pinned_root(paths.state_dir)
    return config.resolve(flags, env, pinned=pinned) if pinned else paths


def main(argv: Optional[List[str]] = None, env: Optional[Mapping[str, str]] = None, out: Optional[TextIO] = None) -> int:
    args = build_parser().parse_args(argv)
    env = dict(os.environ if env is None else env)
    out = out or sys.stdout
    as_json = bool(getattr(args, "json", False))
    known: List[str] = scrub.known_values(None, env)

    def emit(evt: dict) -> None:
        if as_json:
            out.write(json.dumps(scrub.scrub_obj(evt, known), ensure_ascii=True) + "\n")
            out.flush()

    def finish(code: int, result: dict) -> int:
        result = scrub.scrub_obj(result, known)
        if as_json:
            out.write(json.dumps({"event": "result", "exit": code, **result}, ensure_ascii=True) + "\n")
        else:
            out.write(json.dumps(result, indent=2, ensure_ascii=True) + "\n")
        out.flush()
        return code

    try:
        paths = load_paths(args, env)
        known = scrub.known_values(paths.dotenv, env)
        if getattr(args, "show_privacy_policy", False):
            return finish(EXIT_OK, {"privacy_policy": privacy.describe(offload.effective_privacy(paths, env)[0])})
        if getattr(args, "show_stale_claims", False):
            return finish(EXIT_OK, {"stale_claims": stale_claims.describe(stale_claims.load(paths.state_dir))})
        if args.cmd == "status":
            return finish(EXIT_OK, compact.status(paths, env))
        if args.cmd == "compact":
            opts = compact.CompactOptions(
                dry_run=args.dry_run, max_batches=args.max_batches, assume_idle=args.assume_idle,
                replay_llm=Path(args.replay_llm) if args.replay_llm else None,
                include_training_logs=args.include_training_logs, include_gateway_chat=args.include_gateway_chat,
            )
            return finish(EXIT_OK, compact.run(paths, opts, env, emit))
        if args.cmd == "offload":
            if args.apply and args.dry_run:
                raise ConfigError("--apply and --dry-run are exclusive")
            opts = offload.OffloadOptions(
                apply=args.apply, confirm=args.confirm, preview_dir=Path(args.preview_dir) if args.preview_dir else None,
                no_llm=args.no_llm, assume_idle=args.assume_idle, replay_llm=Path(args.replay_llm) if args.replay_llm else None,
                trace_requests=args.trace_requests, max_llm_calls=args.max_llm_calls, sources=args.sources,
            )
            res = offload.run(paths, opts, env, emit)
            # A partial `--apply` (an un-embed failed mid-way) returns its actions with an error.
            return finish(EXIT_UNEXPECTED if res.get("error") else EXIT_OK, res)
        raise ConfigError("unknown command")
    except Deferred as e:
        return finish(EXIT_DEFERRED, {"deferred": str(e)})
    except (ConfigError, BookingRefused) as e:
        return finish(EXIT_CONFIG, {"error": str(e)})
    except ArchiveError as e:
        return finish(EXIT_UNEXPECTED, {"error": f"archive: {e}"})
    except Exception as e:  # noqa: BLE001
        return finish(EXIT_UNEXPECTED, {"error": f"{type(e).__name__}: {str(e)[:300]}"})


if __name__ == "__main__":
    sys.exit(main())
