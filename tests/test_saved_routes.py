"""Maps saved routes: the "routes" shared-store collection. It syncs like every other collection
(create / list / since / patch / soft delete), the stored shape is checked (a bad pin never reaches a
nav intent), and it is never part of the AI search index: no vault row, no vault search hit (scoped,
unscoped or include_finance), no reindex.

Every test runs against a temp cc.db (command_center_api paths are redirected), never the real
data/command-center store. Embeddings are disabled, so nothing reaches a local model server.
Run with: python -m pytest tests/test_saved_routes.py -q
"""
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import GatewayCase  # noqa: E402

import command_center_api as cc  # noqa: E402
from fastapi import HTTPException  # noqa: E402

# Made-up places (no real addresses).
HOME = {"lat": 43.6532, "lng": -79.3832, "label": "Test Home"}
STUDIO = {"lat": 43.6426, "lng": -79.3871, "label": "Audition studio, 100 Test Street"}
STOP = {"lat": 43.66, "lng": -79.39, "label": "Coffee"}
WORD = "zanzibarquay"  # a token only these rows carry, so search hits are unambiguous


def route(**over):
    r = {"name": f"To the {WORD} studio", "origin": "home", "destination": {**STUDIO, "label": f"{WORD} studio"}, "stops": [STOP]}
    r.update(over)
    return r


