/**
 * Google Sheets Inventory Reader
 * 
 * Reads iPad/iPhone inventory from a shared Google Sheet and provides
 * the data for merging into the Command Center inventory dashboard.
 * 
 * Uses the DRIVE API (already enabled) to export sheets as CSV.
 * No need for the separate Sheets API to be enabled.
 * 
 * Uses the same service account as google-drive.js:
 *   fello-dcr-uploads@fello-verify.iam.gserviceaccount.com
 * 
 * The sheet must be shared with the service account email (Viewer access).
 * 
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key file contents (raw or base64)
 */

const { google } = require('googleapis');

// Sheet ID and cache
const SHEET_ID = process.env.GOOGLE_SHEETS_INVENTORY_ID || '1alke7dZUvO_273oklR3UKmWmdVi6_hYCOjf_W6OacJ0';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let driveClient = null;
let sheetCache = null;
let sheetCacheTime = null;

/**
 * Initialize the Google Drive client (reuses same auth as google-drive.js)
 */
function getDriveClient() {
  if (driveClient) return driveClient;

  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) {
    console.log('[Sheets] Not configured — missing GOOGLE_SERVICE_ACCOUNT_KEY');
    return null;
  }

  try {
    let keyData;
    try {
      keyData = JSON.parse(keyRaw);
    } catch {
      keyData = JSON.parse(Buffer.from(keyRaw, 'base64').toString('utf8'));
    }

    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    driveClient = google.drive({ version: 'v3', auth });
    console.log(`[Sheets] Drive client initialized for sheet reading`);
    return driveClient;
  } catch (err) {
    console.error('[Sheets] Init error:', err.message);
    return null;
  }
}

/**
 * Parse CSV string into rows (handles quoted fields with commas)
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
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        currentRow.push(currentField.trim());
        if (currentRow.some(f => f !== '')) rows.push(currentRow);
        currentRow = [];
        currentField = '';
        if (ch === '\r') i++; // skip \n after \r
      } else {
        currentField += ch;
      }
    }
  }
  // Last field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(f => f !== '')) rows.push(currentRow);
  }

  return rows;
}

/**
 * Export a Google Sheet as CSV via Drive API and parse into row objects
 */
async function readSheetAsCSV() {
  const client = getDriveClient();
  if (!client) return null;

  try {
    // Export the spreadsheet as CSV (exports first visible sheet)
    const response = await client.files.export({
      fileId: SHEET_ID,
      mimeType: 'text/csv',
    });

    const csvText = response.data;
    if (!csvText || typeof csvText !== 'string') {
      console.log('[Sheets] Empty CSV response');
      return [];
    }

    const rows = parseCSV(csvText);
    if (rows.length < 2) {
      console.log('[Sheets] No data rows found in CSV');
      return [];
    }

    console.log(`[Sheets] Parsed ${rows.length} rows, ${rows[0].length} columns. Headers: ${rows[0].slice(0, 5).join(', ')}...`);
    return rows;
  } catch (err) {
    console.error('[Sheets] CSV export error:', err.message);
    return null;
  }
}

/**
 * Fetch the inventory sheet.
 * 
 * Supports TWO formats:
 * 
 * 1. PIVOT TABLE (auto-detected): Models as columns, statuses as rows
 *    e.g. columns: [blank], 5th Gen, 6th Gen, ...
 *         rows:    4G Active, 748, 1194, ...
 *                  4G Inactive, 8, 45, ...
 *                  4G Capable, 569, 275, ...
 *    "Active" = deployed, "Capable/Available" = available, sum = total
 * 
 * 2. STANDARD TABLE: One row per model with named columns
 *    e.g. Model, Total, Deployed, Available, Category
 * 
 * Returns normalized product objects compatible with the inventory dashboard.
 */
