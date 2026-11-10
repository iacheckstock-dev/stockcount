/**
 * ดัชนี Count_Log (v2.3.0) ต้องให้ผลเท่ากับอ่านทั้งชีตเสมอ
 * - หลังส่งข้อมูลปกติ / cache หาย / มีแถวเพิ่มจากทางอื่น (นำเข้าไฟล์) / รอบเปลี่ยน / Location หายจาก cache บางตัว
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/index-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n    ')); }
}

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4", "2026-11-04")');
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
run('apiSeedDevices(3, "TC21")');
const ITEMS = [['8858684826179', 'A112101UT0450XK'], ['8858153867481', 'A112101UT0550XK']];

function device(id) {
  const code = run(`apiPairCode(${JSON.stringify(id)})`).devices.find(x => x.id === id).pairCode;
  const token = env.post({ action: 'pair', deviceId: id, code }).token;
  const d = { id, seq: 0 };
  d.call = (action, body) => env.post(Object.assign({ action, deviceId: id, token, appVersion: '2.3.0' }, body || {}));
  d.batch = (loc, n, qty, extra) => Array.from({ length: n }, () => {
    d.seq++; const it = ITEMS[d.seq % 2];
    return Object.assign({ logId: id + '-' + String(d.seq).padStart(6, '0'), seq: d.seq, projectId: '2026Q4', staff: 'EMP-1', location: loc,
      barcode: it[0], material: it[1], qty: qty === undefined ? 1 : qty, type: 'SCAN', scanTime: '2026-11-04 10:' + String(d.seq % 60).padStart(2, '0') + ':00' }, extra || {});
  });
  d.sync = entries => { const r = d.call('sync', { entries, events: [] }); assert.ok(r.ok, JSON.stringify(r)); return r; };
  return d;
}

/** เทียบดัชนีกับการอ่านทั้งชีต (ทุก Location ทุกเครื่อง) */
function same(label) {
  const r = run(`(function () {
    var cfg = readConfig_(), p = cfg.PROJECT_ID;
    var full = locData_(p);                       // อ่านทั้งชีต
    var X = logIdx_(p);                            // ดัชนี
    var names = Object.keys(full);
    var got = X.loc(names);
    var bad = [];
    names.forEach(function (l) {
      var F = full[l], G = got[l];
      if (!G) { bad.push(l + ' ไม่มีในดัชนี'); return; }
      if (F.qty !== G.qty || F.lines !== G.lines) bad.push(l + ' รวม ' + F.qty + '/' + F.lines + ' ≠ ' + G.qty + '/' + G.lines);
      Object.keys(F.devices).forEach(function (d) {
        var a = F.devices[d], b = G.devices[d] || {};
        if (a.qty !== b.qty || a.lines !== b.lines || a.maxSeq !== b.maxSeq || a.lastTime !== b.lastTime) bad.push(l + ' ' + d + ' ' + JSON.stringify([a.qty, a.lines, a.maxSeq, a.lastTime]) + ' ≠ ' + JSON.stringify([b.qty, b.lines, b.maxSeq, b.lastTime]));
      });
      Object.keys(F.items).forEach(function (k) {
        var a = F.items[k], b = G.items[k] || {};
        if (a.qty !== b.qty || JSON.stringify(a.byDevice) !== JSON.stringify(b.byDevice)) bad.push(l + ' ' + k);
      });
    });
    var rows = logIndex_().rows;
    ['TC21-01', 'TC21-02', 'TC21-03'].forEach(function (d) {
      var a = seqStats_(rows, d, p), b = X.stats(d);
      if (JSON.stringify(a) !== JSON.stringify(b)) bad.push('Seq ' + d + ' ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));
    });
    return { bad: bad, n: names.length };
  })()`);
  assert.strictEqual(JSON.stringify(r.bad), '[]', label + ': ' + JSON.stringify(r.bad));
  assert.ok(r.n > 0);
}
const cache = () => env.ctx.CacheService.getScriptCache();
const sheetReads = fn => { env.stats.reset(); fn(); return Object.keys(env.stats.lock.sheets).filter(k => k === 'reads:Count_Log').length ? env.stats.lock.cells : 0; };

const A = device('TC21-01'), B = device('TC21-02'), C = device('TC21-03');

