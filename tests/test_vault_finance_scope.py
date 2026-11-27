"""Vault search scope: an unscoped search never returns finance records (receipts, invoices,
cheques, income) unless the caller asks with include_finance — agent context (the Librarian's
vault matches) uses the unscoped search, Nic's Vault page passes include_finance.

Every test runs against a temp cc.db, never the real data/command-center store.
Run with: python3 tests/run_all.py  (or: python3 tests/test_vault_finance_scope.py)
"""
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import GatewayCase  # noqa: E402

import command_center_api as cc  # noqa: E402

ROWS = [
    ("receipts", {"vendor": "Home Depot", "category": "deck job lumber", "total": 118.40, "hst": 13.62}),
    ("invoices", {"number": "INV-7", "client": "Patel", "items": "deck job", "total": 2400}),
    ("checks", {"payer": "Patel", "amount": 1200, "memo": "deck job"}),
    ("notes", {"title": "deck job brainstorm", "rawText": "stain colour and railing ideas for the deck job"}),
    ("projects", {"client": "Patel", "job": "deck job", "status": "estimate follow-up"}),
]


class VaultFinanceScope(GatewayCase):
    @classmethod
    def setUpClass(cls):
        # Lexical search only: never reach (and JIT-load a model on) the real local LLM server.
        cls._embed = cc.embed

        def no_embed(*_a, **_k):
            raise RuntimeError("embeddings disabled in tests")

        cc.embed = no_embed
        super().setUpClass()
        for coll, data in ROWS:
            s, d = cls.h.api("POST", f"/api/cc/c/{coll}", data)
            assert s == 200, d
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        cc.embed = cls._embed

    def search(self, query):
        s, d = self.api("GET", f"/api/cc/vault/search?{query}")
        self.assertEqual(s, 200, d)
        return {r["collection"] for r in d["results"]}

    def test_unscoped_search_leaves_finance_out(self):
        got = self.search("q=deck%20job&collections=&k=20")
        self.assertTrue(got, "non-finance matches expected")
        self.assertFalse(got & cc.FINANCE_COLLECTIONS, got)

    def test_unknown_collections_fall_back_to_the_safe_default(self):
        got = self.search("q=deck%20job&collections=bogus,nope&k=20")
        self.assertFalse(got & cc.FINANCE_COLLECTIONS, got)

    def test_include_finance_and_named_collections_still_work(self):
        self.assertTrue(self.search("q=deck%20job&k=20&include_finance=true") & {"receipts", "invoices", "checks"})
        self.assertEqual(self.search("q=deck%20job&collections=receipts&k=20"), {"receipts"})

    def test_direct_call_defaults_to_safe(self):
        res = cc.vault_search("deck job", None, 20)
        self.assertFalse({r["collection"] for r in res["results"]} & cc.FINANCE_COLLECTIONS)


if __name__ == "__main__":
    unittest.main()
