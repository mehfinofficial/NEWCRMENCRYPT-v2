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

  // Both get() and post() parse the JSON body even on a non-2xx response
  // (rather than just throwing "HTTP 403") and attach it to the thrown
  // Error as `.body`, with `.status` alongside it. That's what lets a
  // caller distinguish a permission_denied 403 from any other failure and
  // react to it specifically (e.g. show the Permission Denied modal)
  // instead of every failed call collapsing into the same generic catch.
  async get(endpoint, params = {}) {
    const url = new URL(this.base + endpoint);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res  = await fetch(url, { credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body   = body;
      throw err;
    }
    return body;
  },

  async post(endpoint, data = {}) {
    const res = await fetch(this.base + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body   = body;
      throw err;
    }
    return body;
  },

  // DASHBOARD
  async getDashboard() { return this.get('dashboard.php'); },

  // CLIENTS
  async getClients(search = '') { return this.get('clients.php', { search }); },
  async getClientsForRenewals() { return this.get('clients.php', { context: 'renewals' }); },
  async addClient(data)         { return this.post('clients.php', { action: 'add', ...data }); },
  async getClient(id)           { return this.get('clients.php', { id }); },
  async updateClient(data)      { return this.post('clients.php', { action: 'update', ...data }); },
  async deleteClient(id)        { return this.post('clients.php', { action: 'delete', id }); },

  // RECORDS
  async getRecords(params = {}) { return this.get('records.php', params); },
  async addRecord(data)         { return this.post('records.php', { action: 'add', ...data }); },
  async updateRecord(data)      { return this.post('records.php', { action: 'update', ...data }); },
  async deleteRecord(id)        { return this.post('records.php', { action: 'delete', id }); },

  // TRANSACTIONS (Add Transaction / Transaction History)
  async addPayment(data)             { return this.post('records.php', { action: 'add_payment', ...data }); },
  async updatePayment(data)          { return this.post('records.php', { action: 'update', ...data }); },
  async getTransactionHistory(params = {}) { return this.get('records.php', { history: 1, ...params }); },

  // FOLLOWUPS
  async getFollowups(params = {})  { return this.get('followups.php', params); },
  async addFollowup(data)          { return this.post('followups.php', { action: 'add', ...data }); },
  async updateFollowup(data)       { return this.post('followups.php', { action: 'update', ...data }); },
  async editFollowup(data)         { return this.post('followups.php', { action: 'edit', ...data }); },
  async deleteFollowup(id)         { return this.post('followups.php', { action: 'delete', id }); },

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

  // USER MANAGEMENT (Add User / Set User — admin only, enforced server-side
  // by users.php regardless of what the client sends)
  async getUsers()               { return this.get('users.php'); },
  async addUser(data)            { return this.post('users.php', { action: 'add', ...data }); },
  async applyRolePreset(data)    { return this.post('users.php', { action: 'apply_role_preset', ...data }); },
  async setUserPermissions(data) { return this.post('users.php', { action: 'set_permissions', ...data }); },

  // ARCHIVES (Archives FAB — admin only)
  async getArchives()          { return this.get('archive.php'); },
  async restoreArchived(data)  { return this.post('archive.php', { action: 'restore', ...data }); },
  async purgeArchived(data)    { return this.post('archive.php', { action: 'purge', ...data }); },

  // SYNC
  async checkSync(since = 0) { return this.get('sync.php', { since }); },

  // FILE MANAGER
  async getFiles(params = {})         { return this.get('files.php', params); },
  async getFilesForRecord(recordId)   { return this.get('files.php', { record_id: recordId }); },
  async getFileInfo(id)               { return this.get('files.php', { info: id }); },
  async generateFileLink(id)          { return this.post('files.php', { action: 'generate_link', id }); },
  // Multipart upload — bypasses the JSON post() helper since a file can't
  // be JSON-encoded. Same base URL / credentials behavior as the rest of API.
  async uploadFile(file, { recordId, account } = {}) {
    const fd = new FormData();
    fd.append('action', 'upload');
    fd.append('file', file);
    if (recordId) fd.append('record_id', recordId);
    if (account)  fd.append('account', account);
    const res = await fetch(this.base + 'files.php', {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
};