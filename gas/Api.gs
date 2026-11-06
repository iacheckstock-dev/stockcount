/**
 * Api.gs — API สำหรับเว็บแอป TC21 (เฟส 2)
 *
 * Deploy เป็น Web app: Execute as = Me, Who has access = Anyone
 * ทุกคำขอ (ยกเว้น ping/pair) ต้องมี deviceId + token ที่ได้จากการจับคู่เครื่องในหน้า Admin
 * คำขอส่งเป็น POST text/plain (JSON) เพื่อไม่ให้เบราว์เซอร์ส่ง preflight
 */

var API_VERSION = 2;
var ENTRY_TYPES = ['SCAN', 'MANUAL', 'VOID', 'FOUND', 'RECOUNT_SET', 'SWAP', 'SALE', 'HOLD'];
var SYNC_STATUSES = ['SETUP', 'COUNTING', 'COUNT_CLOSED'];
var PAIR_MINUTES = 30;
var PAIR_MAX_FAILS = 5;

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ping') return json_({ ok: true, serverTime: Date.now(), api: API_VERSION, serverVersion: SYSTEM_VERSION });
  return HtmlService.createHtmlOutput('<p>Stock Count API v' + API_VERSION + '</p>');
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'BAD_JSON' });
  }
  try {
    var out;
    switch (req.action) {
      case 'ping': out = { ok: true }; break;
      case 'pair': out = apiPair_(req); break;
      case 'bootstrap': out = apiBootstrap_(auth_(req)); break;
      case 'master': out = apiMaster_(auth_(req)); break;
      case 'stock': out = apiStock_(auth_(req)); break;
      case 'sync': out = apiSync_(auth_(req), req); break;
      case 'locStatus': out = apiLocStatus_(auth_(req), req); break;
      case 'check': out = apiCheck_(auth_(req), req); break;
      default: out = { ok: false, error: 'UNKNOWN_ACTION' };
    }
    out.serverTime = Date.now();
    out.serverVersion = SYSTEM_VERSION;
    return json_(out);
  } catch (err) {
    var code = err && err.code ? err.code : 'SERVER_ERROR';
    return json_({ ok: false, error: code, message: String(err && err.message || err), serverTime: Date.now(), serverVersion: SYSTEM_VERSION });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function apiError_(code, message) {
  var e = new Error(message || code);
  e.code = code;
  return e;
}

// ---------- ตารางแบบอ้างคอลัมน์ด้วยชื่อ ----------

function table_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), 1);
  var values = lastRow ? sh.getRange(1, 1, lastRow, lastCol).getDisplayValues() : [[]];
  var header = values[0];
  var idx = {};
  header.forEach(function (h, i) { if (h) idx[h] = i; });
  return { sh: sh, header: header, idx: idx, rows: values.slice(1) };
}

function rowObj_(t, row) {
  var o = {};
  t.header.forEach(function (h, i) { if (h) o[h] = row[i]; });
  return o;
}

/** เขียนค่าตามชื่อคอลัมน์ลงแถวที่ rowIndex (0 = แถวแรกหลังหัวตาราง) หรือเพิ่มแถวใหม่ถ้า rowIndex < 0 */
function putRow_(t, rowIndex, obj) {
  var row = rowIndex >= 0 ? t.rows[rowIndex].slice() : new Array(t.header.length).fill('');
  Object.keys(obj).forEach(function (k) {
    if (t.idx[k] !== undefined) row[t.idx[k]] = obj[k] === null || obj[k] === undefined ? '' : obj[k];
  });
  if (rowIndex >= 0) {
    t.sh.getRange(rowIndex + 2, 1, 1, row.length).setValues([row]);
    t.rows[rowIndex] = row;
  } else {
    appendRows_(t.sh, [row]);
    t.rows.push(row);
  }
}

function appendRows_(sh, rows) {
  if (!rows.length) return;
  var start = sh.getLastRow() + 1;
  var need = start + rows.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 500);
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

function sha_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ---------- เครื่อง ----------

