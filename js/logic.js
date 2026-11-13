/**
 * Pure business logic — no DOM, no network. Used by the app and by the tests.
 * Dates: every calendar day and week is computed in Asia/Manila. Weeks run
 * Monday to Sunday and are identified by their Monday, "YYYY-MM-DD".
 */

export const TIMEZONE = 'Asia/Manila';
export const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
export const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
export const IMPACT_TYPES = ['Delayed', 'Left less time', 'Prevented completion'];
export const REASONS = {
  none: 'No reason given yet',
  additional: 'Additional task or urgent assignment',
  waiting: 'Waiting for information, approval, or another person',
  time: 'Insufficient time or competing priorities',
  technical: 'Technical or operational issue',
  other: 'Other reason'
};

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isBlank(v) { return v === '' || v === null || v === undefined; }

/** Manila calendar date for a date-only string, ISO timestamp or Date. '' when unknown. */
export function dayKey(v) {
  if (isBlank(v)) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : DAY_FMT.format(d);
}

export function todayKey(now = new Date()) { return DAY_FMT.format(now); }

export function addDays(key, n) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing the given day or timestamp. */
export function mondayOf(v) {
  const key = dayKey(v);
  if (!key) return '';
  const dow = new Date(key + 'T00:00:00Z').getUTCDay();
  return addDays(key, -((dow + 6) % 7));
}

export function weekEnd(week) { return addDays(week, 6); }

export function inWeek(v, week) {
  const d = dayKey(v);
  return !!d && d >= week && d <= weekEnd(week);
}

export function fmtDay(key) {
  if (!key) return '';
  const p = key.split('-');
  return MONTHS[Number(p[1]) - 1] + ' ' + Number(p[2]);
}

export function fmtRange(week) {
  const s = week.split('-'), e = weekEnd(week).split('-');
  const right = (e[1] === s[1] ? '' : MONTHS[Number(e[1]) - 1] + ' ') + Number(e[2]);
  return MONTHS[Number(s[1]) - 1] + ' ' + Number(s[2]) + ' – ' + right + ', ' + e[0];
}

export function fmtMinutes(min) {
  if (isBlank(min)) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

/* ------------------------------ tasks ------------------------------ */

export function isOpen(t) {
  return !t.archived && t.status !== 'Completed' && t.status !== 'Cancelled';
}

/** A blank task with sensible defaults. */
export function newTask(fields, nowISO = new Date().toISOString()) {
  return derive(Object.assign({
    id: '', title: '', description: '', owner_id: '', task_type: 'PLANNED', status: 'Not Started',
    percent: null, due: '', original_due: '', priority: 'Medium', est_minutes: null,
    blocked_reason: '', reason_code: 'none', reason_note: '', affected_by: [], notes: [], logs: [],
    created_at: nowISO, created_by: '', completed_at: '', archived: false, archived_at: '',
    updated_at: nowISO, updated_by: ''
  }, fields));
}

/**
 * Recompute everything that is derived from other fields. Always call before saving:
 *  - minutes: total of the time logs (null when nothing was logged)
 *  - open:    not archived, not completed, not cancelled (drives the carry-over query)
 *  - weeks:   the Mondays of the weeks the task was created, due and completed in
 */
export function derive(task) {
  const t = Object.assign({}, task);
  t.logs = Array.isArray(t.logs) ? t.logs : [];
  t.notes = Array.isArray(t.notes) ? t.notes : [];
  t.affected_by = Array.isArray(t.affected_by) ? t.affected_by : [];
  t.archived = !!t.archived;
  t.percent = isBlank(t.percent) ? null : clampPercent(t.percent);
  t.minutes = t.logs.length ? t.logs.reduce((s, l) => s + (Number(l.minutes) || 0), 0) : null;
  t.open = isOpen(t);
  t.weeks = [...new Set([t.created_at, t.due, t.completed_at].map(mondayOf).filter(Boolean))].sort();
  return t;
}

export function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Set the reported percentage and keep status / completion time consistent with it. */
export function applyPercent(task, value, nowISO = new Date().toISOString()) {
  const t = Object.assign({}, task);
  if (isBlank(value)) {
    t.percent = null;
    if (t.status === 'Completed') { t.status = 'In Progress'; t.completed_at = ''; }
    return derive(t);
  }
  t.percent = clampPercent(value);
  if (t.percent === 100) {
    if (t.status !== 'Cancelled') { t.status = 'Completed'; if (!t.completed_at) t.completed_at = nowISO; }
  } else if (t.status === 'Completed') {
    t.status = 'In Progress'; t.completed_at = '';
  } else if (t.status === 'Not Started' && t.percent > 0) {
    t.status = 'In Progress';
  }
  return derive(t);
}

/** Set the status and keep percent / completion time consistent with it. */
export function applyStatus(task, status, nowISO = new Date().toISOString()) {
  const t = Object.assign({}, task, { status });
  if (status === 'Completed') { t.percent = 100; if (!t.completed_at) t.completed_at = nowISO; }
  else {
    t.completed_at = '';
    if (t.percent === 100 && status !== 'Cancelled') t.percent = 90;
  }
  return derive(t);
}

export function validateTask(t) {
  const errors = [];
  if (!t.title || !String(t.title).trim()) errors.push('Give the task a title.');
  if (String(t.title || '').length > 200) errors.push('The title is too long (200 characters at most).');
  if (!t.owner_id) errors.push('Choose who the task belongs to.');
  if (!['PLANNED', 'ADDITIONAL'].includes(t.task_type)) errors.push('The task type is not valid.');
  if (!STATUSES.includes(t.status)) errors.push('The status is not valid.');
  if (t.due && !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) errors.push('The deadline is not a valid date.');
  if (!isBlank(t.est_minutes) && !(Number(t.est_minutes) >= 0)) errors.push('The estimate must be zero or more minutes.');
  return errors;
}

export function validateLog(l) {
  const m = Number(l.minutes);
  if (!Number.isFinite(m) || m <= 0 || m > 6000) return 'Enter the time spent (up to 100 hours).';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date || '')) return 'Choose the date the work was done.';
  return '';
}

