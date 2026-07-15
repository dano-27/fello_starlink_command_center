const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory token cache ────────────────────────────────────────────
const tokenCache = new Map(); // key: clientId, value: { accessToken, expiresAt }

function getCacheKey(clientId) {
  return clientId;
}

function getCachedToken(clientId) {
  const cached = tokenCache.get(getCacheKey(clientId));
  if (cached && Date.now() < cached.expiresAt - 30000) {
    return cached.accessToken;
  }
  return null;
}

function setCachedToken(clientId, accessToken, expiresIn) {
  tokenCache.set(getCacheKey(clientId), {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });
}

// ── OIDC Token Exchange ──────────────────────────────────────────────
app.post('/api/auth/token', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'clientId and clientSecret are required' });
  }

  // Check cache first
  const cached = getCachedToken(clientId);
  if (cached) {
    return res.json({ access_token: cached, fromCache: true });
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const response = await fetch('https://starlink.com/api/auth/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Token exchange failed:', response.status, text);
      return res.status(response.status).json({
        error: 'Authentication failed',
        detail: text,
      });
    }

    const data = await response.json();
    setCachedToken(clientId, data.access_token, data.expires_in || 900);
    return res.json(data);
  } catch (err) {
    console.error('Token exchange error:', err.message);
    return res.status(500).json({ error: 'Failed to connect to Starlink auth server' });
  }
});

// ── Proxy: Data Usage Query ──────────────────────────────────────────
app.post('/api/data-usage', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    // Forward page/limit query params for pagination
    const url = new URL('https://starlink.com/api/public/v2/data-usage/query');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    if (req.query.limit != null) url.searchParams.set('limit', req.query.limit);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Data usage proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch data usage' });
  }
});

// ── Proxy: List Service Lines ────────────────────────────────────────
app.get('/api/service-lines', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const url = new URL('https://starlink.com/api/public/v2/service-lines');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Service lines proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch service lines' });
  }
});

// ── Proxy: User Terminals ────────────────────────────────────────────
app.get('/api/user-terminals', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const url = new URL('https://starlink.com/api/public/v2/user-terminals');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    if (data?.content?.results?.length > 0) {
      console.log('Terminal result[0] keys:', Object.keys(data.content.results[0]));
      console.log('Terminal result[0]:', JSON.stringify(data.content.results[0]).slice(0, 1500));
    }
    return res.json(data);
  } catch (err) {
    console.error('User terminals proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch user terminals' });
  }
});

// ── Proxy: Account info ──────────────────────────────────────────────
app.get('/api/account', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch('https://starlink.com/api/public/v2/account', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Account proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

// ── Proxy: Router Configs ────────────────────────────────────────────
app.get('/api/router-configs', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const url = new URL('https://starlink.com/api/public/v2/routers/configs');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Router configs API returned ${response.status}: ${text}`);
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    // DEBUG: log first result's full keys to find router IDs
    if (data?.content?.results?.length > 0) {
      console.log('Config result[0] keys:', Object.keys(data.content.results[0]));
      console.log('Config result[0]:', JSON.stringify(data.content.results[0]).slice(0, 1000));
    }
    return res.json(data);
  } catch (err) {
    console.error('Router configs proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch router configs' });
  }
});

app.post('/api/router-configs', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch('https://starlink.com/api/public/v2/routers/configs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Router config create proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to create router config' });
  }
});

// NOTE: /default and /assign must be registered before /:configId
app.get('/api/router-configs/default', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch('https://starlink.com/api/public/v2/routers/configs/default', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Default router config proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch default router config' });
  }
});

app.put('/api/router-configs/default', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch('https://starlink.com/api/public/v2/routers/configs/default', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Set default router config proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to set default router config' });
  }
});

app.put('/api/router-configs/assign', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const body = req.body;  // Pass through as-is: { configId, routerIds }
    const url = 'https://starlink.com/api/public/v2/routers/configs/assign';
    console.log('Assign URL:', url);
    console.log('Assign body:', JSON.stringify(body));
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });
    console.log('Assign config request body:', JSON.stringify(req.body));
    console.log('Assign config response status:', response.status);
    const responseText = await response.text();
    console.log('Assign config response body:', responseText);

    if (!response.ok) {
      return res.status(response.status).json({ error: responseText || `API returned ${response.status}` });
    }

    let data;
    try { data = JSON.parse(responseText); } catch { data = { raw: responseText }; }
    return res.json(data);
  } catch (err) {
    console.error('Assign router config proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to assign router config' });
  }
});

app.get('/api/router-configs/:configId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch(`https://starlink.com/api/public/v2/routers/configs/${req.params.configId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Router config detail proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch router config' });
  }
});

