#!/usr/bin/env python3
"""Zero-dependency test runner for Agentic OS: the verify gate.

Usage:
    python tests/run_all.py                       every tests/test_*.py module (the gate)
    python tests/run_all.py "test_trading_*.py"   one group, e.g. under trading\\.venv
    python tests/run_all.py -j 1                  serial, in this process (for debugging)
    python tests/run_all.py -v                    also print the output of modules that passed

Each tests/test_*.py module runs in its own worker process, -j at a time (default: half the CPU
threads, max 8, so the live services keep some room). The slowest modules (as timed on the
last run) start first. A module whose tests pass prints one line; a module with a failure or
error prints its whole output. -j 1 runs everything in this process, in file order.

Some tests assert wall-clock bounds (a long-poll answered within 0.5 s, ...), which a busy machine
can miss. So a module that fails while the other workers run is rerun once on its own, as the
serial gate ran it, and the solo run decides. Tests that failed only under load are listed as
"flaky under load" in the summary and the outcome line. --no-retry makes the first run final.

Modules are found by file name, so a new tests/test_*.py file runs without being registered
here. Two things keep the gate from shrinking quietly:
- A module that fails to import is a test error (unittest's _FailedTest), never dropped.
- EveryTestFileLoaded fails the run when a tests/test_*.py file matching the pattern gave no
  tests at all (it did not load, its name is not a valid module name, or it has no TestCase).

Each module boots its own isolated Harness or temp dirs, so no real project data is touched.
Requires python3 and the gateway's packages (fastapi, uvicorn, ...). No pytest.

Two interpreters run this code (system Python for the gateway, trading\\.venv for the bridge),
and they don't have the same packages. A test that needs a package this interpreter lacks skips
with the reason, and the runner lists every skipped test at the end:
- test_trading_review_regressions.AdapterFreshness needs ib_async (pinned in trading\\.venv).
- test_trading_agent.AgentThinkReasoningTests needs python-multipart and httpx2 (starlette's
  TestClient): the gateway's packages, in system Python.
The gateway modules (server.py, command_center_api, ...) need system Python, so under
trading\\.venv run only the "test_trading_*.py" group.
"""
import argparse
import json
import locale
import os
import subprocess
import sys
import tempfile
import time
import unittest
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PATTERN = "test_*.py"
DURATIONS = Path(tempfile.gettempdir()) / "agentic-os-run_all-durations.json"
LINE = "-" * 70


