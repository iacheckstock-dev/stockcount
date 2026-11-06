/**
 * Code.gs — ฝั่งเซิร์ฟเวอร์ (Apps Script ผูกกับไฟล์ Google Sheets หลัก)
 * เฟส 1: สร้างชีต, เปิดรอบ, นำเข้า SAP/POS, Barcode_Map, ตรวจความพร้อม, ตัดสินขัดแย้ง, อนุมัติ Master
 *
 * หน้า Admin เปิดจากเมนู "ระบบตรวจนับ" ใน Sheets เท่านั้น จึงใช้ได้เฉพาะคนที่มีสิทธิ์แก้ไขไฟล์
 * (API สำหรับ TC21 จะเพิ่มในเฟส 2 แยกต่างหาก และต้องใช้ device token)
 */

var SCHEMA_VERSION = 4;

/**
 * เวอร์ชันของระบบ (ใช้เลขเดียวทั้งแอป TC21 และเซิร์ฟเวอร์ ตาม Semantic Versioning MAJOR.MINOR.PATCH)
 * ต้องตรงกับ APP_VERSION ใน app/app.js และ appVersion ใน app/config.json — ดู CHANGELOG.md
 */
var SYSTEM_VERSION = '2.2.1';

var SHEETS = {
  Config: ['Key', 'Value', 'Note'],
  Staff: ['Staff_Code', 'Name', 'Role', 'Active'],
  Devices: ['Device_ID', 'Name', 'Active', 'Last_Seq', 'Last_Sync', 'Gaps', 'App_Version', 'Last_Check_At', 'Last_Check',
    'Paired_At', 'Token_Hash', 'Pair_Code', 'Pair_Expires', 'Pair_Fails'],
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
  Count_History: ['Project_ID', 'Count_Date', 'SAP_Qty', 'Net_Count', 'Diff_Qty', 'Diff_Value', 'Diff_Items', 'Edits',
    'Archive_Link', 'Checksum'],
  Admin_Log: ['Time', 'By', 'Action', 'Target', 'Detail']
};

// คอลัมน์ที่ต้องเป็นข้อความ (กันเลข 0 นำหน้าหาย / 8.85E+12)
var TEXT_COLS = {
  Barcode_Map: ['Barcode', 'Material', 'Cust_Mat'],
  SAP_POS_Compare: ['Material', 'Cust_Mat', 'SAP_Barcode', 'POS_Barcode', 'Final_Barcode'],
  Device_Master: ['Barcode', 'Material', 'Cust_Mat'],
  Count_Log: ['Log_ID', 'Device_ID', 'Staff_Code', 'Location', 'Barcode', 'Material', 'Ref_ID'],
  Locations: ['Location'],
  Loc_Checks: ['Device_ID', 'Location'],
  Loc_Members: ['Location', 'Device_ID'],
  Quarantine: ['Device_ID', 'Log_ID'],
  Staff: ['Staff_Code'],
  Devices: ['Device_ID', 'Pair_Code']
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
  ['API_URL', '', 'URL ของ Web app ที่เครื่องใช้ (Deployment ที่ Active ลงท้าย /exec) — ต้องตรงกับ app/config.json']
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

function ensureSetup_() {
  var ss = SpreadsheetApp.getActive();
  var missing = Object.keys(SHEETS).some(function (n) { return !ss.getSheetByName(n); });
  var cfg = readConfig_();
  if (missing || Number(cfg.SCHEMA_VERSION || 0) < SCHEMA_VERSION) {
    setupSheets();
    setConfig_({ SCHEMA_VERSION: SCHEMA_VERSION });
  }
}

// ---------- Config / Log ----------

function readConfig_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Config');
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
    if (r[0]) out[r[0]] = r[1];
  });
  return out;
}

function setConfig_(obj) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Config');
  var keys = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  Object.keys(obj).forEach(function (k) {
    var i = keys.indexOf(k);
    var v = obj[k] === null || obj[k] === undefined ? '' : String(obj[k]);
    if (i >= 0) sh.getRange(i + 2, 2).setValue(v);
    else { sh.appendRow([k, v, '']); keys.push(k); }
  });
}

function who_() {
  return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'unknown';
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
}

function logAdmin_(action, target, detail) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Admin_Log');
  if (!sh) return;
  sh.appendRow([now_(), who_(), action, target || '', detail || '']);
}

function withLock_(fn) {
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
    spreadsheetUrl: SpreadsheetApp.getActive().getUrl(),
    round: { projectId: cfg.PROJECT_ID, countDate: cfg.COUNT_DATE, status: cfg.ROUND_STATUS || 'NONE' },
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
    log: log.slice(1).slice(-50).reverse()
  };
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
      sh.appendRow([t, 'ACK หลังอนุมัติ v' + cfg.MASTER_APPROVED_VERSION, m.hash, c.level, c.title, c.count, 'รับทราบ', c.note, by]);
    });
    logAdmin_('ACK_WARNING', 'v' + cfg.MASTER_APPROVED_VERSION, ids.join(', '));
    return apiGetState();
  });
}

function apiGetCompare() {
  var m = computeMaster_();
  return m.compare;
}

