/**
 * ปิดรอบ (v2.5.2): สำรอง → ตรวจไฟล์สำรอง → Count_History → ล้างชีตงาน · ทำต่อเมื่อค้าง · โหมดรอบทดสอบ · ไฟล์สำรองดูอย่างเดียว
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/closeround-test.js
 */
const assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
}
const BC1 = '8858684826179', MAT1 = 'A112101UT0450XK';

/** รอบสะอาด 1 เครื่อง: เปิดรอบ → นำเข้า → อนุมัติ → จับคู่ */
function setup(project, type) {
  const env = createEnv();
  const { sap, pos } = loadSamples(env.ctx.Core);
  const run = (c, v) => env.run(c, Object.assign({ _sap: sap, _pos: pos }, v || {}));
  run('setupSheets()');
  run(`apiOpenRound("${project}", "2026-11-04", "${type}")`);
  run('apiUpload("POS", _pos, { fileName: "pos.xls", fileDate: "2026-11-04" })');
  run('apiUpload("SAP", _sap, { fileName: "sap.xls", fileDate: "2026-11-04", d1Confirmed: true })');
  const st = run('apiGetState()');
  run(`apiApprove(${JSON.stringify(st.master.hash)}, ${JSON.stringify(st.master.checks.filter(c => c.level === 'WARN' && !c.pass).map(c => c.id))})`);
  env.sheets.Staff.data.push(['EMP-K', 'นาย ก', 'ผู้ตรวจสอบ', 'Y']);
  run('apiSeedDevices(1, "TC21")');
  const code = run('apiPairCode("TC21-01")').devices.find(x => x.id === 'TC21-01').pairCode;
  const token = env.post({ action: 'pair', deviceId: 'TC21-01', code }).token;
  const call = (action, body) => env.post(Object.assign({ action, deviceId: 'TC21-01', token, appVersion: '2.5.2' }, body || {}));
  let seq = 0, at = 1;
  const entries = [];
  const scan = (loc, qty) => { seq++; const e = { logId: 'TC21-01-' + String(seq).padStart(6, '0'), seq, projectId: project, staff: 'EMP-K', location: loc, barcode: BC1, material: MAT1, qty, type: 'SCAN', refId: '', reason: '', note: '', scanTime: '2026-11-04 10:00:' + String(seq).padStart(2, '0') }; entries.push(e); return e; };
  const ev = (t, loc, extra) => {
    const mine = entries.filter(e => e.location === loc);
    return Object.assign({ id: 'TC21-01-E' + at, at: at++, type: t, projectId: project, location: loc, staff: 'EMP-K', time: '2026-11-04 10:30:00', lines: mine.length,
      qty: mine.reduce((a, e) => a + e.qty, 0), fromSeq: 1, upToSeq: seq }, extra || {});
  };
  return { env, run, call, scan, ev };
}
const cfgOf = E => E.run('readConfig_()');
const logs = (E, a) => E.env.sheets.Admin_Log.data.filter(r => r[2] === a);

console.log('\nปิดรอบ — รอบทดลอง 2026Q4-R1 นับครบ ผ่าน K1–K7');
const E = setup('2026Q4-R1', 'PILOT');
E.call('sync', { entries: [E.scan('A1', 3), E.scan('A1', 2)], events: [E.ev('OPEN', 'A1')] });
E.call('sync', { entries: [], events: [E.ev('CLOSE', 'A1', { total: 5 })] });
const unk = E.scan('A2', 2); unk.barcode = '2999999999990'; unk.material = '';   // สินค้าที่ไม่มีในบัญชี 2 ชิ้น (v2.5.4: ผลต่างไม่นับรวม)
E.call('sync', { entries: [E.scan('A2', 4), unk], events: [E.ev('OPEN', 'A2')] });
E.call('sync', { entries: [], events: [E.ev('CLOSE', 'A2', { total: 6 })] });

