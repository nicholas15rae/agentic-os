# Queued phase — OpenStreetMap stack + Instagram API ("Gabagool" integrations)

**Status: BUILT (Nov 18 2026). See `HANDOFF.md` §11 for what shipped and the manual checks.** The original brief follows.

~~QUEUED. Don't start this until the in-flight builds on `feat/command-center` have landed.~~
Those builds are Phase 2 voice reflexes, the memmap `GabagoulBadge`, reminders/os-alarm, the Spotify overhaul and any other
open instance. Start gate: `git status` is clean or committed, `npm run typecheck`, `npx vitest run` and
`cargo test --lib` pass, and nobody else is editing `envfile.rs`, `IntegrationSettings.tsx`, `orchestrator/*` or
`tauri.conf.json`. If the gate isn't met, stop and say so; don't build on a half-finished tree.

**Read `HANDOFF.md` top to bottom first.** Its §8 guardrails apply. Don't break §6–§9 (routing, Spotify, Gmail,
Gabagool cues, mic hard-stop, voice roster, voice reflexes).

---

## 0. Build on what exists (extend it; don't make a second copy)

| Already built | Where | This phase does |
|---|---|---|
| `.env`-first credential loader + key statuses | `src-tauri/src/commands/envfile.rs` (`ENV_FOR`, `OTHER_SECRET_ENV`, `env_or_file`, `key_statuses`) | Register the Instagram keys here. Tokens stay in Rust/Python and never reach the webview. |
| Integrations panel | `src/sections/settings/IntegrationSettings.tsx` | Add OSM + Instagram rows driven by live backend status. |
| Tony's tools / planner | `src/features/orchestrator/plan.ts`, `execute.ts` (and how the Gmail/Spotify tools are registered) | Add the map + Instagram tools the same way. |
| Instagram **webhook** (verify + event log) | `server.py` → `GET/POST /webhook/instagram`. Token in `.env` as `INSTAGRAM_VERIFY_TOKEN`; events go to `data/instagram/webhook-events.jsonl` (gitignored). `ZeroTrustMiddleware` lets tunnelled (ngrok) traffic reach only `/webhook/*`. | Reuse it. Feed new comment events to `instagram_manage_comments`. If `INSTAGRAM_APP_SECRET` is set, the POST already checks `X-Hub-Signature-256`. **Don't loosen the tunnel guard.** |
| Webview CSP | `src-tauri/tauri.conf.json` → `app.security.csp` | Add OpenFreeMap tile/style/glyph hosts to `connect-src`/`img-src`, plus `worker-src blob:` for MapLibre. Nominatim/OSRM/Instagram calls go through the backend, so they need no CSP entry. |

---

## 1. Decisions already made (don't ask again)

- **Display name:** use **Gabagool** where applicable: API `User-Agent`, OAuth/app labels, UI headers. Don't rename
  existing files or identifiers (e.g. `GabagoulBadge.tsx`, `gaba.ts`).
- **Google Maps is on hold.** Put mapping and routing behind a `MapProvider` interface (geocode, reverse, route, and
  deep-link URL) so Google Maps can be dropped back in later without touching Tony's tools or the UI. Ship one
  implementation now: `osm`.
- **Zero cost.** No API keys or cards for maps.

## 2. Task 1 — OpenStreetMap stack

1. **Map UI (React/TS):** use **MapLibre GL JS** with OpenFreeMap vector tiles, style
   `https://tiles.openfreemap.org/styles/liberty`.
   - Interactive pins for destinations. Draw the road-following GeoJSON `LineString` returned by the backend.
   - An **"Open in Maps"** button linking to `https://www.google.com/maps/dir/?api=1&destination=LAT,LNG`. Open it in
     the system browser through Tauri's opener, not `window.open`, so it hands off to the phone/Maps app.
2. **Geocoding (Nominatim):** forward via `https://nominatim.openstreetmap.org/search` and reverse via `/reverse`.
   - `User-Agent: Gabagool-CommandCenter/1.0` (backend-side; a webview can't set it). Enforce **≤1 request/second**
     with a global limiter and a local cache keyed by the normalised query. Nominatim's usage policy forbids
     autocomplete-as-you-type, so geocode only on submit.
3. **Routing/ETA (OSRM):**
   `https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson&steps=true`
   (note: **lon,lat** order).
   - Return distance, duration, turn-by-turn steps and the GeoJSON geometry to both Tony (voice/chat) and the map panel.
   - Public OSRM has **no live traffic**. Tony must say ETAs are baseline driving estimates until a traffic-aware
     provider is added. "Plot my route for today's jobs" means multiple waypoints (`{a};{b};{c}`). Check where
     "today's jobs" come from (reminders/scheduler/kanban) before inventing a source.
   - The public demo server is for light use. Cache recent routes and don't poll.

## 3. Task 2 — Instagram API with Instagram Login

Base: `https://graph.instagram.com/v26.0/`. Confirm v26.0 is current when you build it; if not, use the current
version and say so.

1. **Credentials:** add `INSTAGRAM_ACCESS_TOKEN` (required) and optional `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`
   to `.env.example` and the credential loader (`envfile.rs`, and `OTHER_SECRET_ENV` for the secrets). They must never
   reach the React frontend; the UI sees statuses only. `INSTAGRAM_VERIFY_TOKEN` already exists for the webhook.
   - Health check on startup and on refresh: `GET /me?fields=user_id,username,followers_count,media_count`.
   - Token refresh helper for the long-lived 60-day token:
     `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`. Only valid
     once the token is ≥24 h old and unexpired. Refresh well before expiry and persist the new token the same way other
     refreshed tokens are stored (see Spotify).
2. **Tony's tools:**
   - `instagram_get_profile`: username, followers, media count.
   - `instagram_list_media`: recent posts/Reels plus basic media insights.
   - `instagram_manage_comments`: read comments and reply (`POST /{comment_id}/replies`). Needs
     `instagram_business_manage_comments`.
   - `instagram_publish_post`: two-step container flow, `POST /{user_id}/media` → `POST /{user_id}/media_publish`.
     **Hard confirmation gate before anything goes live.** Tony shows the caption and media and waits for an explicit
     yes. The media must be at a public URL. For Reels/video, poll the container's `status_code` until `FINISHED`
     before publishing.

## 4. Task 3 — UI sync and verification

- OSM and Instagram both appear in the Integrations panel with **live** backend credential/health status. There
  must be no stale "disconnected" state after credentials load; re-query status when keys change, as the
  `envfile.rs` key-status path already allows.
- Tests: the limiter and cache, OSRM response → tool answer formatting, the `MapProvider` contract, the Instagram
  status mapping, and the publish gate (no publish call without confirmation). Mock all network calls.

## 5. Deliverables (put them in the final report and add a `HANDOFF.md` section)

1. The exact `.env` variables the user must fill in.
2. Every new npm, Python or Rust package (expected at least `maplibre-gl`).
3. A verification checklist: an OSM route query through Tony ("How long to get to <address>?" → ETA with the
   no-traffic note, plus the route drawn on the map and "Open in Maps" working), and an Instagram `/me` pull through
   Tony.
