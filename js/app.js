/* =============================================
   app.js — SPA Logic, Rendering, Interactions
   ============================================= */

/* ---- STATE ---- */
let currentPage = 'dashboard';
let allClients  = [];
let allRecords  = [];
let allFollowups = [];
let queriesView = 'records'; // 'records' | 'followups' — sub-view inside the merged Queries page

/* ---- SMART POLLING ---- */
let _pollTimer     = null;
let _lastSyncTs    = 0;      // unix timestamp of last known server change
let _pollPaused    = false;  // pause while user is typing

const POLL_INTERVAL = 5000;  // 5 seconds — lightweight since 99% are just a timestamp check

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(_pollTick, POLL_INTERVAL);
}

async function _pollTick() {
  if (_pollPaused) return;
  if (document.querySelector('.modal-overlay.open')) return; // skip if modal open

  try {
    const res = await API.get('sync.php', { since: _lastSyncTs });
    if (!res.changed) return; // nothing changed — skip silently

    _lastSyncTs = res.server_ts;
    _silentRefresh();
    _refreshPermissions();
  } catch(e) {
    // sync.php runs requireAuth() same as everything else, so if the
    // account was just disabled or its login-hours window just closed,
    // THIS poll can be the very request that trips enforceAccountAccess()
    // and tears down the session server-side — that comes back as a 401.
    // That's the one case this catch must not swallow: without this, the
    // session dies on the server but the SPA never notices, so the
    // "kicked within ~5s" behavior silently never reached the user.
    // Everything else (network blips, etc.) is still swallowed as before.
    if (e.status === 401) {
      showToast((e.body && e.body.error) || 'Your session has ended. Please log in again.');
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
  }
}

// Re-checks this session's own role/permissions against the server and
// re-applies the UI if an admin changed them elsewhere (Set User bumps
// sync just like any other write, so this rides the same poll tick
// instead of needing its own timer). Backend enforcement was already
// live on every request regardless — this just keeps the UI (which
// buttons/screens show) from going stale until next login/refresh.
async function _refreshPermissions() {
  try {
    const res  = await fetch('api/auth.php?action=check', { credentials: 'include' });
    const data = await res.json();

    if (!data.logged_in) {
      // Session no longer valid — bounce to login rather than let the
      // user keep interacting with a UI that can't actually do anything.
      showToast('Your session has ended. Please log in again.');
      setTimeout(() => window.location.reload(), 1500);
      return;
    }

    const changed = data.role !== currentRole
      || JSON.stringify(data.permissions) !== JSON.stringify(currentPermissions);
    if (!changed) return;

    setPermissions(data.role, data.permissions);
    showToast('Your permissions were updated by an admin');

    // The screen currently open may no longer be allowed — same checks
    // navigate() itself would apply, just re-run reactively here.
    if (currentPage === 'clients' && !can('view_clients')) navigate('dashboard');
    if (currentPage === 'logs' && !isAdmin())               navigate('dashboard');
    if (currentPage === 'queries'
        && !can(queriesView === 'followups' ? 'view_followups' : 'view_records')) {
      navigate('dashboard');
    }
  } catch(e) { /* swallow — background check, not user-initiated */ }
}

function localDateStr() {
  // "Today" as the server sees it (Asia/Kolkata), not the device's own
  // timezone — keeps new records/follow-ups dated the same day the
  // server/dashboard consider "today", even if a phone is misconfigured
  // or the user is travelling outside India.
  return todayIST();
}

// Today's calendar date in Asia/Kolkata, as "YYYY-MM-DD", regardless of
// the device's own timezone setting.
function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Turns a "YYYY-MM-DD" calendar date into a UTC-anchored Date object.
// Using Date.UTC (instead of `new Date(dateStr)`) makes day-difference
// math exact — it sidesteps the JS quirk where date-only strings parse
// as UTC midnight while `new Date()` + setHours(0,0,0,0) is local midnight,
// which can silently shift a diff by up to a day.
function dayDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

// Whole-day difference between a "YYYY-MM-DD" date and today (IST).
function daysFromToday(dateStr) {
  return Math.round((dayDate(dateStr) - dayDate(todayIST())) / 86400000);
}

// Human-friendly day label for a reminder date — shared by the follow-up
// detail modal and the dashboard "Follow-up Today" cards so both agree on
// wording (Overdue / Today / Tomorrow / In N days).
function urgencyLabel(dateStr) {
  if (!dateStr) return null;
  const diff = daysFromToday(dateStr);
  if (diff < 0)   return 'Overdue';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `In ${diff} days`;
}

function _silentRefresh() {
  switch (currentPage) {
    case 'dashboard': loadDashboard();                                                  break;
    case 'clients':   loadClients(document.getElementById('clientSearch')?.value);     break;
    case 'queries':
      if (queriesView === 'records') loadRecords(document.getElementById('recordSearch')?.value);
      else                           loadFollowups(document.getElementById('followupSearch')?.value);
      break;
    case 'logs':      loadLogs();                                                       break;
  }
}

// Pause while user is typing so we don't re-render mid-input
document.addEventListener('focusin',  e => { if (e.target.matches('input,textarea,select')) _pollPaused = true; });
document.addEventListener('focusout', e => { if (e.target.matches('input,textarea,select')) _pollPaused = false; });

/* ---- NAVIGATION ---- */
function navigate(page) {
  // Logs is a hard admin-only gate (unrelated to the toggleable view_*
  // permissions), so it still blocks navigation outright. Clients/Queries
  // are NOT blocked here anymore — the page always opens, and
  // loadClients()/loadRecords()/loadFollowups() render a Permission Denied
  // placeholder in the list area instead if the user isn't allowed to view it.
  if (page === 'logs' && !isAdmin()) { showPermissionDenied(); return; }

  closeFabSheet();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Clear all search bars on every tab switch — a leftover query from one
  // tab shouldn't sit stale in its box when the user comes back to it later.
  ['clientSearch', 'recordSearch', 'followupSearch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

  const titles = {
    dashboard: 'Dashboard', clients: 'Clients',
    queries: 'Queries', logs: 'Logs',
    profile: 'Profile'
  };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  currentPage = page;

  // Scroll to top on page switch
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Show/hide floating pills
  const clientPill = document.getElementById('addClientPill');
  if (clientPill) {
    if (page === 'clients') {
      setTimeout(() => clientPill.classList.add('visible'), 80);
    } else {
      clientPill.classList.remove('visible');
    }
  }
  // Records/Follow-up pills are controlled by setQueriesView() since they
  // depend on which sub-view of the merged Queries page is active.
  if (page !== 'queries') {
    document.getElementById('addRecordPill')?.classList.remove('visible');
    document.getElementById('addFollowupPill')?.classList.remove('visible');
  }

  // Lazy load data
  if (page === 'dashboard') loadDashboard();
  if (page === 'clients')   loadClients();
  if (page === 'queries')   setQueriesView(queriesView);
  if (page === 'logs')      loadLogs();

  // Reset records date filter when leaving the queries page
  if (page !== 'queries') {
    resetRecordFilter();
    resetFollowupFilter();
  }
}

// Resets the Records sub-view's filter/date state back to "All".
function resetRecordFilter() {
  recordFilter = 'all';
  recordDateFilter = '';
  const lbl = document.getElementById('dateChipLabel');
  const inp = document.getElementById('recordDateInput');
  const chips = document.querySelectorAll('#recordFilters .chip');
  if (lbl) lbl.textContent = 'Filter by Date';
  if (inp) inp.value = '';
  chips.forEach(c => c.classList.remove('active'));
  const allChip = document.querySelector('#recordFilters .chip[data-filter="all"]');
  if (allChip) allChip.classList.add('active');
}

// Resets the Follow-ups sub-view's filter state back to "All".
function resetFollowupFilter() {
  followupFilter = 'all';
  document.querySelectorAll('#page-followups .chip').forEach(c => c.classList.remove('active'));
  const allChip = document.querySelector('#page-followups .chip[data-filter="all"]');
  if (allChip) allChip.classList.add('active');
}

/* ---- QUERIES (Records + Follow-ups merged view) ---- */

// Switches the sub-view inside the Queries page and loads its data.
// Also the entry point used by dashboard shortcuts (navigateQueries).
function setQueriesView(view) {
  const target = view === 'followups' ? 'followups' : 'records';
  // No permission gate here anymore — the toggle always switches sub-view,
  // same as navigate()'s Clients gate above. loadRecords()/loadFollowups()
  // render the in-page Permission Denied placeholder themselves if the
  // user isn't allowed to view that sub-view.

  const prevView = queriesView;
  queriesView = target;

  // Switching sub-view is a fresh look at that list, not a continuation —
  // drop whatever filter/date was applied on either side so "Pending" on
  // Records doesn't silently linger when you come back to it later.
  if (queriesView !== prevView) {
    resetRecordFilter();
    resetFollowupFilter();
  }

  document.querySelectorAll('#queriesToggle .queries-toggle__btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === queriesView);
  });

  document.getElementById('page-records')?.classList.toggle('active', queriesView === 'records');
  document.getElementById('page-followups')?.classList.toggle('active', queriesView === 'followups');

  const recordPill   = document.getElementById('addRecordPill');
  const followupPill = document.getElementById('addFollowupPill');
  if (recordPill)   recordPill.classList.toggle('visible', queriesView === 'records');
  if (followupPill) followupPill.classList.toggle('visible', queriesView === 'followups');

  if (queriesView === 'records') loadRecords();
  else                           loadFollowups();
}

// Jump straight to the Queries page on a specific sub-view (used by
// dashboard's "View All" shortcuts and the bottom-nav Queries item).
function navigateQueries(view) {
  queriesView = view === 'followups' ? 'followups' : 'records';
  navigate('queries'); // navigate() calls setQueriesView(queriesView) internally
}

/* ---- FAB QUICK-ACTION SHEET ---- */
let fabSheetOpen = false;

function toggleFabSheet() {
  fabSheetOpen ? closeFabSheet() : openFabSheet();
}

function openFabSheet() {
  fabSheetOpen = true;
  document.getElementById('fabSheet')?.classList.add('open');
  document.getElementById('fabBackdrop')?.classList.add('open');
  document.getElementById('navFab')?.classList.add('is-open');
  document.body.classList.add('no-scroll');
}

function closeFabSheet() {
  fabSheetOpen = false;
  document.getElementById('fabSheet')?.classList.remove('open');
  document.getElementById('fabBackdrop')?.classList.remove('open');
  document.getElementById('navFab')?.classList.remove('is-open');
  document.body.classList.remove('no-scroll');
}

// Routes each quick-action sheet item to its screen. Items not built yet
// fall through to the "coming soon" toast at the bottom.
function fabAction(label) {
  closeFabSheet();

  switch (label) {
    case 'Add Client':
      if (!can('can_add_client')) { showPermissionDenied(); return; }
      navigate('clients');
      openModal('addClientModal');
      populateSoftwareTypes();
      return;

    case 'Add New Record':
      if (!can('can_add_record')) { showPermissionDenied(); return; }
      navigateQueries('records');
      openModal('addRecordModal');
      populateClientSelect();
      populateServiceSelect();
      return;

    case 'Add New Follow-up':
      if (!can('can_add_followup')) { showPermissionDenied(); return; }
      navigateQueries('followups');
      openModal('addFollowupModal');
      populateFollowupClientSelect();
      return;

    case 'Pending Records':
      if (!can('access_pending_records')) { showPermissionDenied(); return; }
      navigateQueries('records');
      // Select the "Pending" filter chip and reload with it applied.
      document.querySelectorAll('#recordFilters .chip').forEach(c => c.classList.remove('active'));
      document.querySelector('#recordFilters .chip[data-filter="pending"]')?.classList.add('active');
      recordFilter = 'pending';
      recordDateFilter = '';
      loadRecords();
      return;

    case 'Quick Message':
      if (!can('access_quick_message')) { showPermissionDenied(); return; }
      openQuickMessage();
      return;

    case 'Upcoming Renewals':
      openRenewalsList();
      return;

    case 'Quick Links':
      if (!can('access_quick_links')) { showPermissionDenied(); return; }
      openQuickLinks();
      return;

    case 'System ID Checker':
      openSystemIdChecker();
      return;

    case 'Inactive Clients':
      openInactiveClientsList();
      return;

    case 'Add Transaction':
      openAddTransactionModal();
      return;

    case 'Transaction History':
      openTransactionHistory();
      return;

    case 'File Manager':
      if (!can('access_file_manager')) { showPermissionDenied(); return; }
      openFileManager();
      return;

    case 'Add User':
      if (!isAdmin()) { showPermissionDenied('Only admins can add staff accounts.'); return; }
      openModal('addUserModal');
      return;

    case 'Set User':
      if (!isAdmin()) { showPermissionDenied('Only admins can manage staff permissions.'); return; }
      openModal('setUserModal');
      loadSetUserList();
      return;

    case 'Archives':
      if (!isAdmin()) { showPermissionDenied('Only admins can access Archives.'); return; }
      openModal('archivesModal');
      loadArchivesList();
      return;
  }

  showToast(`${label} — coming soon`);
}

/* ---- PROFILE MENU ---- */
let profileMenuOpen = false;

function toggleProfileMenu() {
  profileMenuOpen = !profileMenuOpen;
  document.getElementById('profileMenu').classList.toggle('open', profileMenuOpen);
}

document.addEventListener('click', e => {
  if (profileMenuOpen && !e.target.closest('#profileBtn') && !e.target.closest('#profileMenu')) {
    profileMenuOpen = false;
    document.getElementById('profileMenu').classList.remove('open');
  }
});

function setUserInfo(username, userid) {
  const initial = (username || 'A')[0].toUpperCase();
  document.getElementById('userAvatar').textContent     = initial;
  document.getElementById('pmAvatar').textContent       = initial;
  document.getElementById('pmName').textContent         = username || 'Admin';
  document.getElementById('pmId').textContent           = '#' + String(userid || 1).padStart(3, '0');

  // New Profile page (bottom-nav tab) — separate markup, same info
  const profAvatar = document.getElementById('profAvatar');
  const profName   = document.getElementById('profName');
  const profId     = document.getElementById('profId');
  if (profAvatar) profAvatar.textContent = initial;
  if (profName)   profName.textContent   = username || 'Admin';
  if (profId)     profId.textContent     = '#' + String(userid || 1).padStart(3, '0');
}

/* ---- PERMISSIONS ----
   Set once after login/session-check from the server's response — never
   computed or trusted from anything else client-side. This state only
   controls what the UI *shows*; every actual gate is re-checked by the
   PHP endpoint on every request, so a user editing localStorage or the
   in-memory object here can't grant themselves anything the backend
   won't also allow. */
let currentRole = 'viewer';
let currentPermissions = {};

function setPermissions(role, permissions) {
  currentRole = role || 'viewer';
  currentPermissions = permissions || {};
  applyPermissionUI();
}

function can(key) {
  return !!currentPermissions[key];
}

// Role check for the Add User / Set User / Archives FAB items — these
// aren't gated by a permission key like everything else, they're
// hard-gated to the admin role only (see users.php's comment on why).
function isAdmin() {
  return currentRole === 'admin';
}

// Re-applies permission-driven visibility to whatever's currently on
// screen. Called once after login/session-check, and again any time a
// screen that has gated controls re-renders (e.g. opening a client's
// detail modal).
function applyPermissionUI() {
  const clientPill = document.getElementById('addClientPill');
  if (clientPill) clientPill.classList.toggle('perm-hidden', !can('can_add_client'));
  const recordPill = document.getElementById('addRecordPill');
  if (recordPill) recordPill.classList.toggle('perm-hidden', !can('can_add_record'));
  const followupPill = document.getElementById('addFollowupPill');
  if (followupPill) followupPill.classList.toggle('perm-hidden', !can('can_add_followup'));

  document.querySelectorAll('.admin-fab').forEach(el => el.classList.toggle('perm-hidden', !isAdmin()));

  document.getElementById('viewLogsRow')?.classList.toggle('perm-hidden', !isAdmin());
}

// Renders a "Permission denied" placeholder (icon + text) inside a
// screen's list area, in place of its cards/data. Used instead of hiding
// the nav entry point entirely — the Clients/Records/Follow-ups tabs and
// the Queries sub-toggle always stay visible and tappable; if the user
// isn't allowed to view that screen, they land on it and see this instead
// of a dead end or a bounce back to Dashboard.
function renderPermissionDeniedState(elementId, screenLabel) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = `
    <div class="permission-denied-inline">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"/>
        <line x1="7" y1="7" x2="17" y2="17"/>
      </svg>
      <div class="pd-title">Permission Denied</div>
      <div class="pd-sub">You don't have access to view ${esc(screenLabel)}. Contact your admin if you need this.</div>
    </div>
  `;
}

/* ---- PERMISSION DENIED / CONFIRM MODALS (generic, reused everywhere) ---- */
function showPermissionDenied(message) {
  const msgEl = document.getElementById('permissionDeniedMessage');
  if (msgEl) msgEl.textContent = message || "You don't have permission to do this. Contact Customer Support for more Information.";
  openModal('permissionDeniedModal');
}

// Generic reusable confirm dialog. onConfirm runs only if the user hits
// the action button; the button re-uses .btn-danger styling and label
// since every caller so far is a delete, but title/message/label are all
// swappable per call.
function showConfirm(title, message, onConfirm, confirmLabel = 'Delete') {
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMessage').textContent = message;
  const okBtn = document.getElementById('confirmModalOkBtn');
  okBtn.textContent = confirmLabel;
  // Clone-and-replace to drop any previously bound handler instead of
  // stacking a new listener on top of it on every call.
  const freshBtn = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(freshBtn, okBtn);
  freshBtn.addEventListener('click', () => {
    closeModal('confirmModal');
    onConfirm();
  });
  openModal('confirmModal');
}

/* ---- THEME ---- */
// Keep these in sync with --bg in css/main.css (light default + [data-theme="dark"])
const THEME_COLORS = { light: '#f7f8fa', dark: '#080a0f' };

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('crm_theme', theme);
  document.getElementById('themePill').classList.toggle('on', theme === 'dark');

  // Sync the mobile status bar / browser chrome color to match.
  const meta = document.getElementById('themeColorMeta');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

async function doLogout() {
  try {
    await fetch('api/auth.php?action=logout', { method: 'GET', credentials: 'include' });
  } catch(e) {}
  showLoginScreen();
}

/* ---- TOAST ---- */
function showToast(msg, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

/* ---- MODALS ---- */
// Modals stack arbitrarily deep (e.g. Client Detail → Record Detail →
// File Detail), but every .modal-overlay shares the same base z-index in
// CSS, so without this the *last one in the HTML source* would always
// render on top regardless of open order. Bumping z-index on every open
// keeps whichever modal was opened most recently on top, no matter how
// many are stacked underneath it.
let _modalZCounter = 200;
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.zIndex = ++_modalZCounter;
  el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('open'); el.style.zIndex = ''; }
  if (id === 'addRecordModal')   resetRecordForm();
  if (id === 'addClientModal')   resetClientForm();
  if (id === 'addFollowupModal') resetFollowupForm();
  if (id === 'changePasswordModal') resetChangePasswordForm();
  if (id === 'quickMessageModal')   resetQuickMessageForm();
  if (id === 'sysIdCheckerModal')   resetSystemIdChecker();
  if (id === 'addTransactionModal') resetTransactionForm();
  if (id === 'addUserModal')        resetAddUserForm();
  if (id === 'userPermissionsModal') _editingUserUid = null;
}

