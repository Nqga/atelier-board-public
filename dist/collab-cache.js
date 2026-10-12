const DATABASE = 'atelier-board:collaboration:v2';
const STORE = 'documents';

/** Per-guest recovery drafts. IndexedDB handles boards larger than localStorage. */
export class IndexedDBCollaborationCache {
  constructor({ indexedDB = globalThis.indexedDB, database = DATABASE } = {}) { this.indexedDB = indexedDB; this.database = database; this.connection = null; }
  async _open() {
    if (!this.indexedDB) return null;
    if (!this.connection) this.connection = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { this.connection = null; reject(request.error); };
      request.onblocked = () => { this.connection = null; reject(new Error('Cache de récupération indisponible.')); };
    });
    return this.connection;
  }
  async get(key) {
    const database = await this._open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async list(prefix) {
    const database = await this._open();
    if (!database) return [];
    return new Promise((resolve, reject) => {
      const values = [];
      const transaction = database.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) values.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(values);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Lecture du cache interrompue.'));
    });
  }
  async set(key, value) {
    const database = await this._open();
    if (!database) return false;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Sauvegarde locale interrompue.'));
    });
  }
  async deleteIfUnchanged(key, expected) {
    const database = await this._open();
    if (!database) return false;
    return new Promise((resolve, reject) => {
      let removed = false;
      const transaction = database.transaction(STORE, 'readwrite');
      const documents = transaction.objectStore(STORE);
      const request = documents.get(key);
      request.onsuccess = () => {
        const current = request.result;
        if (current && current.state === expected.state && current.hasPending === expected.hasPending && current.rejected === expected.rejected) { documents.delete(key); removed = true; }
      };
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Nettoyage du cache interrompu.'));
    });
  }
  async delete(key) {
    const database = await this._open();
    if (!database) return false;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    });
  }
}