function findDevice_(t, deviceId) {
  for (var i = 0; i < t.rows.length; i++) if (t.rows[i][t.idx.Device_ID] === deviceId) return i;
  return -1;
}

function auth_(req) {
  var deviceId = String(req.deviceId || '');
  var t = table_('Devices');
  var i = findDevice_(t, deviceId);
  if (i < 0) throw apiError_('UNKNOWN_DEVICE', 'ไม่พบเครื่อง ' + deviceId);
  var d = rowObj_(t, t.rows[i]);
  if (d.Active !== 'Y') throw apiError_('DEVICE_DISABLED', 'เครื่องนี้ถูกปิดใช้งาน');
  if (!d.Token_Hash || sha_(req.token || '') !== d.Token_Hash) throw apiError_('BAD_TOKEN', 'token ไม่ถูกต้อง ต้องจับคู่เครื่องใหม่');
  return { deviceId: deviceId, table: t, row: i, device: d, appVersion: String(req.appVersion || '') };
}

function apiPair_(req) {
  return withLock_(function () {
    var deviceId = String(req.deviceId || '').toUpperCase().trim();
    var code = String(req.code || '').trim();
    var t = table_('Devices');
    var i = findDevice_(t, deviceId);
    if (i < 0) throw apiError_('UNKNOWN_DEVICE', 'ไม่พบเครื่อง ' + deviceId + ' ในระบบ');
    var d = rowObj_(t, t.rows[i]);
    if (d.Active !== 'Y') throw apiError_('DEVICE_DISABLED', 'เครื่องนี้ถูกปิดใช้งาน');
    if (!d.Pair_Code || !d.Pair_Expires || Date.now() > Number(d.Pair_Expires)) {
      throw apiError_('NO_PAIR_CODE', 'ไม่มีรหัสจับคู่ หรือหมดอายุแล้ว ให้สร้างรหัสใหม่ในหน้า Admin');
    }
    if (code !== d.Pair_Code) {
      var fails = (parseInt(d.Pair_Fails, 10) || 0) + 1;
      var upd = { Pair_Fails: fails };
      if (fails >= PAIR_MAX_FAILS) { upd.Pair_Code = ''; upd.Pair_Expires = ''; }
      putRow_(t, i, upd);
      throw apiError_('BAD_PAIR_CODE', fails >= PAIR_MAX_FAILS ? 'ใส่รหัสผิดเกินกำหนด รหัสถูกยกเลิก ให้สร้างรหัสใหม่' : 'รหัสจับคู่ไม่ถูกต้อง');
    }
    var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    putRow_(t, i, { Token_Hash: sha_(token), Pair_Code: '', Pair_Expires: '', Pair_Fails: 0, Paired_At: now_(), App_Version: req.appVersion || '' });
    var maxSeq = deviceMaxSeqAll_(deviceId);
    logAdmin_('DEVICE_PAIRED', deviceId, 'จับคู่เครื่องสำเร็จ (Seq ล่าสุดที่เซิร์ฟเวอร์มี ' + maxSeq + ')');
    return { ok: true, deviceId: deviceId, token: token, deviceName: d.Name || deviceId, maxSeqAll: maxSeq };
  });
}

function apiBootstrap_(a) {
  var cfg = readConfig_();
  var staff = table_('Staff');
  var list = staff.rows.map(function (r) { return rowObj_(staff, r); })
    .filter(function (s) { return s.Staff_Code && String(s.Active).toUpperCase() !== 'N'; })
    .map(function (s) { return { code: normStaff_(s.Staff_Code), name: s.Name, role: s.Role }; });
  var m = computeMaster_();
  var approvedOk = approvedCurrent_(cfg, m);
  var seqInfo = deviceSeqInfo_(a.deviceId, cfg.PROJECT_ID);
  putRow_(a.table, a.row, { Last_Sync: now_(), App_Version: a.appVersion });
  return {
    ok: true,
    project: { id: cfg.PROJECT_ID, countDate: cfg.COUNT_DATE, status: cfg.ROUND_STATUS || 'NONE' },
    master: { approved: approvedOk, hash: approvedOk ? cfg.MASTER_APPROVED_HASH : '', version: cfg.MASTER_APPROVED_VERSION, count: cfg.MASTER_APPROVED_COUNT },
    staff: list,
    stockVersion: stockVersion_(cfg),
    device: { id: a.deviceId, name: a.device.Name || a.deviceId, maxSeq: seqInfo.max, received: seqInfo.count, gaps: seqInfo.gaps,
      maxSeqAll: deviceMaxSeqAll_(a.deviceId) }
  };
}

