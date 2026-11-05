/**
 * Code.gs — ฝั่งเซิร์ฟเวอร์ (Apps Script ผูกกับไฟล์ Google Sheets หลัก)
 * เฟส 1: สร้างชีต, เปิดรอบ, นำเข้า SAP/POS, Barcode_Map, ตรวจความพร้อม, ตัดสินขัดแย้ง, อนุมัติ Master
 *
 * หน้า Admin เปิดจากเมนู "ระบบตรวจนับ" ใน Sheets เท่านั้น จึงใช้ได้เฉพาะคนที่มีสิทธิ์แก้ไขไฟล์
 * (API สำหรับ TC21 จะเพิ่มในเฟส 2 แยกต่างหาก และต้องใช้ device token)
 */

var SCHEMA_VERSION = 1;

var SHEETS = {
  Config: ['Key', 'Value', 'Note'],
  Staff: ['Staff_Code', 'Name', 'Role', 'Active'],
  Devices: ['Device_ID', 'Name', 'Last_Seq', 'Last_Sync', 'Token_Hash', 'Active'],
  Locations: ['Location', 'Zone', 'Status', 'Counters', 'Devices', 'Closed_Time', 'Device_Lines', 'Device_Qty'],
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
    'Entry_Type', 'Ref_ID', 'Reason', 'Note', 'Scan_Time', 'Received_Time', 'Source', 'Entered_By', 'Requested_By'],
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
  Staff: ['Staff_Code'],
  Devices: ['Device_ID']
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
  ['MASTER_APPROVED_COUNT', '', 'จำนวนบาร์โค้ดที่ส่งลงเครื่อง']
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
    if (header && sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#f0efec');
      sh.setFrozenRows(1);
    }
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

function ensureSetup_() {
  var ss = SpreadsheetApp.getActive();
  var missing = Object.keys(SHEETS).some(function (n) { return !ss.getSheetByName(n); });
  if (missing) setupSheets();
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
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('มีคนกำลังบันทึกข้อมูลอยู่ ลองใหม่อีกครั้ง');
  try { return fn(); } finally { lock.releaseLock(); }
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
    countDate: cfg.COUNT_DATE, sapFileDate: cfg.SAP_FILE_DATE, posFileDate: cfg.POS_FILE_DATE
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
    return [t, 'CHECK: ' + reason, m.hash, c.level, c.title, c.count, c.pass ? 'ผ่าน' : (c.level === 'BLOCK' ? 'บล็อก' : 'เตือน'), c.note, by];
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
        current: !!cfg.MASTER_APPROVED_HASH && cfg.MASTER_APPROVED_HASH === m.hash
      }
    },
    log: log.slice(1).slice(-50).reverse()
  };
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
      MASTER_APPROVED_BY: who_(), MASTER_APPROVED_COUNT: m.deviceRows.length
    });
    var sh = SpreadsheetApp.getActive().getSheetByName('Master_Check');
    sh.appendRow([now_(), 'APPROVE v' + version, m.hash, '', 'อนุมัติ Master', m.deviceRows.length, 'อนุมัติ',
      'รับทราบคำเตือน: ' + (warns.join(', ') || '-') + (m.hasSap ? '' : ' (ยอดชั่วคราวจาก POS)'), who_()]);
    logAdmin_('APPROVE_MASTER', 'v' + version, m.hash + ', ' + m.deviceRows.length + ' บาร์โค้ด');
    return apiGetState();
  });
}

// ---------- ล้างข้อมูลรอบ (ใช้ได้เฉพาะก่อนเริ่มนับ) ----------

var RESET_CONFIG_KEYS = ['PROJECT_ID', 'COUNT_DATE', 'SAP_FILE_NAME', 'SAP_FILE_DATE', 'SAP_UPLOADED_AT', 'SAP_UPLOADED_BY',
  'SAP_D1_CONFIRMED', 'POS_FILE_NAME', 'POS_FILE_DATE', 'POS_UPLOADED_AT', 'POS_UPLOADED_BY', 'MASTER_APPROVED_HASH',
  'MASTER_APPROVED_AT', 'MASTER_APPROVED_BY', 'MASTER_APPROVED_COUNT'];

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
