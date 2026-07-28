(function() {
  'use strict';

  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const searchSpinner = document.getElementById('search-spinner');
  const resultsContainer = document.getElementById('results-container');
  
  let currentChart = null;
  let currentMap = null;

  // ── Column Definitions ──────────────────────────────────────
  // All possible columns with source, key, label, and default visibility
  const ALL_COLUMNS = [
    // Link status
    { key: 'linked',       label: '🔗',            source: 'meta',    default: true,  group: 'Status' },
    // iPad (SimpleMDM)
    { key: 'name',         label: 'iPad Name',     source: 'ipad',    default: true,  group: 'iPad' },
    { key: 'ipadSerial',   label: 'iPad Serial',   source: 'ipad',    default: true,  group: 'iPad' },
    { key: 'model',        label: 'Model',         source: 'ipad',    default: true,  group: 'iPad' },
    { key: 'os',           label: 'OS Version',    source: 'ipad',    default: true,  group: 'iPad' },
    { key: 'battery',      label: 'Battery',       source: 'ipad',    default: true,  group: 'iPad' },
    { key: 'capacity',     label: 'Storage',       source: 'ipad',    default: false, group: 'iPad' },
    { key: 'lastSeenAt',   label: 'Last Seen',     source: 'ipad',    default: false, group: 'iPad' },
    { key: 'enrolledAt',   label: 'Enrolled',      source: 'ipad',    default: false, group: 'iPad' },
    { key: 'phoneNumber',  label: 'Phone #',       source: 'ipad',    default: false, group: 'iPad' },
    { key: 'wifiMac',      label: 'WiFi MAC',      source: 'ipad',    default: false, group: 'iPad' },
    { key: 'mdmImei',      label: 'MDM IMEI',      source: 'ipad',    default: false, group: 'iPad' },
    // Bridge
    { key: 'imei',         label: 'IMEI',          source: 'bridge',  default: true,  group: 'Bridge' },
    { key: 'eid',          label: 'EID/eSIM',      source: 'bridge',  default: false, group: 'Bridge' },
    // SIM (Webbing)
    { key: 'simSerial',    label: 'SIM Serial',    source: 'sim',     default: true,  group: 'SIM' },
    { key: 'iccid',        label: 'ICCID',         source: 'sim',     default: true,  group: 'SIM' },
    { key: 'carrier',      label: 'Carrier',       source: 'sim',     default: true,  group: 'SIM' },
    { key: 'simStatus',    label: 'SIM Status',    source: 'sim',     default: true,  group: 'SIM' },
    { key: 'plan',         label: 'Plan',          source: 'sim',     default: false, group: 'SIM' },
    { key: 'ip',           label: 'IP Address',    source: 'sim',     default: false, group: 'SIM' },
    { key: 'simModel',     label: 'SIM Device',    source: 'sim',     default: false, group: 'SIM' },
    { key: 'vendor',       label: 'Vendor',        source: 'sim',     default: false, group: 'SIM' },
  ];

  // Load saved column prefs from localStorage
  const STORAGE_KEY = 'fello_lookup_columns';
  function getVisibleColumns() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return ALL_COLUMNS.filter(c => c.default).map(c => c.key);
  }
  function saveVisibleColumns(keys) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  }
  let visibleColumns = getVisibleColumns();

  // ── Event Listeners ──────────────────────────────────────────
  searchBtn.addEventListener('click', handleSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSearch();
  });

  // ── Search Logic ─────────────────────────────────────────────
  async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    setLoading(true);
    resultsContainer.classList.remove('visible');
    
    // Clear previous instances
    if (currentChart) { currentChart.destroy(); currentChart = null; }
    if (currentMap) { currentMap.remove(); currentMap = null; }

    try {
      const response = await fetch(`/api/lookup?q=${encodeURIComponent(query)}`);
      
      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data.found && data.found !== undefined) {
        renderError(`No results found for "${esc(query)}". Try a different Group Number or Serial.`);
      } else if (data.type === 'group') {
        renderGroupResults(data, query);
      } else if (data.type === 'device') {
        renderDeviceResults(data);
      } else if (data.type === 'mdm_device') {
        renderMdmDeviceResults(data);
      } else {
        renderError('Unknown result type received.');
      }
      
    } catch (err) {
      console.error(err);
      renderError(err.message || 'An error occurred during search.');
    } finally {
      setLoading(false);
      resultsContainer.classList.add('visible');
    }
  }

  function setLoading(isLoading) {
    if (isLoading) {
      searchSpinner.style.display = 'block';
      searchBtn.style.opacity = '0.5';
      searchBtn.disabled = true;
    } else {
      searchSpinner.style.display = 'none';
      searchBtn.style.opacity = '1';
      searchBtn.disabled = false;
    }
  }

  // ── Render Helpers ───────────────────────────────────────────
  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMB(mb) {
    if (mb == null) return '0 MB';
    const num = parseFloat(mb);
    if (isNaN(num)) return '0 MB';
    if (num > 1024) return (num / 1024).toFixed(2) + ' GB';
    return num.toFixed(2) + ' MB';
  }

  function getStatusBadge(statusId) {
    // 3 = Active, 4 = Suspended (assuming from previous webbing context)
    let text = 'Unknown';
    let cls = 'badge-inactive';
    if (statusId === 3 || String(statusId).toLowerCase() === 'active') {
      text = 'Active';
      cls = 'badge-active';
    } else if (statusId === 4 || String(statusId).toLowerCase() === 'suspended') {
      text = 'Suspended';
      cls = 'badge-suspended';
    } else if (statusId) {
      text = String(statusId);
    }
    return `<span class="badge ${cls}">${esc(text)}</span>`;
  }

  function renderError(message) {
    resultsContainer.innerHTML = `
      <div class="section" style="border-color: var(--red);">
        <div class="section-content" style="color: var(--red); font-weight: 500;">
          ⚠️ ${esc(message)}
        </div>
      </div>
    `;
  }

  // ── Group Results ────────────────────────────────────────────
  function renderGroupResults(data, query) {
    const mdm = data.simpleMdmDevices || [];
    const web = data.webbingDevices || [];
    const stats = data.stats || {};
    const usage = data.usage || {};
    const matchIcon = stats.countMatch ? '✅' : '⚠️';
    const branchId = data.branchName || query;

    let html = `
      <!-- Overview Bar -->
      <div class="stats-bar">
        <div class="stat-card stat-purple">
          <div class="stat-label">iPads Found</div>
          <div class="stat-value">${esc(stats.mdmCount || mdm.length)}</div>
        </div>
        <div class="stat-card stat-blue">
          <div class="stat-label">SIM Lines</div>
          <div class="stat-value">${esc(stats.webbingCount || web.length)}</div>
        </div>
        <div class="stat-card stat-green">
          <div class="stat-label">🔗 Matched</div>
          <div class="stat-value">${esc(stats.matchedCount || 0)} / ${esc(Math.max(stats.mdmCount, stats.webbingCount) || 0)}</div>
        </div>
        <div class="stat-card stat-amber">
          <div class="stat-label">Counts Match</div>
          <div class="stat-value">${matchIcon} ${stats.countMatch ? 'Yes' : 'No'}</div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="actions-bar">
        <button class="btn btn-warning" onclick="window.bulkAction('${esc(branchId)}', 'suspend')">⏸ Bulk Suspend SIMs</button>
        <button class="btn btn-success" onclick="window.bulkAction('${esc(branchId)}', 'activate')">▶ Bulk Activate SIMs</button>
      </div>
    `;

    // Build unified rows with ALL available fields
    const matched = data.matches || [];
    const unmatchedIpads = mdm.filter(d => !d.matchedSimSerial);
    const unmatchedSims = web.filter(w => !w.matchedIpadName);
    
    // Store rows globally so column picker can re-render
    window._fleetRows = [];
    window._fleetData = data;
    
    // Matched pairs first
    for (const m of matched) {
      const ipad = mdm.find(d => d.serial === m.ipadSerial) || {};
      const sim = web.find(w => (w.serial || w.ssid) === m.simSerial) || {};
      window._fleetRows.push({
        linked: true,
        // iPad fields
        name: m.ipadName,
        ipadSerial: m.ipadSerial,
        model: ipad.model || ipad.model_name || '',
        os: ipad.osVersion || ipad.os_version || '',
        battery: ipad.batteryLevel || ipad.battery_level || null,
        capacity: ipad.capacity || '',
        lastSeenAt: ipad.lastSeenAt ? new Date(ipad.lastSeenAt).toLocaleString() : '',
        enrolledAt: ipad.enrolledAt ? new Date(ipad.enrolledAt).toLocaleDateString() : '',
        phoneNumber: ipad.phoneNumber || '',
        wifiMac: ipad.wifiMac || '',
        mdmImei: ipad.imei || '',
        // Bridge fields
        imei: m.ipadImei,
        eid: ipad.allImeis?.length > 1 ? ipad.allImeis.slice(1).join(', ') : '',
        // SIM fields
        simSerial: m.simSerial,
        iccid: m.simIccid,
        carrier: m.simCarrier,
        simStatus: sim.statusId || sim.status || m.simStatus,
        plan: sim.plan || '',
        ip: m.simIp || sim.ip || '',
        simModel: sim.model || '',
        vendor: sim.vendor || ''
      });
    }
    // Unmatched iPads
    for (const d of unmatchedIpads) {
      window._fleetRows.push({
        linked: false,
        name: d.name || d.device_name || '',
        ipadSerial: d.serial || d.serial_number || '',
        model: d.model || d.model_name || '',
        os: d.osVersion || d.os_version || '',
        battery: d.batteryLevel || d.battery_level || null,
        capacity: d.capacity || '',
        lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '',
        enrolledAt: d.enrolledAt ? new Date(d.enrolledAt).toLocaleDateString() : '',
        phoneNumber: d.phoneNumber || '',
        wifiMac: d.wifiMac || '',
        mdmImei: d.imei || '',
        imei: d.abmImei || '',
        eid: '',
        simSerial: '', iccid: '', carrier: '', simStatus: null,
        plan: '', ip: '', simModel: '', vendor: ''
      });
    }
    // Unmatched SIMs
    for (const w of unmatchedSims) {
      window._fleetRows.push({
        linked: false,
        name: '', ipadSerial: '', model: '', os: '', battery: null,
        capacity: '', lastSeenAt: '', enrolledAt: '',
        phoneNumber: '', wifiMac: '', mdmImei: '',
        imei: w.imei || '',
        eid: '',
        simSerial: w.ssid || w.serial || '',
        iccid: w.iccid || '',
        carrier: w.carrier || w.network || '',
        simStatus: w.statusId || w.status,
        plan: w.plan || '',
        ip: w.ip || w.ipAddress || '',
        simModel: w.model || '',
        vendor: w.vendor || ''
      });
    }

    // Column picker dropdown
    const groups = {};
    ALL_COLUMNS.forEach(c => {
      if (!groups[c.group]) groups[c.group] = [];
      groups[c.group].push(c);
    });

    let pickerHtml = `
      <div class="column-picker-wrapper">
        <button class="btn btn-outline column-picker-toggle" id="col-picker-btn" title="Choose columns">
          ⚙️ Columns <span class="col-count">(${visibleColumns.length}/${ALL_COLUMNS.length})</span>
        </button>
        <div class="column-picker-dropdown" id="col-picker-dropdown" style="display:none;">
          <div class="col-picker-header">
            <span>Show / Hide Columns</span>
            <button class="col-picker-reset" id="col-reset-btn">Reset</button>
          </div>
          ${Object.entries(groups).map(([group, cols]) => `
            <div class="col-picker-group">
              <div class="col-picker-group-label">${esc(group)}</div>
              ${cols.map(c => `
                <label class="col-picker-item">
                  <input type="checkbox" value="${c.key}" ${visibleColumns.includes(c.key) ? 'checked' : ''}>
                  <span>${esc(c.label)}</span>
                </label>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // Render the table
    const visCols = ALL_COLUMNS.filter(c => visibleColumns.includes(c.key));
    html += `
      <div class="section" id="sec-unified">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="section-title"><span class="section-icon">📋</span> Fleet Overview — iPad + SIM Pairs</div>
          <div class="chevron">▼</div>
        </div>
        <div class="section-content">
          <div class="table-toolbar">
            ${pickerHtml}
            <span class="table-info">${window._fleetRows.length} rows · ${matched.length} matched</span>
          </div>
          <div class="table-responsive" id="fleet-table-wrap">
            ${buildFleetTable(window._fleetRows, visCols)}
          </div>
        </div>
      </div>
    `;

    resultsContainer.innerHTML = html;
    
    // Wire up column picker
    initColumnPicker();
  }

  function buildFleetTable(rows, visCols) {
    const ipadBorderCol = (() => {
      const ipadCols = visCols.filter(c => c.source === 'ipad' || c.source === 'meta');
      return ipadCols.length > 0 ? ipadCols[ipadCols.length - 1].key : null;
    })();
    
    return `
      <table>
        <thead>
          <tr>
            ${visCols.map(c => `
              <th style="${c.key === ipadBorderCol ? 'border-right: 2px solid var(--border);' : ''}">${esc(c.label)}</th>
            `).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="${visCols.length}">No devices found.</td></tr>` : ''}
          ${rows.map(r => `
            <tr style="${!r.linked ? 'opacity: 0.6;' : ''}">
              ${visCols.map(c => {
                const style = c.key === ipadBorderCol ? 'border-right: 2px solid var(--border);' : '';
                return `<td style="${style}" class="${isMonoCol(c.key) ? 'mono' : ''}">${formatCell(c.key, r[c.key], r)}</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function isMonoCol(key) {
    return ['ipadSerial', 'imei', 'eid', 'simSerial', 'iccid', 'ip', 'wifiMac', 'mdmImei', 'phoneNumber'].includes(key);
  }

  function formatCell(key, val, row) {
    const empty = '<span style="color:var(--text-muted)">—</span>';
    switch(key) {
      case 'linked':
        return row.linked
          ? '<span style="color: var(--green); font-weight: bold;">✓</span>'
          : '<span style="color: var(--amber);">✗</span>';
      case 'battery':
        return val ? val + (String(val).includes('%') ? '' : '%') : '—';
      case 'simStatus':
        return val ? getStatusBadge(val) : '—';
      case 'imei':
      case 'iccid':
      case 'eid':
        return val ? `<span style="font-size:0.75rem">${esc(String(val))}</span>` : empty;
      default:
        return val ? esc(String(val)) : empty;
    }
  }

  function initColumnPicker() {
    const btn = document.getElementById('col-picker-btn');
    const dropdown = document.getElementById('col-picker-dropdown');
    const resetBtn = document.getElementById('col-reset-btn');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });

    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.style.display = 'none';
      }
    });

    dropdown.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        visibleColumns = Array.from(dropdown.querySelectorAll('input:checked')).map(i => i.value);
        saveVisibleColumns(visibleColumns);
        const visCols = ALL_COLUMNS.filter(c => visibleColumns.includes(c.key));
        document.getElementById('fleet-table-wrap').innerHTML = buildFleetTable(window._fleetRows, visCols);
        btn.querySelector('.col-count').textContent = `(${visibleColumns.length}/${ALL_COLUMNS.length})`;
      });
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        visibleColumns = ALL_COLUMNS.filter(c => c.default).map(c => c.key);
        saveVisibleColumns(visibleColumns);
        dropdown.querySelectorAll('input[type=checkbox]').forEach(cb => {
          cb.checked = visibleColumns.includes(cb.value);
        });
        const visCols = ALL_COLUMNS.filter(c => visibleColumns.includes(c.key));
        document.getElementById('fleet-table-wrap').innerHTML = buildFleetTable(window._fleetRows, visCols);
        btn.querySelector('.col-count').textContent = `(${visibleColumns.length}/${ALL_COLUMNS.length})`;
      });
    }
  }

  // Group Actions (Global for inline handlers)
  window.bulkAction = async function(branchId, action) {
    if (!confirm(`Are you sure you want to bulk ${action} all SIMs for branch ${branchId}?`)) return;
    try {
      const res = await fetch(`/api/webbing/branches/${encodeURIComponent(branchId)}/${action}`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Action failed');
      alert(`Successfully triggered bulk ${action}.`);
      handleSearch(); // Refresh
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  // ── Device Results ───────────────────────────────────────────
  function renderDeviceResults(data) {
    const dev = data.device || {};
    const live = data.liveData || {};
    const usage = data.usage || {};
    const loc = data.location || {};

    let html = `
      <!-- Device Header -->
      <div class="device-header">
        <div class="device-title">
          <h2>📱 ${esc(dev.serial || dev.ssid)}</h2>
          ${getStatusBadge(dev.statusId || dev.status)}
        </div>
        <div class="device-branch">
          Branch: <strong>${esc(dev.branchName || dev.branch)}</strong>
        </div>
      </div>

      <!-- Controls -->
      <div class="actions-bar" style="margin-bottom: 24px;">
        <button class="btn btn-success" onclick="window.deviceAction('${esc(dev.iccid)}', 'activate')">▶ Activate</button>
        <button class="btn btn-warning" onclick="window.deviceAction('${esc(dev.iccid)}', 'suspend')">⏸ Suspend</button>
      </div>

      <!-- Info Grid -->
      <div class="section">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="section-title"><span class="section-icon">📋</span> Device Info</div>
          <div class="chevron">▼</div>
        </div>
        <div class="section-content">
          <div class="info-grid">
            <div class="info-item"><span class="info-label">SSID / Serial</span><span class="info-value mono">${esc(dev.ssid || dev.serial)}</span></div>
            <div class="info-item"><span class="info-label">MSISDN</span><span class="info-value mono">${esc(dev.msisdn)}</span></div>
            <div class="info-item"><span class="info-label">Plan</span><span class="info-value">${esc(dev.planName || dev.plan)}</span></div>
            <div class="info-item"><span class="info-label">Branch / Order ID</span><span class="info-value">${esc(dev.branchName || dev.branch)}</span></div>
            <div class="info-item"><span class="info-label">Device Type</span><span class="info-value">${esc(dev.deviceType)}</span></div>
            <div class="info-item"><span class="info-label">Status Updated</span><span class="info-value">${dev.statusDate ? new Date(dev.statusDate).toLocaleString() : '-'}</span></div>
          </div>
        </div>
      </div>

      <!-- Live Telemetry -->
      <div class="section">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="section-title"><span class="section-icon">📡</span> Live Telemetry</div>
          <div class="chevron">▼</div>
        </div>
        <div class="section-content">
          <div class="info-grid">
            <div class="info-item"><span class="info-label">IMEI</span><span class="info-value mono">${esc(live.imei || dev.imei)}</span></div>
            <div class="info-item"><span class="info-label">ICCID</span><span class="info-value mono">${esc(live.iccid || dev.iccid)}</span></div>
            <div class="info-item"><span class="info-label">Vendor / Model</span><span class="info-value">${esc(live.vendor)} / ${esc(live.model)}</span></div>
            <div class="info-item"><span class="info-label">Carrier (VPLMN)</span><span class="info-value">${esc(live.carrier || live.vplmn)}</span></div>
            <div class="info-item"><span class="info-label">Home Net (HPLMN)</span><span class="info-value">${esc(live.hplmn)}</span></div>
            <div class="info-item"><span class="info-label">Country</span><span class="info-value">${esc(live.country)}</span></div>
            <div class="info-item"><span class="info-label">APN</span><span class="info-value">${esc(live.apn)}</span></div>
            <div class="info-item"><span class="info-label">IP Address</span><span class="info-value mono">${esc(live.ipAddress || live.ip)}</span></div>
            <div class="info-item"><span class="info-label">Active Data Session</span><span class="info-value">${live.activeSession ? 'Yes' : 'No'}</span></div>
            <div class="info-item"><span class="info-label">IMSI</span><span class="info-value mono">${esc(live.imsi)}</span></div>
          </div>
        </div>
      </div>

      <!-- Charts & Maps & SMS -->
      <div class="controls-grid">
        <!-- Usage Chart -->
        <div class="section">
          <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <div class="section-title"><span class="section-icon">📈</span> 30-Day Usage</div>
            <div class="chevron">▼</div>
          </div>
          <div class="section-content">
            <div class="chart-container">
              <canvas id="usage-chart"></canvas>
            </div>
          </div>
        </div>

        <!-- Location -->
        <div class="section">
          <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <div class="section-title"><span class="section-icon">🗺️</span> Location</div>
            <div class="chevron">▼</div>
          </div>
          <div class="section-content">
            ${(loc.Latitude && loc.Longitude) ? '<div id="device-map" class="map-container"></div>' : '<p>No location data available.</p>'}
          </div>
        </div>
        
        <!-- SMS -->
        <div class="section">
          <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <div class="section-title"><span class="section-icon">✉️</span> Send SMS</div>
            <div class="chevron">▼</div>
          </div>
          <div class="section-content">
            <textarea id="sms-text" class="sms-input" placeholder="Enter SMS message to send to device..."></textarea>
            <button class="btn btn-primary" onclick="window.sendSms('${esc(dev.iccid)}')">Send SMS</button>
          </div>
        </div>
      </div>
    `;

    resultsContainer.innerHTML = html;

    // Render Chart
    if (usage.records && usage.records.length > 0) {
      setTimeout(() => renderChart(usage.records), 0);
    }

    // Render Map
    if (loc.Latitude && loc.Longitude) {
      setTimeout(() => renderMap(loc.Latitude, loc.Longitude), 0);
    }
  }

  // Device Actions
  window.deviceAction = async function(iccid, action) {
    if (!iccid) return alert("Missing ICCID");
    if (!confirm(`Are you sure you want to ${action} this device?`)) return;
    try {
      const res = await fetch(`/api/webbing/devices/${encodeURIComponent(iccid)}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error('Action failed');
      alert(`Successfully triggered ${action}.`);
      handleSearch();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  window.sendSms = async function(iccid) {
    const text = document.getElementById('sms-text').value.trim();
    if (!text) return alert("Please enter a message");
    if (!iccid) return alert("Missing ICCID");
    
    try {
      const res = await fetch(`/api/webbing/devices/${encodeURIComponent(iccid)}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      if (!res.ok) throw new Error('Failed to send SMS');
      alert("SMS sent successfully.");
      document.getElementById('sms-text').value = '';
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  function renderChart(records) {
    const ctx = document.getElementById('usage-chart');
    if (!ctx) return;
    
    // Sort records by Date
    const sorted = [...records].sort((a, b) => new Date(a.Date) - new Date(b.Date));
    const labels = sorted.map(r => {
      const d = new Date(r.Date);
      return `${d.getMonth()+1}/${d.getDate()}`;
    });
    const data = sorted.map(r => r.TotalMB || 0);

    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = 'Inter';

    currentChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Data Usage (MB)',
          data,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          pointBackgroundColor: '#0f172a',
          pointBorderColor: '#3b82f6',
          pointBorderWidth: 2,
          pointRadius: 4,
          fill: true,
          tension: 0.4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            titleColor: '#f8fafc',
            bodyColor: '#f8fafc',
            borderColor: '#334155',
            borderWidth: 1,
            padding: 12
          }
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
        }
      }
    });
  }

  function renderMap(lat, lng) {
    const mapEl = document.getElementById('device-map');
    if (!mapEl) return;
    
    currentMap = L.map('device-map').setView([lat, lng], 13);
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20
    }).addTo(currentMap);
    
    L.marker([lat, lng]).addTo(currentMap)
      .bindPopup('Last Known Location')
      .openPopup();
  }
  // ── MDM-Only Device Results ──────────────────────────────────
  function renderMdmDeviceResults(data) {
    const d = data.device || {};
    const lastSeen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—';
    const bat = d.batteryLevel ? d.batteryLevel + (String(d.batteryLevel).includes('%') ? '' : '%') : '—';
    
    resultsContainer.innerHTML = `
      <div class="section" style="border-color: var(--purple);">
        <div class="section-header">
          <span class="section-icon">📱</span>
          <h2 class="section-title">SimpleMDM iPad — ${esc(d.name || d.serial)}</h2>
        </div>
        <div class="section-content">
          <div class="info-grid">
            <div class="info-item"><label>Device Name</label><span>${esc(d.name || '—')}</span></div>
            <div class="info-item"><label>Serial</label><span class="mono">${esc(d.serial || '—')}</span></div>
            <div class="info-item"><label>Model</label><span>${esc(d.model || '—')}</span></div>
            <div class="info-item"><label>OS Version</label><span>${esc(d.osVersion || '—')}</span></div>
            <div class="info-item"><label>Battery</label><span>${bat}</span></div>
            <div class="info-item"><label>Last Seen</label><span>${lastSeen}</span></div>
          </div>
          <p style="margin-top: 16px; color: var(--text-muted); font-size: 13px;">
            ℹ️ This device was found in SimpleMDM only. No matching Webbing SIM data available.
          </p>
        </div>
      </div>
    `;
  }

})();
