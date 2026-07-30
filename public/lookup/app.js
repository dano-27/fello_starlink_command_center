(function() {
  'use strict';

  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const searchSpinner = document.getElementById('search-spinner');
  const resultsContainer = document.getElementById('results-container');
  
  let currentChart = null;
  let currentMap = null;

  // ── Tools Dropdown ──
  const toolsToggle = document.getElementById('tools-toggle');
  const toolsDropdown = document.getElementById('tools-dropdown');
  if (toolsToggle && toolsDropdown) {
    toolsToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toolsDropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => toolsDropdown.classList.remove('open'));
  }

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
        renderError(`No results found for "${esc(query)}". Try a Group Number, Serial, or ICCID.`);
      } else if (data.type === 'group') {
        renderGroupResults(data, query);
      } else if (data.type === 'iccid' || data.type === 'imei') {
        // Normalize ICCID/IMEI response to match device renderer format
        const live = data.liveData || {};
        const normalized = {
          ...data,
          liveData: {
            imei: data.device?.imei || live.imei,
            iccid: data.device?.iccid || live.iccid,
            vendor: live.vendor,
            model: live.model,
            carrier: live.carrier,
            vplmn: live.carrier,
            country: live.countryName,
            apn: live.apn,
            ip: live.ip,
            ipAddress: live.ip,
            activeSession: live.isActive,
            imsi: live.mccmnc ? String(live.mccmnc) : null,
            lastActive: live.lastActive
          },
          device: {
            ...data.device,
            plan: data.device?.productName,
            planName: data.device?.productName,
            branch: data.device?.branchName,
            deviceType: data.device?.deviceTypeName,
            statusDate: data.device?.statusChanged,
            status: data.device?.statusId
          }
        };
        renderDeviceResults(normalized);
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
    const branchId = data.branchName || query;
    const numericBranchId = data.branchId || null;
    window._currentBranchId = numericBranchId;
    window._currentBranchName = branchId;

    const nonMdmDevices = web.filter(w => !w.matchedIpadName).length;
    const mdmMatched = stats.matchedCount || 0;
    // Counts "match" if SIM lines = MDM devices + identified non-MDM devices
    const effectiveMatch = mdmMatched + nonMdmDevices >= (stats.webbingCount || web.length);

    let html = `
      <!-- Overview Bar -->
      <div class="stats-bar">
        <div class="stat-card stat-purple">
          <div class="stat-label">MDM Devices</div>
          <div class="stat-value">${esc(stats.mdmCount || mdm.length)}</div>
        </div>
        <div class="stat-card stat-blue">
          <div class="stat-label">SIM Lines</div>
          <div class="stat-value">${esc(stats.webbingCount || web.length)}</div>
        </div>
        <div class="stat-card stat-green">
          <div class="stat-label">🔗 Matched</div>
          <div class="stat-value">${esc(mdmMatched)} / ${esc(Math.max(stats.mdmCount, stats.webbingCount) || 0)}</div>
        </div>
        <div class="stat-card stat-amber">
          <div class="stat-label">Non-MDM Devices</div>
          <div class="stat-value">${nonMdmDevices > 0 ? '📶 ' + nonMdmDevices : '0'}</div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="actions-bar">
        <button class="btn btn-warning" onclick="window.bulkAction('${esc(branchId)}', 'suspend')">⏸ Bulk Suspend SIMs</button>
        <button class="btn btn-success" onclick="window.bulkAction('${esc(branchId)}', 'activate')">▶ Bulk Activate SIMs</button>
        <button class="btn btn-outline" style="border-color:var(--red);color:var(--red);" onclick="window.bulkLostMode('enable')">🔴 Enable Lost Mode All</button>
        <button class="btn btn-outline" style="border-color:var(--green);color:var(--green);" onclick="window.bulkLostMode('disable')">🟢 Disable Lost Mode All</button>
      </div>

      <!-- Carrier Switch -->
      <div class="carrier-switch-bar" style="display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:20px;flex-wrap:wrap;">
        <span style="font-weight:700;font-size:14px;color:var(--text);white-space:nowrap;">📡 Switch Carrier:</span>
        <select id="bulk-carrier-select" style="flex:1;min-width:200px;max-width:420px;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;font-weight:500;cursor:pointer;">
          <option value="" disabled selected>Select a carrier plan…</option>
          <option value="11105">🌐 Multi-Carrier — Pay as You Go (US, CA, MX)</option>
          <option value="11125">📶 AT&T — Pay as You Go (US/AT&T, CA/BELL, MX)</option>
          <option value="11126">📶 T-Mobile — Pay as You Go (US/TMO, CA/ROGERS, MX)</option>
          <option value="11127">📶 Verizon — Pay as You Go (US/VZ, CA/TELUS, MX)</option>
        </select>
        <button class="btn btn-primary" onclick="window.bulkChangeCarrier()" style="white-space:nowrap;">🔄 Apply to All SIMs</button>
        <span style="font-size:12px;color:var(--muted);">Current: <strong id="current-plan-label" style="color:var(--text);">${esc(web.length > 0 ? (web[0].productName || web[0].ProductName || '—') : '—')}</strong></span>
      </div>

      <!-- Data Usage Calculator -->
      <div class="usage-calculator">
        <div class="usage-calc-header">
          <h3 class="usage-calc-title">📊 Data Usage Calculator</h3>
        </div>
        <div class="usage-calc-controls">
          <div class="usage-calc-dates">
            <div class="usage-date-group">
              <label class="usage-date-label">Start Date</label>
              <input type="date" id="usage-start-date" class="usage-date-input">
            </div>
            <div class="usage-date-group">
              <label class="usage-date-label">End Date</label>
              <input type="date" id="usage-end-date" class="usage-date-input">
            </div>
            <button class="btn btn-primary" id="usage-calc-btn" onclick="window.calculateUsage()">📊 Calculate Usage</button>
          </div>
        </div>
        <div id="usage-results" class="usage-results"></div>
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
        mdmId: ipad.id || null,
        simDeviceId: sim.serviceDeviceId || null,
        simStatusRaw: sim.status || m.simStatus || '',
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
        eid: ipad.abmEid || '',
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
        mdmId: d.id || null,
        simDeviceId: null,
        simStatusRaw: '',
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
        eid: d.abmEid || '',
        simSerial: '', iccid: '', carrier: '', simStatus: null,
        plan: '', ip: '', simModel: '', vendor: ''
      });
    }
    // Unmatched SIMs — detect device type from vendor/model
    for (const w of unmatchedSims) {
      const vendor = (w.vendor || '').toLowerCase();
      const model = (w.model || '').toLowerCase();
      const combined = `${vendor} ${model}`;

      let deviceType = 'sim';
      let deviceIcon = '📡';
      let deviceName = 'SIM-Only Device';

      if (combined.includes('mifi') || combined.includes('hotspot') || combined.includes('jetpack') ||
          combined.includes('nighthawk') || combined.includes('inseego') || combined.includes('franklin') ||
          combined.includes('usb620') || combined.includes('usb730') || combined.includes('usb800')) {
        deviceType = 'hotspot';
        deviceIcon = '📶';
        deviceName = 'Mobile Hotspot';
      } else if (combined.includes('cradlepoint') || combined.includes('router') || combined.includes('ibr') ||
                 combined.includes('e3000') || combined.includes('netgear') || combined.includes('mofi')) {
        deviceType = 'router';
        deviceIcon = '🌐';
        deviceName = 'Mobile Router';
      } else if (combined.includes('starlink')) {
        deviceType = 'starlink';
        deviceIcon = '🛰️';
        deviceName = 'Starlink';
      }

      // Build a descriptive name from model
      const modelDisplay = w.model ? w.model.split(',')[0].trim() : '';
      const fullName = `${deviceIcon} ${deviceName}` + (modelDisplay ? ` — ${modelDisplay}` : '');

      window._fleetRows.push({
        linked: false,
        mdmId: null,
        simDeviceId: w.serviceDeviceId || null,
        simStatusRaw: w.status || '',
        deviceType: deviceType,
        name: fullName, ipadSerial: '', model: modelDisplay, os: '', battery: null,
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
          <div class="section-title"><span class="section-icon">📋</span> Fleet Overview — Device + SIM Pairs</div>
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
          ${rows.map((r, idx) => `
            <tr data-row-idx="${idx}" style="cursor:pointer;${!r.linked ? 'opacity: 0.6;' : ''}" onclick="window.openDeviceDrawer(${idx})">
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
        if (row.linked) return '<span style="color: var(--green); font-weight: bold;">✓</span>';
        if (row.deviceType === 'hotspot') return '<span title="Mobile Hotspot">📶</span>';
        if (row.deviceType === 'router') return '<span title="Mobile Router">🌐</span>';
        if (row.deviceType === 'starlink') return '<span title="Starlink">🛰️</span>';
        if (row.deviceType === 'sim') return '<span title="SIM-Only Device">📡</span>';
        return '<span style="color: var(--amber);">✗</span>';
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

  // Bulk Carrier Change
  window.bulkChangeCarrier = async function() {
    const sel = document.getElementById('bulk-carrier-select');
    if (!sel || !sel.value) { alert('Please select a carrier plan first.'); return; }
    const productId = parseInt(sel.value);
    const planName = sel.options[sel.selectedIndex].text;
    const branchId = window._currentBranchId;
    if (!branchId) { alert('No branch ID available for bulk change.'); return; }

    const web = window._fleetRows || [];
    const simCount = web.filter(r => r.simSerial).length;
    const currentPlan = document.getElementById('current-plan-label')?.textContent || '—';

    const msg = `⚠️ BULK CARRIER CHANGE\n\n` +
      `Branch: ${window._currentBranchName || branchId}\n` +
      `Devices: ${simCount} SIM lines\n\n` +
      `Current Plan:\n  ${currentPlan}\n\n` +
      `New Plan:\n  ${planName}\n\n` +
      `This will change the carrier for ALL ${simCount} SIM lines in this order. Continue?`;

    if (!confirm(msg)) return;

    try {
      sel.disabled = true;
      const btn = sel.nextElementSibling;
      const origText = btn.innerHTML;
      btn.innerHTML = '⏳ Switching…';
      btn.disabled = true;

      const res = await fetch(`/api/webbing/branches/${encodeURIComponent(branchId)}/change-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Change failed');

      const successes = result.results?.filter(r => r.success).length || 0;
      const failures = result.results?.filter(r => !r.success).length || 0;
      alert(`✅ Carrier switch complete!\n\nSuccess: ${successes}\nFailed: ${failures}`);
      handleSearch(); // Refresh
    } catch (err) {
      alert('❌ Error: ' + err.message);
    } finally {
      sel.disabled = false;
      const btn = document.querySelector('.carrier-switch-bar .btn-primary');
      if (btn) { btn.innerHTML = '🔄 Apply to All SIMs'; btn.disabled = false; }
    }
  };

  window.bulkLostMode = async function(mode) {
    const rows = window._fleetRows || [];
    const ipads = rows.filter(r => r.mdmId);
    if (ipads.length === 0) { alert('No iPads found.'); return; }
    
    const label = mode === 'enable' ? 'ENABLE LOST MODE' : 'DISABLE LOST MODE';
    let msg = '';
    if (mode === 'enable') {
      msg = prompt('Lost Mode message for all devices:', 'This iPad has been reported lost. Please contact the administrator.');
      if (!msg) return;
    }
    if (!confirm(`${label} on all ${ipads.length} iPads?`)) return;
    
    let success = 0, failed = 0;
    for (const ipad of ipads) {
      try {
        if (mode === 'enable') {
          const res = await fetch(`/api/simplemdm/devices/${ipad.mdmId}/lost_mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
          });
          if (res.ok) { success++; } else { failed++; }
        } else {
          const res = await fetch(`/api/simplemdm/devices/${ipad.mdmId}/lost_mode`, { method: 'DELETE' });
          if (res.ok) { success++; } else { failed++; }
        }
      } catch { failed++; }
    }
    
    showToast(`${label}: ${success}/${ipads.length} succeeded`, failed > 0 ? 'error' : 'success');
  };

  // ── Usage Table Renderer with Sorting ──────────────────────
  let _usageSortCol = 'TotalUsage';
  let _usageSortDir = 'desc';

  function renderUsageTable(results, totals, startDate, endDate, sortCol, sortDir) {
    if (sortCol) _usageSortCol = sortCol;
    if (sortDir) _usageSortDir = sortDir;

    const totalGB = (totals.totalUsage / 1024).toFixed(3);
    const fleetRows = window._fleetRows || [];

    // Enrich results with iPad info for sorting
    const enriched = results.map(r => {
      const matchedRow = fleetRows.find(fr => fr.simSerial === r.Serial || fr.simSerial === r.SSID);
      return {
        ...r,
        _ipadName: matchedRow ? matchedRow.name : '—',
        _ipadSerial: matchedRow ? matchedRow.ipadSerial : ''
      };
    });

    // Sort
    const col = _usageSortCol;
    const dir = _usageSortDir === 'asc' ? 1 : -1;
    enriched.sort((a, b) => {
      let va, vb;
      if (col === 'Device') { va = a._ipadName; vb = b._ipadName; }
      else if (col === 'Serial') { va = a.Serial || ''; vb = b.Serial || ''; }
      else if (col === 'IMEI') { va = a.IMEI || ''; vb = b.IMEI || ''; }
      else if (col === 'Plan') { va = a.ProductName || ''; vb = b.ProductName || ''; }
      else if (col === 'Status') { va = a.StatusName || ''; vb = b.StatusName || ''; }
      else if (col === 'TotalUsage') { va = a.TotalUsage; vb = b.TotalUsage; }
      else if (col === 'TotalUsageDays') { va = a.TotalUsageDays || 0; vb = b.TotalUsageDays || 0; }
      else { va = a.TotalUsage; vb = b.TotalUsage; }
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });

    const arrow = (c) => _usageSortCol === c ? (_usageSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = (label, colKey) => `<th class="usage-sortable" onclick="window.sortUsageTable('${colKey}')">${label}${arrow(colKey)}</th>`;

    let tableHtml = `
      <div class="usage-summary">
        <div class="usage-summary-card">
          <div class="usage-summary-label">Total Data Usage</div>
          <div class="usage-summary-value">${totalGB} GB</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-label">Total Lines</div>
          <div class="usage-summary-value">${totals.totalDevices || 0}</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-label">Lines With Usage</div>
          <div class="usage-summary-value">${totals.devicesWithUsage || 0}</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-label">Period</div>
          <div class="usage-summary-value">${startDate} → ${endDate}</div>
        </div>
      </div>
      <table class="usage-table">
        <thead>
          <tr>
            <th>#</th>
            ${th('Device', 'Device')}
            ${th('SIM Serial', 'Serial')}
            ${th('IMEI', 'IMEI')}
            ${th('Plan', 'Plan')}
            ${th('Status', 'Status')}
            ${th('Usage (MB)', 'TotalUsage')}
            ${th('Usage (GB)', 'TotalUsage')}
            ${th('Active Days', 'TotalUsageDays')}
          </tr>
        </thead>
        <tbody>`;

    enriched.forEach((r, i) => {
      const usageGB = (r.TotalUsage / 1024).toFixed(3);
      const usageMB = r.TotalUsage.toFixed(2);
      const statusClass = r.StatusName === 'Active' ? 'status-active' : 'status-suspended';
      const deviceLabel = r._ipadName !== '—'
        ? `${r._ipadName}` + (r._ipadSerial ? `<br><span class="mono" style="font-size:0.7rem;color:var(--text-muted);">${esc(r._ipadSerial)}</span>` : '')
        : '—';
      tableHtml += `
          <tr>
            <td>${i + 1}</td>
            <td>${deviceLabel}</td>
            <td class="mono">${esc(r.Serial || '—')}</td>
            <td class="mono">${esc(r.IMEI || '—')}</td>
            <td>${esc(r.ProductName || '—')}</td>
            <td><span class="badge ${statusClass}">${esc(r.StatusName || '—')}</span></td>
            <td class="mono">${usageMB}</td>
            <td class="mono" style="font-weight:600;">${usageGB}</td>
            <td>${r.TotalUsageDays || 0}</td>
          </tr>`;
    });

    tableHtml += `
          <tr class="usage-total-row">
            <td colspan="5"><strong>TOTAL</strong></td>
            <td class="mono"><strong>${(totals.totalUsage || 0).toFixed(2)}</strong></td>
            <td class="mono" style="font-weight:700;">${totalGB}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <button class="btn btn-outline" style="margin-top:12px;border-color:var(--blue);color:var(--blue);" onclick="window.exportUsageCSV()">📥 Export CSV</button>`;

    document.getElementById('usage-results').innerHTML = tableHtml;
  }

  window.sortUsageTable = function(colKey) {
    const d = window._usageResults;
    if (!d) return;
    const newDir = (_usageSortCol === colKey && _usageSortDir === 'desc') ? 'asc' : 'desc';
    renderUsageTable(d.results, d.totals, d.start, d.end, colKey, newDir);
  };

  // ── Data Usage Calculator ───────────────────────────────────
  window.calculateUsage = async function() {
    const branchId = window._currentBranchId;
    if (!branchId) { alert('No branch ID available.'); return; }
    
    const startEl = document.getElementById('usage-start-date');
    const endEl = document.getElementById('usage-end-date');
    if (!startEl.value || !endEl.value) { alert('Please select both start and end dates.'); return; }
    
    // Convert YYYY-MM-DD to MM/dd/yyyy for the API
    const [sy, sm, sd] = startEl.value.split('-');
    const [ey, em, ed] = endEl.value.split('-');
    const start = `${sm}/${sd}/${sy}`;
    const end = `${em}/${ed}/${ey}`;
    
    const resultsDiv = document.getElementById('usage-results');
    const btn = document.getElementById('usage-calc-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Calculating...';
    resultsDiv.innerHTML = '<div class="usage-loading">Fetching usage data for all lines... This may take a moment.</div>';
    
    try {
      const res = await fetch(`/api/webbing/branches/${branchId}/usage?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&interval=Unknown`);
      if (!res.ok) throw new Error('Failed to fetch usage data');
      const data = await res.json();
      
      const results = data.results || [];
      const totals = data.totals || {};
      const totalGB = (totals.totalUsage / 1024).toFixed(3);
      renderUsageTable(results, totals, startEl.value, endEl.value);
      window._usageResults = { results, totals, start: startEl.value, end: endEl.value };
      
    } catch (err) {
      resultsDiv.innerHTML = `<div class="usage-loading" style="color:var(--red);">Error: ${err.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '📊 Calculate Usage';
    }
  };

  window.exportUsageCSV = function() {
    const d = window._usageResults;
    if (!d) return;
    let csv = 'iPad Name,iPad Serial,SIM Serial,IMEI,Plan,Status,Usage (MB),Usage (GB),Active Days\n';
    const fleetRows = window._fleetRows || [];
    d.results.forEach(r => {
      const matchedRow = fleetRows.find(fr => fr.simSerial === r.Serial || fr.simSerial === r.SSID);
      const ipadName = matchedRow ? matchedRow.name : '';
      const ipadSerial = matchedRow ? matchedRow.ipadSerial : '';
      csv += `${ipadName},${ipadSerial},${r.Serial},${r.IMEI},${r.ProductName},${r.StatusName},${r.TotalUsage.toFixed(2)},${(r.TotalUsage / 1024).toFixed(3)},${r.TotalUsageDays}\n`;
    });
    csv += `TOTAL,,,,,,${d.totals.totalUsage.toFixed(2)},${(d.totals.totalUsage / 1024).toFixed(3)},\n`;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Usage_Report_${d.start}_to_${d.end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

  // ══════════════════════════════════════════════════════════════
  //  DEVICE DETAIL DRAWER
  // ══════════════════════════════════════════════════════════════
  
  const drawerOverlay = document.getElementById('drawer-overlay');
  const drawerBody = document.getElementById('drawer-body');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerClose = document.getElementById('drawer-close');
  let drawerMap = null;
  
  drawerClose.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', (e) => {
    if (e.target === drawerOverlay) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  function closeDrawer() {
    drawerOverlay.classList.remove('open');
    if (drawerMap) { drawerMap.remove(); drawerMap = null; }
  }

  function showToast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `drawer-toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  async function drawerAction(url, method = 'POST', body = null) {
    try {
      const opts = { method };
      if (body) { opts.headers = {'Content-Type':'application/json'}; opts.body = JSON.stringify(body); }
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast('Action completed');
      return await res.json().catch(() => ({}));
    } catch (e) {
      showToast(`Error: ${e.message}`, 'error');
      throw e;
    }
  }

  // Carrier plan mapping (real Webbing product IDs)
  const CARRIER_PLANS = [
    { id: 11105, label: 'Multi-Carrier — Pay as You Go (US, CA, MX)' },
    { id: 11125, label: 'AT&T — Pay as You Go (US/AT&T, CA/BELL, MX)' },
    { id: 11126, label: 'T-Mobile — Pay as You Go (US/TMO, CA/ROGERS, MX)' },
    { id: 11127, label: 'Verizon — Pay as You Go (US/VZ, CA/TELUS, MX)' },
  ];

  window.openDeviceDrawer = function(idx) {
    const row = window._fleetRows[idx];
    if (!row) return;

    drawerTitle.innerHTML = `
      ${esc(row.name || row.simSerial || 'Device')}
      <span class="drawer-subtitle">${esc(row.ipadSerial || '')}</span>
    `;

    const hasIpad = !!row.mdmId;
    const hasSim = !!row.simDeviceId;
    const isActive = String(row.simStatusRaw).toLowerCase().includes('active') || row.simStatus === 3;

    let html = '';

    // ── Device Info ──
    html += `
      <div class="drawer-section">
        <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="ds-icon">📱</span> Device Info <span class="ds-chevron">▼</span>
        </div>
        <div class="drawer-section-body">
          <div class="info-grid">
            <div class="info-item"><div class="info-label">iPad Name</div><div class="info-value">${esc(row.name) || '—'}</div></div>
            <div class="info-item"><div class="info-label">iPad Serial</div><div class="info-value">${esc(row.ipadSerial) || '—'}</div></div>
            <div class="info-item"><div class="info-label">Model</div><div class="info-value">${esc(row.model) || '—'}</div></div>
            <div class="info-item"><div class="info-label">OS</div><div class="info-value">${esc(row.os) || '—'}</div></div>
            <div class="info-item"><div class="info-label">Battery</div><div class="info-value">${row.battery || '—'}</div></div>
            <div class="info-item"><div class="info-label">Last Seen</div><div class="info-value">${esc(row.lastSeenAt) || '—'}</div></div>
            <div class="info-item"><div class="info-label">IMEI</div><div class="info-value">${esc(row.imei) || '—'}</div></div>
            <div class="info-item"><div class="info-label">EID</div><div class="info-value" style="font-size:0.65rem">${esc(row.eid) || '—'}</div></div>
            <div class="info-item"><div class="info-label">SIM Serial</div><div class="info-value">${esc(row.simSerial) || '—'}</div></div>
            <div class="info-item"><div class="info-label">ICCID</div><div class="info-value" style="font-size:0.65rem">${esc(row.iccid) || '—'}</div></div>
            <div class="info-item"><div class="info-label">Carrier</div><div class="info-value">${esc(row.carrier) || '—'}</div></div>
            <div class="info-item"><div class="info-label">SIM Status</div><div class="info-value">${row.simStatus ? getStatusBadge(row.simStatus) : '—'}</div></div>
            <div class="info-item"><div class="info-label">Plan</div><div class="info-value">${esc(row.plan) || '—'}</div></div>
            <div class="info-item"><div class="info-label">IP Address</div><div class="info-value">${esc(row.ip) || '—'}</div></div>
          </div>
        </div>
      </div>
    `;

    // ── Screen Share ──
    if (hasIpad) {
      html += `
        <div class="drawer-section">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">📺</span> Screen Share <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <button class="action-btn" style="width:100%; flex-direction:row; justify-content:center; gap:8px; padding:12px;" 
                    onclick="window.startScreenShare('${esc(row.ipadSerial)}', '${esc(row.name)}')">
              <span class="action-icon">📺</span> Start Screen Share
            </button>
          </div>
        </div>
      `;
    }

    // ── iPad Actions ──
    if (hasIpad) {
      const did = row.mdmId;
      html += `
        <div class="drawer-section">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">🔧</span> iPad Controls <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <div class="action-grid">
              <button class="action-btn" onclick="window.mdmAction(${did}, 'lock', this)">
                <span class="action-icon">🔒</span> Lock
              </button>
              <button class="action-btn" onclick="window.mdmAction(${did}, 'restart', this)">
                <span class="action-icon">🔄</span> Restart
              </button>
              <button class="action-btn" onclick="window.mdmAction(${did}, 'shutdown', this)">
                <span class="action-icon">⏻</span> Shutdown
              </button>
              <button class="action-btn" onclick="window.mdmAction(${did}, 'push_apps', this)">
                <span class="action-icon">📲</span> Push Apps
              </button>
              <button class="action-btn" onclick="window.mdmAction(${did}, 'refresh', this)">
                <span class="action-icon">🔃</span> Refresh
              </button>
              <button class="action-btn" onclick="window.mdmAction(${did}, 'clear_passcode', this)">
                <span class="action-icon">🔓</span> Clear Code
              </button>
            </div>
          </div>
        </div>
      `;

      // ── Lost Mode ──
      html += `
        <div class="drawer-section">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">📍</span> Lost Mode <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <div class="action-grid" style="grid-template-columns: 1fr 1fr;">
              <button class="action-btn" onclick="window.enableLostMode(${did}, this)">
                <span class="action-icon">🔴</span> Enable Lost Mode
              </button>
              <button class="action-btn" onclick="window.disableLostMode(${did}, this)">
                <span class="action-icon">🟢</span> Disable Lost Mode
              </button>
            </div>
          </div>
        </div>
      `;
    }

    // ── SIM Actions ──
    if (hasSim) {
      const sid = row.simDeviceId;
      html += `
        <div class="drawer-section">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">📶</span> SIM Controls <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <div class="sim-toggle-row">
              <button class="sim-toggle-btn active-btn" onclick="window.simAction(${sid}, 'activate', this)">
                ▶ Activate
              </button>
              <button class="sim-toggle-btn suspend-btn" onclick="window.simAction(${sid}, 'suspend', this)">
                ⏸ Suspend
              </button>
            </div>
          </div>
        </div>
      `;

      // ── Change Carrier ──
      html += `
        <div class="drawer-section">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">🔄</span> Change Carrier <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <div class="carrier-row">
              <select class="carrier-select" id="carrier-select-${sid}">
                ${CARRIER_PLANS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}
              </select>
              <button class="carrier-apply-btn" onclick="window.changeCarrier(${sid})">Apply</button>
            </div>
          </div>
        </div>
      `;

      // ── Send SMS ──
      html += `
        <div class="drawer-section collapsed">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">📨</span> Send SMS <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <div class="sms-row">
              <input type="text" class="sms-input" id="sms-input-${sid}" placeholder="Enter message...">
              <button class="sms-send-btn" onclick="window.sendSms(${sid})">Send</button>
            </div>
          </div>
        </div>
      `;

      // ── Live Telemetry ──
      html += `
        <div class="drawer-section">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">📊</span> Live Telemetry <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <div class="telemetry-grid" id="telemetry-${sid}">
              <div class="telemetry-item"><div class="telemetry-label">Loading...</div></div>
            </div>
            <button class="action-btn" style="width:100%; margin-top:8px; flex-direction:row; justify-content:center; gap:6px;"
                    onclick="window.loadTelemetry(${sid})">
              <span class="action-icon">🔃</span> Refresh
            </button>
          </div>
        </div>
      `;

      // ── Location ──
      html += `
        <div class="drawer-section collapsed">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">📍</span> Location <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <button class="action-btn" style="width:100%; flex-direction:row; justify-content:center; gap:6px;"
                    onclick="window.loadLocation(${sid}, '${esc(row.ipadSerial)}')">
              <span class="action-icon">📍</span> Get Location
            </button>
            <div id="drawer-map-${sid}" class="drawer-map" style="display:none;"></div>
          </div>
        </div>
      `;
    }

    // ── Danger Zone ──
    if (hasIpad) {
      html += `
        <div class="drawer-section danger collapsed">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">⚠️</span> Danger Zone <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            <button class="danger-btn" onclick="window.wipeDevice(${row.mdmId}, '${esc(row.name)}')">
              🗑 Factory Reset (Wipe Device)
            </button>
          </div>
        </div>
      `;
    }

    drawerBody.innerHTML = html;
    drawerOverlay.classList.add('open');

    // Auto-load telemetry if SIM exists
    if (hasSim) {
      window.loadTelemetry(row.simDeviceId);
    }
  };

  // ── MDM Device Actions ──
  window.mdmAction = async function(deviceId, action, btn) {
    if (!confirm(`Are you sure you want to ${action} this device?`)) return;
    btn.classList.add('loading');
    try {
      await drawerAction(`/api/simplemdm/devices/${deviceId}/${action}`);
      btn.classList.add('success');
      setTimeout(() => btn.classList.remove('success'), 2000);
    } finally {
      btn.classList.remove('loading');
    }
  };

  // ── Lost Mode ──
  window.enableLostMode = async function(deviceId, btn) {
    const msg = prompt('Lost Mode message:', 'This iPad has been reported lost. Please contact the administrator.');
    if (!msg) return;
    btn.classList.add('loading');
    try {
      await drawerAction(`/api/simplemdm/devices/${deviceId}/lost_mode`, 'POST', { message: msg });
      btn.classList.add('success');
    } finally {
      btn.classList.remove('loading');
    }
  };

  window.disableLostMode = async function(deviceId, btn) {
    if (!confirm('Disable Lost Mode?')) return;
    btn.classList.add('loading');
    try {
      await drawerAction(`/api/simplemdm/devices/${deviceId}/lost_mode`, 'DELETE');
      btn.classList.add('success');
    } finally {
      btn.classList.remove('loading');
    }
  };

  // ── SIM Actions ──
  window.simAction = async function(simId, action, btn) {
    if (!confirm(`${action} this SIM?`)) return;
    btn.classList.add('loading');
    try {
      await drawerAction(`/api/webbing/devices/${simId}/${action}`);
      btn.classList.add('success');
    } finally {
      btn.classList.remove('loading');
    }
  };

  // ── Change Carrier ──
  window.changeCarrier = async function(simId) {
    const sel = document.getElementById(`carrier-select-${simId}`);
    const planId = sel.value;
    const planName = sel.options[sel.selectedIndex].text;
    if (!confirm(`Change carrier to: ${planName}?`)) return;
    await drawerAction(`/api/webbing/devices/${simId}/change-plan`, 'POST', { productId: parseInt(planId) });
  };

  // ── Send SMS ──
  window.sendSms = async function(simId) {
    const input = document.getElementById(`sms-input-${simId}`);
    const msg = input.value.trim();
    if (!msg) return;
    await drawerAction(`/api/webbing/devices/${simId}/sms`, 'POST', { message: msg });
    input.value = '';
  };

  // ── Live Telemetry ──
  window.loadTelemetry = async function(simId) {
    const container = document.getElementById(`telemetry-${simId}`);
    if (!container) return;
    container.innerHTML = '<div class="telemetry-item"><div class="telemetry-label">Loading...</div></div>';
    try {
      const res = await fetch(`/api/webbing/devices/${simId}/live`);
      const data = await res.json();
      const live = data.liveData || data;
      container.innerHTML = `
        <div class="telemetry-item"><div class="telemetry-label">IP Address</div><div class="telemetry-value">${esc(live.IP || live.ipAddress || live.ip || '—')}</div></div>
        <div class="telemetry-item"><div class="telemetry-label">Carrier</div><div class="telemetry-value">${esc(live.VPLMN || live.vplmnName || '—')}</div></div>
        <div class="telemetry-item"><div class="telemetry-label">Country</div><div class="telemetry-value">${esc(live.CountryName || live.country || '—')}</div></div>
        <div class="telemetry-item"><div class="telemetry-label">Status</div><div class="telemetry-value">${live.IsActive ? '🟢 Active' : '🔴 Inactive'}</div></div>
        <div class="telemetry-item"><div class="telemetry-label">Last Active</div><div class="telemetry-value">${esc(live.LastActive || live.PDP || '—')}</div></div>
        <div class="telemetry-item"><div class="telemetry-label">APN</div><div class="telemetry-value">${esc(live.APN || '—')}</div></div>
        <div class="telemetry-item"><div class="telemetry-label">Device</div><div class="telemetry-value">${esc(live.Model || live.model || '—')}</div></div>
        <div class="telemetry-item"><div class="telemetry-label">Vendor</div><div class="telemetry-value">${esc(live.Vendor || live.vendor || '—')}</div></div>
      `;
    } catch (e) {
      container.innerHTML = `<div class="telemetry-item"><div class="telemetry-label" style="color:var(--red)">Error loading telemetry</div></div>`;
    }
  };

  // ── Location ──
  window.loadLocation = async function(simId, serial) {
    const mapDiv = document.getElementById(`drawer-map-${simId}`);
    if (!mapDiv) return;
    mapDiv.style.display = 'block';
    
    try {
      // Try cell tower location first
      const res = await fetch(`/api/webbing/devices/${simId}/location`);
      const data = await res.json();
      const loc = data.location || data;
      const lat = parseFloat(loc.latitude || loc.lat);
      const lng = parseFloat(loc.longitude || loc.lng || loc.lon);
      
      if (!isNaN(lat) && !isNaN(lng)) {
        if (drawerMap) drawerMap.remove();
        drawerMap = L.map(mapDiv).setView([lat, lng], 14);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap'
        }).addTo(drawerMap);
        L.marker([lat, lng]).addTo(drawerMap).bindPopup('Cell tower location').openPopup();
        
        // Also try GPS from Fello app
        if (serial) {
          try {
            const gpsRes = await fetch(`/api/location/${encodeURIComponent(serial)}`);
            const gpsData = await gpsRes.json();
            if (gpsData.latitude && gpsData.longitude) {
              L.marker([gpsData.latitude, gpsData.longitude], {
                icon: L.divIcon({ className: '', html: '<div style="background:var(--blue);width:12px;height:12px;border-radius:50%;border:2px solid white;"></div>' })
              }).addTo(drawerMap).bindPopup('GPS location (Fello App)');
            }
          } catch (e) { /* GPS not available */ }
        }
        
        setTimeout(() => drawerMap.invalidateSize(), 100);
      } else {
        mapDiv.innerHTML = '<p style="color:var(--text-muted);padding:20px;text-align:center;">Location not available</p>';
      }
    } catch (e) {
      mapDiv.innerHTML = `<p style="color:var(--red);padding:20px;text-align:center;">Error: ${e.message}</p>`;
    }
  };

  // ── Screen Share ──
  window.startScreenShare = async function(serial, name) {
    try {
      showToast('Connecting to screen share...');
      const res = await fetch('/api/cobrowse/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial, deviceName: name })
      });
      const data = await res.json();
      if (data.sessionUrl) {
        const overlay = document.getElementById('screen-overlay');
        const iframe = document.getElementById('screen-iframe');
        iframe.src = data.sessionUrl;
        overlay.style.display = 'flex';
        closeDrawer();
      } else {
        showToast(data.error || 'Device not online for screen share', 'error');
      }
    } catch (e) {
      showToast(`Screen share error: ${e.message}`, 'error');
    }
  };

  // Screen share close
  document.getElementById('screen-close').addEventListener('click', () => {
    document.getElementById('screen-overlay').style.display = 'none';
    document.getElementById('screen-iframe').src = 'about:blank';
  });

  // ── Wipe Device ──
  window.wipeDevice = async function(deviceId, name) {
    if (!confirm(`⚠️ FACTORY RESET: This will ERASE ALL DATA on "${name}". This cannot be undone!\n\nAre you sure?`)) return;
    if (!confirm(`FINAL WARNING: Type the device name to confirm.\n\nDevice: ${name}\n\nProceed with factory reset?`)) return;
    await drawerAction(`/api/simplemdm/devices/${deviceId}/wipe`);
  };

})();
