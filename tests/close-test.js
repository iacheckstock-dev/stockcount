/**
 * ปิดการนับ + เงื่อนไขปิดรอบ K1–K7 ครบทุกข้อ (v2.5.0) — รอบสะอาด 1 เครื่อง 2 Location
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/close-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
}

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4", "2026-11-04", "PILOT")');
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
env.sheets.Staff.data.push(['EMP-K', 'นาย ก', 'ผู้ตรวจสอบ', 'Y']);
run('apiSeedDevices(2, "TC21")');
const BC1 = '8858684826179', MAT1 = 'A112101UT0450XK';

const code = run('apiPairCode("TC21-01")').devices.find(x => x.id === 'TC21-01').pairCode;
const token = env.post({ action: 'pair', deviceId: 'TC21-01', code }).token;
const call = (action, body) => env.post(Object.assign({ action, deviceId: 'TC21-01', token, appVersion: '2.5.0' }, body || {}));
let seq = 0, at = 1;
const entries = [];
const scan = (loc, qty) => { seq++; const e = { logId: 'TC21-01-' + String(seq).padStart(6, '0'), seq, projectId: '2026Q4', staff: 'EMP-K', location: loc, barcode: BC1, material: MAT1, qty, type: 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:00:0' + seq }; entries.push(e); return e; };
const ev = (type, loc, extra) => {
  const mine = entries.filter(e => e.location === loc);
  return Object.assign({ id: 'TC21-01-E' + at, at: at++, type, projectId: '2026Q4', location: loc, staff: 'EMP-K', time: '2026-11-04 10:30:00', lines: mine.length,
    qty: mine.reduce((a, e) => a + e.qty, 0), fromSeq: 1, upToSeq: seq }, extra || {});
};
const item = (R, id) => R.items.find(x => x.id === id);

console.log('\nรอบสะอาด: นับ → ปิดการนับ → ทำเงื่อนไขครบ → พร้อมปิดรอบ');
test('นับ 2 Location แล้วปิดทั้งคู่ · K1 ✓ แต่ K7 ✗ (ยังไม่ปิดการนับ)', () => {
  let r = call('sync', { entries: [scan('A1', 3), scan('A1', 2)], events: [ev('OPEN', 'A1')] });
  assert.ok(r.ok);
  r = call('sync', { entries: [], events: [ev('CLOSE', 'A1', { total: 5 })] });
  r = call('sync', { entries: [scan('A2', 4)], events: [ev('OPEN', 'A2')] });
  r = call('sync', { entries: [], events: [ev('CLOSE', 'A2', { total: 4 })] });
  const R = run('closeCheck_(false)');
  assert.ok(item(R, 'K1').ok, item(R, 'K1').detail + JSON.stringify(item(R, 'K1').list));
  assert.ok(item(R, 'K2').ok && !item(R, 'K7').ok);
});
test('ครบทุกข้อ: ปิดการนับ → เครื่องค้าง 0 → กระทบยอด → สรุปผลและบันทึก → K1–K7 ✓ ทั้งหมด', () => {
  run('apiCountClose("EMP-K")');
  call('hello', { pending: 0, location: '' });
  const rec = run('apiReconcile()');
  assert.ok(rec.ok, JSON.stringify(rec.audit));
  run('apiSummarySave()');
  const R = run('apiCloseCheck()');
  assert.ok(R.ok, JSON.stringify(R.items.filter(x => !x.ok)));
  assert.ok(R.items.every(x => x.ok && !x.fix));
});
test('เครื่องที่จับคู่อยู่แต่ไม่ส่งสัญญาณ → K3 ✗ "ไม่มีสัญญาณ" · ยกเลิกเครื่องที่ไม่ใช้ → ✓', () => {
  const c2 = run('apiPairCode("TC21-02")').devices.find(x => x.id === 'TC21-02').pairCode;
  env.post({ action: 'pair', deviceId: 'TC21-02', code: c2 });
  let k3 = item(run('closeCheck_(false)'), 'K3');
  assert.ok(!k3.ok && k3.list.indexOf('TC21-02: ไม่มีสัญญาณ') >= 0, JSON.stringify(k3.list));
  run('apiSetDeviceActive("TC21-02", false, "TEMP", "ไม่ได้ใช้รอบนี้")');
  k3 = item(run('closeCheck_(false)'), 'K3');
  assert.ok(k3.ok, JSON.stringify(k3.list));
});
test('รายการเข้ามาหลังบันทึกผล → K4 และ K5 ✗ จนกว่าจะกระทบยอด + บันทึกใหม่', () => {
  call('sync', { entries: [scan('A2', 1)], events: [] });
  let R = run('apiCloseCheck()');
  assert.ok(!item(R, 'K4').ok && !item(R, 'K5').ok && !R.ok);
  run('apiReconcile()');
  run('apiSummarySave()');
  R = run('apiCloseCheck()');
  // ยอดตอนปิด A2 (4) ≠ ชีต (5) → กระทบยอดเจอจุดต่าง (ยกเว้นมีธง) — ต้องไม่ผ่าน ไม่ปล่อยผ่านเงียบ
  assert.ok(!R.ok, 'ยิงเพิ่มหลังปิด Location ต้องไม่ผ่านเงื่อนไข');
  assert.ok(!item(R, 'K2').ok || !item(R, 'K4').ok, JSON.stringify(R.items.filter(x => !x.ok).map(x => x.id + ' ' + x.detail)));
});

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
