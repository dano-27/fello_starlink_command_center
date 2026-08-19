const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { FelloCrmClient, CrmApiError } = require('./fello-crm-client');
const { CustomerVerifyService } = require('./customer-verify');

// ── Auth & Audit ──────────────────────────────────────────────────────
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const USERS_CSV = path.join(DATA_DIR, 'users.csv');
const AUDIT_LOG = path.join(DATA_DIR, 'audit.jsonl');

// In-memory user database (loaded from CSV)
let users = new Map();
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_CSV)) {
      // Auto-create default users.csv on first boot
      console.log('[Auth] No users.csv found — creating default with admin user');
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(USERS_CSV, 'username,password,name,role\ndanodomirok,Odomirok23,Dan Odomirok,admin\nmichele,Fello1234!,Michele,agent\n', 'utf-8');
      } catch (e) {
        console.error('[Auth] Failed to create default users.csv:', e.message);
        return;
      }
    }
    const raw = fs.readFileSync(USERS_CSV, 'utf-8');
    const lines = raw.trim().split('\n');
    if (lines.length < 2) return;
    const newUsers = new Map();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map(s => s.trim());
      if (parts.length >= 4) {
        const [username, password, name, role] = parts;
        newUsers.set(username.toLowerCase(), { username: username.toLowerCase(), password, name, role: role || 'agent' });
      }
    }
    users = newUsers;
    console.log(`[Auth] Loaded ${users.size} users from CSV`);
  } catch (e) {
    console.error('[Auth] Failed to load users:', e.message);
  }
}
loadUsers();
// Reload users when CSV changes
try { fs.watch(USERS_CSV, () => { console.log('[Auth] Users CSV changed, reloading...'); loadUsers(); }); } catch(e) {}

// Session store (persisted to disk to survive redeploys)
const SESSION_COOKIE = 'fello_session';
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
// DATA_DIR already declared at top of file
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

let sessions = new Map();

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      sessions = new Map();
      for (const [token, sess] of Object.entries(raw)) {
        // Only load sessions that haven't expired
        const loginTime = new Date(sess.loginTime).getTime();
        if (now - loginTime < SESSION_MAX_AGE) {
          sessions.set(token, sess);
        }
      }
      console.log('[Auth] Loaded ' + sessions.size + ' sessions from disk');
    }
  } catch (e) {
    console.error('[Auth] Failed to load sessions:', e.message);
  }
}

function saveSessions() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(sessions);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[Auth] Failed to save sessions:', e.message);
  }
}

// Load existing sessions on startup
loadSessions();

function createSession(user) {
  const token = crypto.randomUUID();
  sessions.set(token, {
    username: user.username,
    name: user.name,
    role: user.role,
    sessionToken: token,
    loginTime: new Date().toISOString()
  });
  saveSessions();
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  // Check expiry
  const loginTime = new Date(session.loginTime).getTime();
  if (Date.now() - loginTime > SESSION_MAX_AGE) {
    sessions.delete(token);
    saveSessions();
    return null;
  }
  return session;
}

// Audit logger
function auditLog(entry) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  }) + '\n';
  try { fs.appendFileSync(AUDIT_LOG, line); } catch(e) { console.error('[Audit] Write failed:', e.message); }
}

