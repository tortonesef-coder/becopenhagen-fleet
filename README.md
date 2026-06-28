# BeCopenhagen Fleet Tracker — Session 1

## What's in this build
- Full bike database (91 bikes, all types, pre-seeded from your spreadsheet)
- 11 batteries paired to e-bikes
- Team member identity (Fede, Hassan, Zac, Pam, Féidhlim, Ibrahim, Monica, Andrew, Desk)
- Desk view: availability by type + adult pool counter
- Bikes view: searchable/filterable full fleet list
- Return tab: morning bulk return flow (type IDs, confirm all at once)
- Log tab: full action history
- Bike detail: checkout, return, repair ticket modals
- Action log: every action stamped with who + when

## Deploy to VPS

### 1. Upload files
```bash
scp -r becopenhagen-fleet/ user@life.interestingtours.dk:/var/www/
```

### 2. On the VPS
```bash
cd /var/www/becopenhagen-fleet
npm install
npm run seed        # loads all bikes into the database
```

### 3. Set environment variables
```bash
export SESSION_SECRET="your-long-random-secret-here"
export PORT=3456
export DB_PATH="/var/data/fleet.db"
```

### 4. Start with pm2
```bash
pm2 start npm --name "bc-fleet" -- start
pm2 save
```

### 5. Caddy config (add to your Caddyfile)
```
fleet.interestingtours.dk {
    reverse_proxy localhost:3456
}
```

## Node version note
Requires Node 22+ (uses built-in SQLite). Check with `node --version`.
If on older Node, install better-sqlite3 instead:
```bash
npm install better-sqlite3
```
And update src/db/schema.js to use `require('better-sqlite3')` instead of `require('node:sqlite')`.

## Sessions
No passwords. Each person picks their name when they open the app.
Session persists for 24 hours. Add `--https` to Caddy for secure cookies in production.

## Coming in Session 2
- Voice check-out/check-in (speech-to-text API)
- FareHarbor webhook receiver (auto-creates pending assignments)
- Guide view with tour bike list
- Pending assignment workflow

## Coming in Session 3
- Full repair ticket queue for Zac
- Repair priority scoring system
- Repair history and duration tracking

## Coming in Session 4
- Browser agent for FareHarbor resource overrides
- Admin view with bike management

## Database location
Default: `./data/fleet.db`
Override with `DB_PATH` environment variable.
Back this file up regularly — it's your entire fleet record.
