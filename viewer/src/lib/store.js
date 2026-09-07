// Document storage in IndexedDB (book §12.4.5).
//
// Documents are structured records with ids, so IndexedDB — not localStorage
// and not Cache Storage — is the right fit. FileSystemFileHandle objects are
// structured-cloneable, so a document that was opened from disk remembers its
// handle and can be written back later after a permission check.

const DB_NAME = 'xor';
const DB_VERSION = 1;
const STORE = 'documents';

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = (event) => {
    const db = request.result;
    if (event.oldVersion < 1) {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
      store.createIndex('name', 'name');
    }
  };
  request.onblocked = () => console.warn('Another tab blocks the IndexedDB upgrade.');
  dbPromise = requestToPromise(request);
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDatabase();
  const tx = db.transaction(STORE, mode);
  const result = await fn(tx.objectStore(STORE));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

export function newId() {
  return crypto.randomUUID();
}

/** @returns {Promise<Document[]>} newest first */
export async function listDocuments() {
  const all = await withStore('readonly', (store) => requestToPromise(store.getAll()));
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getDocument(id) {
  return withStore('readonly', (store) => requestToPromise(store.get(id)));
}

export function putDocument(doc) {
  return withStore('readwrite', (store) => requestToPromise(store.put(doc)));
}

export function deleteDocument(id) {
  return withStore('readwrite', (store) => requestToPromise(store.delete(id)));
}

export function createDocument({ name = 'Untitled.md', content = '', handle = null, remote = null, mtime = null } = {}) {
  const now = Date.now();
  // handle: File System Access handle · remote: URL served by a local server ·
  // mtime: the file's modification time when last read, so a save can detect
  // that someone else (an agent, another editor) wrote it since.
  return { id: newId(), name, content, handle, remote, mtime, createdAt: now, updatedAt: now };
}

/** Ask the browser not to evict our data under storage pressure (book §12.4.3). */
export async function requestPersistence() {
  if (navigator.storage?.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
