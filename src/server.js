const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');
const { getDb } = require('./db/schema');

// Load env vars from /etc/environment (pm2 doesn't inherit them automatically)
try {
  fs.readFileSync('/etc/environment','utf8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g,'');
  });
} catch(e) {}

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new FileStore({
    path: path.join(__dirname, '../data/sessions'),
    ttl: 30 * 24 * 60 * 60,
    retries: 0,
    logFn: () => {},
  }),
  secret: process.env.SESSION_SECRET || 'bc-fleet-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Serve index.html with cache-busting version stamp (git commit hash)
const { execSync } = require('child_process');
let APP_VERSION = 'dev';
try { APP_VERSION = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch(e) {}
// Ensure the repo's versioned hooks are active (git doesn't auto-trust hooks
// from a clone). Enforces the CLAUDE_CONTEXT.md-on-every-commit convention for
// anyone committing on this machine, incl. Claude Code sessions.
try { execSync('git config core.hooksPath .githooks', { cwd: path.join(__dirname, '..') }); } catch(e) {}

const indexHtml = require('fs').readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8');
const indexHtmlVersioned = indexHtml.replace(/__VERSION__/g, APP_VERSION);

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(indexHtmlVersioned);
});

app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
  // Shop mode: every action is initially logged as 'shop' and attributed retroactively
  if (req.session?.shop_mode) {
    req.session.actor = 'shop';
    req.session.actor_name = 'Shop';
  }

  req.actor = req.session?.actor || null;
  next();
});

app.use('/api/voice', require('./routes/voice'));
app.use('/webhooks', require('./routes/webhooks'));
const { router: icalRouter, startPolling } = require('./routes/ical');
app.use('/api/ical', icalRouter);
app.use('/api/repairs', require('./routes/repairs'));
app.use('/api/fleet', require('./routes/fleet'));
app.use('/auth', require('./routes/auth'));
app.use('/api/fareharbor-agent', require('./routes/fareharbor-agent'));
app.use('/api/guides', require('./routes/guides'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/notif-prefs', require('./routes/notif-prefs').router);
app.use('/api/admin-notifs', require('./routes/admin-notifs').router);
app.use('/api', require('./routes/api'));

app.post('/session/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.post('/session/shop-logout-actor', (req, res) => {
  // Clears just the current shop actor, keeps shop_mode active for next person
  req.session.shop_actor = null;
  req.session.shop_actor_name = null;
  res.json({ ok: true });
});

app.get('/session/me', (req, res) => {
  if (req.session?.shop_mode) {
    if (req.session.shop_actor) {
      return res.json({ actor: { id: req.session.shop_actor, name: req.session.shop_actor_name, role: 'shop' }, shop_mode: true });
    }
    return res.json({ actor: null, shop_mode: true });
  }
  if (!req.session.actor) return res.json({ actor: null });
  // Read the member fresh so the restored session carries CAPABILITIES too
  // (can_shop / is_guide / view_mode). Without these the view switcher would
  // disappear on every page refresh, and tabs would fall back to role-only.
  const m = getDb().prepare('SELECT id, name, role, is_guide, can_shop, view_mode FROM team_members WHERE id=? AND active=1').get(req.session.actor);
  if (!m) return res.json({ actor: null });
  res.json({ actor: { id: m.id, name: m.name, role: m.role, is_guide: m.is_guide, can_shop: m.can_shop, view_mode: m.view_mode }});
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

getDb();

// Start iCal polling after DB is ready
startPolling();

// Start 16h-before tour reminders (runs every hour)
require('./tour-reminders').startReminders();

// Start log retention cleanup (120 days, runs daily)
require('./log-retention').startLogRetention();
require('./scraper-heartbeat').startHeartbeat();

app.listen(PORT, () => {
  console.log(`BC Fleet running on port ${PORT}`);
  console.log('OpenAI key:', process.env.OPENAI_API_KEY ? 'SET' : 'MISSING');
  console.log('Anthropic key:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
  console.log('SMTP:', process.env.SMTP_HOST ? `${process.env.SMTP_HOST}:${process.env.SMTP_PORT} user=${process.env.SMTP_USER} pass=${process.env.SMTP_PASSWORD?'SET':'MISSING'}` : 'NOT CONFIGURED');
});

module.exports = app;
