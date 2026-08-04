/**
 * Webbing WWS V5.21 SOAP Client
 * Handles XML envelope construction, credential injection, response parsing,
 * error handling, and pagination for all 4 Webbing web services.
 */

const WEBBING_SERVICES = {
  usage:    'https://wws.iamwebbing.com/usage/Usage.asmx',
  accounts: 'https://wws.iamwebbing.com/accounts/Accounts.asmx',
  devices:  'https://wws.iamwebbing.com/devices/Devices.asmx',
  service:  'https://wws.iamwebbing.com/service/Service.asmx'
};

const WEBBING_NS = 'http://wws.iamwebbing.com/';

// ── XML Helpers ──────────────────────────────────────────────────────────

function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildXmlFields(obj, indent = '        ') {
  let xml = '';
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      xml += `${indent}<${key}>\n${buildXmlFields(value, indent + '  ')}${indent}</${key}>\n`;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object') {
          xml += `${indent}<${key}>\n${buildXmlFields(item, indent + '  ')}${indent}</${key}>\n`;
        } else {
          xml += `${indent}<${key}>${escapeXml(item)}</${key}>\n`;
        }
      }
    } else {
      xml += `${indent}<${key}>${escapeXml(value)}</${key}>\n`;
    }
  }
  return xml;
}

