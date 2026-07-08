# CLAUDE_CONTEXT.md
# BeCopenhagen Fleet App — Permanent Configuration & State Document
# Last updated: 2026-07-08

> **MAINTENANCE RULE — READ FIRST:** This file must be kept up to date with
> every change made to this codebase, AND it must be actively referred to
> before making changes — not just written to after the fact. Any time a
> file is added, a schema is altered, a route is created or removed, a
> feature ships or changes status, or an open item is resolved — update the
> relevant section of this document **in the same commit** as the change
> itself, not as an afterthought or a separate later pass. If you are Claude
> working in this repo and you just shipped something, updating this file is
> part of finishing the task, not optional cleanup. Before starting
> nontrivial work, read the relevant sections of this file first — it exists
> to make you smarter about this codebase, not just to record history.

---

## 1. Core Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 | Uses built-in `node:sqlite` (no better-sqlite3), run with `node --experimental-sqlite` for direct DB scripts |
| Backend | Express 4 | express-session for auth, no ORM |
| Database | SQLite via `node:sqlite` built-in | WAL mode, FK enforcement, file at `/var/www/becopenhagen-fleet/data/fleet.db` |
| Frontend | Vanilla JS PWA | No framework — single `app.js`, single `app.css`, single `index.html` |
| Hosting | Hetzner VPS `178.104.12.40` | Ubuntu 24, 4GB RAM |
| Process manager | pm2, process name `bc-fleet` | |
| Reverse proxy | Caddy | Auto-TLS, config at `/etc/caddy/Caddyfile` |
| Email | nodemailer via Simply.com SMTP | `smtp.simply.com:587`, sender `noreply@becopenhagen.dk`; extended with attachment support and a shared footer |
| Voice input | OpenAI Whisper (STT) + Anthropic Claude Haiku (bike ID parsing) | |
| Browser automation | Playwright (Node), headless Chromium on VPS | Used for FareHarbor booking agent and the guide-schedule dashboard scraper |
| Version control | GitHub `git@github.com:tortonesef-coder/becopenhagen-fleet.git` | |
| DNS/Domain | Simply.com, managed by Hassan | `app.becopenhagen.dk` → VPS |

No new npm dependencies or runtime/external-service changes were introduced in the most recent session — all new work (below) used this existing stack.

---

## 2. Codebase Architecture

### Authentication
- **Two-step login:** tap name → confirm email (6-digit code via SMTP) → set password (first-time only)
- **Passwords:** `crypto.scryptSync` with random salt, stored as `hash:salt` in `team_members`
- **Verification codes:** `crypto.randomInt(100000, 1000000)` — cryptographically secure
- **Sessions:** express-session, 24h cookie, server-side session store (in-memory)
- **Shop Mode:** separate PIN-protected session (`shop_mode: true` on session), PIN stored hashed in `shop_pin` table. Every action is attributed retroactively via "Who did this?" full-screen takeover after each action
- **Session tear-down:** `req.session.destroy()` + `res.clearCookie('connect.sid')` on logout — both must happen to avoid cookie persistence race condition
- **"View As" impersonation** — as of the latest session, this no longer touches `req.session` at all. It is resolved per-request via an `X-View-As` header and the new `getActor(req)` helper (`src/actor.js`), which returns the effective actor (real session vs. impersonation) without mutating session state.

### API Design
- All routes are RESTful JSON APIs under `/api/`
- Route files: `api.js` (bikes/availability/log), `auth.js` (login/verify/session), `repairs.js` (tickets), `fleet.js` (admin bike management), `ical.js` (tour/rental sync + polling), `webhooks.js` (FareHarbor webhook receiver), `voice.js` (Whisper STT), `fareharbor-agent.js` (Playwright booking agent bridge)
- New route files (latest session): `routes/admin-notifs.js` (`createNotification()` / `resolveNotification()` + router for the Alerts system), `routes/notif-prefs.js` (per-guide notification preference toggles)
- `api()` helper in frontend does all fetch calls with JSON body, throws on non-2xx
- No authentication middleware on most routes — actor identity comes from `req.session.actor` (or the resolved impersonation actor via `getActor()`)

