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
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Config ──────────────────────────────────────────────────────────
const CONFIG = {
  server: process.env.AGENT_SERVER || 'wss://fellostarlinkcommandcenter-production.up.railway.app',
  secret: process.env.AGENT_SECRET || 'fello-agent-2026',
  name: process.env.AGENT_NAME || os.hostname(),
  smdmEmail: process.env.SMDM_EMAIL || '',
  smdmPassword: process.env.SMDM_PASSWORD || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  headless: process.env.HEADLESS === 'true',
  userDataDir: './agent-profile',
  reconnectDelay: 5000,
  pingInterval: 25000,
  aiMaxSteps: 20,
};

// Load local config file (keeps secrets out of git)
try {
  const fs = require('fs');
  const path = require('path');
  const cfgPath = path.join(__dirname, 'agent-config.json');
  if (fs.existsSync(cfgPath)) {
    const local = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    Object.assign(CONFIG, local);
    console.log('[Config] Loaded agent-config.json');
  }
} catch (e) { console.log('[Config] No agent-config.json found, using env vars'); }

let ws = null;
let browser = null;
let page = null;
let reconnectTimer = null;
let pingTimer = null;

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function err(msg) { console.error(`[${new Date().toLocaleTimeString()}] ERROR ${msg}`); }

// ── Browser Management ──────────────────────────────────────────────

async function ensureBrowser() {
  // Check if existing browser is still alive
  if (browser) {
    try {
      // Quick health check — if this throws, browser is dead
      browser.pages();
      if (page && !page.isClosed()) return;
      // Page closed but browser alive — get a new page
      page = browser.pages()[0] || await browser.newPage();
      return;
    } catch (e) {
      log('Browser crashed, relaunching... (' + e.message + ')');
      browser = null;
      page = null;
    }
  }
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
      if (secSelect) {
        // Get all available options to find the right match
        const options = await secSelect.$$eval('option', opts => opts.map(o => ({ value: o.value, label: o.textContent.trim() })));
        sendStatus(task.id, 'Security options: ' + options.map(o => o.label || o.value).join(', '));
        // Try exact label match, then value match, then fuzzy
        const secLower = security.toLowerCase().replace(/[^a-z0-9]/g, '');
        const match = options.find(o => o.label.toLowerCase() === security.toLowerCase())
          || options.find(o => o.value.toLowerCase() === security.toLowerCase())
          || options.find(o => o.label.toLowerCase().replace(/[^a-z0-9]/g, '').includes(secLower))
          || options.find(o => o.value.toLowerCase().replace(/[^a-z0-9]/g, '').includes(secLower));
        if (match) {
          await secSelect.selectOption(match.value);
          sendStatus(task.id, 'Selected security: ' + (match.label || match.value));
        } else {
          sendStatus(task.id, 'Warning: could not match security "' + security + '"');
        }
      }
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
    if (url) {
      sendStatus(task.id, 'Navigating to ' + url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
    }
    // If instructions provided, engage AI to follow them
    if (instructions && CONFIG.geminiApiKey) {
      return await runAiLoop(task, instructions);
    }
    return { success: true, result: { pageTitle: await page.title(), pageUrl: page.url(), instructions }, screenshot: await takeScreenshot() };
  },

  async ai_task(task) {
    const { instruction, startUrl, maxSteps } = task.params;
    if (!CONFIG.geminiApiKey) throw new Error('GEMINI_API_KEY not set — AI tasks require Gemini');
    if (!instruction) throw new Error('instruction is required');
    await ensureBrowser();
    if (startUrl) {
      sendStatus(task.id, 'Navigating to start URL...');
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
    }
    return await runAiLoop(task, instruction, maxSteps);
  },
};

// ── AI Vision Engine ────────────────────────────────────────────────

const DESTRUCTIVE_KEYWORDS = ['delete', 'remove', 'wipe', 'erase', 'destroy', 'reset', 'unenroll', 'unassign', 'clear all'];

const AI_SYSTEM_PROMPT = `You are a browser automation agent. You can see a screenshot of a web page and must decide the next action to accomplish the user's goal.

RULES:
- Respond with ONLY valid JSON, no markdown, no explanation
- Be precise about which element to interact with
- Use visible text labels, button names, or placeholder text to identify elements
- If you need to scroll to find something, say so
- When the task is fully complete, use the "done" action
- If something went wrong or you're stuck, use the "error" action
- NEVER perform destructive actions (delete, wipe, remove, erase) — use "confirm_destructive" instead
- If a page is loading or hasn't changed, use "wait" action

AVAILABLE ACTIONS (respond with JSON):
{ "action": "click", "target": "visible text or description of the element to click", "reasoning": "why" }
{ "action": "type", "target": "visible label or placeholder of the input field", "text": "text to type", "clear": true/false, "reasoning": "why" }
{ "action": "select", "target": "visible label of the dropdown", "value": "option text to select", "reasoning": "why" }
{ "action": "scroll", "direction": "down" or "up", "reasoning": "why" }
{ "action": "navigate", "url": "https://...", "reasoning": "why" }
{ "action": "wait", "seconds": 2, "reasoning": "why" }
{ "action": "done", "summary": "what was accomplished" }
{ "action": "error", "message": "what went wrong" }
{ "action": "confirm_destructive", "description": "what destructive action was requested", "reasoning": "why this needs human approval" }`;

