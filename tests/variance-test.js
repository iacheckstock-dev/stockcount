/**
 * รายงานผลต่าง (v2.9.0): พิมพ์ได้เฉพาะผลสรุปที่บันทึกล่าสุด · ขาด/เกิน · มูลค่าตามราคาทุน · ชื่อร้าน · Admin_Log
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/variance-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
}
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
const BC1 = '8858684826179', MAT1 = 'A112101UT0450XK';

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4-R1", "2026-11-04", "PILOT")');
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
env.sheets.Staff.data.push(['EMP-K', 'นาย ก', 'ผู้ตรวจสอบ', 'Y']);
run('apiSeedDevices(1, "TC21")');
const code = run('apiPairCode("TC21-01")').devices.find(x => x.id === 'TC21-01').pairCode;
const token = env.post({ action: 'pair', deviceId: 'TC21-01', code }).token;
const call = (action, body) => env.post(Object.assign({ action, deviceId: 'TC21-01', token, appVersion: '2.9.0' }, body || {}));
let seq = 0;
const scan = (loc, qty, bc, mat) => { seq++; return { logId: 'TC21-01-' + String(seq).padStart(6, '0'), seq, projectId: '2026Q4-R1', staff: 'EMP-K', location: loc, barcode: bc || BC1, material: mat === undefined ? MAT1 : mat, qty, type: 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:00:' + String(seq).padStart(2, '0') }; };
const unk = scan('A1', 2, '2999999999990', '');
call('sync', { entries: [scan('A1', 3), unk], events: [] });
const logs = a => env.sheets.Admin_Log.data.filter(r => r[2] === a);
const book = run('bookByMaterial_()');
const mat1 = book[MAT1];

console.log('\nรายงานผลต่าง');
test('ยังไม่ได้สรุปผลและบันทึก → พิมพ์ไม่ได้', () => {
  assert.throws(() => run('apiVarianceReport()'), /ยังไม่ได้ "สรุปผลและบันทึก"/);
});
test('ชื่อร้าน / สาขา: บันทึก · แสดงใน state · Admin_Log · ยาวเกิน 80 ไม่รับ', () => {
  const s = run('apiSetStoreName("  สาขา   ทดสอบ 01 ")');
  assert.strictEqual(s.round.storeName, 'สาขา ทดสอบ 01');
  assert.strictEqual(logs('SET_STORE_NAME').length, 1);
  run('apiSetStoreName("สาขา ทดสอบ 01")');
  assert.strictEqual(logs('SET_STORE_NAME').length, 1, 'ชื่อเดิม ไม่บันทึกซ้ำ');
  assert.throws(() => run('apiSetStoreName(' + JSON.stringify('ก'.repeat(81)) + ')'), /เกิน 80/);
});
test('หลังบันทึก: หัวรายงาน + ยอดรวมตรงกับผลสรุป · ขาด/เกินเรียงตามรหัส · ไม่มีรายการที่ตรง', () => {
  run('apiSummarySave()');
  const R = run('apiVarianceReport()'), S = run('apiSummary()');
  assert.ok(R.store === 'สาขา ทดสอบ 01' && R.project === '2026Q4-R1' && R.countDate === '2026-11-04' && R.run === 1 && R.sig);
  const T = R.totals;
  assert.strictEqual(T.skus, S.totals.skus);
  assert.strictEqual(T.short, S.totals.short); assert.strictEqual(T.over, S.totals.over); assert.strictEqual(T.match, S.totals.match);
  assert.strictEqual(T.book, S.totals.book);
  assert.ok(Math.abs(T.diff - S.totals.diff) < 1e-9, T.diff + ' vs ' + S.totals.diff);
  assert.ok(Math.abs(T.diffValue - S.totals.diffValue) < 0.011, T.diffValue + ' vs ' + S.totals.diffValue);
  assert.ok(R.short.every(r => r[4] < 0) && R.over.every(r => r[4] > 0));
  assert.strictEqual(R.short.length + R.over.length, T.short + T.over);
  const sorted = l => l.every((r, i) => !i || l[i - 1][0] <= r[0]);
  assert.ok(sorted(R.short) && sorted(R.over));
  assert.ok(T.shortQty < 0 && T.overQty >= 0);
});
test('แถวสินค้า: [รหัส, ชื่อ, บัญชี, นับ, ต่าง, ราคาทุน, มูลค่า] · มูลค่า = ต่าง × ราคาทุน', () => {
  const R = run('apiVarianceReport()');
  const row = R.short.concat(R.over).find(r => r[0] === MAT1);
  assert.ok(row, 'MAT1 ต้องอยู่ในรายงาน');
  assert.strictEqual(row[3], 3); assert.strictEqual(row[2], mat1.book); assert.strictEqual(row[4], 3 - mat1.book);
  if (mat1.cost) assert.ok(Math.abs(row[6] - Math.round(row[4] * mat1.cost * 100) / 100) < 1e-9);
  else assert.ok(row[5] === null && row[6] === null);
});
test('ยิงแล้วไม่มีใน Master → แยกไว้ ไม่รวมในผลต่าง', () => {
  const R = run('apiVarianceReport()');
  same(R.unmapped, [['2999999999990', 2]]);
  assert.strictEqual(R.totals.unmappedQty, 2);
});
test('ไม่มีราคาทุน → ช่องว่าง และนับใน noCost (ฟังก์ชันแยก)', () => {
  const R = run('varianceReport_(' + JSON.stringify({ skus: [['M1', 'a', 5, 3, 0, 3, -2, 0, 0], ['M2', 'b', 1, 4, 0, 4, 3, 10, 30], ['M3', 'c', 2, 2, 0, 2, 0, 5, 0]], unmapped: [], sap: {}, bookSource: 'SAP' }) + ')');
  same(R.short, [['M1', 'a', 5, 3, -2, null, null]]);
  same(R.over, [['M2', 'b', 1, 4, 3, 10, 30]]);
  assert.ok(R.totals.noCost === 1 && R.totals.match === 1 && R.totals.diff === 1 && R.totals.diffValue === 30 && R.totals.shortValue === 0);
});
test('ทุกครั้งที่ออกรายงานบันทึก PRINT_VARIANCE บอกครั้งที่สรุปผล', () => {
  const n = logs('PRINT_VARIANCE').length;
  assert.ok(n >= 3);
  assert.ok(/ผลสรุปครั้งที่ 1/.test(logs('PRINT_VARIANCE').slice(-1)[0][4]));
});
test('ตัวเลขเปลี่ยนหลังบันทึก (ปรับยอด) → พิมพ์ไม่ได้ จนกว่าจะบันทึกใหม่', () => {
  run('apiAdjust({ material: "' + MAT1 + '", qty: 1, reason: "' + run('ADJ_REASONS[0][0]') + '", staff: "EMP-K", note: "นับทวน" })');
  const n = logs('PRINT_VARIANCE').length;
  assert.throws(() => run('apiVarianceReport()'), /ตัวเลขเปลี่ยนหลังสรุปผลครั้งที่ 1/);
  assert.strictEqual(logs('PRINT_VARIANCE').length, n, 'พิมพ์ไม่ได้ ไม่บันทึก');
  run('apiSummarySave()');
  const R = run('apiVarianceReport()');
  assert.strictEqual(R.run, 2);
  assert.strictEqual(R.short.concat(R.over).find(r => r[0] === MAT1)[3], 4);
});

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
