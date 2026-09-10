const jwt = require('jsonwebtoken');

function issueSession(res, user) {
  const token = jwt.sign({ sub: String(user.id), role: user.role, teamId: user.teamId ? String(user.teamId) : null }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.cookie('ss_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000, path: '/' });
}

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.ss_session;
    if (!token) return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { return res.status(401).json({ success: false, error: { code: 'INVALID_SESSION', message: 'Your session has expired.' } }); }
}

function requireRole(role) {
  return (req, res, next) => req.user?.role === role ? next() : res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You do not have permission for this action.' } });
}

module.exports = { issueSession, requireAuth, requireRole };
