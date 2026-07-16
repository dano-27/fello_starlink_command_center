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

        // Group Detail Tabs
        groupTabs:           $('#group-tabs'),
        gtabDevices:         $('#gtab-devices'),
        gtabProfiles:        $('#gtab-profiles'),
        gtabApps:            $('#gtab-apps'),

        // Profiles Tab
        profilesLoading:     $('#profiles-loading'),
        profilesEmpty:       $('#profiles-empty'),
        profilesGrid:        $('#profiles-grid'),
        addProfileBtn:       $('#add-profile-btn'),
        profilePicker:       $('#profile-picker'),
        profilePickerClose:  $('#profile-picker-close'),
        profilePickerSearch: $('#profile-picker-search'),
        profilePickerList:   $('#profile-picker-list'),

        // Apps Tab
        appsLoading:         $('#apps-loading'),
        appsEmpty:           $('#apps-empty'),
        appsGrid:            $('#apps-grid'),
        addAppBtn:           $('#add-app-btn'),
        appPicker:           $('#app-picker'),
        appPickerClose:      $('#app-picker-close'),
        appPickerSearch:     $('#app-picker-search'),
        appPickerList:       $('#app-picker-list'),

        // Wallpaper Modal
        wpModalOverlay:      $('#wallpaper-modal-overlay'),
        wpModalClose:        $('#wallpaper-modal-close'),
        wpProfileName:       $('#wp-profile-name'),
        wpScreen:            $('#wp-screen'),
        wpDropzone:          $('#wp-dropzone'),
        wpDropzoneContent:   $('#wp-dropzone-content'),
        wpPreview:           $('#wp-preview'),
        wpFileInput:         $('#wp-file-input'),
        wpCancel:            $('#wp-cancel'),
        wpSubmit:            $('#wp-submit'),
        createWallpaperBtn:  $('#create-wallpaper-btn'),

        // Serial Assignment Modal
        serialModalOverlay:  $('#serial-modal-overlay'),
        serialModalClose:    $('#serial-modal-close'),
        serialTextarea:      $('#serial-textarea'),
        serialCount:         $('#serial-count'),
        serialAutoSync:      $('#serial-auto-sync'),
        serialCancel:        $('#serial-cancel'),
        serialSubmit:        $('#serial-submit'),
        serialInputPhase:    $('#serial-input-phase'),
        serialProgressPhase: $('#serial-progress-phase'),
        serialProgressText:  $('#serial-progress-text'),
        serialProgressFill:  $('#serial-progress-fill'),
        serialResultsPhase:  $('#serial-results-phase'),
        serialResultsSummary:$('#serial-results-summary'),
        serialResultsList:   $('#serial-results-list'),
        serialDone:          $('#serial-done'),
        addBySerialBtn:      $('#add-by-serial-btn'),
        depSyncBtn:          $('#dep-sync-btn'),

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

        // Topbar Tabs
        tabGroups:           $('#tab-groups'),
        tabProvisioning:     $('#tab-provisioning'),

        // Provisioning View
        provisioningView:    $('#provisioning-view'),
        provLoading:         $('#prov-loading'),
        provEmpty:           $('#prov-empty'),
        provError:           $('#prov-error'),
        provErrorMessage:    $('#prov-error-message'),
        provRetryBtn:        $('#prov-retry-btn'),
        provTable:           $('#prov-table'),
        provTbody:           $('#prov-tbody'),
        provisionNewBtn:     $('#provision-new-btn'),

        // Provision Modal
        provModalOverlay:    $('#provision-modal-overlay'),
        provModalClose:      $('#provision-modal-close'),
        provForm:            $('#provision-form'),
        provEventName:       $('#prov-event-name'),
        provOrderNumber:     $('#prov-order-number'),
        provConfigMode:      $('#prov-config-mode'),
        provApps:            $('#prov-apps'),
        provAppSearch:       $('#prov-app-search'),
        provAppDropdown:     $('#prov-app-dropdown'),
        provSelectedApps:    $('#prov-selected-apps'),
        provSubmitBtn:       $('#provision-submit'),
        provCancelBtn:       $('#provision-cancel'),
    };

    // ---- State ----
    let state = {
        apiKey: '',
        // Current top-level tab: 'groups' | 'provisioning'
        activeTab: 'groups',
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
        // Provisioning
        provQueue: [],
        provExpandedId: null,
        provAutoRefreshTimer: null,
        // App catalog for picker
        appCatalog: [],
        // Group detail tabs
        activeGroupTab: 'devices',
        groupProfiles: [],
        groupApps: [],
        allProfiles: [],
        allApps: [],
        wpImageBase64: null,
        appCatalogLoaded: false,
        selectedAppIds: [],   // [{id, name}]
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

        // Reset group detail tabs
        state.activeGroupTab = 'devices';
        state.groupProfiles = [];
        state.groupApps = [];
        if (dom.groupTabs) {
            dom.groupTabs.querySelectorAll('.group-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.gtab === 'devices');
            });
        }
        if (dom.gtabDevices) dom.gtabDevices.classList.remove('hidden');
        if (dom.gtabProfiles) dom.gtabProfiles.classList.add('hidden');
        if (dom.gtabApps) dom.gtabApps.classList.add('hidden');
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
                <button class="group-delete-btn" title="Delete group" aria-label="Delete group">🗑</button>
                <div class="group-card-arrow">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
                </div>
            `;
            // Delete button — stop propagation so it doesn't drill into the group
            card.querySelector('.group-delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                deleteGroup(group);
            });
            card.addEventListener('click', () => navigateToGroupDevices(group));
            dom.groupsGrid.appendChild(card);
        });

        showGroupsState('grid');
    }

    async function deleteGroup(group) {
        const name = getGroupName(group);
        const count = state.groupDeviceCounts[group.id] || 0;

        const msg = count > 0
            ? `This group has ${count} device${count !== 1 ? 's' : ''} assigned. Deleting it will unassign them. Continue?`
            : `Are you sure you want to delete "${name}"?`;

        const confirmed = await showConfirm('Delete Group?', msg, '🗑');
        if (!confirmed) return;

        try {
            showToast(`Deleting "${name}"…`, 'info');
            await apiRequest(`/assignment_groups/${group.id}`, { method: 'DELETE' });
            showToast(`"${name}" deleted successfully.`, 'success');
            // Remove from state and re-render
            state.groups = state.groups.filter(g => g.id !== group.id);
            state.filteredGroups = state.filteredGroups.filter(g => g.id !== group.id);
            delete state.groupDeviceCounts[group.id];
            updateGroupsStats();
            renderGroupsGrid();
        } catch (err) {
            showToast(`Failed to delete group: ${err.message}`, 'error');
        }
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
            // Re-fetch the group to get the latest device relationships
            let freshGroup = group;
            try {
                const refreshed = await apiRequest(`/assignment_groups/${group.id}`);
                if (refreshed && refreshed.data) {
                    freshGroup = refreshed.data;
                    state.currentGroup = freshGroup; // update cached group
                }
            } catch (_) { /* fall back to passed-in group */ }

            // Get device IDs from the group's relationships
            const devRel = freshGroup.relationships && freshGroup.relationships.devices && freshGroup.relationships.devices.data;
            const deviceIds = Array.isArray(devRel) ? devRel.map(d => d.id) : [];

            // Also check device_groups for indirect devices
            const dgRel = freshGroup.relationships && freshGroup.relationships.device_groups && freshGroup.relationships.device_groups.data;
            const deviceGroupIds = Array.isArray(dgRel) ? dgRel.map(dg => dg.id) : [];

            console.log(`[fetchGroupDevices] group ${group.id}: ${deviceIds.length} direct devices, ${deviceGroupIds.length} device groups`);

            // Get devices from device_groups too
            let allDeviceIds = [...deviceIds];
            for (const dgId of deviceGroupIds) {
                try {
                    const dgResp = await apiRequest(`/device_groups/${dgId}`);
                    const dgDevs = dgResp?.data?.relationships?.devices?.data || [];
                    const dgDevIds = dgDevs.map(d => d.id);
                    console.log(`[fetchGroupDevices] device_group ${dgId}: ${dgDevIds.length} devices`);
                    allDeviceIds = allDeviceIds.concat(dgDevIds);
                } catch (_) { /* skip unavailable device groups */ }
            }

            // Deduplicate
            allDeviceIds = [...new Set(allDeviceIds)];

            if (allDeviceIds.length === 0) {
                state.devices = [];
                state.filteredDevices = [];
                updateDevicesStats();
                showDevicesState('empty');
                return;
            }

            console.log(`[fetchGroupDevices] fetching ${allDeviceIds.length} unique device IDs`);

            // Fetch each device's details in parallel (batched 10 at a time)
            let allDevices = [];
            const BATCH = 10;
            for (let i = 0; i < allDeviceIds.length; i += BATCH) {
                const batch = allDeviceIds.slice(i, i + BATCH);
                const results = await Promise.all(
                    batch.map(id =>
                        apiRequest(`/devices/${id}`)
                            .then(resp => {
                                const device = resp.data || resp;
                                console.log(`[fetchGroupDevices] device ${id}: ${device?.attributes?.name || device?.name || 'no-name'} (${device?.attributes?.status || 'unknown'})`);
                                return device;
                            })
                            .catch(err => {
                                console.warn(`[fetchGroupDevices] device ${id} failed: ${err.message}`);
                                return null;
                            })
                    )
                );
                allDevices = allDevices.concat(results.filter(Boolean));
            }

            console.log(`[fetchGroupDevices] loaded ${allDevices.length} devices successfully`);

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

        // Tab switching
        dom.tabGroups.addEventListener('click', () => switchTab('groups'));
        dom.tabProvisioning.addEventListener('click', () => switchTab('provisioning'));

        // Refresh — context-aware
        dom.refreshBtn.addEventListener('click', () => {
            if (state.activeTab === 'provisioning') {
                fetchProvQueue();
                showToast('Refreshing queue…', 'info');
            } else if (state.currentView === 'groups') {
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

        // Provisioning buttons
        dom.provisionNewBtn.addEventListener('click', openProvisionModal);
        dom.provModalClose.addEventListener('click', closeProvisionModal);
        dom.provCancelBtn.addEventListener('click', closeProvisionModal);
        dom.provModalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.provModalOverlay) closeProvisionModal();
        });
        dom.provForm.addEventListener('submit', handleProvisionSubmit);
        initAppPicker();
        dom.provRetryBtn.addEventListener('click', fetchProvQueue);

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!dom.confirmOverlay.classList.contains('hidden')) {
                    dom.confirmCancel.click();
                } else if (!dom.provModalOverlay.classList.contains('hidden')) {
                    closeProvisionModal();
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
        initGroupTabs();

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

    // ================================================
    //  TAB SWITCHING
    // ================================================

    function switchTab(tab) {
        state.activeTab = tab;

        // Update tab buttons
        dom.tabGroups.classList.toggle('active', tab === 'groups');
        dom.tabProvisioning.classList.toggle('active', tab === 'provisioning');

        if (tab === 'provisioning') {
            // Hide groups-related UI
            dom.groupsView.classList.add('hidden');
            dom.devicesView.classList.add('hidden');
            dom.breadcrumbBar.classList.add('hidden');
            dom.provisioningView.classList.remove('hidden');

            // Hide stats row, search/toolbar for provisioning
            $('#stats-row').classList.add('hidden');
            $('.toolbar').classList.add('hidden');

            fetchProvQueue();
        } else {
            // Show groups UI
            dom.provisioningView.classList.add('hidden');
            $('#stats-row').classList.remove('hidden');
            $('.toolbar').classList.remove('hidden');

            stopProvAutoRefresh();

            // Restore whatever groups view was active
            if (state.currentView === 'devices' && state.currentGroup) {
                dom.devicesView.classList.remove('hidden');
                dom.breadcrumbBar.classList.remove('hidden');
            } else {
                resetStatFontSize();
                navigateToGroups();
            }
        }
    }

    // ================================================
    //  PROVISIONING QUEUE
    // ================================================

    function showProvState(stateName) {
        dom.provLoading.classList.add('hidden');
        dom.provEmpty.classList.add('hidden');
        dom.provError.classList.add('hidden');
        dom.provTable.classList.add('hidden');

        switch (stateName) {
            case 'loading':
                dom.provLoading.classList.remove('hidden');
                break;
            case 'empty':
                dom.provEmpty.classList.remove('hidden');
                break;
            case 'error':
                dom.provError.classList.remove('hidden');
                break;
            case 'table':
                dom.provTable.classList.remove('hidden');
                break;
        }
    }

    async function fetchProvQueue() {
        showProvState('loading');

        try {
            const response = await fetch('/api/automation/queue');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            const runs = result.data || [];

            state.provQueue = runs;
            renderProvQueue();

            // Auto-refresh if any run is 'running'
            const hasRunning = runs.some(r => r.status === 'running');
            if (hasRunning) {
                startProvAutoRefresh();
            } else {
                stopProvAutoRefresh();
            }
        } catch (err) {
            dom.provErrorMessage.textContent = err.message || 'An unknown error occurred.';
            showProvState('error');
            stopProvAutoRefresh();
        }
    }

    function startProvAutoRefresh() {
        stopProvAutoRefresh();
        state.provAutoRefreshTimer = setInterval(() => {
            if (state.activeTab === 'provisioning') {
                fetchProvQueue();
            }
        }, 5000);
    }

    function stopProvAutoRefresh() {
        if (state.provAutoRefreshTimer) {
            clearInterval(state.provAutoRefreshTimer);
            state.provAutoRefreshTimer = null;
        }
    }

    function getStatusBadge(status) {
        const map = {
            success: { icon: '✅', cls: 'prov-status-success', label: 'Success' },
            partial: { icon: '⚠️', cls: 'prov-status-partial', label: 'Partial' },
            failed:  { icon: '❌', cls: 'prov-status-failed', label: 'Failed' },
            running: { icon: '🔄', cls: 'prov-status-running', label: 'Running' },
        };
        const info = map[status] || map.running;
        return `<span class="prov-status ${info.cls}"><span>${info.icon}</span> ${info.label}</span>`;
    }

    function renderProvQueue() {
        const runs = state.provQueue;

        if (runs.length === 0) {
            showProvState('empty');
            return;
        }

        dom.provTbody.innerHTML = '';

        runs.forEach((run) => {
            const appsCount = (run.appsMatched ? run.appsMatched.length : 0);
            const failedCount = (run.appsFailed ? run.appsFailed.length : 0);
            const appsLabel = `${appsCount} matched` + (failedCount > 0 ? `, ${failedCount} failed` : '');

            const tr = document.createElement('tr');
            tr.className = 'prov-row';
            tr.innerHTML = `
                <td>${getStatusBadge(run.status)}</td>
                <td><strong>${escapeHtml(run.eventName || '—')}</strong></td>
                <td>${escapeHtml(run.orderNumber || '—')}</td>
                <td>${escapeHtml(run.configMode || '—')}</td>
                <td>${appsLabel}</td>
                <td>${formatDate(run.timestamp)}</td>
                <td><button class="prov-delete-btn" title="Delete run" aria-label="Delete run">🗑</button></td>
            `;

            // Click row to expand/collapse detail
            tr.addEventListener('click', (e) => {
                if (e.target.closest('.prov-delete-btn')) return;
                toggleProvDetail(run, tr);
            });

            // Delete button
            tr.querySelector('.prov-delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                deleteProvRun(run);
            });

            dom.provTbody.appendChild(tr);

            // If this run is expanded, render its detail row
            if (state.provExpandedId === run.id) {
                const detailTr = createProvDetailRow(run);
                dom.provTbody.appendChild(detailTr);
            }
        });

        showProvState('table');
    }

    function toggleProvDetail(run, rowEl) {
        if (state.provExpandedId === run.id) {
            state.provExpandedId = null;
        } else {
            state.provExpandedId = run.id;
        }
        renderProvQueue();
    }

    function createProvDetailRow(run) {
        const tr = document.createElement('tr');
        tr.className = 'prov-detail-row';

        // Apps matched
        let appsMatchedHtml = '';
        if (run.appsMatched && run.appsMatched.length > 0) {
            appsMatchedHtml = '<ul class="prov-detail-list">' +
                run.appsMatched.map(a => {
                    const meta = a.id ? ` <span class="prov-meta">#${a.id}</span>` : '';
                    return `<li><span class="prov-icon">✓</span> ${escapeHtml(a.matched || a.requested)}${meta}</li>`;
                }).join('') +
                '</ul>';
        } else {
            appsMatchedHtml = '<span class="prov-no-data">None</span>';
        }

        // Apps failed
        let appsFailedHtml = '';
        if (run.appsFailed && run.appsFailed.length > 0) {
            appsFailedHtml = '<ul class="prov-detail-list">' +
                run.appsFailed.map(a => `<li><span class="prov-icon">✗</span> ${escapeHtml(a)}</li>`).join('') +
                '</ul>';
        } else {
            appsFailedHtml = '<span class="prov-no-data">None</span>';
        }

        // Profiles assigned
        let profilesHtml = '';
        if (run.profilesAssigned && run.profilesAssigned.length > 0) {
            profilesHtml = '<ul class="prov-detail-list">' +
                run.profilesAssigned.map(p => {
                    const meta = p.reason ? ` <span class="prov-meta">${escapeHtml(p.reason)}</span>` : '';
                    return `<li><span class="prov-icon">🛡</span> ${escapeHtml(p.name)}${meta}</li>`;
                }).join('') +
                '</ul>';
        } else {
            profilesHtml = '<span class="prov-no-data">None</span>';
        }

        // Layout matched
        let layoutHtml = '';
        if (run.layoutMatched) {
            layoutHtml = `<span class="prov-layout-badge">📐 ${escapeHtml(run.layoutMatched.name)}</span>`;
        } else {
            layoutHtml = '<span class="prov-no-data">None</span>';
        }

        // Manual setup needed
        let manualHtml = '';
        if (run.manualSetupNeeded && run.manualSetupNeeded.length > 0) {
            manualHtml = '<ul class="prov-detail-list">' +
                run.manualSetupNeeded.map(item =>
                    `<li><span class="prov-icon">⚠</span> ${escapeHtml(item)}</li>`
                ).join('') +
                '</ul>';
        } else {
            manualHtml = '<span class="prov-no-data">None — fully automated</span>';
        }

        tr.innerHTML = `
            <td colspan="7">
                <div class="prov-detail-content">
                    <div class="prov-detail-grid">
                        <div class="prov-detail-section">
                            <h5>Apps Matched</h5>
                            ${appsMatchedHtml}
                        </div>
                        <div class="prov-detail-section">
                            <h5>Apps Failed</h5>
                            ${appsFailedHtml}
                        </div>
                        <div class="prov-detail-section">
                            <h5>Profiles Assigned</h5>
                            ${profilesHtml}
                        </div>
                        <div class="prov-detail-section">
                            <h5>Layout Matched</h5>
                            ${layoutHtml}
                        </div>
                    </div>
                    ${run.manualSetupNeeded && run.manualSetupNeeded.length > 0 ? `
                    <div class="prov-manual-section">
                        <h5>⚙ Manual Setup Required</h5>
                        ${manualHtml}
                    </div>` : ''}
                </div>
            </td>
        `;
        return tr;
    }

    async function deleteProvRun(run) {
        const confirmed = await showConfirm(
            'Delete Run?',
            `Remove the provisioning run for "${run.eventName || 'Unknown'}" from history?`,
            '🗑'
        );
        if (!confirmed) return;

        try {
            const res = await fetch(`/api/automation/queue/${run.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            showToast('Run deleted from history.', 'success');
            state.provQueue = state.provQueue.filter(r => r.id !== run.id);
            if (state.provExpandedId === run.id) state.provExpandedId = null;
            renderProvQueue();
        } catch (err) {
            showToast(`Failed to delete run: ${err.message}`, 'error');
        }
    }

    // ================================================
    //  PROVISION MODAL + APP CATALOG PICKER
    // ================================================

    async function loadAppCatalog() {
        if (state.appCatalogLoaded) return;
        try {
            const apiKey = loadCredentials();
            const res = await fetch('/api/automation/apps', {
                headers: { 'x-simplemdm-key': apiKey || state.apiKey },
            });
            if (res.ok) {
                const body = await res.json();
                state.appCatalog = (body.data || []).sort((a, b) => a.name.localeCompare(b.name));
                state.appCatalogLoaded = true;
            }
        } catch (e) {
            console.warn('Failed to load app catalog:', e);
        }
    }

    function renderSelectedApps() {
        dom.provSelectedApps.innerHTML = '';
        state.selectedAppIds.forEach(app => {
            const pill = document.createElement('span');
            pill.className = 'app-pill';
            pill.innerHTML = `${escapeHtml(app.name)} <button type="button" class="app-pill-remove" data-id="${app.id}">&times;</button>`;
            pill.querySelector('.app-pill-remove').addEventListener('click', () => {
                state.selectedAppIds = state.selectedAppIds.filter(a => a.id !== app.id);
                renderSelectedApps();
                filterAppDropdown(dom.provAppSearch.value);
            });
            dom.provSelectedApps.appendChild(pill);
        });
    }

    function filterAppDropdown(query) {
        const q = query.toLowerCase().trim();
        const selectedIds = new Set(state.selectedAppIds.map(a => a.id));
        const filtered = state.appCatalog.filter(a =>
            !selectedIds.has(a.id) && (q.length === 0 || a.name.toLowerCase().includes(q))
        ).slice(0, 30); // Cap at 30 results

        dom.provAppDropdown.innerHTML = '';
        if (q.length === 0 && filtered.length === state.appCatalog.length - selectedIds.size) {
            // Don't show dropdown if no query typed
            dom.provAppDropdown.classList.add('hidden');
            return;
        }

        if (filtered.length === 0) {
            dom.provAppDropdown.innerHTML = '<div class="app-dropdown-empty">No matching apps found</div>';
        } else {
            filtered.forEach(app => {
                const item = document.createElement('div');
                item.className = 'app-dropdown-item';
                item.textContent = app.name;
                item.addEventListener('click', () => {
                    state.selectedAppIds.push({ id: app.id, name: app.name });
                    renderSelectedApps();
                    dom.provAppSearch.value = '';
                    dom.provAppDropdown.classList.add('hidden');
                    dom.provAppSearch.focus();
                });
                dom.provAppDropdown.appendChild(item);
            });
        }
        dom.provAppDropdown.classList.remove('hidden');
    }

    function initAppPicker() {
        dom.provAppSearch.addEventListener('input', () => {
            filterAppDropdown(dom.provAppSearch.value);
        });
        dom.provAppSearch.addEventListener('focus', () => {
            if (dom.provAppSearch.value.trim().length > 0) {
                filterAppDropdown(dom.provAppSearch.value);
            }
        });
        // Close dropdown on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.prov-app-picker')) {
                dom.provAppDropdown.classList.add('hidden');
            }
        });
    }

    async function openProvisionModal() {
        dom.provForm.reset();
        state.selectedAppIds = [];
        renderSelectedApps();
        dom.provAppDropdown.classList.add('hidden');
        dom.provModalOverlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        dom.provEventName.focus();
        // Load catalog in background
        await loadAppCatalog();
    }

    function closeProvisionModal() {
        dom.provModalOverlay.classList.add('hidden');
        document.body.style.overflow = '';
    }

    async function handleProvisionSubmit(e) {
        e.preventDefault();

        const eventName = dom.provEventName.value.trim();
        if (!eventName) {
            showToast('Event Name is required.', 'warning');
            return;
        }

        const orderNumber = dom.provOrderNumber.value.trim();
        const configMode = dom.provConfigMode.value;
        const app_ids = state.selectedAppIds.map(a => a.id);
        const apps = state.selectedAppIds.map(a => a.name);

        const submitBtn = dom.provSubmitBtn;
        const btnText = submitBtn.querySelector('.btn-text');
        const btnSpinner = submitBtn.querySelector('.btn-spinner');

        btnText.textContent = 'Provisioning…';
        btnSpinner.classList.remove('hidden');
        submitBtn.disabled = true;

        try {
            const apiKey = loadCredentials();
            const res = await fetch('/api/automation/provision', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-simplemdm-key': apiKey || state.apiKey,
                },
                body: JSON.stringify({ eventName, orderNumber, configMode, apps, app_ids }),
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(body || `HTTP ${res.status}`);
            }

            showToast(`Provisioning started for "${eventName}"`, 'success');
            closeProvisionModal();
            fetchProvQueue();
        } catch (err) {
            showToast(`Provisioning failed: ${err.message}`, 'error');
        } finally {
            btnText.textContent = 'Start Provisioning';
            btnSpinner.classList.add('hidden');
            submitBtn.disabled = false;
        }
    }

    // ================================================
    //  GROUP DETAIL TABS
    // ================================================

    function initGroupTabs() {
        if (!dom.groupTabs) return;
        dom.groupTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.group-tab');
            if (!btn) return;
            const tab = btn.dataset.gtab;
            switchGroupTab(tab);
        });

        // Profile tab buttons
        if (dom.addProfileBtn) dom.addProfileBtn.addEventListener('click', openProfilePicker);
        if (dom.profilePickerClose) dom.profilePickerClose.addEventListener('click', closeProfilePicker);
        if (dom.profilePickerSearch) dom.profilePickerSearch.addEventListener('input', filterProfilePicker);

        // App tab buttons
        if (dom.addAppBtn) dom.addAppBtn.addEventListener('click', openAppPicker);
        if (dom.appPickerClose) dom.appPickerClose.addEventListener('click', closeAppPicker);
        if (dom.appPickerSearch) dom.appPickerSearch.addEventListener('input', filterAppPicker);

        // Wallpaper creator
        if (dom.createWallpaperBtn) dom.createWallpaperBtn.addEventListener('click', openWallpaperModal);

        // Serial assignment
        if (dom.addBySerialBtn) dom.addBySerialBtn.addEventListener('click', openSerialModal);
        if (dom.depSyncBtn) dom.depSyncBtn.addEventListener('click', triggerDepSync);
    }

    function switchGroupTab(tab) {
        state.activeGroupTab = tab;

        // Update tab buttons
        dom.groupTabs.querySelectorAll('.group-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.gtab === tab);
        });

        // Show/hide content
        dom.gtabDevices.classList.toggle('hidden', tab !== 'devices');
        dom.gtabProfiles.classList.toggle('hidden', tab !== 'profiles');
        dom.gtabApps.classList.toggle('hidden', tab !== 'apps');

        // Fetch data when switching to a tab
        if (tab === 'profiles' && state.groupProfiles.length === 0) {
            fetchGroupProfiles();
        }
        if (tab === 'apps' && state.groupApps.length === 0) {
            fetchGroupApps();
        }
    }

    // ================================================
    //  PROFILES TAB
    // ================================================

    async function fetchGroupProfiles() {
        if (!state.currentGroup) return;
        const groupId = state.currentGroup.id;

        dom.profilesLoading.classList.remove('hidden');
        dom.profilesEmpty.classList.add('hidden');
        dom.profilesGrid.classList.add('hidden');

        try {
            const resp = await apiRequest(`/assignment_groups/${groupId}/profiles`);
            const profiles = resp.data || [];
            state.groupProfiles = profiles;
            renderGroupProfiles();
        } catch (err) {
            showToast('Failed to load profiles: ' + err.message, 'error');
        } finally {
            dom.profilesLoading.classList.add('hidden');
        }
    }

    function renderGroupProfiles() {
        const profiles = state.groupProfiles;
        if (profiles.length === 0) {
            dom.profilesEmpty.classList.remove('hidden');
            dom.profilesGrid.classList.add('hidden');
            return;
        }

        dom.profilesEmpty.classList.add('hidden');
        dom.profilesGrid.classList.remove('hidden');

        const profileTypeIcons = {
            'custom_configuration_profile': '⚙️',
            'restrictions': '🔒',
            'wifi': '📶',
            'home_screen_layout': '📱',
            'passcode': '🔑',
        };

        dom.profilesGrid.innerHTML = profiles.map(p => {
            const name = (p.attributes && p.attributes.name) || p.name || 'Unnamed';
            const type = p.type || 'profile';
            const icon = profileTypeIcons[type] || '🛡';
            const typeLabel = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

            return `<div class="profile-card" data-profile-id="${p.id}">
                <div class="card-icon profile-icon">${icon}</div>
                <div class="card-info">
                    <h5 title="${escapeHtml(name)}">${escapeHtml(name)}</h5>
                    <span class="card-meta">${escapeHtml(typeLabel)} • ID: ${p.id}</span>
                </div>
                <button class="card-remove" title="Remove from group" data-profile-id="${p.id}" data-profile-name="${escapeHtml(name)}">&times;</button>
            </div>`;
        }).join('');

        // Remove buttons
        dom.profilesGrid.querySelectorAll('.card-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.profileId;
                const name = btn.dataset.profileName;
                confirmAction('Remove Profile', `Remove "${name}" from this group?`, '🛡', async () => {
                    try {
                        await apiRequest(`/assignment_groups/${state.currentGroup.id}/profiles/${id}`, { method: 'DELETE' });
                        showToast(`Removed "${name}"`, 'success');
                        state.groupProfiles = state.groupProfiles.filter(p => String(p.id) !== String(id));
                        renderGroupProfiles();
                    } catch (err) {
                        showToast('Failed to remove profile: ' + err.message, 'error');
                    }
                });
            });
        });
    }

    async function openProfilePicker() {
        dom.profilePicker.classList.remove('hidden');
        dom.profilePickerSearch.value = '';
        dom.profilePickerSearch.focus();

        // Fetch all profiles if we haven't yet
        if (state.allProfiles.length === 0) {
            dom.profilePickerList.innerHTML = '<div class="picker-empty">Loading profiles…</div>';
            try {
                const resp = await apiRequest('/profiles?limit=100');
                state.allProfiles = resp.data || [];
            } catch (err) {
                dom.profilePickerList.innerHTML = '<div class="picker-empty">Failed to load</div>';
                return;
            }
        }
        renderProfilePickerList('');
    }

    function closeProfilePicker() {
        dom.profilePicker.classList.add('hidden');
    }

    function filterProfilePicker() {
        renderProfilePickerList(dom.profilePickerSearch.value);
    }

    function renderProfilePickerList(query) {
        const q = query.toLowerCase();
        const assignedIds = new Set(state.groupProfiles.map(p => String(p.id)));
        const filtered = state.allProfiles.filter(p => {
            const name = (p.attributes && p.attributes.name) || p.name || '';
            return name.toLowerCase().includes(q);
        });

        if (filtered.length === 0) {
            dom.profilePickerList.innerHTML = '<div class="picker-empty">No profiles found</div>';
            return;
        }

        dom.profilePickerList.innerHTML = filtered.map(p => {
            const name = (p.attributes && p.attributes.name) || p.name || 'Unnamed';
            const type = (p.type || 'profile').replace(/_/g, ' ');
            const assigned = assignedIds.has(String(p.id));

            return `<button class="picker-item${assigned ? ' already-assigned' : ''}" data-id="${p.id}" data-name="${escapeHtml(name)}">
                <div class="picker-item-icon profile">🛡</div>
                <div class="picker-item-info">
                    <div class="picker-item-name">${escapeHtml(name)}</div>
                    <div class="picker-item-meta">${escapeHtml(type)} • ID: ${p.id}</div>
                </div>
                ${assigned ? '<span class="picker-item-badge">Assigned</span>' : ''}
            </button>`;
        }).join('');

        dom.profilePickerList.querySelectorAll('.picker-item:not(.already-assigned)').forEach(item => {
            item.addEventListener('click', async () => {
                const id = item.dataset.id;
                const name = item.dataset.name;
                try {
                    await apiRequest(`/assignment_groups/${state.currentGroup.id}/profiles/${id}`, { method: 'POST' });
                    showToast(`Added "${name}"`, 'success');
                    closeProfilePicker();
                    state.groupProfiles = []; // force refetch
                    fetchGroupProfiles();
                } catch (err) {
                    showToast('Failed to add profile: ' + err.message, 'error');
                }
            });
        });
    }

    // ================================================
    //  APPS TAB
    // ================================================

    async function fetchGroupApps() {
        if (!state.currentGroup) return;
        const groupId = state.currentGroup.id;

        dom.appsLoading.classList.remove('hidden');
        dom.appsEmpty.classList.add('hidden');
        dom.appsGrid.classList.add('hidden');

        try {
            const resp = await apiRequest(`/assignment_groups/${groupId}/apps`);
            const apps = resp.data || [];
            state.groupApps = apps;
            renderGroupApps();
        } catch (err) {
            showToast('Failed to load apps: ' + err.message, 'error');
        } finally {
            dom.appsLoading.classList.add('hidden');
        }
    }

    function renderGroupApps() {
        const apps = state.groupApps;
        if (apps.length === 0) {
            dom.appsEmpty.classList.remove('hidden');
            dom.appsGrid.classList.add('hidden');
            return;
        }

        dom.appsEmpty.classList.add('hidden');
        dom.appsGrid.classList.remove('hidden');

        dom.appsGrid.innerHTML = apps.map(a => {
            const name = (a.attributes && a.attributes.name) || a.name || 'Unnamed';
            const bundleId = (a.attributes && a.attributes.bundle_identifier) || '';
            const iconUrl = a.attributes && a.attributes._icon_url;

            const iconHtml = iconUrl
                ? `<img src="${escapeHtml(iconUrl)}" alt="">`
                : '📲';

            return `<div class="app-card" data-app-id="${a.id}">
                <div class="card-icon app-icon">${iconHtml}</div>
                <div class="card-info">
                    <h5 title="${escapeHtml(name)}">${escapeHtml(name)}</h5>
                    <span class="card-meta">${escapeHtml(bundleId || 'App ID: ' + a.id)}</span>
                </div>
                <button class="card-remove" title="Remove from group" data-app-id="${a.id}" data-app-name="${escapeHtml(name)}">&times;</button>
            </div>`;
        }).join('');

        // Remove buttons
        dom.appsGrid.querySelectorAll('.card-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.appId;
                const name = btn.dataset.appName;
                confirmAction('Remove App', `Remove "${name}" from this group?`, '📲', async () => {
                    try {
                        await apiRequest(`/assignment_groups/${state.currentGroup.id}/apps/${id}`, { method: 'DELETE' });
                        showToast(`Removed "${name}"`, 'success');
                        state.groupApps = state.groupApps.filter(a => String(a.id) !== String(id));
                        renderGroupApps();
                    } catch (err) {
                        showToast('Failed to remove app: ' + err.message, 'error');
                    }
                });
            });
        });
    }

    async function openAppPicker() {
        dom.appPicker.classList.remove('hidden');
        dom.appPickerSearch.value = '';
        dom.appPickerSearch.focus();

        // Fetch all apps if we haven't yet
        if (state.allApps.length === 0) {
            dom.appPickerList.innerHTML = '<div class="picker-empty">Loading apps…</div>';
            try {
                const resp = await apiRequest('/apps?limit=100');
                state.allApps = resp.data || [];
            } catch (err) {
                dom.appPickerList.innerHTML = '<div class="picker-empty">Failed to load</div>';
                return;
            }
        }
        renderAppPickerList('');
    }

    function closeAppPicker() {
        dom.appPicker.classList.add('hidden');
    }

    function filterAppPicker() {
        renderAppPickerList(dom.appPickerSearch.value);
    }

    function renderAppPickerList(query) {
        const q = query.toLowerCase();
        const assignedIds = new Set(state.groupApps.map(a => String(a.id)));
        const filtered = state.allApps.filter(a => {
            const name = (a.attributes && a.attributes.name) || a.name || '';
            return name.toLowerCase().includes(q);
        });

        if (filtered.length === 0) {
            dom.appPickerList.innerHTML = '<div class="picker-empty">No apps found</div>';
            return;
        }

        dom.appPickerList.innerHTML = filtered.map(a => {
            const name = (a.attributes && a.attributes.name) || a.name || 'Unnamed';
            const bundleId = (a.attributes && a.attributes.bundle_identifier) || '';
            const assigned = assignedIds.has(String(a.id));
            const iconUrl = a.attributes && a.attributes._icon_url;

            return `<button class="picker-item${assigned ? ' already-assigned' : ''}" data-id="${a.id}" data-name="${escapeHtml(name)}">
                <div class="picker-item-icon app">${iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="">` : '📲'}</div>
                <div class="picker-item-info">
                    <div class="picker-item-name">${escapeHtml(name)}</div>
                    <div class="picker-item-meta">${escapeHtml(bundleId || 'ID: ' + a.id)}</div>
                </div>
                ${assigned ? '<span class="picker-item-badge">Assigned</span>' : ''}
            </button>`;
        }).join('');

        dom.appPickerList.querySelectorAll('.picker-item:not(.already-assigned)').forEach(item => {
            item.addEventListener('click', async () => {
                const id = item.dataset.id;
                const name = item.dataset.name;
                try {
                    await apiRequest(`/assignment_groups/${state.currentGroup.id}/apps/${id}`, { method: 'POST' });
                    showToast(`Added "${name}"`, 'success');
                    closeAppPicker();
                    state.groupApps = []; // force refetch
                    fetchGroupApps();
                } catch (err) {
                    showToast('Failed to add app: ' + err.message, 'error');
                }
            });
        });
    }

    // ================================================
    //  WALLPAPER CREATOR
    // ================================================

    function openWallpaperModal() {
        state.wpImageBase64 = null;

        // Reset form
        if (dom.wpProfileName) {
            const groupName = state.currentGroup ? getGroupName(state.currentGroup) : '';
            dom.wpProfileName.value = groupName ? `${groupName} — Wallpaper` : '';
        }
        if (dom.wpScreen) dom.wpScreen.value = 'both';
        if (dom.wpPreview) {
            dom.wpPreview.classList.add('hidden');
            dom.wpPreview.src = '';
        }
        if (dom.wpDropzoneContent) dom.wpDropzoneContent.classList.remove('hidden');
        if (dom.wpSubmit) dom.wpSubmit.disabled = true;
        if (dom.wpFileInput) dom.wpFileInput.value = '';

        dom.wpModalOverlay.classList.remove('hidden');

        // Wire up events (idempotent via cloneNode or check)
        initWallpaperEvents();
    }

    let wpEventsInit = false;
    function initWallpaperEvents() {
        if (wpEventsInit) return;
        wpEventsInit = true;

        // Close
        dom.wpModalClose.addEventListener('click', closeWallpaperModal);
        dom.wpCancel.addEventListener('click', closeWallpaperModal);
        dom.wpModalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.wpModalOverlay) closeWallpaperModal();
        });

        // Click to browse
        dom.wpDropzone.addEventListener('click', () => dom.wpFileInput.click());

        // File input change
        dom.wpFileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) handleWallpaperFile(e.target.files[0]);
        });

        // Drag & drop
        dom.wpDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dom.wpDropzone.classList.add('dragover');
        });
        dom.wpDropzone.addEventListener('dragleave', () => {
            dom.wpDropzone.classList.remove('dragover');
        });
        dom.wpDropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dom.wpDropzone.classList.remove('dragover');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleWallpaperFile(e.dataTransfer.files[0]);
            }
        });

        // Submit
        dom.wpSubmit.addEventListener('click', submitWallpaper);
    }

    function handleWallpaperFile(file) {
        if (!file.type.startsWith('image/')) {
            showToast('Please select an image file', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            // Show preview
            dom.wpPreview.src = e.target.result;
            dom.wpPreview.classList.remove('hidden');
            dom.wpDropzoneContent.classList.add('hidden');

            // Store Base64 (strip data:image/...;base64, prefix)
            state.wpImageBase64 = e.target.result.split(',')[1];
            dom.wpSubmit.disabled = false;
        };
        reader.readAsDataURL(file);
    }

    function closeWallpaperModal() {
        dom.wpModalOverlay.classList.add('hidden');
    }

    async function submitWallpaper() {
        if (!state.wpImageBase64) return;

        const name = dom.wpProfileName.value.trim() || 'Custom Wallpaper';
        const where = dom.wpScreen.value;
        const groupId = state.currentGroup ? state.currentGroup.id : null;

        const btnText = dom.wpSubmit.querySelector('.btn-text');
        const btnSpinner = dom.wpSubmit.querySelector('.btn-spinner');
        btnText.textContent = 'Creating…';
        btnSpinner.classList.remove('hidden');
        dom.wpSubmit.disabled = true;

        try {
            const resp = await fetch('/api/automation/wallpaper', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${btoa(state.apiKey + ':')}`,
                    'X-SimpleMDM-Key': state.apiKey,
                },
                body: JSON.stringify({
                    imageBase64: state.wpImageBase64,
                    where: where,
                    profileName: name,
                    groupId: groupId,
                }),
            });

            const data = await resp.json();

            if (!resp.ok) throw new Error(data.error || 'Failed to create profile');

            showToast(`Created wallpaper profile "${name}"`, 'success');
            closeWallpaperModal();

            // Refresh profiles tab
            state.groupProfiles = [];
            if (state.activeGroupTab === 'profiles') {
                fetchGroupProfiles();
            }
        } catch (err) {
            showToast('Wallpaper creation failed: ' + err.message, 'error');
        } finally {
            btnText.textContent = 'Create Profile';
            btnSpinner.classList.add('hidden');
            dom.wpSubmit.disabled = !state.wpImageBase64;
        }
    }

    // ================================================
    //  SERIAL NUMBER ASSIGNMENT
    // ================================================

    function parseSerials(text) {
        // Split by newlines, commas, spaces, tabs — filter to non-empty
        return [...new Set(
            text.split(/[\n,\s\t]+/)
                .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
                .filter(s => s.length >= 8) // Apple serials are 10-12 chars
        )];
    }

    let serialEventsInit = false;
    function openSerialModal() {
        // Reset to input phase
        dom.serialInputPhase.classList.remove('hidden');
        dom.serialProgressPhase.classList.add('hidden');
        dom.serialResultsPhase.classList.add('hidden');
        dom.serialTextarea.value = '';
        dom.serialCount.textContent = '0 serial numbers detected';
        dom.serialSubmit.disabled = true;
        dom.serialModalOverlay.classList.remove('hidden');
        dom.serialTextarea.focus();

        if (!serialEventsInit) {
            serialEventsInit = true;

            // Close
            dom.serialModalClose.addEventListener('click', closeSerialModal);
            dom.serialCancel.addEventListener('click', closeSerialModal);
            dom.serialModalOverlay.addEventListener('click', (e) => {
                if (e.target === dom.serialModalOverlay) closeSerialModal();
            });
            dom.serialDone.addEventListener('click', () => {
                closeSerialModal();
                // Refresh device list
                if (state.currentGroup) fetchGroupDevices(state.currentGroup);
            });

            // Textarea parsing
            dom.serialTextarea.addEventListener('input', () => {
                const serials = parseSerials(dom.serialTextarea.value);
                dom.serialCount.textContent = `${serials.length} serial number${serials.length !== 1 ? 's' : ''} detected`;
                dom.serialSubmit.disabled = serials.length === 0;
            });

            // Submit
            dom.serialSubmit.addEventListener('click', submitSerials);
        }
    }

    function closeSerialModal() {
        dom.serialModalOverlay.classList.add('hidden');
    }

    async function submitSerials() {
        const serials = parseSerials(dom.serialTextarea.value);
        if (serials.length === 0) return;
        if (!state.currentGroup) return;

        const groupId = state.currentGroup.id;
        const autoSync = dom.serialAutoSync.checked;

        // Switch to progress phase
        dom.serialInputPhase.classList.add('hidden');
        dom.serialProgressPhase.classList.remove('hidden');
        dom.serialProgressText.textContent = `Processing ${serials.length} serial${serials.length !== 1 ? 's' : ''}…`;
        dom.serialProgressFill.style.width = '10%';

        try {
            const resp = await fetch(`/api/simplemdm/groups/${groupId}/assign-serials`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${btoa(state.apiKey + ':')}`,
                },
                body: JSON.stringify({ serials, autoSync }),
            });

            dom.serialProgressFill.style.width = '90%';

            const results = await resp.json();

            if (!resp.ok) throw new Error(results.error || 'Assignment failed');

            dom.serialProgressFill.style.width = '100%';

            // Brief pause then show results
            setTimeout(() => renderSerialResults(results), 300);
        } catch (err) {
            showToast('Serial assignment failed: ' + err.message, 'error');
            // Go back to input phase
            dom.serialProgressPhase.classList.add('hidden');
            dom.serialInputPhase.classList.remove('hidden');
        }
    }

    function renderSerialResults(results) {
        dom.serialProgressPhase.classList.add('hidden');
        dom.serialResultsPhase.classList.remove('hidden');

        const assigned = results.assigned || [];
        const notFound = results.notFound || [];
        const errors = results.errors || [];

        // Summary
        let summaryHtml = '<div class="serial-results-summary">';
        if (assigned.length > 0) summaryHtml += `<div class="serial-summary-stat success">✅ ${assigned.length} assigned</div>`;
        if (notFound.length > 0) summaryHtml += `<div class="serial-summary-stat warning">⚠️ ${notFound.length} not found</div>`;
        if (errors.length > 0) summaryHtml += `<div class="serial-summary-stat error">❌ ${errors.length} error${errors.length !== 1 ? 's' : ''}</div>`;
        if (results.syncTriggered) summaryHtml += `<div class="serial-summary-stat" style="color:var(--blue)">🔄 ABM sync triggered</div>`;
        summaryHtml += '</div>';
        dom.serialResultsSummary.innerHTML = summaryHtml;

        // Result items
        let listHtml = '';
        for (const item of assigned) {
            const sourceLabel = {
                enrolled: 'Device assigned to group',
                dep_enrolled: 'DEP device assigned to group',
                abm_assigned: '🔵 Assigned to MDM via ABM — will enroll on next power-on',
            }[item.source] || item.source;
            listHtml += `<div class="serial-result-item success">
                <span class="serial-result-icon">✅</span>
                <span class="serial-result-sn">${escapeHtml(item.serial)}</span>
                <span class="serial-result-info">${escapeHtml(item.name || '')} — ${sourceLabel}</span>
            </div>`;
        }
        for (const item of notFound) {
            listHtml += `<div class="serial-result-item warning">
                <span class="serial-result-icon">⚠️</span>
                <span class="serial-result-sn">${escapeHtml(item.serial)}</span>
                <span class="serial-result-info">${escapeHtml(item.reason)}</span>
            </div>`;
        }
        for (const item of errors) {
            listHtml += `<div class="serial-result-item error">
                <span class="serial-result-icon">❌</span>
                <span class="serial-result-sn">${escapeHtml(item.serial)}</span>
                <span class="serial-result-info">${escapeHtml(item.error)}</span>
            </div>`;
        }
        dom.serialResultsList.innerHTML = listHtml;

        // Toast
        if (assigned.length > 0) {
            showToast(`${assigned.length} device${assigned.length !== 1 ? 's' : ''} assigned to group`, 'success');
        }
    }

    async function triggerDepSync() {
        dom.depSyncBtn.disabled = true;
        dom.depSyncBtn.textContent = '🔄 Syncing…';

        try {
            const resp = await fetch('/api/simplemdm/dep/sync', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${btoa(state.apiKey + ':')}`,
                },
            });

            if (resp.ok || resp.status === 202) {
                showToast('ABM sync triggered — new devices will appear shortly', 'success');
            } else {
                showToast('ABM sync failed', 'error');
            }
        } catch (err) {
            showToast('ABM sync error: ' + err.message, 'error');
        } finally {
            dom.depSyncBtn.disabled = false;
            dom.depSyncBtn.textContent = '🔄 Sync ABM';
        }
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