/* ---- CHANGE PASSWORD ---- */
function resetChangePasswordForm() {
  ['cp_current', 'cp_new', 'cp_confirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const err = document.getElementById('cpError');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  const btn = document.getElementById('cpSaveBtn');
  if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
}

function cpShowError(msg) {
  const err = document.getElementById('cpError');
  err.textContent = msg;
  err.style.display = 'flex';
}

async function submitChangePassword() {
  const err = document.getElementById('cpError');
  err.style.display = 'none';

  const current = document.getElementById('cp_current').value;
  const next    = document.getElementById('cp_new').value;
  const confirm = document.getElementById('cp_confirm').value;

  if (!current || !next || !confirm) {
    cpShowError('Please fill in all fields.');
    return;
  }
  if (next.length < 6) {
    cpShowError('New password must be at least 6 characters.');
    return;
  }
  if (next !== confirm) {
    cpShowError('New password and confirmation do not match.');
    return;
  }
  if (next === current) {
    cpShowError('New password must be different from the current password.');
    return;
  }

  const btn = document.getElementById('cpSaveBtn');
  btn.disabled = true;
  btn.classList.add('loading');

  try {
    const res = await fetch('api/auth.php?action=change_password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ current_password: current, new_password: next })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Password updated successfully');
      closeModal('changePasswordModal');
    } else {
      cpShowError(data.error || 'Failed to update password.');
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  } catch (e) {
    cpShowError('Connection error. Please try again.');
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

function resetClientForm() {
  clearForm(['c_name','c_firm','c_address','c_contact','c_email','c_software_version']);
  document.getElementById('c_whatsapp').value = '+91';
  document.getElementById('c_renewal_date').value = '';
  document.getElementById('c_system_id').value = '';
  document.getElementById('c_software_type').value = '';
  document.getElementById('c_status').value = '1';
  clearExtraPhoneFields();

  editingClientId = null;
  document.getElementById('addClientModalTitle').textContent = 'New Client';
  document.getElementById('addClientSaveBtn').textContent = 'Save Client';
}

/* ---- MULTI-PHONE: extra Contact number slots on the client form ---- */
// Each row is just an input + a remove button; values are collected fresh
// from the DOM on save, so there's no separate array to keep in sync.
function addExtraPhoneField(value = '') {
  const container = document.getElementById('c_extra_phones');
  const row = document.createElement('div');
  row.className = 'extra-phone-row';
  row.innerHTML = `
    <input type="tel" class="c_extra_contact" placeholder="+91 XXXXX XXXXX" value="${esc(value)}" />
    <button type="button" class="btn-remove-phone" onclick="this.closest('.extra-phone-row').remove()" title="Remove this number">&minus;</button>
  `;
  container.appendChild(row);
}

function clearExtraPhoneFields() {
  document.getElementById('c_extra_phones').innerHTML = '';
}

function populateExtraPhoneFields(numbers) {
  clearExtraPhoneFields();
  (numbers || []).forEach(n => addExtraPhoneField(n));
}

function getExtraPhoneValues() {
  return Array.from(document.querySelectorAll('#c_extra_phones .c_extra_contact'))
    .map(el => el.value.trim())
    .filter(Boolean);
}

// Close modals on backdrop click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

/* ========================
   DASHBOARD
   ======================== */
async function loadDashboard() {
  try {
    const data = await API.getDashboard();

    // Greeting + user info
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greetingName').textContent = `${greeting}, ${data.username || 'Admin'}!`;
    document.getElementById('greetingDate').textContent = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    setUserInfo(data.username, data.userid);

    // Bar chart
    renderBarChart(data.chart_data || []);

    // Resolution rate ring
    renderResolutionRate(data.resolution_rate || {});

    // Upcoming renewals
    const renewalEl = document.getElementById('upcomingRenewals');
    if (data.upcoming_renewals?.length) {
      renewalEl.innerHTML = data.upcoming_renewals.map(r => renewalItem(r)).join('');
    } else {
      renewalEl.innerHTML = `<div class="empty-state">No upcoming renewals 🎉</div>`;
    }

    // Follow-up today
    const followEl = document.getElementById('followupToday');
    if (data.followup_today?.length) {
      followEl.innerHTML = data.followup_today.map(f => followupItem(f)).join('');
    } else {
      followEl.innerHTML = `<div class="empty-state">No follow-ups today</div>`;
    }

  } catch(e) {
    console.error(e);
    document.getElementById('greetingName').textContent = 'Admin';
  }
}

function renderBarChart(chartData) {
  const barsEl = document.getElementById('chartBars');
  const totalEl = document.getElementById('chartTotal');

  if (!chartData.length) {
    barsEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;width:100%;padding:20px 0;">No data</div>`;
    return;
  }

  const max = Math.max(...chartData.map(d => d.count), 1);
  const weekTotal = chartData.reduce((s, d) => s + d.count, 0);
  totalEl.textContent = weekTotal + ' records';

  // Today's day label
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 3);

  barsEl.innerHTML = chartData.map(d => {
    const pct = Math.round((d.count / max) * 100);
    const heightPct = d.count === 0 ? 4 : Math.max(pct, 8);
    const isToday = d.day === todayLabel;
    return `
      <div class="bar-col">
       
        <div class="bar-wrap">
          <div class="bar-fill ${isToday ? 'bar-fill--today' : ''} ${d.count === 0 ? 'bar-fill--empty' : ''}"
               style="height:${heightPct}%"
               data-count="${d.count}">
          </div>
        </div>
        <div class="bar-label ${isToday ? 'bar-label--today' : ''}">${d.day}</div>
      </div>`;
  }).join('');

// Animate bars in
  document.querySelectorAll('.bar-fill').forEach((el, i) => {
    el.style.transform = 'scaleY(0)';
    el.style.transformOrigin = 'bottom';
    el.style.transition = 'none';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = `transform 0.45s cubic-bezier(.34,1.3,.64,1) ${i * 55}ms`;
        el.style.transform = 'scaleY(1)';
      });
    });
  });
}

function renderResolutionRate(res) {
  const pct      = res.pct ?? 0;
  const resolved = res.resolved ?? 0;
  const opened   = res.opened ?? 0;
  const circumference = 163.4; // 2 * PI * r(26)

  document.getElementById('resRatePct').textContent = pct + '%';
  document.getElementById('resRateSub').textContent =
    opened > 0 ? `${resolved} of ${opened} queries closed this week` : 'No queries opened this week';

  const arc = document.getElementById('resRateArc');
  const offset = circumference - (circumference * pct / 100);

  // Animate in exactly like the weekly bars: snap back to empty with no
  // transition, then on the next frame transition up to the real value so
  // the ring always grows in from zero instead of jumping straight there.
  arc.style.transition = 'none';
  arc.setAttribute('stroke-dashoffset', circumference);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      arc.style.transition = 'stroke-dashoffset 0.6s cubic-bezier(.34,1.3,.64,1)';
      arc.setAttribute('stroke-dashoffset', offset);
    });
  });
}

/* ========================
   INFINITE SCROLL (30 at a time)
   ======================== */
const LIST_PAGE_SIZE = 30;

// Renders `items` into `el` in chunks of `pageSize`, revealing the next
// chunk automatically as the user scrolls near the bottom of the list.
// `items` is rendered 30-at-a-time on scroll same as before. Once the
// local array runs dry, if `fetchMoreFn` is provided (server has more
// pages beyond what's loaded), it's called to pull the next server page
// and append it to `items` (same array reference) before continuing —
// this is what lets the list actually reach every row, not just the
// first server page.
function renderPaginatedList(el, items, pageSize, itemHtmlFn, emptyMessage, fetchMoreFn) {
  if (el._infiniteObserver) { el._infiniteObserver.disconnect(); el._infiniteObserver = null; }

  if (!items.length) {
    el.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }

  el.innerHTML = '';
  let rendered = 0;
  let fetchingMore = false;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        renderNextChunk();
      }
    });
  }, { root: null, rootMargin: '600px' });
  el._infiniteObserver = observer;

  async function renderNextChunk() {
    let next = items.slice(rendered, rendered + pageSize);

    if (!next.length && fetchMoreFn && !fetchingMore) {
      fetchingMore = true;
      const gotMore = await fetchMoreFn(); // appends onto `items` if successful
      fetchingMore = false;
      next = items.slice(rendered, rendered + pageSize);
      if (!gotMore || !next.length) return;
    }

    if (!next.length) return;
    el.insertAdjacentHTML('beforeend', next.map(itemHtmlFn).join(''));
    rendered += next.length;

    const oldSentinel = el.querySelector('.infinite-scroll-sentinel');
    if (oldSentinel) oldSentinel.remove();

    if (rendered < items.length || fetchMoreFn) {
      const sentinel = document.createElement('div');
      sentinel.className = 'infinite-scroll-sentinel';
      el.appendChild(sentinel);
      observer.observe(sentinel);
    }
  }

  renderNextChunk();
}

/* ========================
   CLIENTS
   ======================== */
async function loadClients(search = '') {
  try {
    const data = await API.getClients(search);
    allClients = data.clients || [];
    renderClients(allClients);
  } catch(e) {
    console.error(e);
    if (e.status === 403 && e.body?.permission_denied) {
      renderPermissionDeniedState('clientsList', 'Clients');
    } else {
      document.getElementById('clientsList').innerHTML = `<div class="empty-state">Failed to load clients</div>`;
    }
  }
}

function clientIsActive(c) {
  if (!c.renewal_date) return true; // no renewal date = treat as active
  return daysFromToday(c.renewal_date) >= 0;
}

function renderClients(clients) {
  const el = document.getElementById('clientsList');
  renderPaginatedList(el, clients, LIST_PAGE_SIZE, (c) => {
    const isActive = clientIsActive(c);
    const initial = (c.firmname || c.clientname || '?')[0].toUpperCase();

    // Avatar color by status
    const avatarClass = !isActive ? 'item-avatar--inactive' : '';

    return `
      <button class="list-item client-item" onclick='openClientDetailById(${JSON.stringify(c.id)})'>
        <div class="item-avatar ${avatarClass}">${initial}</div>
        <div class="item-body">
          <div class="item-title">${esc(c.firmname || c.clientname)}</div>
          <div class="item-info-row">
            <span class="item-info-text">${esc(c.clientname)}</span>
            <span class="item-info-dot"></span>
            <span class="item-info-text">${esc(c.contact)}</span>
          </div>
        </div>
        <div class="client-item-right">
          <span class="badge ${isActive ? 'badge-active' : 'badge-expired'}">${isActive ? 'Active' : 'Inactive'}</span>
          </div>
      </button>
    `;
  }, 'No clients found');
}

// Tracks which client the detail modal is currently showing, so the
// header's Edit/Delete buttons (and their handlers) know what to act on
// without needing the id passed back through onclick="" every time.
let currentDetailClient = null;

function openClientDetail(c) {
  currentDetailClient = c;
  const editBtn   = document.getElementById('cdEditBtn');
  const deleteBtn = document.getElementById('cdDeleteBtn');
  if (editBtn)   editBtn.style.display   = can('can_edit_client')   ? '' : 'none';
  if (deleteBtn) deleteBtn.style.display = can('can_delete_client') ? '' : 'none';

  const isActive = clientIsActive(c);
  const waIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.397 5.61L0 24l6.545-1.38A11.946 11.946 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.8 9.8 0 0 1-5.003-1.367l-.36-.214-3.713.983.993-3.648-.235-.374A9.817 9.817 0 0 1 2.182 12C2.182 6.578 6.578 2.182 12 2.182S21.818 6.578 21.818 12 17.422 21.818 12 21.818z"/></svg>`;

  // Renewal pill colour logic
  let renewalPillHtml = '';
  if (c.renewal_date) {
    const diff  = daysFromToday(c.renewal_date);
    let renewClass = 'cd-renewal--ok';
    if (diff < 0)   renewClass = 'cd-renewal--expired';
    else if (diff <= 30) renewClass = 'cd-renewal--soon';
    const label = diff < 0
      ? `Expired ${Math.abs(diff)}d ago`
      : diff === 0 ? 'Renews today'
      : `Renewal : ${formatDate(c.renewal_date)}`;
    renewalPillHtml = `<span class="cd-renewal-pill ${renewClass}">${label}</span>`;
  }

  const body = document.getElementById('clientDetailBody');
  body.innerHTML = `
    <div class="cd-header">
      <div class="cd-header-top">
        <div class="cd-avatar">${(c.firmname||c.clientname||'?')[0].toUpperCase()}</div>
        <div class="cd-header-right">
          <span class="cd-status-badge ${isActive ? 'cd-status--active' : 'cd-status--inactive'}">${isActive ? 'Active' : 'Inactive'}</span>
          ${renewalPillHtml}
        </div>
      </div>
      <div class="cd-firm">${esc(c.firmname) || '—'}</div>
      <div class="cd-name">${esc(c.clientname)}</div>
    </div>
    <div class="cd-rows">
      ${c.system_id ? `
      <div class="detail-row">
        <span class="detail-label">System ID</span>
        <span class="cd-sysid-pill">${esc(c.system_id)}</span>
      </div>` : ''}
      ${detailRow('Firm Name', c.firmname)}
      ${detailRow('Address', c.address)}
      ${detailRow('Person', c.clientname)}
      ${detailRow('Phone', c.contact)}
      ${(c.extra_contacts || []).map((n, i) => detailRow(`Phone ${i + 2}`, n)).join('')}
      ${detailRow('Email', c.email)}
      ${detailRow('Renewal', formatDate(c.renewal_date))}
      ${c.software_type ? `
      <div class="detail-row">
        <span class="detail-label">Software</span>
        <span class="cd-sysid-pill">${esc(c.software_type)}</span>
      </div>` : ''}
      ${c.software_version ? `
      <div class="detail-row">
        <span class="detail-label">Version</span>
        <span class="cd-sysid-pill">${esc(c.software_version)}</span>
      </div>` : ''}
      ${c.whatsapp ? `
      <div class="detail-row">
        <span class="detail-label">WhatsApp</span>
        <div class="cd-wa-wrap">
          <span class="detail-value">${esc(c.whatsapp)}</span>
   
        </div>
      </div>` : ''}
    </div>
    <div class="rdm-section">
      <div class="rdm-section-title">History</div>
      <div id="cd-ledger-list"></div>
    </div>
  `;
  // Wire up Call & Chat footer buttons — multi-number aware, same picker
  // pattern as the other five call/chat entry points. Single number (or
  // none) keeps the plain href with no JS in the way, exactly as before;
  // multiple numbers intercept the click and route through the picker.
  // Handlers are cleared (: null) on the single/no-number branch since
  // these buttons are reused across opens for different clients.
  const callBtn = document.getElementById('cdCallBtn');
  const chatBtn = document.getElementById('cdChatBtn');
  const phoneOptions      = getClientPhoneOptions(c);
  const hasMultiplePhones = phoneOptions.length > 1;
  const phone = (phoneOptions[0]?.value || c.contact || '').replace(/\D/g, '');
  const wa    = (c.whatsapp || c.contact || '').replace(/\D/g, '');

  callBtn.href = hasMultiplePhones ? '#' : (phone ? `tel:${phone}` : '#');
  callBtn.style.opacity = (hasMultiplePhones || phone) ? '1' : '0.4';
  callBtn.style.pointerEvents = (hasMultiplePhones || phone) ? 'auto' : 'none';
  callBtn.onclick = hasMultiplePhones ? (e) => {
    e.preventDefault();
    startPhoneCall(c, c.contact, `Call ${c.firmname || c.clientname}`);
  } : null;

  chatBtn.href = hasMultiplePhones ? '#' : (wa ? `https://wa.me/${wa}` : '#');
  chatBtn.style.opacity = (hasMultiplePhones || wa) ? '1' : '0.4';
  chatBtn.style.pointerEvents = (hasMultiplePhones || wa) ? 'auto' : 'none';
  chatBtn.onclick = hasMultiplePhones ? (e) => {
    e.preventDefault();
    startWhatsAppChat(c, c.whatsapp || c.contact, `Chat with ${c.firmname || c.clientname}`);
  } : null;
  openModal('clientDetailModal');
  loadClientLedger(c.clientname);
}

// Client ledger: every past record/transaction for this client, newest first.
// Clicking an entry opens the same detail modal used on the Records tab.
// Local store for the client-ledger modal specifically — its records come
// from a separate paginated fetch and aren't guaranteed to be sitting in
// the global allRecords array, so it needs its own lookup-by-id map.
let ledgerRecordsById = {};
function openLedgerRecordById(id) { const r = ledgerRecordsById[id]; if (r) openRecordDetail(r); }

