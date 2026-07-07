// Resolves the "effective actor" for a request — the real logged-in session
// actor, UNLESS an admin is using "View as" (X-View-As header), in which
// case we return the impersonated user's identity WITHOUT ever touching or
// mutating req.session. This is critical: earlier we tried overriding
// req.session directly (via a Proxy), but express-session serializes the
// session object at the end of the request, which persisted the
// impersonated identity into the real session — logging the admin in
// permanently as the impersonated user after a reload. Never do that again.
//
// Usage: const actor = getActor(req);  // { id, name, role }
//        if (!actor.id) return res.status(401)...

const { getDb } = require('./db/schema');

function getActor(req) {
  const realId = req.session?.actor || null;
  const realRole = req.session?.actor_role || null;
  const realName = req.session?.actor_name || null;

  const viewAsId = req.headers['x-view-as'];
  if (viewAsId && realRole === 'admin') {
    const target = getDb().prepare('SELECT id, name, role FROM team_members WHERE id=? AND active=1').get(viewAsId);
    if (target) {
      return { id: target.id, name: target.name, role: target.role, isViewAs: true, realId, realRole };
    }
  }

  return { id: realId, name: realName, role: realRole, isViewAs: false, realId, realRole };
}

module.exports = { getActor };
