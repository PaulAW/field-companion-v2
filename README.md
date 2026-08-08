# 🌿 Field Companion

Mobile-first PWA for native prairie and woodland stewardship on Paul Winer's 7.77-acre SE Iowa property.

Live at: https://paulaw.github.io/field-companion-v2/

**Features:**
- 📷 **Plant ID** — take a photo, Claude AI identifies it and gives property-specific action advice
- 📍 **Field Log** — GPS-tagged observation entry, history view, CSV export for Google Sheets
- 🗺️ **Zones & Map** — all 8 zones with invasive priorities and restoration goals; satellite property map with boundary drawing, pins, and live location tracking
- 🌱 **Plants** — property-wide plant list grouped by zone, with a find-a-plant search
- ✅ **Tasks** — seasonal maintenance checklist with persistent state
- 📁 **Drive** — quick links to all Google Drive landscaping documents
- ☁️ **Cloud sync** — sign in with Google to sync observations and zone boundaries across devices via a Cloudflare Worker + D1 backend (see [Architecture](#architecture) below)
- 🤖 **MCP connector** — Claude.ai can read and write your field data directly in chat (see [Connecting Claude.ai](#connecting-claudeai-mcp))
- 📵 **Offline** — Log, Zones, Tasks, and Drive all work without internet; cloud sync resumes automatically when back online

## Architecture

This is not a purely static/offline app — it has a real backend:

- **Frontend**: static PWA in `public/`, deployed via GitHub Actions to GitHub Pages
- **Backend**: a separate Cloudflare Worker project (`field-companion-worker/`, **not a subfolder of this repo**) providing:
  - Google Sign-In + session auth (`public/js/auth.js` ↔ `POST /auth/google`)
  - Cloud sync for observations and zone boundaries (`public/js/sync.js`, `public/js/map.js` ↔ `/observations`, `/boundaries`, `/tasks`)
  - A D1 (SQLite) database — see `PROJECT_STATE.md` for the current schema
  - An MCP server for Claude.ai (see below)
  - Deployed at `https://field-companion-backend.paulwiner5.workers.dev`
- **Plant ID**: routes through a second, separate Cloudflare Worker (`https://field-companion-api.paulwiner5.workers.dev`) that proxies to the Anthropic API — this one only needs a per-device API key, no sign-in

`PROJECT_STATE.md` in this repo root is the up-to-date source of truth for backend URLs, D1 schema, and sprint history.

## Connecting Claude.ai (MCP)

The backend exposes an MCP server so a Claude.ai chat can read and write your zones, field log, tasks, treatments, and planting orders directly.

1. In Claude.ai: **Settings → Connectors → Add custom connector**
2. URL: `https://field-companion-backend.paulwiner5.workers.dev/mcp`
3. Claude.ai will redirect you to a Google Sign-In page — sign in with the same Google account the app itself uses (single-user gate, same as cloud sync)
4. Once connected, Claude can call: `get_zones`, `get_observations`, `create_observation`, `update_zone`, `get_tasks`, `create_task`, `update_task`, `get_boundaries`, `get_treatments`, `create_treatment`, `get_planting_orders`

---

## Setup

### 1. Add your Google Drive links

Edit [`public/js/data/drive-links.json`](public/js/data/drive-links.json) and replace each `PASTE_YOUR_GOOGLE_DRIVE_LINK_HERE` value with the actual sharing URL from your Google Drive documents.

To get a sharing link in Google Drive: open the file → Share → Get link → Copy.

### 2. Get an Anthropic API key (for Plant ID only)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an account and add a payment method
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`)

> **Cost:** roughly $0.01 per plant identification. $5 in credits will last months at normal field use.
>
> **Note:** This is separate from Claude Pro. Claude Pro is the chat app; this requires the API.

### 3. Deploy to GitHub Pages

```bash
# 1. Create a new repo on github.com (e.g. "field-companion")

# 2. Push this folder
git init
git add .
git commit -m "Initial Field Companion build"
git remote add origin https://github.com/YOUR-USERNAME/field-companion.git
git push -u origin main

# 3. Enable GitHub Pages
#    Go to repo → Settings → Pages → Source: Deploy from branch → main → /public → Save
```

Your app will be live at: `https://YOUR-USERNAME.github.io/field-companion/`

### 4. Install on your phone (Android)

1. Open Chrome on your Samsung Galaxy S22
2. Navigate to your GitHub Pages URL
3. Tap the three-dot menu → **Add to Home screen**
4. The app installs as a PWA — works like a native app

### 5. Enter your API key

Open the app → tap ⚙️ in the top right → paste your `sk-ant-…` key → **Save key**.

The key is stored only on your device (localStorage) and is sent only to `api.anthropic.com`.

---

## App icons

The PWA manifest references `icons/icon-192.png` and `icons/icon-512.png`. For now these are missing (the app works without them but won't show a custom icon). To add icons:

1. Create a 512×512 PNG with a leaf or plant icon
2. Save it as `public/icons/icon-512.png`
3. Create a 192×192 version as `public/icons/icon-192.png`
4. Commit and push — the PWA will use them on next install

Free icon sources: [favicon.io](https://favicon.io) lets you generate from emoji — use 🌿.

---

## Updating zone data or tasks

- **Zone info** (invasives, targets, goals): edit `public/js/data/zones.json`
- **Seasonal tasks**: edit `public/js/data/tasks.json`
- **Drive links**: edit `public/js/data/drive-links.json`
- **AI prompt context** (confirmed natives, kill list): edit `public/js/data/property-context.json`

After editing, commit and push — GitHub Pages auto-deploys within ~1 minute.

---

## CSV column order (for Google Sheets paste)

```
Date | Zone | Lat | Lng | Location | Common Name | Latin Name | Native | Keystone | Type | Action | Photo | Logged By | Notes
```

---

## File structure

```
field-companion/
├── PROJECT_STATE.md         ← backend URLs, D1 schema, sprint history — read this first
└── public/
    ├── index.html            ← App shell (single page)
    ├── manifest.json         ← PWA install config
    ├── service-worker.js     ← Offline cache (bump CACHE_NAME on every deploy)
    ├── css/
    │   └── style.css
    ├── js/
    │   ├── app.js             ← Core: routing, IndexedDB, offline, toast
    │   ├── auth.js            ← Google Sign-In, session token storage
    │   ├── sync.js            ← Cloud sync for observations (push/pull vs. the D1 backend)
    │   ├── map.js             ← Property map: satellite view, pins, boundary drawing, live location, zone/boundary sync
    │   ├── map-picker.js      ← GPS map picker used by Plant ID / Log entry
    │   ├── plant-id.js        ← Camera, PlantNet + Claude API, result display
    │   ├── plants.js          ← Property-wide plant list / find-a-plant search
    │   ├── logger.js          ← Observation form, history, CSV export
    │   ├── zones.js           ← Zone grid and detail
    │   ├── tasks.js           ← Seasonal checklist (localStorage offline + D1 cloud)
    │   └── data/
    │       ├── zones.json
    │       ├── tasks.json
    │       ├── drive-links.json
    │       └── property-context.json
    └── icons/
        ├── icon-192.png
        └── icon-512.png

field-companion-worker/       ← separate repo, sibling folder — Cloudflare Worker backend
├── schema.sql                ← D1 schema
├── seed-zones.sql            ← one-time zone data backfill
├── wrangler.toml
└── src/
    ├── index.js               ← REST API: auth, observations, boundaries, tasks
    └── mcp.js                 ← MCP server + OAuth for the Claude.ai connector
```
