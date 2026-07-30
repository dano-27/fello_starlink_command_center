/**
 * Fello CRM Client
 * 
 * Connects to Fello's custom CRM API to retrieve order information,
 * device manifests, event details, and configuration profiles.
 * 
 * Includes a mock mode that returns realistic sample data when no
 * API key is configured, enabling end-to-end testing of the full flow.
 */

class FelloCrmClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.timeout = config.timeout || 15000;
    this.mockMode = !this.baseUrl || !this.apiKey;
    
    if (this.mockMode) {
      console.log('[CRM] Running in MOCK mode — no API key configured');
    } else {
      console.log(`[CRM] Connected to ${this.baseUrl}`);
    }
  }

  /**
   * Check if the CRM client is configured with real credentials
   */
  isConfigured() {
    return !this.mockMode;
  }

  /**
   * Make an authenticated request to the CRM API
   */
  async request(method, path, body = null) {
    if (this.mockMode) {
      return this._mockRequest(method, path, body);
    }

    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Auth header — adjust based on actual CRM API docs
      'Authorization': `Bearer ${this.apiKey}`,
      'X-API-Key': this.apiKey
    };

    const options = { method, headers };
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    // AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    options.signal = controller.signal;

    try {
      const response = await fetch(url, options);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new CrmApiError(
          `CRM API Error: ${response.status} ${response.statusText}`,
          response.status,
          errorText
        );
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new CrmApiError('CRM API request timed out', 408);
      }
      if (err instanceof CrmApiError) throw err;
      throw new CrmApiError(`CRM API request failed: ${err.message}`, 0);
    }
  }

  // ─── Order Methods ──────────────────────────────────────────────────

  /**
   * Look up an order by order number
   * Returns order details + full device manifest
   * 
   * @param {string} orderNumber - e.g. "FE1234", "SQ9171"
   * @returns {Object} { order, devices, event, config }
   */
  async getOrder(orderNumber) {
    const data = await this.request('GET', `/api/orders/${encodeURIComponent(orderNumber)}`);
    return this._normalizeOrder(data);
  }

  /**
   * Get just the device list for an order
   * 
   * @param {string} orderNumber
   * @returns {Array} Array of device objects with serial, model, etc.
   */
  async getOrderDevices(orderNumber) {
    const data = await this.request('GET', `/api/orders/${encodeURIComponent(orderNumber)}/devices`);
    return this._normalizeDevices(data);
  }

  /**
   * Search orders by any query (order number, customer name, event name)
   * 
   * @param {string} query
   * @returns {Array} Array of matching order summaries
   */
  async searchOrders(query) {
    const data = await this.request('GET', `/api/orders/search?q=${encodeURIComponent(query)}`);
    return Array.isArray(data) ? data : (data.results || data.orders || []);
  }

  /**
   * Get a single device by serial number
   * 
   * @param {string} serial
   * @returns {Object} Device details including order association
   */
  async getDevice(serial) {
    const data = await this.request('GET', `/api/devices/${encodeURIComponent(serial)}`);
    return this._normalizeDevice(data);
  }

  /**
   * Health check — verify CRM API is reachable
   */
  async healthCheck() {
    try {
      if (this.mockMode) {
        return { status: 'mock', message: 'Running in mock mode — no API key configured' };
      }
      await this.request('GET', '/api/health');
      return { status: 'connected', baseUrl: this.baseUrl };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  // ─── Data Normalization ─────────────────────────────────────────────
  // These normalize whatever shape the CRM API returns into our standard format.
  // Update these once we have actual API docs.

  _normalizeOrder(raw) {
    const order = raw.order || raw;
    return {
      orderNumber: order.orderNumber || order.order_number || order.id || '',
      customerName: order.customerName || order.customer_name || order.customer || '',
      status: order.status || 'unknown',
      eventName: order.eventName || order.event_name || order.event?.name || '',
      eventAddress: order.eventAddress || order.event_address || order.event?.address || '',
      eventDate: order.eventDate || order.event_date || order.event?.date || '',
      deviceCount: order.deviceCount || order.device_count || (order.devices || []).length,
      devices: this._normalizeDevices(order.devices || raw.devices || []),
      config: order.config || order.configuration || {},
      mdmGroupId: order.mdmGroupId || order.mdm_group_id || null,
      mdmAccount: order.mdmAccount || order.mdm_account || null,
      notes: order.notes || '',
      createdAt: order.createdAt || order.created_at || '',
      updatedAt: order.updatedAt || order.updated_at || '',
      raw: raw
    };
  }

  _normalizeDevices(devices) {
    if (!Array.isArray(devices)) {
      devices = devices?.devices || devices?.data || [];
    }
    return devices.map(d => this._normalizeDevice(d));
  }

  _normalizeDevice(raw) {
    const d = raw.device || raw;
    return {
      serial: d.serial || d.serialNumber || d.serial_number || '',
      model: d.model || d.modelName || d.model_name || '',
      name: d.name || d.deviceName || d.device_name || '',
      orderNumber: d.orderNumber || d.order_number || '',
      status: d.status || 'unknown',
      configProfile: d.configProfile || d.config_profile || d.profile || null,
      assignedSlot: d.assignedSlot || d.assigned_slot || d.slot || null,
      notes: d.notes || '',
      raw: raw
    };
  }

  // ─── Mock Data ──────────────────────────────────────────────────────

  async _mockRequest(method, path) {
    await new Promise(r => setTimeout(r, 100));

    const orderMatch = path.match(/\/api\/orders\/([^/?]+)/);
    const deviceMatch = path.match(/\/api\/devices\/([^/?]+)/);
    const searchMatch = path.match(/\/api\/orders\/search\?q=(.+)/);

    if (path === '/api/health') {
      return { status: 'ok', mock: true };
    }

    if (searchMatch) {
      const query = decodeURIComponent(searchMatch[1]).toUpperCase();
      return this._mockSearchOrders(query);
    }

    if (orderMatch) {
      const orderNum = decodeURIComponent(orderMatch[1]);
      const isDevicesOnly = path.includes('/devices');
      const order = this._mockGetOrder(orderNum);
      return isDevicesOnly ? order.devices : order;
    }

    if (deviceMatch) {
      return this._mockGetDevice(decodeURIComponent(deviceMatch[1]));
    }

    throw new CrmApiError('Mock: Unknown endpoint', 404);
  }

  _mockGetOrder(orderNumber) {
    const num = orderNumber.toUpperCase();
    const deviceCount = this._mockDeviceCount(num);
    const devices = [];
    for (let i = 1; i <= deviceCount; i++) {
      devices.push({
        serial: `MOCK${num.replace(/[^A-Z0-9]/g, '')}${String(i).padStart(3, '0')}`,
        model: 'iPad mini (5th generation)',
        name: `${num}-${i}`,
        orderNumber: num,
        status: 'assigned',
        configProfile: `${num}_profile`,
        assignedSlot: i,
        notes: ''
      });
    }

    return {
      order: {
        orderNumber: num,
        customerName: this._mockCustomerName(num),
        status: 'active',
        eventName: `${this._mockCustomerName(num)} Event`,
        eventAddress: '123 Main St, San Antonio, TX 78201',
        eventDate: '2026-08-15',
        deviceCount,
        devices,
        config: {
          wifiSSID: `${num}-WiFi`,
          lockMessage: 'Property of Fello',
          wallpaper: 'default',
          apps: ['Safari', 'Maps']
        },
        mdmGroupId: null,
        mdmAccount: 'fello',
        notes: 'Mock order for testing',
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-07-30T10:00:00Z'
      }
    };
  }

  _mockGetDevice(serial) {
    return {
      device: {
        serial,
        model: 'iPad mini (5th generation)',
        name: `MOCK-${serial.slice(-3)}`,
        orderNumber: 'MOCK-ORDER',
        status: 'assigned',
        configProfile: 'default_profile',
        assignedSlot: 1,
        notes: 'Mock device'
      }
    };
  }

  _mockSearchOrders(query) {
    const results = [];
    if (query.startsWith('FE') || query.startsWith('SQ')) {
      results.push({
        orderNumber: query,
        customerName: this._mockCustomerName(query),
        status: 'active',
        deviceCount: this._mockDeviceCount(query),
        eventName: `${this._mockCustomerName(query)} Event`
      });
    }
    results.push({
      orderNumber: 'FE9999',
      customerName: 'Sample Customer',
      status: 'active',
      deviceCount: 10,
      eventName: 'Sample Event'
    });
    return { results };
  }

  _mockDeviceCount(orderNum) {
    const hash = orderNum.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return 5 + (hash % 20);
  }

  _mockCustomerName(orderNum) {
    const names = ['Acme Corp', 'Smith Events', 'Johnson Rentals', 'Alamo Fireworks', 'Davis Entertainment'];
    const hash = orderNum.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return names[hash % names.length];
  }
}

class CrmApiError extends Error {
  constructor(message, statusCode = 0, details = '') {
    super(message);
    this.name = 'CrmApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = { FelloCrmClient, CrmApiError };