// Extract task context from a request (order ID, branch ID, customer)
function extractTaskContext(req) {
  const ctx = {};
  // From query params (lookup)
  if (req.query.q) ctx.query = req.query.q;
  // From URL path params
  if (req.params.branchId) ctx.branchId = req.params.branchId;
  if (req.params.userTerminalId) ctx.terminalId = req.params.userTerminalId;
  if (req.params.id) ctx.resourceId = req.params.id;
  if (req.params.deviceId) ctx.deviceId = req.params.deviceId;
  if (req.params.groupId) ctx.groupId = req.params.groupId;
  // From body
  if (req.body) {
    if (req.body.branchId) ctx.branchId = req.body.branchId;
    if (req.body.orderId) ctx.orderId = req.body.orderId;
    if (req.body.flyOrderId) ctx.orderId = req.body.flyOrderId;
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

// Cookie parser helper
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return cookies;
}

// File upload config — uses /data for Railway volume persistence, falls back to ./data
const UPLOAD_DIR = fs.existsSync('/data') ? '/data/uploads' : path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Site check results persistence
const SITE_CHECKS_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const SITE_CHECKS_FILE = path.join(SITE_CHECKS_DIR, 'site-checks.json');
if (!fs.existsSync(SITE_CHECKS_DIR)) fs.mkdirSync(SITE_CHECKS_DIR, { recursive: true });

function loadSiteChecks() {
  try {
    if (fs.existsSync(SITE_CHECKS_FILE)) return JSON.parse(fs.readFileSync(SITE_CHECKS_FILE, 'utf8'));
  } catch (e) { console.warn('[SiteCheck] Failed to load:', e.message); }
  return {};
}
function saveSiteChecks(data) {
  try { fs.writeFileSync(SITE_CHECKS_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.warn('[SiteCheck] Failed to save:', e.message); }
}

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
  clientId: process.env.ABM_CLIENT_ID || 'BUSINESSAPI.0965ba6c-d47a-4594-acb7-74c60e8adfe0',
  keyId: process.env.ABM_KEY_ID || '424264f6-f8be-4b2c-bf5b-53d4051db236',
  tokenUrl: 'https://account.apple.com/auth/oauth2/v2/token',
  apiBase: 'https://api-business.apple.com/v1',
  simpleMdmServerId: '399E3FA11E9C47E1AEB621C9522C604C',
};

// Try loading private key from env or file
let abmPrivateKey = null;
try {
  const pemEnv = process.env.ABM_DEVICE_API_KEY || process.env.ABM_PRIVATE_KEY;
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

async function abmLookupDevice(serial, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const token = await getAbmToken();
    const resp = await fetch(`${ABM_CONFIG.apiBase}/orgDevices/${serial}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    
    if (resp.ok) {
      return (await resp.json()).data;
    }
    
    // Rate limited or server error — retry with backoff
    if ((resp.status === 429 || resp.status >= 500) && attempt < retries - 1) {
      const delay = (attempt + 1) * 1000; // 1s, 2s, 3s
      console.log(`[ABM] Rate limited on ${serial} (${resp.status}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    
    console.log(`[ABM] Lookup failed for ${serial}: HTTP ${resp.status}`);
    return null;
  }
  return null;
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

// ── Auth middleware ──────────────────────────────────────────────────
const AUTH_WHITELIST = [
  '/login', '/login.html',
  '/api/auth/login', '/api/auth/logout',
  '/favicon.ico',
  '/share', '/api/public/share',
  '/shared-header.css', '/shared-header.js', '/fello-logo.png'
];

app.use((req, res, next) => {
  // Skip auth if no users loaded (auth disabled)
  if (users.size === 0) { req.user = { username: 'system', name: 'System', role: 'admin' }; return next(); }

  // Whitelist check
  const p = req.path.toLowerCase();
  if (AUTH_WHITELIST.some(w => p === w || p.startsWith(w + '/')) || p.startsWith('/login')) {
    return next();
  }

  // Check session cookie
  const cookies = parseCookies(req);
  let sessionToken = cookies[SESSION_COOKIE];
  
  // Fallback: check for session token in header (for cases where cookie isn't sent)
  if (!sessionToken && req.headers['x-session-token']) {
    sessionToken = req.headers['x-session-token'];
  }
  
  const session = getSession(sessionToken);

  if (!session) {
    // Log auth failures for API share calls to help debug
    if (req.path.startsWith('/api/share')) {
      console.error('[Auth] Share endpoint auth failed — path:', req.path, 
        'cookie present:', !!cookies[SESSION_COOKIE], 
        'header present:', !!req.headers['x-session-token'],
        'token value:', sessionToken ? sessionToken.substring(0, 8) + '...' : 'none',
        'sessions count:', sessions.size);
    }
    // API calls get 401, page requests get redirected
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
  }

  req.user = session;
  next();
});

// ── Audit middleware ────────────────────────────────────────────────
// Tracked GET endpoints for session/task tracking
const TRACKED_GET_PATHS = ['/api/lookup', '/api/reports/overage', '/api/webbing/branches'];

app.use((req, res, next) => {
  if (!req.user) return next();
  
  const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
  const isTrackedGet = req.method === 'GET' && TRACKED_GET_PATHS.some(p => req.path.startsWith(p));
  
  if (isWrite || isTrackedGet) {
    // Don't log auth endpoints (except login/logout which are logged manually)
    if (req.path.startsWith('/api/auth/')) return next();
    
    // Build the audit body — redact passwords
    let auditBody = undefined;
    if (isWrite && req.body && Object.keys(req.body).length > 0) {
      auditBody = { ...req.body };
      if (auditBody.password) auditBody.password = '***REDACTED***';
    }
    
    // For GET requests, log query params instead of body
    if (isTrackedGet && req.query && Object.keys(req.query).length > 0) {
      auditBody = { ...req.query };
    }
    
    // Capture response status after handler completes
    const startTime = Date.now();
    res.on('finish', () => {
      auditLog({
        user: req.user.username,
        name: req.user.name,
        role: req.user.role,
        sessionId: req.user.sessionToken || req.headers['x-session-id'] || undefined,
        method: isTrackedGet ? 'VIEW' : req.method,
        path: req.path,
        body: auditBody,
        taskContext: extractTaskContext(req),
        status: res.statusCode,
        durationMs: Date.now() - startTime,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        userAgent: req.headers['user-agent']
      });
    });
  }
  next();
});

// Root redirects to Command Center (before static so it overrides old index.html)
app.get('/', (req, res) => res.redirect('/lookup/'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(path.join(__dirname, 'public', 'reports')));

// ── Auth Endpoints ──────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = users.get(username.toLowerCase());
  if (!user || user.password !== password) {
    auditLog({ user: username, name: 'Unknown', method: 'LOGIN', path: '/api/auth/login', body: { success: false }, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, userAgent: req.headers['user-agent'] });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createSession(user);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`);

  auditLog({ user: user.username, name: user.name, role: user.role, sessionId: token, method: 'LOGIN', path: '/api/auth/login', body: { success: true }, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, userAgent: req.headers['user-agent'] });

  // Return token so client can store it for header-based auth fallback
  res.json({ success: true, user: { username: user.username, name: user.name, role: user.role }, sessionToken: token });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const session = sessions.get(token);
    if (session) {
      auditLog({ user: session.username, name: session.name, role: session.role, sessionId: token, method: 'LOGOUT', path: '/api/auth/logout', ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, userAgent: req.headers['user-agent'] });
    }
    sessions.delete(token);
    saveSessions();
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ username: req.user.username, name: req.user.name, role: req.user.role });
});

// ── Audit page access guard (admin only) ────────────────────────────
app.use('/audit', (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.redirect('/lookup/');
  }
  next();
});

// ── Audit Log Endpoints (admin only) ────────────────────────────────
app.get('/api/audit/log', (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    if (!fs.existsSync(AUDIT_LOG)) return res.json([]);
    const raw = fs.readFileSync(AUDIT_LOG, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    // Parse and apply filters
    let entries = lines.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);

    const { user, method, search, limit = 500, offset = 0 } = req.query;
    if (user) entries = entries.filter(e => e.user === user);
    if (method) entries = entries.filter(e => e.method === method.toUpperCase());
    if (search) {
      const q = search.toLowerCase();
      entries = entries.filter(e => JSON.stringify(e).toLowerCase().includes(q));
    }

    // Return newest first
    entries.reverse();
    const total = entries.length;
    entries = entries.slice(Number(offset), Number(offset) + Number(limit));

    res.json({ total, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit/log/export', (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    if (!fs.existsSync(AUDIT_LOG)) return res.send('No audit log entries');
    const raw = fs.readFileSync(AUDIT_LOG, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);

    // Build CSV
    let csv = 'Timestamp,User,Name,Method,Path,Details,IP\n';
    for (const e of entries) {
      const details = e.body ? JSON.stringify(e.body).replace(/"/g, '""') : '';
      csv += `"${e.timestamp}","${e.user}","${e.name || ''}","${e.method}","${e.path}","${details}","${e.ip || ''}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit_log.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Session Timeline & Agent Stats ──────────────────────────────────

// GET /api/audit/sessions — group audit entries by session, with task breakdown
app.get('/api/audit/sessions', (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    if (!fs.existsSync(AUDIT_LOG)) return res.json({ sessions: [] });
    const raw = fs.readFileSync(AUDIT_LOG, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);

    const { user: filterUser, from, to, limit = 50 } = req.query;

    const sessionMap = new Map();

    for (const e of entries) {
      if (filterUser && e.user !== filterUser) continue;
      if (from && e.timestamp < from) continue;
      if (to && e.timestamp > to + 'T23:59:59Z') continue;

      let sessionKey = e.sessionId;
      if (!sessionKey) {
        const dateStr = e.timestamp ? e.timestamp.split('T')[0] : 'unknown';
        sessionKey = e.user + '_' + dateStr;
      }

      if (!sessionMap.has(sessionKey)) {
        sessionMap.set(sessionKey, {
          sessionId: sessionKey,
          user: e.user,
          name: e.name || '',
          role: e.role || '',
          loginTime: null,
          logoutTime: null,
          actions: [],
          tasks: []
        });
      }

      const session = sessionMap.get(sessionKey);
      if (e.method === 'LOGIN' && e.body && e.body.success) {
        session.loginTime = e.timestamp;
        session.ip = e.ip;
      } else if (e.method === 'LOGOUT') {
        session.logoutTime = e.timestamp;
      } else {
        session.actions.push(e);
      }
    }

    const results = [];
    for (const [, session] of sessionMap) {
      if (session.actions.length === 0 && !session.loginTime) continue;

      let currentTask = null;
      const tasks = [];

      for (const action of session.actions) {
        const query = action.taskContext?.query || action.body?.q;
        const isLookup = action.method === 'VIEW' && action.path === '/api/lookup' && query;

        if (isLookup) {
          if (currentTask) {
            currentTask.endTime = currentTask.actions.length > 0
              ? currentTask.actions[currentTask.actions.length - 1].timestamp
              : currentTask.startTime;
            tasks.push(currentTask);
          }
          currentTask = {
            orderId: query,
            startTime: action.timestamp,
            endTime: action.timestamp,
            actions: [{ method: action.method, path: action.path, timestamp: action.timestamp, status: action.status }]
          };
        } else if (currentTask) {
          currentTask.actions.push({ method: action.method, path: action.path, timestamp: action.timestamp, status: action.status, durationMs: action.durationMs });
        } else {
          currentTask = {
            orderId: action.taskContext?.query || action.taskContext?.branchId || 'General',
            startTime: action.timestamp,
            endTime: action.timestamp,
            actions: [{ method: action.method, path: action.path, timestamp: action.timestamp, status: action.status }]
          };
        }
      }
      if (currentTask) {
        currentTask.endTime = currentTask.actions.length > 0
          ? currentTask.actions[currentTask.actions.length - 1].timestamp
          : currentTask.startTime;
        tasks.push(currentTask);
      }

      for (const task of tasks) {
        const start = new Date(task.startTime).getTime();
        const end = new Date(task.endTime).getTime();
        task.durationMs = end - start;
        task.durationFormatted = formatDuration(end - start);
        task.actionCount = task.actions.length;
      }

      const firstTime = session.loginTime || (session.actions[0] && session.actions[0].timestamp);
      const lastTime = session.logoutTime || (session.actions.length > 0 ? session.actions[session.actions.length - 1].timestamp : firstTime);
      const sessionDurationMs = firstTime && lastTime ? new Date(lastTime).getTime() - new Date(firstTime).getTime() : 0;

      results.push({
        sessionId: session.sessionId,
        user: session.user,
        name: session.name,
        role: session.role,
        ip: session.ip,
        loginTime: session.loginTime || firstTime,
        logoutTime: session.logoutTime,
        durationMs: sessionDurationMs,
        durationFormatted: formatDuration(sessionDurationMs),
        totalActions: session.actions.length,
        taskCount: tasks.length,
        tasks: tasks
      });
    }

    results.sort((a, b) => (b.loginTime || '').localeCompare(a.loginTime || ''));
    const limited = results.slice(0, Number(limit));

    res.json({ total: results.length, sessions: limited });
  } catch (err) {
    console.error('[Audit] Sessions error:', err);
    res.status(500).json({ error: err.message });
  }
});

function formatDuration(ms) {
  if (ms < 1000) return '< 1s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return mins + 'm ' + remSecs + 's';
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hours + 'h ' + remMins + 'm';
}

// GET /api/audit/agent-stats — aggregate performance stats per agent
app.get('/api/audit/agent-stats', (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    if (!fs.existsSync(AUDIT_LOG)) return res.json({ agents: [] });
    const raw = fs.readFileSync(AUDIT_LOG, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);

    const { from, to } = req.query;
    const filtered = entries.filter(e => {
      if (from && e.timestamp < from) return false;
      if (to && e.timestamp > to + 'T23:59:59Z') return false;
      return true;
    });

    const agentMap = new Map();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
    for (const e of filtered) {
      // Skip non-human entries (system, API tokens, UUIDs)
      if (!e.user || e.user === 'system' || UUID_RE.test(e.user)) continue;
      if (!agentMap.has(e.user)) {
        agentMap.set(e.user, {
          user: e.user,
          name: e.name || '',
          role: e.role || '',
          totalActions: 0,
          logins: 0,
          lookups: 0,
          writes: 0,
          activeDays: new Set(),
          firstSeen: e.timestamp,
          lastSeen: e.timestamp
        });
      }
      const agent = agentMap.get(e.user);
      agent.totalActions++;
      if (e.timestamp > agent.lastSeen) agent.lastSeen = e.timestamp;
      if (e.timestamp < agent.firstSeen) agent.firstSeen = e.timestamp;
      if (e.method === 'LOGIN') agent.logins++;
      if (e.method === 'VIEW') agent.lookups++;
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(e.method)) agent.writes++;
      const day = e.timestamp ? e.timestamp.split('T')[0] : '';
      if (day) agent.activeDays.add(day);
    }

    const agents = Array.from(agentMap.values()).map(a => ({
      ...a,
      activeDays: a.activeDays.size,
      avgActionsPerDay: a.activeDays.size > 0 ? Math.round(a.totalActions / a.activeDays.size) : 0
    }));

    agents.sort((a, b) => b.totalActions - a.totalActions);
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Login page route ────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── User management (admin only) ────────────────────────────────────
app.get('/api/auth/users', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const list = [];
  for (const [, u] of users) {
    list.push({ username: u.username, name: u.name, role: u.role });
  }
  res.json({ users: list });
});

app.post('/api/auth/users', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { csvContent } = req.body;
  if (!csvContent) return res.status(400).json({ error: 'csvContent required' });
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_CSV, csvContent, 'utf-8');
    loadUsers();
    auditLog({ user: req.user.username, name: req.user.name, method: 'UPDATE_USERS', path: '/api/auth/users', ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress });
    res.json({ success: true, userCount: users.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save users from admin UI — merges new users with existing passwords
app.post('/api/auth/users/save', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { users: userList } = req.body;
  if (!userList || !Array.isArray(userList)) return res.status(400).json({ error: 'users array required' });
  if (userList.length === 0) return res.status(400).json({ error: 'Cannot save empty user list' });

  try {
    // Build CSV — for existing users without a password field, keep their current password
    let csv = 'username,password,name,role\n';
    for (const u of userList) {
      const username = (u.username || '').trim().toLowerCase();
      if (!username) continue;
      // If password provided, use it; otherwise look up existing
      let password = u.password;
      if (!password) {
        const existing = users.get(username);
        password = existing ? existing.password : '';
      }
      const name = (u.name || '').trim();
      const role = u.role || 'agent';
      csv += username + ',' + password + ',' + name + ',' + role + '\n';
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_CSV, csv, 'utf-8');
    loadUsers();

    const changeDesc = userList.map(u => u.username).join(', ');
    auditLog({ user: req.user.username, name: req.user.name, method: 'UPDATE_USERS', path: '/api/auth/users/save', body: { users: changeDesc }, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress });

    res.json({ success: true, userCount: users.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin page route
app.get('/admin/users', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).send('Admin access required');
  res.sendFile(path.join(__dirname, 'public', 'admin', 'users.html'));
});

// ── Cradlepoint NetCloud Manager API ────────────────────────────────
const CP_ECM_API_ID = process.env.CP_ECM_API_ID || '';
const CP_ECM_API_KEY = process.env.CP_ECM_API_KEY || '';
const CP_CP_API_ID = process.env.CP_CP_API_ID || '';
const CP_CP_API_KEY = process.env.CP_CP_API_KEY || '';
const CP_BASE_URL = process.env.CP_BASE_URL || 'https://www.us0.cradlepointecm.com/api/v2';

if (CP_ECM_API_ID && CP_CP_API_ID) {
  console.log('[Cradlepoint] API configured — ECM ID: ' + CP_ECM_API_ID.substring(0, 8) + '...');
} else {
  console.log('[Cradlepoint] Not configured — set CP_ECM_API_ID, CP_ECM_API_KEY, CP_CP_API_ID, CP_CP_API_KEY');
}

function cpHeaders() {
  return {
    'X-CP-API-ID': CP_CP_API_ID,
    'X-CP-API-KEY': CP_CP_API_KEY,
    'X-ECM-API-ID': CP_ECM_API_ID,
    'X-ECM-API-KEY': CP_ECM_API_KEY,
    'Content-Type': 'application/json'
  };
}

async function cpFetch(endpoint, options) {
  const url = endpoint.startsWith('http') ? endpoint : CP_BASE_URL + endpoint;
  const resp = await fetch(url, { headers: cpHeaders(), ...options });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Cradlepoint API ' + resp.status + ': ' + text.substring(0, 200));
  }
  return resp.json();
}

// Config check
app.get('/api/cradlepoint/config', (req, res) => {
  res.json({
    configured: !!(CP_ECM_API_ID && CP_CP_API_ID),
    baseUrl: CP_BASE_URL
  });
});

// List all routers
app.get('/api/cradlepoint/routers', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const state = req.query.state; // online, offline
    let url = '/routers/?limit=' + limit + '&offset=' + offset;
    if (state) url += '&state=' + state;
    const data = await cpFetch(url);
    console.log('[Cradlepoint] Routers: ' + (data.data || []).length + ' of ' + (data.meta || {}).total_count);
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Routers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Single router detail
app.get('/api/cradlepoint/routers/:id', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const data = await cpFetch('/routers/' + req.params.id + '/');
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Router detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Net devices (modems, WANs) — optionally filter by router
app.get('/api/cradlepoint/net_devices', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    let url = '/net_devices/?limit=' + (req.query.limit || 100);
    if (req.query.router) url += '&router=' + req.query.router;
    if (req.query.type) url += '&type=' + req.query.type;
    const data = await cpFetch(url);
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Net devices error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Net device usage samples
app.get('/api/cradlepoint/net_devices/:id/usage', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    let url = '/net_device_usage_samples/?net_device=' + req.params.id + '&limit=' + (req.query.limit || 100);
    if (req.query.created_at__gt) url += '&created_at__gt=' + req.query.created_at__gt;
    const data = await cpFetch(url);
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Net device signal samples
app.get('/api/cradlepoint/net_devices/:id/signal', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    let url = '/net_device_signal_samples/?net_device=' + req.params.id + '&limit=' + (req.query.limit || 50);
    if (req.query.created_at__gt) url += '&created_at__gt=' + req.query.created_at__gt;
    const data = await cpFetch(url);
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Signal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Net device health
app.get('/api/cradlepoint/net_device_health', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    let url = '/net_device_health/?limit=' + (req.query.limit || 100);
    if (req.query.net_device) url += '&net_device=' + req.query.net_device;
    const data = await cpFetch(url);
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Health error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Groups
app.get('/api/cradlepoint/groups', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const data = await cpFetch('/groups/?limit=100');
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Alerts
app.get('/api/cradlepoint/alerts', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const limit = req.query.limit || 50;
    let url = '/router_alerts/?limit=' + limit;
    if (req.query.router) url += '&router=' + req.query.router;
    const data = await cpFetch(url);
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Alerts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Router locations
app.get('/api/cradlepoint/locations', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    let url = '/locations/?limit=' + (req.query.limit || 50);
    if (req.query.router) url += '&router=' + req.query.router;
    const data = await cpFetch(url);
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reboot a router (admin only)
app.post('/api/cradlepoint/routers/:id/reboot', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const data = await cpFetch('/reboot_activity/', {
      method: 'POST',
      body: JSON.stringify({ router: CP_BASE_URL + '/routers/' + req.params.id + '/' })
    });
    auditLog({
      user: req.user.username,
      name: req.user.name,
      method: 'REBOOT',
      path: '/api/cradlepoint/routers/' + req.params.id + '/reboot',
      body: { routerId: req.params.id },
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    });
    console.log('[Cradlepoint] Reboot initiated for router ' + req.params.id + ' by ' + req.user.username);
    res.json({ success: true, action: 'reboot', routerId: req.params.id, data: data });
  } catch (err) {
    console.error('[Cradlepoint] Reboot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Unified fleet overview with Webbing SIM enrichment
app.get('/api/cradlepoint/fleet', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured', configured: false });
  try {
    const [routersData, netDevData, alertsData] = await Promise.all([
      cpFetch('/routers/?limit=200'),
      cpFetch('/net_devices/?limit=500'),
      cpFetch('/router_alerts/?limit=20')
    ]);

    const routers = routersData.data || [];
    const netDevices = netDevData.data || [];
    const alerts = alertsData.data || [];
    const online = routers.filter(r => r.state === 'online').length;

    // Build net device lookup by router ID
    const netDevByRouter = {};
    for (const nd of netDevices) {
      const routerUrl = nd.router || '';
      const rid = routerUrl.replace(/\/$/, '').split('/').pop();
      if (rid) {
        if (!netDevByRouter[rid]) netDevByRouter[rid] = [];
        netDevByRouter[rid].push(nd);
      }
    }

    // Build Webbing ICCID lookup from the in-memory cache
    const wbByIccid = {};
    for (const d of webbingDeviceCache) {
      const iccid = String(d.ICCID || '').trim();
      if (iccid) wbByIccid[iccid] = d;
    }

    // Enrich each router
    const enrichedRouters = routers.map(r => {
      const rid = String(r.id);
      const devices = netDevByRouter[rid] || [];
      
      // Find the primary modem (SIM1 with an ICCID)
      const primaryModem = devices.find(d => d.iccid && d.type === 'mdm') || null;
      const iccid = primaryModem ? String(primaryModem.iccid).trim() : null;
      
      // Cross-reference with Webbing
      const webbingSim = iccid ? (wbByIccid[iccid] || null) : null;

      return {
        id: r.id,
        name: r.name || '',
        state: r.state || 'unknown',
        serial_number: r.serial_number || '',
        mac: r.mac || '',
        asset_id: r.asset_id || '',
        description: r.description || '',
        group: r.group || null,
        firmware_version: r.actual_firmware || null,
        // Net device / modem info
        modem: primaryModem ? {
          carrier: primaryModem.carrier || '',
          carrier_id: primaryModem.carrier_id || '',
          connection_state: primaryModem.connection_state || '',
          signal_type: primaryModem.service_type || '',
          ip: primaryModem.ipv4_address || '',
          iccid: iccid,
          imei: primaryModem.imei || '',
          model: primaryModem.model || '',
          apn: primaryModem.apn || ''
        } : null,
        allDevices: devices.map(d => ({
          id: d.id,
          name: d.name || '',
          type: d.type || '',
          carrier: d.carrier || '',
          connection_state: d.connection_state || '',
          ip: d.ipv4_address || '',
          iccid: d.iccid || '',
          imei: d.imei || '',
          model: d.model || ''
        })),
        // Webbing match
        webbing: webbingSim ? {
          matched: true,
          iccid: String(webbingSim.ICCID || ''),
          product: webbingSim.ProductName || '',
          status: webbingSim.StatusName || '',
          branch: webbingSim.BranchName || '',
          msisdn: webbingSim.MSISDN || '',
          branchId: webbingSim.BranchID || '',
          serial: webbingSim.Serial || ''
        } : { matched: false }
      };
    });

    const wbMatched = enrichedRouters.filter(r => r.webbing && r.webbing.matched).length;
    
    // Sort by asset_id (routers without one go to the end)
    enrichedRouters.sort((a, b) => {
      const aId = a.asset_id || '';
      const bId = b.asset_id || '';
      if (!aId && !bId) return 0;
      if (!aId) return 1;
      if (!bId) return -1;
      return aId.localeCompare(bId, undefined, { numeric: true });
    });
    
    console.log('[Cradlepoint] Fleet: ' + routers.length + ' routers (' + online + ' online), ' + wbMatched + ' Webbing matches, ' + alerts.length + ' alerts');

    res.json({
      configured: true,
      routers: enrichedRouters,
      alerts: alerts,
      stats: {
        total: routers.length,
        online: online,
        offline: routers.length - online,
        alertCount: (alertsData.meta || {}).total_count || alerts.length,
        webbingMatched: wbMatched
      }
    });
  } catch (err) {
    console.error('[Cradlepoint] Fleet error:', err.message);
    res.status(500).json({ error: err.message, configured: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ── Cradlepoint Advanced Features ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ── WiFi Configuration ──────────────────────────────────────────────
// GET: Read current WiFi SSID/password config from a router
app.get('/api/cradlepoint/routers/:id/wifi', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const routerId = req.params.id;
    const routerUrl = CP_BASE_URL + '/routers/' + routerId + '/';
    
    // Get configuration manager for this router
    const cfgData = await cpFetch('/configuration_managers/?router=' + routerId + '&limit=1');
    const configs = cfgData.data || [];
    if (configs.length === 0) {
      return res.json({ ssids: [], configId: null, error: 'No configuration found for this router' });
    }
    
    const configId = configs[0].id;
    const config = configs[0].configuration || {};
    
    // Navigate to WiFi radios
    const wifi = config?.networking?.wifi?.radios || {};
    const ssids = [];
    
    for (const [radioKey, radio] of Object.entries(wifi)) {
      const band = radioKey.includes('5') ? '5 GHz' : radioKey.includes('6') ? '6 GHz' : '2.4 GHz';
      const radioSsids = radio.ssids || {};
      
      for (const [ssidKey, ssidConfig] of Object.entries(radioSsids)) {
        ssids.push({
          radioKey: radioKey,
          ssidKey: ssidKey,
          ssid: ssidConfig.ssid || ssidKey,
          password: ssidConfig.wpa_password || '',
          enabled: ssidConfig.enabled !== false,
          band: band,
          security: ssidConfig.encryption_mode || 'wpa2',
          hidden: ssidConfig.broadcast === false
        });
      }
    }
    
    console.log('[Cradlepoint] WiFi config for router ' + routerId + ': ' + ssids.length + ' SSIDs');
    res.json({ ssids: ssids, configId: configId });
  } catch (err) {
    console.error('[Cradlepoint] WiFi read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT: Update WiFi SSID name and/or password
app.put('/api/cradlepoint/routers/:id/wifi', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  
  try {
    const routerId = req.params.id;
    const { radioKey, ssidKey, newSsid, newPassword } = req.body;
    
    if (!radioKey || !ssidKey) {
      return res.status(400).json({ error: 'radioKey and ssidKey are required' });
    }
    if (!newSsid && !newPassword) {
      return res.status(400).json({ error: 'Provide newSsid and/or newPassword' });
    }
    
    // Get the config manager ID
    const routerUrl = CP_BASE_URL + '/routers/' + routerId + '/';
    const cfgData = await cpFetch('/configuration_managers/?router=' + routerId + '&limit=1');
    const configs = cfgData.data || [];
    if (configs.length === 0) {
      return res.status(404).json({ error: 'No configuration manager found' });
    }
    
    const configId = configs[0].id;
    
    // Build the PATCH delta
    const ssidPatch = {};
    if (newSsid) ssidPatch.ssid = newSsid;
    if (newPassword) ssidPatch.wpa_password = newPassword;
    
    const patchBody = [{
      op: 'replace',
      path: '/configuration/networking/wifi/radios/' + radioKey + '/ssids/' + ssidKey,
      value: ssidPatch
    }];
    
    // PATCH uses merge semantics on configuration_managers
    const patchData = {
      configuration: {
        networking: {
          wifi: {
            radios: {
              [radioKey]: {
                ssids: {
                  [ssidKey]: ssidPatch
                }
              }
            }
          }
        }
      }
    };
    
    await cpFetch('/configuration_managers/' + configId + '/', {
      method: 'PATCH',
      body: JSON.stringify(patchData)
    });
    
    auditLog({
      user: req.user.username,
      name: req.user.name,
      method: 'WIFI_UPDATE',
      path: '/api/cradlepoint/routers/' + routerId + '/wifi',
      body: { routerId, radioKey, ssidKey, newSsid: newSsid || '(unchanged)', passwordChanged: !!newPassword },
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    });
    
    console.log('[Cradlepoint] WiFi updated for router ' + routerId + ' (' + ssidKey + ') by ' + req.user.username);
    res.json({ success: true, message: 'WiFi configuration updated. Changes will sync to the router shortly.' });
  } catch (err) {
    console.error('[Cradlepoint] WiFi update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Speed Tests ─────────────────────────────────────────────────────
// POST: Trigger a speed test on a router
app.post('/api/cradlepoint/routers/:id/speedtest', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  
  try {
    const routerId = req.params.id;
    
    // Get account URL (needed for speed test)
    const routerData = await cpFetch('/routers/' + routerId + '/');
    const accountUrl = routerData.account || '';
    
    // Get the primary modem net_device ID
    const netDevData = await cpFetch('/net_devices/?router=' + CP_BASE_URL + '/routers/' + routerId + '/&type=mdm&limit=10');
    const modems = netDevData.data || [];
    const primaryModem = modems.find(m => m.connection_state === 'connected') || modems[0];
    
    if (!primaryModem) {
      return res.status(400).json({ error: 'No modem found on this router' });
    }
    
    // Trigger speed test using Cradlepoint default server
    const testBody = {
      account: accountUrl,
      config: {
        host: req.body.host || '',  // Empty = use Cradlepoint default
        max_test_concurrency: 1,
        net_device_ids: [primaryModem.id],
        port: req.body.port || 12865,
        size: null,
        test_timeout: 10,
        test_type: req.body.testType || 'TCP Download',
        time: 5
      }
    };
    
    const testResult = await cpFetch('/speed_test/', {
      method: 'POST',
      body: JSON.stringify(testBody)
    });
    
    auditLog({
      user: req.user.username,
      name: req.user.name,
      method: 'SPEED_TEST',
      path: '/api/cradlepoint/routers/' + routerId + '/speedtest',
      body: { routerId, modemId: primaryModem.id, testType: testBody.config.test_type },
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    });
    
    console.log('[Cradlepoint] Speed test triggered for router ' + routerId + ' by ' + req.user.username);
    res.json({ success: true, test: testResult });
  } catch (err) {
    console.error('[Cradlepoint] Speed test trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET: Poll speed test status/results
app.get('/api/cradlepoint/speedtest/:testId', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const data = await cpFetch('/speed_test/' + req.params.testId + '/');
    res.json(data);
  } catch (err) {
    console.error('[Cradlepoint] Speed test poll error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Historical GPS Tracking ─────────────────────────────────────────
// GET: Fetch location history for a router
app.get('/api/cradlepoint/routers/:id/history', async (req, res) => {
  if (!CP_ECM_API_ID) return res.status(503).json({ error: 'Cradlepoint not configured' });
  try {
    const routerId = req.params.id;
    const days = parseInt(req.query.days) || 7;
    const limit = parseInt(req.query.limit) || 500;
    
    // Calculate start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startIso = startDate.toISOString().replace('+', '%2b');
    
    const routerUrl = CP_BASE_URL + '/routers/' + routerId + '/';
    const url = '/historical_locations/?router=' + encodeURIComponent(routerUrl) + 
                '&limit=' + limit + 
                '&created_at__gt=' + startIso +
                '&order_by=created_at';
    
    const data = await cpFetch(url);
    const locations = (data.data || []).map(loc => ({
      lat: loc.latitude,
      lng: loc.longitude,
      speed: loc.speed || 0,
      heading: loc.heading || 0,
      accuracy: loc.accuracy || 0,
      timestamp: loc.created_at || ''
    }));
    
    console.log('[Cradlepoint] GPS history for router ' + routerId + ': ' + locations.length + ' points over ' + days + ' days');
    res.json({ routerId, days, locations });
  } catch (err) {
    console.error('[Cradlepoint] GPS history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ── Customer Data Usage Sharing (QR Code Portal) ─────────────────────
// ═══════════════════════════════════════════════════════════════════════

const SHARE_TOKENS_FILE = path.join(DATA_DIR, 'share-tokens.json');
let shareTokens = {};

// Load tokens from disk
function loadShareTokens() {
  try {
    if (fs.existsSync(SHARE_TOKENS_FILE)) {
      shareTokens = JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf8'));
      // Clean expired tokens
      const now = Date.now();
      let cleaned = 0;
      for (const [token, data] of Object.entries(shareTokens)) {
        if (data.expiresAt && new Date(data.expiresAt).getTime() < now) {
          delete shareTokens[token];
          cleaned++;
        }
      }
      if (cleaned > 0) saveShareTokens();
      console.log('[Share] Loaded ' + Object.keys(shareTokens).length + ' active share tokens');
    }
  } catch (e) {
    console.error('[Share] Error loading tokens:', e.message);
    shareTokens = {};
  }
}

function saveShareTokens() {
  try {
    fs.writeFileSync(SHARE_TOKENS_FILE, JSON.stringify(shareTokens, null, 2));
  } catch (e) {
    console.error('[Share] Error saving tokens:', e.message);
  }
}

loadShareTokens();

// Admin: Generate a share token for an order
app.post('/api/share/generate', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  const { orderId, customerName, eventName, startDate, endDate, totalGbAmount } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  
  // Check if token already exists for this order
  const existing = Object.entries(shareTokens).find(([_, d]) => d.orderId === orderId && new Date(d.expiresAt) > new Date());
  if (existing) {
    return res.json({ token: existing[0], shareUrl: '/share/' + existing[0], ...existing[1], alreadyExists: true });
  }
  
  // Generate secure token
  const crypto = require('crypto');
  const token = crypto.randomBytes(16).toString('hex');
  
  // Calculate expiration: 7 days after rental end date, or 30 days from now if no end date
  let expiresAt;
  if (endDate) {
    const end = new Date(endDate);
    end.setDate(end.getDate() + 7);
    expiresAt = end.toISOString();
  } else {
    const exp = new Date();
    exp.setDate(exp.getDate() + 30);
    expiresAt = exp.toISOString();
  }
  
  // Determine branchName from orderId (Webbing branches match order IDs)
  const branchName = orderId.toUpperCase();
  
  shareTokens[token] = {
    orderId,
    branchName,
    customerName: customerName || '',
    eventName: eventName || '',
    startDate: startDate || '',
    endDate: endDate || '',
    totalGbAmount: parseFloat(totalGbAmount || 0),
    createdAt: new Date().toISOString(),
    expiresAt,
    createdBy: req.user.username
  };
  
  saveShareTokens();
  
  // Audit log
  if (typeof auditLog === 'function') {
    auditLog(req, 'share_generate', { orderId, token: token.substring(0, 8) + '...' });
  }
  
  console.log('[Share] Token generated for ' + orderId + ' by ' + req.user.username + ' (expires ' + expiresAt + ')');
  
  res.json({
    token,
    shareUrl: '/share/' + token,
    ...shareTokens[token]
  });
});

// Admin: List all active share tokens
app.get('/api/share/list', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  const now = new Date();
  const active = Object.entries(shareTokens)
    .filter(([_, d]) => new Date(d.expiresAt) > now)
    .map(([token, d]) => ({ token, shareUrl: '/share/' + token, ...d }));
  
  res.json({ tokens: active, total: active.length });
});

// Admin: Revoke a share token
app.delete('/api/share/:token', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  const { token } = req.params;
  if (shareTokens[token]) {
    const orderId = shareTokens[token].orderId;
    delete shareTokens[token];
    saveShareTokens();
    if (typeof auditLog === 'function') {
      auditLog(req, 'share_revoke', { orderId, token: token.substring(0, 8) + '...' });
    }
    console.log('[Share] Token revoked for ' + orderId);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Token not found' });
});

// Public: Validate token and return order info (NO auth required)
app.get('/api/public/share/:token', (req, res) => {
  const data = shareTokens[req.params.token];
  if (!data) return res.status(404).json({ error: 'Share link not found or expired' });
  if (new Date(data.expiresAt) < new Date()) {
    delete shareTokens[req.params.token];
    saveShareTokens();
    return res.status(410).json({ error: 'This share link has expired' });
  }
  
  // Return only safe customer-facing data
  res.json({
    valid: true,
    orderId: data.orderId,
    customerName: data.customerName,
    eventName: data.eventName,
    startDate: data.startDate,
    endDate: data.endDate,
    totalGbAmount: data.totalGbAmount,
    expiresAt: data.expiresAt
  });
});

// Public: Get live device usage data for a shared order (NO auth required)
app.get('/api/public/share/:token/usage', async (req, res) => {
  const data = shareTokens[req.params.token];
  if (!data) return res.status(404).json({ error: 'Share link not found or expired' });
  if (new Date(data.expiresAt) < new Date()) {
    return res.status(410).json({ error: 'This share link has expired' });
  }
  
  const branchName = data.branchName;
  const results = { devices: [], totalUsageMB: 0, totalUsageGB: 0 };
  
  try {
    // ─── Find branch SIMs in the Webbing cache ───
    const branchDevices = webbingDeviceCache.filter(d => 
      d.BranchName && d.BranchName.toUpperCase() === branchName
    );
    
    // ─── Fetch SimpleMDM devices to match iPad names ───
    let mdmMatches = {};  // iccid -> { name, serial, barcode }
    try {
      const mdmKey = getSimpleMdmKey();
      if (mdmKey) {
        const auth = 'Basic ' + Buffer.from(mdmKey + ':').toString('base64');
        let mdmDevices = [];
        
        // Use SimpleMDM search to find devices matching this order name
        const searchUrl = `https://a.simplemdm.com/api/v1/devices?search=${encodeURIComponent(data.orderId)}&limit=100`;
        const mdmRes = await fetch(searchUrl, { headers: { 'Authorization': auth } });
        
        if (mdmRes.ok) {
          const mdmData = await mdmRes.json();
          const batch = mdmData.data || [];
          
          for (const d of batch) {
            const name = d.attributes?.name || '';
            // Extract ICCID from service_subscriptions
            const subs = d.attributes?.service_subscriptions || [];
            const iccid = subs.length > 0 ? (subs[0].iccid || '') : '';
            mdmDevices.push({
              name: name,
              serial: d.attributes?.serial_number || '',
              barcode: '', // barcode stored in custom attributes
              model: d.attributes?.model_name || '',
              iccid: iccid,
              imei: d.attributes?.imei || ''
            });
          }
        } else {
          console.error('[Share] SimpleMDM search failed:', mdmRes.status);
        }
        
        // Build ICCID -> iPad mapping  
        for (const d of mdmDevices) {
          if (d.iccid) {
            const cleanIccid = d.iccid.replace(/\s/g, '');
            mdmMatches[cleanIccid] = d;
          }
          // Also match by IMEI — SIM and iPad share the same IMEI
          if (d.imei) {
            const simByImei = branchDevices.find(s => (s.IMEI || '') === d.imei);
            if (simByImei && simByImei.ICCID) {
              mdmMatches[simByImei.ICCID.replace(/\s/g, '')] = d;
            }
          }
        }
        
        console.log('[Share] SimpleMDM search for "' + data.orderId + '": found ' + mdmDevices.length + ' devices, matched ' + Object.keys(mdmMatches).length + ' to SIMs');
      } else {
        console.log('[Share] No SimpleMDM key configured');
      }
    } catch (e) {
      console.error('[Share] SimpleMDM lookup error:', e.message);
    }
    
    // ─── Fetch Webbing SIM Usage ───
    if (branchDevices.length > 0) {
      const client = getWebbingClient();
      const rawStart = data.startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];
      const rawEnd = data.endDate && data.endDate < today ? data.endDate : today;
      
      // Convert YYYY-MM-DD to MM/dd/yyyy for Webbing API
      function toWebbingDate(isoDate) {
        const [y, m, d] = isoDate.split('-');
        return m + '/' + d + '/' + y;
      }
      const startDate = toWebbingDate(rawStart);
      const endDate = toWebbingDate(rawEnd);
      
      console.log('[Share] Fetching usage for ' + branchDevices.length + ' devices, ' + startDate + ' to ' + endDate);
      
      for (const dev of branchDevices) {
        let usageMB = 0;
        let usageError = null;
        
        try {
          // Use 'Unknown' interval for total (matching working branch usage pattern)
          const usageData = await client.getDeviceUsage(dev.ServiceDeviceID, startDate, endDate, 'Unknown');
          const usage = usageData?.Usage;
          if (usage && usage.DeviceUsageRecord) {
            const records = Array.isArray(usage.DeviceUsageRecord) ? usage.DeviceUsageRecord : [usage.DeviceUsageRecord];
            for (const r of records) {
              usageMB += parseFloat(r.TotalUsage || 0);
            }
          }
        } catch (e) {
          usageError = e.message;
          console.error('[Share] Usage error for device ' + dev.ServiceDeviceID + ' (' + (dev.SSID || dev.Serial || '') + '):', e.message);
        }
        
        // Find matched iPad for this SIM
        const iccid = (dev.ICCID || '').replace(/\s/g, '');
        const ipad = mdmMatches[iccid] || null;
        
        // Detect carrier from ProductName or matched data
        const pn = dev.ProductName || '';
        let carrier = 'Cellular';
        if (pn.includes('VZ') || pn.includes('Verizon')) carrier = 'Verizon';
        else if (pn.includes('AT&T') || pn.includes('ATT')) carrier = 'AT&T';
        else if (pn.includes('T-Mobile') || pn.includes('TMO')) carrier = 'T-Mobile';
        // Determine device type for icon
        // Matched to SimpleMDM iPad = 'ipad', unmatched SIM = 'hotspot' (standalone data device)
        const deviceType = ipad ? 'ipad' : 'hotspot';
        
        results.devices.push({
          type: deviceType,
          // Use iPad name if available, otherwise SIM serial/SSID
          name: ipad ? ipad.name : (dev.SSID || dev.Serial || 'Cellular SIM'),
          deviceName: ipad ? ipad.name : null,
          serialNumber: ipad ? ipad.serial : (dev.Serial || ''),
          barcode: ipad ? ipad.barcode : '',
          model: ipad ? ipad.model : '',
          simSerial: dev.SSID || dev.Serial || '',
          iccid: iccid,
          carrier: carrier,
          status: dev.StatusName || '',
          usageMB: Math.round(usageMB * 100) / 100,
          usageGB: Math.round((usageMB / 1024) * 1000) / 1000,
          ...(usageError ? { error: 'Usage temporarily unavailable' } : {})
        });
        results.totalUsageMB += usageMB;
      }
    }
    
    // ─── Cradlepoint Routers: enrich matching SIM entries ───
    // A Cradlepoint router uses a Webbing SIM — find which SIMs are in routers
    // and upgrade their type/name instead of adding separate router entries
    if (CP_ECM_API_ID && branchDevices.length > 0) {
      try {
        const cpFleet = await cpFetch('/routers/?limit=200');
        const cpNetDevs = await cpFetch('/net_devices/?limit=500');
        
        for (const nd of (cpNetDevs.data || [])) {
          const ndIccid = String(nd.iccid || '').trim();
          if (!ndIccid) continue;
          
          // Find the SIM device entry we already added that matches this Cradlepoint net_device
          const matchedDevice = results.devices.find(d => 
            d.iccid && d.iccid.replace(/\s/g, '') === ndIccid.replace(/\s/g, '')
          );
          
          if (matchedDevice) {
            const routerUrl = nd.router || '';
            const rid = routerUrl.replace(/\/$/, '').split('/').pop();
            const router = (cpFleet.data || []).find(r => String(r.id) === rid);
            if (router) {
              // Upgrade this SIM entry to a router
              matchedDevice.type = 'router';
              matchedDevice.name = router.name || 'Cradlepoint Router';
              matchedDevice.routerSerial = router.serial_number || '';
              matchedDevice.model = router.full_product_name || '';
              matchedDevice.routerStatus = router.state || 'unknown';
              // Keep the SIM's usage data — it's the router's data usage
              console.log('[Share] Matched Cradlepoint ' + (router.name || rid) + ' to SIM ' + matchedDevice.simSerial);
            }
          }
        }
      } catch (e) {
        console.error('[Share] Cradlepoint lookup error:', e.message);
      }
    }
    
    results.totalUsageGB = Math.round((results.totalUsageMB / 1024) * 1000) / 1000;
    results.totalGbAmount = data.totalGbAmount || 0;
    results.overageGB = data.totalGbAmount > 0 ? Math.max(0, Math.round((results.totalUsageGB - data.totalGbAmount) * 1000) / 1000) : 0;
    results.usagePercent = data.totalGbAmount > 0 ? Math.min(100, Math.round((results.totalUsageGB / data.totalGbAmount) * 100)) : 0;
    
    console.log('[Share] Usage for ' + data.orderId + ': ' + results.totalUsageGB + ' GB / ' + data.totalGbAmount + ' GB, ' + results.devices.length + ' devices');
    
    res.json(results);
  } catch (err) {
    console.error('[Share] Usage aggregation error:', err.message);
    res.status(500).json({ error: 'Failed to fetch usage data' });
  }
});


// ── CoverageMap API Proxy (for Site Checker) ────────────────────────
const COVERAGEMAP_KEY = process.env.COVERAGEMAP_KEY || 'e3f45af8095f4148998998511ad55754';
app.get('/api/coveragemap', async (req, res) => {
  const { latitude, longitude } = req.query;
  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'Missing latitude or longitude' });
  }
  try {
    const apiUrl = `https://enterprise.coveragemap.com/api/v1/signal-strength/lookup?latitude=${latitude}&longitude=${longitude}`;
    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${COVERAGEMAP_KEY}`,
        'Accept': 'application/json',
      },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Server-side Starlink credentials (from env vars)
const SL_CLIENT_ID = process.env.STARLINK_CLIENT_ID || '';
const SL_CLIENT_SECRET = process.env.STARLINK_CLIENT_SECRET || '';
let slServerToken = null;
let slServerTokenExpiry = 0;

async function getStarlinkServerToken() {
  // Return cached token if still valid (30s buffer)
  if (slServerToken && Date.now() < slServerTokenExpiry - 30000) {
    return slServerToken;
  }
  if (!SL_CLIENT_ID || !SL_CLIENT_SECRET) {
    return null; // Not configured
  }
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', SL_CLIENT_ID);
    params.append('client_secret', SL_CLIENT_SECRET);
    const response = await fetch('https://starlink.com/api/auth/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!response.ok) {
      console.error('[Starlink] Token refresh failed:', response.status);
      return null;
    }
    const data = await response.json();
    slServerToken = data.access_token;
    slServerTokenExpiry = Date.now() + (data.expires_in || 900) * 1000;
    console.log('[Starlink] Server token refreshed, expires in ' + data.expires_in + ' seconds');
    return slServerToken;
  } catch (err) {
    console.error('[Starlink] Token refresh error:', err.message);
    return null;
  }
}

if (SL_CLIENT_ID) {
  console.log('[Starlink] Server-side auth configured');
  getStarlinkServerToken(); // Pre-fetch on startup
} else {
  console.log('[Starlink] No server credentials — standalone page login only');
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

app.get('/api/starlink/fleet', async (req, res) => {
  // Try server token first, then fall back to request header
  let authHeader = req.headers.authorization;
  if (!authHeader) {
    const serverToken = await getStarlinkServerToken();
    if (serverToken) {
      authHeader = 'Bearer ' + serverToken;
    } else {
      return res.status(401).json({ error: 'Starlink not configured', configured: false });
    }
  }

  try {
    // Fetch terminals, service lines, and router configs in parallel
    const [terminalsRes, serviceLinesRes, routerConfigsRes, alertsRes] = await Promise.all([
      fetch('https://starlink.com/api/public/v2/user-terminals', {
        headers: { 'Content-Type': 'application/json', Authorization: authHeader }
      }),
      fetch('https://starlink.com/api/public/v2/service-lines', {
        headers: { 'Content-Type': 'application/json', Authorization: authHeader }
      }),
      fetch('https://starlink.com/api/public/v2/routers/configs', {
        headers: { 'Content-Type': 'application/json', Authorization: authHeader }
      }),
      fetch('https://starlink.com/api/public/v2/alerts', {
        headers: { 'Content-Type': 'application/json', Authorization: authHeader }
      })
    ]);

    const terminals = terminalsRes.ok ? await terminalsRes.json() : { content: { results: [] } };
    const serviceLines = serviceLinesRes.ok ? await serviceLinesRes.json() : { content: { results: [] } };
    const routerConfigs = routerConfigsRes.ok ? await routerConfigsRes.json() : { content: { results: [] } };
    const alerts = alertsRes.ok ? await alertsRes.json() : { content: { results: [] } };

    // Build service line lookup
    const slResults = serviceLines.content?.results || serviceLines.results || [];
    const serviceLineMap = {};
    for (const sl of slResults) {
      serviceLineMap[sl.serviceLineNumber || sl.serviceLineId] = sl;
    }

    // Normalize terminal data
    const termResults = terminals.content?.results || terminals.results || [];
    const normalizedTerminals = termResults.map(t => ({
      userTerminalId: t.userTerminalId || t.id || '',
      kitSerialNumber: t.kitSerialNumber || '',
      dishSerialNumber: t.dishSerialNumber || '',
      serviceLineNumber: t.serviceLineNumber || '',
      nickname: t.nickname || t.userTerminalId || '',
      active: t.active !== false,
      hardwareVersion: t.hardwareVersion || '',
      softwareVersion: t.softwareVersion || '',
      routerId: t.routerId || '',
      serviceLine: serviceLineMap[t.serviceLineNumber] || null
    }));

    const alertResults = alerts.content?.results || alerts.results || [];

    console.log('[Starlink] Fleet: ' + normalizedTerminals.length + ' terminals, ' + slResults.length + ' service lines, ' + alertResults.length + ' alerts');

    res.json({
      configured: true,
      terminals: normalizedTerminals,
      serviceLines: slResults,
      routerConfigs: routerConfigs.content?.results || routerConfigs.results || [],
      alerts: alertResults,
      stats: {
        terminalCount: normalizedTerminals.length,
        activeCount: normalizedTerminals.filter(t => t.active).length,
        alertCount: alertResults.length
      }
    });
  } catch (err) {
    console.error('[Starlink] Fleet fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Starlink fleet data', configured: true });
  }
});

// Server-authed Starlink actions (for Command Center integration)
app.post('/api/starlink/reboot/:userTerminalId', async (req, res) => {
  const token = await getStarlinkServerToken();
  if (!token) return res.status(401).json({ error: 'Starlink not configured' });
  try {
    const response = await fetch('https://starlink.com/api/public/v2/user-terminals/' + req.params.userTerminalId + '/reboot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }
    res.json({ success: true, action: 'reboot', terminalId: req.params.userTerminalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/starlink/stow/:userTerminalId', async (req, res) => {
  const token = await getStarlinkServerToken();
  if (!token) return res.status(401).json({ error: 'Starlink not configured' });
  try {
    const response = await fetch('https://starlink.com/api/public/v2/user-terminals/' + req.params.userTerminalId + '/stow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }
    res.json({ success: true, action: 'stow', terminalId: req.params.userTerminalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/starlink/unstow/:userTerminalId', async (req, res) => {
  const token = await getStarlinkServerToken();
  if (!token) return res.status(401).json({ error: 'Starlink not configured' });
  try {
    const response = await fetch('https://starlink.com/api/public/v2/user-terminals/' + req.params.userTerminalId + '/unstow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }
    res.json({ success: true, action: 'unstow', terminalId: req.params.userTerminalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ██  DCR → SimpleMDM Automation Engine
// ══════════════════════════════════════════════════════════════════════



// ── Server Config (persisted to JSON) ───────────────────────────────
// Use /data volume on Railway for persistence, fall back to local for dev
const PERSIST_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true });
const CONFIG_FILE = path.join(PERSIST_DIR, 'automation-config.json');

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

// ── Multi-account SimpleMDM registry ─────────────────────────────────
const MDM_ACCOUNTS = {
  fello: {
    name: 'Fello',
    getKey: () => serverConfig.simpleMdmKey || process.env.SIMPLEMDM_API_KEY || '',
    depServerId: '10650',
    webbingBranch: null  // Fello uses per-order branches
  },
  alamo: {
    name: 'Alamo Fireworks',
    getKey: () => process.env.SIMPLEMDM_ALAMO_KEY || 'Ze4rUrKGFpQW4hsO9g4wZsDRBMszrNAWkoHI01PCnKp3fQG6tuJvyVeZPyIpR7rS',
    depServerId: '7997',
    webbingBranch: 'SQ14503'  // Alamo SIMs live under this Webbing branch
  }
};

// ── IMS NextGen CRM Integration ───────────────────────────────────────
const crmClient = new FelloCrmClient({
  baseUrl: process.env.IMS_NEXTGEN_URL || 'https://ims-v4-migration-prod-876702752852.us-east4.run.app',
  apiKey: process.env.IMS_NEXTGEN_TOKEN || '2423|rydhEvIv6ZsEABia67jH5ffhMUJLthtu3YrfySpx93f5cc0e'
});

function getMdmAccountKey(accountId) {
  const acct = MDM_ACCOUNTS[accountId];
  if (!acct) throw new Error(`Unknown MDM account: ${accountId}`);
  return acct.getKey();
}

function getAllMdmAccounts() {
  return Object.entries(MDM_ACCOUNTS)
    .filter(([_, acct]) => !!acct.getKey())
    .map(([id, acct]) => ({ id, name: acct.name, depServerId: acct.depServerId }));
}


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
const DCR_LOG_FILE = path.join(PERSIST_DIR, 'dcr-submissions.json');

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
  // CORS headers
  const origin = req.headers.origin || '';
  const allowed = serverConfig.allowedOrigins || [];
  if (allowed.length === 0 || allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin || '*');
  }
  try {
    // categories is a parallel array matching files — one category per file
    const cats = req.body.categories || [];
    const catArray = Array.isArray(cats) ? cats : [cats];
    const files = (req.files || []).map((f, i) => ({
      name: f.originalname,
      storedName: f.filename,
      size: f.size,
      type: f.mimetype,
      url: `/api/dcr/${req.params.id}/files/${f.filename}`,
      category: catArray[i] || 'general',
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

// ── List configured MDM accounts ────────────────────────────────────
app.get('/api/simplemdm/accounts', (req, res) => {
  const accounts = getAllMdmAccounts();
  res.json({ accounts });
});

app.post('/api/simplemdm/dep/sync', async (req, res) => {
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

  try {
    const resp = await fetch(`https://a.simplemdm.com/api/v1/dep_servers/${depServerId}/sync`, {
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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
      const depUrl = `https://a.simplemdm.com/api/v1/dep_servers/${depServerId}/dep_devices?limit=100${depCursor ? `&starting_after=${depCursor}` : ''}`;
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
            const syncResp = await fetch(`https://a.simplemdm.com/api/v1/dep_servers/${depServerId}/sync`, {
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
              const depUrl = `https://a.simplemdm.com/api/v1/dep_servers/${depServerId}/dep_devices?limit=100${depCursor ? `&starting_after=${depCursor}` : ''}`;
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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';



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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';



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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';



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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
  const accountId = req.query.account || req.body?.account || 'fello';
  const rawKey = getMdmAccountKey(accountId);
  const auth = 'Basic ' + Buffer.from(rawKey + ':').toString('base64');
  const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';

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
app.get('/share/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share', 'index.html'));
});



// ══════════════════════════════════════════════════════════════════════
// ██  Device Location Tracking (with persistent history)
// ══════════════════════════════════════════════════════════════════════

const deviceLocations = {}; // Latest location per device (in-memory)
const LOCATION_HISTORY_FILE = path.join(PERSIST_DIR, 'location_history.jsonl');

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
    // List ALL devices from Cobrowse API (filter in code — API param names differ from dashboard)
    const listUrl = new URL('https://cobrowse.io/api/1/devices');

    console.log(`[Cobrowse] Searching for device: serial=${serial}, name=${deviceName}`);

    const devicesResp = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!devicesResp.ok) {
      const errText = await devicesResp.text();
      return res.status(502).json({ error: `Cobrowse API error: ${devicesResp.status} ${errText}` });
    }

    const allDevices = await devicesResp.json();
    console.log(`[Cobrowse] API returned ${allDevices.length} total device(s)`);
    if (allDevices.length > 0) {
      console.log(`[Cobrowse] Raw device fields:`, Object.keys(allDevices[0]).join(', '));
      console.log(`[Cobrowse] First device raw:`, JSON.stringify(allDevices[0], null, 2).substring(0, 1000));
    }
    console.log(`[Cobrowse] All devices:`, JSON.stringify(allDevices.map(d => ({
      id: d.id,
      name: d.custom_data?.device_name,
      app: d.custom_data?.app,
      serial: d.custom_data?.serial_number,
      online: d.online,
      connectable: d.connectable,
      state: d.state,
      last_active: d.last_active
    })), null, 2));

    // Filter to Fello Remote devices
    const felloDevices = allDevices.filter(d => d.custom_data?.app === 'Fello Remote' || d.custom_data?.app === 'Fello Connect');
    const connectableDevices = felloDevices.filter(d => d.connectable);
    // Also consider recently active devices (within last 15 min)
    const recentCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recentDevices = felloDevices.filter(d => d.last_active && d.last_active > recentCutoff);
    // Prefer connectable, then recently active, then all fello devices
    const devices = connectableDevices.length > 0 ? connectableDevices : (recentDevices.length > 0 ? recentDevices : felloDevices);
    console.log(`[Cobrowse] ${felloDevices.length} Fello devices, ${connectableDevices.length} connectable, ${recentDevices.length} recently active`);

    if (!devices || devices.length === 0) {
      return res.json({ error: 'No Fello Remote devices found. Make sure the app is installed and has been opened at least once.', devices: [] });
    }

    // Match device — try serial first, then name, then first online device
    let targetDevice = null;

    // Log all available device serials for debugging
    console.log(`[Cobrowse] Looking for serial="${serial}", name="${deviceName}"`);
    devices.forEach((d, i) => {
      console.log(`[Cobrowse]   Device ${i}: serial_number="${d.custom_data?.serial_number}", device_name="${d.custom_data?.device_name}", online=${d.online}`);
    });

    // Match by serial_number — prefer ONLINE device when duplicates exist
    if (serial) {
      const serialMatches = devices.filter(d =>
        d.custom_data && (
          d.custom_data.serial_number === serial ||
          d.custom_data.serial_number?.toUpperCase() === serial?.toUpperCase()
        )
      );
      if (serialMatches.length > 0) {
        // Prefer connectable device, then most recently active
        targetDevice = serialMatches.find(d => d.connectable) 
          || serialMatches.sort((a, b) => (b.last_active || '').localeCompare(a.last_active || ''))[0];
        console.log(`[Cobrowse] Matched by serial: ${serial} (${serialMatches.length} matches, picked ${targetDevice.connectable ? 'connectable' : 'offline'} device ${targetDevice.id})`);
      }
    }

    // Match by device name
    if (!targetDevice && deviceName) {
      targetDevice = devices.find(d =>
        d.custom_data && (
          d.custom_data.device_name === deviceName ||
          d.custom_data.device_name?.toLowerCase() === deviceName?.toLowerCase()
        )
      );
      if (targetDevice) console.log(`[Cobrowse] Matched by name: ${deviceName}`);
    }

    // Fallback: first online device
    if (!targetDevice && devices.length > 0) {
      targetDevice = devices[0];
      console.log(`[Cobrowse] No exact match — using first online device: ${targetDevice.custom_data?.device_name || targetDevice.id}`);
    }
    
    if (!targetDevice) {
      return res.json({ error: 'No matching Fello Connect device found online. Make sure the app is open on the iPad.' });
    }

    // Auto-cleanup: delete stale duplicate devices with the same serial
    // (Each app reinstall / keychain clear creates a new CoBrowse device registration)
    if (serial) {
      const allSerialMatches = devices.filter(d =>
        d.custom_data?.serial_number?.toUpperCase() === serial.toUpperCase()
      );
      if (allSerialMatches.length > 1) {
        // Sort by last_active descending, keep the most recent
        allSerialMatches.sort((a, b) => (b.last_active || '').localeCompare(a.last_active || ''));
        const staleDevices = allSerialMatches.slice(1);
        console.log(`[Cobrowse] Cleaning up ${staleDevices.length} stale device(s) with serial ${serial}`);
        // Delete stale devices in background (don't await)
        for (const stale of staleDevices) {
          fetch(`https://cobrowse.io/api/1/devices/${stale.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
          }).then(() => console.log(`[Cobrowse] Deleted stale device ${stale.id}`))
            .catch(err => console.warn(`[Cobrowse] Failed to delete ${stale.id}: ${err.message}`));
        }
      }
    }

    // Use CoBrowse's connect page filtered to this device's serial
    const connectUrl = `https://cobrowse.io/connect?token=${encodeURIComponent(token)}&filter_serial_number=${encodeURIComponent(serial || '')}&navigation=none`;
    
    console.log(`[Cobrowse] Returning connect URL for device ${targetDevice.id} (${targetDevice.custom_data?.device_name})`);
    
    res.json({
      mode: 'connect',
      token,
      connectUrl,
      deviceId: targetDevice.id,
      deviceName: targetDevice.custom_data?.device_name || 'Unknown',
      connectable: targetDevice.connectable
    });
  } catch (err) {
    console.error(`[Cobrowse] Connect error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  WEBBING WWS API INTEGRATION
// ══════════════════════════════════════════════════════════════════════

const { WebbingClient, WebbingApiError, normalizeArray } = require('./webbing-client');

// Initialize client from env vars
let webbingClient = null;
function getWebbingClient() {
  if (!webbingClient) {
    const username = process.env.WEBBING_USERNAME;
    const password = process.env.WEBBING_PASSWORD;
    const wsKey = process.env.WEBBING_WSKEY;
    if (!username || !password || !wsKey) {
      throw new Error('Webbing credentials not configured. Set WEBBING_USERNAME, WEBBING_PASSWORD, WEBBING_WSKEY environment variables.');
    }
    webbingClient = new WebbingClient({ username, password, wsKey });
  }
  return webbingClient;
}

// ── Device Inventory Cache ──────────────────────────────────────────────
let webbingDeviceCache = [];
let webbingCacheTime = null;
let webbingSyncing = false;
const WEBBING_SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes

async function syncWebbingDevices(forceAll = false) {
  if (webbingSyncing) return;
  webbingSyncing = true;
  try {
    const client = getWebbingClient();
    let options = {};

    // Delta sync if we have a recent cache
    if (!forceAll && webbingCacheTime && webbingDeviceCache.length > 0) {
      const since = new Date(webbingCacheTime.getTime() - 60000).toISOString(); // 1 min overlap
      options.fromUpdatedAt = since;
      console.log(`[Webbing] Delta sync from ${since}...`);
      const result = await client.getAllServiceDevices(options);
      // Merge updates into cache
      const updatedIds = new Set(result.devices.map(d => d.ServiceDeviceID));
      webbingDeviceCache = webbingDeviceCache.filter(d => !updatedIds.has(d.ServiceDeviceID));
      webbingDeviceCache.push(...result.devices);
      console.log(`[Webbing] Delta sync: ${result.devices.length} updated, total ${webbingDeviceCache.length} devices`);
    } else {
      console.log(`[Webbing] Full inventory sync starting...`);
      const result = await client.getAllServiceDevices(options);
      webbingDeviceCache = result.devices;
      console.log(`[Webbing] Full sync complete: ${result.total} devices`);
    }
    webbingCacheTime = new Date();
  } catch (err) {
    console.error(`[Webbing] Sync error:`, err.message);
  } finally {
    webbingSyncing = false;
  }
}

// Start periodic sync
setTimeout(() => {
  try { syncWebbingDevices(true); } catch (e) { console.error('[Webbing] Initial sync failed:', e.message); }
}, 5000); // 5 second delay on startup

setInterval(() => {
  try { syncWebbingDevices(false); } catch (e) { console.error('[Webbing] Periodic sync failed:', e.message); }
}, WEBBING_SYNC_INTERVAL);

// ── Webbing Config Check ────────────────────────────────────────────────
app.get('/api/webbing/config', (req, res) => {
  const configured = !!(process.env.WEBBING_USERNAME && process.env.WEBBING_PASSWORD && process.env.WEBBING_WSKEY);
  res.json({ configured, deviceCount: webbingDeviceCache.length, lastSync: webbingCacheTime });
});

// ── Device Inventory (cached, with server-side search/filter/paginate) ──
app.get('/api/webbing/devices', (req, res) => {
  try {
    const { page = 1, pageSize = 100, status, branch, search, deviceType } = req.query;
    let devices = [...webbingDeviceCache];

    // Filter by status
    if (status && status !== '0') {
      devices = devices.filter(d => d.StatusID == status);
    }
    // Filter by branch
    if (branch && branch !== '0') {
      devices = devices.filter(d => d.BranchID == branch);
    }
    // Filter by device type
    if (deviceType && deviceType !== '0') {
      devices = devices.filter(d => d.DeviceTypeID == deviceType);
    }
    // Search
    if (search) {
      const q = search.toLowerCase();
      devices = devices.filter(d =>
        (d.SSID && String(d.SSID).toLowerCase().includes(q)) ||
        (d.Serial && String(d.Serial).toLowerCase().includes(q)) ||
        (d.IMEI && String(d.IMEI).toLowerCase().includes(q)) ||
        (d.MSISDN && String(d.MSISDN).toLowerCase().includes(q)) ||
        (d.ICCID && String(d.ICCID).toLowerCase().includes(q)) ||
        (d.ProductName && String(d.ProductName).toLowerCase().includes(q)) ||
        (d.BranchName && String(d.BranchName).toLowerCase().includes(q))
      );
    }

    // Stats
    const stats = {
      total: webbingDeviceCache.length,
      filtered: devices.length,
      active: webbingDeviceCache.filter(d => d.StatusID === 3).length,
      suspended: webbingDeviceCache.filter(d => d.StatusID === 4).length,
      inactive: webbingDeviceCache.filter(d => d.StatusID === 2).length,
      deactivated: webbingDeviceCache.filter(d => d.StatusID === 5).length
    };

    // Get unique branches for filter dropdown
    const branches = [...new Set(webbingDeviceCache.map(d => JSON.stringify({ id: d.BranchID, name: d.BranchName })))].map(b => JSON.parse(b));

    // Paginate
    const p = parseInt(page);
    const ps = parseInt(pageSize);
    const start = (p - 1) * ps;
    const paged = devices.slice(start, start + ps);

    res.json({
      devices: paged,
      stats,
      branches,
      pagination: {
        page: p,
        pageSize: ps,
        totalRecords: devices.length,
        totalPages: Math.ceil(devices.length / ps)
      },
      lastSync: webbingCacheTime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Force Sync ──────────────────────────────────────────────────────────
app.post('/api/webbing/sync', async (req, res) => {
  try {
    await syncWebbingDevices(req.body?.full === true);
    res.json({ ok: true, deviceCount: webbingDeviceCache.length, lastSync: webbingCacheTime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Device Stats ────────────────────────────────────────────────────────
app.get('/api/webbing/stats', (req, res) => {
  const devices = webbingDeviceCache;
  const planCounts = {};
  const branchCounts = {};
  devices.forEach(d => {
    planCounts[d.ProductName || 'Unknown'] = (planCounts[d.ProductName || 'Unknown'] || 0) + 1;
    branchCounts[d.BranchName || 'Unknown'] = (branchCounts[d.BranchName || 'Unknown'] || 0) + 1;
  });

  res.json({
    total: devices.length,
    active: devices.filter(d => d.StatusID === 3).length,
    suspended: devices.filter(d => d.StatusID === 4).length,
    inactive: devices.filter(d => d.StatusID === 2).length,
    deactivated: devices.filter(d => d.StatusID === 5).length,
    byPlan: planCounts,
    byBranch: branchCounts,
    lastSync: webbingCacheTime
  });
});

// ── Branches List (aggregated from cache) ───────────────────────────────
app.get('/api/webbing/branches/list', (req, res) => {
  try {
    const { search, page = 1, pageSize = 50 } = req.query;
    const branchMap = {};

    webbingDeviceCache.forEach(d => {
      const key = d.BranchID || 0;
      if (!branchMap[key]) {
        branchMap[key] = {
          branchId: d.BranchID,
          branchName: d.BranchName || 'Unknown',
          total: 0,
          active: 0,
          suspended: 0,
          inactive: 0,
          deactivated: 0,
          plans: {},
          devices: []
        };
      }
      const b = branchMap[key];
      b.total++;
      if (d.StatusID === 3) b.active++;
      else if (d.StatusID === 4) b.suspended++;
      else if (d.StatusID === 2) b.inactive++;
      else if (d.StatusID === 5) b.deactivated++;
      const plan = d.ProductName || 'Unknown';
      b.plans[plan] = (b.plans[plan] || 0) + 1;
    });

    let branches = Object.values(branchMap);

    // Search
    if (search) {
      const q = search.toLowerCase();
      branches = branches.filter(b =>
        b.branchName.toLowerCase().includes(q) ||
        String(b.branchId).includes(q)
      );
    }

    // Sort by device count descending
    branches.sort((a, b) => b.total - a.total);

    // Stats
    const stats = {
      totalBranches: Object.keys(branchMap).length,
      filteredBranches: branches.length,
      totalDevices: webbingDeviceCache.length,
      activeDevices: webbingDeviceCache.filter(d => d.StatusID === 3).length,
      suspendedDevices: webbingDeviceCache.filter(d => d.StatusID === 4).length
    };

    // Paginate
    const p = parseInt(page);
    const ps = parseInt(pageSize);
    const start = (p - 1) * ps;
    const paged = branches.slice(start, start + ps);

    res.json({
      branches: paged,
      stats,
      pagination: {
        page: p,
        pageSize: ps,
        totalRecords: branches.length,
        totalPages: Math.ceil(branches.length / ps)
      },
      lastSync: webbingCacheTime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Branch Detail (devices in a branch) ─────────────────────────────────
app.get('/api/webbing/branches/:branchId/devices', (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId);
    const { page = 1, pageSize = 100, search, status } = req.query;
    let devices = webbingDeviceCache.filter(d => d.BranchID === branchId);

    const branchName = devices.length > 0 ? devices[0].BranchName : 'Unknown';

    // Filter by status
    if (status && status !== '0') {
      devices = devices.filter(d => d.StatusID == status);
    }

    // Search within branch
    if (search) {
      const q = search.toLowerCase();
      devices = devices.filter(d =>
        (d.SSID && d.SSID.toLowerCase().includes(q)) ||
        (d.Serial && d.Serial.toLowerCase().includes(q)) ||
        (d.IMEI && d.IMEI.toLowerCase().includes(q)) ||
        (d.ProductName && d.ProductName.toLowerCase().includes(q))
      );
    }

    // Stats for this branch
    const allBranchDevices = webbingDeviceCache.filter(d => d.BranchID === branchId);
    const stats = {
      total: allBranchDevices.length,
      filtered: devices.length,
      active: allBranchDevices.filter(d => d.StatusID === 3).length,
      suspended: allBranchDevices.filter(d => d.StatusID === 4).length,
      inactive: allBranchDevices.filter(d => d.StatusID === 2).length,
      deactivated: allBranchDevices.filter(d => d.StatusID === 5).length
    };

    // Paginate
    const p = parseInt(page);
    const ps = parseInt(pageSize);
    const start = (p - 1) * ps;
    const paged = devices.slice(start, start + ps);

    res.json({
      branchId,
      branchName,
      devices: paged,
      stats,
      pagination: {
        page: p,
        pageSize: ps,
        totalRecords: devices.length,
        totalPages: Math.ceil(devices.length / ps)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Live Telemetry ──────────────────────────────────────────────────────
app.get('/api/webbing/devices/:id/live', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.getLiveData(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Device Record (includes BranchID) ───────────────────────────────────
app.get('/api/webbing/devices/:id/record', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.getServiceDevice(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Device Location ─────────────────────────────────────────────────────
app.get('/api/webbing/devices/:id/location', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.getLocation(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Device Usage ────────────────────────────────────────────────────────
app.get('/api/webbing/devices/:id/usage', async (req, res) => {
  try {
    const client = getWebbingClient();
    const { start, end, groupBy } = req.query;
    // Default to last 30 days
    const endDate = end || new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const result = await client.getDeviceUsage(parseInt(req.params.id), startDate, endDate, groupBy || 'Day');
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Activate Device ─────────────────────────────────────────────────────
app.post('/api/webbing/devices/:id/activate', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.activateDevice(parseInt(req.params.id));
    // Trigger a delta sync to update cache
    setTimeout(() => syncWebbingDevices(false), 2000);
    res.json({ success: true, result });
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Suspend Device ──────────────────────────────────────────────────────
app.post('/api/webbing/devices/:id/suspend', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.suspendDevice(parseInt(req.params.id));
    setTimeout(() => syncWebbingDevices(false), 2000);
    res.json({ success: true, result });
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── IMEI Lock ───────────────────────────────────────────────────────────
app.get('/api/webbing/devices/:id/imei-lock', async (req, res) => {
  try {
    const client = getWebbingClient();
    const device = webbingDeviceCache.find(d => d.ServiceDeviceID == req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found in cache' });
    // GetIMEILock needs ICCID — find from device data
    const result = await client.getIMEILock(device.ICCID || device.Serial);
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Send SMS ────────────────────────────────────────────────────────────
app.post('/api/webbing/devices/:id/sms', async (req, res) => {
  try {
    const client = getWebbingClient();
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const result = await client.sendSMS(parseInt(req.params.id), message);
    res.json({ success: true, result });
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Accounts (debug) ────────────────────────────────────────────────────
app.get('/api/webbing/branches/:branchId/accounts', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.searchAccounts(parseInt(req.params.branchId));
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

app.get('/api/webbing/accounts/:accountId/assignments', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.searchAssignments(parseInt(req.params.accountId));
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Branches ────────────────────────────────────────────────────────────
app.get('/api/webbing/branches', async (req, res) => {
  try {
    const client = getWebbingClient();
    const freeText = req.query.search || req.query.q || '';
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 100;
    const result = await client.searchBranches(freeText, page, pageSize);
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Plans ───────────────────────────────────────────────────────────────
app.get('/api/webbing/plans', async (req, res) => {
  try {
    const client = getWebbingClient();
    const result = await client.getProducts();
    res.json(result);
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ██  ORDER CREATION                                                   ██
// ═══════════════════════════════════════════════════════════════════════

// ── Site Checker per order/branch ───────────────────────────────────────
app.post('/api/orders/:branchId/site-check', async (req, res) => {
  try {
    const branchId = req.params.branchId;
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Missing address' });

    // Geocode address via Nominatim
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`, {
      headers: { 'User-Agent': 'FelloCommandCenter/1.0' }
    });
    const geoData = await geoRes.json();
    if (!geoData.length) return res.status(404).json({ error: 'Address not found' });

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);
    const displayName = geoData[0].display_name;

    // Get carrier coverage from CoverageMap API
    const COVERAGEMAP_KEY = process.env.COVERAGEMAP_KEY || 'e3f45af8095f4148998998511ad55754';
    let coverage = {};
    if (COVERAGEMAP_KEY) {
      const cmRes = await fetch(`https://enterprise.coveragemap.com/api/v1/signal-strength/lookup?latitude=${lat}&longitude=${lon}`, {
        headers: { 'Authorization': `Bearer ${COVERAGEMAP_KEY}`, 'Accept': 'application/json' }
      });
      const cmData = await cmRes.json();
      if (cmData.status === 200 && Array.isArray(cmData.data)) {
        for (const entry of cmData.data) {
          const carrier = entry.provider?.name;
          const tech = entry.technology?.code;
          if (!carrier || !tech) continue;
          if (!coverage[carrier]) coverage[carrier] = {};
          coverage[carrier][tech] = {
            signal: entry.signal?.signal,
            quarterMile: entry.signal?.quarterMile,
            halfMile: entry.signal?.halfMile,
            oneMile: entry.signal?.oneMile,
            coverage: entry.coverage?.quarterMile
          };
        }
      }
    }

    // Determine recommendation
    const carrierPlanMap = {
      'T-Mobile': 11126,
      'AT&T': 11125,
      'Verizon': 11127
    };
    let recommended = null;
    let bestSignal = -999;
    for (const [carrier, techs] of Object.entries(coverage)) {
      // Prefer 5G signal, fall back to 4G
      const sig = techs['5G']?.signal || techs['4G']?.signal || -999;
      if (sig > bestSignal && carrierPlanMap[carrier]) {
        bestSignal = sig;
        recommended = carrier;
      }
    }

    // Build flat carriers array for frontend rendering (only carriers we have plans for)
    const allowedCarriers = ['T-Mobile', 'AT&T', 'Verizon'];
    const carriers = Object.entries(coverage)
      .filter(([name]) => allowedCarriers.includes(name))
      .map(([name, techs]) => {
      const sig = techs['5G']?.signal || techs['4G']?.signal || -999;
      return {
        name,
        signalDbm: sig,
        tech5G: techs['5G'] || null,
        tech4G: techs['4G'] || null,
        recommended: name === recommended,
        planId: carrierPlanMap[name] || null
      };
    }).sort((a, b) => b.signalDbm - a.signalDbm);

    const result = {
      address: displayName,
      inputAddress: address,
      geocodedAddress: displayName,
      latitude: lat,
      longitude: lon,
      coverage,
      carriers,
      recommended,
      recommendedPlanId: recommended ? carrierPlanMap[recommended] : null,
      checkedAt: new Date().toISOString()
    };

    // Persist
    const checks = loadSiteChecks();
    checks[branchId] = result;
    saveSiteChecks(checks);

    console.log(`[SiteCheck] Branch ${branchId}: ${address} → ${recommended || 'no recommendation'} (${bestSignal} dBm)`);
    res.json(result);
  } catch (err) {
    console.error('[SiteCheck] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get stored site check result
app.get('/api/orders/:branchId/site-check', (req, res) => {
  const checks = loadSiteChecks();
  const result = checks[req.params.branchId];
  if (result) return res.json(result);
  res.json(null);
});

// Apply recommended carrier to all devices in a branch
app.post('/api/orders/:branchId/apply-carrier', async (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId);
    const { planId, carrierName, address } = req.body;
    if (!planId) return res.status(400).json({ error: 'Missing planId' });

    // Find all devices in this branch
    const devices = webbingDeviceCache.filter(d => d.BranchID === branchId);
    if (!devices.length) return res.status(404).json({ error: 'No devices found in branch' });

    const client = getWebbingClient();
    const results = [];
    for (const d of devices) {
      try {
        await client.changePlan(d.ServiceDeviceID, planId);
        results.push({ id: d.ServiceDeviceID, success: true });
      } catch (e) {
        results.push({ id: d.ServiceDeviceID, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // Update stored site check with applied carrier
    const checks = loadSiteChecks();
    const branchKey = req.params.branchId;
    if (checks[branchKey]) {
      checks[branchKey].appliedCarrier = carrierName;
      checks[branchKey].appliedPlanId = planId;
      checks[branchKey].appliedAt = new Date().toISOString();
      saveSiteChecks(checks);
    }

    // Trigger Webbing cache refresh
    setTimeout(() => syncWebbingDevices(false), 2000);

    const successCount = results.filter(r => r.success).length;
    console.log(`[SiteCheck] Applied ${carrierName} (plan ${planId}) to ${successCount}/${devices.length} devices in branch ${branchId}`);
    res.json({ success: true, total: devices.length, changed: successCount, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── eSIM Profile Assignment Tool ─────────────────────────────────────────
app.post('/api/esim/assign', async (req, res) => {
  try {
    const { serials = [], branchId } = req.body;
    if (!serials.length) return res.status(400).json({ error: 'No serials provided' });

    const client = getWebbingClient();
    const results = [];

    // Step 1: Get available (Inactive) eSIM service devices from Webbing
    // StatusID 2 = Inactive — these are unassigned eSIM SIM lines
    console.log(`[eSIM] Searching for inactive (unassigned) eSIM devices...`);
    let availableProfiles = [];
    try {
      const profileResult = await client.getServiceDevices({ statusId: 2, pageSize: 1000 });
      const devices = profileResult.ServiceDevices?.ServiceDeviceRecord;
      if (devices) {
        availableProfiles = Array.isArray(devices) ? devices : [devices];
      }
      console.log(`[eSIM] Found ${availableProfiles.length} inactive eSIM devices`);
    } catch (e) {
      console.error('[eSIM] Failed to fetch inactive devices:', e.message);
    }

    if (!availableProfiles.length) {
      return res.status(404).json({ error: 'No inactive eSIM devices found in Webbing. All profiles may already be assigned.' });
    }

    // Step 2: For each serial, get EID from ABM and match to an available eSIM profile
    let profileIndex = 0;
    for (const serial of serials) {
      const result = { serial, status: 'pending', eid: null, iccid: null, error: null };
      
      try {
        // Get EID from ABM
        console.log(`[eSIM] Looking up ABM device: ${serial}`);
        const abmDevice = await abmLookupDevice(serial);
        if (!abmDevice) {
          result.status = 'error';
          result.error = 'Device not found in Apple Business Manager';
          results.push(result);
          continue;
        }

        const attr = abmDevice.attributes || abmDevice;
        const eid = attr.eid || '';
        result.eid = eid;

        if (!eid) {
          result.status = 'error';
          result.error = 'No EID found for device in ABM — device may not support eSIM or hasn\'t reported EID yet';
          results.push(result);
          continue;
        }

        // Pick next available profile
        if (profileIndex >= availableProfiles.length) {
          result.status = 'error';
          result.error = 'No more available eSIM profiles — all have been assigned';
          results.push(result);
          continue;
        }

        const profile = availableProfiles[profileIndex];
        const iccid = profile.ICCID || '';
        result.iccid = iccid;
        result.profileId = profile.ServiceDeviceID || profile.ID;
        result.msisdn = profile.MSISDN || '';
        result.serial_sim = profile.Serial || '';

        // Match EID to eSIM profile
        console.log(`[eSIM] Matching serial ${serial} (EID: ${eid}) to profile ICCID: ${iccid}`);
        await client.esimEIDMatch({ ICCID: iccid }, eid);
        
        result.status = 'success';
        result.message = `Matched EID to eSIM profile (ICCID: ${iccid})`;
        profileIndex++;
        
        console.log(`[eSIM] ✓ ${serial} → ICCID ${iccid}`);
      } catch (e) {
        result.status = 'error';
        result.error = e.message || 'Unknown error during eSIM matching';
        console.error(`[eSIM] ✗ ${serial}: ${e.message}`);
      }

      results.push(result);
      // Rate limiting — 300ms between calls
      await new Promise(r => setTimeout(r, 300));
    }

    const successCount = results.filter(r => r.status === 'success').length;
    console.log(`[eSIM] Assignment complete: ${successCount}/${serials.length} successful`);

    res.json({
      success: true,
      total: serials.length,
      assigned: successCount,
      failed: serials.length - successCount,
      availableProfilesRemaining: availableProfiles.length - profileIndex,
      results
    });
  } catch (err) {
    console.error('[eSIM] Fatal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── eSIM Status Check ───────────────────────────────────────────────────
app.get('/api/esim/status/:serial', async (req, res) => {
  try {
    const serial = req.params.serial;
    
    // Find the device in Webbing cache by serial
    const device = webbingDeviceCache.find(d => 
      d.Serial && d.Serial.toUpperCase() === serial.toUpperCase()
    );
    
    if (!device) {
      return res.json({ serial, hasProfile: false, message: 'Device not found in Webbing' });
    }

    const client = getWebbingClient();
    const subscription = await client.getESIMSubscription(device.ServiceDeviceID);
    
    res.json({
      serial,
      hasProfile: true,
      serviceDeviceId: device.ServiceDeviceID,
      subscription
    });
  } catch (err) {
    res.json({ serial: req.params.serial, hasProfile: false, error: err.message });
  }
});

// ── Available eSIM profiles count ───────────────────────────────────────
app.get('/api/esim/available', async (req, res) => {
  try {
    const client = getWebbingClient();
    // Inactive eSIM devices (statusId=2) are unassigned and available
    const result = await client.getServiceDevices({ statusId: 2, pageSize: 1 });
    const total = result.PaginationResponse?.TotalRecords || 0;
    res.json({ available: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/create', async (req, res) => {
  try {
    const { orderName, account = 'fello', serials = [] } = req.body;
    
    if (!orderName || !orderName.trim()) {
      return res.status(400).json({ error: 'Order name is required' });
    }
    
    const acct = MDM_ACCOUNTS[account];
    if (!acct) {
      return res.status(400).json({ error: `Unknown MDM account: ${account}` });
    }
    
    const apiKey = acct.getKey();
    if (!apiKey) {
      return res.status(400).json({ error: `No API key configured for ${acct.name}` });
    }
    
    const cleanName = orderName.trim();
    console.log(`[Order] Creating order "${cleanName}" in ${acct.name} with ${serials.length} serials`);
    
    // Step 1: Create assignment group in SimpleMDM
    const groupResp = await smdmRequest(apiKey, '/assignment_groups', 'POST', {
      name: cleanName,
      auto_deploy: true
    });
    
    const groupId = groupResp?.data?.id;
    if (!groupId) {
      console.error('[Order] Failed to create group:', JSON.stringify(groupResp));
      return res.status(500).json({ error: 'Failed to create SimpleMDM group', details: groupResp });
    }
    
    console.log(`[Order] Created group "${cleanName}" (ID: ${groupId})`);
    
    // Step 2: Resolve serials to SimpleMDM device IDs and assign
    const results = [];
    const cleanSerials = serials
      .map(s => (s || '').trim().toUpperCase())
      .filter(Boolean);
    
    for (const serial of cleanSerials) {
      try {
        // Search for the device by serial
        const searchResp = await smdmRequest(apiKey, `/devices?search=${encodeURIComponent(serial)}`);
        const devices = searchResp?.data || [];
        
        // Find exact serial match
        const device = devices.find(d => 
          (d.attributes?.serial_number || '').toUpperCase() === serial
        );
        
        if (!device) {
          results.push({ serial, status: 'not_found', error: 'Device not enrolled in SimpleMDM' });
          continue;
        }
        
        // Assign device to the group
        const assignResp = await smdmRequest(
          apiKey, 
          `/assignment_groups/${groupId}/devices/${device.id}`,
          'POST'
        );
        
        results.push({
          serial,
          status: 'assigned',
          deviceId: device.id,
          deviceName: device.attributes?.name || ''
        });
        
        console.log(`[Order] Assigned ${serial} (device ${device.id}) to group ${groupId}`);
      } catch (err) {
        console.error(`[Order] Error processing serial ${serial}:`, err.message);
        results.push({ serial, status: 'error', error: err.message });
      }
    }
    
    const assigned = results.filter(r => r.status === 'assigned').length;
    const failed = results.filter(r => r.status !== 'assigned').length;
    
    console.log(`[Order] Complete: ${assigned} assigned, ${failed} failed`);
    
    res.json({
      success: true,
      groupId,
      orderName: cleanName,
      account,
      accountName: acct.name,
      results,
      summary: {
        total: cleanSerials.length,
        assigned,
        notFound: results.filter(r => r.status === 'not_found').length,
        errors: results.filter(r => r.status === 'error').length
      }
    });
    
  } catch (err) {
    console.error('[Order] Creation failed:', err);
    res.status(500).json({ error: `Order creation failed: ${err.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ██  FELLO CRM API ENDPOINTS                                         ██
// ═══════════════════════════════════════════════════════════════════════

// ── CRM Status ──────────────────────────────────────────────────────────
app.get('/api/crm/status', async (req, res) => {
  try {
    const health = await crmClient.healthCheck();
    res.json({
      configured: crmClient.isConfigured(),
      mockMode: crmClient.mockMode,
      ...health
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CRM Order Lookup ────────────────────────────────────────────────────
app.get('/api/crm/orders/:orderNumber', async (req, res) => {
  try {
    const order = await crmClient.getOrder(req.params.orderNumber);
    res.json(order);
  } catch (err) {
    const status = err instanceof CrmApiError ? (err.statusCode || 500) : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── CRM Order Devices ───────────────────────────────────────────────────
app.get('/api/crm/orders/:orderNumber/devices', async (req, res) => {
  try {
    const devices = await crmClient.getOrderDevices(req.params.orderNumber);
    res.json({ devices });
  } catch (err) {
    const status = err instanceof CrmApiError ? (err.statusCode || 500) : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── CRM Order Search ────────────────────────────────────────────────────
app.get('/api/crm/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (!query) return res.status(400).json({ error: 'Query parameter q is required' });
    const results = await crmClient.searchOrders(query);
    res.json({ results });
  } catch (err) {
    const status = err instanceof CrmApiError ? (err.statusCode || 500) : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── CRM Device Lookup ───────────────────────────────────────────────────
app.get('/api/crm/devices/:serial', async (req, res) => {
  try {
    const device = await crmClient.getDevice(req.params.serial);
    res.json(device);
  } catch (err) {
    const status = err instanceof CrmApiError ? (err.statusCode || 500) : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Usage Overview ──────────────────────────────────────────────────────
app.get('/api/webbing/usage/overview', async (req, res) => {
  try {
    const client = getWebbingClient();
    const { start, end } = req.query;
    const endDate = end || new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const countryUsage = await client.getCountryUsage(startDate, endDate);
    res.json({ countryUsage });
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Change Plan for single device ───────────────────────────────────────
app.post('/api/webbing/devices/:id/change-plan', async (req, res) => {
  try {
    const productId = req.body.productId;
    if (!productId) return res.status(400).json({ error: 'Missing productId' });
    const client = getWebbingClient();
    const result = await client.changePlan(parseInt(req.params.id), productId);
    setTimeout(() => syncWebbingDevices(false), 2000);
    res.json({ success: true, result });
  } catch (err) {
    res.status(err instanceof WebbingApiError ? 400 : 500).json({ error: err.message });
  }
});

// ── Bulk change plan for branch ─────────────────────────────────────────
app.post('/api/webbing/branches/:branchId/change-plan', async (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId);
    const productId = req.body.productId;
    if (!productId) return res.status(400).json({ error: 'Missing productId' });
    
    const devices = webbingDeviceCache.filter(d => d.BranchID === branchId);
    const client = getWebbingClient();
    const results = [];
    
    for (const d of devices) {
      try {
        const result = await client.changePlan(d.ServiceDeviceID, productId);
        results.push({ id: d.ServiceDeviceID, success: true });
      } catch (e) {
        results.push({ id: d.ServiceDeviceID, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }
    setTimeout(() => syncWebbingDevices(false), 2000);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk suspend branch devices ─────────────────────────────────────────
app.post('/api/webbing/branches/:branchId/suspend', async (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId);
    const devices = webbingDeviceCache.filter(d => d.BranchID === branchId && d.StatusID === 3);
    const client = getWebbingClient();
    const results = [];
    
    for (const d of devices) {
      try {
        await client.suspendDevice(d.ServiceDeviceID);
        results.push({ id: d.ServiceDeviceID, success: true });
      } catch (e) {
        results.push({ id: d.ServiceDeviceID, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }
    setTimeout(() => syncWebbingDevices(false), 2000);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk activate branch devices ────────────────────────────────────────
app.post('/api/webbing/branches/:branchId/activate', async (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId);
    const devices = webbingDeviceCache.filter(d => d.BranchID === branchId && d.StatusID === 4);
    const client = getWebbingClient();
    const results = [];
    
    for (const d of devices) {
      try {
        await client.activateDevice(d.ServiceDeviceID);
        results.push({ id: d.ServiceDeviceID, success: true });
      } catch (e) {
        results.push({ id: d.ServiceDeviceID, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }
    setTimeout(() => syncWebbingDevices(false), 2000);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get available plans ─────────────────────────────────────────────────
app.get('/api/webbing/plans/available', (req, res) => {
  const plans = [
    { productId: 11127, name: 'Fello Pay as You Go (US/VZ, Canada/TELUS, and Mexico)' },
    { productId: 11105, name: 'Fello Pay as You Go (US, Canada, and Mexico)' },
    { productId: 11125, name: 'Fello Pay as You Go (US/AT&T, Canada/BELL, and Mexico)' },
    { productId: 11128, name: 'Fello Pay as You Go (US/TMO, Canada/ROGERS, and Mexico)' }
  ];
  res.json({ plans });
});

// ── Webbing Branch Usage Report ─────────────────────────────────────────
app.get('/api/webbing/branches/:branchId/usage', async (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId);
    const { start, end, interval = 'Unknown', limit = 0 } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end dates are required (MM/dd/yyyy)' });
    }

    const devices = webbingDeviceCache.filter(d => d.BranchID === branchId);

    if (devices.length === 0) {
      return res.json({ totals: { totalUsage: 0, totalDevices: 0, devicesWithUsage: 0 }, results: [] });
    }
    
    const limitNum = parseInt(limit, 10);
    const devicesToProcess = limitNum > 0 ? devices.slice(0, limitNum) : devices;
    
    // Split date range into 31-day chunks (Webbing API max)
    const [sm, sd, sy] = start.split('/').map(Number);
    const [em, ed, ey] = end.split('/').map(Number);
    const startDt = new Date(sy, sm - 1, sd);
    const endDt = new Date(ey, em - 1, ed);
    const MAX_DAYS = 31;
    const dateChunks = [];
    let chunkStart = new Date(startDt);
    while (chunkStart < endDt) {
      let chunkEnd = new Date(chunkStart);
      chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS - 1);
      if (chunkEnd > endDt) chunkEnd = new Date(endDt);
      dateChunks.push({
        start: `${String(chunkStart.getMonth()+1).padStart(2,'0')}/${String(chunkStart.getDate()).padStart(2,'0')}/${chunkStart.getFullYear()}`,
        end: `${String(chunkEnd.getMonth()+1).padStart(2,'0')}/${String(chunkEnd.getDate()).padStart(2,'0')}/${chunkEnd.getFullYear()}`
      });
      chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() + 1);
    }
    if (dateChunks.length === 0) dateChunks.push({ start, end });
    console.log(`[Usage] Date range split into ${dateChunks.length} chunk(s) for ${devicesToProcess.length} devices`);
    
    const client = getWebbingClient();
    const results = [];
    let totalUsageMB = 0;
    let devicesWithUsage = 0;

    // Process devices in parallel batches to avoid Railway timeout
    const BATCH_SIZE = 20;
    
    async function fetchDeviceUsage(device) {
      try {
        let usageMB = 0;
        let usageDays = 0;
        
        for (const chunk of dateChunks) {
          try {
            const usageData = await client.getDeviceUsage(device.ServiceDeviceID, chunk.start, chunk.end, interval);
            let records = [];
            const usage = usageData?.Usage;
            if (usage && usage.DeviceUsageRecord) {
              records = Array.isArray(usage.DeviceUsageRecord) ? usage.DeviceUsageRecord : [usage.DeviceUsageRecord];
            }
            for (const r of records) {
              usageMB += parseFloat(r.TotalUsage || 0);
              usageDays += parseInt(r.TotalUsageDays || 0, 10);
            }
          } catch (chunkErr) {
            // Individual chunk errors are non-fatal
          }
        }
        
        return {
          SSID: device.SSID, Serial: device.Serial, IMEI: device.IMEI,
          ProductName: device.ProductName, TotalUsage: usageMB,
          TotalUsageDays: usageDays, ServiceDeviceID: device.ServiceDeviceID,
          StatusName: device.StatusName
        };
      } catch (err) {
        return {
          SSID: device.SSID, Serial: device.Serial, IMEI: device.IMEI,
          ProductName: device.ProductName, TotalUsage: 0,
          TotalUsageDays: 0, ServiceDeviceID: device.ServiceDeviceID,
          StatusName: device.StatusName
        };
      }
    }
    
    for (let i = 0; i < devicesToProcess.length; i += BATCH_SIZE) {
      const batch = devicesToProcess.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(d => fetchDeviceUsage(d)));
      results.push(...batchResults);
      for (const r of batchResults) {
        totalUsageMB += r.TotalUsage;
        if (r.TotalUsage > 0) devicesWithUsage++;
      }
    }

    results.sort((a, b) => b.TotalUsage - a.TotalUsage);

    res.json({
      totals: {
        totalUsage: totalUsageMB,
        totalDevices: devicesToProcess.length,
        devicesWithUsage: devicesWithUsage
      },
      results: results
    });
  } catch (error) {
    console.error('Error generating branch usage report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  AUTOMATED DATA OVERAGE REPORTS
// ══════════════════════════════════════════════════════════════════════

// GET /api/reports/overage?date=YYYY-MM-DD
// Default date = today → reports on orders that ended YESTERDAY
// The rental start→end dates are used as the usage query window
app.get('/api/reports/overage', async (req, res) => {
  try {
    const reportDate = req.query.date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const targetEnd = reportDate;
    
    console.log('[OverageReport] Looking for orders ending: ' + targetEnd);

    const imsToken = process.env.IMS_TOKEN || '2423|rydhEvIv6ZsEABia67jH5ffhMUJLthtu3YrfySpx93f5cc0e';
    const imsBase = process.env.IMS_BASE_URL || 'https://ims-v4-migration-prod-876702752852.us-east4.run.app';
    
    // Step 1: Gather candidate orders from BOTH /api/orders AND Webbing branches
    const endingOrders = [];
    const seenOrderIds = new Set();
    
    // Source A: /api/orders list (FE, OR, GSO, JP prefixes)
    try {
      const ordersResp = await fetch(imsBase + '/api/orders', {
        headers: { 'Authorization': 'Bearer ' + imsToken }
      });
      if (ordersResp.ok) {
        const allOrders = await ordersResp.json();
        for (const o of allOrders) {
          const endDate = o.shipments_max_rental_end || o.end_date;
          if (endDate === targetEnd && !seenOrderIds.has(o.fly_order_id)) {
            seenOrderIds.add(o.fly_order_id);
            endingOrders.push({
              fly_order_id: o.fly_order_id,
              customer_name: o.customer_name || '',
              status: o.status || '',
              rentalStart: o.shipments_min_rental_start || o.start_date || '',
              rentalEnd: endDate,
              total_gb_amount: parseFloat(o.total_gb_amount || 0)
            });
          }
        }
      }
    } catch (e) {
      console.log('[OverageReport] /api/orders fetch failed: ' + e.message);
    }
    
    // Source B: Webbing branches → look up each in NextGen for dates
    // Webbing branch names match order IDs (e.g. "LE2103", "SQ15188")
    const client = getWebbingClient();
    try {
      // Get all branch names from cache
      const branchNames = new Set();
      for (const d of webbingDeviceCache) {
        if (d.BranchName) branchNames.add(d.BranchName.toUpperCase());
      }
      
      // For each branch not already found, look up in NextGen
      const branchesToCheck = [...branchNames].filter(bn => !seenOrderIds.has(bn));
      console.log('[OverageReport] Checking ' + branchesToCheck.length + ' Webbing branches against NextGen');
      
      // Process in batches of 20 to avoid overloading
      const BATCH = 20;
      for (let i = 0; i < branchesToCheck.length; i += BATCH) {
        const batch = branchesToCheck.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async function(branchName) {
          try {
            const resp = await fetch(imsBase + '/api/nextgen/v1/orders/' + branchName, {
              headers: { 'Authorization': 'Bearer ' + imsToken }
            });
            if (resp.ok) {
              const detail = await resp.json();
              // Determine end date: check multiple fields
              let endDate = detail.shipments_max_rental_end || detail.end_date || null;
              // Also check rental-level dates if order-level is empty
              if ((!endDate || endDate === '0000-00-00') && detail.rentals && detail.rentals.length > 0) {
                const rentalEnds = detail.rentals
                  .map(r => r.end_time || r.end_date || '')
                  .filter(d => d && d !== '0000-00-00')
                  .sort();
                if (rentalEnds.length > 0) endDate = rentalEnds[rentalEnds.length - 1]; // latest
              }
              
              let startDate = detail.shipments_min_rental_start || detail.start_date || null;
              if ((!startDate || startDate === '0000-00-00') && detail.rentals && detail.rentals.length > 0) {
                const rentalStarts = detail.rentals
                  .map(r => r.start_time || r.start_date || '')
                  .filter(d => d && d !== '0000-00-00')
                  .sort();
                if (rentalStarts.length > 0) startDate = rentalStarts[0]; // earliest
              }
              
              if (endDate === targetEnd) {
                return {
                  fly_order_id: detail.fly_order_id || branchName,
                  customer_name: detail.customer_name || '',
                  status: detail.status || '',
                  rentalStart: startDate || '',
                  rentalEnd: endDate,
                  total_gb_amount: parseFloat(detail.total_gb_amount || 0)
                };
              }
            }
          } catch (e) { /* skip */ }
          return null;
        }));
        
        for (const r of results) {
          if (r && !seenOrderIds.has(r.fly_order_id)) {
            seenOrderIds.add(r.fly_order_id);
            endingOrders.push(r);
          }
        }
      }
    } catch (e) {
      console.log('[OverageReport] Webbing branch check failed: ' + e.message);
    }
    
    console.log('[OverageReport] Found ' + endingOrders.length + ' orders ending on ' + targetEnd);
    
    if (endingOrders.length === 0) {
      return res.json({
        reportDate: reportDate,
        targetEndDate: targetEnd,
        orders: [],
        message: 'No orders ended on ' + targetEnd
      });
    }

    // Step 2: For each order, get branch usage from Webbing
    const orderReports = [];

    for (const order of endingOrders) {
      const flyId = order.fly_order_id;
      const rentalStart = order.rentalStart;
      const rentalEnd = order.rentalEnd;
      const totalGbAllocation = order.total_gb_amount;

      // Get full order details from NextGen
      let orderDetail = null;
      try {
        const detailResp = await fetch(imsBase + '/api/nextgen/v1/orders/' + flyId, {
          headers: { 'Authorization': 'Bearer ' + imsToken }
        });
        if (detailResp.ok) {
          orderDetail = await detailResp.json();
        }
      } catch (e) {
        console.log('[OverageReport] Could not fetch order detail for ' + flyId + ': ' + e.message);
      }

      // Find Webbing branch for this order
      const branchName = flyId.toUpperCase();
      let branchDevices = webbingDeviceCache.filter(function(d) {
        return d.BranchName && d.BranchName.toUpperCase() === branchName;
      });
      let branchId = branchDevices.length > 0 ? branchDevices[0].BranchID : null;

      // If not in cache, try searching Webbing API
      if (branchDevices.length === 0) {
        try {
          const searchResult = await client.searchBranches(flyId, 1, 100);
          const branchesContainer = searchResult.Branches || {};
          let branchRecords = branchesContainer.BranchRecord || [];
          if (!Array.isArray(branchRecords)) branchRecords = branchRecords ? [branchRecords] : [];
          
          const foundBranch = branchRecords.find(function(b) {
            return (b.BranchName || b.Name || '').toUpperCase() === branchName;
          }) || (branchRecords.length === 1 ? branchRecords[0] : null);
          
          if (foundBranch) {
            branchId = foundBranch.BranchID || foundBranch.ID;
            const devResult = await client.getServiceDevices({ branchId: branchId, pageSize: 500 });
            let devRecords = devResult.ServiceDevices?.ServiceDeviceRecord || devResult.ServiceDevices || [];
            if (!Array.isArray(devRecords)) devRecords = devRecords ? [devRecords] : [];
            branchDevices = devRecords;
          }
        } catch (e) {
          console.log('[OverageReport] Webbing branch search failed for ' + flyId + ': ' + e.message);
        }
      }

      // Skip orders with no SIM devices
      if (branchDevices.length === 0) {
        orderReports.push({
          flyOrderId: flyId,
          customerName: order.customer_name || '',
          status: order.status || '',
          rentalStart: rentalStart,
          rentalEnd: rentalEnd,
          totalGbAllocation: totalGbAllocation,
          branchId: null,
          totalDevices: 0,
          totalUsageMB: 0,
          totalUsageGB: 0,
          overageGB: 0,
          devices: [],
          error: 'No Webbing branch found for this order'
        });
        continue;
      }

      // Convert rental dates to Webbing format (MM/dd/yyyy)
      let startStr = rentalStart;
      let endStr = rentalEnd;
      if (rentalStart && rentalStart.includes('-')) {
        const [sy, sm, sd] = rentalStart.split('-');
        startStr = sm + '/' + sd + '/' + sy;
      }
      if (rentalEnd && rentalEnd.includes('-')) {
        const [ey, em, ed] = rentalEnd.split('-');
        endStr = em + '/' + ed + '/' + ey;
      }

      // Split into 31-day chunks (Webbing max)
      const [sm2, sd2, sy2] = startStr.split('/').map(Number);
      const [em2, ed2, ey2] = endStr.split('/').map(Number);
      const startDt = new Date(sy2, sm2 - 1, sd2);
      const endDt = new Date(ey2, em2 - 1, ed2);
      const dateChunks = [];
      let chunkStart = new Date(startDt);
      while (chunkStart < endDt) {
        let chunkEnd = new Date(chunkStart);
        chunkEnd.setDate(chunkEnd.getDate() + 30);
        if (chunkEnd > endDt) chunkEnd = new Date(endDt);
        dateChunks.push({
          start: String(chunkStart.getMonth()+1).padStart(2,'0') + '/' + String(chunkStart.getDate()).padStart(2,'0') + '/' + chunkStart.getFullYear(),
          end: String(chunkEnd.getMonth()+1).padStart(2,'0') + '/' + String(chunkEnd.getDate()).padStart(2,'0') + '/' + chunkEnd.getFullYear()
        });
        chunkStart = new Date(chunkEnd);
        chunkStart.setDate(chunkStart.getDate() + 1);
      }
      if (dateChunks.length === 0) dateChunks.push({ start: startStr, end: endStr });

      // Fetch usage for each device
      const deviceResults = [];
      let totalUsageMB = 0;
      const BATCH_SIZE = 15;

      async function fetchDeviceUsage(device) {
        let usageMB = 0;
        let usageDays = 0;
        for (const chunk of dateChunks) {
          try {
            const usageData = await client.getDeviceUsage(device.ServiceDeviceID, chunk.start, chunk.end, 'Unknown');
            const usage = usageData?.Usage;
            if (usage && usage.DeviceUsageRecord) {
              const records = Array.isArray(usage.DeviceUsageRecord) ? usage.DeviceUsageRecord : [usage.DeviceUsageRecord];
              for (const r of records) {
                usageMB += parseFloat(r.TotalUsage || 0);
                usageDays += parseInt(r.TotalUsageDays || 0, 10);
              }
            }
          } catch (e) { /* skip chunk errors */ }
        }
        return {
          ssid: device.SSID || device.Serial || '',
          serial: device.Serial || '',
          imei: String(device.IMEI || ''),
          iccid: device.ICCID || '',
          plan: device.ProductName || '',
          status: device.StatusName || '',
          usageMB: Math.round(usageMB * 100) / 100,
          usageGB: Math.round((usageMB / 1024) * 1000) / 1000,
          usageDays: usageDays
        };
      }

      for (let i = 0; i < branchDevices.length; i += BATCH_SIZE) {
        const batch = branchDevices.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(function(d) { return fetchDeviceUsage(d); }));
        deviceResults.push(...batchResults);
        for (const r of batchResults) { totalUsageMB += r.usageMB; }
      }

      deviceResults.sort(function(a, b) { return b.usageMB - a.usageMB; });

      const totalUsageGB = Math.round((totalUsageMB / 1024) * 1000) / 1000;
      const overageGB = totalGbAllocation > 0 ? Math.max(0, Math.round((totalUsageGB - totalGbAllocation) * 1000) / 1000) : 0;

      orderReports.push({
        flyOrderId: flyId,
        customerName: order.customer_name || '',
        status: order.status || '',
        rentalStart: rentalStart,
        rentalEnd: rentalEnd,
        totalGbAllocation: totalGbAllocation,
        branchId: branchId,
        totalDevices: branchDevices.length,
        devicesWithUsage: deviceResults.filter(function(d) { return d.usageMB > 0; }).length,
        totalUsageMB: Math.round(totalUsageMB * 100) / 100,
        totalUsageGB: totalUsageGB,
        overageGB: overageGB,
        usagePercent: totalGbAllocation > 0 ? Math.round((totalUsageGB / totalGbAllocation) * 1000) / 10 : null,
        devices: deviceResults
      });

      console.log('[OverageReport] ' + flyId + ': ' + totalUsageGB + ' GB used / ' + totalGbAllocation + ' GB allocated (' + deviceResults.length + ' devices)');
    }

    res.json({
      reportDate: reportDate,
      targetEndDate: targetEnd,
      generatedAt: new Date().toISOString(),
      orderCount: orderReports.length,
      orders: orderReports
    });

  } catch (error) {
    console.error('[OverageReport] Error:', error);
    res.status(500).json({ error: 'Failed to generate overage report: ' + error.message });
  }
});

// ── Webbing to SimpleMDM Match ───────────────────────────────────────
app.get('/api/webbing/branches/:branchId/match', async (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId, 10);
    const devices = (webbingDeviceCache || []).filter(d => d.BranchID === branchId);
    
    if (!devices.length) {
      return res.status(404).json({ error: 'No devices found for this branch in cache' });
    }
    
    const branchName = devices[0].BranchName;
    const webbingMatches = [];
    const client = getWebbingClient();
    
    // Fetch live data for each device to get IMEI
    for (const d of devices) {
      try {
        const liveResult = await client.getLiveData(d.ServiceDeviceID);
        // The parsed response has fields directly on the result object
        const imei = liveResult.IMEI ? String(liveResult.IMEI) : null;
        const iccid = liveResult.ICCID ? String(liveResult.ICCID) : null;
        webbingMatches.push({
          serviceDeviceId: d.ServiceDeviceID,
          serial: d.Serial,
          imei,
          iccid,
          ssid: d.SSID,
          status: d.StatusName,
          plan: d.ProductName,
          carrier: liveResult.VPLMN || liveResult.CarrierName || null,
          ip: liveResult.IP || null
        });
      } catch (err) {
        console.error(`Failed to get live data for ${d.ServiceDeviceID}:`, err.message);
        webbingMatches.push({
          serviceDeviceId: d.ServiceDeviceID,
          serial: d.Serial,
          imei: null,
          iccid: null,
          ssid: d.SSID,
          status: d.StatusName,
          plan: d.ProductName,
          carrier: null,
          ip: null
        });
      }
      await new Promise(r => setTimeout(r, 150));
    }
    
    // Step 2: Find SimpleMDM iPads by device name prefix
    const mdmKey = getSimpleMdmKey();
    const auth = 'Basic ' + Buffer.from(mdmKey + ':').toString('base64');
    
    const branchPrefix = branchName.toLowerCase();
    const simpleMdmDevices = [];
    let hasMore = true;
    let startingAfter = '';
    let totalFetched = 0;
    
    while (hasMore) {
      const url = `https://a.simplemdm.com/api/v1/devices?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
      const devResp = await fetch(url, { headers: { 'Authorization': auth } });
      if (!devResp.ok) {
        console.error(`[Match] SimpleMDM devices fetch failed: ${devResp.status}`);
        break;
      }
      const devData = await devResp.json();
      const items = devData.data || [];
      totalFetched += items.length;
      
      for (const d of items) {
        const attr = d.attributes || {};
        const name = (attr.name || '').trim();
        if (name.toLowerCase().startsWith(branchPrefix)) {
          simpleMdmDevices.push({
            id: d.id,
            name: name,
            serial: attr.serial_number,
            model: attr.model_name,
            osVersion: attr.os_version,
            batteryLevel: attr.battery_level,
            lastSeenAt: attr.last_seen_at,
            // List endpoint may have ICCID/IMEI directly
            iccid: attr.iccid || null,
            imei: attr.imei || null
          });
        }
      }
      
      hasMore = devData.has_more === true;
      startingAfter = items.length > 0 ? items[items.length - 1].id : '';
      if (!startingAfter) break;
    }
    
    console.log(`[Match] Scanned ${totalFetched} SimpleMDM devices, found ${simpleMdmDevices.length} matching "${branchName}"`);
    
    // Sort MDM devices by the number in parentheses: "FE13916 (1)" → 1
    simpleMdmDevices.sort((a, b) => {
      const numA = parseInt((a.name.match(/\((\d+)\)/) || [])[1]) || 0;
      const numB = parseInt((b.name.match(/\((\d+)\)/) || [])[1]) || 0;
      return numA - numB;
    });
    
    // NOTE: SimpleMDM API does NOT expose eSIM ICCID/IMEI (confirmed null).
    // 1:1 matching is not possible via API. Return side-by-side inventory.
    const countMatch = simpleMdmDevices.length === webbingMatches.length;
    
    res.json({
      branchName: branchName,
      webbingDevices: webbingMatches,
      simpleMdmDevices: simpleMdmDevices,
      stats: {
        webbingCount: webbingMatches.length,
        mdmCount: simpleMdmDevices.length,
        countMatch: countMatch,
        totalScanned: totalFetched
      }
    });
    
  } catch (error) {
    console.error('Match endpoint error:', error);
    res.status(500).json({ error: 'Failed to perform match' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  ABM IMEI BRIDGE — uses getAbmToken() from top of file
// ══════════════════════════════════════════════════════════════════════════

// Fetch all devices from ABM orgDevices endpoint (with correct JSON:API pagination)
async function getAbmDeviceList() {
  const token = await getAbmToken();
  const devices = [];
  let nextUrl = `${ABM_CONFIG.apiBase}/orgDevices?limit=1000`;
  
  while (nextUrl) {
    const resp = await fetch(nextUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[ABM] orgDevices error:', resp.status, err);
      throw new Error(`ABM orgDevices failed: ${resp.status}`);
    }
    
    const json = await resp.json();
    const items = json.data || [];
    devices.push(...items);
    
    // JSON:API pagination: links.next contains the full URL for next page
    nextUrl = json.links?.next || null;
    console.log(`[ABM] Fetched page: ${items.length} devices (total: ${devices.length}), hasMore: ${!!nextUrl}`);
  }
  
  console.log(`[ABM] Fetched ${devices.length} total devices from orgDevices`);
  return devices;
}

// Cache the IMEI map to avoid refetching on every lookup request
let abmImeiMapCache = { map: null, reverseMap: null, fetchedAt: 0, deviceCount: 0 };
const ABM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Build serial→IMEI map from ABM devices (with cache)
async function buildAbmImeiMap() {
  // Return cached if fresh
  if (abmImeiMapCache.map && Date.now() - abmImeiMapCache.fetchedAt < ABM_CACHE_TTL) {
    console.log(`[ABM] Using cached IMEI map (${abmImeiMapCache.map.size} devices, age: ${Math.round((Date.now() - abmImeiMapCache.fetchedAt)/1000)}s)`);
    return { serialToImei: abmImeiMapCache.map, imeiToSerial: abmImeiMapCache.reverseMap };
  }
  
  const devices = await getAbmDeviceList();
  const serialToImei = new Map();
  const imeiToSerial = new Map();
  
  for (const d of devices) {
    const attr = d.attributes || d;
    const serial = (attr.serialNumber || attr.serial_number || d.id || '').toUpperCase();
    const imeis = attr.imei || attr.IMEI || [];
    const imeiList = Array.isArray(imeis) ? imeis : [imeis];
    const eid = attr.eid || '';
    const model = attr.deviceModel || attr.model || '';
    
    if (serial && imeiList.length > 0) {
      const primaryImei = String(imeiList[0]).replace(/\s/g, '');
      if (!primaryImei) continue;
      
      serialToImei.set(serial, {
        imei: primaryImei,
        allImeis: imeiList.map(i => String(i).replace(/\s/g, '')),
        eid: eid || null,
        model: model
      });
      
      for (const imei of imeiList) {
        const cleanImei = String(imei).replace(/\s/g, '');
        if (cleanImei) imeiToSerial.set(cleanImei, serial);
      }
    }
  }
  
  // Cache it
  abmImeiMapCache = { map: serialToImei, reverseMap: imeiToSerial, fetchedAt: Date.now(), deviceCount: devices.length };
  console.log(`[ABM] Built IMEI map: ${serialToImei.size} devices with IMEI out of ${devices.length} total`);
  return { serialToImei, imeiToSerial };
}

// ── Debug: Test ABM API connection ────────────────────────────────────
app.get('/api/debug/abm-devices', async (req, res) => {
  try {
    if (!abmPrivateKey) {
      return res.json({ error: 'ABM private key not loaded.' });
    }
    
    const token = await getAbmToken();
    
    // If serial param provided, do a single device lookup
    const serial = req.query.serial;
    if (serial) {
      const resp = await fetch(`${ABM_CONFIG.apiBase}/orgDevices/${serial}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = resp.ok ? await resp.json() : { error: resp.status, body: await resp.text() };
      return res.json({ singleDeviceLookup: serial, data });
    }
    
    // Otherwise list devices (return raw response to see pagination format)
    const limit = parseInt(req.query.limit) || 5;
    const url = `${ABM_CONFIG.apiBase}/orgDevices?limit=${limit}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      return res.json({ error: `ABM API error: ${resp.status}`, details: err });
    }
    
    // Return the ENTIRE raw response to see pagination format
    const rawData = await resp.json();
    const topLevelKeys = Object.keys(rawData);
    
    res.json({
      status: 'connected',
      topLevelKeys,
      rawData
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
  }
});


app.get('/api/debug/dep-devices', async (req, res) => {
  try {
    const accountId = req.query.account || req.body?.account || 'fello';
    const mdmKey = getMdmAccountKey(accountId);
    const auth = 'Basic ' + Buffer.from(mdmKey + ':').toString('base64');
    const depServerId = MDM_ACCOUNTS[accountId]?.depServerId || '10650';
    const limit = parseInt(req.query.limit) || 5;
    
    const url = `https://a.simplemdm.com/api/v1/dep_servers/${depServerId}/dep_devices?limit=${limit}`;
    const resp = await fetch(url, { headers: { 'Authorization': auth } });
    if (!resp.ok) return res.status(resp.status).json({ error: `DEP fetch failed: ${resp.status}` });
    
    const data = await resp.json();
    const items = data.data || [];
    
    // Extract and log all attribute keys from the first device
    const sampleAttrs = items.length > 0 ? Object.keys(items[0].attributes || {}) : [];
    
    // Return raw data so we can see all fields
    res.json({
      count: items.length,
      hasMore: data.has_more,
      sampleAttributeKeys: sampleAttrs,
      devices: items.map(d => ({
        id: d.id,
        type: d.type,
        attributes: d.attributes
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  UNIFIED LOOKUP HUB
// ══════════════════════════════════════════════════════════════════════════


app.get('/api/lookup', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing search query (q)' });
  
  console.log(`[Lookup] Search: "${query}"`);
  
  // Detect search type: MDM account name | ICCID (19-20 digits) | IMEI (15 digits) | group/branch | device serial
  const isICCID = /^\d{19,20}$/.test(query);
  const isIMEI = /^\d{15}$/.test(query);
  
  // Check if query matches an MDM account name (e.g. "Alamo Fireworks")
  const mdmAccountMatch = !isICCID && !isIMEI ? Object.entries(MDM_ACCOUNTS).find(([id, acct]) => 
    acct.name.toLowerCase() === query.toLowerCase() && acct.getKey()
  ) : null;
  
  // Try IMS NextGen CRM lookup for order numbers
  let crmOrder = null;
  if (!isICCID && !isIMEI && !mdmAccountMatch && crmClient.isConfigured()) {
    try {
      const crmResult = await crmClient.getOrder(query);
      if (crmResult && crmResult.flyOrderId) {
        crmOrder = crmResult;
        console.log(`[Lookup] CRM order found: ${crmResult.flyOrderId} — ${crmResult.customerName} (${crmResult.rentalCount} line items)`);
      }
    } catch (crmErr) {
      // CRM not available or order not found — fall through to prefix search
      console.log(`[Lookup] CRM lookup failed for "${query}": ${crmErr.message}`);
    }
  }
  
  // Try fetching Starlink fleet data (only if order has Starlink line items)
  let starlinkFleet = null;
  const hasStarlinkRentals = crmOrder && crmOrder.rentals && crmOrder.rentals.some(function(r) {
    return r.modelName && r.modelName.toLowerCase().includes('starlink');
  });
  if (!isICCID && !isIMEI && hasStarlinkRentals) {
   try {
      const slToken = await getStarlinkServerToken();
      if (slToken) {
        const slResp = await fetch('https://starlink.com/api/public/v2/user-terminals', {
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + slToken }
        });
        if (slResp.ok) {
          const slData = await slResp.json();
          const termResults = slData.content?.results || slData.results || [];
          let allTerminals = termResults.map(t => ({
            userTerminalId: t.userTerminalId || t.id || '',
            kitSerialNumber: t.kitSerialNumber || '',
            dishSerialNumber: t.dishSerialNumber || '',
            serviceLineNumber: t.serviceLineNumber || '',
            nickname: t.nickname || t.userTerminalId || '',
            active: t.active !== false,
            hardwareVersion: t.hardwareVersion || '',
            softwareVersion: t.softwareVersion || '',
            routerId: t.routerId || ''
          }));

          // If we have a CRM order, filter terminals by matching barcode nicknames
          // Terminal nicknames are Fello barcodes (e.g., I00912518) 
          // IMS part numbers are prefixes (e.g., I009 for Starlink Receiver)
          let matchedTerminals = [];
          let matchedByOrder = false;
          if (crmOrder && crmOrder.rentals && crmOrder.rentals.length > 0) {
            const slPartNumbers = crmOrder.rentals
              .filter(r => r.modelName && r.modelName.toLowerCase().includes('starlink') && r.partNumber)
              .map(r => r.partNumber.toUpperCase());
            
            if (slPartNumbers.length > 0) {
              matchedTerminals = allTerminals.filter(t => {
                const nick = (t.nickname || '').toUpperCase();
                return slPartNumbers.some(pn => nick.startsWith(pn));
              });
              matchedByOrder = matchedTerminals.length > 0;
              console.log('[Lookup] Starlink: Matched ' + matchedTerminals.length + '/' + allTerminals.length + ' terminals by barcode prefix (' + slPartNumbers.join(', ') + ')');
            }
          }

          starlinkFleet = {
            terminals: matchedByOrder ? matchedTerminals : allTerminals,
            allTerminals: allTerminals,
            configured: true,
            filteredByOrder: matchedByOrder,
            totalCount: allTerminals.length
          };
          console.log('[Lookup] Starlink: showing ' + starlinkFleet.terminals.length + ' of ' + allTerminals.length + ' terminals');
        }
      }
    } catch (slErr) {
      console.log('[Lookup] Starlink fleet fetch failed:', slErr.message);
    }
  }

  const isGroupSearch = !isICCID && !isIMEI && !mdmAccountMatch && (
    /^(FE|SQ|EB|CB|MO|Z5|SH|LE|AR|OR|RS|MEAL|CAMO|CASQ|ALA)/i.test(query) || 
    (query.length >= 4 && /^\d+$/.test(query))
  );
  
  try {
    if (mdmAccountMatch) {
      // ── MDM ACCOUNT SEARCH ─────────────────────────────────────
      const [mdmAcctId, mdmAcct] = mdmAccountMatch;
      const mdmKey = mdmAcct.getKey();
      console.log(`[Lookup] MDM Account search: "${mdmAcct.name}" (${mdmAcctId})`);
      
      // Fetch ALL devices from this SimpleMDM account
      const simpleMdmDevices = [];
      const auth = 'Basic ' + Buffer.from(mdmKey + ':').toString('base64');
      let hasMore = true;
      let startingAfter = '';
      
      while (hasMore) {
        const url = `https://a.simplemdm.com/api/v1/devices?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
        const devResp = await fetch(url, { headers: { 'Authorization': auth } });
        if (!devResp.ok) break;
        const devData = await devResp.json();
        const items = devData.data || [];
        
        for (const d of items) {
          const attr = d.attributes || {};
          // Extract ICCID/IMEI from service_subscriptions (eSIM data)
          const subs = attr.service_subscriptions || [];
          const primarySub = Array.isArray(subs) && subs.length > 0 ? subs[0] : {};
          const subIccid = (primarySub.iccid || '').replace(/\s/g, '');
          const subImei = (primarySub.imei || '').replace(/\s/g, '');
          const subEid = (primarySub.eid || '').replace(/\s/g, '');
          
          simpleMdmDevices.push({
            id: d.id, name: (attr.name || '').trim(), serial: attr.serial_number,
            model: attr.model_name, osVersion: attr.os_version,
            batteryLevel: attr.battery_level, lastSeenAt: attr.last_seen_at,
            phoneNumber: attr.phone_number || primarySub.phone_number || null,
            wifiMac: attr.wifi_mac || null,
            imei: subImei || attr.imei || null,
            iccid: subIccid || attr.iccid || null,
            eid: subEid || null,
            carrier: primarySub.current_carrier_network || null,
            capacity: attr.device_capacity || null,
            enrolledAt: attr.enrolled_at || null,
            deviceGroupId: attr.device_group_id || null,
            mdmAccount: mdmAcctId,
            mdmAccountName: mdmAcct.name,
            barcode: ''
          });
        }
        hasMore = devData.has_more === true;
        startingAfter = items.length > 0 ? items[items.length - 1].id : '';
        if (!startingAfter) break;
      }
      
      simpleMdmDevices.sort((a, b) => {
        const numA = parseInt((a.name.match(/(\d+)/) || [])[1]) || 0;
        const numB = parseInt((b.name.match(/(\d+)/) || [])[1]) || 0;
        return a.name.localeCompare(b.name) || numA - numB;
      });
      
      console.log(`[Lookup] Found ${simpleMdmDevices.length} devices in ${mdmAcct.name} account`);
      
      // Load Webbing SIMs from linked branch (if configured)
      const webbingDevices = [];
      const matches = [];
      let abmStatus = 'not_configured';
      let branchId = null;
      
      if (mdmAcct.webbingBranch) {
        const branchName = mdmAcct.webbingBranch.toUpperCase();
        const branchDevs = webbingDeviceCache.filter(d =>
          d.BranchName && d.BranchName.toUpperCase() === branchName
        );
        branchId = branchDevs.length > 0 ? branchDevs[0].BranchID : null;
        
        for (const d of branchDevs) {
          webbingDevices.push({
            serviceDeviceId: d.ServiceDeviceID,
            serial: d.Serial || d.SSID,
            ssid: d.SSID,
            iccid: d.ICCID,
            imei: String(d.IMEI || ''),
            msisdn: d.MSISDN,
            status: d.StatusName,
            statusId: d.StatusID,
            plan: d.ProductName,
            productName: d.ProductName,
            branch: d.BranchName,
            branchName: d.BranchName,
            branchId: d.BranchID,
            ip: d.IP || '',
            model: d.Model || '',
            vendor: d.Vendor || '',
            deviceType: d.DeviceTypeName,
            statusDate: d.StatusDateChange
          });
        }
        console.log(`[Lookup] Loaded ${webbingDevices.length} Webbing SIMs from branch ${mdmAcct.webbingBranch}`);
      }
      
      // Pass 1: Direct ICCID matching (eSIM devices have ICCID in service_subscriptions)
      // First search branch SIMs, then fallback to entire Webbing cache
      for (const ipad of simpleMdmDevices) {
        if (!ipad.iccid) continue;
        const mdmIccid = ipad.iccid.replace(/\s/g, '');
        
        // Try branch SIMs first
        let matchedSim = webbingDevices.find(sim => {
          const simIccid = (sim.iccid || '').replace(/\s/g, '');
          return simIccid && simIccid === mdmIccid && !sim.matchedIpadName;
        });
        
        // Fallback: search entire Webbing cache
        if (!matchedSim) {
          const rawMatch = webbingDeviceCache.find(d => {
            const simIccid = (d.ICCID || '').replace(/\s/g, '');
            return simIccid && simIccid === mdmIccid;
          });
          if (rawMatch) {
            // Add to webbingDevices list (normalized)
            matchedSim = {
              serviceDeviceId: rawMatch.ServiceDeviceID,
              serial: rawMatch.Serial || rawMatch.SSID,
              ssid: rawMatch.SSID,
              iccid: rawMatch.ICCID,
              imei: String(rawMatch.IMEI || ''),
              msisdn: rawMatch.MSISDN,
              status: rawMatch.StatusName,
              statusId: rawMatch.StatusID,
              plan: rawMatch.ProductName,
              productName: rawMatch.ProductName,
              branch: rawMatch.BranchName,
              branchName: rawMatch.BranchName,
              branchId: rawMatch.BranchID,
              ip: rawMatch.IP || '',
              model: rawMatch.Model || '',
              vendor: rawMatch.Vendor || '',
              deviceType: rawMatch.DeviceTypeName,
              statusDate: rawMatch.StatusDateChange
            };
            if (!webbingDevices.find(w => w.serviceDeviceId === matchedSim.serviceDeviceId)) {
              webbingDevices.push(matchedSim);
            }
          }
        }
        
        if (matchedSim && !matchedSim.matchedIpadName) {
          matches.push({
            ipadName: ipad.name,
            ipadSerial: ipad.serial,
            ipadImei: ipad.imei || '',
            simSerial: matchedSim.serial,
            simImei: matchedSim.imei || '',
            simIccid: matchedSim.iccid,
            simCarrier: matchedSim.carrier || ipad.carrier || '',
            simStatus: matchedSim.status,
            simIp: matchedSim.ip || ''
          });
          ipad.matchedSimSerial = matchedSim.serial;
          matchedSim.matchedIpadName = ipad.name;
          matchedSim.matchedIpadSerial = ipad.serial;
          ipad.abmLookupStatus = 'iccid-matched';
        }
      }
      console.log(`[Lookup] ICCID matching: ${matches.length} pairs (branch + full cache)`);

      
      // Pass 2: ABM IMEI matching (for remaining unmatched devices)
      try {
        const unmatchedIpads = simpleMdmDevices.filter(d => !d.matchedSimSerial);
        if (abmPrivateKey && unmatchedIpads.length > 0) {
          const { serialToImei, imeiToSerial } = await buildAbmImeiMap();
          abmStatus = 'connected';
          
          for (const ipad of unmatchedIpads) {
            const serial = (ipad.serial || '').toUpperCase();
            if (!serial) { ipad.abmLookupStatus = ipad.abmLookupStatus || 'no-serial'; continue; }
            
            const abmData = serialToImei.get(serial);
            if (!abmData) { ipad.abmLookupStatus = 'not-in-abm'; continue; }
            
            ipad.abmImei = abmData.imei;
            ipad.allImeis = abmData.allImeis;
            ipad.abmEid = abmData.eid || null;
            
            // Find matching Webbing SIM by IMEI
            // If branch SIMs were pre-loaded, search those; otherwise search entire cache
            const searchPool = webbingDevices.length > 0 ? webbingDevices : null;
            let matchedSim = null;
            
            if (searchPool) {
              // Match against pre-loaded branch SIMs (already normalized)
              matchedSim = searchPool.find(sim => {
                const simImei = sim.imei || '';
                return simImei && abmData.allImeis.some(abmImei => 
                  simImei === abmImei || simImei.includes(abmImei) || abmImei.includes(simImei)
                );
              });
            } else {
              // Fallback: search entire Webbing cache (raw field names)
              const rawMatch = webbingDeviceCache.find(sim => {
                const simImei = sim.IMEI ? String(sim.IMEI) : '';
                return simImei && abmData.allImeis.some(abmImei => 
                  simImei === abmImei || simImei.includes(abmImei) || abmImei.includes(simImei)
                );
              });
              if (rawMatch) matchedSim = rawMatch;
            }
            
            if (matchedSim) {
              ipad.abmLookupStatus = 'matched';
              const simDevice = {
                serviceDeviceId: matchedSim.serviceDeviceId || matchedSim.ServiceDeviceID,
                serial: matchedSim.serial || matchedSim.Serial || matchedSim.ssid || matchedSim.SSID,
                ssid: matchedSim.ssid || matchedSim.SSID,
                iccid: matchedSim.iccid || matchedSim.ICCID,
                imei: String(matchedSim.imei || matchedSim.IMEI || ''),
                msisdn: matchedSim.msisdn || matchedSim.MSISDN,
                status: matchedSim.status || matchedSim.StatusName,
                statusId: matchedSim.statusId || matchedSim.StatusID,
                plan: matchedSim.plan || matchedSim.ProductName,
                productName: matchedSim.productName || matchedSim.ProductName,
                branch: matchedSim.branch || matchedSim.BranchName,
                branchName: matchedSim.branchName || matchedSim.BranchName,
                branchId: matchedSim.branchId || matchedSim.BranchID,
                ip: matchedSim.ip || matchedSim.IP || '',
                model: matchedSim.model || matchedSim.Model || '',
                vendor: matchedSim.vendor || matchedSim.Vendor || '',
                deviceType: matchedSim.deviceType || matchedSim.DeviceTypeName,
                statusDate: matchedSim.statusDate || matchedSim.StatusDateChange
              };
              
              if (!webbingDevices.find(w => w.serviceDeviceId === simDevice.serviceDeviceId)) {
                webbingDevices.push(simDevice);
              }
              
              matches.push({
                ipadName: ipad.name,
                ipadSerial: ipad.serial,
                ipadImei: abmData.imei,
                simSerial: simDevice.serial,
                simImei: simDevice.imei,
                simIccid: simDevice.iccid,
                simCarrier: simDevice.carrier,
                simStatus: simDevice.status,
                simIp: simDevice.ip
              });
              ipad.matchedSimSerial = simDevice.serial;
              simDevice.matchedIpadName = ipad.name;
              simDevice.matchedIpadSerial = ipad.serial;
            } else {
              ipad.abmLookupStatus = `imei-no-sim-match:${abmData.imei}`;
            }
          }
          console.log(`[Lookup] ABM IMEI matching: ${matches.length} pairs out of ${simpleMdmDevices.length} devices`);
        }
      } catch (e) {
        console.error('[Lookup] ABM IMEI matching error:', e.message);
        abmStatus = 'error';
      }
      
      const activeCount = webbingDevices.filter(d => d.statusId === 3).length;
      const suspendedCount = webbingDevices.filter(d => d.statusId === 4).length;
      
      return res.json({
        type: 'group',
        crmOrder: crmOrder || null, starlinkFleet: starlinkFleet || null,
        found: true,
        branchName: mdmAcct.name,
        branchId: branchId,
        mdmAccountId: mdmAcctId,
        webbingDevices,
        simpleMdmDevices,
        matches,
        usage: null,
        stats: {
          webbingCount: webbingDevices.length,
          mdmCount: simpleMdmDevices.length,
          countMatch: webbingDevices.length === simpleMdmDevices.length,
          matchedCount: matches.length,
          activeCount,
          suspendedCount,
          abmStatus
        }
      });
      
    } else if (isICCID || isIMEI) {
      // ── ICCID / IMEI SEARCH ──────────────────────────────────
      const searchType = isICCID ? 'ICCID' : 'IMEI';
      console.log(`[Lookup] Performing ${searchType} search for "${query}"`);
      
      // Step 1: Search in Webbing cache
      const device = webbingDeviceCache.find(d => {
        if (isICCID) return (d.ICCID || '') === query;
        return (d.IMEI || '') === query || String(d.IMEI) === query;
      });
      
      // Step 2: Fetch live data (works even if device not in cache)
      let liveData = null;
      try {
        const client = getWebbingClient();
        liveData = await client.getLiveData(query);
      } catch (e) {
        console.log(`[Lookup] GetSDLiveData error for ${searchType} ${query}: ${e.message}`);
      }
      
      if (!device && !liveData) {
        return res.json({ type: searchType.toLowerCase(), found: false, query });
      }
      
      // Step 3: Fetch usage (last 30 days) if we have a ServiceDeviceID
      const serviceDeviceId = device?.ServiceDeviceID || null;
      let usage = null;
      if (serviceDeviceId) {
        try {
          const client = getWebbingClient();
          const endDate = new Date().toLocaleDateString('en-US');
          const startDate = new Date(Date.now() - 30*24*60*60*1000).toLocaleDateString('en-US');
          const usageResult = await client.getDeviceUsage(serviceDeviceId, startDate, endDate, 'Day');
          const records = usageResult?.UsageRecords || usageResult?.records || [];
          const totalMB = records.reduce((sum, r) => sum + (parseFloat(r.TotalMB || r.totalMB || 0)), 0);
          usage = { totalMB: Math.round(totalMB * 100) / 100, records, period: `${startDate} - ${endDate}` };
        } catch (e) {
          console.log('[Lookup] Usage error:', e.message);
        }
      }
      
      // Step 4: Fetch location if we have ServiceDeviceID
      let location = null;
      if (serviceDeviceId) {
        try {
          const client = getWebbingClient();
          const locResult = await client.getLocation(serviceDeviceId);
          location = locResult?.LocationInfo || locResult;
        } catch (e) {
          console.log('[Lookup] Location error:', e.message);
        }
      }
      
      return res.json({
        type: searchType.toLowerCase(),
        found: true,
        device: {
          serviceDeviceId,
          serial: device?.Serial || null,
          ssid: device?.SSID || null,
          iccid: liveData?.ICCID ? String(liveData.ICCID) : (device?.ICCID || query),
          imei: liveData?.IMEI ? String(liveData.IMEI) : (device?.IMEI || null),
          msisdn: device?.MSISDN || null,
          statusName: device?.StatusName || (liveData?.IsActive ? 'Active' : 'In Use'),
          statusId: device?.StatusID || null,
          productName: device?.ProductName || null,
          branchName: device?.BranchName || null,
          branchId: device?.BranchID || null,
          orderId: device?.OrderID || null,
          deviceTypeName: device?.DeviceTypeName || null,
          apnName: device?.ApnName || null,
          updatedAt: device?.UpdatedAtUtc || null,
          statusChanged: device?.StatusDateChange || null
        },
        liveData: liveData ? {
          countryName: liveData.CountryName,
          countryCode: liveData.CountryCode,
          carrier: liveData.VPLMN,
          mccmnc: liveData.MCCMNC,
          apn: liveData.APN,
          ip: liveData.IP,
          vendor: liveData.Vendor,
          model: liveData.Model,
          isActive: liveData.IsActive,
          lastActive: liveData.LastActive,
          pdpTimestamp: liveData.PDP
        } : null,
        usage,
        location
      });
    } else if (isGroupSearch) {
      // ── GROUP/BRANCH SEARCH ──────────────────────────────────
      console.log(`[Lookup] Performing GROUP search for "${query}"`);
      
      // Step 1: Find the branch in Webbing cache
      const branchName = query.toUpperCase();
      let branchDevices = webbingDeviceCache.filter(d => 
        d.BranchName && d.BranchName.toUpperCase() === branchName
      );
      let branchId = branchDevices.length > 0 ? branchDevices[0].BranchID : null;
      // If not found by exact name, try searching Webbing API
      if (branchDevices.length === 0) {
        const client = getWebbingClient();
        let foundBranch = null;
        
        console.log(`[Lookup] Branch "${branchName}" not in cache, searching Webbing API...`);
        
        // Primary: Search by name using SearchText (exact match)
        try {
          const searchResult = await client.searchBranches(query, 1, 100);
          const branchesContainer = searchResult.Branches || {};
          let branchRecords = branchesContainer.BranchRecord || [];
          if (!Array.isArray(branchRecords)) branchRecords = branchRecords ? [branchRecords] : [];
          
          console.log(`[Lookup] SearchBranches returned ${branchRecords.length} results for "${query}"`);
          
          foundBranch = branchRecords.find(b => 
            (b.BranchName || b.Name || '').toUpperCase() === branchName
          ) || (branchRecords.length === 1 ? branchRecords[0] : null);
        } catch (e) {
          console.error(`[Lookup] Branch search error: ${e.message}`);
        }
        
        // If found, fetch devices by branchId
        if (foundBranch) {
          try {
            branchId = foundBranch.BranchID || foundBranch.ID;
            console.log(`[Lookup] Found branch "${branchName}" (ID: ${branchId}), fetching devices...`);
            const devResult = await client.getServiceDevices({ branchId, pageSize: 500 });
            let devRecords = devResult.ServiceDevices?.ServiceDeviceRecord || devResult.ServiceDevices || [];
            if (!Array.isArray(devRecords)) devRecords = devRecords ? [devRecords] : [];
            branchDevices = devRecords;
            console.log(`[Lookup] Found ${branchDevices.length} devices via GetServiceDevices`);
          } catch (e) {
            console.error(`[Lookup] Device fetch error: ${e.message}`);
          }
          
          // Fallback: if GetServiceDevices returns 0, try with different SDTypeIDs
          if (branchDevices.length === 0) {
            console.log(`[Lookup] GetServiceDevices(branchId=${branchId}) returned 0, trying SDTypeID scan...`);
            for (let sdType = 1; sdType <= 10; sdType++) {
              try {
                const devResult = await client.getServiceDevices({ branchId, sdTypeId: sdType, pageSize: 500 });
                let devRecords = devResult.ServiceDevices?.ServiceDeviceRecord || devResult.ServiceDevices || [];
                if (!Array.isArray(devRecords)) devRecords = devRecords ? [devRecords] : [];
                if (devRecords.length > 0) {
                  branchDevices = devRecords;
                  console.log(`[Lookup] Found ${devRecords.length} devices with SDTypeID=${sdType}`);
                  break;
                }
              } catch (e) {
                // Skip this type
              }
            }
            
            // If still no devices, show branch as found but empty
            if (branchDevices.length === 0) {
              console.log(`[Lookup] Branch ${branchName} exists (ID=${branchId}) but has 0 devices in SOAP API`);
              // Return found=true with branchId so the user knows the branch exists
              return res.json({ 
                type: 'group',
        crmOrder: crmOrder || null, starlinkFleet: starlinkFleet || null, branchName: branchName, branchId, found: true,
                webbingDevices: [], simpleMdmDevices: [], 
                note: 'Branch exists in Webbing but devices are not accessible via the SOAP API. Check the Webbing dashboard directly.',
                stats: { webbingCount: 0, mdmCount: 0, countMatch: true } 
              });
            }
          }
        } else {
          console.log(`[Lookup] Branch "${branchName}" not found via SearchBranches`);
        }
      }
      
      if (branchDevices.length === 0) {
        return res.json({ type: 'group',
        crmOrder: crmOrder || null, starlinkFleet: starlinkFleet || null, branchName: query, found: false, 
          webbingDevices: [], simpleMdmDevices: [], stats: { webbingCount: 0, mdmCount: 0, countMatch: true } });
      }
      
      // Step 2: Fetch live data for each device (with rate limiting)
      const webbingDevices = [];
      const client = getWebbingClient();
      for (const d of branchDevices) {
        try {
          const liveResult = d._liveData || await client.getLiveData(d.ServiceDeviceID);
          webbingDevices.push({
            serviceDeviceId: d.ServiceDeviceID,
            serial: d.Serial,
            ssid: d.SSID,
            imei: liveResult.IMEI ? String(liveResult.IMEI) : null,
            iccid: liveResult.ICCID ? String(liveResult.ICCID) : null,
            status: d.StatusName,
            statusId: d.StatusID,
            plan: d.ProductName,
            carrier: liveResult.VPLMN || liveResult.CarrierName || null,
            ip: liveResult.IP || null,
            model: liveResult.Model || null,
            vendor: liveResult.Vendor || null
          });
        } catch (err) {
          webbingDevices.push({
            serviceDeviceId: d.ServiceDeviceID,
            serial: d.Serial,
            ssid: d.SSID,
            imei: null, iccid: null,
            status: d.StatusName,
            statusId: d.StatusID,
            plan: d.ProductName,
            carrier: null, ip: null, model: null, vendor: null
          });
        }
        await new Promise(r => setTimeout(r, 100));
      }
      
      // Step 3: Scan ALL SimpleMDM accounts for matching iPads by name prefix
      const simpleMdmDevices = [];
      for (const [mdmAcctId, mdmAcct] of Object.entries(MDM_ACCOUNTS)) {
        const mdmKey = mdmAcct.getKey();
        if (!mdmKey) continue;
        try {
          const auth = 'Basic ' + Buffer.from(mdmKey + ':').toString('base64');
          const branchPrefix = branchName.toLowerCase();
          let hasMore = true;
          let startingAfter = '';
          
          while (hasMore) {
            const url = `https://a.simplemdm.com/api/v1/devices?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
            const devResp = await fetch(url, { headers: { 'Authorization': auth } });
            if (!devResp.ok) break;
            const devData = await devResp.json();
            const items = devData.data || [];
            
            for (const d of items) {
              const attr = d.attributes || {};
              const name = (attr.name || '').trim();
              if (name.toLowerCase().startsWith(branchPrefix)) {
                simpleMdmDevices.push({
                  id: d.id, name, serial: attr.serial_number,
                  model: attr.model_name, osVersion: attr.os_version,
                  batteryLevel: attr.battery_level, lastSeenAt: attr.last_seen_at,
                  phoneNumber: attr.phone_number || null,
                  wifiMac: attr.wifi_mac || null,
                  imei: attr.imei || null,
                  iccid: attr.iccid || null,
                  capacity: attr.device_capacity || null,
                  enrolledAt: attr.enrolled_at || null,
                  deviceGroupId: attr.device_group_id || null,
                  mdmAccount: mdmAcctId,
                  mdmAccountName: mdmAcct.name,
            barcode: ''
                });
              }
            }
            hasMore = devData.has_more === true;
            startingAfter = items.length > 0 ? items[items.length - 1].id : '';
            if (!startingAfter) break;
          }
        } catch (e) {
          console.error(`[Lookup] SimpleMDM ${mdmAcct.name} scan error:`, e.message);
        }
      }
      
      simpleMdmDevices.sort((a, b) => {
        const numA = parseInt((a.name.match(/\((\d+)\)/) || [])[1]) || 0;
        const numB = parseInt((b.name.match(/\((\d+)\)/) || [])[1]) || 0;
        return numA - numB;
      });
      
      // NOTE: Branch usage is skipped in lookup (requires per-device API calls, too slow)
      // Users can access the full usage report from the Webbing IoT dashboard
      
      // Step 4: ABM IMEI Bridge — match iPads to SIM lines via IMEI
      const matches = [];
      let abmStatus = 'unavailable';
      try {
        if (abmPrivateKey && simpleMdmDevices.length > 0) {
          // Fetch ALL ABM devices in one batch (cached for 5 min), then match in memory
          const { serialToImei } = await buildAbmImeiMap();
          abmStatus = 'connected';
          
          for (const ipad of simpleMdmDevices) {
            const serial = (ipad.serial || '').toUpperCase();
            if (!serial) { ipad.abmLookupStatus = 'no-serial'; continue; }
            
            const abmData = serialToImei.get(serial);
            if (!abmData) {
              ipad.abmLookupStatus = 'not-in-abm';
              continue;
            }
            
            ipad.abmImei = abmData.imei;
            ipad.allImeis = abmData.allImeis;
            ipad.abmEid = abmData.eid || null;
            
            // Find matching Webbing SIM by IMEI
            const matchedSim = webbingDevices.find(sim => 
              sim.imei && abmData.allImeis.some(abmImei => 
                sim.imei === abmImei || sim.imei.includes(abmImei) || abmImei.includes(sim.imei)
              )
            );
            
            if (matchedSim) {
              ipad.abmLookupStatus = 'matched';
              matches.push({
                ipadName: ipad.name,
                ipadSerial: ipad.serial,
                ipadImei: abmData.imei,
                simSerial: matchedSim.serial,
                simImei: matchedSim.imei,
                simIccid: matchedSim.iccid,
                simCarrier: matchedSim.carrier,
                simStatus: matchedSim.status,
                simIp: matchedSim.ip
              });
              ipad.matchedSimSerial = matchedSim.serial;
              matchedSim.matchedIpadName = ipad.name;
              matchedSim.matchedIpadSerial = ipad.serial;
            } else {
              ipad.abmLookupStatus = `imei-no-sim-match:${abmData.imei}`;
            }
          }
          console.log(`[Lookup] ABM IMEI matching: ${matches.length} pairs out of ${simpleMdmDevices.length} iPads`);
        }
      } catch (e) {
        console.error('[Lookup] ABM IMEI matching error:', e.message);
        abmStatus = 'error';
      }
      
      const activeCount = webbingDevices.filter(d => d.statusId === 3).length;
      const suspendedCount = webbingDevices.filter(d => d.statusId === 4).length;
      
      // Include stored site check result if available
      const siteChecks = loadSiteChecks();
      const siteCheck = siteChecks[branchName] || siteChecks[String(branchId)] || null;

      return res.json({
        type: 'group',
        crmOrder: crmOrder || null, starlinkFleet: starlinkFleet || null,
        found: true,
        branchName: branchName,
        branchId: branchId,
        webbingDevices,
        simpleMdmDevices,
        matches,
        usage: null,
        siteCheck,
        stats: {
          webbingCount: webbingDevices.length,
          mdmCount: simpleMdmDevices.length,
          countMatch: webbingDevices.length === simpleMdmDevices.length,
          matchedCount: matches.length,
          activeCount,
          suspendedCount,
          abmStatus
        }
      });
      
    } else {
      // ── FALLBACK: Check SimpleMDM groups by name ──────────────
      // Checks both assignment_groups and device_groups (legacy)
      let foundGroup = null;
      let foundGroupAcctId = null;
      let foundGroupType = null; // 'assignment' or 'device'
      
      console.log(`[Lookup] Checking SimpleMDM groups for name "${query}"...`);
      
      try {
        for (const [mdmAcctId, mdmAcct] of Object.entries(MDM_ACCOUNTS)) {
          const mdmKey = mdmAcct.getKey();
          if (!mdmKey) continue;
          
          // Check assignment groups
          try {
            let allGroups = [];
            let hasMore = true;
            let startingAfter = '';
            while (hasMore) {
              const url = `/assignment_groups?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
              const resp = await smdmRequest(mdmKey, url);
              const page = resp?.data || [];
              allGroups = allGroups.concat(page);
              hasMore = resp?.has_more === true;
              startingAfter = page.length > 0 ? page[page.length - 1].id : '';
              if (!startingAfter) break;
            }
            
            const names = allGroups.map(g => g.attributes?.name || '(unnamed)');
            console.log(`[Lookup] ${mdmAcct.name} assignment_groups (${allGroups.length}): ${names.join(', ')}`);
            
            const match = allGroups.find(g => 
              (g.attributes?.name || '').toLowerCase() === query.toLowerCase()
            );
            if (match) {
              foundGroup = match;
              foundGroupAcctId = mdmAcctId;
              foundGroupType = 'assignment';
              console.log(`[Lookup] Found assignment group "${match.attributes?.name}" (ID: ${match.id})`);
              break;
            }
          } catch (e) {
            console.log(`[Lookup] ${mdmAcct.name} assignment_groups error:`, e.message);
          }
          
          // Check legacy device groups
          try {
            let allDevGroups = [];
            let hasMore = true;
            let startingAfter = '';
            while (hasMore) {
              const url = `/device_groups?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
              const resp = await smdmRequest(mdmKey, url);
              const page = resp?.data || [];
              allDevGroups = allDevGroups.concat(page);
              hasMore = resp?.has_more === true;
              startingAfter = page.length > 0 ? page[page.length - 1].id : '';
              if (!startingAfter) break;
            }
            
            const names = allDevGroups.map(g => g.attributes?.name || '(unnamed)');
            console.log(`[Lookup] ${mdmAcct.name} device_groups (${allDevGroups.length}): ${names.join(', ')}`);
            
            const match = allDevGroups.find(g => 
              (g.attributes?.name || '').toLowerCase() === query.toLowerCase()
            );
            if (match) {
              foundGroup = match;
              foundGroupAcctId = mdmAcctId;
              foundGroupType = 'device';
              console.log(`[Lookup] Found device group "${match.attributes?.name}" (ID: ${match.id})`);
              break;
            }
          } catch (e) {
            console.log(`[Lookup] ${mdmAcct.name} device_groups error:`, e.message);
          }
          
          if (foundGroup) break;
        }
      } catch (outerErr) {
        console.log(`[Lookup] Group search failed:`, outerErr.message);
      }
      
      if (!foundGroup) {
        console.log(`[Lookup] No group found matching "${query}" in any account`);
      }
      
      if (foundGroup) {
        // Found an assignment group — fetch its devices and return as group result
        const mdmAcct = MDM_ACCOUNTS[foundGroupAcctId];
        const mdmKey = mdmAcct.getKey();
        const groupId = foundGroup.id;
        const groupName = foundGroup.attributes?.name || query;
        
        console.log(`[Lookup] Found group "${groupName}" (ID: ${groupId}) in ${mdmAcct.name} (type: ${foundGroupType})`);
        
        // Step 1: Get the device IDs from the group's relationships
        const auth = 'Basic ' + Buffer.from(mdmKey + ':').toString('base64');
        let deviceIds = [];
        
        try {
          // Fetch the group details to get device relationships
          const groupDetail = await smdmRequest(mdmKey, `/${foundGroupType === 'device' ? 'device_groups' : 'assignment_groups'}/${groupId}`);
          console.log(`[Lookup] Group detail relationships:`, JSON.stringify(groupDetail?.data?.relationships || {}).substring(0, 500));
          
          // Assignment groups can have devices directly and/or via device_groups
          const relDevices = groupDetail?.data?.relationships?.devices?.data || [];
          const relDeviceGroups = groupDetail?.data?.relationships?.device_groups?.data || [];
          
          // Get direct device IDs
          const directDeviceIds = (Array.isArray(relDevices) ? relDevices : relDevices ? [relDevices] : [])
            .map(d => d.id).filter(Boolean);
          deviceIds = [...directDeviceIds];
          
          console.log(`[Lookup] Direct device IDs from group: ${directDeviceIds.length}`);
          
          // Also get devices from linked device groups
          const linkedDgIds = (Array.isArray(relDeviceGroups) ? relDeviceGroups : relDeviceGroups ? [relDeviceGroups] : [])
            .map(g => g.id).filter(Boolean);
          
          for (const dgId of linkedDgIds) {
            try {
              const dgDetail = await smdmRequest(mdmKey, `/device_groups/${dgId}`);
              const dgDevices = dgDetail?.data?.relationships?.devices?.data || [];
              const dgDevIds = (Array.isArray(dgDevices) ? dgDevices : dgDevices ? [dgDevices] : [])
                .map(d => d.id).filter(Boolean);
              deviceIds = deviceIds.concat(dgDevIds);
              console.log(`[Lookup] Device group ${dgId}: ${dgDevIds.length} devices`);
            } catch (dgErr) {
              console.log(`[Lookup] Error fetching device group ${dgId}:`, dgErr.message);
            }
          }
          
          // Deduplicate
          deviceIds = [...new Set(deviceIds)];
          console.log(`[Lookup] Total unique device IDs: ${deviceIds.length}`);
        } catch (relErr) {
          console.log(`[Lookup] Error fetching group relationships:`, relErr.message);
        }
        
        // Step 2: Fetch each device's details
        const simpleMdmDevices = [];
        
        for (const devId of deviceIds) {
          try {
            const devResp = await smdmRequest(mdmKey, `/devices/${devId}`);
            const d = devResp?.data;
            if (!d) continue;
            
            const attr = d.attributes || {};
            const deviceName = (attr.name || '').trim();
            const subs = attr.service_subscriptions || [];
            const primarySub = Array.isArray(subs) && subs.length > 0 ? subs[0] : {};
            const subIccid = (primarySub.iccid || '').replace(/\s/g, '');
            const subImei = (primarySub.imei || '').replace(/\s/g, '');
            const subEid = (primarySub.eid || '').replace(/\s/g, '');
            
            simpleMdmDevices.push({
              id: d.id, name: deviceName, serial: attr.serial_number,
              model: attr.model_name, osVersion: attr.os_version,
              batteryLevel: attr.battery_level, lastSeenAt: attr.last_seen_at,
              phoneNumber: attr.phone_number || primarySub.phone_number || null,
              wifiMac: attr.wifi_mac || null,
              imei: subImei || attr.imei || null,
              iccid: subIccid || attr.iccid || null,
              eid: subEid || null,
              carrier: primarySub.current_carrier_network || null,
              capacity: attr.device_capacity || null,
              enrolledAt: attr.enrolled_at || null,
              deviceGroupId: attr.device_group_id || null,
              mdmAccount: foundGroupAcctId,
              mdmAccountName: mdmAcct.name,
              barcode: ''
            });
          } catch (devErr) {
            console.log(`[Lookup] Error fetching device ${devId}:`, devErr.message);
          }
        }
        
        console.log(`[Lookup] Assignment group "${groupName}": ${simpleMdmDevices.length} devices`);
        
        // Match to Webbing SIMs via ICCID
        const webbingDevices = [];
        const matches = [];
        
        for (const ipad of simpleMdmDevices) {
          if (!ipad.iccid) continue;
          const mdmIccid = ipad.iccid.replace(/\s/g, '');
          
          const rawMatch = webbingDeviceCache.find(d => {
            const simIccid = (d.ICCID || '').replace(/\s/g, '');
            return simIccid && simIccid === mdmIccid;
          });
          
          if (rawMatch) {
            const matchedSim = {
              serviceDeviceId: rawMatch.ServiceDeviceID,
              serial: rawMatch.Serial || rawMatch.SSID,
              ssid: rawMatch.SSID,
              iccid: rawMatch.ICCID,
              imei: String(rawMatch.IMEI || ''),
              msisdn: rawMatch.MSISDN,
              status: rawMatch.StatusName,
              statusId: rawMatch.StatusID,
              plan: rawMatch.ProductName,
              productName: rawMatch.ProductName,
              branch: rawMatch.BranchName,
              branchName: rawMatch.BranchName,
              branchId: rawMatch.BranchID,
              ip: rawMatch.IP || '',
              model: rawMatch.Model || '',
              vendor: rawMatch.Vendor || '',
              deviceType: rawMatch.DeviceTypeName,
              statusDate: rawMatch.StatusDateChange
            };
            
            if (!webbingDevices.find(w => w.serviceDeviceId === matchedSim.serviceDeviceId)) {
              webbingDevices.push(matchedSim);
            }
            
            matches.push({
              ipadName: ipad.name, ipadSerial: ipad.serial,
              ipadImei: ipad.imei || '',
              simSerial: matchedSim.serial, simImei: matchedSim.imei || '',
              simIccid: matchedSim.iccid,
              simCarrier: ipad.carrier || '', simStatus: matchedSim.status,
              simIp: matchedSim.ip || ''
            });
            ipad.matchedSimSerial = matchedSim.serial;
            matchedSim.matchedIpadName = ipad.name;
            matchedSim.matchedIpadSerial = ipad.serial;
          }
        }
        
        return res.json({
          type: 'group',
        crmOrder: crmOrder || null, starlinkFleet: starlinkFleet || null,
          found: true,
          source: 'assignment_group',
          branchName: groupName,
          branchId: null,
          groupId,
          webbingDevices,
          simpleMdmDevices,
          matches,
          stats: {
            mdmCount: simpleMdmDevices.length,
            webbingCount: webbingDevices.length,
            matchedCount: matches.length,
            abmStatus: 'not_needed'
          }
        });
      }
      
      // ── DEVICE SERIAL SEARCH ──────────────────────────────────
      console.log(`[Lookup] Performing DEVICE search for "${query}"`);
      
      // Search in Webbing cache by serial, SSID, ICCID, or ServiceDeviceID
      const device = webbingDeviceCache.find(d => 
        (d.Serial || '').toLowerCase() === query.toLowerCase() ||
        (d.SSID || '').toLowerCase() === query.toLowerCase() ||
        (d.ICCID || '') === query ||
        String(d.ServiceDeviceID) === query
      );
      
      if (!device) {
        // Try searching SimpleMDM by serial number
        let mdmDevice = null;
        for (const [mdmAcctId, mdmAcct] of Object.entries(MDM_ACCOUNTS)) {
          const mdmKey = mdmAcct.getKey();
          if (!mdmKey) continue;
          try {
            const auth = 'Basic ' + Buffer.from(mdmKey + ':').toString('base64');
            const searchResp = await fetch(`https://a.simplemdm.com/api/v1/devices?search=${encodeURIComponent(query)}`, {
              headers: { 'Authorization': auth }
            });
            if (searchResp.ok) {
              const searchData = await searchResp.json();
              const items = searchData.data || [];
              if (items.length > 0) {
                const attr = items[0].attributes || {};
                mdmDevice = {
                  id: items[0].id, name: attr.name, serial: attr.serial_number,
                  model: attr.model_name, osVersion: attr.os_version,
                  batteryLevel: attr.battery_level, lastSeenAt: attr.last_seen_at,
                  mdmAccount: mdmAcctId,
                  mdmAccountName: mdmAcct.name,
            barcode: ''
                };
                break; // Found in this account, stop searching
              }
            }
          } catch (e) {
            console.error(`[Lookup] SimpleMDM ${mdmAcct.name} search error:`, e.message);
          }
        }
        
        if (mdmDevice) {
          return res.json({ type: 'mdm_device', found: true, device: mdmDevice });
        }
        return res.json({ type: 'device', found: false, query });
      }
      
      // Fetch live data
      let liveData = null;
      try {
        const client = getWebbingClient();
        liveData = await client.getLiveData(device.ServiceDeviceID);
      } catch (e) {
        console.log('[Lookup] Live data error:', e.message);
      }
      
      // Fetch usage (last 30 days)
      let usage = null;
      try {
        const client = getWebbingClient();
        const endDate = new Date().toLocaleDateString('en-US');
        const startDate = new Date(Date.now() - 30*24*60*60*1000).toLocaleDateString('en-US');
        const usageResult = await client.getDeviceUsage(device.ServiceDeviceID, startDate, endDate, 'Day');
        const records = usageResult?.UsageRecords || usageResult?.records || [];
        const totalMB = records.reduce((sum, r) => sum + (parseFloat(r.TotalMB || r.totalMB || 0)), 0);
        usage = { totalMB: Math.round(totalMB * 100) / 100, records, period: `${startDate} - ${endDate}` };
      } catch (e) {
        console.log('[Lookup] Usage error:', e.message);
      }
      
      // Fetch location
      let location = null;
      try {
        const client = getWebbingClient();
        const locResult = await client.getLocation(device.ServiceDeviceID);
        location = locResult?.LocationInfo || locResult;
      } catch (e) {
        console.log('[Lookup] Location error:', e.message);
      }
      
      return res.json({
        type: 'device',
        found: true,
        device: {
          serviceDeviceId: device.ServiceDeviceID,
          serial: device.Serial,
          ssid: device.SSID,
          msisdn: device.MSISDN,
          statusName: device.StatusName,
          statusId: device.StatusID,
          productName: device.ProductName,
          branchName: device.BranchName,
          branchId: device.BranchID,
          orderId: device.OrderID,
          deviceTypeName: device.DeviceTypeName,
          apnName: device.ApnName,
          updatedAt: device.UpdatedAtUtc,
          statusChanged: device.StatusDateChange
        },
        liveData,
        usage,
        location
      });
    }
  } catch (error) {
    console.error('[Lookup] Error:', error);
    res.status(500).json({ error: 'Lookup failed: ' + error.message });
  }
});

// ── Customer Verification Routes ────────────────────────────────────
const customerVerify = new CustomerVerifyService();

// Run full verification pipeline on a customer email
app.post('/api/verify-customer', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address required' });
    }
    const result = await customerVerify.verify(email);
    res.json(result);
  } catch (error) {
    console.error('[CustomerVerify] Error:', error);
    res.status(500).json({ error: 'Verification failed: ' + error.message });
  }
});

// Get all past verification results
app.get('/api/verify-customer/results', (req, res) => {
  res.json(customerVerify.getResults());
});

// Get a specific verification by email
app.get('/api/verify-customer/:email', (req, res) => {
  const result = customerVerify.getResult(req.params.email);
  result ? res.json(result) : res.status(404).json({ error: 'No verification found for this email' });
});

// Delete a verification result
app.delete('/api/verify-customer/:email', (req, res) => {
  const deleted = customerVerify.deleteResult(req.params.email);
  deleted ? res.json({ success: true }) : res.status(404).json({ error: 'Not found' });
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
