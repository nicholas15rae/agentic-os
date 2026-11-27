"""Task mirror (/api/tasks), the volatile phone progress map (_progress) and the comms
WebSocket broadcast's handling of dead clients.

Run with: python3 tests/run_all.py  (or: python3 tests/test_task_mirror.py)
"""
import asyncio
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import GatewayCase  # noqa: E402

import os_api  # noqa: E402


def envelope(task_id="t-1", status="coding", **extra):
    return {
        "task_id": task_id, "created_at": 1.0, "status": status, "current_owner": "coder",
        "iteration_count": 1, "max_iterations": 3, "raw_intent": {"text": "status card", "timestamp": 1.0},
        "handoff_log": [{"timestamp": 1.0, "from_agent": "prompter", "to_agent": "coder", "summary_payload": "brief ready"}],
        **extra,
    }


class TaskMirrorTests(GatewayCase):
    def setUp(self):
        os_api._ensure_schema()
        self.iso.sql("DELETE FROM task_mirror")

    def test_round_trip_and_active_filter(self):
        s, d = self.api("PUT", "/api/tasks/t-1", envelope("t-1", "coding"))
        self.assertEqual(s, 200, d)
        self.api("PUT", "/api/tasks/t-2", envelope("t-2", "review_ready", current_owner="staging"))
        self.api("PUT", "/api/tasks/t-3", envelope("t-3", "failed"))
        s, d = self.api("GET", "/api/tasks/t-1")
        self.assertEqual(s, 200, d)
        self.assertEqual(d["current_owner"], "coder")
        self.assertEqual(d["handoff_log"][0]["to_agent"], "coder")
        self.assertIn("updated_at", d)
        s, d = self.api("GET", "/api/tasks?active=1")
        self.assertEqual([i["task_id"] for i in d["items"]], ["t-1"])
        s, d = self.api("GET", "/api/tasks")
        self.assertEqual(sorted(i["task_id"] for i in d["items"]), ["t-1", "t-2", "t-3"])
        # An update replaces the snapshot.
        self.api("PUT", "/api/tasks/t-1", envelope("t-1", "review_ready", current_owner="staging"))
        self.assertEqual(self.api("GET", "/api/tasks/t-1")[1]["status"], "review_ready")
        self.assertEqual(self.api("GET", "/api/tasks?active=1")[1]["items"], [])

    def test_16kb_cap(self):
        s, d = self.api("PUT", "/api/tasks/big", envelope("big", librarian_notes="x" * (16 * 1024)))
        self.assertEqual(s, 413, d)
        self.assertEqual(self.api("GET", "/api/tasks/big")[0], 404)
        s, d = self.api("PUT", "/api/tasks/fits", envelope("fits", librarian_notes="x" * (15 * 1024)))
        self.assertEqual(s, 200, d)

    def test_validation(self):
        self.assertEqual(self.api("PUT", "/api/tasks/t-9", envelope("other"))[0], 400)
        self.assertEqual(self.api("PUT", "/api/tasks/t-9", envelope("t-9", "done"))[0], 400)
        self.assertIn(self.api("PUT", "/api/tasks/..%2Fx", envelope("..%2Fx"))[0], (400, 404))
        self.assertEqual(self.api("GET", "/api/tasks/missing")[0], 404)

    def test_put_is_localhost_only(self):
        from types import SimpleNamespace
        from fastapi import HTTPException
        for host, headers in (("100.64.0.9", {}), ("127.0.0.1", {"x-forwarded-for": "8.8.8.8"})):
            req = SimpleNamespace(client=SimpleNamespace(host=host), headers=headers)
            with self.assertRaises(HTTPException) as ctx:
                os_api.task_mirror_put("t-x", req, envelope("t-x"))
            self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(self.api("GET", "/api/tasks/t-x")[0], 404)

    def test_mirror_is_bounded(self):
        keep = os_api.TASK_MIRROR_KEEP
        os_api.TASK_MIRROR_KEEP = 3
        try:
            for i in range(5):
                self.api("PUT", f"/api/tasks/k-{i}", envelope(f"k-{i}", "queued"))
            ids = [r["task_id"] for r in self.iso.sql("SELECT task_id FROM task_mirror ORDER BY updated_at")]
            self.assertEqual(ids, ["k-2", "k-3", "k-4"])
        finally:
            os_api.TASK_MIRROR_KEEP = keep


    def test_envelope_updated_at_ms_is_kept_and_gateway_time_is_mirrored_at(self):
        # Regression: the gateway used to overwrite the envelope's ms updated_at with its own
        # seconds, so the phone said the last update was ~500,000 hours ago.
        ms = 1_795_000_000_123
        s, d = self.api("PUT", "/api/tasks/t-ms", envelope("t-ms", "coding", updated_at=ms))
        self.assertEqual(s, 200, d)
        self.assertIn("mirrored_at", d)
        got = self.api("GET", "/api/tasks/t-ms")[1]
        self.assertEqual(got["updated_at"], ms)
        self.assertLess(abs(got["mirrored_at"] - time.time()), 60)  # seconds
        item = next(i for i in self.api("GET", "/api/tasks?active=1")[1]["items"] if i["task_id"] == "t-ms")
        self.assertEqual(item["updated_at"], ms)
        # A snapshot without updated_at is served in ms too (never gateway seconds).
        self.api("PUT", "/api/tasks/t-nots", envelope("t-nots", "queued"))
        self.assertGreater(self.api("GET", "/api/tasks/t-nots")[1]["updated_at"], 1e12)