test('เปิดรอบต้องเลือกประเภท · บันทึก ROUND_TYPE และ OPEN_ROUND บอกประเภท', () => {
  assert.strictEqual(cfgOf(E).ROUND_TYPE, 'PILOT');
  assert.ok(/รอบทดลอง/.test(logs(E, 'OPEN_ROUND').slice(-1)[0][4]));
  assert.throws(() => E.run('apiOpenRound("2026Q4-R1", "2026-11-04", "")'), /ประเภทรอบ/);
  const s = E.run('apiGetState()').round;
  assert.ok(s.type === 'PILOT' && s.typeTh === 'รอบทดลอง' && s.testAllowed === false);
});
test('ปิดรอบได้เฉพาะตอนปิดการนับแล้ว · ต้องพิมพ์ยืนยันตรง · ต้องมีรหัสผู้ตรวจสอบ', () => {
  assert.throws(() => E.run('apiCloseRound("EMP-K", "2026Q4-R1", false)'), /ปิดการนับแล้ว/);
  E.run('apiCountClose("EMP-K")');
  E.call('hello', { pending: 0, location: '' });
  E.run('apiReconcile()'); E.run('apiSummarySave()');
  assert.ok(E.run('apiCloseCheck()').ok, 'K1–K7 ผ่านครบ');
  assert.throws(() => E.run('apiCloseRound("EMP-K", "2026Q4", false)'), /พิมพ์ยืนยันไม่ตรง/);
  assert.throws(() => E.run('apiCloseRound("", "2026Q4-R1", false)'), /ผู้ตรวจสอบ/);
  assert.throws(() => E.run('apiCloseRound("EMP-K", "ล้างข้อมูลทดสอบ 2026Q4-R1", true)'), /โหมดรอบทดสอบใช้ได้เฉพาะรอบ 2026Q4/);
});
test('สำเนาไฟล์ไม่สำเร็จ → หยุด ไม่ล้างอะไร · บันทึก CLOSE_ROUND_START_FAILED', () => {
  const n = E.env.sheets.Count_Log.data.length;
  E.env.copyCfg.fail = 'Drive quota';
  assert.throws(() => E.run('apiCloseRound("EMP-K", "2026Q4-R1", false)'), /Drive quota/);
  delete E.env.copyCfg.fail;
  assert.ok(cfgOf(E).ROUND_STATUS === 'COUNT_CLOSED' && E.env.sheets.Count_Log.data.length === n);
  assert.ok(logs(E, 'CLOSE_ROUND_START_FAILED').length === 1);
});
test('ไฟล์สำเนาไม่ตรง (จำลองแถวหาย) → ARCHIVE_VERIFY_FAILED · เปลี่ยนชื่อไฟล์ "ตรวจไม่ผ่าน" · ไม่ล้างอะไร', () => {
  const n = E.env.sheets.Count_Log.data.length;
  E.env.copyCfg.tamper = b => { b.sheets.Count_Log.data.pop(); };
  assert.throws(() => E.run('apiCloseRound("EMP-K", "2026Q4-R1", false)'), /ตรวจไฟล์สำรองไม่ผ่าน.*Count_Log/);
  delete E.env.copyCfg.tamper;
  const bad = Object.values(E.env.books).filter(b => /ตรวจไม่ผ่าน/.test(b.name));
  assert.strictEqual(bad.length, 1);
  assert.ok(cfgOf(E).ROUND_STATUS === 'COUNT_CLOSED' && E.env.sheets.Count_Log.data.length === n && !E.env.sheets.Count_History.data.slice(1).length);
  assert.ok(/ไม่ล้างชีตใด ๆ/.test(logs(E, 'ARCHIVE_VERIFY_FAILED').slice(-1)[0][4]));
});
let res, copy;
test('ล้างชีตหลุดกลางทาง → สถานะ CLOSING · Count_History เขียนแล้ว 1 แถว · กดอีกครั้งทำต่อ ไม่สำรองซ้ำ ไม่เขียนประวัติซ้ำ', () => {
  const orig = E.env.ctx.writeTable_;
  let cnt = 0;
  E.env.ctx.writeTable_ = function (n) { if (n === 'Variance' && !cnt++) throw new Error('Exceeded maximum execution time'); return orig.apply(this, arguments); };
  assert.throws(() => E.run('apiCloseRound("EMP-K", "2026Q4-R1", false)'), /maximum execution time/);
  E.env.ctx.writeTable_ = orig;
  const nBooks = Object.keys(E.env.books).length;
  assert.strictEqual(cfgOf(E).ROUND_STATUS, 'CLOSING');
  assert.strictEqual(E.env.sheets.Count_History.data.length, 2, 'ประวัติ 1 แถว');
  assert.strictEqual(E.run('apiGetState()').round.statusTh, 'กำลังปิดรอบ (ค้าง)');
  res = E.run('apiCloseRound("EMP-K", "2026Q4-R1", false)');
  assert.strictEqual(Object.keys(E.env.books).length, nBooks, 'ไม่สำเนาซ้ำ');
  assert.strictEqual(E.env.sheets.Count_History.data.length, 2, 'ไม่เขียนประวัติซ้ำ');
  assert.ok(/ทำต่อจากที่ค้าง/.test(logs(E, 'CLOSE_ROUND_CLEAR').slice(-1)[0][4]));
});
test('หลังปิดรอบ: CLOSED · ชีตงานว่าง (เหลือหัวตาราง) · Staff / Devices / Admin_Log / Count_History คงอยู่ · ค่ารอบใน Config ว่าง', () => {
  const c = cfgOf(E), S = E.env.sheets;
  assert.ok(c.ROUND_STATUS === 'CLOSED' && c.PROJECT_ID === '2026Q4-R1' && !c.COUNT_CLOSED_AT && !c.SUMMARY_SAVED && !c.CLOSE_STATE && !c.MASTER_APPROVED_HASH && !c.SAP_FILE_NAME, JSON.stringify(c));
  ['Count_Log', 'Adjustments', 'Variance', 'Locations', 'Loc_Members', 'Loc_Checks', 'Barcode_Map', 'Device_Master', 'Dash_Data', 'Import_Files'].forEach(n =>
    assert.strictEqual(S[n].data.filter(r => r.some(v => v !== '')).length, 1, n));
  assert.ok(!S.SAP_Snapshot.data.length && !S.POS_Snapshot.data.length);
  assert.ok(S.Staff.data.length > 1 && S.Devices.data.some(r => r[0] === 'TC21-01'));
  assert.ok(logs(E, 'OPEN_ROUND').length >= 1 && logs(E, 'CLOSE_ROUND').length === 1, 'Admin_Log ต่อเนื่อง ไม่ถูกล้าง');
});
test('Count_History: ยอดบัญชี / สุดท้าย / ต่าง · ลิงก์ + checksum · ครั้งที่บันทึกผล · จำนวนรายการ · ผู้ปิด · ประเภท PILOT', () => {
  const t = E.run('table_("Count_History")'), h = E.run('rowObj_(table_("Count_History"), table_("Count_History").rows[0])');
  assert.ok(h.Project_ID === '2026Q4-R1' && h.Round_Type === 'PILOT' && h.Lines === '4' && h.Final_Run === '1' && /EMP-K/.test(h.Closed_By), JSON.stringify(h));
  assert.ok(/^Count_Log:[0-9a-f]{16}\|Adjustments:[0-9a-f]{16}\|Variance:[0-9a-f]{16}$/.test(h.Checksum), h.Checksum);
  assert.ok(h.Archive_ID && h.Archive_Link.indexOf(h.Archive_ID) >= 0);
  assert.strictEqual(Number(h.Net_Count), 11);
  // v2.5.4 (UAT G12-6): ผลต่างเท่ากับหน้าสรุปผล (ไม่รวมสินค้าที่ไม่มีในบัญชี) — เดิม Net − บัญชี ต่างกัน 2 ชิ้น
  const sv = logs(E, 'SUMMARY_SAVE').slice(-1)[0][4].match(/ต่าง (-?[\d.]+)/)[1];
  assert.strictEqual(Number(h.Diff_Qty), Number(sv), 'Diff_Qty ' + h.Diff_Qty + ' ≠ สรุปผล ' + sv);
  assert.strictEqual(Number(h.Diff_Qty), Number(h.Net_Count) - Number(h.SAP_Qty) - 2);
  copy = E.env.books[h.Archive_ID];
  assert.ok(/^ARCHIVED · 2026Q4-R1 · รอบทดลอง · ปิด \d{4}-\d{2}-\d{2}$/.test(copy.name), copy.name);
  const hs = E.run('apiGetState()').history;
  assert.ok(hs.length === 1 && hs[0].project === '2026Q4-R1' && hs[0].typeTh === 'รอบทดลอง');
});
test('ไฟล์สำรอง: Count_Log ครบ 4 รายการ · Config = ARCHIVED · Admin_Log เฉพาะรอบนี้ · ทุกชีตตั้ง protect แบบเตือน', () => {
  assert.strictEqual(copy.sheets.Count_Log.data.length, 5);
  assert.ok(copy.sheets.Config.data.some(r => r[0] === 'ROUND_STATUS' && r[1] === 'ARCHIVED') && copy.sheets.Config.data.some(r => r[0] === 'ARCHIVED_TYPE' && r[1] === 'PILOT'));
  const al = copy.sheets.Admin_Log.data.slice(1);
  assert.ok(al.length > 3 && al.every(r => r[5] === '2026Q4-R1' || r[2] === 'OPEN_ROUND' && r[3] === '2026Q4-R1'), JSON.stringify(al.filter(r => r[5] !== '2026Q4-R1').slice(0, 3)));
  assert.ok(!al.some(r => r[2] === 'SETUP'), 'แถวก่อนเปิดรอบไม่ติดไป');
  assert.ok(al.some(r => r[2] === 'CLOSE_ROUND_START'), 'แถวเริ่มปิดรอบอยู่ในไฟล์สำรอง');
  assert.ok(Object.values(copy.sheets).every(s => s.prot.length), 'ทุกชีตมี protect');
});
test('ตรวจไฟล์สำรองย้อนหลัง: ตรง → ✓ · มีคนแก้ Count_Log ในไฟล์สำรอง → ✗ · บันทึก ARCHIVE_CHECK', () => {
  let v = E.run('apiVerifyArchive("2026Q4-R1")');
  assert.ok(v.ok && v.rows.every(r => r.ok) && v.cfgOk, JSON.stringify(v));
  const keep = copy.sheets.Count_Log.data[1][8];
  copy.sheets.Count_Log.data[1][8] = '99';
  v = E.run('apiVerifyArchive("2026Q4-R1")');
  assert.ok(!v.ok && !v.rows[0].ok && v.rows[1].ok);
  copy.sheets.Count_Log.data[1][8] = keep;
  assert.ok(/ไม่ตรง — ถูกแก้หลังปิดรอบ/.test(logs(E, 'ARCHIVE_CHECK').slice(-1)[0][4]));
});
test('ในไฟล์สำรอง: ดูได้ · ทุกปุ่มที่เขียนข้อมูลถูกปฏิเสธ "ไฟล์สำรอง ดูอย่างเดียว"', () => {
  const real = E.env.ctx.SpreadsheetApp.getActive;
  E.env.ctx.SpreadsheetApp.getActive = () => copy;
  try {
    const s = E.run('apiGetState()');
    assert.ok(s.round.archived && s.round.statusTh === 'ไฟล์สำรอง (ดูอย่างเดียว)');
    assert.throws(() => E.run('apiCountReopen("EMP-K", "x")'), /ไฟล์สำรอง/);
    assert.throws(() => E.run('apiAdjust(_o)', { _o: { material: MAT1, qty: 1, reason: 'RECOUNT', note: '', location: '', staff: 'EMP-K' } }), /ไฟล์สำรอง/);
    assert.throws(() => E.run('logAdmin_("X", "-", "-")'), /ไฟล์สำรอง/);
  } finally { E.env.ctx.SpreadsheetApp.getActive = real; }
});
test('เครื่องหลังปิดรอบ: hello / sync ตอบ CLOSED · รายการที่หลุดส่งมาเก็บใน Quarantine ไม่เข้า Count_Log', () => {
  assert.strictEqual(E.call('hello', { pending: 1, location: '' }).round, 'CLOSED');
  const r = E.call('sync', { entries: [E.scan('A3', 1)], events: [] });
  assert.ok(r.round === 'CLOSED' && r.quarantined.length === 1 && !r.accepted.length, JSON.stringify(r));
  assert.strictEqual(E.env.sheets.Count_Log.data.length, 1);
});
test('เปิดรอบใหม่: รหัสที่ปิดแล้วใช้ซ้ำไม่ได้ (แนะนำรหัสถัดไป) · รหัสใหม่เปิดได้ บันทึกหน้า Admin เริ่มจากรอบใหม่', () => {
  assert.throws(() => E.run('apiOpenRound("2026Q4-R1", "2026-11-20", "PILOT")'), /ปิดรอบไปแล้ว ใช้ซ้ำไม่ได้.*2026Q4-R2/);
  const s = E.run('apiOpenRound("2026Q4-R2", "2026-11-20", "REAL")');
  assert.ok(s.round.status === 'SETUP' && s.round.type === 'REAL' && s.log.cur.length === 1 && s.log.cur[0][2] === 'OPEN_ROUND', JSON.stringify(s.log.cur));
  assert.ok(s.log.allCount > 20 && s.history.length === 1);
});