def iter_tests(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from iter_tests(item)
        else:
            yield item


def module_of(test) -> str:
    """The test module a case came from. A file that raised on import (or raised SkipTest at
    module level) becomes a placeholder case in unittest.loader named after its module."""
    cls = type(test)
    if cls.__module__ == "unittest.loader":
        return test._testMethodName
    return cls.__module__


def discover(pattern: str) -> unittest.TestSuite:
    # discover(), unlike loadTestsFromName(), turns ANY import-time exception into a _FailedTest
    # (FastAPI raises RuntimeError, not ImportError, when python-multipart is missing).
    return unittest.TestLoader().discover(start_dir=str(HERE), pattern=pattern, top_level_dir=str(HERE))


class EveryTestFileLoaded(unittest.TestCase):
    """The gate covers every tests/test_*.py file. The runner fills `loaded` in from the loaded
    suite (serial) or from the workers' reports (parallel) before this runs."""

    pattern = DEFAULT_PATTERN
    loaded: set = set()

    def test_every_test_file_contributed_tests(self):
        expected = {p.stem for p in HERE.glob(self.pattern)}
        self.assertTrue(expected, f"no tests/{self.pattern} file found")
        missing = sorted(expected - self.loaded)
        self.assertEqual(missing, [], "these tests/ files gave no tests (not loaded, invalid module name, or no TestCase)")


def outcome_line(failures: int, errors: int, skipped: int, xfail: int = 0, xpass: int = 0, flaky: int = 0) -> str:
    parts = [f"{k}={v}" for k, v in (("failures", failures), ("errors", errors), ("skipped", skipped),
                                     ("expected failures", xfail), ("unexpected successes", xpass),
                                     ("flaky under load", flaky)) if v]
    word = "FAILED" if failures or errors or xpass else "OK"
    return f"{word} ({', '.join(parts)})" if parts else word


def report_skips(skipped, stream) -> None:
    """skipped: (test id, reason) pairs, grouped by reason."""
    if not skipped:
        return
    by_reason = defaultdict(list)
    for test_id, reason in skipped:
        by_reason[reason].append(test_id)
    stream.write(f"\nSkipped {len(skipped)} test(s):\n")
    for reason in sorted(by_reason):
        ids = sorted(by_reason[reason])
        stream.write(f"  {reason} ({len(ids)})\n")
        for test_id in ids:
            stream.write(f"    {test_id}\n")
    stream.flush()


# ── worker: one module, in its own process ──────────────────────────────────

def run_worker(name: str, result_path: str) -> int:
    suite = discover(f"{name}.py")
    loaded = sorted({module_of(t) for t in iter_tests(suite)})
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(suite)
    report = {
        "run": result.testsRun,
        "failures": [t.id() for t, _ in result.failures],
        "errors": [t.id() for t, _ in result.errors],
        "skipped": [(t.id(), reason) for t, reason in result.skipped],
        "xfail": len(result.expectedFailures),
        "xpass": len(result.unexpectedSuccesses),
        "loaded": loaded,
    }
    Path(result_path).write_text(json.dumps(report), encoding="utf-8")
    return 0 if result.wasSuccessful() else 1


def run_module(name: str, timeout: float) -> dict:
    fd, result_path = tempfile.mkstemp(prefix=f"run_all-{name}-", suffix=".json")
    os.close(fd)
    t0 = time.perf_counter()
    try:
        p = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker", name, "--result", result_path],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        output, crash = p.stdout, None
        if p.returncode not in (0, 1):
            crash = f"worker exited with code {p.returncode}"
    except subprocess.TimeoutExpired as e:
        output, crash = e.stdout or b"", f"timed out after {timeout:.0f} s (the worker was killed)"
    secs = time.perf_counter() - t0
    try:
        report = json.loads(Path(result_path).read_text(encoding="utf-8")) if not crash else None
    except (OSError, ValueError):
        report, crash = None, "worker wrote no result (it crashed before the run finished)"
    finally:
        Path(result_path).unlink(missing_ok=True)
    if report is None:  # one error for the module; counted as loaded so the coverage check doesn't repeat it
        report = {"run": 0, "failures": [], "errors": [f"{name} ({crash})"], "skipped": [], "xfail": 0, "xpass": 0, "loaded": [name]}
    report.update(name=name, secs=secs, output=output.decode(locale.getpreferredencoding(False), "replace"))
    return report


def load_durations() -> dict:
    try:
        return json.loads(DURATIONS.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def save_durations(durations: dict) -> None:
    try:
        DURATIONS.write_text(json.dumps(durations, indent=1, sort_keys=True), encoding="utf-8")
    except OSError:
        pass


def is_bad(r: dict) -> bool:
    return bool(r["failures"] or r["errors"] or r["xpass"])


def main_parallel(pattern: str, jobs: int, verbose: bool, timeout: float, retry: bool) -> int:
    names = sorted(p.stem for p in HERE.glob(pattern))
    durations = load_durations()
    # Longest first, so the last module to start is a short one. Unknown modules: by file size.
    order = sorted(names, key=lambda n: -durations.get(n, (HERE / f"{n}.py").stat().st_size / 2000))
    t0 = time.perf_counter()
    reports = []
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = [pool.submit(run_module, n, timeout) for n in order]
        for i, fut in enumerate(as_completed(futures), 1):
            r = fut.result()
            reports.append(r)
            print(f"[{i:>2}/{len(names)}] {'FAIL' if is_bad(r) else 'ok  '} {r['name']} ({r['run']} tests, {r['secs']:.1f} s)", flush=True)
            if is_bad(r) or verbose:
                print(f"{LINE}\n{r['output'].rstrip()}\n{LINE}", flush=True)
    busy = sum(r["secs"] for r in reports)
    save_durations({**durations, **{r["name"]: round(r["secs"], 1) for r in reports}})

    # A module that failed while the others ran gets one more run on its own, as the serial gate
    # ran it. Some tests assert wall-clock bounds (a long-poll answered in < 0.5 s, ...) that a busy
    # machine can miss. The solo run decides; the tests that failed only under load are listed.
    flaky = []  # (module, the test ids that failed with the other workers running)
    for idx, r in enumerate(reports):
        if not (retry and is_bad(r)):
            continue
        print(f"Rerunning {r['name']} alone (it failed with {jobs} workers running) ...", flush=True)
        again = run_module(r["name"], timeout)
        if is_bad(again):
            print(f"FAIL {again['name']} alone too ({again['run']} tests, {again['secs']:.1f} s)")
            print(f"{LINE}\n{again['output'].rstrip()}\n{LINE}", flush=True)
        else:
            print(f"ok   {again['name']} alone ({again['run']} tests, {again['secs']:.1f} s)", flush=True)
            flaky.append((r["name"], r["failures"] + r["errors"]))
        reports[idx] = again
    wall = time.perf_counter() - t0

    EveryTestFileLoaded.pattern = pattern
    EveryTestFileLoaded.loaded = {m for r in reports for m in r["loaded"]}
    check = unittest.TestResult()
    EveryTestFileLoaded("test_every_test_file_contributed_tests").run(check)
    check_failed = [tb for _, tb in check.failures + check.errors]
    print(f"{'FAIL' if check_failed else 'ok  '} EveryTestFileLoaded ({len(names)} files)")
    for tb in check_failed:
        print(tb)

    failures = [t for r in reports for t in r["failures"]] + (["EveryTestFileLoaded"] if check_failed else [])
    errors = [t for r in reports for t in r["errors"]]
    skipped = [tuple(s) for r in reports for s in r["skipped"]]
    xfail, xpass = sum(r["xfail"] for r in reports), sum(r["xpass"] for r in reports)
    flaky_ids = [t for _, ids in flaky for t in ids]

    print("=" * 70)
    for label, ids in (("FAIL", failures), ("ERROR", errors)):
        for test_id in ids:
            print(f"{label}: {test_id}")
    if flaky:
        print(f"Flaky under load: failed with {jobs} workers running, passed when their module was rerun alone:")
        for test_id in flaky_ids:
            print(f"  {test_id}")
    print("Slowest: " + ", ".join(f"{r['name']} {r['secs']:.0f} s" for r in sorted(reports, key=lambda r: -r["secs"])[:5]))
    print(LINE)
    print(f"Ran {sum(r['run'] for r in reports) + 1} tests in {wall:.1f}s ({len(names)} modules, {jobs} workers, {busy:.0f} s of work)")
    print()
    print(outcome_line(len(failures), len(errors), len(skipped), xfail, xpass, len(flaky_ids)), flush=True)
    report_skips(skipped, sys.stdout)
    return 1 if failures or errors or xpass else 0


def main_serial(pattern: str) -> int:
    found = discover(pattern)
    EveryTestFileLoaded.pattern = pattern
    EveryTestFileLoaded.loaded = {module_of(t) for t in iter_tests(found)}  # the suite drops each test once run
    loader = unittest.TestLoader()
    suite = unittest.TestSuite([loader.loadTestsFromTestCase(EveryTestFileLoaded), found])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report_skips([(t.id(), reason) for t, reason in result.skipped], sys.stderr)
    return 0 if result.wasSuccessful() else 1


def main(argv) -> int:
    ap = argparse.ArgumentParser(description="Agentic OS test gate (unittest only).")
    ap.add_argument("pattern", nargs="?", default=DEFAULT_PATTERN, help='file pattern in tests/ (default "test_*.py")')
    ap.add_argument("-j", "--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) // 2)),
                    help="worker processes (default: half the CPU threads, max 8); 1 = serial, in this process")
    ap.add_argument("-v", "--verbose", action="store_true", help="also print the output of modules that passed")
    ap.add_argument("--timeout", type=float, default=900, help="seconds before one module's worker is killed (default 900)")
    ap.add_argument("--no-retry", action="store_true", help="a module that fails with the other workers running is final (no solo rerun)")
    ap.add_argument("--worker", help=argparse.SUPPRESS)
    ap.add_argument("--result", help=argparse.SUPPRESS)
    args = ap.parse_args(argv[1:])
    if args.worker:
        return run_worker(args.worker, args.result)
    sys.stdout.reconfigure(errors="replace")
    print(f"Python {sys.version.split()[0]} ({sys.executable}), pattern {args.pattern}, {args.jobs} worker(s)", flush=True)
    if args.jobs <= 1:
        return main_serial(args.pattern)
    return main_parallel(args.pattern, args.jobs, args.verbose, args.timeout, retry=not args.no_retry)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
