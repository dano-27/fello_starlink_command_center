/**
 * Fello AI Operations Assistant — Gemini Integration
 * Provides context-aware AI chat using Google's Gemini API
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;
let configured = false;

// Data source references (injected from server.js)
let dataSources = {
  getWebbingCache: () => [],
  getSimpleMdmCache: () => ({}),
  getShareTokens: () => ({}),
  getDcrSubmissions: () => [],
  getWebbingCacheTime: () => null,
  getSimpleMdmCacheTime: () => null
};

/**
 * Initialize the assistant with API key and data source references
 */
function init(apiKey, sources) {
  if (!apiKey) {
    console.log('[AI] No GEMINI_API_KEY set — assistant disabled');
    return;
  }
  try {
    genAI = new GoogleGenerativeAI(apiKey);
    configured = true;
    console.log('[AI] Gemini assistant initialized ✓');
  } catch (e) {
    console.error('[AI] Failed to initialize Gemini:', e.message);
  }
  if (sources) dataSources = { ...dataSources, ...sources };
}

function isConfigured() {
  return configured;
}

/**
 * Build a real-time context snapshot from all data sources
 */
function buildContext() {
  const ctx = {};
  const now = new Date();

  // Webbing device stats
  try {
    const cache = dataSources.getWebbingCache();
    const active = cache.filter(d => d.StatusID === 3).length;
    const suspended = cache.filter(d => d.StatusID === 4).length;
    const inactive = cache.filter(d => d.StatusID === 2).length;

    // Branch breakdown — ALL branches with active devices
    const branchMap = {};
    for (const d of cache) {
      const name = d.BranchName || 'Unknown';
      if (!branchMap[name]) branchMap[name] = { total: 0, active: 0, suspended: 0, branchId: d.BranchID };
      branchMap[name].total++;
      if (d.StatusID === 3) branchMap[name].active++;
      if (d.StatusID === 4) branchMap[name].suspended++;
    }

    ctx.webbingDevices = {
      total: cache.length, active, suspended, inactive,
      lastSync: dataSources.getWebbingCacheTime(),
      branches: branchMap
    };
  } catch (e) {
    ctx.webbingDevices = { error: e.message };
  }

  // SimpleMDM stats
  try {
    const mdmCache = dataSources.getSimpleMdmCache();
    const mdmGroups = {};
    let totalMdm = 0;
    for (const [acctId, devices] of Object.entries(mdmCache)) {
      for (const d of devices) {
        // Extract order prefix from device name (e.g., "SQ14315 (1)" → "SQ14315")
        const nameMatch = (d.name || '').match(/^([A-Z]{2,4}\d+)/i);
        if (nameMatch) {
          const order = nameMatch[1].toUpperCase();
          if (!mdmGroups[order]) mdmGroups[order] = { count: 0, account: acctId };
          mdmGroups[order].count++;
        }
        totalMdm++;
      }
    }
    ctx.simpleMdm = { totalDevices: totalMdm, lastSync: dataSources.getSimpleMdmCacheTime(), orderGroups: mdmGroups };
  } catch (e) {
    ctx.simpleMdm = { error: e.message };
  }

  // Active share tokens (Pulse links) with usage data
  try {
    const tokens = dataSources.getShareTokens();
    const pulseOrders = {};
    for (const [token, data] of Object.entries(tokens)) {
      const usage = data.cachedUsage || {};
      const totalBytes = usage.totalUsageBytes || 0;
      const allocBytes = usage.totalAllocationBytes || 0;
      const pct = allocBytes > 0 ? (totalBytes / allocBytes * 100) : null;
      pulseOrders[data.orderId] = {
        createdBy: data.createdBy,
        expiresAt: data.expiresAt,
        daysUntilExpiry: data.expiresAt ? Math.round((new Date(data.expiresAt) - now) / 86400000) : null,
        usageGb: (totalBytes / (1024 ** 3)).toFixed(2),
        allocationGb: (allocBytes / (1024 ** 3)).toFixed(1),
        usagePercent: pct !== null ? pct.toFixed(1) : null,
        deviceCount: usage.deviceCount || null,
        riskLevel: pct >= 95 ? 'CRITICAL' : pct >= 80 ? 'WARNING' : pct !== null ? 'OK' : 'NO_DATA'
      };
    }
    ctx.pulseOrders = pulseOrders;
  } catch (e) {
    ctx.pulseOrders = { error: e.message };
  }

  // DCR submissions
  try {
    const subs = dataSources.getDcrSubmissions();
    const dcrByOrder = {};
    for (const s of subs) {
      const order = s.orderNumber || 'UNKNOWN';
      if (!dcrByOrder[order]) dcrByOrder[order] = { pending: 0, in_progress: 0, completed: 0, latest: null, company: s.company, eventName: s.eventName };
      dcrByOrder[order][s.status || 'pending']++;
      if (!dcrByOrder[order].latest || new Date(s.timestamp) > new Date(dcrByOrder[order].latest)) {
        dcrByOrder[order].latest = s.timestamp;
      }
    }
    ctx.dcrByOrder = dcrByOrder;
  } catch (e) {
    ctx.dcrByOrder = { error: e.message };
  }

  // ── Cross-Reference: Unified Order Health ──
  // Build a per-order view combining Webbing, MDM, Pulse, and DCR data
  try {
    const allOrders = new Set();
    if (ctx.pulseOrders && typeof ctx.pulseOrders === 'object') Object.keys(ctx.pulseOrders).forEach(o => allOrders.add(o));
    if (ctx.dcrByOrder && typeof ctx.dcrByOrder === 'object') Object.keys(ctx.dcrByOrder).forEach(o => allOrders.add(o));

    const orderHealth = {};
    for (const orderId of allOrders) {
      const pulse = ctx.pulseOrders?.[orderId] || null;
      const dcr = ctx.dcrByOrder?.[orderId] || null;
      const branch = ctx.webbingDevices?.branches?.[orderId] || null;
      const mdm = ctx.simpleMdm?.orderGroups?.[orderId] || null;

      const issues = [];
      // Data usage warnings
      if (pulse?.riskLevel === 'CRITICAL') issues.push('🚨 Data usage at ' + pulse.usagePercent + '% — approaching limit');
      else if (pulse?.riskLevel === 'WARNING') issues.push('⚠️ Data usage at ' + pulse.usagePercent + '% — monitor closely');
      // Expiring soon
      if (pulse && pulse.daysUntilExpiry != null && pulse.daysUntilExpiry <= 2 && pulse.daysUntilExpiry >= 0) issues.push('⏰ Pulse link expires in ' + pulse.daysUntilExpiry + ' day(s)');
      if (pulse && pulse.daysUntilExpiry != null && pulse.daysUntilExpiry < 0) issues.push('❌ Pulse link EXPIRED ' + Math.abs(pulse.daysUntilExpiry) + ' day(s) ago');
      // Count mismatches
      if (branch && mdm && branch.active !== mdm.count) issues.push('📊 Device mismatch: ' + branch.active + ' active SIMs vs ' + mdm.count + ' iPads in MDM');
      // Pending DCRs
      if (dcr && dcr.pending > 0) issues.push('📋 ' + dcr.pending + ' pending DCR(s) — customer waiting');

      orderHealth[orderId] = {
        company: dcr?.company || null,
        eventName: dcr?.eventName || null,
        webbingSims: branch ? { active: branch.active, suspended: branch.suspended, total: branch.total } : null,
        mdmDevices: mdm?.count || null,
        dataUsage: pulse ? { usageGb: pulse.usageGb, allocationGb: pulse.allocationGb, percent: pulse.usagePercent, risk: pulse.riskLevel } : null,
        pulseExpiry: pulse?.expiresAt || null,
        dcrStatus: dcr ? { pending: dcr.pending, inProgress: dcr.in_progress, completed: dcr.completed } : null,
        issues
      };
    }
    ctx.orderHealth = orderHealth;
  } catch (e) {
    ctx.orderHealthError = e.message;
  }

  // System health
  ctx.systemHealth = {
    webbingSynced: !!dataSources.getWebbingCacheTime(),
    mdmSynced: !!dataSources.getSimpleMdmCacheTime(),
    webbingLastSync: dataSources.getWebbingCacheTime(),
    mdmLastSync: dataSources.getSimpleMdmCacheTime()
  };
  ctx.currentTime = now.toISOString();

  // Fleet summary (compact — don't send raw branch/device lists)
  ctx.fleetSummary = {
    totalWebbingSims: ctx.webbingDevices?.total || 0,
    activeWebbingSims: ctx.webbingDevices?.active || 0,
    suspendedWebbingSims: ctx.webbingDevices?.suspended || 0,
    totalMdmDevices: ctx.simpleMdm?.totalDevices || 0,
    totalPulseLinks: ctx.pulseOrders ? Object.keys(ctx.pulseOrders).length : 0,
    totalDcrOrders: ctx.dcrByOrder ? Object.keys(ctx.dcrByOrder).length : 0
  };

  // Remove raw data — orderHealth already has everything cross-referenced
  delete ctx.webbingDevices;
  delete ctx.simpleMdm;
  delete ctx.pulseOrders;
  delete ctx.dcrByOrder;

  // Inventory + forecast summary (if cached)
  try {
    const invCache = dataSources.getInventoryCache?.();
    if (invCache) {
      ctx.inventory = {
        totalModels: invCache.summary.totalModels,
        totalUnits: invCache.summary.totalUnits,
        totalDeployed: invCache.summary.totalDeployed,
        totalAvailable: invCache.summary.totalAvailable,
        utilization: invCache.summary.utilization + '%',
        shortageCount: invCache.summary.shortageCount || 0,
        // Items needing attention
        alerts: invCache.products
          .filter(p => p.status === 'low' || p.status === 'watch' || p.status === 'shortage')
          .map(p => ({
            name: p.name, total: p.totalStock, deployed: p.deployed,
            available: p.available, utilization: p.utilization + '%', status: p.status,
            demand30: p.forecast?.demand30 || 0,
            returns30: p.forecast?.returns30 || 0,
            projected30: p.forecast?.projected30 ?? p.available,
            upcomingOrders: (p.forecast?.upcomingOrders || []).map(o => o.id + ' (' + o.customer + ', ' + o.qty + 'x, ' + o.start + ')')
          })),
        // Shortage forecasts
        shortages: (invCache.forecast?.shortages || [])
      };
    }
  } catch (e) {
    // Inventory not loaded yet — skip
  }

  return ctx;
}

