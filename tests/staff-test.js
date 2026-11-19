/**
 * v2.5.5: จัดการพนักงานในหน้า Admin · เลขชุดรายชื่อ (staffRev) · เครื่องรู้ว่าเปิดรอบใหม่ · "พร้อมรอบนี้"
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/staff-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
}
const throws = (fn, re) => { try { fn(); } catch (e) { assert.ok(re.test(e.message), e.message); return; } assert.fail('ต้องปฏิเสธ: ' + re); };

const env = createEnv();
const { sap, pos } = loadSamples(env.ctx.Core);
const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
run('setupSheets()');
run('apiOpenRound("2026Q4-R1", "2026-11-04", "PILOT")');
run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
const st = run('apiGetState()');
run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
env.sheets.Staff.data.push(['EMP-K', 'นาย ก', 'หัวหน้าทีม', 'Y']);
run('apiSeedDevices(1, "TC21")');
const code = run('apiPairCode("TC21-01")').devices.find(x => x.id === 'TC21-01').pairCode;
const token = env.post({ action: 'pair', deviceId: 'TC21-01', code }).token;
const VER = run('SYSTEM_VERSION');
const call = (action, body) => env.post(Object.assign({ action, deviceId: 'TC21-01', token, appVersion: VER }, body || {}));
const logs = a => env.sheets.Admin_Log.data.filter(r => r[2] === a);
const staffRow = c => env.sheets.Staff.data.find(r => r[0] === c);

console.log('\nจัดการพนักงาน');
test('เพิ่ม: รหัสพิมพ์เล็กแปลงเป็นพิมพ์ใหญ่ · ต้องเลือกผู้กด · บันทึก STAFF_ADD พร้อมผู้กด', () => {
  const d = run('apiStaffAdd("EMP-K", "tmp01", "ชั่วคราว 1", "ผู้ช่วย")');
  assert.ok(d.staff.some(x => x.code === 'TMP01' && x.active && x.name === 'ชั่วคราว 1' && x.lines === 0));
  assert.deepStrictEqual(staffRow('TMP01'), ['TMP01', 'ชั่วคราว 1', 'ผู้ช่วย', 'Y']);
  assert.ok(/ผู้กด EMP-K/.test(logs('STAFF_ADD').slice(-1)[0][4]));
  throws(() => run('apiStaffAdd("", "TMP02", "x", "")'), /ผู้ตรวจสอบ/);
});
test('เพิ่ม: รหัสซ้ำ / รูปแบบผิด / ไม่มีชื่อ → ปฏิเสธ · ซ้ำกับคนที่ปิดใช้ก็ไม่ได้ (บอกให้กดเปิดใช้)', () => {
  throws(() => run('apiStaffAdd("EMP-K", "TMP01", "ซ้ำ", "")'), /มีอยู่แล้ว/);
  throws(() => run('apiStaffAdd("EMP-K", "A", "สั้น", "")'), /2–12/);
  throws(() => run('apiStaffAdd("EMP-K", "AB CD", "เว้นวรรค", "")'), /2–12/);
  throws(() => run('apiStaffAdd("EMP-K", "TMP09", "", "")'), /ชื่อ/);
  run('apiStaffAdd("EMP-K", "TMP02", "ชั่วคราว 2", "")');
  run('apiStaffActive("EMP-K", "TMP02", false, "จบงาน")');
  throws(() => run('apiStaffAdd("EMP-K", "TMP02", "ใหม่", "")'), /ปิดใช้อยู่.*เปิดใช้/);
});
test('แก้ไข: ชื่อ / ตำแหน่ง (รหัสคงเดิม) · บันทึกค่าเก่า → ใหม่ · ไม่เปลี่ยนอะไร → ปฏิเสธ', () => {
  run('apiStaffEdit("EMP-K", "TMP01", "ชั่วคราว หนึ่ง", "ผู้ตรวจสอบ")');
  assert.deepStrictEqual(staffRow('TMP01'), ['TMP01', 'ชั่วคราว หนึ่ง', 'ผู้ตรวจสอบ', 'Y']);
  assert.ok(/ชั่วคราว 1 → ชั่วคราว หนึ่ง/.test(logs('STAFF_EDIT').slice(-1)[0][4]));
  throws(() => run('apiStaffEdit("EMP-K", "TMP01", "ชั่วคราว หนึ่ง", "ผู้ตรวจสอบ")'), /ไม่มีอะไรเปลี่ยน/);
  throws(() => run('apiStaffEdit("EMP-K", "NOPE", "x", "")'), /ไม่พบ/);
});
test('ปิดใช้: ต้องมีเหตุผล · ปิดตัวเองไม่ได้ · เปิดใช้คืนได้ · STAFF_OFF / STAFF_ON', () => {
  throws(() => run('apiStaffActive("EMP-K", "TMP01", false, "")'), /เหตุผล/);
  throws(() => run('apiStaffActive("EMP-K", "EMP-K", false, "ทดสอบ")'), /ตัวเอง/);
  run('apiStaffActive("EMP-K", "TMP01", false, "ลาออก")');
  assert.strictEqual(staffRow('TMP01')[3], 'N');
  assert.ok(/ลาออก/.test(logs('STAFF_OFF').slice(-1)[0][4]));
  throws(() => run('apiStaffActive("TMP01", "TMP02", true, "")'), /ผู้ตรวจสอบ/);   // คนที่ปิดใช้แล้วเป็นผู้กดไม่ได้
  run('apiStaffActive("EMP-K", "TMP01", true, "")');
  assert.strictEqual(staffRow('TMP01')[3], 'Y');
  assert.strictEqual(logs('STAFF_ON').length, 1);
});

console.log('\nเครื่องได้รายชื่อใหม่');
test('hello / bootstrap มี staffRev · เพิ่มคน → เลขเปลี่ยน · action "staff" คืนรายชื่อที่ใช้งาน (ไม่มีคนที่ปิดใช้)', () => {
  const r1 = call('hello', { pending: 0 }).staffRev, b = call('bootstrap');
  assert.ok(r1 && b.staffRev === r1 && Array.isArray(b.closedProjects));
  run('apiStaffAdd("EMP-K", "TMP03", "ชั่วคราว 3", "")');
  const r2 = call('hello', { pending: 0 }).staffRev;
  assert.notStrictEqual(r2, r1);
  const s = call('staff');
  assert.ok(s.ok && s.staffRev === r2 && s.staff.some(x => x.code === 'TMP03') && !s.staff.some(x => x.code === 'TMP02'));
  run('apiStaffEdit("EMP-K", "TMP03", "ชั่วคราว สาม", "")');
  assert.notStrictEqual(call('hello', { pending: 0 }).staffRev, r2, 'แก้ชื่อก็เปลี่ยนเลข (บัตร/หน้าจอแสดงชื่อใหม่)');
});
test('จำนวนรายการรอบนี้ต่อคน (แท็บพนักงาน)', () => {
  call('sync', { entries: [{ logId: 'TC21-01-000001', seq: 1, projectId: '2026Q4-R1', staff: 'TMP03', location: 'A1', barcode: '8858684826179', material: 'A112101UT0450XK', qty: 2, type: 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:00:01' }], events: [] });
  const d = run('apiStaffState()');
  assert.strictEqual(d.staff.find(x => x.code === 'TMP03').lines, 1);
  assert.strictEqual(d.staff.find(x => x.code === 'EMP-K').lines, 0);
});

console.log('\nรอบ · พร้อมรอบนี้');
test('sync ตอบรหัสรอบ (เครื่องเทียบได้ว่าเปิดรอบใหม่แล้ว)', () => {
  const r = call('sync', { entries: [], events: [] });
  assert.ok(r.project === '2026Q4-R1' && r.round, JSON.stringify(r).slice(0, 200));
});
test('พร้อมรอบนี้: ยังไม่ตรวจ ✗ → ตรวจผ่านรอบนี้ ✓ → แอปเก่า ✗ · ตรวจรอบอื่น ✗', () => {
  const dev = () => run('apiDevicesState()').devices.find(x => x.id === 'TC21-01');
  call('hello', { pending: 0 });
  let d = dev();
  assert.ok(!d.ready.ok && d.ready.why.some(w => /ยังไม่ตรวจความพร้อม/.test(w)), JSON.stringify(d.ready));
  call('check', { staff: 'EMP-K', project: '2026Q4-R1', items: [{ title: 'x', result: 'OK' }] });
  assert.strictEqual(env.sheets.Devices.data[1][env.sheets.Devices.data[0].indexOf('Check_Project')], '2026Q4-R1');
  d = dev();
  assert.ok(d.ready.ok && d.checkProject === '2026Q4-R1', JSON.stringify(d.ready));
  call('check', { staff: 'EMP-K', project: '2026Q4-R1', items: [{ title: 'x', result: 'OK' }], appVersion: '2.5.4' });
  d = dev();
  assert.ok(!d.ready.ok && d.ready.why.some(w => /แอป 2\.5\.4/.test(w)), JSON.stringify(d.ready));
  call('check', { staff: 'EMP-K', project: '2026Q3', items: [{ title: 'x', result: 'OK' }] });
  d = dev();
  assert.ok(!d.ready.ok && d.ready.why.some(w => /รอบ 2026Q3/.test(w)), JSON.stringify(d.ready));
  call('hello', { pending: 3 });
  call('check', { staff: 'EMP-K', project: '2026Q4-R1', items: [{ title: 'x', result: 'OK' }] });
  d = dev();
  assert.ok(!d.ready.ok && d.ready.why.some(w => /ค้างส่ง 3/.test(w)), JSON.stringify(d.ready));
});
test('ชีต Devices มีคอลัมน์ Check_Project · SCHEMA_VERSION 12', () => {
  assert.ok(env.sheets.Devices.data[0].indexOf('Check_Project') > 0);
  assert.strictEqual(run('SCHEMA_VERSION'), 12);
});

console.log('\nv2.5.6');
test('แก้พนักงาน: บันทึกเฉพาะช่องที่เปลี่ยน · ชื่อดูเหมือนเดิม (สระซ้อนสลับลำดับ) บอกว่าแก้ตัวสะกด', () => {
  run('apiStaffEdit("EMP-K", "TMP01", "ชั่วคราว หนึ่ง", "หัวหน้า")');
  let d = logs('STAFF_EDIT').slice(-1)[0][4];
  assert.ok(/^ตำแหน่ง ผู้ตรวจสอบ → หัวหน้า · ผู้กด/.test(d) && !/ชื่อ/.test(d), d);
  env.sheets.Staff.data.push(['TA369', 'ปาริฉัตร สวาศรี'.replace('ั', 'ั'), '', 'Y']);
  run('apiStaffEdit("EMP-K", "TA369", "ปาริฉัตร  สวาศรี", "")');   // วรรคซ้ำ → ดูเหมือนเดิม
  d = logs('STAFF_EDIT').slice(-1)[0][4];
  assert.ok(/^ชื่อ .* \(แก้ตัวสะกด\/สระซ้อน\) · ผู้กด/.test(d) && !/ตำแหน่ง/.test(d), d);
});
test('apiAdminLog: เลือกรอบ · ทุกรอบ · ค้นคำ · offset · รายการรอบ', () => {
  const all = run('apiAdminLog("*", "", 0)');
  assert.ok(all.total >= 10 && all.rows.length === Math.min(100, all.total) && all.rounds.some(r => r.p === '2026Q4-R1'));
  assert.ok(String(all.rows[0][0]) >= String(all.rows[all.rows.length - 1][0]), 'ใหม่ก่อน');
  const st = run('apiAdminLog("2026Q4-R1", "staff_", 0)');
  assert.ok(st.total >= 5 && st.rows.every(r => /STAFF_/.test(r[2]) && r[5] === '2026Q4-R1'), JSON.stringify(st.rows.slice(0, 2)));
  const o2 = run('apiAdminLog("*", "", 2)');
  assert.deepStrictEqual(o2.rows[0], all.rows[2]);
  assert.strictEqual(run('apiAdminLog("*", "ไม่มีคำนี้แน่นอน", 0)').total, 0);
  assert.ok(run('apiGetState()').log.rounds.length >= 1);
});
test('apiRoundStatus: เบา · ตรงกับ Config', () => {
  const r = run('apiRoundStatus()');
  assert.deepStrictEqual([r.projectId, r.status], ['2026Q4-R1', run('readConfig_().ROUND_STATUS')]);
  assert.ok(r.statusTh);
});

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
