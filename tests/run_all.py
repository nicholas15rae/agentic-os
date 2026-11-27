#!/usr/bin/env python3
"""Zero-dependency test runner for Agentic OS (v4.0).

Usage:  python3 tests/run_all.py

Runs every tests/test_*.py module. Each module boots its own isolated
Harness (temp state dir), so no real project data is ever touched.
Requires: python3 + installed deps (fastapi, uvicorn) — no pytest/httpx.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_core  # noqa: E402
import test_security  # noqa: E402
import test_kanban_journal  # noqa: E402
import test_memory_scheduler  # noqa: E402
import test_scheduler_history  # noqa: E402
import test_v40  # noqa: E402
import test_command_center_extract_json  # noqa: E402
import test_spotify_callback  # noqa: E402
import test_os_inbox  # noqa: E402
import test_vault_finance_scope  # noqa: E402
import test_cors  # noqa: E402
import test_command_center_llm  # noqa: E402
import test_task_mirror  # noqa: E402
import test_memory_scrolls  # noqa: E402
import test_memory_scrolls_offload  # noqa: E402
import test_memory_scrolls_privacy  # noqa: E402
import test_memory_scrolls_hub  # noqa: E402
import test_memory_scrolls_guards  # noqa: E402
import test_memory_scrolls_curated  # noqa: E402
import test_memory_scrolls_fidelity  # noqa: E402
import test_memory_scrolls_v6  # noqa: E402
import test_memory_scrolls_v7  # noqa: E402
import test_memory_scrolls_v8  # noqa: E402
import test_trading_bridge  # noqa: E402
import test_trading_desk  # noqa: E402
import test_trading_signals  # noqa: E402
import test_trading_engines  # noqa: E402
import test_trading_intel  # noqa: E402
import test_trading_health  # noqa: E402
import test_trading_agent  # noqa: E402
import test_trading_calendar  # noqa: E402
import test_trading_failures  # noqa: E402
import test_backup_verify  # noqa: E402
import test_business_profiles  # noqa: E402
import test_finance_gateway  # noqa: E402
import test_finance_summary  # noqa: E402
import test_phonebook  # noqa: E402


def main() -> int:
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for module in (test_core, test_security, test_kanban_journal,
                   test_memory_scheduler, test_scheduler_history, test_v40, test_command_center_extract_json,
                   test_spotify_callback, test_os_inbox, test_vault_finance_scope, test_cors, test_command_center_llm,
                   test_task_mirror, test_memory_scrolls, test_memory_scrolls_offload,
                   test_memory_scrolls_privacy, test_memory_scrolls_hub, test_memory_scrolls_guards,
                   test_memory_scrolls_curated, test_memory_scrolls_fidelity, test_memory_scrolls_v6,
                   test_memory_scrolls_v7, test_memory_scrolls_v8, test_trading_bridge, test_trading_desk, test_trading_signals, test_trading_engines, test_trading_intel, test_trading_health, test_trading_agent,
                   test_trading_calendar, test_trading_failures, test_backup_verify, test_business_profiles, test_finance_gateway, test_phonebook):
        suite.addTests(loader.loadTestsFromModule(module))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