async function loadClientLedger(clientname) {
  const el = document.getElementById('cd-ledger-list');
  if (!el) return;
  el.innerHTML = `<div class="empty-state" style="padding:16px 0;">Loading history...</div>`;
  try {
    // This modal shows a client's *entire* history in one go (no scroll
    // pagination here), so pull every server page rather than just the
    // first — otherwise long-standing clients would silently lose older
    // entries past the page-size cutoff.
    let records = [];
    let page = 1, hasMore = true;
    while (hasMore) {
      const data = await API.getRecords({ search: clientname, page, include_payments: 1 });
      records = records.concat((data.records || []).filter(r => r.account === clientname));
      hasMore = !!data.hasMore;
      page++;
    }
    if (!records.length) {
      el.innerHTML = `<div class="empty-state" style="padding:16px 0;">No history yet</div>`;
      return;
    }
    ledgerRecordsById = {};
    records.forEach(r => { ledgerRecordsById[r.id] = r; });
    el.innerHTML = records.map(r => {
      const isPayment = (r.servicetype || '').toLowerCase() === 'payment';
      const statusBadge = badgeHtml(r.status || 'pending');
      const summary = r.query || r.query_note || r.payment_info || '';
      const sub = [timeAgo(r.transdate), summary].filter(Boolean).join(' · ');
      const title = isPayment ? 'Payment' : (r.servicename || 'Record');
      const rightHtml = isPayment && r.payment_amount
        ? `<span style="font-weight:700;color:var(--success);">${formatCurrency(r.payment_amount)}</span>`
        : statusBadge;
      const hasFiles = parseInt(r.file_count, 10) > 0;
      const fileBadge = hasFiles ? `
          <span class="item-avatar-file-badge" title="Has attached file${r.file_count > 1 ? 's' : ''}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </span>` : '';
      return `
        <div class="list-item" style="cursor:pointer" onclick='openLedgerRecordById(${JSON.stringify(r.id)})'>
          <div class="item-avatar" style="background:var(--surface-2)">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
            ${fileBadge}
          </div>
          <div class="item-body">
            <div class="item-title">${esc(title)}</div>
            <div class="item-sub">${esc(sub)}</div>
          </div>
          <div class="item-right">${rightHtml}</div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:16px 0;">Failed to load history</div>`;
  }
}

function formatCurrency(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return amount;
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  if (!y || !m || !d) return dateStr;
  return `${d}-${m}-${y}`;
}

function detailRow(label, value) {
  if (!value) return '';
  return `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${esc(value)}</span></div>`;
}

// Non-null while addClientModal is in edit mode, holding the id of the
// client being edited. saveClient() branches add-vs-update off this, and
// resetClientForm() (called by closeModal) always clears it back to null
// so the modal defaults back to "New Client" next time it's opened fresh.
let editingClientId = null;

// Opens the Add/Edit Client modal pre-filled with the client currently
// shown in the detail modal, and flips it into edit mode. Relies on
// currentDetailClient rather than taking an id so the caller (the header
// button) doesn't need to know it.
function openEditClientFromDetail() {
  const c = currentDetailClient;
  if (!c) return;
  if (!can('can_edit_client')) { showPermissionDenied(); return; }

  editingClientId = c.id;
  document.getElementById('addClientModalTitle').textContent = 'Edit Client';
  document.getElementById('addClientSaveBtn').textContent = 'Save Changes';

  document.getElementById('c_name').value              = c.clientname || '';
  document.getElementById('c_firm').value               = c.firmname || '';
  document.getElementById('c_address').value             = c.address || '';
  document.getElementById('c_contact').value             = c.contact || '';
  document.getElementById('c_email').value               = c.email || '';
  document.getElementById('c_whatsapp').value            = c.whatsapp || '+91';
  populateExtraPhoneFields(c.extra_contacts || []);
  document.getElementById('c_renewal_date').value        = c.renewal_date || '';
  document.getElementById('c_system_id').value           = c.system_id || '';
  document.getElementById('c_software_version').value    = c.software_version || '';
  document.getElementById('c_status').value               = String(c.status ?? 1);

  populateSoftwareTypes().then(() => {
    document.getElementById('c_software_type').value = c.software_type || '';
  });

  closeModal('clientDetailModal');
  openModal('addClientModal');
}

function confirmDeleteClient() {
  const c = currentDetailClient;
  if (!c) return;
  if (!can('can_delete_client')) { showPermissionDenied(); return; }

  showConfirm(
    'Delete client?',
    `${c.firmname || c.clientname} will be moved to Archives and can be restored within 30 days.`,
    async () => {
      try {
        await API.deleteClient(c.id);
        showToast('Client deleted');
        closeModal('clientDetailModal');
        loadClients();
      } catch (e) {
        if (e.status === 403) { showPermissionDenied(); return; }
        // Hard block: a client with existing records can never be deleted.
        // No retry/force option — just tell the user why and stop.
        if (e.status === 409 && e.body && e.body.has_records) {
          showToast(e.body.error || `This client has ${e.body.record_count} record(s) and can't be deleted.`);
          return;
        }
        showToast('Failed to delete client');
      }
    }
  );
}

async function saveClient() {
  const data = {
    clientname:       document.getElementById('c_name').value.trim(),
    firmname:         document.getElementById('c_firm').value.trim(),
    address:          document.getElementById('c_address').value.trim(),
    contact:          document.getElementById('c_contact').value.trim(),
    extra_contacts:   getExtraPhoneValues(),
    email:            document.getElementById('c_email').value.trim(),
    whatsapp:         document.getElementById('c_whatsapp').value.trim(),
    system_id:        document.getElementById('c_system_id').value.trim() || null,
    renewal_date:     document.getElementById('c_renewal_date').value || null,
    software_type:    document.getElementById('c_software_type').value || null,
    software_version: document.getElementById('c_software_version').value.trim() || null,
    status:           parseInt(document.getElementById('c_status').value),
  };
  if (!data.clientname || !data.firmname || !data.contact) {
    showToast(' Fill required fields'); return;
  }
  const isEdit = !!editingClientId;
  if (isEdit) data.id = editingClientId;

  try {
    if (isEdit) await API.updateClient(data);
    else        await API.addClient(data);
    showToast(isEdit ? 'Client updated' : 'Client saved');
    closeModal('addClientModal'); // resetClientForm() runs via closeModal(), clearing editingClientId
    loadClients();
  } catch(e) {
    if (e.status === 403) showPermissionDenied();
    else showToast(isEdit ? 'Failed to update client' : 'Failed to save client');
  }
}

/* ========================
   RECORDS
   ======================== */
let recordFilter = 'all';
let _serviceTypeMap = {}; // serviceid -> servicetype

// Non-null while addRecordModal is in edit mode, holding the id of the
// record being edited — same pattern as editingClientId. saveRecord()
// branches add-vs-update off this; resetRecordForm() (run by closeModal())
// always clears it so the modal defaults back to "New Record" next time.
let editingRecordId = null;

let recordDateFilter = ''; // holds YYYY-MM-DD when date filter is active

// Tracks server-side pagination state for the current search/filter so the
// infinite scroll can keep asking for the next page instead of stopping
// at whatever the first page happened to contain.
let recordsPaging = { page: 1, hasMore: false, search: '', filter: 'all', date: '' };

async function loadRecords(search = '') {
  try {
    const params = { search, filter: recordFilter, page: 1 };
    if (recordFilter === 'date' && recordDateFilter) params.date = recordDateFilter;
    const data = await API.getRecords(params);
    allRecords = data.records || [];
    recordsPaging = { page: 1, hasMore: !!data.hasMore, search, filter: recordFilter, date: recordDateFilter };
    renderRecords(allRecords);
  } catch(e) {
    if (e.status === 403 && e.body?.permission_denied) {
      renderPermissionDeniedState('recordsList', 'Records');
    } else {
      document.getElementById('recordsList').innerHTML = `<div class="empty-state">Failed to load records</div>`;
    }
  }
}

// Called by the scroll sentinel once it runs out of locally-loaded rows.
// Fetches the next server page for the *current* search/filter and appends
// it onto allRecords (same array reference the list is rendering from).
async function fetchMoreRecords() {
  if (!recordsPaging.hasMore) return false;
  const nextPage = recordsPaging.page + 1;
  const params = { search: recordsPaging.search, filter: recordsPaging.filter, page: nextPage };
  if (recordsPaging.filter === 'date' && recordsPaging.date) params.date = recordsPaging.date;
  try {
    const data = await API.getRecords(params);
    const newRows = data.records || [];
    allRecords.push(...newRows);
    recordsPaging.page = nextPage;
    recordsPaging.hasMore = !!data.hasMore;
    return newRows.length > 0;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function renderRecords(records) {
  const el = document.getElementById('recordsList');
  renderPaginatedList(el, records, LIST_PAGE_SIZE, (r) => {
    const statusBadge = badgeHtml(r.status || 'pending');
    const sub = [r.servicename, timeAgo(r.transdate)].filter(Boolean).join(' · ');
    const status = r.status || 'pending';
    const client  = allClients.find(c => c.clientname === r.account);
    // Multi-number aware: getClientPhoneOptions covers whatsapp/contact/
    // extra_contacts, same source the Quick Message "Send To" dropdown
    // uses, instead of only ever offering the primary contact number.
    const phoneOptions = client ? getClientPhoneOptions(client) : [];
    const hasMultiplePhones = phoneOptions.length > 1;
    const singlePhone = (phoneOptions[0]?.value || '').replace(/\D/g, '');
    const callBtn = (status === 'pending' && phoneOptions.length)
      ? `<a class="item-call-btn" href="${hasMultiplePhones ? '#' : 'tel:' + singlePhone}"
           onclick="event.stopPropagation();${hasMultiplePhones ? `event.preventDefault();startRecordCallById(${JSON.stringify(r.id)});` : ''}"
           aria-label="Call">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>
        </a>`
      : '';

    return `
       <div class="list-item" style="cursor:pointer" onclick='openRecordDetailById(${JSON.stringify(r.id)})'>
        <div class="item-avatar" style="background:var(--surface-2)">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-user"><path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" /><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /></svg>
          </div>
        <div class="item-body">
<div class="item-title">${esc((allClients.find(c => c.clientname === r.account)?.firmname) || r.account)}</div>
          <div class="item-sub">${sub}</div>
        </div>
        <div class="item-right" style="display:flex;align-items:center;gap:8px;">${callBtn}${statusBadge}</div>
      </div>`;
  }, 'No records found', fetchMoreRecords);
}


// Pending Records call icon — record rows only carry the account name,
// so resolve the linked client fresh (allRecords/allClients are both
// already in memory by the time this fires).
function startRecordCallById(id) {
  const r = allRecords.find(x => String(x.id) === String(id));
  if (!r) return;
  const client = allClients.find(c => c.clientname === r.account);
  startPhoneCall(client, client?.contact || client?.whatsapp, `Call ${client?.firmname || r.account}`);
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 3)   return `${diffDays} days ago`;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}
// Filter chips — All / Pending / Done / Pick date
document.querySelectorAll('#recordFilters .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (chip.dataset.filter === 'date') return; // handled by openDatePicker
    document.querySelectorAll('#recordFilters .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    recordFilter = chip.dataset.filter;
    clearDateFilter(false); // reset date silently
    loadRecords(document.getElementById('recordSearch').value);
  });
});

function openDatePicker() {
  const input = document.getElementById('recordDateInput');
  input.showPicker ? input.showPicker() : input.click();
}

function applyDateFilter(dateVal) {
  if (!dateVal) return;
  recordDateFilter = dateVal;
  recordFilter = 'date';
  const [y, m, d] = dateVal.split('-');
  document.getElementById('dateChipLabel').textContent = `${d}-${m}-${y}`;
  document.querySelectorAll('#recordFilters .chip').forEach(c => c.classList.remove('active'));
  document.getElementById('datePickerChip').classList.add('active');
  loadRecords(document.getElementById('recordSearch').value);
}

function clearDateFilter(reload = true) {
  recordDateFilter = '';
  const input = document.getElementById('recordDateInput');
  if (input) input.value = '';
  document.getElementById('dateChipLabel').textContent = 'Filter by Date';
}

// When client is selected — prefill system ID for install services
async function onClientSelect() {
  const sel = document.getElementById('r_account');
  const clientName = sel.value;
  if (!clientName) return;
  try {
    const client = allClients.find(c => c.clientname === clientName);
    if (client?.system_id) {
      document.getElementById('r_systemid').value = client.system_id;
    }
    // Prefill renewal date if renewal service is selected
    const serviceType = document.getElementById('r_service').dataset.serviceType;
    if (serviceType === 'renewal' && client?.renewal_date) {
      document.getElementById('r_renewal_date').value = client.renewal_date;
    }
  } catch(e) {}
}

// When service is selected — show/hide relevant fields
function onServiceSelect() {
  const sel       = document.getElementById('r_service');
  const serviceid = sel.value;
  const svc       = _serviceMap[serviceid] || {};
  const type      = (svc.type || '').toLowerCase();
  // Store on element so saveRecord() can read reliably without re-looking up the map
  sel.dataset.serviceType = type;
  sel.dataset.serviceName = svc.name || '';

  // Hide all groups first
  ['r_grp_support','r_grp_renewal','r_grp_syschange','r_grp_install','r_grp_files'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  if (type === 'support') {
    document.getElementById('r_grp_support').style.display = 'flex';
    document.getElementById('r_grp_files').style.display = 'flex';
  } else if (type === 'renewal') {
    document.getElementById('r_grp_renewal').style.display = 'flex';
    document.getElementById('r_grp_files').style.display = 'flex';
    // Prefill current renewal date from selected client
    const client = allClients.find(c => c.clientname === document.getElementById('r_account').value);
    if (client?.renewal_date) {
      document.getElementById('r_renewal_date').value = client.renewal_date;
    }
  } else if (type === 'system change') {
    document.getElementById('r_grp_syschange').style.display = 'flex';
    // Prefill current system ID from selected client
    const client = allClients.find(c => c.clientname === document.getElementById('r_account').value);
    if (client?.system_id) document.getElementById('r_systemid').value = client.system_id;
  } else if (type === 'install') {
    document.getElementById('r_grp_install').style.display = 'flex';
    document.getElementById('r_grp_files').style.display = 'flex';
  }
}

// Toggles the file <input> visibility when "Attach Files" is (un)ticked.
function toggleRecordFileInput() {
  const checked = document.getElementById('r_attach_files')?.checked;
  const wrap = document.getElementById('r_files_input_wrap');
  if (wrap) wrap.style.display = checked ? 'flex' : 'none';
  if (checked) initRecordFileDrop();
}

// Shows whatever files are already attached to the record currently being
// edited — previously the edit form only ever offered a fresh upload
// input, so a record's existing files looked like they'd disappeared the
// moment you opened Edit. Each row has a Remove button (not a view/open
// action) since this is the edit form, not the read-only detail view —
// removing a file here calls files.php's delete action directly and
// re-renders the list, it does not touch the record itself.
async function loadExistingRecordFiles(recordId) {
  const section = document.getElementById('r_existing_files_section');
  const list    = document.getElementById('r_existing_files_list');
  if (!section || !list) return;
  section.style.display = 'none';
  list.innerHTML = '';
  if (!recordId) return;
  try {
    const data  = await API.getFilesForRecord(recordId);
    const files = data.files || [];
    if (!files.length) return;
    section.style.display = 'flex';
    list.innerHTML = files.map(f => `
      <div class="rdm-file-row" style="cursor:default;">
        <div class="rdm-file-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
        </div>
        <div class="rdm-file-info">
          <div class="rdm-file-name">${esc(f.original_name)}</div>
          <div class="rdm-file-meta">${formatFileSize(f.filesize)}${f.created_at ? ' · ' + formatDate(f.created_at) : ''}</div>
        </div>
        <button type="button" class="icon-btn" aria-label="Remove file" onclick='removeExistingRecordFile(${JSON.stringify(f.id)}, ${JSON.stringify(f.original_name)}, ${JSON.stringify(recordId)})'>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>
        </button>
      </div>
    `).join('');
  } catch (e) {
    section.style.display = 'none';
  }
}

// Permanently removes a single file from the record being edited. Doesn't
// require re-saving the record — the delete happens immediately, same as
// how new files upload immediately-on-save rather than being staged.
function removeExistingRecordFile(fileId, fileName, recordId) {
  if (!can('can_edit_record')) { showPermissionDenied(); return; }
  showConfirm(
    'Remove file?',
    `"${fileName}" will be permanently deleted.`,
    async () => {
      try {
        await API.deleteFile(fileId);
        showToast('File removed');
        loadExistingRecordFiles(recordId);
      } catch (e) {
        if (e.status === 403) { showPermissionDenied(); return; }
        showToast('Failed to remove file');
      }
    }
  );
}

function _formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Renders the chip list of currently-selected files under the dropzone.
function _renderRecordFileList() {
  const input = document.getElementById('r_files_input');
  const list = document.getElementById('r_filelist');
  if (!input || !list) return;
  list.innerHTML = '';
  Array.from(input.files).forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'filelist-item';
    item.innerHTML = `
      <div class="filelist-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
      <div class="filelist-info">
        <span class="filelist-name">${_escapeHtml(file.name)}</span>
        <span class="filelist-size">${_formatFileSize(file.size)}</span>
      </div>
      <button type="button" class="filelist-remove" aria-label="Remove file" onclick="_removeRecordFile(${idx})">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    list.appendChild(item);
  });
}

// Removes a single file from the input's FileList by rebuilding it via DataTransfer
// (native FileList objects are read-only, so this is the standard workaround).
function _removeRecordFile(idx) {
  const input = document.getElementById('r_files_input');
  if (!input) return;
  const dt = new DataTransfer();
  Array.from(input.files).forEach((file, i) => { if (i !== idx) dt.items.add(file); });
  input.files = dt.files;
  _renderRecordFileList();
}

function _escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Wires up click-to-browse and change handling for the Add Record file input.
// Safe to call multiple times (guards re-binding).
function initRecordFileDrop() {
  const drop = document.getElementById('r_filedrop');
  const input = document.getElementById('r_files_input');
  if (!drop || !input || drop.dataset.bound) return;
  drop.dataset.bound = '1';

  input.addEventListener('change', _renderRecordFileList);
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
}

async function saveRecord() {
  const sel         = document.getElementById('r_service');
  const serviceid   = sel.value;
  // Read from data attrs set by onServiceSelect — reliable even if _serviceMap lookup fails
  const serviceType = sel.dataset.serviceType || ((_serviceMap[serviceid] || {}).type || '');
  const serviceName = sel.dataset.serviceName || ((_serviceMap[serviceid] || {}).name || '');

  if (!document.getElementById('r_account').value || !serviceid || !document.getElementById('r_transdate').value) {
    showToast('Fill required fields'); return;
  }

  const base = {
    account:     document.getElementById('r_account').value,
    serviceid,
    servicename: serviceName,
    servicetype: serviceType,
    transdate:   document.getElementById('r_transdate').value,
    status:      document.getElementById('r_status').value,
  };

  let extra = {};
  if (serviceType === 'support') {
    extra.query      = document.getElementById('r_query')?.value.trim() || '';
    extra.query_note = document.getElementById('r_query_note')?.value.trim() || '';
  } else if (serviceType === 'renewal') {
    extra.renewaldate    = document.getElementById('r_renewal_date')?.value || null;
    extra.payment_info   = document.getElementById('r_payment_info')?.value.trim() || '';
    extra.payment_amount = document.getElementById('r_payment_amount')?.value || null;
    extra.next_renewal   = document.getElementById('r_next_renewal')?.value || null;
    extra.query_note     = document.getElementById('r_renewal_note')?.value.trim() || '';
  } else if (serviceType === 'system change') {
    extra.systemid     = document.getElementById('r_systemid')?.value || '';
    extra.new_systemid = document.getElementById('r_new_systemid')?.value.trim() || '';
    extra.query_note   = document.getElementById('r_syschange_note')?.value.trim() || '';
  } else if (serviceType === 'install') {
    extra.payment_info   = document.getElementById('r_install_payment_info')?.value.trim() || '';
    extra.payment_amount = document.getElementById('r_install_payment_amount')?.value || null;
    extra.query_note     = document.getElementById('r_install_note')?.value.trim() || '';
  }

  const isEdit = !!editingRecordId;

  try {
    let result;
    if (isEdit) {
      result = await API.updateRecord({ id: editingRecordId, ...base, ...extra });
    } else {
      result = await API.addRecord({ action: 'add', ...base, ...extra });
    }

    // If files were attached, upload them now tied to the record's id.
    const attachFiles = document.getElementById('r_attach_files')?.checked;
    const filesInput   = document.getElementById('r_files_input');
    const filesToUpload = (attachFiles && filesInput && filesInput.files.length)
      ? Array.from(filesInput.files) : [];
    const recordId = isEdit ? editingRecordId : result.id;
    for (const file of filesToUpload) {
      try {
        await API.uploadFile(file, { recordId, account: base.account });
      } catch (e) {
        showToast(`Failed to upload ${file.name}`);
      }
    }

    showToast(isEdit ? 'Record updated' : 'Record saved');
    closeModal('addRecordModal'); // resetRecordForm() runs via closeModal(), clearing editingRecordId
    refreshAfterRecordChange();
  } catch(e) {
    if (e.status === 403) showPermissionDenied();
    else showToast(isEdit ? 'Failed to update record' : 'Failed to save record');
  }
}

// Refetches whichever record-backed lists might be showing the record that
// was just added/edited/deleted (Records tab, Transaction History, and a
// client's ledger inside their detail modal) so none of them go stale.
// Cheap enough to just call all three rather than track which is active.
function refreshAfterRecordChange() {
  loadRecords(document.getElementById('recordSearch')?.value || '');
  const thSearch = document.getElementById('thSearch');
  if (thSearch) loadTransactionHistory(thSearch.value || '');
  if (currentDetailClient) loadClientLedger(currentDetailClient.clientname);
}

function toggleRecordStatus() {
  const sel    = document.getElementById('r_status');
  const toggle = document.getElementById('r_status_toggle');
  const thumb  = document.getElementById('r_status_thumb');
  const label  = document.getElementById('r_status_label');
  if (sel.value === 'pending') {
    sel.value = 'done';
    label.textContent = 'Done';
    toggle.style.background = 'var(--accent)';
    thumb.style.transform = 'translateX(20px)';
  } else {
    sel.value = 'pending';
    label.textContent = 'Pending';
    toggle.style.background = 'var(--border)';
    thumb.style.transform = 'translateX(0)';
  }
}

function resetRecordForm() {
  ['r_account','r_account_search','r_service','r_transdate'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  const acBox = document.getElementById('r_account_suggestions');
  if (acBox) acBox.style.display = 'none';
  const rSvc = document.getElementById('r_service');
  if (rSvc) { rSvc.dataset.serviceType = ''; rSvc.dataset.serviceName = ''; }
document.getElementById('r_transdate').value = localDateStr();
  document.getElementById('r_status').value = 'pending';
  // Reset toggle UI
  const toggle = document.getElementById('r_status_toggle');
  const thumb  = document.getElementById('r_status_thumb');
  const label  = document.getElementById('r_status_label');
  if (toggle) toggle.style.background = 'var(--border)';
  if (thumb)  thumb.style.transform = 'translateX(0)';
  if (label)  label.textContent = 'Pending';
  // Clear all group fields
  ['r_query_note','r_renewal_date','r_payment_info','r_payment_amount','r_next_renewal','r_renewal_note',
   'r_query','r_systemid','r_new_systemid','r_syschange_note','r_install_note',
   'r_install_payment_info','r_install_payment_amount'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  // Reset Attach Files controls
  const attachCb = document.getElementById('r_attach_files');
  if (attachCb) attachCb.checked = false;
  const filesInput = document.getElementById('r_files_input');
  if (filesInput) filesInput.value = '';
  const filesWrap = document.getElementById('r_files_input_wrap');
  if (filesWrap) filesWrap.style.display = 'none';
  const filesList = document.getElementById('r_filelist');
  if (filesList) filesList.innerHTML = '';
  const existingFilesSection = document.getElementById('r_existing_files_section');
  if (existingFilesSection) existingFilesSection.style.display = 'none';
  const existingFilesList = document.getElementById('r_existing_files_list');
  if (existingFilesList) existingFilesList.innerHTML = '';
  // Hide all groups
  ['r_grp_support','r_grp_renewal','r_grp_syschange','r_grp_install','r_grp_files'].forEach(id => {
    const el = document.getElementById(id); if(el) el.style.display = 'none';
  });

  editingRecordId = null;
  document.getElementById('addRecordModalTitle').textContent = 'New Record';
  document.getElementById('addRecordSaveBtn').textContent = 'Save Record';
}

/* ========================
   FOLLOW-UPS
   ======================== */
let followupFilter = 'all';
let followupType   = 'new'; // 'client' or 'new'

// Non-null while addFollowupModal is in edit mode, holding the id of the
// follow-up being edited — same pattern used for clients/records.
let editingFollowupId = null;

// Tracks which follow-up the detail modal is currently showing, so the
// header's Edit/Delete buttons know what to act on.
let currentDetailFollowup = null;

let followupsPaging = { page: 1, hasMore: false, search: '', filter: 'all' };

async function loadFollowups(search = '') {
  try {
    const data = await API.getFollowups({ search, filter: followupFilter, page: 1 });
    allFollowups = data.followups || [];
    followupsPaging = { page: 1, hasMore: !!data.hasMore, search, filter: followupFilter };
    renderFollowups(allFollowups);
  } catch(e) {
    if (e.status === 403 && e.body?.permission_denied) {
      renderPermissionDeniedState('followupsList', 'Follow-ups');
    } else {
      document.getElementById('followupsList').innerHTML = `<div class="empty-state">Failed to load follow-ups</div>`;
    }
  }
}

async function fetchMoreFollowups() {
  if (!followupsPaging.hasMore) return false;
  const nextPage = followupsPaging.page + 1;
  try {
    const data = await API.getFollowups({ search: followupsPaging.search, filter: followupsPaging.filter, page: nextPage });
    const newRows = data.followups || [];
    allFollowups.push(...newRows);
    followupsPaging.page = nextPage;
    followupsPaging.hasMore = !!data.hasMore;
    return newRows.length > 0;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function renderFollowups(followups) {
  const el = document.getElementById('followupsList');
  renderPaginatedList(el, followups, LIST_PAGE_SIZE, (f) => {
    const isClient  = f.type === 'client';
    const title     = isClient ? esc(f.clientname || f.phonenumber) : esc(f.phonenumber);
    const sub       = [
      isClient ? esc(f.phonenumber) : (f.note ? esc(f.note) : ''),
      formatDate(f.reminderdate)
    ].filter(Boolean).join(' · ');
    const leadBadge = parseInt(f.is_lead) ? `<span class="badge badge-lead">Lead</span>` : '';
    return `
    <div class="list-item" style="cursor:pointer" onclick='openFollowupDetailById(${JSON.stringify(f.id)})'>
      <div class="item-avatar" style="background:var(--surface-2)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>
      </div>
      <div class="item-body">
        <div class="item-title">${title}</div>
        <div class="item-sub">${sub}</div>
      </div>
      <div class="item-right">
        ${leadBadge}
        ${badgeHtml(followupDisplayStatus(f))}
      </div>
    </div>`;
  }, 'No follow-ups found', fetchMoreFollowups);
}

function filterFollowups(filter, btn) {
  document.querySelectorAll('#page-followups .chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  followupFilter = filter;
  loadFollowups(document.getElementById('followupSearch').value);
}

async function markFollowupDone(id) {
  if (!can('can_update_followup_status')) { showPermissionDenied(); return; }
  try {
    await API.updateFollowup({ id, status: 'done' });
    showToast('Marked as complete');
    closeModal('followupDetailModal');
    loadFollowups();
  } catch(e) {
    if (e.status === 403) showPermissionDenied();
    else showToast('Failed to update');
  }
}

async function markFollowupCancelled(id) {
  if (!can('can_update_followup_status')) { showPermissionDenied(); return; }
  try {
    await API.updateFollowup({ id, status: 'cancelled' });
    showToast('Follow-up cancelled');
    closeModal('followupDetailModal');
    loadFollowups();
  } catch(e) {
    if (e.status === 403) showPermissionDenied();
    else showToast('Failed to update');
  }
}


function openFollowupDetail(f) {
  currentDetailFollowup = f;
  const editBtn   = document.getElementById('frdmEditBtn');
  const deleteBtn = document.getElementById('frdmDeleteBtn');
  if (editBtn)   editBtn.style.display   = can('can_edit_followup')   ? '' : 'none';
  if (deleteBtn) deleteBtn.style.display = can('can_delete_followup') ? '' : 'none';

  const isClient = f.type === 'client';
  const status   = f.status || 'pending';
  // Raw status still drives the "Mark Complete" button (an overdue item is
  // still pending, just late) — the badge shows the friendlier Overdue label.
  const displayStatus = followupDisplayStatus(f);
  const isLead   = parseInt(f.is_lead) === 1;
 
  const displayName = isClient
    ? (f.clientname || f.phonenumber)
    : f.phonenumber;
 
  const avatarInitial = (displayName || '?')[0].toUpperCase();
 
  const rawPhone = (f.phonenumber || '').replace(/\D/g, '');
  const waHref   = rawPhone ? `https://wa.me/${rawPhone}` : null;
  // Use the same digit-only value for the tel: link too — raw f.phonenumber
  // embedded directly into href="${...}" would let a quote character in
  // that field break out of the attribute, same bug class as the onclick
  // issue fixed earlier. Stripping to digits closes it off entirely.
  const callHref = rawPhone ? `tel:${rawPhone}` : null;

  // A follow-up only ever stores one denormalised phonenumber — multi-
  // number selection has to come from the linked client record itself, so
  // look that up when this is a client follow-up. (allClients is already
  // permission-masked server-side, same as everywhere else it's used.)
  // Gated on view_phone_followups specifically, not view_phone_clients —
  // a user who can see numbers on the Clients tab but not on Follow-ups
  // shouldn't get client phone numbers leaking in through this lookup.
  const linkedClient = (isClient && can('view_phone_followups'))
    ? (_followupClients.length ? _followupClients : allClients).find(c => c.clientname === f.clientname)
    : null;
  const phoneOptions = linkedClient ? getClientPhoneOptions(linkedClient) : [];
  const hasMultiplePhones = phoneOptions.length > 1;
  const showCallBtn = !!callHref || hasMultiplePhones;
 
  /* ── Reminder urgency label ── */
  const urgency = urgencyLabel(f.reminderdate);
 
  /* ── Header ── */
  document.getElementById('frdm-title').textContent = displayName || 'Follow-up';
 
  /* ── Body ── */
  const body = document.getElementById('frdm-body');
  body.innerHTML = `
 
    <!-- Hero — same pattern as record detail -->
    <div class="rdm-hero">
      <div class="rdm-hero-avatar">${esc(avatarInitial)}</div>
      <div class="rdm-hero-info">
        <div class="rdm-hero-name">${esc(displayName)}</div>
        <div class="rdm-hero-meta">
          <span class="rdm-type-badge" style="--type-color:var(--accent)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>
            ${isClient ? 'Client' : 'New Follow Up'}
          </span>
          ${isLead ? `<span class="rdm-type-badge" style="--type-color:var(--warning)">
            Lead
          </span>` : ''}
          ${badgeHtml(displayStatus)}
        </div>
      </div>
    </div>
 
    <!-- Follow-up Info -->
    <div class="rdm-section">
      <div class="rdm-section-title">Follow-up Info</div>
      ${rdmRow('Phone',     f.phonenumber)}
      ${isClient && f.clientname ? rdmRow('Client', f.clientname) : ''}
      ${f.note ? rdmRow('Note', f.note) : ''}
      ${rdmRow('Reminder',  formatDate(f.reminderdate))}
      ${urgency ? rdmRow('When', urgency) : ''}
    </div>
 
    <!-- Call / WhatsApp row — subtle, below the info -->
    ${(showCallBtn || waHref) ? `
    <div class="frdm-actions">
      ${showCallBtn ? `
        <a id="frdmCallBtn" class="btn btn-ghost frdm-action-btn" href="${hasMultiplePhones ? '#' : callHref}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px;vertical-align:middle"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>Call
        </a>` : ''}
      ${waHref ? `
        <a class="btn btn-ghost frdm-action-btn" href="${waHref}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;vertical-align:middle"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.397 5.61L0 24l6.545-1.38A11.946 11.946 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.8 9.8 0 0 1-5.003-1.367l-.36-.214-3.713.983.993-3.648-.235-.374A9.817 9.817 0 0 1 2.182 12C2.182 6.578 6.578 2.182 12 2.182S21.818 6.578 21.818 12 17.422 21.818 12 21.818z"/></svg>WhatsApp
        </a>` : ''}
    </div>` : ''}
  `;

  // Multi-number client: intercept the Call button and route through the
  // number picker instead of navigating straight off the plain tel: href.
  // Single-number (or non-client) follow-ups keep the plain href — no JS
  // in the way, same as before this feature.
  const callBtnEl = document.getElementById('frdmCallBtn');
  if (callBtnEl) {
    if (hasMultiplePhones) {
      callBtnEl.onclick = (e) => {
        e.preventDefault();
        startPhoneCall(linkedClient, rawPhone, `Call ${displayName}`);
      };
    } else {
      callBtnEl.onclick = null;
    }
  }
 
  /* ── Footer ── */
  // Pending (including overdue, which is still status 'pending' under the
  // hood) gets the full action set: Cancel, Complete, then Back. Anything
  // already resolved (done/cancelled) just gets a Back button.
  const footer = document.getElementById('frdm-footer');
  const canUpdateStatus = can('can_update_followup_status');
  footer.innerHTML = (status === 'pending' && canUpdateStatus)
    ? `<button class="btn btn-danger" style="flex:1" onclick="markFollowupCancelled(${f.id})">Cancelled</button>
       <button class="btn btn-primary" style="flex:1" onclick="markFollowupDone(${f.id})">Complete</button>
       <button class="btn btn-ghost" style="flex:1" onclick="closeModal('followupDetailModal')">Back</button>`
    : `<button class="btn btn-ghost" style="flex:1" onclick="closeModal('followupDetailModal')">Back</button>`;
 
  openModal('followupDetailModal');
}

// Toggle Client / New tabs in modal
function onFollowupTypeToggle(type) {
  followupType = type;
  document.getElementById('f_tab_client').classList.toggle('active', type === 'client');
  document.getElementById('f_tab_new').classList.toggle('active',    type === 'new');
  document.getElementById('f_grp_client').style.display = type === 'client' ? 'flex' : 'none';
  document.getElementById('f_grp_new').style.display    = type === 'new'    ? 'flex' : 'none';
}

// Local cache for followup modal clients (in case allClients isn't loaded yet)
let _followupClients = [];

// When client selected — autofill phone (editable)
function onFollowupClientSelect() {
  const source = _followupClients.length ? _followupClients : allClients;
  const client = source.find(c => c.clientname === document.getElementById('f_client').value);
  if (client) {
    document.getElementById('f_phone').value = client.contact || client.whatsapp || '';
  }
}

// Load clients for the followup modal's autocomplete (separate cache from records)
async function populateFollowupClientSelect() {
  if (_followupClients.length) return; // already loaded
  try {
    const data = await API.getClients();
    _followupClients = data.clients || [];
  } catch(e) {}
}

// Client autocomplete for the Add Follow-up "Client" field — same
// type-to-search pattern used on the Add Record "Account" field.
function filterFollowupClientSuggestions() {
  const input = document.getElementById('f_client_search');
  const box   = document.getElementById('f_client_suggestions');
  const term  = input.value.trim().toLowerCase();

  const source = _followupClients.length ? _followupClients : allClients;

  const matches = term
    ? source.filter(c =>
        (c.firmname || '').toLowerCase().includes(term) ||
        (c.clientname || '').toLowerCase().includes(term)
      ).slice(0, 8)
    : source.slice(0, 8);

  if (!matches.length) {
    box.innerHTML = '<div class="autocomplete-empty">No matching clients</div>';
    box.style.display = 'block';
    return;
  }

  box.innerHTML = matches.map(c => `
    <div class="autocomplete-item" onclick="selectFollowupClientSuggestion('${esc(c.clientname).replace(/'/g, "\\'")}')">
      ${esc(c.firmname || c.clientname)}
      ${c.firmname ? `<span class="ac-sub">${esc(c.clientname)}</span>` : ''}
    </div>
  `).join('');
  box.style.display = 'block';
}

function selectFollowupClientSuggestion(clientname) {
  const source = _followupClients.length ? _followupClients : allClients;
  const client = source.find(c => c.clientname === clientname);
  document.getElementById('f_client').value = clientname;
  document.getElementById('f_client_search').value = client ? (client.firmname || client.clientname) : clientname;
  document.getElementById('f_client_suggestions').style.display = 'none';
  onFollowupClientSelect();
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('f_client_search');
  const box  = document.getElementById('f_client_suggestions');
  if (!wrap || !box) return;
  if (e.target !== wrap && !box.contains(e.target)) {
    box.style.display = 'none';
  }
});

async function saveFollowup() {
  const reminderdate = document.getElementById('f_date').value;
  const status       = document.getElementById('f_status').value;
  const is_lead      = document.getElementById('f_is_lead').checked ? 1 : 0;
  let phonenumber, clientname, note;

  if (followupType === 'client') {
    clientname  = document.getElementById('f_client').value;
    phonenumber = document.getElementById('f_phone').value.trim();
    note        = document.getElementById('f_note_client').value.trim();
    if (!clientname || !phonenumber || !reminderdate) {
      showToast('Fill required fields'); return;
    }
  } else {
    phonenumber = document.getElementById('f_phone_new').value.trim();
    note        = document.getElementById('f_note_new').value.trim();
    clientname  = '';
    if (!phonenumber || !reminderdate) {
      showToast('Fill required fields'); return;
    }
  }

  const isEdit = !!editingFollowupId;
  const data = { phonenumber, reminderdate, status, is_lead, type: followupType, clientname, note };
  if (isEdit) data.id = editingFollowupId;

  try {
    if (isEdit) await API.editFollowup(data);
    else        await API.addFollowup(data);
    showToast(isEdit ? 'Follow-up updated' : 'Follow-up saved');
    closeModal('addFollowupModal'); // resetFollowupForm() runs via closeModal(), clearing editingFollowupId
    loadFollowups();
  } catch(e) {
    if (e.status === 403) showPermissionDenied();
    else showToast(isEdit ? 'Failed to update follow-up' : 'Failed to save');
  }
}

function resetFollowupForm() {
  followupType = 'new';
  document.getElementById('f_tab_new').classList.add('active');
  document.getElementById('f_tab_client').classList.remove('active');
  document.getElementById('f_grp_client').style.display = 'none';
  document.getElementById('f_grp_new').style.display    = 'flex';
  document.getElementById('f_client').value        = '';
  document.getElementById('f_client_search').value = '';
  document.getElementById('f_client_suggestions').style.display = 'none';
  document.getElementById('f_phone').value       = '';
  document.getElementById('f_note_client').value = '';
  document.getElementById('f_phone_new').value   = '';
  document.getElementById('f_note_new').value    = '';
  document.getElementById('f_date').value        = localDateStr();
  document.getElementById('f_status').value      = 'pending';
  document.getElementById('f_is_lead').checked   = false;

  editingFollowupId = null;
  document.getElementById('addFollowupModalTitle').textContent = 'New Follow-up';
  document.getElementById('addFollowupSaveBtn').textContent = 'Save';
}

// Opens the Add/Edit Follow-up modal pre-filled with the follow-up
// currently shown in the detail modal, and flips it into edit mode — same
// pattern as openEditClientFromDetail()/openEditRecordFromDetail().
function openEditFollowupFromDetail() {
  const f = currentDetailFollowup;
  if (!f) return;
  if (!can('can_edit_followup')) { showPermissionDenied(); return; }

  editingFollowupId = f.id;
  document.getElementById('addFollowupModalTitle').textContent = 'Edit Follow-up';
  document.getElementById('addFollowupSaveBtn').textContent = 'Save Changes';

  followupType = f.type === 'client' ? 'client' : 'new';
  onFollowupTypeToggle(followupType);

  if (followupType === 'client') {
    document.getElementById('f_client').value = f.clientname || '';
    const client = allClients.find(c => c.clientname === f.clientname);
    document.getElementById('f_client_search').value = client ? (client.firmname || client.clientname) : (f.clientname || '');
    document.getElementById('f_phone').value = f.phonenumber || '';
    document.getElementById('f_note_client').value = f.note || '';
  } else {
    document.getElementById('f_phone_new').value = f.phonenumber || '';
    document.getElementById('f_note_new').value = f.note || '';
  }

  document.getElementById('f_date').value = f.reminderdate || '';
  document.getElementById('f_status').value = f.status || 'pending';
  document.getElementById('f_is_lead').checked = parseInt(f.is_lead) === 1;

  closeModal('followupDetailModal');
  openModal('addFollowupModal');
}

function confirmDeleteFollowup() {
  const f = currentDetailFollowup;
  if (!f) return;
  if (!can('can_delete_followup')) { showPermissionDenied(); return; }

  showConfirm(
    'Delete follow-up?',
    `This will be moved to Archives and can be restored within 30 days.`,
    async () => {
      try {
        await API.deleteFollowup(f.id);
        showToast('Follow-up deleted');
        closeModal('followupDetailModal');
        loadFollowups();
      } catch (e) {
        if (e.status === 403) showPermissionDenied();
        else showToast('Failed to delete follow-up');
      }
    }
  );
}

/* ========================
   LOGS
   ======================== */
async function loadLogs() {
  try {
    const data = await API.getLogs();
    const el = document.getElementById('logsList');
    const logs = data.logs || [];
    if (!logs.length) {
      el.innerHTML = `<div class="empty-state">No activity yet</div>`; return;
    }
    el.innerHTML = logs.map(l => {
      const userBadge = l.user && l.user !== 'unknown'
        ? `<span class="log-user">${esc(l.user)}</span>`
        : '';
      return `
      <div class="log-item">
        <div class="log-dot"></div>
        <div class="log-content">
          <div class="log-msg">${esc(l.message || l.action || JSON.stringify(l))}</div>
          <div class="log-meta">
            ${userBadge}
            <span class="log-time">${l.created_at || l.timestamp || ''}</span>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    document.getElementById('logsList').innerHTML = `<div class="empty-state">No logs available</div>`;
  }
}

/* ========================
   HELPERS & ICONS
   ======================== */
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function badgeHtml(status) {
  const map = { active: 'Active', expired: 'Expired', expiring: 'Expiring', pending: 'Pending', done: 'Complete', cancelled: 'Cancelled', overdue: 'Overdue' };
  return `<span class="badge badge-${status}">${map[status] || status}</span>`;
}

// A follow-up's stored status is only ever 'pending' or 'done' — "overdue"
// isn't a DB value, it's a pending follow-up whose reminder date has already
// passed. This computes the label that should actually show on the pill,
// without touching the underlying status used for filtering/actions.
function followupDisplayStatus(f) {
  if (f.status === 'pending' && daysFromToday(f.reminderdate) < 0) return 'overdue';
  return f.status || 'pending';
}

function getRecordStatus(r) {
  if (!r.renewaldate) return 'active';
  const diff = daysFromToday(r.renewaldate);
  if (diff < 0) return 'expired';
  if (diff <= 15) return 'expiring';
  return 'active';
}

function renewalItem(r) {
  const diff      = daysFromToday(r.renewal_date);
  const pillClass = diff <= 2 ? 'cd-renewal--soon' : 'cd-renewal--ok';
  const initial   = (r.firmname || r.clientname || '?')[0].toUpperCase();
  return `
    <button class="list-item client-item" onclick='openRenewalDetailFromDashboard(${JSON.stringify(r.id)})'>
      <div class="item-avatar">${initial}</div>
      <div class="item-body">
        <div class="item-title">${esc(r.firmname || r.clientname)}</div>
        <div class="item-sub">${esc(r.clientname)} · ${formatDate(r.renewal_date)}</div>
      </div>
      <div class="item-right"><span class="cd-renewal-pill ${pillClass}">${renewalDaysLabel(diff)}</span></div>
    </button>`;
}

// Dashboard's renewal cards are a lighter-weight fetch (id/clientname/
// firmname/renewal_date only), so opening the detail popup pulls the full
// renewals list first if it isn't already loaded, then reuses the same
// modal the FAB "Upcoming Renewals" list uses.
async function openRenewalDetailFromDashboard(id) {
  if (!_renewalsData.length) {
    await loadRenewalsList();
  }
  openRenewalDetail(id);
}

function followupItem(f) {
  const hasClient = f.type === 'client' && f.clientname;
  // Client follow-ups show the client's name, never the raw phone number —
  // phone stays available inside the detail modal / call button only.
  const title = hasClient ? f.clientname : f.phonenumber;
  const day   = urgencyLabel(f.reminderdate) || 'Today';
  // Same "day · status pill" pattern for both client and non-client cards.
  const sub   = `${esc(day)} · ${badgeHtml(followupDisplayStatus(f))}`;
  const phone = (f.phonenumber || '').replace(/\D/g, '');
  // Same multi-number lookup as the follow-up detail modal: a client
  // follow-up's own phonenumber is just a snapshot, so check the linked
  // client record (already permission-masked) for extra numbers.
  const linkedClient = (hasClient && can('view_phone_followups'))
    ? allClients.find(c => c.clientname === f.clientname)
    : null;
  const hasMultiplePhones = linkedClient ? getClientPhoneOptions(linkedClient).length > 1 : false;
  const callBtn = (phone || hasMultiplePhones)
    ? `<a class="item-call-btn" href="${hasMultiplePhones ? '#' : 'tel:' + phone}"
         onclick="event.stopPropagation();${hasMultiplePhones ? `event.preventDefault();startFollowupCallById(${JSON.stringify(f.id)});` : ''}"
         aria-label="Call">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>
      </a>`
    : '';
  return `
    <div class="list-item" style="cursor:pointer" onclick='openFollowupDetailFromDashboard(${JSON.stringify(f.id)})'>
      <div class="item-avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>
      </div>
      <div class="item-body">
        <div class="item-title">${esc(title)}</div>
        <div class="item-sub">${sub}</div>
      </div>
      <div class="item-right">${callBtn}</div>
    </div>`;
}

// Dashboard's "Follow-up Today" cards are a lighter-weight fetch, so opening
// the detail popup pulls the full follow-ups list first if it isn't already
// loaded, then reuses the same modal the Queries > Follow-ups list uses.
async function openFollowupDetailFromDashboard(id) {
  let f = allFollowups.find(x => x.id === id);
  if (!f) {
    await loadFollowups();
    f = allFollowups.find(x => x.id === id);
  }
  if (f) openFollowupDetail(f);
}

// Follow-up card's call icon — same id-lookup-then-reload pattern as
// openFollowupDetailFromDashboard, since the dashboard's follow-up
// payload is a lighter-weight fetch than the full Follow-ups list.
async function startFollowupCallById(id) {
  let f = allFollowups.find(x => x.id === id);
  if (!f) {
    await loadFollowups();
    f = allFollowups.find(x => x.id === id);
  }
  if (!f) return;
  const isClient = f.type === 'client' && f.clientname;
  const linkedClient = isClient ? allClients.find(c => c.clientname === f.clientname) : null;
  const displayName = isClient ? (f.clientname || f.phonenumber) : f.phonenumber;
  startPhoneCall(linkedClient, f.phonenumber, `Call ${displayName}`);
}

function clearForm(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}


/* ========================
   SEARCH DEBOUNCE
   ======================== */
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

document.getElementById('clientSearch').addEventListener('input', debounce(e => loadClients(e.target.value), 350));
document.getElementById('recordSearch').addEventListener('input', debounce(e => loadRecords(e.target.value), 350));
document.getElementById('followupSearch').addEventListener('input', debounce(e => loadFollowups(e.target.value), 350));

// Clears a search input and re-triggers its existing debounced input listener
// so the list reloads unfiltered — used by the × button in each search bar.
function clearSearch(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

/* ========================
   POPULATE SELECTS FOR MODALS
   ======================== */
async function populateSoftwareTypes() {
  const sel = document.getElementById('c_software_type');
  if (sel.options.length > 1) return; // already loaded
  try {
    const data = await API.get('clients.php', { software_types: 1 });
    (data.software_types || []).forEach(s => {
      sel.add(new Option(s.name, s.name));
    });
  } catch(e) {}
}

let _recordClients = [];

async function populateClientSelect() {
  if (_recordClients.length) return;
  try {
    const data = await API.getClients();
    _recordClients = data.clients || [];
  } catch(e) {}
}

// Client autocomplete for the Add Record "Account" field.
// Lets the user type a name/firm instead of scrolling a long dropdown.
function filterClientSuggestions() {
  const input = document.getElementById('r_account_search');
  const box   = document.getElementById('r_account_suggestions');
  const term  = input.value.trim().toLowerCase();

  const source = _recordClients.length ? _recordClients : allClients;

  const matches = term
    ? source.filter(c =>
        (c.firmname || '').toLowerCase().includes(term) ||
        (c.clientname || '').toLowerCase().includes(term)
      ).slice(0, 8)
    : source.slice(0, 8);

  if (!matches.length) {
    box.innerHTML = '<div class="autocomplete-empty">No matching clients</div>';
    box.style.display = 'block';
    return;
  }

  box.innerHTML = matches.map(c => `
    <div class="autocomplete-item" onclick="selectClientSuggestion('${esc(c.clientname).replace(/'/g, "\\'")}')">
      ${esc(c.firmname || c.clientname)}
      ${c.firmname ? `<span class="ac-sub">${esc(c.clientname)}</span>` : ''}
    </div>
  `).join('');
  box.style.display = 'block';
}

function selectClientSuggestion(clientname) {
  const source = _recordClients.length ? _recordClients : allClients;
  const client = source.find(c => c.clientname === clientname);
  document.getElementById('r_account').value = clientname;
  document.getElementById('r_account_search').value = client ? (client.firmname || client.clientname) : clientname;
  document.getElementById('r_account_suggestions').style.display = 'none';
  onClientSelect();
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('r_account_search');
  const box  = document.getElementById('r_account_suggestions');
  if (!wrap || !box) return;
  if (e.target !== wrap && !box.contains(e.target)) {
    box.style.display = 'none';
  }
});

const _serviceMap = {}; // serviceid -> { servicename, servicetype }

async function populateServiceSelect() {
  const sel = document.getElementById('r_service');
  if (sel.options.length > 1) return;
  try {
    const data = await API.get('records.php', { services: 1 });
    (data.services || []).forEach(s => {
      _serviceMap[s.serviceid] = { name: s.servicename, type: s.servicetype };
      sel.add(new Option(s.servicename, s.serviceid));
    });
  } catch(e) {}
}

document.getElementById('addRecordModal').addEventListener('click', async () => {
  await populateClientSelect();
  await populateServiceSelect();
});

/* ========================
   QUICK MESSAGE
   ======================== */
let _qmClients        = [];
let _qmTemplates      = [];
let _qmSelectedClient = null;
let _qmSelectedTemplate = null;

function openQuickMessage() {
  openModal('quickMessageModal');
  populateQuickMessageClients();
  populateQuickMessageTemplates();
}

async function populateQuickMessageClients() {
  if (_qmClients.length) return;
  try {
    const data = await API.getClients();
    _qmClients = data.clients || [];
  } catch(e) {}
}

async function populateQuickMessageTemplates() {
  const sel = document.getElementById('qm_template');
  if (sel.options.length > 1) return; // already loaded
  try {
    const data = await API.getMessageTemplates();
    _qmTemplates = data.templates || [];
    _qmTemplates.forEach(t => sel.add(new Option(t.name, t.id)));
  } catch(e) {}
}

// Client autocomplete for the Quick Message "Client" field — same pattern
// as the Add Record account picker.
function filterQmClientSuggestions() {
  const input = document.getElementById('qm_account_search');
  const box   = document.getElementById('qm_account_suggestions');
  const term  = input.value.trim().toLowerCase();

  const source = _qmClients.length ? _qmClients : allClients;

  const matches = term
    ? source.filter(c =>
        (c.firmname || '').toLowerCase().includes(term) ||
        (c.clientname || '').toLowerCase().includes(term)
      ).slice(0, 8)
    : source.slice(0, 8);

  if (!matches.length) {
    box.innerHTML = '<div class="autocomplete-empty">No matching clients</div>';
    box.style.display = 'block';
    return;
  }

  box.innerHTML = matches.map(c => `
    <div class="autocomplete-item" onclick="selectQmClientSuggestion('${esc(c.clientname).replace(/'/g, "\\'")}')">
      ${esc(c.firmname || c.clientname)}
      ${c.firmname ? `<span class="ac-sub">${esc(c.clientname)}</span>` : ''}
    </div>
  `).join('');
  box.style.display = 'block';
}

function selectQmClientSuggestion(clientname) {
  const source = _qmClients.length ? _qmClients : allClients;
  const client = source.find(c => c.clientname === clientname);
  document.getElementById('qm_account').value = clientname;
  document.getElementById('qm_account_search').value = client ? (client.firmname || client.clientname) : clientname;
  document.getElementById('qm_account_suggestions').style.display = 'none';
  populateQmNumberDropdown(client);
}

// Every phone number on file for a client, in the order shown in the
// "Send To" dropdown. WhatsApp first since that's what quick-message
// channel defaults to sending on.
function getClientPhoneOptions(client) {
  if (!client) return [];
  const options = [];
  if (client.whatsapp) options.push({ label: `WhatsApp — ${client.whatsapp}`, value: client.whatsapp });
  if (client.contact)  options.push({ label: `Contact — ${client.contact}`, value: client.contact });
  (client.extra_contacts || []).forEach((n, i) => {
    if (n) options.push({ label: `Contact ${i + 2} — ${n}`, value: n });
  });
  return options;
}

// Only shown when a client has more than one number on file — a
// single-number client skips this entirely, same as before this feature.
function populateQmNumberDropdown(client) {
  const group  = document.getElementById('qm_number_group');
  const select = document.getElementById('qm_number');
  const options = getClientPhoneOptions(client);
  if (options.length > 1) {
    select.innerHTML = options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    group.style.display = 'flex';
  } else {
    select.innerHTML = '';
    group.style.display = 'none';
  }
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('qm_account_search');
  const box  = document.getElementById('qm_account_suggestions');
  if (!wrap || !box) return;
  if (e.target !== wrap && !box.contains(e.target)) {
    box.style.display = 'none';
  }
});

/* ========================
   NUMBER PICKER (generic)
   ======================== */
// Shared disambiguation step for every call/message action that touches a
// client's phone number: Send Reminder (renewals), the follow-up detail
// Call button, the follow-up card call icon, and the Pending Records call
// icon. Single-number (or no-number) clients never see this — it only
// exists for the multi-number case, same "one number = no extra step"
// behaviour those features already had.
//
// `options` is whatever getClientPhoneOptions() returned (label/value
// pairs); `onSelect(option)` runs once the user taps a row. Listeners are
// bound fresh on every open (not delegated) since the list is rebuilt
// each time and there's only ever one number picker on screen.
function openNumberPicker(title, options, onSelect) {
  document.getElementById('npTitle').textContent = title || 'Choose a number';
  const list = document.getElementById('npList');
  list.innerHTML = options.map((o, i) => `
    <button type="button" class="np-option" data-idx="${i}">
      <span class="np-option-label">${esc(o.label)}</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  `).join('');
  list.querySelectorAll('.np-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      closeModal('numberPickerModal');
      onSelect(options[idx]);
    });
  });
  openModal('numberPickerModal');
}

// Entry point for the plain "place a call" actions (follow-up detail,
// follow-up card, Pending Records). `client` is the full client record
// (so getClientPhoneOptions can see extra_contacts); `fallbackPhone` is
// used when there's no linked client record at all — e.g. a "New Follow
// Up" that was never tied to a client, just a raw number on the
// follow-up itself, where multi-number selection doesn't apply.
// Nothing here bypasses the server-side phone masking: if the user lacks
// view_phone_* permission the API already stripped contact/whatsapp/
// extra_contacts/phonenumber to null before this ever runs, so `client`
// carries no numbers and this silently no-ops via the "no phone" toast.
function startPhoneCall(client, fallbackPhone, title) {
  const options = client ? getClientPhoneOptions(client) : [];
  if (options.length > 1) {
    openNumberPicker(title || 'Choose a number to call', options, (o) => {
      const digits = (o.value || '').replace(/\D/g, '');
      if (digits) window.location.href = `tel:${digits}`;
    });
    return;
  }
  const digits = (options[0]?.value || fallbackPhone || '').replace(/\D/g, '');
  if (digits) window.location.href = `tel:${digits}`;
  else showToast('No phone number on file');
}

// Same shape as startPhoneCall but opens WhatsApp instead of dialing.
// Used by the Client Details "Chat" button — the one call/chat entry
// point where a client's WhatsApp number can differ from their other
// numbers, so it needs its own picker rather than reusing startPhoneCall.
function startWhatsAppChat(client, fallbackPhone, title) {
  const options = client ? getClientPhoneOptions(client) : [];
  if (options.length > 1) {
    openNumberPicker(title || 'Choose a number to chat with', options, (o) => {
      const digits = (o.value || '').replace(/\D/g, '');
      if (digits) window.open(`https://wa.me/${digits}`, '_blank');
    });
    return;
  }
  const digits = (options[0]?.value || fallbackPhone || '').replace(/\D/g, '');
  if (digits) window.open(`https://wa.me/${digits}`, '_blank');
  else showToast('No phone number on file');
}

