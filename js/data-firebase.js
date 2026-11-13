/**
 * Live data layer: Firestore + Google sign-in. Same interface as data-local.js.
 *
 * Collections
 *   members/{email}            name, role, admin, active        (id = lower-case email)
 *   tasks/{id}                 the task, with notes / logs / affected_by embedded
 *   tasks/{id}/events/{auto}   change history (who, when, what)
 *   snapshots/{week__email}    frozen weekly record
 *   deletions/{id}             copy of a permanently deleted task
 *
 * Reads use live listeners with an on-device cache, so the screen fills from
 * the cache at once and other people's changes arrive without a reload.
 */
const V = 'https://www.gstatic.com/firebasejs/10.12.2/';

export async function create(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(V + 'firebase-app.js'), import(V + 'firebase-auth.js'), import(V + 'firebase-firestore.js')
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  let fs;
  try {
    fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch (e) {
    fs = F.getFirestore(app); // private windows etc.: no on-device cache, still works
  }

  const me = () => (auth.currentUser && auth.currentUser.email ? auth.currentUser.email.toLowerCase() : '');
  const plain = (v) => JSON.parse(JSON.stringify(v)); // Firestore rejects undefined
  const rows = (snap) => snap.docs.map((d) => d.data());
  const col = (name) => F.collection(fs, name);

  return {
    mode: 'firebase',
    onUser(cb) {
      A.onAuthStateChanged(auth, (u) => cb(u && u.email ? { email: u.email.toLowerCase(), name: u.displayName || u.email } : null));
    },
    signIn() {
      const provider = new A.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return A.signInWithPopup(auth, provider);
    },
    signOut() { return A.signOut(auth); },
    async getMember(email) {
      const d = await F.getDoc(F.doc(fs, 'members', email));
      return d.exists() ? d.data() : null;
    },
    watchMembers(cb, onErr) { return F.onSnapshot(col('members'), (s) => cb(rows(s)), onErr); },
    /** The week's tasks = tasks dated in that week + every task still open (carry-over). */
    watchTasks(week, cb, onErr) {
      let dated = null, open = null;
      const emit = () => {
        if (dated === null || open === null) return;
        const byId = new Map();
        dated.concat(open).forEach((t) => byId.set(t.id, t));
        cb([...byId.values()]);
      };
      const u1 = F.onSnapshot(F.query(col('tasks'), F.where('weeks', 'array-contains', week)), (s) => { dated = rows(s); emit(); }, onErr);
      const u2 = F.onSnapshot(F.query(col('tasks'), F.where('open', '==', true)), (s) => { open = rows(s); emit(); }, onErr);
      return () => { u1(); u2(); };
    },
    watchArchived(cb, onErr) {
      return F.onSnapshot(F.query(col('tasks'), F.where('archived', '==', true), F.limit(200)), (s) => cb(rows(s)), onErr);
    },
    watchSnapshots(cb, onErr) {
      return F.onSnapshot(F.query(col('snapshots'), F.orderBy('week_start', 'desc'), F.limit(400)), (s) => cb(rows(s)), onErr);
    },
    saveTask(task, event) {
      const batch = F.writeBatch(fs);
      batch.set(F.doc(fs, 'tasks', task.id), plain(task));
      if (event) {
        batch.set(F.doc(F.collection(fs, 'tasks', task.id, 'events')),
          plain(Object.assign({ actor: me(), at: new Date().toISOString() }, event)));
      }
      return batch.commit();
    },
    deleteTask(task) {
      const batch = F.writeBatch(fs);
      batch.set(F.doc(fs, 'deletions', task.id), { task: plain(task), actor: me(), at: new Date().toISOString() });
      batch.delete(F.doc(fs, 'tasks', task.id));
      return batch.commit();
    },
    async taskEvents(id) {
      const s = await F.getDocs(F.query(F.collection(fs, 'tasks', id, 'events'), F.orderBy('at', 'desc'), F.limit(100)));
      return rows(s);
    },
    saveSnapshot(snap) { return F.setDoc(F.doc(fs, 'snapshots', snap.id), plain(snap)); },
    saveMember(m) { return F.setDoc(F.doc(fs, 'members', m.email), plain(m)); }
  };
}
