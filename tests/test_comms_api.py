"""Comms gateway routes (os_api.py /api/comms/*): the Instant Send trust rules.

Comms step 1 (build plan Sections 8-10, decision 5 default):
- /send: only `origin: "ui-typed"` (typed by hand in the Chat box) to an EXACTLY trusted contact
  skips the confirmation card; voice / Tony / agent / UI-card / missing origins get 428 unless
  `confirmed: true`. A substring of a trusted number is not trusted.
- /contacts: `trusted: true` needs `confirmed: true` (428 otherwise), is refused for Instagram,
  Messenger and RCS (400), and every trust change is audit-logged.

Every test runs against a temp cc.db and a temp audit log.

Run with: python -m pytest tests/test_comms_api.py -q -p no:cacheprovider
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import IsolatedCC  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import os_api  # noqa: E402

TRUSTED = "+1 (416) 555-1234"  # stored key: 4165551234


class CommsTrustCase(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        self.addCleanup(self.iso.__exit__, None, None, None)
        self.audit = Path(tempfile.mkdtemp(prefix="agentic-os-audit-")) / "audit" / "audit.log"
        p = mock.patch.object(os_api, "AUDIT_FILE", self.audit)
        p.start()
        self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(os_api.comms_router)
        self.c = TestClient(app)

    # helpers
    def trust(self, address=TRUSTED, **extra):
        return self.c.post("/api/comms/contacts", json={"address": address, "name": "Mom", "trusted": True, "confirmed": True, **extra})

    def send(self, address=TRUSTED, **extra):
        return self.c.post("/api/comms/send", json={"address": address, "contact": "Mom", "body": "on my way", "channel": "sms", **extra})

    def audit_lines(self):
        if not self.audit.exists():
            return []
        return [json.loads(l) for l in self.audit.read_text(encoding="utf-8").splitlines() if l.strip()]

    def outbox(self):
        return self.iso.sql("SELECT * FROM comms_outbox")

    # /contacts
    def test_trust_without_confirmation_is_refused(self):
        r = self.c.post("/api/comms/contacts", json={"address": TRUSTED, "name": "Mom", "trusted": True})
        self.assertEqual(r.status_code, 428, r.text)
        self.assertEqual(self.iso.sql("SELECT * FROM comms_contacts"), [])
        # A truthy non-boolean isn't an explicit confirmation either.
        r = self.c.post("/api/comms/contacts", json={"address": TRUSTED, "trusted": True, "confirmed": "yes"})
        self.assertEqual(r.status_code, 428, r.text)
        self.assertEqual(self.audit_lines(), [])

    def test_trust_with_confirmation_is_stored_and_audited(self):
        r = self.trust()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.iso.sql("SELECT address, trusted FROM comms_contacts"), [{"address": "4165551234", "trusted": 1}])
        lines = self.audit_lines()
        self.assertEqual([(l["action"], l["address"]) for l in lines], [("comms_trust_on", "4165551234")])
        self.assertTrue(lines[0]["timestamp"] and lines[0]["id"])
        # Re-trusting is not a change; turning it off needs no card but is logged too.
        self.trust()
        r = self.c.post("/api/comms/contacts", json={"address": TRUSTED, "trusted": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.iso.sql("SELECT trusted FROM comms_contacts"), [{"trusted": 0}])
        self.assertEqual([l["action"] for l in self.audit_lines()], ["comms_trust_on", "comms_trust_off"])

    def test_read_only_channels_can_never_be_trusted(self):
        for ch in ("instagram", "messenger", "rcs", "Instagram"):
            r = self.trust(address="sam.r", channel=ch)
            self.assertEqual(r.status_code, 400, f"{ch}: {r.text}")
        self.assertEqual(self.iso.sql("SELECT * FROM comms_contacts WHERE trusted=1"), [])

    def test_empty_address_is_refused(self):
        self.assertEqual(self.trust(address="  ").status_code, 400)
        self.assertEqual(self.iso.sql("SELECT * FROM comms_contacts"), [])

    # /send
    def test_hand_typed_reply_to_a_trusted_contact_skips_the_card(self):
        self.trust()
        for origin in ("ui-typed", "ui_typed", "UI-Typed"):
            r = self.send(address="416-555-1234", origin=origin)
            self.assertEqual(r.status_code, 200, f"{origin}: {r.text}")
        self.assertEqual(len(self.outbox()), 3)

    def test_trusted_contact_with_a_voice_tony_or_agent_origin_still_needs_the_card(self):
        self.trust()
        for origin in ("voice", "tony", "agent", "ui-card", None, ""):
            extra = {} if origin is None else {"origin": origin}
            r = self.send(**extra)
            self.assertEqual(r.status_code, 428, f"{origin!r}: {r.text}")
        self.assertEqual(self.outbox(), [])
        # The card's yes still sends.
        r = self.send(origin="voice", confirmed=True)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.outbox()), 1)

    def test_a_substring_of_a_trusted_number_is_not_trusted(self):
        self.trust()
        for address in ("1234", "555-1234", "5551234", "41655512"):
            r = self.send(address=address, origin="ui-typed")
            self.assertEqual(r.status_code, 428, f"{address}: {r.text}")
        # A different number that merely contains the trusted digits isn't either.
        r = self.send(address="4165551234@s.whatsapp.net", origin="ui-typed")
        self.assertEqual(r.status_code, 428, r.text)
        self.assertEqual(self.outbox(), [])

    def test_untrusted_contact_needs_the_card_even_when_hand_typed(self):
        r = self.send(address="6475550000", origin="ui-typed")
        self.assertEqual(r.status_code, 428, r.text)
        r = self.send(address="6475550000", origin="ui-typed", confirmed=True)
        self.assertEqual(r.status_code, 200, r.text)

    def test_instant_send_never_applies_to_read_only_channels(self):
        self.trust()
        for ch in ("instagram", "messenger", "rcs"):
            r = self.send(origin="ui-typed", channel=ch)
            self.assertEqual(r.status_code, 428, f"{ch}: {r.text}")
        self.assertEqual(self.outbox(), [])

    def test_calls_always_need_the_card(self):
        self.trust()
        r = self.c.post("/api/comms/call", json={"address": TRUSTED, "origin": "ui-typed"})
        self.assertEqual(r.status_code, 428, r.text)
        r = self.c.post("/api/comms/call", json={"address": TRUSTED, "confirmed": True})
        self.assertEqual(r.status_code, 200, r.text)


if __name__ == "__main__":
    unittest.main()
