const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');

// File upload config — uses /data for Railway volume persistence, falls back to ./data
const UPLOAD_DIR = fs.existsSync('/data') ? '/data/uploads' : path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const subId = req.params.id || 'temp';
      const dir = path.join(UPLOAD_DIR, subId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

// ── ABM (Apple Business Manager) API ─────────────────────────────────
const ABM_CONFIG = {
  clientId: process.env.ABM_CLIENT_ID || 'BUSINESSAPI.29f7a116-5e25-4bf9-a7a4-96a62621fd1d',
  keyId: process.env.ABM_KEY_ID || 'b81b2e1d-068c-4112-8c73-c2a7ebe43ca0',
  tokenUrl: 'https://account.apple.com/auth/oauth2/v2/token',
  apiBase: 'https://api-business.apple.com/v1',
  simpleMdmServerId: '399E3FA11E9C47E1AEB621C9522C604C',
};

// Try loading private key from env or file
let abmPrivateKey = null;
try {
  const pemEnv = process.env.ABM_PRIVATE_KEY;
  if (pemEnv) {
    abmPrivateKey = crypto.createPrivateKey(pemEnv.replace(/\\n/g, '\n'));
  } else {
    // Fallback to local file for development
    const pemPath = path.join(process.env.HOME || '', 'Downloads', 'Fello_COmmand_Center.pem');
    if (fs.existsSync(pemPath)) {
      abmPrivateKey = crypto.createPrivateKey(fs.readFileSync(pemPath, 'utf8'));
    }
  }
  if (abmPrivateKey) console.log('[ABM] Private key loaded ✓');
  else console.log('[ABM] No private key found — ABM features disabled');
} catch (e) {
  console.error('[ABM] Failed to load private key:', e.message);
}

function base64url(buf) { return Buffer.from(buf).toString('base64url'); }

let abmTokenCache = { token: null, expiresAt: 0 };

async function getAbmToken() {
  // Return cached token if still valid (with 60s buffer)
  if (abmTokenCache.token && Date.now() < abmTokenCache.expiresAt - 60000) {
    return abmTokenCache.token;
  }

  if (!abmPrivateKey) throw new Error('ABM private key not configured');

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: ABM_CONFIG.keyId, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    iss: ABM_CONFIG.clientId,
    sub: ABM_CONFIG.clientId,
    aud: ABM_CONFIG.tokenUrl,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
  }));

  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), {
    key: abmPrivateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${base64url(sig)}`;

  const resp = await fetch(ABM_CONFIG.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ABM_CONFIG.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
      scope: 'business.api',
    }),
  });

  const data = await resp.json();
  if (!data.access_token) throw new Error('ABM auth failed: ' + (data.error || 'unknown'));

  abmTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  console.log('[ABM] Token refreshed ✓');
  return abmTokenCache.token;
}

async function abmLookupDevice(serial) {
  const token = await getAbmToken();
  const resp = await fetch(`${ABM_CONFIG.apiBase}/orgDevices/${serial}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  return (await resp.json()).data;
}

async function abmAssignToSimpleMdm(serials) {
  const token = await getAbmToken();
  const resp = await fetch(`${ABM_CONFIG.apiBase}/orgDeviceActivities`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'orgDeviceActivities',
        attributes: { activityType: 'ASSIGN_DEVICES' },
        relationships: {
          mdmServer: {
            data: { type: 'mdmServers', id: ABM_CONFIG.simpleMdmServerId },
          },
          devices: {
            data: serials.map(sn => ({ type: 'orgDevices', id: sn })),
          },
        },
      },
    }),
  });
  const result = await resp.json();
  return { status: resp.status, data: result.data || result };
}

async function abmUnassignDevices(serials) {
  if (!abmPrivateKey || serials.length === 0) return { status: 0, skipped: true };
  const token = await getAbmToken();
  const payload = {
    data: {
      type: 'orgDeviceActivities',
      attributes: { activityType: 'UNASSIGN_DEVICES' },
      relationships: {
        mdmServer: {
          data: { type: 'mdmServers', id: ABM_CONFIG.simpleMdmServerId },
        },
        devices: {
          data: serials.map(sn => ({ type: 'orgDevices', id: sn })),
        },
      },
    },
  };
  console.log(`[ABM] Unassign request: ${JSON.stringify(payload)}`);
  const resp = await fetch(`${ABM_CONFIG.apiBase}/orgDeviceActivities`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const rawText = await resp.text();
  console.log(`[ABM] Unassign response: status=${resp.status}, body=${rawText}`);
  let result;
  try { result = JSON.parse(rawText); } catch { result = rawText; }
  return { status: resp.status, data: result.data || result };
}

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json({ limit: '50mb' }));
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

app.options('/api/dcr/:id/upload', (req, res) => {
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
    status: 'pending',
    notes: [],
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
        id: submission.id,
      });
    } catch (e) {
      console.error(`[DCR] Auto-provision failed:`, e.message);
      return res.json({
        status: 'partial',
        message: 'Submission logged but auto-provisioning failed: ' + e.message,
        id: submission.id,
      });
    }
  }

  return res.json({
    status: 'success',
    message: 'Submission received (no SimpleMDM key configured — provisioning skipped)',
    id: submission.id,
  });
});

// DCR submissions API — list (supports ?status= filter)
app.get('/api/dcr/submissions', (req, res) => {
  let subs = [...dcrSubmissions];
  if (req.query.status) {
    subs = subs.filter(s => s.status === req.query.status);
  }
  // Newest first
  subs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return res.json(subs);
});

// DCR — get single submission
app.get('/api/dcr/:id', (req, res) => {
  const sub = dcrSubmissions.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  return res.json(sub);
});

// DCR — update status
app.patch('/api/dcr/:id/status', (req, res) => {
  const sub = dcrSubmissions.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (req.body.status) {
    sub.status = req.body.status;
    saveDcrLog(dcrSubmissions);
    console.log(`[DCR] Status updated: ${sub.id} → ${sub.status}`);
  }
  return res.json(sub);
});

// DCR — add internal note
app.post('/api/dcr/:id/notes', (req, res) => {
  const sub = dcrSubmissions.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (!sub.notes) sub.notes = [];
  sub.notes.push({
    text: req.body.note,
    author: req.body.author || 'Admin',
    timestamp: new Date().toISOString(),
  });
  saveDcrLog(dcrSubmissions);
  return res.json(sub);
});