app.put('/api/router-configs/:configId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch(`https://starlink.com/api/public/v2/routers/configs/${req.params.configId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Router config update proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to update router config' });
  }
});

// ── Proxy: Router Detail ─────────────────────────────────────────────
app.get('/api/routers/:routerId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch(`https://starlink.com/api/public/v2/routers/${req.params.routerId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Router detail proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch router detail' });
  }
});

// ── Proxy: Telemetry ─────────────────────────────────────────────────
app.get('/api/telemetry/location', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const url = new URL('https://starlink.com/api/public/v2/telemetry/location');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Telemetry location proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch telemetry location' });
  }
});

app.post('/api/telemetry/uptime', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const url = new URL('https://starlink.com/api/public/v2/telemetry/uptime/query');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    if (req.query.limit != null) url.searchParams.set('limit', req.query.limit);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Telemetry uptime proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch telemetry uptime' });
  }
});

// ── Proxy: Alerts ────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const url = new URL('https://starlink.com/api/public/v2/alerts');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Alerts proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

app.get('/api/alerts/history', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const url = new URL('https://starlink.com/api/public/v2/alerts/history');
    if (req.query.page != null) url.searchParams.set('page', req.query.page);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Alerts history proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch alerts history' });
  }
});

// ── Proxy: Device Control ────────────────────────────────────────────
app.post('/api/reboot/:userTerminalId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch(`https://starlink.com/api/public/v2/user-terminals/${req.params.userTerminalId}/reboot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Reboot proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to reboot user terminal' });
  }
});

app.post('/api/stow/:userTerminalId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch(`https://starlink.com/api/public/v2/user-terminals/${req.params.userTerminalId}/stow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Stow proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to stow user terminal' });
  }
});

app.post('/api/unstow/:userTerminalId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const response = await fetch(`https://starlink.com/api/public/v2/user-terminals/${req.params.userTerminalId}/unstow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Unstow proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to unstow user terminal' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ██  DCR → SimpleMDM Automation Engine
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');

// ── Provisioning Queue (persisted to JSON) ──────────────────────────
const QUEUE_FILE = path.join(__dirname, 'provisioning-queue.json');

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
  } catch (e) { console.error('Queue load error:', e.message); }
  return [];
}

function saveQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) { console.error('Queue save error:', e.message); }
}

let provisioningQueue = loadQueue();

