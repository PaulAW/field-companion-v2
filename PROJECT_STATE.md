# Field Companion — Project State

This file is the single source of truth for design/planning sessions in Claude Chat
(a Claude Chat session cannot see Claude Code session history or local files). Keep
it current as work lands — update it whenever a sprint of work ships or the
architecture changes.

Last updated: 2026-08-18.

## Repos

| Repo | Path (local) | Remote | Role |
|---|---|---|---|
| Frontend (PWA) | `C:\Users\paulw\Projects\field-companion\` | `v2` → `https://github.com/PaulAW/field-companion-v2.git` | **Source of truth — this is what's deployed.** Push here triggers a GitHub Actions → Pages deploy automatically (~20s). |
| Frontend (stale mirror) | same folder, `origin` remote | `https://github.com/PaulAW/field-companion.git` | Do not use — behind `v2`. Never push here. |
| Backend (Worker) | `C:\Users\paulw\Projects\field-companion-worker\` | `origin` → `https://github.com/PaulAW/field-companion-worker.git` (private) | Cloudflare Worker: D1 CRUD API, Google Sign-In, MCP server. **Not a subfolder of the frontend repo.** **No auto-deploy workflow** — `git push` is backup only; going live requires running `wrangler deploy` (see Deploy note below). |

Current branch on both: `main`.
- Frontend `main` @ `fd8af16` — "chore: bump build/cache version to cover the last 4 plant-id.js deploys" (2026-08-18), build `v72/2026-08-18-a`.
- Backend `main` @ `4487419` — "feat: require plant/GPS link on task creation; add lat/lng/no_location to tasks" (2026-08-12). (Unchanged this session — all 2026-08-18 work was frontend-only.)

**Deploy note (backend):** the local `wrangler` CLI's Cloudflare OAuth token expires periodically and can't be refreshed non-interactively from a Claude Code session (`wrangler login` needs a real browser). If it's expired, the user's own terminal usually already has a working `CLOUDFLARE_API_TOKEN` env var that a sandboxed session doesn't inherit — have the user run `wrangler deploy` themselves rather than trying to fix auth in-session.

## Deployed URLs

| What | URL |
|---|---|
| Frontend (live PWA) | https://paulaw.github.io/field-companion-v2/ |
| Backend — D1 CRUD API + auth + MCP | https://field-companion-backend.paulwiner5.workers.dev |
| Backend — Claude API CORS proxy (Plant ID only, separate Worker) | https://field-companion-api.paulwiner5.workers.dev |

## D1 database (`field-companion-db`)

Schema lives in `field-companion-worker/schema.sql`. As of 2026-08-08, the MCP schema addition (zones, treatments, planting_orders/planting_order_items, oauth_clients/oauth_codes) has been applied to the remote database and zones seeded from `zones.json`.

| Table | Purpose | Notes |
|---|---|---|
| `users` | Single-user table, gated by `ALLOWED_EMAIL` env var | `id` is `INTEGER AUTOINCREMENT` |
| `sessions` | Bearer session tokens (30-day expiry) | Used by both the REST API and MCP OAuth token exchange |
| `observations` | Field log entries | `id` is `INTEGER AUTOINCREMENT` — **not** TEXT |
| `boundaries` | Zone/property polygon GeoJSON | `zone_id` is free-text (e.g. `"A"`), no FK |
| `tasks` | Seasonal checklist | Previously created ad-hoc by `index.js` on first request (self-migrating `CREATE TABLE IF NOT EXISTS`); now also declared in `schema.sql` |
| `zones` *(new)* | Zone metadata — previously **client-only** (`public/js/data/zones.json` + localStorage overrides), never synced to the backend | `PRIMARY KEY (user_id, id)`; `id` is the zone letter (A–H) |
| `treatments` *(new)* | Herbicide/invasive treatment log | `zone_id` FK → `zones`, `observation_id` FK → `observations` (INTEGER) |
| `planting_orders` / `planting_order_items` *(new)* | Planting order + line-item history | |
| `oauth_clients` / `oauth_codes` *(new)* | MCP OAuth 2.1 (dynamic client registration + PKCE authorization codes) | Powers the Claude.ai custom connector sign-in; issues the same session tokens as the REST API |

**Zones data note:** the frontend still reads zones from static `public/js/data/zones.json` (unchanged) — the new D1 `zones` table exists so the MCP server and future multi-user work have something to read/write. `field-companion-worker/seed-zones.sql` backfills the 8 existing zones from that JSON file for the current user.

## MCP server (Claude.ai custom connector)

Added 2026-08-07. Exposes 12 tools at `POST https://field-companion-backend.paulwiner5.workers.dev/mcp` (JSON-RPC 2.0, MCP Streamable HTTP transport): `get_zones`, `get_observations`, `create_observation`, `update_zone`, `get_tasks`, `create_task`, `update_task`, `delete_task` *(added 2026-08-11)*, `get_boundaries`, `get_treatments`, `create_treatment`, `get_planting_orders`.

