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
            demand: p.forecast?.demand || 0,
            returns: p.forecast?.returns || 0,
            projected: p.forecast?.projected ?? p.available,
            upcomingOrders: (p.forecast?.upcomingOrders || []).map(o => {
              const s = o.shipping || {};
              let desc = o.id + ' (' + o.customer + ', ' + o.qty + 'x, ' + o.start + ')';
              if (s.outboundSpeed) desc += ' [' + (s.carrier || 'UPS').toUpperCase() + ' ' + s.outboundSpeed + (s.eta ? ', ETA ' + s.eta : '') + (s.prepDays != null ? ', ' + s.prepDays + 'd prep' : '') + (s.city ? ', → ' + s.city + ' ' + s.state : '') + ']';
              return desc;
            })
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

const SYSTEM_PROMPT = `You are Fello AI — a high-level data analyst and strategic forecasting engine embedded in Fello's Command Center.

## Your Role
You don't just report data — you **analyze trends, identify patterns, predict constraints, and surface insights** the ops team wouldn't see by looking at numbers alone. Think like a VP of Operations who has access to every data point and can connect dots across orders, inventory, devices, and timelines.

## About Fello
Fello rents iPads, Square terminals, hotspots, Starlink terminals, and cellular connectivity for events. Every rental is an "order" (e.g., SQ14315, OR164). The ops team manages device provisioning, data usage monitoring, customer configuration requests (DCRs), and equipment readiness.

## Your Audience
The **ops team** — they manage orders, contact customers, configure devices in SimpleMDM, and manage SIMs in Webbing. They do NOT write code or manage servers. Never suggest engineering fixes, code changes, API key checks, or "hotfixes." Only suggest things they can do in the Command Center, SimpleMDM portal, Webbing portal, or by contacting customers.

## Data You Receive
- **fleetSummary**: High-level counts (total SIMs, active SIMs, total iPads, Pulse links, DCR orders)
- **orderHealth**: Per-order cross-reference combining Webbing SIMs, MDM iPads, Pulse usage data, DCR status, and pre-computed issues
- **systemHealth**: Whether Webbing and MDM caches have synced
- **inventory**: Equipment stock levels with demand forecasting. Includes:
  - Current: totalUnits, totalDeployed, totalAvailable, utilization%
  - Alerts: items flagged as low/watch/shortage with demand forecasts, return pipeline, projected availability
  - Shortages: items where projected stock goes negative — demand exceeds supply
  - Per-item: upcoming orders driving demand (order ID, customer, qty, dates)

## Analytical Framework — How to THINK

### 1. Pattern Recognition
- **Seasonal demand**: Look at order dates and volumes. Are certain equipment types consistently in high demand during specific periods?
- **Customer patterns**: Do repeat customers (same company across multiple orders) tend to need the same equipment mix? Flag when a returning customer's new order differs significantly.
- **Equipment velocity**: Which items move fastest? Which sit idle? High velocity + low stock = procurement alert.

### 2. Predictive Forecasting
- **Inventory constraints**: Cross-reference upcoming order demand against available stock. If 3 orders in the next 14 days all need Square Terminals and there are only 20 left, flag it NOW — not when it's too late.
- **Return pipeline**: Equipment coming back from ending orders can cover upcoming demand. Calculate: Available + Expected Returns - Upcoming Demand = Projected Position. Negative = shortage incoming.
- **Overlap analysis**: Two orders overlapping in time need separate equipment. 50 iPads available doesn't mean you can serve two 30-iPad orders that overlap.
- **Lead time risk**: Orders starting within 3 days with no checkouts yet are at risk of not shipping on time.

### 5. Shipping & Logistics Intelligence
Each upcoming order includes shipping data: carrier (UPS, FedEx), speed (GND=Ground, 2DA=2nd Day Air, 1DA=Next Day Air), outbound date, estimated arrival, destination city/state, and prep days (days between ship date and event start).
- **Transit time alerts**: Ground shipping (GND) typically takes 3-7 business days. If an order ships GND to a distant city with only 3 prep days, flag the risk — it may not arrive on time.
- **Prep day analysis**: prepDays = rental_start - outbound_date. Orders with < 3 prep days and Ground speed to a distant state are at risk. Recommend upgrading to 2DA or 1DA.
- **Return logistics**: inbound speed affects when equipment becomes available for the next order. Ground returns from distant cities take 5-7 days — don't count that equipment as "available" until the return window passes.
- **Regional patterns**: Orders to the West Coast from your warehouse take longer via Ground than Midwest orders. Factor destination into transit time estimates.

### 3. Cross-Reference Intelligence
- **Order-to-inventory**: When an order has 10 iPads on the rental but MDM only shows 6 enrolled → 4 iPads may not be provisioned yet. Is the order starting soon?
- **SIM-to-device mismatch**: SIM count ≠ iPad count → investigate. Could be hotspots, could be a provisioning gap.
- **DCR aging**: Pending DCRs older than 48 hours → customer is waiting. Flag by urgency.
- **Data usage trajectory**: If an order is at 80% data usage with 5 days left, will they hit the cap? Project based on current daily burn rate.

### 4. Proactive Risk Assessment
Always scan for these risks without being asked:
- 🔴 **Shortage risk**: Items where demand > available within any time window
- 🟡 **Provisioning gap**: Orders starting within 7 days that aren't fully checked out
- 🟡 **Overlapping demand**: Multiple orders needing the same equipment type in the same time window
- 🔵 **Return opportunities**: Equipment coming back soon that could be reallocated to pending orders
- ⚪ **Idle equipment**: High-stock items with 0 demand — potential overstock or miscategorization

## Understanding Null Data
Null usage data is **normal and common** — not an emergency. The server may have recently restarted (cache rebuilds in ~10 min), a Pulse link was just created, or the order doesn't have Webbing SIMs yet. Just note "data not yet available" and analyze what IS available.

## Response Style

**Lead with the insight, not the data.** 
- ❌ "There are 47 active orders and 92 inventory products"
- ✅ "3 confirmed orders starting this week need Square Terminals, but only 8 are available — you'll be 4 short unless the Armada Fair returns theirs by Wednesday"

**Quantify the impact.**
- ❌ "iPad stock is getting low"
- ✅ "iPad 8th Gen: 0 available, 12 needed across OR175 and OR174 next week. But 15 are due back from OR171 (ended Aug 24) — follow up on that return to unblock these orders"

**Connect the dots.**
- Don't just list issues — explain HOW they connect. "OR164 is active until Sep 8 with 4 Square Terminals, which means those units won't be available for OR175 (starting Aug 27, needs 4). You'll need to source from a different pool or check if OR164 can share."

**Recommend specific next steps.**
- Name the order, the customer, the equipment, and the action
- Prioritize by time urgency (orders starting soonest first)

## Formatting
- ### for sections, **bold** for key info
- Tables for comparing orders or equipment
- Use 🔴 🟡 🟢 for urgency levels
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

module.exports = { init, isConfigured, chat, buildContext, summarizeSession, askAudit, analyzeAgentStats, generateOrderBrief, generateProactiveAlerts, diagnoseDevice, generateTrainingTips };

/**
 * Generate an AI-powered summary of a user session
 */
async function summarizeSession(session) {
  if (!configured || !genAI) throw new Error('AI assistant not configured.');

  const taskDescriptions = (session.tasks || []).map(t => {
    const actions = (t.actions || []).map(a => {
      const desc = a.description || `${a.method} ${(a.path || '').replace('/api/', '')}`;
      let line = desc;
      if (a.isError) line += ' ❌ ERROR';
      if (a.isRetry) line += ' 🔁 RETRY';
      if (a.idleGapFormatted) line = `⏸️ ${a.idleGapFormatted} idle → ${line}`;
      return line;
    });
    return {
      target: t.orderId || 'General',
      duration: t.durationFormatted || '-',
      actionCount: t.actionCount || actions.length,
      errorCount: t.errorCount || 0,
      actions: actions.slice(0, 25)
    };
  });

  const sessionDesc = {
    agent: session.name || session.user, username: session.user,
    role: session.role || 'agent', loginTime: session.loginTime,
    logoutTime: session.logoutTime || '(still active)',
    duration: session.durationFormatted, totalActions: session.totalActions,
    taskCount: session.taskCount, errorCount: session.errorCount || 0,
    retryCount: session.retryCount || 0, ip: session.ip,
    tasks: taskDescriptions
  };

  const prompt = `Analyze this Command Center session and write a concise, insightful 2-4 sentence summary of what the user did. Be specific about orders they worked on, what actions they performed (lookups, SIM changes, device management, DCR submissions, etc.), and note anything unusual (errors, repeated actions, long idle times, retries).

