/*
 * History database on this device (IndexedDB). Every reading the page takes from PREPA is stored here,
 * so charts, the outage log and 24-hour totals keep building across visits instead of starting over.
 * Readings from the GitHub updater (data/*.json) are merged in on top when it runs.
 */
window.HDB = (() => {
  const NAME = 'pr-generation-history', VERSION = 1, KEEP_DAYS = 400;
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('This browser has no local database'));
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('checks')) db.createObjectStore('checks', { keyPath: 'at' });
        if (!db.objectStoreNames.contains('trace')) db.createObjectStore('trace', { keyPath: 'time' });
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'event_id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), s = t.objectStore(store); let out;
      Promise.resolve(fn(s)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    });
  };
  const put = (store, rows) => tx(store, 'readwrite', (s) => { for (const r of rows) s.put(r); return rows.length; });
  const all = (store) => tx(store, 'readonly', (s) => new Promise((res) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); }));
  const getMeta = (k) => tx('meta', 'readonly', (s) => new Promise((res) => { const r = s.get(k); r.onsuccess = () => res(r.result ? r.result.v : null); }));
  const setMeta = (k, v) => tx('meta', 'readwrite', (s) => { s.put({ k, v }); });
  async function prune() {
    const cut = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
    for (const [store, key] of [['checks', 'at'], ['trace', 'time'], ['events', 'detected_at']]) {
      await tx(store, 'readwrite', (s) => new Promise((res) => {
        const r = s.openCursor(); r.onsuccess = () => { const c = r.result; if (!c) return res(); if (new Date(c.value[key]).toISOString() < cut) c.delete(); c.continue(); };
      }));
    }
  }
  async function clear() { for (const s of ['checks', 'trace', 'events', 'meta']) await tx(s, 'readwrite', (st) => { st.clear(); }); }
  return { open, put, all, getMeta, setMeta, prune, clear };
})();