### Frontend State
- Global `state` object: `{ actor, shopMode, currentTab, action, bikeFilter }`
- Tab system: `renderTab(id)` re-renders entire content area on each tab switch (no virtual DOM)
- No localStorage or sessionStorage — all state in memory + server session
- `undoStack` (max 25 entries): `{ label, fn }` where `fn` is an async compensating API call
- Undo button in topbar, dimmed when empty, red when active
- Guide and mechanic profile views now have sub-tabs: Overview, Invoice, Availability, Notifications (guides); Overview only (mechanic)
- Admin tab has been restructured into: **Action · Operations · Fleet · Guides & Tours · App · Alerts** (supersedes the earlier Fleet/Log/FareHarbor/Bugs/View-as grouping)

### Data Flow
- iCal feeds polled every 90 seconds from FareHarbor → parsed → upserted into `tour_availabilities`
- FareHarbor webhook fires on booking create/update/cancel → processed in `webhooks.js` → updates `pending_assignments`; raw webhook bodies are now also logged verbatim to `webhook_log`
- FareHarbor booking agent: frontend form → POST `/api/fareharbor-agent/create-booking` → `execFile('node', [AGENT_SCRIPT, ...argv])` → Playwright headless Chromium → FareHarbor dashboard UI → returns `booking_ref`
- **Guide-schedule scraper (v2):** full rewrite (`scripts/fareharbor-agent/scrape-guide-schedule-v2.js`) using FareHarbor's internal calendar JSON API instead of page-scraping. Runtime dropped from ~40min to ~90s per run, now a single hourly cron job. The previous page-scraping version of this script is obsolete.
  - Crew-role detection switched from `group.role.short_name` (frequently abbreviated/empty due to FareHarbor's payload deduplication) to `crewMember.unicode` (reliably present per entry)
  - Bike-count extraction (v2 only) reads FareHarbor's `resource_use_summaries`, scoped **only to private tours** (group tours' shared resources like Electric Cargo Bike report fractional/unreliable values). Guide-blocking resources are excluded by numeric ID (not name, which can be abbreviated), via a one-time-per-run resource list fetch.
- Guide extraction in `ical.js` was rewritten to prefer the crew member's real account name over trailing "Guide - X" text, only falling back to the trailing text for generic "Crew N" placeholder accounts (previously always trusted the trailing text, which broke for real accounts with non-name notes like language tags)
- `computeBufferedMinutes()` (ical.js) and the v2 scraper's duration calc are now tour-specific: Food Tour (F3/F3P) gets a 30+30min buffer (4.5h total for a 3.5h tour); all other tours keep the previous 15+15min buffer
- Private tours with zero bookings are now fully excluded from: Tours list, guide upcoming-hours tracking, and assignment emails (see private-tour-type note below)
- Guide name matching logic (`guideMatches`, `normalizeName`, `GUIDE_ALIASES`, Levenshtein distance) was extracted out of `ical.js` into a standalone shared module, `src/guide-name-match.js`, now imported everywhere guide names are compared (ical.js, guides.js, v2 scraper, tour-reminders.js)

### Environment Variables (stored in `/etc/environment`)
```
SESSION_SECRET
OPENAI_API_KEY
ANTHROPIC_API_KEY
FAREHARBOR_EMAIL
FAREHARBOR_PASSWORD
SMTP_HOST=smtp.simply.com
SMTP_PORT=587
SMTP_USER=noreply@becopenhagen.dk
SMTP_PASSWORD
DB_PATH (optional override)
PORT (optional, default 3456)
```

pm2 does NOT inherit `/etc/environment` automatically — server.js reads it manually at startup via `fs.readFileSync('/etc/environment')`.

---

## 3. System Directory Map

