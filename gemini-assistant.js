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

  // Webbing device stats
  try {
    const cache = dataSources.getWebbingCache();
    const active = cache.filter(d => d.StatusID === 3).length;
    const suspended = cache.filter(d => d.StatusID === 4).length;
    const inactive = cache.filter(d => d.StatusID === 2).length;

    // Branch breakdown (top 20 by device count)
    const branchMap = {};
    for (const d of cache) {
      const name = d.BranchName || 'Unknown';
      if (!branchMap[name]) branchMap[name] = { total: 0, active: 0, suspended: 0 };
      branchMap[name].total++;
      if (d.StatusID === 3) branchMap[name].active++;
      if (d.StatusID === 4) branchMap[name].suspended++;
    }
    const topBranches = Object.entries(branchMap)
      .sort((a, b) => b[1].active - a[1].active)
      .slice(0, 20)
      .map(([name, stats]) => ({ name, ...stats }));

    ctx.webbingDevices = {
      total: cache.length,
      active,
      suspended,
      inactive,
      lastSync: dataSources.getWebbingCacheTime(),
      topBranches
    };
  } catch (e) {
    ctx.webbingDevices = { error: e.message };
  }

  // SimpleMDM stats
  try {
    const mdmCache = dataSources.getSimpleMdmCache();
    const accounts = {};
    for (const [acctId, devices] of Object.entries(mdmCache)) {
      accounts[acctId] = { deviceCount: devices.length };
    }
    ctx.simpleMdm = {
      accounts,
      totalDevices: Object.values(mdmCache).reduce((sum, devs) => sum + devs.length, 0),
      lastSync: dataSources.getSimpleMdmCacheTime()
    };
  } catch (e) {
    ctx.simpleMdm = { error: e.message };
  }

  // Active share tokens (Pulse links)
  try {
    const tokens = dataSources.getShareTokens();
    const activeTokens = Object.entries(tokens).map(([token, data]) => ({
      orderId: data.orderId,
      createdBy: data.createdBy,
      expiresAt: data.expiresAt,
      totalUsageGb: data.cachedUsage ? (data.cachedUsage.totalUsageBytes / (1024 * 1024 * 1024)).toFixed(2) : null,
      totalAllocationGb: data.cachedUsage ? (data.cachedUsage.totalAllocationBytes / (1024 * 1024 * 1024)).toFixed(1) : null,
      deviceCount: data.cachedUsage ? data.cachedUsage.deviceCount : null,
      usagePercent: data.cachedUsage && data.cachedUsage.totalAllocationBytes > 0
        ? ((data.cachedUsage.totalUsageBytes / data.cachedUsage.totalAllocationBytes) * 100).toFixed(1) + '%'
        : null
    }));
    ctx.pulseLinks = {
      count: activeTokens.length,
      links: activeTokens
    };
  } catch (e) {
    ctx.pulseLinks = { error: e.message };
  }

  // DCR submissions
  try {
    const subs = dataSources.getDcrSubmissions();
    const pending = subs.filter(s => s.status === 'pending');
    const inProgress = subs.filter(s => s.status === 'in_progress');
    const completed = subs.filter(s => s.status === 'completed');
    const recent = subs.slice(0, 10).map(s => ({
      id: s.id,
      orderNumber: s.orderNumber,
      company: s.company,
      eventName: s.eventName,
      status: s.status,
      timestamp: s.timestamp,
      appCount: s.apps ? s.apps.length : 0,
      fileCount: s.files ? s.files.length : 0
    }));

    ctx.dcrRequests = {
      total: subs.length,
      pending: pending.length,
      inProgress: inProgress.length,
      completed: completed.length,
      recent
    };
  } catch (e) {
    ctx.dcrRequests = { error: e.message };
  }

  ctx.currentTime = new Date().toISOString();
  return ctx;
}

const SYSTEM_PROMPT = `You are Fello AI, an intelligent operations assistant for the Fello Command Center.

## About Fello
Fello is an event technology company that rents iPads, hotspots, and connectivity solutions to businesses for events, conferences, trade shows, and more. Key systems:

- **Webbing IoT Platform**: Manages SIM cards and cellular lines. Devices have statuses: Active (StatusID 3), Suspended (4), Inactive (2). Organized into "branches" by order number.
- **SimpleMDM**: Mobile device management for iPads. Devices are organized into groups named by order number (e.g., "FE12997 - Ali Forney Center").
- **IMS (Inventory Management)**: Tracks orders, line items, customers, rental dates.
- **Fello Pulse**: Customer-facing data usage dashboards shared via unique links (share tokens).
- **DCR (Device Configuration Requests)**: Form submissions from customers specifying app installs, wallpapers, Wi-Fi configs, lockdown modes, etc.

## Your Role
- Answer questions about current operations using the real-time data provided
- Identify issues proactively (data usage warnings, mismatched device counts, pending DCRs)
- Provide actionable recommendations
- Help draft customer communications
- Summarize fleet status and order health

## Guidelines
- Be concise and direct — this is an internal ops tool, not customer-facing
- Use bullet points, tables, and bold text for readability
- When citing numbers, always specify the source (e.g., "from Webbing cache", "from Pulse data")
- Flag any data usage over 80% as a warning, over 95% as critical
- If data is unavailable, say so clearly — don't guess
- Current time is provided in the context data`;

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

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT
  });

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

  const chatSession = model.startChat({ history: geminiHistory });

  try {
    const result = await chatSession.sendMessage(userMessage);
    return result.response.text();
  } catch (e) {
    console.error('[AI] Gemini API error:', e.message);
    if (e.message.includes('429') || e.message.includes('RESOURCE_EXHAUSTED')) {
      throw new Error('Rate limit reached. Please wait a moment and try again.');
    }
    throw new Error('AI service error: ' + e.message);
  }
}

module.exports = { init, isConfigured, chat, buildContext };