Auth: OAuth 2.1 with dynamic client registration + PKCE, reusing the existing Google Sign-In + `ALLOWED_EMAIL` gate. Discovery at `/.well-known/oauth-authorization-server`. See `field-companion-worker/src/mcp.js`.

**Note:** a Claude Code session's tool list for this connector is fixed when it first connects — adding/deploying a new MCP tool does not make it discoverable mid-session (confirmed with `delete_task`: available on the server immediately after deploy, but not found via tool search until a fresh session). Expect a restart/reconnect to be needed after adding tools here.

**Deploy steps completed 2026-08-08:**
1. ✅ `wrangler d1 execute field-companion-db --remote --file=schema.sql` — ran successfully (23 queries, 25 rows written)
2. ✅ `wrangler d1 execute field-companion-db --remote --file=seed-zones.sql` — ran successfully (8 queries, 16 rows written)
3. ✅ `wrangler deploy` from `field-companion-worker/` — live at `field-companion-backend.paulwiner5.workers.dev`

**Deploy steps completed 2026-08-08 (cont'd):**
4. ✅ Google Cloud Console — added `https://field-companion-backend.paulwiner5.workers.dev` as an Authorized JavaScript origin on the `GOOGLE_CLIENT_ID` OAuth client
5. ✅ Claude.ai custom connector added at `https://field-companion-backend.paulwiner5.workers.dev/mcp`, signed in, and confirmed working (`get_zones` returned all 8 zones with full detail)

**MCP connector is fully live as of 2026-08-08.**

## Plant ID and cloud-sync reliability work (2026-08-09 to 2026-08-11)

Prompted by real field use surfacing that Plant ID lost in-progress results and that Tasks data silently diverged between the two devices and the MCP connector.

- **Plant ID**: fixed the top "Identify plant" button silently discarding a queued supplemental photo when tapped after a result already existed; fixed the "Add photo to improve ID" control giving no feedback when tapped before selecting a plant part; added full session persistence (photo, organ, GPS, zone, notes, supplemental photos, and the AI result) so a backgrounded-tab reload no longer loses an in-progress or completed ID; added a photo-count/confidence-delta line to results re-identified with extra photos.
- **Gallery save**: added a "Save photo to gallery" button that downloads the primary photo with the ID + confidence embedded in its EXIF `ImageDescription` (hand-written minimal EXIF writer, `public/js/exif-writer.js` — no third-party library). Google Photos picking this up depends on the user having "Download" folder backup enabled in their own Google Photos settings — not guaranteed. **Not yet verified with a real photo on a real device** — only tested via mocked browser calls.
- **Cloud sync root cause**: session tokens expire after 30 days with no renewal prompt; the app detected this and silently reverted to local-only data with zero indication anything had changed. This explains why the Tasks tab, MCP `get_tasks`, and the two devices' local views had all drifted apart — three independent, never-reconciled data stores (desktop `localStorage`, phone `localStorage`, and D1) rather than one shared state.
- **Fix**: replaced the offline banner and a short-lived session-expired banner with a single red/yellow/green sync-status dot next to the settings gear (offline / online-but-signed-out / online-and-synced), tap opens Settings and shows the same text as a toast (title/hover doesn't work on mobile touch). Reconnecting while signed in now triggers a real sync automatically instead of requiring "Sync now". Device-local custom tasks now migrate to the cloud automatically on sign-in instead of being silently orphaned once cloud data takes over. The app remembers the last signed-in identity (`fc_last_user` in `localStorage`) through a sign-out/expiry so re-sign-in prompts can say "sign back in as X". **Not yet verified through a real offline→online transition in the field** — tested via simulated `online` events in the browser.
- **Data cleanup**: removed 7 junk/duplicate rows from the D1 `tasks` table (test entries created while developing the MCP `create_task`/`update_task` tools back in June, plus one accidental duplicate from the sign-in migration). Added the `delete_task` MCP tool (see above) since none existed before this.

## Task location-linking requirement (2026-08-12)

Prompted by finding a Zone A "high-priority removal" task whose text described a specific
invasive shrub and claimed "GPS coordinates logged for tracking," but had no linked
observation and no lat/lng anywhere — the plant it referred to is now unrecoverable. Root
cause: `create_task` (used both by the app and by Claude.ai chat sessions via the MCP
connector) let a task's `observation_id`/`observation_name` be optional free text with
nothing enforcing that a photo-derived task actually persisted the species/GPS via
`create_observation` first.

- `tasks` gained `lat`, `lng`, `no_location` columns (in addition to existing
  `observation_id`/`observation_name`).
- **New tasks must now include one of:** a linked `observation_id`, `lat`+`lng`, or
  `no_location: true` (explicit "general/admin task, not about a specific spot"). Enforced
  server-side in `POST /tasks` and the `create_task` MCP tool — client-side validation
  alone wouldn't have stopped the original bug, which came from an MCP tool call.
  **Existing tasks were not touched or backfilled** — the requirement only applies going
  forward; edits to already-orphaned tasks are still allowed without a link.
- `update_task`/`PUT /tasks/:id` accept the same fields (not enforced there) so a missing
  link can be attached after the fact — the Tasks tab's edit view now has GPS-capture +
  observation-search controls for exactly this.
- Tasks now show their created date and a "⚠️ unlinked" badge when they have neither a
  plant link nor GPS nor the general-task flag (only applies to tasks created after this
  shipped — the pre-existing seasonal checklist and the several dozen AI-authored tasks
  from earlier sessions are silently exempt via a `created_at` presence check, not flagged).
- Plant ID's three "Add task" buttons previously only passed a free-text `observation_name`
  (the observation wasn't saved yet at that point in the flow) — they now auto-save the
  observation first so the task links to a real record.

**Found but not fixed — flagged for a future session:** task→observation links created via
the in-app Log flow use the *local IndexedDB* autoincrement id, while links an AI creates
via `create_observation` + `create_task` over MCP use the *cloud D1* `observations.id` —
two different id spaces stored in the same `observation_id` column. Confirmed concretely:
task `e85a561b` claims `observation_id: "9"` / "Silver maple · Zone C", but the real cloud
Silver Maple observation is id `241` in Zone A. `PropertyMap.flyToObs()` now defensively
matches on both `o.id` and `o.cloud_id` (`public/js/map.js`), which resolves same-device
app-created links and any synced MCP-created links, but does not fix the underlying schema
ambiguity. A real fix would mean always writing the cloud id once synced, or giving tasks
their own resolved-observation lookup independent of whichever id happened to be on hand
at creation time.

## Plant ID camera capture + AI-agreement fixes (2026-08-18)

Prompted by real field use: tapping "Camera" to identify a plant returned to the app with
no photo and no zone selected (GPS alone survived). Root cause: `<input capture="environment">`
hands off to Android's native camera app as a separate activity; under memory pressure
Android can kill the browser tab's process while that app is foregrounded, forcing a full
page reload on return. The captured photo — which only reaches app code via the file
input's `change` event — is lost in that reload, since the event would fire on the
now-dead page instance. A `restoreSession()` ordering bug separately let the zone
selection get clobbered back to blank during recovery (GPS restore ran first and called
`persistSession()`, which read the zone `<select>` before it had been restored).

- **New `CameraCapture` module** (`public/js/camera-capture.js`): in-page live camera via
  `getUserMedia` + a `<video>` preview + canvas snapshot, replacing the native camera-app
  handoff for the primary photo and both supplemental-photo ("Add photo to improve ID")
  flows. Staying on-page means there's no separate Android activity for the OS to reclaim
  memory from — removes the failure mode rather than working around it. Falls back to the
  old native-camera file input automatically if `getUserMedia` is unavailable or denied.
  **Not yet verified on a real Android device** — this session's browser-preview testing
  could only confirm the JS logic and the fallback path; the actual field failure mode
  (Android killing the tab mid-capture) can't be reproduced in a sandboxed preview.
- Fixed the `restoreSession()` zone-clobbering ordering bug above.
- **Supplemental-photo flow reordered**: it previously required picking a plant part
  (Leaf/Flower/...) *before* the photo button would do anything — backwards, since you
  don't know what part a photo shows until you've taken it. Also, the disabled button used
  `pointer-events:none`, which silently swallowed taps with zero feedback (read as
  "broken" rather than "gated"). Now mirrors the primary photo's flow: capture the photo
  first, then pick the plant part; either order still works.
- **Claude vs PlantNet "IDs differ" disagreement check** had two real bugs, found via a
  live Big Bluestem ID: (1) the comparator did a naive space-split on the first two words
  of each scientific name, so a stray leading/double space, an author suffix, or a hybrid
  "×" marker in either raw string shifted the split and flagged a disagreement even when
  both names rendered identically; (2) after fixing that, a genuine case surfaced where
  PlantNet's *actual* top candidate was a one-letter typo of the correct name ("gerardii"
  vs "gerardi") — PlantNet's species names come from crowd-sourced observation data and are
  typo-prone. The check now normalizes more robustly (strips diacritics/punctuation,
  collapses whitespace) and tolerates small edit distances (≤2 chars, ≤25% of name length)
  as agreement, and checks all 3 of PlantNet's returned candidates rather than just #1 —
  a typo'd top result with a correctly-spelled #2/#3 now also counts as agreement.
- **Gotcha caught mid-session, see the entry below**: build/cache version wasn't bumped on
  4 of these 5 deploys before being caught and fixed.

## Sprint history (reference IDs mined from commit messages)

No standalone sprint-requirements doc survives in git history — one (`field-companion-v2-requirements-for-claude-code.md`) exists only as an uncommitted file in a stale worktree (`.claude/worktrees/modest-jemison-369a7d/`, 1 commit behind `main`, never added to git). The IDs below are recovered from commit subjects only.

- **A-1 – A-7**: observation edit/duplicate, sync status, map zone labels, boundary delete, boundary/label sync fixes
- **B-1 – B-4**: cloud task sync, zone delete, Log tab button fix
- **C-1 – C-4**: PlantNet hybrid plant ID, few-shot examples, image quality, field rename
- **S-1 – S-5**: batched fixes (v53)
- **MP-3**: backend fix bundled with new zones (v55)
- **SC-1, NZ-2, PID-2**: bundled into the Plants tab / desktop layout release (v56)
- **Phase 1**: Google Sign-In + cloud sync via Cloudflare Worker + D1 (`141e3d1`, ~May 2026)
- **Phase 2**: GPS map picker, confidence threshold, model upgrade (`9b7398d`)
- **Phase 3**: property map tab, satellite view, pins, boundary drawing (`a1c0a7d`)
- v54–v64 (Jun–Jul 2026): swipe nav, scroll memory, zone flash, dupe modal, invoice URL fix, live location tracking, find-a-plant search

(Current commit hashes for both repos are in the Repos table at the top of this doc — kept there instead of duplicated here.)

## Deferred features (as of 2026-08-08, extended 2026-08-11)

- **County GIS parcel import** and **GPS-walk boundary drawing** (both spec'd in `FC V2 Specs/`) were never built — only manual polygon drawing exists. Decided not worth building now: all 8 zone boundaries are already drawn and working via manual drawing, so neither feature has a use case today. **Revisit both when work begins on the multi-user / multi-property version** — a new property or new zone at that point would need one of these again.
- **Multi-user / walled-off datasets per account**: mentioned by the user as an "eventually" idea, not started. The `users`/`sessions` schema exists but everything is still hard-gated to a single `ALLOWED_EMAIL`. Would need real per-user scoping added throughout the Worker (currently all queries just use whatever the one allowed user's `user_id` resolves to) before this is more than a placeholder.

## Known mismatches / gotchas (as of 2026-08-18)

- `origin` remote (frontend) is behind `v2` — **always push frontend work to `v2`**, never `origin`.
- Backend (`field-companion-worker/`) now has a GitHub remote (`origin`, private repo) and is pushed, but **has no auto-deploy workflow** — pushing is backup only; `wrangler deploy` is the actual deploy step (see Deploy note in Repos table above).
- `README.md` in the frontend repo described only the offline-only PWA (no mention of Google Sign-In, cloud sync, or the backend) — fixed 2026-08-07; see the README's own history if it drifts again.
- `field-companion-worker/schema.sql` was missing the `tasks` table (it was created ad-hoc by `index.js` at runtime) — now also declared in `schema.sql` for accuracy, though the runtime self-migration code stays as a safety net for the already-deployed database.
- **Unexplained: `tasks.user_id` (declared `TEXT`) round-trips through the MCP/D1 layer as the string `"1.0"`, not `"1"`** — same pattern seen on `observation_id` (`"9.0"`, `"13.0"`, `"41.0"`). Harmless for the app itself (its own parameterized queries compare consistently either way), but it broke a hand-written `WHERE user_id = 1` in a manual `wrangler d1 execute` cleanup command (matched zero rows silently — no error, just no effect). Root cause not investigated — worth digging into next session if hand-written SQL against this DB is needed again. Always verify row counts after manual D1 writes rather than trusting the CLI's "Executed N commands" message, which doesn't reflect rows affected.
- **The small `observation_id` values above (`"9"`, `"13"`, `"41"`) are separately explained now (2026-08-12): they're local IndexedDB ids, not cloud D1 `observations.id` values** (real cloud ids are in the 200s+). See the task-linking section above — this is a genuine id-space mismatch between app-created and MCP-created task links, not just a formatting quirk.
- Frontend service worker (`public/service-worker.js`) uses a strict cache-first strategy — **`CACHE_NAME` and `APP_BUILD` must be bumped on every deploy that changes any cached shell file** (`index.html`, anything in `public/js/` or `public/css/`), or already-installed devices will never detect the update, no matter how many times the user refreshes. This was missed twice in the 2026-08-09–11 work, and again on 2026-08-18 (bumped on only 1 of 5 same-day deploys to `public/js/plant-id.js`, all four follow-on fixes forgotten) before being caught each time. **Recurring enough that it's worth bumping on every commit that touches a cached file, not just the first one in a session.**
