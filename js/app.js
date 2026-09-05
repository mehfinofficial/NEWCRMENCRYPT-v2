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
  } catch(e) { /* swallow — don't show errors for background polls */ }
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
  const prevView = queriesView;
  queriesView = view === 'followups' ? 'followups' : 'records';

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
      navigate('clients');
      openModal('addClientModal');
      populateSoftwareTypes();
      return;

    case 'Add New Record':
      navigateQueries('records');
      openModal('addRecordModal');
      populateClientSelect();
      populateServiceSelect();
      return;

    case 'Add New Follow-up':
      navigateQueries('followups');
      openModal('addFollowupModal');
      populateFollowupClientSelect();
      return;

    case 'Pending Records':
      navigateQueries('records');
      // Select the "Pending" filter chip and reload with it applied.
      document.querySelectorAll('#recordFilters .chip').forEach(c => c.classList.remove('active'));
      document.querySelector('#recordFilters .chip[data-filter="pending"]')?.classList.add('active');
      recordFilter = 'pending';
      recordDateFilter = '';
      loadRecords();
      return;

    case 'Quick Message':
      openQuickMessage();
      return;

    case 'Upcoming Renewals':
      openRenewalsList();
      return;

    case 'Client Ledger':
      // Filler for now — just drops the user on the Clients list until the
      // real ledger screen is built.
      navigate('clients');
      showToast('Client Ledger — coming soon');
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
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'addRecordModal')   resetRecordForm();
  if (id === 'addClientModal')   resetClientForm();
  if (id === 'addFollowupModal') resetFollowupForm();
  if (id === 'changePasswordModal') resetChangePasswordForm();
  if (id === 'quickMessageModal')   resetQuickMessageForm();
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

    // Stat pills
    const t = data.trends || {};
    document.getElementById('statPills').innerHTML =
      statCard(iconPeople, data.total_clients ?? 0, 'Total Clients',   t.clients,  'green')  +
      statCard(iconFile,   data.total_records ?? 0, 'Total Records',   t.records,  'blue')   +
      statCard(iconAlert,  data.expired ?? 0,        'Expired',         t.expired,  'red')    +
      statCard(iconClock,  data.expiring_soon ?? 0,  'Expiring Soon',   t.expiring, 'orange');

    // Month summary
    renderMonthSummary(data);

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

function statCard(icon, value, label, trend, color) {
  const t = trend || {};
  const pct = t.pct;
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
  const trendText = (pct === null || pct === undefined) ? 'New' : pct === 0 ? 'No change' : `${arrow} ${Math.abs(pct)}%`;
  const vsText = (pct === null || pct === undefined) ? '' : 'vs last week';
  return `
    <div class="stat-pill stat-pill--${color}">
      <div class="stat-pill__glow"></div>
      <div class="stat-pill__val">${value}</div>
      <div class="stat-pill__label">${label}</div>
      <div class="stat-pill__trend">
        <span class="stat-pill__badge">${trendText}</span>
        <span class="stat-pill__vs">${vsText}</span>
      </div>
    </div>`;
}

