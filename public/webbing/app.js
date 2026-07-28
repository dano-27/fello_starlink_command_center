/**
 * Webbing IoT Dashboard — Branch-First Navigation
 * Branches = Order Numbers. Primary view lists branches, drill into devices.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────
  let branchPage = 1, branchPageSize = 50;
  let devicePage = 1, devicePageSize = 100;
  let branchDetailPage = 1, branchDetailPageSize = 100;
  let currentBranch = null; // { branchId, branchName }
  let currentDevice = null;
  let usageChart = null;
  let deviceMap = null;
  let mainMap = null;

  // ── DOM Ready ─────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initBranches();
    initDevices();
    initReports();
    initModal();
    loadBranches();
    loadStats();
    loadPlans();

    document.getElementById('btn-refresh').addEventListener('click', async () => {
      document.getElementById('sync-info').textContent = 'Syncing...';
      await fetch('/api/webbing/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full: true }) });
      loadBranches();
      loadStats();
    });
  });

  // ── Plans ─────────────────────────────────────────────────────────────
  let availablePlans = [];
  async function loadPlans() {
    try {
      const res = await fetch('/api/webbing/plans/available');
      if (res.ok) {
        const data = await res.json();
        availablePlans = data.plans || [];
        populatePlanDropdowns();
      }
    } catch (e) {
      console.error('Failed to load plans', e);
    }
  }

  function populatePlanDropdowns() {
    const opts = '<option value="">Select Plan...</option>' + 
                 availablePlans.map(p => `<option value="${p.productId}">${p.name}</option>`).join('');
    const bulkSelect = document.getElementById('bulk-plan-select');
    if (bulkSelect) bulkSelect.innerHTML = opts;
    const deviceSelect = document.getElementById('device-plan-select');
    if (deviceSelect) deviceSelect.innerHTML = opts;
  }

  // ── Tabs ───────────────────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        if (tab === 'branches') {
          document.getElementById('view-branches').classList.add('active');
          loadBranches();
        } else if (tab === 'all-devices') {
          document.getElementById('view-all-devices').classList.add('active');
          loadAllDevices();
        } else if (tab === 'map') {
          document.getElementById('view-map').classList.add('active');
          setTimeout(() => initMainMap(), 100);
        } else if (tab === 'reports') {
          document.getElementById('view-reports').classList.add('active');
          loadReportBranches();
        }
      });
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────
  async function loadStats() {
    try {
      const res = await fetch('/api/webbing/branches/list?page=1&pageSize=1');
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById('stat-branches-count').textContent = data.stats.totalBranches.toLocaleString();
      document.getElementById('stat-total-count').textContent = data.stats.totalDevices.toLocaleString();
      document.getElementById('stat-active-count').textContent = data.stats.activeDevices.toLocaleString();
      document.getElementById('stat-suspended-count').textContent = data.stats.suspendedDevices.toLocaleString();
      if (data.lastSync) {
        const ago = timeAgo(new Date(data.lastSync));
        document.getElementById('sync-info').textContent = `Last sync: ${ago}`;
      }
    } catch (e) { console.error('Stats error:', e); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  BRANCHES VIEW
  // ═══════════════════════════════════════════════════════════════════════

  function initBranches() {
    let searchTimer;
    document.getElementById('branch-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { branchPage = 1; loadBranches(); }, 300);
    });

    document.getElementById('branches-prev').addEventListener('click', () => {
      if (branchPage > 1) { branchPage--; loadBranches(); }
    });
    document.getElementById('branches-next').addEventListener('click', () => {
      branchPage++; loadBranches();
    });
  }

  async function loadBranches() {
    const search = document.getElementById('branch-search').value;
    const params = new URLSearchParams({ page: branchPage, pageSize: branchPageSize });
    if (search) params.set('search', search);

    try {
      const res = await fetch(`/api/webbing/branches/list?${params}`);
      if (!res.ok) throw new Error('Failed to load branches');
      const data = await res.json();
      renderBranches(data.branches);

      const { page, totalPages, totalRecords } = data.pagination;
      document.getElementById('branches-page-info').textContent = `Page ${page} of ${totalPages} (${totalRecords.toLocaleString()} branches)`;
      document.getElementById('branches-prev').disabled = page <= 1;
      document.getElementById('branches-next').disabled = page >= totalPages;

      // Update global stats
      document.getElementById('stat-branches-count').textContent = data.stats.totalBranches.toLocaleString();
      document.getElementById('stat-total-count').textContent = data.stats.totalDevices.toLocaleString();
      document.getElementById('stat-active-count').textContent = data.stats.activeDevices.toLocaleString();
      document.getElementById('stat-suspended-count').textContent = data.stats.suspendedDevices.toLocaleString();
    } catch (e) {
      console.error('Branches error:', e);
      document.getElementById('branches-tbody').innerHTML = `<tr><td colspan="7" class="empty-row">Error loading branches: ${e.message}</td></tr>`;
    }
  }

  function renderBranches(branches) {
    const tbody = document.getElementById('branches-tbody');
    if (!branches || branches.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No branches found.</td></tr>';
      return;
    }

    tbody.innerHTML = branches.map(b => {
      const planList = Object.entries(b.plans || {})
        .sort((a, c) => c[1] - a[1])
        .slice(0, 2)
        .map(([name, count]) => `<span class="plan-tag" title="${name}">${truncate(name, 30)} (${count})</span>`)
        .join('');
      const morePlans = Object.keys(b.plans || {}).length > 2 ? `<span class="plan-tag plan-tag-more">+${Object.keys(b.plans).length - 2} more</span>` : '';

      return `<tr class="branch-row" data-branch-id="${b.branchId}" data-branch-name="${esc(b.branchName)}">
        <td class="branch-name-cell">
          <span class="branch-icon">📦</span>
          <strong>${esc(b.branchName)}</strong>
          <span class="branch-id-badge">#${b.branchId}</span>
        </td>
        <td class="count-cell">${b.total}</td>
        <td class="count-cell"><span class="status-dot active"></span>${b.active}</td>
        <td class="count-cell"><span class="status-dot suspended"></span>${b.suspended}</td>
        <td class="count-cell">${b.inactive + b.deactivated}</td>
        <td class="plans-cell">${planList}${morePlans}</td>
        <td><button class="btn-view-branch">View →</button></td>
      </tr>`;
    }).join('');

    // Click handlers
    tbody.querySelectorAll('.branch-row').forEach(row => {
      const viewBtn = row.querySelector('.btn-view-branch');
      const handler = () => openBranch(parseInt(row.dataset.branchId), row.dataset.branchName);
      viewBtn.addEventListener('click', handler);
      row.addEventListener('dblclick', handler);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  BRANCH DETAIL VIEW
  // ═══════════════════════════════════════════════════════════════════════

  function openBranch(branchId, branchName) {
    currentBranch = { branchId, branchName };
    branchDetailPage = 1;

    // Hide branches, show detail
    document.getElementById('view-branches').classList.remove('active');
    document.getElementById('view-branch-detail').classList.add('active');
    document.getElementById('branch-detail-title').textContent = `📦 ${branchName}`;
    document.getElementById('branch-device-search').value = '';
    document.getElementById('branch-status-filter').value = '0';

    loadBranchDevices();

    document.getElementById('btn-back-to-branches').onclick = () => {
      document.getElementById('view-branch-detail').classList.remove('active');
      document.getElementById('view-branches').classList.add('active');
      document.getElementById('match-results-container').classList.add('hidden');
      document.getElementById('match-summary-bar').classList.add('hidden');
      document.getElementById('match-table-container').classList.add('hidden');
      currentBranch = null;
    };

    document.getElementById('branch-device-search').oninput = debounce(() => {
      branchDetailPage = 1; loadBranchDevices();
    }, 300);

    document.getElementById('branch-status-filter').onchange = () => {
      branchDetailPage = 1; loadBranchDevices();
    };

    document.getElementById('branch-devices-prev').onclick = () => {
      if (branchDetailPage > 1) { branchDetailPage--; loadBranchDevices(); }
    };
    document.getElementById('branch-devices-next').onclick = () => {
      branchDetailPage++; loadBranchDevices();
    };

    // Bulk Actions
    document.getElementById('btn-bulk-change-plan').onclick = () => handleBulkAction('change-plan');
    document.getElementById('btn-bulk-suspend').onclick = () => handleBulkAction('suspend');
    document.getElementById('btn-bulk-resume').onclick = () => handleBulkAction('activate');
    
    // Match with SimpleMDM
    document.getElementById('btn-match-mdm').onclick = handleMatchWithSimpleMDM;
  }
  
  async function handleMatchWithSimpleMDM() {
    if (!currentBranch) return;
    
    document.getElementById('match-results-container').classList.remove('hidden');
    document.getElementById('match-loading-container').classList.remove('hidden');
    document.getElementById('match-summary-bar').classList.add('hidden');
    document.getElementById('match-table-container').classList.add('hidden');
    document.getElementById('match-loading-text').textContent = 'Fetching live data and matching devices with SimpleMDM...';
    
    try {
      const res = await fetch(`/api/webbing/branches/${currentBranch.branchId}/match`);
      if (!res.ok) throw new Error('Match failed');
      const data = await res.json();
      
      document.getElementById('match-loading-container').classList.add('hidden');
      document.getElementById('match-summary-bar').classList.remove('hidden');
      document.getElementById('match-table-container').classList.remove('hidden');
      
      document.getElementById('match-stat-matched').textContent = data.stats.matched;
      document.getElementById('match-stat-unmatched-sims').textContent = data.stats.unmatchedWebbing;
      document.getElementById('match-stat-unmatched-ipads').textContent = data.stats.unmatchedMdm;
      document.getElementById('match-stat-total').textContent = data.stats.total;
      
      const tbody = document.getElementById('match-devices-tbody');
      let rowsHtml = '';
      
      // Matched
      data.matches.forEach(m => {
        rowsHtml += `<tr style="background: rgba(34,197,94,0.1);">
          <td><strong>${esc(m.simpleMdm.name)}</strong></td>
          <td>${esc(m.simpleMdm.serial)}</td>
          <td class="mono">${esc(m.webbing.imei)}</td>
          <td class="mono">${esc(m.webbing.iccid)}</td>
          <td>${esc(m.webbing.serial)}</td>
          <td><span class="status-badge ${m.webbing.status === 'Active' ? 'active' : 'suspended'}">${esc(m.webbing.status)}</span></td>
          <td>${esc(m.webbing.carrier || '—')}</td>
          <td>${esc(m.webbing.plan || '—')}</td>
          <td class="mono">${esc(m.webbing.ip || '—')}</td>
        </tr>`;
      });
      
      // Unmatched Webbing (SIMs)
      data.unmatchedWebbing.forEach(w => {
        rowsHtml += `<tr style="background: rgba(245,158,11,0.1);">
          <td>—</td>
          <td>—</td>
          <td class="mono">${esc(w.imei || '—')}</td>
          <td class="mono">${esc(w.iccid || '—')}</td>
          <td>${esc(w.serial)}</td>
          <td><span class="status-badge ${w.status === 'Active' ? 'active' : 'suspended'}">${esc(w.status)}</span></td>
          <td>${esc(w.carrier || '—')}</td>
          <td>${esc(w.plan || '—')}</td>
          <td class="mono">${esc(w.ip || '—')}</td>
        </tr>`;
      });
      
      // Unmatched MDM (iPads)
      data.unmatchedMdm.forEach(m => {
        rowsHtml += `<tr style="background: rgba(239,68,68,0.1);">
          <td><strong>${esc(m.name)}</strong></td>
          <td>${esc(m.serial)}</td>
          <td class="mono">${esc(m.imei || '—')}</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
        </tr>`;
      });
      
      if (!rowsHtml) rowsHtml = '<tr><td colspan="9" class="empty-row">No data found.</td></tr>';
      tbody.innerHTML = rowsHtml;
      
    } catch (e) {
      document.getElementById('match-loading-container').classList.add('hidden');
      alert(`Error matching devices: ${e.message}`);
    }
  }

  async function handleBulkAction(action) {
    if (!currentBranch) return;
    
    let url = `/api/webbing/branches/${currentBranch.branchId}/${action}`;
    let body = {};
    let confirmMsg = '';

    if (action === 'change-plan') {
      const productId = document.getElementById('bulk-plan-select').value;
      if (!productId) return alert('Please select a plan first.');
      const planName = document.getElementById('bulk-plan-select').options[document.getElementById('bulk-plan-select').selectedIndex].text;
      confirmMsg = `Are you sure you want to change ALL devices in this branch to:\n${planName}?`;
      body = { productId: parseInt(productId) };
    } else if (action === 'suspend') {
      confirmMsg = 'Are you sure you want to suspend ALL active devices in this branch?';
    } else if (action === 'activate') {
      confirmMsg = 'Are you sure you want to resume ALL suspended devices in this branch?';
    }

    if (!confirm(confirmMsg)) return;

    const progressContainer = document.getElementById('bulk-progress-container');
    const progressBar = document.getElementById('bulk-progress-bar');
    const progressText = document.getElementById('bulk-progress-text');
    const progressCount = document.getElementById('bulk-progress-count');
    
    progressContainer.classList.remove('hidden');
    progressText.textContent = `Performing ${action}...`;
    progressBar.style.width = '50%'; // Fake progress for now, real progress needs a stream, but we just wait for the response
    progressCount.textContent = '...';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Object.keys(body).length ? JSON.stringify(body) : null
      });
      const data = await res.json();
      
      progressBar.style.width = '100%';
      progressText.textContent = 'Done!';
      
      if (data.success) {
        const successes = data.results.filter(r => r.success).length;
        progressCount.textContent = `${successes} / ${data.results.length} succeeded`;
        setTimeout(() => {
          progressContainer.classList.add('hidden');
          progressBar.style.width = '0%';
          loadBranchDevices();
        }, 3000);
      } else {
        alert(`Error: ${data.error || 'Unknown error'}`);
        progressContainer.classList.add('hidden');
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
      progressContainer.classList.add('hidden');
    }
  }

  async function loadBranchDevices() {
    if (!currentBranch) return;
    const search = document.getElementById('branch-device-search').value;
    const status = document.getElementById('branch-status-filter').value;
    const params = new URLSearchParams({ page: branchDetailPage, pageSize: branchDetailPageSize });
    if (search) params.set('search', search);
    if (status && status !== '0') params.set('status', status);

    try {
      const res = await fetch(`/api/webbing/branches/${currentBranch.branchId}/devices?${params}`);
      if (!res.ok) throw new Error('Failed to load devices');
      const data = await res.json();

      // Update branch stats
      document.getElementById('branch-stat-total').textContent = data.stats.total;
      document.getElementById('branch-stat-active').textContent = data.stats.active;
      document.getElementById('branch-stat-suspended').textContent = data.stats.suspended;
      document.getElementById('branch-stat-inactive').textContent = data.stats.inactive + data.stats.deactivated;

      renderDeviceTable(data.devices, 'branch-devices-tbody', true);

      const { page, totalPages, totalRecords } = data.pagination;
      document.getElementById('branch-devices-page-info').textContent = `Page ${page} of ${totalPages} (${totalRecords} devices)`;
      document.getElementById('branch-devices-prev').disabled = page <= 1;
      document.getElementById('branch-devices-next').disabled = page >= totalPages;
    } catch (e) {
      document.getElementById('branch-devices-tbody').innerHTML = `<tr><td colspan="7" class="empty-row">Error: ${e.message}</td></tr>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ALL DEVICES VIEW
  // ═══════════════════════════════════════════════════════════════════════

  function initDevices() {
    let searchTimer;
    document.getElementById('device-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { devicePage = 1; loadAllDevices(); }, 300);
    });
    document.getElementById('filter-status').addEventListener('change', () => { devicePage = 1; loadAllDevices(); });
    document.getElementById('filter-branch').addEventListener('change', () => { devicePage = 1; loadAllDevices(); });

    document.getElementById('devices-prev').addEventListener('click', () => {
      if (devicePage > 1) { devicePage--; loadAllDevices(); }
    });
    document.getElementById('devices-next').addEventListener('click', () => {
      devicePage++; loadAllDevices();
    });
  }

  async function loadAllDevices() {
    const search = document.getElementById('device-search').value;
    const status = document.getElementById('filter-status').value;
    const branch = document.getElementById('filter-branch').value;
    const params = new URLSearchParams({ page: devicePage, pageSize: devicePageSize });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (branch) params.set('branch', branch);

    try {
      const res = await fetch(`/api/webbing/devices?${params}`);
      if (!res.ok) throw new Error('Failed to load devices');
      const data = await res.json();

      renderDeviceTable(data.devices, 'devices-tbody', false);

      // Populate branch filter
      const branchSelect = document.getElementById('filter-branch');
      if (branchSelect.options.length <= 1 && data.branches) {
        data.branches.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = b.name;
          branchSelect.appendChild(opt);
        });
      }

      const { page, totalPages, totalRecords } = data.pagination;
      document.getElementById('devices-page-info').textContent = `Page ${page} of ${totalPages} (${totalRecords.toLocaleString()} devices)`;
      document.getElementById('devices-prev').disabled = page <= 1;
      document.getElementById('devices-next').disabled = page >= totalPages;
    } catch (e) {
      document.getElementById('devices-tbody').innerHTML = `<tr><td colspan="7" class="empty-row">Error: ${e.message}</td></tr>`;
    }
  }

  // ── Shared Device Table Renderer ──────────────────────────────────────
  function renderDeviceTable(devices, tbodyId, showActions) {
    const tbody = document.getElementById(tbodyId);
    if (!devices || devices.length === 0) {
      const cols = showActions ? 7 : 7;
      tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-row">No devices found.</td></tr>`;
      return;
    }

    tbody.innerHTML = devices.map(d => {
      const statusClass = d.StatusID === 3 ? 'active' : d.StatusID === 4 ? 'suspended' : d.StatusID === 2 ? 'inactive' : 'deactivated';
      const statusName = d.StatusName || statusClass;
      const updated = d.UpdatedAtUtc ? timeAgo(new Date(d.UpdatedAtUtc + 'Z')) : '—';
      const branchCol = showActions ? '' : `<td>${esc(d.BranchName || '—')}</td>`;
      const actionsCol = showActions
        ? `<td><button class="btn-device-detail" data-device='${JSON.stringify(d).replace(/'/g, '&#39;')}'>Details</button></td>`
        : '';

      return `<tr class="device-row" data-device-id="${d.ServiceDeviceID}">
        <td><strong>${esc(d.SSID || '—')}</strong></td>
        <td>${esc(d.Serial || '—')}</td>
        <td class="mono">${esc(d.IMEI || '—')}</td>
        <td><span class="status-badge ${statusClass}">${statusName}</span></td>
        <td class="plan-cell" title="${esc(d.ProductName || '')}">${truncate(d.ProductName || '—', 35)}</td>
        ${branchCol}
        <td>${updated}</td>
        ${actionsCol}
      </tr>`;
    }).join('');

    // Detail click handlers
    tbody.querySelectorAll('.btn-device-detail').forEach(btn => {
      btn.addEventListener('click', () => {
        const device = JSON.parse(btn.dataset.device);
        openDeviceModal(device);
      });
    });

    // Also open on row click for all-devices view
    if (!showActions) {
      tbody.querySelectorAll('.device-row').forEach(row => {
        row.addEventListener('click', async () => {
          const deviceId = row.dataset.deviceId;
          // Fetch device data from cache
          try {
            const res = await fetch(`/api/webbing/devices?search=${deviceId}&pageSize=1`);
            if (res.ok) {
              const data = await res.json();
              if (data.devices.length > 0) openDeviceModal(data.devices[0]);
            }
          } catch (e) { console.error(e); }
        });
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DEVICE DETAIL MODAL
  // ═══════════════════════════════════════════════════════════════════════

  function initModal() {
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('device-modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    document.querySelectorAll('.modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.modalTab;
        document.getElementById(`modal-${target}`).classList.add('active');

        if (target === 'usage' && currentDevice) loadDeviceUsage(currentDevice);
        if (target === 'live' && currentDevice) loadLiveData(currentDevice);
        if (target === 'location' && currentDevice) loadDeviceLocation(currentDevice);
      });
    });

    document.getElementById('btn-refresh-live').addEventListener('click', () => {
      if (currentDevice) loadLiveData(currentDevice);
    });

    document.getElementById('btn-send-sms').addEventListener('click', sendSMS);
    document.getElementById('btn-device-change-plan').addEventListener('click', changeDevicePlan);
  }

  async function changeDevicePlan() {
    if (!currentDevice) return;
    const select = document.getElementById('device-plan-select');
    const productId = select.value;
    if (!productId) return alert('Please select a plan first.');
    const planName = select.options[select.selectedIndex].text;
    if (!confirm(`Are you sure you want to change the plan for this device to:\n${planName}?`)) return;

    try {
      const res = await fetch(`/api/webbing/devices/${currentDevice.ServiceDeviceID}/change-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: parseInt(productId) })
      });
      const data = await res.json();
      if (data.success) {
        alert('Plan changed successfully.');
        closeModal();
        if (currentBranch) loadBranchDevices();
        else loadAllDevices();
      } else {
        alert(`Error: ${data.error || 'Unknown error'}`);
      }
    } catch (e) { alert(`Error: ${e.message}`); }
  }

  function openDeviceModal(device) {
    currentDevice = device;
    document.getElementById('modal-device-title').textContent = device.SSID || device.Serial || 'Device';
    document.getElementById('device-modal-overlay').classList.remove('hidden');

    // Reset to info tab
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.modal-tab[data-modal-tab="info"]').classList.add('active');
    document.getElementById('modal-info').classList.add('active');

    // Render info
    const statusClass = device.StatusID === 3 ? 'active' : device.StatusID === 4 ? 'suspended' : 'inactive';
    document.getElementById('modal-info').innerHTML = `
      <div class="info-grid">
        <div class="info-item"><label>SSID</label><span>${esc(device.SSID || '—')}</span></div>
        <div class="info-item"><label>Serial</label><span>${esc(device.Serial || '—')}</span></div>
        <div class="info-item"><label>IMEI</label><span class="mono">${esc(device.IMEI || '—')}</span></div>
        <div class="info-item"><label>MSISDN</label><span class="mono">${esc(device.MSISDN || '—')}</span></div>
        <div class="info-item"><label>Status</label><span class="status-badge ${statusClass}">${device.StatusName || '—'}</span></div>
        <div class="info-item"><label>Device Type</label><span>${esc(device.DeviceTypeName || '—')}</span></div>
        <div class="info-item"><label>Plan</label><span>${esc(device.ProductName || '—')}</span></div>
        <div class="info-item"><label>Branch</label><span>${esc(device.BranchName || '—')}</span></div>
        <div class="info-item"><label>APN</label><span>${esc(device.ApnName || '—')}</span></div>
        <div class="info-item"><label>IP</label><span class="mono">${esc(device.IP || '—')}</span></div>
        <div class="info-item"><label>Order ID</label><span>${device.OrderID || '—'}</span></div>
        <div class="info-item"><label>Service Device ID</label><span>${device.ServiceDeviceID || '—'}</span></div>
        <div class="info-item"><label>Last Updated</label><span>${device.UpdatedAtUtc ? new Date(device.UpdatedAtUtc + 'Z').toLocaleString() : '—'}</span></div>
        <div class="info-item"><label>Status Changed</label><span>${device.StatusDateChange ? new Date(device.StatusDateChange).toLocaleString() : '—'}</span></div>
      </div>`;

    // Render controls
    renderControls(device);
  }

  function closeModal() {
    document.getElementById('device-modal-overlay').classList.add('hidden');
    currentDevice = null;
  }

  function renderControls(device) {
    const btns = document.getElementById('control-status-buttons');
    if (device.StatusID === 3) {
      btns.innerHTML = `<button class="btn-action btn-danger" id="btn-suspend-device">⏸ Suspend Device</button>`;
      document.getElementById('btn-suspend-device').onclick = () => controlDevice(device, 'suspend');
    } else {
      btns.innerHTML = `<button class="btn-action btn-success" id="btn-activate-device">▶ Activate Device</button>`;
      document.getElementById('btn-activate-device').onclick = () => controlDevice(device, 'activate');
    }
  }

  async function controlDevice(device, action) {
    if (!confirm(`Are you sure you want to ${action} this device (${device.SSID || device.Serial})?`)) return;
    try {
      const res = await fetch(`/api/webbing/devices/${device.ServiceDeviceID}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Device ${action}d successfully.`);
        closeModal();
        if (currentBranch) loadBranchDevices();
      } else {
        alert(`Error: ${data.error || 'Unknown error'}`);
      }
    } catch (e) { alert(`Error: ${e.message}`); }
  }

  async function sendSMS() {
    if (!currentDevice) return;
    const message = document.getElementById('sms-message').value.trim();
    if (!message) return alert('Please enter a message.');
    try {
      const res = await fetch(`/api/webbing/devices/${currentDevice.ServiceDeviceID}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const data = await res.json();
      if (data.success) {
        alert('SMS sent successfully.');
        document.getElementById('sms-message').value = '';
      } else {
        alert(`Error: ${data.error || 'Failed to send SMS'}`);
      }
    } catch (e) { alert(`Error: ${e.message}`); }
  }

  async function loadDeviceUsage(device) {
    try {
      const res = await fetch(`/api/webbing/devices/${device.ServiceDeviceID}/usage`);
      if (!res.ok) { document.getElementById('modal-usage').innerHTML = '<p class="error-text">Failed to load usage data.</p>'; return; }
      const data = await res.json();
      const records = data.UsageRecords?.UsageRecord;
      if (!records) { document.getElementById('modal-usage').innerHTML = '<p class="empty-text">No usage data available.</p>'; return; }

      const items = Array.isArray(records) ? records : [records];
      document.getElementById('modal-usage').innerHTML = '<canvas id="usage-chart"></canvas>';
      const ctx = document.getElementById('usage-chart').getContext('2d');
      if (usageChart) usageChart.destroy();
      usageChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: items.map(i => i.Date || i.CountryName || 'Unknown'),
          datasets: [{
            label: 'Data (MB)',
            data: items.map(i => ((i.TotalBytes || 0) / 1048576).toFixed(2)),
            backgroundColor: 'rgba(59, 130, 246, 0.6)',
            borderColor: 'rgba(59, 130, 246, 1)',
            borderWidth: 1
          }]
        },
        options: { responsive: true, plugins: { legend: { labels: { color: '#e2e8f0' } } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' }, title: { display: true, text: 'MB', color: '#94a3b8' } } } }
      });
    } catch (e) { document.getElementById('modal-usage').innerHTML = `<p class="error-text">${e.message}</p>`; }
  }

  async function loadLiveData(device) {
    const el = document.getElementById('live-data-content');
    el.innerHTML = '<div class="loading-spinner">Loading...</div>';
    try {
      const res = await fetch(`/api/webbing/devices/${device.ServiceDeviceID}/live`);
      if (!res.ok) { el.innerHTML = '<p class="error-text">Failed to load live data.</p>'; return; }
      const data = await res.json();
      const live = data.LiveData || data;
      el.innerHTML = `<div class="info-grid">
        <div class="info-item"><label>Carrier (VPLMN)</label><span>${esc(live.VPLMN || live.CarrierName || '—')}</span></div>
        <div class="info-item"><label>MCC/MNC</label><span>${esc(live.MCCMNC || '—')}</span></div>
        <div class="info-item"><label>APN</label><span>${esc(live.APN || '—')}</span></div>
        <div class="info-item"><label>IP</label><span class="mono">${esc(live.IP || '—')}</span></div>
        <div class="info-item"><label>Active</label><span class="status-badge ${live.IsActive ? 'active' : 'inactive'}">${live.IsActive ? 'Yes' : 'No'}</span></div>
        <div class="info-item"><label>Last Active</label><span>${esc(live.LastActiveDate || '—')}</span></div>
        <div class="info-item"><label>Country</label><span>${esc(live.CountryName || '—')}</span></div>
      </div>`;
    } catch (e) { el.innerHTML = `<p class="error-text">${e.message}</p>`; }
  }

  async function loadDeviceLocation(device) {
    try {
      const res = await fetch(`/api/webbing/devices/${device.ServiceDeviceID}/location`);
      if (!res.ok) { document.getElementById('device-map').innerHTML = '<p class="error-text">Location unavailable.</p>'; return; }
      const data = await res.json();
      const loc = data.LocationInfo || data;
      const lat = parseFloat(loc.Latitude || loc.Lat);
      const lng = parseFloat(loc.Longitude || loc.Lng || loc.Long);

      if (isNaN(lat) || isNaN(lng)) {
        document.getElementById('device-map').innerHTML = '<p class="empty-text">No location data available for this device.</p>';
        return;
      }

      if (deviceMap) deviceMap.remove();
      deviceMap = L.map('device-map').setView([lat, lng], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(deviceMap);
      L.marker([lat, lng]).addTo(deviceMap).bindPopup(`<b>${esc(device.SSID || device.Serial)}</b><br>Lat: ${lat}, Lng: ${lng}`).openPopup();
      setTimeout(() => deviceMap.invalidateSize(), 200);
    } catch (e) { document.getElementById('device-map').innerHTML = `<p class="error-text">${e.message}</p>`; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MAP VIEW
  // ═══════════════════════════════════════════════════════════════════════

  function initMainMap() {
    if (mainMap) { mainMap.invalidateSize(); return; }
    mainMap = L.map('map-container').setView([39.8, -98.5], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mainMap);
    // TODO: Load device locations in batches and add markers
    // For now show message
    const info = L.control({ position: 'topright' });
    info.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-info-box');
      div.innerHTML = '<div style="background:rgba(0,0,0,0.8);padding:12px 16px;border-radius:8px;color:#e2e8f0;font-family:Inter">Device locations load on demand.<br>Click a device in a branch to view its location.</div>';
      return div;
    };
    info.addTo(mainMap);
  }

  // ── Utilities ─────────────────────────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '…' : str;
  }

  function timeAgo(date) {
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  REPORTS VIEW
  // ═══════════════════════════════════════════════════════════════════════

  let reportChartInstance = null;
  let currentReportData = [];

  function initReports() {
    // Set default dates: first of current month to today
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // pad month and day with 0 if needed
    const startM = String(firstDay.getMonth() + 1).padStart(2, '0');
    const startD = String(firstDay.getDate()).padStart(2, '0');
    const endM = String(now.getMonth() + 1).padStart(2, '0');
    const endD = String(now.getDate()).padStart(2, '0');
    
    document.getElementById('report-start-date').value = `${firstDay.getFullYear()}-${startM}-${startD}`;
    document.getElementById('report-end-date').value = `${now.getFullYear()}-${endM}-${endD}`;
    
    document.getElementById('btn-generate-report').addEventListener('click', generateReport);
    document.getElementById('btn-export-csv').addEventListener('click', exportReportCSV);
  }

  async function loadReportBranches() {
    try {
      const res = await fetch('/api/webbing/branches/list?pageSize=1000');
      if (res.ok) {
        const data = await res.json();
        const select = document.getElementById('report-branch-select');
        select.innerHTML = '<option value="">Select a branch...</option>' + 
          data.branches.map(b => `<option value="${b.branchId}">${esc(b.branchName)} (#${b.branchId}) - ${b.total} devices</option>`).join('');
      }
    } catch (e) { console.error('Failed to load branches for reports', e); }
  }
  
  // Format Date to MM/dd/yyyy for API
  function formatApiDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${m}/${d}/${y}`;
  }

  async function generateReport() {
    const select = document.getElementById('report-branch-select');
    const branchId = select.value;
    const branchName = select.options[select.selectedIndex]?.text || '';
    
    if (!branchId) return alert('Please select a branch.');
    
    const startStr = document.getElementById('report-start-date').value;
    const endStr = document.getElementById('report-end-date').value;
    
    if (!startStr || !endStr) return alert('Please select both start and end dates.');
    
    const startApi = formatApiDate(startStr);
    const endApi = formatApiDate(endStr);
    
    const countMatch = branchName.match(/(\d+) devices/);
    const deviceCount = countMatch ? countMatch[1] : '...';
    
    document.getElementById('report-results-container').classList.add('hidden');
    document.getElementById('report-loading-container').classList.remove('hidden');
    document.getElementById('report-loading-text').textContent = `Generating report for ~${deviceCount} devices. This may take a while...`;
    
    try {
      const res = await fetch(`/api/webbing/branches/${branchId}/usage?start=${startApi}&end=${endApi}&interval=Unknown`);
      if (!res.ok) throw new Error('Failed to generate report');
      
      const data = await res.json();
      currentReportData = data.results;
      
      // Render Results
      document.getElementById('report-loading-container').classList.add('hidden');
      document.getElementById('report-results-container').classList.remove('hidden');
      
      const totalGB = (data.totals.totalUsage / 1024).toFixed(2);
      document.getElementById('report-total-gb').textContent = `${totalGB} GB`;
      document.getElementById('report-devices-active').textContent = `${data.totals.devicesWithUsage} / ${data.totals.totalDevices}`;
      document.getElementById('report-date-range').textContent = `${startApi} - ${endApi}`;
      
      renderReportTable(data.results);
      renderReportChart(data.results);
      
    } catch (e) {
      document.getElementById('report-loading-container').classList.add('hidden');
      alert(`Error: ${e.message}`);
    }
  }

  function renderReportTable(results) {
    const tbody = document.getElementById('report-tbody');
    if (!results || results.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No usage data found.</td></tr>';
      return;
    }

    tbody.innerHTML = results.map(r => {
      const mb = parseFloat(r.TotalUsage || 0);
      const gb = mb / 1024;
      const statusClass = r.StatusName === 'Active' ? 'active' : (r.StatusName === 'Suspended' ? 'suspended' : 'inactive');
      
      return `<tr>
        <td><strong>${esc(r.SSID || '—')}</strong></td>
        <td>${esc(r.Serial || '—')}</td>
        <td class="mono">${esc(r.IMEI || '—')}</td>
        <td class="plan-cell" title="${esc(r.ProductName || '')}">${truncate(r.ProductName || '—', 30)}</td>
        <td><span class="status-badge ${statusClass}">${r.StatusName || '—'}</span></td>
        <td style="text-align:right">${mb.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
        <td style="text-align:right"><strong>${gb.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></td>
        <td style="text-align:right">${r.TotalUsageDays || 0}</td>
      </tr>`;
    }).join('');
  }

  function renderReportChart(results) {
    const top20 = results.slice(0, 20).filter(r => r.TotalUsage > 0);
    
    const ctx = document.getElementById('report-chart').getContext('2d');
    if (reportChartInstance) reportChartInstance.destroy();
    
    if (top20.length === 0) {
        return;
    }
    
    reportChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: top20.map(r => truncate(r.SSID || r.Serial || r.IMEI || 'Unknown', 15)),
        datasets: [{
          label: 'Data Used (GB)',
          data: top20.map(r => (r.TotalUsage / 1024).toFixed(2)),
          backgroundColor: 'rgba(59, 130, 246, 0.7)',
          borderColor: 'rgba(59, 130, 246, 1)',
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: { 
        responsive: true, 
        maintainAspectRatio: false,
        plugins: { 
          legend: { labels: { color: '#e2e8f0' } },
          title: { display: true, text: 'Top 20 Devices by Data Usage', color: '#e2e8f0' }
        }, 
        scales: { 
          x: { ticks: { color: '#94a3b8' } }, 
          y: { ticks: { color: '#94a3b8' }, title: { display: true, text: 'Gigabytes (GB)', color: '#94a3b8' } } 
        } 
      }
    });
  }

  function exportReportCSV() {
    if (!currentReportData || currentReportData.length === 0) return alert('No data to export.');
    
    const headers = ['SSID', 'Serial', 'IMEI', 'Plan', 'Status', 'Data Used (MB)', 'Data Used (GB)', 'Usage Days'];
    const rows = currentReportData.map(r => {
      const mb = parseFloat(r.TotalUsage || 0);
      const gb = mb / 1024;
      return [
        `"${(r.SSID || '').replace(/"/g, '""')}"`,
        `"${(r.Serial || '').replace(/"/g, '""')}"`,
        `"${(r.IMEI || '').replace(/"/g, '""')}"`,
        `"${(r.ProductName || '').replace(/"/g, '""')}"`,
        `"${(r.StatusName || '').replace(/"/g, '""')}"`,
        mb.toFixed(2),
        gb.toFixed(4),
        r.TotalUsageDays || 0
      ].join(',');
    });
    
    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.setAttribute('href', url);
    const startStr = document.getElementById('report-start-date').value;
    const endStr = document.getElementById('report-end-date').value;
    link.setAttribute('download', `Webbing_Usage_Report_${startStr}_to_${endStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
})();
