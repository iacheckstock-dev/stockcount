/**
 * Config ชื่อซ้ำ + อัปเกรดโครงสร้างชีตพร้อมกัน (v2.5.3 · จาก UAT 18 พ.ย.: SETUP 2 ครั้งห่าง 5 วินาที → ROUND_TYPE / CLOSE_STATE ซ้ำ)
 * node tests/config-test.js
 */
const assert = require('assert');
const { createEnv } = require('./gas-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
}
const keys = env => env.sheets.Config.data.slice(1).map(r => r[0]).filter(Boolean);
const count = (env, k) => keys(env).filter(x => x === k).length;
const logs = (env, a) => env.sheets.Admin_Log.data.filter(r => r[2] === a);

/** สภาพเหมือนไฟล์จริงหลัง Deploy v2.5.2: Config มี ROUND_TYPE / CLOSE_STATE ซ้ำ (ว่าง) และ SCHEMA_VERSION 9 */
function brokenFile() {
  const env = createEnv();
  env.run('setupSheets()');
  env.run('apiOpenRound("2026Q4", "2026-11-04", "PILOT")');
  env.sheets.Config.data.push(['ROUND_TYPE', '', 'ซ้ำ'], ['CLOSE_STATE', '', 'ซ้ำ']);
  env.run('setConfig_({ SCHEMA_VERSION: 9 })');
  return env;
}
/** จำลอง Deploy เวอร์ชันถัดไป: ชีตและ Script Properties บอกเวอร์ชันเก่า */
const olderDeploy = env => { env.run('setConfig_({ SCHEMA_VERSION: 9 }); PropertiesService.getScriptProperties().setProperty("SCHEMA_DONE", "9")'); };

console.log('Config ชื่อซ้ำ (v2.5.3)');
test('ชื่อซ้ำ: readConfig_ ใช้แถวแรก ตรงกับ setConfig_ ที่เขียนแถวแรก (เดิมอ่านแถวท้าย → ค่าที่บันทึกหาย)', () => {
  const env = brokenFile();
  env.run('setConfig_({ CLOSE_STATE: "{\\"a\\":1}" })');
  assert.strictEqual(env.run('readConfig_().CLOSE_STATE'), '{"a":1}');
  assert.strictEqual(env.run('readConfig_().ROUND_TYPE'), 'PILOT');
});
test('อัปเกรดโครงสร้าง (SCHEMA 9 → 10) ซ่อมแถวซ้ำ + Admin_Log CONFIG_DEDUP · ค่าเดิมอยู่ครบ', () => {
  const env = brokenFile();
  env.run('ensureSetup_()');
  assert.strictEqual(count(env, 'ROUND_TYPE'), 1);
  assert.strictEqual(count(env, 'CLOSE_STATE'), 1);
  assert.strictEqual(new Set(keys(env)).size, keys(env).length, 'ไม่มีชื่อซ้ำเลย');
  const L = logs(env, 'CONFIG_DEDUP');
  assert.strictEqual(L.length, 1);
  assert.ok(/2 แถว: ROUND_TYPE, CLOSE_STATE/.test(L[0][4]), L[0][4]);
  assert.strictEqual(env.run('readConfig_().ROUND_TYPE'), 'PILOT');
  assert.strictEqual(env.run('readConfig_().PROJECT_ID'), '2026Q4');
  assert.strictEqual(env.run('readConfig_().SCHEMA_VERSION'), String(env.run('SCHEMA_VERSION')));
  assert.strictEqual(env.run('PropertiesService.getScriptProperties().getProperty("SCHEMA_DONE")'), String(env.run('SCHEMA_VERSION')));
});
test('แถวแรกว่างแต่แถวที่ซ้ำมีค่า → ย้ายค่ามาแถวแรกก่อนลบ', () => {
  const env = createEnv();
  env.run('setupSheets()');
  const i = env.sheets.Config.data.findIndex(r => r[0] === 'ROUND_TYPE');
  env.sheets.Config.data[i][1] = '';
  env.sheets.Config.data.push(['ROUND_TYPE', 'REAL', '']);
  env.run('setupSheets()');
  assert.strictEqual(count(env, 'ROUND_TYPE'), 1);
  assert.strictEqual(env.run('readConfig_().ROUND_TYPE'), 'REAL');
  assert.ok(/ย้ายค่าจากแถวที่ซ้ำ: ROUND_TYPE/.test(logs(env, 'CONFIG_DEDUP')[0][4]));
});
test('ไม่มีชื่อซ้ำ → ไม่ลบอะไร ไม่บันทึก CONFIG_DEDUP', () => {
  const env = createEnv();
  env.run('setupSheets()'); env.run('setupSheets()');
  assert.strictEqual(logs(env, 'CONFIG_DEDUP').length, 0);
});

