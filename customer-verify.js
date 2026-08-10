const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const tls = require('tls');
const https = require('https');
const http = require('http');

let freeDomains = [];
try {
  freeDomains = require('./free-email-domains.json');
} catch (e) {
  console.warn('[CustomerVerify] Could not load free-email-domains.json, continuing without it.');
}

const FREE_EMAIL_DOMAINS = new Set(freeDomains);
const DISPOSABLE_PATTERNS = ['tempmail', 'throwaway', 'guerrilla', 'mailinator', 'yopmail', 'sharklasers', 'guerrillamail', 'grr.la', 'dispostable', 'maildrop'];

class CustomerVerifyService {
  constructor(config = {}) {
    this.hunterApiKey = config.hunterApiKey || process.env.HUNTER_API_KEY;
    
    if (!this.hunterApiKey) {
      console.log('[CustomerVerify] Running in MOCK mode — set HUNTER_API_KEY for live verification');
    }

    const railwayDataDir = '/data';
    const localDataDir = path.join(__dirname, 'data');
    this.dataDir = fs.existsSync(railwayDataDir) ? railwayDataDir : localDataDir;
    
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.resultsFile = path.join(this.dataDir, 'verification-results.json');
    this.results = {};
    
    if (fs.existsSync(this.resultsFile)) {
      try {
        const fileContent = fs.readFileSync(this.resultsFile, 'utf8');
        this.results = JSON.parse(fileContent);
      } catch (err) {
        console.error('[CustomerVerify] Failed to load results JSON', err.message);
      }
    }
  }

