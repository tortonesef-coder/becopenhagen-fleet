const express = require('express');
const session = require('express-session');
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
  secret: process.env.SESSION_SECRET || 'bc-fleet-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
  req.actor = req.session?.actor || null;
  next();
});

app.use('/api/voice', require('./routes/voice'));
app.use('/webhooks', require('./routes/webhooks'));
app.use('/api/repairs', require('./routes/repairs'));
app.use('/api/fleet', require('./routes/fleet'));
app.use('/api', require('./routes/api'));

app.post('/session/login', (req, res) => {
  const { actor_id } = req.body;
  const db = getDb();
  const member = db.prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(actor_id);
  if (!member) return res.status(400).json({ error: 'Unknown team member' });
  req.session.actor = member.id;
  req.session.actor_name = member.name;
  req.session.actor_role = member.role;
  res.json({ ok: true, actor: member });
});

app.post('/session/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/session/me', (req, res) => {
  if (!req.session.actor) return res.json({ actor: null });
  res.json({ actor: { id: req.session.actor, name: req.session.actor_name, role: req.session.actor_role }});
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

getDb();

app.listen(PORT, () => {
  console.log(`BC Fleet running on port ${PORT}`);
  console.log('OpenAI key:', process.env.OPENAI_API_KEY ? 'SET' : 'MISSING');
  console.log('Anthropic key:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
});

module.exports = app;
