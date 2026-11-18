/**
 * Code.gs — ฝั่งเซิร์ฟเวอร์ (Apps Script ผูกกับไฟล์ Google Sheets หลัก)
 * เฟส 1: สร้างชีต, เปิดรอบ, นำเข้า SAP/POS, Barcode_Map, ตรวจความพร้อม, ตัดสินขัดแย้ง, อนุมัติ Master
 *
 * หน้า Admin เปิดจากเมนู "ระบบตรวจนับ" ใน Sheets เท่านั้น จึงใช้ได้เฉพาะคนที่มีสิทธิ์แก้ไขไฟล์
 * (API สำหรับ TC21 จะเพิ่มในเฟส 2 แยกต่างหาก และต้องใช้ device token)
 */

var SCHEMA_VERSION = 11;   // 6 = v2.4.1 Variance.Barcode · 7 = v2.4.2 ชีต Adjustments · 8 = v2.5.0 Admin_Log.Project_ID · 9 = v2.5.2 Count_History คอลัมน์ปิดรอบ · 10 = v2.5.3 ซ่อม Config ซ้ำ · 11 = v2.5.4 สถานะอัปเกรดใน Script Properties (โครงสร้างชีตไม่เปลี่ยน — เลขขยับเพื่อให้อัปเกรดทำงานหนึ่งครั้งหลัง Deploy)

/**
 * เวอร์ชันของระบบ (ใช้เลขเดียวทั้งแอป TC21 และเซิร์ฟเวอร์ ตาม Semantic Versioning MAJOR.MINOR.PATCH)
 * ต้องตรงกับ APP_VERSION ใน app/app.js และ appVersion ใน app/config.json — ดู CHANGELOG.md
 */
var SYSTEM_VERSION = '2.5.4';

var SHEETS = {
  Config: ['Key', 'Value', 'Note'],
  Staff: ['Staff_Code', 'Name', 'Role', 'Active'],
  Devices: ['Device_ID', 'Name', 'Active', 'Last_Seq', 'Last_Sync', 'Gaps', 'App_Version', 'Last_Check_At', 'Last_Check',
    'Paired_At', 'Token_Hash', 'Pair_Code', 'Pair_Expires', 'Pair_Fails', 'Revoked_At', 'Revoke_Reason', 'Repaired_At'],
  Locations: ['Location', 'Zone', 'Status', 'Open_By', 'Counters', 'Devices', 'Opened_At', 'Closed_Time', 'Last_Check', 'Edits',
    'Updated_At', 'Owner', 'Members', 'Status_Detail', 'Flag', 'Flag_Check', 'Close_Cover', 'Close_Total'],
  // ผู้ดูแล/ผู้ช่วยต่อ Location ต่อเครื่อง (v2.2.0)
  Loc_Members: ['Project_ID', 'Location', 'Device_ID', 'Role', 'State', 'Staff', 'Joined_At', 'State_At', 'Cover_Seq', 'Sub_Lines',
    'Sub_Qty', 'Match', 'Sub_By', 'Ev_At', 'Updated_At'],
  // ประวัติทุกเหตุการณ์ของ Location: เปิด เข้าร่วม ส่งงาน พัก ปิด แก้ โอน (พร้อมผลตรวจยอดกับเครื่อง)
  Loc_Checks: ['Time', 'Project_ID', 'Device_ID', 'Location', 'Event', 'Staff', 'Dev_Lines', 'Dev_Qty', 'Srv_Lines', 'Srv_Qty',
    'Match', 'Up_To_Seq', 'Note'],
  Device_Checks: ['Time', 'Device_ID', 'Staff', 'App_Version', 'Result', 'Detail'],
  Quarantine: ['Received_Time', 'Device_ID', 'Log_ID', 'Project_ID', 'Payload', 'Reason'],
  SAP_Snapshot: null,
  POS_Snapshot: null,
  Barcode_Map: ['Barcode', 'Material', 'Cust_Mat', 'Name', 'Source', 'Source_TH', 'Book_Qty', 'Book_Source', 'SAP_Qty',
    'POS_Qty', 'Unit_Cost', 'SAP_IT', 'SAP_QI', 'SAP_BL', 'Retail_Price', 'Status'],
  Map_Decisions: ['Key', 'Type', 'Id', 'Decision', 'Decided_By', 'Decided_At'],
  SAP_POS_Compare: ['Material', 'Cust_Mat', 'Name', 'Status', 'SAP_Barcode', 'POS_Barcode', 'Final_Barcode', 'SAP_Qty',
    'POS_Qty', 'Diff', 'SAP_IT', 'SAP_QI', 'SAP_BL'],
  Master_Check: ['Time', 'Kind', 'Master_Hash', 'Level', 'Item', 'Count', 'Result', 'Note', 'By'],
  Device_Master: ['Barcode', 'Material', 'Cust_Mat', 'Name'],
  Count_Log: ['Log_ID', 'Project_ID', 'Device_ID', 'Seq', 'Staff_Code', 'Location', 'Barcode', 'Material', 'Qty',
    'Entry_Type', 'Ref_ID', 'Reason', 'Note', 'Scan_Time', 'Received_Time', 'Source', 'Entered_By', 'Requested_By', 'Basis'],
  Import_Files: ['Time', 'File_Name', 'Checksum', 'Lines', 'Existing', 'Added', 'By'],
  Dash_Data: ['Key', 'Value', 'Updated_At'],
  // v2.5.2: Final_Run = ผลสรุปครั้งที่ใช้ · Lines = รายการใน Count_Log · Round_Type = REAL / PILOT / TEST · Archive_ID = ไฟล์สำรอง
  Count_History: ['Project_ID', 'Count_Date', 'SAP_Qty', 'Net_Count', 'Diff_Qty', 'Diff_Value', 'Diff_Items', 'Edits',
    'Archive_Link', 'Checksum', 'Final_Run', 'Lines', 'Closed_At', 'Closed_By', 'Round_Type', 'Archive_ID'],
  // Project_ID (v2.5.0): รหัสรอบของแต่ละแถว — Admin_Log เก็บต่อเนื่องข้ามรอบ (ตัดสิน Q2 เฟส 4) หน้า Admin แสดงเฉพาะรอบปัจจุบัน
  Admin_Log: ['Time', 'By', 'Action', 'Target', 'Detail', 'Project_ID'],
  // ผลสรุปราย SKU ทุกครั้งที่กด "สรุปผลและบันทึก" (v2.4.0) — เก็บต่อท้าย ไม่เขียนทับ
  Variance: ['Run', 'Time', 'Project_ID', 'SAP_File', 'Material', 'Name', 'Book_Qty', 'Book_Source', 'Device_Qty', 'Adjust_Qty',
    'Final_Qty', 'Diff_Qty', 'Unit_Cost', 'Diff_Value', 'SAP_IT', 'SAP_QI', 'SAP_BL', 'Locations', 'Barcode'],
  // บรรทัดปรับยอดด้วยมือ (v2.4.2) — เขียนผ่านฟอร์มในหน้า Admin เท่านั้น เพิ่มอย่างเดียว คีย์ผิด = บรรทัดกลับรายการ (Ref_ID)
  Adjustments: ['Adj_ID', 'Time', 'Project_ID', 'Material', 'Name', 'Qty', 'Reason', 'Note', 'Location', 'Staff_Code', 'By', 'Ref_ID',
    'Book_Qty', 'Final_Before', 'Final_After']
};

// คอลัมน์ที่ต้องเป็นข้อความ (กันเลข 0 นำหน้าหาย / 8.85E+12)
var TEXT_COLS = {
  Barcode_Map: ['Barcode', 'Material', 'Cust_Mat'],
  SAP_POS_Compare: ['Material', 'Cust_Mat', 'SAP_Barcode', 'POS_Barcode', 'Final_Barcode'],
  Device_Master: ['Barcode', 'Material', 'Cust_Mat'],
  Count_Log: ['Log_ID', 'Device_ID', 'Staff_Code', 'Location', 'Barcode', 'Material', 'Ref_ID'],
  Locations: ['Location'],
  Variance: ['Material', 'Barcode'],
  Adjustments: ['Adj_ID', 'Material', 'Location', 'Staff_Code', 'Ref_ID'],
  Loc_Checks: ['Device_ID', 'Location'],
  Loc_Members: ['Location', 'Device_ID'],
  Quarantine: ['Device_ID', 'Log_ID'],
  Staff: ['Staff_Code'],
  Devices: ['Device_ID', 'Pair_Code', 'Revoked_At', 'Repaired_At']
};

var CONFIG_DEFAULTS = [
  ['SCHEMA_VERSION', SCHEMA_VERSION, 'เวอร์ชันโครงสร้างชีต'],
  ['PROJECT_ID', '', 'รหัสรอบนับ เช่น 2026Q4'],
  ['COUNT_DATE', '', 'วันนับ (yyyy-mm-dd) เทียบกับยอด SAP สิ้นวันก่อนหน้า'],
  ['ROUND_STATUS', 'NONE', 'NONE / SETUP / COUNTING / COUNT_CLOSED / CLOSED'],
  ['DRIVE_FOLDER_ID', '', 'โฟลเดอร์ Drive สำหรับไฟล์นำเข้าและ Archive'],
  ['SAP_FILE_NAME', '', ''], ['SAP_FILE_DATE', '', ''], ['SAP_UPLOADED_AT', '', ''], ['SAP_UPLOADED_BY', '', ''],
  ['SAP_D1_CONFIRMED', '', 'ผู้ดูแลยืนยันว่าบัญชีปิดยอด D−1 แล้วตอนอัปโหลด'],
  ['POS_FILE_NAME', '', ''], ['POS_FILE_DATE', '', ''], ['POS_UPLOADED_AT', '', ''], ['POS_UPLOADED_BY', '', ''],
  ['MASTER_APPROVED_HASH', '', 'checksum ของ Device_Master ที่อนุมัติ'],
  ['MASTER_APPROVED_VERSION', 0, 'เลขครั้งที่อนุมัติ'],
  ['MASTER_APPROVED_AT', '', ''], ['MASTER_APPROVED_BY', '', ''],
  ['MASTER_APPROVED_COUNT', '', 'จำนวนบาร์โค้ดที่ส่งลงเครื่อง'],
  ['MASTER_APPROVED_PROJECT', '', 'รอบนับที่อนุมัติ Master'],
  ['MASTER_APPROVED_ACK', '', 'คำเตือนที่รับทราบแล้ว (คั่นด้วย ,)'],
  ['APP_URL', 'https://iacheckstock-dev.github.io/stockcount/app/', 'ที่อยู่เว็บแอป TC21 (GitHub Pages)'],
  ['MEMBERS_MIGRATED', '', 'รอบที่ย้ายข้อมูล Location เป็นผู้ดูแล/ผู้ช่วยแล้ว (v2.2.0)'],
  ['API_URL', '', 'URL ของ Web app ที่เครื่องใช้ (Deployment ที่ Active ลงท้าย /exec) — ต้องตรงกับ app/config.json'],
  ['COUNT_CLOSED_AT', '', 'เวลากด "ปิดการนับ" (v2.5.0) · ว่าง = ยังไม่ปิด หรือเปิดการนับอีกครั้งแล้ว'],
  ['COUNT_CLOSED_BY', '', 'รหัสผู้ตรวจสอบที่กดปิดการนับ'],
  ['LAST_RECONCILE', '', 'ผลกระทบยอดทั้งรอบครั้งล่าสุด (JSON) — ใช้ตรวจเงื่อนไขปิดรอบ K4'],
  ['SUMMARY_SAVED', '', 'ผลสรุปที่บันทึกล่าสุด (JSON: project, run, at, sig) — ใช้ตรวจเงื่อนไขปิดรอบ K5'],
  ['ROUND_TYPE', '', 'ประเภทรอบ REAL = รอบจริง · PILOT = รอบทดลอง (เลือกตอนเปิดรอบ · v2.5.2)'],
  ['CLOSE_STATE', '', 'ข้อมูลระหว่างปิดรอบ (JSON) — ใช้ทำต่อเมื่อปิดรอบค้างกลางทาง · ว่าง = ไม่มีค้าง']
];

// ---------- เมนูและหน้า Admin ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ระบบตรวจนับ')
    .addItem('เปิดหน้า Admin', 'openAdmin')
    .addSeparator()
    .addItem('ตั้งค่าชีต (ครั้งแรก / ซ่อมชีตที่หาย)', 'setupSheets')
    .addItem('ล้างข้อมูลรอบนี้ เริ่มใหม่ (ก่อนเริ่มนับเท่านั้น)', 'resetRoundMenu')
    .addToUi();
}

function openAdmin() {
  ensureSetup_();
  var html = HtmlService.createTemplateFromFile('Admin').evaluate()
    .setWidth(1280).setHeight(860).setTitle('ระบบตรวจนับ — Admin');
  SpreadsheetApp.getUi().showModalDialog(html, 'ระบบตรวจนับ — Admin');
}

// ---------- สร้างชีต ----------

function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  var created = [];
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      created.push(name);
    }
    var header = SHEETS[name];
    if (header) migrateHeader_(sh, header);
    (TEXT_COLS[name] || []).forEach(function (col) {
      var c = header.indexOf(col) + 1;
      if (c > 0) sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
    });
    if (name !== 'Config' && name !== 'Staff' && name !== 'Map_Decisions') {
      var prot = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      if (!prot.length) sh.protect().setDescription('เขียนโดยระบบเท่านั้น').setWarningOnly(true);
    }
  });
  var cfg = ss.getSheetByName('Config');
  dedupeConfig_(cfg);
  var existing = readConfig_();
  var add = CONFIG_DEFAULTS.filter(function (r) { return !(r[0] in existing); });
  if (add.length) cfg.getRange(cfg.getLastRow() + 1, 1, add.length, 3).setValues(add);
  cfg.getRange('B:B').setNumberFormat('@');
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  if (!existing.DRIVE_FOLDER_ID) {
    var folder = DriveApp.createFolder(ss.getName() + '_Files');
    setConfig_({ DRIVE_FOLDER_ID: folder.getId() });
  }
  logAdmin_('SETUP', 'Sheets', created.length ? 'สร้างชีต: ' + created.join(', ') : 'ตรวจชีตครบแล้ว');
  try {
    SpreadsheetApp.getUi().alert('ตั้งค่าชีตเรียบร้อย' + (created.length ? '\nสร้างใหม่ ' + created.length + ' ชีต' : ''));
  } catch (e) { /* เรียกจาก editor ไม่มี UI */ }
  return created;
}

/** ชีตว่าง: เขียนหัวตารางใหม่ทั้งแถว / มีข้อมูลแล้ว: เติมคอลัมน์ที่ขาดต่อท้าย (ไม่ย้ายข้อมูลเดิม) */
function migrateHeader_(sh, header) {
  if (sh.getLastRow() <= 1) {
    if (sh.getMaxColumns() < header.length) sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
    if (sh.getLastColumn() > header.length) sh.getRange(1, header.length + 1, 1, sh.getLastColumn() - header.length).clearContent();
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#f0efec');
    sh.setFrozenRows(1);
    return;
  }
  var cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  var add = header.filter(function (h) { return cur.indexOf(h) < 0; });
  if (!add.length) return;
  var start = cur.length + 1;
  if (sh.getMaxColumns() < start + add.length - 1) sh.insertColumnsAfter(sh.getMaxColumns(), start + add.length - 1 - sh.getMaxColumns());
  sh.getRange(1, start, 1, add.length).setValues([add]).setFontWeight('bold').setBackground('#f0efec');
}

function missingSheets_() {
  var ss = SpreadsheetApp.getActive();
  return Object.keys(SHEETS).some(function (n) { return !ss.getSheetByName(n); });
}
function needSetup_() {
  if (missingSheets_()) return true;
  if (typeof REQ_ !== 'undefined' && REQ_) REQ_.cfg = null;   // อ่านใหม่จากชีต ไม่ใช้ค่าที่จำไว้ในคำขอนี้
  return Number(readConfig_().SCHEMA_VERSION || 0) < SCHEMA_VERSION;
}

/**
 * อัปเกรดโครงสร้างชีตหลัง Deploy เวอร์ชันใหม่ — ทำได้ทีละคำขอ (v2.5.3)
 * เดิม (v2.5.2 · 18 พ.ย. 13:06) TC21 2 เครื่องส่งคำขอพร้อมกันหลัง Deploy → ทั้งคู่เห็นว่ายังไม่อัปเกรด → อัปเกรดซ้ำ
 * → Config มี ROUND_TYPE / CLOSE_STATE ซ้ำ 2 แถว · ตอนนี้: ล็อกก่อน แล้วตรวจซ้ำในล็อก คำขอที่ตามมาเห็นว่าอัปเกรดแล้วก็ข้าม
 */
