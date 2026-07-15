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
- **Bike-count field ownership (fixed 2026-07-08):** `tour_availabilities.bikes_needed` has two writers with **disjoint** key ownership, so they no longer clobber each other. iCal owns the non-GT categories (`A, E, B, AC, AT`, parsed from summary text); v2 owns `GT` (from resources). Each writer merges only its own keys via atomic `json_set(json(COALESCE(bikes_needed,'{}')), ...)` inside its `ON CONFLICT` clause, preserving the other's keys, and recomputes `total_bikes` as the combined sum. Previously both did a whole-object `bikes_needed=excluded.bikes_needed`, which — because their totals come from disjoint categories — made each `CASE WHEN total_bikes>0` guard let that writer replace the whole object, zeroing the other's keys and oscillating `{A:n,GT:0}`↔`{A:0,GT:m}` every cycle on mixed tours. The merge is atomic (single statement) so there is no read-then-write race between the 90s iCal process and the hourly v2 process. Self-heals existing rows within one v2 cycle; no migration needed.
- Guide extraction in `ical.js` was rewritten to prefer the crew member's real account name over trailing "Guide - X" text, only falling back to the trailing text for generic "Crew N" placeholder accounts (previously always trusted the trailing text, which broke for real accounts with non-name notes like language tags)
- **Guide field ownership (fixed 2026-07-08):** v2 (crew `unicode`) is authoritative for `guide`. iCal's parser now also returns `guide_confident` — true only when the guide came from a real account name (the reliable path), false for the trailing-text / placeholder / bare-location fallbacks. iCal writes `icalGuide = guide_confident ? guide : null` and the upsert uses `guide=COALESCE(excluded.guide, guide)`: a confident parse overwrites (so reassignments stay fast, ~90s) while a non-confident or blank parse never clobbers a value v2 set. Same rule on `guide_tour_hours` (iCal only logs hours off a confident guide; v2 covers placeholder-crew tours, resolving the real name via unicode). Notification/assignment-email logic now keys off the *effective* guide (`icalGuide || prev`) so alerts and the stored/displayed guide stay consistent. This ends the previous behaviour where iCal's unconditional 90s `guide=excluded.guide` overwrote (or NULL-wiped) v2's better assignment.
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
│   ├── tour-duration.js              ← NEW: shared computeBufferedMinutes() — single source of truth for buffered tour length, imported by ical.js AND the v2 scraper so they can't drift
│   ├── notify-first-booking.js       ← NEW: notifyFirstBooking(availId, {testEmailTo}) — fires the first-booking guide email + admin alert EXACTLY ONCE via an atomic claim on tour_availabilities.first_booking_notified. Called by both the webhook (real-time) and ical.js (covers Airbnb). Fixes the race where the webhook bumped booking_count before the 90s sync saw 0→1
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
│   │   ├── backfill-real-created-at-from-fareharbor.js  ← NEW: pulls TRUE created_at from FareHarbor's per-availability bookings API for bookings missing it (predate the webhook); dry-run by default, --commit to write. Uses earlier of created_at/original_created_at so pre-1-July bookings that were later rescheduled still count
│   │   ├── recode-guided-bikes.js  ← NEW: renames guided bike IDs GTn->Gn (Guided Bike) and GTn->GSn (Guided Bike Small), updating all 6 referencing tables atomically (FK off during swap); dry-run by default, --commit to apply
│   │   ├── test-first-booking-email.js  ← NEW: sends a REAL first-booking email to ONLY the address you pass (notifier test mode); safe, repeatable, never emails a guide
│   │   ├── test-all-emails.js  ← NEW: sends one of EVERY email notification type to ONLY the address you pass (real first-booking template + representative samples of the rest); for verifying the whole email set
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
bookings_json TEXT (JSON array), url TEXT, last_synced TEXT,
first_booking_notified INT DEFAULT 0
```
**Updated:** `bikes_needed` now includes a `GT` (Guided Tour Bikes) category, tracked distinctly from generic "Adult" bikes. `first_booking_notified` (added 2026-07-08) is an atomic once-only guard for the first-booking notification (see `src/notify-first-booking.js`); migration marks existing booked tours as notified to avoid retro-emails.

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

### Debugging approach — scientific method, not reactive patching
- **Verify before fixing, every time.** A fix based on a guess, however confident, is not a fix — it's a new hypothesis that needs its own verification. Today's session repeatedly broke things by skipping this: scoping bike-count trust to "private tours" without confirming the resource behaved the same way on every private tour (it didn't — A3P reported pool capacity, not a per-booking count); assuming "Guided Tour Bikes" being abbreviated meant the same fix would work for every resource (it didn't — group tours' shared resources report fractional prorated values); assuming a display fallback wouldn't need the flag logic updated too (it did — produced a visible contradiction). Each of these was a real fix for a real bug that then broke or half-broke something adjacent, because the fix was shipped on a hypothesis rather than a confirmed root cause.
- **The loop:** hypothesize root cause → get REAL data that would prove or disprove it (diagnostic script, curl command, direct DB query, or a raw API fetch — never assume the shape of data you haven't actually seen) → only once the hypothesis is confirmed against real data, write the fix scoped exactly to what was confirmed → push → Fede deploys → verify the fix against real data again, not just "looks right in one screenshot"
- **Before generalizing a fix to a broader category** ("this works for private tours" / "this resource is reliable"), check whether it's actually been confirmed for more than one instance in that category, not just the one that was debugged. If not, scope the fix narrowly to what's confirmed and say so explicitly, rather than writing a broad rule that will need walking back later.
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
- Per-availability bookings API (returns full booking objects incl. real `created_at`, `original_created_at`, `modified_at`, `contact`, etc.): `https://fareharbor.com/api/v1/companies/becopenhagen/items/{item_id}/availabilities/{availability_id}/bookings/` — authenticated via the logged-in Playwright page's cookies (`page.request.get`), confirmed directly usable (HTTP 200), no page-scraping/interception needed. This is the source for backfilling the true booking-creation date on bookings that predate our webhook (which otherwise fall back to `first_seen_at`)
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
| Completed/past tour re-sync | **Now intentional (freeze policy, 2026-07-08).** Finished tours (start_date before today) are deliberately immutable: iCal skips recomputing their `tour_availabilities`/`guide_tour_hours` rows and v2 already skips past days. A tour first seen after it's over is snapshotted once. Consequence by design: a later formula/field change only affects future tours — to change a past tour you must run a deliberate migration under `scripts/fixes/` (as with `fix-past-f3-duration.js`). This converts the old "frozen-past-data" footgun into stated behaviour, but the migration requirement itself remains: if you change a formula and want it applied retroactively, write a fixes script |
| Cancel-booking Playwright script | Not built yet |
| Battery management UI | DB table exists, no UI |
| Offline PWA caching | Never built |
| AC/AT seat configuration toggle | DB supports it, no UI button |
| Admin email (admin-specific feature walkthrough) | Drafted as follow-on to staff intro email |
| Repair priority weight tuning UI | Formula hardcoded in code, not adjustable from Admin tab |

---

## 8. Session Log

- **2026-07-15 (assigned 31 Aug A3P didn't appear in Tours — 30-day window):** The A3P was correctly assigned and in the DB, but invisible in the Tours view. Cause: `GET /api/ical/tours` defaults to `days=30`, and 31 Aug is 47 days out — past the window. Both the guide Tours view (`renderTours`, line ~3453) and the admin **Operations → Tours** view (line ~2193, which is what Fede's screenshot showed) called `/tours` with no `days` param. Fixed both to `?days=120` so far-out private tours (booked weeks ahead) show. `renderToursList` already displays "N guests" (relabeled earlier); the screenshot lacked it only because the pax-fixed scraper hadn't re-run yet on those rows. NOTE: the "9 bikes for a small tour" Fede spotted was NOT a bug — 3 bookings × multiple people = 9 pax = 9 bikes; it actually confirms bookings≠people, which the pax fix addresses.