```
/var/www/becopenhagen-fleet/          ← project root on VPS
├── src/
│   ├── server.js                     ← Express app entry point, route registration, session
│   ├── auth.js                       ← password hashing helpers (scryptSync)
│   ├── email.js                      ← nodemailer SMTP transporter, sendVerificationCodeEmail, sendPasswordResetEmail
│   ├── actor.js                      ← NEW: getActor(req) — resolves effective actor (real session vs "View As") without mutating req.session
│   ├── guide-name-match.js           ← NEW: shared fuzzy guide-name matcher (guideMatches, normalizeName, GUIDE_ALIASES, Levenshtein), extracted from ical.js
│   ├── tour-change-log.js            ← NEW: logTourChange() helper, writes to tour_change_log audit table
│   ├── log-retention.js              ← NEW: daily cleanup job, 120-day retention on log/audit tables only
│   ├── db/
│   │   ├── schema.js                 ← SQLite init, all CREATE TABLE, migrations
│   │   └── seed.js                   ← bike types, full fleet (91 bikes), team members
│   └── routes/
│       ├── api.js                    ← bikes, availability, action log, bug reports, fareharbor-agent-log
│       ├── auth.js                   ← login, verify code, set password, session, shop PIN
│       ├── repairs.js                ← repair tickets CRUD, priority scoring
│       ├── fleet.js                  ← admin bike add/edit/retire
│       ├── ical.js                   ← iCal feed polling, tour/rental parsing, /api/ical/tours + /rentals
│       ├── webhooks.js               ← FareHarbor webhook receiver (/webhooks/fareharbor)
│       ├── voice.js                  ← Whisper STT + Claude Haiku bike ID extraction
│       ├── fareharbor-agent.js       ← bridges app to Playwright booking script via execFile
│       ├── admin-notifs.js           ← NEW: createNotification() / resolveNotification() + Alerts router
│       └── notif-prefs.js            ← NEW: per-guide notification preference toggles
├── public/
│   ├── index.html                    ← single HTML shell, all screens in same DOM
│   ├── manifest.json                 ← PWA manifest (icons, display:standalone)
│   ├── favicon.svg                   ← red circle "be" logo
│   ├── icons/
│   │   ├── icon-192.png              ← PWA home screen icon
│   │   └── icon-512.png              ← PWA splash icon
│   ├── css/
│   │   └── app.css                   ← all styles, CSS custom properties for theming
│   └── js/
│       └── app.js                    ← entire frontend (~2500 lines), all tabs, all UI
├── scripts/
│   ├── backup.sh                     ← nightly backup to /var/backups/bc-fleet/ + GitHub private repo
│   ├── restore.sh                    ← restore from backup
│   ├── seed-emails.js                ← one-time script to populate team member emails
│   ├── test-alerts.js                ← NEW: fires one test notification of each type for visual QA (display only, does not test trigger logic)
│   ├── fixes/                        ← NEW: convention — one-off data migration scripts now live here as committed files (see §7 Developer Workflow)
│   │   ├── restore-manual-guide-hours.js
│   │   ├── fix-past-f3-duration.js
│   │   ├── backfill-booking-created-at.js
│   │   └── reset-tour-bike-data.js
│   └── fareharbor-agent/
│       ├── create-booking.js         ← Playwright booking automation (PROVEN WORKING, 7 scenarios tested)
│       ├── scrape-availability.js    ← pre-scraper for availability IDs (IN PROGRESS — regex fix needed)
│       ├── scrape-guide-schedule-v2.js ← NEW: full rewrite of guide-schedule scraper using FareHarbor's internal calendar JSON API (replaces the earlier page-scraping version, now obsolete)
│       ├── package.json
│       └── README.md
├── data/
│   └── fleet.db                      ← SQLite database (WAL mode)
└── package.json
```

---

## 4. Core Data Models

### bike_types
```sql
id TEXT PK, label TEXT, fareharbor_resource TEXT, rental_value_dkk INT, demand_level INT, sort_order INT
```
Types: A, SA, AC, AT, B, BM, TB, MB, CC, E
`fareharbor_resource` must exactly match FareHarbor's dropdown label (e.g. "Adult's Bikes", "Christiania Cargo Bikes")

