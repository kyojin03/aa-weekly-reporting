/**
 * UI. State lives in S; every change re-renders the current view from S.
 * Fields in the lists save by themselves when you leave them (no Save button):
 * the screen updates at once and the write goes to the database in the background.
 */
import * as L from './logic.js';
import { firebaseConfig } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(L.isBlank(s) ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 't' + Date.now() + Math.random().toString(36).slice(2));
const nowISO = () => new Date().toISOString();

const S = {
  authChecked: false, user: null, me: null,
  members: [], tasks: [], archived: [], snapshots: [],
  week: L.mondayOf(L.todayKey()), selected: '', view: 'my',
  loadingWeek: true, error: '', report: '', reportTitle: '', showArchived: false
};
const openDetails = new Set();
let db = null;
let unsubs = [];
let unsubTasks = null;

/* ------------------------------ helpers ------------------------------ */

function toast(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

function friendly(e) {
  const code = (e && e.code) || '';
  if (code === 'permission-denied') return 'You are not allowed to do that. Members can change only their own work.';
  if (code === 'unavailable') return 'No connection. Your change is kept on this device and will be sent when you are back online.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was cancelled.';
  if (code === 'auth/popup-blocked') return 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.';
  if (code === 'auth/unauthorized-domain') return 'This web address is not allowed to sign in yet. Add it under Authentication → Settings → Authorized domains in Firebase.';
  return (e && e.message) || 'Something went wrong.';
}

function fail(e) {
  console.error(e);
  S.error = friendly(e);
  toast(S.error);
  render();
}

const member = (email) => S.members.find((m) => m.email === email);
const nameOf = (email) => { const m = member(email); return m ? m.name : email; };
const isAdmin = () => !!(S.me && S.me.admin);
const canEdit = (t) => isAdmin() || (S.me && t.owner_id === S.me.email);
const canEditFor = (email) => isAdmin() || (S.me && email === S.me.email);
const activeMembers = () => S.members.filter((m) => m.active !== false).sort((a, b) => a.name.localeCompare(b.name));
const weekTasks = () => L.scopeWeek(S.tasks, S.week);
const tasksOf = (email) => weekTasks().filter((t) => t.owner_id === email);
const findTask = (id) => S.tasks.find((t) => t.id === id) || S.archived.find((t) => t.id === id);
const snapshotFor = (email) => S.snapshots.find((s) => s.week_start === S.week && s.member_id === email);

function initials(name) {
  const w = String(name || '').replace(/[^A-Za-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

function prefs(patch) {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('aa_next_prefs') || '{}') || {}; } catch (e) { p = {}; }
  if (patch) {
    Object.assign(p, patch);
    try { localStorage.setItem('aa_next_prefs', JSON.stringify(p)); } catch (e) { /* best effort */ }
  }
  return p;
}

/** Save a task: update the screen first, then write. A failed write reports and the live data corrects the screen. */
function saveTask(next, before) {
  const t = L.derive(Object.assign({}, next, { updated_at: nowISO(), updated_by: S.me.email }));
  const errors = L.validateTask(t);
  if (errors.length) { toast(errors[0]); render(); return Promise.resolve(false); }
  const detail = before ? L.describeChange(before, t) : 'created';
  const i = S.tasks.findIndex((x) => x.id === t.id);
  if (i === -1) S.tasks.push(t); else S.tasks[i] = t;
  S.archived = S.archived.filter((x) => x.id !== t.id).concat(t.archived ? [t] : []);
  S.error = '';
  render();
  return db.saveTask(t, detail ? { type: before ? 'updated' : 'created', detail } : null).then(() => true, (e) => { fail(e); return false; });
}

/* ------------------------------ rendering ------------------------------ */

// Rebuilding the view while a mouse button or finger is down would swallow the
// click that is in progress, so a render asked for mid-press waits for release.
let pressing = false;
let renderWaiting = false;
function render() {
  if (pressing) { renderWaiting = true; return; }
  renderWaiting = false;
  paint();
}
function released() {
  pressing = false;
  setTimeout(() => { if (renderWaiting && !pressing) render(); }, 0); // after the click handlers have run
}

function paint() {
  const signedIn = !!(S.user && S.me && S.me.active !== false);
  $('chrome').hidden = !signedIn;
  $('nav').hidden = !signedIn;
  renderBanner();
  const view = $('view');
  // Keep the caret and any half-typed text when the view is rebuilt under the user.
  const a = document.activeElement;
  const focus = a && view.contains(a) && a.dataset && a.dataset.key
    ? { key: a.dataset.key, value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;

  if (!S.authChecked) view.innerHTML = skeleton();
  else if (!S.user) view.innerHTML = signInPanel();
  else if (!signedIn) view.innerHTML = notOnRosterPanel();
  else {
    renderChrome();
    view.innerHTML = S.view === 'team' ? vTeam() : S.view === 'reports' ? vReports() : vMy();
  }

  if (focus) {
    const el = view.querySelector('[data-key="' + CSS.escape(focus.key) + '"]');
    if (el) {
      el.focus();
      if (el.tagName !== 'SELECT') {
        el.value = focus.value;
        try { el.setSelectionRange(focus.start, focus.end); } catch (e) { /* number and date fields have no caret API */ }
      }
    }
  }
}

function renderBanner() {
  const b = $('banner');
  if (S.error) {
    b.hidden = false; b.className = 'banner error';
    b.innerHTML = esc(S.error) + ' <button class="btn small" data-act="dismiss-error">Dismiss</button>';
  } else if (db && db.mode === 'local') {
    b.hidden = false; b.className = 'banner demo';
    b.innerHTML = '<strong>Local preview</strong> · not connected to Firebase yet. What you enter stays in this browser only. ' +
      '<button class="btn small" data-act="reset-local">Clear preview data</button>';
  } else b.hidden = true;
}

function renderChrome() {
  const sel = $('memberSelect');
  sel.innerHTML = activeMembers().map((m) =>
    '<option value="' + esc(m.email) + '"' + (m.email === S.selected ? ' selected' : '') + '>' +
    esc(m.name) + (m.email === S.me.email ? ' (me)' : '') + '</option>').join('');
  $('weekLabel').textContent = L.fmtRange(S.week);
  $('weekToday').hidden = S.week === L.mondayOf(L.todayKey());
  $('userBox').innerHTML = db.mode === 'local' ? '' :
    '<span class="muted">' + esc(S.user.email) + '</span> <button class="btn small" data-act="signout">Sign out</button>';
  document.querySelectorAll('#nav [role="tab"]').forEach((b) => {
    const on = b.dataset.view === S.view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

const skeleton = () => '<div class="skel-hero"><div class="skel c"></div><div class="skel l"></div></div><div class="skel b"></div><div class="skel p"></div>';

function signInPanel() {
  return '<div class="panel"><h2>Sign in</h2>' +
    '<p>Use your Google account to open the team\'s weekly reporting.</p>' +
    '<div class="row"><button class="btn primary" data-act="signin">Sign in with Google</button></div>' +
    '<p class="muted">Only people on the team roster can see or enter anything.</p></div>';
}

function notOnRosterPanel() {
  return '<div class="panel"><h2>Not on the roster yet</h2>' +
    '<p><strong>' + esc(S.user.email) + '</strong> is not an active member of the team roster. Ask an admin to add this email, then reload.</p>' +
    '<div class="row"><button class="btn" data-act="signout">Sign out</button></div></div>';
}

function ring(pct) {
  const C = 2 * Math.PI * 26, v = L.isBlank(pct) ? 0 : Math.max(0, Math.min(100, pct));
  return '<svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="ring-bg" cx="32" cy="32" r="26"/>' +
    '<circle class="ring-fg" cx="32" cy="32" r="26" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + (C * (1 - v / 100)).toFixed(2) + '" transform="rotate(-90 32 32)"/></svg>';
}

function statCards(s) {
  const stat = (label, val, hint) => '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-num">' + esc(val) + '</div>' +
    (hint ? '<div class="stat-hint">' + esc(hint) + '</div>' : '') + '</div>';
  const lead = s.avg.reported ? s.avg.reported + ' of ' + s.avg.count + ' planned reported' + (s.avg.unreported ? ' · ' + s.avg.unreported + ' pending' : '')
    : (s.avg.count ? 'Nothing reported yet' : 'No planned tasks');
  return '<div class="stats"><div class="stat lead"><div class="stat-label">Accomplished</div>' +
    '<div class="lead-row"><div><div class="stat-big">' + (s.avg.percent === null ? '—' : s.avg.percent + '%') + '</div>' +
    '<div class="stat-hint">' + esc(lead) + '</div></div>' + ring(s.avg.percent) + '</div></div>' +
    stat('Planned', s.avg.count, s.completed ? s.completed + ' completed' : '') +
    stat('Additional', s.add.count, s.add.withoutTime ? s.add.withoutTime + ' without time' : '') +
    stat('Extra time', L.fmtMinutes(s.add.minutes), '') +
    stat('Plans affected', s.impacts, s.overdue ? s.overdue + ' overdue' : '') + '</div>';
}

function chip(t) {
  if (t.status === 'Cancelled') return ' <span class="chip idle">Cancelled</span>';
  if (t.status === 'Blocked') return ' <span class="chip bad">Blocked</span>';
  if (t.status === 'Completed') return ' <span class="chip ok">Complete</span>';
  if (L.isOverdue(t)) return ' <span class="chip warn">Overdue</span>';
  if (!L.isBlank(t.percent) && t.percent > 0) return ' <span class="chip info">In progress</span>';
  return ' <span class="chip idle">Not started</span>';
}

function plannedRow(t, adds) {
  const ro = canEdit(t) ? '' : ' disabled';
  const pct = L.isBlank(t.percent) ? 0 : t.percent;
  const code = t.reason_code || 'none';
  const link = (t.affected_by || [])[0];
  const showWhy = t.status !== 'Completed';
  const open = openDetails.has(t.id) || code !== 'none' || !!t.reason_note;
  return '<div class="task" data-id="' + esc(t.id) + '"><div class="task-top">' +
    '<div class="task-main"><div class="t-title">' + esc(t.title) + chip(t) + '</div>' +
    '<div class="t-meta">' + (t.due ? 'Due ' + esc(L.fmtDay(t.due)) + ' · ' : '') + (L.isBlank(t.percent) ? 'Not reported yet' : t.percent + '% reported') + '</div></div>' +
    '<div class="task-fields"><label>% done <input type="number" min="0" max="100" inputmode="numeric" placeholder="—" data-field="percent" data-key="pct_' + esc(t.id) + '" value="' + (L.isBlank(t.percent) ? '' : t.percent) + '"' + ro + '></label>' +
    '<button class="btn small" data-act="open">Details</button></div></div>' +
    '<div class="meter' + (pct >= 100 ? ' done' : '') + '" aria-hidden="true"><div style="width:' + pct + '%"></div></div>' +
    (showWhy ? '<details class="more" data-det="' + esc(t.id) + '"' + (open ? ' open' : '') + '><summary>Reason if incomplete</summary><div class="t-ctl">' +
      '<label>Why incomplete? <select data-field="reason_code" data-key="rc_' + esc(t.id) + '"' + ro + '>' +
      Object.keys(L.REASONS).map((k) => '<option value="' + k + '"' + (k === code ? ' selected' : '') + '>' + esc(L.REASONS[k]) + '</option>').join('') + '</select></label>' +
      (code === 'additional' ? '<label>Which additional task? <select data-field="affected_task" data-key="at_' + esc(t.id) + '"' + ro + '><option value="">Choose…</option>' +
        adds.map((a) => '<option value="' + esc(a.id) + '"' + (link && link.task_id === a.id ? ' selected' : '') + '>' + esc(a.title) + '</option>').join('') + '</select></label>' +
        '<label>Effect <select data-field="affected_type" data-key="ay_' + esc(t.id) + '"' + ro + '>' +
        L.IMPACT_TYPES.map((x) => '<option' + (link && link.type === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></label>' : '') +
      '</div><div class="t-ctl"><label style="flex:1;min-width:200px">Explanation <input type="text" style="width:100%" maxlength="500" placeholder="Short explanation" data-field="reason_note" data-key="rn_' + esc(t.id) + '" value="' + esc(t.reason_note) + '"' + ro + '></label></div></details>' : '') +
    '</div>';
}

function additionalCard(t, all) {
  const hit = all.filter((p) => (p.affected_by || []).some((a) => a.task_id === t.id));
  const timeless = L.isBlank(t.minutes);
  return '<div class="task" data-id="' + esc(t.id) + '"><div class="task-top"><div class="task-main">' +
    '<div class="t-title">' + esc(t.title) + ' <span class="chip ' + (timeless ? 'warn' : 'idle') + '">' + (timeless ? 'Time not recorded' : esc(L.fmtMinutes(t.minutes))) + '</span>' +
    (hit.length ? ' <span class="chip info">Affected plan</span>' : '') + (t.status === 'Completed' ? ' <span class="chip ok">Done</span>' : '') + '</div>' +
    '<div class="t-meta">' + esc(L.fmtDay(L.dayKey(t.created_at))) +
    (hit.length ? ' · Affected: ' + hit.map((p) => esc(p.title)).join(', ') : ' · No effect on planned work recorded') + '</div></div>' +
    '<div class="task-fields"><button class="btn small" data-act="open">Details</button></div></div></div>';
}

function vMy() {
  const m = member(S.selected) || S.me;
  const mine = tasksOf(m.email);
  const plan = L.planned(mine), adds = L.additional(mine);
  const s = L.summarize(mine);
  const snap = snapshotFor(m.email);
  const editable = canEditFor(m.email);
  let h = '<div class="hero"><div class="avatar" aria-hidden="true">' + esc(initials(m.name)) + '</div>' +
    '<div class="who"><h2>' + esc(m.name) + '</h2><div class="muted">' + (m.role ? esc(m.role) + ' · ' : '') + 'Week of ' + esc(L.fmtRange(S.week)) + '</div></div>' +
    (snap ? '<span class="badge ok">✓ Submitted</span>' : '<span class="badge warn">Not yet submitted</span>') + '</div>';
  h += statCards(s);
  if (S.loadingWeek) return h + skeleton();

  h += '<div class="panel"><div class="panel-head"><h2>Planned tasks</h2></div>' +
    (editable ? '<form class="quick" data-form="add-planned"><input type="text" data-key="qp_title" name="title" maxlength="200" placeholder="Add a planned task and press Enter" aria-label="New planned task title">' +
      '<input type="date" data-key="qp_due" name="due" aria-label="Deadline (optional)"><button class="btn primary">Add</button></form>' : '') +
    (plan.length ? plan.map((t) => plannedRow(t, adds)).join('')
      : '<div class="empty">No planned tasks this week.' + (editable ? ' Type a title above to add one.' : '') + '</div>') +
    (plan.length && editable ? '<p class="muted">Percentages and reasons save by themselves when you leave the field. Leave a task blank until you have measured it — blank tasks stay out of the average.</p>' : '') +
    archivedBlock(m.email) + '</div>';

  h += '<div class="panel"><div class="panel-head"><h2>Additional work</h2>' +
    (editable ? '<button class="btn primary" data-act="add-additional">+ Add additional work</button>' : '') + '</div>' +
    (adds.length ? adds.map((t) => additionalCard(t, plan)).join('') : '<div class="empty">No additional work recorded this week.</div>') + '</div>';

  h += '<div class="panel"><h2>Submit the week</h2>' +
    '<p class="readiness"><strong>' + s.avg.reported + ' of ' + s.avg.count + '</strong> planned tasks have a reported %' +
    (s.avg.unreported ? ' · ' + s.avg.unreported + ' still blank' : '') + (s.needsReason ? ' · ' + s.needsReason + ' incomplete without a reason' : '') + '</p>' +
    (snap ? '<p><span class="badge ok">✓ Submitted</span> <span class="muted">Frozen on ' + esc(L.fmtDay(L.dayKey(snap.submitted_at))) + ' at ' + esc(snap.percent === null ? '—' : snap.percent + '%') + '. Submitting again replaces this week\'s record only.</span></p>' : '') +
    (editable ? '<div class="row"><button class="btn primary" data-act="submit-week">' + (snap ? 'Submit again' : 'Submit weekly accomplishment') + '</button></div>' : '') +
    '<p class="muted">Submitting keeps a frozen copy of this week exactly as it stands now. Later edits to tasks never change it.</p></div>';
  return h;
}

function archivedBlock(email) {
  const rows = S.archived.filter((t) => t.owner_id === email);
  if (!rows.length) return '';
  return '<div class="row" style="margin-top:12px"><button class="btn small" data-act="toggle-archived">' + (S.showArchived ? 'Hide' : 'Show') + ' archived (' + rows.length + ')</button></div>' +
    (S.showArchived ? '<ul class="clean">' + rows.map((t) => '<li data-id="' + esc(t.id) + '">' + esc(t.title) + ' <span class="muted">(' + esc(t.task_type.toLowerCase()) + ')</span> ' +
      (canEdit(t) ? '<button class="btn small" data-act="restore">Restore</button>' : '') + '</li>').join('') + '</ul>' : '');
}

function vTeam() {
  const all = weekTasks();
  let h = '<div class="panel"><div class="panel-head"><h2>Team overview</h2>' +
    '<button class="btn" data-act="csv-week">Export this week (CSV)</button></div>' +
    '<p class="muted">Week of ' + esc(L.fmtRange(S.week)) + '. Roles differ, so task counts are never treated as equal effort.</p></div>';
  h += statCards(L.summarize(all));
  if (S.loadingWeek) return h + skeleton();
  h += '<div class="panel"><h2>By person</h2>' + activeMembers().map((m) => {
    const mine = all.filter((t) => t.owner_id === m.email);
    const s = L.summarize(mine);
    const snap = snapshotFor(m.email);
    const open = openDetails.has('m_' + m.email);
    return '<details class="more person" data-det="m_' + esc(m.email) + '"' + (open ? ' open' : '') + '><summary><strong>' + esc(m.name) + '</strong> <span class="muted">' + esc(m.role || '') + '</span> ' +
      '<span class="chip ' + (s.avg.percent === null ? 'idle' : 'info') + '">' + (s.avg.percent === null ? 'no %' : s.avg.percent + '%') + '</span> ' +
      '<span class="muted">' + s.avg.count + ' planned · ' + s.add.count + ' additional (' + esc(L.fmtMinutes(s.add.minutes)) + ')</span>' +
      (s.overdue ? ' <span class="chip warn">' + s.overdue + ' overdue</span>' : '') +
      (s.needsReason ? ' <span class="chip warn">' + s.needsReason + ' no reason</span>' : '') +
      (snap ? ' <span class="chip ok">Submitted</span>' : '') + '</summary>' +
      (mine.length ? '<ul class="clean">' + mine.map((t) => '<li data-id="' + esc(t.id) + '">' + esc(t.title) + ' <span class="muted">' +
        (t.task_type === 'PLANNED' ? (L.isBlank(t.percent) ? 'not reported' : t.percent + '%') : (L.isBlank(t.minutes) ? 'time not recorded' : L.fmtMinutes(t.minutes))) +
        (t.task_type === 'ADDITIONAL' ? ' · additional' : '') + '</span>' + chip(t) +
        (t.reason_note || t.blocked_reason ? '<br><span class="muted">' + esc(t.reason_note || t.blocked_reason) + '</span>' : '') +
        ' <button class="btn small" data-act="open">Open</button></li>').join('') + '</ul>' : '<p class="muted">Nothing recorded this week.</p>') +
      '</details>';
  }).join('') + '</div>';

  h += '<div class="panel"><div class="panel-head"><h2>Roster (' + S.members.length + ')</h2>' +
    (isAdmin() ? '<button class="btn" data-act="add-member">+ Add member</button>' : '') + '</div><ul class="clean">' +
    S.members.slice().sort((a, b) => a.name.localeCompare(b.name)).map((m) => '<li data-email="' + esc(m.email) + '"><strong>' + esc(m.name) + '</strong> <span class="muted">' + esc(m.role || '') + ' · ' + esc(m.email) + '</span>' +
      (m.admin ? ' <span class="chip info">Admin</span>' : '') + (m.active === false ? ' <span class="chip idle">Inactive</span>' : '') +
      (isAdmin() ? ' <button class="btn small" data-act="edit-member">Edit</button>' : '') + '</li>').join('') + '</ul>' +
    (isAdmin() ? '' : '<p class="muted">Only admins can change the roster.</p>') + '</div>';
  return h;
}

function vReports() {
  const snaps = S.snapshots.slice().sort((a, b) => (a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : String(a.member_name).localeCompare(String(b.member_name))));
  return '<div class="panel"><h2>Weekly report</h2><div class="row">' +
    '<button class="btn primary" data-act="report-member">Report for ' + esc(nameOf(S.selected)) + '</button>' +
    '<button class="btn" data-act="report-team">Whole team</button>' +
    '<button class="btn" data-act="copy-report"' + (S.report ? '' : ' disabled') + '>Copy</button>' +
    '<button class="btn" data-act="print">Print / Save PDF</button>' +
    '<button class="btn" data-act="csv-week">Export this week (CSV)</button></div>' +
    (S.reportTitle ? '<p class="muted">' + esc(S.reportTitle) + '</p>' : '') +
    '<pre class="report">' + esc(S.report || 'Choose a report above. It is built from the week\'s current records.') + '</pre></div>' +
    '<div class="panel"><h2>Submitted weeks</h2><p class="muted">Frozen copies, exactly as they were when submitted.</p>' +
    (snaps.length ? '<ul class="clean">' + snaps.slice(0, 60).map((s) => '<li data-snap="' + esc(s.id) + '"><strong>' + esc(L.fmtRange(s.week_start)) + '</strong> <span class="muted">' + esc(s.member_name || s.member_id) +
      ' · ' + (s.percent === null || s.percent === undefined ? '—' : s.percent + '%') + ' · submitted ' + esc(L.fmtDay(L.dayKey(s.submitted_at))) + '</span> ' +
      '<button class="btn small" data-act="view-snap">View</button></li>').join('') + '</ul>'
      : '<div class="empty">No submitted weeks yet.</div>') + '</div>';
}

/* ------------------------------ dialogs ------------------------------ */

/** Close and remove a dialog now (the close event alone is not relied on for clean-up). */
function shut(dlg) {
  if (dlg.open) dlg.close();
  dlg.remove();
}

function dialog(html) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  // A form that was accepted (not stopped by validation) closes its dialog.
  dlg.addEventListener('submit', (e) => setTimeout(() => { if (!e.defaultPrevented) shut(dlg); }, 0));
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) shut(dlg); });
  dlg.showModal();
  return dlg;
}

function addAdditionalDialog() {
  const owner = S.selected;
  const plan = L.planned(tasksOf(owner)).filter((t) => t.status !== 'Completed');
  const dlg = dialog('<h3 style="margin-top:0">Add additional work</h3><form class="form" method="dialog">' +
    '<label class="full">What came up?*<input name="title" maxlength="200" required></label>' +
    '<label>Hours spent<input name="h" type="number" min="0" max="99" value="0"></label>' +
    '<label>Minutes spent<input name="m" type="number" min="0" max="59" value="0"></label>' +
    '<label class="full">Did it affect a planned task?<select name="affected"><option value="">No</option>' +
    plan.map((t) => '<option value="' + esc(t.id) + '">Yes — ' + esc(t.title) + '</option>').join('') + '</select></label>' +
    '<label>Effect<select name="type">' + L.IMPACT_TYPES.map((x) => '<option>' + x + '</option>').join('') + '</select></label>' +
    '<label class="full">Short explanation (if it affected the plan)<input name="note" maxlength="500"></label>' +
    '<div class="row full"><button class="btn primary" value="save">Add</button><button class="btn" type="button" data-close>Cancel</button></div></form>');
  dlg.querySelector('form').addEventListener('submit', (e) => {
    const f = new FormData(e.target);
    const title = String(f.get('title')).trim();
    if (!title) { e.preventDefault(); return; }
    const minutes = (Number(f.get('h')) || 0) * 60 + (Number(f.get('m')) || 0);
    const affectedId = f.get('affected');
    const note = String(f.get('note')).trim();
    if (affectedId && !note) { e.preventDefault(); toast('Add a short explanation of how it affected the plan.'); return; }
    const id = uid();
    const t = L.newTask({
      id, title, owner_id: owner, task_type: 'ADDITIONAL', percent: null, created_by: S.me.email,
      logs: minutes > 0 ? [{ date: L.todayKey(), minutes, note: 'Recorded when added', by: S.me.email, at: nowISO() }] : []
    });
    saveTask(t, null).then((ok) => {
      if (!ok || !affectedId) return;
      const p = findTask(affectedId);
      if (!p) return;
      const links = (p.affected_by || []).filter((a) => a.task_id !== id).concat([{ task_id: id, type: String(f.get('type')) }]);
      saveTask(Object.assign({}, p, { reason_code: 'additional', affected_by: links, reason_note: p.reason_note || note }), p);
    });
  });
}

function taskDialog(id) {
  const t = findTask(id);
  if (!t) return;
  const ro = canEdit(t) ? '' : ' disabled';
  const opt = (list, cur) => list.map((x) => '<option' + (x === cur ? ' selected' : '') + '>' + x + '</option>').join('');
  const dlg = dialog('<h3 style="margin-top:0">' + esc(t.title) + '</h3>' +
    '<p class="muted">' + esc(nameOf(t.owner_id)) + ' · created ' + esc(L.fmtDay(L.dayKey(t.created_at))) +
    (t.original_due && t.original_due !== t.due ? ' · original deadline ' + esc(L.fmtDay(t.original_due)) : '') +
    (t.archived ? ' · <strong>archived</strong>' : '') + '</p>' +
    '<form class="form" method="dialog" id="tForm">' +
    '<label class="full">Title*<input name="title" maxlength="200" required value="' + esc(t.title) + '"' + ro + '></label>' +
    '<label class="full">Description<textarea name="description" rows="2" maxlength="2000"' + ro + '>' + esc(t.description) + '</textarea></label>' +
    '<label>Type<select name="task_type"' + ro + '><option value="PLANNED"' + (t.task_type === 'PLANNED' ? ' selected' : '') + '>Planned</option><option value="ADDITIONAL"' + (t.task_type === 'ADDITIONAL' ? ' selected' : '') + '>Additional</option></select></label>' +
    '<label>Status<select name="status"' + ro + '>' + opt(L.STATUSES, t.status) + '</select></label>' +
    '<label>% done (blank = not reported)<input name="percent" type="number" min="0" max="100" value="' + (L.isBlank(t.percent) ? '' : t.percent) + '"' + ro + '></label>' +
    '<label>Deadline<input name="due" type="date" value="' + esc(t.due) + '"' + ro + '></label>' +
    '<label>Priority<select name="priority"' + ro + '>' + opt(L.PRIORITIES, t.priority) + '</select></label>' +
    '<label>Estimate (minutes)<input name="est_minutes" type="number" min="0" value="' + (L.isBlank(t.est_minutes) ? '' : t.est_minutes) + '"' + ro + '></label>' +
    (isAdmin() ? '<label class="full">Owner<select name="owner_id">' + activeMembers().concat(member(t.owner_id) && member(t.owner_id).active === false ? [member(t.owner_id)] : [])
      .map((m) => '<option value="' + esc(m.email) + '"' + (m.email === t.owner_id ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select></label>' : '') +
    '<label class="full">Blocker (if blocked)<input name="blocked_reason" maxlength="500" value="' + esc(t.blocked_reason) + '"' + ro + '></label>' +
    '</form>' +
    '<h4>Time logged: ' + esc(L.fmtMinutes(t.minutes)) + '</h4>' +
    (t.logs.length ? '<ul class="clean">' + t.logs.map((l) => '<li>' + esc(L.fmtDay(l.date)) + ' — ' + esc(L.fmtMinutes(l.minutes)) + (l.note ? ' <span class="muted">' + esc(l.note) + '</span>' : '') + '</li>').join('') + '</ul>' : '') +
    (ro ? '' : '<div class="t-ctl"><label>Date <input id="lDate" type="date" value="' + L.todayKey() + '"></label><label>Minutes <input id="lMin" type="number" min="1" max="6000" style="width:90px"></label>' +
      '<label style="flex:1">Note <input id="lNote" maxlength="300" style="width:100%"></label><button class="btn small" type="button" id="lAdd">Log time</button></div>') +
    '<h4>Notes (' + t.notes.length + ')</h4>' +
    (t.notes.length ? '<ul class="clean">' + t.notes.map((n) => '<li>' + esc(n.text) + '<br><span class="muted">' + esc(nameOf(n.by)) + ' · ' + esc(L.fmtDay(L.dayKey(n.at))) + '</span></li>').join('') + '</ul>' : '') +
    (ro ? '' : '<div class="t-ctl"><label style="flex:1">Add a note <input id="nText" maxlength="1000" style="width:100%"></label><button class="btn small" type="button" id="nAdd">Add note</button></div>') +
    '<details class="more"><summary>Change history</summary><div id="tHist" class="muted">Loading…</div></details>' +
    '<div class="row" style="margin-top:14px">' +
    (ro ? '' : '<button class="btn primary" form="tForm" value="save">Save</button>' +
      (t.archived ? '<button class="btn" type="button" id="tRestore">Restore</button>' : '<button class="btn" type="button" id="tArchive">Archive</button>') +
      '<button class="btn danger" type="button" id="tDelete">Delete forever</button>') +
    '<button class="btn" type="button" data-close>Close</button></div>');

  const fresh = () => findTask(id) || t;
  const on = (sel, fn) => { const el = dlg.querySelector(sel); if (el) el.addEventListener('click', fn); };
  dlg.querySelector('details').addEventListener('toggle', (e) => {
    if (!e.target.open) return;
    db.taskEvents(id).then((ev) => {
      ev.sort((a, b) => (a.at < b.at ? 1 : -1));
      dlg.querySelector('#tHist').innerHTML = ev.length ? ev.map((x) => esc(L.fmtDay(L.dayKey(x.at))) + ' · ' + esc(nameOf(x.actor)) + ' · ' + esc(x.detail || x.type)).join('<br>') : 'No changes recorded.';
    }, (e2) => { dlg.querySelector('#tHist').textContent = friendly(e2); });
  });
  dlg.querySelector('#tForm').addEventListener('submit', (e) => {
    const f = new FormData(e.target);
    const cur = fresh();
    let next = Object.assign({}, cur, {
      title: String(f.get('title')).trim(), description: String(f.get('description')), task_type: f.get('task_type'),
      due: f.get('due') || '', priority: f.get('priority'), blocked_reason: String(f.get('blocked_reason')).trim(),
      est_minutes: f.get('est_minutes') === '' ? null : Number(f.get('est_minutes'))
    });
    if (f.get('owner_id')) next.owner_id = f.get('owner_id');
    if (!next.original_due && next.due) next.original_due = next.due;
    const pct = f.get('percent');
    if (String(pct) !== String(L.isBlank(cur.percent) ? '' : cur.percent)) next = L.applyPercent(next, pct);
    if (f.get('status') !== cur.status) next = L.applyStatus(next, f.get('status'));
    const errors = L.validateTask(next);
    if (errors.length) { e.preventDefault(); toast(errors[0]); return; }
    saveTask(next, cur).then((ok) => { if (ok) toast('Saved.'); });
  });
  on('#lAdd', () => {
    const log = { date: dlg.querySelector('#lDate').value, minutes: Number(dlg.querySelector('#lMin').value), note: dlg.querySelector('#lNote').value.trim(), by: S.me.email, at: nowISO() };
    const err = L.validateLog(log);
    if (err) { toast(err); return; }
    const cur = fresh();
    shut(dlg);
    saveTask(Object.assign({}, cur, { logs: cur.logs.concat([log]) }), cur).then((ok) => { if (ok) { toast('Time logged.'); taskDialog(id); } });
  });
  on('#nAdd', () => {
    const text = dlg.querySelector('#nText').value.trim();
    if (!text) { toast('Type the note first.'); return; }
    const cur = fresh();
    shut(dlg);
    saveTask(Object.assign({}, cur, { notes: cur.notes.concat([{ text, by: S.me.email, at: nowISO() }]) }), cur).then((ok) => { if (ok) taskDialog(id); });
  });
  on('#tArchive', () => { const cur = fresh(); shut(dlg); saveTask(Object.assign({}, cur, { archived: true, archived_at: nowISO() }), cur).then((ok) => { if (ok) toast('Archived. You can restore it from the archived list.'); }); });
  on('#tRestore', () => { const cur = fresh(); shut(dlg); saveTask(Object.assign({}, cur, { archived: false, archived_at: '' }), cur).then((ok) => { if (ok) toast('Restored.'); }); });
  on('#tDelete', () => {
    if (!confirm('Permanently delete "' + t.title + '" with its notes and time logs? Submitted weeks keep their frozen copy. This cannot be undone.')) return;
    const cur = fresh();
    shut(dlg);
    S.tasks = S.tasks.filter((x) => x.id !== id); S.archived = S.archived.filter((x) => x.id !== id);
    render();
    db.deleteTask(cur).then(() => toast('Deleted.'), fail);
  });
}

function submitDialog() {
  const m = member(S.selected);
  const mine = tasksOf(m.email);
  const plan = L.planned(mine);
  const s = L.summarize(mine);
  const dlg = dialog('<h3 style="margin-top:0">Submit the week of ' + esc(L.fmtRange(S.week)) + '</h3>' +
    '<p class="muted">' + esc(m.name) + ' · accomplished ' + (s.avg.percent === null ? '—' : s.avg.percent + '%') + ' · ' + s.add.count + ' additional (' + esc(L.fmtMinutes(s.add.minutes)) + ')</p>' +
    '<ul class="review">' + (plan.length ? plan.map((t) => '<li><strong>' + esc(t.title) + '</strong> — ' + (L.isBlank(t.percent) ? 'not reported (left out of the average)' : t.percent + '%') +
      (L.needsReason(t) ? '<br><span class="err">Incomplete with no reason given.</span>' : '') + '</li>').join('') : '<li>No planned tasks.</li>') + '</ul>' +
    '<p class="muted">This keeps a frozen copy of the week as it stands now.</p>' +
    '<div class="row"><button class="btn primary" id="sGo">Confirm submit</button><button class="btn" data-close>Back</button></div>');
  dlg.querySelector('#sGo').addEventListener('click', () => {
    const snap = L.buildSnapshot({ week: S.week, memberId: m.email, memberName: m.name, tasks: mine, submittedBy: S.me.email });
    shut(dlg);
    S.snapshots = S.snapshots.filter((x) => x.id !== snap.id).concat([snap]);
    render();
    db.saveSnapshot(snap).then(() => toast('Submitted — this week is frozen.'), fail);
  });
}

function memberDialog(email) {
  const m = email ? member(email) : { email: '', name: '', role: '', admin: false, active: true };
  if (!m) return;
  const dlg = dialog('<h3 style="margin-top:0">' + (email ? 'Edit member' : 'Add member') + '</h3><form class="form" method="dialog">' +
    '<label class="full">Google account email*<input name="email" type="email" required value="' + esc(m.email) + '"' + (email ? ' disabled' : '') + '></label>' +
    '<label class="full">Name*<input name="name" maxlength="120" required value="' + esc(m.name) + '"></label>' +
    '<label class="full">Role<input name="role" maxlength="120" value="' + esc(m.role) + '"></label>' +
    '<label><input name="admin" type="checkbox"' + (m.admin ? ' checked' : '') + '> Admin (can edit everyone and the roster)</label>' +
    '<label><input name="active" type="checkbox"' + (m.active !== false ? ' checked' : '') + '> Active</label>' +
    '<div class="row full"><button class="btn primary" value="save">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>' +
    '<p class="muted">The person signs in with this exact Google account. Inactive members can no longer open the app; their records stay.</p>');
  dlg.querySelector('form').addEventListener('submit', (e) => {
    const f = new FormData(e.target);
    const next = {
      email: email || String(f.get('email')).trim().toLowerCase(), name: String(f.get('name')).trim(), role: String(f.get('role')).trim(),
      admin: f.get('admin') === 'on', active: f.get('active') === 'on'
    };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.email) || !next.name) { e.preventDefault(); toast('Enter a valid email and a name.'); return; }
    if (!email && member(next.email)) { e.preventDefault(); toast('That email is already on the roster.'); return; }
    if (email === S.me.email && (!next.admin || !next.active)) { e.preventDefault(); toast('You cannot remove your own admin access. Ask another admin.'); return; }
    S.members = S.members.filter((x) => x.email !== next.email).concat([next]);
    render();
    db.saveMember(next).then(() => toast('Member saved.'), fail);
  });
}

/* ------------------------------ actions ------------------------------ */

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function setWeek(week) {
  S.week = week; S.report = ''; S.reportTitle = ''; S.loadingWeek = true;
  if (unsubTasks) unsubTasks();
  unsubTasks = db.watchTasks(S.week, (list) => { S.tasks = list; S.loadingWeek = false; render(); }, fail);
  render();
}

function act(a, el) {
  const row = el.closest('[data-id]');
  const id = row ? row.dataset.id : '';
  switch (a) {
    case 'signin': db.signIn().catch(fail); break;
    case 'signout': db.signOut().catch(fail); break;
    case 'dismiss-error': S.error = ''; render(); break;
    case 'reset-local': if (confirm('Clear everything entered in this preview?')) { db.reset(); toast('Preview data cleared.'); } break;
    case 'week-prev': setWeek(L.addDays(S.week, -7)); break;
    case 'week-next': setWeek(L.addDays(S.week, 7)); break;
    case 'week-today': setWeek(L.mondayOf(L.todayKey())); break;
    case 'open': taskDialog(id); break;
    case 'add-additional': addAdditionalDialog(); break;
    case 'submit-week': submitDialog(); break;
    case 'toggle-archived': S.showArchived = !S.showArchived; render(); break;
    case 'restore': { const t = findTask(id); if (t) saveTask(Object.assign({}, t, { archived: false, archived_at: '' }), t).then((ok) => { if (ok) toast('Restored.'); }); break; }
    case 'add-member': memberDialog(''); break;
    case 'edit-member': memberDialog(el.closest('[data-email]').dataset.email); break;
    case 'csv-week': download('week-' + S.week + '.csv', L.toCsv(weekTasks(), nameOf)); break;
    case 'report-member':
      S.report = L.reportText({ name: nameOf(S.selected), week: S.week, tasks: tasksOf(S.selected) });
      S.reportTitle = 'Current records — not a frozen copy.'; render(); break;
    case 'report-team':
      S.report = activeMembers().map((m) => L.reportText({ name: m.name, week: S.week, tasks: tasksOf(m.email) })).join('\n\n' + '─'.repeat(40) + '\n\n');
      S.reportTitle = 'Whole team, current records — not a frozen copy.'; render(); break;
    case 'view-snap': {
      const s = S.snapshots.find((x) => x.id === el.closest('[data-snap]').dataset.snap);
      if (s) { S.report = s.text; S.reportTitle = 'Frozen copy submitted ' + L.fmtDay(L.dayKey(s.submitted_at)) + ' by ' + nameOf(s.submitted_by) + '.'; render(); window.scrollTo(0, 0); }
      break;
    }
    case 'copy-report': navigator.clipboard.writeText(S.report).then(() => toast('Copied.'), () => toast('Could not copy — select the text instead.')); break;
    case 'print': window.print(); break;
    default: break;
  }
}

/** A list field was changed: work out the new task and save it. */
function fieldChanged(el) {
  const row = el.closest('[data-id]');
  const t = row && findTask(row.dataset.id);
  if (!t || !canEdit(t)) return;
  const v = el.value;
  let next;
  switch (el.dataset.field) {
    case 'percent':
      if (v !== '' && !(Number(v) >= 0 && Number(v) <= 100)) { toast('Enter a percentage from 0 to 100.'); render(); return; }
      next = L.applyPercent(t, v);
      break;
    case 'reason_code':
      next = Object.assign({}, t, { reason_code: v });
      if (v !== 'additional') next.affected_by = [];
      if (v === 'none') next.reason_note = '';
      openDetails.add(t.id);
      break;
    case 'reason_note': next = Object.assign({}, t, { reason_note: v.trim() }); break;
    case 'affected_task': {
      const type = ((t.affected_by || [])[0] || {}).type || L.IMPACT_TYPES[0];
      next = Object.assign({}, t, { affected_by: v ? [{ task_id: v, type }] : [] });
      break;
    }
    case 'affected_type': {
      const cur = (t.affected_by || [])[0];
      if (!cur) return;
      next = Object.assign({}, t, { affected_by: [{ task_id: cur.task_id, type: v }] });
      break;
    }
    default: return;
  }
  saveTask(next, t);
}

const changedFields = [];
function flushFields() {
  while (changedFields.length) fieldChanged(changedFields.shift());
}

function bind() {
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('#nav [data-view]');
    if (tab) { S.view = tab.dataset.view; prefs({ view: S.view }); render(); return; }
    const b = e.target.closest('[data-act]');
    if (b && !b.closest('dialog')) {
      flushFields(); // a value typed just before this click is saved before the action reads the data
      act(b.dataset.act, b);
    }
  });
  document.addEventListener('pointerdown', () => { pressing = true; }, true);
  document.addEventListener('pointerup', released, true);
  document.addEventListener('pointercancel', released, true);
  // Deferred one tick so the focus has already moved on (Tab) before the view is rebuilt.
  $('view').addEventListener('change', (e) => {
    if (!e.target.dataset.field) return;
    changedFields.push(e.target);
    setTimeout(flushFields, 0);
  });
  $('view').addEventListener('submit', (e) => {
    if (e.target.dataset.form !== 'add-planned') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const title = String(f.get('title')).trim();
    if (!title) { toast('Type a title first.'); return; }
    const due = f.get('due') || '';
    e.target.reset();
    saveTask(L.newTask({ id: uid(), title, owner_id: S.selected, task_type: 'PLANNED', due, original_due: due, created_by: S.me.email }), null);
  });
  $('view').addEventListener('toggle', (e) => {
    const k = e.target.dataset && e.target.dataset.det;
    if (!k) return;
    if (e.target.open) openDetails.add(k); else openDetails.delete(k);
  }, true);
  $('memberSelect').addEventListener('change', (e) => { S.selected = e.target.value; S.report = ''; S.reportTitle = ''; prefs({ selected: S.selected }); render(); });
}

/* ------------------------------ start-up ------------------------------ */

function stopWatching() {
  unsubs.forEach((u) => u()); unsubs = [];
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
}

async function onUser(user) {
  stopWatching();
  S.user = user; S.me = null; S.authChecked = true; S.error = '';
  if (!user) { render(); return; }
  try { S.me = await db.getMember(user.email); } catch (e) { S.me = null; if (!e || e.code !== 'permission-denied') S.error = friendly(e); }
  if (!S.me || S.me.active === false) { render(); return; }
  const p = prefs();
  S.selected = S.me.email;
  if (['my', 'team', 'reports'].includes(p.view)) S.view = p.view;
  unsubs.push(db.watchMembers((list) => {
    S.members = list;
    const mine = list.find((m) => m.email === S.me.email);
    if (mine) S.me = mine;
    if (!list.some((m) => m.email === S.selected && m.active !== false)) S.selected = S.me.email;
    render();
  }, fail));
  unsubs.push(db.watchArchived((list) => { S.archived = list; render(); }, fail));
  unsubs.push(db.watchSnapshots((list) => { S.snapshots = list; render(); }, fail));
  setWeek(S.week);
}

async function boot() {
  bind();
  render();
  try {
    const local = !firebaseConfig || new URLSearchParams(location.search).has('local');
    db = local ? (await import('./data-local.js')).create() : await (await import('./data-firebase.js')).create(firebaseConfig);
    db.onUser(onUser);
  } catch (e) {
    S.authChecked = true;
    fail(e);
  }
}

boot();