// Fills {name}/{firm}/{renewal_date}/{system_id} placeholders with the
// selected client's actual data.
function fillMessageTemplate(body, client) {
  const renewalStr = client.renewal_date ? formatDate(client.renewal_date) : '—';
  return body
    .replace(/{name}/g,         client.clientname || '')
    .replace(/{firm}/g,         client.firmname || client.clientname || '')
    .replace(/{renewal_date}/g, renewalStr)
    .replace(/{system_id}/g,    client.system_id || '—');
}

// Step 1 -> Step 2: builds the message from the chosen client + template
// and shows it for review before anything actually gets sent.
function previewQuickMessage() {
  const clientname = document.getElementById('qm_account').value;
  const templateId = document.getElementById('qm_template').value;

  if (!clientname) { showToast('Please select a client'); return; }
  if (!templateId) { showToast('Please select a message type'); return; }

  const source = _qmClients.length ? _qmClients : allClients;
  const client   = source.find(c => c.clientname === clientname);
  const template = _qmTemplates.find(t => String(t.id) === String(templateId));
  if (!client)   { showToast('Client not found'); return; }
  if (!template) { showToast('Template not found'); return; }

  _qmSelectedClient   = client;
  _qmSelectedTemplate = template;

  document.getElementById('qm_preview_text').value = fillMessageTemplate(template.body, client);

  const options = getClientPhoneOptions(client);
  const phone = options.length > 1
    ? (document.getElementById('qm_number').value || '').replace(/\D/g, '')
    : (options[0]?.value || '').replace(/\D/g, '');
  const warn = document.getElementById('qm_no_phone_warning');
  if (!phone) {
    warn.textContent = 'No phone number on file for this client — you can still copy the message manually.';
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }

  document.getElementById('qm_step_compose').style.display  = 'none';
  document.getElementById('qm_footer_compose').style.display = 'none';
  document.getElementById('qm_step_preview').style.display   = 'flex';
  document.getElementById('qm_footer_preview').style.display = 'flex';
}

