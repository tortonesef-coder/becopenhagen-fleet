const express = require('express');
const session = require('express-session');
const path = require('path');
const { getDb } = require('./db/schema');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'bc-fleet-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Session middleware - attach actor to all requests
app.use((req, res, next) => {
  req.actor = req.session?.actor || null;
  next();
});

// API routes
app.use('/api', require('./routes/api'));
app.use('/api/voice', require('./routes/voice'));

// Session routes
app.post('/session/login', (req, res) => {
  const { actor_id } = req.body;
  const db = getDb();
  const member = db.prepare('SELECT * FROM team_members WHERE id = ? AND active = 1').get(actor_id);
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
  res.json({
    actor: {
      id: req.session.actor,
      name: req.session.actor_name,
      role: req.session.actor_role
    }
  });
});

// All other routes serve the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Init DB on start
getDb();

app.listen(PORT, () => {
  console.log(`BeCopenhagen Fleet Tracker running on http://localhost:${PORT}`);
});

module.exports = app;