### bikes
```sql
id TEXT PK, type_id TEXT FK, name TEXT, frame_number TEXT, model TEXT,
frame_size TEXT, key_number TEXT, gender TEXT, notes TEXT, active INT, created_at TEXT
```
91 bikes total (+ 11 physical bikes added to the fleet DB this session under the new GT category — see below). Each bike has a Danish cultural figure as its name (A1="Agnes Obel" etc.)

### bike_status
```sql
bike_id TEXT PK FK, status TEXT (available/out/repair/missing/borrowed),
assigned_to TEXT, assignment_type TEXT, fareharbor_booking_ref TEXT,
customer_name TEXT, out_since TEXT, return_due TEXT, note TEXT,
location_lat REAL, location_lng REAL, location_address TEXT,
updated_at TEXT, updated_by TEXT
```

### team_members
```sql
id TEXT PK, name TEXT, role TEXT (admin/guide/mechanic), active INT,
email TEXT, password_hash TEXT, password_salt TEXT, needs_password_setup INT
```
Team: Fede (admin), Hassan (admin), Søren (admin), Zac (mechanic), Andrew/Féidhlim/Ibrahim/Monica/Pam (guides)
Aliases in `src/guide-name-match.js` (formerly in ical.js): Hasse→Hassan, Paloma→Pam

### repair_tickets
```sql
id INT PK, bike_id FK, reported_by TEXT, problem TEXT, problem_categories TEXT,
can_rent INT, status TEXT (open/resolved), priority_score REAL, complexity INT (1-5),
estimated_hours REAL, started_at TEXT, resolved_at TEXT, resolved_by TEXT,
resolution_note TEXT, created_at TEXT
```
Priority formula: `(rental_value × 0.3) + (demand × 0.25) + (inverse_complexity × 0.25) + (wait_days × 0.2)`

### tour_availabilities
```sql
availability_id TEXT PK, feed_id TEXT, feed_label TEXT, feed_type TEXT (tour/rental),
guide TEXT, start_at TEXT, end_at TEXT, start_date TEXT, start_time TEXT, end_time TEXT,
summary TEXT, bikes_needed TEXT (JSON), total_bikes INT, booking_count INT,
bookings_json TEXT (JSON array), url TEXT, last_synced TEXT
```
**Updated:** `bikes_needed` now includes a `GT` (Guided Tour Bikes) category, tracked distinctly from generic "Adult" bikes.

### action_log
```sql
id INT PK, actor TEXT, action TEXT, bike_id TEXT, battery_id TEXT,
booking_ref TEXT, details TEXT (JSON), created_at TEXT
```
Action types include: checkout, return, city, missing, borrowed, repair_reported, fareharbor_booking_created, fareharbor_booking_failed

### pending_assignments
Created by FareHarbor webhook for each incoming booking. Linked to bikes via `assignment_bikes`.

### fareharbor_availability_cache (schema exists, not yet populated)
```sql
item_id TEXT, date TEXT, availability_id TEXT, scraped_at TEXT — PK(item_id, date)
```
Intended for pre-scraped availability IDs from collapsed single-daily-slot rental items.

### New tables (introduced this session)
- **`admin_notifications`** — `id, type, title, body, ref_id, dismissed, resolved_at, created_at`. `resolved_at` was added mid-session to distinguish "admin dismissed, stays dismissed" from "issue resolved, can re-alert later."
- **`tour_change_log`** — `availability_id, feed_id, start_date, field, old_value, new_value, source (ical/v2), raw_data, created_at`. `raw_data` is a capped raw source snippet, stored only on actual changes, not every poll. Written via `src/tour-change-log.js`'s `logTourChange()`.
- **`page_views`** — `actor, actor_name, tab, created_at`. Covers top-level tabs and all sub-tabs.
- **`emails_sent`** — `to_email, to_name, subject, category, ok, error, sent_at`. Every `sendEmail()` call now auto-logs here.
- **`webhook_log`** — raw FareHarbor webhook bodies, stored verbatim, uncapped.
- **`bookings`** — permanent individual-booking ledger: `ref, availability_id, customer info, source, booking_created_at`. Survives `tour_availabilities` purging; enables historical "bookings N days ago" queries. Queryable via Admin → App → Bookings (by exact date / N-days-ago / date range).