function normStaff_(code) {
  return String(code || '').trim().toUpperCase().replace(/^EMP:/, '');
}

function apiMaster_(a) {
  var cfg = readConfig_();
  if (!cfg.MASTER_APPROVED_HASH || cfg.MASTER_APPROVED_PROJECT !== cfg.PROJECT_ID) {
    throw apiError_('MASTER_NOT_APPROVED', 'ยังไม่มี Master ที่อนุมัติสำหรับรอบ ' + (cfg.PROJECT_ID || '-'));
  }
  var rows = readRaw_('Device_Master').slice(1).filter(function (r) { return r[0] || r[1]; });
  return { ok: true, projectId: cfg.PROJECT_ID, hash: cfg.MASTER_APPROVED_HASH, version: cfg.MASTER_APPROVED_VERSION, rows: rows };
}

// ---------- ยอด Stock สำหรับแสดงบนเครื่อง ----------
// การแสดงยอดบัญชีบนเครื่องเป็นการยอมรับความเสี่ยง (ดูสเปก: ยอมรับความเสี่ยงเรื่องแสดง Stock)
// ยอดมาจาก Barcode_Map ปัจจุบัน: SAP Qty-UR ถ้ายังไม่มี SAP ใช้ยอด POS ชั่วคราว

/** เปลี่ยนเมื่อมีการอัปโหลด SAP/POS ใหม่ เครื่องใช้ตัดสินว่าต้องโหลดยอดใหม่หรือไม่ */
function stockVersion_(cfg) {
  return String(cfg.SAP_UPLOADED_AT || '') + '|' + String(cfg.POS_UPLOADED_AT || '');
}

function apiStock_(a) {
  var cfg = readConfig_();
  var t = table_('Barcode_Map');
  var seen = {}, rows = [], source = '';
  t.rows.forEach(function (r) {
    var mat = r[t.idx.Material];
    if (!mat || seen[mat]) return;
    seen[mat] = true;
    if (!source) source = r[t.idx.Book_Source];
    rows.push([mat, Number(r[t.idx.Book_Qty]) || 0]);
  });
  return { ok: true, projectId: cfg.PROJECT_ID, version: stockVersion_(cfg), source: source || '', rows: rows };
}

// ---------- ตรวจลำดับ Seq ----------

/** อ่าน Log_ID ทั้งหมด (คอลัมน์ A–D) ครั้งเดียว ใช้ทั้งกันซ้ำและตรวจช่องว่าง */
function logIndex_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Count_Log');
  var n = sh.getLastRow() - 1;
  var vals = n > 0 ? sh.getRange(2, 1, n, 4).getDisplayValues() : [];
  var ids = {};
  vals.forEach(function (r) { ids[r[0]] = r; });
  return { sh: sh, ids: ids, rows: vals };
}

function seqStats_(rows, deviceId, projectId) {
  var seqs = rows.filter(function (r) { return r[2] === deviceId && r[1] === projectId; })
    .map(function (r) { return parseInt(r[3], 10); }).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
  var gaps = [];
  for (var i = 1; i < seqs.length && gaps.length < 50; i++) {
    for (var s = seqs[i - 1] + 1; s < seqs[i] && gaps.length < 50; s++) gaps.push(s);
  }
  return { count: seqs.length, min: seqs[0] || 0, max: seqs[seqs.length - 1] || 0, gaps: gaps };
}

