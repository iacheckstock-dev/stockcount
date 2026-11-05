/**
 * จำลอง Apps Script แบบย่อ เพื่อรัน Code.gs ทั้ง flow บน Node (ไม่ต้องมีบัญชี Google)
 * node tests/gas-mock.js  (ต้องตั้ง SAMPLE_SAP / SAMPLE_POS)
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto'), assert = require('assert');

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
        setNumberFormat: () => rng, setFontWeight: () => rng, setBackground: () => rng
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
vm.createContext(ctx);
for (const f of ['Core.gs', 'Code.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });

const XLSX = require('xlsx');
const sapRows = ctx.Core.parseTsv(new TextDecoder('windows-874').decode(fs.readFileSync(process.env.SAMPLE_SAP)));
const wb = XLSX.readFile(process.env.SAMPLE_POS);
const posRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

const run = code => vm.runInContext(code, Object.assign(ctx, { _sap: sapRows, _pos: posRows }));
let s;
run('setupSheets()');
assert.ok(!sheets['ชีต1'], 'ลบชีตว่างเริ่มต้น');
assert.strictEqual(Object.keys(sheets).length, Object.keys(vm.runInContext("SHEETS", ctx)).length);
s = run('apiOpenRound("2026q4", "2026-11-04")');
assert.strictEqual(s.round.projectId, '2026Q4');
s = run('apiUpload("POS", _pos, { fileName: "Stock_Shop_POS.xls", fileDate: "2026-11-04" })');
assert.ok(s.master.hasPos && !s.master.hasSap);
assert.ok(s.master.canApprove, 'เช้าวันนับ อนุมัติจาก POS ได้');
const warnsMorning = s.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id);
console.log('เช้า (POS อย่างเดียว) คำเตือน:', warnsMorning.join(', '), '| บาร์โค้ด', s.master.deviceCount);
assert.throws(() => run(`apiApprove(${JSON.stringify(s.master.hash)}, [])`), /รับทราบ/);
s = run(`apiApprove(${JSON.stringify(s.master.hash)}, ${JSON.stringify(warnsMorning)})`);
assert.ok(s.master.approved.current);
assert.strictEqual(sheets.Device_Master.data.length - 1, s.master.deviceCount);
assert.throws(() => run('apiUpload("SAP", _sap, { fileName: "ZMMD002A.xls", fileDate: "2026-11-04" })'), /D−1/);
s = run('apiUpload("SAP", _sap, { fileName: "ZMMD002A.xls", fileDate: "2026-11-04", d1Confirmed: true })');
console.log('หลังอัปโหลด SAP: hash', s.master.hash, 'อนุมัติแล้วยังตรง?', s.master.approved.current, '| สถานะ', JSON.stringify(s.master.counts));
assert.strictEqual(s.master.newWarnings.map(c => c.id).join(','), 'POS_FILL', 'คำเตือนใหม่หลังอัปโหลด SAP');
if (process.env.DUMP_AFTER_SAP) fs.writeFileSync(process.env.DUMP_AFTER_SAP, JSON.stringify({ state: s, compare: [] }));
s = run('apiAckWarnings(["POS_FILL"])');
assert.strictEqual(s.master.newWarnings.length, 0);
assert.ok(s.master.approved.current);
// snapshot อ่านกลับแล้วยังได้ผลเดิม (บาร์โค้ดไม่เพี้ยน)
assert.strictEqual(s.master.stats.matched, 703);
assert.strictEqual(s.master.stats.posFilled, 4);
const bm = sheets.Barcode_Map.data;
assert.ok(bm.slice(1).every(r => r[0] === '' || /^\d+$/.test(r[0])), 'บาร์โค้ดเป็นตัวเลขล้วนเป็นข้อความ');
const cmp = run('apiGetCompare()');
assert.strictEqual(cmp.length, 2330);
assert.ok(sheets.Admin_Log.data.length >= 5);
console.log('Admin_Log:'); sheets.Admin_Log.data.slice(1).forEach(r => console.log('  ' + r.slice(2).join(' | ')));
console.log('ไฟล์ที่เก็บใน Drive:', ctx._files.join(', '));
// ล้างรอบแล้วเริ่มใหม่
run('resetRound_()');
s = run('apiGetState()');
assert.ok(!s.master.hasPos && !s.master.hasSap && !s.round.projectId && s.round.status === 'NONE');
assert.ok(!s.master.approved.hash);
assert.ok(!s.master.canApprove, 'ยังไม่เปิดรอบ อนุมัติไม่ได้');
if (process.env.DUMP_EMPTY) fs.writeFileSync(process.env.DUMP_EMPTY, JSON.stringify({ state: s, compare: [] }));
assert.strictEqual(sheets.Barcode_Map.data.length, 1);
assert.ok(sheets.Admin_Log.data.some(r => r[2] === 'RESET_ROUND'));
s = run('apiOpenRound("2026Q4", "2026-11-04")');
s = run('apiUpload("POS", _pos, { fileName: "Stock_Shop_POS.xls", fileDate: "2026-11-04" })');
assert.strictEqual(s.master.deviceCount, 2318);
run('setConfig_({ ROUND_STATUS: "COUNTING" })');
assert.throws(() => run('resetRound_()'), /เริ่มนับแล้ว/);
console.log('ล้างรอบ: ผ่าน (และกันการล้างหลังเริ่มนับ)');
console.log('\nจำลอง Apps Script ผ่านครบ flow');
if (process.env.DUMP) {
  // ใส่ขัดแย้งตัวอย่างหนึ่งรายการเพื่อดูหน้าจอ
  fs.writeFileSync(process.env.DUMP, JSON.stringify({ state: s, compare: cmp }));
}
