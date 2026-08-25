/**
 * Google Sheets Inventory Reader
 * 
 * Reads iPad/iPhone inventory from a shared Google Sheet.
 * - Summary tab: pivot table with model counts by SIM status
 * - Individual model tabs: detailed per-device inventory
 * 
 * Uses the Sheets API for multi-tab support.
 * 
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key file contents (raw or base64)
 */

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEETS_INVENTORY_ID || '1alke7dZUvO_273oklR3UKmWmdVi6_hYCOjf_W6OacJ0';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let sheetsClient = null;
let driveClient = null;
let sheetCache = null;
let sheetCacheTime = null;

function getClients() {
  if (sheetsClient && driveClient) return { sheets: sheetsClient, drive: driveClient };

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
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
    });

    sheetsClient = google.sheets({ version: 'v4', auth });
    driveClient = google.drive({ version: 'v3', auth });
    console.log(`[Sheets] Initialized — reading sheet ${SHEET_ID}`);
    return { sheets: sheetsClient, drive: driveClient };
  } catch (err) {
    console.error('[Sheets] Init error:', err.message);
    return null;
  }
}

/**
 * Read a specific tab's data via Sheets API
 */
async function readTab(tabName) {
  const clients = getClients();
  if (!clients) return null;

  try {
    const resp = await clients.sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'`,
    });
    return resp.data.values || [];
  } catch (err) {
    console.error(`[Sheets] Error reading tab "${tabName}":`, err.message);
    return null;
  }
}

/**
 * Read tab using Drive API CSV export (fallback if Sheets API fails)
 */
async function readTabViaDrive() {
  const clients = getClients();
  if (!clients) return null;

  try {
    const response = await clients.drive.files.export({
      fileId: SHEET_ID,
      mimeType: 'text/csv',
    });
    return parseCSV(response.data || '');
  } catch (err) {
    console.error('[Sheets] Drive CSV export error:', err.message);
    return null;
  }
}

/**
 * Parse CSV text into 2D array
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
 * Get all tab names from the sheet
 */
async function getTabNames() {
  const clients = getClients();
  if (!clients) return [];

  try {
    const meta = await clients.sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties.title',
    });
    return meta.data.sheets.map(s => s.properties.title);
  } catch (err) {
    console.error('[Sheets] Get tabs error:', err.message);
    return [];
  }
}

/**
 * Main entry: fetch all tabs and build inventory
 */
async function fetchInventory() {
  if (sheetCache && sheetCacheTime && (Date.now() - sheetCacheTime < CACHE_TTL)) {
    return sheetCache;
  }

  let allProducts = [];

  // Try Sheets API first (multi-tab), fall back to Drive API (first tab only)
  let tabs = await getTabNames();

  if (tabs.length > 0) {
    console.log(`[Sheets] Found ${tabs.length} tabs: ${tabs.join(', ')}`);

    for (const tab of tabs) {
      const rows = await readTab(tab);
      if (!rows || rows.length < 2) continue;

      const tabLower = tab.toLowerCase();

      if (tabLower === 'summary' || tabLower === 'overview') {
        // Pivot table format
        const pivotProducts = parsePivotFormat(rows, tab);
        allProducts.push(...pivotProducts);
        console.log(`[Sheets] Tab "${tab}": ${pivotProducts.length} products (pivot format)`);
      } else {
        // Detail tab — per-device inventory for a specific model
        const detailProducts = parseDetailTab(rows, tab);
        allProducts.push(...detailProducts);
        console.log(`[Sheets] Tab "${tab}": ${detailProducts.length} detail records`);
      }
    }
  } else {
    // Fallback: Drive API CSV export (first tab only)
    console.log('[Sheets] Falling back to Drive API CSV export');
    const rows = await readTabViaDrive();
    if (rows && rows.length >= 2) {
      allProducts = parsePivotFormat(rows, 'Summary');
    }
  }

  sheetCache = allProducts;
  sheetCacheTime = Date.now();
  console.log(`[Sheets] Total: ${allProducts.length} inventory items from Google Sheets`);
  return allProducts;
}