const SYSTEM_PROMPT = `You are Fello AI — a senior operations analyst embedded in Fello's Command Center.

## About Fello
Fello rents iPads, hotspots, Starlink terminals, and cellular connectivity for events. Every rental is an "order" (e.g., SQ14315, FE16443). The ops team manages device provisioning, data usage monitoring, customer configuration requests (DCRs), and equipment readiness.

## Your Audience
You are talking to the **ops team** — they manage orders, contact customers, configure devices in SimpleMDM, and manage SIMs in Webbing. They do NOT write code, manage servers, or debug APIs. Never suggest engineering fixes, code changes, API key checks, or "hotfixes." Only suggest things they can do in the Command Center, SimpleMDM portal, Webbing portal, or by contacting customers.

## Data You Receive
- **fleetSummary**: High-level counts (total SIMs, active SIMs, total iPads, Pulse links, DCR orders)
- **orderHealth**: Per-order cross-reference combining Webbing SIMs, MDM iPads, Pulse usage data, DCR status, and pre-computed issues
- **systemHealth**: Whether Webbing and MDM caches have synced
- **inventory**: Equipment stock levels — totalUnits, totalDeployed, totalAvailable, utilization%. Includes alerts (low/watch/shortage items) with 30-day demand forecasts, return pipeline, projected availability, and the specific upcoming orders driving demand. Shortage items have negative projected30 meaning demand exceeds supply.

## Understanding Null Data
Null usage data is **normal and common** — it does NOT mean something is broken. Common reasons:
- The server recently restarted (Railway redeploy) and caches are rebuilding (takes ~10 min)
- A Pulse link was just created and usage hasn't been fetched yet
- The order doesn't have Webbing SIMs assigned yet
**Do NOT treat null data as an emergency.** Just note "usage data not yet available" and move on to what IS available.

## How to Analyze

**Cross-reference orderHealth.** Each order has:
- \`webbingSims\`: active/suspended/total SIM counts (null = no Webbing branch for this order)
- \`mdmDevices\`: iPad count in SimpleMDM (null = no MDM group matched)
- \`dataUsage\`: usage vs allocation with risk level (null = not yet available)
- \`dcrStatus\`: pending/in-progress/completed config requests
- \`issues\`: pre-computed alerts (mismatches, expiring links, etc.)

**Focus on what matters:**
1. Orders with **pending DCRs** — customer is waiting for their iPads to be configured
2. Orders where **SIM count ≠ iPad count** — provisioning gap to investigate
3. Orders with **high data usage** (WARNING/CRITICAL) — may need to upsell or alert customer
4. Pulse links **expiring soon** — customer will lose their dashboard

**Actionable recommendations only.** Examples of good actions:
- "Contact St. Paul Kirchenfest about their 3 pending DCRs — they submitted duplicates, confirm which config they want"
- "Check SQ14315 in Webbing — 24 SIMs active but only 18 iPads in MDM. 6 SIMs might be for hotspots, or 6 iPads need to be enrolled"
- "SH6120 data usage at 87% — reach out to GSWS Columbus about adding more data before their event"

Bad actions (never suggest these):
- "Force API resync" / "Check API keys" / "Apply hotfix" / "Debug the integration"

## Formatting
- Lead with the most important finding
- Use ### for sections, **bold** for key info
- Tables for comparing multiple orders
- Keep it concise — ops managers are busy
- Never say "Based on the data provided" — just get to it`;

