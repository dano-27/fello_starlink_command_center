/* ═══════════════════════════════════════════════════════════════
   Hexnode UEM Dashboard — app.js
   Single-page app with API key auth, device management, groups,
   detail modal, remote actions, and toast notifications.
   ═══════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─── Configuration ───
  const STORAGE_KEY = 'hexnode_credentials';
  const API_BASE = '/api/hexnode';
  const PAGE_SIZE = 15;

  // ─── State ───
  const state = {
    apiKey: '',
    devices: [],
    filteredDevices: [],
    groups: [],
    filteredGroups: [],
    currentPage: 1,
    totalDevices: 0,
    osTypes: new Set(),
    selectedDeviceId: null,
    activeTab: 'devices',
  };

  // ─── DOM Cache ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    loginScreen: $('#login-screen'),
    app: $('#app'),
    loginForm: $('#login-form'),
    apiKeyInput: $('#api-key-input'),
    toggleVis: $('#toggle-key-visibility'),
    loginBtn: $('#login-btn'),
    logoutBtn: $('#logout-btn'),

    // Stats
    statTotal: $('#stat-total-val'),
    statEnrolled: $('#stat-enrolled-val'),
    statGroups: $('#stat-groups-val'),
    statOS: $('#stat-os-val'),

    // Devices
    deviceSearch: $('#device-search'),
    searchClear: $('#search-clear'),
    osFilter: $('#os-filter'),
    refreshDevicesBtn: $('#refresh-devices-btn'),
    retryDevicesBtn: $('#retry-devices-btn'),
    deviceTbody: $('#device-tbody'),
    deviceTableWrap: $('#device-table-wrap'),
    devicesLoading: $('#devices-loading'),
    devicesEmpty: $('#devices-empty'),
    devicesError: $('#devices-error'),
    devicesErrorMsg: $('#devices-error-msg'),
    pagination: $('#pagination'),
    pageInfo: $('#page-info'),
    prevPage: $('#prev-page'),
    nextPage: $('#next-page'),

    // Groups
    groupSearch: $('#group-search'),
    refreshGroupsBtn: $('#refresh-groups-btn'),
    groupsGrid: $('#groups-grid'),
    groupsLoading: $('#groups-loading'),
    groupsEmpty: $('#groups-empty'),

    // Modal
    modalOverlay: $('#device-modal-overlay'),
    modal: $('#device-modal'),
    modalDeviceName: $('#modal-device-name'),
    modalBody: $('#modal-body'),
    modalFooter: $('#modal-footer'),
    modalClose: $('#modal-close'),
    modalLoading: $('#modal-loading'),

    // Confirm
    confirmOverlay: $('#confirm-overlay'),
    confirmIcon: $('#confirm-icon'),
    confirmTitle: $('#confirm-title'),
    confirmMessage: $('#confirm-message'),
    confirmCancel: $('#confirm-cancel'),
    confirmOk: $('#confirm-ok'),

    // Toast
    toastContainer: $('#toast-container'),

    // Tabs
    tabs: $$('.tab'),
    tabPanels: $$('.tab-content'),
  };

  // ═══════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════

  function toast(message, type = 'info', duration = 4000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;

    const icons = {
      success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#05ac3f" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff4d41" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3166ae" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e6a700" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    };

    el.innerHTML = `${icons[type] || icons.info}<span>${escapeHtml(message)}</span>`;
    dom.toastContainer.appendChild(el);

    setTimeout(() => {
      el.classList.add('toast-exit');
      el.addEventListener('animationend', () => el.remove());
    }, duration);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  }

  function getEnrollmentBadge(device) {
    // Hexnode API may return enrollment_status or is_enrolled
    const enrolled = device.enrollment_status === true ||
                     device.enrollment_status === 'Enrolled' ||
                     device.is_enrolled === true;
    const pending = device.enrollment_status === 'Pending';

    if (pending) {
      return '<span class="enrollment-badge badge-pending">⏳ Pending</span>';
    }
    if (enrolled) {
      return '<span class="enrollment-badge badge-enrolled">✓ Enrolled</span>';
    }
    return '<span class="enrollment-badge badge-unenrolled">✕ Unenrolled</span>';
  }

  // ─── API Helper ───
  async function api(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
      'Authorization': state.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const res = await fetch(url, { ...options, headers });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
    }

    // Some endpoints may return empty
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  // ═══════════════════════════════════════════
  //  AUTH
  // ═══════════════════════════════════════════

  function loadCredentials() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.apiKey || parsed;
      }
    } catch {}
    return '';
  }

  function saveCredentials(key) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: key }));
  }

  function clearCredentials() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function showLogin() {
    dom.loginScreen.classList.remove('hidden');
    dom.app.classList.add('hidden');
  }

  function showApp() {
    dom.loginScreen.classList.add('hidden');
    dom.app.classList.remove('hidden');
  }

  async function attemptLogin(key) {
    state.apiKey = key;
    const btnText = dom.loginBtn.querySelector('.btn-text');
    const btnLoader = dom.loginBtn.querySelector('.btn-loader');

    btnText.classList.add('hidden');
    btnLoader.classList.remove('hidden');
    dom.loginBtn.disabled = true;

    try {
      // Test the key by fetching devices
      await api('/devices/?page_size=1');
      saveCredentials(key);
      showApp();
      toast('Connected to Hexnode', 'success');
      loadDashboard();
    } catch (err) {
      toast(`Connection failed: ${err.message}`, 'error');
    } finally {
      btnText.classList.remove('hidden');
      btnLoader.classList.add('hidden');
      dom.loginBtn.disabled = false;
    }
  }

  function logout() {
    clearCredentials();
    state.apiKey = '';
    state.devices = [];
    state.groups = [];
    dom.apiKeyInput.value = '';
    showLogin();
    toast('Disconnected from Hexnode', 'info');
  }

  // ═══════════════════════════════════════════
  //  DASHBOARD DATA
  // ═══════════════════════════════════════════

  async function loadDashboard() {
    await Promise.all([
      fetchDevices(),
      fetchGroups(),
    ]);
  }

  // ─── DEVICES ───
  async function fetchDevices() {
    showDeviceState('loading');

    try {
      const data = await api(`/devices/?page_size=200`);
      const results = data.results || data.devices || data || [];
      state.devices = Array.isArray(results) ? results : [];
      state.totalDevices = data.count || state.devices.length;

      // Collect OS types
      state.osTypes.clear();
      state.devices.forEach(d => {
        const os = d.os_name || d.platform_name || d.os || '';
        if (os) state.osTypes.add(os);
      });

      populateOSFilter();
      filterDevices();
      updateStats();
    } catch (err) {
      showDeviceState('error', err.message);
    }
  }

  function showDeviceState(s, msg) {
    dom.deviceTableWrap.classList.toggle('hidden', s !== 'table');
    dom.devicesLoading.classList.toggle('hidden', s !== 'loading');
    dom.devicesEmpty.classList.toggle('hidden', s !== 'empty');
    dom.devicesError.classList.toggle('hidden', s !== 'error');
    dom.pagination.classList.toggle('hidden', s !== 'table');

    if (s === 'error' && msg) {
      dom.devicesErrorMsg.textContent = msg;
    }
  }

  function populateOSFilter() {
    // Clear existing options except "All OS"
    dom.osFilter.innerHTML = '<option value="">All OS</option>';
    [...state.osTypes].sort().forEach(os => {
      const opt = document.createElement('option');
      opt.value = os;
      opt.textContent = os;
      dom.osFilter.appendChild(opt);
    });
  }

  function filterDevices() {
    const query = dom.deviceSearch.value.toLowerCase().trim();
    const osFilter = dom.osFilter.value;

    dom.searchClear.classList.toggle('hidden', !query);

    state.filteredDevices = state.devices.filter(d => {
      const name = (d.device_name || d.name || '').toLowerCase();
      const model = (d.model_name || d.model || '').toLowerCase();
      const serial = (d.serial_number || d.serialnumber || '').toLowerCase();
      const os = d.os_name || d.platform_name || d.os || '';

      const matchSearch = !query || name.includes(query) || model.includes(query) || serial.includes(query);
      const matchOS = !osFilter || os === osFilter;

      return matchSearch && matchOS;
    });

    state.currentPage = 1;
    renderDeviceTable();
  }

  function renderDeviceTable() {
    const start = (state.currentPage - 1) * PAGE_SIZE;
    const pageDevices = state.filteredDevices.slice(start, start + PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(state.filteredDevices.length / PAGE_SIZE));

    if (state.filteredDevices.length === 0) {
      showDeviceState('empty');
      return;
    }

    showDeviceState('table');

    dom.deviceTbody.innerHTML = pageDevices.map(d => {
      const id = d.id || d.device_id;
      const name = d.device_name || d.name || 'Unknown';
      const model = d.model_name || d.model || '—';
      const os = d.os_name || d.platform_name || d.os || '—';
      const serial = d.serial_number || d.serialnumber || '—';
      const lastReported = d.last_reported || d.last_contact_time || d.updated_at || '';

      return `<tr data-device-id="${id}" tabindex="0">
        <td><span class="device-name">${escapeHtml(name)}</span></td>
        <td>${escapeHtml(model)}</td>
        <td>${escapeHtml(os)}</td>
        <td>${escapeHtml(serial)}</td>
        <td>${getEnrollmentBadge(d)}</td>
        <td><span class="last-reported">${formatDate(lastReported)}</span></td>
        <td><span class="row-arrow">→</span></td>
      </tr>`;
    }).join('');

    // Pagination
    dom.pageInfo.textContent = `Page ${state.currentPage} of ${totalPages} · ${state.filteredDevices.length} devices`;
    dom.prevPage.disabled = state.currentPage <= 1;
    dom.nextPage.disabled = state.currentPage >= totalPages;
    dom.pagination.classList.toggle('hidden', totalPages <= 1);
  }

  function updateStats() {
    dom.statTotal.textContent = state.devices.length;

    const enrolled = state.devices.filter(d =>
      d.enrollment_status === true ||
      d.enrollment_status === 'Enrolled' ||
      d.is_enrolled === true
    ).length;
    dom.statEnrolled.textContent = enrolled;

    dom.statGroups.textContent = state.groups.length;
    dom.statOS.textContent = state.osTypes.size;
  }

  // ─── GROUPS ───
  async function fetchGroups() {
    dom.groupsGrid.innerHTML = '';
    dom.groupsLoading.classList.remove('hidden');
    dom.groupsEmpty.classList.add('hidden');

    try {
      const data = await api('/devicegroups/');
      const results = data.results || data.device_groups || data || [];
      state.groups = Array.isArray(results) ? results : [];
      filterGroups();
      updateStats();
    } catch (err) {
      toast(`Failed to load groups: ${err.message}`, 'error');
      dom.groupsLoading.classList.add('hidden');
    }
  }

  function filterGroups() {
    const query = (dom.groupSearch?.value || '').toLowerCase().trim();

    state.filteredGroups = state.groups.filter(g => {
      const name = (g.name || g.group_name || '').toLowerCase();
      return !query || name.includes(query);
    });

    renderGroups();
  }

  function renderGroups() {
    dom.groupsLoading.classList.add('hidden');

    if (state.filteredGroups.length === 0) {
      dom.groupsGrid.innerHTML = '';
      dom.groupsEmpty.classList.remove('hidden');
      return;
    }

    dom.groupsEmpty.classList.add('hidden');

    dom.groupsGrid.innerHTML = state.filteredGroups.map(g => {
      const name = g.name || g.group_name || 'Unnamed Group';
      const count = g.device_count ?? g.devices?.length ?? '—';
      const desc = g.description || '';

      return `<div class="group-card">
        <div class="group-card-header">
          <div class="group-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <span class="group-name">${escapeHtml(name)}</span>
        </div>
        <div class="group-meta">
          <span class="group-meta-item"><strong>${count}</strong> devices</span>
          ${desc ? `<span class="group-meta-item">${escapeHtml(desc)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  // ═══════════════════════════════════════════
  //  DEVICE DETAIL MODAL
  // ═══════════════════════════════════════════

  function openDeviceModal(deviceId) {
    state.selectedDeviceId = deviceId;
    dom.modalOverlay.classList.remove('hidden');
    dom.modalFooter.classList.add('hidden');
    dom.modalDeviceName.textContent = 'Loading…';
    dom.modalBody.innerHTML = `
      <div class="state-message">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <p>Loading device details…</p>
      </div>`;

    document.body.style.overflow = 'hidden';
    fetchDeviceDetail(deviceId);
  }

  function closeDeviceModal() {
    dom.modalOverlay.classList.add('hidden');
    state.selectedDeviceId = null;
    document.body.style.overflow = '';
  }

  async function fetchDeviceDetail(deviceId) {
    try {
      const device = await api(`/devices/${deviceId}/`);
      renderDeviceDetail(device);
    } catch (err) {
      dom.modalDeviceName.textContent = 'Error';
      dom.modalBody.innerHTML = `
        <div class="state-message">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--light-red)" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <p>Failed to load device details</p>
          <span class="state-sub">${escapeHtml(err.message)}</span>
        </div>`;
    }
  }

  function renderDeviceDetail(d) {
    const name = d.device_name || d.name || 'Unknown Device';
    dom.modalDeviceName.textContent = name;
    dom.modalFooter.classList.remove('hidden');

    const fields = [
      { label: 'Device Name', value: d.device_name || d.name },
      { label: 'Model', value: d.model_name || d.model },
      { label: 'Platform / OS', value: d.os_name || d.platform_name || d.os },
      { label: 'OS Version', value: d.os_version },
      { label: 'Serial Number', value: d.serial_number || d.serialnumber },
      { label: 'IMEI', value: d.imei },
      { label: 'UDID', value: d.udid },
      { label: 'Wi-Fi MAC', value: d.wifi_mac || d.wifi_mac_address },
      { label: 'Enrollment Status', value: d.enrollment_status },
      { label: 'Compliance Status', value: d.compliance_status },
      { label: 'Supervised', value: d.is_supervised != null ? (d.is_supervised ? 'Yes' : 'No') : null },
      { label: 'Battery Level', value: d.battery_level != null ? `${d.battery_level}%` : null },
      { label: 'Storage Free', value: formatStorage(d.available_device_capacity || d.available_storage) },
      { label: 'Storage Total', value: formatStorage(d.device_capacity || d.total_storage) },
      { label: 'Last Reported', value: formatDate(d.last_reported || d.last_contact_time) },
      { label: 'Enrolled Since', value: formatDate(d.enrolled_since || d.enrollment_date) },
    ].filter(f => f.value != null && f.value !== '' && f.value !== '—');

    // Policies
    const policies = d.policy || d.policies || [];
    const policyList = Array.isArray(policies) ? policies : [policies].filter(Boolean);

    let html = `<div class="detail-section">
      <div class="detail-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        Device Information
      </div>
      <div class="detail-grid">
        ${fields.map(f => `
          <div class="detail-item">
            <div class="detail-label">${escapeHtml(f.label)}</div>
            <div class="detail-value">${escapeHtml(String(f.value))}</div>
          </div>`).join('')}
      </div>
    </div>`;

    html += `<div class="detail-section">
      <div class="detail-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Applied Policies
      </div>`;

    if (policyList.length === 0) {
      html += '<p class="no-policies">No policies applied to this device</p>';
    } else {
      html += '<ul class="policy-list">';
      policyList.forEach(p => {
        const pName = typeof p === 'string' ? p : (p.policy_name || p.name || 'Unknown Policy');
        const pType = typeof p === 'object' ? (p.policy_type || p.type || '') : '';
        html += `<li class="policy-item">
          <div class="policy-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div>
            <div class="policy-name">${escapeHtml(pName)}</div>
            ${pType ? `<div class="policy-type">${escapeHtml(pType)}</div>` : ''}
          </div>
        </li>`;
      });
      html += '</ul>';
    }

    html += '</div>';

    // Device groups
    const groups = d.groups || d.device_groups || [];
    if (Array.isArray(groups) && groups.length > 0) {
      html += `<div class="detail-section">
        <div class="detail-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          Device Groups
        </div>
        <div class="detail-grid">
          ${groups.map(g => {
            const gName = typeof g === 'string' ? g : (g.name || g.group_name || 'Group');
            return `<div class="detail-item">
              <div class="detail-value">${escapeHtml(gName)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    dom.modalBody.innerHTML = html;
  }

  function formatStorage(val) {
    if (val == null) return null;
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    if (num >= 1024) return `${(num / 1024).toFixed(1)} TB`;
    return `${num.toFixed(1)} GB`;
  }

  // ═══════════════════════════════════════════
  //  REMOTE ACTIONS
  // ═══════════════════════════════════════════

  const actionConfig = {
    lock: {
      title: 'Lock Device',
      message: 'This will immediately lock the device. The user will need their passcode to unlock it.',
      icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#3166ae" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
      endpoint: (id) => `/devices/${id}/actions/lock/`,
      successMsg: 'Lock command sent',
    },
    restart: {
      title: 'Restart Device',
      message: 'This will restart the device immediately. Any unsaved work will be lost.',
      icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e65100" stroke-width="1.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      endpoint: (id) => `/devices/${id}/actions/restart/`,
      successMsg: 'Restart command sent',
    },
    scan: {
      title: 'Scan Device',
      message: 'This will trigger a device scan to update its reported information.',
      icon: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" stroke-width="1.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
      endpoint: (id) => `/devices/${id}/actions/scan/`,
      successMsg: 'Scan command sent',
    },
  };

  let confirmResolve = null;

  function showConfirm(action) {
    const config = actionConfig[action];
    if (!config) return;

    dom.confirmIcon.innerHTML = config.icon;
    dom.confirmTitle.textContent = config.title;
    dom.confirmMessage.textContent = config.message;
    dom.confirmOverlay.classList.remove('hidden');

    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }

  function hideConfirm(result) {
    dom.confirmOverlay.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(result);
      confirmResolve = null;
    }
  }

  async function executeAction(action) {
    const config = actionConfig[action];
    if (!config || !state.selectedDeviceId) return;

    const confirmed = await showConfirm(action);
    if (!confirmed) return;

    try {
      await api(config.endpoint(state.selectedDeviceId), { method: 'POST' });
      toast(config.successMsg, 'success');
    } catch (err) {
      toast(`Action failed: ${err.message}`, 'error');
    }
  }

  // ═══════════════════════════════════════════
  //  TABS
  // ═══════════════════════════════════════════

  function switchTab(tabName) {
    state.activeTab = tabName;

    dom.tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });

    dom.tabPanels.forEach(p => {
      p.classList.toggle('active', p.id === `panel-${tabName}`);
    });
  }

  // ═══════════════════════════════════════════
  //  EVENT LISTENERS
  // ═══════════════════════════════════════════

  function bindEvents() {
    // Login
    dom.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const key = dom.apiKeyInput.value.trim();
      if (!key) return;
      attemptLogin(key);
    });

    dom.toggleVis.addEventListener('click', () => {
      const input = dom.apiKeyInput;
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    dom.logoutBtn.addEventListener('click', logout);

    // Tabs
    dom.tabs.forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Device search / filter
    dom.deviceSearch.addEventListener('input', debounce(filterDevices, 250));
    dom.searchClear.addEventListener('click', () => {
      dom.deviceSearch.value = '';
      filterDevices();
    });
    dom.osFilter.addEventListener('change', filterDevices);

    // Group search
    if (dom.groupSearch) {
      dom.groupSearch.addEventListener('input', debounce(filterGroups, 250));
    }

    // Refresh
    dom.refreshDevicesBtn.addEventListener('click', fetchDevices);
    dom.retryDevicesBtn.addEventListener('click', fetchDevices);
    dom.refreshGroupsBtn.addEventListener('click', fetchGroups);

    // Pagination
    dom.prevPage.addEventListener('click', () => {
      if (state.currentPage > 1) {
        state.currentPage--;
        renderDeviceTable();
      }
    });

    dom.nextPage.addEventListener('click', () => {
      const totalPages = Math.ceil(state.filteredDevices.length / PAGE_SIZE);
      if (state.currentPage < totalPages) {
        state.currentPage++;
        renderDeviceTable();
      }
    });

    // Device row click → open modal
    dom.deviceTbody.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-device-id]');
      if (row) {
        openDeviceModal(row.dataset.deviceId);
      }
    });

    dom.deviceTbody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const row = e.target.closest('tr[data-device-id]');
        if (row) openDeviceModal(row.dataset.deviceId);
      }
    });

    // Modal close
    dom.modalClose.addEventListener('click', closeDeviceModal);
    dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === dom.modalOverlay) closeDeviceModal();
    });

    // Remote actions
    document.querySelectorAll('.btn-action').forEach(btn => {
      btn.addEventListener('click', () => {
        executeAction(btn.dataset.action);
      });
    });

    // Confirm dialog
    dom.confirmCancel.addEventListener('click', () => hideConfirm(false));
    dom.confirmOk.addEventListener('click', () => hideConfirm(true));
    dom.confirmOverlay.addEventListener('click', (e) => {
      if (e.target === dom.confirmOverlay) hideConfirm(false);
    });

    // Keyboard: Escape closes modal / confirm
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!dom.confirmOverlay.classList.contains('hidden')) {
          hideConfirm(false);
        } else if (!dom.modalOverlay.classList.contains('hidden')) {
          closeDeviceModal();
        }
      }
    });
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // ═══════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════

  function init() {
    bindEvents();

    const savedKey = loadCredentials();
    if (savedKey) {
      dom.apiKeyInput.value = savedKey;
      attemptLogin(savedKey);
    } else {
      showLogin();
    }
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
