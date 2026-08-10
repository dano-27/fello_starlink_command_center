/**
 * IMS NextGen CRM Client
 * 
 * Connects to Fello's IMS NextGen API to retrieve order information,
 * line items (rentals), shipping details, and customer data.
 */

const IMS_BASE_URL = 'https://ims-v4-migration-prod-876702752852.us-east4.run.app';
const IMS_TOKEN = '2423|rydhEvIv6ZsEABia67jH5ffhMUJLthtu3YrfySpx93f5cc0e';

class FelloCrmClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.IMS_NEXTGEN_URL || IMS_BASE_URL;
    this.token = config.apiKey || process.env.IMS_NEXTGEN_TOKEN || IMS_TOKEN;
    this.timeout = config.timeout || 15000;
    this.configured = !!(this.baseUrl && this.token);
    
    if (this.configured) {
      console.log(`[CRM] Connected to IMS NextGen at ${this.baseUrl}`);
    } else {
      console.log('[CRM] IMS NextGen not configured — CRM features disabled');
    }
  }

  isConfigured() {
    return this.configured;
  }

  /**
   * Make an authenticated request to the IMS NextGen API
   */
  async request(method, path) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new CrmApiError(
          `IMS API Error: ${response.status} ${response.statusText}`,
          response.status,
          errorText
        );
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new CrmApiError('IMS API request timed out', 408);
      }
      if (err instanceof CrmApiError) throw err;
      throw new CrmApiError(`IMS API request failed: ${err.message}`, 0);
    }
  }

  // ─── Order Methods ──────────────────────────────────────────────────

  /**
   * Look up an order by fly_order_id (e.g. "OR161")
   * 
   * @param {string} flyOrderId - e.g. "OR161"
   * @returns {Object} Normalized order with rentals, shipping, customer info
   */
  async getOrder(flyOrderId) {
    const raw = await this.request('GET', `/api/nextgen/v1/orders/${encodeURIComponent(flyOrderId)}`);
    return this._normalizeOrder(raw);
  }

  /**
   * Health check — verify IMS API is reachable
   */
  async healthCheck() {
    try {
      if (!this.configured) {
        return { status: 'not_configured', message: 'IMS NextGen credentials not set' };
      }
      // Try fetching a known order as a health check
      await this.request('GET', '/api/nextgen/v1/orders/OR161');
      return { status: 'connected', baseUrl: this.baseUrl };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  // ─── Data Normalization ─────────────────────────────────────────────

  _normalizeOrder(raw) {
    return {
      id: raw.id,
      flyOrderId: raw.fly_order_id || '',
      customerName: raw.customer_name || '',
      status: raw.status || 'unknown',
      
      // Shipping info
      shipping: {
        name: raw.ship_name || '',
        firstName: raw.ship_first_name || '',
        lastName: raw.ship_last_name || '',
        address1: raw.ship_address1 || '',
        address2: raw.ship_address2 || '',
        city: raw.ship_city || '',
        state: raw.ship_state || '',
        zip: raw.ship_zip || '',
        country: raw.ship_country || '',
        email: raw.ship_email || '',
        phone: raw.ship_phone || '',
        buildingName: raw.building_name || '',
        siteCode: raw.site_code || '',
        deliveryInstructions: raw.delivery_instructions || '',
        tracking: raw.ship_tracking || ''
      },

      // Return shipping
      returnShipping: {
        name: raw.return_name || '',
        address1: raw.return_address1 || '',
        city: raw.return_city || '',
        state: raw.return_state || '',
        zip: raw.return_zip || ''
      },

      // Dates
      startDate: raw.start_date || '',
      endDate: raw.end_date || '',
      outboundDate: raw.outbound_date || '',
      inboundDate: raw.inbound_date || '',
      prepDate: raw.prep_date || '',
      createdAt: raw.created_at || '',
      updatedAt: raw.updated_at || '',

      // Order details
      eventName: raw.event_name || '',
      eventType: raw.event_type || '',
      eventVenue: raw.event_venue || '',
      notes: raw.notes || '',
      salesNotes: raw.sales_notes || '',
      shippingSpeed: raw.shipping_speed || '',
      carrier: raw.carrier || '',
      purchaseOrderNumber: raw.purchase_order_number || '',
      dealOwner: raw.deal_owner || null,
      sequence: raw.sequence || 0,
      siteSource: raw.site_source || '',

      // Line items (rentals)
      rentals: (raw.rentals || []).map(r => this._normalizeRental(r)),
      rentalCount: (raw.rentals || []).length,

      // Raw response for debugging
      raw
    };
  }

  _normalizeRental(r) {
    const model = r.model || {};
    return {
      id: r.id,
      lineItemId: r.line_item_id,
      modelId: model.id || r.model_id,
      modelName: model.model_name || model.name || '',
      partNumber: model.part_number || '',
      amount: r.amount || 0,
      isIpad: r.is_ipad === 1,
      network: model.network || '',
      location: model.location || '',
      status: model.status || '',
      category: model.model_category || 0,
      color: model.color || '',
      size: model.size || '',
      operatingSystem: model.operating_system || '',
      startTime: r.start_time || '',
      endTime: r.end_time || '',
      outboundDate: r.outbound_date || '',
      inboundDate: r.inbound_date || '',
      confirmed: r.confirmed || 0,
      checkoutAmount: r.checkout_amount,
      checkinAmount: r.checkin_amount,
      shipmentId: r.shipment_id || null,
      variantFields: model.variant_fields || null,
      noSerialNumber: model.no_serial_number || false,
      noEsim: model.no_esim || false,
      noDep: model.no_dep || false,
      tracking: model.tracking || ''
    };
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
