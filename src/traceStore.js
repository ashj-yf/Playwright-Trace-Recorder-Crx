/**
 * IndexedDB-backed storage for recordings and finished traces.
 *
 * Everything bulky produced while recording — screenshots, network response
 * bodies, stylesheets, DOM snapshots — AND the lightweight event/request
 * metadata is written here immediately and kept out of the service worker's
 * heap. Only small counters stay in memory.
 *
 * Layout (v2):
 *  - resources:  `${session}|${name}` -> ArrayBuffer, content-addressed (sha1)
 *  - snapshots:  autoincrement {id, session, json}
 *  - events:     autoincrement {id, session, data}, append-only action/console log
 *  - requests:   `${session}|${rid}` -> tracked network request object
 *  - sessions:   keyPath session -> sessionInfo (also the crash-recovery marker)
 *  - traces:     keyPath id -> finished archive {…, data: ArrayBuffer}
 *
 * Resources and archives are stored as ArrayBuffers, NOT Blobs. A Blob read out
 * of IndexedDB inside an MV3 service worker is backed by a lazy internal blob:
 * URL; after the worker is terminated and restarted, that handle points at the
 * dead instance's blob registry and every read rejects with TypeError "network
 * error". Structured-cloned ArrayBuffers carry their bytes inline and survive
 * worker restarts.
 *
 * Resources are content-addressed (sha1), so identical payloads captured many
 * times over a long recording are stored exactly once.
 */

const DB_NAME = 'ptr-trace-store';
const DB_VERSION = 2;

const STORE_RESOURCES = 'resources';
const STORE_SNAPSHOTS = 'snapshots';
const STORE_EVENTS = 'events';
const STORE_REQUESTS = 'requests';
const STORE_SESSIONS = 'sessions';
const STORE_TRACES = 'traces';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_RESOURCES)) {
        // Keys are `${session}|${name}` so a whole session can be dropped with
        // a single key-range delete.
        db.createObjectStore(STORE_RESOURCES);
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id', autoIncrement: true })
          .createIndex('session', 'session');
      }
      if (!db.objectStoreNames.contains(STORE_TRACES)) {
        db.createObjectStore(STORE_TRACES, { keyPath: 'id' });
      }
      // v2: the event/request log moved out of the worker heap.
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        db.createObjectStore(STORE_EVENTS, { keyPath: 'id', autoIncrement: true })
          .createIndex('session', 'session');
      }
      if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
        db.createObjectStore(STORE_REQUESTS).createIndex('session', 'session');
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'session' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function runRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    Promise.resolve(fn(tx.objectStore(storeName), tx))
      .then(value => { result = value; })
      .catch(err => { try { tx.abort(); } catch (_) {} reject(err); });
  });
}

/**
 * Async-iterate the values of a session index in batches.
 *
 * Each batch is one short-lived transaction: an IndexedDB cursor transaction
 * auto-commits the moment no request is pending and control returns to the
 * event loop, so a generator that yields across slow consumer work (e.g. zip
 * compression) cannot hold a single cursor open. `skip` re-positions each new
 * transaction at the first unread row.
 */
async function* readIndexBatched(storeName, session, batchSize = 250, mapFn = v => v) {
  let skip = 0;
  for (;;) {
    const batch = [];
    let exhausted = false;
    const advance = skip;
    await withStore(storeName, 'readonly', (store) => new Promise((resolve, reject) => {
      const index = store.index('session');
      const request = index.openCursor(IDBKeyRange.only(session));
      let positioned = advance === 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          exhausted = true;
          resolve();
          return;
        }
        if (!positioned) {
          positioned = true;
          cursor.advance(advance);
          return;
        }
        batch.push(cursor.value);
        if (batch.length >= batchSize) {
          resolve();
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    }));
    if (batch.length === 0) return;
    for (const value of batch) yield mapFn(value);
    skip += batch.length;
    if (exhausted || batch.length < batchSize) return;
  }
}

// ── Content addressing ────────────────────────────────────────────────────────

export async function sha1Hex(bytes) {
  const source = bytes instanceof Uint8Array
    ? (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer)
    : bytes;
  const digest = await crypto.subtle.digest('SHA-1', source);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Resources (screenshots, network bodies, stylesheets, post data) ───────────

function resourceKey(session, name) {
  return `${session}|${name}`;
}

/**
 * Store a resource unless an identical one is already present.
 * Returns true when newly written, false when it was a duplicate.
 * The bytes are stored inline (TypedArray structured clone), which survives
 * service-worker restarts — unlike an IndexedDB Blob's lazy internal handle.
 */
export async function putResource(session, name, bytes) {
  const key = resourceKey(session, name);
  // Store a standalone buffer so the value never shares a larger ArrayBuffer.
  const value = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
  return withStore(STORE_RESOURCES, 'readwrite', async (store) => {
    const existing = await runRequest(store.getKey(key));
    if (existing !== undefined) return false;
    await runRequest(store.put(value, key));
    return true;
  });
}

export async function readResource(session, name) {
  return withStore(STORE_RESOURCES, 'readonly',
    store => runRequest(store.get(resourceKey(session, name))));
}

/** All resource names recorded for a session. */
export async function listResourceNames(session) {
  const prefix = `${session}|`;
  const range = IDBKeyRange.bound(prefix, `${session}|￿`);
  const names = [];
  await withStore(STORE_RESOURCES, 'readonly', async (store) => {
    const request = store.openKeyCursor(range);
    while (true) {
      const cursor = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!cursor) break;
      names.push(cursor.key.slice(prefix.length));
      cursor.continue();
    }
  });
  return names;
}

