# ⚡ MarketShock - Interactive Startup Market Simulator

**MarketShock** is a real-time, multi-user web application designed for hackathons, startup bootcamps, and venture competitions. It allows participants to launch virtual startups, set product pricing, and track financial performance in a dynamic market environment.

The twist: **Judges act as market administrators**, throwing real-time market shocks—such as tech booms, recessions, or data scandals—directly at startups, forcing founders to pivot, adjust pricing, and navigate market turbulence live.

---

## 🛠️ Tech Stack

* **Backend:** Node.js, Express.js
* **Real-time Communication:** Socket.io (WebSockets)
* **Frontend:** HTML5, JavaScript (ES6+), Tailwind CSS

---

## ✨ Features

* **Participant Dashboard:** Launch a venture, configure product categories, adjust unit pricing on the fly, and view live updates on revenue, units sold, and conversion rates.
* **Admin / Judge Control Panel:** Trigger market shocks in real time and monitor a live leaderboard of all participating startups.
* **Dynamic Market Engine:** Built-in simulation cycle that updates metrics every 4 seconds based on price elasticity, demand shifts, and active market shocks.
* **Real-Time Shocks:**
* 🚀 **Tech Boom:** Increases market demand by 50%.
* 📉 **Recession:** Cuts market demand and capital limits by 30%.
* 🔒 **Data Privacy Scandal:** Halves conversion rates for Tech category startups.
* ⚖️ **Market Stabilization:** Resets market conditions back to baseline.



---

## 📁 Project Structure

```text
market-shock/
├── package.json        # Dependencies and startup scripts
├── server.js          # Express server & WebSocket simulation engine
├── .gitignore         # Excludes node_modules
└── public/            # Client-side assets
    ├── index.html     # Participant login / startup launch
    ├── dashboard.html # Live startup management panel
    └── admin.html     # Judge control panel & real-time leaderboard

```

---

## 🚀 Getting Started

### Prerequisites

Ensure you have [Node.js](https://nodejs.org/) (v14 or higher) installed on your system.

### Installation

1. Clone the repository:
```bash
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git
cd YOUR-REPO

```


2. Install dependencies:
```bash
npm install

```


3. Start the application:
```bash
npm start

```


4. Open your browser and navigate to:
* **Startup Participant Login:** `http://localhost:3000`
* **Judge / Admin Portal:** `http://localhost:3000/admin.html`



