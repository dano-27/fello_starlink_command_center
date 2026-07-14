/* ================================================
   SimpleMDM Dashboard — app.js
   Single-page app for SimpleMDM device management
   ================================================ */

(function () {
    'use strict';

    // ---- Constants ----
    const STORAGE_KEY = 'simplemdm_credentials';
    const API_BASE = '/api/simplemdm';

    // ---- DOM Refs ----
    const $  = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {
        // Screens
        loginScreen:       $('#login-screen'),
        dashboard:         $('#dashboard'),

        // Login
        loginForm:         $('#login-form'),
        apiKeyInput:       $('#api-key-input'),
        toggleKey:         $('#toggle-key'),
        loginBtn:          $('#login-btn'),
        loginBtnText:      $('#login-btn .btn-text'),
        loginBtnSpinner:   $('#login-btn .btn-spinner'),

        // Topbar
        refreshBtn:        $('#refresh-btn'),
        logoutBtn:         $('#logout-btn'),

        // Stats
        statTotal:         $('#stat-total'),
        statEnrolled:      $('#stat-enrolled'),
        statUnenrolled:    $('#stat-unenrolled'),

        // Search
        searchInput:       $('#search-input'),
        searchClear:       $('#search-clear'),
        deviceCountLabel:  $('#device-count-label'),

        // Table
        loadingState:      $('#loading-state'),
        emptyState:        $('#empty-state'),
        errorState:        $('#error-state'),
        errorMessage:      $('#error-message'),
        retryBtn:          $('#retry-btn'),
        deviceTable:       $('#device-table'),
        deviceTbody:       $('#device-tbody'),

        // Device Modal
        modalOverlay:      $('#device-modal-overlay'),
        modalClose:        $('#modal-close'),
        modalDeviceName:   $('#modal-device-name'),
        modalDeviceStatus: $('#modal-device-status'),
        modalBody:         $('#modal-body'),
        actionLock:        $('#action-lock'),
        actionRestart:     $('#action-restart'),
        actionShutdown:    $('#action-shutdown'),

        // Confirm
        confirmOverlay:    $('#confirm-overlay'),
        confirmIcon:       $('#confirm-icon'),
        confirmTitle:      $('#confirm-title'),
        confirmMessage:    $('#confirm-message'),
        confirmCancel:     $('#confirm-cancel'),
        confirmProceed:    $('#confirm-proceed'),

        // Toast
        toastContainer:    $('#toast-container'),
    };

    // ---- State ----
    let state = {
        apiKey: '',
        devices: [],
        filteredDevices: [],
        sortField: 'name',
        sortDir: 'asc',
        currentDevice: null,
    };

    // ================================================
    //  UTILITIES
    // ================================================

    function getAuthHeader() {
        return 'Basic ' + btoa(state.apiKey + ':');
    }

    async function apiRequest(path, options = {}) {
        const url = `${API_BASE}${path}`;
        const headers = {
            'Authorization': getAuthHeader(),
            'Accept': 'application/json',
            ...(options.headers || {}),
        };

        const res = await fetch(url, { ...options, headers });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const error = new Error(`API Error ${res.status}`);
            error.status = res.status;
            error.body = body;
            throw error;
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return res.json();
        }
        return res.text();
    }

    // ================================================
    //  TOAST
    // ================================================

    function showToast(message, type = 'info') {
        const icons = {
            info: 'ℹ️',
            success: '✅',
            error: '❌',
            warning: '⚠️',
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span>${message}</span>
        `;

        dom.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-exit');
            toast.addEventListener('animationend', () => toast.remove());
        }, 4000);
    }

    // ================================================
    //  CONFIRM DIALOG
    // ================================================

    function showConfirm(title, message, icon = '⚠️') {
        return new Promise((resolve) => {
            dom.confirmIcon.textContent = icon;
            dom.confirmTitle.textContent = title;
            dom.confirmMessage.textContent = message;
            dom.confirmOverlay.classList.remove('hidden');

            function cleanup() {
                dom.confirmOverlay.classList.add('hidden');
                dom.confirmCancel.removeEventListener('click', onCancel);
                dom.confirmProceed.removeEventListener('click', onProceed);
            }

            function onCancel() {
                cleanup();
                resolve(false);
            }

            function onProceed() {
                cleanup();
                resolve(true);
            }

            dom.confirmCancel.addEventListener('click', onCancel);
            dom.confirmProceed.addEventListener('click', onProceed);
        });
    }

    // ================================================
    //  AUTH
    // ================================================

    function loadCredentials() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const creds = JSON.parse(stored);
                if (creds && creds.apiKey) {
                    return creds.apiKey;
                }
            }
        } catch (e) {
            // ignore
        }
        return '';
    }

    function saveCredentials(apiKey) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey }));
    }

    function clearCredentials() {
        localStorage.removeItem(STORAGE_KEY);
    }

    // ================================================
    //  SCREEN TRANSITIONS
    // ================================================

    function showLogin() {
        dom.dashboard.classList.add('hidden');
        dom.loginScreen.classList.remove('hidden');
        state.apiKey = '';
        state.devices = [];
        state.filteredDevices = [];
    }

    function showDashboard() {
        dom.loginScreen.classList.add('hidden');
        dom.dashboard.classList.remove('hidden');
    }

    // ================================================
    //  LOGIN
    // ================================================

    function setLoginLoading(loading) {
        if (loading) {
            dom.loginBtnText.textContent = 'Connecting…';
            dom.loginBtnSpinner.classList.remove('hidden');
            dom.loginBtn.disabled = true;
            dom.apiKeyInput.disabled = true;
        } else {
            dom.loginBtnText.textContent = 'Connect to SimpleMDM';
            dom.loginBtnSpinner.classList.add('hidden');
            dom.loginBtn.disabled = false;
            dom.apiKeyInput.disabled = false;
        }
    }

    async function attemptLogin(apiKey) {
        state.apiKey = apiKey;
        setLoginLoading(true);

        try {
            // Test the API key by fetching devices (limit 1)
            await apiRequest('/devices?limit=1');
            saveCredentials(apiKey);
            showDashboard();
            showToast('Connected to SimpleMDM', 'success');
            fetchDevices();
        } catch (err) {
            state.apiKey = '';
            if (err.status === 401) {
                showToast('Invalid API key. Please check and try again.', 'error');
            } else {
                showToast(`Connection failed: ${err.message}`, 'error');
            }
        } finally {
            setLoginLoading(false);
        }
    }

    // ================================================
    //  DEVICES
    // ================================================

    function showTableState(stateName) {
        dom.loadingState.classList.add('hidden');
        dom.emptyState.classList.add('hidden');
        dom.errorState.classList.add('hidden');
        dom.deviceTable.classList.add('hidden');

        switch (stateName) {
            case 'loading':
                dom.loadingState.classList.remove('hidden');
                break;
            case 'empty':
                dom.emptyState.classList.remove('hidden');
                break;
            case 'error':
                dom.errorState.classList.remove('hidden');
                break;
            case 'table':
                dom.deviceTable.classList.remove('hidden');
                break;
        }
    }

    async function fetchDevices() {
        showTableState('loading');
        dom.searchInput.value = '';
        dom.searchClear.classList.add('hidden');

        try {
            // Fetch all devices (paginated — SimpleMDM returns up to 100 per page)
            let allDevices = [];
            let hasMore = true;
            let startingAfter = 0;

            while (hasMore) {
                const response = await apiRequest(`/devices?limit=100&starting_after=${startingAfter}`);
                const devices = response.data || response;

                if (Array.isArray(devices) && devices.length > 0) {
                    allDevices = allDevices.concat(devices);
                    if (devices.length < 100) {
                        hasMore = false;
                    } else {
                        startingAfter = devices[devices.length - 1].id;
                    }
                } else {
                    hasMore = false;
                }
            }

            state.devices = allDevices;
            state.filteredDevices = [...allDevices];
            updateStats();
            sortAndRender();
        } catch (err) {
            if (err.status === 401) {
                showToast('Session expired. Please log in again.', 'error');
                clearCredentials();
                showLogin();
                return;
            }
            dom.errorMessage.textContent = err.message || 'An unknown error occurred.';
            showTableState('error');
        }
    }

    function updateStats() {
        const total = state.devices.length;
        const enrolled = state.devices.filter(d => getEnrollmentStatus(d) === 'enrolled').length;
        const unenrolled = total - enrolled;

        dom.statTotal.textContent = total;
        dom.statEnrolled.textContent = enrolled;
        dom.statUnenrolled.textContent = unenrolled;
    }

    function getAttr(device, key) {
        if (device.attributes && device.attributes[key] !== undefined) {
            return device.attributes[key];
        }
        if (device[key] !== undefined) {
            return device[key];
        }
        return '';
    }

    function getDeviceName(device) {
        return getAttr(device, 'name') || getAttr(device, 'device_name') || 'Unnamed Device';
    }

    function getModel(device) {
        return getAttr(device, 'model_name') || getAttr(device, 'model') || '—';
    }

    function getSerial(device) {
        return getAttr(device, 'serial_number') || '—';
    }

    function getOSVersion(device) {
        return getAttr(device, 'os_version') || '—';
    }

    function getEnrollmentStatus(device) {
        const status = getAttr(device, 'status') || getAttr(device, 'enrollment_status') || '';
        return status.toLowerCase() || 'unknown';
    }

    // ---- Sorting ----
    function sortDevices() {
        const { sortField, sortDir } = state;
        const dir = sortDir === 'asc' ? 1 : -1;

        state.filteredDevices.sort((a, b) => {
            let valA, valB;
            switch (sortField) {
                case 'name':
                    valA = getDeviceName(a).toLowerCase();
                    valB = getDeviceName(b).toLowerCase();
                    break;
                case 'model':
                    valA = getModel(a).toLowerCase();
                    valB = getModel(b).toLowerCase();
                    break;
                case 'os_version':
                    valA = getOSVersion(a).toLowerCase();
                    valB = getOSVersion(b).toLowerCase();
                    break;
                default:
                    valA = '';
                    valB = '';
            }
            if (valA < valB) return -1 * dir;
            if (valA > valB) return 1 * dir;
            return 0;
        });
    }

    function sortAndRender() {
        sortDevices();
        renderDeviceTable();
    }

    // ---- Search ----
    function filterDevices(query) {
        const q = query.toLowerCase().trim();

        if (!q) {
            state.filteredDevices = [...state.devices];
        } else {
            state.filteredDevices = state.devices.filter(d => {
                return (
                    getDeviceName(d).toLowerCase().includes(q) ||
                    getModel(d).toLowerCase().includes(q) ||
                    getSerial(d).toLowerCase().includes(q)
                );
            });
        }

        sortAndRender();
    }

    // ---- Render Table ----
    function renderDeviceTable() {
        const devices = state.filteredDevices;

        dom.deviceCountLabel.textContent = `${devices.length} device${devices.length !== 1 ? 's' : ''}`;

        // Update sort arrows
        $$('.device-table thead th.sortable').forEach(th => {
            const field = th.dataset.sort;
            const arrow = th.querySelector('.sort-arrow');
            if (field === state.sortField) {
                arrow.textContent = state.sortDir === 'asc' ? '▲' : '▼';
                arrow.style.opacity = '1';
            } else {
                arrow.textContent = '';
                arrow.style.opacity = '0.4';
            }
        });

        if (devices.length === 0) {
            showTableState('empty');
            return;
        }

        dom.deviceTbody.innerHTML = '';

        devices.forEach((device, index) => {
            const name = getDeviceName(device);
            const model = getModel(device);
            const serial = getSerial(device);
            const os = getOSVersion(device);
            const status = getEnrollmentStatus(device);

            const tr = document.createElement('tr');
            tr.style.animationDelay = `${index * 0.02}s`;
            tr.innerHTML = `
                <td><span class="device-name">${escapeHtml(name)}</span></td>
                <td>${escapeHtml(model)}</td>
                <td>${escapeHtml(serial)}</td>
                <td>${escapeHtml(os)}</td>
                <td><span class="status-badge status-${status}">${status}</span></td>
            `;
            tr.addEventListener('click', () => openDeviceModal(device));
            dom.deviceTbody.appendChild(tr);
        });

        showTableState('table');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ================================================
    //  DEVICE DETAIL MODAL
    // ================================================

    async function openDeviceModal(device) {
        state.currentDevice = device;

        dom.modalDeviceName.textContent = getDeviceName(device);

        const status = getEnrollmentStatus(device);
        dom.modalDeviceStatus.textContent = status;
        dom.modalDeviceStatus.className = `modal-badge status-badge status-${status}`;

        // Try to fetch fresh device details
        let detailDevice = device;
        try {
            const deviceId = device.id;
            const response = await apiRequest(`/devices/${deviceId}`);
            detailDevice = response.data || response;
            state.currentDevice = detailDevice;
        } catch (e) {
            // Use cached data
        }

        renderModalBody(detailDevice);
        dom.modalOverlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeDeviceModal() {
        dom.modalOverlay.classList.add('hidden');
        document.body.style.overflow = '';
        state.currentDevice = null;
    }

    function renderModalBody(device) {
        const attrs = device.attributes || device;

        const fields = [
            { label: 'Device Name', value: getDeviceName(device) },
            { label: 'Model', value: getModel(device) },
            { label: 'Serial Number', value: getSerial(device) },
            { label: 'OS Version', value: getOSVersion(device) },
            { label: 'IMEI', value: attrs.imei || '—' },
            { label: 'MEID', value: attrs.meid || '—' },
            { label: 'WiFi MAC', value: attrs.wifi_mac || '—' },
            { label: 'Bluetooth MAC', value: attrs.bluetooth_mac || '—' },
            { label: 'Battery Level', value: attrs.battery_level ? `${attrs.battery_level}%` : '—' },
            { label: 'Capacity', value: attrs.device_capacity ? `${attrs.device_capacity} GB` : '—' },
            { label: 'Available Space', value: attrs.available_device_capacity ? `${attrs.available_device_capacity} GB` : '—' },
            { label: 'Last Seen', value: formatDate(attrs.last_seen_at || attrs.last_seen) },
            { label: 'Enrollment Date', value: formatDate(attrs.enrolled_at || attrs.enrollment_date) },
            { label: 'Phone Number', value: attrs.phone_number || '—', fullWidth: false },
            { label: 'Device ID', value: device.id || '—' },
            { label: 'Build Version', value: attrs.build_version || '—' },
        ];

        let html = '<div class="detail-grid">';
        fields.forEach(f => {
            const cls = f.fullWidth ? ' full-width' : '';
            html += `
                <div class="detail-item${cls}">
                    <span class="detail-label">${f.label}</span>
                    <span class="detail-value">${escapeHtml(String(f.value))}</span>
                </div>
            `;
        });
        html += '</div>';

        dom.modalBody.innerHTML = html;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return d.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch (e) {
            return dateStr;
        }
    }

    // ================================================
    //  REMOTE ACTIONS
    // ================================================

    async function executeRemoteAction(action, actionLabel) {
        if (!state.currentDevice) return;

        const deviceName = getDeviceName(state.currentDevice);
        const deviceId = state.currentDevice.id;

        const icons = { lock: '🔒', restart: '🔄', shutdown: '⏻' };

        const confirmed = await showConfirm(
            `${actionLabel} Device?`,
            `Are you sure you want to ${actionLabel.toLowerCase()} "${deviceName}"? This action will be sent immediately.`,
            icons[action] || '⚠️'
        );

        if (!confirmed) return;

        try {
            showToast(`Sending ${actionLabel.toLowerCase()} command…`, 'info');

            await apiRequest(`/devices/${deviceId}/${action}`, {
                method: 'POST',
            });

            showToast(`${actionLabel} command sent to "${deviceName}" successfully.`, 'success');
        } catch (err) {
            showToast(`Failed to ${actionLabel.toLowerCase()} device: ${err.message}`, 'error');
        }
    }

    // ================================================
    //  EVENT HANDLERS
    // ================================================

    function initEventListeners() {
        // Login form
        dom.loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const key = dom.apiKeyInput.value.trim();
            if (!key) return;
            attemptLogin(key);
        });

        // Toggle password visibility
        dom.toggleKey.addEventListener('click', () => {
            const input = dom.apiKeyInput;
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Refresh
        dom.refreshBtn.addEventListener('click', () => {
            fetchDevices();
            showToast('Refreshing devices…', 'info');
        });

        // Logout
        dom.logoutBtn.addEventListener('click', () => {
            clearCredentials();
            showLogin();
            showToast('Disconnected from SimpleMDM', 'info');
        });

        // Search
        let searchDebounce;
        dom.searchInput.addEventListener('input', (e) => {
            clearTimeout(searchDebounce);
            const q = e.target.value;
            dom.searchClear.classList.toggle('hidden', !q);

            searchDebounce = setTimeout(() => {
                filterDevices(q);
            }, 200);
        });

        dom.searchClear.addEventListener('click', () => {
            dom.searchInput.value = '';
            dom.searchClear.classList.add('hidden');
            filterDevices('');
            dom.searchInput.focus();
        });

        // Sort
        $$('.device-table thead th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (state.sortField === field) {
                    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    state.sortField = field;
                    state.sortDir = 'asc';
                }
                sortAndRender();
            });
        });

        // Retry
        dom.retryBtn.addEventListener('click', fetchDevices);

        // Close modal
        dom.modalClose.addEventListener('click', closeDeviceModal);
        dom.modalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.modalOverlay) closeDeviceModal();
        });

        // Remote actions
        dom.actionLock.addEventListener('click', () => executeRemoteAction('lock', 'Lock'));
        dom.actionRestart.addEventListener('click', () => executeRemoteAction('restart', 'Restart'));
        dom.actionShutdown.addEventListener('click', () => executeRemoteAction('shutdown', 'shutdown'));

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!dom.confirmOverlay.classList.contains('hidden')) {
                    dom.confirmCancel.click();
                } else if (!dom.modalOverlay.classList.contains('hidden')) {
                    closeDeviceModal();
                }
            }
        });
    }

    // ================================================
    //  INIT
    // ================================================

    function init() {
        initEventListeners();

        // Auto-fill saved API key
        const savedKey = loadCredentials();
        if (savedKey) {
            dom.apiKeyInput.value = savedKey;
            // Auto-login
            attemptLogin(savedKey);
        } else {
            showLogin();
        }
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
