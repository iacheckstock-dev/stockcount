/* app.js — เว็บแอปตรวจนับบน Zebra TC21 (เฟส 2)
 * หลักการ: ทุกการยิงบันทึกลงเครื่อง (IndexedDB) ก่อนเสมอ แล้วส่งขึ้นเซิร์ฟเวอร์เป็นชุด
 * เซิร์ฟเวอร์กันซ้ำด้วย Log_ID = รหัสเครื่อง-Seq จึงส่งซ้ำกี่ครั้งก็ไม่นับเกิน
 */
(function () {
  'use strict';

  var APP_VERSION = '2.2.0';
  var QTY_CONFIRM = 150;      // จำนวนที่ป้อนเองเกินนี้ต้องยืนยันอีกครั้ง
  var QTY_MAX_DIGITS = 5;     // ยาวกว่านี้ = น่าจะยิงบาร์โค้ดเข้าช่องจำนวน
  var INFO_EVERY = 15000;     // ถามสถานะผู้ช่วย/ผู้ดูแลระหว่างนับร่วมกัน
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
  function modal(opt) {
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
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 20000);
    if (ctl) opt.signal = ctl.signal;
    return fetch(url, opt).finally(function () { clearTimeout(timer); });
  }

  function api(action, body, ms) {
    if (!S.cfg.apiUrl) return Promise.reject({ code: 'NO_API', message: 'ยังไม่ได้ตั้งที่อยู่เซิร์ฟเวอร์' });
    var payload = Object.assign({ action: action, deviceId: S.cfg.deviceId, token: S.cfg.token, appVersion: APP_VERSION }, body || {});
    var t0 = Date.now();
    return fetchTimeout(S.cfg.apiUrl, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' }, ms)
      .then(function (r) { return r.json(); }, function (e) { throw { code: 'NETWORK', message: 'ติดต่อเซิร์ฟเวอร์ไม่ได้' }; })
      .then(function (res) {
        if (res.serverTime) S.serverOffset = res.serverTime - (t0 + Date.now()) / 2;
        if (res.serverVersion) S.serverVersion = res.serverVersion;
        setOnline(true);
        if (!res.ok) throw { code: res.error, message: res.message || res.error };
        return res;
      }, function (e) { if (e && e.code === 'NETWORK') setOnline(false); throw e; });
  }

  function setOnline(on) {
    S.online = on;
    if (on) S.lastErr = '';
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
      if (e.type === 'RECOUNT_SET' || (e.type === 'VOID' && /แก้/.test(e.reason))) it.edits++;
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
  function combinedSummary(loc) {
    var mine = locSummary(loc), oth = othersOf(loc);
    var items = new Map(), qty = mine.qty;
    mine.items.forEach(function (it, k) { items.set(k, Object.assign({}, it, { mine: it.qty, others: 0 })); });
    oth.items.forEach(function (x) {
      var k = x[0], it = items.get(k);
      if (!it) { it = { key: k, material: x[1], barcode: x[2], qty: 0, mine: 0, others: 0, edits: 0, lines: 0 }; items.set(k, it); }
      it.others = x[3]; it.qty = Math.round((it.mine + it.others) * 1000) / 1000;
      if (!it.barcode && x[2]) it.barcode = x[2];
      qty += x[3];
    });
    var sku = 0;
    items.forEach(function (it) { if (it.qty !== 0) sku++; });
    return { qty: Math.round(qty * 1000) / 1000, sku: sku, items: items, mine: mine, othersQty: oth.qty, multi: hasOthers(loc) };
  }
  /** ถามเซิร์ฟเวอร์ว่าใครอยู่ใน Location นี้ (ล้มเหลว/ออฟไลน์ = null) */
  function fetchInfo(loc, ms) {
    if (S.online === false || !S.cfg.token) return Promise.resolve(null);
    return api('locInfo', { location: loc }, ms || 4000).then(function (r) {
      S.info[loc] = r;
      if (r.me) setRole(loc, { role: r.me.role, state: S.loc === loc && r.me.state !== 'CLOSED' ? 'COUNTING' : r.me.state, owner: r.owner ? r.owner.device : '', ownerLabel: r.owner ? memberLabel(r.owner) : '' });
      if (S.view === 'count' || S.view === 'loc') render();
      return r;
    }, function () { return null; });
  }
  setInterval(function () {
    if (!S.loc || S.online === false || S.syncing || !$('modal').classList.contains('hidden')) return;
    if (S.view === 'loc' || (S.view === 'count' && (hasOthers(S.loc) || isHelper()))) fetchInfo(S.loc);
  }, INFO_EVERY);

  function deviceTotal() { return Math.round(S.entries.reduce(function (a, e) { return a + e.qty; }, 0) * 1000) / 1000; }
  function pending() { return S.entries.filter(function (e) { return !e.synced && !e.rejected; }); }
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
          fromSeq: ev.fromSeq, upToSeq: ev.upToSeq, total: ev.total, auto: ev.auto, at: ev.at };
      })
    };
    return api('sync', payload, 30000).then(function (res) {
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
          toast(r.role === 'HELPER' ? r.location + ' มีผู้ดูแลแล้ว (' + r.owner + ') — เครื่องนี้เป็นผู้ช่วย' : 'เครื่องนี้เป็นผู้ดูแล ' + r.location, r.role === 'HELPER');
          fetchInfo(r.location);
        }
      });
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
  setInterval(function () { if (S.cfg.apiUrl && S.cfg.token && !S.syncing) api('ping', {}, 8000).catch(function () {}); }, 60000);
  window.addEventListener('online', function () { scheduleSync(200); });
  window.addEventListener('offline', function () { setOnline(false); });

  // ---------- หน้าจอ ----------
  function show(v) {
    S.view = v;
    document.querySelectorAll('.view').forEach(function (el) { el.classList.toggle('on', el.id === 'v-' + v); });
    window.scrollTo(0, 0);
    if (v === 'count') { requestWake(); renderCount(); }
    if (v === 'loc') { renderLoc(); fetchInfo(S.loc); }
    if (v === 'status') renderStatus();
    if (v === 'locs') { renderLocs(); loadMyLocs(); }
    if (v === 'manual') { $('manQ').value = ''; renderManual(); setTimeout(function () { $('manQ').focus(); }, 50); }
    renderTop();
  }

  function renderTop() {
    $('tbLoc').textContent = S.loc || '—';
    var helper = S.loc && isHelper();
    var rr = S.loc && S.roles[S.loc];
    $('tbRole').textContent = !S.loc ? '' : helper ? 'ผู้ช่วย' : hasOthers(S.loc) && rr && rr.owner === S.cfg.deviceId ? 'ผู้ดูแล' : '';
    $('tbRole').className = helper ? 'helper' : '';
    $('tbStaff').textContent = S.staff ? (S.staff.name || S.staff.code) : 'ยังไม่เข้างาน';
    var p = pending().length;
    var synced = S.entries.length - p - S.entries.filter(function (e) { return e.rejected; }).length;
    $('syncText').textContent = 'สแกน ' + fmt(S.entries.length) + ' · ส่ง ' + fmt(synced) + ' · ค้าง ' + fmt(p);
    $('netDot').className = 'dot ' + (S.syncing ? 'busy' : S.online === true ? 'on' : S.online === false ? 'off' : '');
    renderBanner();
  }

  function renderBanner() {
    var b = $('banner'), msg = '', bad = false;
    var p = pending();
    var oldest = p.length ? Math.min.apply(null, p.map(function (e) { return e.createdAt; })) : 0;
    var rejected = S.entries.filter(function (e) { return e.rejected; }).length;
    if (S.lastErr === 'BAD_TOKEN' || S.lastErr === 'DEVICE_DISABLED' || S.lastErr === 'UNKNOWN_DEVICE') { msg = 'เครื่องนี้ถูกยกเลิกหรือต้องจับคู่ใหม่ ข้อมูลในเครื่องไม่หาย ให้ Export ไฟล์ แล้วแจ้งหัวหน้าทีม'; bad = true; }
    else if (oldest && Date.now() - oldest > STALE_MIN * 60000) { msg = 'มีรายการค้างส่งเกิน ' + STALE_MIN + ' นาที — ไปจุดที่มี Wi-Fi หรือ Export ไฟล์'; bad = true; }
    else if (rejected) { msg = 'มี ' + rejected + ' รายการที่เซิร์ฟเวอร์ไม่รับ ดูที่หน้าสถานะ'; bad = true; }
    else if (S.masterChanged) msg = 'หัวหน้าทีมอนุมัติรายการบาร์โค้ดชุดใหม่ ไปที่สถานะ → ตรวจความพร้อมใหม่ เพื่อโหลด';
    else if (S.recountBanner && S.view === 'count') msg = S.recountBanner;
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
    $('locSku').textContent = sum.multi ? 'ของฉัน ' + fmt(sum.mine.qty) + ' · ' + (S.info[S.loc].members.length) + ' เครื่อง' :
      fmt(sum.sku) + ' SKU' + (S.loc && S.locChecks[S.loc] === 'OK' ? ' · ✓ ส่งครบ' : '');
    $('locLbl').textContent = sum.multi ? 'ยอดรวม Location (ทุกเครื่อง)' : 'ยอดรวม Location';
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
    if (e.key === 'Enter') { var code = buf; buf = ''; if (code) handleScan(code); e.preventDefault(); return; }
    if (e.key && e.key.length === 1) {
      if (Date.now() - bufAt > 800) buf = '';
      buf += e.key; bufAt = Date.now();
    }
  });

  function handleScan(raw) {
    var code = String(raw).trim(), up = code.toUpperCase();
    if (!code) return;
    if (S.view === 'setup') { if (/^DEV:/.test(up)) $('setDevice').value = up.slice(4); return; }
    if (/^EMP:/.test(up)) return setStaff(up.slice(4));
    if (/^DEV:/.test(up)) { toast('นี่คือสติกเกอร์เครื่อง ' + up.slice(4)); return; }
    if (S.view === 'ready') { toast('ยิงบัตรผู้ตรวจสอบ (EMP:) เพื่อทดสอบ', true); return; }
    if (S.view === 'status') return;
    if (/^LOC:/.test(up)) { var loc = normLoc(up); if (!loc) { SOUND.bad(); toast('ป้าย Location ไม่ถูกต้อง', true); return; } return openLocation(loc); }
    if (S.view !== 'count') show('count');
    scanProduct(code);
  }

  function setStaff(code) {
    var list = (S.boot && S.boot.staff) || [];
    var s = list.find(function (x) { return x.code === code; });
    if (!s) { SOUND.bad(); toast('ไม่พบรหัสผู้ตรวจสอบ ' + code, true); return; }
    S.staff = { code: s.code, name: s.name };
    S.dwOk = true;
    SOUND.ok();
    toast('เข้างาน: ' + (s.name || s.code));
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
    if (!S.staff) { SOUND.bad(); setCard('bad', 'ยิงบัตรผู้ตรวจสอบ (EMP:) ก่อน'); show('count'); return Promise.resolve(); }
    if (S.loc === loc) { show('count'); toast('อยู่ที่ ' + loc + ' แล้ว'); return Promise.resolve(); }
    var r = S.roles[loc] || null;
    var ask = Promise.resolve(true);
    if (r && r.role === 'OWNER' && r.state === 'CLOSED') {
      var s0 = combinedSummary(loc);
      ask = confirmBox(loc + ' ปิดไปแล้ว', 'ยอดตอนปิด ' + fmt(s0.qty) + ' ชิ้น ' + s0.sku + ' SKU<br>ต้องการเปิดเพื่อนับเพิ่มหรือแก้ไข?', 'เปิดนับเพิ่ม');
    } else if (r && r.role === 'HELPER' && r.state === 'SUBMITTED') {
      ask = confirmBox('กลับไปช่วย ' + loc + ' อีกครั้ง?', 'ส่งงานไปแล้ว <b>' + fmt(locSummary(loc).qty) + '</b> ชิ้น ยอดเดิมยังอยู่ ยิงเพิ่มต่อจากเดิม' +
        (r.owner ? '<br><span class="muted">ผู้ดูแล ' + esc(r.ownerLabel || r.owner) + '</span>' : ''), 'กลับไปช่วย');
    }
    return ask.then(function (ok) {
      if (!ok) { show('count'); return; }
      var prev = S.loc;
      return (prev ? leaveLocation(prev) : Promise.resolve()).then(function () {
        S.loc = loc; S.recountBanner = ''; S.lastSku = null; clearResume();
        var known = S.roles[loc];
        setRole(loc, { role: known ? known.role : 'OWNER', state: 'COUNTING' });
        SOUND.ok();
        setCard('idle', (r && r.state === 'PAUSED' ? 'กลับมานับต่อ ' + loc + ' (พักไว้)' : 'เปิด ' + loc + ' แล้ว') + ' — ยิงสินค้าได้เลย',
          prev ? (isHelperBefore(prev) ? 'ส่งงาน ' + prev + ' ให้อัตโนมัติแล้ว' : prev + ' พักไว้ (ยังไม่ปิด)') : '');
        show('count');
        return saveState().then(function () { return checkOwner(loc, r); });
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

  /** เช็กเบื้องหลังหลังเปิด: ใครเป็นผู้ดูแล (ออฟไลน์ = ไม่ถาม ให้เซิร์ฟเวอร์ตัดสินตอนส่งข้อมูล) */
  function checkOwner(loc, before) {
    var sendOpen = function (type) { return addEvent(type || 'OPEN', loc); };
    return fetchInfo(loc, 3000).then(function (info) {
      if (S.loc !== loc) return;
      if (!info) return sendOpen(isHelper(loc) ? 'JOIN' : 'OPEN');
      var o = info.owner, me = info.me;
      var otherOwner = o && o.device !== S.cfg.deviceId;
      if (!otherOwner) { setRole(loc, { role: 'OWNER', state: 'COUNTING', owner: S.cfg.deviceId }); render(); return sendOpen('OPEN'); }
      var who = memberLabel(o);
      if (o.state === 'CLOSED') {
        // Control 10: ผู้ดูแลปิดแล้ว ผู้ช่วยยิงเพิ่มไม่ได้จนกว่าผู้ดูแลจะเปิดแก้ไข
        S.loc = null; setRole(loc, { role: 'HELPER', state: 'SUBMITTED', owner: o.device, ownerLabel: who });
        SOUND.bad(); setCard('bad', loc + ' ปิดแล้วโดย ' + (o.name || o.device), 'ให้ผู้ดูแลเปิดแก้ไขก่อน — ไม่รับการยิง');
        return saveState().then(function () { render(); return modal({ title: loc + ' ปิดแล้ว', html: 'ปิดโดย ' + esc(who) + '<br>ถ้าต้องนับเพิ่ม ให้ผู้ดูแลยิงป้าย ' + esc(loc) + ' เพื่อเปิดแก้ไขก่อน', yes: 'รับทราบ', noCancel: true }); });
      }
      if (me && me.role === 'HELPER' && before && before.role === 'HELPER') {
        setRole(loc, { role: 'HELPER', state: 'COUNTING', owner: o.device, ownerLabel: who }); render();
        return sendOpen('JOIN');
      }
      SOUND.warn();
      return modal({ title: loc + ' ดูแลโดย ' + (o.name || o.device), html: 'ผู้ดูแล ' + esc(who) + '<br>เข้าร่วมนับเป็น <b>ผู้ช่วย</b>?<br><span class="muted">ผู้ช่วยยิงได้ แก้ยอด/ปิดไม่ได้ เสร็จแล้วกด "ส่งงาน"</span>',
        yes: 'เข้าร่วม', no: 'ไม่ใช่ (ยิงป้ายผิด)' }).then(function (yes) {
        if (S.loc !== loc) return;
        setRole(loc, { role: 'HELPER', state: 'COUNTING', owner: o.device, ownerLabel: who });
        if (yes) { setCard('idle', 'เข้าร่วม ' + loc + ' เป็นผู้ช่วยแล้ว', 'ผู้ดูแล ' + esc(who), 'เสร็จแล้วกด "ส่งงาน"'); render(); return saveState().then(function () { return sendOpen('JOIN'); }); }
        // ยิงป้ายผิด: ออกจาก Location; ถ้าเผลอยิงสินค้าไปแล้ว ยอดนั้นยังอยู่และถูกส่งงานไว้
        var mine = locSummary(loc).lines;
        S.loc = null;
        setCard('idle', 'ไม่ได้เข้าร่วม ' + loc, mine ? 'ยิงไปแล้ว ' + mine + ' รายการ — ส่งงานให้แล้ว ถ้ายิงผิดให้ผู้ดูแลแก้ยอด' : 'ยิงป้าย Location ถัดไป');
        var p = mine ? addEvent('JOIN', loc).then(function () { setRole(loc, { state: 'SUBMITTED' }); return addEvent('SUBMIT', loc); }) : Promise.resolve(delete S.roles[loc]);
        return p.then(saveState).then(render);
      });
    });
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

  function doClose(loc, total) {
    setRole(loc, { role: 'OWNER', state: 'CLOSED' });
    return addEvent('CLOSE', loc, { total: total }).then(function () {
      if (S.loc === loc) S.loc = null;
      setCard('idle', 'ปิด ' + loc + ' แล้ว', 'ยิงป้าย Location ถัดไป');
      toast('ปิด ' + loc + ' แล้ว');
      if (S.online === false && pending().length) exportFile(true);
      return saveState().then(render).then(offerPaused);
    });
  }

  function doSubmit(loc) {
    return leaveLocation(loc, { self: true }).then(function () {
      SOUND.ok();
      setCard('idle', 'ส่งงาน ' + loc + ' แล้ว', 'ของฉัน ' + fmt(locSummary(loc).qty) + ' ชิ้น · ยิงป้าย Location ถัดไป');
      if (S.online === false && pending().length) exportFile(true);
      render();
      return offerPaused();
    });
  }

  /**
   * ผู้ดูแลแก้ยอด/ล้าง/ปิด ได้เมื่อผู้ช่วยส่งงานครบ (ข้อมูลถึงเซิร์ฟเวอร์ครบ)
   * ออนไลน์: ถามสถานะล่าสุด · ออฟไลน์: ใช้ได้ถ้าเท่าที่รู้ไม่มีผู้ช่วยค้าง (เซิร์ฟเวอร์ตรวจซ้ำตอนส่งข้อมูล)
   */
  function ownerGate(loc, what) {
    return fetchInfo(loc, 5000).then(function (fresh) {
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
    ownerGate(loc, 'ปิด Location ').then(function (ok) {
      if (!ok || S.loc !== loc) return;
      var s = combinedSummary(loc);
      confirmBox('ปิด ' + loc, '<span class="bignum">' + fmt(s.qty) + '</span> ชิ้น · ' + s.sku + ' SKU' + (s.multi ? ' <span class="muted">(รวม ' + S.info[loc].members.length + ' เครื่อง)</span>' : '') +
        '<br>ตรงกับยอดนับมือบนกระดาษของร้านแล้วใช่ไหม?<br><span class="muted">ถ้าไม่ตรง กดยกเลิก แล้วใช้ "ดู/แก้ Location"</span>', 'ปิด Location')
        .then(function (yes) { if (yes) doClose(loc, s.qty); });
    });
  };
  $('btnLoc').onclick = function () { if (!S.loc) { toast('ยิงป้าย Location ก่อน หรือเลือกจาก ⋮ → Location ที่นับแล้ว', true); return; } show('loc'); };
  $('tbLoc').onclick = function () { if (S.view === 'count' || S.view === 'loc') show('locs'); };
  $('btnManual').onclick = function () { if (!S.loc) { toast('ยิงป้าย Location ก่อน', true); return; } show('manual'); };
  $('btnMenu').onclick = function (e) { e.stopPropagation(); $('menu').classList.toggle('hidden'); };
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
  var STATE_TXT = { COUNTING: 'กำลังนับ', PAUSED: 'พักไว้', SUBMITTED: 'ส่งงานแล้ว', CLOSED: 'ปิดแล้ว' };
  function renderLocs() {
    var locs = {};
    S.entries.forEach(function (e) { if (e.location) { var x = locs[e.location] || (locs[e.location] = { last: '' }); if (e.scanTime > x.last) x.last = e.scanTime; } });
    Object.keys(S.roles).forEach(function (l) { if (!locs[l]) locs[l] = { last: '' }; });
    var order = { COUNTING: 1, PAUSED: 2, SUBMITTED: 3, CLOSED: 4 };
    var list = Object.keys(locs).map(function (l) {
      var r = S.roles[l] || {}, srv = S.myLocs[l] || {}, m = locSummary(l);
      return { loc: l, role: r.role || srv.role || 'OWNER', state: l === S.loc ? 'COUNTING' : r.state || srv.state || 'COUNTING', mine: m.qty, sku: m.sku, last: locs[l].last || '', srv: srv };
    }).sort(function (a, b) {
      return (b.loc === S.loc) - (a.loc === S.loc) || (order[a.state] || 9) - (order[b.state] || 9) || String(b.last).localeCompare(String(a.last));
    });
    $('locsHead').textContent = list.length ? list.length + ' Location · แตะเพื่อไปที่ Location นั้น' : 'ยังไม่มี Location ในรอบนี้';
    $('locsList').innerHTML = list.map(function (x) {
      var st = x.loc === S.loc ? 'อยู่ที่นี่' : STATE_TXT[x.state] || x.state;
      var multi = x.srv.devices > 1;
      return '<li data-l="' + esc(x.loc) + '" class="st-' + esc(x.state) + (x.loc === S.loc ? ' here' : '') + '"><div><div class="n"><span class="ln">' + esc(x.loc) + '</span> ' + esc(st) +
        ' · ' + (x.role === 'HELPER' ? 'ผู้ช่วย' : 'ผู้ดูแล') + '</div><div class="c">ของฉัน ' + fmt(x.mine) + ' ชิ้น · ' + x.sku + ' SKU' + (x.last ? ' · ยิงล่าสุด ' + esc(x.last.slice(11, 16)) : '') + '</div>' +
        (multi ? '<div class="c"><span class="badge">มีเครื่องอื่นร่วมนับ ' + x.srv.devices + ' เครื่อง · รวม ' + fmt(x.srv.total) + '</span></div>' : '') +
        (x.srv.flag ? '<div class="c"><span class="badge r">' + esc(x.srv.flag) + '</span></div>' : '') + '</div></li>';
    }).join('');
  }
  function loadMyLocs() {
    if (S.online === false || !S.cfg.token) return Promise.resolve();
    return api('myLocs', {}, 8000).then(function (r) {
      S.myLocs = {}; S.knownNames = r.names || [];
      r.locs.forEach(function (x) {
        S.myLocs[x.location] = x;
        // เครื่องที่ข้อมูลถูกล้างแล้วจับคู่ใหม่ ได้บทบาทคืนจากเซิร์ฟเวอร์
        var cur = S.roles[x.location];
        if (!cur || cur.role !== x.role) setRole(x.location, { role: x.role, state: x.location === S.loc ? 'COUNTING' : (cur && cur.state) || x.state });
      });
      DB.set('knownNames_' + S.projectId, S.knownNames);
      return saveState();
    }, function () {}).then(function () { if (S.view === 'locs') renderLocs(); });
  }
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
        var q = me ? s.mine.qty : m.qty;
        return '<div class="mrow' + (m.role === 'HELPER' && !(m.state === 'SUBMITTED' && m.match === 'OK') ? ' wait' : '') + '"><span>' + (m.role === 'OWNER' ? 'ผู้ดูแล' : 'ผู้ช่วย') + ' ' +
          esc(memberLabel(m)) + (me ? ' (ฉัน)' : '') + '</span><span>' + esc(st) + ' · ' + fmt(q) + '</span></div>';
      }).join('');
    }
    $('locMembers').innerHTML = mem;
    var wait = helper ? [] : waitingHelpers(loc);
    var edits = S.entries.filter(function (e) { return e.location === loc && (e.type === 'RECOUNT_SET' || (e.type === 'VOID' && /แก้/.test(e.reason))); }).length;
    $('locEdited').textContent = helper ? 'ผู้ช่วยดูยอดได้อย่างเดียว — แก้ยอดให้แจ้งผู้ดูแล' + (info && info.owner ? ' (' + memberLabel(info.owner) + ')' : '') :
      wait.length ? 'แก้ยอด / ล้าง / ปิด ได้เมื่อ ' + wait.map(function (m) { return m.name || m.device; }).join(', ') + ' ส่งงาน' :
      edits ? 'แก้ไขแล้ว ' + edits + ' ครั้ง (แตะ SKU เพื่อดูประวัติ)' : 'แตะ SKU เพื่อใส่ยอดจริงที่นับได้';
    $('locEdited').className = wait.length ? 'warnline' : 'muted';
    $('btnLocUndo').classList.toggle('hidden', helper);
    $('btnLocClear').classList.toggle('hidden', helper);
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
    if (isHelper()) { toast('ผู้ช่วยแก้ยอดไม่ได้ — แจ้งผู้ดูแลแก้', true); return; }
    var key = li.dataset.k;
    ownerGate(S.loc, 'แก้ยอด').then(function (ok) { if (ok) editItem(key); });
  });

  function editItem(key) {
    var loc = S.loc, s = combinedSummary(loc), it = s.items.get(key); if (!it) return;
    var m = info(it), cur = it.qty;
    var hist = S.entries.filter(function (e) { return e.location === loc && itemKey(e) === key && e.type !== 'SCAN'; }).slice(-6).reverse()
      .map(function (e) { return '<div class="muted">' + esc(e.scanTime.slice(11, 16)) + ' ' + esc(e.staff) + ' · ' + esc(e.type) + ' ' + (e.qty > 0 ? '+' : '') + fmt(e.qty) + (e.reason ? ' · ' + esc(e.reason) : '') + '</div>'; }).join('');
    modal({
      title: 'แก้ยอดใน ' + loc,
      html: '<b>' + esc(m.n) + '</b><br>' + tailHtml(m.c) + '<br>ใส่ <b>ยอดจริง</b> ที่นับได้' + (s.multi ? ' <b>รวมทุกเครื่อง</b>' : '') + ' (ใส่ 0 ถ้าไม่มีของชิ้นนี้ที่นี่)' +
        (s.multi ? '<div class="muted">ตอนนี้ ของฉัน ' + fmt(it.mine) + ' + เครื่องอื่น ' + fmt(it.others) + ' = ' + fmt(cur) + '</div>' : '') + (hist ? '<div style="margin-top:6px">' + hist + '</div>' : ''),
      input: true, value: '', yes: 'บันทึกยอดจริง',
      preview: function (v) {
        if (v === '' || isNaN(Number(v))) return '';
        var nv = Number(v), d = nv - cur;
        return 'SKU: ' + fmt(cur) + ' <span class="arrow">→ ' + fmt(nv) + '</span><br>' + loc + ': ' + fmt(s.qty) + ' <span class="arrow">→ ' + fmt(s.qty + d) + '</span>';
      }
    }).then(function (v) {
      if (v === null) return;
      if (badNumber(v)) return;
      if (v === '' || isNaN(Number(v)) || Number(v) < 0) { toast('ใส่ตัวเลข 0 ขึ้นไป', true); return; }
      var nv = Number(v), d = Math.round((nv - cur) * 1000) / 1000;
      if (d === 0) { toast('ยอดเท่าเดิม ไม่มีการแก้'); return; }
      return qtyCheck(nv, m.n).then(function (yes) {
        if (!yes) return;
        // basis = ยอดรวมที่เห็นตอนแก้ เซิร์ฟเวอร์ใช้ตรวจว่ามีเครื่องอื่นยิง/แก้ SKU นี้ระหว่างนั้นหรือไม่ (Control 8)
        return addEntry({ barcode: it.barcode, material: it.material, qty: d, type: 'RECOUNT_SET', basis: cur, reason: 'แก้ยอด Location ' + fmt(cur) + ' → ' + fmt(nv) }).then(function () {
          return addEvent('EDIT', loc);
        }).then(function () { SOUND.ok(); toast('แก้แล้ว: ' + fmt(cur) + ' → ' + fmt(nv)); renderLoc(); renderTop(); });
      });
    });
  }

  $('btnLocBack').onclick = function () { show('count'); };
  $('btnLocUndo').onclick = function () {
    var loc = S.loc, v = voidedSet();
    var last = S.entries.slice().reverse().find(function (e) { return e.location === loc && e.type === 'RECOUNT_SET' && !v[e.logId]; });
    if (!last) { toast('ไม่มีการแก้ให้ย้อน', true); return; }
    var m = info(last);
    confirmBox('ย้อนการแก้ล่าสุด', esc(m.n) + '<br>' + esc(last.reason) + '<br>จะคืนยอด ' + (last.qty > 0 ? '−' : '+') + fmt(Math.abs(last.qty)), 'ย้อนการแก้').then(function (yes) {
      if (!yes) return;
      addEntry({ barcode: last.barcode, material: last.material, qty: -last.qty, type: 'VOID', refId: last.logId, reason: 'ย้อนการแก้: ' + last.reason })
        .then(function () { return addEvent('EDIT', loc); }).then(function () { SOUND.warn(); renderLoc(); renderTop(); });
    });
  };
  $('btnLocClear').onclick = function () {
    var loc = S.loc;
    ownerGate(loc, 'ล้าง Location ').then(function (ok) {
      if (!ok) return;
      var s = combinedSummary(loc);
      if (!s.qty && !s.sku) { toast('Location นี้ไม่มียอด', true); return; }
      confirmBox('ล้าง ' + loc + ' นับใหม่?', 'ล้าง <span class="bignum">' + fmt(s.qty) + '</span> ชิ้น ' + s.sku + ' SKU ของ ' + loc + (s.multi ? ' <b>(รวมทุกเครื่อง)</b>' : '') +
        '<br><span class="muted">ระบบไม่ลบข้อมูลเดิม แต่บันทึกรายการหักยอดกำกับไว้ ย้อนได้ทีละ SKU</span>', 'ล้างและนับใหม่').then(function (yes) {
        if (!yes) return;
        var items = Array.from(s.items.values()).filter(function (it) { return it.qty !== 0; });
        var p = Promise.resolve();
        items.forEach(function (it) {
          p = p.then(function () { return addEntry({ barcode: it.barcode, material: it.material, qty: -it.qty, type: 'RECOUNT_SET', basis: it.qty, reason: 'ล้าง Location นับใหม่ (เดิม ' + fmt(it.qty) + ')' }); });
        });
        p.then(function () { return addEvent('EDIT', loc); }).then(function () {
          S.recountBanner = 'นับใหม่ ' + loc + ' (ยอดเดิม ' + fmt(s.qty) + ')';
          SOUND.warn(); setCard('idle', 'ล้าง ' + loc + ' แล้ว — เริ่มนับใหม่ได้'); show('count');
        });
      });
    });
  };

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
      ['สแกนแล้ว', fmt(S.entries.length)], ['ส่งแล้ว', fmt(S.entries.length - p - rej.length)], ['ค้างส่ง', fmt(p)],
      ['เซิร์ฟเวอร์ไม่รับ', fmt(rej.length)], ['ข้อมูลรอบอื่นค้างส่ง', fmt(S.oldPending.length)], ['รอตรวจ Location', fmt(S.events.length)],
      ['ส่งสำเร็จล่าสุด', S.lastSyncOk ? stamp(new Date(S.lastSyncOk)).slice(11) : '-'], ['เชื่อมต่อ', S.online ? 'ออนไลน์' : S.online === false ? 'ออฟไลน์' : '-'],
      ['รายการบาร์โค้ด', fmt(S.master.size) + ' · ' + (S.masterHash || '-')], ['เวอร์ชัน', 'แอป ' + APP_VERSION + ' · เซิร์ฟเวอร์ ' + (S.serverVersion || '-') + (S.latestVersion && S.latestVersion !== APP_VERSION ? ' (มีแอป ' + S.latestVersion + ')' : '')]
    ];
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
    if (pending().length || S.oldPending.length) { toast('ยังมีข้อมูลค้างส่ง ส่งหรือ Export ก่อน', true); return; }
    confirmBox('ยกเลิกการจับคู่', 'ต้องใช้รหัสจับคู่ใหม่จากหัวหน้าทีมจึงจะใช้เครื่องนี้ได้อีก', 'ยกเลิกการจับคู่').then(function (y) {
      if (!y) return; S.cfg.token = ''; DB.set('cfg', S.cfg).then(function () { show('setup'); });
    });
  };

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
    S.cfg = { apiUrl: apiUrl, deviceId: dev, token: '' };
    setupMsg('กำลังจับคู่…', true);
    api('pair', { code: code }, 20000).then(function (r) {
      S.cfg.token = r.token; S.lastErr = '';
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
      return Promise.all([DB.get('closedLocs_' + pid), DB.get('locChecks_' + pid), DB.get('loc'), DB.get('roles_' + pid), DB.get('knownNames_' + pid)]);
    }).then(function (v) {
      S.locChecks = v[1] || {}; S.roles = v[3] || {}; S.knownNames = v[4] || []; S.info = {}; S.myLocs = {};
      // ข้อมูลจากรุ่นก่อน 2.2.0: Location ที่ปิดแล้ว = ผู้ดูแลที่ปิดแล้ว
      (v[0] || []).forEach(function (l) { if (!S.roles[l]) S.roles[l] = { role: 'OWNER', state: 'CLOSED' }; });
      var lastLoc = v[2];
      S.loc = lastLoc && S.entries.some(function (e) { return e.location === lastLoc; }) ? lastLoc : null;
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
          add('DataWedge: ได้ครบทุกหลักพร้อม Enter', S.dwOk ? 'OK' : 'FAIL', S.dwOk ? 'ผู้ตรวจสอบ ' + (S.staff ? S.staff.code : '') : 'ยิงบัตรผู้ตรวจสอบ (EMP:) 1 ครั้ง');
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
      return Promise.all([DB.get('cfg'), DB.get('boot'), DB.get('masterHash'), DB.get('masterProject'), DB.get('projectId'), DB.get('staff'), DB.get('readiness'), DB.all('events'), DB.get('stock'), DB.get('ckRotate')]);
    }).then(function (v) {
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
      if (!S.cfg.token) { show('setup'); return; }
      var r = S.readiness;
      if (r && r.pass && r.project === S.projectId && r.date === today()) {
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
