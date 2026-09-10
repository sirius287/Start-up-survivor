# Startup Survivor: The Business Model Gauntlet (2026 Edition)

Welcome to the **Situation Room**. 

Startup Survivor is a high-pressure entrepreneurship simulation where teams acquire a startup idea, build its business model, and face unpredictable AI-driven market shocks. They must rapidly pivot, adapt their strategy, and defend their survival before VC-style judges.

This is NOT a regular pitch competition. Teams don't pitch — they survive.

## Features

- **Live Market Simulation**: Real-time tick engine determining revenue, demand, and unit sales based on team pricing, marketing, and segment choices.
- **Shock Arsenal**: 12 diverse market disruptions (Threats, Opportunities, Wildcards) that force teams to adapt or perish.
- **Command Bunker**: Advanced Judge/Game Master control panel to orchestrate the chaos. Deploy shocks globally or surgically strike specific teams.
- **Dynamic Leaderboard**: Auto-updating live leaderboard based on cumulative revenue performance.
- **V-TAPP 2026 Theme**: A competitive, high-stakes atmosphere built for the VIT-AP University entrepreneurship techfest.

## Technologies

- Vanilla JavaScript (No frameworks)
- Real-time `localStorage` based state synchronization
- Custom CSS variable-based theming (Cinematic & Cyberpunk aesthetics)
- Responsive layout with `css/style.css` design system

## Setup

1. **Serve locally**: Use any local web server (e.g. `python3 -m http.server 8000`)
2. **Access**: 
   - Landing/Team Login: `index.html`
   - Team Dashboard: `dashboard.html`
   - Admin/Command Bunker: `admin.html`
3. **Admin Access**: The default Game Master passphrase is `gauntlet2026`.

## Security

- Role-based views
- LocalStorage state compartmentalization
- Passphrase brute-force lockout mechanisms
- XSS prevention via HTML entity sanitization

---
*Developed for the V-TAPP 2026 Techfest by the VIT-AP Entrepreneurship Club.*
