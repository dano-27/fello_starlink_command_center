/**
 * Google Sheets Inventory Reader
 * 
 * Reads iPad/iPhone inventory from a shared Google Sheet.
 * Uses ONLY the Drive API (files.export) — no Sheets API dependency.
 * 
 * The Summary tab is exported as CSV via Drive API and parsed.
 * 
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key file contents (raw or base64)
 */

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEETS_INVENTORY_ID || '1alke7dZUvO_273oklR3UKmWmdVi6_hYCOjf_W6OacJ0';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let driveClient = null;
let sheetCache = null;
let sheetCacheTime = null;

function getDriveClient() {
  if (driveClient) return driveClient;

  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) {
    console.log('[Sheets] Not configured — missing GOOGLE_SERVICE_ACCOUNT_KEY');
    return null;
  }

  try {
    let keyData;
    try { keyData = JSON.parse(keyRaw); } catch { keyData = JSON.parse(Buffer.from(keyRaw, 'base64').toString('utf8')); }

    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    driveClient = google.drive({ version: 'v3', auth });
    console.log('[Sheets] Drive client initialized');
    return driveClient;
  } catch (err) {
    console.error('[Sheets] Init error:', err.message);
    return null;
  }
}

/**
 * Parse CSV text into 2D array (handles quoted fields)
 */
function parseCSV(csvText) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { currentField += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { currentField += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { currentRow.push(currentField.trim()); currentField = ''; }
      else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        currentRow.push(currentField.trim());
        if (currentRow.some(f => f !== '')) rows.push(currentRow);
        currentRow = []; currentField = '';
        if (ch === '\r') i++;
      } else { currentField += ch; }
    }
  }
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(f => f !== '')) rows.push(currentRow);
  }
  return rows;
}

/**
 * Export first sheet tab as CSV via Drive API
 */
async function exportCSV() {
  const client = getDriveClient();
  if (!client) return null;

  try {
    const response = await client.files.export({
      fileId: SHEET_ID,
      mimeType: 'text/csv',
    });

    const csvText = response.data;
    if (!csvText || typeof csvText !== 'string') {
      console.log('[Sheets] Empty CSV response');
      return null;
    }

    return parseCSV(csvText);
  } catch (err) {
    console.error('[Sheets] CSV export error:', err.message);
    return null;
  }
}

/**
 * Main entry: fetch inventory from Google Sheet
 */
async function fetchInventory() {
  if (sheetCache && sheetCacheTime && (Date.now() - sheetCacheTime < CACHE_TTL)) {
    return sheetCache;
  }

  const rows = await exportCSV();
  if (!rows || rows.length < 2) {
    console.log('[Sheets] No data from sheet');
    sheetCache = [];
    sheetCacheTime = Date.now();
    return [];
  }

  // Detect format: pivot table if first header cell is empty
  const firstCell = (rows[0][0] || '').trim();
  const products = (!firstCell && rows[0].length > 2) ? parsePivotFormat(rows) : parseStandardFormat(rows);

  sheetCache = products;
  sheetCacheTime = Date.now();
  console.log(`[Sheets] Loaded ${products.length} products from Google Sheets`);
  return products;
}

/**
 * Parse pivot table:
 * Row 0: [blank], "5th Gen", "6th Gen", ..., "Grand Total"
 * Rows:  "4G Active", 748, 1194, ...     → has SIM, ready to rent
 *        "4G Inactive", 8, 45, ...       → damaged/inoperable
 *        "4G Capable", 569, 275, ...     → no SIM, needs SIM
 */
