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

// ── Fallback to SPA ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Starlink Data Usage Dashboard`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Running at http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
