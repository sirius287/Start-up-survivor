// Vercel serverless entry point. Serves the same Express app that `npm start`
// boots, but lets the platform own the HTTP listener. The request reaches this
// handler for any /api/* path (see vercel.json rewrites); static pages and
// assets are served by Vercel's CDN directly, never hitting this function.
//
// The database schema is initialized once per cold start. schema.sql is
// idempotent (CREATE TABLE IF NOT EXISTS), so this is safe on every boot.
const app = require('../server/server');
const { initDb } = require('../server/db');

let ready = null;

module.exports = async (req, res) => {
  if (!ready) {
    ready = initDb();
    // Allow a later invocation to retry if initialization failed.
    ready.catch(() => { ready = null; });
  }
  try {
    await ready;
  } catch (error) {
    console.error('Database initialization failed', error);
    res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable.' } });
    return;
  }
  return app(req, res);
};
