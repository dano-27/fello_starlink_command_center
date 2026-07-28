// app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- State ---
    let devices = [];
    let currentPage = 1;
    let currentFilters = { search: '', status: '', branch: '', type: '' };
    const pageSize = 100;
    
    // Maps & Charts
    let mainMap = null;
    let detailMap = null;
    let mainUsageChart = null;
    let countryUsageChart = null;
    let detailUsageChart = null;
    let activeDeviceId = null;

    // --- DOM Elements ---
    const tabs = {
        inventory: document.getElementById('tab-inventory'),
        usage: document.getElementById('tab-usage'),
        map: document.getElementById('tab-map')
    };
    const views = {
        inventory: document.getElementById('view-inventory'),
        usage: document.getElementById('view-usage'),
        map: document.getElementById('view-map')
    };
    
    // --- Initialization ---
    initNavigation();
    initFilters();
    loadDashboardData();

    // --- Navigation & Tabs ---
    function initNavigation() {
        // Main tabs
        Object.keys(tabs).forEach(key => {
            tabs[key].addEventListener('click', () => {
                // Update active tab styling
                Object.values(tabs).forEach(t => t.classList.remove('active'));
                tabs[key].classList.add('active');
                
                // Update views
                Object.values(views).forEach(v => v.classList.add('hidden'));
                views[key].classList.remove('hidden');
                
                // Trigger specific tab logic
                if (key === 'map') {
                    setTimeout(initMainMap, 100); // Allow render before Leaflet init
                } else if (key === 'usage') {
                    loadUsageData();
                }
            });
        });

        // Modal tabs
        const modalTabs = document.querySelectorAll('.modal-tab');
        const modalContents = document.querySelectorAll('.mtab-content');
        modalTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.mtab;
                modalTabs.forEach(t => t.classList.remove('active'));
                modalContents.forEach(c => c.classList.remove('active'));
                
                tab.classList.add('active');
                document.getElementById(`mtab-${target}`).classList.add('active');

                if (target === 'location') {
                    setTimeout(() => initDetailMap(activeDeviceId), 100);
                } else if (target === 'usage') {
                    loadDeviceUsage(activeDeviceId);
                } else if (target === 'live') {
                    loadDeviceLive(activeDeviceId);
                }
            });
        });

        // Modals
        document.getElementById('btn-modal-close').addEventListener('click', closeDeviceModal);
        
        // Refresh
        document.getElementById('btn-refresh').addEventListener('click', loadDashboardData);
        document.getElementById('btn-refresh-live').addEventListener('click', () => loadDeviceLive(activeDeviceId));
    }

    // --- Data Loading ---
    async function loadDashboardData() {
        showToast('Loading dashboard data...');
        await Promise.all([
            fetchStats(),
            fetchDevices(1),
            loadFilterOptions()
        ]);
    }

    async function fetchStats() {
        try {
            const res = await fetch('/api/webbing/stats');
            if(res.ok) {
                const stats = await res.json();
                document.getElementById('stat-total-devices').textContent = stats.total || 0;
                document.getElementById('stat-active-devices').textContent = stats.active || 0;
                document.getElementById('stat-suspended-devices').textContent = stats.suspended || 0;
                document.getElementById('stat-total-data').textContent = (stats.totalDataGb || 0) + ' GB';
            }
        } catch (e) {
            console.error('Failed to load stats', e);
        }
    }

    async function fetchDevices(page = 1) {
        currentPage = page;
        try {
            const url = new URL(window.location.origin + '/api/webbing/devices');
            url.searchParams.append('page', page);
            url.searchParams.append('pageSize', pageSize);
            if (currentFilters.search) url.searchParams.append('search', currentFilters.search);
            if (currentFilters.status) url.searchParams.append('status', currentFilters.status);
            if (currentFilters.branch) url.searchParams.append('branch', currentFilters.branch);
            
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                devices = data.items || [];
                renderDeviceTable(devices);
                updatePagination(data.total, page);
            }
        } catch (e) {
            console.error('Failed to fetch devices', e);
            renderDeviceTable([]);
        }
    }

    // --- Table & Filters ---
    function renderDeviceTable(data) {
        const tbody = document.getElementById('inventory-tbody');
        tbody.innerHTML = '';
        
        if (data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">No devices found.</td></tr>`;
            return;
        }

        data.forEach(dev => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${dev.ssid || '-'}</strong></td>
                <td>${dev.serial || '-'}</td>
                <td>${dev.imei || '-'}</td>
                <td><span class="badge badge-${dev.status.toLowerCase()}">${dev.status}</span></td>
                <td>${dev.plan || '-'}</td>
                <td>${dev.branch || '-'}</td>
                <td>${new Date(dev.lastUpdated).toLocaleDateString()}</td>
            `;
            tr.addEventListener('click', () => openDeviceModal(dev));
            tbody.appendChild(tr);
        });
    }

    function initFilters() {
        const searchInput = document.getElementById('search-input');
        const statusFilter = document.getElementById('filter-status');
        const branchFilter = document.getElementById('filter-branch');
        
        let timeout = null;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                currentFilters.search = e.target.value;
                fetchDevices(1);
            }, 500);
        });

        statusFilter.addEventListener('change', (e) => {
            currentFilters.status = e.target.value;
            fetchDevices(1);
        });
        
        branchFilter.addEventListener('change', (e) => {
            currentFilters.branch = e.target.value;
            fetchDevices(1);
        });

        // Pagination
        document.getElementById('btn-prev-page').addEventListener('click', () => {
            if (currentPage > 1) fetchDevices(currentPage - 1);
        });
        document.getElementById('btn-next-page').addEventListener('click', () => {
            fetchDevices(currentPage + 1);
        });
    }

    function updatePagination(totalItems, currentPage) {
        const totalPages = Math.ceil(totalItems / pageSize) || 1;
        document.getElementById('page-indicator').textContent = `Page ${currentPage} of ${totalPages}`;
        document.getElementById('btn-prev-page').disabled = currentPage <= 1;
        document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
    }

    async function loadFilterOptions() {
        try {
            // Branches come from the devices endpoint response (cached)
            const res = await fetch('/api/webbing/devices?page=1&pageSize=1');
            if (res.ok) {
                const data = await res.json();
                const branches = data.branches || [];
                const branchSelect = document.getElementById('filter-branch');
                branchSelect.innerHTML = '<option value="">All Branches</option>';
                branches.forEach(b => {
                    const opt = document.createElement('option');
                    opt.value = b.id;
                    opt.textContent = b.name;
                    branchSelect.appendChild(opt);
                });
            }
        } catch (e) {
            console.error('Error loading branches', e);
        }
    }

    // --- Device Modal ---
    function openDeviceModal(device) {
        activeDeviceId = device.id;
        
        // Populate Info
        document.getElementById('modal-title').textContent = device.ssid || 'Unknown Device';
        document.getElementById('modal-status-badge').textContent = device.status;
        document.getElementById('modal-status-badge').className = `badge badge-${device.status.toLowerCase()}`;
        
        document.getElementById('detail-ssid').textContent = device.ssid || '-';
        document.getElementById('detail-imei').textContent = device.imei || '-';
        document.getElementById('detail-serial').textContent = device.serial || '-';
        document.getElementById('detail-plan').textContent = device.plan || '-';
        document.getElementById('detail-branch').textContent = device.branch || '-';
        document.getElementById('detail-apn').textContent = device.apn || '-';
        document.getElementById('detail-ip').textContent = device.ip || '-';
        document.getElementById('detail-msisdn').textContent = device.msisdn || '-';
        document.getElementById('detail-updated').textContent = new Date(device.lastUpdated).toLocaleString() || '-';

        // Set Controls initial state
        document.getElementById('control-current-state').textContent = device.status;
        const suspendBtn = document.getElementById('btn-toggle-suspend');
        if (device.status.toLowerCase() === 'active') {
            suspendBtn.textContent = 'Suspend Device';
            suspendBtn.className = 'btn btn-warning';
            suspendBtn.onclick = () => toggleDeviceStatus(device.id, 'suspend');
        } else {
            suspendBtn.textContent = 'Activate Device';
            suspendBtn.className = 'btn btn-success text-white';
            suspendBtn.style.backgroundColor = 'var(--success)';
            suspendBtn.onclick = () => toggleDeviceStatus(device.id, 'activate');
        }

        // Fetch IMEI lock
        fetch(`/api/webbing/devices/${device.id}/imei-lock`)
            .then(r => r.json())
            .then(data => {
                document.getElementById('control-imei-lock').textContent = data.locked ? 'Locked' : 'Unlocked';
            }).catch(() => document.getElementById('control-imei-lock').textContent = 'Error');

        // SMS handler
        const smsBtn = document.getElementById('btn-send-sms');
        smsBtn.onclick = () => {
            const msg = document.getElementById('sms-message').value;
            if(!msg) return;
            fetch(`/api/webbing/devices/${device.id}/sms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
            }).then(r => {
                if(r.ok) {
                    showToast('SMS Sent successfully');
                    document.getElementById('sms-message').value = '';
                }
            });
        }

        // Show Modal
        document.getElementById('device-modal').classList.remove('hidden');
        
        // Reset tabs to Info
        document.querySelectorAll('.modal-tab')[0].click();
    }

    function closeDeviceModal() {
        document.getElementById('device-modal').classList.add('hidden');
        activeDeviceId = null;
    }

    async function toggleDeviceStatus(id, action) {
        try {
            const res = await fetch(`/api/webbing/devices/${id}/${action}`, { method: 'POST' });
            if (res.ok) {
                showToast(`Device ${action}d successfully.`);
                fetchDevices(currentPage);
                closeDeviceModal();
            } else {
                showToast(`Failed to ${action} device.`, true);
            }
        } catch(e) {
            showToast('API Error', true);
        }
    }

    async function loadDeviceLive(id) {
        try {
            document.getElementById('live-active').textContent = 'Loading...';
            const res = await fetch(`/api/webbing/devices/${id}/live`);
            if (res.ok) {
                const data = await res.json();
                document.getElementById('live-active').textContent = data.activeStatus || '-';
                document.getElementById('live-carrier').textContent = data.carrier || '-';
                document.getElementById('live-mccmnc').textContent = data.mccmnc || '-';
                document.getElementById('live-apn').textContent = data.apn || '-';
                document.getElementById('live-ip').textContent = data.ip || '-';
                document.getElementById('live-last-active').textContent = data.lastActive ? new Date(data.lastActive).toLocaleString() : '-';
            }
        } catch (e) {
            document.getElementById('live-active').textContent = 'Error fetching data';
        }
    }

    async function initDetailMap(id) {
        if (!detailMap) {
            detailMap = L.map('device-map').setView([0, 0], 2);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '© OpenStreetMap contributors © CARTO'
            }).addTo(detailMap);
        }
        detailMap.invalidateSize();
        
        try {
            const res = await fetch(`/api/webbing/devices/${id}/location`);
            if (res.ok) {
                const loc = await res.json();
                if(loc.lat && loc.lng) {
                    detailMap.setView([loc.lat, loc.lng], 13);
                    L.marker([loc.lat, loc.lng]).addTo(detailMap).bindPopup("Current Location").openPopup();
                }
            }
        } catch(e) {}
    }

    async function loadDeviceUsage(id) {
        try {
            const res = await fetch(`/api/webbing/devices/${id}/usage`);
            if (res.ok) {
                const data = await res.json();
                renderDeviceUsageChart(data);
            }
        } catch(e) {}
    }

    function renderDeviceUsageChart(data) {
        const ctx = document.getElementById('device-usage-chart').getContext('2d');
        if (detailUsageChart) detailUsageChart.destroy();

        detailUsageChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.map(d => d.date),
                datasets: [{
                    label: 'Data Usage (MB)',
                    data: data.map(d => d.usageMb),
                    backgroundColor: '#3b82f6',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#9ca3af' } },
                    x: { grid: { display: false }, ticks: { color: '#9ca3af' } }
                }
            }
        });
    }

    // --- Main Dashboard Charts & Maps ---
    async function loadUsageData() {
        try {
            const res = await fetch('/api/webbing/usage/overview');
            if (res.ok) {
                const data = await res.json();
                renderMainUsageCharts(data);
                
                // Top consumers
                const tbody = document.getElementById('top-consumers-tbody');
                tbody.innerHTML = '';
                (data.topConsumers || []).forEach(c => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td>${c.ssid}</td><td>${c.usageGb.toFixed(2)}</td>`;
                    tbody.appendChild(tr);
                });
            }
        } catch(e) {}
    }

    function renderMainUsageCharts(data) {
        const ctxMain = document.getElementById('usage-chart-main').getContext('2d');
        if (mainUsageChart) mainUsageChart.destroy();
        mainUsageChart = new Chart(ctxMain, {
            type: 'bar',
            data: {
                labels: (data.daily || []).map(d => d.date),
                datasets: [{
                    label: 'Total Data (GB)',
                    data: (data.daily || []).map(d => d.usageGb),
                    backgroundColor: '#3b82f6',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#9ca3af' } },
                    x: { grid: { display: false }, ticks: { color: '#9ca3af' } }
                }
            }
        });

        const ctxCountry = document.getElementById('usage-chart-country').getContext('2d');
        if (countryUsageChart) countryUsageChart.destroy();
        countryUsageChart = new Chart(ctxCountry, {
            type: 'doughnut',
            data: {
                labels: (data.countries || []).map(d => d.country),
                datasets: [{
                    data: (data.countries || []).map(d => d.usageGb),
                    backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { color: '#f3f4f6' } }
                }
            }
        });
    }

    async function initMainMap() {
        if (!mainMap) {
            mainMap = L.map('main-map').setView([20, 0], 2);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '© OpenStreetMap contributors © CARTO'
            }).addTo(mainMap);
        }
        mainMap.invalidateSize();

        try {
            const url = new URL(window.location.origin + '/api/webbing/devices');
            url.searchParams.append('page', 1);
            url.searchParams.append('pageSize', 1000);
            const res = await fetch(url);
            if(res.ok) {
                const data = await res.json();
                
                // Demo mapping logic - assuming API returns lat/lng
                data.items.forEach(dev => {
                    if(dev.lat && dev.lng) {
                        let color = dev.status.toLowerCase() === 'active' ? 'green' : 
                                    dev.status.toLowerCase() === 'suspended' ? 'orange' : 'red';
                        
                        // Create custom colored marker (simple circle marker for demo)
                        L.circleMarker([dev.lat, dev.lng], {
                            radius: 6,
                            fillColor: color,
                            color: '#fff',
                            weight: 1,
                            opacity: 1,
                            fillOpacity: 0.8
                        }).addTo(mainMap)
                        .bindPopup(`<b>${dev.ssid}</b><br/>Status: ${dev.status}`);
                    }
                });
            }
        } catch(e) {}
    }

    // --- Utils ---
    function showToast(msg, isError = false) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast';
        if(isError) toast.style.borderLeft = '4px solid var(--danger)';
        else toast.style.borderLeft = '4px solid var(--success)';
        toast.textContent = msg;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});