// DCR — upload files for a submission
app.post('/api/dcr/:id/upload', upload.array('files', 20), (req, res) => {
  try {
    const files = (req.files || []).map(f => ({
      name: f.originalname,
      storedName: f.filename,
      size: f.size,
      type: f.mimetype,
      url: `/api/dcr/${req.params.id}/files/${f.filename}`,
      category: req.body.category || 'general',
    }));

    // Update submission with file references
    const sub = dcrSubmissions.find(s => s.id === req.params.id);
    if (sub) {
      if (!sub.files) sub.files = [];
      sub.files.push(...files);
      saveDcrLog(dcrSubmissions);
    }

    res.json({ status: 'success', files });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// DCR — serve uploaded files
app.get('/api/dcr/:id/files/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.id, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// DCR — list files for a submission
app.get('/api/dcr/:id/files', (req, res) => {
  const dir = path.join(UPLOAD_DIR, req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).map(name => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, size: stat.size, url: `/api/dcr/${req.params.id}/files/${name}` };
  });
  res.json(files);
});

// DCR — delete submission
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
      'Accept': 'application/json',
    },
  };
  if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
    // SimpleMDM API expects form-urlencoded data, not JSON
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(body)) {
      params.append(key, String(val));
    }
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = params.toString();
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

function wallpaperPayload(imageBase64, where) {
  // where: 1=lock, 2=home, 3=both
  const uuid = crypto.randomUUID();
  const whereInt = where === 'lock' ? 1 : where === 'home' ? 2 : 3;

  return {
    name: `Wallpaper (${where === 'lock' ? 'Lock Screen' : where === 'home' ? 'Home Screen' : 'Both'})`,
    xml: `        <dict>
            <key>PayloadDisplayName</key>
            <string>Wallpaper</string>
            <key>PayloadIdentifier</key>
            <string>com.fello.wallpaper</string>
            <key>PayloadType</key>
            <string>com.apple.wallpaper</string>
            <key>PayloadUUID</key>
            <string>${uuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>Image</key>
            <dict>
                <key>Where</key>
                <integer>${whereInt}</integer>
                <key>ImageData</key>
                <data>${imageBase64}</data>
            </dict>
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

// ── DEP Sync ────────────────────────────────────────────────────────
app.post('/api/simplemdm/dep/sync', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const resp = await fetch('https://a.simplemdm.com/api/v1/dep_servers/10650/sync', {
      method: 'POST',
      headers: { Authorization: auth },
    });
    console.log(`[DEP] Sync triggered — status ${resp.status}`);
    return res.status(resp.status).json({ status: 'sync_triggered' });
  } catch (err) {
    console.error('[DEP] Sync error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Assign Devices by Serial Number ─────────────────────────────────
app.post('/api/simplemdm/groups/:groupId/assign-serials', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const { serials, autoSync } = req.body;
  const groupId = req.params.groupId;

  // Rate-limit helper: small delay between API calls to avoid throttling
  const apiDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const API_DELAY = 300; // ms between mutating calls

  if (!Array.isArray(serials) || serials.length === 0) {
    return res.status(400).json({ error: 'No serial numbers provided' });
  }

  // Deduplicate and clean
  const cleanSerials = [...new Set(serials.map(s => s.trim().toUpperCase()).filter(Boolean))];
  console.log(`[ASSIGN] Processing ${cleanSerials.length} serials for group ${groupId}`);

  // Extract the API key for smdmRequest calls
  let rawKey;
  if (auth.startsWith('Basic ')) {
    rawKey = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().replace(/:$/, '');
  } else {
    rawKey = auth;
  }

  // Fetch group name to extract order number for device naming
  let orderNumber = null;
  let existingDeviceCount = 0;
  try {
    const groupData = await smdmRequest(rawKey, `/assignment_groups/${groupId}`);
    const groupName = groupData.data?.attributes?.name || '';
    // Extract order number: everything before " - " in the group name
    const dashIdx = groupName.indexOf(' - ');
    orderNumber = dashIdx > 0 ? groupName.substring(0, dashIdx).trim() : null;
    console.log(`[ASSIGN] Group name: "${groupName}", order number: "${orderNumber}"`);

    // Count existing devices in the group to determine starting sequence number
    if (orderNumber) {
      const groupDetail = groupData.data?.relationships?.devices?.data || [];
      existingDeviceCount = groupDetail.length;
      // Also check device_groups for nested devices
      const deviceGroups = groupData.data?.relationships?.device_groups?.data || [];
      // For simplicity, just count direct devices
      console.log(`[ASSIGN] Group has ${existingDeviceCount} existing devices, starting sequence at ${existingDeviceCount + 1}`);
    }
  } catch (groupErr) {
    console.error(`[ASSIGN] Could not fetch group name for device naming:`, groupErr.message);
  }

  let sequenceNumber = existingDeviceCount;
  const results = { assigned: [], notFound: [], errors: [] };

  // ── Pre-fetch: Build a serial→device map from enrolled devices ──
  console.log('[ASSIGN] Pre-fetching enrolled device list...');
  const enrolledBySerial = new Map();
  try {
    let hasMore = true;
    let startingAfter = '';
    while (hasMore) {
      const url = `https://a.simplemdm.com/api/v1/devices?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
      const resp = await fetch(url, { headers: { Authorization: auth } });
      const data = resp.ok ? await resp.json() : { data: [], has_more: false };
      for (const d of (data.data || [])) {
        const sn = d.attributes?.serial_number?.toUpperCase();
        if (sn) enrolledBySerial.set(sn, d);
      }
      hasMore = data.has_more === true;
      const items = data.data || [];
      startingAfter = items.length > 0 ? items[items.length - 1].id : '';
      if (!startingAfter) break;
    }
    console.log(`[ASSIGN] Pre-fetched ${enrolledBySerial.size} enrolled devices`);
  } catch (fetchErr) {
    console.error('[ASSIGN] Failed to pre-fetch enrolled devices:', fetchErr.message);
  }

  // ── Pre-fetch: Build a serial→depDevice map from DEP devices ──
  console.log('[ASSIGN] Pre-fetching DEP device list...');
  const depBySerial = new Map();
  try {
    let hasMore = true;
    let depCursor = '';
    while (hasMore) {
      const depUrl = `https://a.simplemdm.com/api/v1/dep_servers/10650/dep_devices?limit=100${depCursor ? `&starting_after=${depCursor}` : ''}`;
      const depResp = await fetch(depUrl, { headers: { Authorization: auth } });
      const depData = depResp.ok ? await depResp.json() : { data: [], has_more: false };
      for (const d of (depData.data || [])) {
        const sn = d.attributes?.serial_number?.toUpperCase();
        if (sn) depBySerial.set(sn, d);
      }
      hasMore = depData.has_more === true;
      const items = depData.data || [];
      depCursor = items.length > 0 ? items[items.length - 1].id : '';
      if (!depCursor) break;
    }
    console.log(`[ASSIGN] Pre-fetched ${depBySerial.size} DEP devices`);
  } catch (fetchErr) {
    console.error('[ASSIGN] Failed to pre-fetch DEP devices:', fetchErr.message);
  }

  // ── Process each serial using the pre-fetched maps ──
  for (const sn of cleanSerials) {
    try {
      // Check enrolled devices (from pre-fetched map — no API call needed)
      const device = enrolledBySerial.get(sn);

      if (device) {
        // Found enrolled device — assign to group
        await apiDelay(API_DELAY);
        const assignResp = await fetch(`https://a.simplemdm.com/api/v1/assignment_groups/${groupId}/devices/${device.id}`, {
          method: 'POST',
          headers: { Authorization: auth },
        });
        if (assignResp.status === 204 || assignResp.ok) {
          // Rename the device if we have an order number
          let newName = device.attributes.name || sn;
          if (orderNumber) {
            sequenceNumber++;
            newName = `${orderNumber} (${String(sequenceNumber).padStart(2, '0')})`;
            try {
              await apiDelay(API_DELAY);
              await smdmRequest(rawKey, `/devices/${device.id}`, 'PATCH', { name: newName, device_name: newName });
              console.log(`[ASSIGN]   📝 Renamed device ${device.id} → "${newName}"`);
            } catch (renameErr) {
              console.error(`[ASSIGN]   ⚠ Rename failed for ${device.id}: ${renameErr.message}`);
            }
          }
          results.assigned.push({ serial: sn, deviceId: device.id, name: newName, source: 'enrolled' });
          console.log(`[ASSIGN]   ✓ ${sn} → device ${device.id} → group ${groupId}`);
        } else {
          results.errors.push({ serial: sn, error: `Assignment failed (${assignResp.status})` });
        }
        continue;
      }

      // Check DEP devices (from pre-fetched map — no API call needed)
      const depDevice = depBySerial.get(sn);

      if (depDevice) {
        const linkedDevice = depDevice.relationships?.device?.data;
        if (linkedDevice && linkedDevice.id) {
          // Has an enrolled device link — assign that
          await apiDelay(API_DELAY);
          const assignResp = await fetch(`https://a.simplemdm.com/api/v1/assignment_groups/${groupId}/devices/${linkedDevice.id}`, {
            method: 'POST',
            headers: { Authorization: auth },
          });
          if (assignResp.status === 204 || assignResp.ok) {
            // Rename the device if we have an order number
            let newName = sn;
            if (orderNumber) {
              sequenceNumber++;
              newName = `${orderNumber} (${String(sequenceNumber).padStart(2, '0')})`;
              try {
                await apiDelay(API_DELAY);
                await smdmRequest(rawKey, `/devices/${linkedDevice.id}`, 'PATCH', { name: newName, device_name: newName });
                console.log(`[ASSIGN]   📝 Renamed device ${linkedDevice.id} → "${newName}"`);
              } catch (renameErr) {
                console.error(`[ASSIGN]   ⚠ Rename failed for ${linkedDevice.id}: ${renameErr.message}`);
              }
            }
            results.assigned.push({ serial: sn, deviceId: linkedDevice.id, name: newName, source: 'dep_enrolled' });
            console.log(`[ASSIGN]   ✓ ${sn} → DEP device ${depDevice.id} → enrolled device ${linkedDevice.id} → group`);
          } else {
            results.errors.push({ serial: sn, error: `DEP assignment failed (${assignResp.status})` });
          }
        } else {
          // DEP device but not yet enrolled — flag it
          results.notFound.push({ serial: sn, reason: 'In DEP but not enrolled yet (device needs to be powered on)' });
          console.log(`[ASSIGN]   ⚠ ${sn} found in DEP but not enrolled`);
        }
        continue;
      }

      // Not in SimpleMDM at all — try ABM
      if (abmPrivateKey) {
        try {
          await apiDelay(API_DELAY);
          const abmDevice = await abmLookupDevice(sn);
          if (abmDevice) {
            const abmStatus = abmDevice.attributes?.status;
            if (abmStatus === 'UNASSIGNED' || abmStatus === 'REMOVED') {
              // Assign to SimpleMDM via ABM
              results.abmPending = results.abmPending || [];
              results.abmPending.push({ serial: sn, model: abmDevice.attributes?.deviceModel || 'Unknown' });
              console.log(`[ASSIGN]   🔵 ${sn} found in ABM (${abmStatus}) — queued for MDM assignment`);
            } else if (abmStatus === 'ASSIGNED') {
              // Check which server it's assigned to
              try {
                await apiDelay(API_DELAY);
                const abmToken = await getAbmToken();
                const srvResp = await fetch(`${ABM_CONFIG.apiBase}/orgDevices/${sn}/assignedServer`, {
                  headers: { Authorization: `Bearer ${abmToken}` },
                });
                const srvData = srvResp.ok ? await srvResp.json() : null;
                const assignedServerId = srvData?.data?.id;
                const assignedServerName = srvData?.data?.attributes?.serverName;

                if (assignedServerId === ABM_CONFIG.simpleMdmServerId) {
                  results.notFound.push({ serial: sn, reason: 'Already assigned to Fello SimpleMDM in ABM — try syncing ABM or the device may need to enroll' });
                  console.log(`[ASSIGN]   ⚠ ${sn} already assigned to Fello SimpleMDM — needs DEP sync or enrollment`);
                } else {
                  results.notFound.push({ serial: sn, reason: `Assigned to "${assignedServerName || 'another MDM server'}" in ABM` });
                  console.log(`[ASSIGN]   ⚠ ${sn} assigned to different server: ${assignedServerName} (${assignedServerId})`);
                }
              } catch (srvErr) {
                results.notFound.push({ serial: sn, reason: 'Assigned to an MDM server in ABM (could not determine which)' });
              }
            } else {
              results.notFound.push({ serial: sn, reason: `ABM status: ${abmStatus}` });
              console.log(`[ASSIGN]   ⚠ ${sn} in ABM with status: ${abmStatus}`);
            }
          } else {
            results.notFound.push({ serial: sn, reason: 'Not found in SimpleMDM, DEP, or Apple Business Manager' });
            console.log(`[ASSIGN]   ✗ ${sn} not found anywhere (including ABM)`);
          }
        } catch (abmErr) {
          console.error(`[ASSIGN]   ABM lookup failed for ${sn}:`, abmErr.message);
          results.notFound.push({ serial: sn, reason: 'Not found in SimpleMDM/DEP; ABM lookup failed' });
        }
      } else {
        results.notFound.push({ serial: sn, reason: 'Not found — ABM integration not configured' });
        console.log(`[ASSIGN]   ✗ ${sn} not found — ABM not configured`);
      }
    } catch (err) {
      results.errors.push({ serial: sn, error: err.message });
      console.error(`[ASSIGN]   ✗ ${sn} error:`, err.message);
    }
  }

  // Batch-assign ABM pending devices to SimpleMDM
  if (results.abmPending && results.abmPending.length > 0) {
    try {
      const abmSerials = results.abmPending.map(d => d.serial);
      console.log(`[ASSIGN] Assigning ${abmSerials.length} devices to SimpleMDM via ABM API...`);
      const abmResult = await abmAssignToSimpleMdm(abmSerials);

      if (abmResult.status === 201 || abmResult.status === 200) {
        for (const d of results.abmPending) {
          let deviceName = `${d.model} (${d.serial})`;
          if (orderNumber) {
            sequenceNumber++;
            deviceName = `${orderNumber} (${String(sequenceNumber).padStart(2, '0')})`;
          }
          results.assigned.push({
            serial: d.serial,
            name: deviceName,
            plannedName: orderNumber ? deviceName : null,
            source: 'abm_assigned',
            deviceId: null,
          });
        }
        console.log(`[ASSIGN] ✓ ABM assignment submitted (activity: ${abmResult.data?.id || 'unknown'})`);

        // Trigger SimpleMDM DEP sync with retry so devices appear
        let syncSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await apiDelay(attempt === 1 ? 1000 : 3000); // Wait longer on retries
            const syncResp = await fetch('https://a.simplemdm.com/api/v1/dep_servers/10650/sync', {
              method: 'POST',
              headers: { Authorization: auth },
            });
            console.log(`[ASSIGN] DEP sync attempt ${attempt}: status ${syncResp.status}`);
            if (syncResp.ok || syncResp.status === 202 || syncResp.status === 204) {
              syncSuccess = true;
              results.syncTriggered = true;
              console.log('[ASSIGN] ✓ DEP sync triggered after ABM assignment');
              break;
            }
          } catch (syncErr) {
            console.error(`[ASSIGN] DEP sync attempt ${attempt} failed:`, syncErr.message);
          }
        }

        // ── Post-sync: Wait for devices to appear, then assign to group ──
        if (syncSuccess) {
          console.log('[ASSIGN] Waiting for DEP sync to propagate...');
          await apiDelay(5000); // Wait 5s for sync to complete

          // Re-fetch DEP devices to find the newly synced ones
          const abmSerialsSet = new Set(abmSerials);
          let postSyncFound = 0;

          // Paginate through DEP devices looking for our serials
          let hasMore = true;
          let depCursor = '';
          while (hasMore) {
            try {
              const depUrl = `https://a.simplemdm.com/api/v1/dep_servers/10650/dep_devices?limit=100${depCursor ? `&starting_after=${depCursor}` : ''}`;
              const depResp = await fetch(depUrl, { headers: { Authorization: auth } });
              const depData = depResp.ok ? await depResp.json() : { data: [], has_more: false };
              const depDevices = depData.data || [];

              for (const depDev of depDevices) {
                const depSn = depDev.attributes?.serial_number?.toUpperCase();
                if (!depSn || !abmSerialsSet.has(depSn)) continue;

                // Found one of our devices in DEP
                const linkedDevice = depDev.relationships?.device?.data;
                if (linkedDevice && linkedDevice.id) {
                  // Device has an enrolled/awaiting record — assign to group
                  try {
                    await apiDelay(API_DELAY);
                    const assignResp = await fetch(`https://a.simplemdm.com/api/v1/assignment_groups/${groupId}/devices/${linkedDevice.id}`, {
                      method: 'POST',
                      headers: { Authorization: auth },
                    });
                    if (assignResp.status === 204 || assignResp.ok) {
                      // Update the result entry with the real device ID
                      const resultEntry = results.assigned.find(r => r.serial === depSn && r.source === 'abm_assigned');
                      if (resultEntry) {
                        resultEntry.deviceId = linkedDevice.id;
                        resultEntry.source = 'abm_assigned_to_group';
                      }
                      // Rename the device
                      if (resultEntry?.plannedName) {
                        try {
                          await apiDelay(API_DELAY);
                          await smdmRequest(rawKey, `/devices/${linkedDevice.id}`, 'PATCH', {
                            name: resultEntry.plannedName,
                            device_name: resultEntry.plannedName,
                          });
                          console.log(`[ASSIGN]   📝 Renamed ${depSn} → "${resultEntry.plannedName}"`);
                        } catch (renameErr) {
                          console.error(`[ASSIGN]   ⚠ Rename failed for ${depSn}: ${renameErr.message}`);
                        }
                      }
                      postSyncFound++;
                      console.log(`[ASSIGN]   ✓ Post-sync: ${depSn} → device ${linkedDevice.id} → group ${groupId}`);
                    }
                  } catch (assignErr) {
                    console.error(`[ASSIGN]   ⚠ Post-sync assign failed for ${depSn}: ${assignErr.message}`);
                  }
                } else {
                  console.log(`[ASSIGN]   ⚠ Post-sync: ${depSn} in DEP but no device link yet`);
                }
                abmSerialsSet.delete(depSn);
              }

              hasMore = depData.has_more === true && abmSerialsSet.size > 0;
              depCursor = depDevices.length > 0 ? depDevices[depDevices.length - 1].id : '';
              if (!depCursor) break;
            } catch (pageErr) {
              console.error('[ASSIGN] Post-sync DEP pagination error:', pageErr.message);
              break;
            }
          }

          console.log(`[ASSIGN] Post-sync: ${postSyncFound}/${abmSerials.length} devices assigned to group`);
          if (abmSerialsSet.size > 0) {
            console.log(`[ASSIGN] ⚠ ${abmSerialsSet.size} devices not yet visible after sync: ${[...abmSerialsSet].join(', ')}`);
            results.syncWarning = `${abmSerialsSet.size} device(s) assigned to MDM but not yet visible in SimpleMDM. They may take a few more minutes to appear.`;
          }
        }

        if (!syncSuccess) {
          console.error('[ASSIGN] ⚠ DEP sync failed after 3 attempts — devices may take time to appear');
          results.syncTriggered = false;
          results.syncWarning = 'DEP sync could not be triggered. Devices may take up to 15 minutes to appear in SimpleMDM.';
        }
      } else {
        for (const d of results.abmPending) {
          results.errors.push({ serial: d.serial, error: `ABM assignment failed (${abmResult.status})` });
        }
      }
    } catch (abmErr) {
      console.error('[ASSIGN] ABM batch assignment failed:', abmErr.message);
      for (const d of results.abmPending) {
        results.errors.push({ serial: d.serial, error: 'ABM assignment failed: ' + abmErr.message });
      }
    }
    delete results.abmPending; // Clean up internal field
  }

  console.log(`[ASSIGN] Done: ${results.assigned.length} assigned, ${results.notFound.length} not found, ${results.errors.length} errors`);
  return res.json(results);
});

