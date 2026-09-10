const jwt = require('jsonwebtoken');

function issueSession(res, user) {
  // `name` is carried in the token so judge/admin actions can be attributed
  // in the event log and the claim UI without an extra lookup per request.
  const token = jwt.sign({ sub: String(user.id), role: user.role, name: user.name || null, teamId: user.teamId ? String(user.teamId) : null }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.cookie('ss_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000, path: '/' });
}

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.ss_session;
    if (!token) return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    // Expose the subject as `id` too — every route reads req.user.id, and
    // reading `sub` directly is an easy place to silently get undefined.
    req.user = { ...claims, id: claims.sub };
    next();
  } catch { return res.status(401).json({ success: false, error: { code: 'INVALID_SESSION', message: 'Your session has expired.' } }); }
}

/** Accepts a single role or an array of allowed roles, e.g.
 *  requireRole(['admin', 'judge']) for endpoints both may use. */
function requireRole(roleOrRoles) {
  const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  return (req, res, next) => allowed.includes(req.user?.role) ? next() : res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You do not have permission for this action.' } });
}

module.exports = { issueSession, requireAuth, requireRole };