/**
 * Seq สูงสุดของเครื่องนี้ที่เซิร์ฟเวอร์เคยได้รับ (ทุกรอบ รวม Quarantine)
 * เครื่องที่ข้อมูลในเบราว์เซอร์ถูกล้างแล้วจับคู่ใหม่ ต้องเริ่มต่อจากเลขนี้ ไม่อย่างนั้น Log_ID จะชนกับของเดิมและถูกมองว่าซ้ำ
 */
function deviceMaxSeqAll_(deviceId) {
  var max = 0, prefix = deviceId + '-';
  function scan(ids) {
    ids.forEach(function (id) {
      if (String(id).indexOf(prefix) === 0) { var n = parseInt(String(id).slice(prefix.length), 10); if (n > max) max = n; }
    });
  }
  scan(Object.keys(logIndex_().ids));
  scan(Object.keys(quarantineIds_()));
  return max;
}

function deviceSeqInfo_(deviceId, projectId) {
  return seqStats_(logIndex_().rows, deviceId, projectId);
}

// ---------- รับข้อมูลการนับ ----------

/**
 * req.entries: [{logId, seq, projectId, staff, location, barcode, material, qty, type, refId, reason, note, scanTime}]
 * req.events:  [{id, type: 'OPEN'|'CLOSE'|'EDIT', projectId, location, staff, time, lines, qty, upToSeq}]
 */
function apiSync_(a, req) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw apiError_('BUSY', 'เซิร์ฟเวอร์กำลังรับข้อมูลจากเครื่องอื่น จะลองส่งใหม่อัตโนมัติ');
  try {
    var res = ingest_(a.deviceId, req.entries || [], req.events || [], 'SYNC', a.device);
    putRow_(a.table, a.row, { Last_Seq: res.seq.max, Last_Sync: now_(), App_Version: a.appVersion, Gaps: res.seq.gaps.length });
    res.ok = true;
    var cfg = readConfig_();
    res.masterHash = cfg.MASTER_APPROVED_PROJECT === cfg.PROJECT_ID ? cfg.MASTER_APPROVED_HASH : '';
    res.stockVersion = stockVersion_(cfg);
    return res;
  } finally {
    lock.releaseLock();
  }
}

/**
 * รวมรายการเข้า Count_Log (ใช้ทั้ง sync และนำเข้าไฟล์)
 * คืน { accepted:[], duplicate:[], quarantined:[], rejected:[{logId,reason}], events:[{id, location, match}], seq }
 */
function ingest_(deviceId, entries, events, source, device) {
  var cfg = readConfig_();
  var project = cfg.PROJECT_ID;
  var statusOk = SYNC_STATUSES.indexOf(cfg.ROUND_STATUS) >= 0;
  var idx = logIndex_();
  var out = { accepted: [], duplicate: [], quarantined: [], rejected: [], events: [] };
  var rows = [], qrows = [];
  var received = now_();
  var qIds = null;

  entries.forEach(function (e) {
    var logId = String(e.logId || '');
    var bad = validateEntry_(e, deviceId, source);
    if (bad) { out.rejected.push({ logId: logId, reason: bad }); return; }
    if (idx.ids[logId]) { out.duplicate.push(logId); return; }
    if (e.projectId !== project || !statusOk) {
      // ข้อมูลรอบอื่น / รอบปิดแล้ว: แยกไว้ ไม่รวมยอด แจ้ง Admin
      if (!qIds) qIds = quarantineIds_();
      if (!qIds[logId]) {
        qrows.push([received, deviceId, logId, String(e.projectId || ''), JSON.stringify(e),
          e.projectId !== project ? 'รอบไม่ตรง (ปัจจุบัน ' + (project || '-') + ')' : 'รอบอยู่ในสถานะ ' + cfg.ROUND_STATUS]);
        qIds[logId] = true;
      }
      out.quarantined.push(logId);
      return;
    }
    idx.ids[logId] = true;
    var row = [logId, project, deviceId, Number(e.seq), normStaff_(e.staff), normLoc_(e.location), String(e.barcode || ''),
      String(e.material || ''), Number(e.qty), e.type, String(e.refId || ''), String(e.reason || ''), String(e.note || ''),
      String(e.scanTime || ''), received, source, normStaff_(e.enteredBy || e.staff), normStaff_(e.requestedBy || '')];
    rows.push(row);
    idx.rows.push([logId, project, deviceId, String(e.seq)]);
    out.accepted.push(logId);
  });

  appendRows_(idx.sh, rows);
  if (qrows.length) {
    appendRows_(SpreadsheetApp.getActive().getSheetByName('Quarantine'), qrows);
    logAdmin_('QUARANTINE', deviceId, qrows.length + ' รายการจากรอบอื่น/รอบที่ปิดแล้ว');
  }
  if (rows.length && cfg.ROUND_STATUS === 'SETUP') {
    setConfig_({ ROUND_STATUS: 'COUNTING' });
    logAdmin_('ROUND_COUNTING', project, 'เริ่มนับ (ได้รับรายการแรกจาก ' + deviceId + ')');
  }

  if (events.length) out.events = applyLocEvents_(deviceId, events, project, source);
  out.seq = seqStats_(idx.rows, deviceId, project);
  return out;
}