function renderMonthSummary(data) {
  const now       = new Date();
  const monthName = now.toLocaleDateString('en-IN', { month: 'long' });
  const year      = now.getFullYear();
  const ms        = data.month_stats || {};

  const newClients = ms.new_clients ?? 0;
  const renewals   = ms.renewals    ?? 0;
  const due        = ms.due         ?? 0;
  const expiring   = data.expiring_soon ?? 0;

  const rate = due > 0 ? Math.round((renewals / due) * 100) : 0;

  document.getElementById('monthSummaryTitle').textContent = `${monthName} ${year}`;
  document.getElementById('ms_clients').textContent  = newClients;
  document.getElementById('ms_renewals').textContent = renewals;
  document.getElementById('ms_expiring').textContent = expiring;
  document.getElementById('ms_barPct').textContent   = due > 0 ? `${rate}% of ${due} due` : 'No renewals due';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.getElementById('ms_barFill').style.width = rate + '%';
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
    document.getElementById('clientsList').innerHTML = `<div class="empty-state">Failed to load clients</div>`;
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

function openClientDetail(c) {
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
  // Wire up Call & Chat footer buttons
  const callBtn = document.getElementById('cdCallBtn');
  const chatBtn = document.getElementById('cdChatBtn');
  const phone = (c.contact || '').replace(/\D/g, '');
  const wa    = (c.whatsapp || c.contact || '').replace(/\D/g, '');
  callBtn.href = phone ? `tel:${phone}` : '#';
  callBtn.style.opacity = phone ? '1' : '0.4';
  callBtn.style.pointerEvents = phone ? 'auto' : 'none';
  chatBtn.href = wa ? `https://wa.me/${wa}` : '#';
  chatBtn.style.opacity = wa ? '1' : '0.4';
  chatBtn.style.pointerEvents = wa ? 'auto' : 'none';
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
      const data = await API.getRecords({ search: clientname, page });
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
      const statusBadge = badgeHtml(r.status || 'pending');
      const summary = r.query || r.query_note || '';
      const sub = [timeAgo(r.transdate), summary].filter(Boolean).join(' · ');
      return `
        <div class="list-item" style="cursor:pointer" onclick='openLedgerRecordById(${JSON.stringify(r.id)})'>
          <div class="item-avatar" style="background:var(--surface-2)">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
          </div>
          <div class="item-body">
            <div class="item-title">${esc(r.servicename || 'Record')}</div>
            <div class="item-sub">${esc(sub)}</div>
          </div>
          <div class="item-right">${statusBadge}</div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:16px 0;">Failed to load history</div>`;
  }
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

async function saveClient() {
  const data = {
    clientname:       document.getElementById('c_name').value.trim(),
    firmname:         document.getElementById('c_firm').value.trim(),
    address:          document.getElementById('c_address').value.trim(),
    contact:          document.getElementById('c_contact').value.trim(),
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
  try {
    await API.addClient(data);
    showToast('Client saved');
    closeModal('addClientModal');
    clearForm(['c_name','c_firm','c_address','c_contact','c_email','c_software_version']);
    document.getElementById('c_whatsapp').value = '+91';
    document.getElementById('c_renewal_date').value = '';
    document.getElementById('c_system_id').value = '';
    document.getElementById('c_software_type').value = '';
    document.getElementById('c_status').value = '1';
    loadClients();
  } catch(e) { showToast(' Failed to save client'); }
}

/* ========================
   RECORDS
   ======================== */
let recordFilter = 'all';
let _serviceTypeMap = {}; // serviceid -> servicetype

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
    document.getElementById('recordsList').innerHTML = `<div class="empty-state">Failed to load records</div>`;
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
    const client = allClients.find(c => c.clientname === r.account);
    const phone  = (client?.contact || client?.whatsapp || '').replace(/\D/g, '');
    const callBtn = (status === 'pending' && phone)
      ? `<a class="item-call-btn" href="tel:${phone}" onclick="event.stopPropagation()" aria-label="Call">
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
  ['r_grp_support','r_grp_renewal','r_grp_syschange','r_grp_install'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  if (type === 'support') {
    document.getElementById('r_grp_support').style.display = 'flex';
  } else if (type === 'renewal') {
    document.getElementById('r_grp_renewal').style.display = 'flex';
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
  }
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
    extra.renewaldate  = document.getElementById('r_renewal_date')?.value || null;
    extra.payment_info = document.getElementById('r_payment_info')?.value.trim() || '';
    extra.next_renewal = document.getElementById('r_next_renewal')?.value || null;
    extra.query_note   = document.getElementById('r_renewal_note')?.value.trim() || '';
  } else if (serviceType === 'system change') {
    extra.systemid     = document.getElementById('r_systemid')?.value || '';
    extra.new_systemid = document.getElementById('r_new_systemid')?.value.trim() || '';
    extra.query_note   = document.getElementById('r_syschange_note')?.value.trim() || '';
  } else if (serviceType === 'install') {
    extra.query_note   = document.getElementById('r_install_note')?.value.trim() || '';
  }

  try {
    await API.addRecord({ action: 'add', ...base, ...extra });
    showToast('Record saved');
    closeModal('addRecordModal');
    resetRecordForm();
    loadRecords();
  } catch(e) { showToast('Failed to save record'); }
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
  ['r_query_note','r_renewal_date','r_payment_info','r_next_renewal','r_renewal_note',
   'r_query','r_systemid','r_new_systemid','r_syschange_note','r_install_note'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  // Hide all groups
  ['r_grp_support','r_grp_renewal','r_grp_syschange','r_grp_install'].forEach(id => {
    const el = document.getElementById(id); if(el) el.style.display = 'none';
  });
}

/* ========================
   FOLLOW-UPS
   ======================== */
let followupFilter = 'all';
let followupType   = 'new'; // 'client' or 'new'

let followupsPaging = { page: 1, hasMore: false, search: '', filter: 'all' };

async function loadFollowups(search = '') {
  try {
    const data = await API.getFollowups({ search, filter: followupFilter, page: 1 });
    allFollowups = data.followups || [];
    followupsPaging = { page: 1, hasMore: !!data.hasMore, search, filter: followupFilter };
    renderFollowups(allFollowups);
  } catch(e) {
    document.getElementById('followupsList').innerHTML = `<div class="empty-state">Failed to load follow-ups</div>`;
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
        ${badgeHtml(f.status)}
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
  try {
    await API.updateFollowup({ id, status: 'done' });
    showToast('Marked as complete');
    loadFollowups();
  } catch(e) { showToast('Failed to update'); }
}


function openFollowupDetail(f) {
  const isClient = f.type === 'client';
  const status   = f.status || 'pending';
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
 
  /* ── Reminder urgency label ── */
  function urgencyLabel(dateStr) {
    if (!dateStr) return null;
    const diff  = daysFromToday(dateStr);
    if (diff < 0)   return 'Overdue';
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return `In ${diff} days`;
  }
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
          ${badgeHtml(status)}
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
    ${(callHref || waHref) ? `
    <div class="frdm-actions">
      ${callHref ? `
        <a class="btn btn-ghost frdm-action-btn" href="${callHref}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px;vertical-align:middle"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>Call
        </a>` : ''}
      ${waHref ? `
        <a class="btn btn-ghost frdm-action-btn" href="${waHref}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;vertical-align:middle"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.025.507 3.934 1.397 5.61L0 24l6.545-1.38A11.946 11.946 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.8 9.8 0 0 1-5.003-1.367l-.36-.214-3.713.983.993-3.648-.235-.374A9.817 9.817 0 0 1 2.182 12C2.182 6.578 6.578 2.182 12 2.182S21.818 6.578 21.818 12 17.422 21.818 12 21.818z"/></svg>WhatsApp
        </a>` : ''}
    </div>` : ''}
  `;
 
  /* ── Footer ── */
  const footer = document.getElementById('frdm-footer');
  footer.innerHTML = status === 'pending'
    ? `<button class="btn btn-ghost" onclick="closeModal('followupDetailModal')">Close</button>
       <button class="btn btn-primary" onclick="markFollowupDone(${f.id})">
        Mark Complete
       </button>`
    : `<button class="btn btn-ghost" style="flex:1" onclick="closeModal('followupDetailModal')">Close</button>`;
 
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
  const sel = document.getElementById('f_client');
  const source = allClients.length ? allClients : _followupClients;
  const client = source.find(c => c.clientname === sel.value);
  if (client) {
    document.getElementById('f_phone').value = client.contact || client.whatsapp || '';
  }
}

// Populate client dropdown in followup modal (separate from records)
async function populateFollowupClientSelect() {
  const sel = document.getElementById('f_client');
  if (sel.options.length > 1) return; // already loaded
  try {
    const data = await API.getClients();
    _followupClients = data.clients || [];
    _followupClients.forEach(c => {
      sel.add(new Option(c.clientname + (c.firmname ? ` (${c.firmname})` : ''), c.clientname));
    });
  } catch(e) {}
}

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

  try {
    await API.addFollowup({ phonenumber, reminderdate, status, is_lead, type: followupType, clientname, note });
    showToast('Follow-up saved');
    closeModal('addFollowupModal');
    loadFollowups();
  } catch(e) { showToast('Failed to save'); }
}

