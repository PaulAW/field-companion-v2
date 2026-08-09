# Field Companion — Project State

This file is the single source of truth for design/planning sessions in Claude Chat
(a Claude Chat session cannot see Claude Code session history or local files). Keep
it current as work lands — update it whenever a sprint of work ships or the
architecture changes.

Last updated: 2026-08-08.

## Repos

| Repo | Path (local) | Remote | Role |
|---|---|---|---|
| Frontend (PWA) | `C:\Users\paulw\Projects\field-companion\` | `v2` → `https://github.com/PaulAW/field-companion-v2.git` | **Source of truth — this is what's deployed.** |
| Frontend (stale mirror) | same folder, `origin` remote | `https://github.com/PaulAW/field-companion.git` | Do not use — 15+ commits behind `v2`. Never push here. |
| Backend (Worker) | `C:\Users\paulw\Projects\field-companion-worker\` | none yet (local git only, initialized 2026-08-07) | Cloudflare Worker: D1 CRUD API, Google Sign-In, MCP server. **Not a subfolder of the frontend repo** — separate project. |

Current branch on both: `main`. Frontend `main` is currently even with `v2/main` (0 ahead, 0 behind).

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

Added 2026-08-07. Exposes 11 tools at `POST https://field-companion-backend.paulwiner5.workers.dev/mcp` (JSON-RPC 2.0, MCP Streamable HTTP transport): `get_zones`, `get_observations`, `create_observation`, `update_zone`, `get_tasks`, `create_task`, `update_task`, `get_boundaries`, `get_treatments`, `create_treatment`, `get_planting_orders`.

Auth: OAuth 2.1 with dynamic client registration + PKCE, reusing the existing Google Sign-In + `ALLOWED_EMAIL` gate. Discovery at `/.well-known/oauth-authorization-server`. See `field-companion-worker/src/mcp.js`.

**Deploy steps completed 2026-08-08:**
1. ✅ `wrangler d1 execute field-companion-db --remote --file=schema.sql` — ran successfully (23 queries, 25 rows written)
2. ✅ `wrangler d1 execute field-companion-db --remote --file=seed-zones.sql` — ran successfully (8 queries, 16 rows written)
3. ✅ `wrangler deploy` from `field-companion-worker/` — live at `field-companion-backend.paulwiner5.workers.dev`

**Deploy steps completed 2026-08-08 (cont'd):**
4. ✅ Google Cloud Console — added `https://field-companion-backend.paulwiner5.workers.dev` as an Authorized JavaScript origin on the `GOOGLE_CLIENT_ID` OAuth client
5. ✅ Claude.ai custom connector added at `https://field-companion-backend.paulwiner5.workers.dev/mcp`, signed in, and confirmed working (`get_zones` returned all 8 zones with full detail)

**MCP connector is fully live as of 2026-08-08.**

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

## Last commits

- Frontend: `9bb78fd` — "chore: relabel build to actual deploy date (v64/2026-07-13-a)" — 2026-07-13
- Backend: `e77d8ff` — "feat: MCP server for Claude.ai custom connector" — 2026-08-07 (local only, not yet pushed to a remote — none exists yet)

## Deferred features (as of 2026-08-08)

- **County GIS parcel import** and **GPS-walk boundary drawing** (both spec'd in `FC V2 Specs/`) were never built — only manual polygon drawing exists. Decided not worth building now: all 8 zone boundaries are already drawn and working via manual drawing, so neither feature has a use case today. **Revisit both when work begins on the multi-user / multi-property version** — a new property or new zone at that point would need one of these again.

## Known mismatches / gotchas (as of 2026-08-08)

- `origin` remote is 15 commits behind `v2` — **always push frontend work to `v2`**, never `origin`.
- Backend (`field-companion-worker/`) had **zero version control** until 2026-08-07 — it now has a local git repo but no GitHub remote configured yet.
- `README.md` in the frontend repo described only the offline-only PWA (no mention of Google Sign-In, cloud sync, or the backend) — fixed 2026-08-07; see the README's own history if it drifts again.
- `field-companion-worker/schema.sql` was missing the `tasks` table (it was created ad-hoc by `index.js` at runtime) — now also declared in `schema.sql` for accuracy, though the runtime self-migration code stays as a safety net for the already-deployed database.
