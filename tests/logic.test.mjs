import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

const WEEK = '2026-11-09'; // a Monday
const at = (day, hour = 2) => day + 'T' + String(hour).padStart(2, '0') + ':00:00Z';
const task = (f) => L.newTask(Object.assign({ id: f.title, owner_id: 'a@x.test', created_at: at('2026-11-10') }, f), at('2026-11-10'));

describe('dates (Asia/Manila)', () => {
  it('converts timestamps to the Manila calendar day', () => {
    assert.equal(L.dayKey('2026-11-08T16:00:00Z'), '2026-11-09'); // midnight in Manila
    assert.equal(L.dayKey('2026-11-08T15:59:00Z'), '2026-11-08');
    assert.equal(L.dayKey('2026-11-11'), '2026-11-11');
    assert.equal(L.dayKey(''), '');
    assert.equal(L.dayKey('nonsense'), '');
  });
  it('finds the Monday of any day, including Sunday and year boundaries', () => {
    assert.equal(L.mondayOf('2026-11-09'), WEEK);
    assert.equal(L.mondayOf('2026-11-15'), WEEK);
    assert.equal(L.mondayOf('2026-11-16'), '2026-11-16');
    assert.equal(L.mondayOf('2026-11-08T20:00:00Z'), WEEK); // already Monday in Manila
    assert.equal(L.mondayOf('2027-01-01'), '2026-12-28');
  });
  it('formats ranges and durations', () => {
    assert.equal(L.fmtRange(WEEK), 'Nov 9 – 15, 2026');
    assert.equal(L.fmtRange('2026-11-30'), 'Nov 30 – Dec 6, 2026');
    assert.equal(L.fmtMinutes(135), '2h 15m');
    assert.equal(L.fmtMinutes(null), '—');
  });
});

describe('derived task fields', () => {
  it('new tasks are unreported, open, and filed under their week', () => {
    const t = task({ title: 'A', due: '2026-11-20' });
    assert.equal(t.percent, null);
    assert.equal(t.open, true);
    assert.equal(t.minutes, null);
    assert.deepEqual(t.weeks, [WEEK, '2026-11-16']);
  });
  it('minutes is always the sum of the time logs', () => {
    const t = L.derive(Object.assign(task({ title: 'A' }), { logs: [{ minutes: 30 }, { minutes: 90 }] }));
    assert.equal(t.minutes, 120);
  });
  it('archived, completed and cancelled tasks are not open', () => {
    assert.equal(L.derive(Object.assign(task({ title: 'A' }), { archived: true })).open, false);
    assert.equal(L.applyStatus(task({ title: 'A' }), 'Cancelled').open, false);
    assert.equal(L.applyPercent(task({ title: 'A' }), 100).open, false);
  });
});

describe('percent and status stay consistent', () => {
  it('100% completes the task and stamps the time once', () => {
    const t = L.applyPercent(task({ title: 'A' }), '100', at('2026-11-12'));
    assert.equal(t.status, 'Completed');
    assert.equal(t.completed_at, at('2026-11-12'));
    assert.equal(L.applyPercent(t, 100, at('2026-11-13')).completed_at, at('2026-11-12'));
  });
  it('lowering a completed task reopens it without asking for anything', () => {
    const t = L.applyPercent(L.applyPercent(task({ title: 'A' }), 100), 80);
    assert.equal(t.status, 'In Progress');
    assert.equal(t.completed_at, '');
    assert.equal(t.open, true);
  });
  it('0% is a real report; blank is not', () => {
    assert.equal(L.applyPercent(task({ title: 'A' }), '0').percent, 0);
    assert.equal(L.applyPercent(task({ title: 'A' }), '').percent, null);
    assert.equal(L.applyPercent(task({ title: 'A' }), 40).status, 'In Progress');
    assert.equal(L.applyPercent(task({ title: 'A' }), 0).status, 'Not Started');
  });
  it('clamps and rounds', () => {
    assert.equal(L.applyPercent(task({ title: 'A' }), 250).percent, 100);
    assert.equal(L.applyPercent(task({ title: 'A' }), 33.6).percent, 34);
  });
  it('setting the status to Completed sets 100%; leaving it drops below 100', () => {
    const done = L.applyStatus(task({ title: 'A' }), 'Completed', at('2026-11-12'));
    assert.equal(done.percent, 100);
    const back = L.applyStatus(done, 'Blocked');
    assert.equal(back.completed_at, '');
    assert.ok(back.percent < 100);
  });
});

describe('week scope', () => {
  const created = task({ title: 'created this week' });
  const dueOnly = L.newTask({ id: 'd', title: 'due this week', owner_id: 'a@x.test', due: '2026-11-13', created_at: at('2026-10-01') }, at('2026-10-01'));
  const carried = L.newTask({ id: 'c', title: 'old but open', owner_id: 'a@x.test', created_at: at('2026-10-01') });
  const oldDone = L.applyPercent(L.newTask({ id: 'o', title: 'old and done', owner_id: 'a@x.test', created_at: at('2026-10-01') }), 100, at('2026-10-02'));
  const future = L.newTask({ id: 'f', title: 'next week', owner_id: 'a@x.test', created_at: at('2026-11-17') });
  const archived = L.derive(Object.assign({}, created, { id: 'z', archived: true }));
  it('includes created, due, completed-in-week and open carry-over only', () => {
    const ids = L.scopeWeek([created, dueOnly, carried, oldDone, future, archived], WEEK).map((t) => t.title).sort();
    assert.deepEqual(ids, ['created this week', 'due this week', 'old but open']);
  });
  it('a task finished this week still belongs to this week', () => {
    const done = L.applyPercent(carried, 100, at('2026-11-12'));
    assert.equal(L.scopeWeek([done], WEEK).length, 1);
    assert.equal(L.scopeWeek([done], '2026-11-16').length, 0);
  });
});