function ensureSetup_() {
  if (!needSetup_()) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) throw new Error('ระบบกำลังอัปเกรดโครงสร้างชีต ลองใหม่อีกครั้งในไม่กี่วินาที');
  try {
    // v2.5.4 (UAT 12 · Executions 14:33:07 / 14:33:19): คำขอที่รอล็อกอ่านชีตซ้ำแล้วยังได้ SCHEMA_VERSION เก่า → อัปเกรดซ้ำ
    // จึงตรวจสถานะ "อัปเกรดเสร็จ" จาก Script Properties (อ่านค่าล่าสุดเสมอ ไม่ผ่านชีต) ก่อน
    var props = PropertiesService.getScriptProperties();
    if (Number(props.getProperty('SCHEMA_DONE') || 0) >= SCHEMA_VERSION && !missingSheets_()) return;
    if (!needSetup_()) { props.setProperty('SCHEMA_DONE', String(SCHEMA_VERSION)); return; }
    setupSheets();
    setConfig_({ SCHEMA_VERSION: SCHEMA_VERSION });
    props.setProperty('SCHEMA_DONE', String(SCHEMA_VERSION));
  } finally { releaseLock_(lock); }
}

/**
 * ซ่อม Config ที่ชื่อซ้ำ (v2.5.3): เก็บแถวแรกของแต่ละชื่อ · ถ้าแถวแรกว่างแต่แถวที่ซ้ำมีค่า ย้ายค่ามาแถวแรก · ลบแถวที่ซ้ำ
 * บันทึก Admin_Log CONFIG_DEDUP — ไม่มีซ้ำ = ไม่ทำอะไร
 */
function dedupeConfig_(sh) {
  var n = sh.getLastRow();
  if (n < 3) return [];
  var rows = sh.getRange(2, 1, n - 1, 2).getDisplayValues(), first = {}, drop = [], fixed = [];
  rows.forEach(function (r, i) {
    var k = r[0];
    if (!k) return;
    if (!(k in first)) { first[k] = i; return; }
    var f = first[k];
    if (rows[f][1] === '' && r[1] !== '') { sh.getRange(f + 2, 2).setValue(r[1]); rows[f][1] = r[1]; fixed.push(k); }
    drop.push(i);
  });
  if (!drop.length) return [];
  for (var j = drop.length - 1; j >= 0; j--) sh.deleteRow(drop[j] + 2);
  var keys = drop.map(function (i) { return rows[i][0]; });
  logAdmin_('CONFIG_DEDUP', 'Config', 'ลบแถวชื่อซ้ำ ' + drop.length + ' แถว: ' + keys.join(', ') + (fixed.length ? ' · ย้ายค่าจากแถวที่ซ้ำ: ' + fixed.join(', ') : ' · แถวที่ลบไม่มีค่า'));
  return keys;
}

// ---------- Config / Log ----------

function readConfig_() {
  // ในคำขอจากเครื่อง อ่านครั้งเดียวต่อคำขอ (v2.3.5) — คืนสำเนา ผู้เรียกแก้ได้โดยไม่กระทบกัน
  if (typeof REQ_ !== 'undefined' && REQ_ && REQ_.cfg) return Object.assign({}, REQ_.cfg);
  var sh = SpreadsheetApp.getActive().getSheetByName('Config');
  var out = {};
  if (!sh) return out;
  var n = sh.getLastRow();
  if (n >= 2) sh.getRange(2, 1, n - 1, 2).getDisplayValues().forEach(function (r) {
    if (r[0] && !(r[0] in out)) out[r[0]] = r[1];   // v2.5.3: ชื่อซ้ำ ใช้แถวแรก — ตรงกับ setConfig_ ที่เขียนแถวแรก
  });
  if (typeof REQ_ !== 'undefined' && REQ_) REQ_.cfg = Object.assign({}, out);
  return out;
}

function setConfig_(obj) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Config');
  var keys = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  Object.keys(obj).forEach(function (k) {
    var i = keys.indexOf(k);
    var v = obj[k] === null || obj[k] === undefined ? '' : String(obj[k]);
    if (i >= 0) sh.getRange(i + 2, 2).setValue(v);
    else { appendRows_(sh, [[k, v, '']]); keys.push(k); }
    if (typeof REQ_ !== 'undefined' && REQ_ && REQ_.cfg) REQ_.cfg[k] = v;
  });
}

function who_() {
  return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'unknown';
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
}
/** เวลา (ms) → รูปแบบเดียวกับ now_() เทียบเป็นข้อความได้ (v2.5.1) */
function ts_(ms) {
  return Utilities.formatDate(new Date(ms), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * บันทึก Admin_Log แบบตรวจว่าเขียนติดจริง (v2.3.8)
 * UAT 12 พ.ย.: ตอนชีต Admin_Log มี filter เปิดอยู่ appendRow ทำงานจบโดยไม่ error แต่แถวไม่ถูกบันทึก (หลักฐานหายเงียบ)
 * → เขียนเองที่แถวถัดจากแถวสุดท้าย แล้วอ่านกลับ ถ้าไม่ตรง = ล้มเหลว (throw) — ผู้เรียกที่เป็นการกระทำของหัวหน้าทีมจะหยุดทันที
 */
function logAdmin_(action, target, detail) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Admin_Log');
  if (!sh) throw new Error('ไม่พบชีต Admin_Log — บันทึกการกระทำไม่ได้');
  if (archived_()) throw new Error('นี่คือไฟล์สำรองของรอบที่ปิดแล้ว — ดูได้อย่างเดียว');
  var row = [now_(), who_(), action, String(target || ''), String(detail || ''), readConfig_().PROJECT_ID || ''];
  var r = appendRows_(sh, [row]);
  SpreadsheetApp.flush();
  var got = sh.getRange(r, 3, 1, 2).getValues()[0];
  if (String(got[0]) !== row[2] || String(got[1]) !== row[3]) {
    var why = 'บันทึก Admin_Log ไม่สำเร็จ (' + action + ' ' + row[3] + ')' + (sh.getFilter && sh.getFilter() ? ' — ชีต Admin_Log มี filter เปิดอยู่ ให้ปิดก่อน (Data → Remove filter)' : '');
    logFallback_(row, why);
    throw new Error(why + ' — ยกเลิกการกระทำนี้แล้ว ยังไม่มีอะไรเปลี่ยน');
  }
}

/** บันทึกของระบบ (ไม่ใช่การกดของหัวหน้าทีม เช่น INDEX_FIX, การจับคู่จากเครื่อง): ห้ามทำให้งานหลักล้ม แต่ห้ามเงียบ → สำรองไว้ใน Loc_Checks + เตือนในหน้า Admin */
function logSys_(action, target, detail) {
  try { logAdmin_(action, target, detail); } catch (e) { /* logAdmin_ เก็บสำรองและตั้งเตือนแล้ว */ }
}

/** เก็บบันทึกที่เขียน Admin_Log ไม่ติดไว้ใน Loc_Checks (Event ADMIN_LOG_FAIL) และตั้งคำเตือนให้หน้า Admin แสดงจนกว่าจะกดรับทราบ */
function logFallback_(row, why) {
  try {
    appendRows_(SpreadsheetApp.getActive().getSheetByName('Loc_Checks'),
      [[row[0], readConfig_().PROJECT_ID, 'ADMIN', '-', 'ADMIN_LOG_FAIL', row[1], '', '', '', '', '', '', row[2] + ' · ' + row[3] + ' · ' + row[4]]]);
  } catch (e) { }
  try {
    var p = PropertiesService.getScriptProperties(), w = JSON.parse(p.getProperty('ADMIN_LOG_WARN') || '{"n":0}');
    w.n++; w.last = row[0]; w.what = row[2] + ' ' + row[3]; w.why = why;
    p.setProperty('ADMIN_LOG_WARN', JSON.stringify(w));
  } catch (e) { }
}

/** การกระทำของหัวหน้าทีม: บันทึกก่อน แล้วค่อยทำ (fail closed) · ทำไม่สำเร็จ → บันทึก _FAILED ตามหลัง */
function adminAct_(action, target, detail, fn) {
  logAdmin_(action, target, detail);
  try { return fn(); } catch (e) {
    try { logAdmin_(action + '_FAILED', target, String(e && e.message || e).slice(0, 300)); } catch (e2) { }
    throw e;
  }
}

function adminLogWarn_() {
  try { var v = PropertiesService.getScriptProperties().getProperty('ADMIN_LOG_WARN'); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

/** หน้า Admin กดรับทราบคำเตือนบันทึกหาย (บันทึกผู้กด) */
function apiAckLogWarn() {
  return withLock_(function () {
    var w = adminLogWarn_();
    logAdmin_('ADMIN_LOG_WARN_ACK', '-', 'รับทราบ: บันทึก Admin_Log ไม่สำเร็จ ' + (w ? w.n + ' ครั้ง ล่าสุด ' + w.last + ' (' + w.what + ')' : '') + ' — รายละเอียดสำรองใน Loc_Checks (ADMIN_LOG_FAIL)');
    PropertiesService.getScriptProperties().deleteProperty('ADMIN_LOG_WARN');
    return apiDevicesState();
  });
}

function withLock_(fn) {
  // v2.5.2: ไฟล์สำรอง (ARCHIVED) ดูอย่างเดียว — ทุกปุ่มที่เขียนข้อมูลใช้ withLock_ จึงกันที่นี่จุดเดียว
  if (archived_()) throw new Error('นี่คือไฟล์สำรองของรอบที่ปิดแล้ว — ดูได้อย่างเดียว แก้ไขไม่ได้');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('มีคนกำลังบันทึกข้อมูลอยู่ ลองใหม่อีกครั้ง');
  try { return fn(); } finally { releaseLock_(lock); }
}

/**
 * ปล่อยล็อกหลังสั่งให้ Sheets บันทึกการเขียนที่ค้างในคิวให้เสร็จก่อน (SpreadsheetApp.flush)
 * ไม่อย่างนั้นคำขอถัดไปที่ได้ล็อกอาจยังไม่เห็นแถวที่เพิ่งเขียน แล้วเขียนทับแถวเดียวกัน
 * — ตามคำแนะนำในเอกสาร LockService ของ Google (v2.2.1)
 */
function releaseLock_(lock) {
  try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
}

// ---------- อ่าน/เขียนตาราง ----------

function writeTable_(name, header, rows) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  sh.clearContents();
  var width = header ? header.length : rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
  var data = (header ? [header] : []).concat(rows).map(function (r) {
    var out = new Array(width);
    for (var i = 0; i < width; i++) out[i] = r[i] === undefined || r[i] === null ? '' : r[i];
    return out;
  });
  if (!data.length) return;
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  if (sh.getMaxRows() < data.length) sh.insertRowsAfter(sh.getMaxRows(), data.length - sh.getMaxRows());
  if (!header) sh.getRange(1, 1, data.length, width).setNumberFormat('@');
  sh.getRange(1, 1, data.length, width).setValues(data);
  if (header) sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#f0efec');
}

function readRaw_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() === 0) return [];
  return sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
}

function readDecisions_() {
  var rows = readRaw_('Map_Decisions');
  var out = {};
  rows.slice(1).forEach(function (r) { if (r[0]) out[r[0]] = r[3]; });
  return out;
}

function hash_(obj) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(obj), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 16);
}

// ---------- คำนวณ Master จาก snapshot ----------

function computeMaster_() {
  var cfg = readConfig_();
  var sapRows = readRaw_('SAP_Snapshot');
  var posRows = readRaw_('POS_Snapshot');
  var sap = sapRows.length ? Core.parseSap(sapRows) : null;
  var pos = posRows.length ? Core.parsePos(posRows) : null;
  var m = Core.buildMaster(sap, pos, readDecisions_(), {
    projectId: cfg.PROJECT_ID, countDate: cfg.COUNT_DATE, sapFileDate: cfg.SAP_FILE_DATE, posFileDate: cfg.POS_FILE_DATE
  });
  m.deviceRows = Core.deviceMasterRows(m.rows);
  // checksum คิดจากคู่ บาร์โค้ด→Material เท่านั้น ชื่อสินค้าที่เปลี่ยนตอนอัปโหลด SAP ไม่ทำให้ต้องอนุมัติใหม่
  m.hash = m.deviceRows.length ? hash_(m.deviceRows.map(function (r) { return [r[0], r[1]]; })) : '';
  m.cfg = cfg;
  return m;
}