console.log('อัปเกรดพร้อมกัน 2 คำขอ (สิ่งที่เกิดจริง 18 พ.ย. 13:06:45 / 13:06:50)');
test('คำขอที่ 2 รอล็อก ระหว่างนั้นคำขอแรกอัปเกรดเสร็จ → คำขอที่ 2 ตรวจซ้ำในล็อกแล้วข้าม (SETUP 1 ครั้ง ไม่มีแถวซ้ำ)', () => {
  const env = brokenFile();
  env.run('ensureSetup_()');   // ซ่อมสภาพเดิมก่อน แล้วจำลองการ Deploy ครั้งถัดไป
  olderDeploy(env);
  const before = keys(env).length, setup0 = logs(env, 'SETUP').length;
  // คำขอที่ 2 ผ่านการตรวจนอกล็อก (ยังเป็น 9) แล้วรอล็อก — ตอนได้ล็อก คำขอแรกอัปเกรดเสร็จไปแล้ว
  const L = env.ctx.LockService, orig = L.getScriptLock;
  let first = true;
  L.getScriptLock = () => { const lk = orig(); const t = lk.tryLock; lk.tryLock = ms => { if (first) { first = false; L.getScriptLock = orig; env.run('ensureSetup_()'); } return t(ms); }; return lk; };
  env.run('ensureSetup_()');
  L.getScriptLock = orig;
  assert.strictEqual(logs(env, 'SETUP').length - setup0, 1, 'SETUP ครั้งเดียว');
  assert.strictEqual(keys(env).length, before);
  assert.strictEqual(new Set(keys(env)).size, keys(env).length);
});
test('คำขอจากเครื่อง (doPost) อ่าน Config ใหม่ในล็อก ไม่ใช้ค่าที่จำไว้ก่อนได้ล็อก', () => {
  const env = createEnv();
  env.run('setupSheets()');
  env.run('setConfig_({ SCHEMA_VERSION: 9 })');
  const setup0 = logs(env, 'SETUP').length;
  env.run('REQ_ = {}; readConfig_(); setConfig_({ SCHEMA_VERSION: SCHEMA_VERSION }); REQ_.cfg.SCHEMA_VERSION = "9"; ensureSetup_(); REQ_ = null;');
  assert.strictEqual(logs(env, 'SETUP').length, setup0, 'ค่าที่จำไว้บอก 9 แต่ชีตเป็น 10 แล้ว → ไม่อัปเกรดซ้ำ');
});
test('v2.5.4 (Executions 14:33:07 / 14:33:19): คำขอที่ 2 ได้ล็อกหลังคำขอแรกอัปเกรดเสร็จ แต่อ่านชีตได้ค่าเก่า → ใช้ Script Properties แล้วข้าม', () => {
  const env = createEnv();
  env.run('setupSheets()');
  env.run('ensureSetup_()');
  olderDeploy(env);
  const setup0 = logs(env, 'SETUP').length;
  const L = env.ctx.LockService, orig = L.getScriptLock;
  let first = true;
  L.getScriptLock = () => { const lk = orig(); const t = lk.tryLock; lk.tryLock = ms => {
    if (first) {   // ระหว่างรอล็อก: คำขอแรกอัปเกรดเสร็จ · จากนั้นคำขอนี้อ่านชีตได้ SCHEMA_VERSION เก่า (สิ่งที่เกิดจริง)
      first = false; L.getScriptLock = orig; env.run('ensureSetup_()');
      env.run('var _rc0 = readConfig_; readConfig_ = function () { var o = _rc0(); o.SCHEMA_VERSION = "9"; return o; }');
    }
    return t(ms); }; return lk; };
  env.run('ensureSetup_()');
  env.run('readConfig_ = _rc0');
  L.getScriptLock = orig;
  assert.strictEqual(logs(env, 'SETUP').length - setup0, 1, 'SETUP ครั้งเดียว (v2.5.3 ได้ 2 ครั้ง)');
});
test('ไฟล์เดิมที่ยังไม่มี SCHEMA_DONE แต่ชีตอัปเกรดแล้ว → ไม่อัปเกรดซ้ำ และบันทึก SCHEMA_DONE', () => {
  const env = createEnv();
  env.run('setupSheets()');
  env.run('setConfig_({ SCHEMA_VERSION: SCHEMA_VERSION }); PropertiesService.getScriptProperties().deleteProperty("SCHEMA_DONE")');
  const setup0 = logs(env, 'SETUP').length;
  env.run('setConfig_({ SCHEMA_VERSION: 9 })');   // นอกล็อกเห็นว่าต้องอัปเกรด
  env.run('var _rc1 = readConfig_; var _n = 0; readConfig_ = function () { var o = _rc1(); if (_n++ === 0) return o; o.SCHEMA_VERSION = String(SCHEMA_VERSION); return o; }');
  env.run('ensureSetup_(); readConfig_ = _rc1');
  assert.strictEqual(logs(env, 'SETUP').length, setup0);
  assert.strictEqual(env.run('PropertiesService.getScriptProperties().getProperty("SCHEMA_DONE")'), String(env.run('SCHEMA_VERSION')));
});
test('ชีตหาย (เช่น ลบชีตเอง) → อัปเกรด/ซ่อมได้แม้ SCHEMA_DONE เป็นเวอร์ชันล่าสุด', () => {
  const env = createEnv();
  env.run('setupSheets()'); env.run('ensureSetup_()');
  const ss = env.ctx.SpreadsheetApp.getActive();
  ss.deleteSheet(ss.getSheetByName('Quarantine'));
  assert.ok(!ss.getSheetByName('Quarantine'), 'ลบชีตในการจำลองได้จริง');
  env.run('ensureSetup_()');
  assert.ok(ss.getSheetByName('Quarantine'), 'สร้างชีตที่หายกลับมา');
});
test('ล็อกไม่ว่าง 60 วินาที → แจ้งข้อความ ไม่อัปเกรดนอกล็อก', () => {
  const env = createEnv();
  env.run('setupSheets()');
  env.run('setConfig_({ SCHEMA_VERSION: 9 })');
  const L = env.ctx.LockService, orig = L.getScriptLock;
  L.getScriptLock = () => ({ tryLock: () => false, releaseLock: () => {} });
  assert.throws(() => env.run('ensureSetup_()'), /กำลังอัปเกรดโครงสร้างชีต/);
  L.getScriptLock = orig;
  assert.strictEqual(env.run('readConfig_().SCHEMA_VERSION'), '9');
});

console.log(`\nผล: ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
process.exit(fail ? 1 : 0);
