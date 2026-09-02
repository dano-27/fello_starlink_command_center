/* ── Fello Command Center Shared Header ─────────────────────────── */
(function() {
  // Detect current page for active highlighting
  const path = window.location.pathname;
  const currentTool = path.split('/').filter(Boolean)[0] || '';

  const tools = [
    { href: '/checker/', icon: '🛰️', label: 'Site Checker', key: 'checker' },
    { href: '/simplemdm/', icon: '📱', label: 'SimpleMDM', key: 'simplemdm' },
    { href: '/webbing/', icon: '📶', label: 'Webbing IoT', key: 'webbing' },
    { href: '/starlink/', icon: '📡', label: 'Starlink', key: 'starlink' },
    { href: '/hexnode/', icon: '🔒', label: 'Hexnode UEM', key: 'hexnode' },
    { href: '/orders/', icon: '📦', label: 'IMS Orders', key: 'orders' },
    { href: '/inventory/', icon: '🏭', label: 'Inventory', key: 'inventory' },
    { href: '/cradlepoint/', icon: '🌐', label: 'Cradlepoint', key: 'cradlepoint' },
    { href: '/peplink/', icon: '🔌', label: 'Peplink', key: 'peplink' },
    { href: '/agent/', icon: '🤖', label: 'Agent', key: 'agent' },
    { href: '/reports/', icon: '📊', label: 'Reports', key: 'reports' },
    { href: '/training/', icon: '📖', label: 'Training', key: 'training' },
  ];

  const toolLinks = tools.map(t => {
    const active = currentTool === t.key ? ' active' : '';
    return `<a href="${t.href}" class="tools-link${active}"><span>${t.icon}</span> ${t.label}</a>`;
  }).join('\n');

  // Build header HTML
  const headerHTML = `
    <div class="fello-header-inner">
      <a href="/lookup/" class="brand-link">
        <img src="/fello-logo.png" alt="Fello" class="brand-logo-img">
        <span class="brand-divider"></span>
        <span class="brand-chip">Command Center</span>
      </a>
      <div class="tools-nav">
        <button class="tools-toggle" id="fello-tools-toggle">🧰 Tools <span class="tools-chevron">▼</span></button>
        <div class="tools-dropdown" id="fello-tools-dropdown">
          ${toolLinks}
        </div>
      </div>
      <div class="fello-user-badge" id="fello-user-badge"></div>
    </div>
  `;

  // Inject the header
  const headerEl = document.querySelector('.fello-header');
  if (headerEl) {
    headerEl.innerHTML = headerHTML;
  }

  // Tools dropdown toggle
  document.addEventListener('click', function(e) {
    const toggle = document.getElementById('fello-tools-toggle');
    const dropdown = document.getElementById('fello-tools-dropdown');
    if (!toggle || !dropdown) return;
    
    if (toggle.contains(e.target)) {
      dropdown.classList.toggle('open');
    } else {
      dropdown.classList.remove('open');
    }
  });

  // Auth check and user badge
  fetch('/api/auth/me').then(r => {
    if (!r.ok) { window.location.href = '/login'; return null; }
    return r.json();
  }).then(user => {
    if (!user) return;
    window._felloUser = user;
    const badge = document.getElementById('fello-user-badge');
    if (!badge) return;

    let links = '';
    if (user.role === 'admin') {
      links += `<a href="/audit/">📋 Audit</a>`;
      links += `<a href="/admin/users">👥 Users</a>`;
    }
    links += `<a href="#" onclick="fetch('/api/auth/logout',{method:'POST'}).then(()=>window.location.href='/login');return false;">Sign Out</a>`;

    badge.innerHTML = `
      <span class="user-name">${user.name || user.username}</span>
      ${links}
    `;

    // Dispatch event so page-specific code can react
    document.dispatchEvent(new CustomEvent('fello-user-loaded', { detail: user }));
  }).catch(() => {
    window.location.href = '/login';
  });
})();
