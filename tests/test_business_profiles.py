"""Gateway business profiles (Settings -> Business): one validated kv row shared by desktop and
phone, never writable through the generic kv route, unknown fields and bad values refused.

Every test runs against a temp cc.db (command_center_api paths are redirected).

Run with: python3 tests/run_all.py  (or: python3 tests/test_business_profiles.py)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import IsolatedCC  # noqa: E402

from fastapi import HTTPException  # noqa: E402

import command_center_api as cc  # noqa: E402

LOGO = "0123456789abcdef0123456789abcdef"


def doc(**profiles):
    return {"version": 1, "legacyImported": True, "profiles": profiles}


class BusinessProfilesTests(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()

    def tearDown(self):
        self.iso.__exit__(None, None, None)

    def test_empty_until_first_save_then_round_trips(self):
        self.assertEqual(cc.get_business_profiles(), {"value": None})
        acting = {
            "name": "Nic Acting",
            "hstNumber": "123456782 RT0001",
            "hstConfirmed": True,
            "province": "ON",
            "taxRate": 13,
            "currency": "CAD",
            "logoFileId": LOGO,
            "invoiceStyle": "modern",
            "agencies": [
                {"id": "imperious", "name": "Imperious Inc.", "parentId": None, "commissionUnion": 15, "commissionNonUnion": 20},
                {"id": "ml_talent", "name": "ML Talent", "parentId": "imperious", "commissionUnion": None, "commissionNonUnion": 0},
            ],
        }
        contracting = {"name": "Nic Contracting", "contracting": {"subRateMode": "amount", "subRate": 450, "defaultWork": "subbed"}}
        out = cc.put_business_profiles({"value": doc(acting=acting, trades_contracting=contracting, personal={})})["value"]
        self.assertEqual(cc.get_business_profiles()["value"], out)
        self.assertEqual(out["profiles"]["acting"]["agencies"][1]["commissionUnion"], None)
        self.assertEqual(out["profiles"]["trades_contracting"]["contracting"]["subRate"], 450.0)
        # Defaults fill a sparse profile.
        p = out["profiles"]["personal"]
        self.assertEqual((p["province"], p["taxRate"], p["currency"], p["invoiceStyle"], p["hstConfirmed"], p["logoFileId"]), ("ON", 13.0, "CAD", "classic", False, ""))

    def test_confirmed_needs_a_number(self):
        out = cc.put_business_profiles({"value": doc(acting={"hstNumber": "  ", "hstConfirmed": True})})["value"]
        self.assertFalse(out["profiles"]["acting"]["hstConfirmed"])

    def test_bad_values_are_refused(self):
        bad = [
            doc(acting={"surprise": 1}),
            doc(**{"Bad-Id": {}}),
            doc(acting={"province": "XX"}),
            doc(acting={"taxRate": 99}),
            doc(acting={"taxRate": True}),
            doc(acting={"currency": "EUR"}),
            doc(acting={"logoFileId": "../../etc/passwd"}),
            doc(acting={"invoiceStyle": "comic"}),
            doc(acting={"name": "x" * 500}),
            doc(acting={"agencies": [{"id": "a1", "parentId": "nobody"}]}),
            doc(acting={"agencies": [{"id": "a1"}, {"id": "a1"}]}),
            doc(acting={"agencies": [{"id": "a1", "commissionUnion": 150}]}),
            doc(acting={"agencies": [{"id": "a1"}, {"id": "a2", "parentId": "a1"}, {"id": "a3", "parentId": "a2"}]}),
            doc(trades_contracting={"contracting": {"subRateMode": "percent", "subRate": 140}}),
            doc(trades_contracting={"contracting": {"defaultWork": "maybe"}}),
            {"profiles": {}, "extra": 1},
        ]
        for d in bad:
            with self.subTest(d=d), self.assertRaises(HTTPException) as e:
                cc.put_business_profiles({"value": d})
            self.assertEqual(e.exception.status_code, 400)
        self.assertIsNone(cc.get_business_profiles()["value"], "nothing was stored")

    def test_generic_kv_cannot_bypass_validation(self):
        with self.assertRaises(HTTPException) as e:
            cc.put_kv("business.profiles", {"value": {"profiles": {"acting": {"anything": 1}}}})
        self.assertEqual(e.exception.status_code, 400)
        # Reading through kv still works (same row).
        cc.put_business_profiles({"value": doc(acting={"name": "A"})})
        self.assertEqual(cc.get_kv("business.profiles")["value"]["profiles"]["acting"]["name"], "A")


if __name__ == "__main__":
    unittest.main(verbosity=2)