Session data:
\`\`\`json
${JSON.stringify(sessionDesc, null, 2)}
\`\`\`

IMPORTANT: 
- Write in past tense, refer to the agent by first name
- Be specific: name order IDs, action types, and counts  
- Note workflow patterns: "looked up X then configured Y"
- Flag mistakes/issues: errors, retries (agent had to redo something), idle gaps (agent got stuck)
- Keep it to 2-4 sentences max
- Do NOT use bullet points — write flowing prose`;

  return await callGemini(prompt, 512);
}

/**
 * Natural language audit search — answer questions about the audit log
 */
async function askAudit(question, entries) {
  if (!configured || !genAI) throw new Error('AI assistant not configured.');

  const prompt = `You are an audit log analyst for Fello's Command Center. Answer the admin's question based on the audit data below.

The data shows recent actions by agents (employees) in the system. Each entry has:
- time: when it happened
- user: who did it
- action: what type (VIEW=read, POST=create, PUT/PATCH=update, DELETE=remove, LOGIN/LOGOUT)
- path: which API endpoint
- order: related order ID (if any)
- status: HTTP status (200=ok, 4xx/5xx=error)
- ms: how long it took
- detail: human-readable description

Audit entries (${entries.length} most recent):
\`\`\`json
${JSON.stringify(entries, null, 1)}
\`\`\`

Admin's question: "${question}"

RULES:
- Be specific: name agents, order IDs, timestamps, and counts
- If the question is about mistakes/errors, focus on status >= 400 entries
- If about performance, analyze timing (ms) and action counts
- If about a specific order, filter entries mentioning that order
- Format with markdown: headers, bold, tables where helpful
- Keep the answer concise but thorough
- If you can't find the answer in the data, say so clearly`;

  return await callGemini(prompt, 2048);
}

