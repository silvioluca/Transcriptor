// Firebase: login Google + archivio Firestore (users/{uid}/conversations/{cid}/segments/{sid})
import { firebaseConfig, allowedEmails } from './config.js';

const V = '13.0.0';
const BASE = `https://www.gstatic.com/firebasejs/${V}/`;

export const configured = !!(firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('INSERISCI'));

let fb = null; // moduli
let app, auth, db;
let user = null;

export async function init(onUser, onDenied) {
  if (!configured) { onUser(null); return false; }
  const [a, au, fs] = await Promise.all([
    import(BASE + 'firebase-app.js'),
    import(BASE + 'firebase-auth.js'),
    import(BASE + 'firebase-firestore.js'),
  ]);
  fb = { ...a, ...au, ...fs };
  app = fb.initializeApp(firebaseConfig);
  auth = fb.getAuth(app);
  auth.languageCode = 'it';
  try {
    db = fb.initializeFirestore(app, {
      localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }),
    });
  } catch {
    db = fb.getFirestore(app);
  }
  fb.onAuthStateChanged(auth, async (u) => {
    if (u && allowedEmails && allowedEmails.length && !allowedEmails.includes((u.email || '').toLowerCase())) {
      await fb.signOut(auth);
      onDenied?.(u.email);
      return;
    }
    user = u;
    onUser(u);
  });
  return true;
}

export async function signIn() {
  const p = new fb.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  try {
    await fb.signInWithPopup(auth, p);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await fb.signInWithRedirect(auth, p);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      throw e;
    }
  }
}

export const signOut = () => fb.signOut(auth);
export const currentUser = () => user;

const convCol = () => fb.collection(db, 'users', user.uid, 'conversations');
const segCol = (cid) => fb.collection(db, 'users', user.uid, 'conversations', cid, 'segments');

export function newConversationId() {
  return fb.doc(convCol()).id;
}

export function createConversation(cid, meta) {
  return fb.setDoc(fb.doc(convCol(), cid), {
    ...meta,
    createdAt: fb.serverTimestamp(),
    updatedAt: fb.serverTimestamp(),
  });
}

export function updateConversation(cid, patch) {
  return fb.updateDoc(fb.doc(convCol(), cid), { ...patch, updatedAt: fb.serverTimestamp() });
}

export function newSegmentId(cid) {
  return fb.doc(segCol(cid)).id;
}

export function saveSegment(cid, seg) {
  const { id, ...data } = seg;
  return fb.setDoc(fb.doc(segCol(cid), id), data);
}

export function updateSegment(cid, sid, patch) {
  return fb.updateDoc(fb.doc(segCol(cid), sid), patch);
}

export function deleteSegment(cid, sid) {
  return fb.deleteDoc(fb.doc(segCol(cid), sid));
}

export async function batchUpdateSegments(cid, ids, patch) {
  for (let i = 0; i < ids.length; i += 400) {
    const b = fb.writeBatch(db);
    ids.slice(i, i + 400).forEach((sid) => b.update(fb.doc(segCol(cid), sid), patch));
    await b.commit();
  }
}

export async function listConversations(after = null, n = 30) {
  const parts = [convCol(), fb.orderBy('updatedAt', 'desc'), fb.limit(n)];
  if (after) parts.splice(2, 0, fb.startAfter(after));
  const snap = await fb.getDocs(fb.query(...parts));
  return {
    items: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    last: snap.docs[snap.docs.length - 1] || null,
    more: snap.docs.length === n,
  };
}

export async function loadConversation(cid) {
  const [m, s] = await Promise.all([
    fb.getDoc(fb.doc(convCol(), cid)),
    fb.getDocs(fb.query(segCol(cid), fb.orderBy('start'))),
  ]);
  if (!m.exists()) throw new Error('Trascrizione non trovata');
  return { meta: { id: m.id, ...m.data() }, segments: s.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

export async function deleteConversation(cid) {
  const s = await fb.getDocs(segCol(cid));
  for (let i = 0; i < s.docs.length; i += 400) {
    const b = fb.writeBatch(db);
    s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  await fb.deleteDoc(fb.doc(convCol(), cid));
}

export function toDate(ts) {
  if (!ts) return new Date();
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}
