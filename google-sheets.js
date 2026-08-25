/**
 * Google Sheets Inventory Reader
 * 
 * Reads iPad/iPhone inventory from a published Google Sheet CSV.
 * Uses a simple HTTPS fetch — no Google API client needed.
 * 
 * The sheet must be "Published to Web" as CSV.
 */

const PUBLISHED_CSV_URL = process.env.GOOGLE_SHEETS_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQU4Nf5PC7Sw_nzqVq397fyCT5Fg9iViXwpxGlBHt71ox78sCdV7w-mwHXIrMkTGXuekFXmRKN0XRLu/pub?gid=0&single=true&output=csv';

const SHEET_ID = '1alke7dZUvO_273oklR3UKmWmdVi6_hYCOjf_W6OacJ0';
const CACHE_TTL = 5 * 60 * 1000;
let sheetCache = null;
let sheetCacheTime = null;
let lastError = null;

function parseCSV(csvText) {
  const rows = [];
  let currentRow = [], field = '', inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i], next = csvText[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { currentRow.push(field.trim()); field = ''; }
      else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        currentRow.push(field.trim());
        if (currentRow.some(f => f !== '')) rows.push(currentRow);
        currentRow = []; field = '';
        if (ch === '\r') i++;
      } else field += ch;
    }
  }
  if (field || currentRow.length > 0) {
    currentRow.push(field.trim());
    if (currentRow.some(f => f !== '')) rows.push(currentRow);
  }
  return rows;
}

async function exportCSV() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    console.log(`[Sheets] Fetching CSV from: ${PUBLISHED_CSV_URL.slice(0, 80)}...`);
    const resp = await fetch(PUBLISHED_CSV_URL, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'FelloCommandCenter/1.0' }
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text();
      lastError = `HTTP ${resp.status}: ${body.slice(0, 200)}`;
      console.error('[Sheets]', lastError);
      return null;
    }

    const csvText = await resp.text();
    if (!csvText || csvText.length < 10) {
      lastError = `Empty response (${csvText?.length || 0} bytes)`;
      return null;
    }

    // Check if we got HTML instead of CSV (login page)
    if (csvText.trim().startsWith('<!DOCTYPE') || csvText.trim().startsWith('<html')) {
      lastError = 'Got HTML instead of CSV — sheet may not be published';
      return null;
    }

    const rows = parseCSV(csvText);
    lastError = null;
    console.log(`[Sheets] Got ${rows.length} rows, ${rows[0]?.length || 0} cols`);
    return rows;
  } catch (err) {
    lastError = `${err.name}: ${err.message}`;
    console.error('[Sheets] Fetch error:', lastError);
    return null;
  }
}

/**
 * Background sync — runs every 5 min, retries on failure
 */
let bgSyncTimer = null;
function startBackgroundSync() {
  async function sync() {
    console.log('[Sheets] Background sync starting...');
    const rows = await exportCSV();
    if (rows && rows.length >= 2) {
      const firstCell = (rows[0][0] || '').trim();
      const products = (!firstCell && rows[0].length > 2) ? parsePivotFormat(rows) : parseStandardFormat(rows);
      sheetCache = products;
      sheetCacheTime = Date.now();
      console.log(`[Sheets] Background sync: ${products.length} products loaded`);
    } else {
      console.log('[Sheets] Background sync: no data, will retry');
    }
  }

  // First attempt after 10s (let server finish starting)
  setTimeout(sync, 10000);
  // Then every 5 minutes
  bgSyncTimer = setInterval(sync, CACHE_TTL);
}

/**
 * Import CSV data directly (manual paste fallback)
 */
function importCSV(csvText) {
  const rows = parseCSV(csvText);
  if (!rows || rows.length < 2) return { error: 'No valid data' };
  const firstCell = (rows[0][0] || '').trim();
  const products = (!firstCell && rows[0].length > 2) ? parsePivotFormat(rows) : parseStandardFormat(rows);
  sheetCache = products;
  sheetCacheTime = Date.now();
  lastError = null;
  console.log(`[Sheets] Manual import: ${products.length} products`);
  return { success: true, productCount: products.length };
}

async function fetchInventory() {
  // Return cache (populated by background sync) — never block on Google
  return sheetCache || [];
}

// Start background sync on module load
startBackgroundSync();


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

function isConfigured() { return true; } // Always configured — uses published URL
function clearCache() { sheetCache = null; sheetCacheTime = null; }

async function debugRead() {
  try {
    const rows = await exportCSV();
    if (!rows) return { error: lastError, url: PUBLISHED_CSV_URL };
    return { success: true, sheetId: SHEET_ID, rowCount: rows.length, headers: rows[0], rows: rows.slice(0, 6), url: PUBLISHED_CSV_URL };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  fetchInventory, isConfigured, clearCache, debugRead, importCSV,
  getCache: () => sheetCache, getSheetId: () => SHEET_ID, getLastError: () => lastError
};
