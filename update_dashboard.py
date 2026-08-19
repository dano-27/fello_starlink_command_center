import re
import sys

with open('/Users/danodomirok/.gemini/antigravity/scratch/starlink-dashboard/public/cradlepoint/index.html', 'r') as f:
    html = f.read()

# 1. Add Leaflet CDN
html = html.replace('</head>', '''  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
</head>''')

# 2. Add CSS
css_to_add = """
    /* Modals & Track Map */
    .modal-overlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 1000;
    }
    .modal-card {
      background: var(--card-bg); border-radius: 8px; width: 100%; max-width: 600px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: flex; flex-direction: column;
    }
    .modal-header {
      padding: 16px; border-bottom: 1px solid var(--border-color);
      display: flex; justify-content: space-between; align-items: center;
    }
    .modal-body {
      padding: 16px; max-height: 70vh; overflow-y: auto;
    }
    .wifi-item {
      border: 1px solid var(--border-color); border-radius: 6px; padding: 16px; margin-bottom: 16px;
    }
    .wifi-item label { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 600; color: var(--text-muted); }
    .wifi-item input { width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 12px; font-family: inherit; font-size: 14px; }
    .password-wrapper { position: relative; }
    .password-wrapper input { padding-right: 60px; }
    .password-wrapper .toggle-pw { position: absolute; right: 8px; top: 8px; background: none; border: none; cursor: pointer; color: var(--primary); font-size: 13px; font-weight: 500;}
    .pill-btn { padding: 6px 16px; border-radius: 16px; border: 1px solid var(--border-color); background: white; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-muted); }
    .pill-btn.active { background: var(--primary); color: white; border-color: var(--primary); }
    #map-section { margin-bottom: 24px; }
"""
html = html.replace('  </style>', css_to_add + '  </style>')

# 3. Modify renderRouters actionHtml
action_html_replacement = """        let actionHtml = '';
        if (currentUser?.role === 'admin') {
          actionHtml += `<button class="btn btn-danger btn-sm" onclick="rebootRouter(event, '${router.id}')">Reboot</button>`;
        }
        if (isOnline) {
          actionHtml += ` <button class="btn btn-secondary btn-sm" onclick="openWifiModal(event, '${router.id}')">📶 WiFi</button>`;
          actionHtml += ` <button class="btn btn-secondary btn-sm" id="btn-test-${router.id}" onclick="runSpeedTest(event, '${router.id}')">🏎️ Test</button>`;
          actionHtml += ` <button class="btn btn-secondary btn-sm" onclick="showTrackMap(event, '${router.id}', '${router.name?.replace(/'/g, "\\\\'") || 'Unknown'}')">📍 Track</button>`;
        }"""
html = re.sub(r'const actionHtml = currentUser\?\.role === \'admin\' \?[^;]+;', action_html_replacement, html)

# 4. Add map section and modal to body
html = html.replace('    <div class="card">\n      <div class="collapsible-header"', '''    <div class="card" id="map-section" style="display: none;">
      <div style="padding: 16px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h3 id="map-router-name" style="margin-bottom: 8px;">Router Name</h3>
          <div style="display: flex; gap: 8px;">
            <button class="pill-btn active" id="btn-map-1" onclick="loadTrackMap(1)">1d</button>
            <button class="pill-btn" id="btn-map-3" onclick="loadTrackMap(3)">3d</button>
            <button class="pill-btn" id="btn-map-7" onclick="loadTrackMap(7)">7d</button>
            <button class="pill-btn" id="btn-map-30" onclick="loadTrackMap(30)">30d</button>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="closeMap()">X</button>
      </div>
      <div id="map-container" style="height: 400px; width: 100%; position: relative;"></div>
      <div id="map-msg" style="padding: 16px; text-align: center; color: var(--text-muted); display: none;">No GPS data available for this router</div>
    </div>

    <div class="card">
      <div class="collapsible-header"''')