function backToComposeQuickMessage() {
  document.getElementById('qm_step_preview').style.display   = 'none';
  document.getElementById('qm_footer_preview').style.display = 'none';
  document.getElementById('qm_step_compose').style.display   = 'flex';
  document.getElementById('qm_footer_compose').style.display = 'flex';
}

// India-first phone normalisation: bare 10-digit numbers get a +91 prefix
// so wa.me/sms links work without the user having to type the country code.
function normalizePhoneForSend(raw) {
  let digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return digits;
}

function sendQuickMessage(channel) {
  if (!_qmSelectedClient) return;
  const text  = document.getElementById('qm_preview_text').value.trim();
  if (!text) { showToast('Message is empty'); return; }

  const options  = getClientPhoneOptions(_qmSelectedClient);
  const rawPhone = options.length > 1
    ? (document.getElementById('qm_number').value || '')
    : (options[0]?.value || '');
  const phone    = normalizePhoneForSend(rawPhone);
  if (!phone) { showToast('No phone number on file for this client'); return; }

  const encoded = encodeURIComponent(text);
  if (channel === 'whatsapp') {
    window.open(`https://wa.me/${phone}?text=${encoded}`, '_blank');
  } else {
    // sms: URI scheme param separator differs by platform (Android: ?body=,
    // iOS: &body=) — ?body= is the more broadly supported default.
    window.location.href = `sms:${rawPhone.replace(/\s+/g, '')}?body=${encoded}`;
  }

  API.logMessageSent({
    client:   _qmSelectedClient.firmname || _qmSelectedClient.clientname,
    template: _qmSelectedTemplate?.name || '',
    channel,
  }).catch(() => {});

  showToast('Message opened — send it from ' + (channel === 'whatsapp' ? 'WhatsApp' : 'your SMS app'));
  closeModal('quickMessageModal');
}

function resetQuickMessageForm() {
  document.getElementById('qm_account_search').value = '';
  document.getElementById('qm_account').value = '';
  document.getElementById('qm_account_suggestions').style.display = 'none';
  document.getElementById('qm_template').value = '';
  document.getElementById('qm_preview_text').value = '';
  document.getElementById('qm_no_phone_warning').style.display = 'none';
  document.getElementById('qm_number_group').style.display = 'none';
  document.getElementById('qm_number').innerHTML = '';
  _qmSelectedClient = null;
  _qmSelectedTemplate = null;
  backToComposeQuickMessage();
}

/* ========================
   UPCOMING RENEWALS
   ======================== */
// Only clients not yet expired show up here — expired ones live under
// Inactive Clients instead, so the two lists don't overlap.
let _renewalsData = [];
let _renewalDetailClient = null;

function openRenewalsList() {
  if (!can('access_renewals')) { showPermissionDenied(); return; }
  openModal('renewalsModal');
  loadRenewalsList();
}

async function loadRenewalsList() {
  const el = document.getElementById('renewalsList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getClientsForRenewals();
    const clients = data.clients || [];
    _renewalsData = clients
      .filter(c => c.renewal_date && daysFromToday(c.renewal_date) >= 0)
      .sort((a, b) => daysFromToday(a.renewal_date) - daysFromToday(b.renewal_date));
    renderRenewalsList();
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load renewals</div>`;
  }
}

function renewalDaysLabel(diff) {
  if (diff === 0) return 'Renews today';
  if (diff === 1) return '1 day left';
  return `${diff} days left`;
}

function renderRenewalsList() {
  const el = document.getElementById('renewalsList');
  renderPaginatedList(el, _renewalsData, LIST_PAGE_SIZE, (c) => {
    const diff      = daysFromToday(c.renewal_date);
    const pillClass = diff <= 7 ? 'cd-renewal--soon' : 'cd-renewal--ok';
    const initial   = (c.firmname || c.clientname || '?')[0].toUpperCase();

    return `
      <button class="list-item client-item" onclick='openRenewalDetail(${JSON.stringify(c.id)})'>
        <div class="item-avatar">${initial}</div>
        <div class="item-body">
          <div class="item-title">${esc(c.firmname || c.clientname)}</div>
          <div class="item-info-row">
            <span class="item-info-text">${esc(c.clientname)}</span>
            <span class="item-info-dot"></span>
            <span class="item-info-text">${formatDate(c.renewal_date)}</span>
          </div>
        </div>
        <div class="client-item-right">
          <span class="cd-renewal-pill ${pillClass}">${renewalDaysLabel(diff)}</span>
        </div>
      </button>
    `;
  }, 'No upcoming renewals');
}

// Lightweight detail popup — just the renewal-relevant fields, not the
// full client profile (that's what Client Ledger / Clients tab is for).
function openRenewalDetail(id) {
  const c = _renewalsData.find(x => String(x.id) === String(id));
  if (!c) return;
  _renewalDetailClient = c;

  const diff      = daysFromToday(c.renewal_date);
  const pillClass = diff <= 7 ? 'cd-renewal--soon' : 'cd-renewal--ok';
  const initial   = (c.firmname || c.clientname || '?')[0].toUpperCase();

  const body = document.getElementById('renewalDetailBody');
  body.innerHTML = `
    <div class="cd-header">
      <div class="cd-header-top">
        <div class="cd-avatar">${initial}</div>
        <div class="cd-header-right">
          <span class="cd-renewal-pill ${pillClass}">${renewalDaysLabel(diff)}</span>
        </div>
      </div>
      <div class="cd-firm">${esc(c.firmname) || '—'}</div>
      <div class="cd-name">${esc(c.clientname)}</div>
    </div>
    <div class="cd-rows">
      ${detailRow('Renewal Date', formatDate(c.renewal_date))}
      ${detailRow('Days Pending', renewalDaysLabel(diff))}
      ${c.system_id ? `
      <div class="detail-row">
        <span class="detail-label">System ID</span>
        <span class="cd-sysid-pill">${esc(c.system_id)}</span>
      </div>` : ''}
      ${detailRow('Phone', c.contact)}
      ${(c.extra_contacts || []).map((n, i) => detailRow(`Phone ${i + 2}`, n)).join('')}
      ${c.software_type ? `
      <div class="detail-row">
        <span class="detail-label">Software</span>
        <span class="cd-sysid-pill">${esc(c.software_type)}</span>
      </div>` : ''}
    </div>
  `;

  // Multi-number aware, same as the Send Reminder button just below it:
  // getClientPhoneOptions covers whatsapp/contact/extra_contacts, and if
  // the user lacks view_phone_renewals the API already masked those to
  // null, so phoneOptions comes back empty and this button doesn't render
  // — same permission story as before, just no longer single-number-only.
  const phoneOptions       = getClientPhoneOptions(c);
  const hasMultiplePhones  = phoneOptions.length > 1;
  const singlePhone        = (phoneOptions[0]?.value || '').replace(/\D/g, '');
  const footer = document.getElementById('renewalDetailFooter');
  footer.innerHTML = `
    ${phoneOptions.length
      ? `<a class="btn btn-ghost" style="flex:1;text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;"
           href="${hasMultiplePhones ? '#' : 'tel:' + singlePhone}"
           onclick="${hasMultiplePhones ? "event.preventDefault();startRenewalDetailCall();" : ''}">Call</a>`
      : ''}
    ${can('can_send_reminder')
      ? `<button class="btn btn-primary" style="flex:1" onclick="sendRenewalReminderFromDetail()">Send Reminder</button>`
      : ''}
    <button class="btn btn-ghost" style="flex:1" onclick="closeModal('renewalDetailModal')">Close</button>`;

  openModal('renewalDetailModal');
}

// Renewal detail modal's own Call button (separate from Send Reminder).
// Reads from _renewalDetailClient rather than taking the client/title as
// inline-onclick arguments — same reason startRecordCallById/
// startFollowupCallById take an id instead: firmname/clientname can
// contain a quote character, which would break out of the onclick
// attribute string if interpolated directly.
function startRenewalDetailCall() {
  if (!_renewalDetailClient) return;
  const c = _renewalDetailClient;
  startPhoneCall(c, c.contact || c.whatsapp, `Call ${c.firmname || c.clientname}`);
}

/* ========================
   SYSTEM ID CHECKER
   ======================== */
// Checks a pasted system ID against clients.system_id (who holds it right
// now) AND the full transaction trail (every old + new ID a System Change
// ever recorded, plus the ID on file at every support/renewal/install
// row) — so a reused or previously-changed-away ID still shows its history.
let _sysIdLastResult = null;

function openSystemIdChecker() {
  openModal('sysIdCheckerModal');
  const input = document.getElementById('sysid_input');
  input.value = '';
  document.getElementById('sysIdCheckerResult').innerHTML = '';
  setTimeout(() => input.focus(), 50);
}

function resetSystemIdChecker() {
  document.getElementById('sysid_input').value = '';
  document.getElementById('sysIdCheckerResult').innerHTML = '';
  _sysIdLastResult = null;
}

async function runSystemIdCheck() {
  const val = document.getElementById('sysid_input').value.trim();
  const el  = document.getElementById('sysIdCheckerResult');
  if (!val) { el.innerHTML = `<div class="empty-state">Enter a system ID to check</div>`; return; }

  el.innerHTML = `<div class="empty-state">Checking...</div>`;
  try {
    const data = await API.checkSystemId(val);
    _sysIdLastResult = data;
    renderSystemIdResult(data);
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to check system ID</div>`;
  }
}