### Extended tables (pre-existing structures, extended this session)
- **`notification_prefs`** — per-guide notification preference toggles (managed via `routes/notif-prefs.js`)
- **`guide_unavailability`** — self-service marking with conflict detection against assigned tours; admin view of all guides' periods

### Altered tables (this session)
- **`guide_tour_hours`** — added `booking_count` column, now **denormalized at sync time**. Previously did a live JOIN to `tour_availabilities`, which gets purged over time and was silently zeroing out booking counts for older tours — this was the root cause of a review-rate bug.

---

## 5. Feature Status

All of these are in production on `app.becopenhagen.dk` unless noted otherwise.

| Feature | Status | Notes |
|---|---|---|
| Bike fleet registry (91+11 bikes) | ✅ Stable | Add/edit/retire via Admin tab |
| Role-based tab system | ✅ Stable | Admin, Guide, Mechanic, Shop each see different tabs |
| Authentication (email verify + password) | ✅ Stable | Cryptographically secure codes, scrypt passwords |
| Shop iPad mode | ✅ Stable | PIN entry dial-pad, who-did-this takeover, exit confirmation modal |
| Action tab (checkout/return/tour/repair/missing/city) | ✅ Stable | With undo stack, voice input, bike ID validation |
| Tours tab (iCal sync from FareHarbor) | ✅ Stable | Guide-filtered, unassigned hidden from guides, 90s polling |
| Rentals tab | ✅ Stable | All bookings shown, no truncation |
| Tickets tab (repair queue) | ✅ Stable | Priority-sorted, complexity rating, can-rent toggle, resolve flow |
| Bikes tab with availability grid | ✅ Stable | Collapsible fleet summary at top, search/filter below |
| Admin tab | ✅ Stable, restructured | Now Action · Operations · Fleet · Guides & Tours · App · Alerts |
| FareHarbor webhook receiver | ✅ Stable | Creates/updates pending_assignments on booking events; raw bodies now also logged to webhook_log |
| FareHarbor booking agent (Playwright) | ✅ Stable | 7 scenarios proven: single, multi-bike, mixed-type, cargo, POS, multi-day, overbooking guard |
| Undo stack (25 entries, topbar button) | ✅ Stable | Covers all mutating actions across all tabs |
| Email (Simply.com SMTP) | ✅ Stable | Verification codes, password resets; extended this session with attachments and a shared footer |
| PWA (installable, home screen icon) | ✅ Stable | manifest.json, icon-192/512.png |
| Bug report button + admin review | ✅ Stable | Topbar bug icon → modal → Admin→Bugs |
| BETA badge | ✅ Stable | Top-left in topbar |
| Nightly backups | ✅ Stable | Local + private GitHub repo (30-day history) |
| Guide-schedule scraper v2 | ✅ New, stable | ~90s per run (was ~40min), single hourly cron, internal calendar JSON API |
| Batched assignment digest emails | ✅ New, stable | One email per guide per run listing all new/updated tours, instead of one per slot |
| Airbnb source detection | ✅ New, stable | No-email-in-iCal-block heuristic, confirmed reliable by Fede |
| Guide unavailability (self-service) | ✅ New, stable | Conflict detection against assigned tours; admin view of all guides' periods |
| Guide/mechanic profile sub-tabs | ✅ New, stable | Overview, Invoice, Availability, Notifications (guides); Overview only (mechanic) |
| Alerts system | ✅ New, stable | unassigned_tour (14-day), unassigned_tour_urgent (2-day, bypasses dismissal), unavailability, invoice, first_booking_soon, bug_report, guide_mismatch, bike_data_anomaly. Desktop notification + sound ping on new alerts |
| Comprehensive activity logging | ✅ New, stable | Tour changes, page views (incl. sub-tabs), sent emails, raw webhooks — all with 120-day auto-retention |
| Permanent bookings ledger | ✅ New, stable | Queryable by exact date / N-days-ago / date range (Admin → App → Bookings) |
| GT bike category | ✅ New, stable | "Guided Tour Bikes" tracked distinctly from generic "Adult" bikes; 11 physical bikes added |
| Guide cross-check | ✅ New, stable | Validates crew-based guide assignment against resource-blocking assignment, flags disagreements without changing authoritative source |
| Send invoice to Søren | ✅ Fixed | Was silently using a worse duplicate dead route handler missing the proper email footer |
| Availability pre-scraper | 🚧 In progress | Regex fix landed: `/Rentals/` matches buttons correctly (31 found), but goBack/re-query loop still fails after first click |

