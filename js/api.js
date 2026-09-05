/* =============================================
   api.js — All API calls to PHP backend
   ============================================= */

// Auto-detect base path so the app works whether hosted at:
//   yourdomain.com/          → base = '/api/'
//   yourdomain.com/newcrm/   → base = '/newcrm/api/'
// Just make sure index.html is always at the project root.
const _scriptBase = (() => {
  const scripts = document.querySelectorAll('script[src]');
  for (const s of scripts) {
    if (s.src.includes('api.js')) {
      // s.src is absolute, e.g. https://host/newcrm/js/api.js
      // Go up from /js/ to project root
      return s.src.replace(/\/js\/api\.js.*$/, '/');
    }
  }
  // Fallback: use current page location (works if index.html is at root)
  return window.location.href.replace(/[^/]*$/, '');
})();

const API = {
  base: _scriptBase + 'api/',

  async get(endpoint, params = {}) {
    const url = new URL(this.base + endpoint);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async post(endpoint, data = {}) {
    const res = await fetch(this.base + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  // DASHBOARD
  async getDashboard() { return this.get('dashboard.php'); },

  // CLIENTS
  async getClients(search = '') { return this.get('clients.php', { search }); },
  async addClient(data)         { return this.post('clients.php', { action: 'add', ...data }); },
  async getClient(id)           { return this.get('clients.php', { id }); },
  async updateClient(data)      { return this.post('clients.php', { action: 'update', ...data }); },
  async deleteClient(id)        { return this.post('clients.php', { action: 'delete', id }); },

  // RECORDS
  async getRecords(params = {}) { return this.get('records.php', params); },
  async addRecord(data)         { return this.post('records.php', { action: 'add', ...data }); },

  // TRANSACTIONS (Add Transaction / Transaction History)
  async addPayment(data)             { return this.post('records.php', { action: 'add_payment', ...data }); },
  async getTransactionHistory(params = {}) { return this.get('records.php', { history: 1, ...params }); },

  // FOLLOWUPS
  async getFollowups(params = {})  { return this.get('followups.php', params); },
  async addFollowup(data)          { return this.post('followups.php', { action: 'add', ...data }); },
  async updateFollowup(data)       { return this.post('followups.php', { action: 'update', ...data }); },

  // MESSAGE TEMPLATES (Quick Message)
  async getMessageTemplates()      { return this.get('messages.php'); },
  async addMessageTemplate(data)   { return this.post('messages.php', { action: 'add_template', ...data }); },
  async updateMessageTemplate(data){ return this.post('messages.php', { action: 'update_template', ...data }); },
  async deleteMessageTemplate(id)  { return this.post('messages.php', { action: 'delete_template', id }); },
  async logMessageSent(data)       { return this.post('messages.php', { action: 'log_sent', ...data }); },

  // SYSTEM ID CHECKER
  async checkSystemId(id) { return this.get('systemid.php', { check: id }); },

  // LOGS
  async getLogs() { return this.get('logs.php'); },

  // SYNC
  async checkSync(since = 0) { return this.get('sync.php', { since }); },
};