function systemIdServiceLabel(type) {
  const map = {
    'support':       'Support / Visit',
    'renewal':       'Renewal',
    'system change': 'System Change',
    'install':       'New Installation',
  };
  return map[(type || '').toLowerCase()] || (type || 'Transaction');
}

function renderSystemIdResult(data) {
  const el = document.getElementById('sysIdCheckerResult');
  const parts = [];

  // Never seen before — clean bill of health, nothing else to show.
  if (!data.ever_used) {
    parts.push(`
      <div class="detail-row" style="border:1px dashed var(--border); border-radius:var(--radius-sm); padding:14px; align-items:center;">
        <span class="cd-status-badge cd-status--active">New</span>
        <span class="detail-value">This system ID has never been used before.</span>
      </div>
    `);
    el.innerHTML = parts.join('');
    return;
  }

  if (data.duplicate) {
    parts.push(`
      <div class="empty-state" style="color:var(--danger,#e5484d); text-align:left; padding:0 0 14px;">
        ⚠ This ID is currently assigned to ${data.current_clients.length} different clients — worth double-checking for a data mistake.
      </div>
    `);
  }

  if (data.in_use) {
    data.current_clients.forEach(c => {
      const isActive   = !c.renewal_date || daysFromToday(c.renewal_date) >= 0;
      const sinceLabel = c.since_source === 'system_change' ? 'Changed to this ID' : 'Client since';
      parts.push(`
        <div class="cd-header" style="padding-bottom:10px; border-bottom:1px solid var(--border); margin-bottom:10px;">
          <div class="cd-header-top">
            <div class="cd-avatar">${esc((c.firmname || c.clientname || '?')[0].toUpperCase())}</div>
            <div class="cd-header-right">
              <span class="cd-status-badge ${isActive ? 'cd-status--active' : 'cd-status--inactive'}">${isActive ? 'Active' : 'Inactive'}</span>
            </div>
          </div>
          <div class="cd-firm">${esc(c.firmname) || '—'}</div>
          <div class="cd-name">${esc(c.clientname)}</div>
        </div>
        <div class="cd-rows" style="margin-bottom:16px;">
          ${detailRow(sinceLabel, formatDate(c.since))}
          ${detailRow('Renewal Date', formatDate(c.renewal_date))}
          ${c.software_type ? detailRow('Software', c.software_type) : ''}
        </div>
      `);
    });
  } else {
    parts.push(`
      <div class="empty-state" style="text-align:left; padding:0 0 14px;">
        Not currently assigned to any client — it only shows up in past records below.
      </div>
    `);
  }

  if (data.history.length) {
    parts.push(`<div class="detail-label" style="margin-bottom:8px;">Change History</div>`);
    data.history.forEach(h => {
      const dirLabel = h.to
        ? `${esc(h.from || '—')} → ${esc(h.to)}`
        : esc(h.from || '—');
      parts.push(`
        <div class="list-item" style="cursor:default;">
          <div class="item-body">
            <div class="item-title">${esc(h.firmname || h.account || '—')}</div>
            <div class="item-info-row">
              <span class="item-info-text">${esc(systemIdServiceLabel(h.servicetype))}</span>
              <span class="item-info-dot"></span>
              <span class="item-info-text">${formatDate(h.date)}</span>
            </div>
            <div class="item-info-row" style="margin-top:4px;">
              <span class="cd-sysid-pill" style="font-size:11px; padding:3px 10px;">${dirLabel}</span>
            </div>
          </div>
        </div>
      `);
    });
  }

  el.innerHTML = parts.join('');
}

// Shortcut from the renewal detail popup straight into Quick Message,
// pre-filled with this client and the Renewal Reminder template. A client
// with more than one number on file gets the number picker first — Quick
// Message only opens once a number has actually been chosen; a
// single-number client skips straight to Quick Message as before.
async function sendRenewalReminderFromDetail() {
  if (!_renewalDetailClient) return;
  if (!can('can_send_reminder')) { showPermissionDenied(); return; }
  const c = _renewalDetailClient;

  const proceedWithNumber = async (chosenPhone) => {
    closeModal('renewalDetailModal');
    closeModal('renewalsModal');
    openModal('quickMessageModal');

    await populateQuickMessageClients();
    await populateQuickMessageTemplates();

    document.getElementById('qm_account').value = c.clientname;
    document.getElementById('qm_account_search').value = c.firmname || c.clientname;
    populateQmNumberDropdown(c);
    if (chosenPhone) document.getElementById('qm_number').value = chosenPhone;

    const tmpl = _qmTemplates.find(t => t.name === 'Renewal Reminder');
    if (tmpl) document.getElementById('qm_template').value = tmpl.id;

    previewQuickMessage();
  };

  const options = getClientPhoneOptions(c);
  if (options.length > 1) {
    openNumberPicker(`Send reminder to ${c.firmname || c.clientname}`, options, (o) => proceedWithNumber(o.value));
  } else {
    proceedWithNumber(options[0]?.value || '');
  }
}

/* ========================
   INACTIVE CLIENTS
   ======================== */
// Mirrors clientIsActive()'s definition of "inactive": a renewal_date that
// has passed. Clients with no renewal_date at all are treated as active
// everywhere else in the app, so they're excluded here too — this list is
// specifically "renewal expired", not "no renewal set".
let _inactiveClientsData = [];

function openInactiveClientsList() {
  if (!can('access_inactive_clients')) { showPermissionDenied(); return; }
  openModal('inactiveClientsModal');
  loadInactiveClientsList();
}

async function loadInactiveClientsList() {
  const el = document.getElementById('inactiveClientsList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getClients();
    const clients = data.clients || [];
    _inactiveClientsData = clients
      .filter(c => c.renewal_date && daysFromToday(c.renewal_date) < 0)
      // Most recently expired first — the ones still likely to renew.
      .sort((a, b) => daysFromToday(b.renewal_date) - daysFromToday(a.renewal_date));
    renderInactiveClientsList();
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load inactive clients</div>`;
  }
}

function renderInactiveClientsList() {
  const el = document.getElementById('inactiveClientsList');
  renderPaginatedList(el, _inactiveClientsData, LIST_PAGE_SIZE, (c) => {
    const diff    = daysFromToday(c.renewal_date);
    const initial = (c.firmname || c.clientname || '?')[0].toUpperCase();

    return `
      <button class="list-item client-item" onclick='openClientDetailByIdFrom(${JSON.stringify(c.id)}, _inactiveClientsData)'>
        <div class="item-avatar">${initial}</div>
        <div class="item-body">
          <div class="item-title">${esc(c.firmname || c.clientname)}</div>
          <div class="item-info-row">
            <span class="item-info-text">${esc(c.clientname)}</span>
            <span class="item-info-dot"></span>
            <span class="item-info-text">Expired ${formatDate(c.renewal_date)}</span>
          </div>
        </div>
        <div class="client-item-right">
          <span class="cd-renewal-pill cd-renewal--expired">Expired ${Math.abs(diff)}d ago</span>
        </div>
      </button>
    `;
  }, 'No inactive clients');
}

// Opens the existing full client-profile modal (same one the Clients tab
// uses) rather than a separate lightweight popup — "details like expired
// on etc" is exactly what that modal already shows via its renewal pill.
function openClientDetailByIdFrom(id, list) {
  const c = list.find(x => String(x.id) === String(id));
  if (c) openClientDetail(c);
}

/* ========================
   ADD TRANSACTION
   (standalone client payment — logged directly, not tied to a
   support/renewal/install service)
   ======================== */
let _transactionClients = [];

// Non-null while addTransactionModal is in edit mode -- same pattern as
// editingRecordId/editingClientId. saveTransaction() branches add-vs-update
// off this; resetTransactionForm() (run by closeModal()) clears it.
let editingPaymentId = null;

async function populateTransactionClientSelect() {
  if (_transactionClients.length) return;
  try {
    const data = await API.getClients();
    _transactionClients = data.clients || [];
  } catch (e) {}
}

function openAddTransactionModal() {
  if (!can('access_add_transaction')) { showPermissionDenied(); return; }
  openModal('addTransactionModal');
  populateTransactionClientSelect();
  resetTransactionForm();
  const dateEl = document.getElementById('at_transdate');
  if (dateEl) dateEl.value = localDateStr();
}

// Client autocomplete for the Add Transaction "Client" field — same
// pattern as the Add Record account picker, kept separate (own element
// IDs / own client cache) so the two modals never step on each other.
function filterTransactionClientSuggestions() {
  const input = document.getElementById('at_account_search');
  const box   = document.getElementById('at_account_suggestions');
  const term  = input.value.trim().toLowerCase();

  const source = _transactionClients.length ? _transactionClients : allClients;

  const matches = term
    ? source.filter(c =>
        (c.firmname || '').toLowerCase().includes(term) ||
        (c.clientname || '').toLowerCase().includes(term)
      ).slice(0, 8)
    : source.slice(0, 8);

  if (!matches.length) {
    box.innerHTML = '<div class="autocomplete-empty">No matching clients</div>';
    box.style.display = 'block';
    return;
  }

  box.innerHTML = matches.map(c => `
    <div class="autocomplete-item" onclick="selectTransactionClientSuggestion('${esc(c.clientname).replace(/'/g, "\\'")}')">
      ${esc(c.firmname || c.clientname)}
      ${c.firmname ? `<span class="ac-sub">${esc(c.clientname)}</span>` : ''}
    </div>
  `).join('');
  box.style.display = 'block';
}

function selectTransactionClientSuggestion(clientname) {
  const source = _transactionClients.length ? _transactionClients : allClients;
  const client = source.find(c => c.clientname === clientname);
  document.getElementById('at_account').value = clientname;
  document.getElementById('at_account_search').value = client ? (client.firmname || client.clientname) : clientname;
  document.getElementById('at_account_suggestions').style.display = 'none';
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('at_account_search');
  const box  = document.getElementById('at_account_suggestions');
  if (!wrap || !box) return;
  if (e.target !== wrap && !box.contains(e.target)) {
    box.style.display = 'none';
  }
});

async function saveTransaction() {
  const account = document.getElementById('at_account').value;
  const amount  = document.getElementById('at_payment_amount').value;

  if (!account) { showToast('Select a client'); return; }
  if (!amount || parseFloat(amount) <= 0) { showToast('Enter a valid payment amount'); return; }

  const isEdit = !!editingPaymentId;
  const data = {
    account,
    transdate:      document.getElementById('at_transdate').value || localDateStr(),
    payment_info:   document.getElementById('at_payment_info').value.trim(),
    payment_amount: amount,
    note:           document.getElementById('at_note').value.trim(),
  };
  if (isEdit) data.id = editingPaymentId;

  try {
    if (isEdit) await API.updatePayment(data);
    else        await API.addPayment(data);
    showToast(isEdit ? 'Transaction updated' : 'Payment recorded');
    closeModal('addTransactionModal'); // resetTransactionForm() runs via closeModal(), clearing editingPaymentId
    refreshAfterRecordChange();
  } catch (e) {
    if (e.status === 403) showPermissionDenied();
    else showToast(isEdit ? 'Failed to update transaction' : 'Failed to save payment');
  }
}

function resetTransactionForm() {
  ['at_account', 'at_account_search', 'at_payment_info', 'at_payment_amount', 'at_note'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const box = document.getElementById('at_account_suggestions');
  if (box) box.style.display = 'none';
  document.getElementById('at_transdate').value = localDateStr();

  editingPaymentId = null;
  document.getElementById('addTransactionModalTitle').textContent = 'Add Transaction';
  document.getElementById('addTransactionSaveBtn').textContent = 'Save Transaction';
}

/* ========================
   TRANSACTION HISTORY
   (Add Transactions + Renewal payments + Installation payments,
   with amount totals)
   ======================== */
let allTransactionHistory = [];
let transactionHistoryPaging = { page: 1, hasMore: false, search: '' };

function openTransactionHistory() {
  if (!can('access_transaction_history')) { showPermissionDenied(); return; }
  openModal('transactionHistoryModal');
  const search = document.getElementById('thSearch');
  if (search) search.value = '';
  loadTransactionHistory();
}

async function loadTransactionHistory(search = '') {
  const el = document.getElementById('transactionHistoryList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getTransactionHistory({ search, page: 1 });
    allTransactionHistory = data.records || [];
    transactionHistoryPaging = { page: 1, hasMore: !!data.hasMore, search };
    renderTransactionHistoryList(allTransactionHistory);
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load transaction history</div>`;
  }
}

async function fetchMoreTransactionHistory() {
  if (!transactionHistoryPaging.hasMore) return false;
  const nextPage = transactionHistoryPaging.page + 1;
  try {
    const data = await API.getTransactionHistory({ search: transactionHistoryPaging.search, page: nextPage });
    const newRows = data.records || [];
    allTransactionHistory.push(...newRows);
    transactionHistoryPaging.page = nextPage;
    transactionHistoryPaging.hasMore = !!data.hasMore;
    return newRows.length > 0;
  } catch (e) {
    return false;
  }
}

function transactionHistoryTypeLabel(type) {
  const map = { payment: 'Payment', renewal: 'Renewal', install: 'New Installation' };
  return map[(type || '').toLowerCase()] || (type || 'Transaction');
}

function renderTransactionHistoryList(records) {
  const el = document.getElementById('transactionHistoryList');
  renderPaginatedList(el, records, LIST_PAGE_SIZE, (r) => {
    const client = allClients.find(c => c.clientname === r.account) || _transactionClients.find(c => c.clientname === r.account);
    const sub = [transactionHistoryTypeLabel(r.servicetype), formatDate(r.transdate), r.payment_info].filter(Boolean).join(' · ');

    return `
      <div class="list-item" style="cursor:pointer" onclick='openTransactionHistoryDetailById(${JSON.stringify(r.id)})'>
        <div class="item-avatar" style="background:var(--surface-2)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
        </div>
        <div class="item-body">
          <div class="item-title">${esc((client && client.firmname) || r.account)}</div>
          <div class="item-sub">${sub}</div>
        </div>
        <div class="item-right" style="font-weight:700;color:var(--success);">${formatCurrency(r.payment_amount)}</div>
      </div>`;
  }, 'No transactions found', fetchMoreTransactionHistory);
}

function openTransactionHistoryDetailById(id) {
  const r = allTransactionHistory.find(x => x.id === id);
  if (r) openRecordDetail(r);
}

/* ========================
   FILE MANAGER
   ======================== */
let allFiles = [];

function openFileManager() {
  openModal('fileManagerModal');
  const search = document.getElementById('fmSearch');
  if (search) search.value = '';
  loadFileManager();
}