class WsAuthTests(unittest.TestCase):
    """Regression: a tunnelled WebSocket (loopback peer + forwarding headers) must not be trusted."""

    def _ws(self, host, headers=None, token=""):
        from types import SimpleNamespace
        return SimpleNamespace(client=SimpleNamespace(host=host), headers=headers or {}, query_params={"token": token} if token else {})

    def test_proxied_loopback_needs_the_token(self):
        import tempfile
        saved = os_api.TOKEN_FILE
        with tempfile.TemporaryDirectory() as d:
            tok = Path(d) / "gateway.token"
            tok.write_text("s3cret-token", encoding="utf-8")
            os_api.TOKEN_FILE = tok
            try:
                self.assertTrue(os_api._ws_authorized(self._ws("127.0.0.1")))
                for h in ("x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host"):
                    self.assertFalse(os_api._ws_authorized(self._ws("127.0.0.1", {h: "8.8.8.8"})), h)
                self.assertTrue(os_api._ws_authorized(self._ws("127.0.0.1", {"x-forwarded-for": "8.8.8.8"}, token="s3cret-token")))
                self.assertFalse(os_api._ws_authorized(self._ws("100.64.0.9")))
            finally:
                os_api.TOKEN_FILE = saved


class ProgressTests(unittest.TestCase):
    def setUp(self):
        os_api._progress.clear()

    def tearDown(self):
        os_api._progress.clear()

    def test_task_fields_accepted(self):
        os_api.progress_put({"taskId": "t-1", "ideaId": "i-1", "status": "coding", "owner": "coder", "iteration": 2, "pct": 60})
        items = os_api.progress_get()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["taskId"], "t-1")
        self.assertIn("t-1", os_api._progress)  # keyed by taskId first

    def test_failed_entries_are_evicted(self):
        os_api.progress_put({"taskId": "f", "status": "failed", "pct": 40})
        self.assertEqual(len(os_api.progress_get()["items"]), 1)  # the phone sees it once
        os_api._progress["f"]["at"] = time.time() - os_api.PROGRESS_FAILED_TTL - 1
        self.assertEqual(os_api.progress_get()["items"], [])

    def test_anything_older_than_30_min_is_evicted_regardless_of_pct(self):
        os_api.progress_put({"ideaId": "stuck", "pct": 35})
        os_api.progress_put({"ideaId": "fresh", "pct": 35})
        os_api._progress["stuck"]["at"] = time.time() - os_api.PROGRESS_MAX_AGE - 1
        self.assertEqual([i["ideaId"] for i in os_api.progress_get()["items"]], ["fresh"])

    def test_finished_entries_still_drop_after_10_min(self):
        os_api.progress_put({"ideaId": "done", "pct": 100})
        os_api._progress["done"]["at"] = time.time() - os_api.PROGRESS_DONE_TTL - 1
        self.assertEqual(os_api.progress_get()["items"], [])

    def test_requires_an_id_and_bad_pct_is_harmless(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            os_api.progress_put({"pct": 1})
        os_api.progress_put({"ideaId": "odd", "pct": "n/a"})
        self.assertEqual(len(os_api.progress_get()["items"]), 1)


class _FakeWs:
    def __init__(self, fail=False):
        self.fail = fail
        self.sent = []

    async def send_text(self, data):
        if self.fail:
            raise RuntimeError("socket closed")
        self.sent.append(data)


class BroadcastTests(unittest.TestCase):
    def setUp(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.saved = (set(os_api._ws_clients), os_api._loop)
        os_api._ws_clients.clear()
        os_api._loop = self.loop

    def tearDown(self):
        os_api._ws_clients.clear()
        os_api._ws_clients.update(self.saved[0])
        os_api._loop = self.saved[1]
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        self.loop.close()

    def _settle(self):
        asyncio.run_coroutine_threadsafe(asyncio.sleep(0.05), self.loop).result(timeout=5)

    def test_dead_client_is_discarded_and_others_still_receive(self):
        good, dead = _FakeWs(), _FakeWs(fail=True)
        os_api._ws_clients.update({good, dead})
        os_api._broadcast({"type": "task", "task_id": "t-1"})
        self._settle()
        self.assertNotIn(dead, os_api._ws_clients)
        self.assertIn(good, os_api._ws_clients)
        os_api._broadcast({"type": "task", "task_id": "t-2"})
        self._settle()
        self.assertEqual(len(good.sent), 2)

    def test_closed_loop_is_a_no_op(self):
        good = _FakeWs()
        os_api._ws_clients.add(good)
        closed = asyncio.new_event_loop()
        closed.close()
        os_api._loop = closed
        os_api._broadcast({"type": "pipeline"})  # must not raise
        self.assertEqual(good.sent, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