console.log('\nโหมดรอบทดสอบ — 2026Q4 ข้อมูลไม่ครบ (Location ค้าง) ข้าม K1 K2 K4 K5');
const T = setup('2026Q4', 'PILOT');
T.call('sync', { entries: [T.scan('B1', 2)], events: [T.ev('OPEN', 'B1')] });
test('รอบปกติปิดไม่ได้เพราะ K1 / K4 / K5 · โหมดทดสอบต้องพิมพ์ "ล้างข้อมูลทดสอบ 2026Q4"', () => {
  T.run('apiCountClose("EMP-K")'); T.call('hello', { pending: 0, location: 'B1' });
  assert.ok(T.run('apiGetState()').round.testAllowed);
  assert.throws(() => T.run('apiCloseRound("EMP-K", "2026Q4", false)'), /ยังปิดรอบไม่ได้.*K1/);
  assert.throws(() => T.run('apiCloseRound("EMP-K", "2026Q4", true)'), /ล้างข้อมูลทดสอบ 2026Q4/);
});
test('โหมดทดสอบยังบังคับ K3: เครื่องค้างส่ง → ปิดไม่ได้', () => {
  T.call('hello', { pending: 2, location: 'B1' });
  assert.throws(() => T.run('apiCloseRound("EMP-K", "ล้างข้อมูลทดสอบ 2026Q4", true)'), /K3/);
  T.call('hello', { pending: 0, location: 'B1' });
});
test('โหมดทดสอบสำเร็จ: Count_History ประเภท TEST · ชื่อไฟล์ "รอบทดสอบ" · Location ที่ค้างอยู่ครบในไฟล์สำรอง', () => {
  const r = T.run('apiCloseRound("EMP-K", "ล้างข้อมูลทดสอบ 2026Q4", true)');
  assert.ok(r.state.round.status === 'CLOSED' && r.closed.type === 'TEST');
  const h = T.run('apiGetState()').history[0];
  assert.ok(h.type === 'TEST' && /รอบทดสอบ/.test(T.env.books[r.closed.archiveId].name));
  assert.ok(T.env.books[r.closed.archiveId].sheets.Locations.data.some(x => x[0] === 'B1'));
  assert.ok(/ข้าม K1 K2 K4 K5/.test(logs(T, 'CLOSE_ROUND_START').slice(-1)[0][4]));
  assert.throws(() => T.run('apiOpenRound("2026Q4", "2026-12-01", "REAL")'), /ใช้ซ้ำไม่ได้/);
});

console.log('\nผล: ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail);
process.exit(fail ? 1 : 0);
