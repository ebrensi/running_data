export class Store {
  constructor(dbName, storeName, keyPath) {
    this.storeName = storeName
    this._dbp = this._initialize(dbName, storeName, keyPath)
  }

  _initialize(dbName, storeName, keyPath, version) {
    return new Promise((resolve, reject) => {
      let openreq = indexedDB.open(dbName, version),
        db
      const self = this

      openreq.onerror = onerror
      openreq.onupgradeneeded = onupgradeneeded
      openreq.onsuccess = onsuccess

      function onupgradeneeded(e) {
        // console.log(`"${dbName}" onupgradeneeded: adding "${storeName}"`, e);
        db = e.target.result
        if (keyPath === undefined) db.createObjectStore(storeName)
        else db.createObjectStore(storeName, { keyPath: keyPath })
      }

      function onerror(event) {
        console.log(`"${dbName}" error`, event.target.error)
        reject(event)
      }

      function onsuccess(event) {
        // console.log(`"${dbName}" success`, event)
        db = event.target.result

        db.onversionchange = onversionchange

        if (db.objectStoreNames.contains(storeName)) resolve(db)
        else {
          // console.log(`"${storeName}" not in "${dbName}". attempting upgrade...`)
          upgrade()
        }
      }

      function onversionchange() {
        // console.log(`"${dbName}" versionchange`);
        upgrade()
      }

      function upgrade() {
        const v = +db.version
        db.close()
        self._dbp = self._initialize(dbName, storeName, keyPath, v + 1)
        self._dbp.then((db) => resolve(db))
      }
    })
  }

  _withIDBStore(type, callback) {
    return this._dbp.then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(this.storeName, type)
          transaction.oncomplete = () => resolve()
          transaction.onabort = transaction.onerror = () =>
            reject(transaction.error)
          callback(transaction.objectStore(this.storeName))
        })
    )
  }

  close() {
    return this._dbp.then((db) => db.close())
  }
}


//// Old get function
// export function get(key, store) {
//   let req
//   return store
//     ._withIDBStore("readonly", (store) => {
//       req = store.get(key)
//     })
//     .then(() => {
//       return req.result
//     })
// }

const buffers = new Map
const counters = new Map

function doTransaction(store) {
  let getCount, putCount = 0
  const t0 = Date.now()
  return store
    ._withIDBStore("readonly", (objectStore) => {
      // We do one transaction involving {count} operations
      const queries = buffers.get(store)
      for (const [key, {op, value, resolve, reject}] of Object.entries(queries)) {
        if (op === "get") {
          const req = objectStore.get(key)
          req.onsuccess = (e) => resolve(e.target.result)
          req.onerror = (e)=> reject(e)
          getCount++
        } else {
          // We can assume the op is "put"
          objectStore.put(key, value)
          putCount++
        }
      }
      buffers.delete(store)
      counters.delete(store)
    })
    .then(() => console.log(`Got ${getCount}, Set ${putCount} tiles in ${Date.now()-t0}ms`))
}


export function get(key, store) {
  return new Promise((resolve, reject) => {
    if (!buffers.has(store)) {
      buffers.set(store, {})
      counters.set(store, {count: 0})
    }
    const op = "get"
    const buf = buffers.get(store)
    buf[key] = {op, resolve, reject}
    const myNum = counters.get(store).count++
    setTimeout(() => {
      // if no more get queries have been added to the buffer for 100ms,
      // go ahead and do the batch indexedDB query
      if (counters.get(store).count === myNum + 1) {
        doTransaction(store)
      }
    }, 30)
  })
}

export function newSet(key, value, store) {
  return new Promise((resolve, reject) => {
    if (!buffers.has(store)) {
      buffers.set(store, {})
      counters.set(store, {count: 0})
    }
    const op = "set"
    const buf = buffers.get(store)
    buf[key] = {op, value, resolve, reject}
    const myNum = counters.get(store).count++
    setTimeout(() => {
      // if no more get queries have been added to the buffer for 100ms,
      // go ahead and do the batch indexedDB query
      if (counters.get(store).count === myNum + 1) {
        doTransaction(store)
      }
    }, 30)
  })
}


export function set(key, value, store) {
  return store._withIDBStore("readwrite", (store) => {
    store.put(value, key)
  })
}

export function del(key, store) {
  return store._withIDBStore("readwrite", (store) => {
    store.delete(key)
  })
}

export function clear(store) {
  return store._withIDBStore("readwrite", (store) => {
    store.clear()
  })
}

export function keys(store) {
  const keys = []
  return store
    ._withIDBStore("readonly", (store) => {
      // This would be store.getAllKeys(), but it isn't supported by Edge or Safari.
      // And openKeyCursor isn't supported by Safari.
      ;(store.openKeyCursor || store.openCursor).call(
        store
      ).onsuccess = function () {
        if (!this.result) return
        keys.push(this.result.key)
        this.result.continue()
      }
    })
    .then(() => keys)
}
