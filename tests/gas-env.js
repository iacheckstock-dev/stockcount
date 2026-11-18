/** สภาพแวดล้อม Apps Script จำลองในหน่วยความจำ (ใช้ทั้ง gas-mock.js และ mock-server.js) */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

function createEnv() {
  const lockTrace = [];
  // นับการเรียกชีต (ขั้น C): บน GAS จริงแต่ละครั้งใช้ ~50–300 ms และอ่านมากเซลล์ยิ่งช้า — แยกนับช่วงถือล็อก
  const stats = { inLock: false, all: { reads: 0, cells: 0, writes: 0, meta: 0 }, lock: { reads: 0, cells: 0, writes: 0, meta: 0, sheets: {} } };
  function tally(kind, name, cells) {
    const b = [stats.all]; if (stats.inLock) b.push(stats.lock);
    b.forEach(x => { x[kind]++; if (cells) x.cells += cells; });
    if (stats.inLock) { const k = kind + ':' + name; stats.lock.sheets[k] = (stats.lock.sheets[k] || 0) + 1; }
  }
  stats.reset = () => { ['all', 'lock'].forEach(k => { stats[k] = { reads: 0, cells: 0, writes: 0, meta: 0, sheets: {} }; }); };
  function makeSheet(name) {
    const sh = {
      name, data: [], maxRows: 1000, maxCols: 26, prot: [],
      getName: () => name,
      getLastRow: () => { tally('meta', name); let n = sh.data.length; while (n && !sh.data[n - 1].some(v => v !== '' && v !== undefined)) n--; return n; },
      getLastColumn: () => { tally('meta', name); return sh.data.reduce((m, r) => Math.max(m, r.length), 0); },
      getMaxRows: () => { tally('meta', name); return sh.maxRows; }, getMaxColumns: () => sh.maxCols,
      insertRowsAfter: (a, n) => { sh.maxRows += n; }, insertColumnsAfter: (a, n) => { sh.maxCols += n; },
      setFrozenRows: () => {}, clearContents: () => { sh.data = []; },
      deleteRow: r => { tally('writes', name); sh.data.splice(r - 1, 1); sh.maxRows--; },
      // dropWrites: จำลองชีตที่เขียนแล้วไม่ติด (UAT 12 พ.ย.: Admin_Log มี filter อยู่ appendRow เงียบหาย)
      appendRow: row => { tally('writes', name); if (!sh.dropWrites) sh.data.push(row.map(String)); },
      getProtections: () => sh.prot,
      getDataRange: () => sh.getRange(1, 1, Math.max(1, sh.getLastRow()), Math.max(1, sh.getLastColumn())),
      protect: () => { const p = { setDescription: () => p, setWarningOnly: () => p }; sh.prot.push(p); return p; },
      getRange: (a, b, c, d) => {
        let r0, c0, nr, nc;
        if (typeof a === 'string') { r0 = 1; c0 = 2; nr = sh.maxRows; nc = 1; } else { r0 = a; c0 = b; nr = c || 1; nc = d || 1; }
        const rng = {
          setValues: vals => {
            tally('writes', name);
            if (vals.length !== nr || vals[0].length !== nc) throw new Error(`setValues size ${vals.length}x${vals[0].length} != ${nr}x${nc} on ${name}`);
            if (r0 + nr - 1 > sh.maxRows) throw new Error('beyond max rows on ' + name);
            if (sh.dropWrites) return rng;
            vals.forEach((row, i) => {
              const ri = r0 - 1 + i; while (sh.data.length <= ri) sh.data.push([]);
              row.forEach((v, j) => { sh.data[ri][c0 - 1 + j] = v === null || v === undefined ? '' : String(v); });
            });
            return rng;
          },
          setValue: v => rng.setValues([[v]]),
          getValues: () => rng.getDisplayValues(),
          getDisplayValues: () => {
            tally('reads', name, nr * nc);
            const out = [];
            for (let i = 0; i < nr; i++) { const row = sh.data[r0 - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => row[c0 - 1 + j] === undefined ? '' : row[c0 - 1 + j])); }
            return out;
          },
          setNumberFormat: () => rng, setFontWeight: () => rng, setBackground: () => rng,
          clearContent: () => {
            tally('writes', name);
            for (let i = 0; i < nr; i++) { const row = sh.data[r0 - 1 + i]; if (row) for (let j = 0; j < nc; j++) if (c0 - 1 + j < row.length) row[c0 - 1 + j] = ''; }
            while (sh.data.length && !sh.data[sh.data.length - 1].some(v => v !== '' && v !== undefined)) sh.data.pop();
            return rng;
          }
        };
        return rng;
      }
    };
    return sh;
  }

  // ไฟล์ Sheets จำลอง (v2.5.2: สำเนาไฟล์ตอนปิดรอบ — makeCopy / openById)
  const books = {};
  function makeBook(id, name, sheets) {
    const b = {
      sheets, id, name,
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = makeSheet(n)),
      getSheets: () => Object.values(sheets),
      deleteSheet: s => { delete sheets[s.name]; },
      getName: () => b.name, getId: () => id, getUrl: () => 'https://example/sheet/' + id
    };
    books[id] = b;
    return b;
  }
  const sheets = {};
  const ss = makeBook('SS1', 'TEST', sheets);
  sheets['ชีต1'] = makeSheet('ชีต1');
  const folders = {};
  const folder = (id, name) => folders[id] || (folders[id] = {
    id, name, files: [], getId: () => id,
    createFile: (n, c) => { ctx._files.push(n); },
    getFoldersByName: n => { const f = Object.values(folders).filter(x => x.parent === id && x.name === n); let i = 0; return { hasNext: () => i < f.length, next: () => f[i++] }; },
    createFolder: n => { const f = folder(id + '/' + n, n); f.parent = id; return f; }
  });
  const driveFile = id => ({
    getId: () => id, getUrl: () => 'https://example/sheet/' + id, getName: () => books[id].name, setName: n => { books[id].name = n; },
    makeCopy: (name, fold) => {
      if (copyCfg.fail) throw new Error(copyCfg.fail);
      const nid = 'COPY' + (Object.keys(books).length);
      const sh2 = {};
      Object.values(books[id].sheets).forEach(x => {
        const c = makeSheet(x.name); c.data = x.data.map(r => r.slice()); c.maxRows = x.maxRows; c.maxCols = x.maxCols; c.prot = x.prot.slice(); sh2[x.name] = c;
      });
      makeBook(nid, name, sh2);
      if (copyCfg.tamper) copyCfg.tamper(books[nid]);
      (fold.files = fold.files || []).push(nid);
      return driveFile(nid);
    }
  });
  const copyCfg = {};

  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ss, openById: id => { if (!books[id]) throw new Error('not found ' + id); return books[id]; }, getUi: () => { throw new Error('no ui'); }, ProtectionType: { SHEET: 'SHEET' }, flush: () => { lockTrace.push('flush'); tally('writes', 'flush'); } },
    Session: { getActiveUser: () => ({ getEmail: () => 'admin@test' }), getEffectiveUser: () => ({ getEmail: () => 'admin@test' }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => { lockTrace.push('lock'); stats.inLock = true; return true; }, releaseLock: () => { lockTrace.push('release'); stats.inLock = false; } }) },
    Utilities: {
      formatDate: (d) => d.toISOString().replace('T', ' ').slice(0, 19),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }
    },
    DriveApp: {
      createFolder: () => folder('FOLDER1', 'TEST_Files'),
      getFolderById: id => folder(id, id),
      getFileById: id => { if (!books[id]) throw new Error('no file ' + id); return driveFile(id); }
    },
    MimeType: { CSV: 'text/csv' }, HtmlService: {}, _files: []
  };

  ctx.ContentService = { createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }), MimeType: { JSON: 'json' } };
  ctx.ScriptApp = { getService: () => ({ getUrl: () => 'http://localhost/api' }) };
  ctx.Utilities.getUuid = () => crypto.randomUUID();
  ctx.LockService.getScriptLock = ctx.LockService.getDocumentLock;
  const cacheStore = {};
  const LIM = 100 * 1024;   // CacheService จริง: ค่าละไม่เกิน 100KB
  const chk = (k, v) => { if (String(v).length > LIM) throw new Error('Argument too large: ' + k); };
  // stale: จำลอง CacheService ที่คืนค่ารุ่นก่อนหน้าได้ (แต่ละคีย์อิสระ) — ใช้ใน tests/index-test.js
  const hist = {}, cacheCfg = { stale: 0, rnd: Math.random };
  const keep = (k, v) => { cacheStore[k] = String(v); (hist[k] = hist[k] || []).push(String(v)); if (hist[k].length > 3) hist[k].shift(); };
  const read = k => {
    if (!(k in cacheStore)) return null;
    if (cacheCfg.stale && hist[k] && hist[k].length > 1 && cacheCfg.rnd() < cacheCfg.stale) return hist[k][Math.floor(cacheCfg.rnd() * (hist[k].length - 1))];
    return cacheStore[k];
  };
  const cache = { put: (k, v) => { chk(k, v); keep(k, v); }, putAll: o => { Object.keys(o).forEach(k => chk(k, o[k])); Object.keys(o).forEach(k => keep(k, o[k])); },
    get: k => read(k), remove: k => { delete cacheStore[k]; delete hist[k]; },
    getAll: ks => { const o = {}; ks.forEach(k => { const v = read(k); if (v !== null) o[k] = v; }); return o; } };
  ctx.CacheService = { getScriptCache: () => cache };
  const props = {};
  ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) };
  vm.createContext(ctx);
  for (const f of ['Core.gs', 'Code.gs', 'Api.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
  const run = (code, vars) => vm.runInContext(code, Object.assign(ctx, vars || {}));
  const post = body => JSON.parse(run('doPost(_req).getContent()', { _req: { postData: { contents: JSON.stringify(body) } } }));
  return { ctx, sheets, run, post, lockTrace, stats, cacheCfg, books, copyCfg, folders };
}

function loadSamples(Core) {
  const XLSX = require('xlsx');
  const sap = Core.parseTsv(new TextDecoder('windows-874').decode(fs.readFileSync(process.env.SAMPLE_SAP)));
  const wb = XLSX.readFile(process.env.SAMPLE_POS);
  const pos = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  return { sap, pos };
}

module.exports = { createEnv, loadSamples };