/**
 * Parse the Summary pivot table:
 * Row 0: [blank], "5th Gen", "6th Gen", ..., "Grand Total"
 * Row N: "4G Active", 748, 1194, ...     → has SIM, ready to rent
 * Row N: "4G Inactive", 8, 45, ...       → damaged/inoperable
 * Row N: "4G Capable", 569, 275, ...     → no SIM, needs SIM
 */
function parsePivotFormat(rows, tabName) {
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
    const row = rows[r];
    const label = (row[0] || '').trim().toLowerCase();
    if (!label) continue;

    const isActive = label.includes('active') && !label.includes('inactive');
    const isInactive = label.includes('inactive');
    const isCapable = label.includes('capable') || label.includes('available') || label.includes('warehouse');

    for (const m of modelNames) {
      const val = parseInt(row[m.col] || '0') || 0;
      if (isActive) modelData[m.col].active += val;
      else if (isInactive) modelData[m.col].inactive += val;
      else if (isCapable) modelData[m.col].capable += val;
      modelData[m.col].total += val;
    }
  }

  const products = [];
  for (const m of modelNames) {
    const d = modelData[m.col];
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
      category: guessCategory(name),
      totalStock: totalUsable,
      deployed: 0,
      available: readyToDeploy,
      utilization: totalUsable > 0 ? Math.round(((totalUsable - readyToDeploy) / totalUsable) * 100) : 0,
      status: readyToDeploy < 3 && totalUsable > 0 ? 'low' : readyToDeploy < 10 && totalUsable > 0 ? 'watch' : 'ok',
      msrp: null,
      source: 'google-sheet',
      sheetTab: tabName,
      notes: `Ready (w/ SIM): ${readyToDeploy} | Needs SIM: ${needsSIM} | Damaged: ${damaged}`,
      forecast: { demand: 0, returns: 0, projected: readyToDeploy, upcomingOrders: [] }
    });
  }

  return products;
}

/**
 * Parse a detail tab (named after a model, e.g. "5th Gen", "6th Gen").
 * These tabs contain per-device records (serial numbers, SIM status, etc.)
 * 
 * Auto-detects columns and builds a summary for that model.
 */
function parseDetailTab(rows, tabName) {
  const headers = rows[0].map(h => (h || '').trim().toLowerCase());

  // Find key columns
  let serialCol = -1, statusCol = -1, simCol = -1, notesCol = -1, locationCol = -1;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (serialCol < 0 && (h.includes('serial') || h.includes('sn') || h.includes('asset'))) serialCol = i;
    if (statusCol < 0 && (h.includes('status') || h.includes('condition') || h.includes('state'))) statusCol = i;
    if (simCol < 0 && (h.includes('sim') || h.includes('iccid') || h.includes('esim') || h.includes('4g'))) simCol = i;
    if (notesCol < 0 && (h.includes('note') || h.includes('comment'))) notesCol = i;
    if (locationCol < 0 && (h.includes('location') || h.includes('where') || h.includes('assigned'))) locationCol = i;
  }

  // Count devices by status
  let totalDevices = 0, activeCount = 0, damagedCount = 0, needsSIMCount = 0;
  const serialNumbers = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => !(c || '').trim())) continue;
    totalDevices++;

    const serial = serialCol >= 0 ? (row[serialCol] || '').trim() : '';
    if (serial) serialNumbers.push(serial);

    const status = statusCol >= 0 ? (row[statusCol] || '').trim().toLowerCase() : '';
    const simStatus = simCol >= 0 ? (row[simCol] || '').trim().toLowerCase() : '';

    if (status.includes('inactive') || status.includes('damage') || status.includes('broken') || status.includes('repair')) {
      damagedCount++;
    } else if (simStatus.includes('active') || simStatus.includes('yes') || simStatus.includes('assigned')) {
      activeCount++;
    } else if (simStatus.includes('capable') || simStatus.includes('no') || simStatus.includes('none') || simStatus === '') {
      needsSIMCount++;
    } else {
      activeCount++; // default to active if we can't tell
    }
  }

  if (totalDevices === 0) return [];

  const modelName = tabName.toLowerCase().includes('iphone') ? tabName : 'iPad ' + tabName;

  return [{
    id: 'sheet-detail-' + modelName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
    name: modelName + ' (Detail)',
    partNumber: '',
    manufacturer: 'Apple',
    category: guessCategory(modelName),
    totalStock: totalDevices - damagedCount,
    deployed: 0,
    available: activeCount,
    utilization: 0,
    status: activeCount < 3 ? 'low' : activeCount < 10 ? 'watch' : 'ok',
    msrp: null,
    source: 'google-sheet-detail',
    sheetTab: tabName,
    notes: `${totalDevices} devices tracked | Active: ${activeCount} | Needs SIM: ${needsSIMCount} | Damaged: ${damagedCount}`,
    serialCount: totalDevices,
    forecast: { demand: 0, returns: 0, projected: activeCount, upcomingOrders: [] }
  }];
}