/** เขียน Barcode_Map, SAP_POS_Compare และผลตรวจลงชีต หลังทุกครั้งที่ข้อมูลเปลี่ยน */
function persistMaster_(m, reason) {
  writeTable_('Barcode_Map', SHEETS.Barcode_Map, m.rows.map(function (r) {
    return [r.barcode, r.material, r.custMat, r.name, r.source, r.sourceTh, r.bookQty, r.bookSource, r.sapQty, r.posQty,
      r.unitCost, r.sapIT, r.sapQI, r.sapBL, r.price, Core.STATUS_TH[r.status] || r.status];
  }));
  writeTable_('SAP_POS_Compare', SHEETS.SAP_POS_Compare, m.compare.map(function (c) {
    return [c.material, c.custMat, c.name, c.statusTh, c.sapBarcodes, c.posBarcode, c.finalBarcodes, c.sapQty, c.posQty,
      c.diff, c.sapIT, c.sapQI, c.sapBL];
  }));
  var sh = SpreadsheetApp.getActive().getSheetByName('Master_Check');
  var t = now_(), by = who_();
  var rows = m.checks.map(function (c) {
    return [t, 'CHECK: ' + reason, m.hash, c.level, c.title, c.count, c.pass ? 'ผ่าน' : ({ BLOCK: 'บล็อก', WARN: 'เตือน', INFO: 'แจ้งให้ทราบ' }[c.level] || c.level), c.note, by];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

// ---------- API ที่หน้า Admin เรียก ----------

function apiGetState() {
  ensureSetup_();
  var m = computeMaster_();
  var cfg = m.cfg;
  var log = readRaw_('Admin_Log');
  return {
    user: who_(),
    version: SYSTEM_VERSION,
    logWarn: adminLogWarn_(),
    spreadsheetUrl: SpreadsheetApp.getActive().getUrl(),
    round: { projectId: cfg.PROJECT_ID, countDate: cfg.COUNT_DATE, status: cfg.ROUND_STATUS || 'NONE',
      statusTh: ROUND_STATUS_TH[cfg.ROUND_STATUS || 'NONE'] || cfg.ROUND_STATUS, closedAt: cfg.COUNT_CLOSED_AT || '', closedBy: cfg.COUNT_CLOSED_BY || '',
      type: cfg.ROUND_TYPE || '', typeTh: ROUND_TYPE_TH[cfg.ROUND_TYPE] || '', testAllowed: TEST_ROUND_IDS.indexOf(cfg.PROJECT_ID) >= 0,
      archived: cfg.ROUND_STATUS === 'ARCHIVED', archivedType: cfg.ARCHIVED_TYPE || '',
      closeType: (function () { try { return (JSON.parse(cfg.CLOSE_STATE || 'null') || {}).type || ''; } catch (e) { return ''; } })() },
    history: historyRows_().map(function (h) {
      return { project: h.Project_ID, countDate: h.Count_Date, book: h.SAP_Qty, final: h.Net_Count, diffQty: h.Diff_Qty, diffValue: h.Diff_Value, diffItems: h.Diff_Items,
        edits: h.Edits, url: h.Archive_Link, checksum: h.Checksum, run: h.Final_Run, lines: h.Lines, at: h.Closed_At, by: h.Closed_By, type: h.Round_Type || '', typeTh: ROUND_TYPE_TH[h.Round_Type] || '' };
    }),
    staff: activeStaff_(),
    files: {
      sap: { name: cfg.SAP_FILE_NAME, date: cfg.SAP_FILE_DATE, at: cfg.SAP_UPLOADED_AT, by: cfg.SAP_UPLOADED_BY, d1: cfg.SAP_D1_CONFIRMED },
      pos: { name: cfg.POS_FILE_NAME, date: cfg.POS_FILE_DATE, at: cfg.POS_UPLOADED_AT, by: cfg.POS_UPLOADED_BY }
    },
    master: {
      hasSap: m.hasSap, hasPos: m.hasPos, hash: m.hash, deviceCount: m.deviceRows.length,
      checks: m.checks, canApprove: m.canApprove, blocking: m.blocking, counts: m.counts, stats: m.stats,
      conflicts: m.conflicts, pendingConflicts: m.pendingConflicts,
      approved: {
        hash: cfg.MASTER_APPROVED_HASH, version: cfg.MASTER_APPROVED_VERSION, at: cfg.MASTER_APPROVED_AT,
        by: cfg.MASTER_APPROVED_BY, count: cfg.MASTER_APPROVED_COUNT,
        project: cfg.MASTER_APPROVED_PROJECT, current: approvedCurrent_(cfg, m),
        ackIds: ackList_(cfg)
      },
      // คำเตือนที่เกิดหลังอนุมัติ (เช่น อัปโหลด SAP ทีหลังแล้วพบรหัสที่ต้องเติมบาร์โค้ด) ยังไม่มีใครรับทราบ
      newWarnings: approvedCurrent_(cfg, m) ? m.checks.filter(function (c) {
        return c.level === 'WARN' && !c.pass && ackList_(cfg).indexOf(c.id) < 0;
      }) : []
    },
    log: logView_(log, cfg.PROJECT_ID)
  };
}

/**
 * Admin_Log สำหรับหน้า Admin (v2.5.0): แถวก่อน v2.5.0 ไม่มี Project_ID → ใช้รอบจาก OPEN_ROUND ล่าสุดก่อนแถวนั้น (อ่านอย่างเดียว ไม่เขียนกลับ)
 * คืน { cur: 100 แถวล่าสุดของรอบปัจจุบัน, all: 100 แถวล่าสุดทุกรอบ, curCount, allCount } · แต่ละแถว [เวลา, ผู้ทำ, การกระทำ, เป้าหมาย, รายละเอียด, รอบ]
 */
function logView_(log, project) {
  var cur = '', rows = log.slice(1).filter(function (r) { return r[0] !== '' || r[2] !== ''; }).map(function (r) {
    var p = String(r[5] || '');
    if (r[2] === 'OPEN_ROUND') cur = String(r[3] || '');
    if (p) cur = p;
    return [r[0], r[1], r[2], r[3], r[4], p || cur];
  });
  var mine = project ? rows.filter(function (r) { return r[5] === project; }) : rows;
  // rowsProject: รอบของแต่ละแถว ตามลำดับแถวในชีต (รวมแถวว่าง) — ใช้ตัด Admin_Log ในไฟล์สำรอง (v2.5.2)
  var c2 = '', rowsProject = log.slice(1).map(function (r) { if (r[2] === 'OPEN_ROUND') c2 = String(r[3] || ''); if (r[5]) c2 = String(r[5]); return r[0] !== '' || r[2] !== '' ? c2 : ''; });
  return { cur: mine.slice(-100).reverse(), all: rows.slice(-100).reverse(), curCount: mine.length, allCount: rows.length, project: project || '', rowsProject: rowsProject };
}

function ackList_(cfg) {
  return String(cfg.MASTER_APPROVED_ACK || '').split(',').filter(String);
}

/** อนุมัติแล้วและยังใช้ได้: คู่บาร์โค้ด→รหัสไม่เปลี่ยน และเป็นรอบเดียวกัน */
function approvedCurrent_(cfg, m) {
  return !!cfg.MASTER_APPROVED_HASH && cfg.MASTER_APPROVED_HASH === m.hash && cfg.MASTER_APPROVED_PROJECT === cfg.PROJECT_ID;
}

/** รับทราบคำเตือนที่เกิดหลังอนุมัติ (ไม่เปลี่ยน Master ที่อนุมัติ) */
function apiAckWarnings(ids) {
  return withLock_(function () {
    var m = computeMaster_();
    var cfg = m.cfg;
    if (!approvedCurrent_(cfg, m)) throw new Error('Master ยังไม่ได้อนุมัติหรือมีการเปลี่ยนแปลง ให้อนุมัติใหม่แทน');
    var open = m.checks.filter(function (c) { return c.level === 'WARN' && !c.pass; });
    ids = (ids || []).filter(function (id) { return open.some(function (c) { return c.id === id; }); });
    if (!ids.length) throw new Error('ไม่มีคำเตือนที่เลือก');
    var acked = ackList_(cfg);
    ids.forEach(function (id) { if (acked.indexOf(id) < 0) acked.push(id); });
    setConfig_({ MASTER_APPROVED_ACK: acked.join(',') });
    var t = now_(), by = who_();
    var sh = SpreadsheetApp.getActive().getSheetByName('Master_Check');
    open.filter(function (c) { return ids.indexOf(c.id) >= 0; }).forEach(function (c) {
      appendRows_(sh, [[t, 'ACK หลังอนุมัติ v' + cfg.MASTER_APPROVED_VERSION, m.hash, c.level, c.title, c.count, 'รับทราบ', c.note, by]]);
    });
    logAdmin_('ACK_WARNING', 'v' + cfg.MASTER_APPROVED_VERSION, ids.join(', '));
    return apiGetState();
  });
}

function apiGetCompare() {
  var m = computeMaster_();
  return m.compare;
}

function apiOpenRound(projectId, countDate, roundType) {
  return withLock_(function () {
    projectId = String(projectId || '').trim().toUpperCase();
    countDate = String(countDate || '').trim();
    if (!/^\d{4}Q[1-4](-R\d+)?$/.test(projectId)) throw new Error('รหัสรอบต้องเป็นรูปแบบ 2026Q4 หรือ 2026Q4-R1');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(countDate)) throw new Error('วันนับไม่ถูกต้อง');
    // v2.5.2: เลือกประเภทรอบทุกครั้ง · รหัสที่ปิดรอบไปแล้วใช้ซ้ำไม่ได้ (เครื่องแยกข้อมูลตามรหัสรอบ — ซ้ำ = ข้อมูลเก่าปน)
    roundType = String(roundType || '').toUpperCase();
    if (roundType !== 'REAL' && roundType !== 'PILOT') throw new Error('เลือกประเภทรอบ: รอบจริง หรือ รอบทดลอง');
    if (historyRows_().some(function (h) { return h.Project_ID === projectId; })) throw new Error('รหัสรอบ ' + projectId + ' ปิดรอบไปแล้ว ใช้ซ้ำไม่ได้ — ใช้รหัสใหม่ เช่น ' + projectId.replace(/-R\d+$/, '') + '-R' + (Number((projectId.match(/-R(\d+)$/) || [0, 0])[1]) + 1));
    var cfg = readConfig_();
    var st = cfg.ROUND_STATUS || 'NONE';
    if (st !== 'NONE' && st !== 'SETUP' && st !== 'CLOSED') {
      throw new Error('รอบ ' + cfg.PROJECT_ID + ' อยู่ในสถานะ ' + st + ' ต้องปิดรอบก่อนจึงเปิดรอบใหม่ได้');
    }
    setConfig_({ PROJECT_ID: projectId, COUNT_DATE: countDate, ROUND_STATUS: 'SETUP', ROUND_TYPE: roundType });
    lxReset_();   // ดัชนี Count_Log ของรอบเดิมไม่ใช้ต่อ (v2.3.5)
    logAdmin_('OPEN_ROUND', projectId, ROUND_TYPE_TH[roundType] + ' · วันนับ ' + countDate + (st === 'SETUP' && cfg.PROJECT_ID ? ' (แก้จาก ' + cfg.PROJECT_ID + ' ' + cfg.COUNT_DATE + ')' : ''));
    return apiGetState();
  });
}

/**
 * kind: 'SAP' | 'POS'; rows: ตาราง 2 มิติจากเบราว์เซอร์; meta: { fileName, fileDate, d1Confirmed }
 */
function apiUpload(kind, rows, meta) {
  return withLock_(function () {
    meta = meta || {};
    if (kind !== 'SAP' && kind !== 'POS') throw new Error('ชนิดไฟล์ไม่ถูกต้อง');
    if (!rows || !rows.length) throw new Error('ไฟล์ว่าง');
    var parsed = kind === 'SAP' ? Core.parseSap(rows) : Core.parsePos(rows);
    if (!parsed.ok) throw new Error(parsed.error);
    if (kind === 'SAP' && !meta.d1Confirmed) throw new Error('ต้องยืนยันว่าบัญชีปิดยอด D−1 แล้วก่อนอัปโหลด SAP');

    // ตัดแถวว่างท้ายไฟล์ เก็บทุกค่าเป็นข้อความ ไม่แก้ข้อมูลต้นฉบับ
    var clean = rows.map(function (r) {
      return r.map(function (v) { return typeof v === 'number' ? String(v) : Core.str(v); });
    });
    writeTable_(kind + '_Snapshot', null, clean);

    var cfgUpdate = {};
    cfgUpdate[kind + '_FILE_NAME'] = meta.fileName || '';
    cfgUpdate[kind + '_FILE_DATE'] = meta.fileDate || '';
    cfgUpdate[kind + '_UPLOADED_AT'] = now_();
    cfgUpdate[kind + '_UPLOADED_BY'] = who_();
    if (kind === 'SAP') cfgUpdate.SAP_D1_CONFIRMED = who_() + ' ' + now_();
    setConfig_(cfgUpdate);

    // เก็บสำเนาไฟล์ที่นำเข้าใน Drive เป็นหลักฐาน
    try {
      var folderId = readConfig_().DRIVE_FOLDER_ID;
      if (folderId) {
        var csv = Core.toCsv(clean[0], clean.slice(1));
        DriveApp.getFolderById(folderId).createFile(
          Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd-HHmmss') + '_' + kind + '_' + (meta.fileName || 'upload') + '.csv',
          csv, MimeType.CSV);
      }
    } catch (e) { /* ไม่ให้การเก็บสำเนาทำให้การอัปโหลดล้ม */ }

    var m = computeMaster_();
    persistMaster_(m, 'อัปโหลด ' + kind);
    var count = kind === 'SAP' ? Object.keys(parsed.materials).length + ' รหัส (' + parsed.rowCount + ' แถว)' : parsed.rowCount + ' รหัส';
    logAdmin_('UPLOAD_' + kind, meta.fileName || '', count + (meta.fileDate ? ', ไฟล์ลงวันที่ ' + meta.fileDate : ''));
    return apiGetState();
  });
}

function apiDecide(key, decision) {
  return withLock_(function () {
    var m = computeMaster_();
    var c = m.conflicts.filter(function (x) { return x.key === key; })[0];
    if (!c) throw new Error('ไม่พบรายการขัดแย้งนี้แล้ว (ข้อมูลอาจเปลี่ยน) กรุณาโหลดหน้าใหม่');
    if (!c.options.some(function (o) { return o.value === decision; })) throw new Error('ตัวเลือกไม่ถูกต้อง');
    var sh = SpreadsheetApp.getActive().getSheetByName('Map_Decisions');
    var rows = readRaw_('Map_Decisions');
    var idx = -1;
    for (var i = 1; i < rows.length; i++) if (rows[i][0] === key) idx = i;
    var row = [key, c.type, c.id, decision, who_(), now_()];
    if (idx > 0) sh.getRange(idx + 1, 1, 1, row.length).setValues([row]);
    else appendRows_(sh, [row]);
    logAdmin_('DECIDE_CONFLICT', key, 'เลือก ' + decision + ' (' + c.detail + ')');
    persistMaster_(computeMaster_(), 'ตัดสินขัดแย้ง');
    return apiGetState();
  });
}

/** อนุมัติ Master: ต้องไม่มีรายการบล็อก, รับทราบคำเตือนครบ และ hash ตรงกับที่ผู้อนุมัติเห็น */
function apiApprove(seenHash, ackIds) {
  return withLock_(function () {
    var m = computeMaster_();
    if (!m.canApprove) throw new Error('ยังมีรายการระดับบล็อกค้างอยู่');
    if (!m.hash) throw new Error('ยังไม่มีบาร์โค้ดสำหรับส่งลงเครื่อง');
    if (seenHash !== m.hash) throw new Error('ข้อมูลเปลี่ยนไประหว่างที่เปิดหน้าอยู่ กรุณาตรวจอีกครั้ง');
    var warns = m.checks.filter(function (c) { return c.level === 'WARN' && !c.pass; }).map(function (c) { return c.id; });
    ackIds = ackIds || [];
    var notAck = warns.filter(function (id) { return ackIds.indexOf(id) < 0; });
    if (notAck.length) throw new Error('ยังไม่ได้กดรับทราบคำเตือน: ' + notAck.join(', '));

    var cfg = m.cfg;
    var version = (parseInt(cfg.MASTER_APPROVED_VERSION, 10) || 0) + 1;
    adminAct_('APPROVE_MASTER', 'v' + version, m.hash + ', ' + m.deviceRows.length + ' รายการ', function () {
    writeTable_('Device_Master', SHEETS.Device_Master, m.deviceRows);
    setConfig_({
      MASTER_APPROVED_HASH: m.hash, MASTER_APPROVED_VERSION: version, MASTER_APPROVED_AT: now_(),
      MASTER_APPROVED_BY: who_(), MASTER_APPROVED_COUNT: m.deviceRows.length,
      MASTER_APPROVED_PROJECT: cfg.PROJECT_ID, MASTER_APPROVED_ACK: warns.join(',')
    });
    var sh = SpreadsheetApp.getActive().getSheetByName('Master_Check');
    appendRows_(sh, [[now_(), 'APPROVE v' + version, m.hash, '', 'อนุมัติ Master', m.deviceRows.length, 'อนุมัติ',
      'รับทราบคำเตือน: ' + (warns.join(', ') || '-') + (m.hasSap ? '' : ' (ยอดชั่วคราวจาก POS)'), who_()]]);
    });
    return apiGetState();
  });
}

// ---------- ล้างข้อมูลรอบ (ใช้ได้เฉพาะก่อนเริ่มนับ) ----------

var RESET_CONFIG_KEYS = ['PROJECT_ID', 'COUNT_DATE', 'SAP_FILE_NAME', 'SAP_FILE_DATE', 'SAP_UPLOADED_AT', 'SAP_UPLOADED_BY',
  'SAP_D1_CONFIRMED', 'POS_FILE_NAME', 'POS_FILE_DATE', 'POS_UPLOADED_AT', 'POS_UPLOADED_BY', 'MASTER_APPROVED_HASH',
  'MASTER_APPROVED_AT', 'MASTER_APPROVED_BY', 'MASTER_APPROVED_COUNT', 'MASTER_APPROVED_PROJECT', 'MASTER_APPROVED_ACK'];

function resetRoundMenu() {
  var ui = SpreadsheetApp.getUi();
  var cfg = readConfig_();
  var res = ui.prompt('ล้างข้อมูลรอบ ' + (cfg.PROJECT_ID || '(ยังไม่เปิดรอบ)'),
    'จะล้าง: ไฟล์ SAP/POS ที่นำเข้า, Barcode_Map, การตัดสินขัดแย้ง, Master ที่อนุมัติ และข้อมูลรอบ\n' +
    'ไม่ล้าง: Admin_Log, Master_Check และสำเนาไฟล์ใน Drive (เก็บเป็นหลักฐาน)\n\nพิมพ์ RESET เพื่อยืนยัน',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  if (res.getResponseText().trim().toUpperCase() !== 'RESET') { ui.alert('ยกเลิก: ไม่ได้พิมพ์ RESET'); return; }
  try {
    resetRound_();
    ui.alert('ล้างข้อมูลรอบเรียบร้อย เปิดหน้า Admin แล้วเริ่มเปิดรอบใหม่ได้');
  } catch (e) {
    ui.alert(e.message);
  }
}

function resetRound_() {
  return withLock_(function () {
    var cfg = readConfig_();
    var st = cfg.ROUND_STATUS || 'NONE';
    if (st !== 'NONE' && st !== 'SETUP') {
      throw new Error('ล้างไม่ได้: รอบ ' + cfg.PROJECT_ID + ' เริ่มนับแล้ว (' + st + ') ข้อมูลการนับต้องเก็บไว้ ให้ปิดรอบตามขั้นตอนแทน');
    }
    var log = SpreadsheetApp.getActive().getSheetByName('Count_Log');
    if (log && log.getLastRow() > 1) throw new Error('ล้างไม่ได้: มีข้อมูลใน Count_Log แล้ว');

    ['SAP_Snapshot', 'POS_Snapshot'].forEach(function (n) { SpreadsheetApp.getActive().getSheetByName(n).clearContents(); });
    ['Barcode_Map', 'SAP_POS_Compare', 'Device_Master', 'Map_Decisions'].forEach(function (n) { writeTable_(n, SHEETS[n], []); });
    var blank = {};
    RESET_CONFIG_KEYS.forEach(function (k) { blank[k] = ''; });
    blank.ROUND_STATUS = 'NONE';
    setConfig_(blank);
    var mc = SpreadsheetApp.getActive().getSheetByName('Master_Check');
    appendRows_(mc, [[now_(), 'RESET', '', '', 'ล้างข้อมูลรอบ ' + (cfg.PROJECT_ID || ''), '', '', '', who_()]]);
    logAdmin_('RESET_ROUND', cfg.PROJECT_ID || '-', 'ล้างไฟล์นำเข้า, Barcode_Map, การตัดสิน และ Master ที่อนุมัติ (Admin_Log/Master_Check/Drive คงไว้)');
  });
}

// ---------- เครื่อง TC21 (หน้า Admin) ----------

function apiDevicesState() {
  ensureSetup_();
  var cfg = readConfig_();
  var t = table_('Devices');
  var devices = t.rows.filter(function (r) { return r[t.idx.Device_ID]; }).map(function (r) {
    var d = rowObj_(t, r);
    var pairLive = d.Pair_Code && Number(d.Pair_Expires) > Date.now();
    return {
      id: d.Device_ID, name: d.Name, active: d.Active === 'Y', paired: !!d.Token_Hash, lastSeq: d.Last_Seq, lastSync: d.Last_Sync,
      gaps: d.Gaps, appVersion: d.App_Version, lastCheckAt: d.Last_Check_At, lastCheck: d.Last_Check, pairedAt: d.Paired_At,
      pairCode: pairLive ? d.Pair_Code : '', pairExpires: pairLive ? Number(d.Pair_Expires) : 0,
      revokedAt: d.Revoked_At || '', revokeReason: d.Revoke_Reason || '', revokeReasonText: REVOKE_REASONS[d.Revoke_Reason] || '', repairedAt: d.Repaired_At || ''
    };
  });
  var hb = heartbeats_(devices.map(function (x) { return x.id; }));
  devices.forEach(function (x) { if (hb[x.id]) x.hb = hb[x.id]; });
  var staff = table_('Staff');
  var q = readRaw_('Quarantine');
  var locs = table_('Locations');
  return {
    apiUrl: cfg.API_URL || '',
    appUrl: cfg.APP_URL,
    now: Date.now(),
    roundStatus: cfg.ROUND_STATUS || 'NONE',
    projectId: cfg.PROJECT_ID,
    devices: devices,
    staff: staff.rows.map(function (r) { return rowObj_(staff, r); }).filter(function (s) { return s.Staff_Code; })
      .map(function (s) { return { code: normStaff_(s.Staff_Code), name: s.Name, role: s.Role, active: String(s.Active).toUpperCase() !== 'N' }; }),
    quarantine: Math.max(0, q.length - 1),
    locations: locs.rows.filter(function (r) { return r[0]; }).map(function (r) { return rowObj_(locs, r); }),
    locTotals: locTotalsForAdmin_(cfg.PROJECT_ID, locs),
    locChecks: locChecksForAdmin_(cfg.PROJECT_ID),
    members: membersForAdmin_(cfg.PROJECT_ID),
    imports: readRaw_('Import_Files').slice(1).slice(-20).reverse(),
    logWarn: adminLogWarn_()
  };
}

/**
 * ตรวจโครงชีต Count_Log (v2.4.1) — สิ่งที่การเทียบยอดจับไม่ได้: แถวว่างกลางชีต · รายการที่เวลาหาย · Seq ของแต่ละเครื่องครบและไม่ซ้ำ
 * อ่านอย่างเดียว ไม่แก้ชีต (หลักฐานต้องคงไว้ตามจริง) · คืนจำนวนรวม + ตัวอย่างเลขแถวไม่เกิน 10
 */
function countLogAudit_(project) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Count_Log'), last = sh.getLastRow();
  var H = SHEETS.Count_Log, c = function (n) { return H.indexOf(n); };
  var vals = last > 1 ? sh.getRange(2, 1, last - 1, c('Received_Time') + 1).getDisplayValues() : [];
  var A = { lastRow: last, rows: 0, blank: 0, blankRows: [], noTime: 0, noScan: 0, noRecv: 0, noTimeRows: [], dupIds: 0, dupRows: [], devices: [] };
  var ids = {}, dev = {};
  vals.forEach(function (r, i) {
    var row = i + 2, id = r[c('Log_ID')];
    if (!r.some(function (v) { return v !== ''; }) || !id) { A.blank++; if (A.blankRows.length < 10) A.blankRows.push(row); return; }
    A.rows++;
    if (ids[id]) { A.dupIds++; if (A.dupRows.length < 10) A.dupRows.push(row + ' (' + id + ' ซ้ำกับแถว ' + ids[id] + ')'); }
    else ids[id] = row;
    var ns = !r[c('Scan_Time')], nr = !r[c('Received_Time')];
    if (ns) A.noScan++; if (nr) A.noRecv++;
    if (ns || nr) { A.noTime++; if (A.noTimeRows.length < 10) A.noTimeRows.push(row); }
    if (r[c('Project_ID')] !== project) return;
    var d = r[c('Device_ID')], q = parseInt(r[c('Seq')], 10);
    if (!(q > 0)) return;
    (dev[d] || (dev[d] = {}))[q] = (dev[d][q] || 0) + 1;
  });
  // Seq ที่ไปอยู่ใน Quarantine (ข้อมูลรอบอื่น / รอบปิดแล้ว) ไม่นับเป็นช่องว่าง
  var qt = readRaw_('Quarantine'), qmark = {};
  qt.slice(1).forEach(function (r) { var p = lxId_(r[2]); if (p) qmark[p.dev + '|' + p.seq] = 1; });
  Object.keys(dev).sort().forEach(function (d) {
    var seqs = Object.keys(dev[d]).map(Number).sort(function (a, b) { return a - b; });
    var lo = seqs[0], hi = seqs[seqs.length - 1], miss = 0, missList = [], dup = 0;
    for (var q = lo; q <= hi; q++) { if (!dev[d][q]) { if (qmark[d + '|' + q]) continue; miss++; if (missList.length < 10) missList.push(q); } else if (dev[d][q] > 1) dup += dev[d][q] - 1; }
    A.devices.push({ dev: d, min: lo, max: hi, count: seqs.length, missing: miss, missingList: missList, dup: dup });
  });
  A.seqOk = A.devices.every(function (x) { return !x.missing && !x.dup; });
  A.ok = !A.blank && !A.noTime && !A.dupIds && A.seqOk;
  return A;
}

/**
 * กระทบยอดทั้งรอบ (v2.3.8): อ่าน Count_Log ทั้งชีต เทียบกับดัชนีทุก Location (ต่าง → แก้ตามชีต + INDEX_FIX)
 * และเทียบยอดตอนปิด (Close_Total) ของ Location ที่ปิดแล้วกับยอดในชีตปัจจุบัน — ใช้ก่อนดู Dashboard / ก่อนปิดรอบ
 */
function apiReconcile() {
  return withLock_(function () {
    var project = readConfig_().PROJECT_ID;
    if (!project) throw new Error('ยังไม่ได้เปิดรอบนับ');
    var X = logIdx_(project, { write: true });
    var idx = X.verify(null, 'กระทบยอดทั้งรอบ (หน้า Admin)');
    X.save();
    var t = table_('Locations'), seen = {}, closeDiffs = [], closed = 0, qty = 0, lines = 0;
    t.rows.forEach(function (r) {
      var L = rowObj_(t, r), l = L.Location; if (!l) return;
      seen[l] = 1;
      var D = X.locs[l] || { qty: 0, lines: 0 };
      if (!/ปิดแล้ว|CLOSED/.test(String(L.Status))) return;
      closed++;
      var ct = String(L.Close_Total === undefined ? '' : L.Close_Total).replace(/,/g, '');
      if (ct !== '' && Number(ct) !== D.qty) closeDiffs.push({ loc: l, close: Number(ct), sheet: D.qty, flag: String(L.Flag_Check || '') });
    });
    var names = Object.keys(X.locs).filter(function (l) { var D = X.locs[l]; qty += D.qty; lines += D.lines; return true; });
    var missing = names.filter(function (l) { return !seen[l] && X.locs[l].lines; });
    var audit = countLogAudit_(project);
    var res = { at: now_(), locs: names.length, closed: closed, qty: Math.round(qty * 1000) / 1000, lines: lines,
      indexDiffs: idx, closeDiffs: closeDiffs, missing: missing, audit: audit };
    res.ok = !idx.length && !closeDiffs.filter(function (c) { return !c.flag; }).length && !missing.length && audit.ok;
    logAdmin_('RECONCILE', project, (res.ok ? 'ตรงทั้งหมด' : 'พบจุดต่าง') + ' · ' + res.locs + ' Location (ปิดแล้ว ' + closed + ') · ' + res.lines + ' รายการ ' + res.qty + ' ชิ้น' +
      ' · ดัชนีไม่ตรงชีต ' + idx.length + ' · ยอดตอนปิดไม่ตรงชีต ' + closeDiffs.length + (missing.length ? ' · ไม่มีในชีต Locations ' + missing.join(',') : '') +
      ' · โครงชีต: แถวว่าง ' + audit.blank + ' · เวลาหาย ' + audit.noTime + ' · Log_ID ซ้ำ ' + audit.dupIds + ' · Seq ' +
      audit.devices.map(function (x) { return x.dev + ' ' + x.min + '–' + x.max + (x.missing ? ' ขาด ' + x.missing : '') + (x.dup ? ' ซ้ำ ' + x.dup : ''); }).join(', '));
    // เก็บผลไว้ตรวจเงื่อนไขปิดรอบ K4 (v2.5.0): ใช้ได้ถ้า Count_Log ไม่มีแถวเพิ่มหลังกระทบยอด
    setConfig_({ LAST_RECONCILE: JSON.stringify({ at: res.at, ok: res.ok, project: project, lastRow: audit.lastRow, lines: lines }) });
    return res;
  });
}

// ---------- ปิดการนับ และเงื่อนไขปิดรอบ (เฟส 4 · v2.5.0) ----------
//
// COUNTING → "ปิดการนับ" → COUNT_CLOSED: เครื่องหยุดยิง / เปิด Location ใหม่ไม่ได้ แต่รายการค้างส่งยังเข้าได้ และส่งงาน / ปิด Location ที่ค้างได้
// หน้า Admin ยังปรับยอด สรุปผล พิมพ์ใบเดินตรวจได้ · ต้องนับเพิ่ม → "เปิดการนับอีกครั้ง" (บังคับเหตุผล) · ทุกครั้งเลือกรหัสผู้ตรวจสอบ
// เงื่อนไขปิดรอบ K1–K7: v2.5.0 แผงดูอย่างเดียว · v2.5.2 ปุ่มปิดรอบใช้ closeCheck_(true) ตรวจซ้ำในล็อกก่อนสำรอง

var ROUND_STATUS_TH = { NONE: 'ยังไม่เปิดรอบ', SETUP: 'เตรียมรอบ', COUNTING: 'กำลังนับ', COUNT_CLOSED: 'ปิดการนับแล้ว', CLOSING: 'กำลังปิดรอบ (ค้าง)', CLOSED: 'ปิดรอบแล้ว', ARCHIVED: 'ไฟล์สำรอง (ดูอย่างเดียว)' };

/** รหัสผู้ตรวจสอบที่ยังใช้งาน (Staff.Active ≠ N) · ไม่พบ = error */
function staffMust_(code) {
  var c = normStaff_(code), st = activeStaff_().filter(function (x) { return x[0] === c; })[0];
  if (!st) throw new Error('เลือกรหัสผู้ตรวจสอบที่กด');
  return st;
}

/**
 * ตัวนับรายการที่เข้ามาระหว่างปิดการนับ: n = รับทั้งหมด · late = ยิงหลังเวลาปิด (เช่น เครื่องออฟไลน์ ยังไม่รู้ว่าปิดแล้ว)
 * v = null ล้าง · v = {n, late, at} เพิ่ม · ไม่ส่ง = อ่าน
 */
function afterClose_(v) {
  var p = PropertiesService.getScriptProperties();
  if (v === null) { p.deleteProperty('AFTER_COUNT_CLOSE'); return null; }
  var cur = {};
  try { cur = JSON.parse(p.getProperty('AFTER_COUNT_CLOSE') || '{}'); } catch (e) { }
  if (v) {
    cur.n = (cur.n || 0) + (v.n || 0); cur.late = (cur.late || 0) + (v.late || 0); cur.last = v.at;
    p.setProperty('AFTER_COUNT_CLOSE', JSON.stringify(cur));
  }
  return { n: cur.n || 0, late: cur.late || 0, last: cur.last || '' };
}

function apiCountClose(staff) {
  return withLock_(function () {
    var cfg = readConfig_(), st = cfg.ROUND_STATUS || 'NONE';
    if (st === 'COUNT_CLOSED') throw new Error('รอบ ' + cfg.PROJECT_ID + ' ปิดการนับไปแล้ว');
    if (st !== 'COUNTING') throw new Error('ปิดการนับได้เมื่อรอบกำลังนับ (ตอนนี้: ' + (ROUND_STATUS_TH[st] || st) + ')');
    var s = staffMust_(staff), K = closeCheck_(false);
    adminAct_('COUNT_CLOSE', cfg.PROJECT_ID, 'ผู้กด ' + s[0] + ' ' + s[1] + ' · ตอนกด: ' + K.items[0].short + ' · ' + K.items[2].short +
      ' — เครื่องหยุดยิง รายการค้างส่งยังเข้าได้', function () {
      setConfig_({ ROUND_STATUS: 'COUNT_CLOSED', COUNT_CLOSED_AT: now_(), COUNT_CLOSED_BY: s[0] });
      afterClose_(null);
    });
    return { state: apiGetState(), check: closeCheck_(false) };
  });
}

function apiCountReopen(staff, why) {
  return withLock_(function () {
    var cfg = readConfig_(), st = cfg.ROUND_STATUS || 'NONE';
    if (st !== 'COUNT_CLOSED') throw new Error('เปิดการนับอีกครั้งได้เฉพาะตอนปิดการนับแล้ว (ตอนนี้: ' + (ROUND_STATUS_TH[st] || st) + ')');
    why = String(why || '').trim();
    if (!why) throw new Error('ใส่เหตุผลที่ต้องนับเพิ่ม');
    var s = staffMust_(staff), A = afterClose_();
    adminAct_('COUNT_REOPEN', cfg.PROJECT_ID, 'ผู้กด ' + s[0] + ' ' + s[1] + ' · เหตุผล: ' + why + ' · ปิดการนับเมื่อ ' + cfg.COUNT_CLOSED_AT +
      (A.n ? ' · ระหว่างปิดรับ ' + A.n + ' รายการ (ยิงหลังปิด ' + A.late + ')' : ''), function () {
      setConfig_({ ROUND_STATUS: 'COUNTING', COUNT_CLOSED_AT: '', COUNT_CLOSED_BY: '' });
      afterClose_(null);
    });
    return { state: apiGetState(), check: closeCheck_(false) };
  });
}

// ---------- ปิดรอบ: สำรอง → ตรวจไฟล์สำรอง → Count_History → ล้างชีตงาน (เฟส 4 · v2.5.2) ----------
//
// ขั้นตอน (บันทึก Admin_Log ก่อนทุกขั้น · ขั้นไหนไม่ผ่านหยุดทันที):
//   1 ตรวจ K1–K7 แบบเต็มในล็อก (โหมดรอบทดสอบ: K3 K6 K7)   2 สำเนาไฟล์ทั้งไฟล์ไป Archive/
//   3 จัดไฟล์สำเนา: Admin_Log เฉพาะรอบนั้น · Config = ARCHIVED · protect แบบเตือน
//   4 ตรวจไฟล์สำเนา: จำนวนแถวทุกชีต + checksum Count_Log / Adjustments / Variance — ไม่ตรง = หยุด ไม่ล้าง
//   5 สถานะ CLOSING (เก็บ CLOSE_STATE) → Count_History 1 แถว → ล้างชีตงาน → CLOSED · Admin_Log CLOSE_ROUND
// หลุดกลางทางหลังขั้น 5 (เช่น หมดเวลา 6 นาที): กด "ปิดรอบ" อีกครั้ง = ทำต่อจาก CLOSE_STATE ไม่สำรองซ้ำ

/** รหัสรอบที่ใช้ "โหมดรอบทดสอบ" ได้ (ข้าม K1 K2 K4 K5) — ล้างข้อมูลทดสอบก่อนใช้งานจริง · แก้ได้เฉพาะในโค้ด (ตรวจย้อนหลังจาก GitHub) */
var TEST_ROUND_IDS = ['2026Q4'];
var ROUND_TYPE_TH = { REAL: 'รอบจริง', PILOT: 'รอบทดลอง', TEST: 'รอบทดสอบ (ล้างข้อมูล)' };
/** ชีตงานที่ล้างตอนปิดรอบ (อยู่ครบในไฟล์สำรอง) · เก็บไว้: Config Staff Devices Count_History Admin_Log */
var CLOSE_CLEAR_TABLES = ['Count_Log', 'Adjustments', 'Variance', 'Dash_Data', 'Locations', 'Loc_Members', 'Loc_Checks', 'Device_Checks',
  'Quarantine', 'Barcode_Map', 'Map_Decisions', 'SAP_POS_Compare', 'Master_Check', 'Device_Master', 'Import_Files'];
var CLOSE_CLEAR_RAW = ['SAP_Snapshot', 'POS_Snapshot'];
var CLOSE_SUM_SHEETS = ['Count_Log', 'Adjustments', 'Variance'];
var CLOSE_CONFIG_KEYS = RESET_CONFIG_KEYS.filter(function (k) { return k !== 'PROJECT_ID' && k !== 'COUNT_DATE'; })
  .concat(['COUNT_CLOSED_AT', 'COUNT_CLOSED_BY', 'LAST_RECONCILE', 'SUMMARY_SAVED', 'CLOSE_STATE']);

function archived_(cfg) { return (cfg || readConfig_()).ROUND_STATUS === 'ARCHIVED'; }

/** checksum ของทั้งชีต (ค่าที่แสดง) อ่านทีละ 2,000 แถว — ใช้ได้กับไฟล์ใดก็ได้ */
function sheetSum_(book, name) {
  var sh = book.getSheetByName(name);
  if (!sh) return { rows: -1, sum: '' };
  var n = sh.getLastRow(), w = sh.getLastColumn(), parts = [];
  for (var r = 1; r <= n; r += 2000) {
    var k = Math.min(2000, n - r + 1);
    parts.push(sha_(JSON.stringify(sh.getRange(r, 1, k, w).getDisplayValues())));
  }
  return { rows: n, sum: sha_(n + ':' + w + ':' + parts.join('')).slice(0, 16) };
}
function sumText_(sums) { return CLOSE_SUM_SHEETS.map(function (n) { return n + ':' + sums[n].sum; }).join('|'); }

/** เขียน Config ในไฟล์ใดก็ได้ (ใช้กับไฟล์สำเนา) */
function setConfigIn_(book, obj) {
  var sh = book.getSheetByName('Config');
  var keys = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
  Object.keys(obj).forEach(function (k) {
    var i = keys.indexOf(k), v = String(obj[k] === null || obj[k] === undefined ? '' : obj[k]);
    if (i >= 0) sh.getRange(i + 2, 2).setValue(v);
    else { appendRows_(sh, [[k, v, '']]); keys.push(k); }
  });
}

function archiveFolder_() {
  var root = DriveApp.getFolderById(readConfig_().DRIVE_FOLDER_ID);
  var it = root.getFoldersByName('Archive');
  return it.hasNext() ? it.next() : root.createFolder('Archive');
}

/** Count_History เป็น object · ล่าสุดก่อน */
function historyRows_() {
  var t = table_('Count_History');
  return t.rows.map(function (r) { return rowObj_(t, r); }).filter(function (h) { return h.Project_ID; }).reverse();
}

/**
 * ปิดรอบ · staff = รหัสผู้ตรวจสอบ · confirm = พิมพ์ยืนยัน (รอบปกติ = รหัสรอบ · โหมดทดสอบ = "ล้างข้อมูลทดสอบ <รหัสรอบ>") · test = โหมดรอบทดสอบ
 * คืน { state, history, verify }
 */
function apiCloseRound(staff, confirm, test) {
  return withLock_(function () {
    var cfg = readConfig_(), project = cfg.PROJECT_ID, st = cfg.ROUND_STATUS || 'NONE';
    var s = staffMust_(staff);
    test = !!test;
    var want = test ? 'ล้างข้อมูลทดสอบ ' + project : project;
    if (String(confirm || '').trim() !== want) throw new Error('พิมพ์ยืนยันไม่ตรง — ต้องพิมพ์ "' + want + '"');
    if (st === 'CLOSING') return closeFinish_(s, 'ทำต่อจากที่ค้าง');
    if (st !== 'COUNT_CLOSED') throw new Error('ปิดรอบได้เมื่อ "ปิดการนับแล้ว" (ตอนนี้: ' + (ROUND_STATUS_TH[st] || st) + ')');
    if (test && TEST_ROUND_IDS.indexOf(project) < 0) throw new Error('โหมดรอบทดสอบใช้ได้เฉพาะรอบ ' + TEST_ROUND_IDS.join(', '));
    var type = test ? 'TEST' : (cfg.ROUND_TYPE === 'PILOT' ? 'PILOT' : 'REAL');

    // 1) เงื่อนไข — ตรวจใหม่ในล็อก ไม่เชื่อผลบนหน้าจอ
    var K = closeCheck_(true), need = test ? ['K3', 'K6', 'K7'] : ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'];
    var bad = K.items.filter(function (x) { return need.indexOf(x.id) >= 0 && !x.ok; });
    if (bad.length) throw new Error('ยังปิดรอบไม่ได้ — ไม่ผ่าน ' + bad.map(function (x) { return x.id + ' ' + x.title + ': ' + x.detail; }).join(' · '));
    var R = summary_(project, 'ปิดรอบ'), T = R.totals;
    var SV = null; try { SV = JSON.parse(cfg.SUMMARY_SAVED || 'null'); } catch (e) { }

    var ss = SpreadsheetApp.getActive();
    var name = 'ARCHIVED · ' + project + (type === 'REAL' ? '' : ' · ' + ROUND_TYPE_TH[type]) + ' · ปิด ' + now_().slice(0, 10);
    var file = null, sums = {};
    adminAct_('CLOSE_ROUND_START', project, 'ผู้กด ' + s[0] + ' ' + s[1] + ' · ' + ROUND_TYPE_TH[type] + (test ? ' (ข้าม K1 K2 K4 K5)' : ' · K1–K7 ผ่าน') +
      ' · เริ่มสำรองไฟล์', function () {
      // 2) สำเนาทั้งไฟล์ — flush ก่อน ให้สำเนามีทุกแถวที่เพิ่งเขียน (รวมแถว CLOSE_ROUND_START)
      SpreadsheetApp.flush();
      CLOSE_SUM_SHEETS.forEach(function (n) { sums[n] = sheetSum_(ss, n); });
      file = DriveApp.getFileById(ss.getId()).makeCopy(name, archiveFolder_());
    });

    // 3) จัดไฟล์สำเนา
    var copy = SpreadsheetApp.openById(file.getId());
    var logRows = ss.getSheetByName('Admin_Log').getDataRange().getDisplayValues();
    var all = logView_(logRows, '');
    var keep = [logRows[0]].concat(logRows.slice(1).filter(function (r, i) { return all.rowsProject[i] === project; }));
    var cl = copy.getSheetByName('Admin_Log');
    cl.clearContents();
    cl.getRange(1, 1, keep.length, keep[0].length).setValues(keep);
    setConfigIn_(copy, { ROUND_STATUS: 'ARCHIVED', ARCHIVED_AT: now_(), ARCHIVED_BY: s[0], ARCHIVED_TYPE: type });
    copy.getSheets().forEach(function (sh) {
      if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) sh.protect().setDescription('ไฟล์สำรอง — ห้ามแก้').setWarningOnly(true);
    });
    SpreadsheetApp.flush();

    // 4) ตรวจไฟล์สำเนา
    var diffs = [];
    ss.getSheets().forEach(function (sh) {
      var n = sh.getName(), c = copy.getSheetByName(n);
      if (n === 'Admin_Log') { if (!c || c.getLastRow() !== keep.length) diffs.push('Admin_Log ' + (c ? c.getLastRow() : '-') + ' ≠ ' + keep.length); return; }
      if (n === 'Config') return;   // สำเนาตั้งค่า ARCHIVED แล้ว ต่างโดยตั้งใจ
      if (!c) { diffs.push(n + ' ไม่มีในสำเนา'); return; }
      if (c.getLastRow() !== sh.getLastRow()) diffs.push(n + ' ' + c.getLastRow() + ' ≠ ' + sh.getLastRow() + ' แถว');
    });
    CLOSE_SUM_SHEETS.forEach(function (n) { var c = sheetSum_(copy, n); if (c.sum !== sums[n].sum) diffs.push(n + ' checksum ไม่ตรง'); });
    if (diffs.length) {
      try { file.setName(name + ' · ตรวจไม่ผ่าน'); } catch (e) { }
      logAdmin_('ARCHIVE_VERIFY_FAILED', project, diffs.join(' · ') + ' — ไม่ล้างชีตใด ๆ · ' + file.getUrl());
      throw new Error('ตรวจไฟล์สำรองไม่ผ่าน (' + diffs.join(' · ') + ') — ระบบไม่ได้ล้างอะไร ไฟล์ทำงานอยู่ครบ');
    }
    var checks = ss.getSheets().length;
    logAdmin_('ARCHIVE_VERIFY', project, 'ตรวจไฟล์สำรองผ่าน · ' + checks + ' ชีต จำนวนแถวตรง · Admin_Log ของรอบ ' + (keep.length - 1) + ' แถว · ' +
      sumText_(sums) + ' · ' + file.getUrl());

    // 5) CLOSING → Count_History → ล้าง → CLOSED
    var state = {
      project: project, countDate: cfg.COUNT_DATE, type: type, archiveId: file.getId(), url: file.getUrl(), checksum: sumText_(sums),
      book: T.book, final: T.final, diffQty: T.diff, diffValue: T.diffValue,   // v2.5.4: ตัวเลขเดียวกับหน้าสรุปผล (ไม่รวมสินค้าที่ไม่มีในบัญชี) — เดิม final − book diffItems: T.over + T.short,
      edits: T.adjLines, run: SV && SV.project === project ? SV.run : '', lines: sums.Count_Log.rows - 1, by: s[0] + ' ' + s[1] + ' (' + who_() + ')', history: false
    };
    setConfig_({ ROUND_STATUS: 'CLOSING', CLOSE_STATE: JSON.stringify(state) });
    return closeFinish_(s, '');
  });
}

/** ส่วนท้ายของการปิดรอบ (ทำซ้ำได้): Count_History → ล้างชีตงาน → CLOSED */
function closeFinish_(s, note) {
  var cfg = readConfig_(), C = JSON.parse(cfg.CLOSE_STATE || 'null');
  if (!C || C.project !== cfg.PROJECT_ID) throw new Error('ไม่พบข้อมูลการปิดรอบที่ค้าง (CLOSE_STATE) — ติดต่อผู้ดูแลระบบ ห้ามแก้ชีตเอง');
  var at = now_();
  if (!C.history) {
    appendRows_(SpreadsheetApp.getActive().getSheetByName('Count_History'), [[C.project, C.countDate, C.book, C.final, C.diffQty, C.diffValue, C.diffItems, C.edits,
      C.url, C.checksum, C.run, C.lines, at, C.by, C.type, C.archiveId]]);
    C.history = true;
    setConfig_({ CLOSE_STATE: JSON.stringify(C) });
  }
  adminAct_('CLOSE_ROUND_CLEAR', C.project, (note ? note + ' · ' : '') + 'ล้างชีตงาน ' + CLOSE_CLEAR_TABLES.concat(CLOSE_CLEAR_RAW).join(', ') + ' (อยู่ครบในไฟล์สำรอง)', function () {
    CLOSE_CLEAR_TABLES.forEach(function (n) { writeTable_(n, SHEETS[n], []); });
    CLOSE_CLEAR_RAW.forEach(function (n) { var sh = SpreadsheetApp.getActive().getSheetByName(n); if (sh) sh.clearContents(); });
    lxReset_();
    afterClose_(null);
    var blank = {};
    CLOSE_CONFIG_KEYS.forEach(function (k) { blank[k] = ''; });
    blank.ROUND_STATUS = 'CLOSED';
    setConfig_(blank);
  });
  logAdmin_('CLOSE_ROUND', C.project, ROUND_TYPE_TH[C.type] + ' · ปิดรอบเสร็จ · ผู้กด ' + (s ? s[0] + ' ' + s[1] : C.by) + ' · ไฟล์สำรอง ' + C.url + ' · ' + C.checksum +
    ' · บัญชี ' + C.book + ' สุดท้าย ' + C.final + ' ต่าง ' + C.diffQty + ' (' + C.diffValue + ' บาท) · Count_Log ' + C.lines + ' รายการ');
  return { state: apiGetState(), closed: C };
}

/** ตรวจไฟล์สำรองย้อนหลัง: คำนวณ checksum ของไฟล์สำรองใหม่ เทียบกับที่เก็บใน Count_History */
function apiVerifyArchive(projectId) {
  return withLock_(function () {
    var h = historyRows_().filter(function (x) { return x.Project_ID === projectId; })[0];
    if (!h) throw new Error('ไม่พบรอบ ' + projectId + ' ใน Count_History');
    var copy;
    try { copy = SpreadsheetApp.openById(h.Archive_ID); } catch (e) { throw new Error('เปิดไฟล์สำรองไม่ได้ (ถูกลบ / ย้าย / ไม่มีสิทธิ์): ' + h.Archive_Link); }
    var want = {};
    String(h.Checksum).split('|').forEach(function (p) { var kv = p.split(':'); want[kv[0]] = kv[1]; });
    var rows = CLOSE_SUM_SHEETS.map(function (n) { var c = sheetSum_(copy, n); return { sheet: n, ok: c.sum === want[n], rows: c.rows }; });
    var cfgOk = false;
    try { var cs = copy.getSheetByName('Config').getDataRange().getDisplayValues(); cfgOk = cs.some(function (r) { return r[0] === 'ROUND_STATUS' && r[1] === 'ARCHIVED'; }); } catch (e) { }
    var ok = rows.every(function (r) { return r.ok; }) && cfgOk;
    logAdmin_('ARCHIVE_CHECK', projectId, (ok ? 'ไฟล์สำรองตรงกับตอนปิดรอบ' : 'ไฟล์สำรองไม่ตรง — ถูกแก้หลังปิดรอบ') + ' · ' +
      rows.map(function (r) { return r.sheet + (r.ok ? ' ✓' : ' ✗'); }).join(' · ') + (cfgOk ? '' : ' · Config ไม่ใช่ ARCHIVED'));
    return { project: projectId, ok: ok, rows: rows, cfgOk: cfgOk, url: h.Archive_Link, at: now_() };
  });
}

/** เวลาของแถว Admin_Log ล่าสุดที่เป็น action นี้ของรอบนี้ (ใช้บอกครั้งล่าสุดในเงื่อนไข K4/K5 · v2.5.1) */
function lastLogOf_(action, project) {
  var log = readRaw_('Admin_Log');
  for (var i = log.length - 1; i > 0; i--) {
    if (log[i][2] === action && String(log[i][3]) === String(project)) {
      var m = String(log[i][4] || '').match(/^ครั้งที่ \d+/);
      return String(log[i][0]) + (m ? ' ' + m[0] : '');
    }
  }
  return '';
}

/** หน้า Admin: ตรวจเงื่อนไขแบบเร็ว (ไม่คำนวณผลสรุปใหม่ · ไม่ใช้ล็อก) — การ์ดเรียกเองทุกครั้งที่เปิดหน้าตอนปิดการนับแล้ว (v2.5.2) */
function apiCloseCheckFast() {
  if (!readConfig_().PROJECT_ID) throw new Error('ยังไม่ได้เปิดรอบนับ');
  return closeCheck_(false);
}

/** หน้า Admin: ตรวจเงื่อนไขปิดรอบ K1–K7 (ดูอย่างเดียว · คำนวณผลสรุปใหม่เทียบ K5 จึงใช้ล็อก) */
function apiCloseCheck() {
  return withLock_(function () {
    if (!readConfig_().PROJECT_ID) throw new Error('ยังไม่ได้เปิดรอบนับ');
    return closeCheck_(true);
  });
}

/**
 * เงื่อนไขปิดรอบ · full = คำนวณผลสรุปใหม่เทียบลายนิ้วมือ (K5) — false ใช้ตอนกดปิด/เปิดการนับ (เร็ว ไม่เทียบ K5)
 * คืน { at, project, status, statusTh, closedAt, closedBy, after, full, ok, items:[{id, ok, title, detail, fix, short, list}] }
 */
function closeCheck_(full) {
  var cfg = readConfig_(), project = cfg.PROJECT_ID, st = cfg.ROUND_STATUS || 'NONE', items = [];
  function add(id, ok, title, detail, fix, short, list) {
    items.push({ id: id, ok: !!ok, title: title, detail: detail || '', fix: ok ? '' : fix, short: short || '', list: list || [] });
  }
  // K1 / K2 จากชีต Locations
  var lt = table_('Locations'), open = [], flags = [], total = 0, groups = {};
  lt.rows.forEach(function (r) {
    var L = rowObj_(lt, r); if (!L.Location) return;
    total++;
    var s = String(L.Status || '') || 'ไม่มีสถานะ';
    if (!/ปิดแล้ว/.test(s)) {
      open.push(L.Location);
      // v2.5.1: แยกตามเครื่องผู้ดูแล (คนถือเครื่องนั้นต้องไปกดปิด) แล้วแยกตามสถานะ · แสดงครบทุกตัว
      var op = String(L.Owner || '').split(' '), dv = op[0] || '';
      var g = groups[dv] = groups[dv] || { st: {}, staff: [] };
      if (op[1] && g.staff.indexOf(op[1]) < 0) g.staff.push(op[1]);
      (g.st[s] = g.st[s] || []).push(String(L.Location));
    }
    if (L.Flag_Check) flags.push(L.Location + ': ' + L.Flag_Check);
  });
  flags.sort(natCmp_);
  var names = {};
  activeStaff_().forEach(function (x) { names[x[0]] = x[1]; });
  var k1list = Object.keys(groups).sort(function (a, b) { return a ? (b ? natCmp_(a, b) : -1) : 1; }).map(function (o) {
    var g = groups[o], who = o ? o + (g.staff.length ? ' · ' + g.staff.sort().map(function (c) { return c + (names[c] ? ' ' + names[c] : ''); }).join(', ') : '') : 'ไม่มีผู้ดูแล';
    return who + ' — ' + Object.keys(g.st).sort().map(function (st) { return st + ' ' + g.st[st].length + ': ' + g.st[st].sort(natCmp_).join(', '); }).join(' · ');
  });
  add('K1', total > 0 && !open.length, 'ทุก Location ปิดแล้ว ไม่มี พัก / กำลังนับ',
    total ? (open.length ? 'ยังไม่ปิด ' + open.length + ' จาก ' + total + ' Location · แยกตามเครื่องผู้ดูแล' : 'ปิดครบ ' + total + ' Location') : 'ยังไม่มี Location ในรอบนี้',
    'ให้ผู้ดูแลกด "ปิด Location" ที่เครื่อง (ทำได้หลังปิดการนับ) · ผู้ช่วยค้างให้กด "ส่งงาน" หรือใช้ "ส่งงานแทน" ในแท็บเครื่อง TC21',
    open.length ? 'Location ยังไม่ปิด ' + open.length : 'Location ปิดครบ ' + total, k1list);
  add('K2', !flags.length, 'ไม่มีธง "ต้องตรวจซ้ำ" ค้าง', flags.length ? 'มีธง ' + flags.length + ' Location' : 'ไม่มีธง',
    'ตรวจแล้วกด "ปิดธง" พร้อมเหตุผล (แท็บเครื่อง TC21) หรือเปิดการนับอีกครั้งให้ผู้ดูแลล้าง Location แล้วนับใหม่', '', flags.slice(0, 30));
  // K3 ทุกเครื่องที่เปิดใช้และจับคู่อยู่ ค้างส่ง 0 ตามสัญญาณล่าสุด
  var dt = table_('Devices'), devs = [];
  dt.rows.forEach(function (r) { var d = rowObj_(dt, r); if (d.Device_ID && d.Active === 'Y' && d.Token_Hash) devs.push(String(d.Device_ID)); });
  devs.sort(natCmp_);
  // v2.5.1 (UAT G10-6): นับเฉพาะสัญญาณที่ส่งมา "หลังปิดการนับ" — เครื่องได้รับสถานะปิดในคำตอบครั้งนั้น ยิงเพิ่มไม่ได้อีก
  // สัญญาณก่อนปิด (เช่น ปิด Wi-Fi ไว้) ไม่นับ เพราะเครื่องอาจยังยิงต่อแบบออฟไลน์ได้
  var hb = heartbeats_(devs), bad = [], good = [], closedAt = cfg.COUNT_CLOSED_AT || '';
  devs.forEach(function (id) {
    var h = hb[id], ago = h ? Math.max(0, Math.round((Date.now() - h.at) / 60000)) : null, at = h ? ts_(h.at) : '';
    if (!h) bad.push(id + ': ไม่มีสัญญาณ');
    else if (h.pending > 0) bad.push(id + ': ค้างส่ง ' + h.pending + ' รายการ (สัญญาณ ' + ago + ' นาทีที่แล้ว)');
    else if (!closedAt) good.push(id + ': ค้าง 0 (สัญญาณ ' + ago + ' นาทีที่แล้ว · ยังไม่ได้ปิดการนับ)');
    else if (at < closedAt) bad.push(id + ': ยังไม่ได้ติดต่อหลังปิดการนับ (สัญญาณล่าสุด ' + at.slice(11, 16) + ' ก่อนปิด ' + closedAt.slice(11, 16) + ')');
    else good.push(id + ': ค้าง 0 (สัญญาณ ' + ago + ' นาทีที่แล้ว หลังปิดการนับ)');
  });
  var k3ok = !bad.length && !!closedAt;
  add('K3', k3ok, 'ทุกเครื่องค้างส่ง 0 ตามสัญญาณหลังปิดการนับ',
    devs.length ? (bad.length ? 'ไม่ผ่าน ' + bad.length + ' จาก ' + devs.length + ' เครื่อง' : !closedAt ? 'ค้าง 0 ครบ ' + devs.length + ' เครื่อง แต่ยังไม่ได้ปิดการนับ — ตรวจจริงหลังปิด' : 'ครบ ' + devs.length + ' เครื่อง') : 'ไม่มีเครื่องที่จับคู่อยู่',
    !closedAt && !bad.length ? 'กด "ปิดการนับ" แล้วรอให้ทุกเครื่องส่งสัญญาณ (ไม่เกิน 1 นาที)' :
    'เปิดแอปบนเครื่องในจุดที่มี Wi-Fi (ส่งสัญญาณทุก 1 นาที) หรือ Export ไฟล์จากเครื่องแล้วนำเข้า · เครื่องที่ไม่ได้ใช้ในรอบนี้: "ยกเลิกเครื่อง" ในแท็บเครื่อง TC21',
    bad.length ? 'เครื่องยังไม่พร้อม ' + bad.length + ' จาก ' + devs.length : 'เครื่องค้างส่ง 0 ครบ ' + devs.length, bad.concat(good));
  // K4 กระทบยอดทั้งรอบครั้งล่าสุด: ตรงทั้งหมด · ทำหลังปิดการนับ · Count_Log ไม่มีแถวเพิ่มหลังจากนั้น
  var R = null; try { R = JSON.parse(cfg.LAST_RECONCILE || 'null'); } catch (e) { }
  var lastRow = SpreadsheetApp.getActive().getSheetByName('Count_Log').getLastRow(), k4 = '', k4ok = false;
  if (!R || R.project !== project) {
    var lastRec = lastLogOf_('RECONCILE', project);
    k4 = lastRec ? 'กระทบยอดล่าสุด ' + lastRec + ' (ก่อนอัปเดตระบบ / ก่อนปิดการนับ) — ต้องกระทบยอดใหม่หลังปิดการนับ' : 'ยังไม่เคยกระทบยอดในรอบนี้';
  }
  else if (!R.ok) k4 = 'กระทบยอด ' + R.at + ' พบจุดต่าง';
  else if (Number(R.lastRow) !== lastRow) k4 = 'มีรายการเข้ามาหลังกระทบยอด ' + R.at + ' — ต้องกระทบยอดใหม่';
  else if (!cfg.COUNT_CLOSED_AT) k4 = 'ตรงทั้งหมด ' + R.at + ' แต่ยังไม่ได้ปิดการนับ — ต้องกระทบยอดอีกครั้งหลังปิดการนับ';
  else if (R.at < cfg.COUNT_CLOSED_AT) k4 = 'ตรงทั้งหมด ' + R.at + ' แต่ทำก่อนปิดการนับ — ต้องกระทบยอดใหม่หลังปิดการนับ';
  else { k4ok = true; k4 = 'ตรงทั้งหมด ' + R.at; }
  add('K4', k4ok, 'กระทบยอดทั้งรอบตรง หลังปิดการนับ (ดัชนี · ยอดตอนปิด · โครงชีต Count_Log)', k4,
    'แท็บเครื่อง TC21 → "กระทบยอดทั้งรอบ" (หลังปิดการนับ และหลังเครื่องส่งครบ) · ถ้าพบจุดต่าง ดูแถวที่ระบบชี้');
  // K5 ผลสรุปที่บันทึกล่าสุด = ตัวเลขตอนนี้ และบันทึกหลังปิดการนับ
  var SV = null; try { SV = JSON.parse(cfg.SUMMARY_SAVED || 'null'); } catch (e) { }
  if (SV && SV.project !== project) SV = null;
  var K5T = 'ผลสรุปที่บันทึกล่าสุด = ตัวเลขตอนนี้ (บันทึกหลังปิดการนับ)';
  var K5F = 'แท็บสรุปผลนับ → "สรุปผลและบันทึก" (หลังปิดการนับ ปรับยอดครั้งสุดท้าย และไฟล์ SAP ล่าสุด)';
  if (!SV) {
    var lastSave = lastLogOf_('SUMMARY_SAVE', project);
    add('K5', false, K5T, lastSave ? 'บันทึกล่าสุด ' + lastSave + ' (ก่อนอัปเดตระบบ / ก่อนปิดการนับ) — ต้องบันทึกใหม่หลังปิดการนับ' : 'ยังไม่เคยกด "สรุปผลและบันทึก" ในรอบนี้', K5F);
  }
  else if (!full) add('K5', false, K5T, 'ยังไม่ได้เทียบตัวเลข (บันทึกล่าสุดครั้งที่ ' + SV.run + ' · ' + SV.at + ')', 'กด "ตรวจเงื่อนไข"');
  else {
    var nowSig = summarySig_(summary_(project, 'ตรวจเงื่อนไขปิดรอบ (หน้า Admin)'));
    var afterCl = !!cfg.COUNT_CLOSED_AT && SV.at >= cfg.COUNT_CLOSED_AT;
    add('K5', nowSig === SV.sig && afterCl, K5T,
      nowSig !== SV.sig ? 'ตัวเลขเปลี่ยนหลังบันทึกครั้งที่ ' + SV.run + ' (' + SV.at + ')' :
        !cfg.COUNT_CLOSED_AT ? 'ตรงกับครั้งที่ ' + SV.run + ' (' + SV.at + ') แต่ยังไม่ได้ปิดการนับ — ต้องบันทึกอีกครั้งหลังปิดการนับ' :
        !afterCl ? 'ตรงกับครั้งที่ ' + SV.run + ' (' + SV.at + ') แต่บันทึกก่อนปิดการนับ' : 'ตรงกับครั้งที่ ' + SV.run + ' (' + SV.at + ')', K5F);
  }
  // K6 / K7
  var w = adminLogWarn_();
  add('K6', !w, 'ไม่มีคำเตือนบันทึก Admin_Log ค้าง', w ? 'บันทึกไม่สำเร็จ ' + w.n + ' ครั้ง ล่าสุด ' + w.last : 'ไม่มี',
    'ตรวจรายการในชีต Loc_Checks (ADMIN_LOG_FAIL) แล้วกด "ตรวจแล้ว รับทราบ" ที่แถบแดงด้านบน');
  add('K7', st === 'COUNT_CLOSED', 'สถานะ "ปิดการนับแล้ว"', (ROUND_STATUS_TH[st] || st) + (cfg.COUNT_CLOSED_AT ? ' · เมื่อ ' + cfg.COUNT_CLOSED_AT + ' โดย ' + cfg.COUNT_CLOSED_BY : ''),
    'กด "ปิดการนับ" ก่อน');
  return { at: now_(), project: project, status: st, statusTh: ROUND_STATUS_TH[st] || st, closedAt: cfg.COUNT_CLOSED_AT || '', closedBy: cfg.COUNT_CLOSED_BY || '',
    after: st === 'COUNT_CLOSED' ? afterClose_() : null, full: !!full, ok: items.every(function (x) { return x.ok; }), items: items };
}


/** ยอดบนเซิร์ฟเวอร์ต่อ Location และต่อเครื่อง (จากดัชนี — ไม่อ่าน Count_Log ทั้งชีต) (v2.3.5) */
function locTotalsForAdmin_(project, locs) {
  if (!project) return {};
  var names = locs.rows.map(function (r) { return r[locs.idx.Location]; }).filter(String);
  var X = logIdx_(project);
  names = names.concat(X.meta.locs.filter(function (l) { return names.indexOf(l) < 0; }));
  var D = X.loc(names), out = {};
  Object.keys(D).forEach(function (l) {
    var dev = {};
    // ยอดแยกเครื่อง = นับจากล้าง Location ครั้งล่าสุด (v2.3.6) · ยอดรวมใช้ยอดเต็ม (รายการล้างหักยอดเก่าไปแล้ว)
    Object.keys(D[l].devices).forEach(function (d) { var x = D[l].devices[d]; dev[d] = { qty: x.sc === undefined ? x.qty : x.sc, raw: x.qty, lines: x.lines }; });
    out[l] = { qty: D[l].qty, lines: D[l].lines, sku: Object.keys(D[l].items).filter(function (k) { return D[l].items[k].qty !== 0; }).length, dev: dev,
      clearedAt: D[l].ca ? D[l].ca[1] : '', clearedBy: D[l].ca ? D[l].ca[0] : '' };
  });
  return out;
}

/** ผลตรวจยอดกับเครื่องครั้งล่าสุดต่อ Location (ส่งงาน/พัก/ปิด/แก้) — ตัวเลขเครื่องเทียบเซิร์ฟเวอร์ (v2.3.5) */
function locChecksForAdmin_(project) {
  var rows = readRaw_('Loc_Checks'), out = {};
  if (rows.length < 2) return out;
  var h = rows[0], ix = {};
  h.forEach(function (c, i) { ix[c] = i; });
  rows.slice(1).forEach(function (r) {
    if (r[ix.Project_ID] !== project || !r[ix.Match]) return;
    out[r[ix.Location]] = { device: r[ix.Device_ID], event: r[ix.Event], match: r[ix.Match], devLines: r[ix.Dev_Lines], devQty: r[ix.Dev_Qty],
      srvLines: r[ix.Srv_Lines], srvQty: r[ix.Srv_Qty], time: String(r[ix.Time]) };
  });
  return out;
}

function membersForAdmin_(project) {
  if (!project) return [];
  var mt = membersTable_();
  return mt.rows.filter(function (r) { return r[mt.idx.Project_ID] === project; }).map(function (r) {
    var m = rowObj_(mt, r);
    return { location: m.Location, device: m.Device_ID, role: m.Role, state: m.State, match: m.Match, staff: m.Staff, subBy: m.Sub_By, stateAt: m.State_At };
  });
}

/** หัวหน้าทีม: ส่งงานแทนผู้ช่วยที่ติดต่อไม่ได้ (บันทึกผู้กดและเหตุผล) */
function apiLocResolveFlag(loc, reason) {
  return withLock_(function () { adminResolveFlag_(loc, reason); return apiDevicesState(); });
}

function apiLocSubmitFor(loc, deviceId, reason) {
  return withLock_(function () { adminSubmitFor_(loc, deviceId, reason); return apiDevicesState(); });
}

/** หัวหน้าทีม: โอนการดูแล Location (เช่น เครื่องผู้ดูแลเสีย) */
function apiLocTransfer(loc, toDevice, reason) {
  return withLock_(function () { adminTransfer_(loc, toDevice, reason); return apiDevicesState(); });
}

/**
 * บันทึก URL ของ Web app ที่ใช้งานจริง
 * ไม่ใช้ ScriptApp.getService().getUrl() เพราะเมื่อเรียกจากเมนูใน Sheets มักได้ URL ของรุ่นทดสอบหรือ deployment อื่น
 */
function apiSetApiUrl(url) {
  url = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error('URL ต้องเป็นรูปแบบ https://script.google.com/macros/s/…/exec (คัดลอกจาก Deploy → Manage deployments → Web app URL)');
  }
  var old = readConfig_().API_URL;
  setConfig_({ API_URL: url });
  logAdmin_('SET_API_URL', url, old ? 'เดิม ' + old : 'ตั้งครั้งแรก');
  return apiDevicesState();
}

