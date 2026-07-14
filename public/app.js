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
    routerConfigs: [],       // all saved configs
    defaultConfigId: null,   // account default config id
    routerList: [],          // routers with their config assignments
    selectedRouterIds: new Set(),
    rcLoaded: false,         // whether router config data has been loaded
  };

  // ── Constants ───────────────────────────────────────────────────────
  const STORAGE_KEYS = {
    credentials: 'starlink_credentials',
    nicknames: 'starlink_nicknames',
    refreshInterval: 'starlink_refresh_interval',
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
    $('rc-bulk-revert').addEventListener('click', handleBulkRevertToDefault);
    $('rc-bulk-assign').addEventListener('click', () => {
      openAssignConfigModal();
    });

    checkSavedCredentials();
  });

  // ══════════════════════════════════════════════════════════════════
  // ══ ROUTER CONFIG MODULE ═════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════

  async function loadRouterConfigData() {
    try {
      const [configs, defaultCfg, terminals] = await Promise.all([
        fetchAllRouterConfigs(),
        fetchDefaultConfig(),
        fetchAllUserTerminals(),
      ]);

      state.routerConfigs = configs;
      state.defaultConfigId = defaultCfg;
      state.rcLoaded = true;

      // Build router list from user terminals
      await buildRouterList(terminals);

      renderDefaultConfigCard();
      renderConfigCards();
      renderRouterTable();
    } catch (err) {
      console.error('Router config load error:', err);
      toast('Failed to load router configs: ' + err.message, 'error');
    }
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

  async function fetchDefaultConfig() {
    const res = await fetch('/api/router-configs/default', {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.content?.configId || null;
  }

  async function fetchAllUserTerminals() {
    // We already have user terminal data from the data-usage flow
    // But we need router info — let's re-fetch to get routerId linkage
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
      const routerId = ut.routerId || ut.kitSerialNumber;
      if (!routerId) continue;

      // Try to get router details to find its config assignment
      let configId = null;
      let nickname = null;
      try {
        const res = await fetch(`/api/routers/${routerId}`, {
          headers: { Authorization: `Bearer ${state.token}` },
        });
        if (res.ok) {
          const data = await res.json();
          configId = data?.content?.configId || null;
          nickname = data?.content?.nickname || null;
        }
      } catch (e) {
        // Router detail fetch failed, that's ok
      }

      routers.push({
        routerId: routerId,
        routerNickname: nickname,
        userTerminalId: ut.userTerminalId || ut.dishSerialNumber,
        kitSerialNumber: ut.kitSerialNumber,
        dishSerialNumber: ut.dishSerialNumber,
        configId: configId,
        serviceLineNumber: ut.serviceLineNumber,
      });
    }
    state.routerList = routers;
  }

  function parseConfigJson(routerConfigJson) {
    try {
      const cfg = typeof routerConfigJson === 'string' ? JSON.parse(routerConfigJson) : routerConfigJson;
      // Try to extract WiFi network info from common structures
      // The Starlink config JSON can vary, but commonly has networks array
      let ssid = null, password = null, auth = null;

      if (cfg.networks && Array.isArray(cfg.networks)) {
        const net = cfg.networks[0];
        ssid = net?.ssid || net?.name || null;
        password = net?.password || net?.psk || null;
        auth = net?.auth || net?.security || null;
      } else if (cfg.wifi) {
        ssid = cfg.wifi.ssid || cfg.wifi.name || null;
        password = cfg.wifi.password || cfg.wifi.psk || null;
        auth = cfg.wifi.auth || cfg.wifi.security || null;
      } else if (cfg.ssid) {
        ssid = cfg.ssid;
        password = cfg.password || cfg.psk || null;
        auth = cfg.auth || cfg.security || null;
      }

      return { ssid, password, auth, raw: cfg };
    } catch {
      return { ssid: null, password: null, auth: null, raw: routerConfigJson };
    }
  }

  function getConfigName(configId) {
    const cfg = state.routerConfigs.find(c => c.configId === configId);
    return cfg?.nickname || configId?.slice(0, 8) || 'Unknown';
  }

  function renderDefaultConfigCard() {
    const card = $('rc-default-card');
    if (!state.defaultConfigId) {
      card.innerHTML = `
        <div class="rc-no-default">
          No default config set. Create a config and set it as default to enable bulk revert.
        </div>
      `;
      return;
    }

    const cfg = state.routerConfigs.find(c => c.configId === state.defaultConfigId);
    if (!cfg) {
      card.innerHTML = `
        <div class="rc-no-default">
          Default config ID set (${state.defaultConfigId.slice(0, 12)}...) but config details not found.
        </div>
      `;
      return;
    }

    const parsed = parseConfigJson(cfg.routerConfigJson);
    card.innerHTML = `
      <div class="rc-default-info">
        <div class="rc-default-detail">
          <span class="rc-label">Config Name</span>
          <span class="rc-value">${cfg.nickname || 'Unnamed'}</span>
        </div>
        <div class="rc-default-detail">
          <span class="rc-label">WiFi Name (SSID)</span>
          <span class="rc-value">${parsed.ssid || 'N/A'}</span>
        </div>
        <div class="rc-default-detail">
          <span class="rc-label">Password</span>
          <span class="rc-value rc-password">
            <span id="default-pw-display">••••••••</span>
            <button class="rc-eye-btn" onclick="document.getElementById('default-pw-display').textContent = document.getElementById('default-pw-display').textContent === '••••••••' ? '${parsed.password || 'N/A'}' : '••••••••'">👁</button>
          </span>
        </div>
        ${parsed.auth ? `
        <div class="rc-default-detail">
          <span class="rc-label">Security</span>
          <span class="rc-value">${parsed.auth}</span>
        </div>` : ''}
        <div class="rc-default-actions">
          <button class="btn btn-secondary btn-sm" onclick="handleChangeDefault()">Change Default</button>
        </div>
      </div>
    `;
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

    grid.innerHTML = state.routerConfigs.map(cfg => {
      const parsed = parseConfigJson(cfg.routerConfigJson);
      const isDefault = cfg.configId === state.defaultConfigId;
      return `
        <div class="rc-config-card ${isDefault ? 'is-default' : ''}" data-config-id="${cfg.configId}">
          <div class="rc-card-name">
            ${cfg.nickname || 'Unnamed Config'}
            ${isDefault ? '<span class="rc-default-badge">Default</span>' : ''}
          </div>
          <div class="rc-card-field">
            <span class="rc-field-label">SSID</span>
            <span class="rc-field-value">${parsed.ssid || 'N/A'}</span>
          </div>
          <div class="rc-card-field">
            <span class="rc-field-label">Password</span>
            <span class="rc-field-value">${parsed.password ? '•'.repeat(parsed.password.length) : 'N/A'}</span>
          </div>
          ${parsed.auth ? `
          <div class="rc-card-field">
            <span class="rc-field-label">Security</span>
            <span class="rc-field-value">${parsed.auth}</span>
          </div>` : ''}
          <div class="rc-card-actions">
            ${!isDefault ? `<button class="btn btn-primary btn-sm" onclick="handleSetAsDefault('${cfg.configId}')">Set as Default</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderRouterTable() {
    const tbody = $('rc-router-body');
    if (state.routerList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="rc-loading-row">No routers found on this account</td></tr>';
      return;
    }

    tbody.innerHTML = state.routerList.map(router => {
      const configName = router.configId ? getConfigName(router.configId) : null;
      const isDefault = router.configId === state.defaultConfigId;
      const checked = state.selectedRouterIds.has(router.routerId) ? 'checked' : '';

      // Find friendly name from device map
      const deviceInfo = Object.values(state.deviceMap).find(d =>
        d.kitSerial === router.kitSerialNumber || d.dishSerial === router.dishSerialNumber
      );
      const terminalName = deviceInfo?.slNickname || deviceInfo?.utNickname || router.dishSerialNumber || router.userTerminalId || '—';

      return `
        <tr>
          <td class="rc-th-check"><input type="checkbox" class="rc-router-check" data-router-id="${router.routerId}" ${checked}></td>
          <td>${router.routerId?.slice(0, 12) || '—'}${router.routerNickname ? ` <small>(${router.routerNickname})</small>` : ''}</td>
          <td>${terminalName}</td>
          <td>
            <span class="rc-config-name-cell">
              ${configName
                ? `${configName} <span class="rc-config-badge ${isDefault ? 'is-default' : ''}">${isDefault ? 'Default' : 'Custom'}</span>`
                : '<span class="rc-config-badge no-config">No Config</span>'}
            </span>
          </td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="handleAssignSingleRouter('${router.routerId}')">Assign</button>
          </td>
        </tr>
      `;
    }).join('');

    // Add checkbox listeners
    tbody.querySelectorAll('.rc-router-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedRouterIds.add(cb.dataset.routerId);
        else state.selectedRouterIds.delete(cb.dataset.routerId);
        updateBulkBar();
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
    state.selectedRouterIds.clear();
    if (checked) {
      state.routerList.forEach(r => state.selectedRouterIds.add(r.routerId));
    }
    renderRouterTable();
    updateBulkBar();
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
      const configJson = {
        networks: [{
          ssid: ssid,
          password: auth !== 'OPEN' ? password : undefined,
          auth: auth,
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

      toast('Config "' + nickname + '" created successfully!', 'success');
      $('create-config-modal').style.display = 'none';
      $('config-nickname').value = '';
      $('config-ssid').value = '';
      $('config-password').value = '';

      // Reload configs
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

  // Expose to onclick handlers in HTML
  window.handleSetAsDefault = async function(configId) {
    if (!confirm('Set this config as the account default? All new routers will receive this config.')) return;
    try {
      const res = await fetch('/api/router-configs/default', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify({ configId }),
      });
      if (!res.ok) throw new Error('Failed to set default config');
      state.defaultConfigId = configId;
      toast('Default config updated!', 'success');
      renderDefaultConfigCard();
      renderConfigCards();
      renderRouterTable();
    } catch (err) {
      toast('Error: ' + err.message, 'error');
    }
  };

  window.handleChangeDefault = function() {
    openAssignConfigModal(true);
  };

  window.handleAssignSingleRouter = function(routerId) {
    state.selectedRouterIds.clear();
    state.selectedRouterIds.add(routerId);
    openAssignConfigModal();
  };

  function openAssignConfigModal(isSettingDefault = false) {
    const list = $('rc-assign-list');
    const count = state.selectedRouterIds.size;
    $('assign-router-count').textContent = isSettingDefault
      ? 'Select the new default config'
      : `Assigning to ${count} router${count > 1 ? 's' : ''}`;

    list.innerHTML = state.routerConfigs.map(cfg => {
      const parsed = parseConfigJson(cfg.routerConfigJson);
      const isDefault = cfg.configId === state.defaultConfigId;
      return `
        <div class="rc-assign-option" data-config-id="${cfg.configId}" data-is-default-action="${isSettingDefault}">
          <div>
            <div class="rc-assign-name">${cfg.nickname || 'Unnamed'}</div>
            <div class="rc-assign-ssid">SSID: ${parsed.ssid || 'N/A'}</div>
          </div>
          ${isDefault ? '<span class="rc-assign-badge">Current Default</span>' : ''}
        </div>
      `;
    }).join('');

    // Add click handlers to options
    list.querySelectorAll('.rc-assign-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        const configId = opt.dataset.configId;
        const isDefaultAction = opt.dataset.isDefaultAction === 'true';

        if (isDefaultAction) {
          await window.handleSetAsDefault(configId);
        } else {
          await assignConfigToSelectedRouters(configId);
        }
        $('assign-config-modal').style.display = 'none';
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

      if (!res.ok) throw new Error('Failed to assign config');

      const configName = getConfigName(configId);
      toast(`"${configName}" assigned to ${routerIds.length} router${routerIds.length > 1 ? 's' : ''}!`, 'success');

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
      toast('Error assigning config: ' + err.message, 'error');
    }
  }

  async function handleBulkRevertToDefault() {
    if (!state.defaultConfigId) {
      toast('No default config set. Please set a default first.', 'error');
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
