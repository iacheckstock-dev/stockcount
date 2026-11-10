/**
 * ขั้น C (v2.3.0): วัดงานฝั่งเซิร์ฟเวอร์ต่อคำขอ ตอนข้อมูลเต็มรอบ (~11,000 แถว 4 เครื่อง 300 Location)
 * นับการเรียกชีต (อ่าน/เขียน/ถามขนาด) และจำนวนเซลล์ที่อ่าน แยก "ช่วงถือล็อก" ที่เครื่องอื่นต้องรอ
 * บน GAS จริง การเรียกชีตแต่ละครั้ง ~50–300 ms และอ่านเซลล์มากยิ่งช้า — ตัวเลขนี้จึงใช้เทียบก่อน/หลังแก้
 *
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/perf-test.js [--json] [--rows 11000]
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

const ROWS = Number((process.argv.find((a, i, all) => all[i - 1] === '--rows')) || 11000);
const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4", "2026-11-04")');
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
env.sheets.Staff.data.push(['EMP-K', 'นาย ก', 'ผู้ตรวจสอบ', 'Y'], ['EMP-C', 'นาย ค', 'ผู้ตรวจสอบ', 'Y']);
run('apiSeedDevices(6, "TC21")');

const ITEMS = [['8858684826179', 'A112101UT0450XK'], ['8858153867481', 'A112101UT0550XK']];
const DEVS = ['TC21-01', 'TC21-02', 'TC21-03', 'TC21-04'];

// ---- เติมข้อมูลรอบเต็มลง Count_Log โดยตรง (รูปแบบเดียวกับ ingest_) ----
const seqOf = {};
DEVS.forEach(d => { seqOf[d] = 0; });
const log = env.sheets.Count_Log.data;
for (let i = 0; i < ROWS; i++) {
  const dev = DEVS[i % DEVS.length], s = ++seqOf[dev];
  const loc = 'S' + (1 + Math.floor(i / (ROWS / 300)));
  const it = ITEMS[i % 2];
  log.push([dev + '-' + String(s).padStart(6, '0'), '2026Q4', dev, String(s), 'EMP-C', loc, it[0], it[1], '1', 'SCAN', '', '', '',
    '2026-11-04 09:00:00', '2026-11-04 09:00:01', 'SYNC', 'EMP-C', '', '']);
}
env.sheets.Count_Log.maxRows = log.length + 1000;

function device(id, staff) {
  const code = run(`apiPairCode(${JSON.stringify(id)})`).devices.find(x => x.id === id).pairCode;
  const token = env.post({ action: 'pair', deviceId: id, code }).token;
  const d = { id, staff, seq: seqOf[id] || 0, entries: [], at: 1 };
  d.call = (action, body) => env.post(Object.assign({ action, deviceId: id, token, appVersion: '2.3.0' }, body || {}));
  d.scan = (loc, n, extra) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      d.seq++;
      const it = ITEMS[d.seq % 2];
      const e = Object.assign({ logId: id + '-' + String(d.seq).padStart(6, '0'), seq: d.seq, projectId: '2026Q4', staff, location: loc, barcode: it[0],
        material: it[1], qty: 1, type: 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:00:00' }, extra || {});
      d.entries.push(e); out.push(e);
    }
    return out;
  };
  d.ev = (type, loc, extra) => {
    const mine = d.entries.filter(e => e.location === loc);
    const seqs = d.entries.map(e => e.seq);
    return Object.assign({ id: id + '-E' + (d.at), type, projectId: '2026Q4', location: loc, staff, time: '2026-11-04 10:00:00',
      lines: mine.length, qty: mine.reduce((a, e) => a + e.qty, 0),
      fromSeq: seqs.length ? Math.min(...seqs) : 0, upToSeq: seqs.length ? Math.max(...seqs) : 0, at: d.at++ }, extra || {});
  };
  d.sync = (entries, events) => { const r = d.call('sync', { entries: entries || [], events: events || [] }); assert.ok(r.ok, JSON.stringify(r)); return r; };
  return d;
}

const A = device('TC21-01', 'EMP-C'), B = device('TC21-02', 'EMP-K');
// อุ่นเครื่อง: ทั้งสองเครื่องอยู่ที่ E1 (A ผู้ดูแล, B ผู้ช่วย) — ย้ายข้อมูลรุ่นเก่า (migrate) ทำครั้งเดียวไปแล้ว
A.sync(A.scan('E1', 1), [A.ev('OPEN', 'E1')]);
B.sync(B.scan('E1', 1), [B.ev('JOIN', 'E1')]);

const results = [];
function measure(name, fn) {
  env.stats.reset();
  const t = Date.now();
  const r = fn();
  const L = env.stats.lock, all = env.stats.all;
  results.push({ name, lockReads: L.reads, lockCells: L.cells, lockWrites: L.writes, lockMeta: L.meta,
    reads: all.reads, cells: all.cells, writes: all.writes, meta: all.meta, ms: Date.now() - t, detail: L.sheets });
  return r;
}

measure('ยิง 15 รายการ (ระหว่างนับ)', () => A.sync(A.scan('E1', 15)));
measure('ยิง 50 รายการ (ส่งค้าง)', () => A.sync(A.scan('E1', 50)));
measure('เปลี่ยน Location: OPEN + 1 รายการ', () => A.sync(A.scan('E2', 1), [A.ev('OPEN', 'E2')]));
measure('ผู้ช่วยส่งงาน (SUBMIT)', () => B.sync(B.scan('E1', 2), [B.ev('SUBMIT', 'E1')]));
measure('ผู้ดูแลปิด (CLOSE)', () => A.sync([], [A.ev('CLOSE', 'E2', { total: 1 })]));
measure('แก้ยอด (RECOUNT_SET + EDIT)', () => {
  A.sync(A.scan('E3', 2), [A.ev('OPEN', 'E3')]);
  env.stats.reset();
  return A.sync(A.scan('E3', 1, { type: 'RECOUNT_SET', qty: -1, basis: 2, reason: 'test' }), [A.ev('EDIT', 'E3')]);
});
measure('ถามสถานะ Location (locInfo)', () => A.call('locInfo', { location: 'E1' }));
measure('hello', () => A.call('hello', { location: 'E1', pending: 0 }));

if (process.argv.includes('--json')) { console.log(JSON.stringify(results)); process.exit(0); }
console.log(`\nข้อมูล Count_Log ${env.sheets.Count_Log.data.length - 1} แถว · ช่วงถือล็อก = เครื่องอื่นต้องรอ\n`);
console.log('คำขอ'.padEnd(38) + 'ล็อก: อ่าน  เซลล์อ่าน  เขียน  ถามขนาด | ทั้งคำขอ: อ่าน  เซลล์อ่าน');
results.forEach(r => console.log(r.name.padEnd(38) + String(r.lockReads).padStart(9) + String(r.lockCells).padStart(11) + String(r.lockWrites).padStart(7) +
  String(r.lockMeta).padStart(9) + ' |' + String(r.reads).padStart(13) + String(r.cells).padStart(11)));
if (process.argv.includes('--detail')) results.forEach(r => console.log('\n' + r.name, r.detail));
module.exports = results;
