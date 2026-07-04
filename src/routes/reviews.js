const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { sendEmail } = require('../email');

function db() { return getDb(); }

function requireAdmin(req, res, next) {
  if (req.session?.actor_role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

const PLATFORMS = ['Google Maps', 'GetYourGuide', 'Viator', 'TripAdvisor', 'Airbnb'];
const BOOKING_TYPES = ['Tour', 'Rental'];

// POST /api/reviews — log a new review (admin only)
router.post('/', requireAdmin, async (req, res) => {
  const { guide_id, review_date, reviewer_name, platform, booking_type, review_text } = req.body;
  const actor = req.session?.actor || 'unknown';

  if (!guide_id || !review_date || !platform) {
    return res.status(400).json({ error: 'guide_id, review_date and platform are required' });
  }

  const guide = db().prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(guide_id);
  if (!guide) return res.status(404).json({ error: 'Guide not found' });

  const result = db().prepare(`
    INSERT INTO guide_reviews (guide_id, review_date, reviewer_name, platform, booking_type, review_text, logged_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(guide_id, review_date, reviewer_name || null, platform, booking_type || 'Tour', review_text || null, actor);

  db().prepare(`INSERT INTO action_log (actor, action, details) VALUES (?,?,?)`)
    .run(actor, 'review_logged', JSON.stringify({ guide_id, guide_name: guide.name, platform, reviewer_name }));

  // Send email to guide if they have an address on file
  if (guide.email) {
    const dateLabel = new Date(review_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const subject = `New 5⭐ review for you — ${platform}`;
    const reviewBlock = review_text
      ? `<blockquote style="border-left:3px solid #e0e0e0;margin:0.75rem 0;padding:0.5rem 1rem;color:#555;font-style:italic">${review_text.replace(/\n/g,'<br>')}</blockquote>`
      : '';
    const htmlContent = `
      <p>Hi ${guide.name},</p>
      <p>You just got a new <strong>5-star review</strong>! Here are the details:</p>
      <table style="border-collapse:collapse;margin:0.5rem 0">
        <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLabel}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#888">Platform</td><td>${platform}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#888">Type</td><td>${booking_type || 'Tour'}</td></tr>
        ${reviewer_name ? `<tr><td style="padding:3px 12px 3px 0;color:#888">Reviewer</td><td>${reviewer_name}</td></tr>` : ''}
      </table>
      ${reviewBlock}
      <p>You can see all your reviews in the app under <strong>Profile</strong>.</p>
      <p style="color:#888;font-size:0.9em">— BeCopenhagen</p>
    `;

    await sendEmail({ to: guide.email, toName: guide.name, subject, htmlContent }).catch(e =>
      console.error('Review email failed:', e.message)
    );
  }

  res.json({ ok: true, id: result.lastInsertRowid });
});

// GET /api/reviews — all reviews (admin), or filtered by guide_id + optional date range
router.get('/', (req, res) => {
  const actor = req.session?.actor;
  const role = req.session?.actor_role;
  if (!actor) return res.status(401).json({ error: 'Not logged in' });

  const { guide_id, from, to } = req.query;

  // Guides can only fetch their own reviews
  const effectiveGuideId = role === 'admin' ? (guide_id || null) : actor;

  let sql = `
    SELECT gr.*, tm.name as guide_name
    FROM guide_reviews gr
    JOIN team_members tm ON tm.id = gr.guide_id
    WHERE 1=1
  `;
  const params = [];

  if (effectiveGuideId) { sql += ' AND gr.guide_id=?'; params.push(effectiveGuideId); }
  if (from) { sql += ' AND gr.review_date >= ?'; params.push(from); }
  if (to)   { sql += ' AND gr.review_date <= ?'; params.push(to); }

  sql += ' ORDER BY gr.review_date DESC, gr.created_at DESC';

  res.json(db().prepare(sql).all(...params));
});

// DELETE /api/reviews/:id — admin only
router.delete('/:id', requireAdmin, (req, res) => {
  const review = db().prepare('SELECT * FROM guide_reviews WHERE id=?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Not found' });
  db().prepare('DELETE FROM guide_reviews WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
