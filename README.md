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

## Deployment

Deploy the repository to Render, Railway, or another Node host, attach a managed PostgreSQL database, configure the environment variables above, and use `npm start` as the start command. The service is intentionally one application: the same origin serves both the frontend and API, so no CORS configuration is needed.