  classifyEmail(email) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return { status: 'fail', type: 'invalid', isDisposable: false };
    if (FREE_EMAIL_DOMAINS.has(domain)) return { status: 'fail', type: 'free', isDisposable: false };
    if (DISPOSABLE_PATTERNS.some(p => domain.includes(p))) return { status: 'fail', type: 'disposable', isDisposable: true };
    return { status: 'pass', type: 'business', isDisposable: false };
  }

  _mockEmailVerification(email) {
    return { status: 'pass', result: 'deliverable', score: 93, isDeliverable: true, smtpValid: true, mxRecords: true, source: 'mock' };
  }

  async verifyEmail(email) {
    if (!this.hunterApiKey) return this._mockEmailVerification(email);
    
    const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${this.hunterApiKey}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.errors) throw new Error(json.errors[0]?.details || 'Hunter API error');
    
    const d = json.data;
    return {
      status: d.result === 'deliverable' ? 'pass' : (d.result === 'risky' ? 'warn' : 'fail'),
      result: d.result,
      score: d.score,
      isDeliverable: d.result === 'deliverable' || d.result === 'risky',
      smtpValid: d.smtp_check,
      mxRecords: d.mx_records,
      source: 'hunter.io'
    };
  }

  async verifyDomain(domain) {
    const results = {
      status: 'pass',
      hasMxRecords: false,
      hasARecord: false,
      hasValidSSL: false,
      sslIssuer: null,
      sslExpiry: null,
      websiteResponds: false,
      httpStatus: null,
      domainAge: null 
    };

    try {
      const mx = await dns.resolveMx(domain);
      results.hasMxRecords = mx && mx.length > 0;
    } catch (e) { }

    try {
      const addrs = await dns.resolve4(domain);
      results.hasARecord = addrs && addrs.length > 0;
    } catch (e) { }

    try {
      const sslResult = await new Promise((resolve, reject) => {
        const socket = tls.connect(443, domain, { servername: domain, timeout: 5000 }, () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          resolve({
            valid: !socket.authorizationError,
            issuer: cert.issuer?.O || cert.issuer?.CN || 'Unknown',
            expiry: cert.valid_to
          });
        });
        socket.on('error', (e) => resolve(null));
        socket.setTimeout(5000, () => { socket.destroy(); resolve(null); });
      });
      if (sslResult) {
        results.hasValidSSL = sslResult.valid;
        results.sslIssuer = sslResult.issuer;
        results.sslExpiry = sslResult.expiry;
      }
    } catch (e) { }

    try {
      const statusCode = await new Promise((resolve) => {
        const req = https.get(`https://${domain}`, { timeout: 8000 }, (resp) => {
          resolve(resp.statusCode);
          resp.resume();
        });
        req.on('error', () => {
          const req2 = http.get(`http://${domain}`, { timeout: 8000 }, (resp) => {
            resolve(resp.statusCode);
            resp.resume();
          });
          req2.on('error', () => resolve(null));
          req2.setTimeout(8000, () => { req2.destroy(); resolve(null); });
        });
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      });
      if (statusCode) {
        results.websiteResponds = statusCode >= 200 && statusCode < 400;
        results.httpStatus = statusCode;
      }
    } catch (e) { }

    const checks = [results.hasMxRecords, results.hasARecord || results.websiteResponds];
    results.status = checks.every(Boolean) ? 'pass' : (checks.some(Boolean) ? 'warn' : 'fail');

    return results;
  }

  _mockCompanyEnrichment(domain) {
    const companyName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
    return {
      status: 'found',
      companyName: companyName,
      industry: 'Technology',
      employeeCount: '51-200',
      description: `Simulated mock company data for ${companyName}`,
      linkedinUrl: `https://linkedin.com/company/${companyName.toLowerCase()}`,
      twitterUrl: null,
      facebookUrl: null,
      country: 'United States',
      city: 'San Francisco',
      emailCount: 42,
      source: 'mock'
    };
  }

  async enrichCompany(domain) {
    if (!this.hunterApiKey) return this._mockCompanyEnrichment(domain);
    
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${this.hunterApiKey}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.errors) return { status: 'unavailable', source: 'hunter.io' };
    
    const d = json.data;
    return {
      status: d.organization ? 'found' : 'unavailable',
      companyName: d.organization || null,
      industry: d.industry || null,
      employeeCount: d.company_type || null,
      description: d.description || null,
      linkedinUrl: d.linkedin || null,
      twitterUrl: d.twitter || null,
      facebookUrl: d.facebook || null,
      country: d.country || null,
      city: d.city || null,
      emailCount: d.total || 0,
      source: 'hunter.io'
    };
  }

  calculateTrustScore(emailClass, emailVerify, domainVerify, companyEnrich) {
    let score = 0;
    
    if (emailVerify.isDeliverable) score += 25;
    if (domainVerify.hasValidSSL) score += 15;
    if (domainVerify.websiteResponds) score += 20;
    if (domainVerify.hasMxRecords) score += 10;
    if (domainVerify.hasARecord) score += 5;
    if (companyEnrich.status === 'found') score += 15;
    if (emailVerify.smtpValid) score += 10;
    
    return Math.min(score, 100);
  }

  getDecision(score) {
    if (score >= 80) return 'auto_approved';
    if (score >= 50) return 'needs_review';
    return 'rejected';
  }

  async verify(email) {
    email = email.trim().toLowerCase();
    const domain = email.split('@')[1];
    
    console.log(`[CustomerVerify] Verifying: ${email}`);
    
    const emailClassification = this.classifyEmail(email);
    
    if (emailClassification.status === 'fail') {
      const result = {
        email,
        domain,
        trustScore: 0,
        decision: 'rejected',
        reason: `${emailClassification.type} email provider`,
        verifiedAt: new Date().toISOString(),
        checks: {
          emailClassification,
          emailVerification: { status: 'skipped', reason: 'Failed classification' },
          domainVerification: { status: 'skipped', reason: 'Failed classification' },
          companyEnrichment: { status: 'skipped', reason: 'Failed classification' }
        }
      };
      this._saveResult(result);
      return result;
    }
    
    const [emailVerification, domainVerification, companyEnrichment] = await Promise.all([
      this.verifyEmail(email).catch(e => ({ status: 'error', error: e.message })),
      this.verifyDomain(domain).catch(e => ({ status: 'error', error: e.message })),
      this.enrichCompany(domain).catch(e => ({ status: 'error', error: e.message }))
    ]);
    
    const trustScore = this.calculateTrustScore(emailClassification, emailVerification, domainVerification, companyEnrichment);
    const decision = this.getDecision(trustScore);
    
    const result = {
      email,
      domain,
      trustScore,
      decision,
      verifiedAt: new Date().toISOString(),
      checks: {
        emailClassification,
        emailVerification,
        domainVerification,
        companyEnrichment
      }
    };
    
    this._saveResult(result);
    console.log(`[CustomerVerify] ${email} → Score: ${trustScore}, Decision: ${decision}`);
    return result;
  }

  _saveResult(result) {
    this.results[result.email] = result;
    try {
      fs.writeFileSync(this.resultsFile, JSON.stringify(this.results, null, 2));
    } catch (e) {
      console.error('[CustomerVerify] Failed to save results:', e.message);
    }
  }

  getResults() {
    return Object.values(this.results).sort((a, b) => new Date(b.verifiedAt) - new Date(a.verifiedAt));
  }

  getResult(email) {
    return this.results[email.toLowerCase()] || null;
  }

  deleteResult(email) {
    const key = email.toLowerCase();
    if (this.results[key]) {
      delete this.results[key];
      try { fs.writeFileSync(this.resultsFile, JSON.stringify(this.results, null, 2)); } catch(e) {}
      return true;
    }
    return false;
  }
}

module.exports = { CustomerVerifyService };
