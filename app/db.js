/* db.js — IndexedDB แบบย่อ: kv, master, entries, events */
var DB = (function () {
  'use strict';
  var NAME = 'stockcount', VERSION = 1, db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('master')) d.createObjectStore('master', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('entries')) {
          var e = d.createObjectStore('entries', { keyPath: 'logId' });
          e.createIndex('project', 'projectId');
        }
        if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'id' });
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(stores, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode);
        var result;
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
        result = fn(t);
      });
    });
  }

  function reqP(r) {
    return new Promise(function (resolve, reject) { r.onsuccess = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; });
  }

  function get(key) {
    var out;
    return tx(['kv'], 'readonly', function (t) { t.objectStore('kv').get(key).onsuccess = function (e) { out = e.target.result; }; })
      .then(function () { return out; });
  }
  function set(key, val) { return tx(['kv'], 'readwrite', function (t) { t.objectStore('kv').put(val, key); }); }
  function del(key) { return tx(['kv'], 'readwrite', function (t) { t.objectStore('kv').delete(key); }); }

  function all(store, indexName, value) {
    var out;
    return tx([store], 'readonly', function (t) {
      var s = t.objectStore(store);
      var r = indexName ? s.index(indexName).getAll(value) : s.getAll();
      r.onsuccess = function () { out = r.result; };
    }).then(function () { return out || []; });
  }

  function putMany(store, items, clearFirst) {
    return tx([store], 'readwrite', function (t) {
      var s = t.objectStore(store);
      if (clearFirst) s.clear();
      items.forEach(function (it) { s.put(it); });
    });
  }

  function remove(store, keys) {
    return tx([store], 'readwrite', function (t) { var s = t.objectStore(store); keys.forEach(function (k) { s.delete(k); }); });
  }

  /**
   * บันทึกรายการใหม่แบบ atomic: เลข Seq เพิ่มขึ้นและรายการถูกเขียนในธุรกรรมเดียว
   * build(seq) คืน object รายการ (ต้องมี logId)
   */
  function addEntry(build) {
    var entry;
    return tx(['kv', 'entries'], 'readwrite', function (t) {
      var kv = t.objectStore('kv');
      kv.get('seq').onsuccess = function (e) {
        var seq = (e.target.result || 0) + 1;
        entry = build(seq);
        kv.put(seq, 'seq');
        t.objectStore('entries').add(entry);
      };
    }).then(function () { return entry; });
  }

  function persistent() {
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
    return navigator.storage.persisted().then(function (p) { return p || navigator.storage.persist(); });
  }

  return { open: open, get: get, set: set, del: del, all: all, putMany: putMany, remove: remove, addEntry: addEntry, persistent: persistent, reqP: reqP };
})();
