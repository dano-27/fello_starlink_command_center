(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    token: null,
    clientId: null,
    clientSecret: null,
    usageResults: [],       // raw API results (ServiceLineDataUsageForBillingCycles[])
    deviceMap: {},          // serviceLineNumber → { dishSerial, kitSerial, utNickname, slNickname, userTerminalId }
    currentRange: 'current', // 'current' | '3months' | '6months' | 'custom'
    searchQuery: '',
    includeInactive: false,
    refreshTimer: null,
    refreshCountdown: null,
    tokenRefreshTimer: null,
    nextRefreshAt: null,
    // Router config state
    activeTab: 'data-usage',
    routerConfigs: [],       // all saved configs from API
    routerDefaults: {},      // routerId → configId (per-router saved defaults, from localStorage)
    routerList: [],          // routers with their current config assignments
    selectedRouterIds: new Set(),
    rcLoaded: false,         // whether router config data has been loaded
    rcSortCol: null,         // current sort column: 'terminal' | 'default' | 'ssid' | 'status'
    rcSortDir: 'asc',        // sort direction: 'asc' | 'desc'
    fleetPairings: [],       // dish-to-router pairings from fleet-pairings.json
    pairingByRouterId: {},   // routerId → { dish, router, routerId }
    pairingByDish: {},       // dishName → { dish, router, routerId }
  };

  // ── Constants ───────────────────────────────────────────────────────
  const STORAGE_KEYS = {
    credentials: 'starlink_credentials',
    nicknames: 'starlink_nicknames',
    refreshInterval: 'starlink_refresh_interval',
    routerDefaults: 'starlink_router_defaults',
  };
  const DEFAULT_REFRESH_MINUTES = 5;
  const GAUGE_RADIUS = 54;
  const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
  const PAGE_SIZE = 100;

  // ── DOM References ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  // ── Auth Module ─────────────────────────────────────────────────────
  async function authenticate(clientId, clientSecret) {
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Authentication failed' }));
      throw new Error(err.error || err.detail || 'Authentication failed');
    }

    const data = await res.json();
    state.token = data.access_token;
    state.clientId = clientId;
    state.clientSecret = clientSecret;

    const refreshMs = ((data.expires_in || 900) - 60) * 1000;
    if (state.tokenRefreshTimer) clearTimeout(state.tokenRefreshTimer);
    state.tokenRefreshTimer = setTimeout(() => refreshToken(), Math.max(refreshMs, 30000));
    return true;
  }

  async function refreshToken() {
    if (!state.clientId || !state.clientSecret) return;
    try {
      await authenticate(state.clientId, state.clientSecret);
    } catch {
      showToast('Session expired. Please log in again.', 'error');
      logout();
    }
  }

  function logout() {
    state.token = null;
    state.clientId = null;
    state.clientSecret = null;
    state.usageResults = [];
    if (state.tokenRefreshTimer) clearTimeout(state.tokenRefreshTimer);
    stopAutoRefresh();
    $('dashboard').style.display = 'none';
    $('login-screen').style.display = 'flex';
    $('client-id').value = '';
    $('client-secret').value = '';
    $('login-error').style.display = 'none';
  }

  function checkSavedCredentials() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.credentials);
      if (saved) {
        const { clientId, clientSecret } = JSON.parse(saved);
        if (clientId && clientSecret) {
          $('client-id').value = clientId;
          $('client-secret').value = clientSecret;
          $('remember-credentials').checked = true;
          handleLogin(new Event('submit'));
        }
      }
    } catch { /* ignore */ }
  }

  // ── API Module ──────────────────────────────────────────────────────
  async function apiRequest(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      showToast('Session expired. Please log in again.', 'error');
      logout();
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => 'Request failed');
      throw new Error(text);
    }
    return res.json();
  }

  // Build query params for data usage based on current range selection
  function buildUsageQueryBody() {
    const body = {
      activeServiceLinesOnly: !state.includeInactive,
    };

    if (state.currentRange === 'custom') {
      const startVal = $('range-start').value;
      if (startVal) {
        body.queryStartDate = new Date(startVal).toISOString();
      } else {
        body.previousBillingCycles = 1;
      }
    } else if (state.currentRange === '3months') {
      body.previousBillingCycles = 3;
    } else if (state.currentRange === '6months') {
      body.previousBillingCycles = 6;
    } else {
      // 'current' — current + 1 previous
      body.previousBillingCycles = 1;
    }

    return body;
  }

  // Returns { start: Date|null, end: Date|null } for the active date filter
  function getDateFilter() {
    if (state.currentRange !== 'custom') return { start: null, end: null };
    const startVal = $('range-start').value;
    const endVal = $('range-end').value;
    return {
      start: startVal ? new Date(startVal + 'T00:00:00Z') : null,
      end: endVal ? new Date(endVal + 'T23:59:59Z') : null,
    };
  }

  // Extract and filter daily data from billing cycles to the active date range
  function getFilteredDailyData(cycles) {
    const { start, end } = getDateFilter();
    const allDays = [];
    (cycles || []).forEach((cycle) => {
      (cycle.dailyDataUsage || []).forEach((day) => {
        allDays.push(day);
      });
    });
    if (!start && !end) return allDays;
    return allDays.filter((day) => {
      const d = new Date(day.date);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

  // Sum daily data entries into totals
  function sumDailyData(days) {
    let priority = 0, standard = 0, optInPriority = 0, nonBillable = 0;
    days.forEach((d) => {
      priority += d.priorityGB || 0;
      standard += d.standardGB || 0;
      optInPriority += d.optInPriorityGB || 0;
      nonBillable += d.nonBillableGB || 0;
    });
    return { priority, standard, optInPriority, nonBillable, total: priority + standard };
  }

  // Check if we should use daily filtering (custom range with at least a start date)
  function isDateFiltered() {
    if (state.currentRange !== 'custom') return false;
    return !!$('range-start').value;
  }

  async function fetchDataUsage() {
    const allResults = [];
    let page = 0;
    let isLastPage = false;
    const body = buildUsageQueryBody();

    try {
      do {
        const data = await apiRequest(`/api/data-usage?page=${page}&limit=${PAGE_SIZE}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });

        const content = data.content || data;
        const results = content.results || [];
        allResults.push(...results);
        isLastPage = content.isLastPage !== false;
        page++;
      } while (!isLastPage);
    } catch (err) {
      console.warn('Failed to fetch data usage:', err.message);
      showToast('Failed to fetch data usage: ' + err.message, 'error');
    }

    return allResults;
  }

  async function fetchUserTerminals() {
    const allResults = [];
    let page = 0;
    let isLastPage = false;
    try {
      do {
        const data = await apiRequest(`/api/user-terminals?page=${page}`);
        const content = data.content || data;
        const results = content.results || [];
        allResults.push(...results);
        isLastPage = content.isLastPage !== false;
        page++;
      } while (!isLastPage);
    } catch (err) {
      console.warn('Failed to fetch user terminals:', err.message);
    }
    return allResults;
  }

  async function fetchServiceLines() {
    const allResults = [];
    let page = 0;
    let isLastPage = false;
    try {
      do {
        const data = await apiRequest(`/api/service-lines?page=${page}`);
        const content = data.content || data;
        const results = content.results || [];
        allResults.push(...results);
        isLastPage = content.isLastPage !== false;
        page++;
      } while (!isLastPage);
    } catch (err) {
      console.warn('Failed to fetch service lines:', err.message);
    }
    return allResults;
  }

  async function buildDeviceMap() {
    const [terminals, serviceLines] = await Promise.all([
      fetchUserTerminals(),
      fetchServiceLines(),
    ]);

    const map = {};

    // Index terminals by serviceLineNumber
    terminals.forEach((ut) => {
      if (ut.serviceLineNumber) {
        map[ut.serviceLineNumber] = {
          dishSerial: ut.dishSerialNumber || '',
          kitSerial: ut.kitSerialNumber || '',
          utNickname: ut.nickname || '',
          userTerminalId: ut.userTerminalId || '',
          slNickname: '',
        };
      }
    });

    // Merge service line nicknames
    serviceLines.forEach((sl) => {
      const sln = sl.serviceLineNumber;
      if (!sln) return;
      if (map[sln]) {
        map[sln].slNickname = sl.nickname || '';
      } else {
        map[sln] = {
          dishSerial: '',
          kitSerial: '',
          utNickname: '',
          userTerminalId: '',
          slNickname: sl.nickname || '',
        };
      }
    });

    state.deviceMap = map;
  }

  // ── Dashboard Module ────────────────────────────────────────────────
  async function initDashboard() {
    showLoading();

    // Fetch device info (terminals + service lines) in parallel with usage data
    const [results] = await Promise.all([
      fetchDataUsage(),
      Object.keys(state.deviceMap).length === 0 ? buildDeviceMap() : Promise.resolve(),
    ]);
    state.usageResults = results;

    hideLoading();
    renderDashboard();
    startAutoRefresh();
  }

  function renderDashboard() {
    const filtered = getFilteredResults();

    if (filtered.length === 0) {
      $('terminal-grid').innerHTML = '';
      $('terminal-grid').style.display = 'none';
      $('empty-state').style.display = 'block';
      $('results-count').textContent = '';
      // Still update summary with all data
      renderFleetSummary(state.usageResults);
    } else {
      $('empty-state').style.display = 'none';
      $('terminal-grid').style.display = 'grid';
      renderFleetSummary(filtered);
      renderTerminalGrid(filtered);
      $('results-count').textContent = `${filtered.length} terminal${filtered.length !== 1 ? 's' : ''}`;
    }
  }

  function getFilteredResults() {
    let results = state.usageResults;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      results = results.filter((r) => {
        const sln = (r.serviceLineNumber || '').toLowerCase();
        const device = state.deviceMap[r.serviceLineNumber] || {};
        const nickname = getDisplayName(r.serviceLineNumber).toLowerCase();
        const dishSerial = (device.dishSerial || '').toLowerCase();
        const kitSerial = (device.kitSerial || '').toLowerCase();
        const utId = (device.userTerminalId || '').toLowerCase();
        return sln.includes(q) || nickname.includes(q) || dishSerial.includes(q) || kitSerial.includes(q) || utId.includes(q);
      });
    }
    return results;
  }

  function renderFleetSummary(results) {
    let totalPriority = 0;
    let totalStandard = 0;

    if (isDateFiltered()) {
      // Use daily data filtered to exact date range
      results.forEach((r) => {
        const days = getFilteredDailyData(r.billingCycles || []);
        const sums = sumDailyData(days);
        totalPriority += sums.priority;
        totalStandard += sums.standard;
      });
    } else {
      results.forEach((r) => {
        (r.billingCycles || []).forEach((cycle) => {
          totalPriority += cycle.totalPriorityGB || 0;
          totalStandard += cycle.totalStandardGB || 0;
        });
      });
    }

    const totalCombined = totalPriority + totalStandard;

    animateValue($('total-terminals'), 0, results.length, 600, (v) => Math.round(v).toString());
    animateValue($('total-priority'), 0, totalPriority, 800, formatDataSize);
    animateValue($('total-standard'), 0, totalStandard, 800, formatDataSize);
    animateValue($('total-combined'), 0, totalCombined, 1000, formatDataSize);
  }

  function renderTerminalGrid(results) {
    const grid = $('terminal-grid');
    grid.innerHTML = '';

    results.forEach((result, index) => {
      const card = createTerminalCard(result, index);
      grid.insertAdjacentHTML('beforeend', card);
    });

    // Attach click handlers to open detail modal
    grid.querySelectorAll('.terminal-card').forEach((card) => {
      card.addEventListener('click', () => {
        const sln = card.dataset.sln;
        const result = state.usageResults.find((r) => r.serviceLineNumber === sln);
        if (result) openDetailModal(result);
      });
      card.style.cursor = 'pointer';
    });
  }

  function createTerminalCard(result, index) {
    const sln = result.serviceLineNumber || 'Unknown';
    const displayName = getDisplayName(sln);
    const device = state.deviceMap[sln] || {};
    const dishSerial = device.dishSerial || '';
    const cycles = result.billingCycles || [];
    const plan = result.servicePlan || {};
    const isActive = !plan.subscriptionEndDate;

    // Aggregate usage — use daily filtering when a custom date range is set
    let totalPriority = 0;
    let totalStandard = 0;
    let totalOverage = 0;

    if (isDateFiltered()) {
      const days = getFilteredDailyData(cycles);
      const sums = sumDailyData(days);
      totalPriority = sums.priority;
      totalStandard = sums.standard;
    } else {
      cycles.forEach((c) => {
        totalPriority += c.totalPriorityGB || 0;
        totalStandard += c.totalStandardGB || 0;
        (c.overageLines || []).forEach((ol) => {
          totalOverage += ol.overageAmountGB || 0;
        });
      });
    }

    const usageLimit = plan.usageLimitGB || 0;
    // For the gauge, use filtered priority vs limit
    const percentage = usageLimit > 0 ? Math.min(100, (totalPriority / usageLimit) * 100) : 0;

    const priorityBarWidth = usageLimit > 0
      ? Math.min(100, (totalPriority / usageLimit) * 100)
      : (totalPriority > 0 ? 50 : 0);

    const maxVal = Math.max(totalPriority, totalStandard, 1);
    const standardBarWidth = (totalStandard / maxVal) * 100;

    const priorityLabel = usageLimit > 0
      ? `${formatDataSize(totalPriority)} / ${formatDataSize(usageLimit)}`
      : formatDataSize(totalPriority);

    const overageHtml = totalOverage > 0
      ? `<div class="overage-text">⚠ ${formatDataSize(totalOverage)} overage</div>`
      : '';

    const statusClass = isActive ? 'online' : 'offline';
    const statusText = isActive ? 'Active' : 'Inactive';
    const cardClass = isActive ? '' : ' inactive';
    const cycleLabel = cycles.length > 1 ? ` (${cycles.length} cycles)` : '';

    const serialLine = dishSerial
      ? `<div class="terminal-serial">SN: ${escapeHtml(dishSerial)}</div>`
      : '';

    const delay = Math.min(index * 0.04, 0.5);

    return `
      <div class="terminal-card${cardClass}" style="animation-delay: ${delay}s" data-sln="${escapeHtml(sln)}">
        <div class="terminal-header">
          <div>
            <div class="terminal-name">${escapeHtml(displayName)}</div>
            ${serialLine}
            <div class="terminal-sln">${escapeHtml(sln)}${cycleLabel}</div>
          </div>
          <span class="status-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="usage-gauge">
          ${createGaugeSVG(percentage)}
        </div>
        <div class="usage-details">
          <div class="usage-row">
            <div class="usage-row-header">
              <span class="usage-row-label">Priority Data</span>
              <span class="usage-row-value">${priorityLabel}</span>
            </div>
            <div class="usage-bar-container">
              <div class="usage-bar-fill priority" style="width: ${Math.min(priorityBarWidth, 100)}%"></div>
            </div>
          </div>
          <div class="usage-row">
            <div class="usage-row-header">
              <span class="usage-row-label">Standard Data</span>
              <span class="usage-row-value">${formatDataSize(totalStandard)}</span>
            </div>
            <div class="usage-bar-container">
              <div class="usage-bar-fill standard" style="width: ${Math.min(standardBarWidth, 100)}%"></div>
            </div>
          </div>
          ${overageHtml}
        </div>
        <div class="card-click-hint">Click for detailed history →</div>
      </div>
    `;
  }

  function createGaugeSVG(percentage) {
    const offset = GAUGE_CIRCUMFERENCE * (1 - percentage / 100);
    const color = percentage > 90 ? '#ff4d41' : percentage > 75 ? '#f59231' : '#3166ae';
    const displayPct = Math.round(percentage);

    return `
      <svg class="gauge-svg" viewBox="0 0 120 120">
        <circle class="gauge-bg" cx="60" cy="60" r="${GAUGE_RADIUS}"/>
        <circle class="gauge-fill" cx="60" cy="60" r="${GAUGE_RADIUS}"
          stroke="${color}"
          stroke-dasharray="${GAUGE_CIRCUMFERENCE}"
          stroke-dashoffset="${offset}"/>
        <text class="gauge-text" x="60" y="55">
          <tspan class="gauge-value">${displayPct}%</tspan>
        </text>
        <text class="gauge-text" x="60" y="75">
          <tspan class="gauge-label">used</tspan>
        </text>
      </svg>
    `;
  }

  // ── Detail Modal ────────────────────────────────────────────────────
  let detailResult = null;

  function openDetailModal(result) {
    detailResult = result;
    const sln = result.serviceLineNumber || 'Unknown';
    const displayName = getDisplayName(sln);
    const device = state.deviceMap[sln] || {};
    const cycles = result.billingCycles || [];

    $('detail-terminal-name').textContent = displayName;
    const serialInfo = device.dishSerial ? `SN: ${device.dishSerial} · ` : '';
    $('detail-terminal-sln').textContent = `${serialInfo}${sln}`;

    // Summary stats — use daily filtering for custom date ranges
    let totalPriority = 0, totalStandard = 0;
    const filteredDays = getFilteredDailyData(cycles);

    if (isDateFiltered()) {
      const sums = sumDailyData(filteredDays);
      totalPriority = sums.priority;
      totalStandard = sums.standard;
    } else {
      cycles.forEach((c) => {
        totalPriority += c.totalPriorityGB || 0;
        totalStandard += c.totalStandardGB || 0;
      });
    }

    $('detail-total-priority').textContent = formatDataSize(totalPriority);
    $('detail-total-standard').textContent = formatDataSize(totalStandard);
    $('detail-total-combined').textContent = formatDataSize(totalPriority + totalStandard);

    const { start, end } = getDateFilter();
    const dayCount = filteredDays.length;
    const cycleCountLabel = isDateFiltered()
      ? `${dayCount} day${dayCount !== 1 ? 's' : ''}`
      : cycles.length.toString();
    $('detail-cycle-count').textContent = cycleCountLabel;
    $('detail-cycle-label').textContent = isDateFiltered() ? 'Days in Range' : 'Billing Cycles';

    // Render billing cycle history table
    renderCycleHistoryTable(cycles);

    // Render daily usage table and chart
    renderDailyUsageTable(cycles);
    renderDailyChart(cycles);

    $('detail-modal').style.display = 'flex';
  }

  function closeDetailModal() {
    $('detail-modal').style.display = 'none';
    detailResult = null;
  }

  function renderCycleHistoryTable(cycles) {
    const tbody = $('cycle-history-body');
    tbody.innerHTML = '';

    if (cycles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-tertiary)">No billing cycle data available</td></tr>';
      return;
    }

    // Chronological order (oldest first)
    const sorted = [...cycles].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

    sorted.forEach((cycle) => {
      const start = formatDate(cycle.startDate);
      const end = formatDate(cycle.endDate);
      const priority = (cycle.totalPriorityGB || 0).toFixed(2);
      const standard = (cycle.totalStandardGB || 0).toFixed(2);
      const total = ((cycle.totalPriorityGB || 0) + (cycle.totalStandardGB || 0)).toFixed(2);

      let overageGB = 0;
      (cycle.overageLines || []).forEach((ol) => { overageGB += ol.overageAmountGB || 0; });
      const overageStr = overageGB > 0 ? overageGB.toFixed(2) : '—';
      const overageClass = overageGB > 0 ? ' class="overage-cell"' : '';

      tbody.innerHTML += `
        <tr>
          <td>${start} — ${end}</td>
          <td>${priority}</td>
          <td>${standard}</td>
          <td><strong>${total}</strong></td>
          <td${overageClass}>${overageStr}</td>
        </tr>
      `;
    });
  }

  function renderDailyUsageTable(cycles) {
    const tbody = $('daily-usage-body');
    const tfoot = $('daily-usage-foot');
    const title = $('daily-table-title');
    tbody.innerHTML = '';
    tfoot.innerHTML = '';

    const filteredDays = getFilteredDailyData(cycles);

    // Update title with date range if custom
    const { start, end } = getDateFilter();
    if (isDateFiltered() && start) {
      const rangeLabel = end
        ? `${formatDate(start.toISOString())} — ${formatDate(end.toISOString())}`
        : `From ${formatDate(start.toISOString())}`;
      title.textContent = `Daily Usage (${rangeLabel})`;
    } else {
      title.textContent = 'Daily Usage Breakdown';
    }

    if (filteredDays.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-tertiary)">No daily data available for this range</td></tr>';
      return;
    }

    // Sort chronologically
    const sorted = [...filteredDays].sort((a, b) => new Date(a.date) - new Date(b.date));

    let sumPriority = 0, sumStandard = 0, sumTotal = 0, sumNonBillable = 0;

    sorted.forEach((day) => {
      const p = day.priorityGB || 0;
      const s = day.standardGB || 0;
      const t = p + s;
      const nb = day.nonBillableGB || 0;
      sumPriority += p;
      sumStandard += s;
      sumTotal += t;
      sumNonBillable += nb;

      const dateStr = formatDate(day.date);
      const hasUsage = t > 0.001;
      const rowClass = hasUsage ? '' : ' style="opacity: 0.4"';

      tbody.innerHTML += `
        <tr${rowClass}>
          <td>${dateStr}</td>
          <td>${p.toFixed(2)}</td>
          <td>${s.toFixed(2)}</td>
          <td><strong>${t.toFixed(2)}</strong></td>
          <td>${nb > 0 ? nb.toFixed(2) : '—'}</td>
        </tr>
      `;
    });

    // Totals footer (sticky at bottom)
    tfoot.innerHTML = `
      <tr>
        <td>Total (${sorted.length} days)</td>
        <td>${sumPriority.toFixed(2)}</td>
        <td>${sumStandard.toFixed(2)}</td>
        <td>${sumTotal.toFixed(2)}</td>
        <td>${sumNonBillable > 0 ? sumNonBillable.toFixed(2) : '—'}</td>
      </tr>
    `;
  }

  // ── Chart Module (Canvas) ───────────────────────────────────────────
  function renderDailyChart(cycles) {
    const canvas = $('daily-chart');
    const ctx = canvas.getContext('2d');

    // Collect daily data, filtered to custom date range if active
    const filteredDays = getFilteredDailyData(cycles);
    const dailyData = filteredDays.map((day) => ({
      date: day.date,
      priority: day.priorityGB || 0,
      standard: day.standardGB || 0,
    }));

    if (dailyData.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#636363';
      ctx.font = '14px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No daily usage data available', canvas.width / 2, canvas.height / 2);
      return;
    }

    // Sort by date
    dailyData.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Set canvas resolution for retina
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 280 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '280px';
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = 280;
    const padLeft = 56;
    const padRight = 16;
    const padTop = 16;
    const padBottom = 40;
    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    ctx.clearRect(0, 0, W, H);

    // Find max value
    const maxVal = Math.max(...dailyData.map((d) => d.priority + d.standard), 0.1);
    const niceMax = ceilToNice(maxVal);

    // Draw grid lines
    const gridLines = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#636363';
    ctx.font = '11px Montserrat, sans-serif';
    ctx.textAlign = 'right';

    for (let i = 0; i <= gridLines; i++) {
      const y = padTop + chartH - (i / gridLines) * chartH;
      const val = (i / gridLines) * niceMax;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();
      ctx.fillText(formatDataSize(val), padLeft - 8, y + 4);
    }

    // Draw bars
    const barGap = Math.max(1, Math.min(3, chartW / dailyData.length * 0.15));
    const barWidth = Math.max(1, (chartW - barGap * dailyData.length) / dailyData.length);

    dailyData.forEach((day, i) => {
      const x = padLeft + i * (barWidth + barGap);
      const priorityH = (day.priority / niceMax) * chartH;
      const standardH = (day.standard / niceMax) * chartH;
      const totalH = priorityH + standardH;

      // Standard (bottom)
      ctx.fillStyle = '#e1edfd';
      ctx.fillRect(x, padTop + chartH - totalH, barWidth, standardH);

      // Priority (top of stack)
      ctx.fillStyle = '#3166ae';
      ctx.fillRect(x, padTop + chartH - totalH + standardH, barWidth, priorityH);
    });

    // Draw x-axis labels (show ~8 labels max)
    ctx.fillStyle = '#636363';
    ctx.font = '10px Montserrat, sans-serif';
    ctx.textAlign = 'center';

    const labelInterval = Math.max(1, Math.floor(dailyData.length / 8));
    dailyData.forEach((day, i) => {
      if (i % labelInterval === 0 || i === dailyData.length - 1) {
        const x = padLeft + i * (barWidth + barGap) + barWidth / 2;
        const label = formatDateShort(day.date);
        ctx.fillText(label, x, H - padBottom + 16);
      }
    });
  }

  function ceilToNice(val) {
    if (val <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(val)));
    const normalized = val / magnitude;
    if (normalized <= 1) return magnitude;
    if (normalized <= 2) return 2 * magnitude;
    if (normalized <= 5) return 5 * magnitude;
    return 10 * magnitude;
  }

  // ── UI Utilities ────────────────────────────────────────────────────
  function formatDataSize(gb) {
    if (gb == null || isNaN(gb)) return '0 GB';
    if (gb >= 1000) {
      return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(gb / 1000) + ' TB';
    }
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(gb) + ' GB';
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateShort(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function showToast(message, type = 'success') {
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { toast.classList.add('show'); });
    });
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 350);
    }, 4000);
  }

  function showLoading() {
    $('loading-grid').style.display = 'grid';
    $('terminal-grid').style.display = 'none';
    $('empty-state').style.display = 'none';
  }

  function hideLoading() {
    $('loading-grid').style.display = 'none';
  }

  function animateValue(el, start, end, duration, formatter) {
    if (!el) return;
    const startTime = performance.now();
    const range = end - start;
    function update(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = start + range * eased;
      el.textContent = formatter ? formatter(current) : Math.round(current).toString();
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Settings Module ─────────────────────────────────────────────────
  // Returns the best display name for a service line:
  //   1. Local nickname (user-set in settings)
  //   2. API-set service line nickname
  //   3. API-set user terminal nickname
  //   4. Dish serial number (hardware identifier)
  //   5. Service line number (fallback)
  function getDisplayName(sln) {
    const localNick = getLocalNickname(sln);
    if (localNick) return localNick;
    const device = state.deviceMap[sln] || {};
    if (device.slNickname) return device.slNickname;
    if (device.utNickname) return device.utNickname;
    if (device.dishSerial) return device.dishSerial;
    return sln;
  }

  // Keep getNickname as alias for backward compat in export
  function getNickname(sln) {
    return getDisplayName(sln);
  }

  function getLocalNickname(sln) {
    try {
      const nicknames = JSON.parse(localStorage.getItem(STORAGE_KEYS.nicknames) || '{}');
      return nicknames[sln] || '';
    } catch { return ''; }
  }

  function setNickname(sln, name) {
    try {
      const nicknames = JSON.parse(localStorage.getItem(STORAGE_KEYS.nicknames) || '{}');
      if (name && name.trim()) { nicknames[sln] = name.trim(); }
      else { delete nicknames[sln]; }
      localStorage.setItem(STORAGE_KEYS.nicknames, JSON.stringify(nicknames));
    } catch { /* ignore */ }
  }

  function getRefreshInterval() {
    try {
      const val = parseInt(localStorage.getItem(STORAGE_KEYS.refreshInterval), 10);
      return (val && val > 0 && val <= 60) ? val : DEFAULT_REFRESH_MINUTES;
    } catch { return DEFAULT_REFRESH_MINUTES; }
  }

  function renderNicknameEditor() {
    const list = $('nickname-list');
    list.innerHTML = '';
    const slns = new Set();
    state.usageResults.forEach((r) => { if (r.serviceLineNumber) slns.add(r.serviceLineNumber); });

    if (slns.size === 0) {
      list.innerHTML = '<p style="color: var(--text-tertiary); font-size: 13px;">No terminals found yet.</p>';
      return;
    }

    slns.forEach((sln) => {
      const localNick = getLocalNickname(sln);
      const device = state.deviceMap[sln] || {};
      const serialLabel = device.dishSerial || sln;
      const row = document.createElement('div');
      row.className = 'nickname-row';
      row.innerHTML = `
        <span class="sln-label" title="${escapeHtml(sln)}">${escapeHtml(serialLabel)}</span>
        <input class="nickname-input" type="text" value="${escapeHtml(localNick)}" placeholder="Enter nickname..." data-sln="${escapeHtml(sln)}">
      `;
      list.appendChild(row);
    });

    list.querySelectorAll('.nickname-input').forEach((input) => {
      const handler = () => { setNickname(input.dataset.sln, input.value); };
      input.addEventListener('change', handler);
      input.addEventListener('blur', handler);
    });
  }

  // ── Export Module ────────────────────────────────────────────────────
  function exportCSV(results) {
    results = results || state.usageResults;
    if (results.length === 0) {
      showToast('No data to export', 'error');
      return;
    }

    const headers = [
      'Service Line Number', 'Dish Serial Number', 'Kit Serial Number', 'Nickname',
      'Billing Cycle Start', 'Billing Cycle End',
      'Priority Data (GB)', 'Standard Data (GB)', 'Total Data (GB)',
      'Opt-In Priority (GB)', 'Non-Billable (GB)', 'Overage (GB)',
    ];

    const rows = [];
    results.forEach((r) => {
      const sln = r.serviceLineNumber || '';
      const device = state.deviceMap[sln] || {};
      const nick = getDisplayName(sln);
      (r.billingCycles || []).forEach((cycle) => {
        let overageGB = 0;
        (cycle.overageLines || []).forEach((ol) => { overageGB += ol.overageAmountGB || 0; });
        rows.push([
          sln, device.dishSerial || '', device.kitSerial || '', nick,
          cycle.startDate || '', cycle.endDate || '',
          (cycle.totalPriorityGB || 0).toFixed(2),
          (cycle.totalStandardGB || 0).toFixed(2),
          ((cycle.totalPriorityGB || 0) + (cycle.totalStandardGB || 0)).toFixed(2),
          (cycle.totalOptInPriorityGB || 0).toFixed(2),
          (cycle.totalNonBillableGB || 0).toFixed(2),
          overageGB.toFixed(2),
        ]);
      });
    });

    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `starlink-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('CSV exported successfully', 'success');
  }

  // ── Auto-Refresh ────────────────────────────────────────────────────
  function startAutoRefresh() {
    stopAutoRefresh();
    const minutes = getRefreshInterval();
    const ms = minutes * 60 * 1000;
    state.nextRefreshAt = Date.now() + ms;

    state.refreshTimer = setInterval(async () => {
      if (document.hidden) return;
      await initDashboard();
      state.nextRefreshAt = Date.now() + ms;
      showToast('Data refreshed', 'success');
    }, ms);

    state.refreshCountdown = setInterval(updateRefreshCountdown, 1000);
    updateRefreshCountdown();
  }

  function stopAutoRefresh() {
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    if (state.refreshCountdown) { clearInterval(state.refreshCountdown); state.refreshCountdown = null; }
  }

  function updateRefreshCountdown() {
    const el = $('refresh-text');
    if (!el || !state.nextRefreshAt) { if (el) el.textContent = 'Live'; return; }
    const remaining = Math.max(0, state.nextRefreshAt - Date.now());
    const sec = Math.ceil(remaining / 1000);
    if (sec <= 0) { el.textContent = 'Refreshing...'; }
    else if (sec < 60) { el.textContent = `${sec}s`; }
    else { const m = Math.floor(sec / 60); const s = sec % 60; el.textContent = `${m}:${s.toString().padStart(2, '0')}`; }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token) updateRefreshCountdown();
  });

  // ── Event Handlers ──────────────────────────────────────────────────
  async function handleLogin(e) {
    e.preventDefault();
    const clientId = $('client-id').value.trim();
    const clientSecret = $('client-secret').value.trim();
    const remember = $('remember-credentials').checked;
    if (!clientId || !clientSecret) return;

    const btn = $('login-btn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    const loginError = $('login-error');

    btnText.style.display = 'none';
    btnLoader.style.display = 'inline-block';
    btn.disabled = true;
    loginError.style.display = 'none';

    try {
      await authenticate(clientId, clientSecret);
      if (remember) {
        localStorage.setItem(STORAGE_KEYS.credentials, JSON.stringify({ clientId, clientSecret }));
      } else {
        localStorage.removeItem(STORAGE_KEYS.credentials);
      }
      $('login-screen').style.display = 'none';
      $('dashboard').style.display = 'block';
      showToast('Connected to Starlink', 'success');
      await initDashboard();
    } catch (err) {
      loginError.textContent = err.message || 'Authentication failed. Check your credentials.';
      loginError.style.display = 'block';
    } finally {
      btnText.style.display = 'inline';
      btnLoader.style.display = 'none';
      btn.disabled = false;
    }
  }

  function handleRangePillClick(e) {
    const pill = e.target.closest('.range-pill');
    if (!pill) return;

    document.querySelectorAll('.range-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');

    const range = pill.dataset.range;
    state.currentRange = range;

    if (range === 'custom') {
      $('custom-date-range').style.display = 'flex';
    } else {
      $('custom-date-range').style.display = 'none';
      initDashboard();
    }
  }

  function handleSettingsOpen() {
    $('settings-modal').style.display = 'flex';
    $('refresh-interval').value = getRefreshInterval();
    renderNicknameEditor();
  }

  function handleSettingsClose() {
    $('settings-modal').style.display = 'none';
    const newInterval = parseInt($('refresh-interval').value, 10);
    if (newInterval && newInterval > 0 && newInterval <= 60) {
      localStorage.setItem(STORAGE_KEYS.refreshInterval, newInterval.toString());
      startAutoRefresh();
    }
    if (state.usageResults.length > 0) renderDashboard();
  }

  function handleClearData() {
    if (!confirm('This will clear all saved credentials, nicknames, and settings. Continue?')) return;
    localStorage.removeItem(STORAGE_KEYS.credentials);
    localStorage.removeItem(STORAGE_KEYS.nicknames);
    localStorage.removeItem(STORAGE_KEYS.refreshInterval);
    showToast('All local data cleared', 'success');
    logout();
  }

  // Debounce utility
  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  // ── Wire Up Event Listeners ─────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    $('login-form').addEventListener('submit', handleLogin);
    $('logout-btn').addEventListener('click', logout);

    $('refresh-btn').addEventListener('click', async () => {
      $('refresh-btn').disabled = true;
      await initDashboard();
      showToast('Data refreshed', 'success');
      $('refresh-btn').disabled = false;
      state.nextRefreshAt = Date.now() + getRefreshInterval() * 60 * 1000;
    });

    $('export-btn').addEventListener('click', () => exportCSV());
    $('settings-btn').addEventListener('click', handleSettingsOpen);
    $('settings-close').addEventListener('click', handleSettingsClose);
    $('clear-data-btn').addEventListener('click', handleClearData);

    // Range pills
    $('range-pills').addEventListener('click', handleRangePillClick);

    // Custom date range apply
    $('apply-range-btn').addEventListener('click', () => {
      const start = $('range-start').value;
      if (!start) {
        showToast('Please select a start date', 'error');
        return;
      }
      initDashboard();
    });

    // Search
    $('terminal-search').addEventListener('input', debounce((e) => {
      state.searchQuery = e.target.value.trim();
      renderDashboard();
    }, 250));

    // Include inactive toggle
    $('include-inactive').addEventListener('change', (e) => {
      state.includeInactive = e.target.checked;
      initDashboard();
    });

    // Settings modal overlay click
    $('settings-modal').addEventListener('click', (e) => {
      if (e.target === $('settings-modal')) handleSettingsClose();
    });

    // Detail modal
    $('detail-close').addEventListener('click', closeDetailModal);
    $('detail-modal').addEventListener('click', (e) => {
      if (e.target === $('detail-modal')) closeDetailModal();
    });
    $('detail-export-btn').addEventListener('click', () => {
      if (detailResult) exportCSV([detailResult]);
    });

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('detail-modal').style.display !== 'none') closeDetailModal();
        else if ($('settings-modal').style.display !== 'none') handleSettingsClose();
        else if ($('create-config-modal').style.display !== 'none') $('create-config-modal').style.display = 'none';
        else if ($('assign-config-modal').style.display !== 'none') $('assign-config-modal').style.display = 'none';
        else if ($('qr-modal').style.display !== 'none') $('qr-modal').style.display = 'none';
      }
    });

    // ── Tab Switching ───────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === state.activeTab) return;
        state.activeTab = tab;

        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.tab-panel').forEach(p => {
          p.classList.remove('active');
          p.style.display = 'none';
        });
        const panel = $('panel-' + tab);
        panel.classList.add('active');
        panel.style.display = 'block';

        // Load router config data on first visit
        if (tab === 'router-config' && !state.rcLoaded) {
          loadRouterConfigData();
        }
      });
    });

    // ── Router Config Event Listeners ───────────────────────────────
    $('rc-config-search').addEventListener('input', filterConfigCards);
    $('rc-bulk-clean-btn').addEventListener('click', bulkCleanExtraSsids);
    $('rc-add-ssid-btn').addEventListener('click', openAddSsidModal);
    $('add-ssid-close').addEventListener('click', () => { $('add-ssid-modal').style.display = 'none'; });
    $('add-ssid-submit').addEventListener('click', handleAddSsidToConfigs);
    $('add-ssid-select-all').addEventListener('change', (e) => {
      $('add-ssid-config-list').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = e.target.checked; });
    });
    $('rc-create-btn').addEventListener('click', () => {
      $('create-config-modal').style.display = 'flex';
    });
    $('create-config-close').addEventListener('click', () => {
      $('create-config-modal').style.display = 'none';
    });
    $('create-config-modal').addEventListener('click', (e) => {
      if (e.target === $('create-config-modal')) $('create-config-modal').style.display = 'none';
    });
    $('assign-config-close').addEventListener('click', () => {
      $('assign-config-modal').style.display = 'none';
    });
    $('assign-config-modal').addEventListener('click', (e) => {
      if (e.target === $('assign-config-modal')) $('assign-config-modal').style.display = 'none';
    });
    $('create-config-submit').addEventListener('click', handleCreateConfig);
    $('rc-select-all').addEventListener('change', handleSelectAllRouters);
    $('rc-thead-select-all').addEventListener('change', handleSelectAllRouters);

    // Sortable column headers
    document.querySelectorAll('.rc-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (state.rcSortCol === col) {
          state.rcSortDir = state.rcSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.rcSortCol = col;
          state.rcSortDir = 'asc';
        }
        renderRouterTable();
      });
    });
    $('rc-bulk-revert').addEventListener('click', handleBulkRevertToDefault);
    $('rc-bulk-assign').addEventListener('click', () => {
      openAssignConfigModal();
    });
    $('qr-close').addEventListener('click', () => {
      $('qr-modal').style.display = 'none';
    });
    $('qr-modal').addEventListener('click', (e) => {
      if (e.target === $('qr-modal')) $('qr-modal').style.display = 'none';
    });

    checkSavedCredentials();
  });

  // ══════════════════════════════════════════════════════════════════
  // ══ ROUTER CONFIG MODULE ═════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════

  async function loadRouterConfigData() {
    try {
      // Load per-router defaults from localStorage
      try {
        const saved = localStorage.getItem(STORAGE_KEYS.routerDefaults);
        state.routerDefaults = saved ? JSON.parse(saved) : {};
      } catch { state.routerDefaults = {}; }

      const [configs, terminals] = await Promise.all([
        fetchAllRouterConfigs(),
        fetchAllUserTerminals(),
      ]);

      state.routerConfigs = configs;
      state.rcLoaded = true;

      // Load fleet pairing data
      try {
        const pRes = await fetch('/fleet-pairings.json');
        if (pRes.ok) {
          state.fleetPairings = await pRes.json();
          // Build lookup indexes — use suffix matching for routerId (last 10 chars)
          // to handle potential leading-zero differences
          state.pairingByRouterId = {};
          state.pairingByDish = {};
          state.fleetPairings.forEach(p => {
            const suffix = p.routerId.slice(-10).toUpperCase();
            state.pairingByRouterId[suffix] = p;
            state.pairingByDish[p.dish] = p;
          });
        }
      } catch (e) { console.warn('Fleet pairings not loaded:', e); }

      // Build router list from user terminals
      await buildRouterList(terminals);

      renderConfigCards();
      renderRouterTable();
    } catch (err) {
      console.error('Router config load error:', err);
      showToast('Failed to load router configs: ' + err.message, 'error');
    }
  }

  function saveRouterDefaults() {
    localStorage.setItem(STORAGE_KEYS.routerDefaults, JSON.stringify(state.routerDefaults));
  }

  function getRouterDefaultConfigId(routerId) {
    return state.routerDefaults[routerId] || null;
  }

  function isRouterModified(router) {
    const defaultCfgId = getRouterDefaultConfigId(router.routerId);
    if (!defaultCfgId) return false;
    return router.configId !== defaultCfgId;
  }

  // Look up fleet pairing by routerId (suffix match)
  function getPairingForRouter(routerId) {
    if (!routerId) return null;
    const suffix = routerId.slice(-10).toUpperCase();
    return state.pairingByRouterId[suffix] || null;
  }

  // Check if a terminal-router pairing matches the fleet assignment
  function isPairingMatch(terminal, routerId) {
    const pairing = getPairingForRouter(routerId);
    if (!pairing) return null; // unknown router, can't determine

    // If terminal has a recognizable dish nickname (e.g. "I00912907"), check it
    const termName = (terminal.terminalNickname || terminal.nickname || '').trim();
    if (termName && termName.startsWith('I00')) {
      // Terminal has a dish-style nickname — compare directly
      return termName === pairing.dish;
    }

    // Terminal has a generic nickname (e.g. "Starlink 01")
    // Can't verify dish identity, but the router IS in our fleet table
    // so assume it's correct (return true) unless we find evidence otherwise
    return true;
  }

  async function fetchAllRouterConfigs() {
    const allConfigs = [];
    let page = 0;
    while (true) {
      const res = await fetch(`/api/router-configs?page=${page}`, {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch router configs');
      const data = await res.json();
      const results = data?.content?.results || [];
      allConfigs.push(...results);
      if (data?.content?.isLastPage) break;
      page++;
    }
    return allConfigs;
  }

  async function fetchAllUserTerminals() {
    const allTerminals = [];
    let page = 0;
    while (true) {
      const res = await fetch(`/api/user-terminals?page=${page}`, {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch user terminals');
      const data = await res.json();
      const results = data?.content?.results || [];
      allTerminals.push(...results);
      if (data?.content?.isLastPage) break;
      page++;
    }
    return allTerminals;
  }

  async function buildRouterList(terminals) {
    const routers = [];
    for (const ut of terminals) {
      // Each terminal has a routers[] array with the real routerId and configId
      if (ut.routers && Array.isArray(ut.routers) && ut.routers.length > 0) {
        for (const router of ut.routers) {
          routers.push({
            routerId: router.routerId,
            routerNickname: router.nickname || null,
            configId: router.configId || null,
            userTerminalId: ut.userTerminalId || ut.dishSerialNumber,
            kitSerialNumber: ut.kitSerialNumber,
            dishSerialNumber: ut.dishSerialNumber,
            serviceLineNumber: ut.serviceLineNumber,
            terminalNickname: ut.nickname,
          });
        }
      } else {
        // Fallback: terminal with no routers array
        routers.push({
          routerId: ut.kitSerialNumber,
          routerNickname: null,
          configId: null,
          userTerminalId: ut.userTerminalId || ut.dishSerialNumber,
          kitSerialNumber: ut.kitSerialNumber,
          dishSerialNumber: ut.dishSerialNumber,
          serviceLineNumber: ut.serviceLineNumber,
          terminalNickname: ut.nickname,
        });
      }
    }
    state.routerList = routers;
  }

  function parseConfigJson(routerConfigJson) {
    try {
      const cfg = typeof routerConfigJson === 'string' ? JSON.parse(routerConfigJson) : routerConfigJson;
      let ssid = null, password = null, auth = null;
      const allSsids = []; // { ssid, password, auth, band }

      // Starlink format: networks[].basicServiceSets[].ssid / authWpa2.password
      if (cfg.networks && Array.isArray(cfg.networks)) {
        for (const net of cfg.networks) {
          if (!net.basicServiceSets || !Array.isArray(net.basicServiceSets)) continue;
          for (const bss of net.basicServiceSets) {
            let bssAuth = null, bssPw = null;
            if (bss.authWpa3) {
              bssPw = bss.authWpa3.password || null;
              bssAuth = 'WPA3';
            } else if (bss.authWpa2) {
              bssPw = bss.authWpa2.password || null;
              bssAuth = 'WPA2';
            } else if (bss.authOpen !== undefined) {
              bssAuth = 'Open';
            }

            if (bss.ssid) {
              allSsids.push({
                ssid: bss.ssid,
                password: bssPw,
                auth: bssAuth,
                band: bss.band || null,
              });
            }

            // First BSS becomes the primary
            if (!ssid && bss.ssid) {
              ssid = bss.ssid;
              password = bssPw;
              auth = bssAuth;
            }
          }
        }
      }

      // Deduplicate SSIDs (keep unique SSID+password combos)
      const seen = new Set();
      const uniqueSsids = allSsids.filter(s => {
        const key = `${s.ssid}|${s.password || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return { ssid, password, auth, allSsids: uniqueSsids, raw: cfg };
    } catch {
      return { ssid: null, password: null, auth: null, allSsids: [], raw: routerConfigJson };
    }
  }

  function getConfigName(configId) {
    const cfg = state.routerConfigs.find(c => c.configId === configId);
    return cfg?.nickname || configId?.slice(0, 8) || 'Unknown';
  }

  function filterConfigCards() {
    var query = $('rc-config-search').value.trim().toLowerCase();
    var grid = $('rc-configs-grid');
    var cards = grid.querySelectorAll('.rc-config-card');
    var visibleCount = 0;

    cards.forEach(function(card) {
      var configId = card.dataset.configId;
      var cfg = state.routerConfigs.find(function(c) { return c.configId === configId; });
      if (!cfg) { card.style.display = 'none'; return; }

      var name = (cfg.nickname || '').toLowerCase();
      var parsed = parseConfigJson(cfg.routerConfigJson);
      var ssidText = parsed.allSsids.map(function(s) { return s.ssid; }).join(' ').toLowerCase();

      var matches = !query || name.includes(query) || ssidText.includes(query);
      card.style.display = matches ? '' : 'none';
      if (matches) visibleCount++;
    });

    var countEl = $('rc-search-count');
    if (query) {
      countEl.textContent = visibleCount + ' of ' + cards.length;
    } else {
      countEl.textContent = '';
    }
  }

  function renderConfigCards() {
    const grid = $('rc-configs-grid');
    if (state.routerConfigs.length === 0) {
      grid.innerHTML = `
        <div class="rc-empty-configs">
          No configs found. Create your first WiFi configuration.
        </div>
      `;
      return;
    }

    const defaultCounts = {};
    Object.values(state.routerDefaults).forEach(cfgId => {
      defaultCounts[cfgId] = (defaultCounts[cfgId] || 0) + 1;
    });

    grid.innerHTML = state.routerConfigs.map(cfg => {
      const parsed = parseConfigJson(cfg.routerConfigJson);
      const count = defaultCounts[cfg.configId] || 0;
      const hasMultipleSsids = parsed.allSsids.length > 1;
      const uniqueSsidNames = [...new Set(parsed.allSsids.map(s => s.ssid))];
      const hasMultipleUniqueSsids = uniqueSsidNames.length > 1;

      // Build SSID sections
      let ssidSections = '';
      if (hasMultipleUniqueSsids) {
        // Multiple different SSIDs
        ssidSections = parsed.allSsids.map((s, i) => {
          const bandLabel = s.band ? s.band.replace('RF_', '').replace('GHZ', ' GHz') : '';
          const isFello = s.ssid.toLowerCase().includes('fello');
          const deleteBtn = !isFello
            ? `<button class="rc-ssid-delete-btn" data-config-id="${cfg.configId}" data-ssid="${s.ssid}" title="Remove this SSID from config">✕</button>`
            : '';
          return `
            <div class="rc-ssid-block ${i > 0 ? 'rc-ssid-divider' : ''}">
              <div class="rc-card-field">
                <span class="rc-field-label">SSID${bandLabel ? ` (${bandLabel})` : ''}</span>
                <span class="rc-field-value">${s.ssid} ${deleteBtn}</span>
              </div>
              <div class="rc-card-field">
                <span class="rc-field-label">Password</span>
                <span class="rc-field-value">${s.password
                  ? `<span class="rc-pw-cell">
                      <code class="rc-pw-masked rc-card-pw" data-pw="${s.password}">${'•'.repeat(s.password.length)}</code>
                      <button class="rc-eye-btn rc-card-eye" title="Show/hide password">👁</button>
                    </span>`
                  : 'N/A'}</span>
              </div>
              ${s.auth ? `<div class="rc-card-field">
                <span class="rc-field-label">Security</span>
                <span class="rc-field-value">${s.auth}</span>
              </div>` : ''}
            </div>`;
        }).join('');
      } else {
        const bands = parsed.allSsids.map(s => s.band?.replace('RF_', '').replace('GHZ', ' GHz')).filter(Boolean);
        ssidSections = `
          <div class="rc-card-field">
            <span class="rc-field-label">SSID</span>
            <span class="rc-field-value">${parsed.ssid || 'N/A'}${bands.length > 1 ? ` <span class="rc-band-badge">${bands.join(' + ')}</span>` : ''}</span>
          </div>
          <div class="rc-card-field">
            <span class="rc-field-label">Password</span>
            <span class="rc-field-value">${parsed.password
              ? `<span class="rc-pw-cell">
                  <code class="rc-pw-masked rc-card-pw" data-pw="${parsed.password}">${'•'.repeat(parsed.password.length)}</code>
                  <button class="rc-eye-btn rc-card-eye" title="Show/hide password">👁</button>
                </span>`
              : 'N/A'}</span>
          </div>
          ${parsed.auth ? `<div class="rc-card-field">
            <span class="rc-field-label">Security</span>
            <span class="rc-field-value">${parsed.auth}</span>
          </div>` : ''}`;
      }

      // QR button
      const qrBtn = parsed.ssid ? '<button class="rc-qr-icon-btn rc-qr-btn" data-config-id="' + cfg.configId + '" data-name="' + (cfg.nickname || 'WiFi').replace(/"/g, '&quot;') + '" title="Generate QR Code"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="5" y="5" width="2" height="2" fill="currentColor" stroke="none"/><rect x="17" y="5" width="2" height="2" fill="currentColor" stroke="none"/><rect x="5" y="17" width="2" height="2" fill="currentColor" stroke="none"/><rect x="14" y="14" width="2" height="2" fill="currentColor" stroke="none"/><rect x="18" y="14" width="2" height="2" fill="currentColor" stroke="none"/><rect x="14" y="18" width="2" height="2" fill="currentColor" stroke="none"/><rect x="18" y="18" width="2" height="2" fill="currentColor" stroke="none"/></svg></button>' : '';

      return '<div class="rc-config-card" data-config-id="' + cfg.configId + '">'
        + qrBtn
        + '<div class="rc-card-name">'
        + (cfg.nickname || 'Unnamed Config')
        + (hasMultipleUniqueSsids ? ' <span class="rc-multi-ssid-badge">Multi-SSID</span>' : '')
        + (count > 0 ? ' <span class="rc-default-badge">' + count + ' router' + (count > 1 ? 's' : '') + '</span>' : '')
        + '</div>'
        + ssidSections
        + '</div>';
    }).join('');

    // Wire up password toggles on config cards
    grid.querySelectorAll('.rc-card-eye').forEach(function(btn) {
      var code = btn.previousElementSibling;
      btn.addEventListener('click', function() {
        var pw = code.dataset.pw;
        code.textContent = code.textContent === pw ? '\u2022'.repeat(pw.length) : pw;
      });
    });

    // Wire up QR code buttons
    grid.querySelectorAll('.rc-qr-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        showWifiQrCode(btn.dataset.configId, btn.dataset.name);
      });
    });

    // Wire up SSID delete buttons
    grid.querySelectorAll('.rc-ssid-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var configId = btn.dataset.configId;
        var ssidToRemove = btn.dataset.ssid;
        if (!confirm('Remove SSID "' + ssidToRemove + '" from this config?')) return;
        await removeSsidFromConfig(configId, ssidToRemove);
      });
    });
  }

  function showWifiQrCode(configId, configName) {
    var cfg = state.routerConfigs.find(function(c) { return c.configId === configId; });
    if (!cfg) return;
    var parsed = parseConfigJson(cfg.routerConfigJson);
    var ssids = parsed.allSsids;
    if (ssids.length === 0) return;

    $('qr-modal-title').textContent = configName;
    var track = $('qr-carousel-track');
    var dotsContainer = $('qr-carousel-dots');
    track.innerHTML = '';
    dotsContainer.innerHTML = '';
    var currentSlide = 0;

    ssids.forEach(function(s, i) {
      var slide = document.createElement('div');
      slide.className = 'qr-slide' + (i === 0 ? ' qr-slide-active' : '');

      var label = document.createElement('div');
      label.className = 'qr-slide-label';
      label.textContent = s.ssid;
      slide.appendChild(label);

      var qrBox = document.createElement('div');
      qrBox.className = 'qr-slide-code';
      slide.appendChild(qrBox);

      var esc = function(str) { return str.replace(/[\\;,:"]/g, '\\$&'); };
      var aType = s.auth === 'Open' ? 'nopass' : 'WPA';
      var wStr = 'WIFI:T:' + aType + ';S:' + esc(s.ssid) + ';P:' + esc(s.password || '') + ';;';

      new QRCode(qrBox, {
        text: wStr,
        width: 240,
        height: 240,
        colorDark: '#232428',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });

      track.appendChild(slide);

      var dot = document.createElement('button');
      dot.className = 'qr-dot' + (i === 0 ? ' qr-dot-active' : '');
      dot.title = s.ssid;
      dot.addEventListener('click', function() { goToSlide(i); });
      dotsContainer.appendChild(dot);
    });

    var slides = track.querySelectorAll('.qr-slide');
    var dots = dotsContainer.querySelectorAll('.qr-dot');
    var isMulti = ssids.length > 1;

    $('qr-prev').style.display = isMulti ? '' : 'none';
    $('qr-next').style.display = isMulti ? '' : 'none';
    dotsContainer.style.display = isMulti ? '' : 'none';
    $('qr-modal-subtitle').textContent = 'SSID: ' + ssids[0].ssid;

    function goToSlide(idx) {
      slides[currentSlide].classList.remove('qr-slide-active');
      dots[currentSlide].classList.remove('qr-dot-active');
      currentSlide = idx;
      slides[currentSlide].classList.add('qr-slide-active');
      dots[currentSlide].classList.add('qr-dot-active');
      $('qr-modal-subtitle').textContent = 'SSID: ' + ssids[currentSlide].ssid;
    }

    $('qr-prev').onclick = function() { goToSlide((currentSlide - 1 + ssids.length) % ssids.length); };
    $('qr-next').onclick = function() { goToSlide((currentSlide + 1) % ssids.length); };

    $('qr-download-btn').onclick = function() {
      setTimeout(function() {
        var activeSlide = slides[currentSlide];
        var canvas = activeSlide.querySelector('canvas');
        if (canvas) {
          var link = document.createElement('a');
          var safeName = (configName + '_' + ssids[currentSlide].ssid).replace(/[^a-zA-Z0-9]/g, '_');
          link.download = safeName + '_wifi_qr.png';
          link.href = canvas.toDataURL('image/png');
          link.click();
        }
      }, 100);
    };

    $('qr-modal').style.display = 'flex';
  }

  function renderRouterTable() {
    const tbody = $('rc-router-body');
    if (state.routerList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="rc-loading-row">No routers found on this account</td></tr>';
      return;
    }

    // Build sortable list with precomputed values
    let rows = state.routerList.map(router => {
      const cfg = router.configId ? state.routerConfigs.find(c => c.configId === router.configId) : null;
      const parsed = cfg ? parseConfigJson(cfg.routerConfigJson) : { ssid: null, password: null, auth: null };
      const defaultCfgId = getRouterDefaultConfigId(router.routerId);
      const defaultCfg = defaultCfgId ? state.routerConfigs.find(c => c.configId === defaultCfgId) : null;
      const defaultName = defaultCfg?.nickname || '';
      const modified = isRouterModified(router);
      const terminalName = router.terminalNickname || router.dishSerialNumber || router.userTerminalId || '';
      const statusVal = modified ? 'modified' : defaultCfgId ? 'default' : 'nodefault';

      // Fleet pairing info
      const pairing = getPairingForRouter(router.routerId);
      const pairingMatch = isPairingMatch(router, router.routerId);
      const dishName = pairing?.dish || terminalName;
      const routerName = pairing?.router || router.routerId?.slice(0, 12) || '—';
      const pairingVal = pairingMatch === true ? 'match' : pairingMatch === false ? 'mismatch' : 'unknown';

      return { router, cfg, parsed, defaultCfgId, defaultCfg, defaultName, modified, terminalName, statusVal, pairing, pairingMatch, dishName, routerName, pairingVal };
    });

    // Sort if a column is active
    if (state.rcSortCol) {
      const dir = state.rcSortDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        let va, vb;
        switch (state.rcSortCol) {
          case 'terminal': va = a.dishName.toLowerCase(); vb = b.dishName.toLowerCase(); break;
          case 'pairing':  va = a.pairingVal; vb = b.pairingVal; break;
          case 'default':  va = a.defaultName.toLowerCase();  vb = b.defaultName.toLowerCase();  break;
          case 'ssid':     va = (a.parsed.ssid || '').toLowerCase(); vb = (b.parsed.ssid || '').toLowerCase(); break;
          case 'status':   va = a.statusVal; vb = b.statusVal; break;
          default: return 0;
        }
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }

    // Update sort icons in thead
    document.querySelectorAll('.rc-sortable').forEach(th => {
      const icon = th.querySelector('.rc-sort-icon');
      if (th.dataset.sort === state.rcSortCol) {
        icon.textContent = state.rcSortDir === 'asc' ? '↑' : '↓';
        th.classList.add('rc-sort-active');
      } else {
        icon.textContent = '⇅';
        th.classList.remove('rc-sort-active');
      }
    });

    tbody.innerHTML = rows.map(({ router, parsed, defaultCfgId, defaultName, modified, dishName, routerName, pairingMatch }) => {
      const hasDefault = !!defaultCfgId;
      const checked = state.selectedRouterIds.has(router.routerId) ? 'checked' : '';
      const pwId = 'pw-' + router.routerId?.replace(/[^a-zA-Z0-9]/g, '');

      // Pairing indicator
      const pairingLight = pairingMatch === true
        ? '<span class="rc-pairing-light rc-pair-match" title="Dish and router match">●</span>'
        : pairingMatch === false
          ? '<span class="rc-pairing-light rc-pair-mismatch" title="Dish and router DO NOT match!">●</span>'
          : '<span class="rc-pairing-light rc-pair-unknown" title="Unknown pairing">●</span>';

      return `
        <tr class="${modified ? 'rc-row-modified' : ''} ${pairingMatch === false ? 'rc-row-mismatch' : ''}">
          <td class="rc-th-check"><input type="checkbox" class="rc-router-check" data-router-id="${router.routerId}" ${checked}></td>
          <td>
            <div class="rc-router-identity">
              <span class="rc-dish-name">${dishName}</span>
              <span class="rc-router-name">${routerName}</span>
            </div>
          </td>
          <td class="rc-pairing-cell">${pairingLight}</td>
          <td>
            ${defaultName
              ? `<span class="rc-config-name-cell">${defaultName}</span>`
              : '<span class="rc-no-val">Not set</span>'}
          </td>
          <td class="rc-ssid-cell">${parsed.ssid || '<span class="rc-no-val">—</span>'}</td>
          <td>
            ${parsed.password
              ? `<span class="rc-pw-cell">
                  <code class="rc-pw-masked" id="${pwId}">${'•'.repeat(parsed.password.length)}</code>
                  <button class="rc-eye-btn" data-pw-id="${pwId}" data-pw="${parsed.password}" title="Toggle password">👁</button>
                </span>`
              : '<span class="rc-no-val">—</span>'}
          </td>
          <td>
            ${modified
              ? '<span class="rc-config-badge rc-modified">⚠ Modified</span>'
              : hasDefault
                ? '<span class="rc-config-badge is-default">✓ Default</span>'
                : '<span class="rc-config-badge no-config">No Default Set</span>'}
          </td>
          <td class="rc-actions-cell">
            <button class="btn btn-secondary btn-sm" onclick="handleSetRouterDefault('${router.routerId}')" title="Save current config as this router's default">${hasDefault ? '✎' : '★'} Set Default</button>
            <button class="btn btn-secondary btn-sm" onclick="handleAssignSingleRouter('${router.routerId}')" title="Assign a different config">Assign</button>
            ${modified ? `<button class="btn btn-primary btn-sm" onclick="handleRevertSingleRouter('${router.routerId}')" title="Revert to saved default">⟲ Revert</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.rc-router-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedRouterIds.add(cb.dataset.routerId);
        else state.selectedRouterIds.delete(cb.dataset.routerId);
        updateBulkBar();
      });
    });

    tbody.querySelectorAll('.rc-eye-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = document.getElementById(btn.dataset.pwId);
        if (!el) return;
        const realPw = btn.dataset.pw;
        if (el.textContent === realPw) {
          el.textContent = '•'.repeat(realPw.length);
        } else {
          el.textContent = realPw;
        }
      });
    });
  }

  function updateBulkBar() {
    const bar = $('rc-bulk-bar');
    const count = state.selectedRouterIds.size;
    if (count === 0) {
      bar.style.display = 'none';
    } else {
      bar.style.display = 'flex';
      $('rc-bulk-count').textContent = `${count} router${count > 1 ? 's' : ''} selected`;
    }
  }

  function handleSelectAllRouters(e) {
    const checked = e.target.checked;
    // Sync both select-all checkboxes
    $('rc-select-all').checked = checked;
    $('rc-thead-select-all').checked = checked;
    state.selectedRouterIds.clear();
    if (checked) {
      state.routerList.forEach(r => {
        state.selectedRouterIds.add(r.routerId);
      });
    }
    renderRouterTable();
    updateBulkBar();
  }

  // Remove a specific SSID from a config's basicServiceSets
  async function removeSsidFromConfig(configId, ssidToRemove) {
    const cfg = state.routerConfigs.find(c => c.configId === configId);
    if (!cfg) { showToast('Config not found', 'error'); return; }

    try {
      const raw = typeof cfg.routerConfigJson === 'string' ? JSON.parse(cfg.routerConfigJson) : { ...cfg.routerConfigJson };

      if (raw.networks && Array.isArray(raw.networks)) {
        for (const net of raw.networks) {
          if (net.basicServiceSets && Array.isArray(net.basicServiceSets)) {
            net.basicServiceSets = net.basicServiceSets.filter(bss => bss.ssid !== ssidToRemove);
          }
        }
        // Remove empty networks
        raw.networks = raw.networks.filter(net => net.basicServiceSets && net.basicServiceSets.length > 0);
      }

      const res = await fetch(`/api/router-configs/${configId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({
          nickname: cfg.nickname,
          routerConfigJson: JSON.stringify(raw),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `API returned ${res.status}`);
      }

      showToast(`Removed "${ssidToRemove}" from ${cfg.nickname}`, 'success');

      // Refresh configs
      state.routerConfigs = await fetchAllRouterConfigs();
      renderConfigCards();
      renderRouterTable();
    } catch (err) {
      showToast(`Failed to update config: ${err.message}`, 'error');
    }
  }

  // Bulk remove all non-Fello SSIDs from all configs
  async function bulkCleanExtraSsids() {
    // Find configs that have extra (non-Fello) SSIDs
    const dirtyConfigs = state.routerConfigs.filter(cfg => {
      const parsed = parseConfigJson(cfg.routerConfigJson);
      return parsed.allSsids.some(s => !s.ssid.toLowerCase().includes('fello'));
    });

    if (dirtyConfigs.length === 0) {
      showToast('All configs are already clean — no extra SSIDs found', 'success');
      return;
    }

    const extraCount = dirtyConfigs.reduce((sum, cfg) => {
      const parsed = parseConfigJson(cfg.routerConfigJson);
      return sum + parsed.allSsids.filter(s => !s.ssid.toLowerCase().includes('fello')).length;
    }, 0);

    if (!confirm(`Remove ${extraCount} extra SSID${extraCount > 1 ? 's' : ''} from ${dirtyConfigs.length} config${dirtyConfigs.length > 1 ? 's' : ''}?\n\nOnly "Fello IP" SSIDs will be kept.`)) return;

    let successCount = 0;
    let failCount = 0;

    for (const cfg of dirtyConfigs) {
      try {
        const raw = typeof cfg.routerConfigJson === 'string' ? JSON.parse(cfg.routerConfigJson) : { ...cfg.routerConfigJson };

        if (raw.networks && Array.isArray(raw.networks)) {
          for (const net of raw.networks) {
            if (net.basicServiceSets && Array.isArray(net.basicServiceSets)) {
              net.basicServiceSets = net.basicServiceSets.filter(bss =>
                bss.ssid && bss.ssid.toLowerCase().includes('fello')
              );
            }
          }
          raw.networks = raw.networks.filter(net => net.basicServiceSets && net.basicServiceSets.length > 0);
        }

        const res = await fetch(`/api/router-configs/${cfg.configId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${state.token}`,
          },
          body: JSON.stringify({
            nickname: cfg.nickname,
            routerConfigJson: JSON.stringify(raw),
          }),
        });

        if (!res.ok) throw new Error(`${res.status}`);
        successCount++;
      } catch (err) {
        console.error(`Failed to clean ${cfg.nickname}:`, err);
        failCount++;
      }
    }

    if (failCount > 0) {
      showToast(`Cleaned ${successCount} configs, ${failCount} failed`, 'error');
    } else {
      showToast(`Cleaned ${successCount} config${successCount > 1 ? 's' : ''} — extra SSIDs removed`, 'success');
    }

    // Refresh
    state.routerConfigs = await fetchAllRouterConfigs();
    renderConfigCards();
    renderRouterTable();
  }

  // Open the Add SSID modal and populate config checklist
  function openAddSsidModal() {
    // Clear form
    $('add-ssid-name').value = '';
    $('add-ssid-password').value = '';
    $('add-ssid-auth').value = 'WPA2';
    $('add-ssid-select-all').checked = false;
    $('add-ssid-error').style.display = 'none';

    const list = $('add-ssid-config-list');
    list.innerHTML = state.routerConfigs.map(cfg => {
      const parsed = parseConfigJson(cfg.routerConfigJson);
      const ssids = parsed.allSsids.map(s => s.ssid).join(', ') || 'No SSIDs';
      return `
        <label class="rc-add-ssid-config-item">
          <input type="checkbox" value="${cfg.configId}">
          <div class="rc-add-ssid-config-info">
            <span class="rc-add-ssid-config-name">${cfg.nickname || 'Unnamed'}</span>
            <span class="rc-add-ssid-config-ssids">${ssids}</span>
          </div>
        </label>`;
    }).join('');

    $('add-ssid-modal').style.display = 'flex';
  }

  // Handle adding an SSID to selected configs
  async function handleAddSsidToConfigs() {
    const ssid = $('add-ssid-name').value.trim();
    const password = $('add-ssid-password').value.trim();
    const authType = $('add-ssid-auth').value;
    const errorEl = $('add-ssid-error');

    // Validation
    if (!ssid) {
      errorEl.textContent = 'SSID is required';
      errorEl.style.display = 'block';
      return;
    }
    if (authType !== 'OPEN' && password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters';
      errorEl.style.display = 'block';
      return;
    }

    const selectedIds = [];
    $('add-ssid-config-list').querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      selectedIds.push(cb.value);
    });

    if (selectedIds.length === 0) {
      errorEl.textContent = 'Select at least one config';
      errorEl.style.display = 'block';
      return;
    }

    errorEl.style.display = 'none';

    // Build auth object for the new BSS
    const authObj = {};
    if (authType === 'WPA2') {
      authObj.authWpa2 = { password };
    } else if (authType === 'WPA3') {
      authObj.authWpa3 = { password };
    } else {
      authObj.authOpen = {};
    }

    // Show loading
    const submitBtn = $('add-ssid-submit');
    submitBtn.querySelector('.btn-text').style.display = 'none';
    submitBtn.querySelector('.btn-loader').style.display = 'inline-block';
    submitBtn.disabled = true;

    let successCount = 0;
    let failCount = 0;

    for (const configId of selectedIds) {
      const cfg = state.routerConfigs.find(c => c.configId === configId);
      if (!cfg) continue;

      try {
        const raw = typeof cfg.routerConfigJson === 'string' ? JSON.parse(cfg.routerConfigJson) : JSON.parse(JSON.stringify(cfg.routerConfigJson));

        // Ensure networks array exists
        if (!raw.networks || !Array.isArray(raw.networks)) {
          raw.networks = [];
        }

        // Check if this SSID already exists in this config
        const alreadyExists = raw.networks.some(net =>
          net.basicServiceSets?.some(bss => bss.ssid === ssid)
        );

        if (alreadyExists) {
          console.log(`SSID "${ssid}" already exists in ${cfg.nickname}, skipping`);
          successCount++;
          continue;
        }

        // Discover which bands this config uses (e.g. RF_2GHZ, RF_5GHZ)
        const existingBands = new Set();
        for (const net of raw.networks) {
          if (net.basicServiceSets) {
            for (const bss of net.basicServiceSets) {
              if (bss.band) existingBands.add(bss.band);
            }
          }
        }
        // Default to both bands if none found
        const bands = existingBands.size > 0
          ? [...existingBands]
          : ['RF_2GHZ', 'RF_5GHZ'];

        // Add a NEW network with one BSS per band (Starlink only allows 1 BSS per band per network)
        raw.networks.push({
          basicServiceSets: bands.map(band => ({
            ssid,
            band,
            ...authObj,
          })),
        });

        const res = await fetch(`/api/router-configs/${configId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${state.token}`,
          },
          body: JSON.stringify({
            nickname: cfg.nickname,
            routerConfigJson: JSON.stringify(raw),
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText || `${res.status}`);
        }
        successCount++;
      } catch (err) {
        console.error(`Failed to add SSID to ${cfg.nickname}:`, err);
        failCount++;
      }
    }

    // Reset button
    submitBtn.querySelector('.btn-text').style.display = '';
    submitBtn.querySelector('.btn-loader').style.display = 'none';
    submitBtn.disabled = false;

    if (failCount > 0) {
      showToast(`Added to ${successCount} config${successCount !== 1 ? 's' : ''}, ${failCount} failed`, 'error');
    } else {
      showToast(`Added "${ssid}" to ${successCount} config${successCount !== 1 ? 's' : ''}`, 'success');
    }

    $('add-ssid-modal').style.display = 'none';

    // Refresh
    state.routerConfigs = await fetchAllRouterConfigs();
    renderConfigCards();
    renderRouterTable();
  }

  async function handleCreateConfig() {
    const nickname = $('config-nickname').value.trim();
    const ssid = $('config-ssid').value.trim();
    const password = $('config-password').value.trim();
    const auth = $('config-auth').value;
    const errorEl = $('create-config-error');

    if (!nickname || !ssid) {
      errorEl.textContent = 'Config name and SSID are required';
      errorEl.style.display = 'block';
      return;
    }
    if (auth !== 'OPEN' && password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters';
      errorEl.style.display = 'block';
      return;
    }

    errorEl.style.display = 'none';
    const btn = $('create-config-submit');
    btn.querySelector('.btn-text').style.display = 'none';
    btn.querySelector('.btn-loader').style.display = 'inline-block';

    try {
      // Build auth object based on security type
      const authObj = auth === 'OPEN' ? { authOpen: {} }
        : auth === 'WPA3' ? { authWpa3: { password } }
        : { authWpa2: { password } };

      const bss = { ssid, ...authObj };
      const configJson = {
        setupComplete: true,
        applyNetworks: true,
        networks: [{
          basicServiceSets: [
            { ...bss, band: 'RF_2GHZ' },
            { ...bss, band: 'RF_5GHZ' },
          ],
        }],
      };

      const res = await fetch('/api/router-configs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({
          nickname: nickname,
          routerConfigJson: JSON.stringify(configJson),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create config');
      }

      showToast('Config "' + nickname + '" created successfully!', 'success');
      $('create-config-modal').style.display = 'none';
      $('config-nickname').value = '';
      $('config-ssid').value = '';
      $('config-password').value = '';

      state.routerConfigs = await fetchAllRouterConfigs();
      renderConfigCards();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.querySelector('.btn-text').style.display = 'inline';
      btn.querySelector('.btn-loader').style.display = 'none';
    }
  }

  // ── Per-Router Default Management ──────────────────────────────────

  window.handleSetRouterDefault = function(routerId) {
    const router = state.routerList.find(r => r.routerId === routerId);
    if (!router || !router.configId) {
      showToast('This router has no config assigned. Assign a config first, then set it as default.', 'error');
      return;
    }
    const configName = getConfigName(router.configId);
    if (!confirm(`Save "${configName}" as the default WiFi profile for this router?\n\nYou can revert to this profile anytime after a customer change.`)) return;

    state.routerDefaults[routerId] = router.configId;
    saveRouterDefaults();
    showToast(`Default saved for router ${routerId.slice(0, 12)}`, 'success');
    renderConfigCards();
    renderRouterTable();
  };

  window.handleRevertSingleRouter = async function(routerId) {
    const defaultCfgId = getRouterDefaultConfigId(routerId);
    if (!defaultCfgId) {
      showToast('No default set for this router.', 'error');
      return;
    }
    const configName = getConfigName(defaultCfgId);
    if (!confirm(`Revert this router to "${configName}"?\n\nThe config will push within 1-2 minutes.`)) return;

    try {
      const res = await fetch('/api/router-configs/assign', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ configId: defaultCfgId, routerIds: [routerId] }),
      });
      if (!res.ok) throw new Error('Failed to assign config');

      const router = state.routerList.find(r => r.routerId === routerId);
      if (router) router.configId = defaultCfgId;

      showToast(`Router reverted to "${configName}"!`, 'success');
      renderRouterTable();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.handleAssignSingleRouter = function(routerId) {
    state.selectedRouterIds.clear();
    state.selectedRouterIds.add(routerId);
    openAssignConfigModal();
  };

  function openAssignConfigModal() {
    const list = $('rc-assign-list');
    const count = state.selectedRouterIds.size;
    $('assign-router-count').textContent = `Assigning to ${count} router${count > 1 ? 's' : ''}`;

    list.innerHTML = state.routerConfigs.map(cfg => {
      const parsed = parseConfigJson(cfg.routerConfigJson);
      return `
        <div class="rc-assign-option" data-config-id="${cfg.configId}">
          <div>
            <div class="rc-assign-name">${cfg.nickname || 'Unnamed'}</div>
            <div class="rc-assign-ssid">SSID: ${parsed.ssid || 'N/A'}</div>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.rc-assign-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        const configId = opt.dataset.configId;
        // Visual feedback
        list.querySelectorAll('.rc-assign-option').forEach(o => o.style.pointerEvents = 'none');
        opt.style.opacity = '0.6';
        opt.textContent = 'Assigning...';
        const errorEl = $('assign-config-error');
        errorEl.style.display = 'none';
        try {
          await assignConfigToSelectedRouters(configId);
          $('assign-config-modal').style.display = 'none';
        } catch (err) {
          errorEl.textContent = 'Error: ' + err.message;
          errorEl.style.display = 'block';
          opt.style.opacity = '1';
          list.querySelectorAll('.rc-assign-option').forEach(o => o.style.pointerEvents = 'auto');
          // Re-render the option text
          const parsed = parseConfigJson(state.routerConfigs.find(c => c.configId === configId)?.routerConfigJson);
          opt.innerHTML = `<div><div class="rc-assign-name">${state.routerConfigs.find(c => c.configId === configId)?.nickname || 'Unnamed'}</div><div class="rc-assign-ssid">SSID: ${parsed.ssid || 'N/A'}</div></div>`;
        }
      });
    });

    $('assign-config-modal').style.display = 'flex';
  }

  async function assignConfigToSelectedRouters(configId) {
    const routerIds = Array.from(state.selectedRouterIds);
    if (routerIds.length === 0) return;

    try {
      const res = await fetch('/api/router-configs/assign', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ configId, routerIds }),
      });

      console.log('Assign response status:', res.status);
      const resText = await res.text();
      console.log('Assign response body:', resText);

      if (!res.ok) {
        const errMsg = resText || `API returned ${res.status}`;
        throw new Error(errMsg);
      }

      const configName = getConfigName(configId);
      showToast(`"${configName}" assigned to ${routerIds.length} router${routerIds.length > 1 ? 's' : ''}!`, 'success');

      // Update local state
      routerIds.forEach(id => {
        const router = state.routerList.find(r => r.routerId === id);
        if (router) router.configId = configId;
      });

      state.selectedRouterIds.clear();
      renderRouterTable();
      updateBulkBar();
      $('rc-select-all').checked = false;
    } catch (err) {
      showToast('Error assigning config: ' + err.message, 'error');
    }
  }

  async function handleBulkRevertToDefault() {
    if (!state.defaultConfigId) {
      showToast('No default config set. Please set a default first.', 'error');
      return;
    }
    const count = state.selectedRouterIds.size;
    if (count === 0) return;

    const configName = getConfigName(state.defaultConfigId);
    if (!confirm(`Revert ${count} router${count > 1 ? 's' : ''} to default config "${configName}"?\n\nThis will push the config to online routers within 1-2 minutes.`)) {
      return;
    }

    await assignConfigToSelectedRouters(state.defaultConfigId);
  }

})();
