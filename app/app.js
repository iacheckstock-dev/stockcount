/* app.js — เว็บแอปตรวจนับบน Zebra TC21 (เฟส 2)
 * หลักการ: ทุกการยิงบันทึกลงเครื่อง (IndexedDB) ก่อนเสมอ แล้วส่งขึ้นเซิร์ฟเวอร์เป็นชุด
 * เซิร์ฟเวอร์กันซ้ำด้วย Log_ID = รหัสเครื่อง-Seq จึงส่งซ้ำกี่ครั้งก็ไม่นับเกิน
 */
(function () {
  'use strict';

  var APP_VERSION = '2.4.0';
  var QTY_CONFIRM = 150;      // จำนวนที่ป้อนเองเกินนี้ต้องยืนยันอีกครั้ง
  var QTY_MAX_DIGITS = 5;     // ยาวกว่านี้ = น่าจะยิงบาร์โค้ดเข้าช่องจำนวน
  var INFO_EVERY = 15000;     // ถามสถานะผู้ช่วย/ผู้ดูแลระหว่างนับร่วมกัน
  var INFO_EVERY_WAIT = 8000; // ถี่ขึ้นตอนผู้ดูแลรอผู้ช่วยส่งงาน
  var INFO_MS = 10000;        // เวลารอคำตอบ "ใครอยู่ใน Location" (GAS จริงตอบ 1–5 วินาที บางครั้งนานกว่า)
  var BATCH = 20;
  var SYNC_EVERY = 2500;
  var STALE_MIN = 30;
  var SYNC_OK = ['SETUP', 'COUNTING', 'COUNT_CLOSED'];

  var S = {
    cfg: {}, boot: null, latestVersion: '', defaultApi: '',
    master: new Map(), masterList: [], masterHash: '', masterProject: '',
    projectId: '', entries: [], oldPending: [], events: [],
    staff: null, loc: null, qty: '', roles: {}, info: {}, myLocs: {}, knownNames: [], locChecks: {},
    serverVersion: '', online: null, syncing: false, lastSyncOk: 0, lastErr: '', serverOffset: null,
    readiness: null, dwOk: false, view: '', recountBanner: '', masterChanged: false, wakeLock: null,
    stock: new Map(), stockSource: '', stockVersion: '', lastSku: null, resumeMsg: '', resumeUntil: 0
  };

  // ---------- เครื่องมือ ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 3 }); }
  function pad6(n) { return ('000000' + n).slice(-6); }
  function two(n) { return ('0' + n).slice(-2); }
  function stamp(d) { d = d || new Date(); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); }
  function today() { return stamp().slice(0, 10); }
  function normLoc(v) { var s = String(v || '').trim().toUpperCase().replace(/^LOC:/, ''); var m = s.match(/^([A-Z]+)0*(\d+)$/); return m ? m[1] + m[2] : ''; }
  function itemKey(e) { return e.material || ('BC:' + e.barcode); }
  function checkDigitOk(b) {
    var d = b.split('').map(Number), c = d.pop(), sum = 0;
    for (var i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
    return (10 - sum % 10) % 10 === c;
  }
  function validFormat(b) { return /^(\d{8}|\d{12,14})$/.test(b) && checkDigitOk(b); }

  var toastTimer;
  function toast(msg, err) {
    var t = $('toast'); t.textContent = msg; t.className = err ? 'err' : ''; clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'hidden'; }, err ? 4000 : 2200);
  }

  // ---------- เสียงและสั่น ----------
  var audio = null;
  function ac() {
    if (!audio) { var C = window.AudioContext || window.webkitAudioContext; if (C) audio = new C(); }
    if (audio && audio.state === 'suspended') audio.resume();
    return audio;
  }
  function tone(freq, ms, at, type) {
    var a = ac(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = type || 'square'; o.frequency.value = freq; g.gain.value = 0.25;
    o.connect(g); g.connect(a.destination);
    var t0 = a.currentTime + (at || 0) / 1000;
    o.start(t0); o.stop(t0 + ms / 1000);
  }
  var SOUND = {
    ok: function () { tone(1250, 70); if (navigator.vibrate) navigator.vibrate(30); },
    warn: function () { tone(700, 120); tone(700, 120, 200); if (navigator.vibrate) navigator.vibrate([80, 60, 80]); },
    bad: function () { tone(280, 600, 0, 'sawtooth'); if (navigator.vibrate) navigator.vibrate(500); }
  };
  document.addEventListener('touchstart', ac, { once: true });
  document.addEventListener('click', ac, { once: true });

  // ---------- โมดัล ----------
  var modalCb = null;
  /** กล่องกลางจอ "กำลังทำ…" พร้อมไอคอนหมุน (CSS ล้วน ไม่ติดต่อเซิร์ฟเวอร์เพิ่ม) — ค้างจนได้ผล (U9/U15/U17) */
  function busy(title, sub) {
    $('busyTitle').textContent = title; $('busySub').textContent = sub || '';
    $('busy').classList.remove('hidden');
  }
  function busyOff() { $('busy').classList.add('hidden'); }

  /**
   * กล่องผลลัพธ์กลางจอ (v2.3.3) — ผลที่ผู้ใช้ต้องรู้ อยู่ตรงที่สายตาอยู่ ไม่ใช่แถบล่าง
   * ok = true : ✓ เขียว หายเองใน 1.5 วิ · แตะปิดได้ · ยิงต่อได้ทันที (กล่องปิดแล้วรับการยิงนั้น)
   * ok = false: ✕ แดง ต้องกด "ตกลง" · opt.scanCloses = ยิงใหม่แทนการกดได้ (เช่น ยิงบัตรผิด)
   * คืน Promise ที่จบเมื่อกล่องปิด — ค่า 'scan' ถ้าปิดเพราะผู้ใช้ยิงต่อ (ไปงานถัดไปแล้ว ไม่ต้องถามอะไรเพิ่ม)
   */
  var resTimer = null, resDone = null;
  function result(ok, title, sub, opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      busyOff();
      if (resDone) resDone();
      $('resIcon').textContent = ok ? '✓' : '✕';
      $('resIcon').className = 'resicon ' + (ok ? 'ok' : 'bad');
      $('resTitle').textContent = title;
      $('resSub').textContent = sub || '';
      $('resOk').classList.toggle('hidden', !!ok);
      $('result').classList.remove('hidden');
      S.result = ok ? 'ok' : opt.scanCloses ? 'retry' : 'bad';
      resDone = function (how) {
        clearTimeout(resTimer); resDone = null; S.result = '';
        $('result').classList.add('hidden'); resolve(how || '');
      };
      if (ok) resTimer = setTimeout(resDone, 1500);
      else setTimeout(function () { $('resOk').focus(); }, 50);
    });
  }
  function resultClose(how) { if (resDone) resDone(how); }
  $('result').addEventListener('click', function (e) { if (S.result === 'ok' || e.target.id === 'resOk') resultClose(); });

  function modal(opt) {
    busyOff();
    return new Promise(function (resolve) {
      $('mTitle').textContent = opt.title || '';
      $('mBody').innerHTML = opt.html || '';
      var inp = $('mInput');
      inp.classList.toggle('hidden', !opt.input);
      inp.value = opt.value !== undefined ? opt.value : '';
      inp.setAttribute('inputmode', opt.inputmode || 'numeric');
      $('mPreview').innerHTML = '';
      $('mYes').textContent = opt.yes || 'ยืนยัน';
      $('mNo').textContent = opt.no || 'ยกเลิก';
      $('mNo').classList.toggle('hidden', opt.noCancel === true);
      $('modal').classList.remove('hidden');
      inp.oninput = function () { if (opt.preview) $('mPreview').innerHTML = opt.preview(inp.value); };
      if (opt.input) { setTimeout(function () { inp.focus(); inp.select(); }, 50); if (opt.preview) $('mPreview').innerHTML = opt.preview(inp.value); }
      modalCb = function (yes) {
        $('modal').classList.add('hidden'); modalCb = null;
        resolve(yes ? (opt.input ? inp.value : true) : (opt.input ? null : false));
      };
    });
  }
  $('mYes').onclick = function () { if (modalCb) modalCb(true); };
  $('mNo').onclick = function () { if (modalCb) modalCb(false); };
  $('mInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && modalCb) { e.preventDefault(); modalCb(true); } });
  function confirmBox(title, html, yes) { return modal({ title: title, html: html, yes: yes }); }

  // ---------- เครือข่าย ----------
  function fetchTimeout(url, opt, ms) {
    var ctl = window.AbortController ? new AbortController() : null, timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, ms || 20000);
    if (ctl) opt.signal = ctl.signal;
    return fetch(url, opt).then(function (r) { clearTimeout(timer); return r; }, function (e) {
      clearTimeout(timer);
      throw { timeout: timedOut, error: e };
    });
  }

  function api(action, body, ms) {
    if (!S.cfg.apiUrl) return Promise.reject({ code: 'NO_API', message: 'ยังไม่ได้ตั้งที่อยู่เซิร์ฟเวอร์' });
    // ยังไม่จับคู่: ถามเซิร์ฟเวอร์ได้อย่างเดียวคือจับคู่ (ไม่อย่างนั้นได้ "ไม่พบเครื่อง" แล้วถูกเข้าใจว่าถูกยกเลิก)
    if (action !== 'pair' && !S.cfg.token) return Promise.reject({ code: 'NOT_PAIRED', message: 'เครื่องยังไม่ได้จับคู่' });
    var payload = Object.assign({ action: action, deviceId: S.cfg.deviceId, token: S.cfg.token, appVersion: APP_VERSION }, body || {});
    var t0 = Date.now();
    return fetchTimeout(S.cfg.apiUrl, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' }, ms)
      .then(function (r) {
        // Google ตอบเป็นหน้า HTML (สคริปต์ error / เกินโควต้า / สิทธิ์ผิด) ≠ ออฟไลน์
        return r.text().then(function (t) {
          try { return JSON.parse(t); } catch (x) { throw { code: 'BAD_REPLY', message: 'เซิร์ฟเวอร์ตอบผิดรูปแบบ (HTTP ' + r.status + ')' }; }
        });
      }, function (e) {
        // หมดเวลารอ = เซิร์ฟเวอร์ช้า (เครือข่ายยังใช้ได้) · ส่งไม่ออกเลย = ออฟไลน์
        if (e && e.timeout && navigator.onLine !== false) throw { code: 'TIMEOUT', message: 'เซิร์ฟเวอร์ตอบช้า (เกิน ' + Math.round((ms || 20000) / 1000) + ' วินาที)' };
        throw { code: 'NETWORK', message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้' };
      })
      .then(function (res) {
        perfAdd(action, Date.now() - t0, res);
        if (res.serverTime) S.serverOffset = res.serverTime - (t0 + Date.now()) / 2;
        if (res.serverVersion) S.serverVersion = res.serverVersion;
        setOnline(true);
        if (!res.ok) {
          if (action !== 'pair' && REVOKE_CODES.indexOf(res.error) >= 0) setRevoked(res.error);
          if (res.error === 'BUSY' || res.error === 'SERVER_ERROR') setSlow(res.error);
          throw { code: res.error, message: res.message || res.error };
        }
        return res;
      }, function (e) {
        perfAdd(action, Date.now() - t0, null, e && e.code);
        if (e && e.code === 'NETWORK') setOnline(false);
        else if (e && (e.code === 'TIMEOUT' || e.code === 'BAD_REPLY')) setSlow(e.code);
        throw e;
      });
  }

  // ---------- วัดเวลาตอบ (v2.2.6) — แสดงที่หน้าสถานะ และรายงานให้หน้า Admin ทุก 1 นาที ----------
  S.perf = {};
  function perfAdd(action, rtt, res, errCode) {
    var p = S.perf[action] || (S.perf[action] = { n: 0, sum: 0, max: 0, srv: 0, wait: 0, hold: 0, to: 0, err: 0, off: 0 });
    if (errCode) { if (errCode === 'TIMEOUT') p.to++; else if (errCode === 'NETWORK') p.off++; else p.err++; return; }
    p.n++; p.sum += rtt; if (rtt > p.max) p.max = rtt;
    if (res && res.ms) p.srv += res.ms;
    if (res && res.lockWait !== undefined) { p.wait += res.lockWait; p.hold += res.lockHold || 0; }
  }
  function perfReport() {
    var o = {};
    Object.keys(S.perf).forEach(function (k) {
      var p = S.perf[k];
      o[k] = { n: p.n, avg: p.n ? Math.round(p.sum / p.n) : 0, max: p.max, srv: p.n ? Math.round(p.srv / p.n) : 0,
        wait: p.n ? Math.round(p.wait / p.n) : 0, hold: p.n ? Math.round(p.hold / p.n) : 0, to: p.to, err: p.err, off: p.off };
    });
    return o;
  }
  /** เซิร์ฟเวอร์ช้า/มีปัญหา (เครือข่ายยังใช้ได้) → ไฟเหลือง ระบบทำงานต่อ ข้อมูลไม่หาย */
  function setSlow(code) { S.slow = code; S.slowAt = Date.now(); renderTop(); }

  /** เครื่องถูกยกเลิก (หน้า Admin) หรือ token ใช้ไม่ได้: หยุดรับการยิงทันที จนกว่าจะจับคู่ใหม่ — ข้อมูลในเครื่องไม่หาย */
  var REVOKE_CODES = ['BAD_TOKEN', 'DEVICE_DISABLED', 'UNKNOWN_DEVICE'];
  function setRevoked(code) {
    if (!S.cfg.token || S.revoked === code) return;   // เฉพาะเครื่องที่เคยจับคู่แล้วถูกปฏิเสธจริง
    S.revoked = code;
    DB.set('revoked', code);
    if (S.view !== 'setup') { SOUND.bad(); show('revoked'); }
  }

  function setOnline(on) {
    S.online = on;
    if (on) { S.lastErr = ''; S.slow = ''; }
    renderTop();
  }

  // ---------- โหลดข้อมูลในเครื่อง ----------
  function loadConfigJson() {
    return fetchTimeout('config.json?t=' + Date.now(), { cache: 'no-store' }, 6000).then(function (r) { return r.json(); })
      .then(function (c) { S.latestVersion = c.appVersion || ''; S.defaultApi = c.apiUrl || ''; }, function () {});
  }

  function loadMaster() {
    return DB.all('master').then(function (rows) {
      S.master = new Map(); S.masterList = rows; tailCache.clear();
      rows.forEach(function (r) { if (r.b) S.master.set(r.b, r); });
    });
  }

  function loadEntries(projectId) {
    S.projectId = projectId || '';
    return DB.all('entries').then(function (all) {
      S.entries = all.filter(function (e) { return e.projectId === S.projectId; }).sort(function (a, b) { return a.seq - b.seq; });
      S.oldPending = all.filter(function (e) { return e.projectId !== S.projectId && !e.synced && !e.rejected; });
    });
  }

  function saveState() {
    return Promise.all([
      DB.set('staff', S.staff), DB.set('loc', S.loc), DB.set('roles_' + S.projectId, S.roles), DB.set('locChecks_' + S.projectId, S.locChecks)
    ]);
  }

  // ---------- สรุปยอด ----------
  function voidedSet() {
    var v = {};
    S.entries.forEach(function (e) { if (e.type === 'VOID' && e.refId) v[e.refId] = true; });
    return v;
  }

  function locSummary(loc) {
    var items = new Map(), lines = 0, qty = 0;
    S.entries.forEach(function (e) {
      if (e.location !== loc) return;
      lines++; qty += e.qty;
      var k = itemKey(e), it = items.get(k);
      if (!it) { it = { key: k, material: e.material, barcode: e.barcode, qty: 0, edits: 0, lines: 0 }; items.set(k, it); }
      it.qty += e.qty; it.lines++;
      if (e.type === 'RECOUNT_SET' || e.type === 'SELF_SET' || (e.type === 'VOID' && /แก้/.test(e.reason))) it.edits++;
      if (!it.barcode && e.barcode) it.barcode = e.barcode;
    });
    var sku = 0;
    items.forEach(function (it) { it.qty = Math.round(it.qty * 1000) / 1000; if (it.qty !== 0) sku++; });
    return { lines: lines, qty: Math.round(qty * 1000) / 1000, sku: sku, items: items };
  }

  // ---------- ผู้ดูแล / ผู้ช่วย ----------
  // S.roles[loc] = { role: OWNER|HELPER, state: COUNTING|PAUSED|SUBMITTED|CLOSED, owner } — เซิร์ฟเวอร์เป็นตัวตัดสิน เครื่องจำไว้ใช้ตอนออฟไลน์
  // S.info[loc]  = ผล locInfo ล่าสุด (ผู้ช่วยแต่ละเครื่อง + ยอดของเครื่องอื่นต่อ SKU)
  function roleOf(loc) { var r = S.roles[loc]; return r ? r.role : 'OWNER'; }
  function isHelper(loc) { return roleOf(loc || S.loc) === 'HELPER'; }
  function setRole(loc, obj) { S.roles[loc] = Object.assign({}, S.roles[loc] || {}, obj, { at: Date.now() }); }
  function staffName(code) { var s = ((S.boot && S.boot.staff) || []).find(function (x) { return x.code === code; }); return s ? s.name : code || ''; }
  function memberLabel(m) { return (m.name || staffName(m.staff) || m.device) + ' (' + m.device + ')'; }
  function othersOf(loc) { var i = S.info[loc]; return i && i.others ? i.others : { items: [], qty: 0 }; }
  function hasOthers(loc) { var i = S.info[loc]; return !!(i && i.members && i.members.some(function (m) { return m.device !== S.cfg.deviceId; })); }
  /** ผู้ช่วยที่ยังไม่ส่งงาน หรือส่งงานแล้วแต่เซิร์ฟเวอร์ยังได้ข้อมูลไม่ครบ */
  function waitingHelpers(loc) {
    var i = S.info[loc];
    if (!i || !i.members) return [];
    return i.members.filter(function (m) { return m.role === 'HELPER' && m.device !== S.cfg.deviceId && !(m.state === 'SUBMITTED' && m.match === 'OK'); });
  }
  function waitText(m) {
    return memberLabel(m) + ' · ' + (m.state === 'SUBMITTED' ? 'ส่งงานแล้ว (รอข้อมูล)' : 'กำลังนับ ' + fmt(m.qty) + ' ชิ้น') + (m.lastTime ? ' · ยิงล่าสุด ' + String(m.lastTime).slice(11, 16) : '');
  }
  /** ยอดรวมทุกเครื่องต่อ SKU = ของเครื่องนี้ (ในเครื่อง รวมที่ยังไม่ส่ง) + ของเครื่องอื่น (จากเซิร์ฟเวอร์) */
  // ---------- ผู้ช่วยแก้ยอดของตัวเอง (v2.3.1) ----------
  // "ยอดของฉัน" = ชิ้นที่เครื่องนี้ยิงใน Location นับจากจุดตัดล่าสุด (v2.3.5):
  //   ล้าง Location (S.info[loc].clr) หรือ ผู้ดูแลแก้ยอดรวม SKU นั้น (edits[key].cp) — ยอดก่อนจุดตัดผู้ดูแลตรวจแล้ว
  //   รายการล้าง Location ไม่นับเป็นยอดของใคร (ตรงกับเซิร์ฟเวอร์)
  function clearSeq(loc) { var i = S.info[loc]; return (i && i.clr) || 0; }
  function cutSeq(loc, key) { var x = editInfo(loc, key); return Math.max(clearSeq(loc), (x && x.cp) || 0); }
  function isClearEntry(e) { return e.type === 'RECOUNT_SET' && /^ล้าง Location/.test(e.reason || ''); }
  function mineEntries(loc, key) {
    var c = cutSeq(loc, key);
    return S.entries.filter(function (e) { return e.location === loc && e.seq > c && !isClearEntry(e) && itemKey(e) === key; });
  }
  function mineSince(loc, key) {
    return Math.round(mineEntries(loc, key).reduce(function (a, e) { return a + e.qty; }, 0) * 1000) / 1000;
  }
  /** การแก้ SKU นี้บนเซิร์ฟเวอร์ { cp: จุดตัดยอดของเครื่องนี้, by: เครื่องที่แก้ล่าสุด, at } */
  function editInfo(loc, key) { var i = S.info[loc]; return (i && i.edits && i.edits[key]) || null; }
  /** เตือนเมื่อเครื่องอื่นเพิ่งแก้ SKU เดียวกัน (ไม่ห้าม — ให้คุยกันก่อน) */
  function otherEditHtml(loc, key) {
    var x = editInfo(loc, key);
    if (!x || !x.by || x.by === S.cfg.deviceId) return '';
    var m = ((S.info[loc] || {}).members || []).find(function (mm) { return mm.device === x.by; });
    return '<div class="warnline">⚠ ' + esc(m ? memberLabel(m) : x.by) + ' แก้ SKU นี้เมื่อ ' + esc(String(x.at).slice(11, 16)) + ' — คุยกันก่อนแก้</div>';
  }

  function combinedSummary(loc) {
    var mine = locSummary(loc), oth = othersOf(loc);
    // "ของฉัน" ต่อ SKU นับจากล้าง Location ครั้งล่าสุด (v2.3.6) ให้ตรงกับยอดเครื่องอื่นที่เซิร์ฟเวอร์ส่งมา (นับหลังล้างเหมือนกัน)
    // รายการล้างเป็นของเครื่องที่กดล้าง ถ้านับรวมจะเห็น "ของฉัน -5 / เครื่องอื่น 6" ทั้งที่รวมได้ 1 ถูกต้อง
    var cut = clearSeq(loc), sc = new Map(), r3 = function (v) { return Math.round(v * 1000) / 1000; };
    S.entries.forEach(function (e) { if (e.location === loc && isClearEntry(e) && e.seq > cut) cut = e.seq; });
    S.entries.forEach(function (e) { if (e.location === loc && e.seq > cut && !isClearEntry(e)) { var k = itemKey(e); sc.set(k, (sc.get(k) || 0) + e.qty); } });
    // ยอดรวม (qty) คิดแบบเดิม = ทุกรายการ (รายการล้างหักยอดเก่าไปแล้ว) เพื่อให้ตรงกับยอดเซิร์ฟเวอร์ตอนปิด
    var items = new Map(), qty = mine.qty, mineQty = 0;
    mine.items.forEach(function (it, k) { var m = r3(sc.get(k) || 0); items.set(k, Object.assign({}, it, { mine: m, others: 0 })); mineQty += m; });
    mineQty = r3(mineQty);
    oth.items.forEach(function (x) {
      var k = x[0], it = items.get(k);
      if (!it) { it = { key: k, material: x[1], barcode: x[2], qty: 0, mine: 0, others: 0, edits: 0, lines: 0 }; items.set(k, it); }
      it.others = x[4] === undefined ? x[3] : x[4]; it.qty = r3(it.qty + x[3]);
      if (!it.barcode && x[2]) it.barcode = x[2];
      qty += x[3];
    });
    var sku = 0;
    items.forEach(function (it) { if (it.qty !== 0) sku++; });
    return { qty: Math.round(qty * 1000) / 1000, sku: sku, items: items, mine: mine, mineQty: mineQty, othersQty: oth.qty, multi: hasOthers(loc) };
  }
  /** ถามเซิร์ฟเวอร์ว่าใครอยู่ใน Location นี้ (ล้มเหลว/ออฟไลน์ = null) */
  function fetchInfo(loc, ms) {
    S.infoErr = '';
    if (navigator.onLine === false || !S.cfg.token) { S.infoErr = 'NETWORK'; return Promise.resolve(null); }
    S.infoBusy = (S.infoBusy || 0) + 1;
    return api('locInfo', { location: loc }, ms || INFO_MS).then(function (r) {
      S.infoBusy--;
      S.info[loc] = r; S.infoAt[loc] = Date.now();
      if (r && !r.flag) delete S.flags[loc];   // เซิร์ฟเวอร์ว่าไม่มีธง (ล้างนับใหม่/หัวหน้าทีมปิดธง) → ไม่เตือนค้าง (v2.2.9)
      // เทียบกับบทบาทที่เซิร์ฟเวอร์ยืนยันครั้งก่อน (ไม่ใช่ที่เครื่องเดาไว้ตอนเพิ่งเปิด Location)
      S.srvRole = S.srvRole || {};
      var was = S.srvRole[loc];
      if (r.me) S.srvRole[loc] = r.me.role;
      if (r.me) setRole(loc, { role: r.me.role, state: S.loc === loc && r.me.state !== 'CLOSED' ? 'COUNTING' : r.me.state, owner: r.owner ? r.owner.device : '', ownerLabel: r.owner ? memberLabel(r.owner) : '' });
      // หัวหน้าทีมโอนการดูแลไปเครื่องอื่น (v2.3.4): บอกให้รู้ · ถ้า Location ปิดไปแล้ว ออกจาก Location ไม่ให้ยิงต่อเข้าไปเงียบ ๆ
      if (r.me && was === 'HELPER' && r.me.role === 'OWNER' && !S.checking) {
        SOUND.ok();
        result(true, 'คุณเป็นผู้ดูแล ' + loc + ' แล้ว', 'หัวหน้าทีมโอนการดูแลมาให้เครื่องนี้\nปิด Location ได้เมื่อทุกคนส่งงาน');
      }
      if (r.me && was === 'OWNER' && r.me.role === 'HELPER' && !S.checking) {
        var by = r.owner ? memberLabel(r.owner) : 'เครื่องอื่น';
        if (S.loc === loc && r.status === 'ปิดแล้ว') {
          S.loc = null; setRole(loc, { state: 'SUBMITTED' }); clearResume();
          setCard('bad', loc + ' ปิดแล้วโดย ' + by, 'หัวหน้าทีมโอนการดูแลไปแล้ว · ยิงป้าย Location ถัดไป');
          SOUND.bad();
          result(false, 'หัวหน้าทีมโอนการดูแล ' + loc + ' แล้ว', 'ผู้ดูแลใหม่: ' + by + ' · ' + loc + ' ปิดแล้ว\nรายการที่ยิงหลังปิดส่งไปแล้ว และติดธงให้ตรวจ\nยิงป้าย Location ถัดไป');
        } else {
          SOUND.warn();
          result(false, 'หัวหน้าทีมโอนการดูแล ' + loc + ' แล้ว', 'ผู้ดูแลใหม่: ' + by + '\nเครื่องนี้เป็นผู้ช่วย (ส่งงานแล้ว) · นับเพิ่มได้ แล้วกด "ส่งงาน"');
        }
      }
      // หัวหน้าทีมส่งงานแทนเครื่องนี้ (v2.3.8): บอกครั้งเดียวต่อ Location · ถ้ามีรายการเข้าไปหลังจากนั้น ให้กดส่งงานยืนยันยอดล่าสุด
      if (r.me && r.me.role === 'HELPER' && was !== 'OWNER') {
        var sf = r.me.subBy === 'ADMIN', seen = (S.roles[loc] || {}).sfSeen;
        if (sf && !seen && !S.checking) {
          setRole(loc, { sfSeen: 1 }); saveState();
          SOUND.warn();
          result(false, 'หัวหน้าทีมส่งงานแทนเครื่องนี้ที่ ' + loc,
            'ใช้ยอดที่เซิร์ฟเวอร์ได้รับตอนนั้น' + (r.me.stateAt ? ' (' + String(r.me.stateAt).slice(11, 16) + ')' : '') + '\n' +
            (r.me.state === 'COUNTING' ? 'มีรายการจากเครื่องนี้ส่งเข้าไปหลังจากนั้น · กด "ส่งงาน" เพื่อยืนยันยอดล่าสุด' :
              r.status === 'ปิดแล้ว' ? loc + ' ปิดแล้ว · ถ้ายิงเพิ่ม Location จะต้องตรวจซ้ำ' : 'ยิงเพิ่มได้ แล้วกด "ส่งงาน" อีกครั้ง'));
        } else if (!sf && seen) setRole(loc, { sfSeen: 0 });
      }
      if (S.view === 'count' || S.view === 'loc') render();
      return r;
    }, function (e) { S.infoBusy--; S.infoErr = (e && e.code) || 'ERROR'; if (S.view === 'loc') renderLoc(); return null; });
  }
  S.infoAt = {}; S.flags = {};
  // ถามสถานะเป็นรอบ: ไม่หยุดเมื่อเซิร์ฟเวอร์ช้า · ถามถี่ขึ้นตอนผู้ดูแลรอผู้ช่วย · ไม่ถามซ้อนขณะคำขอก่อนยังไม่กลับ
  setInterval(function () {
    if (!S.loc || S.checking || S.sending || S.infoBusy || navigator.onLine === false || !$('modal').classList.contains('hidden')) return;
    if (!(S.view === 'loc' || (S.view === 'count' && (hasOthers(S.loc) || isHelper())))) return;
    var every = !isHelper() && waitingHelpers(S.loc).length ? INFO_EVERY_WAIT : INFO_EVERY;
    if (Date.now() - (S.infoAt[S.loc] || 0) >= every) fetchInfo(S.loc);
  }, 2000);

  function deviceTotal() { return Math.round(S.entries.reduce(function (a, e) { return a + e.qty; }, 0) * 1000) / 1000; }
  function pending() { return S.entries.filter(function (e) { return !e.synced && !e.rejected; }); }
  /** Location นี้ยังมีรายการหรือเหตุการณ์ที่ยังไม่ได้ส่งหรือไม่ */
  function locPending(loc) {
    return pending().some(function (e) { return e.location === loc; }) || S.events.some(function (ev) { return ev.location === loc; });
  }
  function info(item) {
    var m = item.material ? S.masterList.find(function (r) { return r.m === item.material; }) : S.master.get(item.barcode);
    return m || { n: item.barcode ? 'บาร์โค้ดไม่รู้จัก ' + item.barcode : item.material, c: '', m: item.material, b: item.barcode };
  }
  /**
   * เน้นส่วนท้ายของ Cust-mat ที่ต่างจากรหัสพี่น้อง (ขึ้นต้นเหมือนกัน) ตัวใหญ่ เช่น UTAA0<b>450XK</b> กับ UTAA0<b>550XK</b>
   * ลดการยิงสลับสี/ไซส์ — เน้นอย่างน้อย 4 ตัวท้ายเสมอ
   */
  var tailCache = new Map();
  function diffStart(c) {
    if (tailCache.has(c)) return tailCache.get(c);
    // พี่น้อง = รหัสที่ขึ้นต้นเหมือนกันทั้งหมดยกเว้น 6 ตัวท้าย; เน้นตั้งแต่ตำแหน่งแรกที่ต่างจากพี่น้องตัวใดตัวหนึ่ง
    var hl = Math.max(4, c.length - 6), head = c.slice(0, hl), first = c.length;
    for (var k = 0; k < S.masterList.length; k++) {
      var o = S.masterList[k].c;
      if (!o || o === c || o.slice(0, hl) !== head) continue;
      var i = hl; while (i < c.length && c[i] === o[i]) i++;
      if (i < first) first = i;
    }
    var start = Math.max(0, Math.min(first, c.length - 4));
    tailCache.set(c, start);
    return start;
  }
  /** บรรทัดที่ 2 ของการ์ด: Cust-mat / บาร์โค้ด เช่น UTAA0<b>590XT</b> / 8858153343503 */
  function codeLine(c, bc) {
    return (c ? tailHtml(c) : '') + (bc ? '<span class="bc">' + (c ? ' / ' : '') + esc(bc) + '</span>' : '');
  }
  function tailHtml(c) {
    if (!c) return '';
    var i = diffStart(c);
    return esc(c.slice(0, i)) + '<b class="tail">' + esc(c.slice(i)) + '</b>';
  }

  // ---------- บันทึกรายการ ----------
  function addEntry(f) {
    return DB.addEntry(function (seq) {
      return {
        logId: S.cfg.deviceId + '-' + pad6(seq), seq: seq, projectId: S.projectId, deviceId: S.cfg.deviceId,
        staff: S.staff ? S.staff.code : '', location: f.location || S.loc || '', barcode: f.barcode || '', material: f.material || '',
        qty: Number(f.qty), type: f.type, refId: f.refId || '', reason: f.reason || '', note: f.note || '', basis: f.basis,
        scanTime: stamp(), createdAt: Date.now(), synced: 0
      };
    }).then(function (e) {
      S.entries.push(e);
      // มีรายการใหม่ใน Location → ผล "ส่งครบ" ครั้งก่อนไม่เป็นจริงแล้ว
      if (e.location && S.locChecks[e.location]) { delete S.locChecks[e.location]; saveState(); }
      scheduleSync(600);
      return e;
    });
  }

  /** เหตุการณ์ Location: OPEN JOIN SUBMIT PAUSE CLOSE EDIT — แนบยอดของเครื่องนี้ใน Location ให้เซิร์ฟเวอร์ตรวจว่าได้รับครบ */
  var lastAt = 0;
  function addEvent(type, loc, extra) {
    var sum = locSummary(loc);
    var seqs = S.entries.map(function (e) { return e.seq; });
    var at = lastAt = Math.max(Date.now(), lastAt + 1);
    var ev = Object.assign({
      id: S.cfg.deviceId + '-E' + at, type: type, projectId: S.projectId, location: loc, at: at,
      staff: S.staff ? S.staff.code : '', time: stamp(), lines: sum.lines, qty: sum.qty,
      fromSeq: seqs.length ? Math.min.apply(null, seqs) : 0, upToSeq: seqs.length ? Math.max.apply(null, seqs) : 0, nextTry: 0
    }, extra || {});
    S.events.push(ev);
    return DB.putMany('events', [ev]).then(function () { scheduleSync(600); });
  }

  // ---------- Sync ----------
  var syncTimer = null;
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms || 0); }

  /**
   * รอเซิร์ฟเวอร์ยืนยันเหตุการณ์ (ส่งงาน/ปิด/ล้าง) พร้อมกล่องหมุนกลางจอ (v2.2.9)
   * กล่องขึ้นหลัง 0.3 วิ (ตอบเร็วไม่กระพริบ) · ขึ้นแล้วค้างอย่างน้อย 0.6 วิ ให้อ่านทัน · ไม่เกิน CONFIRM_MS
   * ออฟไลน์ไม่หมุน — ข้อมูลอยู่ในเครื่องแล้ว จะส่งให้อัตโนมัติ
   * ผล: 'ok' ยืนยันแล้ว · 'wait' เซิร์ฟเวอร์ให้รอ (เช่น ข้อมูลยังมาไม่ครบ) · 'late' ช้า/ส่งไม่ได้ · 'offline'
   */
  var CONFIRM_MS = 12000;
  function confirmSent(loc, title, sub) {
    var ids = S.events.filter(function (ev) { return ev.location === loc; }).map(function (ev) { return ev.id; });
    if (!ids.length) return Promise.resolve('ok');
    if (navigator.onLine === false || S.online === false || !S.cfg.token) return Promise.resolve('offline');
    var t0 = Date.now(), shownAt = 0;
    S.sending = loc;
    var timer = setTimeout(function () { shownAt = Date.now(); busy(title, sub); }, 300);
    var left = function () { return S.events.filter(function (ev) { return ids.indexOf(ev.id) >= 0; }); };
    var pause = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function step(tries) {
      var l = left();
      if (!l.length) return 'ok';
      if (l.some(function (ev) { return ev.nextTry > Date.now(); })) return 'wait';
      if (Date.now() - t0 > CONFIRM_MS || tries > 6 || S.revoked) return 'late';
      if (S.syncing) return pause(400).then(function () { return step(tries); });
      clearTimeout(syncTimer);
      return syncNow(true).then(function () {
        if (S.lastErr && left().length) return S.lastErr === 'NETWORK' ? 'offline' : 'late';
        return step(tries + 1);
      });
    }
    return Promise.resolve(step(0)).then(function (res) {
      clearTimeout(timer);
      var hold = shownAt ? Math.max(0, 600 - (Date.now() - shownAt)) : 0;
      return pause(hold).then(function () { S.sending = ''; if (shownAt) busyOff(); return res; });
    });
  }
  /** ข้อความบรรทัดล่างของการ์ดตามผลการรอยืนยัน */
  function sentNote(res) {
    return res === 'ok' ? 'เซิร์ฟเวอร์รับแล้ว ✓' : res === 'wait' ? 'เซิร์ฟเวอร์รอข้อมูลจากเครื่องอื่น จะส่งซ้ำให้อัตโนมัติ'
      : res === 'offline' ? 'ออฟไลน์ — ข้อมูลอยู่ในเครื่องแล้ว จะส่งให้อัตโนมัติ' : 'เซิร์ฟเวอร์ตอบช้า — ข้อมูลอยู่ในเครื่องแล้ว จะส่งซ้ำให้อัตโนมัติ';
  }

  function syncNow(force) {
    if (S.syncing || !S.cfg.token || !S.cfg.apiUrl) return Promise.resolve();
    var now = Date.now();
    var unsynced = pending().concat(S.oldPending).sort(function (a, b) { return a.seq - b.seq; });
    var batch = unsynced.slice(0, BATCH);
    var rest = unsynced.slice(BATCH);
    var minRest = rest.length ? rest[0].seq : Infinity;
    // ส่งเหตุการณ์ตามลำดับที่เกิด หยุดที่ตัวแรกที่ยังรอ (WAIT) เพื่อไม่ให้ "ส่งงาน" เก่าไปทับ "เข้าร่วม" ใหม่
    var evs = [];
    S.events.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    for (var q = 0; q < S.events.length; q++) {
      var x = S.events[q];
      if (x.nextTry > now || x.upToSeq >= minRest) break;
      evs.push(x);
    }
    if (!batch.length && !evs.length && !force) return Promise.resolve();
    S.syncing = true; renderTop();
    var payload = {
      entries: batch.map(function (e) {
        return { logId: e.logId, seq: e.seq, projectId: e.projectId, staff: e.staff, location: e.location, barcode: e.barcode, material: e.material,
          qty: e.qty, type: e.type, refId: e.refId, reason: e.reason, note: e.note, scanTime: e.scanTime, basis: e.basis };
      }),
      events: evs.map(function (ev) {
        return { id: ev.id, type: ev.type, projectId: ev.projectId, location: ev.location, staff: ev.staff, time: ev.time, lines: ev.lines, qty: ev.qty,
          fromSeq: ev.fromSeq, upToSeq: ev.upToSeq, total: ev.total, auto: ev.auto, clear: ev.clear, mine: ev.mine, clearMine: ev.clearMine, at: ev.at };
      }),
      pendingAfter: rest.length, location: S.loc || ''
    };
    return api('sync', payload, 30000).then(function (res) {
      // แยกเวลางานในเซิร์ฟเวอร์ของการส่งครั้งล่าสุด (ขั้น C v2.3.0) — ดูที่หน้าสถานะ
      if (res.prof) S.lastProf = { p: res.prof, srv: res.ms, wait: res.lockWait, hold: res.lockHold, n: batch.length, ev: evs.length };
      var done = {};
      res.accepted.concat(res.duplicate).forEach(function (id) { done[id] = 'ok'; });
      res.quarantined.forEach(function (id) { done[id] = 'q'; });
      var rej = {};
      res.rejected.forEach(function (r) { rej[r.logId] = r.reason; });
      var changed = [];
      batch.forEach(function (e) {
        if (done[e.logId]) { e.synced = 1; e.syncedAt = Date.now(); if (done[e.logId] === 'q') e.quarantined = 1; changed.push(e); }
        else if (rej[e.logId]) { e.rejected = rej[e.logId]; changed.push(e); }
      });
      S.oldPending = S.oldPending.filter(function (e) { return !e.synced && !e.rejected; });
      var removeIds = [];
      (res.events || []).forEach(function (r) {
        var ev = S.events.find(function (x) { return x.id === r.id; });
        if (!ev) return;
        if (r.match === 'WAIT') { ev.nextTry = Date.now() + 30000; changed.length; }
        else {
          removeIds.push(ev.id);
          if (r.match !== 'OPEN' && r.match !== 'SKIP') S.locChecks[ev.location] = r.match;
        }
      });
      S.events = S.events.filter(function (ev) { return removeIds.indexOf(ev.id) < 0; });
      // บทบาทที่เซิร์ฟเวอร์ตัดสิน (เช่น เปิดตอนออฟไลน์ แต่มีผู้ดูแลอยู่แล้ว → เป็นผู้ช่วย)
      (res.events || []).forEach(function (r) {
        if (!r.role || r.match === 'WAIT') return;
        var before = roleOf(r.location);
        var later = S.events.some(function (ev) { return ev.location === r.location; });
        var upd = { role: r.role, owner: r.owner };
        if (!later) upd.state = r.location === S.loc && r.state !== 'CLOSED' && r.state !== 'SUBMITTED' ? 'COUNTING' : r.state;
        setRole(r.location, upd);
        if (before !== r.role && r.location === S.loc) {
          var msg = r.role === 'HELPER' ? r.location + ' มีผู้ดูแลแล้ว (' + r.owner + ') — เครื่องนี้เป็นผู้ช่วย' : 'เครื่องนี้เป็นผู้ดูแล ' + r.location;
          // แจ้งกลางจอให้กดรับทราบ (เดิมเป็นข้อความสั้นด้านล่าง อ่านไม่ทัน) — ถ้ามีกล่องอื่นเปิดอยู่ใช้ข้อความสั้นแทน
          if (r.role === 'HELPER' && $('modal').classList.contains('hidden')) {
            SOUND.warn();
            modal({ title: 'เครื่องนี้เป็นผู้ช่วยที่ ' + r.location, html: esc(r.location) + ' มีผู้ดูแลอยู่แล้ว (' + esc(r.owner) + ')<br>ยอดที่ยิงไว้ยังอยู่ นับต่อได้ เสร็จแล้วกด "ส่งงาน"<br><span class="muted">ถ้ายิงป้ายผิด ให้ยิงป้าย Location ที่ถูก ระบบจะส่งงานให้ แล้วแจ้งผู้ดูแลแก้ยอด</span>',
              yes: 'รับทราบ', noCancel: true });
          } else toast(msg, r.role === 'HELPER');
          fetchInfo(r.location);
        }
      });
      // การแก้ยอดของเครื่องนี้ชนกับเครื่องอื่น → แจ้งกลางจอทันที (v2.2.8)
      if (res.flags && res.flags.length) {
        res.flags.forEach(function (f) { S.flags[f.location] = 'ต้องตรวจซ้ำ: ' + f.note; });
        SOUND.bad();
        modal({ title: 'ต้องตรวจซ้ำ ' + res.flags.map(function (f) { return f.location; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', '),
          html: res.flags.map(function (f) { return '<b>' + esc(f.location) + '</b> ' + esc(f.note); }).join('<br>') +
            '<br><span class="muted">มีเครื่องอื่นยิง/แก้สินค้านี้ระหว่างที่คุณแก้ยอด ยอดที่ได้อาจไม่ใช่ที่ตั้งใจ — นับ SKU นี้ใหม่ หรือ ล้าง Location แล้วนับใหม่</span>',
          yes: 'รับทราบ', noCancel: true });
      }
      if (res.masterHash !== undefined && S.masterHash && res.masterHash && res.masterHash !== S.masterHash) S.masterChanged = true;
      if (res.stockVersion && res.stockVersion !== S.stockVersion) downloadStock().catch(function () {});
      S.lastSyncOk = Date.now();
      return Promise.all([DB.putMany('entries', changed), DB.remove('events', removeIds), saveState()]).then(function () {
        S.syncing = false; render();
        if (unsynced.length > batch.length) scheduleSync(300);
      });
    }, function (err) {
      S.syncing = false;
      S.lastErr = err && err.code ? err.code : 'ERROR';
      if (err && (err.code === 'BAD_TOKEN' || err.code === 'DEVICE_DISABLED' || err.code === 'UNKNOWN_DEVICE')) S.lastErr = err.code;
      render();
    });
  }

  setInterval(function () {
    if (pending().length || S.oldPending.length || S.events.some(function (e) { return e.nextTry <= Date.now(); })) syncNow();
  }, SYNC_EVERY);
  // รายงานตัวทุก 1 นาที: หน้า Admin เห็นว่าเครื่องยังติดต่อได้และค้างกี่รายการ · ถ้าเครื่องถูกยกเลิก จะรู้ภายใน 1 นาที
  var lastHello = 0;
  function hello() {
    if (!S.cfg.apiUrl || !S.cfg.token || S.syncing) return;
    // อยู่ใน Location: ทุก 30 วิ (ให้ผู้ดูแลรู้เร็วว่ามีผู้ช่วยเข้ามา) · ไม่อยู่: ทุก 60 วิ
    if (Date.now() - lastHello < (S.loc ? 30000 : 60000) - 1000) return;
    lastHello = Date.now();
    var loc = S.loc;
    api('hello', { pending: pending().length + S.oldPending.length, location: loc || '', perf: perfReport() }, 10000).then(function (r) {
      // เซิร์ฟเวอร์บอกว่า Location นี้มีหลายเครื่อง แต่เครื่องยังไม่รู้ → ถามรายละเอียด (U7/U8)
      if (loc && loc === S.loc && r.members > 1 && !hasOthers(loc) && !S.infoBusy) fetchInfo(loc);
    }, function (err) {
      if (err && (err.code === 'BAD_TOKEN' || err.code === 'DEVICE_DISABLED' || err.code === 'UNKNOWN_DEVICE')) { S.lastErr = err.code; render(); }
    });
  }
  setInterval(hello, 10000);
  window.addEventListener('online', function () { scheduleSync(200); });
  window.addEventListener('offline', function () { setOnline(false); });

  // ---------- หน้าจอ ----------
  function show(v) {
    if (S.revoked && v !== 'setup' && v !== 'revoked') v = 'revoked';
    S.view = v;
    document.querySelectorAll('.view').forEach(function (el) { el.classList.toggle('on', el.id === 'v-' + v); });
    window.scrollTo(0, 0);
    if (v === 'count') { requestWake(); renderCount(); }
    if (v === 'loc') { renderLoc(); fetchInfo(S.loc); }
    if (v === 'status') renderStatus();
    if (v === 'revoked') renderRevoked();
    renderBanner();
    if (v === 'locs') { S.locsFilter = null; renderLocs(); loadMyLocs(); }   // เข้าหน้านี้ทุกครั้งเริ่มที่ "ต้องทำต่อ" (ถ้ามี)
    if (v === 'manual') { $('manQ').value = ''; renderManual(); setTimeout(function () { $('manQ').focus(); }, 50); }
    renderTop();
  }

  function renderTop() {
    $('tbLoc').textContent = S.loc || '—';
    var helper = S.loc && isHelper();
    var rr = S.loc && S.roles[S.loc];
    // ป้ายบทบาทแสดงทุกครั้งที่อยู่ใน Location (U10) — ระหว่างตรวจยังไม่แสดง
    $('tbRole').textContent = !S.loc || S.checking === S.loc ? '' : helper ? 'ผู้ช่วย' : 'ผู้ดูแล';
    $('tbRole').className = helper ? 'helper' : 'owner';
    $('tbStaff').textContent = S.staff ? (S.staff.name || S.staff.code) : 'ยังไม่เข้างาน';
    var p = pending().length;
    // นับเป็น "รายการ" (บรรทัดที่บันทึก รวมลบ/แก้) ไม่ใช่ชิ้น — จำนวนที่ส่งแล้วดูได้ที่หน้าสถานะ
    $('syncText').textContent = 'รายการ ' + fmt(S.entries.length) + ' · ค้าง ' + fmt(p);
    $('netDot').className = 'dot ' + (S.syncing ? 'busy' : S.online === false ? 'off' : S.slow ? 'slow' : S.online === true ? 'on' : '');
    renderBanner();
  }

  function renderBanner() {
    var b = $('banner'), msg = '', bad = false;
    var p = pending();
    var oldest = p.length ? Math.min.apply(null, p.map(function (e) { return e.createdAt; })) : 0;
    var rejected = S.entries.filter(function (e) { return e.rejected; }).length;
    if (S.view === 'revoked') msg = '';   // หน้าหยุดยิงอธิบายเองแล้ว
    else if (S.lastErr === 'BAD_TOKEN' || S.lastErr === 'DEVICE_DISABLED' || S.lastErr === 'UNKNOWN_DEVICE') { msg = 'เครื่องนี้ถูกยกเลิกหรือต้องจับคู่ใหม่ ข้อมูลในเครื่องไม่หาย ให้ Export ไฟล์ แล้วแจ้งหัวหน้าทีม'; bad = true; }
    else if (oldest && Date.now() - oldest > STALE_MIN * 60000) { msg = 'มีรายการค้างส่งเกิน ' + STALE_MIN + ' นาที — ไปจุดที่มี Wi-Fi หรือ Export ไฟล์'; bad = true; }
    else if (rejected) { msg = 'มี ' + rejected + ' รายการที่เซิร์ฟเวอร์ไม่รับ ดูที่หน้าสถานะ'; bad = true; }
    else if (S.masterChanged) msg = 'หัวหน้าทีมอนุมัติรายการบาร์โค้ดชุดใหม่ ไปที่สถานะ → ตรวจความพร้อมใหม่ เพื่อโหลด';
    else if (S.recountBanner && S.view === 'count') msg = S.recountBanner;
    else if (S.slow && S.online !== false) msg = S.slow === 'BAD_REPLY' || S.slow === 'SERVER_ERROR' ? 'เซิร์ฟเวอร์มีปัญหา (ไม่ใช่ Wi-Fi) — นับต่อได้ ข้อมูลไม่หาย ถ้าเป็นนานให้แจ้งหัวหน้าทีม' :
      'เซิร์ฟเวอร์ตอบช้า — นับต่อได้ ข้อมูลไม่หาย ระบบจะส่งเอง';
    b.textContent = msg; b.className = msg ? (bad ? 'bad' : '') : 'hidden';
  }

  function render() {
    renderTop();
    if (S.view === 'count') renderCount();
    if (S.view === 'loc') renderLoc();
    if (S.view === 'status') renderStatus();
    if (S.view === 'locs') renderLocs();
  }

  function renderCount() {
    var sum = S.loc ? combinedSummary(S.loc) : { qty: 0, sku: 0, multi: false };
    $('locTotal').textContent = fmt(sum.qty);
    fitText($('locTotal'), 40, 20);
    // หลายเครื่อง: ยอดรวม = ทุกเครื่อง และบอกยอดของเครื่องนี้แยก
    $('locSku').textContent = sum.multi ? 'ของฉัน ' + fmt(sum.mineQty) + ' · ' + (S.info[S.loc].members.length) + ' เครื่อง' :
      fmt(sum.sku) + ' SKU' + (S.loc && S.locChecks[S.loc] === 'OK' && !locPending(S.loc) ? ' · ✓ ส่งครบ' : '');
    $('locLbl').textContent = sum.multi ? 'ยอดรวมทุกเครื่อง' : 'ยอดรวม Location';
    $('devTotal').textContent = fmt(deviceTotal());
    fitText($('devTotal'), 22, 13);
    var helper = S.loc && isHelper();
    $('btnClose').innerHTML = helper ? 'ส่ง<br>งาน' : 'ปิด<br>Location';
    $('btnClose').classList.toggle('ok', !!helper);
    $('btnLoc').innerHTML = helper ? 'ดู<br>Location' : 'ดู/แก้<br>Location';
    renderSku();
    var q = S.qty || '1';
    $('qtyVal').textContent = q; $('qtyVal').className = q !== '1' ? 'multi' : '';
    if (!S.loc && $('card').className.indexOf('idle') >= 0) {
      $('cardTitle').textContent = S.staff ? 'ยิงป้าย Location เพื่อเริ่ม' : 'ยิงบัตรผู้ตรวจสอบ (EMP:) ก่อน';
      $('cardSub').textContent = ''; $('cardQty').textContent = '';
    }
  }

  /**
   * ช่อง SKU (ในกล่อง "ทั้งเครื่อง"): แสดงเฉพาะสินค้าของการยิงครั้งล่าสุด
   * นับ = ยอดสุทธิของเครื่องนี้ทุก Location (สีเขียว) · Stock = ยอดบัญชีทั้งร้าน (สีน้ำเงิน)
   * ยิงผิด / ไม่รู้จัก / เปิด Location ใหม่ → เคลียร์
   */
  function skuCount(material) {
    var n = 0;
    for (var i = 0; i < S.entries.length; i++) if (S.entries[i].material === material) n += S.entries[i].qty;
    return Math.round(n * 1000) / 1000;
  }
  function setSku(item) { S.lastSku = item && item.m ? { m: item.m, c: item.c || '' } : null; renderSku(); }
  function renderSku() {
    var box = $('skuBox'), k = S.lastSku;
    $('skuSrc').textContent = S.stockSource === 'POS' ? 'POS' : '';
    $('skuSrc').classList.toggle('hidden', S.stockSource !== 'POS');
    if (!k) { box.className = 'sku empty'; $('skuTail').textContent = '—'; $('skuCnt').textContent = '—'; $('skuStk').textContent = '—'; $('skuMark').textContent = ''; return; }
    var cnt = skuCount(k.m), has = S.stock.has(k.m), stk = has ? S.stock.get(k.m) : null;
    box.className = 'sku';
    $('skuTail').textContent = k.c ? k.c.slice(diffStart(k.c)) : k.m;
    $('skuCnt').textContent = fmt(cnt);
    $('skuStk').textContent = has ? fmt(stk) : '—';
    $('skuMark').textContent = has ? (cnt === stk ? '✓' : cnt > stk ? '▲' : '') : '';
    $('skuMark').className = has && cnt > stk ? 'over' : '';
    fitText($('skuCnt'), 20, 12); fitText($('skuStk'), 20, 12);
  }
  /** ย่อตัวเลขจนพอดีช่อง (ตัวเลขหลักพัน/หมื่น) ไม่ตัดหรือล้นกรอบ */
  function fitText(el, max, min) {
    el.style.fontSize = max + 'px';
    var size = max;
    while (size > min && el.scrollWidth > el.clientWidth + 0.5) { size--; el.style.fontSize = size + 'px'; }
  }

  /** จำนวนที่ป้อนเองเกิน 150 → ยืนยันอีกครั้ง (กันกดเกิน เช่น 1200 แทน 12) */
  function qtyCheck(qty, name) {
    if (qty <= QTY_CONFIRM) return Promise.resolve(true);
    return confirmBox('ยืนยันจำนวน', 'บันทึก <span class="bignum">' + fmt(qty) + '</span> ชิ้น<br>' + esc(name || '') + '<br><span class="muted">เกิน ' + QTY_CONFIRM + ' ชิ้นต่อครั้ง ตรวจว่าไม่ได้กดเกิน</span>', 'ถูกต้อง บันทึก');
  }
  /** ช่องตัวเลขในกล่อง: ยาวผิดปกติ = น่าจะยิงบาร์โค้ดเข้าช่องจำนวน */
  function badNumber(v) {
    v = String(v === null || v === undefined ? '' : v).trim();
    if (v.replace(/\D/g, '').length > QTY_MAX_DIGITS) { SOUND.bad(); toast('ตัวเลขยาวผิดปกติ — อาจยิงบาร์โค้ดเข้าช่องจำนวน ไม่บันทึก', true); return true; }
    return false;
  }

  function setCard(kind, title, subHtml, qtyHtml) {
    $('card').className = 'card ' + kind;
    $('cardTitle').textContent = title;
    $('cardSub').innerHTML = subHtml || '';
    $('cardQty').innerHTML = qtyHtml || '';
  }

  // ---------- การยิง ----------
  var buf = '', bufAt = 0;
  document.addEventListener('keydown', function (e) {
    // ข้ามเฉพาะตอนพิมพ์ในช่องข้อความ; ช่องติ๊ก/ปุ่มที่ค้างโฟกัสอยู่ต้องไม่กินการยิง
    var t = e.target || {}, tag = t.tagName || '';
    var typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(checkbox|radio|button|submit)$/i.test(t.type || ''));
    if (typing || !$('modal').classList.contains('hidden')) return;
    if (tag === 'INPUT' || tag === 'BUTTON') { if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); }
    if (e.key === 'Enter') {
      var code = buf; buf = ''; e.preventDefault();
      // กล่องผลลัพธ์: ✓ / ยิงใหม่ได้ → ปิดแล้วรับการยิงนี้ · ✕ ต้องกดตกลงก่อน
      if (S.result) {
        if (S.result === 'bad') { if (code) { SOUND.warn(); } else resultClose(); return; }
        resultClose(code ? 'scan' : '');
      }
      if (code) handleScan(code);
      return;
    }
    if (e.key && e.key.length === 1) {
      if (Date.now() - bufAt > 800) buf = '';
      buf += e.key; bufAt = Date.now();
    }
  });

  function handleScan(raw) {
    var code = String(raw).trim(), up = code.toUpperCase();
    if (!code) return;
    if (S.view === 'setup') { if (/^DEV:/.test(up)) $('setDevice').value = up.slice(4); return; }
    if (S.revoked) { SOUND.bad(); toast('เครื่องนี้ถูกยกเลิก ยิงไม่ได้ — กด "จับคู่ใหม่ (เก็บข้อมูลเดิม)"', true); return; }
    if (/^EMP:/.test(up)) return setStaff(up.slice(4));
    if (/^DEV:/.test(up)) { toast('นี่คือสติกเกอร์เครื่อง ' + up.slice(4)); return; }
    if (S.view === 'ready' || !isReady()) {
      SOUND.bad();
      toast(isReady() ? 'กด "เริ่มนับ" ก่อน' : 'ตรวจความพร้อมยังไม่ผ่าน — แก้ข้อ ✗ ก่อน' + (S.dwOk ? '' : ' (ยิงบัตรผู้ตรวจสอบ EMP:)'), true);
      if (S.view !== 'ready') show('ready');
      return;
    }
    if (S.view === 'status') return;
    if (S.checking) { SOUND.warn(); toast('รอสักครู่ — กำลังตรวจ ' + S.checking + ' (ยังไม่บันทึก)', true); return; }
    if (S.sending) { SOUND.warn(); toast('รอสักครู่ — กำลังส่ง ' + S.sending + ' (ยังไม่บันทึก)', true); return; }
    if (/^LOC:/.test(up)) { var loc = normLoc(up); if (!loc) { SOUND.bad(); toast('ป้าย Location ไม่ถูกต้อง', true); return; } return openLocation(loc); }
    if (S.view !== 'count') show('count');
    scanProduct(code);
  }

  function setStaff(code) {
    var list = (S.boot && S.boot.staff) || [];
    var s = list.find(function (x) { return x.code === code; });
    if (!s) { SOUND.bad(); result(false, 'ไม่พบรหัสผู้ตรวจสอบ', code + '\nยิงบัตรใหม่ หรือแจ้งหัวหน้าทีม', { scanCloses: true }); return; }
    S.staff = { code: s.code, name: s.name };
    S.dwOk = true;
    SOUND.ok();
    result(true, 'ยืนยันตัวตนแล้ว', (s.name || s.code) + (s.name ? ' (' + s.code + ')' : ''));
    saveState();
    if (S.view === 'ready') runChecks(true);
    render();
  }

  function scanProduct(code) {
    clearResume();
    if (!S.staff) { SOUND.bad(); setSku(null); setCard('bad', 'ยิงบัตรผู้ตรวจสอบ (EMP:) ก่อน'); return; }
    if (!S.loc) { SOUND.bad(); setSku(null); setCard('bad', 'ยิงป้าย Location ก่อน', 'รายการนี้ไม่ถูกบันทึก'); return; }
    var bc = code.replace(/\s+/g, '');
    var item = S.master.get(bc);
    if (!item && !validFormat(bc)) { SOUND.bad(); setSku(null); setCard('bad', 'รูปแบบบาร์โค้ดผิด — ยิงใหม่', esc(bc), 'ไม่บันทึก'); return; }
    var qty = parseInt(S.qty || '1', 10) || 1;
    var go = qtyCheck(qty, item ? item.n : bc);
    go.then(function (yes) {
      if (!yes) return;
      return addEntry({ barcode: bc, material: item ? item.m : '', qty: qty, type: 'SCAN' }).then(function () {
        S.qty = '';
        var inLoc = combinedSummary(S.loc).items.get(item ? item.m : 'BC:' + bc);
        if (item) { SOUND.ok(); setSku(item); setCard('ok', item.n || item.m, codeLine(item.c, bc), '+' + fmt(qty) + ' · ใน ' + S.loc + ' รวม ' + fmt(inLoc ? inLoc.qty : qty)); }
        else { SOUND.warn(); setSku(null); setCard('warn', 'บาร์โค้ดไม่รู้จัก — แยกสินค้าไว้', esc(bc), '+' + fmt(qty) + ' บันทึกแล้ว · ตรวจซ้ำตอนอัปโหลดไฟล์ใหม่'); }
        render();
      });
    });
  }

  /**
   * ยิงป้าย Location
   * 1) ออกจาก Location เดิม: ผู้ดูแล = พัก, ผู้ช่วย = ส่งงานอัตโนมัติ (ไม่มีทางรอกันจนติด)
   * 2) เปิดทันที ยิงสินค้าต่อได้ ไม่ต้องรอเซิร์ฟเวอร์
   * 3) เช็กเบื้องหลัง: ถ้ามีเครื่องอื่นเป็นผู้ดูแล → ถามเข้าร่วม · ถ้าผู้ดูแลปิดแล้ว → ไม่รับการยิง
   */
  function openLocation(loc) {
    if (!isReady()) { SOUND.bad(); toast('ตรวจความพร้อมยังไม่ผ่าน — แก้ข้อ ✗ ก่อน', true); show('ready'); return Promise.resolve(); }
    if (!S.staff) { SOUND.bad(); setCard('bad', 'ยิงบัตรผู้ตรวจสอบ (EMP:) ก่อน'); show('count'); return Promise.resolve(); }
    if (S.loc === loc) { show('count'); toast('อยู่ที่ ' + loc + ' แล้ว'); return Promise.resolve(); }
    // ถามเซิร์ฟเวอร์ก่อน แล้วตัดสินคำถามจากบทบาทล่าสุด (v2.3.5 — UAT G4-13/15: บทบาทที่จำไว้เก่าหลังหัวหน้าทีมโอนการดูแล)
    // ออฟไลน์ → ใช้บทบาทที่จำไว้ · คำตอบนี้ใช้ต่อในขั้นตรวจผู้ดูแล ไม่ถามซ้ำ
    var online = navigator.onLine !== false && S.cfg.token;
    var was = (S.srvRole && S.srvRole[loc]) || (S.roles[loc] || {}).role;   // บทบาทล่าสุดที่รู้ ก่อนถามเซิร์ฟเวอร์
    S.checking = loc;
    if (online) {
      setCard('idle', 'กำลังตรวจ ' + loc + '…', 'ถามเซิร์ฟเวอร์ว่าใครเป็นผู้ดูแล · รอสักครู่'); show('count');
      busy('กำลังตรวจ ' + loc + '…', 'ถามเซิร์ฟเวอร์ว่าใครเป็นผู้ดูแล');
    }
    return (online ? fetchInfo(loc) : Promise.resolve(null)).then(function (pre) {
      busyOff(); S.checking = '';
      return openLocation2(loc, pre, was, online);
    });
  }
  function openLocation2(loc, pre, was, tried) {
    var r = S.roles[loc] || null;
    var ask = Promise.resolve(true);
    var by = pre && pre.owner ? memberLabel(pre.owner) : '';
    if (pre && pre.me && pre.me.role === 'OWNER' && was === 'HELPER') {
      SOUND.ok();
      ask = result(true, 'คุณเป็นผู้ดูแล ' + loc + ' แล้ว', 'หัวหน้าทีมโอนการดูแลมาให้เครื่องนี้').then(function () { return true; });
    } else if (pre && pre.me && pre.me.role === 'HELPER' && was === 'OWNER') {
      // ถูกโอนการดูแลออกขณะอยู่ที่อื่น: แจ้งก่อน · ปิดแล้ว → จบตรงนี้ · ยังไม่ปิด → ถามกลับไปช่วยตามปกติ
      SOUND.warn();
      var closed = pre.status === 'ปิดแล้ว';
      return result(false, 'หัวหน้าทีมโอนการดูแล ' + loc + ' แล้ว', 'ผู้ดูแลใหม่: ' + by + (closed ? '\n' + loc + ' ปิดแล้ว · ยิงป้าย Location ถัดไป' : '\nเครื่องนี้เป็นผู้ช่วย')).then(function () {
        if (closed) { show('count'); return; }
        return openLocation2(loc, pre, 'HELPER');
      });
    } else if (pre && pre.status === 'ปิดแล้ว' && pre.me && pre.me.role === 'HELPER') {
      // ผู้ดูแลปิดแล้ว (หรือถูกโอนออก แล้วผู้ดูแลใหม่ปิด) → ผู้ช่วยกลับไปยิงเพิ่มไม่ได้
      SOUND.bad();
      return result(false, loc + ' ปิดแล้ว', 'ผู้ดูแล ' + by + ' ปิดไปแล้ว\nถ้าต้องนับเพิ่ม ให้ผู้ดูแลเปิดก่อน').then(function () { show('count'); });
    } else
    if (r && r.role === 'OWNER' && r.state === 'CLOSED') {
      var s0 = combinedSummary(loc);
      ask = confirmBox(loc + ' ปิดไปแล้ว', 'ยอดตอนปิด ' + fmt(s0.qty) + ' ชิ้น ' + s0.sku + ' SKU<br>ต้องการเปิดเพื่อนับเพิ่มหรือแก้ไข?', 'เปิดนับเพิ่ม');
    } else if (r && r.role === 'HELPER' && r.state === 'SUBMITTED') {
      S.rejoinAsked = loc;
      ask = confirmBox('กลับไปช่วย ' + loc + ' อีกครั้ง?', 'ส่งงานไปแล้ว <b>' + fmt(locSummary(loc).qty) + '</b> ชิ้น ยอดเดิมยังอยู่ ยิงเพิ่มต่อจากเดิม' +
        (r.owner ? '<br><span class="muted">ผู้ดูแล ' + esc(r.ownerLabel || r.owner) + '</span>' : ''), 'กลับไปช่วย');
    }
    return ask.then(function (ok) {
      if (!ok) { show('count'); return; }
      var prev = S.loc;
      return (prev ? leaveLocation(prev) : Promise.resolve()).then(function () {
        S.loc = loc; S.recountBanner = ''; S.lastSku = null; S.totalMode = null; clearResume();
        var known = S.roles[loc];
        setRole(loc, { role: known ? known.role : 'OWNER', state: 'COUNTING' });
        var note = prev ? (isHelperBefore(prev) ? 'ส่งงาน ' + prev + ' ให้อัตโนมัติแล้ว' : prev + ' พักไว้ (ยังไม่ปิด)') : '';
        // ถามเซิร์ฟเวอร์ก่อนว่าใครเป็นผู้ดูแล — ระหว่างนี้ยังไม่รับการยิง (v2.2.6)
        S.checking = loc;
        SOUND.ok();
        setCard('idle', 'กำลังตรวจ ' + loc + '…', 'ถามเซิร์ฟเวอร์ว่ามีผู้ดูแลแล้วหรือยัง · รอสักครู่' + (note ? '<br>' + esc(note) : ''));
        show('count');
        busy('กำลังตรวจ ' + loc + '…', 'ถามเซิร์ฟเวอร์ว่ามีผู้ดูแลแล้วหรือยัง' + (note ? '\n' + note : ''));
        var done = function () { busyOff(); if (S.checking === loc) S.checking = ''; render(); };
        return saveState().then(function () { return checkOwner(loc, r, note, pre, tried); }).then(done, function (e) { done(); throw e; });
      });
    });
  }
  var leftAs = {};
  function isHelperBefore(loc) { return leftAs[loc] === 'HELPER'; }

  /** ออกจาก Location โดยไม่ปิด: ผู้ดูแล → พัก · ผู้ช่วย → ส่งงานอัตโนมัติ */
  function leaveLocation(loc, opt) {
    var helper = isHelper(loc);
    leftAs[loc] = helper ? 'HELPER' : 'OWNER';
    setRole(loc, { state: helper ? 'SUBMITTED' : 'PAUSED' });
    if (S.loc === loc) S.loc = null;
    return addEvent(helper ? 'SUBMIT' : 'PAUSE', loc, helper ? { auto: !(opt && opt.self) } : null).then(saveState);
  }

  /**
   * หลังยิงป้าย: ถามเซิร์ฟเวอร์ว่าใครเป็นผู้ดูแล แล้วตัดสิน (v2.2.6)
   * - ออฟไลน์จริง → เปิดนับได้ เซิร์ฟเวอร์ตัดสินบทบาทตอนส่งข้อมูล และแจ้งด้วยกล่องกลางจอ
   * - เซิร์ฟเวอร์ช้า → ถาม "ลองอีกครั้ง / ไม่ใช่ (ยิงป้ายผิด)" ไม่เข้าร่วมเองโดยไม่ถาม
   */
  function checkOwner(loc, before, note, pre, tried) {
    var sendOpen = function (type) { return addEvent(type || 'OPEN', loc); };
    var openCard = function (title, sub) {
      S.checking = '';
      setCard('idle', title || ('เปิด ' + loc + ' แล้ว — ยิงสินค้าได้เลย'), [sub, note].filter(Boolean).map(esc).join('<br>')); render();
    };
    var retried = false;
    // คำตอบที่เพิ่งถามตอนยิงป้าย (≤ 15 วิ) ใช้ต่อได้ ไม่ถามเซิร์ฟเวอร์ซ้ำ
    // ถามไปแล้วแต่เซิร์ฟเวอร์ช้า → ไปที่ "ลองอีกครั้ง" เลย ไม่รอซ้ำอีกรอบ
    var first = pre && S.infoAt[loc] && Date.now() - S.infoAt[loc] <= 15000 ? Promise.resolve(pre) :
      tried && !pre && S.infoErr !== 'NETWORK' ? Promise.resolve(null) : fetchInfo(loc);
    return first.then(function onInfo(info) {
      if (S.loc !== loc) return;
      if (info) return decide(info);
      if (S.infoErr === 'NETWORK') {
        openCard('เปิด ' + loc + ' แล้ว (ออฟไลน์) — ยิงสินค้าได้เลย', 'ถ้ามีผู้ดูแลอยู่แล้ว ระบบจะแจ้งเมื่อส่งข้อมูลได้');
        return sendOpen(isHelper(loc) ? 'JOIN' : 'OPEN');
      }
      SOUND.warn();
      var m = !retried ?
        { title: 'ตรวจ ' + loc + ' ไม่ได้', html: 'เซิร์ฟเวอร์ตอบช้า ยังไม่รู้ว่ามีผู้ดูแลแล้วหรือยัง<br><span class="muted">ยังไม่บันทึกการยิง</span>', yes: 'ลองอีกครั้ง', no: 'ไม่ใช่ (ยิงป้ายผิด)' } :
        { title: 'ยังตรวจ ' + loc + ' ไม่ได้', html: 'นับต่อได้ ระบบจะจัดบทบาทให้เมื่อเซิร์ฟเวอร์ตอบ<br>ถ้ามีผู้ดูแลอยู่แล้ว เครื่องนี้จะเป็น <b>ผู้ช่วย</b> และจะแจ้งให้ทราบ', yes: 'นับต่อ', no: 'ไม่ใช่ (ยิงป้ายผิด)' };
      return modal(m).then(function (yes) {
        if (S.loc !== loc) return;
        if (!yes) return cancelOpen(loc, before);
        if (retried) { openCard(); return sendOpen(isHelper(loc) ? 'JOIN' : 'OPEN'); }
        retried = true;
        setCard('idle', 'กำลังตรวจ ' + loc + '…', 'ลองอีกครั้ง'); render();
        busy('กำลังตรวจ ' + loc + '…', 'ลองอีกครั้ง');
        return fetchInfo(loc).then(onInfo);
      });
    });

    function decide(info) {
      var o = info.owner, me = info.me;
      var otherOwner = o && o.device !== S.cfg.deviceId;
      if (!otherOwner) {
        setRole(loc, { role: 'OWNER', state: 'COUNTING', owner: S.cfg.deviceId });
        openCard((before && before.state === 'PAUSED' ? 'กลับมานับต่อ ' + loc + ' (พักไว้)' : 'เปิด ' + loc + ' แล้ว') + ' — ยิงสินค้าได้เลย');
        return sendOpen('OPEN');
      }
      var who = memberLabel(o);
      if (o.state === 'CLOSED') {
        // Control 10: ผู้ดูแลปิดแล้ว ผู้ช่วยยิงเพิ่มไม่ได้จนกว่าผู้ดูแลจะเปิดแก้ไข
        S.checking = ''; S.loc = null; setRole(loc, { role: 'HELPER', state: 'SUBMITTED', owner: o.device, ownerLabel: who });
        SOUND.bad(); setCard('bad', loc + ' ปิดแล้วโดย ' + (o.name || o.device), 'ให้ผู้ดูแลเปิดแก้ไขก่อน — ไม่รับการยิง');
        return saveState().then(function () { render(); return modal({ title: loc + ' ปิดแล้ว', html: 'ปิดโดย ' + esc(who) + '<br>ถ้าต้องนับเพิ่ม ให้ผู้ดูแลยิงป้าย ' + esc(loc) + ' เพื่อเปิดแก้ไขก่อน', yes: 'รับทราบ', noCancel: true }); });
      }
      if (me && me.role === 'HELPER') {
        var asked = S.rejoinAsked === loc; S.rejoinAsked = '';
        if (me.state === 'SUBMITTED' && !asked) {
          // ส่งงานไปแล้ว (เซิร์ฟเวอร์ยืนยัน) แต่เครื่องไม่ได้ถาม → ถามก่อนกลับไปช่วย
          SOUND.warn();
          return modal({ title: 'กลับไปช่วย ' + loc + ' อีกครั้ง?', html: 'ส่งงานไปแล้ว <b>' + fmt(me.qty !== undefined ? me.qty : locSummary(loc).qty) + '</b> ชิ้น ยอดเดิมยังอยู่ ยิงเพิ่มต่อจากเดิม<br><span class="muted">ผู้ดูแล ' + esc(who) + '</span>',
            yes: 'กลับไปช่วย', no: 'ไม่ใช่ (ยิงป้ายผิด)' }).then(function (yes) {
            if (S.loc !== loc) return;
            if (!yes) { setRole(loc, { role: 'HELPER', state: 'SUBMITTED', owner: o.device, ownerLabel: who }); return cancelOpen(loc, null, true); }
            setRole(loc, { role: 'HELPER', state: 'COUNTING', owner: o.device, ownerLabel: who });
            openCard('กลับมาช่วย ' + loc + ' แล้ว — ยิงสินค้าได้เลย', 'ผู้ดูแล ' + who);
            return saveState().then(function () { return sendOpen('JOIN'); });
          });
        }
        setRole(loc, { role: 'HELPER', state: 'COUNTING', owner: o.device, ownerLabel: who });
        openCard('ช่วยนับ ' + loc + ' — ยิงสินค้าได้เลย', 'ผู้ดูแล ' + who);
        return sendOpen('JOIN');
      }
      SOUND.warn();
      return modal({ title: loc + ' ดูแลโดย ' + (o.name || o.device), html: 'ผู้ดูแล ' + esc(who) + '<br>เข้าร่วมนับเป็น <b>ผู้ช่วย</b>?<br><span class="muted">ผู้ช่วยยิงได้ แก้ได้เฉพาะยอดของตัวเอง ปิดไม่ได้ เสร็จแล้วกด "ส่งงาน"</span>',
        yes: 'เข้าร่วม', no: 'ไม่ใช่ (ยิงป้ายผิด)' }).then(function (yes) {
        if (S.loc !== loc) return;
        if (!yes) return cancelOpen(loc, before);
        setRole(loc, { role: 'HELPER', state: 'COUNTING', owner: o.device, ownerLabel: who });
        S.checking = '';
        setCard('idle', 'เข้าร่วม ' + loc + ' เป็นผู้ช่วยแล้ว', 'ผู้ดูแล ' + esc(who), 'เสร็จแล้วกด "ส่งงาน"'); render();
        return saveState().then(function () { return sendOpen('JOIN'); });
      });
    }
  }

  /** ยิงป้ายผิด / ไม่เข้าร่วม: ออกจาก Location โดยไม่ส่งเหตุการณ์ (ยังไม่รับการยิงระหว่างตรวจ จึงไม่มีรายการค้าง) */
  function cancelOpen(loc, before, keepRole) {
    S.checking = ''; S.loc = null;
    if (!keepRole) { if (before) S.roles[loc] = before; else delete S.roles[loc]; }
    setCard('idle', 'ไม่ได้เปิด ' + loc, 'ยิงป้าย Location ถัดไป');
    return saveState().then(render);
  }

  function pausedLocs() {
    return Object.keys(S.roles).filter(function (l) { var r = S.roles[l]; return l !== S.loc && r.role === 'OWNER' && r.state === 'PAUSED'; });
  }
  /** หลังปิด/ส่งงาน ถ้ามี Location ที่พักไว้ เสนอให้กลับไปนับต่อ */
  function offerPaused() {
    var p = pausedLocs();
    if (!p.length) return Promise.resolve();
    var l = p[p.length - 1];
    return confirmBox('มี Location ที่พักไว้', 'กลับไปนับต่อที่ <b>' + esc(l) + '</b> (พักไว้)?' + (p.length > 1 ? '<br><span class="muted">พักไว้ทั้งหมด: ' + esc(p.join(', ')) + '</span>' : ''), 'กลับไปนับต่อที่ ' + l)
      .then(function (y) { if (y) return openLocation(l); });
  }

  /** ธง "ต้องตรวจซ้ำ" ที่รู้ล่าสุดของ Location (จากเซิร์ฟเวอร์ หรือที่เพิ่งได้รับแจ้งตอนส่งข้อมูล) */
  function flagOf(loc) {
    var i = S.info[loc];
    return (i && i.flag) || S.flags[loc] || '';
  }

  function doClose(loc, total) {
    setRole(loc, { role: 'OWNER', state: 'CLOSED' });
    if (S.loc === loc) S.loc = null;
    return addEvent('CLOSE', loc, { total: total }).then(function () {
      return confirmSent(loc, 'กำลังปิด ' + loc + '…', 'รอเซิร์ฟเวอร์ตรวจยอดและยืนยัน');
    }).then(function (res) {
      setCard(res === 'ok' ? 'ok' : 'idle', 'ปิด ' + loc + ' แล้ว', sentNote(res) + '<br>ยิงป้าย Location ถัดไป');
      if (S.online === false && pending().length) exportFile(true);
      return saveState().then(render).then(function () { return result(true, 'ปิด ' + loc + ' แล้ว', sentNote(res)); }).then(function (how) { if (how !== 'scan') return offerPaused(); });
    });
  }

  function doSubmit(loc) {
    return leaveLocation(loc, { self: true }).then(function () {
      return confirmSent(loc, 'กำลังส่งงาน ' + loc + '…', 'รอเซิร์ฟเวอร์ยืนยันว่าได้รับยอดครบ');
    }).then(function (res) {
      SOUND.ok();
      setCard(res === 'ok' ? 'ok' : 'idle', 'ส่งงาน ' + loc + ' แล้ว', 'ของฉัน ' + fmt(locSummary(loc).qty) + ' ชิ้น · ' + sentNote(res) + '<br>ยิงป้าย Location ถัดไป');
      if (S.online === false && pending().length) exportFile(true);
      render();
      return result(true, 'ส่งงาน ' + loc + ' แล้ว', 'ของฉัน ' + fmt(locSummary(loc).qty) + ' ชิ้น\n' + sentNote(res)).then(function (how) { if (how !== 'scan') return offerPaused(); });
    });
  }

  /**
   * ผู้ดูแลแก้ยอด/ล้าง/ปิด ได้เมื่อผู้ช่วยส่งงานครบ (ข้อมูลถึงเซิร์ฟเวอร์ครบ)
   * ออนไลน์: ถามสถานะล่าสุด · ออฟไลน์: ใช้ได้ถ้าเท่าที่รู้ไม่มีผู้ช่วยค้าง (เซิร์ฟเวอร์ตรวจซ้ำตอนส่งข้อมูล)
   */
  function ownerGate(loc, what, strict) {
    // แก้ยอด: ถ้าเพิ่งได้สถานะสด (≤ 20 วิ) และผู้ช่วยส่งงานครบ ไม่ต้องถามซ้ำ (เซิร์ฟเวอร์ยังมีด่าน Basis อีกชั้น) · ปิด/ล้าง: ถามสดทุกครั้ง (U12)
    if (!strict && S.infoAt[loc] && Date.now() - S.infoAt[loc] <= 20000 && !waitingHelpers(loc).length) return Promise.resolve(true);
    busy('กำลังตรวจผู้ช่วย…', 'ถามเซิร์ฟเวอร์ว่าผู้ช่วยส่งงานครบหรือยัง');
    return fetchInfo(loc).then(function (fresh) {
      busyOff();
      // เซิร์ฟเวอร์ช้า: ยังไม่ให้ปิด/แก้ จนกว่าจะได้สถานะสด (ออฟไลน์จริงใช้สถานะล่าสุด แล้วเซิร์ฟเวอร์ตรวจซ้ำภายหลัง)
      if (!fresh && S.infoErr !== 'NETWORK') {
        SOUND.warn();
        return modal({ title: 'ตรวจผู้ช่วยไม่ได้', html: 'เซิร์ฟเวอร์ตอบช้า ยังไม่รู้ว่าผู้ช่วยส่งงานครบหรือยัง<br><span class="muted">' + esc(what) + 'ได้หลังตรวจผ่าน</span>',
          yes: 'ลองอีกครั้ง', no: 'ยกเลิก' }).then(function (y) { return y ? ownerGate(loc, what) : false; });
      }
      // นับช่วยกัน + ออฟไลน์ (v2.3.4): ห้ามปิด / ล้างทั้ง Location / แก้ยอดรวม — ต้องยืนยันกับเซิร์ฟเวอร์ว่าทุกคนส่งงานแล้ว
      // (สถานะผู้ช่วยที่จำไว้อาจเก่า: UAT T7 ปิดตอนออฟไลน์ ทั้งที่ผู้ช่วยยังนับอยู่) · นับคนเดียวยังทำออฟไลน์ได้
      if (!fresh && hasOthers(loc)) {
        SOUND.bad();
        return result(false, what + 'ได้เมื่อออนไลน์', 'นับช่วยกัน ต้องตรวจกับเซิร์ฟเวอร์ว่าทุกคนส่งงานแล้ว\nพัก ' + loc + ' ไว้ (ยิงป้าย Location อื่น) นับต่อได้ แล้วกลับมาทำเมื่อมีสัญญาณ\nเครื่องใช้ไม่ได้: แจ้งหัวหน้าทีม "โอนการดูแล"').then(function () { return false; });
      }
      var wait = waitingHelpers(loc);
      if (!wait.length) return true;
      SOUND.warn();
      return modal({
        title: what + 'ได้เมื่อผู้ช่วยส่งงานครบ',
        html: (fresh ? '' : '<span class="muted">ออฟไลน์ — ใช้สถานะล่าสุดที่รู้</span><br>') + 'รอ:<br>' + wait.map(function (m) { return '• ' + esc(waitText(m)); }).join('<br>') +
          '<br><span class="muted">ตามตัวให้กด "ส่งงาน" ถ้าตามไม่ได้ แจ้งหัวหน้าทีม (หน้า Admin → ส่งงานแทน)</span>',
        yes: 'รับทราบ', noCancel: true
      }).then(function () { return false; });
    });
  }

  // ---------- ปุ่มหน้านับ ----------
  $('keypad').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var k = b.dataset.k;
    if (k === 'C') S.qty = '';
    else if (k === 'B') S.qty = S.qty.slice(0, -1);
    else if (S.qty.length < 4) S.qty = (S.qty === '0' ? '' : S.qty) + b.textContent;
    if (S.qty === '0') S.qty = '';
    renderCount();
  });

  $('btnUndo').onclick = function () {
    if (!S.loc) { toast('ยังไม่ได้เปิด Location', true); return; }
    var v = voidedSet();
    var last = S.entries.slice().reverse().find(function (e) { return e.location === S.loc && (e.type === 'SCAN' || e.type === 'MANUAL') && !v[e.logId]; });
    if (!last) { toast('ไม่มีรายการให้ยกเลิก', true); return; }
    var it = info(last);
    confirmBox('ยกเลิกรายการล่าสุด', esc(it.n) + '<br>' + tailHtml(it.c) + '<br>จำนวน ' + fmt(last.qty) + ' ใน ' + esc(S.loc), 'ยกเลิกรายการนี้').then(function (yes) {
      if (!yes) return;
      addEntry({ barcode: last.barcode, material: last.material, qty: -last.qty, type: 'VOID', refId: last.logId, reason: 'ยกเลิกรายการล่าสุด' }).then(function () {
        SOUND.warn(); setSku(last.material ? it : null); setCard('warn', 'ยกเลิกแล้ว: ' + it.n, codeLine(it.c, last.barcode), '−' + fmt(last.qty)); render();
      });
    });
  };

  $('btnClose').onclick = function () {
    if (!S.loc) { toast('ยังไม่ได้เปิด Location', true); return; }
    var loc = S.loc;
    if (isHelper(loc)) {
      var m = locSummary(loc), r = S.roles[loc] || {};
      confirmBox('ส่งงาน ' + loc + '?', 'ของฉัน <span class="bignum">' + fmt(m.qty) + '</span> ชิ้น · ' + m.sku + ' SKU<br>ส่วนของฉันเสร็จแล้ว ผู้ดูแล' + (r.owner ? ' (' + esc(r.ownerLabel || r.owner) + ')' : '') + 'จะเป็นคนปิด Location<br><span class="muted">ถ้าต้องกลับมานับเพิ่ม ยิงป้าย ' + esc(loc) + ' อีกครั้ง</span>', 'ส่งงาน')
        .then(function (yes) { if (yes) doSubmit(loc); });
      return;
    }
    ownerGate(loc, 'ปิด Location ', true).then(function (ok) {
      if (!ok || S.loc !== loc) return;
      var s = combinedSummary(loc), flag = flagOf(loc);
      // ข้อความตามสถานการณ์ (v2.3.4): นับช่วยกัน ล้างของตัวเอง / ล้างทั้ง Location ใช้ปุ่มรอง · ปิดไม่ลบธง
      var redo = s.multi ? 'ถ้ายอดยังไม่ถูก: แต่ละคนแก้/ล้างยอดของตัวเอง หรือใช้ "แก้ยอดรวม / ล้างทั้ง Location"' : 'ถ้ายอดยังไม่ถูก: ดู/แก้ → ล้าง Location แล้วนับใหม่';
      confirmBox('ปิด ' + loc, (flag ? '<div class="warnline">⚠ ' + esc(flag) + '<br>' + redo + '<br>ปิดได้ แต่ธงยังอยู่จนหัวหน้าทีมตรวจและกด "ปิดธง"</div>' : '') +
        '<span class="bignum">' + fmt(s.qty) + '</span> ชิ้น · ' + s.sku + ' SKU' + (s.multi ? ' <span class="muted">(รวม ' + S.info[loc].members.length + ' เครื่อง)</span>' : '') +
        '<br>ตรงกับยอดนับมือบนกระดาษของร้านแล้วใช่ไหม?<br><span class="muted">ถ้าไม่ตรง กดยกเลิก แล้วใช้ "ดู/แก้ Location"</span>', 'ปิด Location')
        .then(function (yes) { if (yes) doClose(loc, s.qty); });
    });
  };
  $('btnLoc').onclick = function () { if (!S.loc) { toast('ยิงป้าย Location ก่อน หรือเลือกจาก ⋮ → Location ที่นับแล้ว', true); return; } show('loc'); };
  $('tbLoc').onclick = function () { if (S.view === 'count' || S.view === 'loc') show('locs'); };
  $('btnManual').onclick = function () { if (!S.loc) { toast('ยิงป้าย Location ก่อน', true); return; } show('manual'); };
  /** ตรวจความพร้อมผ่านแล้ว (รอบนี้) — ยังไม่ผ่านห้ามเข้าหน้านับทุกทาง */
  function isReady() { return !!(S.readiness && S.readiness.pass && S.readiness.project === S.projectId && S.staff); }
  $('btnMenu').onclick = function (e) {
    e.stopPropagation();
    // ยังไม่พร้อม: ซ่อนเมนูที่พาเข้าหน้านับ เหลือ สถานะ/Export และ ตรวจความพร้อมใหม่
    var ok = isReady(), paired = !!S.cfg.token && !S.revoked;
    document.querySelectorAll('#menu button[data-m=locs], #menu button[data-m=typeloc]').forEach(function (b) { b.classList.toggle('hidden', !ok || !paired); });
    // ยังไม่จับคู่: เหลือแค่ สถานะ / Export
    document.querySelectorAll('#menu button[data-m=ready]').forEach(function (b) { b.classList.toggle('hidden', !paired); });
    $('menu').classList.toggle('hidden');
  };
  document.addEventListener('click', function () { $('menu').classList.add('hidden'); });
  $('menu').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    $('menu').classList.add('hidden');
    if (b.dataset.m === 'status') show('status');
    else if (b.dataset.m === 'typeloc') typeLocation();
    else if (b.dataset.m === 'locs') show('locs');
    else if (b.dataset.m === 'ready') { show('ready'); runChecks(false); }
  });
  function knownLocs() {
    var k = {};
    S.entries.forEach(function (e) { if (e.location) k[e.location] = true; });
    Object.keys(S.roles).forEach(function (l) { k[l] = true; });
    S.knownNames.forEach(function (l) { k[l] = true; });
    return k;
  }
  /** ไปที่ Location ด้วยการพิมพ์ชื่อ (ป้ายหาย/ยิงไม่ได้) — ชื่อที่ยังไม่เคยมีในรอบนี้ต้องยืนยัน กันพิมพ์ผิดแล้วยอดแยกไปอีกที่ */
  function typeLocation() {
    modal({ title: 'ไปที่ Location', html: 'พิมพ์ชื่อ เช่น A12 (ใช้เมื่อป้ายหายหรือยิงไม่ได้)', input: true, inputmode: 'text', yes: 'ไป' }).then(function (v) {
      if (v === null) return; var loc = normLoc(v);
      if (!loc) { toast('รูปแบบต้องเป็นตัวอักษรโซน + เลข เช่น A12', true); return; }
      if (knownLocs()[loc] || loc === S.loc) return openLocation(loc);
      confirmBox(loc + ' ยังไม่เคยมีในรอบนี้', 'ตรวจว่าพิมพ์ถูก: <span class="bignum">' + esc(loc) + '</span><br><span class="muted">ถ้าพิมพ์ผิด ยอดจะแยกไปอยู่ Location ใหม่</span>', 'ถูกต้อง เปิด ' + loc)
        .then(function (y) { if (y) openLocation(loc); });
    });
  }

  // ---------- Location ที่นับแล้ว ----------
  // v2.3.7: จัดกลุ่มตามสิ่งที่ต้องทำต่อ (กำลังนับ → ต้องทำต่อ → เสร็จแล้ว) · ในกลุ่มเรียงตามชื่อป้ายแบบตัวเลข (A2 ก่อน A10)
  // ตัวเลขใหญ่ขวา = ยอดรวมทุกเครื่อง (ปิดแล้ว = ยอดตอนปิด) · "ของฉัน" นับหลังล้าง Location
  var STATE_TXT = { COUNTING: 'กำลังนับ', PAUSED: 'พักไว้', SUBMITTED: 'ส่งงานแล้ว', CLOSED: 'ปิดแล้ว' };
  function natCmp(a, b) { return String(a).localeCompare(String(b), 'th', { numeric: true, sensitivity: 'base' }); }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  /** ยอดของฉันหลังล้าง Location ครั้งล่าสุด: เซิร์ฟเวอร์ (sc) + รายการที่ยังไม่ส่ง · ถ้ามีรายการล้างค้างส่ง คิดจากในเครื่อง */
  function mineAfterClear(loc, srv) {
    var mine = S.entries.filter(function (e) { return e.location === loc && !e.rejected; });
    var un = mine.filter(function (e) { return !e.synced; });
    if (srv && srv.mineSc !== undefined && !un.some(isClearEntry)) return r3(un.reduce(function (t, e) { return t + e.qty; }, srv.mineSc));
    var cut = clearSeq(loc);
    mine.forEach(function (e) { if (isClearEntry(e) && e.seq > cut) cut = e.seq; });
    return r3(mine.reduce(function (t, e) { return e.seq > cut && !isClearEntry(e) ? t + e.qty : t; }, 0));
  }
  function locRow(l) {
    var r = S.roles[l] || {}, srv = S.myLocs[l], role = r.role || (srv && srv.role) || 'OWNER';
    var state = l === S.loc ? 'COUNTING' : r.state || (srv && srv.state) || 'COUNTING';
    var unsent = S.entries.reduce(function (t, e) { return e.location === l && !e.synced && !e.rejected ? t + e.qty : t; }, 0);
    var x = { loc: l, role: role, state: state, srv: srv || {}, mine: mineAfterClear(l, srv), flag: srv && srv.flag || '' };
    var closed = srv ? /ปิดแล้ว|CLOSED/.test(srv.status) : state === 'CLOSED';
    x.done = !x.flag && l !== S.loc && (role === 'HELPER' ? state === 'SUBMITTED' || state === 'CLOSED' : state === 'CLOSED');
    if (closed && srv && srv.closeTotal !== null && srv.closeTotal !== undefined && !unsent) x.total = srv.closeTotal;
    else if (srv) x.total = r3(srv.total + unsent);
    else x.total = combinedSummary(l).qty;   // ยังไม่เคยถามเซิร์ฟเวอร์ (ออฟไลน์): ยอดที่เครื่องรู้
    if (l === S.loc) x.total = combinedSummary(l).qty;   // Location ปัจจุบัน: ยอดเดียวกับหน้านับ
    x.closed = closed;
    if (l === S.loc) x.tag = ['b', 'กำลังนับ'];
    else if (x.flag) x.tag = ['r', 'ต้องตรวจซ้ำ'];
    else if (x.done) x.tag = ['g', role === 'HELPER' && !closed ? 'ส่งงานแล้ว' : 'ปิด' + (srv && srv.closedTime ? ' ' + String(srv.closedTime).slice(11, 16) : 'แล้ว')];
    else if (state === 'PAUSED') x.tag = ['y', 'พักไว้'];
    else if (role === 'OWNER' && srv && srv.helpers > srv.helpersDone) x.tag = ['y', 'รอผู้ช่วยส่งงาน ' + srv.helpersDone + '/' + srv.helpers];
    else if (role === 'HELPER' && state === 'SUBMITTED') x.tag = ['g', 'ส่งงานแล้ว'];
    else x.tag = ['y', 'ยังไม่ปิด'];
    return x;
  }
  function renderLocs() {
    var locs = {};
    S.entries.forEach(function (e) { if (e.location) locs[e.location] = 1; });
    Object.keys(S.roles).forEach(function (l) { locs[l] = 1; });
    Object.keys(S.myLocs).forEach(function (l) { locs[l] = 1; });
    var list = Object.keys(locs).map(locRow);
    var here = list.filter(function (x) { return x.loc === S.loc; });
    var todo = list.filter(function (x) { return x.loc !== S.loc && !x.done; }).sort(function (a, b) { return !!b.flag - !!a.flag || natCmp(a.loc, b.loc); });
    var done = list.filter(function (x) { return x.done; }).sort(function (a, b) { return natCmp(a.loc, b.loc); });
    var f = S.locsFilter || (todo.length ? 'todo' : 'all');
    var total = r3(list.reduce(function (t, x) { return t + (x.total || 0); }, 0));
    $('locsSum').innerHTML = '<div>เสร็จแล้ว<b>' + done.length + '</b></div><div>ยังไม่เสร็จ<b>' + (todo.length + here.length) + '</b></div><div>ยอดรวม<b>' + fmt(total) + '</b></div>';
    $('locsChips').querySelectorAll('button').forEach(function (b) {
      var n = { todo: todo.length, done: done.length, all: list.length }[b.dataset.f];
      b.textContent = { todo: 'ต้องทำต่อ', done: 'เสร็จแล้ว', all: 'ทั้งหมด' }[b.dataset.f] + ' ' + n;
      b.classList.toggle('on', b.dataset.f === f);
    });
    var old = S.online === false && S.myLocsAt ? ' · ยอดจากเซิร์ฟเวอร์เมื่อ ' + String(S.myLocsAt).slice(11, 16) + ' (ออฟไลน์)' : '';
    $('locsHead').textContent = list.length ? 'ตัวเลขขวา = ยอดรวมทุกเครื่อง · แตะเพื่อไปที่ Location' + old : 'ยังไม่มี Location ในรอบนี้';
    function row(x) {
      var who = x.role === 'HELPER' ? 'ผู้ช่วย' : 'ผู้ดูแล';
      var sub = 'ของฉัน ' + fmt(x.mine) + ' · ' + who + (x.srv.devices > 1 ? ' · ' + x.srv.devices + ' เครื่อง' : '');
      return '<li data-l="' + esc(x.loc) + '" class="st-' + esc(x.state) + (x.done ? ' st-done' : '') + (x.loc === S.loc ? ' here' : '') + '"><div class="lmain"><div class="n"><span class="ln">' + esc(x.loc) + '</span>' +
        '<span class="badge ' + x.tag[0] + '">' + esc(x.tag[1]) + '</span></div><div class="c">' + esc(sub) + '</div>' +
        (x.flag ? '<div class="c"><span class="badge r">' + esc(x.flag) + '</span></div>' : '') + '</div>' +
        '<div class="lq">' + fmt(x.total) + (x.closed && x.done ? '<small>ยอดสุดท้าย</small>' : '') + '</div></li>';
    }
    function grp(t, xs) { return xs.length ? '<li class="grp">' + esc(t) + '</li>' + xs.map(row).join('') : ''; }
    var html = grp('กำลังนับ', here);
    if (f !== 'done') html += grp('ต้องทำต่อ', todo);
    if (f !== 'todo') html += grp('เสร็จแล้ว', done);
    if (f === 'todo' && !todo.length) html += '<li class="grp">ไม่มีงานค้าง · แตะ "ทั้งหมด" เพื่อดู Location ที่เสร็จแล้ว</li>';
    $('locsList').innerHTML = html;
  }
  $('locsChips').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-f]'); if (!b) return;
    S.locsFilter = b.dataset.f; renderLocs(); $('locsList').scrollTop = 0; window.scrollTo(0, 0);
  });
  function loadMyLocs() {
    if (S.online === false || !S.cfg.token) return Promise.resolve();
    return api('myLocs', {}, 8000).then(function (r) {
      S.myLocs = {}; S.knownNames = r.names || []; S.myLocsAt = r.at || '';
      r.locs.forEach(function (x) {
        S.myLocs[x.location] = x;
        // เครื่องที่ข้อมูลถูกล้างแล้วจับคู่ใหม่ ได้บทบาทคืนจากเซิร์ฟเวอร์
        var cur = S.roles[x.location];
        if (!cur || cur.role !== x.role) setRole(x.location, { role: x.role, state: x.location === S.loc ? 'COUNTING' : (cur && cur.state) || x.state });
      });
      DB.set('knownNames_' + S.projectId, S.knownNames);
      DB.set('myLocs_' + S.projectId, { at: S.myLocsAt, locs: S.myLocs });   // ใช้ตอนออฟไลน์ (v2.3.7)
      return saveState();
    }, function () {}).then(function () { if (S.view === 'locs') renderLocs(); });
  }
  $('btnLocRefresh').onclick = function () { if (S.loc && !S.infoBusy) { fetchInfo(S.loc); renderLoc(); } };
  $('locsList').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-l]'); if (!li) return;
    openLocation(li.dataset.l);
  });
  $('btnLocsBack').onclick = function () { show('count'); };
  $('btnLocsType').onclick = function () { typeLocation(); };

  // ---------- ดู/แก้ Location ----------
  // ผู้ดูแล: แก้ยอด/ล้าง จากยอดรวมทุกเครื่อง (ของเครื่องนี้ + เครื่องอื่นจากเซิร์ฟเวอร์) หลังผู้ช่วยส่งงานครบ
  // ผู้ช่วย: ดูอย่างเดียว
  function renderLoc() {
    if (!S.loc) { show('count'); return; }
    var loc = S.loc, s = combinedSummary(loc), helper = isHelper(loc), info = S.info[loc];
    $('locName').textContent = loc;
    $('locSum').textContent = fmt(s.qty) + ' ชิ้น · ' + s.sku + ' SKU';
    var mem = '';
    if (info && info.members && info.members.length > 1) {
      mem = info.members.map(function (m) {
        var me = m.device === S.cfg.deviceId;
        var st = m.role === 'OWNER' ? (m.state === 'CLOSED' ? 'ปิดแล้ว' : m.state === 'PAUSED' ? 'พัก' : 'กำลังนับ') :
          m.state === 'SUBMITTED' ? (m.match === 'OK' ? 'ส่งงานแล้ว ✓' : 'ส่งงานแล้ว (รอข้อมูล)') : 'กำลังนับ';
        var q = me ? s.mineQty : (m.sc === undefined ? m.qty : m.sc); // นับหลังล้าง Location (v2.3.6)
        return '<div class="mrow' + (m.role === 'HELPER' && !(m.state === 'SUBMITTED' && m.match === 'OK') ? ' wait' : '') + '"><span>' + (m.role === 'OWNER' ? 'ผู้ดูแล' : 'ผู้ช่วย') + ' ' +
          esc(memberLabel(m)) + (me ? ' (ฉัน)' : '') + '</span><span>' + esc(st) + ' · ' + fmt(q) + '</span></div>';
      }).join('');
    }
    $('locMembers').innerHTML = mem;
    // ความสดของสถานะผู้ร่วมนับ (v2.2.6): ผู้ดูแลรู้ว่ากำลังดูข้อมูลเมื่อไหร่ และกดรีเฟรชเองได้
    var at = S.infoAt[loc];
    $('locFreshText').textContent = S.infoBusy ? 'กำลังอัปเดตสถานะ…' :
      (at ? 'อัปเดตสถานะล่าสุด ' + stamp(new Date(at)).slice(11) : 'ยังไม่ได้สถานะจากเซิร์ฟเวอร์') +
      (S.infoErr === 'TIMEOUT' ? ' · ครั้งล่าสุดเซิร์ฟเวอร์ตอบช้า' : S.infoErr === 'NETWORK' ? ' · ออฟไลน์' : S.infoErr ? ' · ครั้งล่าสุดไม่สำเร็จ' : '');
    var wait = helper ? [] : waitingHelpers(loc);
    // นับช่วยกัน (v2.3.2): ทุกคน (รวมผู้ดูแล) แก้/ล้าง/ย้อน ได้เฉพาะยอดของตัวเอง · ผู้ดูแลมีโหมดแก้ยอดรวมแยก (ทุกคนส่งงานแล้ว)
    var shared = !helper && s.multi, total = shared && S.totalMode === loc;
    if (!shared && S.totalMode === loc) S.totalMode = null;
    var edits = S.entries.filter(function (e) { return e.location === loc && (e.type === 'RECOUNT_SET' || e.type === 'SELF_SET' || (e.type === 'VOID' && /แก้/.test(e.reason))); }).length;
    $('locEdited').textContent = helper ? 'ผู้ช่วย: แตะ SKU เพื่อแก้ "ยอดของฉัน" (เฉพาะชิ้นที่เครื่องนี้ยิง) · ยอดรวม Location ผู้ดูแลเป็นคนแก้' + (edits ? ' · แก้แล้ว ' + edits + ' ครั้ง' : '') :
      total ? 'โหมดแก้ยอดรวม: แตะ SKU เพื่อใส่ยอดจริงรวมทุกเครื่อง (ต้องใส่เหตุผล)' :
      shared ? 'นับช่วยกัน: แตะ SKU เพื่อแก้ "ยอดของฉัน" (เฉพาะชิ้นที่เครื่องนี้ยิง)' + (wait.length ? ' · ปิดได้เมื่อ ' + wait.map(function (m) { return m.name || m.device; }).join(', ') + ' ส่งงาน' : '') :
      wait.length ? 'แก้ยอด / ล้าง / ปิด ได้เมื่อ ' + wait.map(function (m) { return m.name || m.device; }).join(', ') + ' ส่งงาน' :
      edits ? 'แก้ไขแล้ว ' + edits + ' ครั้ง (แตะ SKU เพื่อดูประวัติ)' : 'แตะ SKU เพื่อใส่ยอดจริงที่นับได้';
    $('locEdited').className = total ? 'warnline' : wait.length && !shared ? 'warnline' : 'muted';
    var own = helper || (shared && !total);
    $('btnLocUndo').textContent = own ? 'ย้อนการแก้ของฉันล่าสุด' : 'ย้อนการแก้ล่าสุด';
    $('btnLocClear').textContent = own ? 'ล้างยอดของฉัน นับใหม่' : total ? 'ล้างทั้ง Location นับใหม่' : 'ล้าง Location นับใหม่';
    $('btnLocTotal').classList.toggle('hidden', !shared);
    $('btnLocTotal').textContent = total ? '← กลับไปแก้ยอดของฉัน' : 'แก้ยอดรวม / ล้างทั้ง Location (ทุกคนส่งงานแล้ว)';
    var items = Array.from(s.items.values()).sort(function (a, b) { return (b.qty !== 0) - (a.qty !== 0) || String(info_(a).c).localeCompare(String(info_(b).c)); });
    $('locItems').innerHTML = items.length ? items.map(function (it) {
      var m = info_(it);
      return '<li data-k="' + esc(it.key) + '" class="' + (it.qty === 0 ? 'zero' : '') + '"><div><div class="n">' + esc(m.n) + (it.edits ? '<span class="badge">แก้ ' + it.edits + '</span>' : '') +
        (!it.material ? '<span class="badge y">ไม่รู้จัก</span>' : '') + '</div><div class="c">' + tailHtml(m.c) + ' · ' + esc(it.material || it.barcode) + '</div>' +
        (s.multi ? '<div class="c">ของฉัน ' + fmt(it.mine) + ' · เครื่องอื่น ' + fmt(it.others) + '</div>' : '') + '</div><div class="q">' + fmt(it.qty) + '</div></li>';
    }).join('') : '<li class="muted">ยังไม่มีรายการใน Location นี้</li>';
  }
  function info_(it) { return info(it); }

  $('locItems').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-k]'); if (!li) return;
    var key = li.dataset.k;
    if (ownScope(S.loc)) { editMine(key); return; }
    var total = S.totalMode === S.loc;
    ownerGate(S.loc, 'แก้ยอด').then(function (ok) { if (ok) editItem(key, total); });
  });

  /** แก้/ล้าง/ย้อน เฉพาะยอดของตัวเอง: ผู้ช่วยเสมอ · ผู้ดูแลตอนนับช่วยกัน (ยกเว้นอยู่ในโหมดแก้ยอดรวม) (v2.3.2) */
  function ownScope(loc) { return isHelper(loc) || (hasOthers(loc) && S.totalMode !== loc); }
  /** ถามเหตุผล (บังคับ) — คืนข้อความ หรือ null ถ้ายกเลิก */
  function askReason(title, what, again) {
    // เหตุผลว่าง → ถามซ้ำพร้อมตัวแดงในกล่อง (แถบล่างถูกแป้นพิมพ์บัง · UAT G4-7 · v2.3.5)
    return modal({ title: title, html: what + '<br>ใส่<b>เหตุผล</b> (บังคับ) เช่น ตรวจนับซ้ำทั้งชั้นแล้วได้ยอดนี้' +
      (again ? '<div class="warnline">ต้องใส่เหตุผลก่อนบันทึก</div>' : ''), input: true, inputmode: 'text', value: '', yes: 'บันทึก' }).then(function (v) {
      if (v === null) return null;
      v = String(v).trim();
      if (!v) { SOUND.warn(); return askReason(title, what, true); }
      return v;
    });
  }
  $('btnLocTotal').onclick = function () {
    var loc = S.loc;
    if (S.totalMode === loc) { S.totalMode = null; renderLoc(); return; }
    ownerGate(loc, 'แก้ยอดรวม ', true).then(function (ok) {
      if (!ok) return;
      S.totalMode = loc; renderLoc();
      toast('โหมดแก้ยอดรวม — แตะ SKU เพื่อแก้ยอดรวมทุกเครื่อง');
    });
  };

  function editItem(key, needReason) {
    var loc = S.loc, s = combinedSummary(loc), it = s.items.get(key); if (!it) return;
    var m = info(it), cur = it.qty;
    var hist = S.entries.filter(function (e) { return e.location === loc && itemKey(e) === key && e.type !== 'SCAN'; }).slice(-6).reverse()
      .map(function (e) { return '<div class="muted">' + esc(e.scanTime.slice(11, 16)) + ' ' + esc(e.staff) + ' · ' + esc(e.type) + ' ' + (e.qty > 0 ? '+' : '') + fmt(e.qty) + (e.reason ? ' · ' + esc(e.reason) : '') + '</div>'; }).join('');
    modal({
      title: 'แก้ยอดใน ' + loc,
      html: '<b>' + esc(m.n) + '</b><br>' + tailHtml(m.c) + '<br>ใส่ <b>ยอดจริง</b> ที่นับได้' + (s.multi ? ' <b>รวมทุกเครื่อง</b>' : '') + ' (ใส่ 0 ถ้าไม่มีของชิ้นนี้ที่นี่)' +
        (s.multi ? '<div class="muted">ตอนนี้ ของฉัน ' + fmt(it.mine) + ' + เครื่องอื่น ' + fmt(it.others) + ' = ' + fmt(cur) + '</div>' : '') + otherEditHtml(loc, key) + (hist ? '<div style="margin-top:6px">' + hist + '</div>' : ''),
      input: true, value: '', yes: 'บันทึกยอดจริง',
      preview: function (v) {
        if (v === '' || isNaN(Number(v))) return '';
        var nv = Number(v), d = nv - cur;
        return 'SKU: ' + fmt(cur) + ' <span class="arrow">→ ' + fmt(nv) + '</span><br>' + loc + ': ' + fmt(s.qty) + ' <span class="arrow">→ ' + fmt(s.qty + d) + '</span>';
      }
    }).then(function (v) {
      if (v === null) return;
      if (badNumber(v)) return;
      if (v === '' || isNaN(Number(v)) || Number(v) < 0) { SOUND.warn(); result(false, 'ใส่ตัวเลข 0 ขึ้นไป', 'ยังไม่ได้แก้ยอด'); return; }
      var nv = Number(v), d = Math.round((nv - cur) * 1000) / 1000;
      if (d === 0) { result(true, 'ยอดเท่าเดิม', 'ไม่มีการแก้'); return; }
      return qtyCheck(nv, m.n).then(function (yes) {
        if (!yes) return;
        return needReason ? askReason('เหตุผลที่แก้ยอดรวม', esc(m.n) + ': ' + fmt(cur) + ' → ' + fmt(nv) + ' (รวมทุกเครื่อง)') : '';
      }).then(function (why) {
        if (why === undefined || why === null) return;
        // basis = ยอดรวมที่เห็นตอนแก้ เซิร์ฟเวอร์ใช้ตรวจว่ามีเครื่องอื่นยิง/แก้ SKU นี้ระหว่างนั้นหรือไม่ (Control 8)
        return addEntry({ barcode: it.barcode, material: it.material, qty: d, type: 'RECOUNT_SET', basis: cur,
          reason: (needReason ? 'แก้ยอดรวม Location ' : 'แก้ยอด Location ') + fmt(cur) + ' → ' + fmt(nv) + (why ? ' · เหตุผล: ' + why : '') }).then(function () {
          return addEvent('EDIT', loc);
        }).then(function () { SOUND.ok(); renderLoc(); renderTop(); result(true, needReason ? 'แก้ยอดรวมแล้ว' : 'แก้ยอดแล้ว', m.n + '\n' + fmt(cur) + ' → ' + fmt(nv)); });
      });
    });
  }

  /**
   * ผู้ช่วยแก้ "ยอดของฉัน" (v2.3.1) — แก้ได้เฉพาะชิ้นที่เครื่องนี้ยิง ไม่ต้องรอผู้ดูแล แก้ตอนออฟไลน์ได้
   * ห้ามเมื่อผู้ดูแลแก้ยอดรวม SKU นี้ไปแล้ว (กันแก้ความผิดเดียวกันซ้ำสองชั้น) · เซิร์ฟเวอร์ตรวจซ้ำด้วย basis
   */
  function editMine(key) {
    var loc = S.loc, s = combinedSummary(loc), it = s.items.get(key); if (!it) return;
    var m = info(it), cur = mineSince(loc, key), x = editInfo(loc, key), cut = x && x.cp;
    if (!mineEntries(loc, key).length) {
      SOUND.warn();
      result(false, 'SKU นี้ไม่มียอดของฉัน' + (cut ? 'หลังผู้ดูแลแก้ยอดรวม' : ''), cut ? 'ยอดก่อนหน้านี้ผู้ดูแลตรวจและแก้ยอดรวมแล้ว\nยิงเพิ่มได้ตามปกติ แล้วแก้เฉพาะส่วนที่ยิงเพิ่ม' : 'แก้ได้เฉพาะชิ้นที่เครื่องนี้ยิง\nถ้าเจอของ ยิงเพิ่มได้ตามปกติ');
      return;
    }
    modal({
      title: 'แก้ยอดของฉันใน ' + loc,
      html: '<b>' + esc(m.n) + '</b><br>' + tailHtml(m.c) + '<br>ใส่ <b>ยอดจริงที่ฉันนับได้</b> (เฉพาะส่วนที่ฉันยิง · ใส่ 0 ถ้ายิงผิดทั้งหมด)' +
        '<div class="muted">ตอนนี้ ของฉัน ' + fmt(cur) + (s.multi ? ' · รวม SKU ' + fmt(it.qty) : '') + '</div>' +
        (cut ? '<div class="muted">ยอดของฉันนับจากที่ผู้ดูแลแก้ยอดรวมครั้งล่าสุด (ยอดก่อนนั้นผู้ดูแลตรวจแล้ว)</div>' : '') + otherEditHtml(loc, key),
      input: true, value: '', yes: 'บันทึกยอดของฉัน',
      preview: function (v) {
        if (v === '' || isNaN(Number(v))) return '';
        var nv = Number(v), d = nv - cur;
        return 'ของฉัน: ' + fmt(cur) + ' <span class="arrow">→ ' + fmt(nv) + '</span><br>รวม SKU: ' + fmt(it.qty) + ' <span class="arrow">→ ' + fmt(it.qty + d) + '</span>';
      }
    }).then(function (v) {
      if (v === null) return;
      if (badNumber(v)) return;
      if (v === '' || isNaN(Number(v)) || Number(v) < 0) { SOUND.warn(); result(false, 'ใส่ตัวเลข 0 ขึ้นไป', 'ยังไม่ได้แก้ยอด'); return; }
      var nv = Number(v), d = Math.round((nv - cur) * 1000) / 1000;
      if (d === 0) { result(true, 'ยอดเท่าเดิม', 'ไม่มีการแก้'); return; }
      return qtyCheck(nv, m.n).then(function (yes) {
        if (!yes) return;
        return addEntry({ barcode: it.barcode, material: it.material, qty: d, type: 'SELF_SET', basis: cur, reason: (isHelper(loc) ? 'ผู้ช่วย' : 'ผู้ดูแล') + 'แก้ยอดของตัวเอง ' + fmt(cur) + ' → ' + fmt(nv) }).then(function () {
          return addEvent('EDIT', loc, { mine: true });
        }).then(function () { SOUND.ok(); renderLoc(); renderTop(); result(true, 'แก้ยอดของฉันแล้ว', m.n + '\n' + fmt(cur) + ' → ' + fmt(nv)); });
      });
    });
  }

  $('btnLocBack').onclick = function () { S.totalMode = null; show('count'); };
  $('btnLocUndo').onclick = function () {
    var loc = S.loc, v = voidedSet();
    if (ownScope(loc)) {
      var mineLast = S.entries.slice().reverse().find(function (e) { return e.location === loc && e.type === 'SELF_SET' && !v[e.logId]; });
      if (!mineLast) { SOUND.warn(); result(false, 'ไม่มีการแก้ของฉันให้ย้อน', 'ย้อนได้เฉพาะการแก้ยอดของเครื่องนี้'); return; }
      var mi = info(mineLast);
      return confirmBox('ย้อนการแก้ของฉันล่าสุด', esc(mi.n) + '<br>' + esc(mineLast.reason) + '<br>จะคืนยอด ' + (mineLast.qty > 0 ? '−' : '+') + fmt(Math.abs(mineLast.qty)), 'ย้อนการแก้').then(function (yes) {
        if (!yes) return;
        addEntry({ barcode: mineLast.barcode, material: mineLast.material, qty: -mineLast.qty, type: 'VOID', refId: mineLast.logId, reason: 'ย้อนการแก้: ' + mineLast.reason })
          .then(function () { return addEvent('EDIT', loc, { mine: true }); }).then(function () { SOUND.ok(); renderLoc(); renderTop(); result(true, 'ย้อนการแก้ของฉันแล้ว', mi.n + '\nคืนยอด ' + (mineLast.qty > 0 ? '−' : '+') + fmt(Math.abs(mineLast.qty))); });
      });
    }
    var last = S.entries.slice().reverse().find(function (e) { return e.location === loc && e.type === 'RECOUNT_SET' && !v[e.logId]; });
    if (!last) { SOUND.warn(); result(false, 'ไม่มีการแก้ให้ย้อน', ''); return; }
    var m = info(last);
    confirmBox('ย้อนการแก้ล่าสุด', esc(m.n) + '<br>' + esc(last.reason) + '<br>จะคืนยอด ' + (last.qty > 0 ? '−' : '+') + fmt(Math.abs(last.qty)), 'ย้อนการแก้').then(function (yes) {
      if (!yes) return;
      addEntry({ barcode: last.barcode, material: last.material, qty: -last.qty, type: 'VOID', refId: last.logId, reason: 'ย้อนการแก้: ' + last.reason })
        .then(function () { return addEvent('EDIT', loc); }).then(function () { SOUND.ok(); renderLoc(); renderTop(); result(true, 'ย้อนการแก้แล้ว', m.n + '\nคืนยอด ' + (last.qty > 0 ? '−' : '+') + fmt(Math.abs(last.qty))); });
    });
  };
  $('btnLocClear').onclick = function () {
    var loc = S.loc;
    if (ownScope(loc)) { clearMine(loc); return; }
    var needReason = S.totalMode === loc;
    ownerGate(loc, 'ล้าง Location ', true).then(function (ok) {
      if (!ok) return;
      var s = combinedSummary(loc);
      if (!s.qty && !s.sku) { toast('Location นี้ไม่มียอด', true); return; }
      confirmBox('ล้าง ' + loc + ' นับใหม่?', 'ล้าง <span class="bignum">' + fmt(s.qty) + '</span> ชิ้น ' + s.sku + ' SKU ของ ' + loc + (s.multi ? ' <b>(รวมทุกเครื่อง)</b>' : '') +
        '<br><span class="muted">ระบบไม่ลบข้อมูลเดิม แต่บันทึกรายการหักยอดกำกับไว้ ย้อนได้ทีละ SKU</span>', 'ล้างและนับใหม่').then(function (yes) {
        if (!yes) return null;
        return needReason ? askReason('เหตุผลที่ล้างทั้ง Location', 'ล้าง ' + fmt(s.qty) + ' ชิ้นของทุกเครื่องใน ' + esc(loc)) : '';
      }).then(function (why) {
        if (why === undefined || why === null) return;
        var items = Array.from(s.items.values()).filter(function (it) { return it.qty !== 0; });
        var p = Promise.resolve();
        items.forEach(function (it) {
          p = p.then(function () { return addEntry({ barcode: it.barcode, material: it.material, qty: -it.qty, type: 'RECOUNT_SET', basis: it.qty, reason: 'ล้าง Location นับใหม่ (เดิม ' + fmt(it.qty) + ')' + (why ? ' · เหตุผล: ' + why : '') }); });
        });
        // ล้างเพื่อนับใหม่ = ธงเดิมหมดความหมาย ลบที่จำไว้ทันที (เซิร์ฟเวอร์ปิดธงเมื่อได้รับ) (v2.2.9)
        delete S.flags[loc];
        if (S.info[loc]) S.info[loc].flag = '';
        p.then(function () { return addEvent('EDIT', loc, { clear: true }); }).then(function () {
          return confirmSent(loc, 'กำลังล้าง ' + loc + '…', 'แจ้งเซิร์ฟเวอร์ว่าเริ่มนับใหม่');
        }).then(function (res) {
          S.recountBanner = 'นับใหม่ ' + loc + ' (ยอดเดิม ' + fmt(s.qty) + ')'; S.totalMode = null;
          SOUND.ok(); setCard('idle', 'ล้าง ' + loc + ' แล้ว — เริ่มนับใหม่ได้', sentNote(res)); show('count');
          result(true, 'ล้าง ' + loc + ' แล้ว', 'เริ่มนับใหม่ได้\n' + sentNote(res));
        });
      });
    });
  };

  /** ผู้ช่วยล้างยอดของตัวเองทั้ง Location เพื่อนับส่วนของตัวเองใหม่ (v2.3.1) — ไม่แตะยอดของเครื่องอื่น */
  function clearMine(loc) {
    var s = combinedSummary(loc), keys = [];
    s.items.forEach(function (it, k) {
      var q = mineSince(loc, k);
      if (q !== 0) keys.push({ it: it, q: q, cut: !!(editInfo(loc, k) || {}).cp });
    });
    var ok = keys, cuts = keys.filter(function (k) { return k.cut; }).length;
    if (!ok.length) { SOUND.warn(); result(false, 'ไม่มียอดของฉันใน ' + loc, 'ยอดที่ผู้ดูแลแก้ยอดรวมไปแล้วไม่นับเป็นยอดของฉัน'); return; }
    var tot = Math.round(ok.reduce(function (a, k) { return a + k.q; }, 0) * 1000) / 1000;
    confirmBox('ล้างยอดของฉันใน ' + loc + '?', 'ล้าง <span class="bignum">' + fmt(tot) + '</span> ชิ้น ' + ok.length + ' SKU <b>เฉพาะที่เครื่องนี้ยิง</b><br>ยอดของเครื่องอื่นไม่ถูกแตะ' +
      (cuts ? '<br><span class="muted">' + cuts + ' SKU นับเฉพาะส่วนหลังผู้ดูแลแก้ยอดรวม</span>' : '') +
      '<br><span class="muted">ระบบไม่ลบข้อมูลเดิม แต่บันทึกรายการหักยอดกำกับไว้</span>', 'ล้างยอดของฉัน').then(function (yes) {
      if (!yes) return;
      var p = Promise.resolve();
      ok.forEach(function (k) {
        p = p.then(function () { return addEntry({ barcode: k.it.barcode, material: k.it.material, qty: -k.q, type: 'SELF_SET', basis: k.q, reason: (isHelper(loc) ? 'ผู้ช่วย' : 'ผู้ดูแล') + 'ล้างยอดของตัวเอง (เดิม ' + fmt(k.q) + ')' }); });
      });
      p.then(function () { return addEvent('EDIT', loc, { mine: true, clearMine: true }); }).then(function () {
        return confirmSent(loc, 'กำลังล้างยอดของฉัน…', 'แจ้งเซิร์ฟเวอร์');
      }).then(function (res) {
        SOUND.ok(); setCard('idle', 'ล้างยอดของฉันใน ' + loc + ' แล้ว — นับส่วนของฉันใหม่ได้', sentNote(res)); show('count');
        result(true, 'ล้างยอดของฉันใน ' + loc + ' แล้ว', 'นับส่วนของฉันใหม่ได้\n' + sentNote(res));
      });
    });
  }

  // ---------- ป้อนเอง ----------
  function renderManual() {
    var q = $('manQ').value.trim().toUpperCase();
    var list = [];
    if (q.length >= 2) {
      list = S.masterList.filter(function (r) {
        return (r.c && r.c.toUpperCase().indexOf(q) >= 0) || (r.m && r.m.toUpperCase().indexOf(q) >= 0) || (r.b && r.b.indexOf(q) >= 0);
      }).slice(0, 40);
    }
    var html = list.map(function (r, i) {
      return '<li data-i="' + i + '"><div><div class="n">' + esc(r.n) + (!r.b ? '<span class="badge y">ไม่มีบาร์โค้ด</span>' : '') + '</div><div class="c">' + tailHtml(r.c) + ' · ' + esc(r.m) + '</div><div class="c">' + esc(r.b) + '</div></div></li>';
    }).join('');
    if (/^\d{8,14}$/.test(q) && !S.master.get(q)) html += '<li data-raw="' + esc(q) + '"><div><div class="n">บันทึกบาร์โค้ด ' + esc(q) + '</div><div class="c">ไม่มีในรายการ (สีเหลือง)' + (validFormat(q) ? '' : ' · check digit ผิด') + '</div></div></li>';
    $('manList').innerHTML = html || '<li class="muted">พิมพ์อย่างน้อย 2 ตัวอักษร</li>';
    $('manList')._list = list;
  }
  $('manQ').addEventListener('input', renderManual);
  $('manQ').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var q = $('manQ').value.trim();
    var item = S.master.get(q);
    if (item) manualPick(item, q); else renderManual();
  });
  $('manList').addEventListener('click', function (e) {
    var li = e.target.closest('li'); if (!li) return;
    if (li.dataset.raw) return manualPick(null, li.dataset.raw);
    if (li.dataset.i !== undefined) manualPick($('manList')._list[Number(li.dataset.i)]);
  });
  function manualPick(item, raw) {
    modal({ title: 'ป้อนเองใน ' + S.loc, html: item ? '<b>' + esc(item.n) + '</b><br>' + tailHtml(item.c) + ' · ' + esc(item.m) : 'บาร์โค้ด ' + esc(raw) + ' (ไม่รู้จัก)', input: true, value: S.qty || '1', yes: 'บันทึก' })
      .then(function (v) {
        if (v === null) return;
        if (badNumber(v)) return;
        var qty = parseInt(v, 10);
        if (!(qty > 0)) { toast('ใส่จำนวนมากกว่า 0', true); return; }
        return qtyCheck(qty, item ? item.n : raw).then(function (yes) { if (yes) return save(qty); });
      });
    function save(qty) {
        return addEntry({ barcode: item ? item.b : raw, material: item ? item.m : '', qty: qty, type: 'MANUAL', reason: 'ป้อนเอง' }).then(function () {
          S.qty = ''; if (item) SOUND.ok(); else SOUND.warn();
          setSku(item); setCard(item ? 'ok' : 'warn', item ? item.n : 'บาร์โค้ดไม่รู้จัก ' + raw, item ? codeLine(item.c, item.b) : '', '+' + fmt(qty) + ' (ป้อนเอง)');
          show('count');
        });
    }
  }
  $('btnManBack').onclick = function () { show('count'); };

  // ---------- สถานะ / Export ----------
  function renderStatus() {
    var p = pending().length, rej = S.entries.filter(function (e) { return e.rejected; });
    var rows = [
      ['เครื่อง', S.cfg.deviceId || '-'], ['รอบ', S.projectId || '-'], ['ผู้ตรวจสอบ', S.staff ? S.staff.code : '-'],
      ['รายการที่บันทึก', fmt(S.entries.length)], ['รายการที่ส่งแล้ว', fmt(S.entries.length - p - rej.length)], ['รายการค้างส่ง', fmt(p)],
      ['ยอดรวมทั้งเครื่อง (ชิ้น)', fmt(deviceTotal())],
      ['เซิร์ฟเวอร์ไม่รับ', fmt(rej.length)], ['ข้อมูลรอบอื่นค้างส่ง', fmt(S.oldPending.length)], ['รอตรวจ Location', fmt(S.events.length)],
      ['ส่งสำเร็จล่าสุด', S.lastSyncOk ? stamp(new Date(S.lastSyncOk)).slice(11) : '-'], ['เชื่อมต่อ', S.online === false ? 'ออฟไลน์' : S.slow ? 'เซิร์ฟเวอร์ช้า/มีปัญหา (' + S.slow + ')' : S.online ? 'ออนไลน์' : '-'],
      ['รายการบาร์โค้ด', fmt(S.master.size) + ' · ' + (S.masterHash || '-')], ['เวอร์ชัน', 'แอป ' + APP_VERSION + ' · เซิร์ฟเวอร์ ' + (S.serverVersion || '-') + (S.latestVersion && S.latestVersion !== APP_VERSION ? ' (มีแอป ' + S.latestVersion + ')' : '')]
    ];
    // เวลาตอบของเซิร์ฟเวอร์ตั้งแต่เปิดแอป (v2.2.6) — ใช้ตัดสินใจปรับระบบ (ขั้น C)
    var sec = function (ms) { return (ms / 1000).toFixed(1); };
    var PNAME = { sync: 'ส่งข้อมูล', locInfo: 'ถามสถานะ', hello: 'รายงานตัว', myLocs: 'รายการ Loc', bootstrap: 'ตรวจพร้อม' };
    var pr = perfReport(), prow = [];
    Object.keys(PNAME).forEach(function (k) {
      var x = pr[k]; if (!x || !(x.n || x.to || x.err || x.off)) return;
      prow.push('<tr><td>' + PNAME[k] + '</td><td>' + x.n + '</td><td>' + sec(x.avg) + '</td><td>' + sec(x.max) + '</td><td' + (x.to ? ' class="bad"' : '') + '>' + x.to + '</td><td>' + x.off + '</td><td' + (x.err ? ' class="bad"' : '') + '>' + x.err + '</td></tr>');
      if (k === 'sync' && x.n) prow.push('<tr class="sub"><td colspan="7">ส่งข้อมูล: ที่เซิร์ฟเวอร์ ' + sec(x.srv) + ' · รอคิว ' + sec(x.wait) + ' · บันทึก ' + sec(x.hold) + ' วิ (เฉลี่ย)</td></tr>');
      var L = S.lastProf;
      if (k === 'sync' && L) {
        var q = L.p, ms = function (v) { return Number(v) || 0; };
        prow.push('<tr class="sub"><td colspan="7">ครั้งล่าสุด (' + L.n + ' รายการ' + (L.ev ? ' + ' + L.ev + ' เหตุการณ์' : '') + '): บันทึก ' + ms(L.hold) + ' ms = ดัชนี ' + ms(q.index) +
          ' · เขียนแถว ' + ms(q.append) + ' · Location ' + ms(q.events) + ' · สถานะ ' + ms(q.refresh) + ' · เก็บดัชนี ' + ms(q.save) + ' · flush ' + ms(q.flush) +
          (q.audit !== undefined ? ' · ตรวจทาน ' + ms(q.audit) : '') + (q.fixed ? ' · <b>แก้ดัชนี ' + q.fixed + ' จุด</b>' : '') +
          (q.rebuilt ? ' · <b>สร้างดัชนีใหม่</b>' : '') + '</td></tr>');
      }
    });
    $('perfBox').innerHTML = prow.length ? '<div class="muted">เวลาตอบของเซิร์ฟเวอร์ ตั้งแต่เปิดแอป (วินาที)</div><table class="perf"><tr><th></th><th>ครั้ง</th><th>เฉลี่ย</th><th>ช้าสุด</th><th>หมดเวลา</th><th>ออฟไลน์</th><th>ผิดพลาด</th></tr>' + prow.join('') + '</table>' : '';
    $('statusKv').innerHTML = rows.map(function (r) { return '<div>' + esc(r[0]) + '</div><div>' + esc(r[1]) + '</div>'; }).join('') +
      (rej.length ? '<div>ไม่รับ</div><div>' + rej.slice(0, 5).map(function (e) { return esc(e.logId + ' ' + e.rejected); }).join('<br>') + '</div>' : '');
  }
  $('btnSyncNow').onclick = function () { syncNow(true).then(function () { toast(S.online ? 'ส่งแล้ว' : 'ยังติดต่อเซิร์ฟเวอร์ไม่ได้', !S.online); renderStatus(); }); };
  $('btnExport').onclick = function () { exportFile(false); };
  $('btnRecheck').onclick = function () { show('ready'); runChecks(false); };
  $('btnStatusBack').onclick = function () { show(S.readiness && S.readiness.pass ? 'count' : 'ready'); };
  $('btnClearOld').onclick = function () {
    DB.all('entries').then(function (all) {
      var old = all.filter(function (e) { return e.projectId !== S.projectId; });
      var unsent = old.filter(function (e) { return !e.synced && !e.rejected; });
      if (unsent.length) { toast('ยังมีข้อมูลรอบเก่าค้างส่ง ' + unsent.length + ' รายการ ส่งหรือ Export ก่อน', true); return; }
      if (!old.length) { toast('ไม่มีข้อมูลรอบเก่า'); return; }
      confirmBox('ล้างข้อมูลรอบเก่า', old.length + ' รายการที่ส่งครบแล้ว', 'ล้าง').then(function (y) {
        if (y) DB.remove('entries', old.map(function (e) { return e.logId; })).then(function () { toast('ล้างแล้ว'); });
      });
    });
  };
  $('btnUnpair').onclick = function () {
    if (pending().length || S.oldPending.length || S.events.length) { toast('ยังมีข้อมูลค้างส่ง ส่งหรือ Export ก่อน', true); return; }
    confirmBox('ยกเลิกการจับคู่', 'ต้องใช้รหัสจับคู่ใหม่จากหัวหน้าทีมจึงจะใช้เครื่องนี้ได้อีก', 'ยกเลิกการจับคู่').then(function (y) {
      if (!y) return;
      // แจ้งเซิร์ฟเวอร์ก่อน ให้หน้า Admin ขึ้น "ยังไม่จับคู่" ตรงกับเครื่อง
      return api('unpair', { staff: S.staff ? S.staff.code : '' }, 10000).then(function () { return true; }, function (err) {
        if (err && (err.code === 'BAD_TOKEN' || err.code === 'DEVICE_DISABLED' || err.code === 'UNKNOWN_DEVICE')) return true;   // เซิร์ฟเวอร์ยกเลิกไว้แล้ว
        return confirmBox('ติดต่อเซิร์ฟเวอร์ไม่ได้', 'หน้า Admin จะยังขึ้นว่าเครื่องนี้จับคู่อยู่ ให้แจ้งหัวหน้าทีมกด "ยกเลิกเครื่อง" ในหน้า Admin', 'ยกเลิกการจับคู่ต่อ');
      }).then(function (go) {
        if (!go) return;
        return resetPairing().then(function () { show('setup'); toast('ยกเลิกการจับคู่แล้ว'); });
      });
    });
  };

  function renderRevoked() {
    var p = pending(), seqs = p.map(function (e) { return e.seq; });
    $('revWhy').textContent = S.revoked === 'DEVICE_DISABLED' ? 'หัวหน้าทีมยกเลิกเครื่องนี้ในหน้า Admin' :
      S.revoked === 'UNKNOWN_DEVICE' ? 'ไม่พบรหัสเครื่องนี้ในระบบ' : 'รหัสยืนยันของเครื่องใช้ไม่ได้แล้ว (ถูกยกเลิก หรือจับคู่รหัสนี้กับเครื่องอื่น)';
    $('revKv').innerHTML = [['เครื่อง', S.cfg.deviceId || '-'], ['รายการในเครื่อง', fmt(S.entries.length)],
      ['ค้างส่ง', p.length ? fmt(p.length) + ' รายการ (Seq ' + Math.min.apply(null, seqs) + '–' + Math.max.apply(null, seqs) + ')' : '0'],
      ['รอตรวจ Location', fmt(S.events.length)]]
      .map(function (r) { return '<div>' + esc(r[0]) + '</div><div>' + esc(r[1]) + '</div>'; }).join('');
  }
  $('btnRePair').onclick = function () {
    $('setDevice').value = S.cfg.deviceId || ''; $('setCode').value = '';
    $('setApi').value = S.cfg.apiUrl || S.defaultApi || '';
    show('setup');
    var p = pending().length;
    setupMsg('ใส่รหัสจับคู่ 6 หลักจากหัวหน้าทีม (หน้า Admin: เปิดใช้ → สร้างรหัสจับคู่)' + (p ? ' — ค้างส่ง ' + p + ' รายการจะส่งต่อหลังจับคู่' : ''), true);
    $('btnSetupBack').classList.remove('hidden');
    setTimeout(function () { $('setCode').focus(); }, 50);
  };
  $('btnSetupBack').onclick = function () { $('btnSetupBack').classList.add('hidden'); show('revoked'); };
  $('btnRevExport').onclick = function () { exportFile(false); };

  /** หลังยกเลิกการจับคู่: ล้าง token และสถานะ Location ของรอบนี้ (ข้อมูลที่นับไว้ส่งครบแล้วจึงยกเลิกได้ ยังเก็บไว้ในเครื่อง) */
  function resetPairing() {
    S.cfg.token = ''; S.lastErr = '';
    S.roles = {}; S.locChecks = {}; S.info = {}; S.myLocs = {}; S.loc = null; S.staff = null;
    // v2.3.8: ล้างผลตรวจความพร้อมด้วย — เดิมข้อ DataWedge ผ่านจากค่าเก่า ทำให้จับคู่ใหม่แล้วเริ่มนับได้โดยยังไม่ยิงบัตร
    S.dwOk = false; S.readiness = null;
    return Promise.all([DB.set('cfg', S.cfg), DB.set('readiness', null), saveState()]);
  }

  function csvCell(v) { var s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportFile(auto) {
    var cols = ['Log_ID', 'Project_ID', 'Device_ID', 'Seq', 'Staff', 'Location', 'Barcode', 'Material', 'Qty', 'Type', 'Ref_ID', 'Reason', 'Note', 'Scan_Time'];
    var list = S.entries.concat(S.oldPending).sort(function (a, b) { return a.seq - b.seq; });
    var lines = ['#STOCKCOUNT_EXPORT,v1,' + S.cfg.deviceId + ',' + S.projectId + ',' + stamp(), cols.join(',')];
    var qty = 0, maxSeq = 0;
    list.forEach(function (e) {
      qty += e.qty; maxSeq = Math.max(maxSeq, e.seq);
      lines.push([e.logId, e.projectId, e.deviceId, e.seq, e.staff, e.location, e.barcode, e.material, e.qty, e.type, e.refId, e.reason, e.note, e.scanTime].map(csvCell).join(','));
    });
    lines.push('#SUMMARY,' + list.length + ',' + Math.round(qty * 1000) / 1000 + ',' + maxSeq);
    var name = 'SC_' + S.projectId + '_' + S.cfg.deviceId + '_' + stamp().replace(/[-: ]/g, '').slice(0, 14) + (auto ? '_auto' : '') + '.csv';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    toast((auto ? 'สำรองอัตโนมัติ: ' : 'บันทึกไฟล์ ') + name + ' ใน Downloads');
  }

  // ---------- ตั้งค่า / จับคู่ ----------
  function setupMsg(t, ok) { var m = $('setupMsg'); m.textContent = t; m.className = 'msg ' + (ok ? 'ok' : 'err'); }
  $('setDevice').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); this.value = this.value.trim().toUpperCase().replace(/^DEV:/, ''); $('setCode').focus(); }
  });
  $('btnPair').onclick = function () {
    var dev = $('setDevice').value.trim().toUpperCase().replace(/^DEV:/, '');
    var code = $('setCode').value.trim();
    var apiUrl = $('setApi').value.trim() || S.defaultApi;
    if (!/^[A-Z0-9-]+$/.test(dev)) return setupMsg('ใส่รหัสเครื่อง เช่น TC21-01');
    if (!/^\d{6}$/.test(code)) return setupMsg('รหัสจับคู่ต้องเป็นตัวเลข 6 หลัก');
    if (!/^(https:\/\/|http:\/\/localhost[:/])/.test(apiUrl)) return setupMsg('ยังไม่มีที่อยู่เซิร์ฟเวอร์ (ใส่ในหัวข้อ "ที่อยู่เซิร์ฟเวอร์")');
    var oldId = S.cfg.deviceId, p = pending(), seqs = p.map(function (e) { return e.seq; });
    if (oldId && dev !== oldId && (p.length || S.events.length || S.oldPending.length)) {
      return setupMsg('เครื่องนี้มีข้อมูลของ ' + oldId + ' ค้างส่ง ' + (p.length + S.oldPending.length) + ' รายการ ต้องจับคู่เป็น ' + oldId + ' (หรือ Export ไฟล์ให้หัวหน้าทีมนำเข้าก่อน)');
    }
    S.cfg = { apiUrl: apiUrl, deviceId: dev, token: '' };
    setupMsg('กำลังจับคู่…', true);
    api('pair', { code: code, pendingCount: p.length, pendingFrom: seqs.length ? Math.min.apply(null, seqs) : 0, pendingTo: seqs.length ? Math.max.apply(null, seqs) : 0,
      staff: S.staff ? S.staff.code : '' }, 20000).then(function (r) {
      S.cfg.token = r.token; S.lastErr = ''; S.revoked = ''; DB.set('revoked', '');
      // จับคู่ (ใหม่) ทุกครั้ง = ตรวจความพร้อมใหม่ทั้งหมด รวมยิงบัตรผู้ตรวจสอบ (v2.3.8)
      S.dwOk = false; S.readiness = null; S.staff = null; DB.set('readiness', null); DB.set('staff', null);
      $('btnSetupBack').classList.add('hidden');
      return bumpSeq(r.maxSeqAll).then(function () { return DB.set('cfg', S.cfg); }).then(function () { setupMsg('จับคู่สำเร็จ: ' + r.deviceName, true); show('ready'); runChecks(false); });
    }, function (e) { setupMsg((e && e.message) || 'จับคู่ไม่สำเร็จ'); });
  };

  // ---------- ตรวจความพร้อม ----------
  function downloadMaster() {
    return api('master', {}, 30000).then(function (r) {
      var rows = r.rows.map(function (x) { return { k: x[0] || 'M:' + x[1], b: x[0], m: x[1], c: x[2], n: x[3] }; });
      return DB.putMany('master', rows, true).then(function () {
        S.masterHash = r.hash; S.masterProject = r.projectId; S.masterChanged = false;
        return Promise.all([DB.set('masterHash', r.hash), DB.set('masterProject', r.projectId), DB.set('masterVersion', r.version)]);
      }).then(loadMaster);
    });
  }

  /** เลข Seq ในเครื่องต้องไม่ต่ำกว่าที่เซิร์ฟเวอร์เคยได้รับ (กันกรณีข้อมูล Chrome ถูกล้างแล้วจับคู่ใหม่) */
  function bumpSeq(serverMax) {
    serverMax = Number(serverMax) || 0;
    return DB.get('seq').then(function (cur) { if (serverMax > (cur || 0)) return DB.set('seq', serverMax); });
  }

  function downloadStock() {
    return api('stock', {}, 30000).then(function (r) {
      var m = new Map();
      r.rows.forEach(function (x) { m.set(x[0], Number(x[1]) || 0); });
      S.stock = m; S.stockSource = r.source; S.stockVersion = r.version;
      if (S.view === 'count') renderSku();
      return DB.set('stock', { projectId: r.projectId, version: r.version, source: r.source, rows: r.rows });
    });
  }

  function switchProject(pid) {
    if (pid === S.projectId) return Promise.resolve();
    return loadEntries(pid).then(function () {
      return Promise.all([DB.get('closedLocs_' + pid), DB.get('locChecks_' + pid), DB.get('loc'), DB.get('roles_' + pid), DB.get('knownNames_' + pid), DB.get('myLocs_' + pid)]);
    }).then(function (v) {
      S.locChecks = v[1] || {}; S.roles = v[3] || {}; S.knownNames = v[4] || []; S.info = {}; S.myLocs = (v[5] && v[5].locs) || {}; S.myLocsAt = (v[5] && v[5].at) || '';
      // ข้อมูลจากรุ่นก่อน 2.2.0: Location ที่ปิดแล้ว = ผู้ดูแลที่ปิดแล้ว
      (v[0] || []).forEach(function (l) { if (!S.roles[l]) S.roles[l] = { role: 'OWNER', state: 'CLOSED' }; });
      var lastLoc = v[2];
      // กลับไป Location เดิม: มีรายการแล้ว หรือยังเปิดนับอยู่ (v2.3.8 — เดิมเปิด Location แล้วยังไม่ยิง ปิดเปิดแอปใหม่จะหลุดออก)
      var lr = lastLoc && S.roles[lastLoc];
      S.loc = lastLoc && (S.entries.some(function (e) { return e.location === lastLoc; }) || (lr && lr.state === 'COUNTING')) ? lastLoc : null;
      return DB.set('projectId', pid);
    });
  }

  function runChecks(quick) {
    var items = [];
    function add(title, result, hint) { items.push({ title: title, result: result, hint: hint || '' }); }
    $('readyHead').textContent = 'กำลังตรวจ…';
    $('btnStart').classList.add('hidden');
    var bootP = quick && S.boot ? Promise.resolve({ ok: true, cached: false, boot: S.boot, fresh: true }) :
      api('bootstrap', {}, 12000).then(function (b) { return { boot: b, fresh: true }; }, function (e) { return { err: e }; });
    var batteryP = navigator.getBattery ? navigator.getBattery().catch(function () { return null; }) : Promise.resolve(null);
    var storeP = DB.persistent().then(function (p) {
      return navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().then(function (e) { return { p: p, free: (e.quota || 0) - (e.usage || 0) }; }) : { p: p, free: Infinity };
    }).catch(function () { return { p: false, free: 0 }; });
    var verP = quick ? Promise.resolve() : loadConfigJson();

    return Promise.all([bootP, batteryP, storeP, verP]).then(function (v) {
      var b = v[0], bat = v[1], st = v[2];
      var offline = b.err && b.err.code === 'NETWORK';
      var chain = Promise.resolve();
      if (b.boot) {
        S.boot = b.boot; DB.set('boot', b.boot);
        chain = bumpSeq(b.boot.device && b.boot.device.maxSeqAll).then(function () { return switchProject(b.boot.project.id); });
      }
      return chain.then(function () {
        var boot = S.boot;
        // 1 เวอร์ชันแอป
        if (!S.latestVersion) add('แอปเป็นเวอร์ชันล่าสุด', 'WARN', 'ตรวจไม่ได้ (ออฟไลน์) ใช้เวอร์ชัน ' + APP_VERSION);
        else if (S.latestVersion !== APP_VERSION) add('แอปเป็นเวอร์ชันล่าสุด', 'FAIL', 'มีเวอร์ชัน ' + S.latestVersion + ' (เครื่องนี้ ' + APP_VERSION + ') — กดปุ่ม "อัปเดตแอปตอนนี้" ด้านล่าง');
        else add('แอปเป็นเวอร์ชันล่าสุด', 'OK', 'แอป ' + APP_VERSION + (S.serverVersion ? ' · เซิร์ฟเวอร์ ' + S.serverVersion : ''));
        // เลขเดียวทั้งระบบ: ถ้าไม่ตรง แปลว่าอัปเดตไม่ครบฝั่ง (เช่น ลืม Deploy New version ของ Apps Script)
        // MAJOR.MINOR ต่างกัน = ฟีเจอร์ไม่ตรงกัน (เช่น 2.2 ต้องใช้เซิร์ฟเวอร์ที่รู้จักผู้ดูแล/ผู้ช่วย) → ห้ามเริ่มนับ · ต่างแค่ PATCH = เตือน
        if (S.serverVersion && S.serverVersion !== APP_VERSION) {
          var mm = function (v) { return String(v).split('.').slice(0, 2).join('.'); };
          add('แอปกับเซิร์ฟเวอร์เป็นรุ่นเดียวกัน', mm(S.serverVersion) !== mm(APP_VERSION) ? 'FAIL' : 'WARN', 'แอป ' + APP_VERSION + ' · เซิร์ฟเวอร์ ' + S.serverVersion +
            (mm(S.serverVersion) !== mm(APP_VERSION) ? ' — หัวหน้าทีมต้อง Deploy New version ของ Apps Script ก่อน' : ' — แจ้งหัวหน้าทีมตรวจสอบ'));
        }
        // 2 จับคู่
        add('เครื่องผูกรหัสเครื่องแล้ว', S.cfg.token ? 'OK' : 'FAIL', S.cfg.deviceId || '');
        // 3 เซิร์ฟเวอร์
        if (b.boot) add('เชื่อมต่อเซิร์ฟเวอร์ได้', 'OK');
        else if (offline) add('เชื่อมต่อเซิร์ฟเวอร์ได้', 'WARN', 'ออฟไลน์ — นับแบบออฟไลน์ได้ถ้ารายการบาร์โค้ดอยู่ในเครื่องแล้ว');
        else add('เชื่อมต่อเซิร์ฟเวอร์ได้', 'FAIL', (b.err && b.err.message) || 'ผิดพลาด');
        // 4 รอบนับ + token
        if (!boot) add('รอบที่เลือกเปิดอยู่ และ token ถูกต้อง', 'FAIL', 'ยังไม่เคยเชื่อมต่อเซิร์ฟเวอร์');
        else if (b.err && !offline) add('รอบที่เลือกเปิดอยู่ และ token ถูกต้อง', 'FAIL', b.err.message);
        else if (!boot.project.id || SYNC_OK.indexOf(boot.project.status) < 0) add('รอบที่เลือกเปิดอยู่ และ token ถูกต้อง', 'FAIL', 'รอบ ' + (boot.project.id || '-') + ' สถานะ ' + boot.project.status);
        else add('รอบที่เลือกเปิดอยู่ และ token ถูกต้อง', offline ? 'WARN' : 'OK', boot.project.id + ' · นับวันที่ ' + boot.project.countDate + (offline ? ' (ข้อมูลล่าสุดในเครื่อง)' : ''));
        // 5 Master
        var masterP = Promise.resolve();
        if (boot && b.boot && boot.master.approved && (S.masterHash !== boot.master.hash || S.masterProject !== boot.project.id || !S.master.size)) {
          $('readyHead').textContent = 'กำลังโหลดรายการบาร์โค้ด…';
          masterP = downloadMaster().catch(function (e) { S._masterErr = e.message; });
        }
        if (b.boot) masterP = masterP.then(loadMyLocs);
        if (b.boot && boot.stockVersion && (boot.stockVersion !== S.stockVersion || !S.stock.size)) {
          masterP = masterP.then(function () { return downloadStock().catch(function () {}); });
        }
        return masterP.then(function () {
          if (boot && b.boot && !boot.master.approved) add('รายการบาร์โค้ดตรงเวอร์ชันที่อนุมัติ', 'FAIL', 'Master ยังไม่ได้อนุมัติสำหรับรอบนี้ (หน้า Admin)');
          else if (boot && S.master.size && S.masterHash === boot.master.hash && S.masterProject === boot.project.id) add('รายการบาร์โค้ดตรงเวอร์ชันที่อนุมัติ', offline ? 'WARN' : 'OK', fmt(S.masterList.length) + ' รายการ · v' + (boot.master.version || ''));
          else if (offline && S.master.size && S.masterProject === S.projectId) add('รายการบาร์โค้ดตรงเวอร์ชันที่อนุมัติ', 'WARN', 'ใช้ชุดในเครื่อง (ตรวจเวอร์ชันไม่ได้ตอนออฟไลน์)');
          else add('รายการบาร์โค้ดตรงเวอร์ชันที่อนุมัติ', 'FAIL', S._masterErr || 'ยังไม่มีรายการบาร์โค้ดของรอบนี้ในเครื่อง');
          // 6 รอบเก่าค้าง
          add('ไม่มีข้อมูลรอบเก่าค้างส่ง', S.oldPending.length ? 'FAIL' : 'OK', S.oldPending.length ? S.oldPending.length + ' รายการ — ส่งข้อมูลหรือ Export ก่อน (หน้าสถานะ)' : '');
          // 7 พื้นที่
          var freeMb = Math.round(st.free / 1048576);
          if (!st.p) add('พื้นที่เก็บข้อมูลแบบถาวร และพื้นที่ว่างพอ', 'FAIL', 'ยังไม่ได้สิทธิ์เก็บถาวร — ติดตั้งแอปลงหน้าจอหลัก (เมนู Chrome → ติดตั้งแอป) แล้วเปิดจากไอคอน');
          else if (st.free < 50 * 1048576) add('พื้นที่เก็บข้อมูลแบบถาวร และพื้นที่ว่างพอ', 'FAIL', 'พื้นที่ว่าง ' + freeMb + ' MB');
          else add('พื้นที่เก็บข้อมูลแบบถาวร และพื้นที่ว่างพอ', 'OK', isFinite(freeMb) ? 'ว่าง ' + fmt(freeMb) + ' MB' : '');
          // 8 นาฬิกา
          if (S.serverOffset === null || !b.boot) add('นาฬิกาเครื่องต่างจากเซิร์ฟเวอร์ไม่เกิน 2 นาที', 'WARN', 'ตรวจไม่ได้ตอนออฟไลน์');
          else if (Math.abs(S.serverOffset) > 120000) add('นาฬิกาเครื่องต่างจากเซิร์ฟเวอร์ไม่เกิน 2 นาที', 'FAIL', 'ต่าง ' + Math.round(S.serverOffset / 60000) + ' นาที — ตั้งเวลาเครื่องเป็นอัตโนมัติ');
          else add('นาฬิกาเครื่องต่างจากเซิร์ฟเวอร์ไม่เกิน 2 นาที', 'OK', 'ต่าง ' + Math.round(Math.abs(S.serverOffset) / 1000) + ' วินาที');
          // 9 แบต
          if (!bat) add('แบตเตอรี่ ≥ 50%', 'WARN', 'อ่านค่าไม่ได้');
          else add('แบตเตอรี่ ≥ 50%', bat.level >= 0.5 || bat.charging ? 'OK' : 'WARN', Math.round(bat.level * 100) + '%' + (bat.charging ? ' (กำลังชาร์จ)' : ''));
          // 10 DataWedge
          add('DataWedge: ได้ครบทุกหลักพร้อม Enter', S.dwOk && S.staff ? 'OK' : 'FAIL', S.dwOk && S.staff ? 'ผู้ตรวจสอบ ' + (S.staff ? S.staff.code : '') : 'ยิงบัตรผู้ตรวจสอบ (EMP:) 1 ครั้ง — ต้องยิงบัตรจริง เพื่อทดสอบหัวยิงไปด้วย (บัตรเสีย: พิมพ์ใหม่จากหน้า Admin)');
          // 11 เสียง
          add('เสียงเขียว/เหลือง/แดงดังครบ', $('ckSound').checked ? 'OK' : 'FAIL', $('ckSound').checked ? '' : 'กดทดสอบเสียง แล้วติ๊กยืนยัน');
          // 12 ปักหมุด
          add('ปักหมุดหน้าจอแล้ว', $('ckPin').checked ? 'OK' : 'WARN', $('ckPin').checked ? '' : 'แนะนำให้ปักหมุดก่อนนับ');
          add('ปิดหมุนจออัตโนมัติแล้ว', $('ckRotate').checked ? 'OK' : 'WARN', $('ckRotate').checked ? '' : 'ดึงแถบบนของเครื่องลงมา แล้วปิด "หมุนอัตโนมัติ"');
          var pass = items.every(function (i) { return i.result !== 'FAIL'; });
          S.readiness = { project: S.projectId, date: today(), pass: pass, at: Date.now() };
          DB.set('readiness', S.readiness);
          renderChecks(items, pass);
          if (S.online && S.cfg.token) api('check', { items: items, staff: S.staff ? S.staff.code : '' }, 10000).catch(function () {});
          return pass;
        });
      });
    });
  }

  function renderChecks(items, pass) {
    var sym = { OK: '✓', WARN: '⚠', FAIL: '✗' };
    $('readyHead').innerHTML = pass ? '<b style="color:#1f7a3a">พร้อมนับ ✓</b>' + (items.some(function (i) { return i.result === 'WARN'; }) ? ' (มีข้อเตือน)' : '') : '<b style="color:#b42318">ยังไม่พร้อม — แก้ข้อ ✗ ก่อน</b>';
    $('readyList').innerHTML = items.map(function (i) {
      return '<li><span class="r ' + i.result + '">' + sym[i.result] + '</span><span class="t">' + esc(i.title) + (i.hint ? '<div class="h">' + esc(i.hint) + '</div>' : '') + '</span></li>';
    }).join('');
    $('btnStart').classList.toggle('hidden', !pass);
    $('btnUpdate').classList.toggle('hidden', !(S.latestVersion && S.latestVersion !== APP_VERSION));
  }

  /** อัปเดตแอป: ล้างสำเนาหน้าแอป (ไม่แตะข้อมูลการนับใน IndexedDB) แล้วโหลดใหม่จากเซิร์ฟเวอร์ */
  function updateApp() {
    var jobs = [];
    if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
    if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.update().catch(function () {}); })); }));
    toast('กำลังอัปเดตแอป…');
    Promise.all(jobs).catch(function () {}).then(function () { location.replace('./?v=' + Date.now()); });
  }
  $('btnUpdate').onclick = updateApp;

  $('btnSound').onclick = function () { SOUND.ok(); setTimeout(SOUND.warn, 600); setTimeout(SOUND.bad, 1400); };
  $('ckSound').onchange = $('ckPin').onchange = $('ckRotate').onchange = function () { this.blur(); DB.set('ckRotate', $('ckRotate').checked); runChecks(true); };
  $('btnRunCheck').onclick = function () { runChecks(false); };
  $('btnReload').onclick = function () {
    $('readyHead').textContent = 'กำลังโหลดรายการบาร์โค้ด…';
    downloadMaster().then(function () { toast('โหลดแล้ว ' + fmt(S.masterList.length) + ' รายการ'); runChecks(true); }, function (e) { toast(e.message || 'โหลดไม่สำเร็จ', true); runChecks(true); });
  };
  $('btnStart').onclick = function () { setCard('idle', S.loc ? 'อยู่ที่ ' + S.loc + ' — ยิงสินค้าต่อได้' : 'ยิงป้าย Location เพื่อเริ่ม'); show('count'); };

  // ---------- Wake Lock / แนวตั้ง ----------
  function requestWake() {
    if ('wakeLock' in navigator && !S.wakeLock) navigator.wakeLock.request('screen').then(function (l) { S.wakeLock = l; l.addEventListener('release', function () { S.wakeLock = null; }); }).catch(function () {});
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('portrait').catch(function () {});
  }
  function resume() {
    // กลับเข้าแอปจากแอปอื่น: วาดใหม่ ขอจอไม่ดับ ล็อกแนวตั้ง แล้วส่งข้อมูลที่ค้าง
    $('splash').classList.add('hidden');
    render(); requestWake(); scheduleSync(200);
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') resume(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) resume(); });
  function clearResume() {}

  // ---------- เริ่มต้น ----------
  function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
    return DB.open().then(function () {
      return Promise.all([DB.get('cfg'), DB.get('boot'), DB.get('masterHash'), DB.get('masterProject'), DB.get('projectId'), DB.get('staff'), DB.get('readiness'), DB.all('events'), DB.get('stock'), DB.get('ckRotate'), DB.get('revoked')]);
    }).then(function (v) {
      S.revoked = v[10] || '';
      S.cfg = v[0] || {}; S.boot = v[1] || null; S.masterHash = v[2] || ''; S.masterProject = v[3] || '';
      S.staff = v[5] || null; S.readiness = v[6] || null; S.events = v[7] || [];
      S.events.forEach(function (ev) { if (!ev.at) ev.at = 0; if (ev.at > lastAt) lastAt = ev.at; });
      var st = v[8];
      var pid = (S.boot && S.boot.project.id) || v[4] || '';
      if (st && st.projectId === pid) { S.stockVersion = st.version; S.stockSource = st.source; st.rows.forEach(function (x) { S.stock.set(x[0], Number(x[1]) || 0); }); }
      $('ckRotate').checked = !!v[9];
      // ไฟล์ config ใช้ตอนตั้งค่าเครื่องครั้งแรกเท่านั้น เครื่องที่จับคู่แล้วไม่ต้องรอเน็ต
      var cfgP = S.cfg.token ? (loadConfigJson(), Promise.resolve()) : loadConfigJson();
      return Promise.all([loadMaster(), switchProject(pid), cfgP]);
    }).then(function () {
      if (!S.cfg.apiUrl && S.defaultApi) S.cfg.apiUrl = S.defaultApi;
      $('setApi').value = S.cfg.apiUrl || S.defaultApi || '';
      if (S.cfg.deviceId) $('setDevice').value = S.cfg.deviceId;
      if (!S.cfg.token) { if (S.revoked) { S.revoked = ''; DB.set('revoked', ''); } show('setup'); return; }
      if (S.revoked) { show('revoked'); return; }
      var r = S.readiness;
      if (r && r.pass && r.project === S.projectId && r.date === today() && S.staff) {
        S.dwOk = true;
        var last = S.entries.length ? S.entries[S.entries.length - 1] : null;
        show('count'); scheduleSync(500);
        // แจ้งในการ์ด (ไม่เพิ่มแถบ จะได้ไม่ดันปุ่มตกขอบจอ)
        if (last) setCard('idle', 'กลับมาทำงานต่อ' + (S.loc ? 'ที่ ' + S.loc : '') + ' · ยิงล่าสุด ' + String(last.scanTime).slice(11, 16),
          'ข้อมูลในเครื่องครบ ' + fmt(S.entries.length) + ' รายการ', S.loc ? 'ยิงสินค้าต่อได้เลย' : 'ยิงป้าย Location เพื่อเริ่ม');
        else if (S.loc) setCard('idle', 'อยู่ที่ ' + S.loc + ' — ยิงสินค้าต่อได้');
      } else { show('ready'); runChecks(false); }
    }).then(function () {
      window.__SC_READY = true;
      $('splash').classList.add('hidden');
    }, function (err) {
      $('splash').querySelector('.spl-t').textContent = 'เปิดแอปไม่สำเร็จ: ' + (err && err.message || err);
      $('splashReload').classList.remove('hidden');
    });
  }

  window.__SC = { S: S, handleScan: handleScan, syncNow: syncNow, locSummary: locSummary, exportFile: exportFile };
  init();
})();
