(function() {
  // Inject CSS
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .fello-ai-widget {
      font-family: 'Montserrat', sans-serif;
      box-sizing: border-box;
    }
    .fello-ai-widget *, .fello-ai-widget *::before, .fello-ai-widget *::after {
      box-sizing: border-box;
    }
    .fello-ai-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background-color: #3166ae;
      color: white;
      border: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      z-index: 9999;
      transition: transform 0.2s ease, background-color 0.2s ease;
    }
    .fello-ai-btn:hover {
      transform: scale(1.05);
    }
    .fello-ai-btn.fello-ai-disabled {
      background-color: #94a3b8;
      cursor: not-allowed;
    }
    .fello-ai-btn.fello-ai-disabled:hover {
      transform: none;
    }
    .fello-ai-panel {
      position: fixed;
      bottom: 100px;
      right: 24px;
      width: 400px;
      height: 550px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      border: 1px solid #e2e8f0;
      display: flex;
      flex-direction: column;
      z-index: 9999;
      opacity: 0;
      transform: scale(0.95);
      pointer-events: none;
      transition: opacity 0.3s ease, transform 0.3s ease;
      overflow: hidden;
    }
    .fello-ai-panel.fello-ai-open {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
    }
    .fello-ai-header {
      background-color: #3166ae;
      color: white;
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
    }
    .fello-ai-close {
      background: none;
      border: none;
      color: white;
      font-size: 24px;
      cursor: pointer;
      line-height: 1;
      padding: 0;
    }
    .fello-ai-messages {
      flex: 1;
      background-color: #fafafa;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .fello-ai-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .fello-ai-chip {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 40px;
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
      color: #334155;
      transition: background-color 0.2s, border-color 0.2s;
    }
    .fello-ai-chip:hover {
      background: #f8fafc;
      border-color: #cbd5e1;
    }
    .fello-ai-msg {
      max-width: 85%;
      padding: 10px 14px;
      font-size: 14px;
      line-height: 1.5;
    }
    .fello-ai-msg-user {
      align-self: flex-end;
      background-color: #3166ae;
      color: white;
      border-radius: 20px 20px 0 20px;
    }
    .fello-ai-msg-ai {
      align-self: flex-start;
      background-color: white;
      color: #1e293b;
      border: 1px solid #e2e8f0;
      border-radius: 20px 20px 20px 0;
    }
    .fello-ai-msg-ai strong { font-weight: 600; }
    .fello-ai-msg-ai ul { padding-left: 20px; margin: 8px 0; }
    .fello-ai-msg-ai li { margin-bottom: 4px; }
    .fello-ai-msg-ai code { 
      background: #f1f5f9; 
      padding: 2px 4px; 
      border-radius: 4px; 
      font-family: monospace; 
      font-size: 0.9em;
    }
    .fello-ai-msg-ai table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
    }
    .fello-ai-msg-ai th, .fello-ai-msg-ai td {
      border: 1px solid #e2e8f0;
      padding: 6px;
      text-align: left;
    }
    .fello-ai-msg-ai th { background: #f8fafc; font-weight: 600; }
    
    .fello-ai-typing {
      display: none;
      align-self: flex-start;
      background-color: white;
      border: 1px solid #e2e8f0;
      border-radius: 20px 20px 20px 0;
      padding: 12px 16px;
    }
    .fello-ai-typing.fello-ai-active { display: flex; gap: 4px; }
    .fello-ai-dot {
      width: 6px;
      height: 6px;
      background: #94a3b8;
      border-radius: 50%;
      animation: fello-bounce 1.4s infinite ease-in-out both;
    }
    .fello-ai-dot:nth-child(1) { animation-delay: -0.32s; }
    .fello-ai-dot:nth-child(2) { animation-delay: -0.16s; }
    @keyframes fello-bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }
    .fello-ai-input-area {
      padding: 16px;
      background: white;
      border-top: 1px solid #e2e8f0;
      display: flex;
      gap: 12px;
    }
    .fello-ai-input {
      flex: 1;
      padding: 12px 16px;
      border: 1px solid #e2e8f0;
      border-radius: 40px;
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .fello-ai-input:focus { border-color: #3166ae; }
    .fello-ai-send {
      background-color: #fcd230;
      color: #1e293b;
      border: none;
      border-radius: 40px;
      padding: 0 20px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: opacity 0.2s;
    }
    .fello-ai-send:hover { opacity: 0.9; }
    .fello-ai-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    @media (max-width: 639px) {
      .fello-ai-panel {
        width: 100%;
        height: 100%;
        bottom: 0;
        right: 0;
        border-radius: 0;
      }
    }
  `;
  document.head.appendChild(styleEl);

  // Parse basic markdown
  function parseMarkdown(text) {
    let escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/`(.*?)`/g, '<code>$1</code>');
    
    const lines = escaped.split('\\n');
    let html = '';
    let inList = false;
    let inTable = false;
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      
      // List
      if (line.startsWith('- ') || line.startsWith('* ')) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + line.substring(2) + '</li>';
        continue;
      } else if (inList) {
        html += '</ul>';
        inList = false;
      }
      
      // Table
      if (line.startsWith('|') && line.endsWith('|')) {
        if (!inTable) { html += '<table>'; inTable = true; }
        if (line.includes('---')) continue;
        
        const cells = line.split('|').slice(1, -1);
        html += '<tr>' + cells.map(c => `<td>${c.trim()}</td>`).join('') + '</tr>';
        continue;
      } else if (inTable) {
        html += '</table>';
        inTable = false;
      }
      
      if (line === '') {
        html += '<br>';
      } else {
        html += line + (i < lines.length - 1 ? '<br>' : '');
      }
    }
    
    if (inList) html += '</ul>';
    if (inTable) html += '</table>';
    
    return html;
  }

  // Create UI elements
  const widgetContainer = document.createElement('div');
  widgetContainer.className = 'fello-ai-widget';

  const button = document.createElement('button');
  button.className = 'fello-ai-btn';
  button.innerHTML = '✨';
  
  const panel = document.createElement('div');
  panel.className = 'fello-ai-panel';
  
  const header = document.createElement('div');
  header.className = 'fello-ai-header';
  header.innerHTML = '<span>Fello AI Assistant</span><button class="fello-ai-close">×</button>';
  
  const messagesArea = document.createElement('div');
  messagesArea.className = 'fello-ai-messages';
  
  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'fello-ai-chips';
  const prompts = [
    "📊 Active orders summary",
    "⚠️ Data usage warnings",
    "📋 Pending DCR requests",
    "📱 Fleet status"
  ];
  prompts.forEach(p => {
    const chip = document.createElement('button');
    chip.className = 'fello-ai-chip';
    chip.textContent = p;
    chip.onclick = () => sendMessage(p);
    chipsContainer.appendChild(chip);
  });
  messagesArea.appendChild(chipsContainer);
  
  const typingIndicator = document.createElement('div');
  typingIndicator.className = 'fello-ai-typing';
  typingIndicator.innerHTML = '<div class="fello-ai-dot"></div><div class="fello-ai-dot"></div><div class="fello-ai-dot"></div>';
  
  const inputArea = document.createElement('div');
  inputArea.className = 'fello-ai-input-area';
  
  const input = document.createElement('input');
  input.className = 'fello-ai-input';
  input.type = 'text';
  input.placeholder = 'Ask anything...';
  
  const sendBtn = document.createElement('button');
  sendBtn.className = 'fello-ai-send';
  sendBtn.textContent = 'Send';
  
  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);
  
  panel.appendChild(header);
  panel.appendChild(messagesArea);
  panel.appendChild(inputArea);
  
  widgetContainer.appendChild(button);
  widgetContainer.appendChild(panel);
  document.body.appendChild(widgetContainer);

  let isConfigured = true;
  let history = [];

  // Check status
  fetch('/api/ai/status', { credentials: 'same-origin' })
    .then(res => res.json())
    .then(data => {
      if (data.configured === false) {
        isConfigured = false;
        button.classList.add('fello-ai-disabled');
        button.title = 'AI not configured';
      }
    })
    .catch(err => console.error('Failed to check AI status:', err));

  // Events
  button.onclick = () => {
    if (!isConfigured) return;
    panel.classList.add('fello-ai-open');
    input.focus();
  };
  
  header.querySelector('.fello-ai-close').onclick = () => {
    panel.classList.remove('fello-ai-open');
    clearChat();
  };

  input.onkeypress = (e) => {
    if (e.key === 'Enter') sendMessage(input.value);
  };
  
  sendBtn.onclick = () => sendMessage(input.value);

  function clearChat() {
    history = [];
    messagesArea.innerHTML = '';
    messagesArea.appendChild(chipsContainer);
    chipsContainer.style.display = 'flex';
    input.value = '';
  }

  function appendMessage(text, isUser) {
    chipsContainer.style.display = 'none';
    const msgDiv = document.createElement('div');
    msgDiv.className = `fello-ai-msg ${isUser ? 'fello-ai-msg-user' : 'fello-ai-msg-ai'}`;
    
    if (isUser) {
      msgDiv.textContent = text;
    } else {
      msgDiv.innerHTML = parseMarkdown(text);
    }
    
    messagesArea.appendChild(msgDiv);
    messagesArea.appendChild(typingIndicator); // Move typing indicator to bottom
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  async function sendMessage(text) {
    if (!text.trim() || !isConfigured) return;
    
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;
    
    appendMessage(text, true);
    
    const currentHistory = [...history];
    history.push({ role: 'user', content: text });
    
    typingIndicator.classList.add('fello-ai-active');
    messagesArea.scrollTop = messagesArea.scrollHeight;

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message: text, history: currentHistory })
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      history.push({ role: 'assistant', content: data.response });
      
      typingIndicator.classList.remove('fello-ai-active');
      appendMessage(data.response, false);
    } catch (error) {
      typingIndicator.classList.remove('fello-ai-active');
      appendMessage('**Error:** ' + (error.message || 'Failed to communicate with AI server.'), false);
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }
})();