function apiSeedDevices(count, prefix) {
  return withLock_(function () {
    count = Math.min(Math.max(parseInt(count, 10) || 0, 1), 30);
    prefix = String(prefix || 'TC21').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'TC21';
    var t = table_('Devices');
    var added = [];
    for (var n = 1; n <= count; n++) {
      var id = prefix + '-' + ('0' + n).slice(-2);
      if (findDevice_(t, id) >= 0) continue;
      putRow_(t, -1, { Device_ID: id, Name: id, Active: 'Y', Last_Seq: 0, Pair_Fails: 0 });
      added.push(id);
    }
    if (added.length) logAdmin_('DEVICE_ADD', added.join(', '), 'เพิ่มเครื่อง ' + added.length + ' เครื่อง');
    return apiDevicesState();
  });
}

/**
 * ชุดป้ายสำหรับทดสอบ (อ่านอย่างเดียว ไม่เขียนชีต)
 * - real: สุ่มบาร์โค้ดจาก Device_Master (ที่มีบาร์โค้ด)
 * - fake: EAN-13 ขึ้นต้น 200 (ช่วงภายในร้าน) check digit ถูก และไม่มีใน Device_Master
 * - staff: บัตรพนักงานที่ต้องถูกปฏิเสธ
 */
function apiTestKit(nReal, nFake) {
  ensureSetup_();
  var cfg = readConfig_();
  nReal = Math.max(1, Math.min(60, Number(nReal) || 20));
  nFake = Math.max(1, Math.min(20, Number(nFake) || 5));
  var rows = readRaw_('Device_Master').slice(1).filter(function (r) { return r[0]; });
  if (!rows.length) throw new Error('ยังไม่มี Device_Master — นำเข้า SAP/POS และอนุมัติ Master ก่อน');
  var have = {};
  rows.forEach(function (r) { have[r[0]] = true; });
  var pool = rows.slice(), real = [];
  while (real.length < nReal && pool.length) {
    var r = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    real.push({ code: r[0], material: r[1], name: String(r[3] || '').slice(0, 40) });
  }
  var fake = [], guard = 0;
  while (fake.length < nFake && guard++ < 1000) {
    var c = ean13_('200' + String(Math.floor(Math.random() * 1e9) + 1e9).slice(1));
    if (!have[c] && fake.indexOf(c) < 0) fake.push(c);
  }
  var staff = table_('Staff');
  var all = staff.rows.map(function (r) { return rowObj_(staff, r); }).filter(function (s) { return s.Staff_Code; });
  var codes = {};
  all.forEach(function (s) { codes[normStaff_(s.Staff_Code)] = true; });
  var fakeCode = 'FAKE01', i = 1;
  while (codes[fakeCode]) fakeCode = 'FAKE' + ('0' + (++i)).slice(-2);
  var bad = [{ code: 'EMP:' + fakeCode, title: 'ไม่มีในรายชื่อ', note: fakeCode }];
  all.filter(function (s) { return String(s.Active).toUpperCase() === 'N'; }).slice(0, 2).forEach(function (s) {
    bad.push({ code: 'EMP:' + normStaff_(s.Staff_Code), title: 'ปิดใช้งานแล้ว', note: s.Name || normStaff_(s.Staff_Code) });
  });
  bad.push({ code: 'EMP:', title: 'ไม่มีรหัส', note: 'EMP: ว่าง' });
  var act = all.filter(function (s) { return String(s.Active).toUpperCase() !== 'N'; })[0];
  if (act) bad.push({ code: normStaff_(act.Staff_Code), title: 'ไม่มี EMP: นำหน้า', note: 'ต้องขึ้นว่าไม่พบสินค้า' });
  return { appUrl: cfg.APP_URL, project: cfg.PROJECT_ID, real: real, fake: fake, staff: bad, masterCount: rows.length };
}