async function askGemini(screenshotBase64, instruction, actionHistory) {
  const genAI = new GoogleGenerativeAI(CONFIG.geminiApiKey);
  const MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash'];
  let lastError = null;

  const historyText = actionHistory.length > 0
    ? '\n\nACTIONS TAKEN SO FAR:\n' + actionHistory.map((a, i) => `${i + 1}. ${a.action}: ${a.reasoning || a.summary || a.target || ''}`).join('\n')
    : '';

  const userPrompt = `GOAL: ${instruction}${historyText}

Look at the screenshot and decide the NEXT action. Respond with ONLY valid JSON.`;

  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: AI_SYSTEM_PROMPT,
        generationConfig: { maxOutputTokens: 1024 }
      });
      const result = await Promise.race([
        model.generateContent([
          userPrompt,
          { inlineData: { mimeType: 'image/png', data: screenshotBase64 } }
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout')), 30000))
      ]);
      const text = result.response.text().trim();
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      const cleaned = jsonMatch[1].trim();
      return JSON.parse(cleaned);
    } catch (e) {
      lastError = e;
      if (e.message.includes('404') || e.message.includes('not found')) continue;
      if (e instanceof SyntaxError) {
        log(`  ⚠ AI returned invalid JSON, retrying with next model...`);
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

async function findAndClickElement(description) {
  // Strategy 1: Try getByRole with name
  for (const role of ['button', 'link', 'menuitem', 'tab']) {
    try {
      const el = page.getByRole(role, { name: new RegExp(escapeRegex(description), 'i') });
      if (await el.count() > 0) { await el.first().click(); return true; }
    } catch {}
  }
  // Strategy 2: Try getByText
  try {
    const el = page.getByText(description, { exact: false });
    if (await el.count() > 0) { await el.first().click(); return true; }
  } catch {}
  // Strategy 3: Scan all clickable elements for matching text
  try {
    const elements = await page.$$('a, button, input[type="submit"], input[type="button"], [role="button"], [onclick], label, select option');
    for (const el of elements) {
      const text = await el.textContent().catch(() => '');
      const value = await el.getAttribute('value').catch(() => '');
      const placeholder = await el.getAttribute('placeholder').catch(() => '');
      const ariaLabel = await el.getAttribute('aria-label').catch(() => '');
      const combined = [text, value, placeholder, ariaLabel].filter(Boolean).join(' ').toLowerCase();
      if (combined.includes(description.toLowerCase())) {
        await el.click();
        return true;
      }
    }
  } catch {}
  // Strategy 4: Try CSS-like selectors if description looks like one
  if (description.startsWith('#') || description.startsWith('.') || description.includes('[')) {
    try { await page.click(description); return true; } catch {}
  }
  return false;
}

async function findAndTypeElement(description, text, clear) {
  // Strategy 1: getByLabel
  try {
    const el = page.getByLabel(new RegExp(escapeRegex(description), 'i'));
    if (await el.count() > 0) { if (clear) await el.first().clear(); await el.first().fill(text); return true; }
  } catch {}
  // Strategy 2: getByPlaceholder
  try {
    const el = page.getByPlaceholder(new RegExp(escapeRegex(description), 'i'));
    if (await el.count() > 0) { if (clear) await el.first().clear(); await el.first().fill(text); return true; }
  } catch {}
  // Strategy 3: Scan inputs
  try {
    const inputs = await page.$$('input, textarea, [contenteditable]');
    for (const el of inputs) {
      const placeholder = await el.getAttribute('placeholder').catch(() => '');
      const name = await el.getAttribute('name').catch(() => '');
      const ariaLabel = await el.getAttribute('aria-label').catch(() => '');
      const id = await el.getAttribute('id').catch(() => '');
      const combined = [placeholder, name, ariaLabel, id].filter(Boolean).join(' ').toLowerCase();
      if (combined.includes(description.toLowerCase())) {
        if (clear) await el.fill('');
        await el.fill(text);
        return true;
      }
    }
  } catch {}
  return false;
}

async function findAndSelectElement(description, value) {
  try {
    const selects = await page.$$('select');
    for (const sel of selects) {
      const name = await sel.getAttribute('name').catch(() => '');
      const ariaLabel = await sel.getAttribute('aria-label').catch(() => '');
      const id = await sel.getAttribute('id').catch(() => '');
      const combined = [name, ariaLabel, id].filter(Boolean).join(' ').toLowerCase();
      if (combined.includes(description.toLowerCase())) {
        await sel.selectOption({ label: value });
        return true;
      }
    }
    // Try by preceding label text
    const labels = await page.$$('label');
    for (const label of labels) {
      const text = await label.textContent().catch(() => '');
      if (text.toLowerCase().includes(description.toLowerCase())) {
        const forId = await label.getAttribute('for').catch(() => '');
        if (forId) {
          await page.selectOption('#' + forId, { label: value });
          return true;
        }
      }
    }
  } catch {}
  return false;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runAiLoop(task, instruction, maxSteps) {
  const stepLimit = maxSteps || CONFIG.aiMaxSteps;
  const actionHistory = [];
  let lastError = null;

  sendStatus(task.id, `🤖 AI task started: "${instruction.substring(0, 80)}${instruction.length > 80 ? '...' : ''}"`);

  for (let step = 1; step <= stepLimit; step++) {
    // Take screenshot
    const screenshot = await takeScreenshot();
    if (!screenshot) throw new Error('Failed to take screenshot');

    // Ask Gemini what to do
    sendStatus(task.id, `🤖 Step ${step}/${stepLimit}: Analyzing page...`);
    let aiAction;
    try {
      aiAction = await askGemini(screenshot, instruction, actionHistory);
    } catch (e) {
      lastError = e;
      sendStatus(task.id, `⚠ AI error: ${e.message}`);
      // Retry once after a brief wait
      await page.waitForTimeout(2000);
      try { aiAction = await askGemini(screenshot, instruction, actionHistory); } catch (e2) { throw e2; }
    }

    log(`  AI step ${step}: ${JSON.stringify(aiAction)}`);
    actionHistory.push(aiAction);

    // Execute the action
    switch (aiAction.action) {
      case 'done':
        sendStatus(task.id, `✅ AI complete: ${aiAction.summary}`);
        return { success: true, result: { summary: aiAction.summary, steps: actionHistory.length, pageUrl: page.url() }, screenshot };

      case 'error':
        sendStatus(task.id, `❌ AI error: ${aiAction.message}`);
        return { success: false, error: aiAction.message, result: { steps: actionHistory.length }, screenshot };

      case 'confirm_destructive':
        sendStatus(task.id, `⚠️ BLOCKED: Destructive action needs approval — ${aiAction.description}`);
        return {
          success: false,
          error: `Destructive action blocked: ${aiAction.description}. Re-submit with explicit confirmation.`,
          result: { blocked: true, description: aiAction.description, steps: actionHistory.length },
          screenshot
        };

      case 'click':
        sendStatus(task.id, `🤖 Step ${step}: Clicking "${aiAction.target}"`);
        // Check for destructive intent
        if (DESTRUCTIVE_KEYWORDS.some(kw => (aiAction.target + ' ' + (aiAction.reasoning || '')).toLowerCase().includes(kw))) {
          sendStatus(task.id, `⚠️ BLOCKED: Refusing to click destructive element "${aiAction.target}"`);
          return { success: false, error: `Blocked destructive click on "${aiAction.target}"`, screenshot };
        }
        const clicked = await findAndClickElement(aiAction.target);
        if (!clicked) {
          sendStatus(task.id, `⚠ Could not find "${aiAction.target}" — asking AI to try again`);
          actionHistory[actionHistory.length - 1].failed = true;
        }
        await page.waitForTimeout(1500);
        break;

      case 'type':
        sendStatus(task.id, `🤖 Step ${step}: Typing into "${aiAction.target}"`);
        const typed = await findAndTypeElement(aiAction.target, aiAction.text, aiAction.clear);
        if (!typed) {
          sendStatus(task.id, `⚠ Could not find input "${aiAction.target}" — asking AI to try again`);
          actionHistory[actionHistory.length - 1].failed = true;
        }
        await page.waitForTimeout(500);
        break;

      case 'select':
        sendStatus(task.id, `🤖 Step ${step}: Selecting "${aiAction.value}" in "${aiAction.target}"`);
        const selected = await findAndSelectElement(aiAction.target, aiAction.value);
        if (!selected) {
          sendStatus(task.id, `⚠ Could not find dropdown "${aiAction.target}" — asking AI to try again`);
          actionHistory[actionHistory.length - 1].failed = true;
        }
        await page.waitForTimeout(500);
        break;

      case 'scroll':
        sendStatus(task.id, `🤖 Step ${step}: Scrolling ${aiAction.direction}`);
        await page.mouse.wheel(0, aiAction.direction === 'up' ? -500 : 500);
        await page.waitForTimeout(1000);
        break;

      case 'navigate':
        sendStatus(task.id, `🤖 Step ${step}: Navigating to ${aiAction.url}`);
        await page.goto(aiAction.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        break;

      case 'wait':
        sendStatus(task.id, `🤖 Step ${step}: Waiting ${aiAction.seconds || 2}s...`);
        await page.waitForTimeout((aiAction.seconds || 2) * 1000);
        break;

      default:
        sendStatus(task.id, `⚠ Unknown AI action: ${aiAction.action}`);
        break;
    }
  }

  sendStatus(task.id, `⚠ AI reached step limit (${stepLimit})`);
  return {
    success: false,
    error: `Reached maximum steps (${stepLimit}) without completing the task`,
    result: { steps: actionHistory.length, lastAction: actionHistory[actionHistory.length - 1] },
    screenshot: await takeScreenshot()
  };
}

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
console.log('  Gemini:   ' + (CONFIG.geminiApiKey ? '✓ AI vision enabled' : '✗ not set (AI tasks disabled)'));
console.log('');
connect();
