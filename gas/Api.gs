/**
 * Api.gs — API สำหรับเว็บแอป TC21 (เฟส 2)
 *
 * Deploy เป็น Web app: Execute as = Me, Who has access = Anyone
 * ทุกคำขอ (ยกเว้น ping/pair) ต้องมี deviceId + token ที่ได้จากการจับคู่เครื่องในหน้า Admin
 * คำขอส่งเป็น POST text/plain (JSON) เพื่อไม่ให้เบราว์เซอร์ส่ง preflight
 */

var API_VERSION = 2;
// SELF_SET (v2.3.1) = ผู้ช่วยแก้ยอดของตัวเอง (เฉพาะชิ้นที่เครื่องนี้ยิง) · RECOUNT_SET = ผู้ดูแลแก้ยอดรวมทั้ง Location
var ENTRY_TYPES = ['SCAN', 'MANUAL', 'VOID', 'FOUND', 'RECOUNT_SET', 'SELF_SET', 'SWAP', 'SALE', 'HOLD'];
var SYNC_STATUSES = ['SETUP', 'COUNTING', 'COUNT_CLOSED'];
var PAIR_MINUTES = 30;
var PAIR_MAX_FAILS = 5;
/** ความจำต่อคำขอ (v2.3.0): Config / ตารางเล็ก / ดัชนี Count_Log อ่านครั้งเดียวต่อคำขอ · null = ไม่จำ (หน้า Admin) */
var REQ_ = null;
var REQ_TABLES = ['Locations', 'Loc_Members', 'Staff'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ping') return json_({ ok: true, serverTime: Date.now(), api: API_VERSION, serverVersion: SYSTEM_VERSION });
  return HtmlService.createHtmlOutput('<p>Stock Count API v' + API_VERSION + '</p>');
}

function doPost(e) {
  var t0 = Date.now();   // วัดเวลาทำงานฝั่งเซิร์ฟเวอร์ (v2.2.6) — เครื่องเทียบกับเวลาไป-กลับทั้งหมด
  REQ_ = {};
  try { return doPost__(e, t0); } finally { REQ_ = null; }
}
function doPost__(e, t0) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'BAD_JSON' });
  }
  try {
    if (req.action !== 'ping') ensureSchema_();
    var out;
    switch (req.action) {
      case 'ping': out = { ok: true }; break;
      case 'pair': out = apiPair_(req); break;
      case 'bootstrap': out = apiBootstrap_(auth_(req)); break;
      case 'master': out = apiMaster_(auth_(req)); break;
      case 'stock': out = apiStock_(auth_(req)); break;
      case 'sync': out = apiSync_(auth_(req), req); break;
      case 'locStatus': out = apiLocStatus_(auth_(req), req); break;
      case 'locInfo': out = apiLocInfo_(auth_(req), req); break;
      case 'myLocs': out = apiMyLocs_(auth_(req)); break;
      case 'check': out = apiCheck_(auth_(req), req); break;
      case 'hello': out = apiHello_(auth_(req), req); break;
      case 'unpair': out = apiUnpair_(auth_(req), req); break;
      default: out = { ok: false, error: 'UNKNOWN_ACTION' };
    }
    out.serverTime = Date.now();
    out.serverVersion = SYSTEM_VERSION;
    out.ms = out.serverTime - t0;
    return json_(out);
  } catch (err) {
    var code = err && err.code ? err.code : 'SERVER_ERROR';
    return json_({ ok: false, error: code, message: String(err && err.message || err), serverTime: Date.now(), serverVersion: SYSTEM_VERSION, ms: Date.now() - t0 });
  }
}

/** อัปเกรดโครงสร้างชีตอัตโนมัติหลัง Deploy เวอร์ชันใหม่ (ไม่ต้องรอเปิดหน้า Admin) */
function ensureSchema_() {
  if (Number(readConfig_().SCHEMA_VERSION || 0) < SCHEMA_VERSION) ensureSetup_();
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
  var memo = REQ_ && REQ_TABLES.indexOf(name) >= 0;
  if (memo && REQ_['t_' + name]) return REQ_['t_' + name];
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), 1);
  var values = lastRow ? sh.getRange(1, 1, lastRow, lastCol).getDisplayValues() : [[]];
  var header = values[0];
  var idx = {};
  header.forEach(function (h, i) { if (h) idx[h] = i; });
  var t = { sh: sh, header: header, idx: idx, rows: values.slice(1) };
  if (memo) REQ_['t_' + name] = t;
  return t;
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
  return start;
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
    var repair = !!d.Revoked_At && !d.Repaired_At;
    var upd = { Token_Hash: sha_(token), Pair_Code: '', Pair_Expires: '', Pair_Fails: 0, Paired_At: now_(), App_Version: req.appVersion || '' };
    if (repair) upd.Repaired_At = upd.Paired_At;   // ปิดช่วงเวลาที่เครื่องถูกยกเลิก
    putRow_(t, i, upd);
    var maxSeq = deviceMaxSeqAll_(deviceId);
    var pend = Number(req.pendingCount) || 0;
    logAdmin_(repair ? 'DEVICE_REPAIRED' : 'DEVICE_PAIRED', deviceId, (repair ? 'จับคู่ใหม่หลังยกเลิก (ยกเลิกเมื่อ ' + d.Revoked_At + ' เหตุผล: ' +
      (REVOKE_REASONS[d.Revoke_Reason] || '-') + ') · ' : 'จับคู่เครื่องสำเร็จ · ') + 'Seq ล่าสุดที่เซิร์ฟเวอร์มี ' + maxSeq +
      ' · ค้างส่งในเครื่อง ' + pend + ' รายการ' + (pend ? ' (Seq ' + req.pendingFrom + '–' + req.pendingTo + ' จะส่งต่ออัตโนมัติ)' : '') + (req.staff ? ' · ผู้ตรวจ ' + req.staff : ''));
    return { ok: true, deviceId: deviceId, token: token, deviceName: d.Name || deviceId, maxSeqAll: maxSeq };
  });
}

// ---------- สัญญาณจากเครื่อง (heartbeat) ----------
// เก็บใน CacheService ไม่เขียนชีต: เวลาติดต่อล่าสุด + จำนวนรายการค้างส่งที่เครื่องรายงาน
var HB_TTL = 21600;   // 6 ชม. (สูงสุดของ CacheService)

function heartbeat_(deviceId, pending, loc, perf) {
  try {
    var hb = { at: Date.now(), pending: Math.max(0, Number(pending) || 0), loc: loc || '' };
    if (perf) hb.perf = perf;
    else { var old = CacheService.getScriptCache().get('hb_' + deviceId); if (old) { old = JSON.parse(old); if (old.perf) hb.perf = old.perf; } }
    CacheService.getScriptCache().put('hb_' + deviceId, JSON.stringify(hb), HB_TTL);
  } catch (e) { /* heartbeat ไม่สำคัญพอจะทำให้คำขอล้ม */ }
}

function heartbeats_(ids) {
  try {
    var got = CacheService.getScriptCache().getAll(ids.map(function (id) { return 'hb_' + id; })) || {};
    var out = {};
    ids.forEach(function (id) { if (got['hb_' + id]) out[id] = JSON.parse(got['hb_' + id]); });
    return out;
  } catch (e) { return {}; }
}

/** สรุปเวลาตอบที่เครื่องรายงาน (กันขนาดเกิน/ข้อมูลแปลก) */
function perfSummary_(p) {
  if (!p || typeof p !== 'object') return null;
  var out = {};
  ['sync', 'locInfo', 'hello', 'myLocs', 'bootstrap'].forEach(function (k) {
    var x = p[k];
    if (!x || !x.n) return;
    out[k] = { n: Number(x.n) || 0, avg: Number(x.avg) || 0, max: Number(x.max) || 0, srv: Number(x.srv) || 0, wait: Number(x.wait) || 0, hold: Number(x.hold) || 0,
      to: Number(x.to) || 0, err: Number(x.err) || 0 };
  });
  return out;
}

/** เครื่องรายงานตัวทุก 1 นาที (ไม่เขียนชีต) — ถ้าเครื่องถูกยกเลิก auth_ จะตอบ error ให้เครื่องรู้ทันที */
function apiHello_(a, req) {
  heartbeat_(a.deviceId, req.pending, req.location, perfSummary_(req.perf));
  // บอกจำนวนเครื่องใน Location ที่เครื่องอยู่ (อ่าน Loc_Members ซึ่งเล็ก) — ผู้ดูแลรู้ว่ามีผู้ช่วยเข้ามา โดยไม่ต้องถาม locInfo ตลอด (v2.2.7)
  var out = { ok: true };
  var loc = normLoc_(req.location);
  if (loc) out.members = membersOf_(membersTable_(), readConfig_().PROJECT_ID, loc).length;
  return out;
}

