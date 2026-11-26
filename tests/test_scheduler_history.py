"""Scheduler event history (data/scheduler-history.json): concurrent saves and corrupt-file recovery.

Regression for the 2026-11-19 09:00 corruption: Heartbeat (*/5) and Daily Standup (0 9 * * 1-5)
fired in the same second on APScheduler's thread pool, both rewrote the file in place, and the
shorter write left the longer one's tail ("}\\r\\n]") behind. Every later event then raised
"Extra data" out of run_skill. These tests use a temp dir only, never the real data/.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import scheduler.scheduler as sched  # noqa: E402

LOGGER = "agentic_os.scheduler"


def _event(n: int, skill: str = "heartbeat") -> dict:
    return {"type": "skill_run", "skill": skill, "trigger": "cron", "status": "started",
            "timestamp": f"2026-11-19T13:{n % 60:02d}:00.000000+00:00", "id": f"seed{n:04d}"}


class HistoryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="agentic-os-sched-history-"))
        (self.tmp / "data").mkdir()
        (self.tmp / "audit").mkdir()
        (self.tmp / "scheduler").mkdir()
        self._saved = (sched.HISTORY_FILE, sched.BASE_DIR)
        sched.HISTORY_FILE = self.tmp / "data" / "scheduler-history.json"
        sched.BASE_DIR = self.tmp / "scheduler"  # run_skill appends to BASE_DIR.parent/audit/audit.log

    def tearDown(self):
        sched.HISTORY_FILE, sched.BASE_DIR = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def history(self) -> list:
        """Strict parse of the file as written; fails the test on any corruption."""
        return json.loads(sched.HISTORY_FILE.read_bytes().decode("utf-8"))

    def corrupt_copies(self) -> list:
        return sorted(sched.HISTORY_FILE.parent.glob("scheduler-history.corrupt-*.json"))

    def leftovers(self) -> list:
        return sorted(p.name for p in sched.HISTORY_FILE.parent.glob("*.tmp"))


class ConcurrentSaveTests(HistoryTestCase):
    def test_threads_saving_at_once_keep_every_event(self):
        threads, per_thread = 8, 25
        barrier = threading.Barrier(threads)
        errors = []

        def worker(t):
            barrier.wait()
            for i in range(per_thread):
                try:
                    sched._save_history({"id": f"t{t}-{i}"})
                except Exception as exc:  # pragma: no cover - the failure being tested for
                    errors.append(exc)

        pool = [threading.Thread(target=worker, args=(t,)) for t in range(threads)]
        for t in pool:
            t.start()
        for t in pool:
            t.join()
        self.assertEqual(errors, [])
        ids = [e["id"] for e in self.history()]
        self.assertEqual(len(ids), threads * per_thread)
        self.assertEqual(len(set(ids)), threads * per_thread)
        self.assertEqual(self.leftovers(), [])

    def test_heartbeat_and_daily_standup_due_in_the_same_second(self):
        """The exact 09:00 collision, 40 times over. The old code corrupted or lost an event every round."""
        sched.HISTORY_FILE.write_text(json.dumps([_event(n) for n in range(600)], indent=2))
        rounds = 40
        for _ in range(rounds):
            barrier = threading.Barrier(2)
            results = []

            def fire(skill):
                barrier.wait()
                results.append(sched.run_skill(skill, "cron"))

            pool = [threading.Thread(target=fire, args=(s,)) for s in ("heartbeat", "daily-standup")]
            for t in pool:
                t.start()
            for t in pool:
                t.join()
            self.assertEqual(len(results), 2)
        history = self.history()
        self.assertEqual(len(history), 600 + 2 * rounds)
        new = [e["skill"] for e in history[600:]]
        self.assertEqual(new.count("heartbeat"), rounds)
        self.assertEqual(new.count("daily-standup"), rounds)
        self.assertEqual(self.corrupt_copies(), [])

    def test_separate_processes_saving_at_once_keep_every_event(self):
        procs, per_proc = 3, 15
        start_at = time.time() + 2.0  # every process starts saving at the same moment
        code = (
            "import sys, time\n"
            "from pathlib import Path\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import scheduler.scheduler as s\n"
            "s.HISTORY_FILE = Path(sys.argv[2])\n"
            "time.sleep(max(0.0, float(sys.argv[3]) - time.time()))\n"
            "for i in range(int(sys.argv[4])):\n"
            "    s._save_history({'id': sys.argv[5] + '-' + str(i)})\n"
        )
        running = [
            subprocess.Popen([sys.executable, "-c", code, str(PROJECT_ROOT), str(sched.HISTORY_FILE),
                              repr(start_at), str(per_proc), f"p{p}"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for p in range(procs)
        ]
        for p in running:
            _, err = p.communicate(timeout=90)
            self.assertEqual(p.returncode, 0, err.decode("utf-8", "replace"))
        ids = [e["id"] for e in self.history()]
        self.assertEqual(len(ids), procs * per_proc)
        self.assertEqual(len(set(ids)), procs * per_proc)
        self.assertEqual(self.leftovers(), [])

    def test_history_is_trimmed_to_the_limit(self):
        with mock.patch.object(sched, "HISTORY_LIMIT", 5):
            for i in range(8):
                sched._save_history({"id": f"e{i}"})
        self.assertEqual([e["id"] for e in self.history()], ["e3", "e4", "e5", "e6", "e7"])


class CorruptFileRecoveryTests(HistoryTestCase):
    def write_raw(self, raw: bytes):
        sched.HISTORY_FILE.write_bytes(raw)

    def test_extra_data_tail_is_kept_aside_and_events_salvaged(self):
        """The real failure: a valid CRLF list followed by the leftover "}\\r\\n]"."""
        good = json.dumps([_event(n) for n in range(608)], indent=2).replace("\n", "\r\n")
        raw = (good + "}\r\n]").encode("utf-8")
        self.write_raw(raw)
        with self.assertRaises(json.JSONDecodeError):
            json.loads(raw)  # the same "Extra data" every event used to hit

        with self.assertLogs(LOGGER, "WARNING") as logs:
            sched.emit_event({"type": "skill_run", "skill": "heartbeat", "trigger": "cron", "status": "started"})
        self.assertEqual(len(logs.output), 1)
        self.assertIn("Extra data", logs.output[0])
        self.assertIn("608 events", logs.output[0])

        copies = self.corrupt_copies()
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_bytes(), raw, "the bad file must be kept byte for byte")
        history = self.history()
        self.assertEqual(len(history), 609)
        self.assertEqual(history[0]["id"], "seed0000")
        self.assertEqual(history[-1]["skill"], "heartbeat")

        # Recovered once: the next event is saved without another warning or copy.
        with self.assertNoLogs(LOGGER, "WARNING"):
            sched.emit_event({"type": "skill_run", "skill": "heartbeat", "trigger": "cron", "status": "started"})
        self.assertEqual(len(self.history()), 610)
        self.assertEqual(len(self.corrupt_copies()), 1)

    def test_unsalvageable_file_starts_a_fresh_history(self):
        raw = b'[\r\n  {\r\n    "type": "skill_run",\r\n    "skill": "heartb'  # torn mid-write
        self.write_raw(raw)
        with self.assertLogs(LOGGER, "WARNING"):
            sched._save_history({"id": "first-after"})
        self.assertEqual([e["id"] for e in self.history()], ["first-after"])
        self.assertEqual(self.corrupt_copies()[0].read_bytes(), raw)

    def test_wrong_top_level_type_is_recovered(self):
        raw = b'{"events": []}'
        self.write_raw(raw)
        with self.assertLogs(LOGGER, "WARNING") as logs:
            sched._save_history({"id": "x"})
        self.assertIn("not a list", logs.output[0])
        self.assertEqual([e["id"] for e in self.history()], ["x"])
        self.assertEqual(self.corrupt_copies()[0].read_bytes(), raw)

    def test_get_history_recovers_instead_of_raising(self):
        good = json.dumps([_event(n) for n in range(10)], indent=2)
        self.write_raw((good + "}\n]").encode("utf-8"))
        with self.assertLogs(LOGGER, "WARNING"):
            events = sched.get_history(limit=3)
        self.assertEqual([e["id"] for e in events], ["seed0007", "seed0008", "seed0009"])
        self.assertEqual(len(self.history()), 10)

    def test_two_incidents_keep_two_copies(self):
        self.write_raw(b"not json")
        with self.assertLogs(LOGGER, "WARNING"):
            sched._save_history({"id": "a"})
        self.write_raw(b"also not json")
        with self.assertLogs(LOGGER, "WARNING"):
            sched._save_history({"id": "b"})
        copies = self.corrupt_copies()
        self.assertEqual(len(copies), 2)
        self.assertEqual(sorted(c.read_bytes() for c in copies), [b"also not json", b"not json"])

    def test_old_crlf_file_loads_without_recovery(self):
        """Files written by the old Path.write_text on Windows have CRLF newlines and are valid."""
        self.write_raw(json.dumps([_event(1)], indent=2).replace("\n", "\r\n").encode("utf-8"))
        with self.assertNoLogs(LOGGER, "WARNING"):
            sched._save_history({"id": "next"})
        self.assertEqual([e["id"] for e in self.history()], ["seed0001", "next"])
        self.assertEqual(self.corrupt_copies(), [])

    def test_missing_or_empty_file_is_an_empty_history(self):
        self.assertEqual(sched.get_history(), [])
        self.write_raw(b"")
        self.assertEqual(sched.get_history(), [])
        self.assertEqual(self.corrupt_copies(), [])


class RunSkillSurvivesHistoryFailureTests(HistoryTestCase):
    def test_run_skill_completes_when_the_history_cannot_be_saved(self):
        with mock.patch.object(sched, "_write_history", side_effect=OSError("disk full")):
            with self.assertLogs(LOGGER, "WARNING") as logs:
                result = sched.run_skill("heartbeat", "cron")
        self.assertEqual(result, {"status": "triggered", "skill": "heartbeat", "trigger": "cron"})
        self.assertIn("disk full", logs.output[0])
        audit = (self.tmp / "audit" / "audit.log").read_text().splitlines()
        self.assertEqual(json.loads(audit[-1])["skill"], "heartbeat")

    def test_run_skill_completes_on_a_corrupt_file(self):
        sched.HISTORY_FILE.write_bytes(b"[]}\r\n]")
        with self.assertLogs(LOGGER, "WARNING"):
            result = sched.run_skill("daily-standup", "cron")
        self.assertEqual(result["status"], "triggered")
        self.assertEqual([e["skill"] for e in self.history()], ["daily-standup"])


if __name__ == "__main__":
    unittest.main()