- **2026-07-15 (pax count: show PEOPLE, not reservations):** The 31 Aug A3P showed `bookings=1` in the app and email while FareHarbor showed 11 booked — because the scraper stored FareHarbor's `booking_count` (number of RESERVATIONS: 1 group booking by Simon Reichen for 11 people) instead of `customer_count` (the 11 PEOPLE). Pax is what the app shows and what prep depends on, and — per Fede — it must be correct independent of bikes: 11 people who bring their own bikes are still an 11-pax tour (bikes come from resources, pax is its own number). Fix: the scraper now stores **pax** in `booking_count` (`av.customer_count ?? av.booking_count ?? 0`), keeps the reservation count separately as `reservation_count`/`customer_count` on the object, and the display + assignment email relabel "booking(s)" → "guest(s)". Removed the temporary 31-Aug sweep trace. NOTE (earlier confusion, now resolved): the "written-then-deleted" theory for the 13:45 was WRONG — the trace proved the 13:45 row (id 2118711983, Federico) is written and kept (`inSeenIds=true`); it had merely not been written yet when the first diag ran (pre-fix scraper). Issue #2 fully closed: 31 Aug 13:45 A3P is in the app, assigned to Federico. Also seen: duplicate assignment emails were from running the scraper manually several times during debugging (the dedup guard correctly flagged one), not a bug.

- **2026-07-15 ("database is locked" after the crash fix — SQLite concurrency):** With the crash fixed the scraper now reaches August (rows for 2026-08-02 printed), but ended with `Fatal: database is locked` — the scraper (separate process) and the live app both write the same SQLite file and collided. WAL was already on but there was **no `busy_timeout`**, so a write landing mid-transaction aborted instantly instead of waiting. Two fixes: (1) `PRAGMA busy_timeout = 5000` in `getDb()` (shared by every connection) — a competing write now waits up to 5s and retries. (2) Wrapped the scraper's whole upsert loop (`for (const av of all)`) in a single `BEGIN IMMEDIATE … COMMIT` (rollback on error) — previously each availability was its own write txn, dozens of separate lock grabs; now it takes the write lock once, briefly. The COMMIT lands BEFORE the digest-email sending and the cancellation sweep, so no slow work holds the lock; those later individual writes (incl. the heartbeat stamp) rely on busy_timeout. This lock contention is also why the heartbeat didn't record on that run.

