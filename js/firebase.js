const firebaseConfig = {
  apiKey: 'AIzaSyCM6PKyiJ53CSGEDQpLxk4czmV9Vro0_as',
  authDomain: 'ihfad-2fecd.firebaseapp.com',
  databaseURL: 'https://ihfad-2fecd-default-rtdb.firebaseio.com',
  projectId: 'ihfad-2fecd',
  storageBucket: 'ihfad-2fecd.firebasestorage.app',
  messagingSenderId: '185800313271',
  appId: '1:185800313271:web:84b269e7e72fdd1ea80032',
  measurementId: 'G-JW4XK0R5HH'
};
let services;
function reportDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('quran-local-reports', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('reports', {keyPath:'sessionId'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storeLocal(report) {
  const db = await reportDb();
  await new Promise((resolve,reject) => {
    const transaction = db.transaction('reports','readwrite');
    transaction.objectStore('reports').put(report);
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
async function pending() {
  const db = await reportDb();
  const rows = await new Promise((resolve,reject) => {
    const request = db.transaction('reports').objectStore('reports').getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close(); return rows;
}
async function connect() {
  if (services) return services;
  const [{initializeApp}, {getAuth, signInAnonymously}, {getDatabase, ref, set}] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js')
  ]);
  const app = initializeApp(firebaseConfig);
  const credential = await signInAnonymously(getAuth(app));
  return services = {db: getDatabase(app), ref, set, uid: credential.user.uid};
}
export async function saveReport(report) {
  await storeLocal(report);
  try { await syncReports(); } catch { /* Kept locally until connectivity returns. */ }
}
export async function syncReports() {
  const rows = await pending(); if (!rows.length) return;
  const {db, ref, set, uid} = await connect();
  for (const report of rows) await set(ref(db, `recitationSessions/${uid}/${report.sessionId}`), report);
}
if (typeof window !== 'undefined') window.addEventListener('online', () => syncReports().catch(() => {}));
