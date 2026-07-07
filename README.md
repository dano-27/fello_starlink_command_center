# Fello Starlink Command Center

A web dashboard for monitoring and auditing data usage across your Starlink terminal fleet, built for **rental terminal auditing**.

## Features

- **Fleet Summary** — Total terminals, priority/standard/combined data at a glance
- **Historical Data** — View up to 6 previous billing cycles or set a custom date range
- **Daily Granularity** — Day-by-day usage breakdown with exact date-range filtering
- **Device Identification** — Terminals shown by serial number and nickname
- **Terminal Detail View** — Click any terminal for daily usage chart, billing cycle history, and per-day table
- **Search & Filter** — Search by serial number, nickname, or service line number
- **Include Inactive** — Show terminals returned from service (rental returns)
- **CSV Export** — Full fleet or single terminal export with serial numbers
- **Auto-Refresh** — Configurable interval with visual countdown

## Architecture

```
Browser (localhost:3456) → Express Proxy (server.js) → Starlink Management API V2
```

The Express proxy handles OIDC authentication and bypasses browser CORS restrictions. Your credentials never leave your local machine.

## Setup

```bash
# Install dependencies
npm install

# Start the dashboard
npm run dev
```

Open **http://localhost:3456** in your browser.

## Usage

1. Enter your Starlink API **Client ID** and **Client Secret**
2. Select a date range (Current, 3 Months, 6 Months, or Custom)
3. Click any terminal card for detailed daily usage
4. Use "Include Inactive" toggle for returned rental terminals
5. Export data as CSV for billing/reporting

## API

Uses the [Starlink Management API V2](https://starlink.readme.io/docs/getting-started):
- `POST /v2/data-usage/query` — Usage data with daily granularity
- `GET /v2/user-terminals` — Terminal serial numbers and device info
- `GET /v2/service-lines` — Service line nicknames and status
- `POST /auth/connect/token` — OAuth2 client_credentials authentication

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS
- **Styling**: Custom dark theme with glassmorphism
- **Charts**: Canvas-rendered daily usage bars