- **2026-07-15 (scraper heartbeat / dead-man's switch):** After the scraper silently crashed for hours and froze all of August (caught only because Fede noticed a missing booking), added a watchdog so a dead scraper is caught the same day. Two parts: (1) the scraper stamps `app_settings.scraper_last_success = datetime('now')` at the very END of `main()` — AFTER the `finally{browser.close()}`, so a crash (which exits via `.catch`) never advances it, meaning the stamp only moves on a genuinely clean full run. (2) New `src/scraper-heartbeat.js` (`startHeartbeat()`, wired in server.js next to log-retention/tour-reminders) checks hourly: if the last clean run is >3h old (scraper runs hourly, so 3h = several misses) it creates an admin notification AND emails federico@becopenhagen.dk, re-alerting at most once per 12h, and logs a recovery when it's healthy again. First check is 5 min after boot (lets an in-flight scrape finish). Staleness math + thresholds unit-tested. `getSetting/setSetting` use app_settings (key is PRIMARY KEY, so ON CONFLICT works); `sendEmail` category 'scraper_heartbeat'.

- **2026-07-15 (CRITICAL: scraper crash froze all of August — my bug):** The 31 Aug A3P (11 booked, French tour, Federico as crew, confirmed in FareHarbor) wasn't in the app. Root cause: the scraper was **crashing during the July fetch and never reaching August** — `Fatal: bikeResourceTypes is not defined`. My resources-everywhere change threaded `bikeResourceTypes` into `extractBikesFromResources` but NOT through `extractAvailabilities` (missing from its signature at def + call site), so it threw the moment a tour with bikes was parsed. Every run since died mid-July; all August rows were frozen at their last good sync, and new August bookings never landed. Fixes: (1) thread `bikeResourceTypes` through `extractAvailabilities` (signature + call). (2) **Hardening so this class of bug can't recur:** bike extraction wrapped in try/catch — a bike-count fault degrades to zero bikes and KEEPS the tour (schedule is critical, bike counts secondary); each month's fetch is isolated in try/catch so one bad month can't abort the others; and if `all` is empty after all months, the run bails BEFORE the cancellation sweep so an empty fetch can't be read as mass cancellations. Deploy + trigger the scraper to backfill August.

- **2026-07-15 (phantom A3P cancellations — FareHarbor reissues availability IDs):** Fede got "Tour assigned — A3P" then "Tour cancelled — A3P" a minute later, though nothing changed. Diagnostic proved it: the live A3P rows all have IDs in the `2118712xxx` block, but the ~9 cancellation notifications from the past week were all for `2123815xxx` IDs — a whole DIFFERENT block. **FareHarbor reissues an availability's internal ID when a private tour is edited/reassigned**, so the old ID disappears from the feed while the SAME slot reappears under a new ID. Both cancellation detectors (iCal every 90s, v2 hourly) treated "ID no longer in feed" as a cancellation and emailed the guide — a phantom every time the private-tour ID block rotated. Fix: a slot is only a real cancellation if **no slot with the same feed + date + time exists in this run**; if it does, the old row is a superseded reissue — delete it silently, no email. Applied the guard to BOTH detectors. Time formats differ between writers (iCal "10:15" colon, scraper "10.15" dot via `hhmm`/da-DK locale), so the slot key normalizes dot→colon on both sides; the scraper derives the time from `start_at` (records carry no `start_time` field). Removed the two throwaway diagnostics (diag-a3p, diag-reviews).

- **2026-07-15 (reviews can be logged for shop staff, not just guides):** Zac (mechanic) does customer-facing shop work and gets good reviews, but the "Log a new review" dropdown filtered to `role==='guide' || role==='admin'`, excluding him. The SERVER never restricted this — `POST /api/reviews` accepts any active member — so it was purely a frontend filter. Widened the recipient list to anyone customer-facing: `role in (guide, admin, mechanic) || is_guide || can_shop`, sorted by name, and relabeled "Select guide…" → "Select team member…". Left the guide METRICS/performance list (line ~2391) as guides-only, so Zac's reviews are recorded without polluting the guide dashboard — reviews and guide-hours/pay are separate systems, so logging a review for him creates no hours or pay entries.

- **2026-07-15 (bike counts now come from FareHarbor RESOURCES for all tour types):** Fede: "I want to use resources everywhere — sometimes a tour uses an adult bike, sometimes a guided bike, sometimes a touring bike; an adult rental might really be a child-seat bike without the seat." Correct: resources record the bike ACTUALLY ASSIGNED; booking text only records what was ORDERED. The v2 scraper previously trusted ONLY "Guided Tour Bikes", and only on PRIVATE tours, because earlier work saw the Adult Bike pool reporting fleet capacity and fractional values elsewhere. **`diag-resources.js` disproved that:** on real data every bike resource is a clean per-booking count (Adult Bike=2, Touring Bike=2, Guided Tour Bikes=2 — including one tour mixing adult AND guided bikes, which text-parsing could never see). The only fractional values were **Monica 0.32 / Andrew 0.4 — those are GUIDES, not bikes**, and were already filtered; the old "fractional" warning was almost certainly about guide resources. Changes: (1) `fetchResourceLookup` now builds a **resourcePk → bike type map** from FareHarbor's `/resources/` list, classified against `bike_types.fareharbor_resource` (the fleet's own names, longest-match-first), so the mapping follows the fleet with no hardcoded list; guides and the shared Electric Cargo Bike prop are excluded. (2) `extractBikesFromResources` counts **every** bike type (was GT-only), keys off resource ID (surviving FareHarbor's abbreviated objects, which have no `pk`/name — falls back to the id in the URI), and skips fractional values. (3) Resources are used for **all tours**, not just private. (4) **OWNERSHIP rewritten**: v2 now owns tour bike counts outright (writes the whole object); **iCal writes bike counts for RENTALS only** — otherwise the 90s iCal sync would clobber v2's hourly resource data. Both writers still only overwrite when `total_bikes > 0`, so a failed/empty scrape leaves the previous counts rather than zeroing the shop's board. Dead `categorizeBikeResource` removed. NOTE: tour counts now refresh hourly (v2) rather than every 90s; the text parser (`src/parse-bikes.js`) still serves rentals.

- **2026-07-15 (parser correction: people counts were being counted as bikes):** The board showed "15 tours" for adult bikes (was 13) and Kids 3 (was 1) — I over-corrected in the previous commit. Cause: `classify()` matched a bare people-count like **"3 Adults"** against the `Adult's Bikes` type name and counted 3 adult bikes, even though the line never mentions a bike. For tours that's *coincidentally* often right (one bike per guest) but it's wrong reasoning and inflated the counts. Fixed with a **line-wide bike context** rule: a line is only counted if it mentions a bike ANYWHERE ("3 Adults, 1 Child incl. bike rental" → the adults get bikes too, even though only the last phrase says "bike"); a line with no bike at all ("4 People", "3 Adults") contributes nothing. Within a bike-bearing line, a phrase that names a bike is classified against the fleet's FareHarbor type names, and a bare person-count gets one bike each. Full regression test passes: rentals (A/CC/TB/SA/B), tours (incl. e-bike split), and the must-not-count cases. Also: the Today board's "N tours + M rentals" sub-label now shows for EVERY category, not just mixed ones (a bare "Cargo bike 2" left the shop guessing whether it was a tour or a rental).
- **Answer to Fede's question:** ~~the counts are NOT read from FareHarbor resources — only guided-tour bikes (`GT`) come from resources, via the hourly v2 scraper. Everything else is parsed from the iCal booking text and matched against `bike_types.fareharbor_resource`.~~ **[SUPERSEDED same day — see the "bike counts now come from FareHarbor RESOURCES for all tour types" entry above: all tour bike types now read from resources; only rentals still use the text parser.]**

- **2026-07-15 (ROOT CAUSE: rentals parsed to ZERO bikes — board under-counted badly):** Fede counted 22 adult bikes; the board said 13, and showed no cargo/touring/small types at all. Cause: `bikes_needed` was parsed from the event SUMMARY with regexes requiring the literal word **"incl."** ("5 Adults incl. bike rentals"). Tours phrase it that way — **rentals do not**: they say "2 Adult's Bikes, 1 Christiania Cargo Bike". So **every rental parsed to zero bikes** (verified against Fede's 7 real rental strings: all returned nothing), and the 13 came purely from tours (4+4+5). Fixes: (1) New shared `src/parse-bikes.js` — `parseBikeCounts(lines)` reads the per-booking `what` lines (which carry the real breakdown) and classifies each phrase against **`bike_types.fareharbor_resource`**, i.e. the fleet's OWN FareHarbor names ("Adult's Bikes", "Christiania Cargo Bikes", "Touring bikes", "Adult City Bikes (Small)"…), longest-match-first so "Adult City Bikes (Small)" isn't swallowed by "Adult's Bikes". E-bike is checked before the type match, since "2 Adults incl. e-bike rentals" contains "adult" and would otherwise file as a plain adult bike. Both phrasings verified. `ical.js` now recomputes `bikes_needed` from the bookings whenever they tell us something. (2) **The upsert hardcoded A/E/B/AC/AT**, which would have silently dropped CC/TB/SA/MB even with the parser fixed — it now takes iCal's whole object and re-attaches GT (still v2-owned), so any bike type the fleet defines flows through with no further code change. (3) `CAT_LABELS` now mirrors the real `bike_types`. Verified against Fede's board: **Adult 22 (13 tours + 9 rentals)**, Kids 3, Cargo 2, Touring 3, Small adult 1. NOTE: existing rows keep their stale zero counts until the next iCal sync rewrites them (90s).

- **2026-07-15 (correction: rentals = today's pickups only):** Reverted the "still-out multi-day rentals" inclusion from the previous commit. Per Fede: a bike handed out yesterday is already gone from the shop, so it needs no *preparing* today — the number answers **"how many bikes must I have ready this morning"**, not "how many are in customers' hands". So only rentals **starting today** feed the count. Removed the `GET /api/ical/rentals-live` endpoint and its fetch (clean-as-we-go); `diag-today-bikes.js` reverted to match. The peak/overlap rules are unchanged and still verified: non-overlapping tours share bikes (8 then 9, 30-min gap → 9), overlapping tours count twice (8 + 9 → 17), tours + same-type rentals add (6 + 4 → 10).

- **2026-07-15 ("Bikes needed today" reworked — one number per type):** The board split the count into "For tours" and "For rentals", which made the shop add two numbers in their head — wrong, because a tour bike and a rental bike are the SAME physical bike from the same pool. Now **one number per bike type = peak simultaneous demand across tours AND rentals**, with a quiet "N tours + M rentals" breakdown. Rules (verified by test): non-overlapping tours SHARE bikes (8 then 9 with a 30-min gap → 9); overlapping tours count TWICE (8 + 9 → 17); tours + rentals of the same type ADD (6 + 4 → 10). Tour window = start-10min to end+20min. Two real bugs fixed while doing it: (1) **multi-day rentals still out from earlier days were never counted** — the board only saw rentals *starting* today, but the N-Day feeds (1-D … 10-D) mean a rental picked up yesterday still holds bikes today. Added `GET /api/ical/rentals-live` (rentals whose window covers today, via `date(COALESCE(end_at, start_at)) >= date('now')`); the existing `/rentals` endpoint is left alone since it's a forward-looking pickup list the Rentals tab depends on. (2) A tour with **no usable start/end time was silently dropped** from the peak (under-counting); it's now added in full — better to over-prepare than send the shop out short. Also fixed the category labels against the real parser codes: A=Adult bike, E=E-bike, **B=Child bike** (was mislabeled "Bike", which is the bare label Fede saw), AC=Child seat, AT=Toddler seat, GT=Guided bike. Verified the parser itself does not double-count.

- **2026-07-15 (merge Fleet into Bikes):** Fleet and Bikes were separate bottom tabs, crowding the bar (shop was at 8). They do different jobs — **Bikes** = live status (availability by type, out/repair counts, `renderBikes`); **Fleet** = the catalogue editor (add/edit/retire, `renderAdminBikes`) — so they're merged as two SUB-tabs under one **Bikes** tab (`renderBikesTab` → Status | Fleet, `data-bikestab`) rather than mashed together. Bars are now: **shop 7** (Today · Action · Repairs · Tours · Rentals · Bikes · Log), **admin 6** (Operations · Bikes · Guides · Log · App · Alerts). Zac keeps his Fleet access (requested earlier) — it's now one tap inside Bikes. Guard: in **Counter Mode** `renderBikesTab` returns status only, since the Fleet catalogue is destructive and must be attributable, so it stays off the shared iPad. The old `fleet` renderTab dispatch is kept so existing deep-links still resolve; Operations' Bikes sub-tab still calls `renderBikes` (status) directly.

- **2026-07-15 (unified "everything" Log as a bottom tab, tap-to-correct any action):** Admin had granular logs buried under App → Logs but no everyday mixed log; shop had none at all. Added **Log** as a bottom tab to BOTH the admin view (Operations · Fleet · Guides · Log · App · Alerts) and the shop view (Today · Action · Repairs · Tours · Rentals · Bikes · Fleet · Log). Rebuilt `renderLog`: all actions mixed newest-first (150), a `.chip-row` filter (All / Checkouts / Returns / Repairs / Left in city, `setLogFilter`), relative timestamps, and **every entry with a bike is tappable**. `openReturnFix` (returns only) was replaced by `openLogFix(bikeId, logId)` — shows what the entry recorded, who did it, the customer/booking, and the bike's CURRENT state, then offers the corrections that make sense: if the bike is out → "Mark as returned" / "Send to repair"; if it's in → "Put back out to <customer>" (restoring assignment + booking ref from the preceding checkout entry) / "Send to repair". Old `openReturnFix` removed (dead code, clean-as-we-go). The granular Admin → App → Logs tabs are untouched. CSS: tab labels now ellipsize + shrink under 400px, since the shop bar is 8 tabs.

- **2026-07-09 (counter-mode trap + session capability loss — two bugs):** Fede hit the login screen and got the Counter Mode PIN instead. Cause: `req.session.shop_mode` is **sticky** — once a browser has been put into Counter Mode, `checkSession()` routes it to `initShopMode()` forever, and the PIN screen had **no escape hatch**, so that device could never reach the normal login again (pre-existing, but newly fatal now that login moved to email+password). Fixed: added a "Not the shop iPad? Sign in with email" link on the PIN screen calling `exitShopMode()` (which hits `/session/logout` → `req.session.destroy()`, clearing shop_mode). **Second bug found while fixing it:** `GET /session/me` returned only `{id,name,role}` from the session, dropping `can_shop`/`is_guide`/`view_mode` — so on every page refresh the restored actor lost its capabilities, the view switcher would vanish and tabs would silently fall back to role-only behaviour. Fixed by reading the member fresh from `team_members` in `/session/me`.

- **2026-07-09 (step 5: email+password login; role labels removed):** Login screen no longer lists the team — it's now **email + password** (`POST /auth/login-email`, case-insensitive email, deliberately vague "Incorrect email or password" so it can't be used to discover who has an account) plus a "Set up / forgot password" link (`POST /auth/forgot-password-email`, always reports success for the same reason; reuses the existing `generateToken()` + `password_resets` + `fleet.interestingtours.dk/reset-password?token=` flow). Readiness diagnostic had confirmed all 9 active members have an email AND a password set, so nobody is locked out. **Role labels removed from the UI**: `/auth/team` now returns **names only** (it's unauthenticated — an outsider shouldn't learn who works here or who is an admin); both Counter-Mode grids ("who are you" / "who did this?") show names only. The admin **View as** tool needs roles, so it moved to a new admin-gated `GET /auth/team-admin`, and now lists people by their **hats** (Shop · Guide · Admin) rather than a raw role string; `startViewAs` takes the full member object so a preview reproduces their actual capabilities, and `activeView()`/`setActiveView()` skip the saved-hat localStorage while previewing (so Fede's own hat doesn't leak into someone else's preview). Old member-picker fns (selectMember/showPasswordScreen/showConfirmEmailScreen) are now unreachable but left in place — the reset-password flow still leans on that code path; safe to prune later.

- **2026-07-09 (Counter Mode = shop view + attribution):** Per Fede, the shared counter iPad now shows the same operational picture as a logged-in shopkeeper instead of just 2 tabs: **Today · Action · Repairs · Tours · Rentals · Bikes**, landing on Today (`showMain` no longer hard-codes 'action' for shopMode). `canSeePayments` now also true in shopMode (the counter is a shop device). Two guardrails deliberately KEPT, because the counter is shared and unauthenticated: (1) **Fleet is excluded** — it edits the bike catalogue (add/retire/recode), a rare destructive action that shouldn't sit on an unlocked device; (2) the restricted `SHOP_ACTIONS` set (return/rental/tour/ticket — no borrowed/city/missing, which are staff-personal and need accountability). NEW guardrail found while wiring this: the counter's session actor is the generic `shop` user, and the "who did this?" prompt only fires after Action-tab submits — so resolving a repair ticket from the newly-exposed Repairs tab would have been recorded as done by "shop", silently creating unattributed data. Fixed by making **Repairs read-only in Counter Mode** ("Log in as yourself to resolve"); *reporting* a new issue still works, since it goes through the attributed Action flow.

- **2026-07-09 (step 4: Hassan demoted; kiosk renamed "Counter Mode"):** Hassan → `role='staff'`, `can_shop=1`, `is_guide=1` (one-time, guarded by an `app_settings.hassan_demoted` flag). **Fede and Søren are now the only admins** (Søren needed no change — he already resolves to Shop+Admin). Hassan keeps his own guide hours/invoice upload (gated by `actor === req.params.id`, not admin) and loses only admin powers: logging reviews for others, dismissing alerts, seeing all guides' hours. Fixed one regression this would have caused: `canSeePayments` (shows whether a customer still owes money — shop-floor info) was gated on `admin || mechanic`, so staff-Hassan would have lost it; it now follows the **shop capability**. **NAMING**: there were two different things called "shop" — the new **Shop view** (a logged-in person's hat) and the pre-existing `shopMode` (the shared, unauthenticated counter iPad: 2 tabs, asks "who did this?" after each action). Both are legitimate and kept; renamed the latter's user-visible labels to **"Counter Mode"** to end the collision (internal `state.shopMode` variable unchanged). STILL TO DO: step 5 = email+password login (no name list / no roles).

- **2026-07-09 (roles → capabilities + views, steps 1-3):** Untangled the one `role` field that was doing three jobs (server permissions / which tabs you see / what you are to the business). Now three independent ideas: **role** = PERMISSION only (server-enforced, unchanged: admin checks in admin-notifs, reviews, guides pay); **capabilities** = what you DO (`can_shop` NEW + existing `is_guide`, can hold several); **active view** = the hat you're wearing now (runtime, per-person, localStorage `bcf_view_<id>`). `availableViews()` derives views from capabilities; `activeView()`/`setActiveView()` manage the current one; `buildTabbar()` now keys off the view, not the role; `landingTab()` follows the view. **SHOP view = mechanic + shopkeeper merged**: Today · Action · Repairs · Tours · Rentals · Bikes · Fleet (Tours included so the shop can see which customers come when and prep bikes). A **view switcher** (`#view-switcher`, `.vs-btn`) appears in the topbar ONLY for people with 2+ views (Fede, Hassan, Søren) — everyone else's experience is byte-identical to before. Migration seeds `can_shop=1` for role IN (mechanic, admin) so this deploy changes nothing on screen. Actor responses in auth.js now include is_guide/can_shop/view_mode. STILL TO DO (deliberately separate commits): step 4 = demote Hassan to staff + can_shop/is_guide (Fede to be sole admin); step 5 = login screen → email+password only (no name list, no roles; readiness diagnostic confirmed all 9 active members have an email AND a password set, so nobody gets locked out).

- **2026-07-09 (correct a return after the fact):** Undo is a ~6s safety net; Fede needs to fix a return 30 min later, long after the undo stack is gone. Made the **Log** correctable: return/bulk_return entries are now tappable ("tap to correct") and open `openReturnFix(bikeId, logId)`, which finds the checkout that preceded that return in `action_log` to recover who the bike was out to (customer/assigned_to/booking_ref), shows the bike's current status, and offers "Undo this return — put back out", re-checking it out to the SAME customer/booking (note 'Return corrected'). If the bike is already out, it says there's nothing to correct. Uses existing endpoints only (`/api/log`, `/api/bikes/:id`, `/api/bikes/:id/checkout` with force). NOTE (told Fede): the reverse case — a bike that was MISSED in a bulk return — is just a normal return via Action, no special tool needed.

- **2026-07-09 (return undo made lossless + reachable):** Undo for returns existed but was **lossy**: it re-checked-out each bike as a generic rental assigned to "(undone return)", destroying the customer name, FareHarbor booking ref and return-due date (the old code even had a no-op `prevStatuses` loop admitting it). Fixed: `submitActionNew` now snapshots each bike's assignment (`assignment_type`, `assigned_to`, `customer_name`, `fareharbor_booking_ref`, `return_due`, note) into `state.action._preReturn` BEFORE the return wipes it, and the undo restores those exact values via the checkout endpoint (which already accepts all of them; note the GET returns the note as `status_note`). Also made undo reachable: `toast()` takes an optional `{undo:true}` to render an inline "Undo" button (6s instead of 1.8s, so there's time to hit it), and action success toasts now show it whenever an undo is registered. The toolbar undo button still works as before.

- **2026-07-12 (brain SPLIT OUT into standalone service — fleet app untouched):** Reverted all brain code from the fleet app (`src/server.js` has ZERO brain references; `src/routes/brain.js` and `public/brain.html` deleted). Rationale: Federico repeatedly flagged "don't break the app" — sharing a process means sharing failure modes, and the fleet app is load-bearing for daily shop/guide ops while the brain is analytics. Not worth the coupling. The brain now lives in `brain/` as a **fully independent service**: own `package.json`, own express instance, own pm2 process (`bc-brain`, see `brain/ecosystem.config.js`), own port (3001). If it crashes, bc-fleet doesn't notice. Reads the fleet DB **read-only** via ATTACH with `mode=ro` (SQLite refuses writes at the file-handle level; tested — UPDATE/DELETE/DROP all fail). Own auth: single user, email + scrypt-hashed password, set by Federico via `node brain/hash-password.js` (password never in code, never committed, never seen by Claude). Files: `brain/server.js`, `brain/public/index.html` (login + chat + CSV upload PWA), `brain/load.js`, `brain/schema.txt` (the schema doc Claude reasons against), `brain/probe-historical-occupancy.js`. Deploy: `cd brain && npm install && pm2 start ecosystem.config.js`. NOTE: the VPS had gone stale (was 7 commits behind on `de2884c`, hence "/brain 404s" — the code had simply never landed); a plain `git pull` fixes it, working tree was clean apart from package-lock and untracked debug scripts.

- **2026-07-12 (brain: fleet DB joined in — occupancy + guides now answerable):** `src/routes/brain.js` now ATTACHes the live fleet DB as `fleet`, **read-only**, into the brain's query session (`file:...?mode=ro`). No copy, no sync — always live. Unlocks the two questions the CSV exports structurally cannot answer: true occupancy / empty departures (`fleet.tour_availabilities` is the only source of departures that sold ZERO bookings) and guide performance (`fleet.tour_availabilities.guide`, `fleet.guide_tour_hours`, `fleet.guide_reviews`). SAFETY (explicitly tested): two independent layers protect the app's data — the runSelect guard rejects anything but SELECT/WITH, and the file handle is opened mode=ro so SQLite itself refuses writes. Verified UPDATE/DELETE/DROP against fleet.* all fail with "attempt to write a readonly database" and the data is unchanged afterward. Schema doc warns Claude that fleet.* only spans a few months (vs 2023+ for bookings/sales) so it must not present long-run trends from it.

- **2026-07-12 (data brain + chat PWA — WORKING):** Pivoted away from the weekly-report-CSV-pipeline approach (was over-engineered, and pre-aggregated summary reports can't answer arbitrary questions). Built instead a **queryable data brain**. Two DETAILED FareHarbor exports (bookings + sales, full history 2023->now, all columns) load into a purpose-built SQLite analytics DB (`scripts/brain/analytics.db`) via `scripts/brain/load.py`, which derives the columns that make questions answerable: booked_dow vs tour_dow, lead_days, channel + commission_rate (GYG 0.30, most OTAs 0.20, direct 0), item_category (tour_group/tour_private/rental/gift_card), cancel_days_before_tour, revenue_per_pax. 3,174 bookings + 3,551 sales txns loaded. Two data bugs found and fixed by testing against real data: FareHarbor appends a grand-totals row (was poisoning aggregates with a phantom 3.5M DKK booking), and it writes 'Cancelled' not 'Yes' in the Cancelled? column (cancellations were silently invisible). **Chat UI**: `/brain` page (`public/brain.html`) mounted in the existing fleet PWA — reuses its session auth, deploy, and design tokens rather than being a separate app. `src/routes/brain.js` exposes POST /api/brain/ask (Claude writes SQL -> server runs it read-only -> Claude explains the rows; hard guard rejects anything but SELECT/WITH, and self-repairs a failed query once), GET /api/brain/status, POST /api/brain/upload (drop in the two weekly CSVs -> rebuilds the DB). Uses ANTHROPIC_API_KEY_REPORTS (separate Console workspace, so cost is tracked apart from the Haiku voice key). Model: claude-sonnet-5. CLI equivalent also exists: `node scripts/brain/ask.js "question"`. First real findings: Sunday is the #1 BOOKING day (478) but only 5th busiest TOUR day; 09:30 is the strongest start time over full history; cancellation rate is 0.63%, but Airbnb cancels ~10x more than direct. KNOWN GAPS: zero-booking departures aren't in booking exports (true occupancy needs fleet DB `tour_availabilities`), and guide assignment likewise. OPEN: join fleet DB for occupancy/guide questions; weekly Monday email on top of the brain.

- **2026-07-09 (External bikes + Today-board summary regrouped):** (1) **External/lifesaver bikes** (borrowed from the rental shop across the street): `scripts/fixes/add-external-bikes.js` adds an "External" bike type (id EXT) + reusable placeholders EXT1..EXT6, so a borrowed bike checks out/returns like any fleet bike and flows through the Today board. Added `addExternalBike()` (grabs the next free External placeholder) and a "+ External bike (borrowed)" button in the checkout bike-picker (shown for rental/tour/city/borrowed action types). (2) **Today board "Bikes needed" regrouped** by TOURS vs RENTALS (Fede thinks in those terms, not bike-type words): "For tours (peak at once)" uses the smart overlap peak per category; "For rentals" sums today's rental bikes per category. Relabeled category A "Touring"→"Regular". NOTE: category labels (Regular/E-bike/Guided/…) are still my best guess for the booking-parse codes A/E/GT/B/AC/AT/SA — pending Fede confirming the real names.

- **2026-07-09 (Today board / shop manifest):** New `renderTodayBoard(c)` — a day manifest for the shop. Three parts: (1) **Bikes needed today** per category, where tours use a sweep-line PEAK: each tour holds its bikes from start-10min to end+20min, so non-overlapping tours share bikes (morning 8 + afternoon 9, 30-min gap → 9, verified); rentals add a flat baseline (multi-day → occupy all day, so summed from today's pickups). needed = tourPeak + rentalBaseline per category (A/E/GT/etc via CAT_LABELS). (2) **Schedule** — today's tour departures + rental pickups, time-sorted, each tappable (tour → openTourDetail to record bikes; rental → openRentalDetail; rentals show ✓ with assigned bike IDs when handed out). (3) **Due back today** — bikes `out` with return_due today. Placement: **mechanic (Zac)** gets a top-level "Today" tab (first); **admin** gets it as the first Operations sub-tab (so Hassan/Fede see it). Not shown to guides. Helpers: `hhmmToMin`, `CAT_LABELS`/`catLabel`, `iconToday`. Known v1 limits (flagged to Fede): rentals already out from prior days aren't in the peak baseline (only today's pickups); tours don't show a "done" badge (no clean tour↔bike ref link). NEXT (proposed): a per-person tab-visibility/permissions system so Fede can curate each person's set (the "shopkeeper set" etc.) instead of role-fixed tabs.

- **2026-07-09 (rental detail: show & return checked-out bikes):** Tapping a handed-out (grayed) rental previously only re-offered "Check out bikes" with no way to see or manage what was already out. `openRentalDetail` now also fetches `/api/bikes`, finds bikes currently `out` against the booking's ref, and lists them ("Bikes checked out (N)" with id · name · due). When bikes are out it shows "Return these bikes" (→ `goReturnForRental` pre-loads them into a return action) plus "Check out more bikes"; when none are out it shows "Check out bikes" as before. `goReturnForRental(bikeIds)` opens the Action screen, pre-loads the bikes, and calls `selectActionType('return')`.

- **2026-07-09 (rentals: de-emphasize handled bookings + link checkout to booking):** (1) Checking out an existing rental booking now links the bikes to it: `renderActionDetails('rental')` adds a hidden `af-ref` pre-filled with `fb.ref`, so the existing submit path stores `fareharbor_booking_ref` on the checked-out bike (previously only walk-ins that created a FareHarbor booking got a ref). (2) The Rentals list now marks a booking as handled when a bike is currently `out` against its ref: `renderRentals` loads `/api/bikes`, builds a set of out-bike refs, and `renderRentalsList` sinks handled bookings to the bottom of their day, dims them (opacity 0.5), and adds a "✓ bikes out" badge — still findable, just de-emphasized vs. bookings still needing bikes. Only applies to checkouts made after this deploy (older ones weren't ref-linked).

- **2026-07-09 (recode guided bike IDs):** `scripts/fixes/recode-guided-bikes.js` renames guided-tour bike primary keys — "Guided Bike" `GTn -> Gn` (keeps number), "Guided Bike Small" `GTn -> GSn` (renumbered GS1, GS2 by current id). Because the bike id is a PK referenced by six tables (`bike_status`, `bike_configurations`, `batteries.paired_bike_id`, `action_log`, `repair_tickets`, `assignment_bikes`) and `foreign_keys=ON`, the swap runs with FK temporarily off inside one transaction, updating the bike and all references together, then verifies no dangling refs. Dry-run by default (prints the full old->new mapping + per-table ref counts); `--commit` applies. Mapping is driven by bike type, so it also confirms whether the earlier Guided-Bike-Small split/reassignment actually happened.

- **2026-07-09 (rental checkout: simpler for existing bookings):** When "Check out bikes" is used on an existing FareHarbor rental booking, `goCheckoutForRental` now sets `state.action.fromBooking`, and the rental form (`renderActionDetails('rental')`) adapts: it shows a compact header (customer name · #ref) with the pre-filled fields tucked under an openable "Booking & payment details" toggle, and the "Create booking in FareHarbor" toggle defaults **off** (the booking already exists, so no duplicate). Walk-in rentals are unchanged — full form, FareHarbor toggle on. `fromBooking` is cleared by the existing state.action resets on Back/submit, so the next walk-in shows the full form.

- **2026-07-09 (Rentals: one booking per detail + working checkout):** Two bugs in the Rentals view. (1) The rental card's onclick passed only `_avail_id`, so `openRentalDetail` listed EVERY booking in that slot; now it also passes `b.ref` and shows just the clicked booking. Rewrote `openRentalDetail(availId, ref)` to render one booking's details (customer, #ref, phone, email, what, comments). (2) The "Check out bikes" button did `closeModal();renderTab('action')` with no context — nothing useful happened. Added `goCheckoutForRental(b)`: opens the Action screen, calls `selectActionType('rental')`, and pre-fills `af-name`/`af-phone`/`af-email` from the booking, so the user lands straight in the rental bike-picker with the customer filled and just selects the bike(s). (Possible follow-up: also pass the FareHarbor booking ref into the checkout so the bike is linked to the booking.)

- **2026-07-09 (tours guide filter dedup + chronological reviews):** (1) The Tours guide filter listed raw distinct `t.guide` strings, so a guide under multiple names (e.g. "Pam" and "Paloma Lopez Garcia-Pelayo") appeared twice. Now each raw guide name is collapsed to its canonical team member via `guideMatches` (falling back to the raw name for guides not on the team), and filtering uses `guideMatches(t.guide, selected)` instead of `===`, so Paloma shows once and selecting her catches all her tours. (2) The admin Reviews list (`renderAdminReviews`) was grouped by guide; now it's a flat chronological list, latest first (sorted by review_date desc, then id desc), with the guide name shown on each row. The log-a-review tool at the top is unchanged.

- **2026-07-09 (housekeeping):** Convention going forward — **clean as we go**: one-off `diag-*` / `capture-*` investigation scripts are removed once the question is answered; only reusable tools (`test-*`) and historical data migrations (`backfill-*`, `fix-*`, `reset-*`, `restore-*`, `split-*`) stay in `scripts/fixes/`. Removed six spent diagnostics: `diag-cancellations.js`, `diag-first-booking-email.js`, `diag-guide-hours.js`, `diag-tour-cancel-dupe.js`, `scripts/fareharbor-agent/diag-real-booking-dates.js`, `scripts/fareharbor-agent/capture-bookings-response.js`. (Their findings are preserved in the session-log entries above.)

- **2026-07-09 (worked-hours bug: today's tours never counted):** Féidhlim showed 0 worked despite a completed L3 that morning. Root cause: the `/api/ical/guide-hours` worked/upcoming split compared the raw ISO `start_at` (e.g. `2026-07-09T10:30:00Z`, with a 'T') as a plain string against SQLite `datetime('now')` (space-separated). Since 'T' sorts after a space, ANY tour dated today sorted as future, so today's completed tours never counted as "worked" until the date rolled over. Fixed by wrapping both comparisons in `datetime(start_at)` so SQLite parses the timestamp before comparing. Affected every guide's same-day completed tours, not just Féidhlim (his only completed tour was today's). Note: a residual ~2h skew remains because iCal stores start_at as local-time-labelled-Z while v2 stores it with a real offset — minor for whole-tour "has it started" and pre-existing. `scripts/fixes/diag-guide-hours.js` added/fixed to use `new Date()` parsing.

- **2026-07-09 (weekly FareHarbor intelligence report — scaffolding, discovery pending):** Started a new `scripts/weekly-report/` module: an automated weekly business brief that reads the fleet DB + pulls FareHarbor's own reports, has Claude (Sonnet 5) synthesize a comprehensive narrative with anomaly flags, and emails it to Federico Monday mornings. Reuses existing infra deliberately — the fleet SQLite DB (feeds itself, no manual export), `src/email.js` sendEmail, the FareHarbor Playwright login from `scrape-guide-schedule-v2.js`, and `/etc/environment`. Kept in the fleet repo (not a separate repo) because it depends on all four. Files so far: `analyze.js` (DB reader — revenue/bookings WoW, YoY when history exists, OTA channel mix from `bookings.source`, per-product occupancy, bike-rental performance; tested end-to-end on a synthetic DB), `config.js` (capacities/rental-types/test-sources), `discover-reports.js` (the WATCHED first-run discovery tool — logs in headed, visits each weekly-core FareHarbor report, and reports back how each exposes CSV export, so the real fetcher is built from reality not guesswork). Scope decision: NOT all ~35 FareHarbor reports weekly (noise) — a curated ~11 weekly-core set (Sales/Bookings by item, Item occupancy [gives native occupancy, removes need to hardcode caps], Affiliates+Booking source, Pace Report [native forward-look], Cancelled, Crew, Revenue by type, Sales-Payout Reconciliation, Underpaid) + secondary detail; billing/tax/invoice reports deferred to a separate monthly job. Cost isolated via a dedicated Anthropic Console **workspace + scoped key** (`ANTHROPIC_API_KEY_REPORTS`), separate from the Haiku voice key. OPEN: run `discover-reports.js` headed, paste output, then build the real report-CSV fetcher + YoY FareHarbor pull + Sonnet synthesis + Monday cron. Nothing wired to cron yet — inert until then.

- **2026-07-09 (duplicate guard now compares content, not just subject):** The duplicate-email guard fired for two genuinely-different Monica reviews that shared the generic subject "New 5⭐ review for you — Airbnb". Per Fede's request, the guard now compares recipient + subject + **content hash** (sha1 of htmlContent, first 16 chars), so two different emails with the same subject (different review text) no longer false-flag, while a true re-fire (identical body) still does. Added `content_hash` column to `emails_sent` (+ migration); `sendEmail` computes it, `logEmail` stores it, `maybeAlertDuplicate` matches on it. The `new_review` email already includes the review text (a `reviewBlock` shown when review_text is entered) — entering the text/reviewer both improves the guide's email and guarantees distinct content. Verified: different content passes, identical content flags.

- **2026-07-09 (mechanic Fleet access + guided-bike category split):** (1) Added the **Fleet** tab to the mechanic role's tab set (Zac), so he can edit bike info — the `/api/fleet/*` routes have no role gate, so this was a pure frontend change; the bike edit form already has a type dropdown for reassignment. Mechanic tabs are now Action · Tickets · Tours · Bikes · Fleet · Profile (6). (2) `scripts/fixes/split-guided-bike-type.js` renames the live "Guided Tour Bikes" bike_type to **"Guided Bike"** (keeping its id so nothing referencing it breaks) and creates a new **"Guided Bike Small"** type (copying fareharbor_resource + rental value). The 2 small bikes are then moved via the Fleet UI. Verified no code hard-codes the guided type id in rental/availability logic, and v2's GT extraction keys off the FareHarbor resource ID (unaffected by the internal split).

- **2026-07-09 (Operations: add Actions sub-tab):** Added **Actions** as the first sub-tab of the admin Operations section (was Tours · Rentals · Bikes · Tickets → now Actions · Tours · Rentals · Bikes · Tickets), rendering the shop quick-action screen via `renderAction(el)`. Made it the default Operations tab. Rewrote `renderOperations`/`switchOpsTab` to use `data-opstab` attributes instead of brittle `textContent`-matching for active state.

- **2026-07-09 (duplicate-alert caught a real clarity gap):** The duplicate-email guard fired for two "Tour cancelled — F3 on Sunday 12 July" emails to Paloma sent 1s apart. Diagnosed (`diag-tour-cancel-dupe.js`): NOT a dedup bug and NOT a tug-of-war — they were two distinct F3 availabilities (2083926004, 2083926005, different time slots) both legitimately cancelled in one v2 run, each with its own `tour_cancel_notified` claim. They only looked identical because per-slot email subjects carried the date but not the time. Fix: added `start_time` to the subjects of tour_cancelled (iCal + v2), first_booking, and zero_bookings (tour_reminder already had it), guarded for missing time. Also note: local working clone had silently rolled back to c2b084c mid-session; re-synced with `git reset --hard origin/main` (all pushed work was safe on origin) — worth `git fetch` + status check at the start of a session if resuming.

- **2026-07-08 (richer Page Visits):** Page Visits previously showed only aggregate per-person tab counts — no times, no totals, no sense of who's active now. Enriched `loadPageVisits` (uses only existing `page_views` data: actor, tab, created_at) into three parts: a summary bar (total visits · distinct people · busiest tab), per-person rows sorted most-recently-active-first showing last-active relative time + total visits + tab breakdown, and a chronological "Recent activity" feed of the 50 newest visits (time-ago · person · tab). Added a shared `timeAgo()` helper next to `fmtTime` (parses SQLite UTC "YYYY-MM-DD HH:MM:SS"). No API/schema change. (Session/device/duration would need new columns on page_views — not done.)

- **2026-07-08 (declutter Admin → App):** The App section had 9 flat sub-tabs crammed in one row (Log, Changes, Bookings, Webhooks, Emails, Visits, Invoicing, Bugs, View as). Reduced to 5 top-level tabs — **Bookings · Invoicing · Bugs · Logs · View as** — by grouping the five rarely-used diagnostic logs (Action log, Tour changes, Webhooks, Sent emails, Page visits) behind a single **Logs** tab with a secondary `.chip-row` picker. Rewrote `renderAppAdmin`/`switchAppAdminTab` to use `data-apptab` attributes (dropped the brittle `textContent === label` active-state matching); added `renderAppLogs`/`switchAppLog`/`renderCurrentLog`. Default tab changed from 'log' to 'bookings-history'. Fixed the impersonation "View as" jump to set `_appAdminTab` before `renderTab('app-admin')` (was set after, racily). Nothing removed — every log is still one tap away.

- **2026-07-08 (UI polish pass — motion, feedback, skeletons):** Added a presentation-only polish layer, all five items Fede approved: (1) **Motion** — toast slides/fades in (layout slot unchanged, so no new layout cost), modal bottom-sheet now slides up/down with a fading backdrop (`.modal-overlay.hidden` changed from `display:none` to `opacity:0; pointer-events:none` to make it animatable — verified nothing reads its display state; `closeModal` clears content after the 240ms slide-out, with a reopen-race guard `closeModal._clearTimer`), tab content fades in via `.content.tab-enter`. (2) **Press feedback** — `:active { transform: scale(0.96) }` on all tappable classes (.btn, .icon-btn, .subtab, .tab-btn, .type-card, .report-bug-btn, .toast-undo-btn, .modal-close). (3) **Skeleton loading** — `renderTab` shows shimmer placeholders (`skeletonHTML()`) before every async tab render ('action' excluded — it's synchronous). (4) **Success checkmark** — success toasts prepend a self-drawing SVG check (`.toast-check`, stroke-dashoffset animation). (5) **Number tickers** — `animateCounts()` ticks `.tc-avail` fleet-availability numbers up over 300ms after render. Performance constraints throughout: only transform/opacity animated (GPU-composited), everything ≤250ms, and a global `prefers-reduced-motion` override disables all of it. Pure styling layer — removable without functional change.

- **2026-07-08 (UI + team polish):** Topbar: removed the BETA badge; turned the bug-report icon into a text "Report a bug" button (`.report-bug-btn`, kept id `#btn-report-bug`); removed the guide-only burger (`#btn-more-menu`) — note this was the guides' shortcut to Rentals + Bikes, so those are no longer reachable for guides (flag if they need relocating; the openMoreMenu JS remains as dead-but-safe `?.` no-ops). Team: renamed display names **Fede→Federico** and **Pam→Paloma**; added an `is_guide` column to `team_members` and flagged the two admins who also run tours (Federico, Hassan) plus all `role='guide'` members, so the Guides & Tours list (`app.js` `renderGuidesAdmin`, filter now `role==='guide' || is_guide`) shows them — Søren (admin) is correctly excluded. All applied to the live DB via a one-time `migrate()` block (runs on restart when `is_guide` is added), plus seed.js updated for fresh DBs. Guide-name matching unaffected (Federico/Paloma still substring-match the FareHarbor crew names).

- **2026-07-08 (duplicate-email alert + faithful test emails):** (1) Added a **duplicate-send guard** in `email.js` (`maybeAlertDuplicate`, runs inside `sendEmail`): automated notifications are all once-only, so if the identical email (same recipient + subject, monitored category) was already sent within ~70 min, it emails an urgent alert to `federico@becopenhagen.dk` — this catches the class of bug where an hourly job re-fires a once-only email (as the invoice_reminder bug would have). Transactional emails (no category) and the alert itself are excluded; alerts are deduped to once per incident per 12h so a persistent bug can't spam. (2) Confirmed all real notification emails already include full detail (tour name, date, time, guest list, review text) — the earlier `test-all-emails.js` used oversimplified stubs, which is what looked thin. Rewrote it to mirror the real templates, filled with a real upcoming tour's data + sample review text, so the test now shows what guides actually receive. Note: test samples still duplicate the production templates by hand — a future `src/email-templates.js` shared module would make them guaranteed-identical (offered, not yet done).

- **2026-07-08 (email-notification audit):** Audited every email notification (verify-first, per Fede). Findings: **first_booking** — fixed earlier this session (webhook race). **zero_bookings** — verified NOT racy and left unchanged: the webhook only bumps booking_count up (cancels return early without touching it), so the 1→0 drop always happens via iCal, which reliably catches it. **invoice_reminder** — BUG FOUND & FIXED: the monthly "mark as sent" `.run(reminderKey, '1')` passed an extra bind param to a 1-placeholder statement → threw "column index out of range" every time → never marked sent → would re-send to every guide every hour on the 20th. Now `.run(reminderKey)`. **tour_cancelled** — was sent by BOTH ical.js (delete section) and the v2 scraper (deletion pass), risking a double email; added a `tour_cancel_notified` dedup table and an `INSERT OR IGNORE ... changes` claim in both so whoever detects the cancellation first sends and the other skips. **tour_reminder** (dedup table, solid), **tour_assigned** (v2, once per assignment), **new_review**/**invoice_to_soren** (event-driven), **verification_code**/**password_reset** (transactional) — all checked, no issues. Obsolete v1 scraper (`scrape-guide-schedule.js`) still has a dead email call; not running. Added `scripts/fixes/test-all-emails.js` (sends one of every type to only a given address) and `test-first-booking-email.js` for safe verification.

- **2026-07-08 (booking-date backfill + first-booking email race):** Two data-correctness fixes after the sync-ownership work. (1) **Booking created_at backfill:** many tours showed a booking date of ~7 July (the `first_seen_at` fallback) because those bookings predate our webhook and never had a true `created_at`, which wrongly hid the "Can keep bikes after tour" flag (threshold: booked before 1 July). Confirmed via diagnostic that FareHarbor's per-availability bookings API (`/api/v1/companies/becopenhagen/items/{item}/availabilities/{avail}/bookings/`, usable directly with the logged-in cookies) returns the real `created_at`/`original_created_at`. `scripts/fixes/backfill-real-created-at-from-fareharbor.js` (dry-run by default) backfilled 47 bookings across 34 tours, all confirmed pre-1-July; uses the earlier of created_at/original_created_at so rescheduled-but-originally-early bookings keep old conditions. (2) **First-booking email wasn't firing:** diagnostic proved the cause — the webhook bumps `booking_count` to 1 (~6s after booking) before the 90s iCal sync runs, so iCal never saw the 0→1 transition its first-booking email/alert depended on. Fixed by moving the trigger into `src/notify-first-booking.js`, called by BOTH the webhook (real-time) and ical.js (covers Airbnb, which fires no webhook), guarded by an atomic claim on the new `tour_availabilities.first_booking_notified` column so it fires exactly once. Migration marks all already-booked tours notified to avoid a retro-email flood; a slot emptying re-arms it. The guide-name accent case (Feidhlim vs Féidhlim) was verified fine — `normalizeName` strips accents. Note: the zero-bookings email likely has the same webhook-race and hasn't been fixed yet.

- **2026-07-08 (sync-ownership refactor — in progress):** Stepped back from reactive bug-fixing to plan the FareHarbor→app sync as a whole. Audited the three writers (iCal 90s poll, webhook on booking events, v2 hourly scraper) against the real code and found the root disease behind most recent bugs: **iCal and v2 are two near-duplicate upserters to `tour_availabilities` with no per-field ownership**, so they overwrite each other every cycle (last writer wins; iCal wins ~39/40 by frequency, so the fast-but-fuzzy source usually beats the slow-but-accurate one). Governing principle agreed with Fede: **one owner per field**, enforced by making each writer touch a disjoint set of fields. Plan is three deploy-and-eyeball steps: (1) **bikes — DONE** (per-key merge, see below / §2); (2) **guide — DONE** (v2 authoritative; iCal parses a `guide_confident` flag and writes only a confident real-account-name via `COALESCE(excluded.guide, guide)`, so it fills blanks and fast reassignments but never clobbers v2 with a guess — see §2); (3) **freeze finished tours — DONE** + **duration unified — DONE**: once a tour's day has passed, iCal no longer recomputes its `tour_availabilities` or `guide_tour_hours` record (v2 already skips past days via its `start_date < todayStr` continue), so past tours are immutable and a later formula change only affects future tours — changing a past tour now requires a deliberate `scripts/fixes/` migration; a past tour first seen with no prior row is still snapshotted once. The duplicated duration-buffer logic (iCal's `computeBufferedMinutes` vs v2's inline `buffer=isFoodTour?60:30`, the exact shape that let the F3 duration drift) is now a single shared `src/tour-duration.js` imported by both; the merged version also uses a sensible 240/210 fallback for missing/invalid times instead of iCal's old 0. **Step 1 shipped:** `bikes_needed` now merges per-key via atomic `json_set` in both upserts (iCal owns A/E/B/AC/AT, v2 owns GT), `total_bikes` recomputed as the combined sum — verified stable across repeated iCal/v2 cycles on a mixed tour, ending the oscillation; self-heals within one v2 cycle, no migration. Also noticed while auditing: `cancel-booking.js` now exists (older doc note said it didn't), and `routes/guides.js` + `routes/reviews.js` are not yet in the §3 directory map.
- **2026-07-08 (prior session):** v2 guide-schedule scraper (internal API rewrite, ~90s vs ~40min); Alerts system + admin notifications table; comprehensive activity logging (tour changes, page views, sent emails, raw webhooks) with 120-day retention; permanent bookings ledger; GT bike category + 11 new bikes; guide cross-check; `getActor()`/`X-View-As` rewrite of impersonation (no session mutation); `guide-name-match.js` extracted as shared module; `scripts/fixes/` convention established and enforced for all data migrations; F3/F3P duration fix shipped and **confirmed**; fixed broken "Send invoice to Søren" route; `CLAUDE_CONTEXT.md` created and established as a living document updated every commit; root-caused and fixed the "Can keep bikes after tour" bug (webhook-set `created_at` was being silently wiped by every iCal sync) with backfill migration + "first seen" fallback for Airbnb bookings (which never fire our webhook); bike-count resource trust tightened twice more after finding stale-frozen-data and pool-capacity-vs-per-booking-count failure modes — now only the specific "Guided Tour Bikes" resource (by ID) is ever trusted, with `reset-tour-bike-data.js` migration to clear bad stored values.
