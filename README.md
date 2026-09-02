# Fello Starlink Command Center

> Unified command center for managing Fello's fleet of iPads, Starlink terminals, routers, SIM cards, and MDM profiles across all customer deployments.

**Live URL:** `https://fellostarlinkcommandcenter-production.up.railway.app`  
**GitHub:** `dano-27/fello_starlink_command_center`  
**Platform:** Node.js + Express, deployed on Railway (auto-deploy from `main`)

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Pages & Dashboard](#pages--dashboard)
- [Integrations](#integrations)
- [API Reference](#api-reference)
- [Browser Automation Agent](#browser-automation-agent)
- [Home Screen Layout Generator](#home-screen-layout-generator)
- [DCR Provisioning Engine](#dcr-provisioning-engine)
- [AI Features](#ai-features)
- [Authentication & Audit](#authentication--audit)
- [Environment Variables](#environment-variables)
- [Development](#development)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Railway (Node.js)                  │
│                                                      │
│  server.js (11,700+ lines, 221 endpoints)           │
│  ├── Express HTTP server                             │
│  ├── WebSocket server (agent bridge)                 │
│  ├── Session-based auth with role management         │
│  └── Background sync workers                         │
│                                                      │
│  External APIs:                                      │
│  ├── Starlink (auth, data-usage, service-lines)     │
│  ├── SimpleMDM (devices, apps, profiles, groups)    │
│  ├── Cradlepoint NetCloud (routers, WiFi, WAN)      │
│  ├── Peplink InControl 2 (OAuth, fleet, config)     │
│  ├── Webbing SOAP (SIM management, usage)           │
│  ├── IMS NextGen (CRM orders, service devices)      │
│  ├── Google Drive (DCR uploads)                      │
│  ├── Google Sheets (inventory data)                  │
│  ├── Gemini AI (chat, briefs, diagnostics)          │
│  ├── CoverageMap API (carrier coverage)             │
│  └── Cobrowse.io (remote device support)            │
│                                                      │
│  Mac Mini Agent:                                     │
│  └── fello-agent.js (Playwright browser automation) │
└─────────────────────────────────────────────────────┘
```

---

## Pages & Dashboard

| Path | Page | Description |
|------|------|-------------|
| `/` | Hub | Central dashboard with smart search and quick-access cards |
| `/lookup/` | Device Lookup | Search any serial/ICCID/IMEI across all systems |
| `/simplemdm/` | SimpleMDM | Device groups, apps, profiles, provisioning |
| `/orders/` | Orders | Order management, DCR submission, site checks |
| `/starlink/` | Starlink | Service lines, terminals, data usage |
| `/cradlepoint/` | Cradlepoint | Router fleet, WiFi config, bandwidth, speed tests |
| `/peplink/` | Peplink | InControl 2 fleet, WiFi/WAN/firewall/DHCP/QoS |
| `/webbing/` | Webbing | SIM card management, usage, plan changes |
| `/inventory/` | Inventory | Equipment tracking, forecasting, Google Sheets sync |
| `/checker/` | Site Checker | Carrier coverage analysis for event locations |
| `/reports/` | Reports | Overage reports, usage analytics |
| `/audit/` | Audit | Activity logs, session replay, AI-powered insights |
| `/training/` | Training | Staff training resources and AI tips |
| `/verify/` | Verify | Customer identity verification |
| `/share/` | Share Links | Public shareable usage dashboards |
| `/agent/` | Automation Agent | Browser automation dashboard, task queue, screenshots |
| `/admin/users` | User Management | Admin-only user CRUD |
| `/hexnode/` | Hexnode | Hexnode MDM integration |

---

## Integrations

### Starlink
- OAuth 2.0 token management
- Service line listing and data usage tracking
- User terminal details and router configurations
- Daily usage history and overage detection

### SimpleMDM
- **Devices**: Search, details, group assignment, lock, wipe, restart
- **Apps**: Catalog, assignment to groups, push installs
- **Profiles**: Built-in + custom configuration profiles
- **Groups**: CRUD, device/serial assignment, profile binding
- **Custom Profiles**: WiFi, Passcode, Web Filter, Wallpaper, **Home Screen Layout**
- **DCR Auto-Provisioning**: Full automated group setup from customer forms
- **ABM/DEP**: Device enrollment tracking and auto-assignment

### Cradlepoint NetCloud
- Router fleet with signal strength, location, bandwidth
- WiFi SSID management (view/edit/toggle per radio)
- WAN interface status and failover
- Speed tests, bandwidth history, alert monitoring
- Remote reboot

### Peplink InControl 2
- OAuth 2.0 with auto-refresh and 401 retry
- 10 management tabs: WiFi, WAN, Speed Test, Firewall, Port Forwarding, Content Blocking, QoS, DHCP, Config Backup, Firmware
- 30+ API endpoints
- Fleet dashboard with signal gauges, GPS, client counts
- SpeedFusion tunnel management
- Webhook receiver for device events

### Webbing (SIM Cards)
- SOAP API integration for SIM management
- Device activation, suspension, plan changes
- ICCID/IMEI lookup, usage tracking
- Branch-level management and bulk operations
- IMEI lock status checking

### IMS NextGen (CRM)
- Order lookup by number
- Device serial tracking
- Service device inventory
- Available device counts

### Cobrowse.io
- Remote screen sharing for iPad support
- Session initiation from Command Center

---

## API Reference

### Authentication (4 endpoints)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login with username/password |
| POST | `/api/auth/logout` | End session |
| GET | `/api/auth/me` | Current user info |
| GET | `/api/auth/users` | List all users (admin) |
| POST | `/api/auth/users` | Create user (admin) |
| POST | `/api/auth/users/save` | Update user (admin) |
| POST | `/api/auth/token` | Starlink OAuth token exchange |

### Audit (6 endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/audit/log` | Activity log with filtering |
| GET | `/api/audit/log/export` | Export audit log as CSV |
| GET | `/api/audit/sessions` | User sessions list |
| POST | `/api/audit/sessions/summarize` | AI session summary |
| GET | `/api/audit/agent-stats` | Agent activity statistics |
| POST | `/api/audit/ask` | Ask the Audit (AI Q&A) |
| POST | `/api/audit/agent-stats/insights` | AI audit insights |

### Starlink (5 endpoints)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/data-usage` | Data usage for service lines |
| GET | `/api/service-lines` | List all service lines |
| GET | `/api/user-terminals` | List user terminals |
| GET | `/api/account` | Account details |
| GET/POST | `/api/router-configs` | Router configurations |

### Cradlepoint (20+ endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cradlepoint/fleet` | Full fleet with merged data |
| GET | `/api/cradlepoint/routers` | All routers |
| GET | `/api/cradlepoint/routers/:id` | Router details |
| GET/PUT | `/api/cradlepoint/routers/:id/wifi` | WiFi SSID management |
| GET | `/api/cradlepoint/routers/:id/bandwidth` | Bandwidth stats |
| POST | `/api/cradlepoint/routers/:id/speedtest` | Initiate speed test |
| POST | `/api/cradlepoint/routers/:id/reboot` | Remote reboot |
| GET | `/api/cradlepoint/net_devices` | Network interfaces |
| GET | `/api/cradlepoint/alerts` | Active alerts |

### Peplink (30+ endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/peplink/fleet` | Fleet dashboard |
| GET | `/api/peplink/devices/:id` | Device details |
| GET/PUT | `/api/peplink/devices/:id/wifi` | WiFi configuration |
| GET/PUT | `/api/peplink/devices/:id/wan/priority` | WAN priority |
| GET/PUT | `/api/peplink/devices/:id/firewall` | Firewall rules |
| GET/PUT | `/api/peplink/devices/:id/portforward` | Port forwarding |
| GET/PUT | `/api/peplink/devices/:id/contentblock` | Content blocking |
| GET/PUT | `/api/peplink/devices/:id/qos` | QoS settings |
| GET/PUT | `/api/peplink/devices/:id/dhcp` | DHCP configuration |
| POST | `/api/peplink/devices/:id/speedtest` | Speed test |
| GET | `/api/peplink/devices/:id/config` | Config backup |
| GET/POST | `/api/peplink/devices/:id/firmware` | Firmware management |

### SimpleMDM (30+ endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/simplemdm/devices` | Device list |
| GET | `/api/simplemdm/devices/:id` | Device details |
| GET | `/api/simplemdm/apps` | App catalog |
| GET | `/api/simplemdm/apps/catalog` | Full catalog with bundle IDs |
| GET | `/api/simplemdm/profiles` | All profiles (built-in + custom) |
| POST | `/api/simplemdm/homescreen-layout` | **Generate Home Screen Layout** |
| POST | `/api/simplemdm/assignment_groups` | Create group |
| GET | `/api/simplemdm/groups/:id/devices` | Group devices |

### Webbing SIM (20+ endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/webbing/devices` | All SIM devices |
| GET | `/api/webbing/branches` | Branch listing |
| POST | `/api/webbing/devices/:id/activate` | Activate SIM |
| POST | `/api/webbing/devices/:id/suspend` | Suspend SIM |
| POST | `/api/webbing/devices/:id/change-plan` | Change data plan |
| GET | `/api/webbing/usage/overview` | Usage overview |

### Orders & DCR (8+ endpoints)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/dcr/submit` | Submit Device Configuration Request |
| POST | `/api/automation/provision` | Auto-provision SimpleMDM group |
| POST | `/api/orders/create` | Manual order creation |
| POST | `/api/orders/:branchId/site-check` | Carrier site check |
| POST | `/api/esim/assign` | eSIM assignment |

### Inventory (5 endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/inventory/dashboard` | Dashboard with forecasting |
| GET | `/api/inventory/sheets-status` | Google Sheets sync status |
| POST | `/api/inventory/sheets-refresh` | Force sync |
| POST | `/api/inventory/sheets-import` | Manual CSV import |

### AI Features (5 endpoints)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ai/chat` | AI chat assistant |
| POST | `/api/ai/order-brief` | Smart order brief |
| GET | `/api/alerts/proactive` | Proactive alerts |
| POST | `/api/ai/diagnose-device` | Device troubleshooter |
| GET | `/api/training/ai-tips` | AI training tips |

### Browser Automation Agent (8 endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agent/status` | Agent connection status + task history |
| POST | `/api/agent/tasks` | Queue a new task |
| GET | `/api/agent/tasks/:taskId` | Get task details |
| GET | `/api/agent/tasks/:taskId/screenshot` | Get task screenshot |
| POST | `/api/agent/tasks/:taskId/retry` | Retry failed task |
| DELETE | `/api/agent/tasks/:taskId` | Cancel task |
| POST | `/api/agent/tasks/clear` | Clear task history |
| GET | `/api/agent/actions` | List available actions |

---

## Browser Automation Agent

The Automation Agent is a Playwright-based browser automation system that runs on a Mac mini and connects to the Command Center via WebSocket.

### Architecture

```
┌──────────────┐    WebSocket     ┌─────────────────┐
│   Mac Mini   │◄────────────────►│ Command Center  │
│              │   /ws/agent      │  (Railway)       │
│ fello-agent  │                  │                  │
│   .js        │  Task dispatch   │  Task queue      │
│              │  ◄──────────     │  REST API        │
│ Playwright   │  Results ──────► │  Dashboard UI    │
│ (Chromium)   │  + screenshots   │                  │
└──────────────┘                  └─────────────────┘
```

### Setup (Mac Mini)

```bash
mkdir -p ~/fello-agent && cd ~/fello-agent

# Install dependencies
npm init -y
npm install playwright ws

# Download agent script
curl -o fello-agent.js https://raw.githubusercontent.com/dano-27/fello_starlink_command_center/main/fello-agent.js

# Create start script
cat > start.sh << 'EOF'
#!/bin/bash
cd ~/fello-agent
export AGENT_SECRET="fello-agent-2026"
export SMDM_EMAIL="it@fello.com"
export SMDM_PASSWORD="Fello1234!"
node fello-agent.js
EOF
chmod +x start.sh

# Run
./start.sh
```

### Available Actions

| Action | Description |
|--------|-------------|
| `create_wifi_profile` | Create WiFi profile in SimpleMDM |
| `create_restrictions_profile` | Create restrictions profile |
| `create_lock_screen_message` | Set lock screen message |
| `create_single_app_mode` | Configure single app kiosk mode |
| `create_wallpaper` | Set device wallpaper |
| `custom_navigation` | Navigate to any URL and take screenshots |

### WebSocket Protocol

- **Connection**: `wss://fellostarlinkcommandcenter-production.up.railway.app/ws/agent?secret=AGENT_SECRET`
- **Heartbeat**: Agent sends `{ type: 'heartbeat' }` every 15 seconds
- **Task dispatch**: Server sends `{ type: 'task', task: {...} }`
- **Task result**: Agent sends `{ type: 'task_result', taskId, success, result, error, screenshot }`

---

## Home Screen Layout Generator

Server-side `.mobileconfig` generation for Apple Home Screen Layout MDM profiles. No browser automation needed — pure API.

### How It Works

1. Generates Apple `com.apple.homescreenlayout` XML payload
2. Uploads to SimpleMDM as a custom configuration profile
3. Assigns to device group
4. iPads receive the layout automatically

### Standard Layout

| Location | Apps |
|----------|------|
| **Dock** | Order-specific app (Eventbrite, Square POS, etc.) |
| **Page 1** | SimpleMDM, Fello Connect, Settings |
| **Page 2** | "Other" folder with 42 system apps |

### API Usage

```bash
# Create a Home Screen Layout
POST /api/simplemdm/homescreen-layout
{
  "dockAppBundleId": "com.eventbrite.attendee",
  "dockAppName": "Eventbrite",
  "profileName": "Home Screen - Eventbrite Order",
  "groupId": 124695,        // optional: auto-assign to group
  "account": "fello"        // optional: defaults to fello
}
```

### Workflow Integration

The Home Screen Layout auto-generates in these workflows:

1. **DCR Auto-Provisioning** — When a DCR includes apps, the first non-default app becomes the dock app
2. **Manual Order Creation** — Pass `dockAppBundleId` in the request body
3. **Standalone API** — Direct creation via `/api/simplemdm/homescreen-layout`

### Bundle IDs for Common Fello Apps

| App | Bundle ID | SimpleMDM ID |
|-----|-----------|-------------|
| SimpleMDM | `com.unwiredrev.DeviceLink.public` | 129309 |
| Fello Connect | `com.fello.FelloRemote` | 687894 |
| Eventbrite Organizer | `com.eventbrite.app1` | 129312 |
| Eventbrite | `com.eventbrite.attendee` | 547855 |
| Square POS | `com.squareup.square` | 129311 |
| Square Retail | `com.squareup.retailer` | 129329 |
| Square Restaurant | `com.squareup.restaurant` | 524066 |
| Shopify POS | `com.jadedpixel.pos` | 129324 |
| GiveSmart | `com.communitybrands.givesmart.events.EventApp` | 544832 |
| Cvent OnArrival | `com.cvent.checkin.ipad.release` | 129323 |
| zkipster | `com.zkipster.zkipster` | 129314 |
| Z5 Inventory | `com.solugenix.invent` | 129319 |
| Zoom | `us.zoom.videomeetings` | 129332 |

---

## DCR Provisioning Engine

Fully automated device provisioning from customer Device Configuration Request (DCR) forms.

### Flow

```
Customer submits DCR form
        │
        ▼
POST /api/dcr/submit
        │
        ├── Generate PDF backup
        ├── Upload to Google Drive
        │
        ▼
POST /api/automation/provision
        │
        ├── Step 1: Create SimpleMDM assignment group
        ├── Step 2: Match & assign apps (fuzzy matching)
        │   ├── Always assigns: Fello Connect
        │   ├── Fuzzy matches requested apps from catalog
        │   └── Pushes apps to group
        ├── Step 3: Assign profiles
        │   ├── Default Restrictions (ID: 142210)
        │   ├── Fello WiFi (ID: 133014)
        │   ├── Custom WiFi (if specified)
        │   ├── Passcode policy
        │   ├── Web content filter
        │   └── Wallpaper
        ├── Step 4: Home Screen Layout ← NEW
        │   ├── Try matching existing layout
        │   └── Auto-generate with dock app if no match
        └── Step 5: Assign device serial numbers
```

---

## AI Features

Powered by Google Gemini (`gemini-3.7-flash`).

| Feature | Endpoint | Description |
|---------|----------|-------------|
| AI Chat | `/api/ai/chat` | Context-aware assistant for device management |
| Smart Order Brief | `/api/ai/order-brief` | AI-generated deployment summary |
| Proactive Alerts | `/api/alerts/proactive` | Auto-detected issues across fleet |
| Device Troubleshooter | `/api/ai/diagnose-device` | AI diagnostics for device problems |
| Training Tips | `/api/training/ai-tips` | Context-relevant training suggestions |
| Session Summaries | `/api/audit/sessions/summarize` | AI summary of user sessions |
| Ask the Audit | `/api/audit/ask` | Natural language audit queries |

---

## Authentication & Audit

### Auth System
- Session-based authentication via `fello_session` cookie
- Global middleware at server startup — no `requireAuth` function
- `req.user` available on all `/api/` routes: `{ username, name, role, sessionToken }`
- Roles: `admin`, `user`
- Admin check: `req.user.role !== 'admin'`

### Audit Logging
- Auto-logs all POST/PUT/DELETE requests + tracked GETs
- `auditLog({ user, name, role, method, path, body, ip })`
- Session tracking with duration, page views, actions
- AI-powered session summarization and insights

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `SESSION_SECRET` | Cookie signing secret |
| `SIMPLEMDM_API_KEY` | SimpleMDM API key (Fello account) |
| `ALAMO_SIMPLEMDM_KEY` | SimpleMDM API key (Alamo account) |
| `STARLINK_TOKEN` | Starlink API token |
| `CRADLEPOINT_ECM_ID` | Cradlepoint ECM API ID |
| `CRADLEPOINT_ECM_KEY` | Cradlepoint ECM API key |
| `PEPLINK_CLIENT_ID` | Peplink OAuth client ID |
| `PEPLINK_CLIENT_SECRET` | Peplink OAuth client secret |
| `PEPLINK_ORG_ID` | Peplink organization ID |
| `WEBBING_USER` | Webbing SOAP username |
| `WEBBING_PASS` | Webbing SOAP password |
| `IMS_TOKEN` | IMS NextGen API token |
| `IMS_BASE_URL` | IMS NextGen base URL |
| `COVERAGEMAP_API_KEY` | CoverageMap API key |
| `COBROWSE_LICENSE` | Cobrowse.io license key |
| `GEMINI_API_KEY` | Google Gemini AI key |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google Drive service account JSON |
| `INVENTORY_SHEET_ID` | Google Sheets inventory spreadsheet ID |
| `AGENT_SECRET` | Browser agent WebSocket auth secret |

---

## Development

### Local Setup

```bash
git clone https://github.com/dano-27/fello_starlink_command_center.git
cd fello_starlink_command_center
npm install
# Set environment variables
node server.js
```

### Project Structure

```
├── server.js              # Main server (11,700+ lines)
├── fello-agent.js         # Browser automation agent (315 lines)
├── package.json           # Dependencies
├── public/                # Frontend pages
│   ├── index.html         # Hub dashboard
│   ├── shared-header.js   # Navigation header
│   ├── agent/             # Automation agent dashboard
│   ├── audit/             # Audit & session logs
│   ├── checker/           # Site checker
│   ├── cradlepoint/       # Cradlepoint management
│   ├── inventory/         # Equipment inventory
│   ├── lookup/            # Device lookup
│   ├── orders/            # Order management
│   ├── peplink/           # Peplink management
│   ├── reports/           # Usage reports
│   ├── simplemdm/         # SimpleMDM management
│   ├── starlink/          # Starlink dashboard
│   ├── training/          # Training resources
│   ├── verify/            # Customer verification
│   └── webbing/           # SIM card management
└── data/                  # Persistent JSON data files
```

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `ws` | WebSocket (agent bridge) |
| `node-fetch` | External API calls |
| `googleapis` | Google Drive/Sheets |
| `pdfkit` | PDF generation for DCRs |
| `xmlbuilder2` | SOAP XML for Webbing |
| `crypto` | UUID generation, hashing |

---

## Commit History Highlights

| Commit | Feature |
|--------|---------|
| `5c3b798` | Home Screen Layout in all workflows |
| `2376d47` | Browser Automation Agent (full system) |
| `9df6769` | Peplink Full Control Suite (10 tabs, 30+ endpoints) |
| `573efd3` | Peplink InControl 2 OAuth integration |
| `85934cc` | 5 AI features (Brief, Alerts, Troubleshooter, Search, Tips) |
| `b4593a1` | AI-enhanced audit system |
| `2a9eeda` | AI session summaries |

---

*Built and maintained by Fello's engineering team. Powered by 221 API endpoints across 8 external integrations.*