function parsePivotFormat(rows) {
  const headers = rows[0];
  const modelNames = [];
  const lastHeader = (headers[headers.length - 1] || '').toLowerCase();
  const skipLast = lastHeader.includes('total') || lastHeader.includes('grand');

  for (let col = 1; col < headers.length - (skipLast ? 1 : 0); col++) {
    const name = (headers[col] || '').trim();
    if (name) modelNames.push({ col, name });
  }

  const modelData = {};
  for (const m of modelNames) {
    modelData[m.col] = { name: m.name, active: 0, inactive: 0, capable: 0, total: 0 };
  }

  for (let r = 1; r < rows.length; r++) {
    const label = (rows[r][0] || '').trim().toLowerCase();
    if (!label) continue;

    const isActive = label.includes('active') && !label.includes('inactive');
    const isInactive = label.includes('inactive');
    const isCapable = label.includes('capable') || label.includes('available') || label.includes('warehouse');

    for (const m of modelNames) {
      const val = parseInt(rows[r][m.col] || '0') || 0;
      if (isActive) modelData[m.col].active += val;
      else if (isInactive) modelData[m.col].inactive += val;
      else if (isCapable) modelData[m.col].capable += val;
      modelData[m.col].total += val;
    }
  }

  const products = [];
  for (const m of modelNames) {
    const d = modelData[m.col];
    // Active = has SIM (ready to rent), Capable = no SIM, Inactive = damaged
    const totalUsable = d.active + d.capable;
    const readyToDeploy = d.active;
    const needsSIM = d.capable;
    const damaged = d.inactive;
    const name = d.name.toLowerCase().includes('iphone') ? d.name : 'iPad ' + d.name;

    products.push({
      id: 'sheet-' + name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      name,
      partNumber: '',
      manufacturer: 'Apple',
      category: name.toLowerCase().includes('iphone') ? 'iPhones' : 'iPads',
      totalStock: totalUsable,
      deployed: 0,
      available: readyToDeploy,
      utilization: totalUsable > 0 ? Math.round(((totalUsable - readyToDeploy) / totalUsable) * 100) : 0,
      status: readyToDeploy < 3 && totalUsable > 0 ? 'low' : readyToDeploy < 10 && totalUsable > 0 ? 'watch' : 'ok',
      msrp: null,
      source: 'google-sheet',
      notes: `Ready (w/ SIM): ${readyToDeploy} | Needs SIM: ${needsSIM} | Damaged: ${damaged}`,
      forecast: { demand: 0, returns: 0, projected: readyToDeploy, upcomingOrders: [] }
    });
  }

  console.log(`[Sheets] Pivot: ${products.length} models parsed`);
  return products;
}

/**
 * Parse standard table format (one row per model)
 */
function parseStandardFormat(rows) {
  const headers = rows[0].map(h => (h || '').trim().toLowerCase());
  const colMap = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!colMap.name && (h.includes('model') || h.includes('device') || h.includes('name') || h.includes('product'))) colMap.name = i;
    if (!colMap.total && (h.includes('total') || h.includes('stock') || h === 'qty' || h.includes('count'))) colMap.total = i;
    if (!colMap.deployed && (h.includes('deploy') || h.includes('out') || h.includes('rent'))) colMap.deployed = i;
    if (!colMap.available && (h.includes('available') || h.includes('in stock') || h.includes('remaining'))) colMap.available = i;
  }
  if (colMap.name === undefined) colMap.name = 0;

  const products = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[colMap.name] || '').trim();
    if (!name) continue;

    const total = parseInt(row[colMap.total] || '0') || 0;
    const deployed = parseInt(row[colMap.deployed] || '0') || 0;
    const available = colMap.available !== undefined ? (parseInt(row[colMap.available] || '0') || 0) : Math.max(0, total - deployed);

    products.push({
      id: 'sheet-' + name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      name,
      partNumber: '', manufacturer: 'Apple',
      category: name.toLowerCase().includes('iphone') ? 'iPhones' : 'iPads',
      totalStock: total, deployed, available,
      utilization: total > 0 ? Math.round((deployed / total) * 100) : 0,
      status: available < 3 && total > 0 ? 'low' : available < 10 && total > 0 ? 'watch' : 'ok',
      msrp: null, source: 'google-sheet', notes: '',
      forecast: { demand: 0, returns: 0, projected: available, upcomingOrders: [] }
    });
  }
  return products;
}

function isConfigured() { return !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY); }
function clearCache() { sheetCache = null; sheetCacheTime = null; }

async function debugRead() {
  const rows = await exportCSV();
  if (!rows) return { error: 'Could not read sheet' };
  return {
    sheetId: SHEET_ID,
    rowCount: rows.length,
    headers: rows[0],
    rows: rows.slice(0, 6)
  };
}

module.exports = {
  fetchInventory, isConfigured, clearCache, debugRead,
  getCache: () => sheetCache, getSheetId: () => SHEET_ID
};