---

## 6. Developer Workflow & Interaction Preferences

### Who does what
- **Claude writes, tests (syntax-checks), commits, and pushes all code** directly to `github.com/tortonesef-coder/becopenhagen-fleet` (main branch), using a stored PAT. Fede never writes or edits code.
- **Fede's role is strictly:** run the deploy command on the VPS, and run diagnostic commands Claude provides, then paste back raw terminal output or screenshots.
- **Claude cannot SSH into the VPS directly** — only HTTP/HTTPS to an allowlisted domain set is available from the sandbox; all server-side verification happens via Fede copy-pasting commands and results back into the conversation.

### Standard deploy pattern (every code change ends with this — Fede runs manually)
```bash
cd /var/www/becopenhagen-fleet && git pull && pm2 restart bc-fleet --update-env
```

### Data/migration changes
Established convention (this session): migration/data-fix scripts must be committed as real files under `scripts/fixes/`, pushed, and run via:
```bash
cd /var/www/becopenhagen-fleet && git pull && node scripts/fixes/<name>.js
```
Fede explicitly rejected ad-hoc inline `node -e "..."` one-liners mid-session ("why do I always have to put all of these scripts... is there no way for you to push these and just refresh?") — this is now the required pattern for **any** data fix, not just code changes. One-off scripts previously were pasted as inline `node -e` commands; that pattern is retired.