html = html.replace('</main>', '''</main>

  <div id="wifi-modal" class="modal-overlay">
    <div class="modal-card">
      <div class="modal-header">
        <h3 style="font-size: 16px;">WiFi Configuration</h3>
        <button class="btn btn-secondary btn-sm" onclick="closeWifiModal()">X</button>
      </div>
      <div id="wifi-modal-content" class="modal-body">
        Loading...
      </div>
    </div>
  </div>''')

# 5. Add credentials: 'same-origin' to existing fetch calls
html = html.replace("fetch('/api/cradlepoint/fleet')", "fetch('/api/cradlepoint/fleet', { credentials: 'same-origin' })")
html = html.replace("fetch(`/api/cradlepoint/routers/${routerId}/reboot`, { method: 'POST' })", "fetch(`/api/cradlepoint/routers/${routerId}/reboot`, { method: 'POST', credentials: 'same-origin' })")

# 6. Append JavaScript functions
js_to_add = """
    // -----------------------------------------
    // WIFI CONFIG
    // -----------------------------------------
    let currentWifiRouterId = null;

    async function openWifiModal(event, routerId) {
      event.stopPropagation();
      currentWifiRouterId = routerId;
      document.getElementById('wifi-modal').style.display = 'flex';
      document.getElementById('wifi-modal-content').innerHTML = '<div style="text-align:center;color:var(--text-muted);">Loading WiFi info...</div>';
      
      try {
        const res = await fetch(`/api/cradlepoint/routers/${routerId}/wifi`, { credentials: 'same-origin' });
        const data = await res.json();
        
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to fetch WiFi config');
        
        const ssids = data.ssids || [];
        if (ssids.length === 0) {
          document.getElementById('wifi-modal-content').innerHTML = '<div style="text-align:center;color:var(--text-muted);">No SSIDs found.</div>';
          return;
        }

        let html = '';
        ssids.forEach((ssid, idx) => {
          html += `
            <div class="wifi-item">
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
                <span style="font-weight:600;font-size:14px;">Radio: ${ssid.band} (${ssid.enabled ? '<span style="color:var(--success)">Enabled</span>' : '<span style="color:var(--danger)">Disabled</span>'})</span>
              </div>
              <label>SSID Name</label>
              <input type="text" id="ssid-name-${idx}" value="${ssid.name}">
              
              <label>Password</label>
              <div class="password-wrapper">
                <input type="password" id="ssid-pw-${idx}" value="${ssid.password}">
                <button type="button" class="toggle-pw" onclick="togglePw(this, 'ssid-pw-${idx}')">Show</button>
              </div>
              
              <button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="updateWifi('${routerId}', '${ssid.radioKey}', '${ssid.ssidKey}', ${idx})">Update WiFi</button>
              <span id="wifi-msg-${idx}" style="font-size:12px;margin-left:8px;"></span>
            </div>
          `;
        });
        document.getElementById('wifi-modal-content').innerHTML = html;
        
      } catch (err) {
        document.getElementById('wifi-modal-content').innerHTML = `<div style="color:var(--danger);">${err.message}</div>`;
      }
    }

    function closeWifiModal() {
      document.getElementById('wifi-modal').style.display = 'none';
      currentWifiRouterId = null;
    }

    function togglePw(btn, inputId) {
      const input = document.getElementById(inputId);
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    }

    async function updateWifi(routerId, radioKey, ssidKey, idx) {
      const newName = document.getElementById(`ssid-name-${idx}`).value;
      const newPw = document.getElementById(`ssid-pw-${idx}`).value;
      const msgEl = document.getElementById(`wifi-msg-${idx}`);
      
      msgEl.textContent = 'Updating...';
      msgEl.style.color = 'var(--text-muted)';
      
      try {
        const res = await fetch(`/api/cradlepoint/routers/${routerId}/wifi`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ radioKey, ssidKey, newSsid: newName, newPassword: newPw })
        });
        const data = await res.json();
        
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to update');
        
        msgEl.textContent = 'Success!';
        msgEl.style.color = 'var(--success)';
        setTimeout(() => { if(msgEl.textContent==='Success!') msgEl.textContent=''; }, 3000);
      } catch (err) {
        msgEl.textContent = err.message;
        msgEl.style.color = 'var(--danger)';
      }
    }

    // -----------------------------------------
    // SPEED TEST
    // -----------------------------------------
    async function runSpeedTest(event, routerId) {
      event.stopPropagation();
      const btn = document.getElementById(`btn-test-${routerId}`);
      if (!btn || btn.disabled) return;
      
      btn.disabled = true;
      const originalText = btn.innerHTML;
      btn.innerHTML = '⏳ Testing...';
      
      // Make sure detail row is open
      const tr = document.querySelector(`.router-row:has(#btn-test-${routerId})`);
      const router = routersData.find(r => r.id === routerId);
      if (router && tr) {
        const detailRow = document.getElementById(`detail-${router.id}`);
        if (!detailRow.classList.contains('open')) {
          toggleDetail(router, tr);
        }
      }
      
      const detailContent = document.getElementById(`detail-content-${routerId}`);
      let resultsDiv = document.getElementById(`speedtest-results-${routerId}`);
      if (!resultsDiv) {
        resultsDiv = document.createElement('div');
        resultsDiv.id = `speedtest-results-${routerId}`;
        resultsDiv.style.marginTop = '16px';
        resultsDiv.style.padding = '12px';
        resultsDiv.style.background = '#fff';
        resultsDiv.style.border = '1px solid var(--border-color)';
        resultsDiv.style.borderRadius = '6px';
        detailContent.appendChild(resultsDiv);
      }
      
      resultsDiv.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Starting speed test...</div>';
      
      try {
        const res = await fetch(`/api/cradlepoint/routers/${routerId}/speedtest`, {
          method: 'POST',
          credentials: 'same-origin'
        });
        const data = await res.json();
        
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to start speed test');
        
        const testId = data.test?.id;
        if (!testId) throw new Error('No test ID returned');
        
        pollSpeedTest(testId, routerId, resultsDiv, btn, originalText);
        
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = originalText;
        resultsDiv.innerHTML = `<div style="color:var(--danger);font-size:13px;">Error: ${err.message}</div>`;
      }
    }

    async function pollSpeedTest(testId, routerId, resultsDiv, btn, originalText) {
      const poll = async () => {
        try {
          const res = await fetch(`/api/cradlepoint/speedtest/${testId}`, { credentials: 'same-origin' });
          const data = await res.json();
          
          if (!res.ok || data.error) throw new Error(data.error || 'Failed to check status');
          
          if (data.status === 'completed' || data.status === 'failed') {
            btn.disabled = false;
            btn.innerHTML = originalText;
            
            if (data.status === 'failed') {
              resultsDiv.innerHTML = `<div style="color:var(--danger);font-size:13px;">Test failed: ${data.error || 'Unknown error'}</div>`;
            } else {
              resultsDiv.innerHTML = `
                <div class="detail-title">🏎️ Speed Test Results</div>
                <div style="display:flex;gap:24px;font-size:14px;">
                  <div><strong>Download:</strong> <span style="color:var(--success);font-weight:600;font-size:16px;">${data.download_mbps || 0} Mbps</span></div>
                  <div><strong>Upload:</strong> <span style="color:var(--primary);font-weight:600;font-size:16px;">${data.upload_mbps || 0} Mbps</span></div>
                  <div><strong>Latency:</strong> <span>${data.latency_ms || 0} ms</span></div>
                </div>
              `;
            }
          } else {
            resultsDiv.innerHTML = `<div style="color:var(--text-muted);font-size:13px;">Testing... Status: ${data.status}</div>`;
            setTimeout(poll, 3000);
          }
        } catch (err) {
          btn.disabled = false;
          btn.innerHTML = originalText;
          resultsDiv.innerHTML = `<div style="color:var(--danger);font-size:13px;">Error: ${err.message}</div>`;
        }
      };
      
      setTimeout(poll, 3000);
    }

    // -----------------------------------------
    // GPS TRACK MAP
    // -----------------------------------------
    let map = null;
    let mapPolyline = null;
    let mapMarkers = [];
    let currentMapRouterId = null;

    function showTrackMap(event, routerId, routerName) {
      event.stopPropagation();
      currentMapRouterId = routerId;
      document.getElementById('map-router-name').textContent = routerName;
      document.getElementById('map-section').style.display = 'block';
      
      if (!map) {
        map = L.map('map-container').setView([0, 0], 2);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© OpenStreetMap contributors'
        }).addTo(map);
      }
      
      // Load 1 day by default
      loadTrackMap(1);
      
      // Scroll to map
      document.getElementById('map-section').scrollIntoView({ behavior: 'smooth' });
      
      // Fix leaflet resize issue when revealing map
      setTimeout(() => map.invalidateSize(), 200);
    }

    function closeMap() {
      document.getElementById('map-section').style.display = 'none';
      currentMapRouterId = null;
    }

    async function loadTrackMap(days) {
      if (!currentMapRouterId) return;
      
      // Update pills
      [1,3,7,30].forEach(d => {
        const btn = document.getElementById(`btn-map-${d}`);
        if(btn) {
          if (d === days) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
      
      document.getElementById('map-container').style.display = 'block';
      document.getElementById('map-msg').style.display = 'none';
      
      // Clear old layers
      if (mapPolyline) map.removeLayer(mapPolyline);
      mapMarkers.forEach(m => map.removeLayer(m));
      mapMarkers = [];
      
      try {
        const res = await fetch(`/api/cradlepoint/routers/${currentMapRouterId}/history?days=${days}`, { credentials: 'same-origin' });
        const data = await res.json();
        
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to fetch history');
        
        const history = data.history || [];
        const latlngs = history.map(h => [h.lat, h.lng]).filter(ll => ll[0] !== undefined && ll[1] !== undefined);
        
        if (latlngs.length === 0) {
          document.getElementById('map-container').style.display = 'none';
          document.getElementById('map-msg').style.display = 'block';
          return;
        }
        
        mapPolyline = L.polyline(latlngs, { color: 'var(--primary)', weight: 3 }).addTo(map);
        map.fitBounds(mapPolyline.getBounds(), { padding: [20, 20] });
        
        // Start marker (oldest) is last in the array if sorted newest first, wait, let's just use indices
        // Assuming order is chronological, start is 0, end is length-1
        // Actually the API history might be newest first. Let's color the edges appropriately.
        // If history[0] is newest, it's the end.
        
        const startMarker = L.circleMarker(latlngs[0], { radius: 6, fillColor: 'var(--success)', fillOpacity: 1, color: '#fff', weight: 2 }).addTo(map);
        const endMarker = L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, fillColor: 'var(--danger)', fillOpacity: 1, color: '#fff', weight: 2 }).addTo(map);
        mapMarkers.push(startMarker, endMarker);
        
      } catch (err) {
        console.error('Error loading GPS history:', err);
        document.getElementById('map-container').style.display = 'none';
        const msg = document.getElementById('map-msg');
        msg.style.display = 'block';
        msg.textContent = `Error: ${err.message}`;
      }
    }
"""
html = html.replace('// Start\n    document.addEventListener(\'DOMContentLoaded\', init);', js_to_add + '\n    // Start\n    document.addEventListener(\'DOMContentLoaded\', init);')

with open('/Users/danodomirok/.gemini/antigravity/scratch/starlink-dashboard/public/cradlepoint/index.html', 'w') as f:
    f.write(html)