function validateEntry_(e, deviceId, source) {
  if (!e || typeof e !== 'object') return 'BAD_ENTRY';
  var seq = Number(e.seq);
  if (!(seq > 0) || Math.floor(seq) !== seq) return 'BAD_SEQ';
  if (source === 'SYNC' && String(e.logId) !== deviceId + '-' + ('000000' + seq).slice(-6)) return 'BAD_LOG_ID';
  if (!String(e.logId || '')) return 'BAD_LOG_ID';
  if (ENTRY_TYPES.indexOf(e.type) < 0) return 'BAD_TYPE';
  var q = Number(e.qty);
  if (!isFinite(q) || Math.abs(q) > 100000) return 'BAD_QTY';
  if (!normLoc_(e.location) && e.type !== 'SALE') return 'NO_LOCATION';
  if (!e.barcode && !e.material) return 'NO_ITEM';
  return '';
}

/** ชื่อ Location: ตัวอักษรโซน + เลข ไม่มี 0 นำหน้า (a01 → A1) */
function normLoc_(v) {
  var s = String(v || '').trim().toUpperCase().replace(/^LOC:/, '');
  var m = s.match(/^([A-Z]+)0*(\d+)$/);
  return m ? m[1] + m[2] : s;
}

function quarantineIds_() {
  var rows = readRaw_('Quarantine');
  var ids = {};
  rows.slice(1).forEach(function (r) { ids[r[2]] = true; });
  return ids;
}

// ---------- Location ----------

function applyLocEvents_(deviceId, events, project, source) {
  var log = SpreadsheetApp.getActive().getSheetByName('Count_Log');
  var n = log.getLastRow() - 1;
  var all = n > 0 ? log.getRange(2, 1, n, 9).getDisplayValues() : [];
  var locs = table_('Locations');
  var checks = [];
  var out = [];
  var have = {};
  all.forEach(function (r) { if (r[1] === project && r[2] === deviceId) have[Number(r[3])] = true; });
  events.forEach(function (ev) {
    if (ev.projectId !== project) { out.push({ id: ev.id, location: ev.location, match: 'SKIP' }); return; }
    var loc = normLoc_(ev.location);
    if (!loc) { out.push({ id: ev.id, match: 'SKIP' }); return; }
    var srvLines = 0, srvQty = 0, upTo = Number(ev.upToSeq) || 0, missing = 0;
    all.forEach(function (r) {
      if (r[1] === project && r[2] === deviceId && r[5] === loc) { srvLines++; srvQty += Number(r[8]) || 0; }
    });
    // ยังได้รับรายการของเครื่องนี้ไม่ครบถึง upToSeq → ยังตัดสินไม่ได้ (WAIT)
    for (var s = Number(ev.fromSeq) || upTo + 1; s <= upTo; s++) if (!have[s]) { missing++; break; }
    srvQty = Math.round(srvQty * 1000) / 1000;
    var match = missing ? 'WAIT' : (srvLines === Number(ev.lines) && srvQty === Number(ev.qty) ? 'OK' : 'MISMATCH');
    if (ev.type === 'CLOSE' || ev.type === 'EDIT') {
      checks.push([now_(), project, deviceId, loc, ev.type, normStaff_(ev.staff), Number(ev.lines) || 0, Number(ev.qty) || 0,
        srvLines, srvQty, match, upTo]);
    }
    upsertLocation_(locs, loc, ev, deviceId, match);
    out.push({ id: ev.id, location: loc, match: ev.type === 'OPEN' ? 'OPEN' : match, srvLines: srvLines, srvQty: srvQty });
  });
  if (checks.length) appendRows_(SpreadsheetApp.getActive().getSheetByName('Loc_Checks'), checks);
  return out;
}