/**
 * AI-powered agent performance insights
 */
async function analyzeAgentStats(agents) {
  if (!configured || !genAI) throw new Error('AI assistant not configured.');

  const prompt = `Analyze these agent performance stats from Fello's Command Center and provide actionable insights for the operations manager.

Agent stats:
\`\`\`json
${JSON.stringify(agents, null, 2)}
\`\`\`

Provide analysis covering:
1. **Top Performers**: Who is most productive? What makes them stand out?
2. **Efficiency**: Compare avg action times. Who's fastest? Who might need help?
3. **Error Patterns**: High error rates could indicate training needs or system issues
4. **Task Mix**: Breakdown of what each agent focuses on (SIM changes, DCRs, device pushes, AI usage). Is the workload balanced?
5. **Recommendations**: Specific, actionable suggestions for the manager

RULES:
- Refer to agents by name (not username) when available
- Quantify everything — don't just say "good" or "slow", say "40% faster" or "3x more errors"
- Focus on insights the manager can ACT on
- Use markdown formatting: headers, bold, short paragraphs
- Keep it under 300 words`;

  return await callGemini(prompt, 2048);
}

/**
 * Smart Order Brief — instant AI-generated situational awareness when looking up an order
 */
async function generateOrderBrief(orderData) {
  if (!configured || !genAI) throw new Error('AI not configured.');

  const prompt = `You are an operations analyst at Fello, a rental equipment company. An agent just looked up an order. Generate a brief, actionable summary.

Order Data:
\`\`\`json
${JSON.stringify(orderData, null, 1)}
\`\`\`

Write a 2-4 sentence brief covering:
1. **Equipment status**: How many iPads/devices deployed vs matched vs active SIMs. Flag any unmatched.
2. **Data usage**: If usage data exists, current consumption vs cap, burn rate, days until cap hit.
3. **Issues**: Pending DCRs, offline Starlinks, unmatched devices, missing SIMs, upcoming deadlines.
4. **Action needed**: One specific thing the agent should do right now.

RULES:
- Write in present tense, concise prose, no bullets
- Bold the most critical numbers and order IDs
- If data is missing, don't make it up — just skip that aspect
- End with a specific actionable recommendation if any issues exist
- Keep it to 2-4 sentences max`;

  return await callGemini(prompt, 512);
}

/**
 * Proactive Alerts — cross-system health check surfacing urgent issues
 */
