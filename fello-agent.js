#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Fello Command Center — Browser Automation Agent
// Runs on a Windows PC with Playwright to control Chrome
// ═══════════════════════════════════════════════════════════════════
//
// SETUP:
//   1. Install Node.js (https://nodejs.org)
//   2. npm init -y && npm install playwright ws
//   3. npx playwright install chromium
//   4. Set env vars (or edit the config below)
//   5. node fello-agent.js
//
// ENV VARS:
//   AGENT_SERVER   — Command Center URL (default: wss://fellostarlinkcommandcenter-production.up.railway.app)
//   AGENT_SECRET   — Shared secret (default: fello-agent-2026)
//   AGENT_NAME     — Agent name shown in dashboard (default: hostname)
//   SMDM_EMAIL     — SimpleMDM login email
//   SMDM_PASSWORD  — SimpleMDM login password
//   HEADLESS       — Set to 'true' to run invisible (default: false — visible browser)

const { chromium } = require('playwright');
const WebSocket = require('ws');
const os = require('os');

// ── Config ──────────────────────────────────────────────────────────
const CONFIG = {
  server: process.env.AGENT_SERVER || 'wss://fellostarlinkcommandcenter-production.up.railway.app',
  secret: process.env.AGENT_SECRET || 'fello-agent-2026',
  name: process.env.AGENT_NAME || os.hostname(),
  smdmEmail: process.env.SMDM_EMAIL || '',
  smdmPassword: process.env.SMDM_PASSWORD || '',
  headless: process.env.HEADLESS === 'true',
  userDataDir: './agent-profile',
  reconnectDelay: 5000,
  pingInterval: 25000,
};

let ws = null;
let browser = null;
let page = null;
let reconnectTimer = null;
let pingTimer = null;

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function err(msg) { console.error(`[${new Date().toLocaleTimeString()}] ERROR ${msg}`); }

// ── Browser Management ──────────────────────────────────────────────

async function ensureBrowser() {
  if (browser) return;
  log('Launching Chrome...');
  browser = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: CONFIG.headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  page = browser.pages()[0] || await browser.newPage();
  log('Chrome ready');
}

async function ensureLoggedIn() {
  await ensureBrowser();
  try {
    await page.goto('https://a.simplemdm.com/admin/devices', { waitUntil: 'domcontentloaded', timeout: 20000 });
    // SimpleMDM redirects to /admin/auth/sign_in if not logged in
    if (page.url().includes('/auth/sign_in') || page.url().includes('/login')) {
      if (!CONFIG.smdmEmail || !CONFIG.smdmPassword) throw new Error('SimpleMDM credentials not set');
      log('Logging into SimpleMDM...');
      await page.fill('#user_email', CONFIG.smdmEmail);
      await page.fill('#user_password', CONFIG.smdmPassword);
      await page.click('input[type="submit"].sign-in-button');
      // Wait for redirect away from sign_in page
      await page.waitForFunction(() => !window.location.href.includes('/auth/sign_in'), { timeout: 15000 });
      await page.waitForTimeout(1000);
      log('Logged into SimpleMDM — URL: ' + page.url());
    } else {
      log('Already logged in — URL: ' + page.url());
    }
  } catch (e) { throw e; }
}

async function takeScreenshot() {
  try { return page ? (await page.screenshot({ type: 'png' })).toString('base64') : null; }
  catch { return null; }
}

function sendStatus(taskId, message) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'status_update', taskId, message }));
  log('  -> ' + message);
}

// ── Task Handlers ───────────────────────────────────────────────────