console.log('\nดัชนีตรงกับชีต');
test('ส่งข้อมูลปกติหลายเครื่องหลาย Location (รวมทศนิยม / ยอดติดลบ)', () => {
  for (let i = 1; i <= 12; i++) { A.sync(A.batch('A' + i, 15)); B.sync(B.batch('A' + i, 7, 0.25)); }
  C.sync(C.batch('A3', 3, -1, { type: 'VOID' }));
  same('หลังส่งปกติ');
});
test('ส่งรายการเดิมซ้ำ → ซ้ำ ไม่นับเพิ่ม (ตรวจจากช่วง Seq ในดัชนี)', () => {
  const b = A.batch('A1', 5); A.sync(b);
  const r = A.sync(b);
  assert.strictEqual(r.duplicate.length, 5); assert.strictEqual(r.accepted.length, 0);
  same('หลังส่งซ้ำ');
});
test('Seq ขาดช่วง → รายงานช่องว่างเหมือนเดิม', () => {
  A.seq += 3;
  const r = A.sync(A.batch('A2', 2));
  assert.strictEqual(JSON.stringify(r.seq.gaps.slice(-3)), JSON.stringify([A.seq - 4, A.seq - 3, A.seq - 2]));
  same('หลังขาดช่วง');
});
test('cache หายทั้งหมด (หมดอายุ 6 ชม.) → สร้างใหม่จากชีตครั้งเดียว ผลตรง', () => {
  Object.keys(env.ctx.CacheService.getScriptCache()).length;
  ['lx_meta'].forEach(k => cache().remove(k));
  const r = A.sync(A.batch('A5', 3));
  assert.strictEqual(r.prof.rebuilt, 1);
  same('หลังสร้างใหม่');
  const r2 = A.sync(A.batch('A5', 3));
  assert.ok(!r2.prof.rebuilt, 'ครั้งถัดไปใช้ดัชนี');
});
test('Location บางตัวหายจาก cache → สร้างใหม่ ไม่ใช้ยอดผิด', () => {
  cache().remove('lx_L_2026Q4_A7');
  const r = B.sync(B.batch('A7', 2));
  assert.strictEqual(r.prof.rebuilt, 1);
  same('หลัง Location หาย');
});
test('มีแถวเพิ่มจากทางอื่น (นำเข้าไฟล์ / เขียนตรง) → อ่านเฉพาะแถวที่เพิ่ม', () => {
  const log = env.sheets.Count_Log.data;
  log.push(['TC21-03-000900', '2026Q4', 'TC21-03', '900', 'EMP-1', 'A9', ITEMS[0][0], ITEMS[0][1], '4', 'FOUND', '', '', '', '2026-11-04 11:00:00', '', 'FILE', '', '', '']);
  C.seq = 900;
  const cells = sheetReads(() => { const r = A.sync(A.batch('A9', 1)); assert.ok(!r.prof.rebuilt); });
  assert.ok(cells < 500, 'อ่านไม่เกินไม่กี่แถว: ' + cells);
  same('หลังแถวเพิ่มนอกระบบ');
});
test('ถามสถานะ Location ขณะดัชนีตามไม่ทัน → คำนวณถูก แต่ไม่เขียนดัชนี (ไม่ได้ถือล็อก)', () => {
  const before = cache().get('lx_meta');
  env.sheets.Count_Log.data.push(['TC21-03-000901', '2026Q4', 'TC21-03', '901', 'EMP-1', 'A9', ITEMS[0][0], ITEMS[0][1], '6', 'FOUND', '', '', '', '2026-11-04 11:01:00', '', 'FILE', '', '', '']);
  C.seq = 901;
  const i = A.call('locInfo', { location: 'A9' });
  const full = run('locData_(readConfig_().PROJECT_ID)').A9;
  assert.strictEqual(i.total, full.qty);
  assert.strictEqual(cache().get('lx_meta'), before, 'locInfo ไม่เขียนดัชนี');
  A.sync(A.batch('A9', 1)); same('หลังตามทัน');
});
test('ชีตแถวน้อยลง (ล้างข้อมูล) → สร้างใหม่', () => {
  env.sheets.Count_Log.data.splice(-3, 3);
  const r = B.sync(B.batch('A10', 1));
  assert.strictEqual(r.prof.rebuilt, 1);
  same('หลังแถวน้อยลง');
});
test('แก้ยอดชนกัน (basis) ยังจับได้จากดัชนี', () => {
  const cur = run('logIdx_("2026Q4").loc(["A11"]).A11').items[ITEMS[1][1]] || run('logIdx_("2026Q4").loc(["A11"]).A11').items[ITEMS[0][1]];
  const it = ITEMS.find(x => x[1] === cur.key);
  B.seq++;
  const e = { logId: 'TC21-02-' + String(B.seq).padStart(6, '0'), seq: B.seq, projectId: '2026Q4', staff: 'EMP-1', location: 'A11', barcode: it[0], material: it[1],
    qty: -1, type: 'RECOUNT_SET', basis: cur.qty - 1, reason: 't', scanTime: '2026-11-04 12:00:00' };
  const r = B.sync([e]);
  assert.ok(r.flags && r.flags[0].location === 'A11', 'ติดธงเมื่อยอดที่เห็นไม่ตรง');
  B.seq++;
  const ok = Object.assign({}, e, { logId: 'TC21-02-' + String(B.seq).padStart(6, '0'), seq: B.seq, basis: r3(cur.qty - 1) });
  const r2 = B.sync([ok]);
  assert.ok(!r2.flags, 'ยอดที่เห็นตรง ไม่ติดธง');
  same('หลังแก้ยอด');
  function r3(n) { return Math.round(n * 1000) / 1000; }
});
test('จับคู่ใหม่ / bootstrap ใช้ Seq จากดัชนี ตรงกับชีต', () => {
  const s = run('deviceMaxSeqAll_("TC21-01")');
  const full = Math.max(...env.sheets.Count_Log.data.slice(1).filter(r => r[2] === 'TC21-01').map(r => Number(r[3])));
  assert.strictEqual(s, full);
});