/**
 * Chat with the AI assistant
 * @param {string} userMessage - The user's message
 * @param {Array} history - Previous conversation turns [{role: 'user'|'model', content: string}]
 * @returns {Promise<string>} The assistant's response
 */
async function chat(userMessage, history = []) {
  if (!configured || !genAI) {
    throw new Error('AI assistant not configured. Set GEMINI_API_KEY environment variable.');
  }

  // Build fresh context
  const context = buildContext();
  const contextJson = JSON.stringify(context, null, 2);
  console.log(`[AI] Context size: ${(contextJson.length / 1024).toFixed(1)}KB, orders: ${Object.keys(context.orderHealth || {}).length}`);

  // Convert history to Gemini format
  const geminiHistory = [];

  // First message includes context
  geminiHistory.push({
    role: 'user',
    parts: [{ text: `Here is the current real-time operational data:\n\n\`\`\`json\n${contextJson}\n\`\`\`\n\nUse this data to answer my questions. Acknowledge briefly.` }]
  });
  geminiHistory.push({
    role: 'model',
    parts: [{ text: 'Got it — I have the latest operational snapshot loaded. How can I help?' }]
  });

  // Add conversation history
  for (const msg of history) {
    geminiHistory.push({
      role: msg.role === 'assistant' ? 'model' : msg.role,
      parts: [{ text: msg.content }]
    });
  }

  // Retry with exponential backoff
  const MAX_RETRIES = 2;
  const MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash'];
  let lastError = null;

  for (const modelName of MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_PROMPT,
          generationConfig: { maxOutputTokens: 4096 }
        });
        const chatSession = model.startChat({ history: geminiHistory });
        // 30-second timeout
        const result = await Promise.race([
          chatSession.sendMessage(userMessage),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out after 15s')), 15000))
        ]);
        return result.response.text();
      } catch (e) {
        lastError = e;
        // Model not found — skip to next model immediately
        if (e.message.includes('404') || e.message.includes('not found') || e.message.includes('Not Found')) {
          console.log(`[AI] ${modelName} not available, trying next model...`);
          break;
        }
        // Transient errors — retry with backoff
        const isRetryable = e.message.includes('503') || e.message.includes('429') || 
                           e.message.includes('RESOURCE_EXHAUSTED') || e.message.includes('overloaded') ||
                           e.message.includes('high demand') || e.message.includes('Service Unavailable') ||
                           e.message.includes('timed out');
        if (isRetryable && attempt < MAX_RETRIES - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`[AI] ${modelName} attempt ${attempt + 1} failed (${e.message.substring(0, 80)}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (isRetryable) {
          console.log(`[AI] ${modelName} exhausted retries, trying next model...`);
          break;
        }
        // Non-retryable, non-404 error
        console.error('[AI] Non-retryable error:', e.message);
        throw new Error('AI service error: ' + e.message);
      }
    }
  }

  console.error('[AI] All models and retries exhausted:', lastError?.message);
  throw new Error('AI service is temporarily busy. Please try again in a few seconds.');
}

module.exports = { init, isConfigured, chat, buildContext };
