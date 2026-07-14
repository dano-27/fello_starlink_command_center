/* ================================================
   SimpleMDM Dashboard — app.js
   Group-first view with drill-in to devices
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
        loginScreen:         $('#login-screen'),
        dashboard:           $('#dashboard'),

        // Login
        loginForm:           $('#login-form'),
        apiKeyInput:         $('#api-key-input'),
        toggleKey:           $('#toggle-key'),
        loginBtn:            $('#login-btn'),
        loginBtnText:        $('#login-btn .btn-text'),
        loginBtnSpinner:     $('#login-btn .btn-spinner'),

        // Topbar
        refreshBtn:          $('#refresh-btn'),
        logoutBtn:           $('#logout-btn'),

        // Stats
        statPrimary:         $('#stat-primary'),
        statPrimaryLabel:    $('#stat-primary-label'),
        statSecondary:       $('#stat-secondary'),
        statSecondaryLabel:  $('#stat-secondary-label'),

        // Breadcrumb
        breadcrumbBar:       $('#breadcrumb-bar'),
        breadcrumbBack:      $('#breadcrumb-back'),
        breadcrumbGroups:    $('#breadcrumb-groups'),
        breadcrumbGroupName: $('#breadcrumb-group-name'),

        // Search
        searchInput:         $('#search-input'),
        searchClear:         $('#search-clear'),
        countLabel:          $('#count-label'),

        // Groups View
        groupsView:          $('#groups-view'),
        groupsLoading:       $('#groups-loading'),
        groupsEmpty:         $('#groups-empty'),
        groupsError:         $('#groups-error'),
        groupsErrorMessage:  $('#groups-error-message'),
        groupsRetryBtn:      $('#groups-retry-btn'),
        groupsGrid:          $('#groups-grid'),

        // Devices View
        devicesView:         $('#devices-view'),
        devicesLoading:      $('#devices-loading'),
        devicesEmpty:        $('#devices-empty'),
        devicesError:        $('#devices-error'),
        devicesErrorMessage: $('#devices-error-message'),
        devicesRetryBtn:     $('#devices-retry-btn'),
        deviceTable:         $('#device-table'),
        deviceTbody:         $('#device-tbody'),

        // Device Modal
        modalOverlay:        $('#device-modal-overlay'),
        modalClose:          $('#modal-close'),
        modalDeviceName:     $('#modal-device-name'),
        modalDeviceStatus:   $('#modal-device-status'),
        modalBody:           $('#modal-body'),
        actionLock:          $('#action-lock'),
        actionRestart:       $('#action-restart'),
        actionShutdown:      $('#action-shutdown'),

        // Confirm
        confirmOverlay:      $('#confirm-overlay'),
        confirmIcon:         $('#confirm-icon'),
        confirmTitle:        $('#confirm-title'),
        confirmMessage:      $('#confirm-message'),
        confirmCancel:       $('#confirm-cancel'),
        confirmProceed:      $('#confirm-proceed'),

        // Toast
        toastContainer:      $('#toast-container'),
    };

    // ---- State ----
    let state = {
        apiKey: '',
        // Current view: 'groups' | 'devices'
        currentView: 'groups',
        // Groups
        groups: [],
        filteredGroups: [],
        groupDeviceCounts: {},   // groupId -> count
        // Current group detail
        currentGroup: null,
        devices: [],
        filteredDevices: [],
        sortField: 'name',
        sortDir: 'asc',
        // Modal
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

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
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
        state.groups = [];
        state.filteredGroups = [];
        state.devices = [];
        state.filteredDevices = [];
        state.currentGroup = null;
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
            // Test the API key by fetching assignment groups (limit 1)
            await apiRequest('/assignment_groups?limit=1');
            saveCredentials(apiKey);
            showDashboard();
            showToast('Connected to SimpleMDM', 'success');
            navigateToGroups();
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
    //  VIEW NAVIGATION
    // ================================================

    function navigateToGroups() {
        state.currentView = 'groups';
        state.currentGroup = null;
        state.devices = [];
        state.filteredDevices = [];

        // UI updates
        dom.breadcrumbBar.classList.add('hidden');
        dom.devicesView.classList.add('hidden');
        dom.groupsView.classList.remove('hidden');

        // Search
        dom.searchInput.value = '';
        dom.searchClear.classList.add('hidden');
        dom.searchInput.placeholder = 'Search groups by name…';

        fetchGroups();
    }

    function navigateToGroupDevices(group) {
        state.currentView = 'devices';
        state.currentGroup = group;
        state.devices = [];
        state.filteredDevices = [];
        state.sortField = 'name';
        state.sortDir = 'asc';

        const groupName = getGroupName(group);

        // UI updates
        dom.groupsView.classList.add('hidden');
        dom.devicesView.classList.remove('hidden');
        dom.breadcrumbBar.classList.remove('hidden');
        dom.breadcrumbGroupName.textContent = groupName;

        // Search
        dom.searchInput.value = '';
        dom.searchClear.classList.add('hidden');
        dom.searchInput.placeholder = 'Search by name, model, or serial…';

        fetchGroupDevices(group);
    }

    // ================================================
    //  GROUP HELPERS
    // ================================================

    function getGroupName(group) {
        if (group.attributes && group.attributes.name) {
            return group.attributes.name;
        }
        if (group.name) {
            return group.name;
        }
        return 'Unnamed Group';
    }

    function getGroupType(group) {
        return group.type || 'assignment_group';
    }

    // ================================================
    //  FETCH GROUPS
    // ================================================

    function showGroupsState(stateName) {
        dom.groupsLoading.classList.add('hidden');
        dom.groupsEmpty.classList.add('hidden');
        dom.groupsError.classList.add('hidden');
        dom.groupsGrid.classList.add('hidden');

        switch (stateName) {
            case 'loading':
                dom.groupsLoading.classList.remove('hidden');
                break;
            case 'empty':
                dom.groupsEmpty.classList.remove('hidden');
                break;
            case 'error':
                dom.groupsError.classList.remove('hidden');
                break;
            case 'grid':
                dom.groupsGrid.classList.remove('hidden');
                break;
        }
    }

    async function fetchGroups() {
        showGroupsState('loading');

        try {
            let allGroups = [];
            let hasMore = true;
            let startingAfter = 0;

            while (hasMore) {
                const response = await apiRequest(`/assignment_groups?limit=100&starting_after=${startingAfter}`);
                const groups = response.data || response;

                if (Array.isArray(groups) && groups.length > 0) {
                    allGroups = allGroups.concat(groups);
                    if (groups.length < 100) {
                        hasMore = false;
                    } else {
                        startingAfter = groups[groups.length - 1].id;
                    }
                } else {
                    hasMore = false;
                }
            }

            state.groups = allGroups;
            state.filteredGroups = [...allGroups];

            // Fetch device counts for each group (in parallel, batched)
            await fetchGroupDeviceCounts(allGroups);

            updateGroupsStats();
            renderGroupsGrid();
        } catch (err) {
            if (err.status === 401) {
                showToast('Session expired. Please log in again.', 'error');
                clearCredentials();
                showLogin();
                return;
            }
            dom.groupsErrorMessage.textContent = err.message || 'An unknown error occurred.';
            showGroupsState('error');
        }
    }

    async function fetchGroupDeviceCounts(groups) {
        // Device IDs are already inline in the group response: relationships.devices.data
        state.groupDeviceCounts = {};
        groups.forEach((group) => {
            const devRel = group.relationships && group.relationships.devices && group.relationships.devices.data;
            state.groupDeviceCounts[group.id] = Array.isArray(devRel) ? devRel.length : 0;
        });
    }

    function updateGroupsStats() {
        const totalGroups = state.groups.length;
        let totalDevices = 0;
        for (const gid in state.groupDeviceCounts) {
            totalDevices += state.groupDeviceCounts[gid];
        }

        dom.statPrimary.textContent = totalGroups;
        dom.statPrimaryLabel.textContent = 'Total Groups';
        dom.statSecondary.textContent = totalDevices;
        dom.statSecondaryLabel.textContent = 'Total Devices';
    }

    function renderGroupsGrid() {
        const groups = state.filteredGroups;

        dom.countLabel.textContent = `${groups.length} group${groups.length !== 1 ? 's' : ''}`;

        if (groups.length === 0) {
            showGroupsState('empty');
            return;
        }

        dom.groupsGrid.innerHTML = '';

        groups.forEach((group, index) => {
            const name = getGroupName(group);
            const type = getGroupType(group);
            const count = state.groupDeviceCounts[group.id] || 0;
            const icon = count > 0 ? '📱' : '📋';

            const card = document.createElement('div');
            card.className = 'group-card';
            card.style.animationDelay = `${index * 0.04}s`;
            card.innerHTML = `
                <div class="group-card-icon">${icon}</div>
                <div class="group-card-body">
                    <h3 class="group-card-name">${escapeHtml(name)}</h3>
                    <span class="group-card-count">${count} device${count !== 1 ? 's' : ''}</span>
                </div>
                <div class="group-card-arrow">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
                </div>
            `;
            card.addEventListener('click', () => navigateToGroupDevices(group));
            dom.groupsGrid.appendChild(card);
        });

        showGroupsState('grid');
    }

    // ---- Filter groups ----
    function filterGroups(query) {
        const q = query.toLowerCase().trim();

        if (!q) {
            state.filteredGroups = [...state.groups];
        } else {
            state.filteredGroups = state.groups.filter(g => {
                return getGroupName(g).toLowerCase().includes(q);
            });
        }

        renderGroupsGrid();
    }

    // ================================================
    //  FETCH DEVICES FOR A GROUP
    // ================================================

    function showDevicesState(stateName) {
        dom.devicesLoading.classList.add('hidden');
        dom.devicesEmpty.classList.add('hidden');
        dom.devicesError.classList.add('hidden');
        dom.deviceTable.classList.add('hidden');

        switch (stateName) {
            case 'loading':
                dom.devicesLoading.classList.remove('hidden');
                break;
            case 'empty':
                dom.devicesEmpty.classList.remove('hidden');
                break;
            case 'error':
                dom.devicesError.classList.remove('hidden');
                break;
            case 'table':
                dom.deviceTable.classList.remove('hidden');
                break;
        }
    }

    async function fetchGroupDevices(group) {
        showDevicesState('loading');

        try {
            // Get device IDs from the group's relationships
            const devRel = group.relationships && group.relationships.devices && group.relationships.devices.data;
            const deviceIds = Array.isArray(devRel) ? devRel.map(d => d.id) : [];

            if (deviceIds.length === 0) {
                state.devices = [];
                state.filteredDevices = [];
                updateDevicesStats();
                showDevicesState('empty');
                return;
            }

            // Fetch each device's details in parallel (batched 10 at a time)
            let allDevices = [];
            const BATCH = 10;
            for (let i = 0; i < deviceIds.length; i += BATCH) {
                const batch = deviceIds.slice(i, i + BATCH);
                const results = await Promise.all(
                    batch.map(id =>
                        apiRequest(`/devices/${id}`)
                            .then(resp => resp.data || resp)
                            .catch(() => null)
                    )
                );
                allDevices = allDevices.concat(results.filter(Boolean));
            }

            state.devices = allDevices;
            state.filteredDevices = [...allDevices];
            updateDevicesStats();
            sortAndRender();
        } catch (err) {
            if (err.status === 401) {
                showToast('Session expired. Please log in again.', 'error');
                clearCredentials();
                showLogin();
                return;
            }
            dom.devicesErrorMessage.textContent = err.message || 'An unknown error occurred.';
            showDevicesState('error');
        }
    }

    function updateDevicesStats() {
        const groupName = state.currentGroup ? getGroupName(state.currentGroup) : 'Group';
        const count = state.devices.length;

        dom.statPrimary.textContent = escapeHtml(groupName);
        dom.statPrimary.style.fontSize = '1.2rem';
        dom.statPrimaryLabel.textContent = 'Assignment Group';
        dom.statSecondary.textContent = count;
        dom.statSecondaryLabel.textContent = count === 1 ? 'Device' : 'Devices';
    }

    function resetStatFontSize() {
        dom.statPrimary.style.fontSize = '';
    }

    // ================================================
    //  DEVICE HELPERS
    // ================================================

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

    // ---- Search devices ----
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

        dom.countLabel.textContent = `${devices.length} device${devices.length !== 1 ? 's' : ''}`;

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
            showDevicesState('empty');
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

        showDevicesState('table');
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

        // Refresh — context-aware
        dom.refreshBtn.addEventListener('click', () => {
            if (state.currentView === 'groups') {
                fetchGroups();
                showToast('Refreshing groups…', 'info');
            } else if (state.currentView === 'devices' && state.currentGroup) {
                fetchGroupDevices(state.currentGroup);
                showToast('Refreshing devices…', 'info');
            }
        });

        // Logout
        dom.logoutBtn.addEventListener('click', () => {
            clearCredentials();
            resetStatFontSize();
            showLogin();
            showToast('Disconnected from SimpleMDM', 'info');
        });

        // Search — context-aware
        let searchDebounce;
        dom.searchInput.addEventListener('input', (e) => {
            clearTimeout(searchDebounce);
            const q = e.target.value;
            dom.searchClear.classList.toggle('hidden', !q);

            searchDebounce = setTimeout(() => {
                if (state.currentView === 'groups') {
                    filterGroups(q);
                } else {
                    filterDevices(q);
                }
            }, 200);
        });

        dom.searchClear.addEventListener('click', () => {
            dom.searchInput.value = '';
            dom.searchClear.classList.add('hidden');
            if (state.currentView === 'groups') {
                filterGroups('');
            } else {
                filterDevices('');
            }
            dom.searchInput.focus();
        });

        // Sort (for device table)
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

        // Retry buttons
        dom.groupsRetryBtn.addEventListener('click', fetchGroups);
        dom.devicesRetryBtn.addEventListener('click', () => {
            if (state.currentGroup) {
                fetchGroupDevices(state.currentGroup);
            }
        });

        // Breadcrumb — back to groups
        dom.breadcrumbBack.addEventListener('click', (e) => {
            e.preventDefault();
            resetStatFontSize();
            navigateToGroups();
        });

        dom.breadcrumbGroups.addEventListener('click', (e) => {
            e.preventDefault();
            resetStatFontSize();
            navigateToGroups();
        });

        // Close modal
        dom.modalClose.addEventListener('click', closeDeviceModal);
        dom.modalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.modalOverlay) closeDeviceModal();
        });

        // Remote actions
        dom.actionLock.addEventListener('click', () => executeRemoteAction('lock', 'Lock'));
        dom.actionRestart.addEventListener('click', () => executeRemoteAction('restart', 'Restart'));
        dom.actionShutdown.addEventListener('click', () => executeRemoteAction('shutdown', 'Shutdown'));

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