async function loadFileManager(search = '') {
  const el = document.getElementById('fileManagerList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getFiles({ search });
    allFiles = data.files || [];
    renderFileManagerList(allFiles);
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load files</div>`;
  }
}

function renderFileManagerList(files) {
  const el = document.getElementById('fileManagerList');
  if (!files.length) { el.innerHTML = `<div class="empty-state">No files yet</div>`; return; }
  el.innerHTML = files.map(f => {
    const linkLabel = f.record_id
      ? `Linked to ${esc(f.transid || f.servicename || ('record #' + f.record_id))}`
      : `Not linked to any record`;
    return `
    <button class="list-item" onclick='openFileDetailById(${JSON.stringify(f.id)})'>
      <div class="item-avatar" style="background:var(--surface-2)">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
      </div>
      <div class="item-body">
        <div class="item-title">${esc(f.original_name)}</div>
        <div class="item-sub">${esc(f.firmname || f.account || 'Unknown client')} · ${formatFileSize(f.filesize)}</div>
        <div class="item-sub" style="${f.record_id ? '' : 'color:var(--warning, #b45309);'}">${linkLabel}</div>
      </div>
    </button>
  `;
  }).join('');
}

function formatFileSize(bytes) {
  bytes = parseInt(bytes, 10) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatTime(dtStr) {
  if (!dtStr) return '';
  const d = new Date(dtStr.replace(' ', 'T'));
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

// Opens the File Detail modal for a given file id — used from both the
// File Manager list (already has the object in allFiles) and the record
// detail's Files pill (which might not, e.g. before File Manager was ever
// opened this session) — that path fetches the single file instead.
function openFileDetailById(id) {
  const f = allFiles.find(x => x.id === id);
  if (f) { openFileDetail(f); return; }
  loadAndOpenFileDetail(id);
}

async function loadAndOpenFileDetail(id) {
  try {
    const data = await API.getFileInfo(id);
    if (data.file) openFileDetail(data.file);
  } catch (e) { showToast('Failed to load file'); }
}

function openFileDetail(f) {
  const body = document.getElementById('fileDetailBody');
  body.innerHTML = `
    <div class="rdm-section" style="margin-top:0;">
      ${rdmRow('File Name', f.original_name)}
      ${rdmRow('Client', f.firmname || f.account || '—')}
      ${rdmRow('Uploaded', formatDate(f.created_at))}
      ${rdmRow('Size', formatFileSize(f.filesize))}
    </div>
    <div class="rdm-section" id="fileLinkSection" style="display:none;">
      <div class="rdm-section-title">Shareable Link</div>
      <div class="form-group">
        <input type="text" id="fileLinkInput" readonly
               style="font-size:13px;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);color:var(--text-primary);width:100%;box-sizing:border-box;" />
      </div>
      <div id="fileLinkExpiry" style="font-size:12px;color:var(--text-secondary);"></div>
    </div>
  `;
  const footer = document.getElementById('fileDetailFooter');
  footer.innerHTML = `
    <button class="btn btn-ghost" onclick="closeModal('fileDetailModal')">Close</button>
    <button class="btn btn-ghost" onclick="generateFileLinkFor(${f.id})">Generate Link</button>
    <button class="btn btn-primary" onclick="downloadFileNow(${f.id})">Download</button>
  `;
  openModal('fileDetailModal');
}

function downloadFileNow(id) {
  window.open(API.base + 'files.php?download=' + id, '_blank');
}

async function generateFileLinkFor(id) {
  try {
    const data = await API.generateFileLink(id);
    const section = document.getElementById('fileLinkSection');
    const input   = document.getElementById('fileLinkInput');
    const expiry  = document.getElementById('fileLinkExpiry');
    if (!section || !input) return;

    section.style.display = 'block';
    input.value = data.url;
    input.select?.();

    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(data.url);
        showToast('Link copied — valid for 10 minutes');
      } catch (e) {
        showToast('Link generated — valid for 10 minutes');
      }
    } else {
      showToast('Link generated — valid for 10 minutes');
    }

    if (expiry) expiry.textContent = 'Expires at ' + formatTime(data.expires_at);
  } catch (e) {
    showToast('Failed to generate link');
  }
}

/* ========================
   QUICK LINKS — admin pastes links (tools used anywhere), everyone with
   access_quick_links can view + copy them. Add/Edit/Delete are hard
   admin-only, enforced server-side in quicklinks.php regardless of what
   the client sends — same non-toggleable pattern as Add User / Set User.
   ======================== */
let _quickLinks = [];
let _editingQuickLinkId = null;

function openQuickLinks() {
  const addBtn = document.getElementById('qlAddBtn');
  if (addBtn) addBtn.classList.toggle('perm-hidden', !isAdmin());
  openModal('quickLinksModal');
  loadQuickLinks();
}

async function loadQuickLinks() {
  const el = document.getElementById('quickLinksList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getQuickLinks();
    _quickLinks = data.links || [];
    renderQuickLinksList();
  } catch (e) {
    if (e.status === 403) { closeModal('quickLinksModal'); showPermissionDenied(); return; }
    el.innerHTML = `<div class="empty-state">Failed to load quick links</div>`;
  }
}

function renderQuickLinksList() {
  const el = document.getElementById('quickLinksList');
  if (!_quickLinks.length) { el.innerHTML = `<div class="empty-state">No quick links yet</div>`; return; }
  const admin = isAdmin();
  el.innerHTML = _quickLinks.map(l => `
    <div class="list-item" style="cursor:default;align-items:flex-start;">
      <div class="item-avatar" style="background:var(--surface-2)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a3.5 3.5 0 0 0 5 0l4 -4a3.5 3.5 0 0 0 -5 -5l-.5 .5"/><path d="M14 10a3.5 3.5 0 0 0 -5 0l-4 4a3.5 3.5 0 0 0 5 5l.5 -.5"/></svg>
      </div>
      <div class="item-body">
        <div class="item-title">${esc(l.title)}</div>
        <div class="item-sub" style="word-break:break-all;">${esc(l.url)}</div>
        ${l.notes ? `<div class="item-sub">${esc(l.notes)}</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" onclick='copyQuickLink(${JSON.stringify(l.url)})'>Copy Link</button>
          ${admin ? `
            <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" onclick="openEditQuickLink(${l.id})">Edit</button>
            <button class="btn btn-danger" style="padding:6px 12px;font-size:12px;" onclick="confirmDeleteQuickLink(${l.id})">Delete</button>
          ` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

async function copyQuickLink(url) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } else {
      showToast('Copy not supported on this device');
    }
  } catch (e) {
    showToast('Failed to copy link');
  }
}

function openAddQuickLink() {
  if (!isAdmin()) { showPermissionDenied('Only admins can manage Quick Links.'); return; }
  _editingQuickLinkId = null;
  document.getElementById('qlModalTitle').textContent = 'Add Quick Link';
  document.getElementById('ql_title').value = '';
  document.getElementById('ql_url').value   = '';
  document.getElementById('ql_notes').value = '';
  openModal('quickLinkFormModal');
}

function openEditQuickLink(id) {
  if (!isAdmin()) { showPermissionDenied('Only admins can manage Quick Links.'); return; }
  const link = _quickLinks.find(l => l.id === id);
  if (!link) return;
  _editingQuickLinkId = id;
  document.getElementById('qlModalTitle').textContent = 'Edit Quick Link';
  document.getElementById('ql_title').value = link.title || '';
  document.getElementById('ql_url').value   = link.url || '';
  document.getElementById('ql_notes').value = link.notes || '';
  openModal('quickLinkFormModal');
}

async function saveQuickLink() {
  if (!isAdmin()) { showPermissionDenied('Only admins can manage Quick Links.'); return; }
  const title = document.getElementById('ql_title').value.trim();
  const url   = document.getElementById('ql_url').value.trim();
  const notes = document.getElementById('ql_notes').value.trim();
  if (!title || !url) { showToast('Title and URL are required'); return; }

  const btn = document.getElementById('qlSaveBtn');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  try {
    if (_editingQuickLinkId) {
      await API.updateQuickLink({ id: _editingQuickLinkId, title, url, notes });
      showToast('Quick link updated');
    } else {
      await API.addQuickLink({ title, url, notes });
      showToast('Quick link added');
    }
    closeModal('quickLinkFormModal');
    loadQuickLinks();
  } catch (e) {
    if (e.status === 403) { showPermissionDenied('Only admins can manage Quick Links.'); return; }
    showToast(e.body?.error || 'Failed to save quick link');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

function confirmDeleteQuickLink(id) {
  if (!isAdmin()) { showPermissionDenied('Only admins can manage Quick Links.'); return; }
  const link = _quickLinks.find(l => l.id === id);
  if (!link) return;
  showConfirm(
    'Delete quick link?',
    `"${link.title}" will be permanently removed.`,
    async () => {
      try {
        await API.deleteQuickLink(id);
        showToast('Quick link deleted');
        loadQuickLinks();
      } catch (e) {
        if (e.status === 403) { showPermissionDenied('Only admins can manage Quick Links.'); return; }
        showToast('Failed to delete quick link');
      }
    }
  );
}

// Loads and renders the "Files" section inside a Record Detail modal as
// full clickable rows (icon + name + size, chevron to hint it opens the
// File Detail modal) — matches the File Manager's row style instead of
// a small pill, so it reads clearly as tappable.
// Hides the whole section when the record has no attached files.
async function loadRecordFiles(recordId) {
  const section = document.getElementById('rdm-files-section');
  const list    = document.getElementById('rdm-files-list');
  if (!section || !list) return;
  try {
    const data  = await API.getFilesForRecord(recordId);
    const files = data.files || [];
    if (!files.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    list.innerHTML = files.map(f => `
      <div class="rdm-file-row" onclick='openFileDetailById(${JSON.stringify(f.id)})'>
        <div class="rdm-file-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
        </div>
        <div class="rdm-file-info">
          <div class="rdm-file-name">${esc(f.original_name)}</div>
          <div class="rdm-file-meta">${formatFileSize(f.filesize)}${f.created_at ? ' · ' + formatDate(f.created_at) : ''}</div>
        </div>
        <svg class="rdm-file-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    `).join('');
  } catch (e) {
    section.style.display = 'none';
  }
}

/* =============================================
   Record View Modal — paste into app.js
   (or add as a new <script> after app.js)
   ============================================= */
 
/* ── TYPE CONFIG ──────────────────────────────
   Maps servicetype → { icon, color, label, fields[] }
   Each field: { key, label, format? }
   ─────────────────────────────────────────── */
const RECORD_TYPE_CONFIG = {
  support: {
    label: 'Support / Visit',
    color: '--info',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    sections: [
      {
        title: 'Query Details',
        fields: [
          { key: 'query',      label: 'Query' },
          { key: 'query_note', label: 'Note' },
        ]
      }
    ]
  },
  renewal: {
    label: 'Renewal',
    color: '--success',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    sections: [
      {
        title: 'Renewal Details',
        fields: [
          { key: 'renewaldate',    label: 'Renewal Date',  format: 'date' },
          { key: 'next_renewal',   label: 'Next Renewal',  format: 'date' },
          { key: 'payment_info',   label: 'Payment Info' },
          { key: 'payment_amount', label: 'Payment Amount', format: 'currency' },
          { key: 'query_note',     label: 'Note' },
        ]
      }
    ]
  },
  'system change': {
    label: 'System Change',
    color: '--warning',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    sections: [
      {
        title: 'System IDs',
        fields: [
          { key: 'systemid',     label: 'Old System ID', pill: true },
          { key: 'new_systemid', label: 'New System ID', pill: true, accent: true },
          { key: 'query_note',   label: 'Note' },
        ]
      }
    ]
  },
  install: {
    label: 'New Installation',
    color: '--accent',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
    sections: [
      {
        title: 'Installation Details',
        fields: [
          { key: 'systemid',       label: 'System ID',    pill: true },
          { key: 'renewaldate',    label: 'Renewal Date', format: 'date' },
          { key: 'payment_info',   label: 'Payment Info' },
          { key: 'payment_amount', label: 'Payment Amount', format: 'currency' },
          { key: 'query_note',     label: 'Note' },
        ]
      }
    ]
  },
  payment: {
    label: 'Payment',
    color: '--success',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    sections: [
      {
        title: 'Payment Details',
        fields: [
          { key: 'payment_info',   label: 'Payment Info' },
          { key: 'payment_amount', label: 'Amount', format: 'currency' },
          { key: 'query_note',     label: 'Note' },
        ]
      }
    ]
  }
};
 
/* Fallback for unknown service types */
const RECORD_TYPE_DEFAULT = {
  label: 'Transaction',
  color: '--text-secondary',
  icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>`,
  sections: [
    {
      title: 'Details',
      fields: [
        { key: 'query',          label: 'Query' },
        { key: 'query_note',     label: 'Note' },
        { key: 'payment_info',   label: 'Payment Info' },
        { key: 'payment_amount', label: 'Payment Amount', format: 'currency' },
        { key: 'renewaldate',    label: 'Renewal Date', format: 'date' },
        { key: 'next_renewal', label: 'Next Renewal',  format: 'date' },
        { key: 'systemid',     label: 'System ID',    pill: true },
        { key: 'new_systemid', label: 'New System ID', pill: true, accent: true },
      ]
    }
  ]
};
 
/* ── OPEN MODAL ───────────────────────────────── */
// ── Safe click handlers for list items ──────────────────────────────────
// These take only a numeric id (never raw record text) and look the full
// object up from the in-memory array. Embedding JSON.stringify(record)
// directly inside an onclick='...' attribute is unsafe: JSON.stringify
// escapes double quotes but NOT single quotes, so a single quote in any
// user-entered field (a client name, a note, etc.) breaks out of the
// attribute and lets arbitrary HTML/JS run for anyone who views that list.
// Passing a plain integer id sidesteps that entirely — there's no user
// text in the attribute to escape.
// Shortcut from the record detail popup straight into Quick Message,
// pre-filled with this record's client (mirrors sendRenewalReminderFromDetail).
async function sendRecordMessageFromDetail(clientname) {
  if (!can('access_quick_message')) { showPermissionDenied(); return; }
  closeModal('recordDetailModal');
  openModal('quickMessageModal');

  await populateQuickMessageClients();
  await populateQuickMessageTemplates();

  const source = _qmClients.length ? _qmClients : allClients;
  const c = source.find(cl => cl.clientname === clientname);

  document.getElementById('qm_account').value = clientname;
  document.getElementById('qm_account_search').value = c ? (c.firmname || c.clientname) : clientname;
  populateQmNumberDropdown(c);
}

function openRecordDetailById(id)   { const r = allRecords.find(x => x.id === id);   if (r) openRecordDetail(r); }
function openFollowupDetailById(id) { const f = allFollowups.find(x => x.id === id); if (f) openFollowupDetail(f); }
function openClientDetailById(id)   { const c = allClients.find(x => x.id === id);   if (c) openClientDetail(c); }

// Tracks which record the detail modal is currently showing, same pattern
// as currentDetailClient, so the header's Edit/Delete buttons know what
// to act on.
let currentDetailRecord = null;

function openRecordDetail(r) {
  currentDetailRecord = r;
  const type   = (r.servicetype || '').toLowerCase();
  const config = RECORD_TYPE_CONFIG[type] || RECORD_TYPE_DEFAULT;
  const status = r.status || 'pending';

  const editBtn   = document.getElementById('rdmEditBtn');
  const deleteBtn = document.getElementById('rdmDeleteBtn');
  if (editBtn)   editBtn.style.display   = can('can_edit_record')   ? '' : 'none';
  if (deleteBtn) deleteBtn.style.display = can('can_delete_record') ? '' : 'none';
 
  /* ── Header title ── */
  document.getElementById('rdm-title').textContent = r.servicename || 'Record Details';
 
  /* ── Body ── */
  const body = document.getElementById('rdm-body');
  body.innerHTML = `
 
    <!-- Hero block: account + type badge -->
    <div class="rdm-hero">
<div class="rdm-hero-avatar">${((allClients.find(c => c.clientname === r.account)?.firmname) || r.account || '?')[0].toUpperCase()}</div>
      <div class="rdm-hero-info">
<div class="rdm-hero-name">${esc((allClients.find(c => c.clientname === r.account)?.firmname) || r.account)}</div>
        <div class="rdm-hero-meta">
          <span class="rdm-type-badge" style="--type-color:var(${config.color})">
            ${config.icon}
            ${config.label}
          </span>
          ${badgeHtml(status)}
        </div>
      </div>
    </div>
 
    <!-- Common fields (always shown) -->
    <div class="rdm-section">
      <div class="rdm-section-title">Transaction</div>
      ${rdmRow('Transaction ID', r.transid, { mono: true })}
      ${rdmRow('Service',        r.servicename)}
      ${rdmRow('Date',           formatDate(r.transdate))}
      ${rdmRow('Recorded By',    r.user)}
    </div>
 
    <!-- Dynamic sections per type -->
    ${config.sections.map(sec => {
      const rows = sec.fields
        .map(f => {
          const val = r[f.key];
          if (!val) return '';
          const display = f.format === 'date' ? formatDate(val) : (f.format === 'currency' ? formatCurrency(val) : val);
          return rdmRow(f.label, display, { pill: f.pill, accent: f.accent });
        })
        .filter(Boolean)
        .join('');
      if (!rows) return '';
      return `
        <div class="rdm-section">
          <div class="rdm-section-title">${sec.title}</div>
          ${rows}
        </div>`;
    }).join('')}

    <!-- Files attached to this record — filled in by loadRecordFiles() below -->
    <div class="rdm-section" id="rdm-files-section" style="display:none;">
      <div class="rdm-section-title">Files</div>
      <div id="rdm-files-list" class="rdm-files-list"></div>
    </div>
 
  `;
 
  /* ── Footer ── */
  const footer = document.getElementById('rdm-footer');
  if (status === 'pending') {
    footer.innerHTML = `
      <button class="btn btn-ghost" style="flex:1" onclick="sendRecordMessageFromDetail('${esc(r.account).replace(/'/g, "\\'")}')">Message</button>
      <button class="btn btn-primary" style="flex:1" onclick="markRecordDone(${r.id})">Mark Done</button>
      <button class="btn btn-ghost" style="flex:1" onclick="closeModal('recordDetailModal')">Close</button>`;
  } else {
    footer.innerHTML = `<button class="btn btn-ghost" style="flex:1" onclick="closeModal('recordDetailModal')">Close</button>`;
  }
 
  openModal('recordDetailModal');
  loadRecordFiles(r.id);
}
 
/* ── ROW HELPER ─────────────────────────────── */
function rdmRow(label, value, opts = {}) {
  if (!value) return '';
  let valHtml;
  if (opts.pill && opts.accent) {
    valHtml = `<span class="rdm-pill rdm-pill--accent">${esc(value)}</span>`;
  } else if (opts.pill) {
    valHtml = `<span class="rdm-pill">${esc(value)}</span>`;
  } else if (opts.mono) {
    valHtml = `<span class="rdm-mono">${esc(value)}</span>`;
  } else {
    valHtml = `<span class="rdm-val">${esc(value)}</span>`;
  }
  return `
    <div class="rdm-row">
      <span class="rdm-label">${label}</span>
      ${valHtml}
    </div>`;
}
 
/* ── MARK DONE ──────────────────────────────── */
async function markRecordDone(id) {
  try {
    await API.post('records.php', { action: 'update_status', id, status: 'done' });
    showToast('Marked as done');
    closeModal('recordDetailModal');
    loadRecords(document.getElementById('recordSearch')?.value || '');
  } catch(e) {
    showToast('Failed to update record');
  }
}

/* -- EDIT / DELETE --
   A record in this modal is either a regular record (support/renewal/
   system change/install -- edited via the Add Record modal, same as
   creating one) or a direct payment tagged servicetype='payment' (edited
   via the separate Add Transaction modal, since its fields are different).
   Both branches key off currentDetailRecord rather than taking an id, same
   as openEditClientFromDetail(). */
function openEditRecordFromDetail() {
  const r = currentDetailRecord;
  if (!r) return;
  if (!can('can_edit_record')) { showPermissionDenied(); return; }

  if ((r.servicetype || '').toLowerCase() === 'payment') {
    editingPaymentId = r.id;
    document.getElementById('addTransactionModalTitle').textContent = 'Edit Transaction';
    document.getElementById('addTransactionSaveBtn').textContent = 'Save Changes';

    const client = allClients.find(c => c.clientname === r.account);
    document.getElementById('at_account').value = r.account || '';
    document.getElementById('at_account_search').value = client ? (client.firmname || client.clientname) : (r.account || '');
    document.getElementById('at_transdate').value = (r.transdate || '').split(' ')[0];
    document.getElementById('at_payment_info').value = r.payment_info || '';
    document.getElementById('at_payment_amount').value = r.payment_amount || '';
    document.getElementById('at_note').value = r.query_note || '';

    closeModal('recordDetailModal');
    openModal('addTransactionModal');
    return;
  }

  editingRecordId = r.id;
  document.getElementById('addRecordModalTitle').textContent = 'Edit Record';
  document.getElementById('addRecordSaveBtn').textContent = 'Save Changes';

  const client = allClients.find(c => c.clientname === r.account);
  document.getElementById('r_account').value = r.account || '';
  document.getElementById('r_account_search').value = client ? (client.firmname || client.clientname) : (r.account || '');
  document.getElementById('r_transdate').value = (r.transdate || '').split(' ')[0];

  // Status toggle
  const sel = document.getElementById('r_status');
  sel.value = r.status || 'pending';
  const toggle = document.getElementById('r_status_toggle');
  const thumb  = document.getElementById('r_status_thumb');
  const label  = document.getElementById('r_status_label');
  if (sel.value === 'done') {
    label.textContent = 'Done';
    toggle.style.background = 'var(--accent)';
    thumb.style.transform = 'translateX(20px)';
  } else {
    label.textContent = 'Pending';
    toggle.style.background = 'var(--border)';
    thumb.style.transform = 'translateX(0)';
  }

  // Populate the service dropdown, then select this record's service and
  // reveal the matching field group -- mirrors what onServiceSelect() does
  // when a user picks a service manually.
  populateServiceSelect().then(() => {
    const serviceSel = document.getElementById('r_service');
    if (r.serviceid) serviceSel.value = r.serviceid;
    serviceSel.dataset.serviceType = (r.servicetype || '').toLowerCase();
    serviceSel.dataset.serviceName = r.servicename || '';
    onServiceSelect();

    const type = (r.servicetype || '').toLowerCase();
    if (type === 'support') {
      document.getElementById('r_query').value = r.query || '';
      document.getElementById('r_query_note').value = r.query_note || '';
    } else if (type === 'renewal') {
      document.getElementById('r_renewal_date').value = r.renewaldate || '';
      document.getElementById('r_payment_info').value = r.payment_info || '';
      document.getElementById('r_payment_amount').value = r.payment_amount || '';
      document.getElementById('r_next_renewal').value = r.next_renewal || '';
      document.getElementById('r_renewal_note').value = r.query_note || '';
    } else if (type === 'system change') {
      document.getElementById('r_systemid').value = r.systemid || '';
      document.getElementById('r_new_systemid').value = r.new_systemid || '';
      document.getElementById('r_syschange_note').value = r.query_note || '';
    } else if (type === 'install') {
      document.getElementById('r_install_payment_info').value = r.payment_info || '';
      document.getElementById('r_install_payment_amount').value = r.payment_amount || '';
      document.getElementById('r_install_note').value = r.query_note || '';
    }

    // Files group only exists for support/renewal/install (see
    // onServiceSelect() above) — system change never shows it.
    if (type === 'support' || type === 'renewal' || type === 'install') {
      loadExistingRecordFiles(r.id);
    }
  });

  closeModal('recordDetailModal');
  openModal('addRecordModal');
}

function confirmDeleteRecord() {
  const r = currentDetailRecord;
  if (!r) return;
  if (!can('can_delete_record')) { showPermissionDenied(); return; }

  const isPayment = (r.servicetype || '').toLowerCase() === 'payment';
  showConfirm(
    isPayment ? 'Delete transaction?' : 'Delete record?',
    `This will be moved to Archives and can be restored within 30 days.`,
    async () => {
      try {
        await API.deleteRecord(r.id);
        showToast(isPayment ? 'Transaction deleted' : 'Record deleted');
        closeModal('recordDetailModal');
        refreshAfterRecordChange();
      } catch (e) {
        if (e.status === 403) showPermissionDenied();
        else showToast('Failed to delete');
      }
    }
  );
}
 


/* ========================
   INIT
   ======================== */
/* ====== AUTH - LOGIN SCREEN (SPA) ====== */

function showLoginScreen() {
  const screen = document.getElementById('loginScreen');
  const topBar = document.getElementById('topBar');
  const mainContent = document.getElementById('mainContent');
  const bottomNav = document.getElementById('bottomNav');
  if (screen) screen.classList.remove('hidden');
  if (topBar) topBar.style.display = 'none';
  if (mainContent) mainContent.style.display = 'none';
  if (bottomNav) bottomNav.style.display = 'none';

  // Prefill username/password if they were saved from a previous
  // "Keep me logged in" login. Only fills the fields — actually logging
  // in still requires pressing Sign In (or Enter).
  const savedUsername = localStorage.getItem('crm_saved_username');
  const savedPassword = localStorage.getItem('crm_saved_password');
  if (savedUsername !== null && savedPassword !== null) {
    const uField = document.getElementById('loginUsername');
    const pField = document.getElementById('loginPassword');
    const rBox   = document.getElementById('loginRemember');
    if (uField) uField.value = savedUsername;
    if (pField) pField.value = savedPassword;
    if (rBox)   rBox.checked = true;
  }
}

function hideLoginScreen() {
  const screen = document.getElementById('loginScreen');
  const topBar = document.getElementById('topBar');
  const mainContent = document.getElementById('mainContent');
  const bottomNav = document.getElementById('bottomNav');
  if (screen) screen.classList.add('hidden');
  if (topBar) topBar.style.display = '';
  if (mainContent) mainContent.style.display = '';
  if (bottomNav) bottomNav.style.display = '';
}

function loginTogglePassword() {
  const inp = document.getElementById('loginPassword');
  const open = document.getElementById('loginEyeOpen');
  const closed = document.getElementById('loginEyeClosed');
  if (inp.type === 'password') {
    inp.type = 'text';
    open.style.display = 'none';
    closed.style.display = 'block';
  } else {
    inp.type = 'password';
    open.style.display = 'block';
    closed.style.display = 'none';
  }
}

function loginShowError(msg) {
  const box = document.getElementById('loginError');
  const txt = document.getElementById('loginErrorText');
  txt.textContent = msg;
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
  document.getElementById('loginUsername').classList.add('err');
  document.getElementById('loginPassword').classList.add('err');
}

function loginClearError() {
  document.getElementById('loginError').classList.remove('show');
  document.getElementById('loginUsername').classList.remove('err');
  document.getElementById('loginPassword').classList.remove('err');
}

async function doLogin() {
  loginClearError();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const remember = document.getElementById('loginRemember').checked;

  if (!username || !password) {
    loginShowError('Please enter your username and password.');
    return;
  }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.classList.add('loading');

  try {
    const res = await fetch('api/auth.php?action=login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password, remember })
    });
    const data = await res.json();

    if (data.success) {
      // Save (or clear) the credentials for next time, based on the
      // checkbox — separate from the server-side "remember" flag, which
      // controls how long the session/cookie itself stays valid.
      if (remember) {
        localStorage.setItem('crm_saved_username', username);
        localStorage.setItem('crm_saved_password', password);
      } else {
        localStorage.removeItem('crm_saved_username');
        localStorage.removeItem('crm_saved_password');
      }
      window.location.reload();
    } else {
      loginShowError(data.error || 'Invalid username or password.');
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  } catch(e) {
    loginShowError('Connection error. Please try again.');
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// Enter key on login screen
document.addEventListener('keydown', e => {
  const screen = document.getElementById('loginScreen');
  if (e.key === 'Enter' && screen && !screen.classList.contains('hidden')) {
    doLogin();
  }
});

/* ========================
   ADD USER (admin only)
   ======================== */

function resetAddUserForm() {
  ['au_username', 'au_password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const roleEl = document.getElementById('au_role');
  if (roleEl) roleEl.value = 'viewer';
  const errEl = document.getElementById('auError');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
}

function showAddUserError(msg) {
  const errEl = document.getElementById('auError');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
}

async function saveAddUser() {
  const username = document.getElementById('au_username').value.trim();
  const password = document.getElementById('au_password').value;
  const role     = document.getElementById('au_role').value;

  const errEl = document.getElementById('auError');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  if (!username || !password) { showAddUserError('Username and password are required.'); return; }
  if (password.length < 6)    { showAddUserError('Password must be at least 6 characters.'); return; }

  const btn = document.getElementById('auSaveBtn');
  btn.disabled = true;
  try {
    await API.addUser({ username, password, role });
    closeModal('addUserModal');
    showToast('User created');
    // If Set User is already open behind this, refresh it so the new
    // account shows up immediately instead of needing a manual reopen.
    if (document.getElementById('setUserModal')?.classList.contains('open')) {
      loadSetUserList();
    }
  } catch (e) {
    showAddUserError((e.body && e.body.error) || e.message || 'Failed to create user.');
  } finally {
    btn.disabled = false;
  }
}

/* ========================
   SET USER — user list + per-user permission editor (admin only)
   ======================== */

// Grouped for display only — the actual list of valid keys always comes
// from the server (data.permission_keys), so a key added later in
// helpers.php still renders even if this map hasn't been updated yet
// (it just falls back to the raw key name via PERMISSION_LABELS[k] || k).
const PERMISSION_GROUPS = [
  { title: 'Clients',    keys: ['can_add_client', 'can_edit_client', 'can_delete_client'] },
  { title: 'Records',    keys: ['can_add_record', 'can_edit_record', 'can_delete_record'] },
  { title: 'Follow-ups', keys: ['can_add_followup', 'can_edit_followup', 'can_delete_followup', 'can_update_followup_status'] },
  { title: 'Messaging',  keys: ['can_send_reminder', 'access_quick_message'] },
  { title: 'Phone Number Visibility', keys: ['view_phone_clients', 'view_phone_renewals', 'view_phone_followups'] },
  { title: 'Screen Access', keys: ['access_renewals', 'access_inactive_clients', 'access_add_transaction', 'access_transaction_history', 'access_pending_records', 'access_file_manager', 'access_quick_links'] },
  { title: 'View Access',   keys: ['view_clients', 'view_records', 'view_followups'] },
];
// Logs isn't in any group above — it's hard admin-only (see api/logs.php),
// same as Add User / Set User / Archives, so it never appears as a toggle.

const PERMISSION_LABELS = {
  can_add_client: 'Add Client', can_edit_client: 'Edit Client', can_delete_client: 'Delete Client',
  can_add_record: 'Add Record', can_edit_record: 'Edit Record', can_delete_record: 'Delete Record',
  can_add_followup: 'Add Follow-up', can_edit_followup: 'Edit Follow-up', can_delete_followup: 'Delete Follow-up',
  can_update_followup_status: 'Complete / Cancel Follow-up',
  can_send_reminder: 'Send Reminder (Renewal Details)', access_quick_message: 'Quick Message screen',
  view_phone_clients: 'Show phone in Clients list & detail', view_phone_renewals: 'Show phone in Renewal Details',
  view_phone_followups: 'Show phone in Follow-ups',
  access_renewals: 'Upcoming Renewals', access_inactive_clients: 'Inactive Clients',
  access_add_transaction: 'Add Transaction', access_transaction_history: 'Transaction History',
  access_pending_records: 'Pending Records', access_file_manager: 'File Manager screen',
  access_quick_links: 'Quick Links screen',
  view_clients: 'View Clients screen', view_records: 'View Records screen',
  view_followups: 'View Follow-ups screen',
};

function roleLabel(role) {
  return { admin: 'Admin', support: 'Support', onsite: 'Onsite', viewer: 'Viewer' }[role] || role;
}

let _setUserUsers    = [];
let _editingUserUid  = null;
let _editingUserPerms = {};
// Enable/Disable + login-hours are now held as local pending state, same
// as _editingUserPerms above, instead of writing to the server the moment
// a toggle is clicked. _editingUserAccessOriginal is the last-saved
// snapshot (what's actually live on the server) so saveUserPermissions()
// can diff against it and only send the calls for whatever actually
// changed, rather than re-writing everything on every save.
let _editingUserAccess = {};
let _editingUserAccessOriginal = {};

async function loadSetUserList() {
  const el = document.getElementById('setUserList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getUsers();
    _setUserUsers = data.users || [];
    renderSetUserList();
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load users</div>`;
  }
}