### Code writing rules
- **No frameworks** on the frontend — vanilla JS only, no React, no Vue, no bundler
- **No bullet points or lists in explanations unless asked** — Claude uses prose
- **No excessive comments** — code should be self-explanatory; comments only for non-obvious choices
- **Syntax-check before every push:** `node --check public/js/app.js` (and server files)
- **One commit per logical change** with a clear, direct commit message
- **Never guess at live state** — if unsure what's actually in the DB or on the server, ask Fede to run a query rather than assume; Claude refines based on real pasted output, never assumes/guesses when real output is available
- **Never generalize from a single example** — one data point (one booking, one resource, one tour) proved wrong twice this session (Airbnb "never" fires the webhook — false; a private tour's bike resource behaves like the validated one — false). When a pattern seems to hold from one observation, check `CLAUDE_CONTEXT.md` for prior documented findings before asserting it as a rule, and be explicit that it's provisional until confirmed on more than one instance
- **Refer to `CLAUDE_CONTEXT.md` before acting, not just after** — read the relevant sections before starting nontrivial work in this repo, not only to record what happened afterward
- **Update `CLAUDE_CONTEXT.md` in the same commit as the change** — new files, schema changes, new/removed routes, feature status changes, and resolved open items all get reflected here immediately, not batched up for later

### GitHub workflow
- Branch: `main` only
- Claude pushes directly to `main` — no PRs, no feature branches
- Every code change: `git add -A && git commit -m "..." && git push`
- If push fails (network blip), retry once

### Debugging approach
- Claude hypothesizes root cause → writes a small standalone diagnostic script or curl command (or adds `console.log`/screenshot debug output to failing code) → pushes → Fede runs it and pastes raw output/screenshot → Claude refines based on real data (never assumes/guesses when real output is available) → writes fix → pushes → Fede deploys → verifies via UI screenshot or another diagnostic query
- Never make multiple speculative fixes in one commit — one hypothesis per iteration
- If something fails silently on the VPS, check `pm2 logs bc-fleet --lines 30` first
- For browser automation debugging: save screenshots to `/tmp/fh-debug-*.png`, Fede SCPs them to desktop

### Communication style
- Fede is terse and direct — short corrections mean "that's wrong, fix it"; he reports bugs primarily via screenshots of the live app
- Fede expects direct acknowledgment of mistakes without over-apologizing, followed immediately by concrete action — not lengthy explanations before a fix
- State clearly when something is **unverified live** vs **confirmed working** — don't present guesses as solid
- When a limitation is actually an implementation gap (not a hard constraint), say so and fix it rather than documenting it as a caveat
- Don't re-explain things Fede already knows — he pushes back when explanations are unnecessary, and pushes back hard (and fairly) when a fix is incomplete or when Claude deviates from the established push/pull workflow

### FareHarbor-specific knowledge
- Login URL: `https://fareharbor.com/login/` (two-step: shortname "becopenhagen" → email/password)
- Booking URL pattern: `https://fareharbor.com/becopenhagen/items/{item_id}/availability/{availability_id}/book/`
- Public widget URL: `https://fareharbor.com/embeds/book/becopenhagen/items/{item_id}/calendar/{YYYY}/{MM}/`
- Date page URL: `https://fareharbor.com/embeds/book/becopenhagen/items/{item_id}/date/{YYYY-MM-DD}/`
- Quantity dropdowns: native `<select>`, options 0–N, then "Overbooking:" separator — never select below/at the separator
- Payment options: "Cash", "Previously paid" (for POS/terminal, comment="POS"), "Charge card", "Airbnb"
- Staff-only "Bike IDs" textarea: one bike ID per line
- Complete booking button: `button:has-text("Complete booking")`, shortcut Shift+Enter
- Booking ref appears on confirmation page as text "Booking #NNNNNNNNN"
- `execFile` (not `exec`) required for passing JSON `--items` arg safely
- Internal calendar JSON API (used by the v2 guide-schedule scraper) is preferred over page-scraping where available — far faster and more reliable
- Crew-role detection: use `crewMember.unicode`, not `group.role.short_name` (the latter is frequently abbreviated/empty due to payload deduplication)
- Bike-count extraction via `resource_use_summaries` is reliable **only** for the specific "Guided Tour Bikes" resource (identified by ID, not name). Every other resource type has shown unreliable behavior in practice: Electric Cargo Bike reports fractional prorated values (expected — single shared prop), and the generic "Adult Bike" pool has been observed reporting total fleet capacity instead of a per-booking count on at least one private tour. Only that one confirmed resource is ever trusted; everything else is ignored rather than guessed at.

### Private tour types
`L2P, L3P, A3P, F3P, H3P, CUSTOM`. No "Can keep bikes after tour" flag, no unassigned visibility. Zero-booking private tours in this set are also fully excluded from: Tours list, guide upcoming-hours tracking, and assignment emails.

### Airbnb bookings
Identified by `b.source === 'Airbnb'` — excluded from "Can keep bikes" flag, shown in orange on tour cards. Detection heuristic (no-email-in-iCal-block) confirmed reliable by Fede this session.

---

## 7. Open / In Progress

| Item | Status |
|---|---|
| "Can keep bikes" flag / date display mismatch | **Fixed.** When the "first seen" fallback was added for display, the flag's own logic wasn't updated to match — it still checked `!b.created_at` directly and defaulted to SHOWING the flag whenever that was missing, even for bookings the UI now correctly shows as recent via `first_seen_at`. Produced visible contradictions (e.g. "First seen 7 Jul" shown alongside "Can keep bikes after tour" on the same booking). Now both use the same effective date (`created_at \|\| first_seen_at`), and the default flipped: when no date is known at all, the flag no longer shows (safer than assuming eligibility) |
| Booking `created_at` overwrite bug | **Fixed and backfilled.** The 90-second iCal sync was unconditionally overwriting `tour_availabilities.bookings_json` with a freshly-parsed version lacking `created_at` (iCal text has no per-booking timestamp at all) — silently wiping out the value the webhook correctly sets within ~90 seconds of every booking. `ical.js` now merges forward any `created_at` already present before overwriting. `scripts/fixes/backfill-booking-created-at.js` backfilled currently-missing values from `action_log`'s `booking_received` history. **Follow-up added:** Airbnb bookings never fire our webhook at all (FareHarbor's Airbnb calendar-sync integration doesn't trigger it), so they have no `created_at` even after backfill — `/api/ical/tours` now falls back to the `bookings` ledger's `first_seen_at` (when our sync first spotted it, ~within 90s of the real booking) and the UI labels it "First seen ... (approx.)" to stay honest about the difference |
| Availability pre-scraper | Regex match fixed (31 buttons found), but click→navigate→re-query loop still fails after first button. Next step: rewrite to navigate directly to `/date/{YYYY-MM-DD}/` URL for each day instead of clicking buttons, avoiding goBack entirely |
| F3/F3P duration fix | **Confirmed fixed in the UI.** `scripts/fixes/fix-past-f3-duration.js` forces every F3/F3P `guide_tour_hours` row to 270 minutes (4h30m); Fede confirmed correct display after running it |
| Guide review-rate / hours re-verification | Pam's data for the current billing cycle (23 Jun–22 Jul) was manually corrected this session. Still worth a full re-verification pass across all guides, not just Pam |
| Bike-count resource trust — tightened twice this session | **Ongoing hardening.** First scoped v2's bike authority to private tours only (group tours' shared resources report fractional/unreliable values). Then found that scoping alone was insufficient: (1) a group tour retained a stale fractional value frozen from before the scoping fix — v2 could no longer correct it since it's not allowed to touch group tours at all — needed `scripts/fixes/reset-tour-bike-data.js` to clear all stored bike data for a clean recompute; (2) a private tour (A3P) showed 31 bikes for 6 people, exactly matching the fleet's total Adult Bike capacity — the generic "Adult Bike" resource was reporting pool capacity, not a per-booking count. Now **only** the specific "Guided Tour Bikes" resource (matched by ID) is ever trusted; every other resource is ignored rather than guessed at. `bike_data_anomaly` alert **has now fired and been explained/verified** — no longer purely theoretical |
| `guide_mismatch` alert type | Live in code but not yet observed firing on real data — unverified in practice |
| Completed/past tour re-sync | Completed/past tours do not get re-synced once they age out of the live FareHarbor feed. Any future policy change to a duration/field will hit the same frozen-past-data problem and will need an explicit migration script under `scripts/fixes/`, not just a code fix. This exact pattern has now caused two separate bugs this session (F3 duration, bike-count staleness) — treat it as a known recurring risk, not a one-off |
| Cancel-booking Playwright script | Not built yet |
| Battery management UI | DB table exists, no UI |
| Offline PWA caching | Never built |
| AC/AT seat configuration toggle | DB supports it, no UI button |
| Admin email (admin-specific feature walkthrough) | Drafted as follow-on to staff intro email |
| Repair priority weight tuning UI | Formula hardcoded in code, not adjustable from Admin tab |

---

## 8. Session Log

- **2026-07-08 (latest session):** v2 guide-schedule scraper (internal API rewrite, ~90s vs ~40min); Alerts system + admin notifications table; comprehensive activity logging (tour changes, page views, sent emails, raw webhooks) with 120-day retention; permanent bookings ledger; GT bike category + 11 new bikes; guide cross-check; `getActor()`/`X-View-As` rewrite of impersonation (no session mutation); `guide-name-match.js` extracted as shared module; `scripts/fixes/` convention established and enforced for all data migrations; F3/F3P duration fix shipped and **confirmed**; fixed broken "Send invoice to Søren" route; `CLAUDE_CONTEXT.md` created and established as a living document updated every commit; root-caused and fixed the "Can keep bikes after tour" bug (webhook-set `created_at` was being silently wiped by every iCal sync) with backfill migration + "first seen" fallback for Airbnb bookings (which never fire our webhook); bike-count resource trust tightened twice more after finding stale-frozen-data and pool-capacity-vs-per-booking-count failure modes — now only the specific "Guided Tour Bikes" resource (by ID) is ever trusted, with `reset-tour-bike-data.js` migration to clear bad stored values.
