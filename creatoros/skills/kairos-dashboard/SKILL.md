---
name: kairos-dashboard
description: Launch the Kairos dashboard — the local web UI for monitoring what your CreatorOS agent is actually doing (activity log, posts, automations, analytics panels). Use when asked to open, launch, or start the Kairos dashboard, or "show me what the agent has been doing."
---

# Launch the Kairos Dashboard

Kairos is the open-source CreatorOS agent harness (github.com/kevinbadi/kairos).
Its dashboard is a zero-external-services local web app: it reads the Kairos
repo's files, the agent activity log (`logs/activity.jsonl`), and the CreatorOS
API with already-configured credentials. Missing credentials never crash it —
you get a connect screen instead.

## Prerequisites

- Node.js >= 20 (`node --version`).
- A Kairos checkout on this machine. Find it:
  1. `which kai` — if the `kai` binary is on PATH (via `npm link`), Kairos is installed; `kai dashboard` works from anywhere.
  2. Otherwise look for the repo folder (a `package.json` with `"name": "kairos"`). Common location: `~/Kairos Agent`.
  3. Neither? Clone it:
     ```sh
     git clone https://github.com/kevinbadi/kairos.git && cd kairos && npm install
     ```

## Steps

1. **Launch** (from the Kairos repo root — dependencies auto-install via its `prestart` hook):
   ```sh
   npm run dashboard
   ```
   or, if `kai` is linked, from anywhere:
   ```sh
   kai dashboard
   ```
   Run it in the background / a separate terminal — it's a long-running server, and blocking your own shell on it looks like a hang.

2. **Open it:** http://localhost:4180 — on macOS:
   ```sh
   open http://localhost:4180
   ```
   Port taken or need a different one? Set `KAIROS_DASHBOARD_PORT`:
   ```sh
   KAIROS_DASHBOARD_PORT=5000 npm run dashboard
   ```

3. **If the dashboard shows a "connect" state** instead of data: the CreatorOS API key isn't configured for Kairos. `creatoros auth:check` verifies the key works; then follow the dashboard's own connect instructions.

## Judgment rules

- **Don't kill an already-running dashboard to start another.** If port 4180 is already serving (step check below), the dashboard is up — just open the URL.
- **Never paste the API key into files or the URL.** Credential setup goes through the tools' own config flows.
- An empty activity feed is not a bug — it means the agent hasn't logged actions yet (`logs/activity.jsonl` doesn't exist until the first run).

## Verification

- Server is up: `curl -s -o /dev/null -w "%{http_code}" http://localhost:4180` returns `200`.
- Tell the human the URL (including the port if overridden) and that the server keeps running until they stop it (Ctrl-C in its terminal, or kill the process).
