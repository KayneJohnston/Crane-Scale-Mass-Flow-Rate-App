// Session storage in IndexedDB (falls back to memory if unavailable).

const DB = 'tap-rate';
const STORE = 'sessions';

export class Store {
  constructor() { this.db = null; this.mem = new Map(); }

  async open() {
    if (!('indexedDB' in self)) return this;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB unavailable, sessions kept in memory only', e);
      this.db = null;
    }
    try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
    return this;
  }

  tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(STORE, mode);
      const st = t.objectStore(STORE);
      let out;
      const r = fn(st);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async put(sess) {
    const copy = JSON.parse(JSON.stringify(sess));
    if (!this.db) { this.mem.set(copy.id, copy); return; }
    await this.tx('readwrite', (st) => st.put(copy));
  }

  async get(id) {
    if (!this.db) return this.mem.get(id) || null;
    return (await this.tx('readonly', (st) => st.get(id))) || null;
  }

  async all() {
    const list = this.db ? (await this.tx('readonly', (st) => st.getAll())) || [] : [...this.mem.values()];
    return list.sort((a, b) => (b.wall0 || 0) - (a.wall0 || 0));
  }

  async delete(id) {
    if (!this.db) { this.mem.delete(id); return; }
    await this.tx('readwrite', (st) => st.delete(id));
  }
}