/** Tasks that belong to a reporting week: created, due or completed in it, or still open from before. */
export function scopeWeek(tasks, week) {
  return (tasks || []).filter((t) => {
    if (!t || t.archived) return false;
    const created = dayKey(t.created_at);
    return inWeek(t.created_at, week) || inWeek(t.due, week) || inWeek(t.completed_at, week) ||
      (!!created && created < week && isOpen(t));
  });
}

export function isOverdue(t, today = todayKey()) {
  return isOpen(t) && !!t.due && t.due < today;
}

export const planned = (tasks) => tasks.filter((t) => t.task_type === 'PLANNED' && t.status !== 'Cancelled');
export const additional = (tasks) => tasks.filter((t) => t.task_type === 'ADDITIONAL' && t.status !== 'Cancelled');

/** Mean of the REPORTED percentages of planned tasks. Blank tasks are left out and counted. */
export function averageAccomplishment(tasks) {
  const list = planned(tasks);
  const reported = list.filter((t) => !isBlank(t.percent));
  const sum = reported.reduce((s, t) => s + clampPercent(t.percent), 0);
  return {
    percent: reported.length ? Math.round((sum / reported.length) * 10) / 10 : null,
    count: list.length, reported: reported.length, unreported: list.length - reported.length
  };
}

export function additionalTime(tasks) {
  const list = additional(tasks);
  const timed = list.filter((t) => !isBlank(t.minutes));
  return {
    count: list.length, minutes: timed.reduce((s, t) => s + Number(t.minutes), 0),
    withoutTime: list.length - timed.length
  };
}

/** Every documented "this additional task affected that planned task" link in the given tasks. */
export function impacts(tasks) {
  const out = [];
  for (const t of tasks) {
    for (const a of t.affected_by || []) {
      out.push({ additional_task_id: a.task_id, affected_task_id: t.id, type: a.type || 'Delayed', note: t.reason_note || '' });
    }
  }
  return out;
}

/** An incomplete planned task nobody has explained. */
export function needsReason(t) {
  return t.task_type === 'PLANNED' && isOpen(t) && !isBlank(t.percent) && t.percent < 100 &&
    (t.reason_code || 'none') === 'none' && !t.blocked_reason && !(t.affected_by || []).length;
}

export function summarize(tasks, today = todayKey()) {
  const avg = averageAccomplishment(tasks);
  const add = additionalTime(tasks);
  return {
    avg, add,
    completed: planned(tasks).filter((t) => t.status === 'Completed').length,
    impacts: impacts(tasks).length,
    overdue: tasks.filter((t) => isOverdue(t, today)).length,
    blocked: tasks.filter((t) => t.status === 'Blocked').length,
    needsReason: tasks.filter(needsReason).length
  };
}

const pct = (v) => (isBlank(v) ? 'not reported' : v + '%');