function renderSetUserList() {
  const el = document.getElementById('setUserList');
  renderPaginatedList(el, _setUserUsers, LIST_PAGE_SIZE, (u) => {
    const initial = (u.username || '?')[0].toUpperCase();
    return `
      <button class="list-item client-item" onclick="openUserPermissionsEditor(${u.uid})">
        <div class="item-avatar">${initial}</div>
        <div class="item-body">
          <div class="item-title">${esc(u.username)}</div>
          <div class="item-sub">${lastActiveLabel(u.last_active)}</div>
        </div>
        <div class="client-item-right">
          <span class="badge badge-active">${esc(roleLabel(u.role))}</span>
        </div>
      </button>
    `;
  }, 'No staff accounts yet');
}

// Finer-grained than timeAgo() (which only buckets by day) — useful here
// specifically for spotting stale/unused logins, so minutes/hours matter
// for anything recent.
function lastActiveLabel(dateStr) {
  if (!dateStr) return 'Never logged in';
  const date = new Date(dateStr.replace(' ', 'T'));
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1)   return 'Active just now';
  if (mins < 60)  return `Active ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Active yesterday';
  if (days < 30)  return `Active ${days}d ago`;
  return `Last active ${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })}`;
}

function openUserPermissionsEditor(uid) {
  const user = _setUserUsers.find(u => u.uid === uid);
  if (!user) return;
  _editingUserUid   = uid;
  _editingUserPerms = { ...user.permissions };
  _editingUserAccess = {
    role:                user.role,
    active:              !!user.active,
    login_hours_enabled: !!user.login_hours_enabled,
    login_start:         user.login_start || '09:00',
    login_end:           user.login_end   || '19:00',
  };
  _editingUserAccessOriginal = { ..._editingUserAccess };

  document.getElementById('upTitle').textContent      = user.username;
  document.getElementById('upRoleLabel').textContent   = roleLabel(user.role);
  document.querySelectorAll('#upRolePresets .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.role === user.role);
  });

  renderUserAccessControls();
  renderUserPermissionsBody();
  openModal('userPermissionsModal');
}

// Enable/Disable + login-hours toggles. These used to persist the instant
// they were clicked, decoupled from the "Save Permissions" button below —
// which turned out to be more surprising than helpful (a toggle here would
// silently take effect even if the admin then closed the modal without
// saving). They now behave exactly like the permission toggles: local
// pending state, rendered from _editingUserAccess, committed only when
// Save Permissions is clicked.
function renderUserAccessControls() {
  const state = _editingUserAccess;
  document.getElementById('upActiveToggle').classList.toggle('on', !!state.active);

  const isAdmin = state.role === 'admin';
  const hoursToggle = document.getElementById('upLoginHoursToggle');
  const hoursTimes  = document.getElementById('upLoginHoursTimes');
  const hoursSub    = document.getElementById('upLoginHoursSub');

  hoursToggle.classList.toggle('on', !!state.login_hours_enabled);
  hoursToggle.classList.toggle('perm-hidden', isAdmin);
  document.getElementById('upLoginStart').value = state.login_start || '09:00';
  document.getElementById('upLoginEnd').value   = state.login_end   || '19:00';
  hoursTimes.style.display = state.login_hours_enabled ? 'flex' : 'none';
  hoursSub.textContent = isAdmin
    ? 'Admins are always exempt from login-hours restrictions.'
    : 'Only allow login between these hours.';
}

function toggleUserActiveInEditor() {
  if (!_editingUserUid) return;
  _editingUserAccess.active = !_editingUserAccess.active;
  renderUserAccessControls();
}

function toggleLoginHoursInEditor() {
  if (!_editingUserUid) return;
  if (_editingUserAccess.role === 'admin') return; // admins are hard-exempt, toggle is hidden for them
  _editingUserAccess.login_hours_enabled = !_editingUserAccess.login_hours_enabled;
  renderUserAccessControls();
}

// Just updates the pending local values — no API call. Renamed from
// saveLoginHoursFromEditor() since it no longer saves anything itself.
function onUserLoginTimeChange() {
  _editingUserAccess.login_start = document.getElementById('upLoginStart').value || '09:00';
  _editingUserAccess.login_end   = document.getElementById('upLoginEnd').value   || '19:00';
}

function renderUserPermissionsBody() {
  const el = document.getElementById('userPermissionsBody');
  el.innerHTML = PERMISSION_GROUPS.map(g => `
    <div class="perm-group">
      <div class="perm-group-title">${g.title}</div>
      ${g.keys.map(k => `
        <div class="perm-toggle-row">
          <span class="perm-toggle-label">${esc(PERMISSION_LABELS[k] || k)}</span>
          <div class="perm-toggle ${_editingUserPerms[k] ? 'on' : ''}" onclick="togglePermInEditor('${k}')">
            <div class="perm-toggle-thumb"></div>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function togglePermInEditor(key) {
  _editingUserPerms[key] = !_editingUserPerms[key];
  renderUserPermissionsBody();
}

function applyRolePresetInEditor(role) {
  if (!_editingUserUid) return;
  showConfirm(
    'Reset to role default?',
    `This overwrites every permission toggle below with the standard ${roleLabel(role)} preset for this user.`,
    async () => {
      try {
        await API.applyRolePreset({ uid: _editingUserUid, role });
        showToast(`Permissions reset to ${roleLabel(role)} default`);
        const uid = _editingUserUid;
        await loadSetUserList();
        openUserPermissionsEditor(uid);
      } catch (e) {
        showToast('Failed to reset permissions');
      }
    },
    'Reset'
  );
}

async function saveUserPermissions() {
  if (!_editingUserUid) return;
  const btn = document.getElementById('upSaveBtn');
  btn.disabled = true;
  try {
    // Account-access changes (Enable/Disable, Login Hours) are now pending
    // local state just like the permission toggles below — commit whatever
    // actually changed here, alongside them, so nothing in this screen
    // applies until this button is clicked.
    const orig = _editingUserAccessOriginal;
    const next = _editingUserAccess;

    if (next.active !== orig.active) {
      await API.setUserActive({ uid: _editingUserUid, active: next.active });
    }
    if (next.login_hours_enabled !== orig.login_hours_enabled
        || next.login_start !== orig.login_start
        || next.login_end   !== orig.login_end) {
      await API.setUserLoginHours({
        uid:     _editingUserUid,
        enabled: next.login_hours_enabled,
        start:   next.login_start,
        end:     next.login_end,
      });
    }

    await API.setUserPermissions({ uid: _editingUserUid, permissions: _editingUserPerms });
    showToast('Permissions saved');
    closeModal('userPermissionsModal');
    loadSetUserList();
  } catch (e) {
    // Surface the backend's actual reason (e.g. "You can't disable your
    // own account.") instead of a generic message, since that guard can
    // now only be discovered here rather than at the moment of toggling.
    showToast((e.body && e.body.error) || 'Failed to save permissions');
  } finally {
    btn.disabled = false;
  }
}

// Deletes the account currently open in the permissions editor. Lives in
// the editor's own Danger Zone (bottom of the modal, below every toggle)
// rather than the Set User list, so it's a deliberate second step, not a
// stray tap on the user list row. Server enforces admin-only and blocks
// deleting your own account, same as everywhere else in Set User.
function confirmDeleteUserInEditor() {
  if (!_editingUserUid) return;
  const user = _setUserUsers.find(u => u.uid === _editingUserUid);
  const name = user ? user.username : 'this user';
  showConfirm(
    'Delete user?',
    `${name}'s account will be permanently deleted. This can't be undone.`,
    async () => {
      try {
        await API.deleteUser({ uid: _editingUserUid });
        showToast('User deleted');
        closeModal('userPermissionsModal');
        loadSetUserList();
      } catch (e) {
        showToast((e.body && e.body.error) || 'Failed to delete user');
      }
    }
  );
}

/* ========================
   ARCHIVES — soft-deleted Clients/Records/Follow-ups, restorable for
   30 days (admin only). Purge itself runs server-side (see
   purgeExpiredArchives() in helpers.php, piggybacked on auth.php's
   session check) — this screen is just the list + manual restore/delete.
   ======================== */

const ARCHIVE_TYPE_LABELS = { clients: 'Client', transactions: 'Record', followups: 'Follow-up' };

let _archiveItems = [];

async function loadArchivesList() {
  const el = document.getElementById('archivesList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getArchives();
    _archiveItems = data.items || [];
    renderArchivesList();
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load archives</div>`;
  }
}

function renderArchivesList() {
  const el = document.getElementById('archivesList');
  renderPaginatedList(el, _archiveItems, LIST_PAGE_SIZE, (it) => {
    const urgent = it.days_left <= 3;
    return `
      <div class="list-item" style="cursor:default;align-items:flex-start;">
        <div class="item-avatar" style="background:var(--surface-2)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
        </div>
        <div class="item-body">
          <div class="item-title">${esc(it.title || '(untitled)')}</div>
          <div class="item-info-row">
            <span class="item-info-text">${esc(ARCHIVE_TYPE_LABELS[it.type] || it.type)}</span>
            <span class="item-info-dot"></span>
            <span class="item-info-text" style="${urgent ? 'color:var(--danger);font-weight:600;' : ''}">${it.days_left}d left</span>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" onclick="restoreArchiveItem('${it.type}', ${it.id})">Restore</button>
            <button class="btn btn-danger" style="padding:6px 12px;font-size:12px;" onclick="purgeArchiveItem('${it.type}', ${it.id})">Delete Permanently</button>
          </div>
        </div>
      </div>
    `;
  }, 'Archives is empty');
}

async function restoreArchiveItem(type, id) {
  try {
    await API.restoreArchived({ type, id });
    showToast('Restored');
    loadArchivesList();
  } catch (e) {
    showToast((e.body && e.body.error) || 'Failed to restore');
  }
}

function purgeArchiveItem(type, id) {
  showConfirm(
    'Delete permanently?',
    'This removes it for good, right now, instead of waiting out the rest of the 30 days. This can\'t be undone.',
    async () => {
      try {
        await API.purgeArchived({ type, id });
        showToast('Deleted permanently');
        loadArchivesList();
      } catch (e) {
        showToast((e.body && e.body.error) || 'Failed to delete');
      }
    },
    'Delete Permanently'
  );
}

/* ====== APP INIT ====== */

// ========================================================
// OFFLINE SCREEN
// navigator.onLine only reflects the OS network interface
// (e.g. still true on Wi-Fi with no real internet), so the
// online/offline events give us instant feedback while the
// retry button does a real fetch to confirm connectivity.
// ========================================================
let _offlineCheckInFlight = false;

function showOfflineScreen() {
  const el = document.getElementById('offlineScreen');
  if (!el) return;
  el.classList.add('show');
  _pollPaused = true; // don't let background polling fire while we know we're offline
  // force reflow so the opacity transition actually plays
  requestAnimationFrame(() => el.classList.add('in'));
}

function hideOfflineScreen() {
  const el = document.getElementById('offlineScreen');
  if (!el) return;
  el.classList.remove('in');
  _pollPaused = false; // resume background polling now that we're back
  setTimeout(() => el.classList.remove('show'), 300);
}

async function checkConnectionNow() {
  if (_offlineCheckInFlight) return;
  _offlineCheckInFlight = true;

  try {
    // Cache-busted, no-store request to a same-origin endpoint —
    // resolves only if we actually have a working connection.
    await fetch('api/auth.php?action=check&_=' + Date.now(), {
      credentials: 'include',
      cache: 'no-store'
    }).then(res => {
      if (!res.ok) throw new Error('bad response');
    });
    hideOfflineScreen();
  } catch (e) {
    // still offline — the 'online' event will fire again and re-trigger this
  } finally {
    _offlineCheckInFlight = false;
  }
}

window.addEventListener('offline', showOfflineScreen);
window.addEventListener('online', checkConnectionNow);

// Initial state — catches the case where the app is opened while already offline
if (!navigator.onLine) {
  showOfflineScreen();
}

(async function init() {
  const splashStart = performance.now();
  const MIN_SPLASH_MS = 3000; // floor — splash always shows for at least this long, even if auth resolves instantly

  const splash = document.getElementById('splashScreen');
  const barFill = document.getElementById('splashBarFill');
  if (barFill) barFill.classList.add('loading'); // bar eases toward ~85% while we wait on real work

  function dismissSplash() {
    if (!splash) return;
    if (barFill) barFill.classList.add('done'); // snap to 100% now that we actually know the result
    const elapsed = performance.now() - splashStart;
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(() => {
      splash.classList.add('hide');
      setTimeout(() => splash.remove(), 400);
    }, wait);
  }

  // Restore theme
  const saved = localStorage.getItem('crm_theme') || 'light';
  applyTheme(saved);

  // Show login screen underneath the splash while we check auth
  showLoginScreen();

  // Warm up allClients in parallel with the auth check, not after it. It's
  // used for the record-row call icon, follow-up client picker, and quick
  // message autocomplete — all of which used to only get populated whenever
  // the user happened to visit the Clients page first. Kicking it off here,
  // alongside auth, means it's ready by the time the splash (min 3s) lifts,
  // so those icons/pickers are correct on the very first render instead of
  // popping in later once something else finally called loadClients().
  const clientsWarmup = fetch('api/clients.php?search=', { credentials: 'include' })
    .then(res => res.json())
    .then(data => { allClients = data.clients || []; })
    .catch(() => {}); // non-fatal — pages that need it will still lazy-load as before

  // ── Auth check — splash now dismisses only once this actually resolves ──
  try {
    const res  = await fetch('api/auth.php?action=check', { credentials: 'include' });
    const data = await res.json();
    if (data.logged_in) {
      setUserInfo(data.username, data.userid);
      setPermissions(data.role, data.permissions);
      hideLoginScreen();
      // Set today's date on modals
      document.getElementById('f_date').value = localDateStr();
      document.getElementById('r_transdate').value = localDateStr();
      onFollowupTypeToggle('new');
      await clientsWarmup;
      navigate('dashboard');
      startPolling();
    } else {
      // Not logged in — login screen is already showing
      // Set dates anyway for when they do log in
      try {
        document.getElementById('f_date').value = localDateStr();
        document.getElementById('r_transdate').value = localDateStr();
        onFollowupTypeToggle('new');
      } catch(e) {}
    }
  } catch(e) {
    console.warn('Auth check failed:', e);
    // On network error, login screen stays visible underneath
  } finally {
    dismissSplash();
  }
})();