async function generateProactiveAlerts(snapshot) {
  if (!configured || !genAI) throw new Error('AI not configured.');

  const prompt = `You are an operations alert system for Fello, a rental equipment company. Analyze this cross-system snapshot and identify urgent issues that need attention RIGHT NOW.

System Snapshot:
\`\`\`json
${JSON.stringify(snapshot, null, 1)}
\`\`\`

Generate a JSON array of alerts. Each alert has:
- "level": "critical" (action needed today) | "warning" (action needed this week) | "info" (FYI)
- "icon": appropriate emoji
- "title": short 1-line summary (include order IDs, counts, dates)
- "detail": 1 sentence explanation of why this matters and what to do
- "link": the best Command Center URL to address this (e.g. "/lookup/?q=SQ14315", "/inventory/", "/orders/")

Focus on:
- Orders starting soon with incomplete equipment checkout
- Data usage approaching caps (>80%)
- Pending DCRs older than 24 hours
- Inventory shortages for upcoming orders
- Starlink terminals offline
- Equipment returns overdue

Return ONLY valid JSON array, no markdown. Sort by priority (critical first). Max 8 alerts. If nothing is urgent, return an empty array [].`;

  const raw = await callGemini(prompt, 2048);
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return [{ level: 'info', icon: '✅', title: 'All systems operational', detail: raw.substring(0, 200), link: '/' }];
  }
}

/**
 * Device Troubleshooter — cross-reference MDM, SIM, coverage, and usage to diagnose issues
 */
async function diagnoseDevice(deviceData) {
  if (!configured || !genAI) throw new Error('AI not configured.');

  const prompt = `You are a senior tech support engineer at Fello. Diagnose this device issue using all available data.

Device Data:
\`\`\`json
${JSON.stringify(deviceData, null, 1)}
\`\`\`

Analyze:
1. **MDM Status**: Is the device checking in? When was it last seen? Battery level? OS up to date?
2. **SIM/Connectivity**: Is the SIM active? What carrier? Signal strength at the location?
3. **Coverage**: Compare signal strengths across carriers at the event location. Is the current carrier the best option?
4. **Usage**: Is the device consuming data? Has it gone dark recently?
5. **Root Cause**: What's most likely wrong?

Provide:
1. A 1-sentence diagnosis (bold the key finding)
2. Numbered action steps from most likely to fix the issue to least likely (max 4 steps)
3. If the device needs replacement, say so clearly

RULES:
- Be specific: name carriers, signal dBm values, dates, device IDs
- Think like a technician — specific steps, not vague advice
- If data is missing for some aspect, skip it
- Keep total response under 150 words`;

  return await callGemini(prompt, 768);
}

/**
 * Training Tips — analyze audit patterns to generate actionable training recommendations
 */
async function generateTrainingTips(auditSummary) {
  if (!configured || !genAI) throw new Error('AI not configured.');

  const prompt = `You are a training manager at Fello. Analyze these audit log patterns from the past 7 days and generate specific, actionable training tips for the ops team.

Audit Summary:
\`\`\`json
${JSON.stringify(auditSummary, null, 1)}
\`\`\`

Generate 3-5 training tips. Each tip should:
1. Reference a SPECIFIC pattern from the data (e.g. "SIM activations fail 18% of the time")
2. Explain WHY it happens (e.g. "usually because the wrong branch is selected")
3. Give a SPECIFIC fix (e.g. "always verify branch name matches order ID before activating")

Format as markdown with:
### 💡 Tip Title
The specific insight with **bold numbers** and a clear recommendation.

RULES:
- Only reference patterns that actually appear in the data — don't invent problems
- Include specific percentages, counts, and agent names where relevant
- Focus on the 3-5 most impactful improvements
- If the data shows no issues, say the team is performing well and highlight what's working`;

  return await callGemini(prompt, 1536);
}

/**
 * Shared Gemini call with model fallback and timeout
 */
async function callGemini(prompt, maxTokens = 1024) {
  const MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash'];
  let lastError = null;

  for (const modelName of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { maxOutputTokens: maxTokens }
        });
        const result = await Promise.race([
          model.generateContent(prompt),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), 25000))
        ]);
        return result.response.text();
      } catch (e) {
        lastError = e;
        if (e.message.includes('404') || e.message.includes('not found')) { attempt = 99; break; }
        if (attempt < 1 && (e.message.includes('503') || e.message.includes('429') || e.message.includes('timed out') || e.message.includes('Timed out'))) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        break;
      }
    }
  }
  throw new Error('AI service unavailable: ' + (lastError?.message || 'unknown'));
}