async function fetchInventory() {
  // Return cache if fresh
  if (sheetCache && sheetCacheTime && (Date.now() - sheetCacheTime < CACHE_TTL)) {
    return sheetCache;
  }

  const rows = await readSheetAsCSV();
  if (!rows || rows.length === 0) {
    console.log('[Sheets] No data from sheet');
    sheetCache = [];
    sheetCacheTime = Date.now();
    return [];
  }

  // Detect format: pivot table if first cell is empty/blank and second+ cells look like model names
  const headers = rows[0];
  const firstCell = (headers[0] || '').trim().toLowerCase();
  const isPivot = (!firstCell || firstCell === '') && headers.length > 2;

  let allProducts;
  if (isPivot) {
    allProducts = parsePivotFormat(rows);
  } else {
    allProducts = parseStandardFormat(rows);
  }

  sheetCache = allProducts;
  sheetCacheTime = Date.now();
  console.log(`[Sheets] Loaded ${allProducts.length} products from Google Sheets (${isPivot ? 'pivot' : 'standard'} format)`);
  return allProducts;
}

/**
 * Parse pivot table format:
 * Row 0 (headers): [blank], "5th Gen", "6th Gen", ..., "Grand Total"
 * Row N: "4G Active", 748, 1194, ...
 * Row N: "4G Inactive", 8, 45, ...
 * Row N: "4G Capable", 569, 275, ...
 */
function parsePivotFormat(rows) {
  const headers = rows[0];
  // Model names are in columns 1..N-1 (skip first blank col and last "Grand Total" col)
  const modelNames = [];
  const lastHeader = (headers[headers.length - 1] || '').toLowerCase();
  const skipLast = lastHeader.includes('total') || lastHeader.includes('grand');
  
  for (let col = 1; col < headers.length - (skipLast ? 1 : 0); col++) {
    const name = (headers[col] || '').trim();
    if (name) modelNames.push({ col, name });
  }

  // Parse status rows
  const modelData = {};
  for (const m of modelNames) {
    modelData[m.col] = { name: m.name, active: 0, inactive: 0, capable: 0, total: 0 };
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const label = (row[0] || '').trim().toLowerCase();
    if (!label) continue;

    const isActive = label.includes('active') && !label.includes('inactive');
    const isInactive = label.includes('inactive');
    const isCapable = label.includes('capable') || label.includes('available') || label.includes('warehouse') || label.includes('in stock');

    for (const m of modelNames) {
      const val = parseInt(row[m.col] || '0') || 0;
      if (isActive) modelData[m.col].active += val;
      else if (isInactive) modelData[m.col].inactive += val;
      else if (isCapable) modelData[m.col].capable += val;
      // Always add to total
      modelData[m.col].total += val;
    }
  }

  // Build products
  const products = [];
  for (const m of modelNames) {
    const d = modelData[m.col];
    const deployed = d.active;
    const available = d.capable;
    const total = d.total; // active + inactive + capable
    const name = 'iPad ' + d.name;

    products.push({
      id: 'sheet-' + name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      name,
      partNumber: '',
      manufacturer: 'Apple',
      category: guessCategory(name),
      totalStock: total,
      deployed,
      available,
      utilization: total > 0 ? Math.round((deployed / total) * 100) : 0,
      status: available < 3 && total > 0 ? 'low' : available < 10 && total > 0 ? 'watch' : 'ok',
      msrp: null,
      source: 'google-sheet',
      notes: `Active: ${d.active}, Inactive: ${d.inactive}, Capable: ${d.capable}`,
      forecast: { demand: 0, returns: 0, projected: available, upcomingOrders: [] }
    });
  }

  console.log(`[Sheets] Pivot: ${modelNames.length} models parsed`);
  return products;
}

/**
 * Parse standard table format (one row per model)
 */
function parseStandardFormat(rows) {
  const headerRow = rows[0];
  const headers = headerRow.map(h => h.toString().trim().toLowerCase());
  const colMap = detectColumns(headers);
  console.log(`[Sheets] Standard format columns: ${JSON.stringify(colMap)}`);

  const products = [];
  for (let i = 1; i < rows.length; i++) {
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (rows[i][j] !== undefined) ? rows[i][j].toString().trim() : '';
    }

    const name = row[colMap.name] || '';
    if (!name) continue;

    const total = parseInt(row[colMap.total] || '0') || 0;
    const deployed = parseInt(row[colMap.deployed] || '0') || 0;
    const available = colMap.available ? (parseInt(row[colMap.available] || '0') || 0) : Math.max(0, total - deployed);
    const category = row[colMap.category] || guessCategory(name);
    const notes = row[colMap.notes] || '';
    const partNumber = row[colMap.partNumber] || '';
    const manufacturer = row[colMap.manufacturer] || guessMfg(name);

    products.push({
      id: 'sheet-' + name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
      name,
      partNumber,
      manufacturer,
      category,
      totalStock: total,
      deployed,
      available,
      utilization: total > 0 ? Math.round((deployed / total) * 100) : 0,
      status: available < 3 && total > 0 ? 'low' : available < 10 && total > 0 ? 'watch' : 'ok',
      msrp: null,
      source: 'google-sheet',
      notes,
      forecast: { demand: 0, returns: 0, projected: available, upcomingOrders: [] }
    });
  }

  return products;
}

