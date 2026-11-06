/**
 * ทดสอบ API ของเครื่อง TC21 (เฟส 2) บน Apps Script จำลอง
 * SAMPLE_SAP=... SAMPLE_POS=... [SAMPLE_DOLPHIN=...] node tests/api-test.js
 */
const fs = require('fs'), assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
}

/** เตรียมระบบให้พร้อมนับ: รอบ 2026Q4, POS+SAP, อนุมัติ, ผู้ตรวจสอบ 3 คน, เครื่อง 5 เครื่อง */
function prepared() {
  const env = createEnv();
  const { sap, pos } = loadSamples(env.ctx.Core);
  const run0 = env.run;
  const run = (c, v) => run0(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
  run('setupSheets()');
  run('apiOpenRound("2026Q4", "2026-11-04")');
  run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
  run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
  const st = run('apiGetState()');
  const warns = st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id);
  run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(warns)})`);
  const staff = env.sheets.Staff;
  staff.data.push(['EMP-NU', 'นุ่น', 'ผู้ตรวจสอบ', 'Y'], ['EMP-AOY', 'อ้อย', 'ผู้ตรวจสอบ', 'Y'], ['EMP-LEAD', 'หัวหน้า', 'หัวหน้าทีมตรวจสอบ', 'Y'], ['EMP-OLD', 'ลาออก', 'ผู้ตรวจสอบ', 'N']);
  run('apiSeedDevices(5, "TC21")');
  return Object.assign(env, { run });
}

function pairDevice(env, id) {
  const d = env.run(`apiPairCode(${JSON.stringify(id)})`).devices.find(x => x.id === id);
  const r = env.post({ action: 'pair', deviceId: id, code: d.pairCode, appVersion: 'test' });
  assert.ok(r.ok, JSON.stringify(r));
  return r.token;
}

function entry(dev, seq, loc, bc, mat, qty, type, extra) {
  return Object.assign({ logId: dev + '-' + String(seq).padStart(6, '0'), seq, projectId: '2026Q4', staff: 'EMP-NU', location: loc, barcode: bc,
    material: mat, qty, type: type || 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:00:0' + (seq % 10) }, extra || {});
}

const env = prepared();
const A = 'TC21-01';
let token;
const BC1 = '8858684826179', MAT1 = 'A112101UT0450XK';
const BC2 = '8858153867481', MAT2 = 'A112101UT0550XK';

console.log('\nจับคู่เครื่อง');
test('สร้างเครื่อง 5 เครื่อง TC21-01..05', () => {
  const s = env.run('apiDevicesState()');
  assert.strictEqual(s.devices.map(d => d.id).join(','), 'TC21-01,TC21-02,TC21-03,TC21-04,TC21-05');
  assert.strictEqual(s.staff.length, 4);
});
test('รหัสผิด → ปฏิเสธ, ผิดครบ 5 ครั้ง → รหัสถูกยกเลิก', () => {
  env.run('apiPairCode("TC21-02")');
  for (let i = 0; i < 4; i++) assert.strictEqual(env.post({ action: 'pair', deviceId: 'TC21-02', code: '000000' }).error, 'BAD_PAIR_CODE');
  const r5 = env.post({ action: 'pair', deviceId: 'TC21-02', code: '000000' });
  assert.ok(/เกินกำหนด/.test(r5.message));
  assert.strictEqual(env.run('apiDevicesState()').devices.find(d => d.id === 'TC21-02').pairCode, '');
});
test('รหัสถูก → ได้ token และรหัสใช้ซ้ำไม่ได้', () => {
  const code = env.run('apiPairCode("TC21-01")').devices.find(d => d.id === A).pairCode;
  const r = env.post({ action: 'pair', deviceId: A, code });
  assert.ok(r.ok && r.token.length === 64);
  token = r.token;
  assert.strictEqual(env.post({ action: 'pair', deviceId: A, code }).error, 'NO_PAIR_CODE');
});
test('token ผิด → BAD_TOKEN', () => assert.strictEqual(env.post({ action: 'bootstrap', deviceId: A, token: 'x' }).error, 'BAD_TOKEN'));

console.log('\nโหลดข้อมูลลงเครื่อง');
const call = (action, body) => env.post(Object.assign({ action, deviceId: A, token, appVersion: '2.0.0' }, body || {}));
test('bootstrap: รอบ, Master อนุมัติ, ผู้ตรวจสอบที่ใช้งานอยู่', () => {
  const b = call('bootstrap');
  assert.ok(b.ok, JSON.stringify(b));
  assert.strictEqual(b.project.id, '2026Q4');
  assert.strictEqual(b.project.status, 'SETUP');
  assert.ok(b.master.approved && b.master.hash);
  assert.strictEqual(b.staff.map(s => s.code).join(','), 'EMP-NU,EMP-AOY,EMP-LEAD');
});
test('master: 2,330 รายการ (บาร์โค้ด 2,318 + ไม่มีบาร์โค้ด 12) ไม่มียอด/ต้นทุน', () => {
  const m = call('master');
  assert.strictEqual(m.rows.length, 2330);
  assert.strictEqual(m.rows.filter(r => !r[0]).length, 12);
  assert.strictEqual(m.rows[0].length, 4);
});

test('stock: ยอดบัญชีต่อ Material (SAP Qty-UR) และ stockVersion ตรงกับ bootstrap', () => {
  const s = call('stock'), b = call('bootstrap');
  assert.strictEqual(s.source, 'SAP');
  assert.strictEqual(s.version, b.stockVersion);
  assert.strictEqual(s.rows.length, 2330);
  const m = Object.fromEntries(s.rows);
  assert.strictEqual(typeof m[MAT1], 'number');
});

console.log('\nส่งข้อมูล (sync)');
test('ส่ง 3 รายการ + เปิด Location → รับ 3, รอบเปลี่ยนเป็น COUNTING', () => {
  const r = call('sync', {
    entries: [entry(A, 1, 'A1', BC1, MAT1, 1), entry(A, 2, 'A1', BC1, MAT1, 1), entry(A, 3, 'A1', BC2, MAT2, 5)],
    events: [{ id: 'e1', type: 'OPEN', projectId: '2026Q4', location: 'a01', staff: 'EMP-NU', time: '2026-11-04 10:00:00', lines: 0, qty: 0 }]
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.accepted.length, 3);
  assert.strictEqual(env.run('readConfig_()').ROUND_STATUS, 'COUNTING');
  const loc = env.run('apiDevicesState()').locations[0];
  assert.strictEqual(loc.Location, 'A1');
  assert.strictEqual(loc.Status, 'กำลังนับ');
});
test('ส่งชุดเดิมซ้ำ → ไม่นับเกิน (duplicate 3)', () => {
  const r = call('sync', { entries: [entry(A, 1, 'A1', BC1, MAT1, 1), entry(A, 2, 'A1', BC1, MAT1, 1), entry(A, 3, 'A1', BC2, MAT2, 5)] });
  assert.strictEqual(r.duplicate.length, 3);
  assert.strictEqual(r.accepted.length, 0);
  assert.strictEqual(env.sheets.Count_Log.data.length - 1, 3);
});
test('Log_ID ไม่ตรงรหัสเครื่อง/Seq → ไม่รับ', () => {
  const r = call('sync', { entries: [Object.assign(entry(A, 9, 'A1', BC1, MAT1, 1), { logId: 'TC21-02-000009' })] });
  assert.strictEqual(r.rejected[0].reason, 'BAD_LOG_ID');
});
test('Seq ขาด (ส่ง 5 ข้าม 4) → รายงานช่องว่าง [4]', () => {
  const r = call('sync', { entries: [entry(A, 5, 'A1', BC2, MAT2, -1, 'VOID', { refId: A + '-000003' })] });
  assert.strictEqual(r.seq.gaps.join(','), '4');
  assert.strictEqual(env.run('apiDevicesState()').devices.find(d => d.id === A).gaps, '1');
});
test('ปิด Location ตอนยังขาด Seq 4 → WAIT', () => {
  const r = call('sync', { events: [{ id: 'e2', type: 'CLOSE', projectId: '2026Q4', location: 'A1', staff: 'EMP-NU', lines: 5, qty: 7, fromSeq: 1, upToSeq: 5 }] });
  assert.strictEqual(r.events[0].match, 'WAIT');
});
test('ได้ Seq 4 แล้ว ปิดใหม่ ยอดตรง → OK; ยอดไม่ตรง → MISMATCH', () => {
  call('sync', { entries: [entry(A, 4, 'A1', BC1, MAT1, 1)] });
  // เครื่องนับ A1: 1+1+5+1-1 = 7 ชิ้น 5 แถว
  let r = call('sync', { events: [{ id: 'e3', type: 'CLOSE', projectId: '2026Q4', location: 'A1', staff: 'EMP-NU', lines: 5, qty: 7, fromSeq: 1, upToSeq: 5 }] });
  assert.strictEqual(r.events[0].match, 'OK');
  r = call('sync', { events: [{ id: 'e4', type: 'EDIT', projectId: '2026Q4', location: 'A1', staff: 'EMP-NU', lines: 5, qty: 8, fromSeq: 1, upToSeq: 5 }] });
  assert.strictEqual(r.events[0].match, 'MISMATCH');
  const loc = env.run('apiDevicesState()').locations.find(l => l.Location === 'A1');
  assert.strictEqual(loc.Status, 'ปิดแล้ว');
  assert.strictEqual(env.sheets.Loc_Checks.data.filter(r => r[4] === 'CLOSE' || r[4] === 'EDIT').length, 3);
});
test('locStatus: เครื่องอื่นเห็นว่า A2 กำลังนับโดย TC21-01', () => {
  call('sync', { events: [{ id: 'e5', type: 'OPEN', projectId: '2026Q4', location: 'A2', staff: 'EMP-NU' }] });
  const t3 = pairDevice(env, 'TC21-03');
  const r = env.post({ action: 'locStatus', deviceId: 'TC21-03', token: t3, location: 'LOC:A02' });
  assert.strictEqual(r.openByOther, 'TC21-01 EMP-NU');
});
test('ข้อมูลรอบอื่น → แยกไว้ใน Quarantine ไม่รวมยอด', () => {
  const r = call('sync', { entries: [Object.assign(entry(A, 6, 'B1', BC1, MAT1, 1), { projectId: '2026Q3' })] });
  assert.strictEqual(r.quarantined.length, 1);
  assert.strictEqual(env.sheets.Quarantine.data.length - 1, 1);
  assert.strictEqual(env.sheets.Count_Log.data.length - 1, 5);
});
test('ผลตรวจความพร้อมเครื่องถูกบันทึก', () => {
  const r = call('check', { staff: 'EMP-NU', items: [{ title: 'x', result: 'OK' }, { title: 'y', result: 'WARN' }] });
  assert.ok(r.pass);
  assert.strictEqual(env.sheets.Device_Checks.data.length - 1, 1);
});
test('ยกเลิกเครื่อง → token เดิมใช้ไม่ได้', () => {
  env.run('apiSetDeviceActive("TC21-03", false)');
  assert.strictEqual(env.post({ action: 'bootstrap', deviceId: 'TC21-03', token: 'x' }).error, 'DEVICE_DISABLED');
});
test('จับคู่ใหม่ได้ maxSeqAll = Seq สูงสุดเดิม (กันเลขชนหลังล้างข้อมูลเครื่อง)', () => {
  const code = env.run('apiPairCode("TC21-01")').devices.find(d => d.id === A).pairCode;
  const r = env.post({ action: 'pair', deviceId: A, code });
  assert.strictEqual(r.maxSeqAll, 6);
  token = r.token;
  assert.strictEqual(call('bootstrap').device.maxSeqAll, 6);
});
test('ตั้ง API_URL: รับเฉพาะรูปแบบ Web app /exec และแสดงในหน้า Admin', () => {
  assert.throws(() => env.run('apiSetApiUrl("https://example.com/x")'), /รูปแบบ/);
  const u = 'https://script.google.com/macros/s/AKfycbxrnsB6Rbv8yG5dS4LTyz-sb4YfN9qUO20OJ5227rY8KyobO4J063_GsBjlvNAHSxRC/exec';
  assert.strictEqual(env.run(`apiSetApiUrl(${JSON.stringify(u)})`).apiUrl, u);
});
test('ล้างรอบไม่ได้หลังเริ่มนับ', () => assert.throws(() => env.run('resetRound_()'), /เริ่มนับแล้ว/));

console.log('\nนำเข้าไฟล์จากเครื่อง');
function exportText(entries) {
  const cols = env.ctx.Core.EXPORT_COLS;
  const lines = ['#STOCKCOUNT_EXPORT,v1,' + A + ',2026Q4,2026-11-04 12:00:00', cols.join(',')];
  entries.forEach(e => lines.push([e.logId, e.projectId, A, e.seq, e.staff, e.location, e.barcode, e.material, e.qty, e.type, e.refId, e.reason, e.note, e.scanTime].join(',')));
  lines.push('#SUMMARY,' + entries.length + ',' + entries.reduce((a, e) => a + e.qty, 0) + ',' + Math.max(...entries.map(e => e.seq)));
  return '﻿' + lines.join('\r\n');
}
test('ไฟล์ export ของ TC21: มีแล้ว 5 เพิ่มใหม่ 2', () => {
  const list = [1, 2, 3, 4, 5].map(s => entry(A, s, 'A1', BC1, MAT1, 1)).concat([entry(A, 7, 'A3', BC1, MAT1, 2), entry(A, 8, 'A3', BC2, MAT2, 1)]);
  const r = env.run('apiImportDeviceFile(_t, "SC_2026Q4_TC21-01.csv")', { _t: exportText(list) });
  assert.strictEqual(r.existing, 5);
  assert.strictEqual(r.added, 2);
  const again = env.run('apiImportDeviceFile(_t, "SC_2026Q4_TC21-01.csv")', { _t: exportText(list) });
  assert.strictEqual(again.added, 0);
  assert.ok(again.importedBefore);
});
test('ไฟล์ไม่ครบ (บรรทัดสรุปไม่ตรง) → ปฏิเสธ', () => {
  const t = exportText([entry(A, 9, 'A3', BC1, MAT1, 1)]).replace('#SUMMARY,1,', '#SUMMARY,2,');
  assert.throws(() => env.run('apiImportDeviceFile(_t, "x.csv")', { _t: t }), /ไม่ครบ/);
});
if (process.env.SAMPLE_DOLPHIN) {
  test('ไฟล์ Dolphin 7 คอลัมน์เดิม นำเข้าได้ และนำเข้าซ้ำไม่นับเกิน', () => {
    const text = fs.readFileSync(process.env.SAMPLE_DOLPHIN, 'latin1');
    const r = env.run('apiImportDeviceFile(_t, "CHKTNL.txt")', { _t: text });
    const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
    assert.strictEqual(r.added, lines);
    const known = env.sheets.Count_Log.data.filter(x => x[2] === 'DOLPHIN' && x[7]).length;
    console.log('      Dolphin: ' + lines + ' แถว, รู้จักรหัส ' + known + ', ไม่รู้จัก ' + (lines - known));
    assert.strictEqual(env.run('apiImportDeviceFile(_t, "CHKTNL.txt")', { _t: text }).added, 0);
  });
}

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
