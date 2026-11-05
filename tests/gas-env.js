/** สภาพแวดล้อม Apps Script จำลองในหน่วยความจำ (ใช้ทั้ง gas-mock.js และ mock-server.js) */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

function createEnv() {
  function makeSheet(name) {
    const sh = {
      name, data: [], maxRows: 1000, maxCols: 26, prot: [],
      getName: () => name,
      getLastRow: () => sh.data.length,
      getLastColumn: () => sh.data.reduce((m, r) => Math.max(m, r.length), 0),
      getMaxRows: () => sh.maxRows, getMaxColumns: () => sh.maxCols,
      insertRowsAfter: (a, n) => { sh.maxRows += n; }, insertColumnsAfter: (a, n) => { sh.maxCols += n; },
      setFrozenRows: () => {}, clearContents: () => { sh.data = []; },
      appendRow: row => { sh.data.push(row.map(String)); },
      getProtections: () => sh.prot,
      protect: () => { const p = { setDescription: () => p, setWarningOnly: () => p }; sh.prot.push(p); return p; },
      getRange: (a, b, c, d) => {
        let r0, c0, nr, nc;
        if (typeof a === 'string') { r0 = 1; c0 = 2; nr = sh.maxRows; nc = 1; } else { r0 = a; c0 = b; nr = c || 1; nc = d || 1; }
        const rng = {
          setValues: vals => {
            if (vals.length !== nr || vals[0].length !== nc) throw new Error(`setValues size ${vals.length}x${vals[0].length} != ${nr}x${nc} on ${name}`);
            if (r0 + nr - 1 > sh.maxRows) throw new Error('beyond max rows on ' + name);
            vals.forEach((row, i) => {
              const ri = r0 - 1 + i; while (sh.data.length <= ri) sh.data.push([]);
              row.forEach((v, j) => { sh.data[ri][c0 - 1 + j] = v === null || v === undefined ? '' : String(v); });
            });
            return rng;
          },
          setValue: v => rng.setValues([[v]]),
          getValues: () => rng.getDisplayValues(),
          getDisplayValues: () => {
            const out = [];
            for (let i = 0; i < nr; i++) { const row = sh.data[r0 - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => row[c0 - 1 + j] === undefined ? '' : row[c0 - 1 + j])); }
            return out;
          },
          setNumberFormat: () => rng, setFontWeight: () => rng, setBackground: () => rng, clearContent: () => rng
        };
        return rng;
      }
    };
    return sh;
  }

  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: s => { delete sheets[s.name]; },
    getName: () => 'TEST', getUrl: () => 'https://example/sheet'
  };
  sheets['ชีต1'] = makeSheet('ชีต1');

  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ss, getUi: () => { throw new Error('no ui'); }, ProtectionType: { SHEET: 'SHEET' } },
    Session: { getActiveUser: () => ({ getEmail: () => 'admin@test' }), getEffectiveUser: () => ({ getEmail: () => 'admin@test' }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      formatDate: (d) => d.toISOString().replace('T', ' ').slice(0, 19),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }
    },
    DriveApp: {
      createFolder: () => ({ getId: () => 'FOLDER1' }),
      getFolderById: () => ({ createFile: (n, c) => { ctx._files.push(n); } })
    },
    MimeType: { CSV: 'text/csv' }, HtmlService: {}, _files: []
  };

  ctx.ContentService = { createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }), MimeType: { JSON: 'json' } };
  ctx.ScriptApp = { getService: () => ({ getUrl: () => 'http://localhost/api' }) };
  ctx.Utilities.getUuid = () => crypto.randomUUID();
  ctx.LockService.getScriptLock = ctx.LockService.getDocumentLock;
  vm.createContext(ctx);
  for (const f of ['Core.gs', 'Code.gs', 'Api.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
  const run = (code, vars) => vm.runInContext(code, Object.assign(ctx, vars || {}));
  const post = body => JSON.parse(run('doPost(_req).getContent()', { _req: { postData: { contents: JSON.stringify(body) } } }));
  return { ctx, sheets, run, post };
}

function loadSamples(Core) {
  const XLSX = require('xlsx');
  const sap = Core.parseTsv(new TextDecoder('windows-874').decode(fs.readFileSync(process.env.SAMPLE_SAP)));
  const wb = XLSX.readFile(process.env.SAMPLE_POS);
  const pos = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  return { sap, pos };
}

module.exports = { createEnv, loadSamples };