/**
 * Auto-detect column mapping from header names
 */
function detectColumns(headers) {
  const map = { name: null, total: null, deployed: null, available: null, category: null, notes: null, partNumber: null, manufacturer: null };

  for (const h of headers) {
    const l = h.toLowerCase();
    if (!map.name && (l.includes('model') || l.includes('device') || l.includes('name') || l.includes('product') || l.includes('item'))) map.name = h;
    if (!map.total && (l.includes('total') || l.includes('stock') || l === 'qty' || l === 'quantity' || l.includes('count') || l.includes('on hand') || l.includes('onhand'))) map.total = h;
    if (!map.deployed && (l.includes('deploy') || l.includes('out') || l.includes('rent') || l.includes('checked out') || l.includes('in use') || l.includes('in field'))) map.deployed = h;
    if (!map.available && (l.includes('available') || l.includes('in stock') || l.includes('remaining') || l.includes('in warehouse') || l === 'in')) map.available = h;
    if (!map.category && (l.includes('category') || l.includes('type') || l.includes('group'))) map.category = h;
    if (!map.notes && (l.includes('note') || l.includes('comment') || l.includes('description'))) map.notes = h;
    if (!map.partNumber && (l.includes('part') || l.includes('sku') || l.includes('model #') || l.includes('model number'))) map.partNumber = h;
    if (!map.manufacturer && (l.includes('manufacturer') || l.includes('brand') || l.includes('make') || l.includes('vendor'))) map.manufacturer = h;
  }

  // Fallbacks: if no name column found, use first column
  if (!map.name && headers.length > 0) map.name = headers[0];

  return map;
}

/**
 * Guess category from product name
 */
function guessCategory(name) {
  const l = name.toLowerCase();
  if (l.includes('ipad')) return 'iPads';
  if (l.includes('iphone')) return 'iPhones';
  if (l.includes('case') || l.includes('cover')) return 'Cases';
  if (l.includes('charger') || l.includes('charging')) return 'Chargers';
  if (l.includes('cable') || l.includes('lightning') || l.includes('usb')) return 'Cables';
  if (l.includes('router') || l.includes('hotspot') || l.includes('mifi')) return 'Routers';
  if (l.includes('starlink')) return 'Starlink';
  if (l.includes('square') || l.includes('terminal') || l.includes('reader')) return 'POS Devices';
  return 'Other';
}

/**
 * Guess manufacturer from product name
 */
function guessMfg(name) {
  const l = name.toLowerCase();
  if (l.includes('ipad') || l.includes('iphone') || l.includes('apple') || l.includes('lightning')) return 'Apple';
  if (l.includes('samsung')) return 'Samsung';
  if (l.includes('square')) return 'Square';
  if (l.includes('starlink') || l.includes('spacex')) return 'SpaceX';
  return '';
}

/**
 * Check if the Sheets integration is configured
 */
function isConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
}

/**
 * Clear the cache (force refresh on next fetch)
 */
function clearCache() {
  sheetCache = null;
  sheetCacheTime = null;
}

/**
 * Debug: get raw CSV from sheet
 */
async function debugRead() {
  const client = getDriveClient();
  if (!client) return { error: 'No drive client' };
  try {
    const response = await client.files.export({ fileId: SHEET_ID, mimeType: 'text/csv' });
    const csvText = response.data || '';
    const lines = csvText.split('\n').slice(0, 10);
    return { sheetId: SHEET_ID, firstLines: lines, totalLength: csvText.length };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  fetchInventory,
  isConfigured,
  clearCache,
  debugRead,
  getCache: () => sheetCache,
  getSheetId: () => SHEET_ID
};