// ── SimpleMDM API helper ────────────────────────────────────────────
async function smdmRequest(apiKey, path, method = 'GET', body = null) {
  const url = `https://a.simplemdm.com/api/v1${path}`;
  const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
  const opts = {
    method,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    const err = new Error(`SimpleMDM ${resp.status}: ${typeof data === 'object' ? JSON.stringify(data) : text}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// ── Fetch full catalog from SimpleMDM ───────────────────────────────
async function fetchAllApps(apiKey) {
  let all = [];
  let startingAfter = 0;
  let hasMore = true;
  while (hasMore) {
    const resp = await smdmRequest(apiKey, `/apps?limit=100&starting_after=${startingAfter}`);
    const items = resp.data || [];
    if (items.length > 0) {
      all = all.concat(items.map(a => ({ id: a.id, name: a.attributes.name })));
      startingAfter = items[items.length - 1].id;
      hasMore = items.length >= 100;
    } else {
      hasMore = false;
    }
  }
  return all;
}

async function fetchAllProfiles(apiKey) {
  let all = [];
  let startingAfter = 0;
  let hasMore = true;
  while (hasMore) {
    const resp = await smdmRequest(apiKey, `/profiles?limit=100&starting_after=${startingAfter}`);
    const items = resp.data || [];
    if (items.length > 0) {
      all = all.concat(items.map(p => ({ id: p.id, type: p.type, name: p.attributes.name })));
      startingAfter = items[items.length - 1].id;
      hasMore = items.length >= 100;
    } else {
      hasMore = false;
    }
  }
  return all;
}

// ── Fuzzy matching ──────────────────────────────────────────────────
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fuzzyMatchApp(appName, catalog) {
  const norm = normalize(appName);
  // 1. Exact normalized match
  let match = catalog.find(a => normalize(a.name) === norm);
  if (match) return match;
  // 2. One contains the other
  match = catalog.find(a => normalize(a.name).includes(norm) || norm.includes(normalize(a.name)));
  if (match) return match;
  // 3. Word overlap scoring
  const words = norm.split(/\s+/).filter(w => w.length > 2);
  let best = null, bestScore = 0;
  for (const a of catalog) {
    const aWords = normalize(a.name);
    let score = 0;
    for (const w of words) {
      if (aWords.includes(w)) score++;
    }
    if (score > bestScore && score >= Math.ceil(words.length * 0.5)) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

function matchHomeScreenLayout(appNames, layouts) {
  // Score each layout by how many of the selected app names appear in the layout name
  const normApps = appNames.map(n => normalize(n));
  let best = null, bestScore = 0;

  for (const layout of layouts) {
    const normLayout = normalize(layout.name);
    let score = 0;
    for (const normApp of normApps) {
      // Check if key parts of the app name appear in the layout name
      const shortName = normApp.replace(/pos|pointofsale|organizer|checkin|layout|homescreen/g, '').trim();
      if (shortName.length > 2 && normLayout.includes(shortName)) score++;
    }
    if (score > bestScore) {
      best = layout;
      bestScore = score;
    }
  }

  // Only return if we matched at least 1 app name
  return bestScore >= 1 ? best : null;
}

// ── Known profile IDs ───────────────────────────────────────────────
const PROFILE_IDS = {
  DEFAULT_RESTRICTIONS: 142210,
  DEFAULT_RESTRICTIONS_HOTSPOT: 160622,
  FELLO_WIFI: 133014,
  EVENTBRITE_PASSCODE: 160284,
  SAFARI_LOCK: 145745,
};

// ── Provisioning endpoint ───────────────────────────────────────────
app.post('/api/automation/provision', async (req, res) => {
  const dcrData = req.body;
  const apiKey = req.headers['x-simplemdm-key'] || req.headers.authorization;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing SimpleMDM API key. Send as x-simplemdm-key header.' });
  }

  // Validate required fields
  if (!dcrData.eventName) {
    return res.status(400).json({ error: 'Missing eventName in DCR payload.' });
  }

  const runId = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    id: runId,
    timestamp: new Date().toISOString(),
    eventName: dcrData.eventName || 'Unknown Event',
    orderNumber: dcrData.orderNumber || '',
    configMode: dcrData.configMode || 'Custom',
    contactName: dcrData.contactName || '',
    company: dcrData.company || '',
    status: 'running',
    groupId: null,
    groupName: '',
    appsRequested: dcrData.apps || [],
    appsMatched: [],
    appsFailed: [],
    profilesAssigned: [],
    layoutMatched: null,
    errors: [],
    dcrPayload: dcrData,
  };

  // Add to queue immediately
  provisioningQueue.unshift(run);
  saveQueue(provisioningQueue);

  // Run provisioning in background (don't block the response)
  (async () => {
    const authKey = apiKey.startsWith('Basic ') ? apiKey : apiKey;
    // Extract raw key for smdmRequest
    let rawKey;
    if (apiKey.startsWith('Basic ')) {
      rawKey = Buffer.from(apiKey.replace('Basic ', ''), 'base64').toString().replace(/:$/, '');
    } else {
      rawKey = apiKey;
    }

    try {
      // ── Step 1: Create Assignment Group ──
      const groupName = dcrData.orderNumber
        ? `${dcrData.eventName} — ${dcrData.orderNumber}`
        : dcrData.eventName;
      run.groupName = groupName;

      console.log(`[PROVISION] Creating group: "${groupName}"`);
      const groupResp = await smdmRequest(rawKey, '/assignment_groups', 'POST', {
        name: groupName,
        auto_deploy: true,
      });
      const groupId = groupResp.data?.id || groupResp.id;
      run.groupId = groupId;
      console.log(`[PROVISION] Group created: ID ${groupId}`);

      // ── Step 2: Match & Assign Apps ──
      const appCatalog = await fetchAllApps(rawKey);
      const requestedApps = dcrData.apps || [];

      for (const appName of requestedApps) {
        const match = fuzzyMatchApp(appName, appCatalog);
        if (match) {
          try {
            await smdmRequest(rawKey, `/assignment_groups/${groupId}/apps/${match.id}`, 'POST');
            run.appsMatched.push({ requested: appName, matched: match.name, id: match.id });
            console.log(`[PROVISION]   ✓ App: "${appName}" → "${match.name}" (${match.id})`);
          } catch (e) {
            run.appsMatched.push({ requested: appName, matched: match.name, id: match.id, warning: e.message });
            console.log(`[PROVISION]   ⚠ App assign failed: "${match.name}" — ${e.message}`);
          }
        } else {
          run.appsFailed.push(appName);
          console.log(`[PROVISION]   ✗ App not found: "${appName}"`);
        }
      }

      // ── Step 3: Assign Profiles ──
      const profilesToAssign = [];

      // Always: Default Restrictions + Fello WiFi
      profilesToAssign.push({ id: PROFILE_IDS.DEFAULT_RESTRICTIONS, name: 'Default Restrictions', reason: 'Always applied' });
      profilesToAssign.push({ id: PROFILE_IDS.FELLO_WIFI, name: 'Fello Wi-Fi', reason: 'Always applied' });

      // Mode-specific
      const mode = (dcrData.configMode || '').toLowerCase();
      if (mode.includes('check-in') || mode.includes('checkin')) {
        // If Eventbrite is in the app list, add passcode policy
        const hasEventbrite = requestedApps.some(a => normalize(a).includes('eventbrite'));
        if (hasEventbrite) {
          profilesToAssign.push({ id: PROFILE_IDS.EVENTBRITE_PASSCODE, name: 'Eventbrite Passcode Policy', reason: 'Check-in mode + Eventbrite' });
        }
      }

      if (mode.includes('kiosk')) {
        if (dcrData.lockdownMode === 'Single App Mode') {
          profilesToAssign.push({ id: PROFILE_IDS.SAFARI_LOCK, name: 'Safari Lock (Single App)', reason: 'Kiosk Single App Mode' });
        }
      }

      for (const prof of profilesToAssign) {
        try {
          await smdmRequest(rawKey, `/assignment_groups/${groupId}/profiles/${prof.id}`, 'POST');
          run.profilesAssigned.push({ name: prof.name, id: prof.id, reason: prof.reason });
          console.log(`[PROVISION]   ✓ Profile: "${prof.name}" (${prof.reason})`);
        } catch (e) {
          run.profilesAssigned.push({ name: prof.name, id: prof.id, reason: prof.reason, warning: e.message });
          console.log(`[PROVISION]   ⚠ Profile assign failed: "${prof.name}" — ${e.message}`);
        }
      }

      // ── Step 4: Auto-match Home Screen Layout ──
      const allProfiles = await fetchAllProfiles(rawKey);
      const layouts = allProfiles.filter(p => p.type === 'home_screen_layout');
      const layoutMatch = matchHomeScreenLayout(requestedApps, layouts);

      if (layoutMatch) {
        try {
          await smdmRequest(rawKey, `/assignment_groups/${groupId}/profiles/${layoutMatch.id}`, 'POST');
          run.layoutMatched = { name: layoutMatch.name, id: layoutMatch.id };
          console.log(`[PROVISION]   ✓ Layout: "${layoutMatch.name}" (auto-matched)`);
        } catch (e) {
          run.layoutMatched = { name: layoutMatch.name, id: layoutMatch.id, warning: e.message };
          console.log(`[PROVISION]   ⚠ Layout assign failed: "${layoutMatch.name}" — ${e.message}`);
        }
      } else {
        console.log(`[PROVISION]   ℹ No matching home screen layout found`);
      }

      // ── Done ──
      run.status = run.appsFailed.length > 0 || run.errors.length > 0 ? 'partial' : 'success';
      console.log(`[PROVISION] ✅ Complete: ${run.status} — Group "${groupName}" (ID: ${groupId})`);

    } catch (err) {
      run.status = 'failed';
      run.errors.push(err.message);
      console.error(`[PROVISION] ❌ Failed:`, err.message);
    }

    saveQueue(provisioningQueue);
  })();

  // Return immediately with run ID
  return res.status(202).json({
    message: 'Provisioning started',
    runId,
    groupName: run.groupName,
  });
});

// ── Queue API ───────────────────────────────────────────────────────
app.get('/api/automation/queue', (req, res) => {
  return res.json({ data: provisioningQueue });
});

app.get('/api/automation/queue/:id', (req, res) => {
  const run = provisioningQueue.find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  return res.json({ data: run });
});

app.delete('/api/automation/queue/:id', (req, res) => {
  const idx = provisioningQueue.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Run not found' });
  provisioningQueue.splice(idx, 1);
  saveQueue(provisioningQueue);
  return res.json({ message: 'Removed' });
});

// ══════════════════════════════════════════════════════════════════════
// ██  SimpleMDM Proxy Routes
// ══════════════════════════════════════════════════════════════════════

// Generic SimpleMDM proxy — forwards /api/simplemdm/* to SimpleMDM API
app.all('/api/simplemdm/*', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  // Strip /api/simplemdm prefix to get the SimpleMDM path
  const apiPath = req.path.replace('/api/simplemdm', '');
  const url = new URL(`https://a.simplemdm.com/api/v1${apiPath}`);

  // Forward query params
  Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const opts = {
      method: req.method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
      opts.body = JSON.stringify(req.body);
    }
    const resp = await fetch(url.toString(), opts);
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ██  Hexnode Proxy Routes
// ══════════════════════════════════════════════════════════════════════

// Generic Hexnode proxy — forwards /api/hexnode/* to Hexnode API
app.all('/api/hexnode/*', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  // Strip /api/hexnode prefix to get the Hexnode path
  const apiPath = req.path.replace('/api/hexnode', '');
  const url = new URL(`https://fello23.hexnodemdm.com/api/v1${apiPath}`);

  // Forward query params
  Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const opts = {
      method: req.method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
      opts.body = JSON.stringify(req.body);
    }
    const resp = await fetch(url.toString(), opts);
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('Hexnode proxy error:', err.message);
    return res.status(500).json({ error: 'Hexnode proxy failed: ' + err.message });
  }
});

// ── Fallback Routes ─────────────────────────────────────────────────
// Tool sub-apps: serve each tool's own index.html
app.get('/starlink/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'starlink', 'index.html'));
});
app.get('/simplemdm/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'simplemdm', 'index.html'));
});
app.get('/hexnode/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hexnode', 'index.html'));
});
app.get('/webbing/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'webbing', 'index.html'));
});
// Hub landing page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Fello Command Center`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Running at http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
