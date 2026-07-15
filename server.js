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

// ── Server Config (persisted to JSON) ───────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'automation-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { console.error('Config load error:', e.message); }
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) { console.error('Config save error:', e.message); }
}

let serverConfig = loadConfig();

// Env var fallback — Railway environment variables persist across deploys
function getSimpleMdmKey() {
  return serverConfig.simpleMdmKey || process.env.SIMPLEMDM_API_KEY || '';
}

// Config API — save/retrieve the SimpleMDM key so the DCR form doesn't need it
app.get('/api/automation/config', (req, res) => {
  return res.json({
    simpleMdmKeySet: !!getSimpleMdmKey(),
    keySource: serverConfig.simpleMdmKey ? 'config' : (process.env.SIMPLEMDM_API_KEY ? 'env' : 'none'),
    allowedOrigins: serverConfig.allowedOrigins || [],
  });
});

app.put('/api/automation/config', (req, res) => {
  const { simpleMdmKey, allowedOrigins } = req.body;
  if (simpleMdmKey !== undefined) serverConfig.simpleMdmKey = simpleMdmKey;
  if (allowedOrigins !== undefined) serverConfig.allowedOrigins = allowedOrigins;
  saveConfig(serverConfig);
  return res.json({ message: 'Config saved', simpleMdmKeySet: !!serverConfig.simpleMdmKey });
});

// ── DCR Submissions Log (persisted to JSON) ─────────────────────────
const DCR_LOG_FILE = path.join(__dirname, 'dcr-submissions.json');

function loadDcrLog() {
  try {
    if (fs.existsSync(DCR_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(DCR_LOG_FILE, 'utf8'));
    }
  } catch (e) { console.error('DCR log load error:', e.message); }
  return [];
}

function saveDcrLog(log) {
  try {
    fs.writeFileSync(DCR_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) { console.error('DCR log save error:', e.message); }
}

let dcrSubmissions = loadDcrLog();

// ── DCR Submit endpoint (public, CORS enabled) ─────────────────────
// This is what the DCR form POSTs to directly — no API key needed from the client
app.options('/api/dcr/submit', (req, res) => {
  // CORS preflight
  const origin = req.headers.origin || '';
  const allowed = serverConfig.allowedOrigins || [];
  if (allowed.length === 0 || allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin || '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  return res.sendStatus(204);
});

app.post('/api/dcr/submit', async (req, res) => {
  // CORS headers
  const origin = req.headers.origin || '';
  const allowed = serverConfig.allowedOrigins || [];
  if (allowed.length === 0 || allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin || '*');
  }

  const dcrData = req.body;

  if (!dcrData || !dcrData.eventName) {
    return res.status(400).json({ error: 'Missing eventName in DCR payload.' });
  }

  // Log the submission
  const submission = {
    id: `dcr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...dcrData,
  };
  dcrSubmissions.unshift(submission);
  saveDcrLog(dcrSubmissions);
  console.log(`[DCR] Submission received: "${dcrData.eventName}" (${dcrData.configMode || 'Custom'})`);

  // Auto-provision if SimpleMDM key is configured
  const apiKey = getSimpleMdmKey();
  if (apiKey) {
    // Trigger provisioning internally (reuse the existing logic)
    const fakeReq = {
      body: dcrData,
      headers: { 'x-simplemdm-key': apiKey },
    };
    const fakeRes = {
      status: () => ({ json: () => {} }),
      json: () => {},
    };
    // Import the provision handler by triggering the route programmatically
    try {
      const provisionUrl = `http://localhost:${PORT}/api/automation/provision`;
      const provRes = await fetch(provisionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-simplemdm-key': apiKey,
        },
        body: JSON.stringify(dcrData),
      });
      const provBody = await provRes.json();
      console.log(`[DCR] Auto-provisioning triggered: ${provBody.runId || 'unknown'}`);
      return res.json({
        status: 'success',
        message: 'Submission received and provisioning started',
        runId: provBody.runId,
      });
    } catch (e) {
      console.error(`[DCR] Auto-provision failed:`, e.message);
      return res.json({
        status: 'partial',
        message: 'Submission logged but auto-provisioning failed: ' + e.message,
      });
    }
  }

  return res.json({
    status: 'success',
    message: 'Submission received (no SimpleMDM key configured — provisioning skipped)',
  });
});