/** เติม check digit EAN-13 ให้เลข 12 หลัก */
function ean13_(d12) {
  var s = 0;
  for (var i = 0; i < 12; i++) s += Number(d12.charAt(i)) * (i % 2 ? 3 : 1);
  return d12 + ((10 - s % 10) % 10);
}

/** สร้างรหัสจับคู่ 6 หลัก ใช้ได้ 30 นาที ครั้งเดียว; จับคู่ใหม่จะทำให้ token เดิมของเครื่องนั้นใช้ไม่ได้ */
function apiPairCode(deviceId) {
  return withLock_(function () {
    var t = table_('Devices');
    var i = findDevice_(t, deviceId);
    if (i < 0) throw new Error('ไม่พบเครื่อง ' + deviceId);
    var code = String(Math.floor(100000 + Math.random() * 900000));
    adminAct_('DEVICE_PAIR_CODE', deviceId, 'สร้างรหัสจับคู่ (หมดอายุใน ' + PAIR_MINUTES + ' นาที)', function () {
      putRow_(t, i, { Pair_Code: code, Pair_Expires: Date.now() + PAIR_MINUTES * 60000, Pair_Fails: 0, Active: 'Y' });
    });
    return apiDevicesState();
  });
}

/** เหตุผลการยกเลิกเครื่อง — LOST: รายการที่ยิงหลังเวลายกเลิก (ก่อนจับคู่ใหม่) ขึ้น "ต้องตรวจซ้ำ" */
var REVOKE_REASONS = { TEMP: 'หยุดใช้ชั่วคราว / กดผิด', REPLACE: 'เครื่องเสีย / เปลี่ยนเครื่อง', LOST: 'เครื่องหาย / สงสัยการใช้งาน' };

