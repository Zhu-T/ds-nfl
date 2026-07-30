# NFL Fantasy Auto-Picker & Live Draft Assistant

This repository contains an NFL Fantasy AI assistant powered by a local **DeepSeek** model (via Ollama/OpenClaw), an **ESPN API & Playwright automation client** for your league roster, **real player stats & injury data from `nfl_data_py`** (nflverse), an **SQLite action history database** with multi-session support, and a web control dashboard.

---

## 📁 Repository Structure

```
ds-nfl/
├── .env                  # Sensitive credentials (git-ignored)
├── .env.example          # Environment template
├── .gitignore            # Git ignore rules
├── README.md             # Project documentation
├── data/                 # Session registry & SQLite db files (git-ignored)
│   ├── sessions.json     # Session registry (names, default session)
│   └── sessions/         # One .db file per session, e.g. test.db
├── public/               # Web Dashboard UI
│   ├── index.html        # Control dashboard interface
│   ├── style.css         # Dashboard styling (dark mode by default, light toggle)
│   └── app.js             # Client-side interactive logic, sessions, & API triggers
├── scripts/               # Utility & Test Scripts
│   └── test_setup.py     # Diagnostic environment checker
└── src/                  # Application Source Code
    ├── lineup_optimizer.py # Lineup optimizer entry point
    ├── draft_assistant.py  # Live draft assistant entry point
    ├── dashboard_server.py # Dashboard API & Web Server (http://localhost:8000)
    └── helpers/
        ├── db_manager.py    # SQLite session registry, action/system logs, API cache, .env loader
        ├── espn_client.py   # ESPN API & Playwright browser UI automation (your roster/lineup slots)
        ├── draft_client.py  # ESPN Live Draft Room automation & VORP logic
        ├── trade_client.py  # ESPN pending trade evaluation
        ├── nfl_data_client.py # Real player stats & injury data via nfl_data_py (nflverse)
        └── llm_client.py    # Local DeepSeek (Ollama) query client
```

---

## 🚀 How to Run

### 1. Launch Control Dashboard (Recommended)
Start the local control server:
```bash
python src/dashboard_server.py
```
Open **[http://localhost:8000](http://localhost:8000)** in your browser. From the dashboard, you can:
* 🏈 **Set Lineup** (Evaluates roster & match-ups using real stats/injury data)
* 📋 **Start Live Draft** (Scrapes live draft board & recommends the best available player)
* 🔁 **Review Trade Offers** (Evaluates pending ESPN trade proposals)
* Switch between **sessions** (separate SQLite databases) from the top bar — useful for keeping test/demo data apart from your real league history. Create new sessions and set a default from the session dropdown.

---

### 2. Run via CLI (Optional)

* **Run Diagnostics Check**:
  ```bash
  python scripts/test_setup.py
  ```
* **Run Lineup Optimizer**:
  ```bash
  python src/lineup_optimizer.py
  ```
* **Run Live Draft Assistant**:
  ```bash
  python src/draft_assistant.py
  ```

CLI runs always use the default session (set it from the dashboard's session dropdown).

---

## 🗂️ Sessions

Action history, system logs, and the API cache all live in per-session SQLite files under `data/sessions/`, registered in `data/sessions.json`. This keeps throwaway/test data separate from a real league's history:

* The dashboard ships with a **Test** session (seeded with demo data) as the initial default.
* Create additional sessions from the session dropdown in the dashboard — each gets its own empty `.db` file and starts with no demo data.
* Any session can be marked as the **default**, used by CLI runs and by the dashboard on first load.

---

## 📊 Player Data Source

Player performance stats and injury status come from [`nfl_data_py`](https://pypi.org/project/nfl-data-py/) (the nflverse dataset), not ESPN — ESPN's API is used only to read your actual fantasy roster (who's on your team, starter/bench slots), since that's league-specific data only ESPN has. `nfl_data_client.py` enriches each player with their most recent stat line and injury report before it's sent to DeepSeek, falling back to the most recent published season if the current one isn't out yet (e.g. during the off-season).

Note: ESPN does not provide a public write API — roster/lineup/draft changes are executed via Playwright browser automation against the ESPN Fantasy UI.

## Todo:
Remove need for .env values
Update styling for set default