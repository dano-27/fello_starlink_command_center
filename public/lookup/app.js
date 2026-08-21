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
    { key: 'barcode',      label: 'Barcode',       source: 'ipad',    default: false, group: 'iPad' },
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
    
    // Hide the tool guide once a search starts
    const toolGuide = document.getElementById('tool-guide');
    if (toolGuide) toolGuide.classList.add('hidden');
    
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
        if (data.type === 'iccid' || data.type === 'imei') {
          renderError(`No results found for "${esc(query)}". Try a Group Number, Serial, or ICCID.`);
        } else if (data.crmOrder) {
          // IMS has the order even though no devices in MDM/Webbing yet
          renderGroupResults(data, query);
        } else {
          renderCreateOrder(query);
        }
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

  function renderCrmOrderSection(crm) {
    if (!crm || !crm.flyOrderId) return '';
    
    var ship = crm.shipping || {};
    var hasAddress = ship.address1 || ship.city || ship.state || ship.zip;
    var statusColor = crm.status === 'confirmed' ? 'var(--green)' : 
                      crm.status === 'pending' ? 'var(--amber)' : 'var(--muted)';
    
    // Build address string
    var addressParts = [];
    if (ship.name || ship.firstName) addressParts.push(ship.name || (ship.firstName + ' ' + (ship.lastName || '')).trim());
    if (ship.buildingName) addressParts.push(ship.buildingName);
    if (ship.address1) addressParts.push(ship.address1);
    if (ship.address2) addressParts.push(ship.address2);
    var cityStateZip = [ship.city, ship.state].filter(Boolean).join(', ');
    if (ship.zip) cityStateZip += ' ' + ship.zip;
    if (cityStateZip.trim()) addressParts.push(cityStateZip.trim());
    
    // Build rentals table
    var rentalsHtml = '';
    if (crm.rentals && crm.rentals.length > 0) {
      rentalsHtml = '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;">' +
        '<thead><tr>' +
        '<th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);border-bottom:2px solid var(--border);">Item</th>' +
        '<th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);border-bottom:2px solid var(--border);">Part #</th>' +
        '<th style="text-align:center;padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);border-bottom:2px solid var(--border);">Qty</th>' +
        '<th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);border-bottom:2px solid var(--border);">Network</th>' +
        '<th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);border-bottom:2px solid var(--border);">Type</th>' +
        '</tr></thead><tbody>';
      
      crm.rentals.forEach(function(r) {
        var typeLabel = r.isIpad ? '<span style="color:var(--primary);font-weight:600;">iPad</span>' : 
                        r.category === 2 ? 'Accessory' : r.category === 3 ? 'Charger' : 'Other';
        rentalsHtml += '<tr>' +
          '<td style="padding:8px 10px;border-bottom:1px solid var(--border);font-weight:500;">' + esc(r.modelName) + '</td>' +
          '<td style="padding:8px 10px;border-bottom:1px solid var(--border);font-family:monospace;font-size:12px;color:var(--muted);">' + esc(r.partNumber || '-') + '</td>' +
          '<td style="padding:8px 10px;border-bottom:1px solid var(--border);text-align:center;font-weight:600;">' + esc(r.amount) + '</td>' +
          '<td style="padding:8px 10px;border-bottom:1px solid var(--border);">' + esc(r.network || '-') + '</td>' +
          '<td style="padding:8px 10px;border-bottom:1px solid var(--border);">' + typeLabel + '</td>' +
          '</tr>';
      });
      rentalsHtml += '</tbody></table>';
    }
    
    return '<div class="section" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:20px;overflow:hidden;">' +
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">' +
        '<h3 style="margin:0;font-size:15px;font-weight:700;color:var(--text);">📦 IMS Order Details</h3>' +
        '<span style="font-size:12px;font-weight:600;color:' + statusColor + ';background:' + statusColor + '15;padding:3px 10px;border-radius:8px;text-transform:uppercase;">' + esc(crm.status) + '</span>' +
      '</div>' +
      '<div style="padding:16px 20px;">' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:12px;">' +
          '<div>' +
            '<div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px;">Order ID</div>' +
            '<div style="font-size:14px;font-weight:600;">' + esc(crm.flyOrderId) + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px;">Customer</div>' +
            '<div style="font-size:14px;font-weight:600;">' + esc(crm.customerName) + '</div>' +
          '</div>' +
          (crm.eventName ? '<div>' +
            '<div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px;">Event</div>' +
            '<div style="font-size:14px;">' + esc(crm.eventName) + '</div>' +
          '</div>' : '') +
          '<div>' +
            '<div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px;">Line Items</div>' +
            '<div style="font-size:14px;font-weight:600;">' + esc(crm.rentalCount) + ' items</div>' +
          '</div>' +
        '</div>' +
        (hasAddress ? 
          '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:12px;">' +
            '<div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:6px;">📍 Shipping Address</div>' +
            '<div style="font-size:13px;line-height:1.6;">' + addressParts.map(function(p){return esc(p)}).join('<br>') + '</div>' +
            (ship.siteCode ? '<div style="margin-top:6px;font-size:12px;color:var(--muted);">Site Code: <strong>' + esc(ship.siteCode) + '</strong></div>' : '') +
            (ship.deliveryInstructions ? '<div style="margin-top:6px;font-size:12px;color:var(--muted);">📝 ' + esc(ship.deliveryInstructions) + '</div>' : '') +
          '</div>' 
        : '<div style="background:var(--bg);border:1px dashed var(--border);border-radius:8px;padding:12px 16px;margin-bottom:12px;text-align:center;color:var(--muted);font-size:13px;">📍 No shipping address on file</div>') +
        (crm.rentals && crm.rentals.length > 0 ?
          '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:12px;">' +
            '<div onclick="var b=this.nextElementSibling;var a=this.querySelector(\'span.arrow\');if(b.style.display===\'none\'){b.style.display=\'block\';a.textContent=\'▼\'}else{b.style.display=\'none\';a.textContent=\'▶\'}" style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:var(--bg);user-select:none;">' +
              '<span style="font-size:13px;font-weight:600;">📦 Line Items (' + esc(crm.rentalCount) + ')</span>' +
              '<span class="arrow" style="font-size:11px;color:var(--muted);">▶</span>' +
            '</div>' +
            '<div style="display:none;">' + rentalsHtml + '</div>' +
          '</div>' : '') +
        (crm.notes ? '<div style="margin-top:12px;font-size:12px;color:var(--muted);"><strong>Notes:</strong> ' + esc(crm.notes) + '</div>' : '') +
        // Share Usage button
        '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);display:flex;align-items:center;gap:12px;">' +
          '<button class="share-usage-btn" ' +
            'data-order="' + esc(crm.flyOrderId) + '" ' +
            'data-customer="' + esc(crm.customerName) + '" ' +
            'data-event="' + esc(crm.eventName) + '" ' +
            'data-start="' + esc(crm.startDate) + '" ' +
            'data-end="' + esc(crm.endDate) + '" ' +
            'data-gb="' + (crm.totalGbAmount || 0) + '" ' +
            'style="display:flex;align-items:center;gap:8px;padding:10px 20px;background:linear-gradient(135deg,#e8802a,#c06820);color:white;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.2s;">' +
            '📤 Fello Pulse' +
          '</button>' +
          '<div id="share-result-' + esc(crm.flyOrderId) + '" style="flex:1;"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderStarlinkFleetSection(fleet) {
    var terminals = fleet.terminals || [];
    if (!terminals || terminals.length === 0) return '';
    var activeCount = terminals.filter(function(t) { return t.active; }).length;
    var isFiltered = fleet.filteredByOrder === true;
    var totalCount = fleet.totalCount || terminals.length;
    
    var cardsHtml = '';
    terminals.forEach(function(t, idx) {
      var statusColor = t.active ? '#10b981' : '#ef4444';
      var statusText = t.active ? 'Online' : 'Offline';
      var tid = esc(t.userTerminalId);
      cardsHtml +=
        '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
              '<span style="font-size:18px;">🛰️</span>' +
              '<span style="font-weight:700;font-size:14px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(t.nickname || t.kitSerialNumber || 'Terminal') + '</span>' +
              '<span style="font-size:11px;font-weight:600;color:' + statusColor + ';background:' + statusColor + '15;padding:2px 8px;border-radius:6px;">' + statusText + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:16px;font-size:12px;color:var(--muted);">' +
              (t.hardwareVersion ? '<span>HW: <strong>' + esc(t.hardwareVersion) + '</strong></span>' : '') +
              (t.serviceLineNumber ? '<span>SL: <strong>' + esc(t.serviceLineNumber) + '</strong></span>' : '') +
              (t.kitSerialNumber ? '<span>Kit: <strong style="font-family:monospace;font-size:11px;">' + esc(t.kitSerialNumber) + '</strong></span>' : '') +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;">' +
            '<button onclick="window.starlinkAction(\'' + tid + '\',\'reboot\',this)" title="Reboot" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:12px;font-weight:600;transition:all .2s;">🔄 Reboot</button>' +
            '<button onclick="window.starlinkAction(\'' + tid + '\',\'stow\',this)" title="Stow for transport" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:12px;font-weight:600;transition:all .2s;">📥 Stow</button>' +
            '<button onclick="window.starlinkAction(\'' + tid + '\',\'unstow\',this)" title="Unstow" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:12px;font-weight:600;transition:all .2s;">📤 Unstow</button>' +
          '</div>' +
        '</div>';
    });

    return '<div class="section" style="background:var(--surface);border:1px solid rgba(56,189,248,0.25);border-radius:12px;margin-bottom:20px;overflow:hidden;">' +
      '<div onclick="var b=this.nextElementSibling;var a=this.querySelector(\'span.sl-arrow\');if(b.style.display===\'none\'){b.style.display=\'block\';a.textContent=\'▼\'}else{b.style.display=\'none\';a.textContent=\'▶\'}" style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;">' +
        '<h3 style="margin:0;font-size:15px;font-weight:700;color:var(--text);">🛰️ Starlink Fleet — ' + (isFiltered ? terminals.length + ' on this order' : terminals.length + ' total') + '</h3>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          (isFiltered ? '<span style="font-size:11px;color:var(--muted);">of ' + totalCount + ' in fleet</span>' : '') +
          '<span style="font-size:12px;font-weight:600;color:#10b981;background:rgba(16,185,129,0.1);padding:3px 10px;border-radius:8px;">' + activeCount + ' Online</span>' +
          '<span class="sl-arrow" style="font-size:11px;color:var(--muted);">▼</span>' +
        '</div>' +
      '</div>' +
      '<div style="padding:16px 20px;display:flex;flex-direction:column;gap:10px;">' +
        cardsHtml +
      '</div>' +
    '</div>';
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

  // ── Create Order Form ─────────────────────────────────────────
  function renderCreateOrder(query) {
    resultsContainer.innerHTML = `
      <div class="create-order-container">
        <div class="create-order-header">
          <div class="create-order-icon">📦</div>
          <h2>No existing order found for <strong>"${esc(query)}"</strong></h2>
          <p class="create-order-subtitle">Would you like to create a new order? This will set up a SimpleMDM group and assign your iPads to it.</p>
        </div>

        <div class="create-order-form">
          <div class="create-order-fields">
            <div class="create-order-field">
              <label for="co-name">Order Name</label>
              <input type="text" id="co-name" value="${esc(query)}" class="create-order-input" />
            </div>
            <div class="create-order-field">
              <label for="co-account">MDM Account</label>
              <select id="co-account" class="create-order-select">
                <option value="fello" selected>Fello</option>
                <option value="alamo">Alamo Fireworks</option>
              </select>
            </div>
          </div>

          <div class="create-order-serials-section">
            <label>iPad Serial Numbers</label>
            <p class="create-order-hint">Paste multiple serials (one per line or comma-separated), or type one at a time.</p>
            <div class="create-order-serial-input-row">
              <input type="text" id="co-serial-input" class="create-order-input" placeholder="e.g. DMPXXXXXXX" />
              <button id="co-add-serial-btn" class="create-order-add-btn">+ Add</button>
            </div>
            <textarea id="co-serial-paste" class="create-order-textarea" placeholder="Or paste multiple serials here (one per line or comma-separated)..." rows="3"></textarea>
            <div id="co-serial-list" class="create-order-serial-list"></div>
          </div>

          <div id="co-progress" class="create-order-progress" style="display:none;">
            <div class="create-order-progress-bar">
              <div id="co-progress-fill" class="create-order-progress-fill"></div>
            </div>
            <div id="co-progress-text" class="create-order-progress-text">Creating order...</div>
          </div>

          <div id="co-results" class="create-order-results" style="display:none;"></div>

          <div class="create-order-actions">
            <button id="co-submit-btn" class="create-order-submit">
              <span>📦</span> Create Order
            </button>
          </div>
        </div>
      </div>
    `;
    resultsContainer.classList.add('visible');

    // Serial management state
    const serialSet = new Set();
    const serialListEl = document.getElementById('co-serial-list');
    const serialInput = document.getElementById('co-serial-input');
    const serialPaste = document.getElementById('co-serial-paste');
    const addBtn = document.getElementById('co-add-serial-btn');
    const submitBtn = document.getElementById('co-submit-btn');

    function renderSerialChips() {
      const arr = [...serialSet];
      serialListEl.innerHTML = arr.length === 0 ? '' : arr.map(s => `
        <div class="serial-chip">
          <span class="serial-chip-text">${esc(s)}</span>
          <button class="serial-chip-remove" data-serial="${esc(s)}">✕</button>
        </div>
      `).join('') + `<div class="serial-chip-count">${arr.length} device${arr.length !== 1 ? 's' : ''}</div>`;

      serialListEl.querySelectorAll('.serial-chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          serialSet.delete(btn.dataset.serial);
          renderSerialChips();
        });
      });
    }

    function addSerials(text) {
      const cleaned = text.replace(/,/g, '\n').split('\n')
        .map(s => s.trim().toUpperCase()).filter(Boolean);
      cleaned.forEach(s => serialSet.add(s));
      renderSerialChips();
    }

    addBtn.addEventListener('click', () => {
      if (serialInput.value.trim()) {
        addSerials(serialInput.value);
        serialInput.value = '';
        serialInput.focus();
      }
    });

    serialInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addBtn.click();
      }
    });

    serialPaste.addEventListener('input', () => {
      const val = serialPaste.value.trim();
      if (val.includes('\n') || val.includes(',')) {
        addSerials(val);
        serialPaste.value = '';
      }
    });

    serialPaste.addEventListener('paste', () => {
      setTimeout(() => {
        if (serialPaste.value.trim()) {
          addSerials(serialPaste.value);
          serialPaste.value = '';
        }
      }, 50);
    });

    // Submit handler
    submitBtn.addEventListener('click', async () => {
      const orderName = document.getElementById('co-name').value.trim();
      const account = document.getElementById('co-account').value;
      const serials = [...serialSet];

      if (!orderName) return alert('Please enter an order name.');
      if (serials.length === 0) return alert('Please add at least one iPad serial number.');

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-inline"></span> Creating...';

      const progressEl = document.getElementById('co-progress');
      const progressFill = document.getElementById('co-progress-fill');
      const progressText = document.getElementById('co-progress-text');
      const resultsEl = document.getElementById('co-results');

      progressEl.style.display = 'block';
      progressText.textContent = 'Creating SimpleMDM group...';
      progressFill.style.width = '10%';

      try {
        const resp = await fetch('/api/orders/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderName, account, serials })
        });

        const data = await resp.json();

        if (!resp.ok) {
          throw new Error(data.error || 'Order creation failed');
        }

        progressFill.style.width = '100%';
        progressText.textContent = 'Complete!';

        // Show per-serial results
        const { results: serialResults, summary } = data;
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = `
          <div class="create-order-summary">
            <div class="create-order-summary-stat success">
              <span class="stat-num">${summary.assigned}</span>
              <span class="stat-label">Assigned</span>
            </div>
            <div class="create-order-summary-stat ${summary.notFound > 0 ? 'warning' : ''}">
              <span class="stat-num">${summary.notFound}</span>
              <span class="stat-label">Not Found</span>
            </div>
            <div class="create-order-summary-stat ${summary.errors > 0 ? 'error' : ''}">
              <span class="stat-num">${summary.errors}</span>
              <span class="stat-label">Errors</span>
            </div>
          </div>
          <div class="create-order-serial-results">
            ${serialResults.map(r => `
              <div class="serial-result ${r.status}">
                <span class="serial-result-icon">${r.status === 'assigned' ? '✅' : r.status === 'not_found' ? '⚠️' : '❌'}</span>
                <span class="serial-result-serial">${esc(r.serial)}</span>
                <span class="serial-result-status">${r.status === 'assigned' 
                  ? (r.deviceName ? esc(r.deviceName) : 'Assigned') 
                  : esc(r.error || r.status)}</span>
              </div>
            `).join('')}
          </div>
          <button class="create-order-view-btn" onclick="document.getElementById('search-input').value='${esc(orderName)}';document.getElementById('search-btn').click();">
            🔍 View Order "${esc(orderName)}"
          </button>
        `;

      } catch (err) {
        progressFill.style.width = '100%';
        progressFill.style.background = 'var(--red)';
        progressText.textContent = 'Failed';
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = `<div class="create-order-error">❌ ${esc(err.message)}</div>`;
      }

      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>📦</span> Create Order';
    });
  }

  // ── Group Results ────────────────────────────────────────────
  function renderGroupResults(data, query) {
    const mdm = data.simpleMdmDevices || [];
    const web = data.webbingDevices || [];
    const stats = data.stats || {};
    const usage = data.usage || {};
    const branchId = data.branchName || query;
    const numericBranchId = data.branchId || null;
    const siteCheck = data.siteCheck || null;
    const slFleet = data.starlinkFleet || null;
    const slTerminals = (slFleet && slFleet.terminals) || [];
    window._currentBranchId = numericBranchId;
    window._currentBranchName = branchId;
    window._starlinkFleet = slFleet;

    // Extract shipping address from CRM order for auto-site-check
    window._orderShippingAddress = '';
    if (data.crmOrder && data.crmOrder.shipping) {
      const s = data.crmOrder.shipping;
      const parts = [s.address1, s.city, s.state, s.zip].filter(Boolean);
      if (parts.length >= 2) {
        window._orderShippingAddress = parts.join(', ');
      }
    }

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
        ${slTerminals.length > 0 ? `<div class="stat-card" style="background:rgba(56,189,248,0.08);border-color:rgba(56,189,248,0.2);">
          <div class="stat-label">🛰️ Starlinks</div>
          <div class="stat-value" style="color:#38bdf8;">${slTerminals.length}</div>
        </div>` : ''}
        <div class="stat-card stat-amber">
          <div class="stat-label">Non-MDM Devices</div>
          <div class="stat-value">${nonMdmDevices > 0 ? '📶 ' + nonMdmDevices : '0'}</div>
        </div>
      </div>

${data.crmOrder ? renderCrmOrderSection(data.crmOrder) : ''}

${slFleet && slTerminals.length > 0 ? renderStarlinkFleetSection(slFleet) : ''}

${(mdm.length > 0 || web.length > 0) ? `
      <!-- Quick Actions -->
      <div class="actions-bar">
        <button class="btn btn-warning" onclick="window.bulkAction('${esc(branchId)}', 'suspend')">⏸ Bulk Suspend SIMs</button>
        <button class="btn btn-success" onclick="window.bulkAction('${esc(branchId)}', 'activate')">▶ Bulk Activate SIMs</button>
        <button class="btn btn-outline" style="border-color:var(--red);color:var(--red);" onclick="window.bulkLostMode('enable')">🔴 Enable Lost Mode All</button>
        <button class="btn btn-outline" style="border-color:var(--green);color:var(--green);" onclick="window.bulkLostMode('disable')">🟢 Disable Lost Mode All</button>
      </div>` : (data.crmOrder ? `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px;text-align:center;">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px;">📋 IMS Order Found — No Devices Deployed Yet</div>
        <div style="font-size:13px;color:var(--muted);">This order exists in IMS NextGen but has no devices assigned in SimpleMDM or Webbing. Devices will appear here once deployed.</div>
      </div>` : '')}

      <!-- Site Checker & Carrier Assignment -->
      <div class="site-checker-panel" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:20px;overflow:hidden;">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <h3 style="margin:0;font-size:15px;font-weight:700;color:var(--text);">📡 Site Checker & Carrier Assignment</h3>
          <span id="site-check-status" style="font-size:12px;color:var(--muted);">${siteCheck?.appliedCarrier ? 'Currently applied: ' + esc(siteCheck.appliedCarrier) : ''}</span>
        </div>
        
        <!-- Address Input -->
        <div style="padding:16px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <input type="text" id="site-check-address" placeholder="Enter deployment address..." value="${esc(siteCheck?.inputAddress || window._orderShippingAddress || '')}" style="flex:1;min-width:280px;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;">
          <button class="btn btn-primary" onclick="window.runSiteCheck()" id="site-check-btn">🔍 Check Coverage</button>
        </div>
        
        <!-- Coverage Results -->
        <div id="site-check-results" style="display:none;padding:16px 20px;background:rgba(0,0,0,0.02);"></div>
        
        <!-- Carrier Assignment -->
        <div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <span style="font-weight:700;font-size:14px;">Switch Carrier:</span>
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
        mdmAccount: ipad.mdmAccount || 'fello',
        mdmAccountName: ipad.mdmAccountName || 'Fello',
        simDeviceId: sim.serviceDeviceId || null,
        simStatusRaw: sim.status || m.simStatus || '',
        // iPad fields
        name: m.ipadName,
        ipadSerial: m.ipadSerial,
        barcode: ipad.barcode || '',
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
        mdmAccount: d.mdmAccount || 'fello',
        mdmAccountName: d.mdmAccountName || 'Fello',
        simDeviceId: null,
        simStatusRaw: '',
        name: d.name || d.device_name || '',
        ipadSerial: d.serial || d.serial_number || '',
        barcode: d.barcode || '',
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
        plan: '', ip: '', simModel: '', vendor: '', barcode: ''
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
        vendor: w.vendor || '',
        barcode: ''
      });
    }

    // Add Starlink terminals from SpaceX API (if available)
    if (slTerminals.length > 0) {
      slTerminals.forEach(function(t) {
        window._fleetRows.push({
          linked: false,
          mdmId: null,
          simDeviceId: null,
          simStatusRaw: t.active ? 'active' : 'offline',
          deviceType: 'starlink',
          name: '🛰️ ' + (t.nickname || t.kitSerialNumber || 'Starlink Terminal'),
          ipadSerial: t.kitSerialNumber || '',
          model: t.hardwareVersion || 'Starlink',
          os: t.softwareVersion || '',
          battery: null,
          capacity: '', lastSeenAt: '', enrolledAt: '',
          phoneNumber: '', wifiMac: '', mdmImei: '',
          imei: '',
          eid: '',
          simSerial: t.dishSerialNumber || '',
          iccid: t.serviceLineNumber || '',
          carrier: 'SpaceX',
          simStatus: t.active ? 3 : 4,
          plan: t.serviceLineNumber || '',
          ip: '',
          simModel: t.hardwareVersion || '',
          vendor: 'SpaceX',
          barcode: '',
          starlinkTerminalId: t.userTerminalId || '',
          starlinkRouterId: t.routerId || ''
        });
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
    
    if (siteCheck && (siteCheck.results || siteCheck.carriers)) {
      setTimeout(() => window.renderSiteCheckResults(siteCheck), 0);
    } else if (window._orderShippingAddress && !siteCheck?.inputAddress) {
      // Auto-run site check with the order's shipping address
      setTimeout(() => {
        console.log('[SiteCheck] Auto-running for order address:', window._orderShippingAddress);
        window.runSiteCheck();
      }, 500);
    }
  }

  window.runSiteCheck = async function() {
    const address = document.getElementById('site-check-address').value.trim();
    if (!address) {
      showToast('Please enter an address', 'error');
      return;
    }
    const btn = document.getElementById('site-check-btn');
    btn.disabled = true;
    btn.innerHTML = '⏳ Checking...';
    try {
      const res = await fetch(`/api/orders/${window._currentBranchName}/site-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check site');
      window.renderSiteCheckResults(data);
      showToast('Coverage check complete');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '🔍 Check Coverage';
    }
  };

  window.renderSiteCheckResults = function(data) {
    const container = document.getElementById('site-check-results');
    if (!container) return;
    
    const carrierBranding = {
      'T-Mobile': { logo: 'https://logo.clearbit.com/t-mobile.com', color: '#E20074', bg: 'rgba(226,0,116,0.08)' },
      'AT&T': { logo: 'https://logo.clearbit.com/att.com', color: '#009FDB', bg: 'rgba(0,159,219,0.08)' },
      'Verizon': { logo: 'https://logo.clearbit.com/verizon.com', color: '#CD040B', bg: 'rgba(205,4,11,0.08)' }
    };

    let html = `<div style="margin-bottom:14px;font-size:13px;color:var(--text);"><i style="color:var(--muted);">Geocoded:</i> <strong>${esc(data.geocodedAddress || data.address || data.inputAddress || '')}</strong></div>`;
    
    html += `<div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:16px;">`;
    
    const carriers = data.carriers || [];
    carriers.forEach(c => {
      const dbm = c.signalDbm || -100;
      let bars = 1;
      let barColor = '#ef4444';
      let qual = 'Poor';
      if (dbm >= -75) { bars = 4; barColor = '#22c55e'; qual = 'Excellent'; }
      else if (dbm >= -85) { bars = 3; barColor = '#22c55e'; qual = 'Good'; }
      else if (dbm >= -95) { bars = 2; barColor = '#f59e0b'; qual = 'Fair'; }
      
      const isRec = c.recommended;
      const brand = carrierBranding[c.name] || { logo: '', color: '#888', bg: 'transparent' };
      const btnStyle = isRec 
        ? `background:${brand.color};color:#fff;border:none;` 
        : `background:transparent;color:var(--text);border:1px solid var(--border);`;
      const btnLabel = isRec ? '✅ Apply Recommended' : `Apply ${esc(c.name)}`;
      
      html += `
        <div style="background:${isRec ? brand.bg : 'var(--bg)'};border:2px solid ${isRec ? brand.color : 'var(--border)'};border-radius:12px;padding:18px;position:relative;transition:border-color 0.2s;">
          ${isRec ? `<div style="position:absolute;top:-10px;right:10px;background:${brand.color};color:#fff;font-size:11px;font-weight:bold;padding:2px 10px;border-radius:10px;">★ Recommended</div>` : ''}
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
            <img src="${brand.logo}" alt="${esc(c.name)}" style="width:32px;height:32px;border-radius:6px;object-fit:contain;background:#fff;padding:2px;" onerror="this.style.display='none'">
            <h4 style="margin:0;font-size:16px;font-weight:700;">${esc(c.name)}</h4>
          </div>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
            <div style="display:flex;gap:3px;align-items:flex-end;height:28px;">
              <div style="width:7px;height:25%;background:${bars >= 1 ? barColor : '#555'};border-radius:2px;"></div>
              <div style="width:7px;height:50%;background:${bars >= 2 ? barColor : '#555'};border-radius:2px;"></div>
              <div style="width:7px;height:75%;background:${bars >= 3 ? barColor : '#555'};border-radius:2px;"></div>
              <div style="width:7px;height:100%;background:${bars >= 4 ? barColor : '#555'};border-radius:2px;"></div>
            </div>
            <div style="font-size:15px;font-weight:bold;">${dbm} dBm <span style="font-weight:normal;color:var(--muted);font-size:12px;">(${qual})</span></div>
          </div>
          ${c.tech5G ? `<div style="font-size:11px;color:var(--muted);margin-bottom:2px;">5G: ${c.tech5G.signal || '—'} dBm · ${c.tech5G.coverage || '—'}</div>` : ''}
          ${c.tech4G ? `<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">4G: ${c.tech4G.signal || '—'} dBm · ${c.tech4G.coverage || '—'}</div>` : '<div style="margin-bottom:8px;"></div>'}
          <button class="btn btn-sm" style="width:100%;padding:8px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;${btnStyle}" onclick="window.applySiteCheckCarrier('${esc(c.name)}', '${c.planId}')">${btnLabel}</button>
        </div>
      `;
      
      if (isRec && c.planId) {
        const select = document.getElementById('bulk-carrier-select');
        if (select) select.value = c.planId;
      }
    });
    
    html += `</div>`;
    container.innerHTML = html;
    container.style.display = 'block';
  };

  window.applySiteCheckCarrier = async function(carrierName, planId) {
    if (!confirm(`Are you sure you want to apply ${carrierName} to all SIMs in this branch?`)) return;
    try {
      const res = await drawerAction(`/api/orders/${window._currentBranchId}/apply-carrier`, 'POST', { planId, carrierName });
      if (res && res.success) {
        showToast(`Successfully applied ${carrierName} to ${res.changed || res.total || 'all'} devices!`);
        setTimeout(handleSearch, 1000);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

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
          const res = await fetch(`/api/simplemdm/devices/${ipad.mdmId}/lost_mode?account=${ipad.mdmAccount || 'fello'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
          });
          if (res.ok) { success++; } else { failed++; }
        } else {
          const res = await fetch(`/api/simplemdm/devices/${ipad.mdmId}/lost_mode?account=${ipad.mdmAccount || 'fello'}`, { method: 'DELETE' });
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
    let csv = '"iPad Name","iPad Serial","SIM Serial","IMEI","Plan","Status","Usage (MB)","Usage (GB)","Active Days"\n';
    const fleetRows = window._fleetRows || [];
    d.results.forEach(r => {
      const matchedRow = fleetRows.find(fr => fr.simSerial === r.Serial || fr.simSerial === r.SSID);
      const ipadName = matchedRow ? matchedRow.name : '';
      const ipadSerial = matchedRow ? matchedRow.ipadSerial : '';
      const q = v => `"${String(v || '').replace(/"/g, '""')}"`;
      csv += `${q(ipadName)},${q(ipadSerial)},${q(r.Serial)},${q(r.IMEI)},${q(r.ProductName)},${q(r.StatusName)},${r.TotalUsage.toFixed(2)},${(r.TotalUsage / 1024).toFixed(3)},${r.TotalUsageDays}\n`;
    });
    csv += `"TOTAL","","","","","",${d.totals.totalUsage.toFixed(2)},${(d.totals.totalUsage / 1024).toFixed(3)},\n`;
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
    window._currentDrawerAccount = row.mdmAccount || 'fello';

    drawerTitle.innerHTML = `
      ${esc(row.name || row.simSerial || 'Device')}
      <span class="drawer-subtitle">${esc(row.ipadSerial || '')}</span>
    `;

    const hasIpad = !!row.mdmId;
    const hasSim = !!row.simDeviceId;
    const isStarlink = row.deviceType === 'starlink';
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

    // ── Starlink Controls ──
    if (isStarlink) {
      // Find matching terminal from fleet data
      const slTerminal = (window._starlinkFleet && window._starlinkFleet.terminals || []).find(t =>
        (row.simSerial && t.kitSerialNumber && row.simSerial.toUpperCase().includes(t.kitSerialNumber.toUpperCase())) ||
        (row.name && row.name.toLowerCase().includes('starlink'))
      );
      const tid = slTerminal ? slTerminal.userTerminalId : '';

      html += `
        <div class="drawer-section">
          <div class="drawer-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="ds-icon">🛰️</span> Starlink Controls <span class="ds-chevron">▼</span>
          </div>
          <div class="drawer-section-body">
            ${tid ? `
            <div class="info-grid" style="margin-bottom:12px;">
              <div class="info-item"><div class="info-label">Terminal ID</div><div class="info-value" style="font-size:11px;font-family:monospace;">${esc(tid)}</div></div>
              ${slTerminal.hardwareVersion ? `<div class="info-item"><div class="info-label">Hardware</div><div class="info-value">${esc(slTerminal.hardwareVersion)}</div></div>` : ''}
              ${slTerminal.softwareVersion ? `<div class="info-item"><div class="info-label">Software</div><div class="info-value">${esc(slTerminal.softwareVersion)}</div></div>` : ''}
              ${slTerminal.serviceLineNumber ? `<div class="info-item"><div class="info-label">Service Line</div><div class="info-value">${esc(slTerminal.serviceLineNumber)}</div></div>` : ''}
              <div class="info-item"><div class="info-label">Status</div><div class="info-value">${slTerminal.active ? '<span style="color:#10b981;font-weight:600;">Online</span>' : '<span style="color:#ef4444;font-weight:600;">Offline</span>'}</div></div>
            </div>
            <div class="action-grid">
              <button class="action-btn" onclick="window.starlinkAction('${esc(tid)}', 'reboot', this)">
                <span class="action-icon">🔄</span> Reboot
              </button>
              <button class="action-btn" onclick="window.starlinkAction('${esc(tid)}', 'stow', this)">
                <span class="action-icon">📥</span> Stow
              </button>
              <button class="action-btn" onclick="window.starlinkAction('${esc(tid)}', 'unstow', this)">
                <span class="action-icon">📤</span> Unstow
              </button>
            </div>
            ` : '<div style="color:var(--muted);font-size:13px;text-align:center;padding:12px;">Starlink terminal not linked to server-side fleet. Use the 🛰️ Starlink Fleet section above for management.</div>'}
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

  // ── Starlink Device Actions ──
  window.starlinkAction = async function(terminalId, action, btn) {
    if (!terminalId) { alert('No terminal ID available'); return; }
    var actionLabels = { reboot: 'Reboot', stow: 'Stow', unstow: 'Unstow' };
    if (!confirm('Are you sure you want to ' + (actionLabels[action] || action) + ' this Starlink terminal?')) return;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    try {
      var resp = await fetch('/api/starlink/' + action + '/' + terminalId, { method: 'POST' });
      var data = await resp.json();
      if (resp.ok && data.success) {
        if (btn) { btn.style.background = 'rgba(16,185,129,0.15)'; btn.style.color = '#10b981'; }
        alert('✅ ' + (actionLabels[action] || action) + ' command sent successfully!');
      } else {
        alert('❌ ' + (actionLabels[action] || action) + ' failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('❌ Network error: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
  };

  // ── MDM Device Actions ──
  window.mdmAction = async function(deviceId, action, btn, account) {
    if (!confirm(`Are you sure you want to ${action} this device?`)) return;
    btn.classList.add('loading');
    try {
      await drawerAction(`/api/simplemdm/devices/${deviceId}/${action}?account=${account || 'fello'}`);
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
      const acct = window._currentDrawerAccount || 'fello';
      await drawerAction(`/api/simplemdm/devices/${deviceId}/lost_mode?account=${acct}`, 'POST', { message: msg });
      btn.classList.add('success');
    } finally {
      btn.classList.remove('loading');
    }
  };

  window.disableLostMode = async function(deviceId, btn) {
    if (!confirm('Disable Lost Mode?')) return;
    btn.classList.add('loading');
    try {
      const acct = window._currentDrawerAccount || 'fello';
      await drawerAction(`/api/simplemdm/devices/${deviceId}/lost_mode?account=${acct}`, 'DELETE');
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
      
      const url = data.connectUrl || data.sessionUrl;
      if (url) {
        const overlay = document.getElementById('screen-overlay');
        const iframe = document.getElementById('screen-iframe');
        iframe.src = url;
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
    const acct = window._currentDrawerAccount || 'fello';
    await drawerAction(`/api/simplemdm/devices/${deviceId}/wipe?account=${acct}`);
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ██  eSIM ASSIGNMENT TOOL                                            ██
  // ═══════════════════════════════════════════════════════════════════════

  window.showEsimTool = function() {
    // Hide the hub/tool guide
    const toolGuide = document.getElementById('tool-guide');
    if (toolGuide) toolGuide.classList.add('hidden');
    
    // Show results container and inject eSIM UI
    resultsContainer.classList.add('visible');
    resultsContainer.innerHTML = `
      <div style="max-width:800px;margin:0 auto;">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
            <div>
              <h2 style="margin:0;font-size:20px;font-weight:700;">📲 eSIM Profile Assignment</h2>
              <p style="margin:4px 0 0;font-size:13px;color:var(--muted);">Paste iPad serial numbers to assign available Webbing eSIM profiles</p>
            </div>
            <div id="esim-available-badge" style="background:var(--bg);padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;">Loading...</div>
          </div>
          
          <div style="padding:20px 24px;">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text);">Serial Numbers <span style="font-weight:normal;color:var(--muted);">(one per line)</span></label>
            <textarea id="esim-serials" placeholder="Paste serial numbers here..." style="width:100%;height:180px;padding:14px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:monospace;font-size:13px;resize:vertical;"></textarea>
            <div style="display:flex;gap:12px;margin-top:14px;align-items:center;">
              <button class="btn btn-primary" id="esim-assign-btn" onclick="window.runEsimAssignment()" style="padding:10px 24px;font-size:14px;">📲 Assign eSIM Profiles</button>
              <span id="esim-count" style="font-size:12px;color:var(--muted);">0 serials entered</span>
            </div>
          </div>
          
          <div id="esim-results" style="display:none;"></div>
        </div>
      </div>
    `;

    // Update serial count on input
    document.getElementById('esim-serials').addEventListener('input', function() {
      const count = this.value.trim().split('\n').filter(s => s.trim()).length;
      document.getElementById('esim-count').textContent = count + ' serial' + (count !== 1 ? 's' : '') + ' entered';
    });

    // Fetch available profile count
    fetch('/api/esim/available').then(r => r.json()).then(data => {
      const badge = document.getElementById('esim-available-badge');
      if (badge) {
        const count = data.available || 0;
        badge.textContent = count + ' profiles available';
        badge.style.color = count > 0 ? 'var(--green)' : 'var(--red)';
        badge.style.border = '1px solid ' + (count > 0 ? 'var(--green)' : 'var(--red)');
      }
    }).catch(() => {
      const badge = document.getElementById('esim-available-badge');
      if (badge) badge.textContent = 'Could not check';
    });
  };

  window.runEsimAssignment = async function() {
    const textarea = document.getElementById('esim-serials');
    const serials = textarea.value.trim().split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!serials.length) {
      showToast('Please enter at least one serial number', 'error');
      return;
    }

    const btn = document.getElementById('esim-assign-btn');
    btn.disabled = true;
    btn.innerHTML = '⏳ Assigning...';

    const resultsDiv = document.getElementById('esim-results');
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = '<div style="padding:20px 24px;text-align:center;color:var(--muted);"><div style="font-size:24px;margin-bottom:8px;">⏳</div>Looking up ' + serials.length + ' device(s) in ABM and matching to eSIM profiles...</div>';

    try {
      const res = await fetch('/api/esim/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serials })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assignment failed');

      // Render results
      let html = '<div style="padding:16px 24px;border-top:1px solid var(--border);background:rgba(0,0,0,0.02);">' +
        '<div style="display:flex;gap:16px;margin-bottom:16px;">' +
          '<div style="flex:1;background:var(--bg);border-radius:10px;padding:12px 16px;text-align:center;">' +
            '<div style="font-size:24px;font-weight:700;color:var(--green);">' + (data.assigned || 0) + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px;">Assigned</div>' +
          '</div>' +
          '<div style="flex:1;background:var(--bg);border-radius:10px;padding:12px 16px;text-align:center;">' +
            '<div style="font-size:24px;font-weight:700;color:var(--red);">' + (data.failed || 0) + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px;">Failed</div>' +
          '</div>' +
          '<div style="flex:1;background:var(--bg);border-radius:10px;padding:12px 16px;text-align:center;">' +
            '<div style="font-size:24px;font-weight:700;color:var(--text);">' + (data.availableProfilesRemaining != null ? data.availableProfilesRemaining : '—') + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px;">Profiles Left</div>' +
          '</div>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          '<thead><tr style="border-bottom:2px solid var(--border);">' +
            '<th style="text-align:left;padding:8px 12px;color:var(--muted);font-weight:600;">Serial</th>' +
            '<th style="text-align:left;padding:8px 12px;color:var(--muted);font-weight:600;">EID</th>' +
            '<th style="text-align:left;padding:8px 12px;color:var(--muted);font-weight:600;">ICCID</th>' +
            '<th style="text-align:left;padding:8px 12px;color:var(--muted);font-weight:600;">Status</th>' +
          '</tr></thead><tbody>';

      for (const r of (data.results || [])) {
        const statusIcon = r.status === 'success' ? '✅' : '❌';
        const statusColor = r.status === 'success' ? 'var(--green)' : 'var(--red)';
        const eidShort = r.eid ? (r.eid.substring(0, 8) + '...' + r.eid.substring(r.eid.length - 4)) : '—';
        const statusText = r.status === 'success' ? 'Assigned' : (r.error || 'Failed');
        html += '<tr style="border-bottom:1px solid var(--border);">' +
          '<td style="padding:8px 12px;font-family:monospace;font-weight:600;">' + esc(r.serial) + '</td>' +
          '<td style="padding:8px 12px;font-family:monospace;font-size:11px;color:var(--muted);" title="' + esc(r.eid || '') + '">' + eidShort + '</td>' +
          '<td style="padding:8px 12px;font-family:monospace;font-size:11px;">' + esc(r.iccid || '—') + '</td>' +
          '<td style="padding:8px 12px;color:' + statusColor + ';">' + statusIcon + ' ' + esc(statusText) + '</td>' +
        '</tr>';
      }

      html += '</tbody></table></div>';
      resultsDiv.innerHTML = html;
      showToast('eSIM assignment complete: ' + data.assigned + '/' + data.total + ' successful');
    } catch (err) {
      resultsDiv.innerHTML = '<div style="padding:20px 24px;color:var(--red);">' + esc(err.message) + '</div>';
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '📲 Assign eSIM Profiles';
    }
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ── Customer Data Usage Sharing ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// Delegated click handler for share buttons
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.share-usage-btn');
  if (!btn) return;
  
  var orderId = btn.getAttribute('data-order');
  var customerName = btn.getAttribute('data-customer');
  var eventName = btn.getAttribute('data-event');
  var startDate = btn.getAttribute('data-start');
  var endDate = btn.getAttribute('data-end');
  var totalGbAmount = parseFloat(btn.getAttribute('data-gb') || 0);
  
  window.generateShareLink(orderId, customerName, eventName, startDate, endDate, totalGbAmount);
});

window.generateShareLink = async function(orderId, customerName, eventName, startDate, endDate, totalGbAmount) {
  var resultDiv = document.getElementById('share-result-' + orderId);
  if (!resultDiv) return;
  
  resultDiv.innerHTML = '<span style="font-size:12px;color:var(--muted);">Generating Fello Pulse link...</span>';
  
  // Extract session token — try cookie first, then localStorage backup
  function getSessionToken() {
    var match = document.cookie.match(/fello_session=([^;]+)/);
    if (match) return match[1];
    // Fallback to localStorage (set during login)
    try { return localStorage.getItem('fello_session_token') || ''; } catch(e) { return ''; }
  }
  
  try {
    var sessionToken = getSessionToken();
    var headers = { 'Content-Type': 'application/json' };
    if (sessionToken) headers['X-Session-Token'] = sessionToken;
    
    var res = await fetch('/api/share/generate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify({ 
        orderId: orderId, 
        customerName: customerName, 
        eventName: eventName, 
        startDate: startDate, 
        endDate: endDate, 
        totalGbAmount: totalGbAmount 
      })
    });
    
    if (res.status === 401) {
      // Auth failed — check if we even have a cookie
      var hasCookie = !!getSessionToken();
      console.error('[Pulse] Auth failed. Cookie present:', hasCookie, 'Status:', res.status);
      throw new Error('Session expired. Please refresh the page and try again.');
    }
    
    if (!res.ok) {
      var errData = await res.json().catch(function() { return { error: 'Server error ' + res.status }; });
      throw new Error(errData.error || 'Failed to generate Fello Pulse link');
    }
    
    var data = await res.json();
    var shareUrl = window.location.origin + data.shareUrl;
    var expiresDate = new Date(data.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    
    // Load QR code library if not already loaded
    if (typeof qrcode === 'undefined') {
      await new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    
    // Generate QR code
    var qrImg = '';
    try {
      var qr = qrcode(0, 'M');
      qr.addData(shareUrl);
      qr.make();
      qrImg = qr.createDataURL(4, 0);
    } catch(e) {
      console.warn('QR generation failed:', e);
    }
    
    var statusLabel = data.alreadyExists ? '(Existing)' : 'Generated';
    var revokeToken = data.token;
    
    resultDiv.innerHTML = 
      '<div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px;margin-top:12px;">' +
        '<div style="display:flex;align-items:flex-start;gap:16px;">' +
          (qrImg ? '<img src="' + qrImg + '" alt="QR Code" style="width:120px;height:120px;border-radius:8px;border:1px solid var(--border);flex-shrink:0;">' : '') +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:12px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">✅ Fello Pulse Link ' + statusLabel + '</div>' +
            '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">' +
              '<input readonly value="' + shareUrl + '" id="share-url-' + orderId + '" style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:11px;font-family:monospace;background:white;min-width:0;" onclick="this.select()">' +
              '<button onclick="var i=document.getElementById(\'share-url-' + orderId + '\');navigator.clipboard.writeText(i.value);this.textContent=\'✓\';var b=this;setTimeout(function(){b.textContent=\'📋\'},1500)" ' +
                'style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:white;cursor:pointer;font-size:14px;" title="Copy link">📋</button>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--muted);">Expires: ' + expiresDate + ' · ' +
              '<a href="#" class="revoke-share-btn" data-token="' + revokeToken + '" data-order="' + orderId + '" style="color:var(--red);font-weight:600;">Revoke</a>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
      
  } catch (err) {
    resultDiv.innerHTML = '<span style="font-size:12px;color:var(--red);">❌ ' + (err.message || 'Failed to generate Fello Pulse link') + '</span>';
  }
};

// Delegated revoke handler
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.revoke-share-btn');
  if (!btn) return;
  e.preventDefault();
  
  var token = btn.getAttribute('data-token');
  var orderId = btn.getAttribute('data-order');
  
  if (!confirm('Revoke this Fello Pulse link? The customer will no longer be able to view their data.')) return;
  
  fetch('/api/share/' + token, { method: 'DELETE', credentials: 'same-origin' }).then(function(res) {
    if (!res.ok) throw new Error('Failed to revoke');
    var resultDiv = document.getElementById('share-result-' + orderId);
    if (resultDiv) {
      resultDiv.innerHTML = '<span style="font-size:12px;color:var(--muted);">🚫 Fello Pulse link revoked</span>';
    }
  }).catch(function(err) {
    alert('Error revoking Fello Pulse link: ' + err.message);
  });
});

