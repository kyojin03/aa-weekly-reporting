/**
 * Local preview data layer: same interface as data-firebase.js, but everything
 * lives in this browser's localStorage. No sign-in, no server, sample people only.
 */
const KEY = 'aa_next_local_v1';
const ME = { email: 'you@example.test', name: 'You (preview)' };

function seed() {
  return {
    members: [
      { email: ME.email, name: ME.name, role: 'Preview admin', admin: true, active: true },
      { email: 'alex@example.test', name: 'Alex Sample', role: 'Associate', admin: false, active: true },
      { email: 'sam@example.test', name: 'Sam Sample', role: 'Assistant', admin: false, active: true }
    ],
    tasks: [], snapshots: [], events: {}
  };
}

export function create() {
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch (e) { db = seed(); }
  const subs = new Set();
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* preview only */ }
    subs.forEach((fn) => fn());
  };
  const watch = (pick, cb) => {
    const fn = () => cb(clone(pick()));
    subs.add(fn); fn();
    return () => subs.delete(fn);
  };

  return {
    mode: 'local',
    onUser(cb) { setTimeout(() => cb(ME), 0); },
    signIn() { return Promise.resolve(); },
    signOut() { return Promise.resolve(); },
    getMember(email) { return Promise.resolve(clone(db.members.find((m) => m.email === email) || null)); },
    watchMembers(cb) { return watch(() => db.members, cb); },
    watchTasks(week, cb) { return watch(() => db.tasks.filter((t) => t.open || (t.weeks || []).includes(week)), cb); },
    watchArchived(cb) { return watch(() => db.tasks.filter((t) => t.archived), cb); },
    watchSnapshots(cb) { return watch(() => db.snapshots, cb); },
    saveTask(task, event) {
      const i = db.tasks.findIndex((t) => t.id === task.id);
      if (i === -1) db.tasks.push(clone(task)); else db.tasks[i] = clone(task);
      if (event) (db.events[task.id] = db.events[task.id] || []).push(Object.assign({ actor: ME.email, at: new Date().toISOString() }, event));
      persist();
      return Promise.resolve();
    },
    deleteTask(task) {
      db.tasks = db.tasks.filter((t) => t.id !== task.id);
      delete db.events[task.id];
      persist();
      return Promise.resolve();
    },
    taskEvents(id) { return Promise.resolve(clone(db.events[id] || [])); },
    saveSnapshot(snap) {
      db.snapshots = db.snapshots.filter((s) => s.id !== snap.id).concat([clone(snap)]);
      persist();
      return Promise.resolve();
    },
    saveMember(m) {
      db.members = db.members.filter((x) => x.email !== m.email).concat([clone(m)]);
      persist();
      return Promise.resolve();
    },
    reset() { db = seed(); persist(); }
  };
}