function buildEnvelope(method, body, credentials) {
  const bodyXml = body ? buildXmlFields(body) : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header>
    <Credentials xmlns="${WEBBING_NS}">
      <Username>${escapeXml(credentials.username)}</Username>
      <Password>${escapeXml(credentials.password)}</Password>
      <WSKey>${escapeXml(credentials.wsKey)}</WSKey>
    </Credentials>
  </s:Header>
  <s:Body>
    <${method} xmlns="${WEBBING_NS}">
${bodyXml}    </${method}>
  </s:Body>
</s:Envelope>`;
}

// ── XML Response Parser ─────────────────────────────────────────────────

function parseXmlValue(text) {
  if (!text || text.trim() === '') return null;
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t) && t.length < 16) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

function xmlToJson(xml) {
  // Simple XML to JSON parser for SOAP responses
  const result = {};
  // Remove XML declaration and SOAP envelope
  let body = xml;

  // Extract content between soap:Body tags
  const bodyMatch = body.match(/<soap:Body>([\s\S]*)<\/soap:Body>/);
  if (bodyMatch) body = bodyMatch[1];

  return parseXmlNode(body.trim());
}

function parseXmlNode(xml) {
  if (!xml || xml.trim() === '') return null;

  const result = {};
  const tagRegex = /<([a-zA-Z0-9_:]+)([^>]*)>([\s\S]*?)<\/\1>/g;
  const selfCloseRegex = /<([a-zA-Z0-9_:]+)([^>]*)\s*\/>/g;
  let match;
  let hasChildren = false;

  // Handle self-closing tags
  while ((match = selfCloseRegex.exec(xml)) !== null) {
    const tagName = match[1].replace(/^[^:]+:/, ''); // Remove namespace prefix
    result[tagName] = null;
    hasChildren = true;
  }

  // Reset regex
  tagRegex.lastIndex = 0;

  // Handle regular tags
  const childCounts = {};
  const tempResults = {};

  // First pass: count occurrences
  const countXml = xml;
  const countRegex = /<([a-zA-Z0-9_:]+)(?:[^>]*)>[\s\S]*?<\/\1>/g;
  while ((match = countRegex.exec(countXml)) !== null) {
    const tagName = match[1].replace(/^[^:]+:/, '');
    childCounts[tagName] = (childCounts[tagName] || 0) + 1;
  }

  // Second pass: parse values
  while ((match = tagRegex.exec(xml)) !== null) {
    const tagName = match[1].replace(/^[^:]+:/, '');
    const content = match[3];
    hasChildren = true;

    // Check if content has child elements
    const hasChildElements = /<[a-zA-Z]/.test(content);

    let value;
    if (hasChildElements) {
      value = parseXmlNode(content);
    } else {
      value = parseXmlValue(content);
    }

    // If multiple elements with same name, make array
    if (childCounts[tagName] > 1) {
      if (!Array.isArray(result[tagName])) {
        result[tagName] = result[tagName] !== undefined ? [result[tagName]] : [];
      }
      result[tagName].push(value);
    } else {
      result[tagName] = value;
    }
  }

  if (!hasChildren) {
    return parseXmlValue(xml);
  }

  return result;
}

// ── SOAP Client ─────────────────────────────────────────────────────────

class WebbingClient {
  constructor(credentials) {
    this.credentials = {
      username: credentials.username || process.env.WEBBING_USERNAME,
      password: credentials.password || process.env.WEBBING_PASSWORD,
      wsKey:    credentials.wsKey    || process.env.WEBBING_WSKEY
    };
    this.retryDelay = 1000;
    this.maxRetries = 2;
  }

  /**
   * Make a SOAP request to a Webbing web service
   * @param {string} service - 'usage' | 'accounts' | 'devices' | 'service'
   * @param {string} method  - SOAP method name
   * @param {object} body    - Request body fields
   * @param {number} retries - Current retry count
   * @returns {object} Parsed response
   */
  async call(service, method, body = {}, retries = 0) {
    const url = WEBBING_SERVICES[service];
    if (!url) throw new Error(`Unknown Webbing service: ${service}`);

    const envelope = buildEnvelope(method, body, this.credentials);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': `${WEBBING_NS}${method}`
        },
        body: envelope
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const xml = await response.text();
      const parsed = xmlToJson(xml);

      // Navigate to the result object
      const responseKey = `${method}Response`;
      const resultKey = `${method}Result`;
      let result = parsed;
      if (result[responseKey]) result = result[responseKey];
      if (result[resultKey]) result = result[resultKey];

      // Check for API errors
      if (result.Success === false) {
        const code = result.ResponseCode || 'unknown';
        const desc = result.ResponseDescription || 'Unknown error';

        // Retry on transient errors (1000 = general error)
        if (code === 1000 && retries < this.maxRetries) {
          console.warn(`[Webbing] Error ${code}: ${desc} — retrying in ${this.retryDelay}ms (${retries + 1}/${this.maxRetries})`);
          await new Promise(r => setTimeout(r, this.retryDelay * (retries + 1)));
          return this.call(service, method, body, retries + 1);
        }

        throw new WebbingApiError(code, desc, method);
      }

      return result;
    } catch (err) {
      if (err instanceof WebbingApiError) throw err;
      if (retries < this.maxRetries) {
        console.warn(`[Webbing] Network error: ${err.message} — retrying (${retries + 1}/${this.maxRetries})`);
        await new Promise(r => setTimeout(r, this.retryDelay * (retries + 1)));
        return this.call(service, method, body, retries + 1);
      }
      throw err;
    }
  }

  // ── Convenience Methods ───────────────────────────────────────────────

  /**
   * Get paginated service devices
   */
  async getServiceDevices(options = {}) {
    const {
      branchId = 0, accountId = 0, assignmentId = 0,
      statusId, deviceTypeId, sdTypeId, onlyActive = false,
      iccid, imei, serial, ssid, eid,
      fromUpdatedAt, toUpdatedAt,
      page = 1, pageSize = 100
    } = options;

    const identifier = {};
    if (iccid) identifier.ICCID = iccid;
    if (imei) identifier.IMEI = imei;
    if (serial) identifier.Serial = serial;
    if (ssid) identifier.SSID = ssid;
    if (eid) identifier.EID = eid;

    const request = {
      GetServiceDevicesRequest: {
        ...(Object.keys(identifier).length > 0 ? { DeviceIdentifier: identifier } : {}),
        OnlyActivePlansDevices: onlyActive,
        BranchID: branchId,
        AccountID: accountId,
        AssignmentID: assignmentId,
        ...(statusId ? { SDStatusID: statusId } : {}),
        ...(deviceTypeId ? { DeviceTypeID: deviceTypeId } : {}),
        ...(sdTypeId ? { SDTypeID: sdTypeId } : {}),
        ...(fromUpdatedAt ? { FromUpdatedAtUtc: fromUpdatedAt } : {}),
        ...(toUpdatedAt ? { ToUpdatedAtUtc: toUpdatedAt } : {}),
        PaginationRequest: {
          PageSize: pageSize,
          PageNumber: page
        }
      }
    };

    return this.call('devices', 'GetServiceDevices', request);
  }

  /**
   * Get ALL service devices (auto-paginate)
   */
  async getAllServiceDevices(options = {}) {
    const pageSize = options.pageSize || 1000;
    let page = 1;
    let allDevices = [];
    let totalRecords = 0;

    do {
      const result = await this.getServiceDevices({ ...options, page, pageSize });
      const devices = normalizeArray(result.ServiceDevices?.ServiceDeviceRecord);
      allDevices = allDevices.concat(devices);

      totalRecords = result.PaginationResponse?.TotalRecords || 0;
      const totalPages = result.PaginationResponse?.TotalPages || 0;
      console.log(`[Webbing] Fetched page ${page}/${totalPages} (${allDevices.length}/${totalRecords} devices)`);

      page++;
      if (page > totalPages) break;

      // Small delay between pages to be nice to the API
      await new Promise(r => setTimeout(r, 200));
    } while (allDevices.length < totalRecords);

    return { devices: allDevices, total: totalRecords };
  }

  /**
   * Get live telemetry for a device
   */
  async getLiveData(identifier) {
    return this.call('service', 'GetSDLiveData', {
      GetSDLiveDataRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Get device location (cell tower triangulation)
   */
  async getLocation(identifier) {
    return this.call('service', 'GetLocationInfo', {
      GetLocationInfoRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Get data usage for a device
   */
  async getDeviceUsage(identifier, startDate, endDate, interval = 'Unknown') {
    return this.call('usage', 'GetDeviceUsage', {
      GetDeviceUsageRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier),
        AssignmentID: 0,
        ProductID: 0,
        StartDate: startDate,
        EndDate: endDate,
        DeviceTimeInterval: interval,  // 'Unknown' for total, 'ByDay', 'ByMonth'
        GroupByCountry: false,
        GroupByAssignment: false,
        GroupByApn: false,
        PaginationRequest: { PageSize: 1000, PageNumber: 1 }
      }
    });
  }

  /**
   * Get online/live usage counters
   */
  async getOnlineUsage(identifier) {
    return this.call('usage', 'GetOnlineDeviceUsage', {
      GetOnlineDeviceUsageRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Activate a service device
   */
  async activateDevice(identifier) {
    return this.call('devices', 'ActivateServiceDevice', {
      ActivateServiceDeviceRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Suspend a service device
   */
  async suspendDevice(identifier) {
    return this.call('devices', 'SuspendServiceDevice', {
      SuspendServiceDeviceRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Change carrier plan for a device
   */
  async changePlan(identifier, productId) {
    return this.call('devices', 'ChangeServiceDeviceProduct', {
      ChangeServiceDeviceProductRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier),
        ProductID: productId
      }
    });
  }

  /**
   * Get IMEI lock info
   */
  async getIMEILock(iccid) {
    return this.call('devices', 'GetIMEILock', {
      GetIMEILockRequest: {
        ICCID: iccid
      }
    });
  }

  /**
   * Set IMEI lock
   */
  async setIMEILock(locks) {
    // locks = [{ ICCID, IMEI }]
    return this.call('devices', 'SetIMEILock', {
      SetIMEILockRequest: {
        IMEILocks: { IMEILockRecord: locks }
      }
    });
  }

  /**
   * Send SMS to a device
   */
  async sendSMS(identifier, message) {
    return this.call('service', 'SendSMS', {
      SendSMSRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier),
        Message: message,
        DataCoding: 0 // ASCII
      }
    });
  }

  /**
   * Search branches
   */
  async searchBranches(searchText = '', page = 1, pageSize = 100) {
    return this.call('accounts', 'SearchBranches', {
      SearchBranchesRequest: {
        SearchText: searchText,
        PaginationRequest: { PageSize: pageSize, PageNumber: page }
      }
    });
  }

  /**
   * Get a single service device by ICCID, IMEI, or ServiceDeviceID
   */
  async getServiceDevice(identifier) {
    return this.call('devices', 'GetServiceDevice', {
      GetServiceDeviceRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Search accounts by branchId
   */
  async searchAccounts(branchId, page = 1, pageSize = 100) {
    return this.call('accounts', 'SearchAccounts', {
      SearchAccountsRequest: {
        BranchID: branchId,
        PaginationRequest: { PageSize: pageSize, PageNumber: page }
      }
    });
  }

  /**
   * Search assignments by accountId (returns ServiceDeviceIDs)
   */
  async searchAssignments(accountId, page = 1, pageSize = 100) {
    return this.call('devices', 'SearchAssignments', {
      SearchAssignmentsRequest: {
        AccountID: accountId,
        PaginationRequest: { PageSize: pageSize, PageNumber: page }
      }
    });
  }

  /**
   * Get products list
   */
  async getProducts(page = 1, pageSize = 100) {
    return this.call('service', 'GetProductsList', {
      GetProductsListRequest: {
        PaginationRequest: { PageSize: pageSize, PageNumber: page }
      }
    });
  }

  /**
   * Get countries list
   */
  async getCountries() {
    return this.call('service', 'GetCountriesList', {
      PaginationRequest: { PageSize: 1000, PageNumber: 1 }
    });
  }

  /**
   * Get usage by country
   */
  async getCountryUsage(startDate, endDate) {
    return this.call('usage', 'GetCountryUsage', {
      GetCountryUsageRequest: {
        StartDate: startDate,
        EndDate: endDate,
        PaginationRequest: { PageSize: 1000, PageNumber: 1 }
      }
    });
  }

  /**
   * Get service plans list
   */
  async getServicePlans(page = 1, pageSize = 100) {
    return this.call('service', 'GetServicePlansList', {
      GetServicePlansListRequest: {
        PaginationRequest: { PageSize: pageSize, PageNumber: page }
      }
    });
  }

  /**
   * Search eSIM profiles (find available profiles in a branch)
   */
  async searchESIMProfiles(options = {}) {
    const { branchId, wirelessCarrierId, statusId, iccid, page = 1, pageSize = 100 } = options;
    return this.call('service', 'SearchESIMProfiles', {
      SearchESIMProfilesRequest: {
        ...(branchId ? { BranchID: branchId } : {}),
        ...(wirelessCarrierId ? { WirelessCarrierID: wirelessCarrierId } : {}),
        ...(statusId !== undefined ? { StatusID: statusId } : {}),
        ...(iccid ? { ICCID: iccid } : {}),
        PaginationRequest: { PageSize: pageSize, PageNumber: page }
      }
    });
  }

  /**
   * Get eSIM subscription status for a device
   */
  async getESIMSubscription(identifier) {
    return this.call('service', 'GetESIMSubscription', {
      GetESIMSubscriptionRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Match an EID to an eSIM profile
   */
  async esimEIDMatch(identifier, eid) {
    return this.call('service', 'ESIMEIDMatch', {
      ESIMEIDMatchRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier),
        EID: eid
      }
    });
  }

  /**
   * Remove EID from an eSIM profile
   */
  async removeESIMEID(identifier) {
    return this.call('service', 'RemoveESIMEID', {
      RemoveESIMEIDRequest: {
        ServiceDeviceIdentifier: buildIdentifier(identifier)
      }
    });
  }

  /**
   * Get eSIM profile by ID
   */
  async getESIMProfile(profileId) {
    return this.call('service', 'GetESIMProfile', {
      GetESIMProfileRequest: {
        ID: profileId
      }
    });
  }

  /**
   * Get list of eSIM profile statuses
   */
  async getESIMProfileStatuses() {
    return this.call('service', 'GetESIMProfileStatusesList', {});
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildIdentifier(id) {
  if (typeof id === 'object') return id;
  if (typeof id === 'number') return { ServiceDeviceID: id };
  // Try to guess identifier type
  if (/^\d{15}$/.test(id)) return { IMEI: id };
  if (/^\d{19,20}$/.test(id)) return { ICCID: id };
  return { ServiceDeviceID: parseInt(id, 10) || 0 };
}

function normalizeArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

class WebbingApiError extends Error {
  constructor(code, description, method) {
    super(`Webbing API Error [${code}] in ${method}: ${description}`);
    this.code = code;
    this.description = description;
    this.method = method;
  }
}

module.exports = { WebbingClient, WebbingApiError, WEBBING_SERVICES, normalizeArray };