/** Plain-text weekly report for one person (or the team) from that week's tasks. */
export function reportText({ name, week, tasks, today = todayKey() }) {
  const s = summarize(tasks, today);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const L = [];
  L.push('WEEKLY ACCOMPLISHMENT REPORT — ' + name);
  L.push('Week of ' + fmtRange(week) + ' (Mon–Sun, Asia/Manila).');
  L.push('');
  L.push('Accomplished: ' + (s.avg.percent === null ? '—' : s.avg.percent + '%') +
    ' (average of ' + s.avg.reported + ' reported of ' + s.avg.count + ' planned task(s)' +
    (s.avg.unreported ? '; ' + s.avg.unreported + ' not reported' : '') + ').');
  L.push('');
  L.push('PLANNED TASKS (' + s.avg.count + ', ' + s.completed + ' completed)');
  for (const t of planned(tasks)) {
    L.push('  • ' + t.title + ' — ' + pct(t.percent) + (t.due ? ' (due ' + fmtDay(t.due) + ')' : '') +
      (isOverdue(t, today) ? ' OVERDUE' : '') + (t.status === 'Blocked' ? ' BLOCKED' : ''));
    if (t.status !== 'Completed') {
      const why = [];
      if ((t.reason_code || 'none') !== 'none') why.push(REASONS[t.reason_code] || t.reason_code);
      if (t.reason_note) why.push(t.reason_note);
      if (t.blocked_reason) why.push('Blocked: ' + t.blocked_reason);
      for (const a of t.affected_by || []) {
        const src = byId.get(a.task_id);
        why.push((a.type || 'Delayed') + ' by "' + (src ? src.title : 'an additional task') + '"');
      }
      if (why.length) L.push('      Why: ' + why.join(' — '));
      else if (needsReason(t)) L.push('      No reason given yet.');
    }
  }
  if (!s.avg.count) L.push('  (none)');
  L.push('');
  L.push('ADDITIONAL WORK (' + s.add.count + ', ' + fmtMinutes(s.add.minutes) + ' recorded' +
    (s.add.withoutTime ? ', ' + s.add.withoutTime + ' without time' : '') + ')');
  for (const t of additional(tasks)) {
    L.push('  • ' + t.title + ' — ' + (isBlank(t.minutes) ? 'time not recorded' : fmtMinutes(t.minutes)) +
      (t.status === 'Completed' ? ' — done' : ''));
  }
  if (!s.add.count) L.push('  (none)');
  L.push('');
  L.push('Overdue: ' + s.overdue + ' · Blocked: ' + s.blocked + ' · Documented impacts on planned work: ' + s.impacts +
    ' · Incomplete without a reason: ' + s.needsReason + '.');
  return L.join('\n');
}

/** The frozen record written when a week is submitted. Nothing in it is recomputed later. */
export function buildSnapshot({ week, memberId, memberName, tasks, submittedBy, nowISO = new Date().toISOString() }) {
  const today = dayKey(nowISO);
  const s = summarize(tasks, today);
  return {
    id: week + '__' + memberId, week_start: week, week_end: weekEnd(week), member_id: memberId, member_name: memberName,
    percent: s.avg.percent, planned: s.avg.count, reported: s.avg.reported, completed: s.completed,
    additional: s.add.count, additional_minutes: s.add.minutes, impacts: s.impacts,
    overdue: s.overdue, blocked: s.blocked,
    text: reportText({ name: memberName, week, tasks, today }),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, task_type: t.task_type, status: t.status, percent: t.percent, minutes: t.minutes })),
    submitted_by: submittedBy, submitted_at: nowISO
  };
}

/** CSV with spreadsheet-formula neutralising, safe to open in Excel or Sheets. */
export function toCsv(tasks, nameOf = (id) => id) {
  const head = ['Owner', 'Type', 'Title', 'Status', 'Percent', 'Due', 'Original due', 'Created', 'Completed',
    'Minutes', 'Reason', 'Explanation', 'Blocked reason', 'Affected by'];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cell = (v) => {
    let s = isBlank(v) ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = tasks.map((t) => [
    nameOf(t.owner_id), t.task_type, t.title, t.status, t.percent, t.due, t.original_due,
    dayKey(t.created_at), dayKey(t.completed_at), t.minutes,
    (t.reason_code || 'none') === 'none' ? '' : (REASONS[t.reason_code] || t.reason_code), t.reason_note, t.blocked_reason,
    (t.affected_by || []).map((a) => (byId.get(a.task_id) || {}).title || a.task_id).join('; ')
  ].map(cell).join(','));
  return [head.join(',')].concat(rows).join('\r\n');
}

/** Short description of what changed between two versions of a task, for the history. */
export function describeChange(before, after) {
  const fields = { title: 'title', owner_id: 'owner', task_type: 'type', status: 'status', percent: 'percent', due: 'deadline',
    priority: 'priority', est_minutes: 'estimate', blocked_reason: 'blocker', reason_code: 'reason', reason_note: 'explanation', archived: 'archived' };
  const show = (v) => (isBlank(v) ? '—' : String(v));
  const parts = [];
  for (const k of Object.keys(fields)) {
    if (show(before[k]) !== show(after[k])) parts.push(fields[k] + ': ' + show(before[k]) + ' → ' + show(after[k]));
  }
  if ((before.logs || []).length !== (after.logs || []).length) parts.push('time logged');
  if ((before.notes || []).length !== (after.notes || []).length) parts.push('note added');
  if (JSON.stringify(before.affected_by || []) !== JSON.stringify(after.affected_by || [])) parts.push('impact links changed');
  return parts.join('; ');
}