function resetFollowupForm() {
  followupType = 'new';
  document.getElementById('f_tab_new').classList.add('active');
  document.getElementById('f_tab_client').classList.remove('active');
  document.getElementById('f_grp_client').style.display = 'none';
  document.getElementById('f_grp_new').style.display    = 'flex';
  document.getElementById('f_client').value      = '';
  document.getElementById('f_phone').value       = '';
  document.getElementById('f_note_client').value = '';
  document.getElementById('f_phone_new').value   = '';
  document.getElementById('f_note_new').value    = '';
  document.getElementById('f_date').value        = localDateStr();
  document.getElementById('f_status').value      = 'pending';
  document.getElementById('f_is_lead').checked   = false;
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
  const map = { active: 'Active', expired: 'Expired', expiring: 'Expiring', pending: 'Pending', done: 'Complete', cancelled: 'Cancelled' };
  return `<span class="badge badge-${status}">${map[status] || status}</span>`;
}

function getRecordStatus(r) {
  if (!r.renewaldate) return 'active';
  const diff = daysFromToday(r.renewaldate);
  if (diff < 0) return 'expired';
  if (diff <= 15) return 'expiring';
  return 'active';
}

function renewalItem(r) {
  const status = getRecordStatus(r);
  return `
    <div class="list-item" style="cursor:default">
      <div class="item-avatar" style="background:var(--surface-2)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
      </div>
      <div class="item-body">
        <div class="item-title">${esc(r.account)}</div>
        <div class="item-sub">${esc(r.servicename)} · ${formatDate(r.renewaldate)}</div>
      </div>
      <div class="item-right">${badgeHtml(status)}</div>
    </div>`;
}

function followupItem(f) {
  return `
    <div class="list-item" style="cursor:default">
      <div class="item-avatar" style="background:var(--surface-2)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>
      </div>
      <div class="item-body">
        <div class="item-title">${esc(f.phonenumber)}</div>
        <div class="item-sub">Today · ${badgeHtml(f.status)}</div>
      </div>
    </div>`;
}

