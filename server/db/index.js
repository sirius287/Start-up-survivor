const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { syncJudgesFromEnv } = require('../services/judges');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  // Judges are defined entirely from JUDGE_<n>_NAME/JUDGE_<n>_CODE env vars
  // (server/services/judges.js) — sync them into the `judges` table on every
  // boot so restarting to add a late judge never disturbs anyone already
  // logged in or any existing claim/score history.
  const judgeCount = await syncJudgesFromEnv(pool);
  if (judgeCount === 0) console.warn('No JUDGE_<n>_NAME/JUDGE_<n>_CODE pairs found in env — the judge panel will have no one who can log in.');
}

async function withTransaction(work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

module.exports = { pool, initDb, withTransaction };
