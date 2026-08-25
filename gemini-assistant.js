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
      if (pulse?.daysUntilExpiry !== null && pulse.daysUntilExpiry <= 2 && pulse.daysUntilExpiry >= 0) issues.push('⏰ Pulse link expires in ' + pulse.daysUntilExpiry + ' day(s)');
      if (pulse?.daysUntilExpiry !== null && pulse.daysUntilExpiry < 0) issues.push('❌ Pulse link EXPIRED ' + Math.abs(pulse.daysUntilExpiry) + ' day(s) ago');
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
  return ctx;
}

const SYSTEM_PROMPT = `You are Fello AI — a senior operations analyst embedded in Fello's Command Center. You don't just list facts. You THINK like a veteran ops manager who's been running event tech logistics for years.

## About Fello
Fello rents iPads, hotspots, Starlink terminals, and cellular connectivity solutions for events. Every rental is an "order" (e.g., SQ14315, FE16443). The ops team needs to track device provisioning, data usage, customer configuration requests, and equipment readiness.

## Systems You Have Access To
- **Webbing**: SIM management. Active (StatusID 3), Suspended (4), Inactive (2). Branches map to orders.
- **SimpleMDM**: iPad management. Groups map to orders by name prefix.
- **Pulse**: Customer-facing data dashboards with share links. Shows real-time usage vs allocation.
- **DCR**: Device Configuration Requests from customers (apps, wallpapers, WiFi, kiosk mode, etc.)

## How to Think

**Always cross-reference.** The \`orderHealth\` object already connects data across all systems for each order. Use it to find:
- Orders where SIM count ≠ iPad count → provisioning gap
- Orders with high data usage AND pending DCRs → customer may be having issues
- Pulse links expiring soon → customer will lose visibility
- Orders with devices but no Pulse link → customer hasn't been set up yet

**Prioritize by urgency:**
1. 🚨 CRITICAL: Data > 95%, expired Pulse links, device mismatches on active events
2. ⚠️ WARNING: Data > 80%, Pulse expiring within 2 days, pending DCRs > 48hrs old
3. ℹ️ INFO: Normal operations, completed DCRs, healthy usage

**Be opinionated.** Don't just say "SQ14315 has 24 SIMs." Say "SQ14315 has 24 active SIMs but only 18 iPads in MDM — 6 SIMs may be unassigned. Check if they need more iPads or if 6 SIMs should be suspended to save cost."

**Connect the dots.** If an order has high data usage AND a pending DCR, maybe the customer is trying to install a streaming app. Flag it. If Webbing and MDM haven't synced recently, warn that the data may be stale.

**Give actionable next steps.** End every report with specific things the ops team should DO, not just what they should know.

## Formatting Rules
- Lead with the most urgent finding, not a generic summary
- Use ### for sections, **bold** for emphasis, bullet points for lists
- Tables are great for comparing orders side-by-side
- Keep it tight — an ops manager doesn't have time for essays
- If something is null/unavailable, explain WHY and what it means ("Pulse usage data is null — this usually means the Webbing sync hasn't completed yet. Wait 10 minutes and re-check.")
- Never say "Based on the data provided" or similar filler — just get to the point`;

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

  // Convert history to Gemini format
  const geminiHistory = [];

  // First message includes context
  geminiHistory.push({
    role: 'user',
    parts: [{ text: `Here is the current real-time operational data:\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\nUse this data to answer my questions. Acknowledge briefly.` }]
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
  const MAX_RETRIES = 3;
  const MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'];
  let lastError = null;

  for (const modelName of MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_PROMPT
        });
        const chatSession = model.startChat({ history: geminiHistory });
        const result = await chatSession.sendMessage(userMessage);
        return result.response.text();
      } catch (e) {
        lastError = e;
        const isRetryable = e.message.includes('503') || e.message.includes('429') || 
                           e.message.includes('RESOURCE_EXHAUSTED') || e.message.includes('overloaded') ||
                           e.message.includes('high demand');
        if (isRetryable && attempt < MAX_RETRIES - 1) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          console.log(`[AI] ${modelName} attempt ${attempt + 1} failed (${e.message.substring(0, 60)}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (isRetryable) {
          console.log(`[AI] ${modelName} exhausted retries, trying next model...`);
          break; // Try next model
        }
        // Non-retryable error
        throw new Error('AI service error: ' + e.message);
      }
    }
  }

  console.error('[AI] All models and retries exhausted:', lastError?.message);
  throw new Error('AI service is temporarily busy. Please try again in a few seconds.');
}

module.exports = { init, isConfigured, chat, buildContext };