// DCR submissions API
app.get('/api/dcr/submissions', (req, res) => {
  return res.json({ data: dcrSubmissions });
});

app.delete('/api/dcr/submissions/:id', (req, res) => {
  const idx = dcrSubmissions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Submission not found' });
  dcrSubmissions.splice(idx, 1);
  saveDcrLog(dcrSubmissions);
  return res.json({ message: 'Removed' });
});

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
  return (str || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

function normalizeStrip(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fuzzyMatchApp(appName, catalog) {
  const normInput = normalize(appName);
  const inputWords = normInput.split(/\s+/).filter(w => w.length > 1);

  // 1. Exact normalized match (stripped)
  const stripped = normalizeStrip(appName);
  let match = catalog.find(a => normalizeStrip(a.name) === stripped);
  if (match) return match;

  // 2. All input words appear in catalog name
  match = catalog.find(a => {
    const catNorm = normalize(a.name);
    return inputWords.every(w => catNorm.includes(w));
  });
  if (match) return match;

  // 3. Word overlap scoring — best match where most input words appear
  let best = null, bestScore = 0, bestLen = Infinity;
  for (const a of catalog) {
    const catNorm = normalize(a.name);
    let score = 0;
    for (const w of inputWords) {
      if (catNorm.includes(w)) score++;
    }
    // Prefer higher score; on tie, prefer shorter name (more specific)
    if (score > 0 && (score > bestScore || (score === bestScore && a.name.length < bestLen))) {
      best = a;
      bestScore = score;
      bestLen = a.name.length;
    }
  }
  // Require at least half the input words to match
  if (best && bestScore >= Math.ceil(inputWords.length * 0.5)) return best;

  // 4. Substring containment as last resort
  match = catalog.find(a => {
    const catStripped = normalizeStrip(a.name);
    return catStripped.includes(stripped) || stripped.includes(catStripped);
  });
  return match || null;
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

// ── Bundled Mobileconfig Generator ──────────────────────────────────
// Generates a single .mobileconfig with multiple payloads per event,
// then uploads it to SimpleMDM as a custom configuration profile.

const crypto = require('crypto');

function escapeXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildMobileconfig(eventName, dcrData, payloads) {
  const rootUuid = crypto.randomUUID();
  const slug = eventName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 30);
  const rootIdentifier = `com.fello.event.${slug}`;

  const payloadXml = payloads.map(p => p.xml).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
${payloadXml}
    </array>
    <key>PayloadDisplayName</key>
    <string>${escapeXml(eventName)} — Custom Config</string>
    <key>PayloadIdentifier</key>
    <string>${rootIdentifier}</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${rootUuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`;
}

// ── Payload Generators ──────────────────────────────────────────────

function wifiPayload(ssid, password, securityType, hidden) {
  const uuid = crypto.randomUUID();
  const encryptionMap = { 'WPA2': 'WPA2', 'WPA2/WPA3': 'WPA3', 'WPA3': 'WPA3', 'WEP': 'WEP', 'None': 'None' };
  const encryption = encryptionMap[securityType] || 'WPA2';

  let xml = `        <dict>
            <key>AutoJoin</key>
            <true/>
            <key>EncryptionType</key>
            <string>${encryption}</string>
            <key>HIDDEN_NETWORK</key>
            <${hidden ? 'true' : 'false'}/>
            <key>PayloadDisplayName</key>
            <string>${escapeXml(ssid)} Wi-Fi</string>
            <key>PayloadIdentifier</key>
            <string>com.fello.wifi.${ssid.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}</string>
            <key>PayloadType</key>
            <string>com.apple.wifi.managed</string>
            <key>PayloadUUID</key>
            <string>${uuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>SSID_STR</key>
            <string>${escapeXml(ssid)}</string>`;

  if (encryption !== 'None' && password) {
    xml += `
            <key>Password</key>
            <string>${escapeXml(password)}</string>`;
  }

  xml += `
        </dict>`;
  return { name: `Wi-Fi: ${ssid}`, xml };
}

function passcodePayload(mode) {
  const uuid = crypto.randomUUID();
  // Check-in/Kiosk modes get a simple 6-digit passcode requirement
  return {
    name: `Passcode Policy (${mode})`,
    xml: `        <dict>
            <key>PayloadDisplayName</key>
            <string>Passcode Policy</string>
            <key>PayloadIdentifier</key>
            <string>com.fello.passcode.${mode.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}</string>
            <key>PayloadType</key>
            <string>com.apple.mobiledevice.passwordpolicy</string>
            <key>PayloadUUID</key>
            <string>${uuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>allowSimple</key>
            <true/>
            <key>forcePIN</key>
            <true/>
            <key>maxPINAgeInDays</key>
            <integer>0</integer>
            <key>minLength</key>
            <integer>6</integer>
            <key>requireAlphanumeric</key>
            <false/>
        </dict>`,
  };
}

function webContentFilterPayload(filterType, urls) {
  const uuid = crypto.randomUUID();
  const isWhitelist = filterType === 'Whitelist';

  let urlEntries = urls.map(u => `                <string>${escapeXml(u)}</string>`).join('\n');

  return {
    name: `Web Content Filter (${filterType})`,
    xml: `        <dict>
            <key>PayloadDisplayName</key>
            <string>Web Content Filter (${filterType})</string>
            <key>PayloadIdentifier</key>
            <string>com.fello.webfilter.${filterType.toLowerCase()}</string>
            <key>PayloadType</key>
            <string>com.apple.webcontent-filter</string>
            <key>PayloadUUID</key>
            <string>${uuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>AutoFilterEnabled</key>
            <false/>
            <key>FilterType</key>
            <string>BuiltIn</string>
            <key>${isWhitelist ? 'WhitelistedBookmarks' : 'BlacklistedURLs'}</key>
            <array>
${isWhitelist
  ? urls.map(u => `                <dict>
                    <key>Title</key>
                    <string>${escapeXml(u)}</string>
                    <key>URL</key>
                    <string>${escapeXml(u)}</string>
                </dict>`).join('\n')
  : urlEntries}
            </array>
        </dict>`,
  };
}

// ── Upload to SimpleMDM ─────────────────────────────────────────────

async function uploadCustomProfile(apiKey, profileName, mobileconfigXml) {
  const boundary = '----FormBoundary' + Date.now().toString(36) + crypto.randomUUID().slice(0, 8);
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="name"`,
    '',
    profileName,
    `--${boundary}`,
    `Content-Disposition: form-data; name="mobileconfig"; filename="config.mobileconfig"`,
    'Content-Type: application/x-apple-aspen-config',
    '',
    mobileconfigXml,
    `--${boundary}--`,
  ].join('\r\n');

  const res = await fetch('https://a.simplemdm.com/api/v1/custom_configuration_profiles', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to create custom profile: HTTP ${res.status} — ${errText}`);
  }

  const data = await res.json();
  return { id: data.data.id, name: profileName };
}

// ── Known profile IDs (reusable, always-applied) ────────────────────
const PROFILE_IDS = {
  DEFAULT_RESTRICTIONS: 142210,
  FELLO_WIFI: 133014,
  SAFARI_LOCK: 145745,  // Single App Lock (Kiosk mode)
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
    manualSetupNeeded: [],
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
        ? `${dcrData.orderNumber} - ${dcrData.eventName}`
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
      const requestedAppIds = dcrData.app_ids || []; // Direct IDs from catalog picker

      // If app_ids are provided, use them directly (from the searchable picker)
      if (requestedAppIds.length > 0) {
        for (const appId of requestedAppIds) {
          const catEntry = appCatalog.find(a => a.id === appId);
          const appName = catEntry ? catEntry.name : `App #${appId}`;
          try {
            await smdmRequest(rawKey, `/assignment_groups/${groupId}/apps/${appId}`, 'POST');
            run.appsMatched.push({ requested: appName, matched: appName, id: appId });
            console.log(`[PROVISION]   ✓ App: "${appName}" (${appId})`);
          } catch (e) {
            run.appsMatched.push({ requested: appName, matched: appName, id: appId, warning: e.message });
            console.log(`[PROVISION]   ⚠ App assign failed: "${appName}" — ${e.message}`);
          }
        }
      }

      // Also fuzzy-match any text app names (from DCR form submissions)
      for (const appName of requestedApps) {
        // Skip if we already assigned this app via ID
        const alreadyAssigned = run.appsMatched.some(a =>
          normalize(a.matched).includes(normalize(appName)) ||
          normalize(appName).includes(normalize(a.matched))
        );
        if (alreadyAssigned) continue;

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
      const manualSetupNeeded = [];
      const eventName = dcrData.eventName || dcrData.orderNumber || 'Event';
      const mode = (dcrData.configMode || '').toLowerCase();

      // ═══ Always applied (existing SimpleMDM profiles) ═══
      profilesToAssign.push({ id: PROFILE_IDS.DEFAULT_RESTRICTIONS, name: 'Default Restrictions', reason: 'Always applied' });
      profilesToAssign.push({ id: PROFILE_IDS.FELLO_WIFI, name: 'Fello Wi-Fi', reason: 'Always applied' });

      // ═══ Kiosk Single App Lock (native SimpleMDM profile) ═══
      if (mode.includes('kiosk')) {
        if (dcrData.lockdownMode === 'Single App Mode') {
          profilesToAssign.push({ id: PROFILE_IDS.SAFARI_LOCK, name: 'Safari Lock (Single App)', reason: 'Kiosk Single App Mode' });
        } else if (dcrData.lockdownMode === 'Guided Access') {
          manualSetupNeeded.push('Guided Access passcode must be configured per-device' + (dcrData.guidedAccessPasscode ? ` (passcode: ${dcrData.guidedAccessPasscode})` : ''));
        }
      }

      // ═══ Build bundled mobileconfig (event-specific payloads) ═══
      const bundledPayloads = [];

      // Helper: check if an app name is in the requested list
      const hasApp = (keyword) => {
        const allApps = [...requestedApps, ...run.appsMatched.map(a => a.matched)];
        return allApps.some(a => normalize(a).includes(keyword));
      };

      // -- Custom Wi-Fi --
      if (dcrData.wifiEnabled === 'Yes' && dcrData.wifiSsid && dcrData.wifiSsid.trim()) {
        bundledPayloads.push(wifiPayload(
          dcrData.wifiSsid.trim(),
          dcrData.wifiPassword || '',
          dcrData.wifiSecurity || 'WPA2',
          dcrData.wifiHidden === 'Yes'
        ));
      }

      // -- Passcode Policy --
      // Check-in + Eventbrite, or Kiosk mode
      if ((mode.includes('check-in') || mode.includes('checkin')) && hasApp('eventbrite')) {
        bundledPayloads.push(passcodePayload('Check-in'));
      } else if (mode.includes('kiosk')) {
        bundledPayloads.push(passcodePayload('Kiosk'));
      }

      // -- Web Content Filter (Kiosk only) --
      if (mode.includes('kiosk') && dcrData.restrictionsEnabled === 'Yes' &&
          dcrData.restrictionType && dcrData.restrictionUrls && dcrData.restrictionUrls.length > 0) {
        bundledPayloads.push(webContentFilterPayload(dcrData.restrictionType, dcrData.restrictionUrls));
      }

      // ═══ Upload bundled mobileconfig if there are payloads ═══
      if (bundledPayloads.length > 0) {
        const profileName = `${eventName} — Custom Config`;
        try {
          const mobileconfigXml = buildMobileconfig(eventName, dcrData, bundledPayloads);
          const uploaded = await uploadCustomProfile(rawKey, profileName, mobileconfigXml);
          profilesToAssign.push({ id: uploaded.id, name: uploaded.name, reason: `Bundled config (${bundledPayloads.map(p => p.name).join(', ')})` });
          run.customConfigCreated = {
            id: uploaded.id,
            name: uploaded.name,
            payloads: bundledPayloads.map(p => p.name),
          };
          console.log(`[PROVISION]   ✓ Created bundled config: "${profileName}" (ID: ${uploaded.id})`);
          console.log(`[PROVISION]     Payloads: ${bundledPayloads.map(p => p.name).join(', ')}`);
        } catch (e) {
          console.error(`[PROVISION]   ✗ Failed to create bundled config:`, e.message);
          manualSetupNeeded.push(`Bundled config creation failed: ${e.message}`);
          // List individual payloads that need manual setup
          bundledPayloads.forEach(p => manualSetupNeeded.push(`  → ${p.name} needs manual configuration`));
        }
      }

      // ═══ Items that still need manual setup ═══

      // Custom wallpaper (requires image upload — can't do via mobileconfig)
      if (dcrData.customWallpaper === 'Yes') {
        manualSetupNeeded.push('Custom wallpaper requested — upload image in SimpleMDM');
      }

      // Web clips (Kiosk — could be bundled but need icon assets)
      if (dcrData.webClips && dcrData.webClips.length > 0) {
        manualSetupNeeded.push(`Web clips need manual setup: ${dcrData.webClips.join(', ')}`);
      }

      // App login credentials
      if (dcrData.appLoginEnabled === 'Yes') {
        const loginApps = dcrData.appLoginApps || [];
        manualSetupNeeded.push(`App login credentials needed for: ${loginApps.length > 0 ? loginApps.join(', ') : 'selected apps'}`);
      }

      // Custom home screen layout
      if (dcrData.homeScreenLayout === 'Custom') {
        manualSetupNeeded.push('Custom home screen layout — create layout profile manually');
      }

      // Store manual setup items in the run
      run.manualSetupNeeded = manualSetupNeeded;
      if (manualSetupNeeded.length > 0) {
        console.log(`[PROVISION]   ⚙ Manual setup needed (${manualSetupNeeded.length} items):`);
        manualSetupNeeded.forEach(item => console.log(`[PROVISION]     • ${item}`));
      }

      // Assign all profiles to the group
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
      run.status = (run.appsFailed.length > 0 || run.errors.length > 0 || run.manualSetupNeeded.length > 0) ? 'partial' : 'success';
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

// ── App Catalog endpoint (cached) ───────────────────────────────────
let appCatalogCache = { data: null, expiry: 0 };

app.get('/api/automation/apps', async (req, res) => {
  const apiKey = req.headers['x-simplemdm-key'] || req.headers.authorization;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing SimpleMDM API key.' });
  }

  const now = Date.now();
  if (appCatalogCache.data && now < appCatalogCache.expiry) {
    return res.json({ data: appCatalogCache.data });
  }

  try {
    let rawKey = apiKey.startsWith('Basic ')
      ? Buffer.from(apiKey.replace('Basic ', ''), 'base64').toString().replace(/:$/, '')
      : apiKey;
    const apps = await fetchAllApps(rawKey);
    appCatalogCache = { data: apps, expiry: now + 10 * 60 * 1000 }; // 10 min cache
    return res.json({ data: apps });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
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

// ── Proxy: SimpleMDM — Group Management (Profiles, Apps, Devices) ──

// List profiles assigned to a group
app.get('/api/simplemdm/assignment_groups/:groupId/profiles', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/profiles`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM group profiles proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// Remove a profile from a group
app.delete('/api/simplemdm/assignment_groups/:groupId/profiles/:profileId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/profiles/${req.params.profileId}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM remove group profile proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// Add a profile to a group
app.post('/api/simplemdm/assignment_groups/:groupId/profiles/:profileId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/profiles/${req.params.profileId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM add group profile proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// List apps assigned to a group
app.get('/api/simplemdm/assignment_groups/:groupId/apps', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/apps`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM group apps proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// Remove an app from a group
app.delete('/api/simplemdm/assignment_groups/:groupId/apps/:appId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/apps/${req.params.appId}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM remove group app proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// Add an app to a group
app.post('/api/simplemdm/assignment_groups/:groupId/apps/:appId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/apps/${req.params.appId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM add group app proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// Add a device to a group
app.post('/api/simplemdm/assignment_groups/:groupId/devices/:deviceId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/devices/${req.params.deviceId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM add group device proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// Remove a device from a group
app.delete('/api/simplemdm/assignment_groups/:groupId/devices/:deviceId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/devices/${req.params.deviceId}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM remove group device proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// List all profiles (paginated, limit=100)
app.get('/api/simplemdm/profiles', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = new URL('https://a.simplemdm.com/api/v1/profiles');
    url.searchParams.set('limit', '100');
    if (req.query.page != null) url.searchParams.set('starting_after', req.query.page);
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM profiles proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// List all apps (paginated, limit=100)
app.get('/api/simplemdm/apps', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = new URL('https://a.simplemdm.com/api/v1/apps');
    url.searchParams.set('limit', '100');
    if (req.query.page != null) url.searchParams.set('starting_after', req.query.page);
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } else {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('SimpleMDM apps proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

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