function clearForm(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

const iconPeople = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const iconFile   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>`;
const iconAlert  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const iconClock  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

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
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('qm_account_search');
  const box  = document.getElementById('qm_account_suggestions');
  if (!wrap || !box) return;
  if (e.target !== wrap && !box.contains(e.target)) {
    box.style.display = 'none';
  }
});

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

  const phone = (client.whatsapp || client.contact || '').replace(/\D/g, '');
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

  const rawPhone = _qmSelectedClient.whatsapp || _qmSelectedClient.contact || '';
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
  openModal('renewalsModal');
  loadRenewalsList();
}

async function loadRenewalsList() {
  const el = document.getElementById('renewalsList');
  el.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const data = await API.getClients();
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
      ${c.software_type ? `
      <div class="detail-row">
        <span class="detail-label">Software</span>
        <span class="cd-sysid-pill">${esc(c.software_type)}</span>
      </div>` : ''}
    </div>
  `;
  openModal('renewalDetailModal');
}

// Shortcut from the renewal detail popup straight into Quick Message,
// pre-filled with this client and the Renewal Reminder template.
async function sendRenewalReminderFromDetail() {
  if (!_renewalDetailClient) return;
  const c = _renewalDetailClient;

  closeModal('renewalDetailModal');
  closeModal('renewalsModal');
  openModal('quickMessageModal');

  await populateQuickMessageClients();
  await populateQuickMessageTemplates();

  document.getElementById('qm_account').value = c.clientname;
  document.getElementById('qm_account_search').value = c.firmname || c.clientname;

  const tmpl = _qmTemplates.find(t => t.name === 'Renewal Reminder');
  if (tmpl) document.getElementById('qm_template').value = tmpl.id;

  previewQuickMessage();
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
          { key: 'renewaldate',  label: 'Renewal Date',  format: 'date' },
          { key: 'next_renewal', label: 'Next Renewal',  format: 'date' },
          { key: 'payment_info', label: 'Payment Info' },
          { key: 'query_note',   label: 'Note' },
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
          { key: 'systemid',     label: 'System ID',    pill: true },
          { key: 'renewaldate',  label: 'Renewal Date', format: 'date' },
          { key: 'query_note',   label: 'Note' },
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
        { key: 'query',        label: 'Query' },
        { key: 'query_note',   label: 'Note' },
        { key: 'payment_info', label: 'Payment Info' },
        { key: 'renewaldate',  label: 'Renewal Date', format: 'date' },
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
function openRecordDetailById(id)   { const r = allRecords.find(x => x.id === id);   if (r) openRecordDetail(r); }
function openFollowupDetailById(id) { const f = allFollowups.find(x => x.id === id); if (f) openFollowupDetail(f); }
function openClientDetailById(id)   { const c = allClients.find(x => x.id === id);   if (c) openClientDetail(c); }

function openRecordDetail(r) {
  const type   = (r.servicetype || '').toLowerCase();
  const config = RECORD_TYPE_CONFIG[type] || RECORD_TYPE_DEFAULT;
  const status = r.status || 'pending';
 
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
          const display = f.format === 'date' ? formatDate(val) : val;
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
 
  `;
 
  /* ── Footer ── */
  const footer = document.getElementById('rdm-footer');
  if (status === 'pending') {
    const client = allClients.find(c => c.clientname === r.account);
    const phone  = (client?.contact || client?.whatsapp || '').replace(/\D/g, '');
    const callBtnHtml = phone
      ? `<a class="btn btn-ghost" href="tel:${phone}" style="text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;gap:6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.4 2 2 0 0 1 3.92 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17z"/></svg>Call
        </a>`
      : '';
    footer.innerHTML = `
      <button class="btn btn-ghost" onclick="closeModal('recordDetailModal')">Close</button>
      ${callBtnHtml}
      <button class="btn btn-primary" onclick="markRecordDone(${r.id})">
         Mark as Done
      </button>`;
  } else {
    footer.innerHTML = `<button class="btn btn-ghost" style="flex:1" onclick="closeModal('recordDetailModal')">Close</button>`;
  }
 
  openModal('recordDetailModal');
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

/* ====== APP INIT ====== */

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

  // ── Auth check — splash now dismisses only once this actually resolves ──
  try {
    const res  = await fetch('api/auth.php?action=check', { credentials: 'include' });
    const data = await res.json();
    if (data.logged_in) {
      setUserInfo(data.username, data.userid);
      hideLoginScreen();
      // Set today's date on modals
      document.getElementById('f_date').value = localDateStr();
      document.getElementById('r_transdate').value = localDateStr();
      onFollowupTypeToggle('new');
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