function upsertLocation_(t, loc, ev, deviceId, match) {
  var i = -1;
  for (var k = 0; k < t.rows.length; k++) if (t.rows[k][t.idx.Location] === loc) { i = k; break; }
  var cur = i >= 0 ? rowObj_(t, t.rows[i]) : {};
  function addTo(list, v) {
    var a = String(list || '').split(',').filter(String);
    if (v && a.indexOf(v) < 0) a.push(v);
    return a.join(',');
  }
  var upd = {
    Location: loc,
    Zone: (loc.match(/^[A-Z]+/) || [''])[0],
    Counters: addTo(cur.Counters, normStaff_(ev.staff)),
    Devices: addTo(cur.Devices, deviceId),
    Updated_At: now_()
  };
  if (ev.type === 'OPEN') {
    upd.Status = 'กำลังนับ';
    upd.Open_By = deviceId + ' ' + normStaff_(ev.staff);
    if (!cur.Opened_At) upd.Opened_At = String(ev.time || now_());
  } else if (ev.type === 'CLOSE') {
    upd.Status = 'ปิดแล้ว';
    upd.Open_By = '';
    upd.Closed_Time = String(ev.time || now_());
    upd.Last_Check = match;
  } else if (ev.type === 'EDIT') {
    upd.Last_Check = match;
    upd.Edits = (parseInt(cur.Edits, 10) || 0) + 1;
  }
  putRow_(t, i, upd);
}

/** ตรวจว่ามีเครื่องอื่นเปิด Location นี้อยู่หรือไม่ (ใช้เตือนตอนออนไลน์) */
function apiLocStatus_(a, req) {
  var loc = normLoc_(req.location);
  var t = table_('Locations');
  for (var k = 0; k < t.rows.length; k++) {
    var r = rowObj_(t, t.rows[k]);
    if (r.Location === loc) {
      var openBy = String(r.Open_By || '');
      var other = openBy && openBy.split(' ')[0] !== a.deviceId ? openBy : '';
      return { ok: true, location: loc, status: r.Status, openByOther: other, devices: r.Devices, counters: r.Counters };
    }
  }
  return { ok: true, location: loc, status: '', openByOther: '' };
}

// ---------- ผลตรวจความพร้อมเครื่อง ----------

function apiCheck_(a, req) {
  var items = req.items || [];
  var pass = items.every(function (i) { return i.result !== 'FAIL'; });
  var detail = items.map(function (i) { return (i.result === 'OK' ? '✓' : i.result === 'WARN' ? '⚠' : '✗') + ' ' + i.title; }).join(' | ');
  appendRows_(SpreadsheetApp.getActive().getSheetByName('Device_Checks'),
    [[now_(), a.deviceId, normStaff_(req.staff), a.appVersion, pass ? 'ผ่าน' : 'ไม่ผ่าน', detail]]);
  putRow_(a.table, a.row, { Last_Check_At: now_(), Last_Check: pass ? 'ผ่าน' : 'ไม่ผ่าน', App_Version: a.appVersion });
  return { ok: true, pass: pass };
}