const handlers = {
  async create_wifi_profile(task) {
    const { name, ssid, password, security, autoJoin } = task.params;
    await ensureLoggedIn();
    sendStatus(task.id, 'Navigating to profiles page...');
    await page.goto('https://a.simplemdm.com/admin/profiles', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Click "Create Profile" button (blue button, top right)
    sendStatus(task.id, 'Clicking Create Profile...');
    const createBtn = await page.$('a:has-text("Create Profile"), button:has-text("Create Profile")');
    if (createBtn) {
      await createBtn.click();
      await page.waitForTimeout(2000);
    } else {
      throw new Error('Could not find "Create Profile" button');
    }

    // Select WiFi / Wireless Network profile type
    sendStatus(task.id, 'Selecting WiFi / Wireless Network type...');
    const wifiOpt = await page.$('a:has-text("Wireless Network"), a:has-text("Wi-Fi"), a:has-text("WiFi"), [data-type="wifi"]');
    if (wifiOpt) {
      await wifiOpt.click();
      await page.waitForTimeout(2000);
    } else {
      // Try clicking any link containing wifi or wireless
      const links = await page.$$('a');
      let found = false;
      for (const link of links) {
        const text = await link.textContent();
        if (text && (text.toLowerCase().includes('wireless') || text.toLowerCase().includes('wi-fi') || text.toLowerCase().includes('wifi'))) {
          await link.click();
          found = true;
          break;
        }
      }
      if (!found) throw new Error('Could not find WiFi/Wireless Network profile type option');
      await page.waitForTimeout(2000);
    }

    sendStatus(task.id, 'Filling WiFi config...');
    // Fill profile name
    const nameField = await page.$('input[name*="name"], input[placeholder*="name"], #profile_name');
    if (nameField) await nameField.fill(name || 'WiFi - ' + ssid);
    // Fill SSID
    const ssidField = await page.$('input[name*="ssid"], input[name*="SSID"], input[placeholder*="SSID"], input[placeholder*="Network"]');
    if (ssidField) await ssidField.fill(ssid);
    // Security type
    if (security) {
      const secSelect = await page.$('select[name*="security"], select[name*="encryption"]');
      if (secSelect) await secSelect.selectOption({ label: security });
    }
    // Password
    if (password) {
      const pwField = await page.$('input[name*="password"][type="password"], input[name*="password"][type="text"], input[placeholder*="assword"]');
      if (pwField) await pwField.fill(password);
    }

    sendStatus(task.id, 'Saving profile...');
    const saveBtn = await page.$('button:has-text("Save"), button:has-text("Create"), input[type="submit"][value*="Save"], input[type="submit"][value*="Create"]');
    if (saveBtn) await saveBtn.click();
    await page.waitForTimeout(3000);
    return { success: true, result: { profileUrl: page.url(), message: 'WiFi profile "' + (name||ssid) + '" created' }, screenshot: await takeScreenshot() };
  },

  async create_restrictions_profile(task) {
    const { name, allowCamera, allowAppInstall, allowAppRemoval, allowSafari, allowScreenshot } = task.params;
    await ensureLoggedIn();
    sendStatus(task.id, 'Navigating to profiles...');
    await page.goto('https://a.simplemdm.com/admin/profiles', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const addBtn = await page.$('a:has-text("Create Profile"), button:has-text("Create Profile")'); if (addBtn) { await addBtn.click(); await page.waitForTimeout(1000); }
    sendStatus(task.id, 'Selecting Restrictions...');
    const opt = await page.$('a:text("Restrictions"), [data-type="restrictions"]'); if (opt) { await opt.click(); await page.waitForTimeout(1500); }
    sendStatus(task.id, 'Configuring restrictions...');
    const nf = await page.$('input[name*="name"]'); if (nf) await nf.fill(name);
    const toggle = async (sel, val) => { const b = await page.$(sel); if (b) { const c = await b.isChecked(); if (c !== val) await b.click(); } };
    if (allowCamera !== undefined) await toggle('input[name*="camera"]', allowCamera);
    if (allowAppInstall !== undefined) await toggle('input[name*="install"]', allowAppInstall);
    if (allowAppRemoval !== undefined) await toggle('input[name*="removal"]', allowAppRemoval);
    if (allowSafari !== undefined) await toggle('input[name*="safari"]', allowSafari);
    if (allowScreenshot !== undefined) await toggle('input[name*="screenshot"]', allowScreenshot);
    sendStatus(task.id, 'Saving...');
    const sb = await page.$('button:text("Save"), input[type="submit"]'); if (sb) await sb.click();
    await page.waitForTimeout(2000);
    return { success: true, result: { profileUrl: page.url(), message: 'Restrictions profile "' + name + '" created' }, screenshot: await takeScreenshot() };
  },

  async create_lock_screen_message(task) {
    const { name, message: lockMsg, assetTag } = task.params;
    await ensureLoggedIn();
    sendStatus(task.id, 'Navigating to profiles...');
    await page.goto('https://a.simplemdm.com/admin/profiles', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const addBtn = await page.$('a:has-text("Create Profile"), button:has-text("Create Profile")'); if (addBtn) { await addBtn.click(); await page.waitForTimeout(1000); }
    sendStatus(task.id, 'Selecting Lock Screen Message...');
    const opt = await page.$('a:text("Lock Screen"), [data-type="lock_screen"]'); if (opt) { await opt.click(); await page.waitForTimeout(1500); }
    const nf = await page.$('input[name*="name"]'); if (nf) await nf.fill(name);
    const mf = await page.$('textarea[name*="message"], input[name*="message"]'); if (mf) await mf.fill(lockMsg);
    if (assetTag) { const af = await page.$('input[name*="asset"]'); if (af) await af.fill(assetTag); }
    sendStatus(task.id, 'Saving...');
    const sb = await page.$('button:text("Save"), input[type="submit"]'); if (sb) await sb.click();
    await page.waitForTimeout(2000);
    return { success: true, result: { profileUrl: page.url(), message: 'Lock Screen Message "' + name + '" created' }, screenshot: await takeScreenshot() };
  },

  async create_single_app_mode(task) {
    const { name, appBundleId, allowTouch, allowAutoLock } = task.params;
    await ensureLoggedIn();
    sendStatus(task.id, 'Navigating to profiles...');
    await page.goto('https://a.simplemdm.com/admin/profiles', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const addBtn = await page.$('a:has-text("Create Profile"), button:has-text("Create Profile")'); if (addBtn) { await addBtn.click(); await page.waitForTimeout(1000); }
    const opt = await page.$('a:text("Single App"), a:text("App Lock"), [data-type="single_app"]'); if (opt) { await opt.click(); await page.waitForTimeout(1500); }
    const nf = await page.$('input[name*="name"]'); if (nf) await nf.fill(name);
    const bf = await page.$('input[name*="bundle"], input[name*="app_id"]'); if (bf) await bf.fill(appBundleId);
    sendStatus(task.id, 'Saving...');
    const sb = await page.$('button:text("Save"), input[type="submit"]'); if (sb) await sb.click();
    await page.waitForTimeout(2000);
    return { success: true, result: { profileUrl: page.url(), message: 'Single App Mode "' + name + '" created' }, screenshot: await takeScreenshot() };
  },

  async update_wallpaper(task) {
    const { name, imageUrl, location } = task.params;
    await ensureLoggedIn();
    sendStatus(task.id, 'Navigating to profiles...');
    await page.goto('https://a.simplemdm.com/admin/profiles', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const addBtn = await page.$('a:has-text("Create Profile"), button:has-text("Create Profile")'); if (addBtn) { await addBtn.click(); await page.waitForTimeout(1000); }
    const opt = await page.$('a:text("Wallpaper"), [data-type="wallpaper"]'); if (opt) { await opt.click(); await page.waitForTimeout(1500); }
    const nf = await page.$('input[name*="name"]'); if (nf) await nf.fill(name);
    const uf = await page.$('input[name*="url"], input[name*="image"]'); if (uf) await uf.fill(imageUrl);
    sendStatus(task.id, 'Saving...');
    const sb = await page.$('button:text("Save"), input[type="submit"]'); if (sb) await sb.click();
    await page.waitForTimeout(2000);
    return { success: true, result: { profileUrl: page.url(), message: 'Wallpaper profile "' + name + '" created' }, screenshot: await takeScreenshot() };
  },

  async custom_navigation(task) {
    const { url, instructions } = task.params;
    await ensureBrowser();
    sendStatus(task.id, 'Navigating to ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    return { success: true, result: { pageTitle: await page.title(), pageUrl: page.url(), instructions }, screenshot: await takeScreenshot() };
  },
};

// ── Task Execution ──────────────────────────────────────────────────

async function executeTask(task) {
  log('Executing: ' + task.action + ' (' + task.id.slice(0, 8) + ')');
  const handler = handlers[task.action];
  if (!handler) return { taskId: task.id, type: 'task_result', success: false, error: 'Unknown action: ' + task.action, screenshot: await takeScreenshot() };
  try {
    const result = await handler(task);
    return { taskId: task.id, type: 'task_result', success: result.success !== false, result: result.result, error: result.error, screenshot: result.screenshot || await takeScreenshot() };
  } catch (e) {
    err('Task failed: ' + e.message);
    return { taskId: task.id, type: 'task_result', success: false, error: e.message, screenshot: await takeScreenshot() };
  }
}

// ── WebSocket ───────────────────────────────────────────────────────

function connect() {
  const wsUrl = CONFIG.server + '/ws/agent?secret=' + encodeURIComponent(CONFIG.secret) + '&name=' + encodeURIComponent(CONFIG.name);
  log('Connecting to Command Center...');
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    log('Connected to Command Center');
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, CONFIG.pingInterval);
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'pong') return;
      if (msg.type === 'task') { const result = await executeTask(msg.task); ws.send(JSON.stringify(result)); }
    } catch (e) { err('Message error: ' + e.message); }
  });

  ws.on('close', (code) => {
    log('Disconnected (code: ' + code + '). Reconnecting in ' + (CONFIG.reconnectDelay / 1000) + 's...');
    if (pingTimer) clearInterval(pingTimer);
    scheduleReconnect();
  });

  ws.on('error', (e) => { if (e.code !== 'ECONNREFUSED') err('WS error: ' + e.message); });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, CONFIG.reconnectDelay);
}

async function shutdown() {
  log('Shutting down...');
  if (pingTimer) clearInterval(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close(1000);
  if (browser) await browser.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ───────────────────────────────────────────────────────────
console.log('');
console.log('  ====================================');
console.log('  Fello Command Center - Browser Agent');
console.log('  ====================================');
console.log('  Agent:    ' + CONFIG.name);
console.log('  Server:   ' + CONFIG.server);
console.log('  Headless: ' + CONFIG.headless);
console.log('  SMDM:     ' + (CONFIG.smdmEmail || '(not set)'));
console.log('');
connect();
