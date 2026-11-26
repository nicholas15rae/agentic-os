"""A2: the phone's approved confirmation card (os_queue kind `action`) and gateway Tony's
desktop-only line for Gmail / Google Calendar.

`action` carries {tool, args, planId, approvedAt} for exactly two carded tools
(calendar.create_event, gmail.create_draft), only their own argument names, and lives five
minutes. The desktop runs it through the same approved-only Rust path as its own card; gateway
Tony never takes one.

Pure checks against the validators (no gateway, no model, no network), plus one POST through an
in-process gateway on a temp cc.db.

Run with: python -m pytest tests/test_os_action_inbox.py -q -p no:cacheprovider
"""
import sys
import unittest
from pathlib import Path

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import GatewayCase  # noqa: E402

import gateway_tony as gt  # noqa: E402
import os_api  # noqa: E402

CAL = {"tool": "calendar.create_event", "args": {"title": "Netflix day player", "date": "2026-11-28", "startTime": "06:30", "location": "Pinewood Studios"}, "planId": "4b1f-9c", "approvedAt": "2026-11-26T15:00:00.000Z"}
DRAFT = {"tool": "gmail.create_draft", "args": {"to": "sam@agency.ca", "subject": "Avail", "body": "I'm free Friday."}, "planId": "p_2", "approvedAt": "2026-11-26T15:00:00Z"}


def refused(payload) -> int:
    try:
        os_api._validate_action_payload(payload)
    except HTTPException as e:
        return e.status_code
    return 0


class ActionPayloadTests(unittest.TestCase):
    def test_the_two_carded_tools_pass(self):
        for p in (CAL, DRAFT, {**CAL, "args": {"title": "Hold", "allDay": True, "date": "2026-12-03"}}):
            self.assertEqual(refused(p), 0, p)

    def test_everything_else_is_refused(self):
        big = {**CAL, "args": {**CAL["args"], "description": "x" * (os_api._ACTION_ARGS_MAX + 1)}}
        cases = [
            ({**CAL, "tool": "gmail.send"}, 400),
            ({**CAL, "tool": "whatsapp.send_message"}, 400),
            ({**CAL, "tool": "calendar.update_event"}, 400),
            ({**CAL, "args": {}}, 400),
            ({**CAL, "args": "title"}, 400),
            ({**CAL, "args": {**CAL["args"], "guests": "x@y.com"}}, 400),
            ({**CAL, "args": {**CAL["args"], "sendInvites": True}}, 400),
            ({**CAL, "args": {**CAL["args"], "calendarId": "other"}}, 400),
            ({**CAL, "args": {"title": "x", "allDay": "yes"}}, 400),
            ({**CAL, "args": {"title": 5}}, 400),
            ({**DRAFT, "args": {**DRAFT["args"], "cc": "boss@x.com"}}, 400),
            ({k: v for k, v in CAL.items() if k != "approvedAt"}, 400),
            ({**CAL, "approvedAt": " "}, 400),
            ({**CAL, "planId": "../x"}, 400),
            ({**CAL, "planId": "p" * 65}, 400),
            ({**CAL, "command": "rm -rf"}, 400),
            (big, 413),
        ]
        for p, code in cases:
            self.assertEqual(refused(p), code, p)

    def test_action_is_a_short_lived_queue_kind_gateway_tony_never_takes(self):
        self.assertIn("action", os_api._QUEUE_KINDS)
        self.assertEqual(os_api.QUEUE_TTL["action"], 300.0)
        self.assertFalse(gt.eligible("action", CAL))
        self.assertFalse(gt.eligible("action", {"text": "add it to my calendar"}))


class DesktopToolsLineTests(unittest.TestCase):
    def test_mail_and_calendar_asks_need_the_desktop(self):
        for t in (
            "check my Gmail for what I got booked for",
            "any e-mails from Sam?",
            "did I get any mail today",
            "any call sheets in my inbox?",
            "what’s on my calendar tomorrow",
            "what's on today",
            "read me my agenda",
        ):
            self.assertTrue(gt.needs_desktop_tools(t), t)
        for t in ("hey tony, what's up", "tell me a joke", "what's the weather", "help me plan a shoot", "", None):
            self.assertFalse(gt.needs_desktop_tools(t), t)

    def test_the_line_is_in_persona_and_claims_nothing(self):
        line = gt.DESKTOP_TOOLS_LINE
        self.assertTrue(line.startswith("Nic,"))
        self.assertIn("desktop app", line)
        for word in ("checked", "sent", "added", "queued", "Jarvis", "Hermes"):
            self.assertNotIn(word, line)


class ActionPostTests(GatewayCase):
    def test_post_accepts_an_approved_action_and_refuses_a_bad_one(self):
        s, d = self.api("POST", "/api/os/inbox", {"kind": "action", "payload": CAL})
        self.assertEqual((s, d.get("status")), (200, "pending"), d)
        row = self.iso.sql("SELECT kind, status FROM os_queue WHERE id=?", (d["id"],))[0]
        self.assertEqual((row["kind"], row["status"]), ("action", "pending"))
        s, d = self.api("POST", "/api/os/inbox", {"kind": "action", "payload": {**CAL, "tool": "gmail.send"}})
        self.assertEqual(s, 400, d)
        self.assertEqual(self.iso.sql("SELECT COUNT(*) n FROM os_queue WHERE kind='action'")[0]["n"], 1)


if __name__ == "__main__":
    unittest.main()
