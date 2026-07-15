# Claude Code entry point — READ THIS FIRST

1. **Read `CLAUDE_CONTEXT.md` in full before doing anything.** It is the living
   memory of this project: architecture, domain model, FareHarbor quirks, data
   ownership rules (which writer owns which fields), and a dated session log of
   every change and why. Update its "## 8. Session Log" (newest entry on top)
   in the same commit as any change you make.

2. **This app is LIVE.** Real bookings, real guides, real customers.
   - Verify first with read-only diagnostics against real data; fix code only
     after the data confirms the cause. Never assume.
   - Never run destructive SQL (DELETE/UPDATE on live tables) without showing
     Federico the exact statement and getting a yes.
   - The database is `data/fleet.db` (SQLite, WAL). The app (pm2: `bc-fleet`)
     and the hourly FareHarbor scraper both write to it.

3. **Deploy** = `git pull && pm2 restart bc-fleet --update-env` in
   `/var/www/becopenhagen-fleet`. The iCal sync runs INSIDE the app process, so
   changes to `src/routes/ical.js` need the restart to take effect.

4. **Ownership rules that keep the two writers from fighting** (details in
   CLAUDE_CONTEXT.md): the v2 scraper owns tour bike counts (from FareHarbor
   resources) and tour pax; iCal owns rental bike counts and may only delete
   rows within its own feed horizon. booking_count on tours means PEOPLE (pax),
   not reservations.

5. Clean as you go: one-off diagnostic scripts get deleted once they've
   answered their question; reusable ones live in `scripts/fixes/`.
