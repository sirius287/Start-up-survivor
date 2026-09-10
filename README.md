# Startup Survivor

Startup Survivor is a server-authoritative real-time market simulation for startup events. The existing Vanilla HTML/CSS UI is served by Express, while PostgreSQL persists teams, game state, market history, BMC content, and shocks.

## Local setup

Requirements: Node.js 20+ and PostgreSQL 14+.

```bash
npm install
Copy-Item .env.example .env
```

Create a PostgreSQL database, set `DATABASE_URL`, generate a judge password hash, then start the service:

```bash
node -e "require('bcrypt').hash('replace-me', 12).then(console.log)"
npm start
```

Open `http://localhost:3000`. The server runs `server/db/schema.sql` automatically on startup. Do not use the old Python static server for multiplayer play.

## Environment variables

- `PORT`: HTTP port, default `3000`
- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: long random value used to sign HTTP-only session cookies
- `JUDGE_PASSWORD_HASH`: bcrypt hash for the judge passphrase
- `NODE_ENV`: use `production` to enable secure cookies and PostgreSQL TLS

## Architecture

`server/server.js` serves the existing root HTML/CSS/JavaScript and exposes `/api/*`. `server/services/market.js` ports the existing `js/market.js` formula; the server calculates every deployment inside a PostgreSQL transaction with a row lock. `server/services/shocks.js` preserves the existing catalog and category-specific behavior.

## API overview

- Auth: `POST /api/auth/team/register`, `POST /api/auth/team/login`, `POST /api/auth/judge/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Game: `GET /api/game/state`, `POST /api/game/start`, `/pause`, `/resume`, `/end`, `/reset`
- Team actions: `POST /api/teams/:teamId/deploy`, `PATCH /api/teams/:teamId/market`, `PATCH /api/teams/:teamId/bmc`
- Shocks: `GET /api/shocks`, `/active`, `/history`, `POST /api/shocks/deploy`, `POST /api/shocks/custom`, `DELETE /api/shocks/:instanceId`
- Leaderboard: `GET /api/leaderboard`

Responses use `{ success: true, data }` or `{ success: false, error: { code, message } }`.

## Product quality scoring (judge-rated)

Judges rate each team's actual product 1–10 across five weighted attributes
(Innovation ×0.25, Market Fit ×0.25, Usability & Craft ×0.20, Execution ×0.15,
Pitch & Story ×0.15) from the "⭐ Product Quality" panel in `admin.html`.
The weighted composite feeds the market model: a 10/10 composite gives +25%
demand (half that on conversion), 5.5/10 is neutral, and 1/10 gives −25%.
Unrated teams get a neutral multiplier, so scoring only changes the game for
teams the judges have actually rated. Teams see their own composite and
attribute dots read-only in `dashboard.html`; judges see every team's scores
in `/api/game/state` (`quality` + `qualityAttributes`).

- Quality config + math: `server/services/quality.js` (`QUALITY_WEIGHT`,
  `QUALITY_NEUTRAL`, attribute weights — the "weightage" knobs).
- Storage: `judge_scores(team_id, attribute, score)` + cached composite in
  `team_market_state.quality_score`; every tick snapshots it to
  `market_history.quality`.
- API: `GET /api/quality/attributes`, `GET /api/quality` (judge),
  `GET /api/quality/:teamId`, `POST /api/quality/:teamId` (judge, body
  `{ scores: { innovation: 8, ... } }`, partial updates allowed).
- Model: `runTick(state, shocks, { ..., quality })` multiplies demand by
  `qualityMultiplier(composite)` and conversion by half that effect.

## Deployment

Deploy the repository to Render, Railway, or another Node host, attach a managed PostgreSQL database, configure the environment variables above, and use `npm start` as the start command. The service is intentionally one application: the same origin serves both the frontend and API, so no CORS configuration is needed.

## Deploying to Vercel

The repo is Vercel-ready. The same Express app runs `api/index.js` as a
serverless function (request polling, no WebSockets — nothing else changes),
while Vercel's CDN serves the static `*.html`/`css`/`js` files directly.

```bash
npm i -g vercel
vercel
```

In the Vercel dashboard (**Project → Settings → Environment Variables**), set:

- `DATABASE_URL`: connection string from Vercel Postgres, Neon, or Supabase
  (append `?sslmode=require` for managed hosts)
- `JWT_SECRET`: long random value, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `JUDGE_PASSWORD_HASH`: bcrypt hash of your judge passphrase —
  `node -e "require('bcrypt').hash('your-admin-passphrase', 12).then(console.log)"`
  (the passphrase itself is the admin key used on the Command Bunker page)
- `NODE_ENV`: `production` (Vercel sets this automatically for production
  deployments; it enables secure cookies and PostgreSQL TLS)

`api/index.js` runs `server/db/schema.sql` once per cold start (idempotent),
so no manual migration step is needed. Notes:

- Vercel Hobby functions sleep when idle: open the site ~10 minutes before
  the event to absorb the cold start, and use a paid tier for zero-downtime
  during the hackathon if possible.
- The auth rate limiter (`express-rate-limit`) is in-memory per function
  instance, so limits are approximate on serverless — acceptable for an event.