function apiSetDeviceActive(deviceId, active, reason, note) {
  return withLock_(function () {
    var t = table_('Devices');
    var i = findDevice_(t, deviceId);
    if (i < 0) throw new Error('ไม่พบเครื่อง ' + deviceId);
    var upd = { Active: active ? 'Y' : 'N' };
    if (!active) {
      reason = REVOKE_REASONS[reason] ? reason : 'TEMP';
      upd.Token_Hash = ''; upd.Pair_Code = ''; upd.Pair_Expires = '';
      upd.Revoked_At = now_(); upd.Revoke_Reason = reason; upd.Repaired_At = '';
    }
    adminAct_(active ? 'DEVICE_ENABLE' : 'DEVICE_REVOKE', deviceId, active ? 'เปิดใช้งาน' :
      'ยกเลิกเครื่อง (token เดิมใช้ไม่ได้) เหตุผล: ' + REVOKE_REASONS[reason] + (note ? ' · ' + note : ''), function () {
      putRow_(t, i, upd);
      try { CacheService.getScriptCache().remove('hb_' + deviceId); } catch (e) { }
    });
    return apiDevicesState();
  });
}

/** นำเข้าไฟล์จากเครื่อง (TC21 export หรือ Dolphin 7 คอลัมน์) — รับเฉพาะรายการที่ยังไม่มี */
function apiImportDeviceFile(text, fileName) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('มีเครื่องกำลังส่งข้อมูลอยู่ ลองใหม่อีกครั้ง');
  try {
    var cfg = readConfig_();
    var checksum = sha_(text).slice(0, 16);
    var parsed;
    if (String(text).indexOf('#STOCKCOUNT_EXPORT') === 0 || String(text).replace(/^﻿/, '').indexOf('#STOCKCOUNT_EXPORT') === 0) {
      parsed = Core.parseDeviceExport(text);
    } else {
      var lookup = {};
      readRaw_('Device_Master').slice(1).forEach(function (r) { if (r[0]) lookup[r[0]] = r[1]; });
      parsed = Core.parseDolphin(text, checksum.slice(0, 8), cfg.PROJECT_ID, lookup);
    }
    if (!parsed.ok) throw new Error(parsed.error);
    var prev = readRaw_('Import_Files').slice(1).filter(function (r) { return r[2] === checksum; });
    var res = ingest_(parsed.deviceId, parsed.entries, [], 'FILE', null);
    var existing = res.duplicate.length;
    appendRows_(SpreadsheetApp.getActive().getSheetByName('Import_Files'),
      [[now_(), fileName || '', checksum, parsed.entries.length, existing, res.accepted.length, who_()]]);
    logAdmin_('IMPORT_FILE', fileName || '', parsed.kind + ' ' + parsed.deviceId + ': ในไฟล์ ' + parsed.entries.length + ' รายการ, มีแล้ว ' + existing +
      ', เพิ่มใหม่ ' + res.accepted.length + (res.quarantined.length ? ', แยกไว้ (รอบอื่น) ' + res.quarantined.length : '') +
      (res.rejected.length ? ', ไม่รับ ' + res.rejected.length : ''));
    return {
      kind: parsed.kind, deviceId: parsed.deviceId, projectId: parsed.projectId, total: parsed.entries.length, existing: existing,
      added: res.accepted.length, quarantined: res.quarantined.length, rejected: res.rejected, importedBefore: prev.length > 0,
      state: apiDevicesState()
    };
  } finally {
    releaseLock_(lock);
  }
}


