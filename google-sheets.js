/**
 * Google Sheets Inventory Reader
 * 
 * Reads iPad/iPhone inventory from a shared Google Sheet.
 * Uses raw HTTP fetch with service account JWT auth — no googleapis client.
 * 
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key file contents (raw or base64)
 */

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEETS_INVENTORY_ID || '1alke7dZUvO_273oklR3UKmWmdVi6_hYCOjf_W6OacJ0';
const CACHE_TTL = 5 * 60 * 1000;
let authClient = null;
let sheetCache = null;
let sheetCacheTime = null;

/**
 * Get an authenticated GoogleAuth client (for access tokens only)
 */
function getAuth() {
  if (authClient) return authClient;

  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) return null;

  try {
    let keyData;
    try { keyData = JSON.parse(keyRaw); } catch { keyData = JSON.parse(Buffer.from(keyRaw, 'base64').toString('utf8')); }

    authClient = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    console.log('[Sheets] Auth initialized');
    return authClient;
  } catch (err) {
    console.error('[Sheets] Auth init error:', err.message);
    return null;
  }
}

/**
 * Get access token string
 */
async function getAccessToken() {
  const auth = getAuth();
  if (!auth) return null;
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token || token;
}

/**
 * Parse CSV text into 2D array
 */
function parseCSV(csvText) {
  const rows = [];
  let currentRow = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { currentRow.push(field.trim()); field = ''; }
      else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        currentRow.push(field.trim());
        if (currentRow.some(f => f !== '')) rows.push(currentRow);
        currentRow = []; field = '';
        if (ch === '\r') i++;
      } else { field += ch; }
    }
  }
  if (field || currentRow.length > 0) {
    currentRow.push(field.trim());
    if (currentRow.some(f => f !== '')) rows.push(currentRow);
  }
  return rows;
}

/**
 * Export sheet as CSV via direct HTTP with timeout
 */
async function exportCSV() {
  const token = await getAccessToken();
  if (!token) { console.log('[Sheets] No access token'); return null; }

  const url = `https://www.googleapis.com/drive/v3/files/${SHEET_ID}/export?mimeType=text/csv`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[Sheets] Export failed ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const csvText = await resp.text();
    if (!csvText) { console.log('[Sheets] Empty CSV'); return null; }

    const rows = parseCSV(csvText);
    console.log(`[Sheets] Exported ${rows.length} rows, ${rows[0]?.length || 0} cols`);
    return rows;
  } catch (err) {
    console.error('[Sheets] Export error:', err.message);
    return null;
  }
}

/**
 * Main: fetch inventory
 */
async function fetchInventory() {
  if (sheetCache && sheetCacheTime && (Date.now() - sheetCacheTime < CACHE_TTL)) {
    return sheetCache;
  }

  const rows = await exportCSV();
  if (!rows || rows.length < 2) {
    sheetCache = [];
    sheetCacheTime = Date.now();
    return [];
  }

  const firstCell = (rows[0][0] || '').trim();
  const products = (!firstCell && rows[0].length > 2) ? parsePivotFormat(rows) : parseStandardFormat(rows);

  sheetCache = products;
  sheetCacheTime = Date.now();
  console.log(`[Sheets] ${products.length} products loaded`);
  return products;
}

/**
 * Pivot table parser:
 * Headers: [blank], 5th Gen, 6th Gen, ..., Grand Total
 * Rows:    4G Active (has SIM), 4G Inactive (damaged), 4G Capable (no SIM)
 */
