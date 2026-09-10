# Startup Survivor

A real-time market simulation game for hackathons and startup events. Teams run startups, set prices, and survive market shocks thrown by the game master.

## Quick Start

Requires Python 3.

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 in your browser.

## How It Works

1. **Teams** log in with a startup name and pick a category (Tech, Health, Finance, etc.)
2. **The game master** logs in as admin and throws market shocks at players
3. Teams adjust pricing and watch their revenue react to market conditions
4. Last team standing wins

Shock types include market crashes, viral booms, regulatory changes, and competitor entries. Each shock changes demand multipliers that feed into team revenue on every tick.

## Project Structure

```
├── index.html          Landing page, team login
├── dashboard.html      Team dashboard, live metrics
├── admin.html          Game master controls
├── css/                Stylesheets
├── js/                 Game engine, state sync, shock logic
└── README.md
```

## Tech

Vanilla HTML, CSS, and JavaScript. No build step, no dependencies. State lives in localStorage and syncs across tabs in the same browser. For multi-device play, serve the files from one machine and open the page from other devices on the same network.

## License

MIT