// ---------- สรุปผลนับ / Dashboard (เฟส 3 · v2.4.0) ----------
//
// ลำดับที่ผู้ตรวจสอบทำงาน: ยอดรวมทั้งร้านเทียบ SAP (UR) → นับครบหรือยัง (Location ที่หาย) → ผลต่างราย SKU → ไล่ย้อนถึง Location / เครื่อง / ผู้นับ
// ทุกครั้งกระทบยอดดัชนีกับ Count_Log ก่อน (ตัวเลขบน Dashboard ต้องมาจากดัชนีที่ตรงกับชีต)
// ยอดเทียบ = Book_Qty ใน Barcode_Map (SAP UR ของไฟล์ที่โหลดล่าสุด · ไม่มี SAP = POS) · IT / QI / BL ไม่รวม แต่ติดป้ายไว้สอบถาม

/** สินค้าตาม Master: Material → ข้อมูลยอดบัญชี (Barcode_Map มีหลายแถวต่อรหัส = หลายบาร์โค้ด ใช้แถวแรก) */
function bookByMaterial_() {
  var t = table_('Barcode_Map'), out = {};
  t.rows.forEach(function (r) {
    var x = rowObj_(t, r), m = String(x.Material || '');
    if (m && out[m] && x.Barcode && out[m].bcs.indexOf(String(x.Barcode)) < 0) out[m].bcs.push(String(x.Barcode));   // v2.4.1 ทุกบาร์โค้ดของรหัส
    if (!m || out[m]) return;
    var n = function (v) { return Number(String(v === undefined ? '' : v).replace(/,/g, '')) || 0; };
    out[m] = { name: String(x.Name || ''), book: n(x.Book_Qty), src: String(x.Book_Source || ''), cost: n(x.Unit_Cost),
      it: n(x.SAP_IT), qi: n(x.SAP_QI), bl: n(x.SAP_BL), bcs: x.Barcode ? [String(x.Barcode)] : [] };
  });
  return out;
}

/** เรียง Location แบบคน: A2 ก่อน A10 (v2.4.1) */
function natCmp_(a, b) {
  var x = String(a).toUpperCase().match(/^(.*?)(\d*)$/), y = String(b).toUpperCase().match(/^(.*?)(\d*)$/);
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  var nx = x[2] === '' ? -1 : Number(x[2]), ny = y[2] === '' ? -1 : Number(y[2]);
  return nx - ny || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
}
/** [[Location, ชิ้น]] → "C3=2, D6=1" (รูปแบบเดียวกับไฟล์ระบบเดิม · v2.4.1) */
function locStr_(list) { return (list || []).map(function (x) { return x[0] + '=' + x[1]; }).join(', '); }

/** เลข Location ที่หายในแต่ละโซน: รวมทุกเครื่อง · เฉพาะช่วงเลขต่ำสุดถึงสูงสุดที่ใช้จริง (ป้ายที่พิมพ์เผื่อเกินเลขสูงสุดไม่นับ) */
function missingLocations_(names) {
  var zones = {};
  names.forEach(function (l) {
    var m = String(l).match(/^(.*?)(\d+)$/); if (!m) return;
    var z = zones[m[1]] || (zones[m[1]] = { nums: {}, pad: 0 });
    z.nums[Number(m[2])] = 1;
    if (m[2].length > 1 && m[2].charAt(0) === '0') z.pad = Math.max(z.pad, m[2].length);
  });
  return Object.keys(zones).sort().map(function (zn) {
    var z = zones[zn], nums = Object.keys(z.nums).map(Number).sort(function (a, b) { return a - b; });
    var lo = nums[0], hi = nums[nums.length - 1], miss = [];
    for (var i = lo; i <= hi; i++) if (!z.nums[i]) miss.push(zn + (z.pad ? ('0000000' + i).slice(-z.pad) : i));
    return { zone: zn, from: zn + lo, to: zn + hi, used: nums.length, missing: miss };
  }).filter(function (z) { return z.missing.length; });
}

function summary_(project, why) {
  var X = logIdx_(project, { write: true });
  var idx = X.verify(null, why);
  X.save();
  var cfg = readConfig_(), book = bookByMaterial_(), mats = {}, r3 = function (v) { return Math.round(v * 1000) / 1000; };
  Object.keys(X.locs).forEach(function (l) {
    var L = X.locs[l];
    Object.keys(L.items).forEach(function (k) {
      var it = L.items[k], m = mats[k] || (mats[k] = { key: k, dev: 0, locs: [] });
      m.dev = r3(m.dev + it.qty);
      if (it.qty !== 0) m.locs.push([l, r3(it.qty)]);   // v2.4.1 ยอดรวม Location ของ SKU นี้ (ทุกเครื่อง หลังล้าง)
    });
  });
  Object.keys(book).forEach(function (k) { var b = book[k]; if (!mats[k] && (b.book || b.it || b.qi || b.bl)) mats[k] = { key: k, dev: 0, locs: [] }; });
  // ปรับยอดด้วยมือ (v2.4.2): ยอดสุดท้าย = นับจากเครื่อง + ผลรวมบรรทัดใน Adjustments (รวมบรรทัดกลับรายการ) · Count_Log ไม่ถูกแตะ
  var A = adjRead_(project), adjBy = {};
  A.lines.forEach(function (a) {
    var x = adjBy[a.material] || (adjBy[a.material] = { qty: 0, lines: 0 });
    x.qty = r3(x.qty + a.qty); x.lines++;
    if (!mats[a.material] && book[a.material]) mats[a.material] = { key: a.material, dev: 0, locs: [] };
  });
  var T = { adjToBook: 0, adjLines: 0, adjByReason: [], book: 0, dev: 0, adj: 0, final: 0, plusQty: 0, minusQty: 0, plusValue: 0, minusValue: 0, skus: 0, match: 0, over: 0, short: 0, unmapped: 0, unmappedQty: 0, special: 0 };
  var skus = [], unmapped = [];
  Object.keys(mats).forEach(function (k) {
    var m = mats[k], b = book[k];
    if (!b) {   // ยิงแล้วแต่ไม่มีใน Master (BC:บาร์โค้ด) — เทียบบัญชีไม่ได้ ต้องจับคู่ก่อน
      m.locs.sort(function (a, b) { return natCmp_(a[0], b[0]); });
      if (m.dev !== 0) { unmapped.push([k.replace(/^BC:/, ''), m.dev, locStr_(m.locs), m.locs]); T.unmapped++; T.unmappedQty = r3(T.unmappedQty + m.dev); }
      T.dev = r3(T.dev + m.dev);
      return;
    }
    var aj = adjBy[k] || { qty: 0, lines: 0 }, adj = aj.qty, fin = r3(m.dev + adj), diff = r3(fin - b.book), val = Math.round(diff * b.cost * 100) / 100;
    var toBook = aj.lines > 0 && adj !== 0 && diff === 0;   // ป้าย "ปรับเท่ายอดบัญชีพอดี" — ไม่กัน แต่ให้ผู้ตรวจทานเห็น
    if (toBook) T.adjToBook++;
    T.skus++; T.book = r3(T.book + b.book); T.dev = r3(T.dev + m.dev); T.adj = r3(T.adj + adj);
    if (diff === 0) T.match++; else if (diff > 0) { T.over++; T.plusQty = r3(T.plusQty + diff); T.plusValue += val; } else { T.short++; T.minusQty = r3(T.minusQty + diff); T.minusValue += val; }
    if (b.it || b.qi || b.bl) T.special++;
    m.locs.sort(function (a, b) { return natCmp_(a[0], b[0]); });
    // [Material, ชื่อ, บัญชี, เครื่อง, ปรับ, สุดท้าย, ต่าง, ต้นทุน, ต่างบาท, IT, QI, BL, จำนวน Location, [[Location, ชิ้น]] (v2.4.1), [บาร์โค้ด] (v2.4.1),
    //  จำนวนบรรทัดปรับ (v2.4.2), ปรับเท่ายอดบัญชีพอดี (v2.4.2)]
    skus.push([k, b.name, b.book, m.dev, adj, fin, diff, b.cost, val, b.it, b.qi, b.bl, m.locs.length, m.locs, b.bcs, aj.lines, toBook]);
  });
  T.final = r3(T.dev + T.adj);
  T.adjLines = A.lines.length;
  T.adjByReason = A.byReason(function (m) { return (book[m] || {}).cost || 0; });
  T.plusValue = Math.round(T.plusValue * 100) / 100; T.minusValue = Math.round(T.minusValue * 100) / 100;
  T.diff = r3(T.final - T.book - T.unmappedQty);   // เทียบเฉพาะสินค้าที่มีในบัญชี
  T.diffValue = Math.round((T.plusValue + T.minusValue) * 100) / 100;
  T.pct = T.book ? Math.round(T.diff / T.book * 10000) / 100 : null;
  skus.sort(function (a, b) { return Math.abs(b[8]) - Math.abs(a[8]) || Math.abs(b[6]) - Math.abs(a[6]); });
  // Location
  var lt = table_('Locations'), names = {}, st = { total: 0, closed: 0, paused: 0, counting: 0, flagged: [], open: [] };
  lt.rows.forEach(function (r) {
    var L = rowObj_(lt, r); if (!L.Location) return;
    names[L.Location] = 1; st.total++;
    var s = String(L.Status);
    if (/ปิดแล้ว/.test(s)) st.closed++; else { if (/พัก/.test(s)) st.paused++; else st.counting++; st.open.push([L.Location, s, String(L.Owner || '')]); }
    if (L.Flag_Check) st.flagged.push([L.Location, String(L.Flag_Check)]);
  });
  Object.keys(X.locs).forEach(function (l) { names[l] = 1; });
  var bookSrc = Object.keys(book).length ? book[Object.keys(book)[0]].src : '';
  var last = null;   // ผลที่บันทึกล่าสุด (ใช้บนหัวใบเดินตรวจ · v2.4.1)
  readRaw_('Dash_Data').slice(1).forEach(function (r) { if (r[0] === 'SUMMARY_RUN') last = { run: Number(r[1]) || 0, at: r[2] }; });
  return { at: now_(), project: project, lastSave: last, complete: st.total > 0 && st.closed === st.total && !st.flagged.length,
    sap: { name: cfg.SAP_FILE_NAME || '', date: cfg.SAP_FILE_DATE || '', at: cfg.SAP_UPLOADED_AT || '' }, bookSource: bookSrc,
    totals: T, locs: st, missing: missingLocations_(Object.keys(names)), skus: skus, unmapped: unmapped, indexDiffs: idx,
    adjustments: A.view(book), staff: activeStaff_(), reasons: ADJ_REASONS };
}

