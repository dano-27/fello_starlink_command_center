// Customer Verification App
(function() {
  'use strict';
  
  const emailInput = document.getElementById('email-input');
  const verifyBtn = document.getElementById('verify-btn');
  const spinner = document.getElementById('verify-spinner');
  const resultsSection = document.getElementById('results-section');
  const historyBody = document.getElementById('history-body');
  const historyCount = document.getElementById('history-count');
  const mockBanner = document.getElementById('mock-banner');
  
  // Tools dropdown toggle
  const toolsToggle = document.getElementById('tools-toggle');
  const toolsDropdown = document.getElementById('tools-dropdown');
  if (toolsToggle && toolsDropdown) {
    toolsToggle.addEventListener('click', () => {
      toolsDropdown.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tools-nav')) toolsDropdown.classList.remove('open');
    });
  }
  
  // Verify button click
  verifyBtn.addEventListener('click', runVerification);
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runVerification();
  });
  
  async function runVerification() {
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) {
      showToast('Please enter a valid email address', 'error');
      return;
    }
    
    verifyBtn.disabled = true;
    spinner.style.display = 'block';
    
    try {
      const resp = await fetch('/api/verify-customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Verification failed');
      }
      
      const result = await resp.json();
      
      // Check if mock mode
      if (result.checks?.emailVerification?.source === 'mock') {
        mockBanner.style.display = 'block';
      } else {
        mockBanner.style.display = 'none';
      }
      
      renderResults(result);
      loadHistory();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      verifyBtn.disabled = false;
      spinner.style.display = 'none';
    }
  }
  
  function renderResults(result) {
    resultsSection.style.display = 'block';
    
    // Animate scroll to results
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    // Score gauge
    const score = result.trustScore;
    const scoreValue = document.getElementById('score-value');
    const scoreRing = document.getElementById('score-ring');
    const scoreLabel = document.getElementById('score-label');
    const circumference = 2 * Math.PI * 54;  // 339.292
    const offset = circumference - (score / 100) * circumference;
    
    // Determine color
    let color = 'var(--danger)';
    if (score >= 80) color = 'var(--success)';
    else if (score >= 50) color = 'var(--warning)';
    
    // Animate score number
    animateNumber(scoreValue, 0, score, 1200);
    
    // Animate ring
    scoreRing.style.stroke = color;
    setTimeout(() => {
      scoreRing.style.strokeDashoffset = offset;
    }, 100);
    
    // Score details
    document.getElementById('score-email').textContent = result.email;
    document.getElementById('score-domain').textContent = result.domain;
    document.getElementById('score-timestamp').textContent = 'Verified ' + formatTimeAgo(result.verifiedAt);
    
    // Decision badge
    const decisionEl = document.getElementById('score-decision');
    const decisionLabels = {
      'auto_approved': '✅ Auto-Approved',
      'needs_review': '⚠️ Needs Review',
      'rejected': '❌ Rejected'
    };
    decisionEl.textContent = decisionLabels[result.decision] || result.decision;
    decisionEl.className = 'score-decision decision-' + result.decision;
    
    if (result.reason) {
      decisionEl.textContent += ' — ' + result.reason;
    }
    
    // Check results grid
    renderChecks(result.checks);
    
    // Company enrichment
    renderEnrichment(result.checks.companyEnrichment);
  }
  
  function renderChecks(checks) {
    const grid = document.getElementById('checks-grid');
    grid.innerHTML = '';
    
    const checkConfigs = [
      {
        key: 'emailClassification',
        title: 'Email Classification',
        icon: '📧',
        fields: [
          { label: 'Type', key: 'type' },
          { label: 'Disposable', key: 'isDisposable', format: v => v ? 'Yes ⚠️' : 'No' }
        ]
      },
      {
        key: 'emailVerification',
        title: 'Email Verification',
        icon: '✉️',
        fields: [
          { label: 'Deliverable', key: 'isDeliverable', format: v => v ? 'Yes ✓' : 'No ✗' },
          { label: 'SMTP Valid', key: 'smtpValid', format: v => v ? 'Yes ✓' : 'No ✗' },
          { label: 'MX Records', key: 'mxRecords', format: v => v ? 'Found ✓' : 'Missing ✗' },
          { label: 'Score', key: 'score' },
          { label: 'Source', key: 'source' }
        ]
      },
      {
        key: 'domainVerification',
        title: 'Domain & Website',
        icon: '🌐',
        fields: [
          { label: 'MX Records', key: 'hasMxRecords', format: v => v ? 'Found ✓' : 'Missing ✗' },
          { label: 'A Record', key: 'hasARecord', format: v => v ? 'Found ✓' : 'Missing ✗' },
          { label: 'Valid SSL', key: 'hasValidSSL', format: v => v ? 'Yes ✓' : 'No ✗' },
          { label: 'SSL Issuer', key: 'sslIssuer' },
          { label: 'SSL Expiry', key: 'sslExpiry' },
          { label: 'Website', key: 'websiteResponds', format: v => v ? 'Online ✓' : 'Offline ✗' },
          { label: 'HTTP Status', key: 'httpStatus' }
        ]
      }
    ];
    
    checkConfigs.forEach((config, idx) => {
      const check = checks[config.key];
      if (!check) return;
      
      const card = document.createElement('div');
      card.className = 'check-card check-' + check.status;
      card.style.animationDelay = (idx * 0.1) + 's';
      
      const statusIcons = { pass: '✅', warn: '⚠️', fail: '❌', skipped: '⏭️', error: '💥' };
      
      let fieldsHtml = '';
      if (check.status === 'skipped') {
        fieldsHtml = `<div class="check-skipped">${check.reason || 'Skipped'}</div>`;
      } else if (check.status === 'error') {
        fieldsHtml = `<div class="check-error">${check.error || 'Error occurred'}</div>`;
      } else {
        config.fields.forEach(f => {
          const val = check[f.key];
          if (val === undefined || val === null) return;
          const display = f.format ? f.format(val) : val;
          fieldsHtml += `<div class="check-field"><span class="check-field-label">${f.label}</span><span class="check-field-value">${display}</span></div>`;
        });
      }
      
      card.innerHTML = `
        <div class="check-header">
          <span class="check-icon">${config.icon}</span>
          <span class="check-title">${config.title}</span>
          <span class="check-status">${statusIcons[check.status] || '?'}</span>
        </div>
        <div class="check-body">${fieldsHtml}</div>
      `;
      
      grid.appendChild(card);
    });
  }
  
  function renderEnrichment(enrichment) {
    const card = document.getElementById('enrichment-card');
    if (!enrichment || enrichment.status === 'skipped' || enrichment.status === 'error') {
      card.style.display = 'none';
      return;
    }
    
    card.style.display = 'block';
    
    let socialHtml = '';
    if (enrichment.linkedinUrl) socialHtml += `<a href="${enrichment.linkedinUrl}" target="_blank" class="social-link social-linkedin" title="LinkedIn">in</a>`;
    if (enrichment.twitterUrl) socialHtml += `<a href="${enrichment.twitterUrl}" target="_blank" class="social-link social-twitter" title="Twitter">𝕏</a>`;
    if (enrichment.facebookUrl) socialHtml += `<a href="${enrichment.facebookUrl}" target="_blank" class="social-link social-facebook" title="Facebook">f</a>`;
    
    const fields = [
      { label: 'Industry', value: enrichment.industry },
      { label: 'Employees', value: enrichment.employeeCount },
      { label: 'Location', value: [enrichment.city, enrichment.country].filter(Boolean).join(', ') },
      { label: 'Emails Found', value: enrichment.emailCount },
      { label: 'Source', value: enrichment.source }
    ].filter(f => f.value);
    
    let fieldsHtml = fields.map(f => 
      `<div class="enrichment-field"><span class="enrichment-label">${f.label}</span><span class="enrichment-value">${f.value}</span></div>`
    ).join('');
    
    card.innerHTML = `
      <div class="enrichment-header">
        <div class="enrichment-company">
          <span class="enrichment-icon">🏢</span>
          <div>
            <div class="enrichment-name">${enrichment.companyName || 'Unknown Company'}</div>
            ${enrichment.description ? `<div class="enrichment-desc">${enrichment.description}</div>` : ''}
          </div>
        </div>
        ${socialHtml ? `<div class="social-links">${socialHtml}</div>` : ''}
      </div>
      <div class="enrichment-fields">${fieldsHtml}</div>
    `;
  }
  
  // History
  function loadHistory() {
    fetch('/api/verify-customer/results')
      .then(r => r.json())
      .then(results => {
        historyCount.textContent = results.length + ' record' + (results.length !== 1 ? 's' : '');
        
        if (results.length === 0) {
          historyBody.innerHTML = '<tr><td colspan="6" class="history-empty">No verifications yet</td></tr>';
          return;
        }
        
        historyBody.innerHTML = results.map(r => {
          let scoreClass = 'score-red';
          if (r.trustScore >= 80) scoreClass = 'score-green';
          else if (r.trustScore >= 50) scoreClass = 'score-amber';
          
          const decisionLabels = {
            'auto_approved': 'Approved',
            'needs_review': 'Review',
            'rejected': 'Rejected'
          };
          
          return `<tr>
            <td class="history-email" onclick="document.getElementById('email-input').value='${r.email}';document.getElementById('verify-btn').click();" style="cursor:pointer;">${r.email}</td>
            <td>${r.domain}</td>
            <td><span class="history-score ${scoreClass}">${r.trustScore}</span></td>
            <td><span class="history-decision decision-${r.decision}">${decisionLabels[r.decision] || r.decision}</span></td>
            <td class="history-time">${formatTimeAgo(r.verifiedAt)}</td>
            <td><button class="history-delete" onclick="deleteVerification('${r.email}')" title="Delete">🗑️</button></td>
          </tr>`;
        }).join('');
      })
      .catch(() => {});
  }
  
  // Delete
  window.deleteVerification = function(email) {
    if (!confirm('Delete verification for ' + email + '?')) return;
    fetch('/api/verify-customer/' + encodeURIComponent(email), { method: 'DELETE' })
      .then(r => {
        if (r.ok) {
          showToast('Deleted verification for ' + email);
          loadHistory();
        } else {
          showToast('Failed to delete', 'error');
        }
      });
  };
  
  // Utilities
  function animateNumber(el, from, to, duration) {
    const start = performance.now();
    function update(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);  // ease-out cubic
      el.textContent = Math.round(from + (to - from) * eased);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }
  
  function formatTimeAgo(dateStr) {
    if (!dateStr) return '--';
    const date = new Date(dateStr);
    const now = new Date();
    const secs = Math.floor((now - date) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    if (secs < 604800) return Math.floor(secs / 86400) + 'd ago';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  
  function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show toast-' + (type || 'success');
    setTimeout(() => { t.className = 'toast'; }, 3500);
  }
  
  // Load history on page load
  loadHistory();
})();