// ── DOM snapshots ─────────────────────────────────────────────────────────────

/**
 * Persist a DOM snapshot as its raw JSON string. Keeping it serialized avoids
 * the 5-10x heap blowup of a parsed node tree; generation parses one at a time.
 */
export async function putSnapshot(session, json) {
  return withStore(STORE_SNAPSHOTS, 'readwrite',
    store => runRequest(store.add({ session, json })));
}

export async function readSnapshot(id) {
  const record = await withStore(STORE_SNAPSHOTS, 'readonly',
    store => runRequest(store.get(id)));
  return record ? record.json : null;
}

// ── Event log (actions + console), append-only ────────────────────────────────

export async function putEvent(session, data) {
  return withStore(STORE_EVENTS, 'readwrite',
    store => runRequest(store.add({ session, data })));
}

export async function countEvents(session) {
  return withStore(STORE_EVENTS, 'readonly',
    store => runRequest(store.index('session').count(IDBKeyRange.only(session))));
}

/** Events in emission order (the index cursor is ordered by primary key). */
export async function* readEvents(session) {
  yield* readIndexBatched(STORE_EVENTS, session, 250, record => record.data);
}

// ── Tracked network requests ──────────────────────────────────────────────────

function requestKey(session, rid) {
  return `${session}|${rid}`;
}

export async function putRequest(session, rid, request) {
  return withStore(STORE_REQUESTS, 'readwrite',
    // Tag the value so the 'session' index can resolve it.
    store => runRequest(store.put({ ...request, session }, requestKey(session, rid))));
}

export async function readRequest(session, rid) {
  return withStore(STORE_REQUESTS, 'readonly',
    store => runRequest(store.get(requestKey(session, rid))));
}

export async function countRequests(session) {
  return withStore(STORE_REQUESTS, 'readonly',
    store => runRequest(store.index('session').count(IDBKeyRange.only(session))));
}

export async function* readRequests(session) {
  yield* readIndexBatched(STORE_REQUESTS, session);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

export async function putSession(info) {
  return withStore(STORE_SESSIONS, 'readwrite',
    store => runRequest(store.put(info)));
}

export async function getSession(session) {
  return withStore(STORE_SESSIONS, 'readonly',
    store => runRequest(store.get(session)));
}

export async function listSessions() {
  return withStore(STORE_SESSIONS, 'readonly',
    store => runRequest(store.getAll()));
}

/**
 * Delete everything stored for one session: resources by key range, plus
 * index-cursor deletes for the autoincrement stores.
 */
export async function clearSession(session) {
  const resourceRange = IDBKeyRange.bound(`${session}|`, `${session}|￿`);
  await withStore(STORE_RESOURCES, 'readwrite',
    store => runRequest(store.delete(resourceRange)));
  await withStore(STORE_REQUESTS, 'readwrite',
    store => runRequest(store.delete(resourceRange)));

  for (const storeName of [STORE_SNAPSHOTS, STORE_EVENTS]) {
    await withStore(storeName, 'readwrite', (store) => {
      const index = store.index('session');
      return new Promise((resolve, reject) => {
        const cursorRequest = index.openKeyCursor(IDBKeyRange.only(session));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return resolve();
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      });
    });
  }

  await withStore(STORE_SESSIONS, 'readwrite',
    store => runRequest(store.delete(session)));
}

/**
 * Remove rows belonging to sessions that have no session record (a worker killed
 * before v2, or an aborted cleanup). `keepSession` is the live recording.
 */
export async function sweepOrphanSessions(keepSession) {
  const db = await openDb();
  const live = new Set(await withStore(STORE_SESSIONS, 'readonly',
    store => runRequest(store.getAllKeys())));

  const seen = new Set();
  const collectPrefixes = async (storeName) => {
    await withStore(storeName, 'readonly', async (store) => {
      const request = store.openKeyCursor();
      while (true) {
        const cursor = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!cursor) break;
        const key = String(cursor.key);
        const bar = key.indexOf('|');
        if (bar >= 0) seen.add(key.slice(0, bar));
        cursor.continue();
      }
    });
  };
  const collectIndexSessions = async (storeName) => {
    await withStore(storeName, 'readonly', async (store) => {
      const request = store.index('session').openKeyCursor();
      while (true) {
        const cursor = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!cursor) break;
        seen.add(cursor.key);
        cursor.continue();
      }
    });
  };

  await collectPrefixes(STORE_RESOURCES);
  await collectPrefixes(STORE_REQUESTS);
  await collectIndexSessions(STORE_SNAPSHOTS);
  await collectIndexSessions(STORE_EVENTS);

  for (const session of seen) {
    if (!live.has(session) && session !== keepSession) await clearSession(session);
  }
}

// ── Finished traces ───────────────────────────────────────────────────────────

export async function putTrace(record) {
  await withStore(STORE_TRACES, 'readwrite',
    store => runRequest(store.put(record)));
}

export async function getTrace(id) {
  return withStore(STORE_TRACES, 'readonly',
    store => runRequest(store.get(id)));
}

export async function deleteTrace(id) {
  return withStore(STORE_TRACES, 'readwrite',
    store => runRequest(store.delete(id)));
}

export async function listTraceIds() {
  const keys = await withStore(STORE_TRACES, 'readonly',
    store => runRequest(store.getAllKeys()));
  return keys || [];
}