// ── Create Wallpaper Profile ────────────────────────────────────────
app.post('/api/automation/wallpaper', async (req, res) => {
  const { imageBase64, where, profileName, groupId } = req.body;
  const apiKey = req.headers['x-simplemdm-key'] || req.headers.authorization;

  if (!apiKey) return res.status(401).json({ error: 'Missing SimpleMDM API key' });
  if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

  let rawKey;
  if (apiKey.startsWith('Basic ')) {
    rawKey = Buffer.from(apiKey.replace('Basic ', ''), 'base64').toString().replace(/:$/, '');
  } else {
    rawKey = apiKey;
  }

  try {
    const screen = where || 'both';
    const name = profileName || 'Custom Wallpaper';
    const payload = wallpaperPayload(imageBase64, screen);
    const xml = buildMobileconfig(name, {}, [payload]);
    const uploaded = await uploadCustomProfile(rawKey, name, xml);

    // Auto-assign to group if provided
    if (groupId) {
      try {
        await smdmRequest(rawKey, `/assignment_groups/${groupId}/profiles/${uploaded.id}`, 'POST');
        console.log(`[WALLPAPER] Assigned to group ${groupId}`);
      } catch (assignErr) {
        console.error(`[WALLPAPER] Failed to assign to group:`, assignErr.message);
      }
    }

    console.log(`[WALLPAPER] Created profile: "${name}" (ID: ${uploaded.id})`);
    return res.json({ status: 'success', profile: uploaded });
  } catch (err) {
    console.error('[WALLPAPER] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

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
            await smdmRequest(rawKey, `/assignment_groups/${groupId}/apps/${appId}`, 'POST', { deployment_type: 'standard' });
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
            await smdmRequest(rawKey, `/assignment_groups/${groupId}/apps/${match.id}`, 'POST', { deployment_type: 'standard' });
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

      // ── Step 2b: Push apps to ensure immediate deployment ──
      if (run.appsMatched.length > 0) {
        try {
          await smdmRequest(rawKey, `/assignment_groups/${groupId}/push_apps`, 'POST');
          console.log(`[PROVISION] ✓ Push apps triggered for group ${groupId}`);
          run.appsPushed = true;
        } catch (pushErr) {
          console.log(`[PROVISION] ⚠ Push apps returned: ${pushErr.message}`);
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

      // -- Wallpaper (if image provided) --
      if (dcrData.customWallpaper === 'Yes' && dcrData.wallpaperImage) {
        bundledPayloads.push(wallpaperPayload(dcrData.wallpaperImage, dcrData.wallpaperScreen || 'both'));
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

      // Custom wallpaper without image
      if (dcrData.customWallpaper === 'Yes' && !dcrData.wallpaperImage) {
        manualSetupNeeded.push('Custom wallpaper requested — upload image via Command Center');
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

      // ── Done with group config ──

      // ── Step 5: Assign Device Serial Numbers ──
      const serialsToAssign = dcrData.serials || [];
      if (serialsToAssign.length > 0) {
        console.log(`[PROVISION] Assigning ${serialsToAssign.length} serial numbers to group ${groupId}...`);
        run.serialAssignment = { requested: serialsToAssign.length, assigned: 0, errors: [] };

        try {
          const basicAuth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
          const assignRes = await fetch(`http://localhost:${PORT}/api/simplemdm/groups/${groupId}/assign-serials`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: basicAuth,
            },
            body: JSON.stringify({ serials: serialsToAssign, autoSync: true }),
          });
          const assignData = await assignRes.json();

          run.serialAssignment.assigned = (assignData.assigned || []).length;
          run.serialAssignment.notFound = assignData.notFound || [];
          run.serialAssignment.errors = assignData.errors || [];
          run.serialAssignment.syncTriggered = assignData.syncTriggered || false;

          console.log(`[PROVISION]   ✓ Serials: ${run.serialAssignment.assigned} assigned, ${(assignData.notFound || []).length} not found, ${(assignData.errors || []).length} errors`);

          if (assignData.syncWarning) {
            run.manualSetupNeeded.push(assignData.syncWarning);
          }
        } catch (serialErr) {
          console.error(`[PROVISION]   ✗ Serial assignment failed:`, serialErr.message);
          run.serialAssignment.errors.push({ error: serialErr.message });
          run.manualSetupNeeded.push(`Serial assignment failed: ${serialErr.message}`);
        }
      }

      // ── Finalize ──
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
// SimpleMDM doesn't have a /groups/:id/profiles endpoint, so we fetch
// ALL profiles (regular + custom) and filter by assignment_groups relationship
app.get('/api/simplemdm/assignment_groups/:groupId/profiles', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const groupId = parseInt(req.params.groupId);

  try {
    // Fetch both regular and custom profiles in parallel
    const [regResp, customResp] = await Promise.all([
      fetch('https://a.simplemdm.com/api/v1/profiles?limit=100', {
        headers: { Authorization: auth },
      }),
      fetch('https://a.simplemdm.com/api/v1/custom_configuration_profiles?limit=100', {
        headers: { Authorization: auth },
      }),
    ]);

    const regData = regResp.ok ? await regResp.json() : { data: [] };
    const customData = customResp.ok ? await customResp.json() : { data: [] };

    const allProfiles = [...(regData.data || []), ...(customData.data || [])];

    // Filter to profiles assigned to this group
    // SimpleMDM uses 'groups' key (not 'assignment_groups')
    const assigned = allProfiles.filter(p => {
      const groups = p.relationships && p.relationships.groups && p.relationships.groups.data;
      if (!Array.isArray(groups)) return false;
      return groups.some(g => g.id === groupId);
    });

    return res.json({ data: assigned });
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
// SimpleMDM doesn't have a /groups/:id/apps listing endpoint, so we fetch
// ALL apps and filter by assignment_groups relationship
app.get('/api/simplemdm/assignment_groups/:groupId/apps', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const groupId = parseInt(req.params.groupId);

  try {
    // Apps don't include group relationships in list view,
    // so fetch the group to get app IDs, then enrich with app details
    const groupResp = await fetch(`https://a.simplemdm.com/api/v1/assignment_groups/${groupId}`, {
      headers: { Authorization: auth },
    });
    const groupData = groupResp.ok ? await groupResp.json() : { data: {} };
    const appRels = groupData.data?.relationships?.apps?.data || [];
    const appIds = new Set(appRels.map(a => a.id));

    if (appIds.size === 0) {
      return res.json({ data: [] });
    }

    // Fetch all apps and filter to the ones in this group
    const appsResp = await fetch('https://a.simplemdm.com/api/v1/apps?limit=100', {
      headers: { Authorization: auth },
    });
    const appsData = appsResp.ok ? await appsResp.json() : { data: [] };
    const assigned = (appsData.data || []).filter(a => appIds.has(a.id));

    await enrichAppsWithIcons(assigned);
    return res.json({ data: assigned });
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

// Create assignment group — always force auto_deploy: true
app.post('/api/simplemdm/assignment_groups', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const params = new URLSearchParams();
    if (req.body?.name) params.append('name', req.body.name);
    if (req.body?.priority) params.append('priority', req.body.priority);
    params.append('auto_deploy', 'true');
    console.log(`[GROUP-CREATE] Creating group: ${params.toString()}`);
    const url = 'https://a.simplemdm.com/api/v1/assignment_groups';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await resp.text();
    console.log(`[GROUP-CREATE] Response: status=${resp.status}, body=${text}`);
    try {
      return res.status(resp.status).json(JSON.parse(text));
    } catch {
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('Group create error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Update assignment group — always force auto_deploy: true
app.patch('/api/simplemdm/assignment_groups/:groupId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const params = new URLSearchParams();
    if (req.body?.name) params.append('name', req.body.name);
    params.append('auto_deploy', 'true');
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await resp.text();
    try {
      return res.status(resp.status).json(JSON.parse(text));
    } catch {
      return res.status(resp.status).send(text);
    }
  } catch (err) {
    console.error('Group update error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Add an app to a group — force deployment_type: standard
app.post('/api/simplemdm/assignment_groups/:groupId/apps/:appId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = `https://a.simplemdm.com/api/v1/assignment_groups/${req.params.groupId}/apps/${req.params.appId}`;
    const body = 'deployment_type=standard';
    console.log(`[APP-ASSIGN] POST ${url}`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const responseText = await resp.text();
    console.log(`[APP-ASSIGN] Response: status=${resp.status}`);
    try {
      const data = JSON.parse(responseText);
      return res.status(resp.status).json(data);
    } catch {
      return res.status(resp.status).send(responseText);
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

// List all profiles (regular + custom, merged)
app.get('/api/simplemdm/profiles', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const [regResp, customResp] = await Promise.all([
      fetch('https://a.simplemdm.com/api/v1/profiles?limit=100', {
        headers: { Authorization: auth },
      }),
      fetch('https://a.simplemdm.com/api/v1/custom_configuration_profiles?limit=100', {
        headers: { Authorization: auth },
      }),
    ]);

    const regData = regResp.ok ? await regResp.json() : { data: [] };
    const customData = customResp.ok ? await customResp.json() : { data: [] };

    return res.json({ data: [...(regData.data || []), ...(customData.data || [])] });
  } catch (err) {
    console.error('SimpleMDM profiles proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// ── App Store Icon Enrichment ────────────────────────────────────────
const iconCache = {}; // itunes_store_id -> icon URL

async function enrichAppsWithIcons(apps) {
  // Collect IDs that need lookup
  const idsToLookup = [];
  for (const app of apps) {
    const storeId = app.attributes && app.attributes.itunes_store_id;
    if (storeId && !iconCache[storeId]) {
      idsToLookup.push(storeId);
    }
  }

  // Batch lookup from iTunes API (max 200 per request)
  if (idsToLookup.length > 0) {
    try {
      const ids = idsToLookup.slice(0, 200).join(',');
      const resp = await fetch(`https://itunes.apple.com/lookup?id=${ids}`);
      if (resp.ok) {
        const data = await resp.json();
        for (const r of (data.results || [])) {
          iconCache[r.trackId] = r.artworkUrl100 || r.artworkUrl60 || '';
        }
      }
    } catch (e) {
      console.error('[ICONS] iTunes lookup failed:', e.message);
    }
  }

  // Attach icon URLs to app objects
  for (const app of apps) {
    const storeId = app.attributes && app.attributes.itunes_store_id;
    if (storeId && iconCache[storeId]) {
      app.attributes._icon_url = iconCache[storeId];
    }
  }
  return apps;
}

// List all apps (enriched with App Store icons)
app.get('/api/simplemdm/apps', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const url = new URL('https://a.simplemdm.com/api/v1/apps');
    url.searchParams.set('limit', '100');
    if (req.query.page != null) url.searchParams.set('starting_after', req.query.page);
    const resp = await fetch(url.toString(), {
      headers: { Authorization: auth },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }

    const data = await resp.json();
    await enrichAppsWithIcons(data.data || []);
    return res.json(data);
  } catch (err) {
    console.error('SimpleMDM apps proxy error:', err.message);
    return res.status(500).json({ error: 'SimpleMDM proxy failed: ' + err.message });
  }
});

// ── Bulk Device Wipe, Unenroll & DEP Unassign ──────────────────────
app.post('/api/simplemdm/devices/bulk-unenroll', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  let rawKey;
  if (auth.startsWith('Basic ')) {
    rawKey = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().replace(/:$/, '');
  } else {
    rawKey = auth;
  }

  const { devices } = req.body; // [{ deviceId, serial }]
  if (!Array.isArray(devices) || devices.length === 0) {
    return res.status(400).json({ error: 'No devices provided' });
  }

  console.log(`[UNENROLL] Processing ${devices.length} devices: wipe → unenroll → delete → DEP unassign`);
  const results = { wiped: [], unenrolled: [], errors: [] };
  const serialsForAbm = [];

  // Step 1: Send wipe commands to ALL devices first
  for (const dev of devices) {
    try {
      const wipeUrl = `https://a.simplemdm.com/api/v1/devices/${dev.deviceId}/wipe`;
      const wipeResp = await fetch(wipeUrl, {
        method: 'POST',
        headers: { Authorization: auth },
      });
      console.log(`[UNENROLL]   🔄 Wipe ${dev.serial} (device ${dev.deviceId}): status ${wipeResp.status}`);
      if (wipeResp.ok || wipeResp.status === 202) {
        results.wiped.push({ serial: dev.serial, deviceId: dev.deviceId });
      } else {
        const body = await wipeResp.text();
        console.log(`[UNENROLL]   ⚠ Wipe response body: ${body}`);
      }
    } catch (wipeErr) {
      console.error(`[UNENROLL]   ⚠ Wipe error for ${dev.serial}: ${wipeErr.message}`);
    }
  }

  // Step 2: Wait a few seconds for wipe commands to be queued/delivered
  if (results.wiped.length > 0) {
    console.log(`[UNENROLL] Waiting 5s for wipe commands to be delivered...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Step 3: Unenroll and delete each device
  for (const dev of devices) {
    try {
      // Unenroll
      try {
        const unenrollUrl = `https://a.simplemdm.com/api/v1/devices/${dev.deviceId}/unenroll`;
        const unenrollResp = await fetch(unenrollUrl, {
          method: 'POST',
          headers: { Authorization: auth },
        });
        console.log(`[UNENROLL]   ✓ Unenroll ${dev.serial}: status ${unenrollResp.status}`);
      } catch (unenrollErr) {
        console.log(`[UNENROLL]   ⚠ Unenroll error: ${unenrollErr.message}`);
      }

      // Delete
      try {
        const deleteUrl = `https://a.simplemdm.com/api/v1/devices/${dev.deviceId}`;
        const deleteResp = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: { Authorization: auth },
        });
        console.log(`[UNENROLL]   ✓ Delete ${dev.serial}: status ${deleteResp.status}`);
      } catch (deleteErr) {
        console.log(`[UNENROLL]   ⚠ Delete error: ${deleteErr.message}`);
      }

      results.unenrolled.push({ serial: dev.serial, deviceId: dev.deviceId });
      if (dev.serial) serialsForAbm.push(dev.serial);
    } catch (err) {
      results.errors.push({ serial: dev.serial, deviceId: dev.deviceId, error: err.message });
      console.error(`[UNENROLL]   ✗ Failed for ${dev.serial}: ${err.message}`);
    }
  }

  // Step 4: Batch unassign from ABM/DEP
  if (serialsForAbm.length > 0) {
    try {
      console.log(`[UNENROLL] Unassigning ${serialsForAbm.length} serials from DEP: ${serialsForAbm.join(', ')}`);
      const abmResult = await abmUnassignDevices(serialsForAbm);
      console.log(`[UNENROLL] ABM unassign result: status=${abmResult.status}, skipped=${abmResult.skipped || false}, data=${JSON.stringify(abmResult.data)}`);
      if (abmResult.skipped) {
        results.abmNote = 'ABM integration not configured — devices were unenrolled from SimpleMDM only';
      } else if (abmResult.status >= 200 && abmResult.status < 300) {
        results.abmUnassigned = true;
      } else {
        results.abmNote = `ABM unassign returned status ${abmResult.status}: ${JSON.stringify(abmResult.data)}`;
      }
    } catch (abmErr) {
      results.abmNote = 'ABM unassign failed: ' + abmErr.message;
      console.error('[UNENROLL] ABM unassign error:', abmErr.message);
    }
  }

  console.log(`[UNENROLL] Done: ${results.wiped.length} wiped, ${results.unenrolled.length} unenrolled, ${results.errors.length} errors, ABM: ${results.abmUnassigned || results.abmNote || 'n/a'}`);
  return res.json(results);
});

// ── Bulk Device Wipe (Factory Reset) ────────────────────────────────
app.post('/api/simplemdm/devices/bulk-wipe', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  let rawKey;
  if (auth.startsWith('Basic ')) {
    rawKey = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().replace(/:$/, '');
  } else {
    rawKey = auth;
  }

  const { devices } = req.body;
  if (!Array.isArray(devices) || devices.length === 0) {
    return res.status(400).json({ error: 'No devices provided' });
  }

  console.log(`[WIPE] Sending factory reset to ${devices.length} devices`);
  const results = { wiped: [], errors: [] };

  for (const dev of devices) {
    try {
      await smdmRequest(rawKey, `/devices/${dev.deviceId}/wipe`, 'POST');
      results.wiped.push({ serial: dev.serial, deviceId: dev.deviceId });
      console.log(`[WIPE]   ✓ Wipe command sent to device ${dev.deviceId} (${dev.serial})`);
    } catch (err) {
      results.errors.push({ serial: dev.serial, deviceId: dev.deviceId, error: err.message });
      console.error(`[WIPE]   ✗ Wipe failed for ${dev.serial}: ${err.message}`);
    }
  }

  console.log(`[WIPE] Done: ${results.wiped.length} wiped, ${results.errors.length} errors`);
  return res.json(results);
});

// ── Delete Group with Device Cleanup ────────────────────────────────
app.post('/api/simplemdm/groups/:groupId/delete-with-cleanup', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  let rawKey;
  if (auth.startsWith('Basic ')) {
    rawKey = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().replace(/:$/, '');
  } else {
    rawKey = auth;
  }

  const groupId = req.params.groupId;
  const { wipeFirst } = req.body || {};
  console.log(`[GROUP-DELETE] Starting cleanup for group ${groupId}${wipeFirst ? ' (with factory reset)' : ''}`);

  const results = { devicesProcessed: 0, wiped: [], unenrolled: [], errors: [], groupDeleted: false };

  try {
    const groupData = await smdmRequest(rawKey, `/assignment_groups/${groupId}`);
    const deviceRefs = groupData.data?.relationships?.devices?.data || [];
    console.log(`[GROUP-DELETE] Group has ${deviceRefs.length} direct devices`);

    const serialsForAbm = [];
    for (const ref of deviceRefs) {
      try {
        const deviceData = await smdmRequest(rawKey, `/devices/${ref.id}`);
        const serial = deviceData.data?.attributes?.serial_number || '';
        const name = deviceData.data?.attributes?.name || serial;

        if (wipeFirst) {
          try {
            await smdmRequest(rawKey, `/devices/${ref.id}/wipe`, 'POST');
            results.wiped.push({ deviceId: ref.id, serial, name });
            console.log(`[GROUP-DELETE]   🔄 Wipe command sent to: ${name} (${serial})`);
          } catch (wipeErr) {
            console.log(`[GROUP-DELETE]   ⚠ Wipe failed for ${name}: ${wipeErr.message}`);
          }
        }

        try {
          await smdmRequest(rawKey, `/devices/${ref.id}/unenroll`, 'POST');
        } catch (_) { /* may already be unenrolled */ }

        try {
          await smdmRequest(rawKey, `/devices/${ref.id}`, 'DELETE');
        } catch (_) { /* best effort */ }

        results.unenrolled.push({ deviceId: ref.id, serial, name });
        if (serial) serialsForAbm.push(serial);
        console.log(`[GROUP-DELETE]   ✓ Unenrolled & deleted: ${name} (${serial})`);
      } catch (devErr) {
        results.errors.push({ deviceId: ref.id, error: devErr.message });
        console.error(`[GROUP-DELETE]   ✗ Device ${ref.id}: ${devErr.message}`);
      }
    }
    results.devicesProcessed = deviceRefs.length;

    if (serialsForAbm.length > 0) {
      try {
        const abmResult = await abmUnassignDevices(serialsForAbm);
        if (!abmResult.skipped && abmResult.status >= 200 && abmResult.status < 300) {
          results.abmUnassigned = true;
        }
      } catch (abmErr) {
        console.error('[GROUP-DELETE] ABM unassign error:', abmErr.message);
      }
    }

    try {
      await smdmRequest(rawKey, `/assignment_groups/${groupId}`, 'DELETE');
      results.groupDeleted = true;
      console.log(`[GROUP-DELETE] ✓ Group ${groupId} deleted`);
    } catch (groupErr) {
      results.groupDeleteError = groupErr.message;
      console.error(`[GROUP-DELETE] ✗ Group delete failed: ${groupErr.message}`);
    }

  } catch (err) {
    console.error(`[GROUP-DELETE] Failed:`, err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.json(results);
});

// Lost Mode — enable (SimpleMDM requires form-encoded body)
app.post('/api/simplemdm/devices/:deviceId/lost_mode', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const { deviceId } = req.params;
  const { message, phone_number, footnote } = req.body || {};

  try {
    const params = new URLSearchParams();
    if (message) params.append('message', message);
    if (phone_number) params.append('phone_number', phone_number);
    if (footnote) params.append('footnote', footnote);

    const resp = await fetch(`https://a.simplemdm.com/api/v1/devices/${deviceId}/lost_mode`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lost Mode — disable
app.delete('/api/simplemdm/devices/:deviceId/lost_mode', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const { deviceId } = req.params;
  try {
    const resp = await fetch(`https://a.simplemdm.com/api/v1/devices/${deviceId}/lost_mode`, {
      method: 'DELETE',
      headers: { Authorization: auth },
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
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



// ══════════════════════════════════════════════════════════════════════
// ██  Device Location Tracking (with persistent history)
// ══════════════════════════════════════════════════════════════════════

const deviceLocations = {}; // Latest location per device (in-memory)
const LOCATION_HISTORY_FILE = path.join(__dirname, 'data', 'location_history.jsonl');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Load latest locations from history file on startup
try {
  if (fs.existsSync(LOCATION_HISTORY_FILE)) {
    const lines = fs.readFileSync(LOCATION_HISTORY_FILE, 'utf8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const key = entry.serial || entry.deviceName || 'unknown';
        deviceLocations[key] = entry;
        if (entry.deviceName && entry.deviceName !== key) deviceLocations[entry.deviceName] = entry;
      } catch (_) {}
    }
    console.log(`[Location] Loaded ${lines.length} historical entries, ${Object.keys(deviceLocations).length} latest locations`);
  }
} catch (err) {
  console.error('[Location] Error loading history:', err.message);
}

// Device reports its location (called from FelloRemote iOS app)
app.post('/api/location/report', (req, res) => {
  const { deviceId, serial, lat, lng, deviceName } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  const locData = {
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    timestamp: new Date().toISOString(),
    deviceName: deviceName || 'Unknown Device',
    deviceId: deviceId || null,
    serial: serial || null,
  };

  // Update latest location in memory
  if (serial) deviceLocations[serial] = locData;
  if (deviceId) deviceLocations[deviceId] = locData;
  if (deviceName) deviceLocations[deviceName] = locData;

  // Append to history file (persistent)
  try {
    fs.appendFileSync(LOCATION_HISTORY_FILE, JSON.stringify(locData) + '\n');
  } catch (err) {
    console.error('[Location] Failed to write history:', err.message);
  }

  res.json({ ok: true });
});

// Get all device locations — latest only (deduplicated)
app.get('/api/location/all', (req, res) => {
  const seen = new Set();
  const unique = {};
  for (const [key, loc] of Object.entries(deviceLocations)) {
    const sig = `${loc.lat},${loc.lng},${loc.deviceName}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      unique[key] = loc;
    }
  }
  res.json(unique);
});

// Get location history for a device (supports date range)
// ?from=2026-07-20T00:00:00Z&to=2026-07-23T23:59:59Z
app.get('/api/location/history/:id', (req, res) => {
  const id = req.params.id;
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default: last 7 days
  const to = req.query.to ? new Date(req.query.to) : new Date();

  try {
    if (!fs.existsSync(LOCATION_HISTORY_FILE)) {
      return res.json([]);
    }
    const lines = fs.readFileSync(LOCATION_HISTORY_FILE, 'utf8').split('\n').filter(l => l.trim());
    const history = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = new Date(entry.timestamp);
        if (ts < from || ts > to) continue;
        // Match by serial, deviceName, or deviceId
        if (entry.serial === id || entry.deviceName === id || entry.deviceId === id) {
          history.push(entry);
        }
      } catch (_) {}
    }
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read history: ' + err.message });
  }
});

// Get single device location — tries exact match, then searches
app.get('/api/location/:id', (req, res) => {
  const id = req.params.id;
  if (deviceLocations[id]) return res.json(deviceLocations[id]);
  const match = Object.values(deviceLocations).find(loc =>
    loc.deviceName === id || loc.serial === id || loc.deviceId === id
  );
  if (match) return res.json(match);
  res.status(404).json({ error: 'No location data for this device' });
});


// ── Cobrowse.io Screen Viewer ────────────────────────────────────────
const COBROWSE_LICENSE_KEY = process.env.COBROWSE_LICENSE_KEY || 'eKa2-Jk15Tk8aQ';

// Try to load private key from file or env
let COBROWSE_PRIVATE_KEY = process.env.COBROWSE_PRIVATE_KEY || null;
if (!COBROWSE_PRIVATE_KEY) {
  try {
    const pemPath = path.join(__dirname, 'cobrowse_private.pem');
    if (fs.existsSync(pemPath)) {
      COBROWSE_PRIVATE_KEY = fs.readFileSync(pemPath, 'utf8');
    }
  } catch (_) {}
}

app.get('/api/cobrowse/config', (req, res) => {
  res.json({ licenseKey: COBROWSE_LICENSE_KEY, configured: !!COBROWSE_PRIVATE_KEY });
});

function generateCobrowseJWT() {
  let pem = COBROWSE_PRIVATE_KEY;
  if (!pem.includes('-----BEGIN')) {
    pem = pem.replace(/\\n/g, '\n');
  }

  // Use createPrivateKey for Node 22+ OpenSSL compatibility
  const privateKey = crypto.createPrivateKey({
    key: pem,
    format: 'pem'
  });

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: COBROWSE_LICENSE_KEY,
    aud: 'https://cobrowse.io',
    sub: 'agent',
    iat: now,
    exp: now + 3600,
    displayName: 'Fello Command Center',
  }));

  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

app.post('/api/cobrowse/token', (req, res) => {
  if (!COBROWSE_LICENSE_KEY || !COBROWSE_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Cobrowse.io is not configured. Add cobrowse_private.pem to the project root.' });
  }
  try {
    res.json({ token: generateCobrowseJWT() });
  } catch (err) {
    console.error('[Cobrowse] JWT generation error:', err.message);
    res.status(500).json({ error: 'JWT generation failed: ' + err.message });
  }
});

// Find a device and create a session for auto-connect
app.post('/api/cobrowse/connect', async (req, res) => {
  if (!COBROWSE_LICENSE_KEY || !COBROWSE_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Cobrowse.io is not configured.' });
  }

  const { serial, deviceName } = req.body;
  const token = generateCobrowseJWT();

  try {
    // List all online devices from Cobrowse API
    const https = require('https');
    const listUrl = new URL('https://cobrowse.io/api/1/devices');
    listUrl.searchParams.set('filter_app', 'Fello Remote');

    const devicesResp = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!devicesResp.ok) {
      const errText = await devicesResp.text();
      return res.status(502).json({ error: `Cobrowse API error: ${devicesResp.status} ${errText}` });
    }

    const devices = await devicesResp.json();

    if (!devices || devices.length === 0) {
      return res.json({ error: 'No Fello Remote devices found online.', devices: [] });
    }

    // If only one device, auto-select it
    let targetDevice = null;
    if (devices.length === 1) {
      targetDevice = devices[0];
    } else {
      // Try to match by serial_number custom data
      targetDevice = devices.find(d =>
        d.custom_data && d.custom_data.serial_number === serial
      );
      // Or match by device name
      if (!targetDevice && deviceName) {
        targetDevice = devices.find(d =>
          d.custom_data && d.custom_data.device_name === deviceName
        );
      }
      // Fallback: first device
      if (!targetDevice) {
        targetDevice = devices[0];
      }
    }

    // Create a session for this device
    const sessionResp = await fetch('https://cobrowse.io/api/1/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ device_id: targetDevice.id })
    });

    if (!sessionResp.ok) {
      // If session creation fails, fall back to iframe with device filter
      return res.json({
        mode: 'iframe',
        token,
        deviceId: targetDevice.id,
        deviceName: targetDevice.custom_data?.device_name || 'Unknown'
      });
    }

    const session = await sessionResp.json();
    res.json({
      mode: 'session',
      token,
      sessionId: session.id,
      sessionUrl: `https://cobrowse.io/session/${session.id}?token=${encodeURIComponent(token)}&navigation=none&agent_tools=none`,
      deviceName: targetDevice.custom_data?.device_name || 'Unknown',
      devices: devices.map(d => ({
        id: d.id,
        name: d.custom_data?.device_name,
        serial: d.custom_data?.serial_number,
        online: d.online
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