/** เครื่องยกเลิกการจับคู่เอง: ล้าง token ฝั่งเซิร์ฟเวอร์ให้หน้า Admin เห็นตรงกัน */
function apiUnpair_(a, req) {
  return withLock_(function () {
    var t = table_('Devices');
    var i = findDevice_(t, a.deviceId);
    putRow_(t, i, { Token_Hash: '', Pair_Code: '', Pair_Expires: '' });
    try { CacheService.getScriptCache().remove('hb_' + a.deviceId); } catch (e) { }
    logAdmin_('DEVICE_UNPAIRED', a.deviceId, 'ยกเลิกการจับคู่จากตัวเครื่อง' + (req.staff ? ' โดย ' + req.staff : ''));
    return { ok: true };
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

// ---------- ดัชนี Count_Log (ขั้น C, v2.3.0) ----------
//
// ปัญหา: ทุกครั้งที่ส่งข้อมูล เซิร์ฟเวอร์อ่าน Count_Log ทั้งชีตหลายรอบ (กันซ้ำ / ตรวจยอด / สรุป Location)
//         ข้อมูลเต็มรอบ ~11,000–16,000 แถว ใช้เวลาหลายวินาทีขณะถือล็อก เครื่องอื่นต้องรอคิว
// ทางแก้: เก็บสรุปไว้ใน CacheService — ช่วง Seq ที่ได้รับแล้วของแต่ละเครื่อง + ยอดต่อ Location (ต่อเครื่อง / ต่อ SKU)
//         Count_Log ยังเป็นข้อมูลจริงเสมอ ดัชนีเป็นแค่สำเนาสรุปที่สร้างใหม่ได้จากชีตทุกเมื่อ
// ความถูกต้อง
// - lx_meta.last = จำนวนแถวของชีตที่ดัชนีครอบคลุม · ชีตมีแถวเพิ่มจากทางอื่น → อ่านเฉพาะแถวที่เพิ่ม
// - ชีตแถวน้อยลง / รอบเปลี่ยน / ดัชนีหาย (cache หมดอายุ 6 ชม.) → อ่านทั้งชีตครั้งเดียวแล้วสร้างใหม่
// - ยอดแต่ละ Location เก็บ upto (แถวที่รวมแล้ว) กันนับซ้ำเมื่ออ่านขณะเครื่องอื่นกำลังบันทึก
// - บันทึกดัชนีกลับเฉพาะตอนถือล็อก (ingest_) · คำขออ่านอย่างเดียว (locInfo) คำนวณในหน่วยความจำ ไม่เขียน

var LX_VER = 4;   // 2 = v2.3.1 (ตราประจำ Location + ยอดต่อ SKU สำหรับผู้ช่วยแก้ยอดตัวเอง)
var LX_TTL = 21600;
var LX_COLS = 14;
var LX_PREFIX = 'lx_L_';
var LX_AUDIT_SEC = 300;   // ตรวจทานดัชนีกับชีตทุก 5 นาที (v2.3.1)

/** ช่วงตัวเลข [[a,b],...] เรียงและไม่ซ้อนกัน */
function rgAdd_(rg, n) {
  for (var i = 0; i < rg.length; i++) {
    var r = rg[i];
    if (n >= r[0] && n <= r[1]) return;
    if (n === r[1] + 1) { r[1] = n; if (rg[i + 1] && rg[i + 1][0] === n + 1) { r[1] = rg[i + 1][1]; rg.splice(i + 1, 1); } return; }
    if (n === r[0] - 1) { r[0] = n; return; }
    if (n < r[0]) { rg.splice(i, 0, [n, n]); return; }
  }
  rg.push([n, n]);
}
function rgHas_(rg, n) {
  for (var i = 0; i < (rg || []).length; i++) if (n >= rg[i][0] && n <= rg[i][1]) return true;
  return false;
}
function rgStats_(rg) {
  rg = rg || [];
  var count = 0, gaps = [];
  rg.forEach(function (r, i) {
    count += r[1] - r[0] + 1;
    if (i) for (var s = rg[i - 1][1] + 1; s < r[0] && gaps.length < 50; s++) gaps.push(s);
  });
  return { count: count, min: rg.length ? rg[0][0] : 0, max: rg.length ? rg[rg.length - 1][1] : 0, gaps: gaps };
}
/** Log_ID มาตรฐาน DEVICE-###### → { dev, seq } (รูปแบบอื่น เช่น Dolphin → null) */
function lxId_(id) {
  var m = String(id).match(/^(.+)-(\d{6,})$/);
  return m ? { dev: m[1], seq: parseInt(m[2], 10) } : null;
}

/** เก็บใน cache แบบย่อ (cache รับได้ ~100KB ต่อรายการ → ~1,000+ SKU ต่อ Location) · Material ได้จากคีย์ */
function lxPack_(L) {
  var it = {};
  Object.keys(L.items).forEach(function (k) { var x = L.items[k]; it[k] = [x.barcode, x.qty, x.byDevice, x.since, x.cp && Object.keys(x.cp).length ? x.cp : 0, x.le || 0, x.sc && !lxSameMap_(x.sc, x.byDevice) ? x.sc : 0]; });   // sc = byDevice (ยังไม่เคยล้าง) → เก็บ 0 ประหยัดที่ (cache จำกัด 100KB ต่อคีย์)
  var dv = {};
  Object.keys(L.devices).forEach(function (d) { var x = L.devices[d]; dv[d] = x.sc === undefined || x.sc === x.qty ? [x.lines, x.qty, x.maxSeq, x.lastTime] : [x.lines, x.qty, x.maxSeq, x.lastTime, x.sc]; });
  return JSON.stringify({ d: dv, i: it, q: L.qty, n: L.lines, u: L.upto, c: L.clr, ca: L.ca || 0 });
}
function lxUnpack_(s) {
  var o = JSON.parse(s), L = { devices: {}, items: {}, qty: o.q, lines: o.n, upto: o.u, clr: o.c || {}, ca: o.ca || null };
  Object.keys(o.d).forEach(function (d) { var x = o.d[d]; L.devices[d] = { lines: x[0], qty: x[1], maxSeq: x[2], lastTime: x[3], sc: x.length > 4 ? x[4] : x[1] }; });
  Object.keys(o.i).forEach(function (k) {
    var x = o.i[k];
    L.items[k] = { key: k, material: k.indexOf('BC:') === 0 ? '' : k, barcode: x[0], qty: x[1], byDevice: x[2], since: x[3] || {}, cp: x[4] || {}, le: x[5] || null, sc: x[6] ? x[6] : Object.assign({}, x[2]) };
  });
  return L;
}

/** เครื่องที่การแก้ยอดรวมตัดยอด: มีเครื่องอื่นร่วมยอด SKU นี้ (นับจากจุดตัดล่าสุด) → เครื่องเหล่านั้น + ผู้แก้ · นับคนเดียว → ไม่ตัดยอดใคร */
function lxCover_(since, editor) {
  var others = Object.keys(since || {}).filter(function (d) { return d !== editor; });
  return others.length ? others.concat([editor]) : [];
}

function lxNewLoc_() { return { devices: {}, items: {}, qty: 0, lines: 0, upto: 0, clr: {}, ca: null }; }
/** แถวนี้คือ "ล้าง Location นับใหม่" ของผู้ดูแล */
function lxIsClear_(type, reason) { return type === 'RECOUNT_SET' && String(reason).indexOf('ล้าง Location') === 0; }
/**
 * รวมแถว Count_Log (ค่าแสดงผล คอลัมน์ A–N) เข้ายอดของ Location
 * นอกจากยอด ยังจำต่อ SKU (v2.3.1 — ผู้ช่วยแก้ยอดของตัวเอง):
 *   since[dev] = "ยอดของฉัน" ของเครื่องนั้น นับจากจุดตัดล่าสุด (ล้าง Location หรือผู้ดูแลแก้ยอดรวม SKU นั้น)
 *   cp[dev] = จุดตัดยอด (v2.3.5): Seq ของเครื่องนั้นตอนผู้ดูแลแก้ยอดรวม — ยอดก่อนหน้าถือว่าผู้ดูแลตรวจแล้ว แก้ผ่านยอดของฉันไม่ได้
 *        (แทน "ห้ามแก้" ของ v2.3.2: ผู้ช่วยกลับมายิงเพิ่มแล้วแก้ส่วนที่ยิงเพิ่มได้ · ยังกันแก้ซ้ำสองชั้น)
 *        ผู้ดูแลแก้ยอดรวมตอนนับคนเดียว = แก้ของตัวเอง ไม่ตัดยอดใคร
 *   le = [เครื่อง, เวลา] การแก้ล่าสุด · clr[dev] = Seq สูงสุดของเครื่องนั้นตอนล้าง Location ครั้งล่าสุด
 */
function lxAddRow_(L, r) {
  var qty = Number(r[8]) || 0, seq = Number(r[3]) || 0, dev = r[2], type = r[9], reason = r[11];
  var d = L.devices[dev] || (L.devices[dev] = { lines: 0, qty: 0, maxSeq: 0, lastTime: '', sc: 0 });
  var clear = lxIsClear_(type, reason);
  if (clear && !L._clearing) {
    // ชุดรายการล้างของผู้ดูแล: ทุกเครื่องเริ่มนับ "ของฉัน" ใหม่จากตรงนี้
    Object.keys(L.devices).forEach(function (x) { L.clr[x] = L.devices[x].maxSeq; L.devices[x].sc = 0; });
    // ยอดแยกเครื่องหลังล้าง (sc · v2.3.6): เริ่มใหม่ทุก SKU · รายการล้างไม่นับเป็นยอดของเครื่องที่กดล้าง
    Object.keys(L.items).forEach(function (k2) { L.items[k2].sc = {}; });
    L.ca = [dev, String(r[13])];
  }
  if (!clear) d.sc = r3_((d.sc || 0) + qty);
  d.lines++; d.qty = r3_(d.qty + qty); if (seq > d.maxSeq) d.maxSeq = seq; if (String(r[13]) > d.lastTime) d.lastTime = String(r[13]);
  var k = itemKey_(r[7], r[6]);
  var it = L.items[k] || (L.items[k] = { key: k, material: r[7], barcode: r[6], qty: 0, byDevice: {}, since: {}, cp: {}, le: null });
  if (!it.cp) it.cp = {};
  if (!it.sc) it.sc = {};
  it.qty = r3_(it.qty + qty); it.byDevice[dev] = r3_((it.byDevice[dev] || 0) + qty);
  if (!clear) it.sc[dev] = r3_((it.sc[dev] || 0) + qty);
  var cover = type === 'RECOUNT_SET' && !clear ? lxCover_(it.since, dev) : [];
  if (clear) { it.since = {}; it.cp = {}; }
  else if (cover.length) {
    // จุดตัดยอด: ทุกเครื่องที่ร่วมยอด (รวมผู้แก้) เริ่ม "ยอดของฉัน" ใหม่จากตรงนี้ · แถวแก้ยอดรวมไม่นับเป็นยอดของใคร
    cover.forEach(function (x) { it.since[x] = 0; it.cp[x] = x === dev ? seq : ((L.devices[x] || {}).maxSeq || 0); });
    it.le = [dev, String(r[13])];
  } else {
    it.since[dev] = r3_((it.since[dev] || 0) + qty);
    if (type === 'RECOUNT_SET' || type === 'SELF_SET') it.le = [dev, String(r[13])];
  }
  if (!it.barcode && r[6]) it.barcode = r[6];
  L.qty = r3_(L.qty + qty); L.lines++;
  L._clearing = clear;
}

/**
 * ใส่แถวลงดัชนี (ใช้ทั้งตอนสร้างใหม่ ตอนตามแถวที่เพิ่ม และตอนตรวจทาน)
 * st = { meta, locs, dirty } · rows = ค่าแสดงผลคอลัมน์ A–N เริ่มที่แถว firstRow ของชีต
 */
function lxApply_(st, rows, firstRow, project) {
  rows.forEach(function (r, i) {
    var p = lxId_(r[0]);
    if (p) rgAdd_(st.meta.ids[p.dev] || (st.meta.ids[p.dev] = []), p.seq);
    else st.meta.odd++;
    if (r[1] !== project) return;
    var seq = Number(r[3]) || 0;
    if (seq > 0) rgAdd_(st.meta.pseq[r[2]] || (st.meta.pseq[r[2]] = []), seq);
    var loc = r[5];
    if (!loc) return;
    if (st.meta.locs.indexOf(loc) < 0) st.meta.locs.push(loc);
    var L = st.locs[loc] || (st.locs[loc] = lxNewLoc_());
    if (firstRow + i <= L.upto) return;
    lxAddRow_(L, r);
    st.dirty[loc] = true;
  });
}
function lxNewMeta_(project, last) { return { v: LX_VER, project: project, last: last, ids: {}, pseq: {}, odd: 0, locs: [], lv: {} }; }
/** สร้างดัชนีจากชีตทั้งชีต (ไม่แตะ cache) */
function lxFromSheet_(sh, project) {
  var last = sh.getLastRow();
  var st = { meta: lxNewMeta_(project, last), locs: {}, dirty: {} };
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, LX_COLS).getDisplayValues() : [];
  lxApply_(st, rows, 2, project);
  Object.keys(st.locs).forEach(function (l) { st.locs[l].upto = last; delete st.locs[l]._clearing; });
  st.last = last;
  return st;
}
/** เทียบ { key: ตัวเลข } โดยไม่สนลำดับคีย์ (ค่า 0 = ไม่มี) */
function lxSameMap_(a, b) {
  a = a || {}; b = b || {};
  var ks = {};
  Object.keys(a).concat(Object.keys(b)).forEach(function (k) { ks[k] = 1; });
  return Object.keys(ks).every(function (k) { return (a[k] || 0) === (b[k] || 0); });
}
/** เทียบดัชนีสองชุด (ยอดต่อเครื่อง / ต่อ SKU) คืนรายการที่ต่าง */
function lxDiff_(a, b, names) {
  var out = [];
  names.forEach(function (l) {
    var A = a[l] || lxNewLoc_(), B = b[l] || lxNewLoc_();
    var ds = {};
    Object.keys(A.devices).concat(Object.keys(B.devices)).forEach(function (d) { ds[d] = 1; });
    Object.keys(ds).forEach(function (d) {
      var x = A.devices[d] || { lines: 0, qty: 0 }, y = B.devices[d] || { lines: 0, qty: 0 };
      if (x.lines !== y.lines || x.qty !== y.qty || (x.sc || 0) !== (y.sc || 0)) out.push(l + ' ' + d + ' ดัชนี ' + x.lines + '/' + x.qty + ' ชีต ' + y.lines + '/' + y.qty);
    });
    var ks = {};
    Object.keys(A.items).concat(Object.keys(B.items)).forEach(function (k) { ks[k] = 1; });
    Object.keys(ks).forEach(function (k) {
      var x = A.items[k] || { qty: 0, since: {}, cp: {} }, y = B.items[k] || { qty: 0, since: {}, cp: {} };
      if (x.qty !== y.qty || lxSameMap_(x.since, y.since) === false || lxSameMap_(x.cp, y.cp) === false || lxSameMap_(x.sc || {}, y.sc || {}) === false) out.push(l + ' ' + k + ' ดัชนี ' + x.qty + ' ชีต ' + y.qty);
    });
  });
  return out;
}

/**
 * เปิดดัชนีของรอบ project · opt.write = ถือล็อกอยู่ บันทึกกลับได้
 * คืน { loc(names) → {loc: D}, has(dev, seq), hasP, stats(dev), maxAll(dev), add(rows, firstRow), verify(...), audit(), save(), sh, last, rebuilt }
 */
function logIdx_(project, opt) {
  opt = opt || {};
  if (REQ_ && REQ_.lx && REQ_.lx.project === project) { if (opt.write) REQ_.lx.write = true; return REQ_.lx; }
  var cache = CacheService.getScriptCache();
  var sh = SpreadsheetApp.getActive().getSheetByName('Count_Log');
  var last = sh.getLastRow();
  var meta = null;
  try { meta = JSON.parse(cache.get('lx_meta') || 'null'); } catch (e) { meta = null; }
  var X = { project: project, sh: sh, last: last, locs: {}, dirty: {}, rebuilt: false, write: !!opt.write, cache: cache, fixes: [] };

  function adopt(st, why) {
    X.meta = st.meta; X.locs = st.locs; X.dirty = {}; X.last = last = st.last;
    Object.keys(X.locs).forEach(function (l) { X.dirty[l] = true; });
    X.rebuilt = true; X.full = true; X.why = why;
  }
  function rebuild(why) { adopt(lxFromSheet_(sh, project), why || 'rebuild'); }
  X.rebuild = rebuild;

  if (meta && meta.v === LX_VER && meta.project === project && meta.last <= last) {
    X.meta = meta;
    if (!X.meta.lv) X.meta.lv = {};
    if (meta.last < last) {
      // มีแถวเพิ่มจากทางอื่น (หรือเครื่องอื่นกำลังบันทึก) → อ่านเฉพาะแถวที่เพิ่ม
      var rows = sh.getRange(meta.last + 1, 1, last - meta.last, LX_COLS).getDisplayValues();
      var need = {};
      rows.forEach(function (r) { if (r[1] === project && r[5]) need[r[5]] = true; });
      if (!lxLoad_(X, Object.keys(need))) rebuild('cache ไม่ครบ');
      else { lxApply_(X, rows, meta.last + 1, project); X.meta.last = last; Object.keys(X.dirty).forEach(function (l) { X.locs[l].upto = last; }); }
    }
  } else rebuild(meta ? 'รอบ/รุ่น/จำนวนแถวเปลี่ยน' : 'ไม่มีดัชนีใน cache');

  X.loc = function (names) {
    if (!X.full && !lxLoad_(X, names)) rebuild('cache ไม่ครบ');
    var out = {};
    names.forEach(function (n) { if (X.locs[n]) out[n] = X.locs[n]; });
    return out;
  };
  X.has = function (dev, seq) { return rgHas_(X.meta.ids[dev], seq); };
  X.hasP = function (dev, seq) { return rgHas_(X.meta.pseq[dev], seq); };
  X.stats = function (dev) { return rgStats_(X.meta.pseq[dev]); };
  X.maxAll = function (dev) { return rgStats_(X.meta.ids[dev]).max; };
  /** หลังเพิ่มแถวลงชีต: rows = แถวที่เพิ่ม (รูปแบบเดียวกับ ingest_) เริ่มที่แถว firstRow */
  X.add = function (rows, firstRow) {
    if (!rows.length) return;
    var need = {};
    rows.forEach(function (r) { if (r[1] === project && r[5]) need[r[5]] = true; });
    if (!X.full && !lxLoad_(X, Object.keys(need))) { rebuild('cache ไม่ครบ'); return; }   // อ่านชีตที่มีแถวใหม่แล้ว
    var disp = rows.map(function (r) { return r.slice(0, LX_COLS).map(function (v) { return v === null || v === undefined ? '' : String(v); }); });
    lxApply_(X, disp, firstRow, project);
    X.last = X.meta.last = firstRow + rows.length - 1;
    Object.keys(X.dirty).forEach(function (l) { X.locs[l].upto = X.last; });
  };
  /**
   * ตรวจทานกับชีตจริง (v2.3.1): อ่าน Count_Log ทั้งชีต เทียบ Location ที่ระบุ (ไม่ระบุ = ทุก Location)
   * ต่าง → ใช้ค่าจากชีต + บันทึก INDEX_FIX ใน Admin_Log (ข้อมูลไว้หาต้นเหตุ) · คืนรายการที่ต่าง
   */
  X.verify = function (names, why) {
    var fresh = lxFromSheet_(sh, project);
    names = names || fresh.meta.locs.concat(X.meta.locs.filter(function (l) { return fresh.meta.locs.indexOf(l) < 0; }));
    if (!X.full && !lxLoad_(X, names)) { adopt(fresh, 'cache ไม่ครบ (ตรวจทาน)'); return []; }
    var diff = lxDiff_(X.locs, fresh.locs, names);
    if (diff.length) {
      try {
        logAdmin_('INDEX_FIX', project, why + ' · ดัชนีไม่ตรงชีต ' + diff.length + ' จุด: ' + diff.slice(0, 6).join(' | ') +
          ' · meta.last ' + X.meta.last + ' ชีต ' + fresh.last + ' · upto ' + names.slice(0, 3).map(function (l) { return l + '=' + (X.locs[l] ? X.locs[l].upto : '-'); }).join(','));
      } catch (e) { }
      X.fixes.push(diff.length);
      adopt(fresh, 'แก้จากการตรวจทาน');
    }
    return diff;
  };
  X.save = function () {
    if (!X.write) return;
    var put = {};
    Object.keys(X.dirty).forEach(function (l) {
      delete X.locs[l]._clearing;
      put[LX_PREFIX + project + '_' + l] = lxPack_(X.locs[l]);
      X.meta.lv[l] = X.locs[l].upto;   // ตราประจำ Location: ตอนโหลดต้องตรงกัน ไม่งั้นถือว่าได้ค่าเก่า
    });
    try {
      if (Object.keys(put).length) cache.putAll(put, LX_TTL);
      cache.put('lx_meta', JSON.stringify(X.meta), LX_TTL);   // meta หลังสุด: ถ้าบันทึกไม่ครบ ครั้งหน้าจะเห็นแถวเพิ่มแล้วอ่านซ้ำเอง
    } catch (e) {
      // บันทึกไม่ได้ (เช่น Location ใหญ่เกิน) → ทิ้งดัชนี ครั้งหน้าอ่านชีตเหมือนรุ่นก่อน (ช้าแต่ถูก)
      try { cache.remove('lx_meta'); } catch (e2) { }
      try { logAdmin_('INDEX_SAVE_FAIL', project, String(e && e.message || e).slice(0, 200)); } catch (e3) { }
    }
    X.dirty = {};
  };
  if (REQ_) REQ_.lx = X;
  return X;
}

/**
 * โหลดยอด Location จาก cache · คืน false (ต้องสร้างใหม่) เมื่อ
 * - Location ที่ดัชนีรู้จักหายจาก cache
 * - ตราไม่ตรง: upto ของ Location ≠ ที่ meta จดไว้ (cache ให้ค่ารุ่นเก่าของอย่างใดอย่างหนึ่ง) (v2.3.1)
 */
function lxLoad_(X, names) {
  var want = names.filter(function (n) { return !X.locs[n] && X.meta.locs.indexOf(n) >= 0; });
  if (!want.length) return true;
  var got = X.cache.getAll(want.map(function (n) { return LX_PREFIX + X.project + '_' + n; })) || {};
  for (var i = 0; i < want.length; i++) {
    var s = got[LX_PREFIX + X.project + '_' + want[i]];
    if (!s) return false;
    var L = lxUnpack_(s);
    if (X.meta.lv && X.meta.lv[want[i]] !== undefined && X.meta.lv[want[i]] !== L.upto) return false;
    X.locs[want[i]] = L;
  }
  return true;
}

/** ทิ้งดัชนี (ชีต Count_Log ถูกแก้นอกระบบ / ปิดรอบ) — ครั้งต่อไปสร้างใหม่จากชีต */
function lxReset_() {
  try { CacheService.getScriptCache().remove('lx_meta'); } catch (e) { }
  if (REQ_) REQ_.lx = null;
}

/**
 * สร้างดัชนีใหม่ทันที — เลือกฟังก์ชันนี้ในหน้า Apps Script แล้วกด Run
 * ใช้เมื่อมีคนแก้ค่าในชีต Count_Log ด้วยมือ (ปกติไม่ต้องใช้: ระบบสร้างใหม่เองเมื่อแถวเพิ่ม/ลด หรือ cache หมดอายุ)
 */
function rebuildCountIndex() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('มีเครื่องกำลังส่งข้อมูลอยู่ ลองใหม่อีกครั้ง');
  try {
    lxReset_();
    var X = logIdx_(readConfig_().PROJECT_ID, { write: true });
    X.save();
    logAdmin_('INDEX_REBUILD', X.project, 'สร้างดัชนี Count_Log ใหม่ ' + (X.last - 1) + ' แถว · ' + X.meta.locs.length + ' Location');
    return { rows: X.last - 1, locations: X.meta.locs.length };
  } finally { releaseLock_(lock); }
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
  max = logIdx_(readConfig_().PROJECT_ID).maxAll(deviceId);   // ดัชนี (v2.3.0) แทนการอ่าน Count_Log ทั้งชีต
  scan(Object.keys(quarantineIds_()));
  return max;
}

function deviceSeqInfo_(deviceId, projectId) {
  return logIdx_(projectId).stats(deviceId);
}

// ---------- รับข้อมูลการนับ ----------

/**
 * req.entries: [{logId, seq, projectId, staff, location, barcode, material, qty, type, refId, reason, note, scanTime}]
 * req.entries[].basis: เฉพาะ RECOUNT_SET — ยอดรวม SKU ทุกเครื่องที่เครื่องเห็นตอนแก้ (ตรวจการแก้ชนกัน)
 * req.events:  [{id, type: 'OPEN'|'JOIN'|'SUBMIT'|'PAUSE'|'CLOSE'|'EDIT', projectId, location, staff, time, lines, qty, fromSeq, upToSeq, total, auto, at}]
 */
function apiSync_(a, req) {
  var lock = LockService.getScriptLock();
  var w0 = Date.now();
  if (!lock.tryLock(25000)) throw apiError_('BUSY', 'เซิร์ฟเวอร์กำลังรับข้อมูลจากเครื่องอื่น จะลองส่งใหม่อัตโนมัติ');
  var h0 = Date.now(), res;
  try {
    res = ingest_(a.deviceId, req.entries || [], req.events || [], 'SYNC', a.device, a.appVersion);
  } finally {
    var f0 = Date.now();
    releaseLock_(lock);
    if (res) res.prof.flush = Date.now() - f0;
  }
  res.lockWait = h0 - w0;          // รอคิวล็อก (เครื่องอื่นกำลังบันทึก)
  res.lockHold = Date.now() - h0;  // ถือล็อก (งานบันทึกจริง รวม flush) — เป้าขั้น C: ≤ 1 วิ
  // งานที่เป็นของเครื่องนี้เท่านั้น ทำหลังปล่อยล็อก เครื่องอื่นไม่ต้องรอ (v2.3.0)
  putRow_(a.table, a.row, { Last_Seq: res.seq.max, Last_Sync: now_(), App_Version: a.appVersion, Gaps: res.seq.gaps.length });
  res.ok = true;
  if (req.pendingAfter !== undefined) heartbeat_(a.deviceId, req.pendingAfter, req.location);
  var cfg = readConfig_();
  res.masterHash = cfg.MASTER_APPROVED_PROJECT === cfg.PROJECT_ID ? cfg.MASTER_APPROVED_HASH : '';
  res.stockVersion = stockVersion_(cfg);
  return res;
}

/**
 * รวมรายการเข้า Count_Log (ใช้ทั้ง sync และนำเข้าไฟล์)
 * คืน { accepted:[], duplicate:[], quarantined:[], rejected:[{logId,reason}], events:[{id, location, match}], seq }
 */
function ingest_(deviceId, entries, events, source, device, appVersion) {
  var cfg = readConfig_();
  var project = cfg.PROJECT_ID;
  var statusOk = SYNC_STATUSES.indexOf(cfg.ROUND_STATUS) >= 0;
  var p0 = Date.now(), prof = {};
  var X = logIdx_(project, { write: true });   // ดัชนีแทนการอ่าน Count_Log ทั้งชีต (v2.3.0) — ถือล็อกอยู่
  prof.index = Date.now() - p0;
  var seen = {}, oddIds = null;
  // Log_ID มาตรฐาน (DEVICE-######) ตรวจซ้ำจากช่วง Seq ในดัชนี · รูปแบบอื่น (ไฟล์ Dolphin) อ่านคอลัมน์ Log_ID ครั้งเดียว
  function dup(id) {
    if (seen[id]) return true;
    var p = lxId_(id);
    if (p) return X.has(p.dev, p.seq);
    if (!oddIds) oddIds = logIndex_().ids;
    return !!oddIds[id];
  }
  var out = { accepted: [], duplicate: [], quarantined: [], rejected: [], events: [], prof: prof };
  var rows = [], qrows = [];
  var received = now_();
  var qIds = null;
  if (project && statusOk) migrateMembers_(project);
  var basis = source === 'SYNC' ? basisChecker_(project, X) : null;
  var touched = {};

  entries.forEach(function (e) {
    var logId = String(e.logId || '');
    var bad = validateEntry_(e, deviceId, source);
    if (bad) { out.rejected.push({ logId: logId, reason: bad }); return; }
    if (dup(logId)) { out.duplicate.push(logId); return; }
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
    seen[logId] = true;
    var loc = normLoc_(e.location);
    if (basis) { basis.check(e, loc, deviceId); basis.added(e, loc, deviceId); }
    if (loc) touched[loc] = true;
    var row = [logId, project, deviceId, Number(e.seq), normStaff_(e.staff), normLoc_(e.location), String(e.barcode || ''),
      String(e.material || ''), Number(e.qty), e.type, String(e.refId || ''), String(e.reason || ''), String(e.note || ''),
      String(e.scanTime || ''), received, source, normStaff_(e.enteredBy || e.staff), normStaff_(e.requestedBy || ''),
      e.basis === undefined || e.basis === null ? '' : String(e.basis)];
    rows.push(row);
    out.accepted.push(logId);
  });

  p0 = Date.now();
  if (rows.length) X.add(rows, appendRows_(X.sh, rows));
  prof.append = Date.now() - p0;
  if (qrows.length) {
    appendRows_(SpreadsheetApp.getActive().getSheetByName('Quarantine'), qrows);
    logAdmin_('QUARANTINE', deviceId, qrows.length + ' รายการจากรอบอื่น/รอบที่ปิดแล้ว');
  }
  var revokedLocs = rows.length && device && device.Revoked_At ? revokeWindow_(project, deviceId, device, entries, out.accepted) : [];
  if (rows.length && cfg.ROUND_STATUS === 'SETUP') {
    setConfig_({ ROUND_STATUS: 'COUNTING' });
    logAdmin_('ROUND_COUNTING', project, 'เริ่มนับ (ได้รับรายการแรกจาก ' + deviceId + ')');
  }

  // เหตุการณ์ก่อน (ล้าง Location = ปิดธงเดิม) แล้วค่อยติดธงจากการแก้ที่ชนกันในชุดนี้ — ธงใหม่จึงไม่ถูกล้างทิ้ง (v2.2.8)
  p0 = Date.now();
  if (events.length) out.events = applyLocEvents_(deviceId, events, project, source, X);
  prof.events = Date.now() - p0;
  if (basis && basis.problems.length) {
    flagCheck_(project, deviceId, basis.problems);
    out.flags = basis.problems.map(function (p) { return { location: p.loc, note: p.note }; });   // แจ้งเครื่องผู้แก้ทันที
  }
  // รายการที่อาจเปลี่ยนสถานะ Location (ส่งงานแล้วแต่ยิงต่อ / เข้ามาหลังปิด / ยังไม่มีสมาชิก)
  var need = needRefresh_(project, deviceId, Object.keys(touched));
  if (basis) basis.problems.forEach(function (p) { if (need.indexOf(p.loc) < 0) need.push(p.loc); });
  revokedLocs.forEach(function (l) { if (need.indexOf(l) < 0) need.push(l); });
  p0 = Date.now();
  if (need.length) refreshLocations_(project, need);
  prof.refresh = Date.now() - p0;
  out.seq = X.stats(deviceId);
  // ตรวจทานดัชนีทั้งหมดกับชีตทุก ~5 นาที (v2.3.1): ดัชนีเพี้ยนด้วยเหตุใดก็ตาม → แก้เอง + บันทึก INDEX_FIX
  if (source === 'SYNC') {
    var ak = 'lx_audit_' + project, ac = CacheService.getScriptCache();
    var due = true;
    try { due = !ac.get(ak); } catch (e) { }
    if (due) {
      p0 = Date.now();
      try { ac.put(ak, '1', LX_AUDIT_SEC); } catch (e) { }
      X.verify(null, 'ตรวจทานตามรอบ');
      prof.audit = Date.now() - p0;
    }
  }
  p0 = Date.now();
  X.save();
  prof.save = Date.now() - p0;
  if (X.fixes.length) prof.fixed = X.fixes.reduce(function (a, b) { return a + b; }, 0);
  if (X.rebuilt) prof.rebuilt = 1;   // สร้างดัชนีใหม่จากชีตในคำขอนี้ (cache หาย / ชีตถูกแก้)
  return out;
}

function needRefresh_(project, deviceId, locs) {
  if (!locs.length || !project) return [];
  var mt = membersTable_();
  return locs.filter(function (loc) {
    var list = membersOf_(mt, project, loc);
    var me = list.filter(function (x) { return x.m.Device_ID === deviceId; })[0];
    var owner = list.filter(function (x) { return x.m.Role === 'OWNER'; })[0];
    return !me || me.m.State !== 'COUNTING' || (owner && owner.m.State === 'CLOSED');
  });
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

// ---------- Location: ผู้ดูแล / ผู้ช่วย (v2.2.0) ----------
//
// หลักการ
// - เครื่องแรกที่เปิด Location = ผู้ดูแล (OWNER) แก้ยอด ล้าง และปิดได้
// - เครื่องที่มาทีหลัง = ผู้ช่วย (HELPER) ยิงได้ ยกเลิกรายการของตัวเองได้ ดูยอดรวมได้ และ "ส่งงาน"
// - เซิร์ฟเวอร์เป็นตัวตัดสินบทบาทเสมอ (กรณีสองเครื่องเปิดพร้อมกัน / เปิดตอนออฟไลน์)
// - สถานะต่อเครื่อง (Loc_Members): COUNTING กำลังนับ · PAUSED พัก (ผู้ดูแล) · SUBMITTED ส่งงานแล้ว · CLOSED ปิดแล้ว (ผู้ดูแล)
// - Cover_Seq = เลข Seq สูงสุดที่การส่งงาน/พัก/ปิดครั้งล่าสุดครอบคลุม ใช้ตรวจ "มีรายการหลังปิด"

var ROLE_TH = { OWNER: 'ผู้ดูแล', HELPER: 'ผู้ช่วย' };
var STATE_TH = { COUNTING: 'กำลังนับ', PAUSED: 'พัก', SUBMITTED: 'ส่งงานแล้ว', CLOSED: 'ปิดแล้ว' };
var FLAG_AFTER_CLOSE = 'มีรายการหลังปิด — ตรวจซ้ำ';

function itemKey_(material, barcode) { return material ? String(material) : 'BC:' + String(barcode || ''); }

/** อ่าน Count_Log ครั้งเดียว สรุปต่อ Location: ต่อเครื่อง และต่อ SKU (รวมทุกเครื่อง) */
function locData_(project, onlyLocs) {
  // เฉพาะบาง Location (ทางที่ใช้บ่อย: ส่งข้อมูล / ถามสถานะ) → ดัชนี · ทุก Location (ย้ายข้อมูลรุ่นเก่า / Admin) → อ่านชีต
  if (onlyLocs) return logIdx_(project).loc(onlyLocs);
  var sh = SpreadsheetApp.getActive().getSheetByName('Count_Log');
  var n = sh.getLastRow() - 1;
  var vals = n > 0 ? sh.getRange(2, 1, n, 14).getDisplayValues() : [];
  var want = onlyLocs ? {} : null;
  if (onlyLocs) onlyLocs.forEach(function (l) { want[l] = true; });
  var out = {};
  vals.forEach(function (r) {
    if (r[1] !== project) return;
    var loc = r[5];
    if (!loc || (want && !want[loc])) return;
    var L = out[loc] || (out[loc] = { devices: {}, items: {}, qty: 0, lines: 0 });
    var qty = Number(r[8]) || 0, seq = Number(r[3]) || 0;
    var d = L.devices[r[2]] || (L.devices[r[2]] = { lines: 0, qty: 0, maxSeq: 0, lastTime: '', seqs: [] });
    d.lines++; d.qty += qty; if (seq > d.maxSeq) d.maxSeq = seq; if (r[13] > d.lastTime) d.lastTime = r[13];
    d.seqs.push(seq);
    var k = itemKey_(r[7], r[6]);
    var it = L.items[k] || (L.items[k] = { key: k, material: r[7], barcode: r[6], qty: 0, byDevice: {} });
    it.qty += qty; it.byDevice[r[2]] = (it.byDevice[r[2]] || 0) + qty;
    if (!it.barcode && r[6]) it.barcode = r[6];
    L.qty += qty; L.lines++;
  });
  Object.keys(out).forEach(function (loc) {
    var L = out[loc];
    L.qty = r3_(L.qty);
    Object.keys(L.devices).forEach(function (d) { L.devices[d].qty = r3_(L.devices[d].qty); });
    Object.keys(L.items).forEach(function (k) { L.items[k].qty = r3_(L.items[k].qty); });
  });
  return out;
}

function r3_(n) { return Math.round(Number(n || 0) * 1000) / 1000; }

// ---------- Loc_Members ----------

function membersTable_() { return table_('Loc_Members'); }

function membersOf_(t, project, loc) {
  var list = [];
  t.rows.forEach(function (r, i) {
    if (r[t.idx.Project_ID] === project && r[t.idx.Location] === loc) list.push({ i: i, m: rowObj_(t, r) });
  });
  return list;
}

function memberIdx_(t, project, loc, deviceId) {
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (r[t.idx.Project_ID] === project && r[t.idx.Location] === loc && r[t.idx.Device_ID] === deviceId) return i;
  }
  return -1;
}

function ownerOf_(t, project, loc) {
  var list = membersOf_(t, project, loc);
  for (var k = 0; k < list.length; k++) if (list[k].m.Role === 'OWNER') return list[k];
  return null;
}

function putMember_(t, project, loc, deviceId, obj) {
  var i = memberIdx_(t, project, loc, deviceId);
  var base = { Project_ID: project, Location: loc, Device_ID: deviceId, Updated_At: now_() };
  if (i < 0) base.Joined_At = now_();
  putRow_(t, i, Object.assign(base, obj));
}

/**
 * ย้ายข้อมูลจากรุ่นก่อน 2.2.0 (ครั้งเดียวต่อรอบ): เครื่องใน Open_By หรือเครื่องแรก = ผู้ดูแล เครื่องอื่น = ผู้ช่วยที่ส่งงานแล้ว
 * ยอดเดิมใน Count_Log ไม่ถูกแก้
 */
function migrateMembers_(project) {
  var cfg = readConfig_();
  if (!project || cfg.MEMBERS_MIGRATED === project) return;
  var t = membersTable_();
  var has = t.rows.some(function (r) { return r[t.idx.Project_ID] === project; });
  if (!has) {
    var data = locData_(project);
    var locs = table_('Locations');
    var n = 0;
    locs.rows.forEach(function (r) {
      var l = rowObj_(locs, r), D = data[l.Location];
      if (!l.Location || !D) return;
      var devs = Object.keys(D.devices);
      var owner = String(l.Open_By || '').split(' ')[0];
      if (devs.indexOf(owner) < 0) owner = String(l.Devices || '').split(',').filter(function (x) { return devs.indexOf(x) >= 0; })[0] || devs[0];
      var closed = l.Status === 'ปิดแล้ว';
      devs.forEach(function (d) {
        var info = D.devices[d];
        var own = d === owner;
        putMember_(t, project, l.Location, d, {
          Role: own ? 'OWNER' : 'HELPER', State: own ? (closed ? 'CLOSED' : 'PAUSED') : 'SUBMITTED', Staff: '',
          State_At: now_(), Cover_Seq: info.maxSeq, Sub_Lines: info.lines, Sub_Qty: info.qty, Match: 'OK', Sub_By: 'MIGRATE', Ev_At: 0
        });
        n++;
      });
    });
    if (n) logAdmin_('MIGRATE_MEMBERS', project, 'กำหนดผู้ดูแล/ผู้ช่วยจากข้อมูลเดิม ' + n + ' รายการ (v2.2.0)');
  }
  setConfig_({ MEMBERS_MIGRATED: project });
}

// ---------- รับเหตุการณ์ Location จากเครื่อง ----------

/**
 * ev.type: OPEN | JOIN | SUBMIT | PAUSE | CLOSE | EDIT
 * ev.lines/qty/fromSeq/upToSeq = ยอดของเครื่องนี้ใน Location (ตรวจว่าเซิร์ฟเวอร์ได้รับครบ)
 * ev.total = ยอดรวมทุกเครื่องที่ผู้ดูแลเห็นตอนปิด · ev.auto = ส่งงานอัตโนมัติ (ยิงป้ายที่อื่น) · ev.at = เวลาสร้าง (ms)
 */
function applyLocEvents_(deviceId, events, project, source, X) {
  migrateMembers_(project);
  X = X || logIdx_(project);
  var locs = table_('Locations');
  var mt = membersTable_();
  var checks = [];
  var out = [];
  var touched = {};
  var evCache = CacheService.getScriptCache();
  events.forEach(function (ev) {
    if (ev.projectId !== project) { out.push({ id: ev.id, location: ev.location, match: 'SKIP' }); return; }
    var loc = normLoc_(ev.location);
    if (!loc) { out.push({ id: ev.id, match: 'SKIP' }); return; }
    // เครื่องหมดเวลารอแต่เซิร์ฟเวอร์ทำเสร็จแล้ว → ส่งซ้ำมา: ตอบผลเดิม ไม่บันทึกซ้ำ (v2.2.6)
    var ck = 'ev_' + deviceId + '_' + ev.id, prev = null;
    try { prev = evCache.get(ck); } catch (e) { }
    if (prev) { out.push(JSON.parse(prev)); return; }
    var upTo = Number(ev.upToSeq) || 0, missing, srvLines, srvQty, match;
    function judge() {
      var mine = ((X.loc([loc])[loc] || { devices: {} }).devices[deviceId]) || { lines: 0, qty: 0 };
      srvLines = mine.lines; srvQty = r3_(mine.qty); missing = 0;
      // ยังได้รับรายการของเครื่องนี้ไม่ครบถึง upToSeq → ยังตัดสินไม่ได้ (WAIT)
      for (var s = Number(ev.fromSeq) || upTo + 1; s <= upTo; s++) if (!X.hasP(deviceId, s)) { missing++; break; }
      match = missing ? 'WAIT' : (srvLines === Number(ev.lines) && srvQty === Number(ev.qty) ? 'OK' : 'MISMATCH');
    }
    judge();
    // ดัชนีบอกว่าไม่ตรง → ตรวจกับชีตจริงก่อนตัดสิน (v2.3.1 — กรณี T3: ดัชนีนับเกิน ทั้งที่ชีตตรงกับเครื่อง)
    if (match === 'MISMATCH' && X.write && X.verify([loc], 'ก่อนตัดสินไม่ตรง ' + loc + ' ' + deviceId + ' ' + ev.type + ' เครื่อง ' + ev.lines + '/' + ev.qty + ' ดัชนี ' + srvLines + '/' + srvQty).length) judge();
    var res = applyRole_(mt, locs, project, loc, deviceId, ev, match, upTo);
    if (ev.type !== 'OPEN' && ev.type !== 'JOIN' || res.note) {
      checks.push([now_(), project, deviceId, loc, res.logType || ev.type, normStaff_(ev.staff), Number(ev.lines) || 0, Number(ev.qty) || 0,
        srvLines, srvQty, ev.type === 'OPEN' || ev.type === 'JOIN' ? '' : match, upTo, res.note || '']);
    } else {
      checks.push([now_(), project, deviceId, loc, ev.type, normStaff_(ev.staff), '', '', '', '', '', '', ROLE_TH[res.role] || '']);
    }
    touched[loc] = true;
    var r = { id: ev.id, location: loc, match: ev.type === 'OPEN' || ev.type === 'JOIN' ? 'OPEN' : match, srvLines: srvLines, srvQty: srvQty,
      role: res.role, owner: res.owner, state: res.state };
    if (ev.type === 'CLOSE' && res.note) r.note = res.note;   // ปิดทั้งที่มีธง → เครื่องเตือนผู้ดูแล
    out.push(r);
    if (r.match !== 'WAIT') { try { evCache.put(ck, JSON.stringify(r), 21600); } catch (e) { } }
  });
  if (checks.length) appendRows_(SpreadsheetApp.getActive().getSheetByName('Loc_Checks'), checks);
  refreshLocations_(project, Object.keys(touched), locs, mt);
  return out;
}

/** ตัดสินบทบาทและสถานะของเครื่องใน Location ตามเหตุการณ์ คืน { role, owner, state, note, logType } */
function applyRole_(mt, locs, project, loc, deviceId, ev, match, upTo) {
  var owner = ownerOf_(mt, project, loc);
  var mi = memberIdx_(mt, project, loc, deviceId);
  var me = mi >= 0 ? rowObj_(mt, mt.rows[mi]) : null;
  var isOwner = owner && owner.m.Device_ID === deviceId;
  var at = Number(ev.at) || 0;
  var staff = normStaff_(ev.staff);
  var li = locIdx_(locs, loc);
  var L = li >= 0 ? rowObj_(locs, locs.rows[li]) : {};
  var closed = owner && owner.m.State === 'CLOSED';
  var res = { owner: owner ? owner.m.Device_ID : deviceId };
  // เหตุการณ์ที่เก่ากว่าที่ใช้ไปแล้ว (ส่งซ้ำหลัง WAIT) ไม่เปลี่ยนสถานะ แต่ยังบันทึกผลตรวจ
  var stale = me && at && Number(me.Ev_At) > at;
  function set(obj) { if (!stale) putMember_(mt, project, loc, deviceId, Object.assign({ Staff: staff, Ev_At: at || me && me.Ev_At || 0 }, obj)); }
  function locSet(obj) { if (!stale) putRow_(locs, li, Object.assign({ Location: loc, Zone: (loc.match(/^[A-Z]+/) || [''])[0], Updated_At: now_() }, obj)); li = locIdx_(locs, loc); }
  function submit(by) {
    set({ Role: me ? me.Role : 'HELPER', State: 'SUBMITTED', State_At: now_(), Cover_Seq: upTo, Sub_Lines: Number(ev.lines) || 0, Sub_Qty: Number(ev.qty) || 0, Match: match, Sub_By: by });
    res.role = me ? me.Role : 'HELPER'; res.state = 'SUBMITTED';
  }

  switch (ev.type) {
    case 'OPEN':
    case 'JOIN':
      if (!owner || isOwner) {
        res.role = 'OWNER'; res.owner = deviceId; res.state = 'COUNTING';
        if (closed) res.note = 'ผู้ดูแลเปิดแก้ไขหลังปิด';
        set({ Role: 'OWNER', State: 'COUNTING', State_At: now_() });
        locSet({ Opened_At: L.Opened_At || String(ev.time || now_()) });
      } else {
        res.role = 'HELPER'; res.state = 'COUNTING';
        if (ev.type === 'OPEN') res.note = 'มีผู้ดูแลแล้ว (' + owner.m.Device_ID + ') — เป็นผู้ช่วย';
        if (closed) res.note = (res.note ? res.note + ' · ' : '') + 'เข้าร่วมหลังผู้ดูแลปิดแล้ว';
        if (me && me.State === 'SUBMITTED') res.note = (res.note ? res.note + ' · ' : '') + 'กลับมาช่วยอีกครั้ง';
        set({ Role: 'HELPER', State: 'COUNTING', State_At: now_() });
      }
      break;
    case 'SUBMIT':
      if (isOwner || (!owner && !me)) {
        // ผู้ดูแลกดส่งงานไม่ได้ในแอป ถ้าเกิดขึ้นให้ถือเป็นการพัก
        set({ Role: 'OWNER', State: 'PAUSED', State_At: now_(), Cover_Seq: upTo, Sub_Lines: Number(ev.lines) || 0, Sub_Qty: Number(ev.qty) || 0, Match: match });
        res.role = 'OWNER'; res.state = 'PAUSED'; res.logType = 'PAUSE';
      } else { submit(ev.auto ? 'AUTO' : 'SELF'); if (ev.auto) res.note = 'ส่งงานอัตโนมัติ (ยิงป้าย Location อื่น)'; }
      break;
    case 'PAUSE':
      if (isOwner || !owner) {
        set({ Role: 'OWNER', State: 'PAUSED', State_At: now_(), Cover_Seq: upTo, Sub_Lines: Number(ev.lines) || 0, Sub_Qty: Number(ev.qty) || 0, Match: match });
        res.role = 'OWNER'; res.state = 'PAUSED';
      } else { submit('AUTO'); res.logType = 'SUBMIT'; res.note = 'ส่งงานอัตโนมัติ (ยิงป้าย Location อื่น)'; }
      break;
    case 'CLOSE':
      if (owner && !isOwner) {
        // แอปรุ่นเก่า (ก่อน 2.2.0) ปิดอัตโนมัติเมื่อยิงป้ายใหม่ → สำหรับผู้ช่วยถือเป็นการส่งงาน
        submit('CLOSE'); res.logType = 'SUBMIT'; res.note = 'ผู้ช่วยกดปิด/ยิงป้ายอื่น ถือเป็นส่งงาน';
        break;
      }
      set({ Role: 'OWNER', State: 'CLOSED', State_At: now_(), Cover_Seq: upTo, Sub_Lines: Number(ev.lines) || 0, Sub_Qty: Number(ev.qty) || 0, Match: match });
      res.role = 'OWNER'; res.owner = deviceId; res.state = 'CLOSED';
      if (stale) break;
      // ครอบคลุมตอนปิด: ผู้ดูแล = upTo ของเหตุการณ์ปิด, ผู้ช่วย = Cover_Seq ของการส่งงานล่าสุด (ถ้ายังไม่ส่งงาน = 0)
      var cover = {}, waiting = [];
      membersOf_(mt, project, loc).forEach(function (x) {
        if (x.m.Device_ID === deviceId) { cover[deviceId] = upTo; return; }
        var ok = x.m.State === 'SUBMITTED' && x.m.Match === 'OK';
        cover[x.m.Device_ID] = x.m.State === 'SUBMITTED' ? Number(x.m.Cover_Seq) || 0 : 0;
        if (!ok) waiting.push(x.m.Device_ID);
      });
      var upd = { Status: 'ปิดแล้ว', Closed_Time: String(ev.time || now_()), Last_Check: match, Close_Cover: JSON.stringify(cover),
        Close_Total: ev.total === undefined || ev.total === '' ? '' : Number(ev.total) };
      if (match === 'OK') {
        var reasons = [];
        if (waiting.length) reasons.push('ปิดขณะผู้ช่วยยังไม่ส่งงาน (' + waiting.join(', ') + ')');
        if (ev.total !== undefined && ev.total !== '') {
          var srvTotal = r3_((locData_(project, [loc])[loc] || { qty: 0 }).qty);
          if (srvTotal !== r3_(ev.total)) reasons.push('ยอดตอนปิด ' + ev.total + ' ≠ เซิร์ฟเวอร์ ' + srvTotal);
        }
        // ปิดไม่ลบธงเดิม (v2.2.8) — ธงหายได้ 2 ทาง: ล้าง Location นับใหม่ หรือหัวหน้าทีมปิดธงในหน้า Admin พร้อมเหตุผล
        var keep = String(L.Flag_Check || '');
        if (reasons.length) { upd.Flag_Check = (keep ? keep + ' · ' : '') + 'ต้องตรวจซ้ำ: ' + reasons.join(' · '); res.note = reasons.join(' · '); }
        if (keep) res.note = (res.note ? res.note + ' · ' : '') + keep;
      }
      locSet(upd);
      break;
    case 'EDIT':
      if (ev.mine || (me && me.Role === 'HELPER' && !isOwner)) {
        // แก้/ล้างยอดของตัวเอง (ผู้ช่วย v2.3.1 · ผู้ดูแลตอนนับช่วยกัน v2.3.2): นับครั้งที่แก้ ไม่เปลี่ยนผลตรวจของ Location และไม่ปิดธง
        locSet({ Edits: (parseInt(L.Edits, 10) || 0) + 1 });
        var who = isOwner ? 'ผู้ดูแล' : 'ผู้ช่วย';
        res.note = ev.clearMine ? who + 'ล้างยอดของตัวเอง' : who + 'แก้ยอดของตัวเอง';
        res.role = me ? me.Role : (isOwner ? 'OWNER' : ''); res.state = me ? me.State : '';
        break;
      }
      var eu = { Last_Check: match, Edits: (parseInt(L.Edits, 10) || 0) + 1 };
      if (ev.clear && L.Flag_Check) {
        // ล้าง Location แล้วนับใหม่ = ตรวจซ้ำแล้ว → ปิดธงเดิม (เก็บข้อความเดิมไว้ใน Loc_Checks / Admin_Log)
        eu.Flag_Check = '';
        logAdmin_('LOC_FLAG_CLEARED', loc, 'ล้าง Location นับใหม่โดย ' + deviceId + ' (' + (ev.staff || '') + ') — ธงเดิม: ' + L.Flag_Check);
        res.note = 'ล้างนับใหม่ — ปิดธงเดิม: ' + L.Flag_Check;
      }
      locSet(eu);
      res.role = me ? me.Role : ''; res.state = me ? me.State : '';
      break;
  }
  return res;
}

function locIdx_(t, loc) {
  for (var k = 0; k < t.rows.length; k++) if (t.rows[k][t.idx.Location] === loc) return k;
  return -1;
}

/**
 * คำนวณสถานะรวมของ Location ใหม่จาก Loc_Members + Count_Log
 * - ผู้ช่วยที่ส่งงานแล้วแต่มีรายการใหม่หลังส่งงาน → กลับเป็นกำลังนับ (ผู้ดูแลปิดไม่ได้จนกว่าจะส่งงานใหม่)
 * - Location ที่ปิดแล้วแต่มีรายการเกินที่ครอบคลุมตอนปิด → ติดธง "มีรายการหลังปิด — ตรวจซ้ำ"
 */
function refreshLocations_(project, locNames, locs, mt) {
  if (!locNames.length) return;
  locs = locs || table_('Locations');
  mt = mt || membersTable_();
  var data = locData_(project, locNames);
  locNames.forEach(function (loc) {
    var D = data[loc] || { devices: {}, qty: 0 };
    var list = membersOf_(mt, project, loc);
    list.forEach(function (x) {
      var dev = D.devices[x.m.Device_ID];
      if (!dev) return;
      var cover = Number(x.m.Cover_Seq) || 0;
      if ((x.m.State === 'SUBMITTED' || x.m.State === 'PAUSED') && dev.maxSeq > cover) {
        putRow_(mt, x.i, { State: 'COUNTING', State_At: now_(), Updated_At: now_() });
        x.m.State = 'COUNTING';
      }
    });
    // เครื่องที่มีรายการใน Location แต่ยังไม่มีใน Loc_Members (เช่น นำเข้าจากไฟล์) → เพิ่มเป็นผู้ช่วย
    Object.keys(D.devices).forEach(function (d) {
      if (list.some(function (x) { return x.m.Device_ID === d; })) return;
      var hasOwner = list.some(function (x) { return x.m.Role === 'OWNER'; });
      putMember_(mt, project, loc, d, { Role: hasOwner ? 'HELPER' : 'OWNER', State: 'COUNTING', State_At: now_(), Staff: '', Ev_At: 0 });
    });
    list = membersOf_(mt, project, loc);
    var owner = list.filter(function (x) { return x.m.Role === 'OWNER'; })[0];
    var li = locIdx_(locs, loc);
    var L = li >= 0 ? rowObj_(locs, locs.rows[li]) : {};
    var closed = owner && owner.m.State === 'CLOSED';
    var counting = list.some(function (x) { return x.m.State === 'COUNTING'; });
    var after = false;
    if (closed) {
      var cover = {};
      try { cover = JSON.parse(L.Close_Cover || '{}'); } catch (e) { cover = {}; }
      Object.keys(D.devices).forEach(function (d) { if (D.devices[d].maxSeq > (Number(cover[d]) || 0)) after = true; });
    }
    var helpers = list.filter(function (x) { return x.m.Role === 'HELPER'; });
    var done = helpers.filter(function (x) { return x.m.State === 'SUBMITTED' && x.m.Match === 'OK'; }).length;
    var flags = [];
    if (after) flags.push(FLAG_AFTER_CLOSE);
    if (L.Flag_Check) flags.push(L.Flag_Check);
    var counters = {};
    list.forEach(function (x) { if (x.m.Staff) counters[x.m.Staff] = true; });
    String(L.Counters || '').split(',').filter(String).forEach(function (c) { counters[c] = true; });
    putRow_(locs, li, {
      Location: loc, Zone: (loc.match(/^[A-Z]+/) || [''])[0],
      Status: closed ? 'ปิดแล้ว' : counting ? 'กำลังนับ' : 'พัก',
      Status_Detail: list.length > 1 ? list.length + ' เครื่อง · ผู้ช่วยส่งงานแล้ว ' + done + '/' + helpers.length : '',
      Owner: owner ? owner.m.Device_ID + (owner.m.Staff ? ' ' + owner.m.Staff : '') : '',
      Open_By: owner && !closed ? owner.m.Device_ID + (owner.m.Staff ? ' ' + owner.m.Staff : '') : '',
      Members: list.map(function (x) {
        return x.m.Device_ID + ' ' + (ROLE_TH[x.m.Role] || '') + ' ' + (STATE_TH[x.m.State] || x.m.State) +
          (x.m.State === 'SUBMITTED' && x.m.Match !== 'OK' ? ' (รอข้อมูล)' : '') + (x.m.Sub_By === 'ADMIN' ? ' (แทนโดยหัวหน้าทีม)' : '');
      }).join(' · '),
      Devices: list.map(function (x) { return x.m.Device_ID; }).join(','),
      Counters: Object.keys(counters).join(','),
      Flag: flags.join(' · '),
      Updated_At: now_()
    });
  });
}

// ---------- ตรวจ "ยอดที่เห็นตอนแก้" (Control 8) ----------

/**
 * เรียกจาก ingest_ ก่อนบันทึกรายการ RECOUNT_SET: เทียบยอด SKU รวมทุกเครื่องบนเซิร์ฟเวอร์ ณ ตอนนั้น กับ basis ที่เครื่องเห็นตอนแก้
 * ไม่ตรง = มีเครื่องอื่นยิง/แก้ SKU นี้ระหว่างนั้น → ติดธง "ต้องตรวจซ้ำ"
 * แก้จากแอปรุ่นเก่า (ไม่มี basis) ขณะ Location มีหลายเครื่อง → ติดธงเช่นกัน
 */
function basisChecker_(project, X) {
  // ยอดบนเซิร์ฟเวอร์จากดัชนี (v2.3.0) + รายการก่อนหน้าในชุดเดียวกัน (ยังไม่ได้บันทึก)
  // since/oe (v2.3.1): ยอดของแต่ละเครื่องนับจากล้าง Location ครั้งล่าสุด และผู้ดูแลแก้ยอดรวม SKU แล้วหรือยัง
  var map = {}, devs = {}, loaded = {}, since = {};
  function load(loc) {
    if (loaded[loc]) return;
    loaded[loc] = true;
    var D = (X || logIdx_(project)).loc([loc])[loc];
    if (!D) return;
    Object.keys(D.items).forEach(function (k) {
      var it = D.items[k], kk = loc + '|' + k;
      map[kk] = r3_((map[kk] || 0) + it.qty);
      Object.keys(it.since || {}).forEach(function (d) { since[kk + '|' + d] = it.since[d]; });
    });
    Object.keys(D.devices).forEach(function (d) { (devs[loc] || (devs[loc] = {}))[d] = true; });
  }
  function add(loc, e, dev) {
    var kk = loc + '|' + itemKey_(e.material, e.barcode), qty = Number(e.qty) || 0;
    map[kk] = r3_((map[kk] || 0) + qty);
    (devs[loc] || (devs[loc] = {}))[dev] = true;
    if (lxIsClear_(e.type, e.reason)) {
      Object.keys(since).forEach(function (x) { if (x.indexOf(kk + '|') === 0) delete since[x]; });
      return;
    }
    if (e.type === 'RECOUNT_SET') {
      var sm = {};
      Object.keys(since).forEach(function (x) { if (x.indexOf(kk + '|') === 0) sm[x.slice(kk.length + 1)] = since[x]; });
      var cover = lxCover_(sm, dev);
      if (cover.length) { cover.forEach(function (d) { since[kk + '|' + d] = 0; }); return; }   // จุดตัดยอด (v2.3.5)
    }
    since[kk + '|' + dev] = r3_((since[kk + '|' + dev] || 0) + qty);
  }
  var problems = [];
  return {
    check: function (e, loc, deviceId) {
      if (e.type === 'SELF_SET') {
        // แก้ยอดของตัวเอง: เทียบกับยอดของเครื่องนี้ นับจากจุดตัดล่าสุด (ล้าง Location / ผู้ดูแลแก้ยอดรวม)
        load(loc);
        var kk = loc + '|' + itemKey_(e.material, e.barcode), sku = e.material || e.barcode;
        var mine = since[kk + '|' + deviceId] || 0;
        if (e.basis === undefined || e.basis === null || e.basis === '' || r3_(e.basis) !== mine) {
          problems.push({ loc: loc, note: deviceId + ' แก้ ' + sku + ' จากยอดของตัวเองที่ไม่ตรง: เห็น ' + e.basis + ' เซิร์ฟเวอร์ ' + mine });
        } else if (r3_(mine + (Number(e.qty) || 0)) < 0) problems.push({ loc: loc, note: deviceId + ' แก้ ' + sku + ' จนยอดของตัวเองติดลบ' });
        return;
      }
      if (e.type !== 'RECOUNT_SET') return;
      load(loc);
      var k = loc + '|' + itemKey_(e.material, e.barcode);
      var cur = map[k] || 0;
      if (e.basis === undefined || e.basis === null || e.basis === '') {
        var ds = Object.keys(devs[loc] || {});
        if (ds.length > 1 || (ds.length === 1 && ds[0] !== deviceId)) problems.push({ loc: loc, note: 'แก้ยอดจากแอปรุ่นเก่าขณะมีหลายเครื่อง (' + (e.material || e.barcode) + ')' });
        return;
      }
      if (r3_(e.basis) !== cur) problems.push({ loc: loc, note: 'ยอดเปลี่ยนระหว่างแก้ ' + (e.material || e.barcode) + ': เห็น ' + r3_(e.basis) + ' เซิร์ฟเวอร์ ' + cur });
    },
    added: function (e, loc, deviceId) { if (loaded[loc]) add(loc, e, deviceId); },
    problems: problems
  };
}

/**
 * รายการที่ยิงในช่วงที่เครื่องถูกยกเลิก (Revoked_At ถึง Repaired_At): บันทึกใน Admin_Log ทุกเหตุผล
 * เหตุผล LOST (หาย / สงสัย) → Location นั้นขึ้น "ต้องตรวจซ้ำ"
 */
function revokeWindow_(project, deviceId, device, entries, accepted) {
  var from = String(device.Revoked_At), to = String(device.Repaired_At || '');
  var ok = {};
  accepted.forEach(function (id) { ok[id] = true; });
  var hit = entries.filter(function (e) {
    var t = String(e.scanTime || '');
    return ok[String(e.logId)] && t >= from && (!to || t < to);
  });
  if (!hit.length) return [];
  var byLoc = {}, seqs = hit.map(function (e) { return Number(e.seq); });
  hit.forEach(function (e) { var l = normLoc_(e.location) || '(ไม่มี Location)'; byLoc[l] = (byLoc[l] || 0) + 1; });
  var lost = device.Revoke_Reason === 'LOST';
  logAdmin_('REVOKED_DEVICE_DATA', deviceId, 'รับรายการที่ยิงหลังยกเลิกเครื่อง ' + hit.length + ' รายการ (Seq ' + Math.min.apply(null, seqs) + '–' +
    Math.max.apply(null, seqs) + ') ' + Object.keys(byLoc).map(function (l) { return l + ' ' + byLoc[l]; }).join(', ') + (lost ? ' → ต้องตรวจซ้ำ' : ''));
  if (!lost) return [];
  var locs = Object.keys(byLoc).filter(function (l) { return l.charAt(0) !== '('; });
  flagCheck_(project, deviceId, locs.map(function (l) {
    return { loc: l, type: 'REVOKED_DATA', note: deviceId + ' ยิง ' + byLoc[l] + ' รายการหลังถูกยกเลิก (เครื่องหาย/สงสัย)' };
  }));
  return locs;
}

function flagCheck_(project, deviceId, problems) {
  if (!problems.length) return;
  var locs = table_('Locations');
  var rows = [];
  var byLoc = {};
  problems.forEach(function (p) { (byLoc[p.loc] || (byLoc[p.loc] = [])).push(p.note); rows.push([now_(), project, deviceId, p.loc, p.type || 'EDIT_CONFLICT', '', '', '', '', '', 'ต้องตรวจซ้ำ', '', p.note]); });
  Object.keys(byLoc).forEach(function (loc) {
    var li = locIdx_(locs, loc);
    var cur = li >= 0 ? String(rowObj_(locs, locs.rows[li]).Flag_Check || '') : '';
    var note = 'ต้องตรวจซ้ำ: ' + byLoc[loc].join(' · ');
    putRow_(locs, li, { Location: loc, Zone: (loc.match(/^[A-Z]+/) || [''])[0], Flag_Check: (cur ? cur + ' · ' : '') + note, Updated_At: now_() });
  });
  appendRows_(SpreadsheetApp.getActive().getSheetByName('Loc_Checks'), rows);
}

// ---------- ข้อมูล Location สำหรับเครื่อง ----------

function memberView_(m, D, staffNames) {
  var dev = (D && D.devices[m.Device_ID]) || { lines: 0, qty: 0, lastTime: '' };
  return {
    device: m.Device_ID, staff: m.Staff, name: staffNames[m.Staff] || '', role: m.Role, state: m.State, match: m.Match,
    subBy: m.Sub_By, lines: dev.lines, qty: dev.qty, sc: dev.sc === undefined ? dev.qty : dev.sc, lastTime: dev.lastTime, stateAt: m.State_At
  };
}

function staffNames_() {
  var t = table_('Staff'), out = {};
  t.rows.forEach(function (r) { var s = rowObj_(t, r); if (s.Staff_Code) out[normStaff_(s.Staff_Code)] = s.Name; });
  return out;
}

/**
 * รายละเอียด Location: ผู้ดูแล ผู้ช่วย สถานะต่อเครื่อง และยอดต่อ SKU ของ "เครื่องอื่น"
 * (เครื่องที่ถามนำยอดของตัวเองในเครื่องมารวมเอง เพราะอาจมีรายการที่ยังไม่ได้ส่ง)
 */
function apiLocInfo_(a, req) {
  var cfg = readConfig_(), project = cfg.PROJECT_ID;
  migrateMembers_(project);
  var loc = normLoc_(req.location);
  var D = locData_(project, [loc])[loc] || { devices: {}, items: {}, qty: 0, lines: 0 };
  var mt = membersTable_();
  var names = staffNames_();
  var list = membersOf_(mt, project, loc).map(function (x) { return memberView_(x.m, D, names); });
  var owner = list.filter(function (m) { return m.role === 'OWNER'; })[0] || null;
  var me = list.filter(function (m) { return m.device === a.deviceId; })[0] || null;
  var others = [], othersQty = 0;
  Object.keys(D.items).forEach(function (k) {
    var it = D.items[k];
    // ยอดเครื่องอื่น = นับจากล้าง Location ครั้งล่าสุด (v2.3.6) — รายการล้างไม่ไปโผล่เป็นยอดติดลบของเครื่องที่กดล้าง
    // [k, material, barcode, ยอดรวมเครื่องอื่น (ใช้รวมยอด เหมือนเดิม), ยอดเครื่องอื่นหลังล้าง (ใช้แสดงแยก "เครื่องอื่น")]
    var sc = it.sc || it.byDevice;
    var q = r3_(it.qty - (it.byDevice[a.deviceId] || 0));
    var qs = r3_(Object.keys(sc).reduce(function (t, d) { return d === a.deviceId ? t : t + sc[d]; }, 0));
    if (q !== 0 || qs !== 0 || Object.keys(it.byDevice).some(function (d) { return d !== a.deviceId; })) others.push([k, it.material, it.barcode, q, qs]);
    othersQty += q;
  });
  var t = table_('Locations'), li = locIdx_(t, loc);
  var L = li >= 0 ? rowObj_(t, t.rows[li]) : {};
  // การแก้ต่อ SKU: cp = จุดตัดยอดของเครื่องนี้ (Seq ตอนผู้ดูแลแก้ยอดรวม · v2.3.5) · by/at = ใครแก้ล่าสุด (เตือนก่อนแก้)
  var edits = {};
  Object.keys(D.items).forEach(function (k) {
    var it = D.items[k], cp = (it.cp && it.cp[a.deviceId]) || 0;
    if (cp || it.le) edits[k] = { cp: cp, by: it.le ? it.le[0] : '', at: it.le ? it.le[1] : '' };
  });
  return {
    ok: true, location: loc, status: L.Status || '', flag: L.Flag || '', owner: owner, me: me, members: list,
    others: { items: others, qty: r3_(othersQty) }, total: D.qty,
    clr: (D.clr && D.clr[a.deviceId]) || 0, edits: edits
  };
}

/** Location ที่เครื่องนี้เคยร่วมนับในรอบนี้ + ชื่อ Location ทั้งหมดในรอบ (ใช้เตือนพิมพ์ชื่อผิด) */
function apiMyLocs_(a) {
  var cfg = readConfig_(), project = cfg.PROJECT_ID;
  migrateMembers_(project);
  var mt = membersTable_();
  var mine = {};
  mt.rows.forEach(function (r) {
    if (r[mt.idx.Project_ID] === project && r[mt.idx.Device_ID] === a.deviceId) mine[r[mt.idx.Location]] = rowObj_(mt, r);
  });
  var t = table_('Locations');
  var data = locData_(project, Object.keys(mine));
  var count = {};
  mt.rows.forEach(function (r) { if (r[mt.idx.Project_ID] === project) count[r[mt.idx.Location]] = (count[r[mt.idx.Location]] || 0) + 1; });
  var names = {};
  t.rows.forEach(function (r) { var l = r[t.idx.Location]; if (l && count[l]) names[l] = true; });
  Object.keys(count).forEach(function (l) { names[l] = true; });
  var list = Object.keys(mine).map(function (loc) {
    var m = mine[loc], li = locIdx_(t, loc), L = li >= 0 ? rowObj_(t, t.rows[li]) : {};
    var D = data[loc] || { qty: 0 }, me = (D.devices || {})[a.deviceId];
    // หน้า "Location ที่นับแล้ว" (v2.3.7): ยอดของฉันหลังล้าง · ผู้ช่วยส่งงานกี่เครื่อง · ยอดตอนปิด
    var hp = mt.rows.filter(function (r) { return r[mt.idx.Project_ID] === project && r[mt.idx.Location] === loc && r[mt.idx.Role] === 'HELPER'; });
    return { location: loc, role: m.Role, state: m.State, match: m.Match, status: L.Status || '', total: D.qty, devices: count[loc] || 1, flag: L.Flag || '', owner: L.Owner || '',
      mineSc: me ? (me.sc === undefined ? me.qty : me.sc) : 0, closedTime: L.Closed_Time ? String(L.Closed_Time) : '',
      closeTotal: L.Close_Total === '' || L.Close_Total === undefined ? null : Number(String(L.Close_Total).replace(/,/g, '')),
      helpers: hp.length, helpersDone: hp.filter(function (r) { return r[mt.idx.State] === 'SUBMITTED' || r[mt.idx.State] === 'CLOSED'; }).length };
  });
  return { ok: true, locs: list, names: Object.keys(names), at: now_() };
}

/** รุ่นเก่า (ก่อน 2.2.0) ยังเรียก locStatus — คืนผู้ดูแลถ้าเป็นเครื่องอื่น */
function apiLocStatus_(a, req) {
  var cfg = readConfig_(), project = cfg.PROJECT_ID;
  migrateMembers_(project);
  var loc = normLoc_(req.location);
  var mt = membersTable_();
  var owner = ownerOf_(mt, project, loc);
  var t = table_('Locations'), li = locIdx_(t, loc);
  var L = li >= 0 ? rowObj_(t, t.rows[li]) : {};
  var other = owner && owner.m.Device_ID !== a.deviceId ? owner.m.Device_ID + (owner.m.Staff ? ' ' + owner.m.Staff : '') : '';
  return { ok: true, location: loc, status: L.Status || '', openByOther: other, devices: L.Devices || '', counters: L.Counters || '' };
}

// ---------- หัวหน้าทีม (หน้า Admin) ----------

/** ส่งงานแทนผู้ช่วยที่ติดต่อไม่ได้: ใช้ยอดที่เซิร์ฟเวอร์ได้รับแล้ว รายการที่มาทีหลังจะทำให้กลับเป็น "กำลังนับ" หรือติดธงหลังปิด */
/** หัวหน้าทีมปิดธง "ต้องตรวจซ้ำ" หลังตรวจแล้วว่ายอดถูก — ต้องมีเหตุผล บันทึกผู้กดใน Admin_Log และ Loc_Checks (v2.2.8) */
function adminResolveFlag_(loc, reason) {
  var project = readConfig_().PROJECT_ID;
  loc = normLoc_(loc);
  reason = String(reason || '').trim();
  if (!reason) throw new Error('ต้องระบุเหตุผลการปิดธง');
  var locs = table_('Locations'), li = locIdx_(locs, loc);
  if (li < 0) throw new Error('ไม่พบ Location ' + loc);
  var old = String(rowObj_(locs, locs.rows[li]).Flag_Check || '');
  if (!old) throw new Error(loc + ' ไม่มีธงต้องตรวจซ้ำ');
  putRow_(locs, li, { Flag_Check: '', Updated_At: now_() });
  appendRows_(SpreadsheetApp.getActive().getSheetByName('Loc_Checks'),
    [[now_(), project, 'ADMIN', loc, 'FLAG_RESOLVE', who_(), '', '', '', '', '', '', 'ปิดธง: ' + reason + ' — ธงเดิม: ' + old]]);
  logAdmin_('LOC_FLAG_RESOLVE', loc, 'ปิดธงต้องตรวจซ้ำ เหตุผล: ' + reason + ' — ธงเดิม: ' + old);
  refreshLocations_(project, [loc]);
}

function adminSubmitFor_(loc, deviceId, reason) {
  var project = readConfig_().PROJECT_ID;
  migrateMembers_(project);
  loc = normLoc_(loc);
  var mt = membersTable_();
  var i = memberIdx_(mt, project, loc, deviceId);
  if (i < 0) throw new Error(deviceId + ' ไม่ได้ร่วมนับ ' + loc);
  var m = rowObj_(mt, mt.rows[i]);
  if (m.Role !== 'HELPER') throw new Error(deviceId + ' เป็นผู้ดูแล ' + loc + ' — ใช้ "โอนการดูแล" แทน');
  var D = (locData_(project, [loc])[loc] || { devices: {} }).devices[deviceId] || { lines: 0, qty: 0, maxSeq: 0 };
  var seqAll = deviceSeqInfo_(deviceId, project).max;
  putRow_(mt, i, { State: 'SUBMITTED', State_At: now_(), Cover_Seq: Math.max(seqAll, D.maxSeq), Sub_Lines: D.lines, Sub_Qty: D.qty, Match: 'OK', Sub_By: 'ADMIN', Ev_At: Date.now(), Updated_At: now_() });
  var note = 'หัวหน้าทีมส่งงานแทน ' + who_() + (reason ? ' · ' + reason : '') + ' · ยอดที่เซิร์ฟเวอร์มี ' + D.qty + ' ชิ้น ' + D.lines + ' รายการ';
  appendRows_(SpreadsheetApp.getActive().getSheetByName('Loc_Checks'), [[now_(), project, deviceId, loc, 'ADMIN_SUBMIT', '', D.lines, D.qty, D.lines, D.qty, 'OK', Math.max(seqAll, D.maxSeq), note]]);
  logAdmin_('LOC_SUBMIT_FOR', loc + ' ' + deviceId, note);
  refreshLocations_(project, [loc], null, mt);
}

/** โอนการดูแล Location ให้เครื่องอื่น (เช่น เครื่องผู้ดูแลเสีย) ผู้ดูแลเดิมกลายเป็นผู้ช่วยที่ส่งงานแล้ว */
function adminTransfer_(loc, toDevice, reason) {
  var project = readConfig_().PROJECT_ID;
  migrateMembers_(project);
  loc = normLoc_(loc);
  var dt = table_('Devices');
  var di = findDevice_(dt, toDevice);
  if (di < 0) throw new Error('ไม่พบเครื่อง ' + toDevice);
  var dv = rowObj_(dt, dt.rows[di]);
  if (String(dv.Active).toUpperCase() === 'N') throw new Error(toDevice + ' ถูกยกเลิกอยู่ — เปิดใช้และจับคู่ก่อน');
  if (!dv.Token_Hash) throw new Error(toDevice + ' ยังไม่จับคู่ — จับคู่ก่อนจึงรับโอนได้');
  if (!String(reason || '').trim()) throw new Error('ต้องระบุเหตุผลการโอน');
  var mt = membersTable_();
  var owner = ownerOf_(mt, project, loc);
  if (owner && owner.m.Device_ID === toDevice) throw new Error(toDevice + ' เป็นผู้ดูแลอยู่แล้ว');
  var closed = owner && owner.m.State === 'CLOSED';
  if (owner) {
    var D = (locData_(project, [loc])[loc] || { devices: {} }).devices[owner.m.Device_ID] || { lines: 0, qty: 0, maxSeq: 0 };
    var seqAll = deviceSeqInfo_(owner.m.Device_ID, project).max;
    putRow_(mt, owner.i, { Role: 'HELPER', State: 'SUBMITTED', State_At: now_(), Cover_Seq: Math.max(seqAll, D.maxSeq), Sub_Lines: D.lines, Sub_Qty: D.qty,
      Match: 'OK', Sub_By: 'ADMIN', Ev_At: Date.now(), Updated_At: now_() });
  }
  var ti = memberIdx_(mt, project, loc, toDevice);
  var cur = ti >= 0 ? rowObj_(mt, mt.rows[ti]) : null;
  putMember_(mt, project, loc, toDevice, { Role: 'OWNER', State: closed ? 'CLOSED' : cur && cur.State === 'COUNTING' ? 'COUNTING' : 'PAUSED', State_At: now_(), Ev_At: Date.now(),
    Staff: cur ? cur.Staff : '', Cover_Seq: cur ? cur.Cover_Seq : 0 });
  var note = 'โอนการดูแล ' + (owner ? owner.m.Device_ID : '-') + ' → ' + toDevice + ' โดย ' + who_() + (reason ? ' · ' + reason : '');
  appendRows_(SpreadsheetApp.getActive().getSheetByName('Loc_Checks'), [[now_(), project, toDevice, loc, 'TRANSFER', '', '', '', '', '', '', '', note]]);
  logAdmin_('LOC_TRANSFER', loc, note);
  refreshLocations_(project, [loc], null, mt);
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

// ---------- ทดสอบแรงงาน (ขั้น C) — เรียกจากหน้า Apps Script เท่านั้น ไม่มีปุ่มในหน้า Admin ----------
//
// loadTestSeed(): เติมแถวปลอมลง Count_Log ให้ใกล้ข้อมูลเต็มรอบ แล้ววัดเวลาจาก TC21 จริง (หน้าสถานะ)
//   เครื่อง LOADTEST-1..4 · Location ZZ1..ZZ300 · Source = LOADTEST · ใช้บาร์โค้ดจริงจาก Device_Master
//   ระหว่างมีแถวปลอม ยอดเทียบ SAP ในหน้า Admin จะไม่ถูกต้อง — ใช้เฉพาะรอบทดสอบ
// loadTestClear(): ลบแถว Source = LOADTEST ออกทั้งหมด (แถวจริงไม่ถูกแตะ)

var LOADTEST_SRC = 'LOADTEST';

function loadTestSeed(rows) {
  rows = Math.min(Number(rows) || 11000, 20000);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('มีเครื่องกำลังส่งข้อมูลอยู่ ลองใหม่อีกครั้ง');
  try {
    var cfg = readConfig_(), project = cfg.PROJECT_ID;
    if (!project) throw new Error('ยังไม่ได้เปิดรอบ');
    var items = readRaw_('Device_Master').slice(1).filter(function (r) { return r[0] && r[1]; }).slice(0, 500);
    if (!items.length) throw new Error('ยังไม่มี Device_Master (อนุมัติ Master ก่อน)');
    var sh = SpreadsheetApp.getActive().getSheetByName('Count_Log');
    var seq = {}, out = [], now = now_();
    sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 4).getDisplayValues().forEach(function (r) {
      if (String(r[2]).indexOf('LOADTEST-') === 0) seq[r[2]] = Math.max(seq[r[2]] || 0, Number(r[3]) || 0);
    });
    for (var i = 0; i < rows; i++) {
      var dev = 'LOADTEST-' + (1 + i % 4), s = seq[dev] = (seq[dev] || 0) + 1;
      var it = items[i % items.length];
      out.push([dev + '-' + ('000000' + s).slice(-6), project, dev, s, 'LOADTEST', 'ZZ' + (1 + Math.floor(i * 300 / rows)), it[0], it[1], 1,
        'SCAN', '', '', 'ข้อมูลทดสอบแรงงาน', now, now, LOADTEST_SRC, 'LOADTEST', '', '']);
    }
    for (var k = 0; k < out.length; k += 5000) appendRows_(sh, out.slice(k, k + 5000));
    lxReset_();
    var X = logIdx_(project, { write: true }); X.save();
    logAdmin_('LOADTEST_SEED', project, 'เติมแถวทดสอบแรงงาน ' + rows + ' แถว (Count_Log รวม ' + (X.last - 1) + ' แถว) — ลบด้วย loadTestClear()');
    return 'เติม ' + rows + ' แถว · Count_Log รวม ' + (X.last - 1) + ' แถว';
  } finally { releaseLock_(lock); }
}

function loadTestClear() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('มีเครื่องกำลังส่งข้อมูลอยู่ ลองใหม่อีกครั้ง');
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName('Count_Log');
    var n = sh.getLastRow();
    if (n < 2) return 'ไม่มีข้อมูล';
    var width = sh.getLastColumn();
    var vals = sh.getRange(2, 1, n - 1, width).getValues();   // ค่าจริง (ไม่ใช่ค่าแสดงผล) เขียนกลับได้เหมือนเดิม
    var srcCol = SHEETS.Count_Log.indexOf('Source');
    var keep = vals.filter(function (r) { return r[srcCol] !== LOADTEST_SRC; });
    var removed = vals.length - keep.length;
    if (!removed) return 'ไม่มีแถวทดสอบแรงงาน';
    sh.getRange(2, 1, n - 1, width).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, width).setValues(keep);
    lxReset_();
    logAdmin_('LOADTEST_CLEAR', readConfig_().PROJECT_ID, 'ลบแถวทดสอบแรงงาน ' + removed + ' แถว (เหลือ ' + keep.length + ' แถว)');
    return 'ลบ ' + removed + ' แถว · เหลือ ' + keep.length + ' แถว';
  } finally { releaseLock_(lock); }
}