function parsePivotFormat(rows) {
  const headers = rows[0];
  const models = [];
  const lastH = (headers[headers.length - 1] || '').toLowerCase();
  const skipLast = lastH.includes('total') || lastH.includes('grand');

  for (let c = 1; c < headers.length - (skipLast ? 1 : 0); c++) {
    const name = (headers[c] || '').trim();
    if (name) models.push({ col: c, name, active: 0, inactive: 0, capable: 0, total: 0 });
  }

  for (let r = 1; r < rows.length; r++) {
    const label = (rows[r][0] || '').trim().toLowerCase();
    if (!label) continue;
    const isActive = label.includes('active') && !label.includes('inactive');
    const isInactive = label.includes('inactive');
    const isCapable = label.includes('capable') || label.includes('available');

    for (const m of models) {
      const v = parseInt(rows[r][m.col] || '0') || 0;
      if (isActive) m.active += v;
      else if (isInactive) m.inactive += v;
      else if (isCapable) m.capable += v;
      m.total += v;
    }
  }

  return models.map(m => {
    const usable = m.active + m.capable;
    const ready = m.active;
    const name = m.name.toLowerCase().includes('iphone') ? m.name : 'iPad ' + m.name;
    return {
      id: 'sheet-' + name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      name, partNumber: '', manufacturer: 'Apple',
      category: name.toLowerCase().includes('iphone') ? 'iPhones' : 'iPads',
      totalStock: usable, deployed: 0, available: ready,
      utilization: usable > 0 ? Math.round(((usable - ready) / usable) * 100) : 0,
      status: ready < 3 && usable > 0 ? 'low' : ready < 10 && usable > 0 ? 'watch' : 'ok',
      msrp: null, source: 'google-sheet',
      notes: `Ready (w/ SIM): ${ready} | Needs SIM: ${m.capable} | Damaged: ${m.inactive}`,
      forecast: { demand: 0, returns: 0, projected: ready, upcomingOrders: [] }
    };
  });
}

function parseStandardFormat(rows) {
  const headers = rows[0].map(h => (h || '').trim().toLowerCase());
  const c = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!c.name && (h.includes('model') || h.includes('device') || h.includes('name'))) c.name = i;
    if (!c.total && (h.includes('total') || h.includes('stock') || h === 'qty')) c.total = i;
    if (!c.deployed && (h.includes('deploy') || h.includes('out'))) c.deployed = i;
    if (!c.available && (h.includes('available') || h.includes('remaining'))) c.available = i;
  }
  if (c.name === undefined) c.name = 0;

  return rows.slice(1).filter(r => (r[c.name] || '').trim()).map(r => {
    const name = (r[c.name] || '').trim();
    const total = parseInt(r[c.total] || '0') || 0;
    const deployed = parseInt(r[c.deployed] || '0') || 0;
    const available = c.available !== undefined ? (parseInt(r[c.available] || '0') || 0) : Math.max(0, total - deployed);
    return {
      id: 'sheet-' + name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      name, partNumber: '', manufacturer: 'Apple',
      category: name.toLowerCase().includes('iphone') ? 'iPhones' : 'iPads',
      totalStock: total, deployed, available,
      utilization: total > 0 ? Math.round((deployed / total) * 100) : 0,
      status: available < 3 && total > 0 ? 'low' : available < 10 && total > 0 ? 'watch' : 'ok',
      msrp: null, source: 'google-sheet', notes: '',
      forecast: { demand: 0, returns: 0, projected: available, upcomingOrders: [] }
    };
  });
}

function isConfigured() { return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY; }
function clearCache() { sheetCache = null; sheetCacheTime = null; }

async function debugRead() {
  try {
    const token = await getAccessToken();
    if (!token) return { error: 'No access token - check GOOGLE_SERVICE_ACCOUNT_KEY' };

    const url = `https://www.googleapis.com/drive/v3/files/${SHEET_ID}/export?mimeType=text/csv`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      return { error: `HTTP ${resp.status}`, detail: errText.slice(0, 500), url };
    }

    const csvText = await resp.text();
    if (!csvText) return { error: 'Empty CSV body' };

    const rows = parseCSV(csvText);
    return { sheetId: SHEET_ID, rowCount: rows.length, headers: rows[0], rows: rows.slice(0, 6) };
  } catch (e) {
    return { error: e.message, name: e.name };
  }
}

module.exports = {
  fetchInventory, isConfigured, clearCache, debugRead,
  getCache: () => sheetCache, getSheetId: () => SHEET_ID
};
