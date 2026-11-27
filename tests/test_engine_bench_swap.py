"""engine/bench_swap.py pure parts: Bionic instance parsing, and the lease holder counts as a
maintenance window for the gateway (so gateway Tony never calls Bionic while Tony is unloaded)."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import command_center_api as cc  # noqa: E402
from engine import bench_swap as bs  # noqa: E402


class SwapTests(unittest.TestCase):
    def test_instances(self):
        fake = {"models": [{"key": "qwen/qwen3.5-9b", "loaded_instances": [{"id": "qwen/qwen3.5-9b", "config": {"parallel": 2}}]},
                           {"key": "other", "loaded_instances": []}]}
        with mock.patch.object(bs, "_json", return_value=fake):
            self.assertEqual(bs.bionic_instances("http://x"), [{"key": "qwen/qwen3.5-9b", "id": "qwen/qwen3.5-9b", "config": {"parallel": 2}}])

    def test_holder_is_a_maintenance_window(self):
        self.assertTrue(cc._is_maintenance(bs.HOLDER))

    def test_lease_body(self):
        with mock.patch.object(bs, "_json", side_effect=lambda m, u, b=None, timeout=30: b) as j:
            on = bs.set_lease(True)
            off = bs.set_lease(False)
        self.assertEqual((on["busy"], on["holder"]), (True, bs.HOLDER))
        self.assertGreater(on["until"], 10 ** 12)  # epoch ms, under the gateway's 15 min cap
        self.assertEqual(off, {"busy": False, "holder": "", "until": None})
        self.assertEqual(j.call_count, 2)


if __name__ == "__main__":
    unittest.main()
