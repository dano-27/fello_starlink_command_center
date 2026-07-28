(function() {
  'use strict';

  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const searchSpinner = document.getElementById('search-spinner');
  const resultsContainer = document.getElementById('results-container');
  
  let currentChart = null;
  let currentMap = null;

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
        <div class="stat-card stat-amber">
          <div class="stat-label">Counts Match</div>
          <div class="stat-value">${matchIcon} ${stats.countMatch ? 'Yes' : 'No'}</div>
        </div>
        <div class="stat-card stat-green">
          <div class="stat-label">Total Usage</div>
          <div class="stat-value">${formatMB(usage.totalMB)}</div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="actions-bar">
        <button class="btn btn-warning" onclick="window.bulkAction('${esc(branchId)}', 'suspend')">⏸ Bulk Suspend SIMs</button>
        <button class="btn btn-success" onclick="window.bulkAction('${esc(branchId)}', 'activate')">▶ Bulk Activate SIMs</button>
      </div>

      <!-- iPads Section -->
      <div class="section" id="sec-ipads">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="section-title"><span class="section-icon">📱</span> iPads (MDM)</div>
          <div class="chevron">▼</div>
        </div>
        <div class="section-content table-responsive">
          <table>
            <thead>
              <tr>
                <th>Device Name</th>
                <th>Serial</th>
                <th>Model</th>
                <th>OS Version</th>
                <th>Battery</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              ${mdm.length === 0 ? '<tr><td colspan="6">No iPads found.</td></tr>' : ''}
              ${mdm.map(d => `
                <tr>
                  <td>${esc(d.name || d.device_name)}</td>
                  <td class="mono">${esc(d.serial_number || d.serial)}</td>
                  <td>${esc(d.model_name || d.model)}</td>
                  <td>${esc(d.os_version)}</td>
                  <td>${d.battery_level ? d.battery_level + '%' : '-'}</td>
                  <td>${d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- SIM Lines Section -->
      <div class="section" id="sec-sims">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="section-title"><span class="section-icon">📡</span> SIM Lines (Webbing)</div>
          <div class="chevron">▼</div>
        </div>
        <div class="section-content table-responsive">
          <table>
            <thead>
              <tr>
                <th>SIM Serial (SSID)</th>
                <th>IMEI</th>
                <th>ICCID</th>
                <th>Status</th>
                <th>Carrier</th>
                <th>Plan</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              ${web.length === 0 ? '<tr><td colspan="7">No SIM lines found.</td></tr>' : ''}
              ${web.map(w => `
                <tr>
                  <td class="mono">${esc(w.ssid || w.serial)}</td>
                  <td class="mono">${esc(w.imei)}</td>
                  <td class="mono">${esc(w.iccid)}</td>
                  <td>${getStatusBadge(w.statusId || w.status)}</td>
                  <td>${esc(w.carrier || w.network)}</td>
                  <td>${esc(w.planName || w.plan)}</td>
                  <td class="mono">${esc(w.ipAddress || w.ip)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    resultsContainer.innerHTML = html;
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
      return \`\${d.getMonth()+1}/\${d.getDate()}\`;
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