test('Location ใหญ่ 1,200 SKU เก็บใน cache ได้ (ไม่เกิน 100KB)', () => {
  const big = [];
  for (let k = 0; k < 1200; k++) {
    A.seq++;
    big.push({ logId: 'TC21-01-' + String(A.seq).padStart(6, '0'), seq: A.seq, projectId: '2026Q4', staff: 'EMP-1', location: 'Z1', barcode: String(8850000000000 + k),
      material: 'MAT' + String(100000 + k) + 'XXXXXXXX', qty: 1, type: 'SCAN', scanTime: '2026-11-04 13:00:00' });
  }
  for (let i = 0; i < big.length; i += 50) A.sync(big.slice(i, i + 50));
  const s = cache().get('lx_L_2026Q4_Z1');
  assert.ok(s && s.length < 100000, 'ขนาด ' + (s && s.length));
  same('หลัง Location ใหญ่');
});
test('rebuildCountIndex() (กด Run ในหน้า Apps Script) สร้างใหม่ได้', () => {
  const r = run('rebuildCountIndex()');
  assert.strictEqual(r.rows, env.sheets.Count_Log.data.length - 1);
  same('หลังสร้างใหม่ด้วยมือ');
});

test('ทดสอบแรงงาน: loadTestSeed เติม 11,000 แถว → ส่งข้อมูลยังไม่อ่านชีตทั้งชีต · loadTestClear ลบเฉพาะแถวทดสอบ', () => {
  const before = env.sheets.Count_Log.data.length;
  run('loadTestSeed(11000)');
  assert.strictEqual(env.sheets.Count_Log.data.length, before + 11000);
  same('หลังเติมแถวทดสอบ');
  env.stats.reset(); A.sync(A.batch('A1', 15));
  assert.ok(env.stats.lock.cells < 1000, 'อ่านในล็อก ' + env.stats.lock.cells + ' เซลล์');
  const real = env.sheets.Count_Log.data.slice(1).filter(r => r[15] !== 'LOADTEST').length;
  run('loadTestClear()');
  assert.strictEqual(env.sheets.Count_Log.data.filter(r => r.some(v => v !== '')).length - 1, real);
  assert.ok(!env.sheets.Count_Log.data.slice(1).some(r => r[15] === 'LOADTEST'));
  A.sync(A.batch('A1', 1));
  same('หลังลบแถวทดสอบ');
});

console.log(`\nผล: ผ่าน ${pass} / ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
