/* ============================================================
   Seeded, deterministic randomness (SPEC.md §2.8 / §1.3).
   Same (gameId, teamId, tick) always produces the same noise —
   reproducible and defensible, unlike the old
   `(Math.random() - 0.4) * 8` which gave identical strategies
   different results on every run.
   ============================================================ */

const crypto = require('crypto');

/** 32-bit unsigned hash of a string, via SHA-256 truncation. Deterministic
 *  across processes/restarts (unlike Node's default string hashing). */
function hashSeed(input) {
  const digest = crypto.createHash('sha256').update(String(input)).digest();
  return digest.readUInt32BE(0);
}

/** Mulberry32 PRNG — tiny, fast, good enough distribution for game noise.
 *  Returns a function producing floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** rng(gameId, teamId, tick) -> deterministic float in [0, 1). */
function rng(gameId, teamId, tick) {
  const seed = hashSeed(`${gameId}:${teamId}:${tick}`);
  return mulberry32(seed)();
}

/** Deterministic noise centered at 0, ± amplitude (e.g. rngNoise(...) * 0.05
 *  for ±5%). Replaces `(Math.random() - 0.4) * N` throughout market.js. */
function rngNoise(gameId, teamId, tick, amplitude = 1) {
  return (rng(gameId, teamId, tick) - 0.5) * 2 * amplitude;
}

module.exports = { hashSeed, mulberry32, rng, rngNoise };