describe('summaries', () => {
  const a = L.applyPercent(task({ title: 'A' }), 50);
  const b = L.applyPercent(task({ title: 'B' }), 100);
  const blank = task({ title: 'C' });
  const cancelled = L.applyStatus(L.applyPercent(task({ title: 'D' }), 10), 'Cancelled');
  const extra = L.derive(Object.assign(task({ title: 'X', task_type: 'ADDITIONAL' }), { logs: [{ minutes: 90 }] }));
  const extraNoTime = task({ title: 'Y', task_type: 'ADDITIONAL' });
  const all = [a, b, blank, cancelled, extra, extraNoTime];

  it('averages only reported planned tasks and counts the blanks', () => {
    assert.deepEqual(L.averageAccomplishment(all), { percent: 75, count: 3, reported: 2, unreported: 1 });
    assert.equal(L.averageAccomplishment([]).percent, null);
  });
  it('totals additional time and counts tasks without any', () => {
    assert.deepEqual(L.additionalTime(all), { count: 2, minutes: 90, withoutTime: 1 });
  });
  it('flags incomplete planned tasks with no reason, but not blank or explained ones', () => {
    assert.equal(L.needsReason(a), true);
    assert.equal(L.needsReason(blank), false);
    assert.equal(L.needsReason(b), false);
    assert.equal(L.needsReason(Object.assign({}, a, { reason_code: 'time' })), false);
    assert.equal(L.needsReason(Object.assign({}, a, { affected_by: [{ task_id: 'X' }] })), false);
  });
  it('lists documented impacts and overdue tasks', () => {
    const hit = Object.assign({}, a, { affected_by: [{ task_id: 'X', type: 'Delayed' }], reason_note: 'pulled away' });
    assert.deepEqual(L.impacts([hit, b]), [{ additional_task_id: 'X', affected_task_id: 'A', type: 'Delayed', note: 'pulled away' }]);
    const late = Object.assign({}, a, { due: '2026-11-10' });
    assert.equal(L.isOverdue(late, '2026-11-11'), true);
    assert.equal(L.isOverdue(late, '2026-11-10'), false);
    assert.equal(L.isOverdue(Object.assign({}, b, { due: '2026-11-10' }), '2026-11-11'), false);
  });
});

describe('report, snapshot and CSV', () => {
  const a = Object.assign(L.applyPercent(task({ title: 'Plan A' }), 50), { reason_code: 'additional', reason_note: 'urgent request', affected_by: [{ task_id: 'Extra', type: 'Delayed' }] });
  const extra = L.derive(Object.assign(task({ title: 'Extra', task_type: 'ADDITIONAL' }), { logs: [{ minutes: 60 }] }));
  it('the report names the percentage, the reason and the linked additional task', () => {
    const text = L.reportText({ name: 'Alex', week: WEEK, tasks: [a, extra], today: '2026-11-12' });
    assert.match(text, /Accomplished: 50%/);
    assert.match(text, /Plan A — 50%/);
    assert.match(text, /urgent request/);
    assert.match(text, /Delayed by "Extra"/);
    assert.match(text, /ADDITIONAL WORK \(1, 1h 0m recorded\)/);
  });
  it('a snapshot is a self-contained frozen copy', () => {
    const s = L.buildSnapshot({ week: WEEK, memberId: 'a@x.test', memberName: 'Alex', tasks: [a, extra], submittedBy: 'a@x.test', nowISO: at('2026-11-13') });
    assert.equal(s.id, WEEK + '__a@x.test');
    assert.equal(s.week_end, '2026-11-15');
    assert.equal(s.percent, 50);
    assert.equal(s.additional_minutes, 60);
    assert.equal(s.tasks.length, 2);
    assert.match(s.text, /Plan A — 50%/);
    assert.doesNotThrow(() => JSON.stringify(s));
  });
  it('CSV quotes and neutralises formulas', () => {
    const evil = task({ title: '=HYPERLINK("http://x")' });
    const csv = L.toCsv([evil, a, extra], (id) => 'Name of ' + id);
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[1].includes('"\'=HYPERLINK(""http://x"")"'));
    assert.ok(lines[2].includes('Extra'), 'affected-by column should name the additional task');
    assert.ok(lines[1].startsWith('Name of a@x.test,PLANNED,'));
  });
});

describe('validation and history', () => {
  it('rejects tasks without a title or owner', () => {
    assert.ok(L.validateTask(L.newTask({ id: '1', title: ' ', owner_id: 'a@x.test' })).length);
    assert.ok(L.validateTask(L.newTask({ id: '1', title: 'ok', owner_id: '' })).length);
    assert.deepEqual(L.validateTask(task({ title: 'ok' })), []);
  });
  it('validates time logs', () => {
    assert.equal(L.validateLog({ date: '2026-11-10', minutes: 30 }), '');
    assert.ok(L.validateLog({ date: '2026-11-10', minutes: 0 }));
    assert.ok(L.validateLog({ date: '', minutes: 30 }));
  });
  it('describes what changed', () => {
    const before = task({ title: 'A' });
    const after = L.applyPercent(Object.assign({}, before, { due: '2026-11-14' }), 100);
    const d = L.describeChange(before, after);
    assert.match(d, /status: Not Started → Completed/);
    assert.match(d, /percent: — → 100/);
    assert.match(d, /deadline: — → 2026-11-14/);
    assert.equal(L.describeChange(before, before), '');
  });
});