function guessCategory(name) {
  const l = name.toLowerCase();
  if (l.includes('ipad')) return 'iPads';
  if (l.includes('iphone')) return 'iPhones';
  if (l.includes('case') || l.includes('cover')) return 'Cases';
  if (l.includes('charger') || l.includes('charging')) return 'Chargers';
  if (l.includes('cable') || l.includes('lightning') || l.includes('usb')) return 'Cables';
  if (l.includes('router') || l.includes('hotspot')) return 'Routers';
  if (l.includes('starlink')) return 'Starlink';
  if (l.includes('square') || l.includes('terminal') || l.includes('reader')) return 'POS Devices';
  return 'Other';
}

function guessMfg(name) {
  const l = name.toLowerCase();
  if (l.includes('ipad') || l.includes('iphone') || l.includes('apple')) return 'Apple';
  if (l.includes('samsung')) return 'Samsung';
  if (l.includes('square')) return 'Square';
  return '';
}

function detectColumns(headers) {
  const map = { name: null, total: null, deployed: null, available: null, category: null, notes: null, partNumber: null, manufacturer: null };
  for (const h of headers) {
    const l = h.toLowerCase();
    if (!map.name && (l.includes('model') || l.includes('device') || l.includes('name') || l.includes('product'))) map.name = h;
    if (!map.total && (l.includes('total') || l.includes('stock') || l === 'qty' || l.includes('count'))) map.total = h;
    if (!map.deployed && (l.includes('deploy') || l.includes('out') || l.includes('rent'))) map.deployed = h;
    if (!map.available && (l.includes('available') || l.includes('in stock') || l.includes('remaining'))) map.available = h;
    if (!map.category && (l.includes('category') || l.includes('type'))) map.category = h;
    if (!map.notes && (l.includes('note') || l.includes('comment'))) map.notes = h;
    if (!map.partNumber && (l.includes('part') || l.includes('sku'))) map.partNumber = h;
    if (!map.manufacturer && (l.includes('manufacturer') || l.includes('brand'))) map.manufacturer = h;
  }
  if (!map.name && headers.length > 0) map.name = headers[0];
  return map;
}

function isConfigured() { return !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY); }

function clearCache() { sheetCache = null; sheetCacheTime = null; }

async function debugRead() {
  const tabs = await getTabNames();
  const tabPreview = {};
  for (const tab of tabs.slice(0, 5)) {
    const rows = await readTab(tab);
    tabPreview[tab] = rows ? { rowCount: rows.length, headers: rows[0], firstRow: rows[1] } : { error: 'Could not read' };
  }
  return { sheetId: SHEET_ID, tabs, tabPreview, totalTabs: tabs.length };
}

module.exports = {
  fetchInventory,
  isConfigured,
  clearCache,
  debugRead,
  getCache: () => sheetCache,
  getSheetId: () => SHEET_ID
};
