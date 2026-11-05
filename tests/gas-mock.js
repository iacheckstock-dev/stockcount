/**
 * จำลอง Apps Script ทั้ง flow บน Node (ไม่ต้องมีบัญชี Google)
 * SAMPLE_SAP=... SAMPLE_POS=... node tests/gas-mock.js
 */
const fs = require('fs'), assert = require('assert');
const { createEnv, loadSamples } = require('./gas-env');
const { ctx, sheets, run: run0, post } = createEnv();
const { sap: sapRows, pos: posRows } = loadSamples(ctx.Core);
const run = code => run0(code, { _sap: sapRows, _pos: posRows });
let s;
run('setupSheets()');
assert.ok(!sheets['ชีต1'], 'ลบชีตว่างเริ่มต้น');
assert.strictEqual(Object.keys(sheets).length, Object.keys(run("SHEETS")).length);
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
assert.strictEqual(s.master.deviceCount, 2330);
run('setConfig_({ ROUND_STATUS: "COUNTING" })');
assert.throws(() => run('resetRound_()'), /เริ่มนับแล้ว/);
console.log('ล้างรอบ: ผ่าน (และกันการล้างหลังเริ่มนับ)');
console.log('\nจำลอง Apps Script ผ่านครบ flow');
if (process.env.DUMP) {
  // ใส่ขัดแย้งตัวอย่างหนึ่งรายการเพื่อดูหน้าจอ
  fs.writeFileSync(process.env.DUMP, JSON.stringify({ state: s, compare: cmp }));
}