function apiOpenRound(projectId, countDate) {
  return withLock_(function () {
    projectId = String(projectId || '').trim().toUpperCase();
    countDate = String(countDate || '').trim();
    if (!/^\d{4}Q[1-4](-R\d+)?$/.test(projectId)) throw new Error('รหัสรอบต้องเป็นรูปแบบ 2026Q4 หรือ 2026Q4-R1');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(countDate)) throw new Error('วันนับไม่ถูกต้อง');
    var cfg = readConfig_();
    var st = cfg.ROUND_STATUS || 'NONE';
    if (st !== 'NONE' && st !== 'SETUP' && st !== 'CLOSED') {
      throw new Error('รอบ ' + cfg.PROJECT_ID + ' อยู่ในสถานะ ' + st + ' ต้องปิดรอบก่อนจึงเปิดรอบใหม่ได้');
    }
    setConfig_({ PROJECT_ID: projectId, COUNT_DATE: countDate, ROUND_STATUS: 'SETUP' });
    logAdmin_('OPEN_ROUND', projectId, 'วันนับ ' + countDate + (st === 'SETUP' && cfg.PROJECT_ID ? ' (แก้จาก ' + cfg.PROJECT_ID + ' ' + cfg.COUNT_DATE + ')' : ''));
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
    else sh.appendRow(row);
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

    writeTable_('Device_Master', SHEETS.Device_Master, m.deviceRows);
    var cfg = m.cfg;
    var version = (parseInt(cfg.MASTER_APPROVED_VERSION, 10) || 0) + 1;
    setConfig_({
      MASTER_APPROVED_HASH: m.hash, MASTER_APPROVED_VERSION: version, MASTER_APPROVED_AT: now_(),
      MASTER_APPROVED_BY: who_(), MASTER_APPROVED_COUNT: m.deviceRows.length,
      MASTER_APPROVED_PROJECT: cfg.PROJECT_ID, MASTER_APPROVED_ACK: warns.join(',')
    });
    var sh = SpreadsheetApp.getActive().getSheetByName('Master_Check');
    sh.appendRow([now_(), 'APPROVE v' + version, m.hash, '', 'อนุมัติ Master', m.deviceRows.length, 'อนุมัติ',
      'รับทราบคำเตือน: ' + (warns.join(', ') || '-') + (m.hasSap ? '' : ' (ยอดชั่วคราวจาก POS)'), who_()]);
    logAdmin_('APPROVE_MASTER', 'v' + version, m.hash + ', ' + m.deviceRows.length + ' รายการ');
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
    mc.appendRow([now_(), 'RESET', '', '', 'ล้างข้อมูลรอบ ' + (cfg.PROJECT_ID || ''), '', '', '', who_()]);
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
      pairCode: pairLive ? d.Pair_Code : '', pairExpires: pairLive ? Number(d.Pair_Expires) : 0
    };
  });
  var staff = table_('Staff');
  var q = readRaw_('Quarantine');
  var locs = table_('Locations');
  return {
    apiUrl: cfg.API_URL || '',
    appUrl: cfg.APP_URL,
    projectId: cfg.PROJECT_ID,
    devices: devices,
    staff: staff.rows.map(function (r) { return rowObj_(staff, r); }).filter(function (s) { return s.Staff_Code; })
      .map(function (s) { return { code: normStaff_(s.Staff_Code), name: s.Name, role: s.Role, active: String(s.Active).toUpperCase() !== 'N' }; }),
    quarantine: Math.max(0, q.length - 1),
    locations: locs.rows.filter(function (r) { return r[0]; }).map(function (r) { return rowObj_(locs, r); }),
    members: membersForAdmin_(cfg.PROJECT_ID),
    imports: readRaw_('Import_Files').slice(1).slice(-20).reverse()
  };
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

/** สร้างรหัสจับคู่ 6 หลัก ใช้ได้ 30 นาที ครั้งเดียว; จับคู่ใหม่จะทำให้ token เดิมของเครื่องนั้นใช้ไม่ได้ */
function apiPairCode(deviceId) {
  return withLock_(function () {
    var t = table_('Devices');
    var i = findDevice_(t, deviceId);
    if (i < 0) throw new Error('ไม่พบเครื่อง ' + deviceId);
    var code = String(Math.floor(100000 + Math.random() * 900000));
    putRow_(t, i, { Pair_Code: code, Pair_Expires: Date.now() + PAIR_MINUTES * 60000, Pair_Fails: 0, Active: 'Y' });
    logAdmin_('DEVICE_PAIR_CODE', deviceId, 'สร้างรหัสจับคู่ (หมดอายุใน ' + PAIR_MINUTES + ' นาที)');
    return apiDevicesState();
  });
}

function apiSetDeviceActive(deviceId, active) {
  return withLock_(function () {
    var t = table_('Devices');
    var i = findDevice_(t, deviceId);
    if (i < 0) throw new Error('ไม่พบเครื่อง ' + deviceId);
    var upd = { Active: active ? 'Y' : 'N' };
    if (!active) { upd.Token_Hash = ''; upd.Pair_Code = ''; upd.Pair_Expires = ''; }
    putRow_(t, i, upd);
    logAdmin_(active ? 'DEVICE_ENABLE' : 'DEVICE_REVOKE', deviceId, active ? 'เปิดใช้งาน' : 'ยกเลิกเครื่อง (token เดิมใช้ไม่ได้)');
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