class SavedRoutesApi(GatewayCase):
    @classmethod
    def setUpClass(cls):
        cls._embed = cc.embed

        def no_embed(*_a, **_k):
            raise RuntimeError("embeddings disabled in tests")

        cc.embed = no_embed
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        cc.embed = cls._embed

    def create(self, body):
        return self.api("POST", "/api/cc/c/routes", body)

    def vault_rows(self, collection="routes"):
        return self.iso.sql("SELECT * FROM vault WHERE collection=?", (collection,))

    # ── synced CRUD ─────────────────────────────────────────────────────────

    def test_create_list_patch_delete_round_trip(self):
        s, made = self.create({**route(), "id": "r-trip"})
        self.assertEqual(s, 200, made)
        self.assertEqual(made["id"], "r-trip")
        self.assertEqual(made["origin"], "home")
        self.assertEqual(made["destination"]["lat"], STUDIO["lat"])
        self.assertEqual(made["stops"], [STOP])

        s, d = self.api("GET", "/api/cc/c/routes")
        self.assertEqual(s, 200, d)
        self.assertIn("r-trip", [i["id"] for i in d["items"]])

        s, d = self.api("PATCH", "/api/cc/c/routes/r-trip", {"pinned": True})
        self.assertEqual(s, 200, d)
        self.assertTrue(d["pinned"])
        self.assertEqual(d["name"], route()["name"], "a partial patch keeps the rest")
        self.assertEqual(d["stops"], [STOP])

        since = time.time() - 1
        s, d = self.api("DELETE", "/api/cc/c/routes/r-trip")
        self.assertEqual(s, 200, d)
        s, d = self.api("GET", "/api/cc/c/routes")
        self.assertNotIn("r-trip", [i["id"] for i in d["items"]])
        # The phone's next sync tick sees the removal.
        s, d = self.api("GET", f"/api/cc/c/routes?since={since}")
        gone = [i for i in d["items"] if i["id"] == "r-trip"]
        self.assertEqual(len(gone), 1)
        self.assertTrue(gone[0]["_deleted"])

    def test_place_origin_and_text_are_normalised(self):
        s, d = self.create(route(name="  Home ‮to​  set\n", origin={"lat": 43, "lng": -79, "label": "Here\x00now"}, stops=[]))
        self.assertEqual(s, 200, d)
        self.assertEqual(d["name"], "Home to set")
        self.assertEqual(d["origin"], {"lat": 43.0, "lng": -79.0, "label": "Here now"})
        self.assertEqual(d["stops"], [])

    def test_stops_default_to_empty_and_here_is_kept_for_use_time(self):
        body = route(origin="here")
        del body["stops"]
        s, d = self.create(body)
        self.assertEqual(s, 200, d)
        self.assertEqual((d["origin"], d["stops"]), ("here", []))

    # ── shape checks ────────────────────────────────────────────────────────

    def test_bad_routes_are_refused(self):
        bad = {
            "no name": route(name="   "),
            "name not text": route(name=7),
            "long name": route(name="x" * (cc.ROUTE_NAME_MAX + 1)),
            "unknown origin": route(origin="work"),
            "origin not a place": route(origin=[43, -79]),
            "lat out of range": route(destination={**STUDIO, "lat": 91}),
            "lng out of range": route(destination={**STUDIO, "lng": -180.5}),
            "lat as text": route(destination={**STUDIO, "lat": "43.6"}),
            "lat as bool": route(destination={**STUDIO, "lat": True}),
            "missing destination": {k: v for k, v in route().items() if k != "destination"},
            "extra place field": route(destination={**STUDIO, "address": "x"}),
            "too many stops": route(stops=[STOP] * (cc.ROUTE_STOPS_MAX + 1)),
            "stops not a list": route(stops=STOP),
            "bad stop": route(stops=[STOP, {"lat": 1}]),
            "pinned not bool": route(pinned="yes"),
            "unknown field": route(notes="free text"),
            "long label": route(destination={**STUDIO, "label": "y" * (cc.ROUTE_LABEL_MAX + 1)}),
        }
        before = self.iso.sql("SELECT COUNT(*) n FROM items WHERE collection='routes'")[0]["n"]
        for what, body in bad.items():
            with self.subTest(what):
                s, d = self.create(body)
                self.assertEqual(s, 400, (what, d))
        self.assertEqual(self.iso.sql("SELECT COUNT(*) n FROM items WHERE collection='routes'")[0]["n"], before, "nothing stored")

    def test_non_finite_coordinates_are_refused(self):
        for n in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(n):
                with self.assertRaises(HTTPException) as e:
                    cc._check_route(route(destination={**STUDIO, "lat": n}))
                self.assertEqual(e.exception.status_code, 400)

    def test_max_stops_is_allowed(self):
        s, d = self.create(route(stops=[STOP] * cc.ROUTE_STOPS_MAX))
        self.assertEqual(s, 200, d)

    def test_a_patch_that_breaks_the_route_is_refused_and_changes_nothing(self):
        s, made = self.create({**route(), "id": "r-keep"})
        self.assertEqual(s, 200, made)
        for patch in ({"destination": {"lat": 400, "lng": 0, "label": ""}}, {"name": ""}, {"stray": 1}, {"origin": "office"}):
            with self.subTest(patch=patch):
                s, d = self.api("PATCH", "/api/cc/c/routes/r-keep", patch)
                self.assertEqual(s, 400, d)
        row = self.iso.sql("SELECT data, updated FROM items WHERE id='r-keep'")[0]
        self.assertEqual(json.loads(row["data"]), {k: made[k] for k in ("name", "origin", "destination", "stops")})
        self.assertEqual(row["updated"], made["_updated"])

    def test_meta_fields_from_the_client_are_ignored(self):
        # useCollection's optimistic create sends id / _created / _updated: never a 400.
        s, d = self.create({**route(), "id": "r-meta", "_created": 1, "_updated": 1, "_deleted": False})
        self.assertEqual(s, 200, d)
        s, d = self.api("PATCH", "/api/cc/c/routes/r-meta", {"id": "other", "_updated": 5, "name": "Renamed"})
        self.assertEqual(s, 200, d)
        self.assertEqual((d["id"], d["name"]), ("r-meta", "Renamed"))

    def test_other_collections_keep_free_form_items(self):
        s, d = self.api("POST", "/api/cc/c/notes", {"title": "anything", "whatever": {"nested": [1, 2]}})
        self.assertEqual(s, 200, d)
        s, d = self.api("PATCH", f"/api/cc/c/notes/{d['id']}", {"stray": True})
        self.assertEqual(s, 200, d)

    # ── never in the AI search index ────────────────────────────────────────

    def test_routes_never_reach_the_vault(self):
        s, made = self.create({**route(), "id": "r-vault"})
        self.assertEqual(s, 200, made)
        self.api("PATCH", "/api/cc/c/routes/r-vault", {"name": f"{WORD} again"})
        self.assertEqual(self.vault_rows(), [])
        s, d = self.api("POST", "/api/cc/vault/reindex")
        self.assertEqual(s, 200, d)
        self.assertEqual(self.vault_rows(), [], "reindex never adds routes")
        self.api("DELETE", "/api/cc/c/routes/r-vault")
        self.assertEqual(self.vault_rows(), [])

    def test_vault_search_never_returns_routes(self):
        s, _ = self.create(route())
        self.assertEqual(s, 200)
        s, note = self.api("POST", "/api/cc/c/notes", {"title": f"{WORD} plan", "rawText": f"drive to the {WORD} studio"})
        self.assertEqual(s, 200, note)
        for query in (
            f"q={WORD}&collections=&k=50",
            f"q={WORD}&collections=routes&k=50",
            f"q={WORD}&collections=routes,notes&k=50",
            f"q={WORD}&k=50&include_finance=true",
        ):
            with self.subTest(query):
                s, d = self.api("GET", f"/api/cc/vault/search?{query}")
                self.assertEqual(s, 200, d)
                got = {r["collection"] for r in d["results"]}
                self.assertIn("notes", got, "the search itself works")
                self.assertNotIn("routes", got)

    def test_a_stray_vault_row_for_routes_is_still_never_returned(self):
        # As if an older gateway (or a later VAULT_FIELDS edit) had embedded one.
        s, made = self.create(route())
        self.assertEqual(s, 200, made)
        with cc._db_lock, cc.db() as c:
            c.execute(
                "INSERT INTO vault(item_id,collection,text,vector,model,updated) VALUES(?,?,?,?,?,?)",
                (made["id"], "routes", f"name: {WORD} studio route", None, None, time.time()),
            )
        try:
            for cols in (None, ["routes"]):
                with self.subTest(cols=cols):
                    res = cc.vault_search(WORD, cols, 50, include_finance=True)
                    self.assertNotIn("routes", {r["collection"] for r in res["results"]})
        finally:
            with cc._db_lock, cc.db() as c:
                c.execute("DELETE FROM vault WHERE item_id=?", (made["id"],))


class SavedRoutesConfig(unittest.TestCase):
    def test_routes_is_a_private_synced_collection(self):
        self.assertIn("routes", cc.COLLECTIONS)
        self.assertIn("routes", cc.PRIVATE_COLLECTIONS)
        self.assertNotIn("routes", cc.VAULT_FIELDS)
        self.assertFalse(cc.PRIVATE_COLLECTIONS & cc.FINANCE_COLLECTIONS)

    def test_client_mirrors_the_gateway(self):
        src = (Path(__file__).resolve().parents[1] / "command center" / "src" / "lib" / "cc-api.ts").read_text(encoding="utf-8")
        self.assertIn('| "routes"', src)
        self.assertIn('PRIVATE_COLLECTIONS: readonly Collection[] = ["routes"]', src)
        for name in ("ROUTE_NAME_MAX", "ROUTE_LABEL_MAX", "ROUTE_STOPS_MAX"):
            self.assertIn(f"export const {name} = {getattr(cc, name)};", src, name)


if __name__ == "__main__":
    unittest.main()