/** หน้า Admin: สรุปผลนับ (ดูอย่างเดียว) */
function apiSummary() {
  return withLock_(function () {
    var project = readConfig_().PROJECT_ID;
    if (!project) throw new Error('ยังไม่ได้เปิดรอบนับ');
    return summary_(project, 'สรุปผลนับ (หน้า Admin)');
  });
}

/** สรุปผลและบันทึก: เก็บผลราย SKU ลงชีต Variance (ต่อท้าย) + Dash_Data + Admin_Log — เป็นหลักฐานว่าตอนนั้นตัวเลขเป็นอย่างไร */
function apiSummarySave() {
  return withLock_(function () {
    var project = readConfig_().PROJECT_ID;
    if (!project) throw new Error('ยังไม่ได้เปิดรอบนับ');
    var R = summary_(project, 'สรุปผลและบันทึก (หน้า Admin)'), T = R.totals, saved = 0;
    var dash = readRaw_('Dash_Data'), run = 1, prevSig = '', prevAt = '';
    dash.slice(1).forEach(function (r) {
      if (r[0] === 'SUMMARY_RUN') { run = (Number(r[1]) || 0) + 1; prevAt = r[2]; }
      if (r[0] === 'SUMMARY_SIG') prevSig = String(r[1]);
    });
    // ลายนิ้วมือของผล (v2.4.1): เหมือนครั้งก่อน = ตัวเลขทุก SKU ไม่เปลี่ยน แจ้งผู้ใช้ว่าบันทึกซ้ำ (ยังบันทึกให้ตามที่กด)
    var sig = summarySig_(R);
    var sapFile = R.sap.name + (R.sap.at ? ' (' + R.sap.at + ')' : '');
    adminAct_('SUMMARY_SAVE', project, 'ครั้งที่ ' + run + ' · ' + (R.complete ? 'นับครบ' : 'ยังนับไม่ครบ') + ' · บัญชี ' + T.book + ' นับ ' + T.final + ' ต่าง ' + T.diff +
      ' (' + (T.pct === null ? '-' : T.pct + '%') + ', ' + T.diffValue + ' บาท) · ' + R.skus.length + ' SKU · ไม่มีใน Master ' + T.unmapped + ' · ไฟล์ SAP ' + sapFile, function () {
      var rows = R.skus.map(function (x) {
        return [run, R.at, project, sapFile, x[0], x[1], x[2], R.bookSource, x[3], x[4], x[5], x[6], x[7], x[8], x[9], x[10], x[11], locStr_(x[13]), x[14].join(' ')];
      }).concat(R.unmapped.map(function (u) {
        return [run, R.at, project, sapFile, 'BC:' + u[0], '(ไม่มีใน Master)', '', '', u[1], 0, u[1], '', '', '', '', '', '', u[2], u[0]];
      }));
      saved = rows.length;
      if (rows.length) appendRows_(SpreadsheetApp.getActive().getSheetByName('Variance'), rows);
      writeTable_('Dash_Data', SHEETS.Dash_Data, [
        ['SUMMARY_RUN', run, R.at], ['BOOK_QTY', T.book, R.at], ['FINAL_QTY', T.final, R.at], ['DIFF_QTY', T.diff, R.at],
        ['DIFF_VALUE', T.diffValue, R.at], ['SKUS_OVER', T.over, R.at], ['SKUS_SHORT', T.short, R.at], ['UNMAPPED', T.unmapped, R.at],
        ['LOCATIONS_CLOSED', R.locs.closed + '/' + R.locs.total, R.at], ['SAP_FILE', sapFile, R.at], ['SUMMARY_SIG', sig, R.at]]);
      // ชีต Config เป็นข้อความ อ่านเวลา/ลายนิ้วมือกลับได้ตรงตามที่เขียน (Dash_Data อาจถูก Sheets แปลงเป็นวันที่) — ใช้ตรวจ K5 (v2.5.0)
      setConfig_({ SUMMARY_SAVED: JSON.stringify({ project: project, run: run, at: R.at, sig: sig }) });
    });
    R.run = run; R.saved = saved; R.same = !!prevSig && prevSig === sig; R.prevAt = prevAt;
    R.lastSave = { run: run, at: R.at };
    return R;
  });
}

/** ลายนิ้วมือของผลสรุป (v2.4.1 · แยกเป็นฟังก์ชัน v2.5.0 ใช้ตรวจ K5) */
function summarySig_(R) {
  var T = R.totals;
  return sha_(JSON.stringify([R.sap, T.book, T.final, R.skus.map(function (x) { return [x[0], x[2], x[5]]; }), R.unmapped, R.locs.closed, R.locs.total])).slice(0, 16);
}

/** ไล่ย้อน SKU: นับที่ Location ไหน เครื่องไหน ใครนับ เท่าไร */
function apiSkuDetail(key) {
  var project = readConfig_().PROJECT_ID;
  var X = logIdx_(project, {}), mt = table_('Loc_Members'), names = staffNames_(), staff = {}, out = [];
  mt.rows.forEach(function (r) { var m = rowObj_(mt, r); if (m.Project_ID === project) staff[m.Location + '|' + m.Device_ID] = normStaff_(m.Staff); });
  var lt = table_('Locations'), status = {};
  lt.rows.forEach(function (r) { var L = rowObj_(lt, r); status[L.Location] = String(L.Status || ''); });
  var all = X.loc(X.meta.locs || []);
  Object.keys(all).sort().forEach(function (l) {
    var it = all[l].items[key]; if (!it) return;
    // ยอดแยกเครื่อง = นับหลังล้าง Location ครั้งล่าสุด (รายการล้างไม่นับเป็นยอดติดลบของเครื่องที่กดล้าง · เหมือน v2.3.6)
    var per = it.sc || it.byDevice, sum = 0;
    Object.keys(per).forEach(function (d) {
      if (per[d] === 0) return;
      var s = staff[l + '|' + d] || '';
      sum += per[d];
      out.push([l, status[l] || '', d, s, names[s] || '', per[d]]);
    });
    // ยอดรวม Location ของ SKU นี้ไม่เท่าผลรวมแยกเครื่อง (ล้างตอนยังไม่เห็นยอดล่าสุดของเครื่องอื่น) → แถวส่วนต่างให้เห็น ไม่ซ่อน
    var rest = Math.round((it.qty - sum) * 1000) / 1000;
    if (rest !== 0) out.push([l, status[l] || '', '(ส่วนต่างจากการล้าง)', '', '', rest]);
  });
  var b = bookByMaterial_()[key] || null;
  var adj = adjRead_(project).view().filter(function (x) { return x[2] === key; });   // บรรทัดปรับยอดของ SKU นี้ (v2.4.2)
  return { key: key, book: b, rows: out, adjustments: adj };
}


// ---------- ปรับยอดด้วยมือ (เฟส 3 · v2.4.2) ----------
//
// ยอดสุดท้าย = นับจากเครื่อง (Count_Log) + บรรทัดปรับยอด (Adjustments) · ไม่มีผู้อนุมัติ จุดควบคุมคือร่องรอยครบ:
// บังคับเหตุผล + ผู้คีย์ (รหัสผู้ตรวจสอบ) · ตรวจรหัสสินค้ากับ Master · บันทึก Admin_Log ก่อนทำ · ไม่ลบไม่เขียนทับ
// คีย์ผิด = บรรทัดกลับรายการ (Ref_ID อ้างบรรทัดเดิม) แล้วคีย์ใหม่ · Count_Log ไม่ถูกแตะ

var ADJ_REASONS = [['RECOUNT', 'นับทวนกับพนักงานหน้าร้าน'], ['TRANSIT', 'สินค้าโอนระหว่างทาง'], ['OTHER', 'อื่น ๆ']];
var ADJ_REVERSAL = 'กลับรายการ';

function activeStaff_() {
  return readRaw_('Staff').slice(1).filter(function (r) { return r[0] && String(r[3]).toUpperCase() !== 'N'; })
    .map(function (r) { return [normStaff_(r[0]), String(r[1] || '')]; });
}

/** บรรทัดปรับยอดของรอบ + ตัวช่วยสรุป */
function adjRead_(project) {
  var H = SHEETS.Adjustments, c = function (n) { return H.indexOf(n); }, rows = readRaw_('Adjustments').slice(1);
  var lines = [], byId = {}, reversed = {};
  rows.forEach(function (r) {
    if (!r[c('Adj_ID')] || r[c('Project_ID')] !== project) return;
    var a = { id: r[c('Adj_ID')], time: r[c('Time')], material: r[c('Material')], name: r[c('Name')],
      qty: Number(String(r[c('Qty')]).replace(/,/g, '')) || 0, reason: r[c('Reason')], note: r[c('Note')], loc: r[c('Location')],
      staff: r[c('Staff_Code')], by: r[c('By')], ref: r[c('Ref_ID')], book: r[c('Book_Qty')], before: r[c('Final_Before')], after: r[c('Final_After')] };
    lines.push(a); byId[a.id] = a;
    if (a.ref) reversed[a.ref] = a.id;
  });
  return {
    lines: lines, byId: byId, reversed: reversed,
    /** ยอดปรับรวมตามเหตุผล: บรรทัดกลับรายการหักออกจากเหตุผลของบรรทัดเดิม · [[เหตุผล, บรรทัด, ชิ้น, บาท]] */
    byReason: function (costOf) {
      var g = {}, order = ADJ_REASONS.map(function (x) { return x[1]; });
      lines.forEach(function (a) {
        var reason = a.ref && byId[a.ref] ? byId[a.ref].reason : a.reason;
        var x = g[reason] || (g[reason] = [reason, 0, 0, 0]);
        if (!a.ref) x[1]++;
        x[2] = Math.round((x[2] + a.qty) * 1000) / 1000;
        x[3] = Math.round((x[3] + a.qty * costOf(a.material)) * 100) / 100;
      });
      return Object.keys(g).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); }).map(function (k) { return g[k]; });
    },
    /** สำหรับหน้า Admin: [Adj_ID, เวลา, Material, ชื่อ, ชิ้น, เหตุผล, หมายเหตุ, Location, ผู้คีย์, อีเมล, อ้างบรรทัด, ถูกกลับโดย, บัญชี, ก่อน, หลัง] */
    view: function () {
      return lines.map(function (a) {
        return [a.id, a.time, a.material, a.name, a.qty, a.reason, a.note, a.loc, a.staff, a.by, a.ref, reversed[a.id] || '', a.book, a.before, a.after];
      });
    }
  };
}

/** ยอดนับจากเครื่อง (ทุก Location) + ยอดปรับปัจจุบันของรหัสหนึ่ง */
function adjCurrent_(project, material) {
  var X = logIdx_(project), all = X.loc(X.meta.locs || []), dev = 0, adj = 0;
  Object.keys(all).forEach(function (l) { var it = all[l].items[material]; if (it) dev += it.qty; });
  adjRead_(project).lines.forEach(function (a) { if (a.material === material) adj += a.qty; });
  return { dev: r3_(dev), adj: r3_(adj), final: r3_(dev + adj), locs: Object.keys(all) };
}

function adjNextId_() {
  var n = 0;
  readRaw_('Adjustments').slice(1).forEach(function (r) { var m = String(r[0]).match(/^ADJ-(\d+)$/); if (m) n = Math.max(n, Number(m[1])); });
  return 'ADJ-' + ('0000' + (n + 1)).slice(-4);
}

/**
 * บันทึกบรรทัดปรับยอด · o = { material (หรือบาร์โค้ด), qty (+/−), reason (RECOUNT/TRANSIT/OTHER), note, location, staff }
 * คืนผลสรุปใหม่ทั้งหน้า + adjDone
 */
function apiAdjust(o) {
  return withLock_(function () {
    var project = readConfig_().PROJECT_ID;
    if (!project) throw new Error('ยังไม่ได้เปิดรอบนับ');
    o = o || {};
    var book = bookByMaterial_(), q = String(o.material || '').trim(), mat = '';
    if (book[q]) mat = q; else if (book[q.toUpperCase()]) mat = q.toUpperCase();
    else { var t = table_('Barcode_Map'); t.rows.forEach(function (r) { if (!mat && r[t.idx.Barcode] === q) mat = r[t.idx.Material]; }); }
    if (!mat) throw new Error('ไม่พบรหัสสินค้า "' + q + '" ใน Master — ปรับยอดได้เฉพาะสินค้าที่มีในบัญชี');
    var qty = Number(String(o.qty === undefined ? '' : o.qty).replace(/,/g, ''));
    if (!isFinite(qty) || qty === 0) throw new Error('จำนวนต้องเป็นตัวเลขที่ไม่ใช่ 0 (เพิ่ม = บวก · ลด = ลบ)');
    if (Math.abs(qty) > 100000) throw new Error('จำนวนเกิน 100,000 ชิ้น — ตรวจตัวเลขอีกครั้ง');
    qty = Math.round(qty * 1000) / 1000;
    var rs = ADJ_REASONS.filter(function (x) { return x[0] === o.reason; })[0];
    if (!rs) throw new Error('เลือกเหตุผล');
    var note = String(o.note || '').trim();
    if (o.reason === 'OTHER' && !note) throw new Error('เหตุผล "อื่น ๆ" ต้องเขียนหมายเหตุอธิบาย');
    var staff = normStaff_(o.staff), st = activeStaff_().filter(function (x) { return x[0] === staff; })[0];
    if (!st) throw new Error('เลือกรหัสผู้ตรวจสอบที่คีย์');
    var cur = adjCurrent_(project, mat), loc = o.location ? normLoc_(o.location) : '';
    if (loc && cur.locs.indexOf(loc) < 0 && locIdx_(table_('Locations'), loc) < 0) throw new Error('ไม่มี Location "' + loc + '" ในรอบนี้ (เว้นว่างได้)');
    var b = book[mat], id = adjNextId_(), after = r3_(cur.final + qty);
    adminAct_('ADJUST', mat, id + ' · ' + (qty > 0 ? '+' : '') + qty + ' · ' + rs[1] + (note ? ' (' + note + ')' : '') + (loc ? ' · ' + loc : '') +
      ' · ผู้คีย์ ' + staff + ' · ยอดสุดท้าย ' + cur.final + ' → ' + after + ' · บัญชี ' + b.book + (after === b.book ? ' · ปรับเท่ายอดบัญชีพอดี' : ''), function () {
      appendRows_(SpreadsheetApp.getActive().getSheetByName('Adjustments'),
        [[id, now_(), project, mat, b.name, qty, rs[1], note, loc, staff, who_(), '', b.book, cur.final, after]]);
    });
    var R = summary_(project, 'ปรับยอด (หน้า Admin)');
    R.adjDone = { id: id, material: mat, name: b.name, qty: qty, before: cur.final, after: after, book: b.book };
    return R;
  });
}

/** กลับรายการ: บรรทัดใหม่จำนวนตรงข้าม อ้าง Ref_ID · บรรทัดเดิมคงอยู่ · กลับซ้ำ / กลับบรรทัดกลับรายการ ไม่ได้ */
function apiAdjustReverse(id, staff, why) {
  return withLock_(function () {
    var project = readConfig_().PROJECT_ID;
    if (!project) throw new Error('ยังไม่ได้เปิดรอบนับ');
    why = String(why || '').trim();
    if (!why) throw new Error('ต้องใส่เหตุผลที่กลับรายการ');
    staff = normStaff_(staff);
    if (!activeStaff_().some(function (x) { return x[0] === staff; })) throw new Error('เลือกรหัสผู้ตรวจสอบที่คีย์');
    var A = adjRead_(project), a = A.byId[id];
    if (!a) throw new Error('ไม่พบบรรทัด ' + id + ' ในรอบนี้');
    if (a.ref) throw new Error(id + ' เป็นบรรทัดกลับรายการ กลับซ้ำไม่ได้ — ถ้าต้องการยอดเดิม ให้คีย์บรรทัดใหม่');
    if (A.reversed[id]) throw new Error(id + ' ถูกกลับรายการแล้วโดย ' + A.reversed[id]);
    var cur = adjCurrent_(project, a.material), nid = adjNextId_(), after = r3_(cur.final - a.qty), b = bookByMaterial_()[a.material] || { book: '' };
    adminAct_('ADJUST_REVERSE', a.material, nid + ' กลับรายการ ' + id + ' (' + (a.qty > 0 ? '+' : '') + a.qty + ' ' + a.reason + ') · เหตุผล: ' + why +
      ' · ผู้คีย์ ' + staff + ' · ยอดสุดท้าย ' + cur.final + ' → ' + after, function () {
      appendRows_(SpreadsheetApp.getActive().getSheetByName('Adjustments'),
        [[nid, now_(), project, a.material, a.name, -a.qty, ADJ_REVERSAL, why, a.loc, staff, who_(), id, b.book, cur.final, after]]);
    });
    var R = summary_(project, 'กลับรายการปรับยอด (หน้า Admin)');
    R.adjDone = { id: nid, material: a.material, name: a.name, qty: -a.qty, before: cur.final, after: after, book: b.book, reversed: id };
    return R;
  });
}
